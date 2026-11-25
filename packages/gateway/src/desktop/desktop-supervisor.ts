import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type { DesktopConfig, DesktopState, DesktopStatus, GatewayEnv } from "@t3-docker/shared";
import type { T3AuthBridge } from "../auth-bridge/t3-auth-bridge.js";
import type { ConfigStore } from "../config/config-store.js";
import { buildCleanWorkerEnv } from "../security/env-sanitizer.js";
import { fileExists, writeFileAtomic } from "../utils/atomic-fs.js";
import { wrapPrivilegeDrop } from "../utils/cli-runner.js";
import { resolveEffectiveDesktopLocale } from "./browser-locale.js";

const DISPLAY_ID = ":99";
const VNC_INTERNAL_PORT = 5900;

export class DesktopSupervisor {
  public readonly supported: boolean;
  private state: DesktopState;
  private readonly procs = new Map<string, ChildProcess>();
  private activeConnections = 0;
  private lastActivityMs = Date.now();
  private activeLocale = "zh-CN";
  private lastError: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private mutex: Promise<void> = Promise.resolve();

  public constructor(
    private readonly gatewayEnv: GatewayEnv,
    private readonly configStore: ConfigStore,
    private readonly authBridge: T3AuthBridge,
  ) {
    this.supported = gatewayEnv.T3GW_VARIANT === "full";
    this.state = this.supported ? "hibernated" : "unsupported";
    if (this.supported) {
      this.idleTimer = setInterval(() => {
        void this.checkIdleAutoSleep();
      }, 15_000);
      this.idleTimer.unref?.();
    }
  }

  public get novncUpstreamUrl(): string {
    return `http://127.0.0.1:${this.gatewayEnv.NOVNC_UPSTREAM_PORT}`;
  }

  public getState(): DesktopState {
    return this.state;
  }

  public touchActivity(): void {
    this.lastActivityMs = Date.now();
  }

  public onVncConnectionOpened(): void {
    this.activeConnections += 1;
    this.touchActivity();
  }

  public onVncConnectionClosed(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    this.touchActivity();
  }

  public getStatus(): DesktopStatus {
    const cfg = this.configStore.get().desktop;
    const idleSeconds =
      this.state === "running" ? Math.max(0, Math.floor((Date.now() - this.lastActivityMs) / 1000)) : 0;
    const timeoutSec = cfg.idleTimeoutMinutes > 0 ? cfg.idleTimeoutMinutes * 60 : null;
    const remaining =
      this.state === "running" && timeoutSec !== null
        ? this.activeConnections > 0
          ? timeoutSec
          : Math.max(0, timeoutSec - idleSeconds)
        : null;

    return {
      supported: this.supported,
      state: this.state,
      pid: this.procs.get("xvfb")?.pid ?? null,
      activeConnections: this.activeConnections,
      idleSeconds,
      autoSleepRemainingSeconds: remaining,
      activeLocale: this.activeLocale,
      t3DesktopRunning: this.procs.has("t3-desktop"),
      chromiumRunning: this.procs.has("chromium"),
      config: cfg,
      lastError: this.lastError,
    };
  }

  public async start(): Promise<DesktopStatus> {
    this.assertSupported();
    return this.withMutex(async () => {
      if (this.state === "running" && this.procs.has("xvfb") && this.procs.has("websockify")) {
        this.touchActivity();
        return this.getStatus();
      }
      await this.startStackInternal();
      return this.getStatus();
    });
  }

  public async stop(): Promise<DesktopStatus> {
    this.assertSupported();
    return this.withMutex(async () => {
      await this.stopStackInternal();
      return this.getStatus();
    });
  }

  public async restart(): Promise<DesktopStatus> {
    this.assertSupported();
    return this.withMutex(async () => {
      await this.stopStackInternal();
      await this.startStackInternal();
      return this.getStatus();
    });
  }

  public async updateConfig(patch: Partial<DesktopConfig>): Promise<DesktopStatus> {
    const prev = this.configStore.get().desktop;
    const updated = await this.configStore.update({
      desktop: {
        ...prev,
        ...patch,
      },
    });

    if (this.supported && this.state === "running") {
      const resolutionChanged =
        updated.desktop.width !== prev.width || updated.desktop.height !== prev.height;
      const langChanged = updated.desktop.languageOverride !== prev.languageOverride;
      if (resolutionChanged || langChanged) {
        return this.restart();
      }
    }
    return this.getStatus();
  }

