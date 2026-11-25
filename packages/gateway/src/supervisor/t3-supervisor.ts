import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import type { GatewayEnv, SupervisorState, SupervisorStatus } from "@t3-docker/shared";
import type { ConfigStore } from "../config/config-store.js";
import { buildCleanWorkerEnv } from "../security/env-sanitizer.js";
import { fileExists } from "../utils/atomic-fs.js";
import {
  getFreeDiskMb,
  resolveT3Binary,
  runWorkerCommand,
  wrapPrivilegeDrop,
} from "../utils/cli-runner.js";
import { LogRingBuffer } from "./ring-buffer.js";

interface EnvironmentDescriptor {
  readonly environmentId?: string;
  readonly auth?: {
    readonly sessionCookieName?: string;
  };
  readonly sessionCookieName?: string;
}

export class T3ProcessSupervisor {
  public readonly logs = new LogRingBuffer(2000);
  private state: SupervisorState = "stopped";
  private child: ChildProcess | null = null;
  private startedAtMs: number | null = null;
  private desiredRunning = false;
  private restartCount = 0;
  private consecutiveCrashes = 0;
  private lastError: string | null = null;
  private environmentId: string | null = null;
  private sessionCookieName: string | null = null;
  private activeVersion: string | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private lockPromise: Promise<void> = Promise.resolve();

  public constructor(
    private readonly gatewayEnv: GatewayEnv,
    private readonly configStore: ConfigStore,
  ) {}

  public get upstreamUrl(): string {
    return `http://${this.gatewayEnv.T3_UPSTREAM_HOST}:${this.gatewayEnv.T3_UPSTREAM_PORT}`;
  }

  public getState(): SupervisorState {
    return this.state;
  }

  public getSessionCookieName(): string | null {
    return this.sessionCookieName;
  }

