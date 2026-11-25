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

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, "");
}

export function parseDeviceCodeOutput(rawText: string): {
  verificationUrl: string | null;
  userCode: string | null;
  expiresInSeconds: number | null;
  authorized: boolean;
  identity: string | null;
  installingRelayClient: boolean;
} {
  const clean = stripAnsi(rawText);

  const urlMatch =
    /(https:\/\/accounts\.t3\.codes\/\S+)/i.exec(clean) ??
    /(https:\/\/app\.t3\.codes\/\S+)/i.exec(clean) ??
    /Open (?:this URL )?on [^\r\n]*:\s*\r?\n\s*(https?:\/\/\S+)/i.exec(clean);

  const codeMatch =
    /^\s*Code:\s*([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9-]{4,20})\s*$/im.exec(clean) ??
    /Confirm this code when asked:\s*([A-Z0-9-]{4,20})/i.exec(clean) ??
    /[?&]user_code=([A-Z0-9-]{4,20})/i.exec(clean);

  const minMatch = /expires in (\d+) min/i.exec(clean);
  const authorized =
    /✓\s*Authorized/i.test(clean) ||
    /Authorized as /i.test(clean) ||
    /T3 Connect linked/i.test(clean);
  const idMatch = /Authorized as ([^\r\n]+)/i.exec(clean);

  const verificationUrl = urlMatch?.[1]?.trim() ?? null;
  const userCode = codeMatch?.[1]?.trim() ?? null;
  const installingRelayClient =
    !userCode &&
    (/Relay client:/i.test(clean) || /relay client is required/i.test(clean));

  const mins = minMatch?.[1] ? Number(minMatch[1]) : NaN;
  return {
    verificationUrl,
    userCode,
    expiresInSeconds: Number.isFinite(mins) && mins > 0 ? mins * 60 : null,
    authorized,
    identity: idMatch?.[1]?.trim() || null,
    installingRelayClient,
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
    const parsedAuth =
      this.authProc || this.authBuffer || this.authError
        ? parseDeviceCodeOutput(this.authBuffer)
        : null;

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
            installingRelayClient: Boolean(this.authProc) && parsedAuth.installingRelayClient,
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
      const before = await this.getStatus();
      this.cancelDeviceAuth();
      if (before.desired || before.linked) {
        await runWorkerCommand({
          command: bin,
          args: ["connect", "unlink", "--base-dir", this.gatewayEnv.T3CODE_HOME],
          gatewayEnv: this.gatewayEnv,
          workerEnv: this.configStore.get().workerEnv,
          timeoutMs: 15_000,
        });
        if (restartImmediately && before.linked && this.supervisor.getState() === "healthy") {
          await this.supervisor.restart();
        }
      }
      return this.getStatus();
    }

    const current = await this.getStatus();
    if (current.authenticated && !current.revoked) {
      await this.runConnectSubcommandWithConfirm(bin, [
        "connect",
        "link",
        "--base-dir",
        this.gatewayEnv.T3CODE_HOME,
      ]);
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

  private async runConnectSubcommandWithConfirm(
    bin: string,
    args: readonly string[],
  ): Promise<void> {
    const cleanEnv = buildCleanWorkerEnv({
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
    });
    const wrapped = wrapPrivilegeDrop(bin, args, this.gatewayEnv.CODER_USER);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(wrapped.cmd, wrapped.args, {
        cwd: this.gatewayEnv.T3_WORKSPACE,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.write("y\ny\n");
      child.stdin?.end();

      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < 4096) stderr += d.toString("utf8");
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Timed out running T3 Connect command"));
      }, 90_000);

      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(stripAnsi(stderr).trim() || `t3 connect exited with code ${code ?? 1}`));
      });
    });
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
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.authProc = proc;

    let answeredRelayPrompt = false;
    const onChunk = (chunk: Buffer) => {
      const str = chunk.toString("utf8");
      this.authBuffer += str;
      // Auto-accept T3's first-run cloudflared relay client installation prompt (`(y/N)`)
      if (!answeredRelayPrompt && /\(y\/N\)/i.test(stripAnsi(this.authBuffer))) {
        answeredRelayPrompt = true;
        try {
          proc.stdin?.write("y\n");
        } catch {
          // Ignore broken pipe
        }
      }
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);

    proc.on("close", (code) => {
      if (this.authProc === proc) {
        this.authProc = null;
      }
      const parsed = parseDeviceCodeOutput(this.authBuffer);
      if (code === 0 || parsed.authorized) {
        this.authBuffer = "";
        this.authError = null;
        if (restartOnSuccess && this.supervisor.getState() === "healthy") {
          void this.supervisor.restart();
        }
      } else {
        const cleanTail = stripAnsi(this.authBuffer).trim().split(/\r?\n/).slice(-3).join(" ");
        this.authError = cleanTail || `Authorization exited with code ${code ?? 1}`;
      }
    });

    // Wait briefly so cached cloudflared setups return the 8-char code immediately;
    // if cloudflared is downloading for the first time, return `state: "authorizing"` promptly
    // while `ConnectAccessTab` polls every 1.5s until the code arrives.
    const deadline = Date.now() + 3_500;
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
