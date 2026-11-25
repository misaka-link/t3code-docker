import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type {
  DesktopConfig,
  DesktopState,
  DesktopStatus,
  GatewayEnv,
  PortableEnvironmentBundle,
} from "@t3-docker/shared";
import type { T3AuthBridge } from "../auth-bridge/t3-auth-bridge.js";
import type { ConfigStore } from "../config/config-store.js";
import { buildCleanWorkerEnv } from "../security/env-sanitizer.js";
import { fileExists, writeFileAtomic } from "../utils/atomic-fs.js";
import { runWorkerCommand, wrapPrivilegeDrop } from "../utils/cli-runner.js";
import { resolveEffectiveDesktopLocale, toT3ClientLanguage } from "./browser-locale.js";

const DISPLAY_ID = ":99";
const VNC_INTERNAL_PORT = 5900;
const DBUS_SOCKET_PATH = "/tmp/t3-dbus-session";
const DBUS_SESSION_ADDRESS = `unix:path=${DBUS_SOCKET_PATH}`;

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return true;
  }
}

/**
 * Encrypts a UTF-8 string using Chromium/Electron's Linux `os_crypt` (`gnome_libsecret` v11) format:
 * `"v11" || AES-128-CBC(plaintext, PBKDF2-HMAC-SHA1(secret, "saltysalt", 1, 16), iv=16x0x20)`.
 */