  public async getStatus(): Promise<SupervisorStatus> {
    const freeDiskMb = await getFreeDiskMb(this.gatewayEnv.T3CODE_HOME);
    const headlessToolsDir = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "tools",
      "chrome-headless-shell",
    );
    const headlessBrowserInstalled = await fileExists(headlessToolsDir);
    const mem = process.memoryUsage();

    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      uptimeSeconds:
        this.startedAtMs && (this.state === "healthy" || this.state === "starting")
          ? Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1000))
          : 0,
      upstreamUrl: this.upstreamUrl,
      activeVersion: this.activeVersion,
      environmentId: this.environmentId,
      sessionCookieName: this.sessionCookieName,
      restartCount: this.restartCount,
      lastError: this.lastError,
      system: {
        platform: process.platform,
        arch: process.arch,
        memoryRssMb: Math.round(mem.rss / (1024 * 1024)),
        freeDiskMb,
        headlessBrowserInstalled,
      },
    };
  }

  public async start(): Promise<void> {
    return this.withExclusiveLock(async () => {
      this.desiredRunning = true;
      if (this.child && (this.state === "healthy" || this.state === "starting")) {
        return;
      }
      await this.spawnProcess();
    });
  }

  public async stop(): Promise<void> {
    return this.withExclusiveLock(async () => {
      this.desiredRunning = false;
      this.clearTimers();
      await this.terminateChild();
      this.state = "stopped";
      this.logs.push("system", "[supervisor] T3 Code server stopped.");
    });
  }

  public async restart(): Promise<void> {
    return this.withExclusiveLock(async () => {
      this.desiredRunning = true;
      this.state = "restarting";
      this.clearTimers();
      await this.terminateChild();
      this.restartCount += 1;
      await this.spawnProcess();
    });
  }

  /**
   * Acquires an exclusive lifecycle lock (e.g. for `updating` or `maintenance`),
   * stops `t3 serve` cleanly, executes the callback, and optionally restarts afterwards.
   */
  public async runInMaintenance<T>(
    mode: "updating" | "maintenance",
    fn: () => Promise<T>,
    restartAfter = true,
  ): Promise<T> {
    return this.withExclusiveLock(async () => {
      const wasDesired = this.desiredRunning;
      this.desiredRunning = false;
      this.clearTimers();
      this.state = mode;
      this.logs.push("system", `[supervisor] Entering ${mode} mode; stopping T3 server...`);
      await this.terminateChild();

      try {
        return await fn();
      } finally {
        if (restartAfter && wasDesired) {
          this.desiredRunning = true;
          await this.spawnProcess();
        } else {
          this.state = "stopped";
        }
      }
    });
  }

  public async runDoctorFix(): Promise<{ ok: boolean; output: string }> {
    return this.runInMaintenance("maintenance", async () => {
      const bin = await resolveT3Binary(this.gatewayEnv);
      this.logs.push("system", "[supervisor] Running `t3 doctor --fix`...");
      const res = await runWorkerCommand({
        command: bin,
        args: ["doctor", "--base-dir", this.gatewayEnv.T3CODE_HOME, "--fix"],
        gatewayEnv: this.gatewayEnv,
        workerEnv: this.configStore.get().workerEnv,
        timeoutMs: 10 * 60_000,
      });
      const combined = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
      this.logs.push("system", `[supervisor] t3 doctor exited with code ${res.code}`);
      return { ok: res.code === 0, output: combined };
    });
  }

  public setActiveVersionHint(version: string | null): void {
    this.activeVersion = version;
  }

  public async detectInstalledVersion(): Promise<string | null> {
    try {
      const bin = await resolveT3Binary(this.gatewayEnv);
      const res = await runWorkerCommand({
        command: bin,
        args: ["--version"],
        gatewayEnv: this.gatewayEnv,
        workerEnv: this.configStore.get().workerEnv,
        timeoutMs: 8_000,
      });
      if (res.code === 0) {
        const match = /(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/.exec(res.stdout);
        const ver = match?.[1] ?? (res.stdout.trim() || null);
        this.activeVersion = ver;
        return ver;
      }
    } catch {
      // Binary may not be present during local unit tests
    }
    return this.activeVersion;
  }

  private async spawnProcess(): Promise<void> {
    this.clearTimers();
    this.state = "starting";
    this.lastError = null;

    await this.detectInstalledVersion();
    const bin = await resolveT3Binary(this.gatewayEnv);
    const args = [
      "serve",
      "--mode",
      "web",
      "--host",
      this.gatewayEnv.T3_UPSTREAM_HOST,
      "--port",
      String(this.gatewayEnv.T3_UPSTREAM_PORT),
      "--base-dir",
      this.gatewayEnv.T3CODE_HOME,
      "--no-browser",
      "--auto-bootstrap-project-from-cwd",
      this.gatewayEnv.T3_WORKSPACE,
    ];

    const cleanEnv = buildCleanWorkerEnv({
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
    });
    const wrapped = wrapPrivilegeDrop(bin, args, this.gatewayEnv.CODER_USER);

    this.logs.push("system", `[supervisor] Spawning: ${wrapped.cmd} ${wrapped.args.join(" ")}`);
    const child = spawn(wrapped.cmd, wrapped.args, {
      cwd: this.gatewayEnv.T3_WORKSPACE,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child = child;
    this.startedAtMs = Date.now();

    child.stdout?.on("data", (chunk: Buffer) => {
      this.logs.push("stdout", chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.logs.push("stderr", chunk.toString("utf8"));
    });

    child.on("error", (err) => {
      this.lastError = err.message;
      this.logs.push("system", `[supervisor] Process spawn error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.startedAtMs = null;
      }
      this.logs.push(
        "system",
        `[supervisor] Process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      if (this.desiredRunning && this.state !== "updating" && this.state !== "maintenance") {
        this.consecutiveCrashes += 1;
        this.state = "degraded";
        this.lastError = `Process exited unexpectedly (code=${code ?? "null"})`;
        const delayMs = Math.min(10_000, 1000 * 2 ** Math.min(4, this.consecutiveCrashes - 1));
        this.logs.push("system", `[supervisor] Scheduling auto-restart in ${delayMs}ms...`);
        this.restartTimer = setTimeout(() => {
          void this.spawnProcess();
        }, delayMs);
      }
    });

    this.startReadinessLoop();
  }

  public async waitForHealthy(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state === "healthy") return true;
      if (this.state === "stopped" || (this.state === "degraded" && this.consecutiveCrashes >= 3)) {
        return false;
      }
      const ok = await this.probeOnce();
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 350));
    }
    return false;
  }

  private startReadinessLoop(): void {
    const tick = async () => {
      if (!this.desiredRunning || !this.child) return;
      await this.probeOnce();
      this.probeTimer = setTimeout(() => void tick(), this.state === "healthy" ? 5_000 : 500);
    };
    this.probeTimer = setTimeout(() => void tick(), 400);
  }

  private async probeOnce(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      const res = await fetch(`${this.upstreamUrl}/.well-known/t3/environment`, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) return false;
      const body = (await res.json().catch(() => ({}))) as EnvironmentDescriptor;
      if (typeof body.environmentId === "string") {
        this.environmentId = body.environmentId;
      }
      const cookieName = body.auth?.sessionCookieName ?? body.sessionCookieName;
      if (typeof cookieName === "string" && cookieName.length > 0) {
        this.sessionCookieName = cookieName;
      }

      if (this.state !== "healthy") {
        this.state = "healthy";
        this.consecutiveCrashes = 0;
        this.lastError = null;
        this.logs.push(
          "system",
          `[supervisor] T3 server is healthy at ${this.upstreamUrl} (cookie=${this.sessionCookieName ?? "auto"})`,
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  private async terminateChild(): Promise<void> {
    const proc = this.child;
    if (!proc) return;
    this.child = null;
    this.startedAtMs = null;

    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (!finished) {
          finished = true;
          resolve();
        }
      };
      proc.once("exit", done);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) {
          proc.kill("SIGKILL");
          setTimeout(done, 500);
        }
      }, 6_000);
    });
  }

  private clearTimers(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private async withExclusiveLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lockPromise;
    let release!: () => void;
    this.lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