  public async launchT3DesktopApp(): Promise<void> {
    this.assertSupported();
    if (this.state !== "running") {
      await this.start();
    }
    if (this.procs.has("t3-desktop")) return;

    await this.prepareT3DesktopCoexistenceSettings();
    const binPath = await this.resolveT3DesktopBinary();
    if (!binPath) {
      throw new Error("T3 Desktop executable not found in current runtime.");
    }

    const upstreamUrl = `http://${this.gatewayEnv.T3_UPSTREAM_HOST}:${this.gatewayEnv.T3_UPSTREAM_PORT}`;
    const pairingLink = await this.authBridge
      .ensureVncDesktopPairingAppLink(upstreamUrl)
      .catch(() => null);

    const localeBundle = await this.resolveCurrentLocaleBundle();
    const args = [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--password-store=basic",
      ...localeBundle.chromiumArgs,
      ...(pairingLink ? [pairingLink] : []),
    ];

    this.spawnManagedProcess("t3-desktop", binPath, args, localeBundle.envOverrides);
  }

  public async launchChromiumBrowser(): Promise<void> {
    this.assertSupported();
    if (this.state !== "running") {
      await this.start();
    }
    if (this.procs.has("chromium")) return;

    const cfg = this.configStore.get().desktop;
    const localeBundle = await this.resolveCurrentLocaleBundle();
    // Dedicated non-default profile path required by Chromium 136+ to allow --remote-debugging-port;
    // do NOT mkdir as root here so Chromium creates it owned by `coder:coder` cleanly.
    const userDataDir = path.join(this.gatewayEnv.CODER_HOME, ".config", "t3-chromium");

    const args = [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userDataDir}`,
      `--window-position=0,0`,
      `--window-size=${cfg.width},${cfg.height}`,
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${cfg.cdpPort}`,
      ...localeBundle.chromiumArgs,
      "about:blank",
    ];