export function encryptLibsecretOsCryptV11(plaintext: string, keyringSecret: string): string {
  const key = crypto.pbkdf2Sync(
    Buffer.from(keyringSecret, "utf8"),
    Buffer.from("saltysalt", "utf8"),
    1,
    16,
    "sha1",
  );
  const iv = Buffer.alloc(16, 0x20);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([
    Buffer.from("v11", "ascii"),
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return encrypted.toString("base64");
}

/**
 * Decrypts a base64-encoded Chromium/Electron Linux `os_crypt` v11 payload, or returns `null` if invalid.
 */
export function decryptLibsecretOsCryptV11(encodedBase64: string, keyringSecret: string): string | null {
  try {
    const raw = Buffer.from(encodedBase64, "base64");
    if (raw.length <= 3 || raw.subarray(0, 3).toString("ascii") !== "v11") {
      return null;
    }
    const key = crypto.pbkdf2Sync(
      Buffer.from(keyringSecret, "utf8"),
      Buffer.from("saltysalt", "utf8"),
      1,
      16,
      "sha1",
    );
    const iv = Buffer.alloc(16, 0x20);
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    const decrypted = Buffer.concat([decipher.update(raw.subarray(3)), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

export function extractLibsecretFromKeyringIni(iniText: string): string | null {
  const itemSecrets = new Map<string, string>();
  const attrNames = new Map<string, string>();
  const osCryptItemIds = new Set<string>();

  let currentSection = "";
  for (const rawLine of iniText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const secMatch = /^\[([^\]]+)\]$/.exec(line);
    if (secMatch) {
      currentSection = secMatch[1]!;
      continue;
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const k = line.slice(0, eqIdx).trim();
    const v = line.slice(eqIdx + 1).trim();

    if (/^\d+$/.test(currentSection) && k === "secret" && v) {
      itemSecrets.set(currentSection, v);
    } else if (/^\d+:attribute\d+$/.test(currentSection)) {
      if (k === "name") {
        attrNames.set(currentSection, v);
      } else if (
        k === "value" &&
        v === "chrome_libsecret_os_crypt_password_v2" &&
        attrNames.get(currentSection) === "xdg:schema"
      ) {
        const itemId = currentSection.split(":")[0]!;
        osCryptItemIds.add(itemId);
      }
    }
  }

  for (const id of osCryptItemIds) {
    const sec = itemSecrets.get(id);
    if (sec) return sec;
  }
  return null;
}

export function buildPreseededKeyringIni(secret: string): string {
  const apps = ["t3code", "t3-code", "t3-code-nightly"];
  const lines = [
    "[keyring]",
    "display-name=login",
    "ctime=0",
    "mtime=0",
    "lock-on-idle=false",
    "lock-after=false",
    "",
    "[1]",
    "item-type=0",
    "display-name=Chrome Safe Storage Control",
    "secret=The meaning of life",
    "mtime=0",
    "ctime=0",
    "",
    "[1:attribute0]",
    "name=explanation",
    "type=string",
    "value=Chrome Safe Storage Control",
    "",
    "[1:attribute1]",
    "name=xdg:schema",
    "type=string",
    "value=_chrome_dummy_schema_for_unlocking",
    "",
  ];
  apps.forEach((appName, idx) => {
    const itemNum = idx + 2;
    lines.push(
      `[${itemNum}]`,
      "item-type=0",
      "display-name=Chromium Safe Storage",
      `secret=${secret}`,
      "mtime=0",
      "ctime=0",
      "",
      `[${itemNum}:attribute0]`,
      "name=application",
      "type=string",
      `value=${appName}`,
      "",
      `[${itemNum}:attribute1]`,
      "name=xdg:schema",
      "type=string",
      "value=chrome_libsecret_os_crypt_password_v2",
      "",
    );
  });
  return `${lines.join("\n")}\n`;
}

export class DesktopSupervisor {
  public readonly supported: boolean;
  private state: DesktopState;
  private readonly procs = new Map<string, ChildProcess>();
  private sessionEnv: Record<string, string> = {};
  private keyringSecret = "";
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

    if (patch.idleTimeoutMinutes !== undefined) {
      this.touchActivity();
    }

    if (patch.languageOverride !== undefined) {
      const targetBcp47 = updated.desktop.languageOverride || updated.locale;
      await this.syncT3ClientSettingsLanguage(targetBcp47).catch(() => undefined);
    }

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

  /**
   * Synchronizes T3 Code's `userdata/client-settings.json` `language` field with the gateway/desktop
   * locale, and restarts the running VNC desktop if its active locale differs.
   */
  public async syncLocaleFromGateway(gatewayLocale: "zh-CN" | "en-US"): Promise<void> {
    const cfg = this.configStore.get().desktop;
    const effectiveTarget = cfg.languageOverride || gatewayLocale;
    await this.syncT3ClientSettingsLanguage(effectiveTarget).catch(() => undefined);

    if (this.supported && this.state === "running" && !cfg.languageOverride) {
      const bundle = await this.resolveCurrentLocaleBundle();
      if (bundle.bcp47 !== this.activeLocale) {
        await this.restart().catch(() => undefined);
      }
    }
  }

  /**
   * Updates the saved loopback environment label inside encrypted `connection-catalog.json`
   * after `T3CODE_ENVIRONMENT_LABEL` changes, and restarts VNC Desktop if currently running.
   */
  public async syncEnvironmentLabel(): Promise<void> {
    if (!this.supported) return;
    const catalogPath = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "connection-catalog.json",
    );
    if (await fileExists(catalogPath)) {
      try {
        const upstreamUrl = `http://${this.gatewayEnv.T3_UPSTREAM_HOST}:${this.gatewayEnv.T3_UPSTREAM_PORT}`;
        const descRes = await fetch(`${upstreamUrl}/.well-known/t3/environment`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (descRes.ok) {
          const desc = (await descRes.json()) as { environmentId?: string; label?: string };
          const secret = this.keyringSecret || (await this.ensureDesktopKeyringSecret());
          if (desc.environmentId && desc.label && secret) {
            const wrapper = JSON.parse(await fs.readFile(catalogPath, "utf8")) as {
              encryptedCatalog?: string;
            };
            const decrypted =
              typeof wrapper.encryptedCatalog === "string"
                ? decryptLibsecretOsCryptV11(wrapper.encryptedCatalog, secret)
                : null;
            if (decrypted) {
              const doc = JSON.parse(decrypted) as {
                targets?: Array<Record<string, unknown>>;
                profiles?: Array<Record<string, unknown>>;
              };
              let changed = false;
              if (Array.isArray(doc.targets)) {
                for (const t of doc.targets) {
                  if (t.environmentId === desc.environmentId && t.label !== desc.label) {
                    t.label = desc.label;
                    changed = true;
                  }
                }
              }
              if (Array.isArray(doc.profiles)) {
                for (const p of doc.profiles) {
                  if (p.environmentId === desc.environmentId && p.label !== desc.label) {
                    p.label = desc.label;
                    changed = true;
                  }
                }
              }
              if (changed) {
                const encryptedCatalog = encryptLibsecretOsCryptV11(JSON.stringify(doc), secret);
                const wrapperJson = `${JSON.stringify({ version: 1, encryptedCatalog }, null, 2)}\n`;
                await runWorkerCommand({
                  command: "node",
                  args: [
                    "-e",
                    "const fs=require('node:fs'),p=process.argv[1],tmp=p+'.tmp';fs.writeFileSync(tmp,process.argv[2],{mode:0o644});fs.renameSync(tmp,p);",
                    catalogPath,
                    wrapperJson,
                  ],
                  gatewayEnv: this.gatewayEnv,
                  workerEnv: this.configStore.get().workerEnv,
                  timeoutMs: 5_000,
                });
              }
            }
          }
        }
      } catch {
        // Ignore best-effort catalog label sync errors
      }
    }

    if (this.state === "running") {
      await this.restart().catch(() => undefined);
    }
  }

  /**
   * Decrypts `userdata/connection-catalog.json` and extracts portable non-loopback `BearerConnectionTarget`
   * environments (plus metadata on any non-exportable `RelayConnectionTarget` entries) for Web sync.
   */
  public async readDesktopCatalogSummary(localEnvId: string | null): Promise<{
    portableEnvironments: PortableEnvironmentBundle[];
    relayTargets: Array<{ environmentId: string; label: string }>;
  }> {
    const catalogPath = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "connection-catalog.json",
    );
    if (!(await fileExists(catalogPath))) {
      return { portableEnvironments: [], relayTargets: [] };
    }

    try {
      const secret = this.keyringSecret || (await this.ensureDesktopKeyringSecret());
      if (!secret) return { portableEnvironments: [], relayTargets: [] };
      const rawWrapper = JSON.parse(await fs.readFile(catalogPath, "utf8")) as {
        encryptedCatalog?: string;
      };
      if (typeof rawWrapper.encryptedCatalog !== "string") {
        return { portableEnvironments: [], relayTargets: [] };
      }
      const decrypted = decryptLibsecretOsCryptV11(rawWrapper.encryptedCatalog, secret);
      if (!decrypted) return { portableEnvironments: [], relayTargets: [] };

      const doc = JSON.parse(decrypted) as {
        targets?: Array<Record<string, unknown>>;
        profiles?: Array<Record<string, unknown>>;
        credentials?: Array<Record<string, unknown>>;
      };
      const targets = Array.isArray(doc.targets) ? doc.targets : [];
      const profiles = Array.isArray(doc.profiles) ? doc.profiles : [];
      const credentials = Array.isArray(doc.credentials) ? doc.credentials : [];

      const portableEnvironments: PortableEnvironmentBundle[] = [];
      const relayTargets: Array<{ environmentId: string; label: string }> = [];

      for (const t of targets) {
        const envId = typeof t.environmentId === "string" ? t.environmentId : "";
        if (!envId || (localEnvId && envId === localEnvId)) continue;

        if (t._tag === "RelayConnectionTarget") {
          relayTargets.push({
            environmentId: envId,
            label: typeof t.label === "string" && t.label ? t.label : envId,
          });
          continue;
        }

        if (t._tag === "BearerConnectionTarget" && typeof t.connectionId === "string") {
          const prof = profiles.find(
            (p) => p._tag === "BearerConnectionProfile" && p.connectionId === t.connectionId,
          );
          const credEntry = credentials.find((c) => c.connectionId === t.connectionId);
          const innerCred =
            credEntry?.credential && typeof credEntry.credential === "object"
              ? (credEntry.credential as Record<string, unknown>)
              : null;
          const httpBaseUrl = typeof prof?.httpBaseUrl === "string" ? prof.httpBaseUrl : "";
          const wsBaseUrl = typeof prof?.wsBaseUrl === "string" ? prof.wsBaseUrl : "";
          const bearerToken =
            innerCred?._tag === "BearerConnectionCredential" && typeof innerCred.token === "string"
              ? innerCred.token
              : "";

          if (!httpBaseUrl || !wsBaseUrl || !bearerToken || isLoopbackUrl(httpBaseUrl)) {
            continue;
          }

          portableEnvironments.push({
            connectionId: t.connectionId,
            environmentId: envId,
            label:
              (typeof t.label === "string" && t.label) ||
              (typeof prof?.label === "string" && prof.label) ||
              envId,
            httpBaseUrl,
            wsBaseUrl,
            bearerToken,
          });
        }
      }

      return { portableEnvironments, relayTargets };
    } catch {
      return { portableEnvironments: [], relayTargets: [] };
    }
  }

  /**
   * Merges portable `BearerConnectionTarget` environments from a Web browser into encrypted
   * `userdata/connection-catalog.json` while preserving the local loopback target and Relay entries.
   */
  public async mergePortableEnvironmentsIntoDesktop(
    localEnvId: string | null,
    incoming: readonly PortableEnvironmentBundle[],
  ): Promise<void> {
    const validIncoming = incoming.filter(
      (b) =>
        b.environmentId &&
        (!localEnvId || b.environmentId !== localEnvId) &&
        !isLoopbackUrl(b.httpBaseUrl),
    );
    if (validIncoming.length === 0) return;

    const secret = this.keyringSecret || (await this.ensureDesktopKeyringSecret());
    if (!secret) return;

    const catalogPath = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "connection-catalog.json",
    );

    interface RawCatalog {
      schemaVersion: 1;
      targets: Array<Record<string, unknown>>;
      profiles: Array<Record<string, unknown>>;
      credentials: Array<Record<string, unknown>>;
      remoteDpopTokens: unknown[];
      disabledEnvironmentIds: string[];
      githubRoutingPermissions?: unknown[];
    }

    let doc: RawCatalog = {
      schemaVersion: 1,
      targets: [],
      profiles: [],
      credentials: [],
      remoteDpopTokens: [],
      disabledEnvironmentIds: [],
    };

    try {
      const rawWrapper = JSON.parse(await fs.readFile(catalogPath, "utf8")) as {
        encryptedCatalog?: string;
      };
      if (typeof rawWrapper.encryptedCatalog === "string") {
        const dec = decryptLibsecretOsCryptV11(rawWrapper.encryptedCatalog, secret);
        if (dec) {
          const parsed = JSON.parse(dec) as Partial<RawCatalog>;
          if (parsed && typeof parsed === "object") {
            doc = {
              schemaVersion: 1,
              targets: Array.isArray(parsed.targets) ? parsed.targets : [],
              profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
              credentials: Array.isArray(parsed.credentials) ? parsed.credentials : [],
              remoteDpopTokens: Array.isArray(parsed.remoteDpopTokens) ? parsed.remoteDpopTokens : [],
              disabledEnvironmentIds: Array.isArray(parsed.disabledEnvironmentIds)
                ? parsed.disabledEnvironmentIds
                : [],
              ...(Array.isArray(parsed.githubRoutingPermissions)
                ? { githubRoutingPermissions: parsed.githubRoutingPermissions }
                : {}),
            };
          }
        }
      }
    } catch {
      // Initialize fresh catalog
    }

    const incomingEnvIds = new Set(validIncoming.map((b) => b.environmentId));
    const incomingConnIds = new Set(validIncoming.map((b) => b.connectionId));

    const keptTargets = doc.targets.filter((t) => {
      if (t._tag !== "BearerConnectionTarget") return true;
      const envId = typeof t.environmentId === "string" ? t.environmentId : "";
      const connId = typeof t.connectionId === "string" ? t.connectionId : "";
      return !incomingEnvIds.has(envId) && !incomingConnIds.has(connId);
    });
    const removedConnIds = new Set(
      doc.targets
        .filter((t) => !keptTargets.includes(t))
        .map((t) => (typeof t.connectionId === "string" ? t.connectionId : ""))
        .filter(Boolean),
    );

    const keptProfiles = doc.profiles.filter((p) => {
      const connId = typeof p.connectionId === "string" ? p.connectionId : "";
      return !incomingConnIds.has(connId) && !removedConnIds.has(connId);
    });
    const keptCredentials = doc.credentials.filter((c) => {
      const connId = typeof c.connectionId === "string" ? c.connectionId : "";
      return !incomingConnIds.has(connId) && !removedConnIds.has(connId);
    });

    const nextDoc: RawCatalog = {
      ...doc,
      schemaVersion: 1,
      targets: [
        ...keptTargets,
        ...validIncoming.map((b) => ({
          _tag: "BearerConnectionTarget",
          environmentId: b.environmentId,
          label: b.label,
          connectionId: b.connectionId,
        })),
      ],
      profiles: [
        ...keptProfiles,
        ...validIncoming.map((b) => ({
          _tag: "BearerConnectionProfile",
          connectionId: b.connectionId,
          environmentId: b.environmentId,
          label: b.label,
          httpBaseUrl: b.httpBaseUrl,
          wsBaseUrl: b.wsBaseUrl,
        })),
      ],
      credentials: [
        ...keptCredentials,
        ...validIncoming.map((b) => ({
          connectionId: b.connectionId,
          credential: {
            _tag: "BearerConnectionCredential",
            token: b.bearerToken,
          },
        })),
      ],
    };

    const encryptedCatalog = encryptLibsecretOsCryptV11(JSON.stringify(nextDoc), secret);
    const wrapperJson = `${JSON.stringify({ version: 1, encryptedCatalog }, null, 2)}\n`;

    if (process.platform === "linux" && this.gatewayEnv.CODER_USER) {
      await runWorkerCommand({
        command: process.execPath,
        args: [
          "-e",
          "const fs=require('node:fs'),path=require('node:path'),p=process.argv[1],tmp=p+'.tmp';fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(tmp,process.argv[2],{mode:0o644});fs.renameSync(tmp,p);",
          catalogPath,
          wrapperJson,
        ],
        gatewayEnv: this.gatewayEnv,
        workerEnv: this.configStore.get().workerEnv,
        cwd: "/tmp",
        timeoutMs: 5_000,
      });
    } else {
      await fs.mkdir(path.dirname(catalogPath), { recursive: true });
      await writeFileAtomic(catalogPath, wrapperJson, 0o644);
    }

    if (this.supported && this.state === "running" && this.procs.has("t3-desktop")) {
      const activeApp = this.procs.get("t3-desktop");
      if (activeApp) {
        this.procs.delete("t3-desktop");
        await this.terminateProcess(activeApp);
      }
      await this.launchT3DesktopApp().catch(() => undefined);
    }
  }

  public async launchT3DesktopApp(): Promise<void> {
    this.assertSupported();
    if (this.state !== "running") {
      await this.start();
    }
    this.touchActivity();

    const binPath = await this.resolveT3DesktopBinary();
    if (!binPath) {
      throw new Error("T3 Desktop executable not found in current runtime.");
    }

    if (this.procs.has("t3-desktop")) {
      const raised = await this.focusX11Window("com.t3tools.t3code", "T3 Code");
      if (raised) return;

      // Electron process is running without a visible X11 window; trigger single-instance reveal
      await this.runDesktopCommand(binPath, ["--no-sandbox"], 5_000).catch(() => undefined);
      await this.delay(400);
      if (await this.focusX11Window("com.t3tools.t3code", "T3 Code")) {
        return;
      }

      const stale = this.procs.get("t3-desktop");
      if (stale) {
        this.procs.delete("t3-desktop");
        await this.terminateProcess(stale);
      }
    }

    await this.prepareT3DesktopCoexistenceSettings();

    const upstreamUrl = `http://${this.gatewayEnv.T3_UPSTREAM_HOST}:${this.gatewayEnv.T3_UPSTREAM_PORT}`;
    const preseeded = await this.preseedVncDesktopCatalog(upstreamUrl).catch(() => false);
    const pairingLink = preseeded
      ? null
      : await this.authBridge.ensureVncDesktopPairingAppLink(upstreamUrl).catch(() => null);

    const localeBundle = await this.resolveCurrentLocaleBundle();
    // Use gnome-libsecret (unlocked via session D-Bus + gnome-keyring-daemon) so Electron's
    // safeStorage.isEncryptionAvailable() is true and T3 Desktop persists connection-catalog.json.
    const args = [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--password-store=gnome-libsecret",
      ...localeBundle.chromiumArgs,
      ...(pairingLink ? [pairingLink] : []),
    ];

    this.spawnManagedProcess("t3-desktop", binPath, args, localeBundle.envOverrides);
    await this.waitForAndFocusWindow("com.t3tools.t3code", "T3 Code", 4_000);
  }

  public async launchChromiumBrowser(focusWindow = true): Promise<void> {
    this.assertSupported();
    if (this.state !== "running") {
      await this.start();
    }
    this.touchActivity();

    if (this.procs.has("chromium")) {
      const hasWindow = await this.hasX11Window("Chromium", "Chromium");
      if (hasWindow) {
        if (focusWindow) {
          await this.focusX11Window("Chromium", "Chromium");
        }
        return;
      }
      const stale = this.procs.get("chromium");
      if (stale) {
        this.procs.delete("chromium");
        await this.terminateProcess(stale);
      }
    }

    const cfg = this.configStore.get().desktop;
    const localeBundle = await this.resolveCurrentLocaleBundle();
    // Dedicated non-default profile path required by Chromium 136+ to allow --remote-debugging-port;
    // do NOT mkdir as root here so Chromium creates it owned by `coder:coder` cleanly.
    const userDataDir = path.join(this.gatewayEnv.CODER_HOME, ".config", "t3-chromium");

    const args = [
      "--no-sandbox",
      "--test-type",
      "--disable-dev-shm-usage",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userDataDir}`,
      `--window-position=0,0`,
      `--window-size=${cfg.width},${Math.max(480, cfg.height - 38)}`,
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${cfg.cdpPort}`,
      ...localeBundle.chromiumArgs,
      "about:blank",
    ];

    this.spawnManagedProcess("chromium", "chromium", args, localeBundle.envOverrides);
    if (focusWindow) {
      await this.waitForAndFocusWindow("Chromium", "Chromium", 3_500);
    }
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
      await fs.rm(DBUS_SOCKET_PATH, { force: true }).catch(() => undefined);

      await this.startSecretServiceSession(localeBundle.envOverrides);
      await this.prepareDesktopEnvironmentFiles(localeBundle.bcp47).catch(() => undefined);

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

      await this.runDesktopCommand("xsetroot", ["-solid", "#141720"], 2_000).catch(() => undefined);

      this.spawnManagedProcess("openbox", "openbox", [], localeBundle.envOverrides);
      await this.delay(150);

      if (await fileExists("/usr/bin/idesk")) {
        this.spawnManagedProcess("idesk", "idesk", [], localeBundle.envOverrides);
      }
      if (await fileExists("/usr/bin/tint2")) {
        this.spawnManagedProcess("tint2", "tint2", [], localeBundle.envOverrides);
      }

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

      await this.launchChromiumBrowser(!cfg.autoStartT3Desktop).catch(() => undefined);
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
    const reverseOrder = [
      "t3-desktop",
      "chromium",
      "tint2",
      "idesk",
      "websockify",
      "x11vnc",
      "openbox",
      "xvfb",
    ];
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

    // Stop session D-Bus & gnome-keyring-daemon cleanly so hibernate returns to 0 MB RAM
    await this.runDesktopCommand(
      "sh",
      [
        "-c",
        "pkill -f 'gnome-keyring-daemon' 2>/dev/null || true; pkill -f '/tmp/t3-dbus-session' 2>/dev/null || true",
      ],
      3_000,
    ).catch(() => undefined);
    await fs.rm(DBUS_SOCKET_PATH, { force: true }).catch(() => undefined);
    this.sessionEnv = {};
    this.state = "hibernated";
  }

  /**
   * Starts a session D-Bus bus and unlocks a passwordless GNOME login keyring as `coder`
   * so Electron's `safeStorage` (`gnome_libsecret`) works out-of-the-box without GUI password prompts.
   */
  private async startSecretServiceSession(
    localeEnv: Readonly<Record<string, string>>,
  ): Promise<void> {
    this.sessionEnv = {};
    await this.ensureDesktopKeyringSecret().catch(() => undefined);

    const setupScript = [
      "set -e",
      `keyrings_target="${this.gatewayEnv.T3CODE_HOME}/.keyrings"`,
      `keyrings_link="${this.gatewayEnv.CODER_HOME}/.local/share/keyrings"`,
      'mkdir -p -m 0700 "$keyrings_target" "$(dirname "$keyrings_link")"',
      'if [ ! -e "$keyrings_link" ]; then ln -s "$keyrings_target" "$keyrings_link"; fi',
      "if command -v dbus-daemon >/dev/null 2>&1; then",
      `  dbus-daemon --session --address="${DBUS_SESSION_ADDRESS}" --fork`,
      `  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_ADDRESS}"`,
      "  if command -v gnome-keyring-daemon >/dev/null 2>&1; then",
      "    printf '' | gnome-keyring-daemon --unlock --components=secrets || true",
      "  fi",
      "fi",
    ].join("\n");

    const res = await runWorkerCommand({
      command: "sh",
      args: ["-c", setupScript],
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      extraEnv: {
        ...localeEnv,
      },
      timeoutMs: 8_000,
    }).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    if (await fileExists(DBUS_SOCKET_PATH)) {
      const envMap: Record<string, string> = {
        DBUS_SESSION_BUS_ADDRESS: DBUS_SESSION_ADDRESS,
      };
      for (const line of res.stdout.split(/\r?\n/)) {
        const trimmed = line.trim().replace(/^export\s+/, "");
        if (trimmed.startsWith("GNOME_KEYRING_CONTROL=")) {
          const val = trimmed.slice("GNOME_KEYRING_CONTROL=".length).replace(/^['"]|['"]$/g, "");
          if (val) envMap.GNOME_KEYRING_CONTROL = val;
        }
      }
      this.sessionEnv = envMap;
    }
  }

  /**
   * Ensures `$T3CODE_HOME/.keyrings/login.keyring` holds a known `chrome_libsecret_os_crypt_password_v2`
   * key before `gnome-keyring-daemon` unlocks it, allowing Gateway to pre-encrypt `connection-catalog.json`.
   */
  private async ensureDesktopKeyringSecret(): Promise<string> {
    const keyringDir = path.join(this.gatewayEnv.T3CODE_HOME, ".keyrings");
    const keyringPath = path.join(keyringDir, "login.keyring");
    const defaultPath = path.join(keyringDir, "default");

    const existingRaw = await fs.readFile(keyringPath, "utf8").catch(() => "");
    const existingSecret = existingRaw ? extractLibsecretFromKeyringIni(existingRaw) : null;
    if (existingSecret) {
      this.keyringSecret = existingSecret;
      return existingSecret;
    }

    const generated = crypto.randomBytes(16).toString("base64");
    const iniPayload = buildPreseededKeyringIni(generated);
    if (process.platform === "linux" && this.gatewayEnv.CODER_USER) {
      await runWorkerCommand({
        command: process.execPath,
        args: [
          "-e",
          "const fs=require('node:fs'),dir=process.argv[1],defFile=process.argv[2],krFile=process.argv[3],body=process.argv[4];fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);fs.writeFileSync(defFile,'login',{mode:0o600});const tmp=krFile+'.tmp';fs.writeFileSync(tmp,body,{mode:0o600});fs.renameSync(tmp,krFile);",
          keyringDir,
          defaultPath,
          keyringPath,
          iniPayload,
        ],
        gatewayEnv: this.gatewayEnv,
        workerEnv: this.configStore.get().workerEnv,
        cwd: "/tmp",
        timeoutMs: 5_000,
      });
    } else {
      await fs.mkdir(keyringDir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(defaultPath, "login", 0o600);
      await writeFileAtomic(keyringPath, iniPayload, 0o600);
    }
    this.keyringSecret = generated;
    return generated;
  }

  /**
   * Pre-seeds an encrypted `userdata/connection-catalog.json` with a live Bearer session token
   * so T3 Desktop boots straight into `/workspace` with ZERO "Add the backend at ...?" prompt.
   */
  private async preseedVncDesktopCatalog(loopbackUpstreamUrl: string): Promise<boolean> {
    const secret = this.keyringSecret || (await this.ensureDesktopKeyringSecret());
    if (!secret) return false;

    const bootstrap = await this.authBridge.bootstrapVncDesktopBearerSession(loopbackUpstreamUrl);
    if (bootstrap.status === "reused") {
      return true;
    }

    const catalogPath = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "connection-catalog.json",
    );

    interface CatalogDoc {
      schemaVersion: 1;
      targets: Array<Record<string, unknown>>;
      profiles: Array<Record<string, unknown>>;
      credentials: Array<Record<string, unknown>>;
      remoteDpopTokens: unknown[];
      disabledEnvironmentIds: string[];
      githubRoutingPermissions?: unknown[];
    }

    let existingCatalog: CatalogDoc = {
      schemaVersion: 1,
      targets: [],
      profiles: [],
      credentials: [],
      remoteDpopTokens: [],
      disabledEnvironmentIds: [],
    };

    try {
      const rawWrapper = JSON.parse(await fs.readFile(catalogPath, "utf8")) as {
        encryptedCatalog?: string;
      };
      if (typeof rawWrapper.encryptedCatalog === "string") {
        const decrypted = decryptLibsecretOsCryptV11(rawWrapper.encryptedCatalog, secret);
        if (decrypted) {
          const parsed = JSON.parse(decrypted) as Partial<CatalogDoc>;
          if (parsed && typeof parsed === "object") {
            existingCatalog = {
              schemaVersion: 1,
              targets: Array.isArray(parsed.targets) ? parsed.targets : [],
              profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
              credentials: Array.isArray(parsed.credentials) ? parsed.credentials : [],
              remoteDpopTokens: Array.isArray(parsed.remoteDpopTokens)
                ? parsed.remoteDpopTokens
                : [],
              disabledEnvironmentIds: Array.isArray(parsed.disabledEnvironmentIds)
                ? parsed.disabledEnvironmentIds
                : [],
              ...(Array.isArray(parsed.githubRoutingPermissions)
                ? { githubRoutingPermissions: parsed.githubRoutingPermissions }
                : {}),
            };
          }
        }
      }
    } catch {
      // Fresh or unreadable catalog; start from clean document
    }

    const origin = new URL(bootstrap.httpBaseUrl).origin;
    const connectionId = `bearer:${bootstrap.environmentId}:${origin}`;

    const keptTargets = existingCatalog.targets.filter(
      (t) => t.environmentId !== bootstrap.environmentId && t.connectionId !== connectionId,
    );
    const keptProfiles = existingCatalog.profiles.filter(
      (p) => p.environmentId !== bootstrap.environmentId && p.connectionId !== connectionId,
    );
    const keptCredentials = existingCatalog.credentials.filter(
      (c) => c.connectionId !== connectionId,
    );

    const nextDoc: CatalogDoc = {
      ...existingCatalog,
      schemaVersion: 1,
      targets: [
        ...keptTargets,
        {
          _tag: "BearerConnectionTarget",
          environmentId: bootstrap.environmentId,
          label: bootstrap.label,
          connectionId,
        },
      ],
      profiles: [
        ...keptProfiles,
        {
          _tag: "BearerConnectionProfile",
          connectionId,
          environmentId: bootstrap.environmentId,
          label: bootstrap.label,
          httpBaseUrl: bootstrap.httpBaseUrl,
          wsBaseUrl: bootstrap.wsBaseUrl,
        },
      ],
      credentials: [
        ...keptCredentials,
        {
          connectionId,
          credential: {
            _tag: "BearerConnectionCredential",
            token: bootstrap.bearerToken,
          },
        },
      ],
      disabledEnvironmentIds: existingCatalog.disabledEnvironmentIds.filter(
        (id) => id !== bootstrap.environmentId,
      ),
    };

    const encryptedCatalog = encryptLibsecretOsCryptV11(JSON.stringify(nextDoc), secret);
    const wrapperJson = `${JSON.stringify({ version: 1, encryptedCatalog }, null, 2)}\n`;

    const writeRes = await runWorkerCommand({
      command: "node",
      args: [
        "-e",
        "const fs=require('node:fs'),path=require('node:path'),p=process.argv[1],tmp=p+'.tmp';fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(tmp,process.argv[2],{mode:0o644});fs.renameSync(tmp,p);",
        catalogPath,
        wrapperJson,
      ],
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      timeoutMs: 5_000,
    });

    return writeRes.code === 0;
  }

  /**
   * Provisions VNC desktop recovery shortcuts so accidentally closed or minimized windows
   * can be reopened directly inside VNC via:
   * 1. Desktop background icons (`idesk`: T3 Code & Chromium)
   * 2. Bottom dock & window taskbar (`tint2`: quick-launchers + active/minimized window list)
   * 3. Openbox right-click desktop root menu (`~/.config/openbox/menu.xml`)
   */
  private async prepareDesktopEnvironmentFiles(bcp47Locale: string): Promise<void> {
    const isZh = bcp47Locale.toLowerCase().startsWith("zh");
    const t3MenuLabel = isZh ? "打开 / 恢复 T3 Code 客户端" : "Open / Restore T3 Code";
    const chromeMenuLabel = isZh ? "打开 / 恢复 Chromium 浏览器" : "Open / Restore Chromium Browser";
    const menuTitle = isZh ? "虚拟桌面快捷恢复" : "Desktop Quick Launch";

    const t3IconCandidates = [
      path.join(
        this.gatewayEnv.T3CODE_HOME,
        "runtime",
        "current",
        "usr/share/icons/hicolor/64x64/apps/t3code.png",
      ),
      "/opt/t3-seed/slot/usr/share/icons/hicolor/64x64/apps/t3code.png",
      "/usr/share/icons/hicolor/64x64/apps/chromium.png",
    ];
    let t3Icon = "/usr/share/pixmaps/chromium.png";
    for (const cand of t3IconCandidates) {
      if (await fileExists(cand)) {
        t3Icon = cand;
        break;
      }
    }
    const chromeIcon = (await fileExists("/usr/share/icons/hicolor/64x64/apps/chromium.png"))
      ? "/usr/share/icons/hicolor/64x64/apps/chromium.png"
      : "/usr/share/pixmaps/chromium.png";

    const coderHome = this.gatewayEnv.CODER_HOME;
    const launcherBin = path.join(coderHome, ".local", "bin", "t3gw-desktop-launch");
    const t3DesktopEntryPath = path.join(
      coderHome,
      ".local",
      "share",
      "applications",
      "t3code-vnc.desktop",
    );
    const chromeDesktopEntryPath = path.join(
      coderHome,
      ".local",
      "share",
      "applications",
      "chromium-vnc.desktop",
    );

    const launcherScript = [
      "#!/bin/sh",
      'target="${1:-t3-desktop}"',
      `token_file="${this.gatewayEnv.T3CODE_HOME}/.desktop-mcp-token"`,
      `port="${this.gatewayEnv.PROXY_PORT}"`,
      'token=""',
      'if [ -f "$token_file" ]; then token="$(tr -d \'\\r\\n\' < "$token_file")"; fi',
      'exec curl -fsS -m 15 -X POST -H "Content-Type: application/json" -H "x-t3gw-wake-token: ${token}" -d "{\\"target\\":\\"${target}\\"}" "http://127.0.0.1:${port}/_t3gw/internal/desktop-launch" >/dev/null 2>&1',
      "",
    ].join("\n");

    const t3DesktopFile = [
      "[Desktop Entry]",
      "Version=1.0",
      "Type=Application",
      "Name=T3 Code",
      `Comment=${t3MenuLabel}`,
      `Exec=${launcherBin} t3-desktop`,
      `Icon=${t3Icon}`,
      "Terminal=false",
      "Categories=Development;",
      "",
    ].join("\n");

    const chromeDesktopFile = [
      "[Desktop Entry]",
      "Version=1.0",
      "Type=Application",
      `Name=${isZh ? "Chromium 浏览器" : "Chromium Browser"}`,
      `Comment=${chromeMenuLabel}`,
      `Exec=${launcherBin} chromium`,
      `Icon=${chromeIcon}`,
      "Terminal=false",
      "Categories=Network;WebBrowser;",
      "",
    ].join("\n");

    const ideskRc = [
      "table Config",
      "  FontName: WenQuanYi Zen Hei",
      "  FontSize: 11",
      "  FontColor: #F4F4F5",
      "  ToolTip.FontSize: 10",
      "  ToolTip.FontName: WenQuanYi Zen Hei",
      "  ToolTip.ForeColor: #F4F4F5",
      "  ToolTip.BackColor: #1E2028",
      "  ToolTip.CaptionOnHover: false",
      "  Locked: true",
      "  Transparency: 75",
      "  Shadow: true",
      "  ShadowColor: #000000",
      "  ShadowX: 1",
      "  ShadowY: 1",
      "  Bold: false",
      "  ClickDelay: 250",
      "  IconSnap: true",
      "  SnapWidth: 16",
      "  SnapHeight: 16",
      "  SnapOrigin: TopLeft",
      "  SnapShadow: false",
      "  CaptionOnHover: false",
      "  CaptionPlacement: bottom",
      "  FillStyle: None",
      "  Background.Delay: 0",
      "  Background.Source: None",
      "  Background.File: None",
      "  Background.Mode: Center",
      "  Background.Color: #141720",
      "end",
      "",
      "table Actions",
      "  Lock: control right doubleClk",
      "  Reload: middle doubleClk",
      "  Drag: right hold",
      "  EndDrag: right singleClk",
      "  Execute[0]: left singleClk",
      "  Execute[1]: left doubleClk",
      "end",
      "",
    ].join("\n");

    const ideskT3 = [
      "table Icon",
      "  Caption: T3 Code",
      `  Command: ${launcherBin} t3-desktop`,
      `  Icon: ${t3Icon}`,
      "  Width: 64",
      "  Height: 64",
      "  X: 36",
      "  Y: 36",
      "end",
      "",
    ].join("\n");

    const ideskChrome = [
      "table Icon",
      "  Caption: Chromium",
      `  Command: ${launcherBin} chromium`,
      `  Icon: ${chromeIcon}`,
      "  Width: 64",
      "  Height: 64",
      "  X: 36",
      "  Y: 152",
      "end",
      "",
    ].join("\n");

    const tint2Rc = [
      "# Background 1: Panel",
      "rounded = 0",
      "border_width = 1",
      "border_sides = T",
      "background_color = #141720 94",
      "border_color = #272a36 100",
      "",
      "# Background 2: Default / Iconified task",
      "rounded = 6",
      "border_width = 1",
      "border_sides = TBLR",
      "background_color = #1f2432 80",
      "border_color = #2e3446 90",
      "background_color_hover = #2a3042 95",
      "border_color_hover = #3f475e 100",
      "",
      "# Background 3: Active task",
      "rounded = 6",
      "border_width = 1",
      "border_sides = TBLR",
      "background_color = #2d3548 100",
      "border_color = #6366f1 90",
      "background_color_hover = #353e54 100",
      "border_color_hover = #818cf8 100",
      "",
      "panel_items = LTC",
      "panel_size = 100% 38",
      "panel_margin = 0 0",
      "panel_padding = 8 4 8",
      "panel_background_id = 1",
      "wm_menu = 1",
      "panel_dock = 0",
      "panel_position = bottom center horizontal",
      "panel_layer = top",
      "panel_monitor = all",
      "strut_policy = follow_size",
      "panel_window_name = tint2",
      "autohide = 0",
      "",
      "launcher_padding = 4 2 8",
      "launcher_background_id = 0",
      "launcher_icon_background_id = 0",
      "launcher_icon_size = 24",
      "launcher_icon_asb = 100 0 0",
      "launcher_icon_theme_override = 0",
      "launcher_tooltip = 1",
      `launcher_item_app = ${t3DesktopEntryPath}`,
      `launcher_item_app = ${chromeDesktopEntryPath}`,
      "",
      "taskbar_mode = single_desktop",
      "taskbar_padding = 4 2 6",
      "taskbar_background_id = 0",
      "taskbar_active_background_id = 0",
      "task_icon = 1",
      "task_text = 1",
      "task_centered = 0",
      "task_maximum_size = 240 30",
      "task_padding = 8 4 6",
      "task_font = WenQuanYi Zen Hei 9.5",
      "task_font_color = #d4d4d8 100",
      "task_active_font_color = #ffffff 100",
      "task_iconified_font_color = #9ca3af 85",
      "task_background_id = 2",
      "task_active_background_id = 3",
      "task_iconified_background_id = 2",
      "mouse_left = toggle_iconify",
      "mouse_middle = none",
      "mouse_right = close",
      "",
      "time1_format = %H:%M",
      "time1_font = WenQuanYi Zen Hei Bold 10",
      "clock_font_color = #e4e4e7 100",
      "clock_padding = 10 2",
      "",
    ].join("\n");

    const openboxMenuXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<openbox_menu xmlns="http://openbox.org/3.4/menu">',
      `  <menu id="root-menu" label="${menuTitle}">`,
      `    <separator label="${menuTitle}" />`,
      `    <item label="${t3MenuLabel}">`,
      "      <action name=\"Execute\">",
      `        <command>${launcherBin} t3-desktop</command>`,
      "      </action>",
      "    </item>",
      `    <item label="${chromeMenuLabel}">`,
      "      <action name=\"Execute\">",
      `        <command>${launcherBin} chromium</command>`,
      "      </action>",
      "    </item>",
      "  </menu>",
      "</openbox_menu>",
      "",
    ].join("\n");

    const filesToWrite = [
      { file: launcherBin, content: launcherScript, mode: 0o755 },
      { file: t3DesktopEntryPath, content: t3DesktopFile, mode: 0o755 },
      { file: chromeDesktopEntryPath, content: chromeDesktopFile, mode: 0o755 },
      { file: path.join(coderHome, "Desktop", "t3code-vnc.desktop"), content: t3DesktopFile, mode: 0o755 },
      { file: path.join(coderHome, "Desktop", "chromium-vnc.desktop"), content: chromeDesktopFile, mode: 0o755 },
      { file: path.join(coderHome, ".ideskrc"), content: ideskRc, mode: 0o644 },
      { file: path.join(coderHome, ".idesktop", "t3code.lnk"), content: ideskT3, mode: 0o644 },
      { file: path.join(coderHome, ".idesktop", "chromium.lnk"), content: ideskChrome, mode: 0o644 },
      { file: path.join(coderHome, ".config", "tint2", "tint2rc"), content: tint2Rc, mode: 0o644 },
      { file: path.join(coderHome, ".config", "openbox", "menu.xml"), content: openboxMenuXml, mode: 0o644 },
    ];

    await runWorkerCommand({
      command: "node",
      args: [
        "-e",
        "const fs=require('node:fs'),path=require('node:path');for(const item of JSON.parse(process.argv[1])){fs.mkdirSync(path.dirname(item.file),{recursive:true});const tmp=item.file+'.tmp';fs.writeFileSync(tmp,item.content,{mode:item.mode});fs.renameSync(tmp,item.file);}",
        JSON.stringify(filesToWrite),
      ],
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      timeoutMs: 5_000,
    });
  }

  /**
   * Ensures `desktop-settings.json` sets `localEnvironmentEnabled: false`, `linuxPasswordStore: "gnome-libsecret"`,
   * and defaults to a maximized window on first launch so T3 Desktop attaches cleanly and fills the VNC viewport.
   */
  private async prepareT3DesktopCoexistenceSettings(): Promise<void> {
    const cfg = this.configStore.get().desktop;
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

    const firstWindowInit =
      existing.mainWindowMaximized === undefined && existing.mainWindowBounds === undefined;

    const merged: Record<string, unknown> = {
      ...existing,
      localEnvironmentEnabled: false,
      linuxPasswordStore: "gnome-libsecret",
      ...(firstWindowInit
          ? {
              mainWindowMaximized: true,
              mainWindowBounds: {
                x: 0,
                y: 0,
                width: cfg.width,
                height: Math.max(480, cfg.height - 38),
              },
            }
          : {}),
    };

    const payload = `${JSON.stringify(merged, null, 2)}\n`;
    await runWorkerCommand({
      command: "node",
      args: [
        "-e",
        "const fs=require('node:fs'),p=process.argv[1],tmp=p+'.tmp';fs.writeFileSync(tmp,process.argv[2],{mode:0o644});fs.renameSync(tmp,p);",
        settingsPath,
        payload,
      ],
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      timeoutMs: 5_000,
    });

    // Seed client-settings.json on first boot so T3 Desktop matches gateway/override language out-of-the-box
    const clientSettingsPath = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "client-settings.json",
    );
    if (!(await fileExists(clientSettingsPath))) {
      const fullCfg = this.configStore.get();
      await this.syncT3ClientSettingsLanguage(
        fullCfg.desktop.languageOverride || fullCfg.locale,
      ).catch(() => undefined);
    }
  }

  public async syncT3ClientSettingsLanguage(bcp47Locale: string): Promise<void> {
    const clientSettingsPath = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "client-settings.json",
    );
    const targetLang = toT3ClientLanguage(bcp47Locale);
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(clientSettingsPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        existing =
          record.settings && typeof record.settings === "object" && !Array.isArray(record.settings)
            ? (record.settings as Record<string, unknown>)
            : record;
      }
    } catch {
      existing = {};
    }

    if (existing.language === targetLang) {
      return;
    }
    const merged = {
      ...existing,
      language: targetLang,
    };
    const payload = `${JSON.stringify(merged, null, 2)}\n`;
    await runWorkerCommand({
      command: "node",
      args: [
        "-e",
        "const fs=require('node:fs'),path=require('node:path'),p=process.argv[1],tmp=p+'.tmp';fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(tmp,process.argv[2],{mode:0o644});fs.renameSync(tmp,p);",
        clientSettingsPath,
        payload,
      ],
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      timeoutMs: 5_000,
    });
  }

  private async hasX11Window(wmClassHint: string, titleHint: string): Promise<boolean> {
    // Guard against wmctrl 1.07 segfaulting when Openbox _NET_CLIENT_LIST is empty
    const clientList = await this.runDesktopCommand("xprop", ["-root", "_NET_CLIENT_LIST"], 2_000).catch(
      () => null,
    );
    if (!clientList || clientList.code !== 0 || !/0x[0-9a-fA-F]+/.test(clientList.stdout)) {
      return false;
    }
    const res = await this.runDesktopCommand("wmctrl", ["-lx"], 2_500).catch(() => null);
    if (!res || res.code !== 0) return false;
    const lowerClass = wmClassHint.toLowerCase();
    const lowerTitle = titleHint.toLowerCase();
    return res.stdout
      .split(/\r?\n/)
      .some((line) => {
        const lower = line.toLowerCase();
        return lower.includes(lowerClass) || lower.includes(lowerTitle);
      });
  }

  private async focusX11Window(wmClassHint: string, titleHint: string): Promise<boolean> {
    const hasWin = await this.hasX11Window(wmClassHint, titleHint);
    if (!hasWin) return false;
    await this.runDesktopCommand(
      "sh",
      [
        "-c",
        `wmctrl -x -r "${wmClassHint}" -b remove,hidden 2>/dev/null || true; wmctrl -x -a "${wmClassHint}" 2>/dev/null || wmctrl -a "${titleHint}" 2>/dev/null || true`,
      ],
      2_500,
    ).catch(() => undefined);
    return true;
  }

  private async waitForAndFocusWindow(
    wmClassHint: string,
    titleHint: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.focusX11Window(wmClassHint, titleHint)) {
        return;
      }
      await this.delay(250);
    }
  }

  private async runDesktopCommand(
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return runWorkerCommand({
      command,
      args,
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      extraEnv: {
        DISPLAY: DISPLAY_ID,
        ...this.sessionEnv,
      },
      timeoutMs,
    });
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
        XDG_CURRENT_DESKTOP: "GNOME",
        ...this.sessionEnv,
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
