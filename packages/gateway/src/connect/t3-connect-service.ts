import { spawn, type ChildProcess } from "node:child_process";
import type { ConnectState, ConnectStatus, GatewayEnv } from "@t3-docker/shared";
import type { ConfigStore } from "../config/config-store.js";
import { buildCleanWorkerEnv } from "../security/env-sanitizer.js";
import type { T3ProcessSupervisor } from "../supervisor/t3-supervisor.js";
import {
  parseJsonFromCliStdout,
  resolveT3Binary,
  runWorkerCommand,
  wrapPrivilegeDrop,
} from "../utils/cli-runner.js";

export function parseDeviceCodeOutput(rawText: string): {
  verificationUrl: string | null;
  userCode: string | null;
  expiresInSeconds: number | null;
  authorized: boolean;
  identity: string | null;
} {
  const urlMatch =
    /Open this URL on a device with a browser:\s*\n\s*(https?:\/\/\S+)/i.exec(rawText) ??
    /(https?:\/\/\S+)/i.exec(rawText);
  const codeMatch = /Confirm this code when asked:\s*([A-Z0-9-]{4,20})/i.exec(rawText);
  const minMatch = /expires in (\d+) min/i.exec(rawText);
  const authorized = /✓\s*Authorized/i.test(rawText) || /Authorized as /i.test(rawText);
  const idMatch = /Authorized as ([^\r\n]+)/i.exec(rawText);

  const mins = minMatch?.[1] ? Number(minMatch[1]) : NaN;
  return {
    verificationUrl: urlMatch?.[1] ?? null,
    userCode: codeMatch?.[1] ?? null,
    expiresInSeconds: Number.isFinite(mins) && mins > 0 ? mins * 60 : null,
    authorized,
    identity: idMatch?.[1]?.trim() || null,
  };
}

export class T3ConnectService {
  private authProc: ChildProcess | null = null;
  private authBuffer = "";
  private authError: string | null = null;

  public constructor(
    private readonly gatewayEnv: GatewayEnv,
    private readonly configStore: ConfigStore,
    private readonly supervisor: T3ProcessSupervisor,
  ) {}

  public async getStatus(): Promise<ConnectStatus> {
    const bin = await resolveT3Binary(this.gatewayEnv);
    const statusRes = await runWorkerCommand({
      command: bin,
      args: ["connect", "status", "--base-dir", this.gatewayEnv.T3CODE_HOME, "--json"],
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      timeoutMs: 10_000,
    }).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    const rawJson = parseJsonFromCliStdout<Record<string, unknown>>(statusRes.stdout) ?? {};
    const desired = rawJson.desired === true;
    const authenticated = rawJson.authenticated === true;
    const revoked = rawJson.revoked === true;
    const linked = rawJson.linked === true && !revoked;

    let state: ConnectState = linked
      ? "on"
      : !desired
        ? "off"
        : revoked || !authenticated
          ? "signin"
          : "pending";

    if (this.authProc) {
      state = "authorizing";
    }

    let relayHost: string | null = null;
    if (typeof rawJson.relayUrl === "string") {
      try {
        relayHost = new URL(rawJson.relayUrl).host;
      } catch {
        relayHost = null;
      }
    }

    const livePrefs = await this.readLivePreferences();
    const devices = await this.listDevices();
    const parsedAuth = this.authProc || this.authBuffer ? parseDeviceCodeOutput(this.authBuffer) : null;

    return {
      state,
      desired,
      authenticated,
      linked,
      revoked,
      relayHost,
      publishAgentActivity:
        livePrefs?.publishAgentActivity ?? (rawJson.publishAgentActivity === true),
      holdWebhooksWhileOffline: livePrefs?.holdWebhooksWhileOffline ?? null,
      deviceAuth: parsedAuth
        ? {
            verificationUrl: parsedAuth.verificationUrl,
            userCode: parsedAuth.userCode,
            expiresInSeconds: parsedAuth.expiresInSeconds,
            identity: parsedAuth.identity,
            error: this.authError,
          }
        : null,
      devices,
    };
  }