    this.spawnManagedProcess("chromium", "chromium", args, localeBundle.envOverrides);
  }

  public async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.supported && this.state !== "hibernated") {
      await this.stopStackInternal();
    }
  }

  private async startStackInternal(): Promise<void> {
    this.state = "waking";
    this.lastError = null;
    const cfg = this.configStore.get().desktop;
    const localeBundle = await this.resolveCurrentLocaleBundle();
    this.activeLocale = localeBundle.bcp47;

    try {
      await fs.rm("/tmp/.X99-lock", { force: true }).catch(() => undefined);

      this.spawnManagedProcess(
        "xvfb",
        "Xvfb",
        [
          DISPLAY_ID,
          "-screen",
          "0",
          `${cfg.width}x${cfg.height}x24`,
          "-ac",
          "+extension",
          "GLX",
          "+render",
          "-noreset",
        ],
        localeBundle.envOverrides,
      );
      await this.delay(350);

      this.spawnManagedProcess("openbox", "openbox", [], localeBundle.envOverrides);
      await this.delay(150);

      this.spawnManagedProcess(
        "x11vnc",
        "x11vnc",
        [
          "-display",
          DISPLAY_ID,
          "-localhost",
          "-nopw",
          "-forever",
          "-shared",
          "-xkb",
          "-rfbport",
          String(VNC_INTERNAL_PORT),
        ],
        localeBundle.envOverrides,
      );
      await this.waitForTcpPort(VNC_INTERNAL_PORT, 5_000);

      this.spawnManagedProcess(
        "websockify",
        "websockify",
        [
          "--web",
          "/usr/share/novnc",
          `127.0.0.1:${this.gatewayEnv.NOVNC_UPSTREAM_PORT}`,
          `127.0.0.1:${VNC_INTERNAL_PORT}`,
        ],
        localeBundle.envOverrides,
      );
      await this.waitForTcpPort(this.gatewayEnv.NOVNC_UPSTREAM_PORT, 5_000);

      this.state = "running";
      this.touchActivity();

      await this.launchChromiumBrowser().catch(() => undefined);
      if (cfg.autoStartT3Desktop) {
        await this.launchT3DesktopApp().catch(() => undefined);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      await this.stopStackInternal();
      this.state = "degraded";
      throw err;
    }
  }

  private async stopStackInternal(): Promise<void> {
    this.state = "stopping";
    const reverseOrder = ["t3-desktop", "chromium", "websockify", "x11vnc", "openbox", "xvfb"];
    for (const key of reverseOrder) {
      const proc = this.procs.get(key);
      if (proc) {
        this.procs.delete(key);
        await this.terminateProcess(proc);
      }
    }
    for (const [key, proc] of this.procs.entries()) {
      this.procs.delete(key);
      await this.terminateProcess(proc);
    }
    this.state = "hibernated";
  }

  /**
   * Ensures `desktop-settings.json` sets `localEnvironmentEnabled: false` so T3 Desktop
   * attaches cleanly as a GUI client to the running `t3 serve` without fighting over SQLite locks.
   */
  private async prepareT3DesktopCoexistenceSettings(): Promise<void> {
    const settingsPath = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "desktop-settings.json",
    );
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(settingsPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }

    if (existing.localEnvironmentEnabled === false) {
      return;
    }
    const merged = {
      ...existing,
      localEnvironmentEnabled: false,
    };
    await writeFileAtomic(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, 0o644);
  }

  private async resolveT3DesktopBinary(): Promise<string | null> {
    if (this.gatewayEnv.T3_DESKTOP_BIN_PATH && (await fileExists(this.gatewayEnv.T3_DESKTOP_BIN_PATH))) {
      return this.gatewayEnv.T3_DESKTOP_BIN_PATH;
    }
    const optRoots = [
      path.join(this.gatewayEnv.T3CODE_HOME, "runtime", "current", "opt"),
      "/opt",
    ];
    for (const optRoot of optRoots) {
      const dirs = await fs.readdir(optRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of dirs) {
        if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith("t3 code")) continue;
        for (const exe of ["t3code", "t3-code", "t3-code-nightly"]) {
          const candidate = path.join(optRoot, entry.name, exe);
          if (await fileExists(candidate)) return candidate;
        }
      }
    }
    return null;
  }

  private async resolveCurrentLocaleBundle() {
    const cfg = this.configStore.get();
    return resolveEffectiveDesktopLocale({
      languageOverride: cfg.desktop.languageOverride,
      t3HomeDir: this.gatewayEnv.T3CODE_HOME,
      gatewayLocale: cfg.locale,
    });
  }

  private spawnManagedProcess(
    name: string,
    command: string,
    args: readonly string[],
    localeEnv: Readonly<Record<string, string>>,
  ): ChildProcess {
    const cleanEnv = buildCleanWorkerEnv({
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      extraEnv: {
        DISPLAY: DISPLAY_ID,
        XDG_CURRENT_DESKTOP: "LXQt",
        ...localeEnv,
      },
    });
    const wrapped = wrapPrivilegeDrop(command, args, this.gatewayEnv.CODER_USER);
    const child = spawn(wrapped.cmd, wrapped.args, {
      cwd: this.gatewayEnv.CODER_HOME,
      env: cleanEnv,
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    this.procs.set(name, child);
    child.on("exit", () => {
      if (this.procs.get(name) === child) {
        this.procs.delete(name);
      }
    });
    child.on("error", (err) => {
      this.lastError = `[${name}] ${err.message}`;
    });
    return child;
  }

  private async terminateProcess(proc: ChildProcess): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      proc.once("exit", done);
      try {
        if (process.platform !== "win32" && proc.pid) {
          process.kill(-proc.pid, "SIGTERM");
        } else {
          proc.kill("SIGTERM");
        }
      } catch {
        done();
        return;
      }
      setTimeout(() => {
        if (!settled) {
          try {
            if (process.platform !== "win32" && proc.pid) {
              process.kill(-proc.pid, "SIGKILL");
            } else {
              proc.kill("SIGKILL");
            }
          } catch {
            // Ignore
          }
          setTimeout(done, 250);
        }
      }, 3_000);
    });
  }

  private async checkIdleAutoSleep(): Promise<void> {
    if (this.state !== "running" || this.activeConnections > 0) return;
    const timeoutMin = this.configStore.get().desktop.idleTimeoutMinutes;
    if (timeoutMin <= 0) return;
    if (Date.now() - this.lastActivityMs >= timeoutMin * 60_000) {
      await this.stop().catch(() => undefined);
    }
  }

  private async waitForTcpPort(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const open = await new Promise<boolean>((resolve) => {
        const sock = net.createConnection({ host: "127.0.0.1", port });
        sock.once("connect", () => {
          sock.destroy();
          resolve(true);
        });
        sock.once("error", () => {
          sock.destroy();
          resolve(false);
        });
      });
      if (open) return;
      await this.delay(150);
    }
    throw new Error(`Timed out waiting for desktop port 127.0.0.1:${port}`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private assertSupported(): void {
    if (!this.supported) {
      throw new Error("CAPABILITY_UNAVAILABLE: Virtual desktop is not included in the headless image.");
    }
  }

  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