  /**
   * Controls T3 Connect master switch from the Admin Console:
   * - Turning OFF runs `t3 connect unlink` (retains stored credentials so turning back ON needs no re-login!)
   * - Turning ON reuses stored credentials via `t3 connect link`, or launches headless Device-Code flow when unauthenticated.
   */
  public async toggle(enabled: boolean, restartImmediately = true): Promise<ConnectStatus> {
    const bin = await resolveT3Binary(this.gatewayEnv);

    if (!enabled) {
      this.cancelDeviceAuth();
      await runWorkerCommand({
        command: bin,
        args: ["connect", "unlink", "--base-dir", this.gatewayEnv.T3CODE_HOME],
        gatewayEnv: this.gatewayEnv,
        workerEnv: this.configStore.get().workerEnv,
        timeoutMs: 15_000,
      });
      if (restartImmediately && this.supervisor.getState() === "healthy") {
        await this.supervisor.restart();
      }
      return this.getStatus();
    }

    const current = await this.getStatus();
    if (current.authenticated && !current.revoked) {
      await runWorkerCommand({
        command: bin,
        args: ["connect", "link", "--base-dir", this.gatewayEnv.T3CODE_HOME],
        gatewayEnv: this.gatewayEnv,
        workerEnv: this.configStore.get().workerEnv,
        timeoutMs: 15_000,
      });
      if (restartImmediately && this.supervisor.getState() === "healthy") {
        await this.supervisor.restart();
      }
      return this.getStatus();
    }

    await this.startHeadlessDeviceCodeFlow(bin, restartImmediately);
    return this.getStatus();
  }

  public async updatePreferences(input: {
    readonly publishAgentActivity?: boolean;
    readonly holdWebhooksWhileOffline?: boolean;
  }): Promise<ConnectStatus> {
    try {
      await fetch(`${this.supervisor.upstreamUrl}/api/connect/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch {
      // Fallback via CLI publish subcommand when live endpoint requires paired token
      if (typeof input.publishAgentActivity === "boolean") {
        const bin = await resolveT3Binary(this.gatewayEnv);
        await runWorkerCommand({
          command: bin,
          args: [
            "connect",
            "publish",
            input.publishAgentActivity ? "on" : "off",
            "--base-dir",
            this.gatewayEnv.T3CODE_HOME,
          ],
          gatewayEnv: this.gatewayEnv,
          workerEnv: this.configStore.get().workerEnv,
        }).catch(() => undefined);
      }
    }
    return this.getStatus();
  }

  public async manageDevice(code: string, action: "approve" | "revoke"): Promise<ConnectStatus> {
    const bin = await resolveT3Binary(this.gatewayEnv);
    await runWorkerCommand({
      command: bin,
      args: [
        "auth",
        "connect-device",
        action,
        code,
        "--base-dir",
        this.gatewayEnv.T3CODE_HOME,
      ],
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      timeoutMs: 15_000,
    });
    return this.getStatus();
  }

  public async logout(): Promise<ConnectStatus> {
    this.cancelDeviceAuth();
    const bin = await resolveT3Binary(this.gatewayEnv);
    await runWorkerCommand({
      command: bin,
      args: ["connect", "logout", "--base-dir", this.gatewayEnv.T3CODE_HOME],
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      timeoutMs: 15_000,
    });
    if (this.supervisor.getState() === "healthy") {
      await this.supervisor.restart();
    }
    return this.getStatus();
  }

  private async startHeadlessDeviceCodeFlow(
    bin: string,
    restartOnSuccess: boolean,
  ): Promise<void> {
    if (this.authProc) return;
    this.authBuffer = "";
    this.authError = null;

    const cleanEnv = buildCleanWorkerEnv({
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
    });
    const wrapped = wrapPrivilegeDrop(
      bin,
      ["connect", "link", "--headless", "--base-dir", this.gatewayEnv.T3CODE_HOME],
      this.gatewayEnv.CODER_USER,
    );

    const proc = spawn(wrapped.cmd, wrapped.args, {
      cwd: this.gatewayEnv.T3_WORKSPACE,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.authProc = proc;

    const onChunk = (chunk: Buffer) => {
      this.authBuffer += chunk.toString("utf8");
    };
    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);

    proc.on("close", (code) => {
      if (this.authProc === proc) {
        this.authProc = null;
      }
      const parsed = parseDeviceCodeOutput(this.authBuffer);
      if (code === 0 || parsed.authorized) {
        this.authBuffer = "";
        if (restartOnSuccess && this.supervisor.getState() === "healthy") {
          void this.supervisor.restart();
        }
      } else {
        this.authError = `Authorization exited with code ${code ?? 1}`;
      }
    });

    // Wait briefly so the initial URL & 8-char code are captured before returning
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && this.authProc) {
      const parsed = parseDeviceCodeOutput(this.authBuffer);
      if (parsed.verificationUrl && parsed.userCode) break;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  private cancelDeviceAuth(): void {
    if (this.authProc) {
      this.authProc.kill("SIGTERM");
      this.authProc = null;
    }
    this.authBuffer = "";
    this.authError = null;
  }

  private async readLivePreferences(): Promise<{
    publishAgentActivity?: boolean;
    holdWebhooksWhileOffline?: boolean | null;
  } | null> {
    try {
      const res = await fetch(`${this.supervisor.upstreamUrl}/api/connect/link-state`);
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      return {
        ...(typeof data.publishAgentActivity === "boolean"
          ? { publishAgentActivity: data.publishAgentActivity }
          : {}),
        holdWebhooksWhileOffline:
          typeof data.holdWebhooksWhileOffline === "boolean"
            ? data.holdWebhooksWhileOffline
            : null,
      };
    } catch {
      return null;
    }
  }

  private async listDevices(): Promise<ConnectStatus["devices"]> {
    try {
      const bin = await resolveT3Binary(this.gatewayEnv);
      const res = await runWorkerCommand({
        command: bin,
        args: ["auth", "connect-device", "list", "--base-dir", this.gatewayEnv.T3CODE_HOME, "--json"],
        gatewayEnv: this.gatewayEnv,
        workerEnv: this.configStore.get().workerEnv,
        timeoutMs: 8_000,
      });
      if (res.code !== 0) return [];
      const parsed = parseJsonFromCliStdout<unknown>(res.stdout);
      const mapItems = (items: unknown[], defaultStatus: "pending" | "approved") =>
        items.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const d = raw as Record<string, unknown>;
          const id = String(d.id ?? d.pairingLinkId ?? d.proofKeyThumbprint ?? d.code ?? "");
          if (!id) return [];
          const code = typeof d.code === "string" ? d.code : undefined;
          const createdAt = typeof d.createdAt === "string" ? d.createdAt : undefined;
          const status: "pending" | "approved" =
            d.status === "pending"
              ? "pending"
              : d.status === "approved"
                ? "approved"
                : defaultStatus;
          return [
            {
              id,
              ...(code ? { code } : {}),
              label: typeof d.label === "string" ? d.label : id,
              status,
              ...(createdAt ? { createdAt } : {}),
            },
          ];
        });

      if (Array.isArray(parsed)) {
        return mapItems(parsed, "approved");
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as {
          devices?: unknown;
          waiting?: unknown;
          trusted?: unknown;
        };
        if (Array.isArray(obj.devices)) {
          return mapItems(obj.devices, "approved");
        }
        return [
          ...(Array.isArray(obj.waiting) ? mapItems(obj.waiting, "pending") : []),
          ...(Array.isArray(obj.trusted) ? mapItems(obj.trusted, "approved") : []),
        ];
      }
      return [];
    } catch {
      return [];
    }
  }
}
