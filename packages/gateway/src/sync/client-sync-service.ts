import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ClientSyncPushRequest,
  ClientSyncState,
  GatewayEnv,
} from "@t3-docker/shared";
import type { ConfigStore } from "../config/config-store.js";
import type { DesktopSupervisor } from "../desktop/desktop-supervisor.js";
import type { T3ProcessSupervisor } from "../supervisor/t3-supervisor.js";
import { writeFileAtomic } from "../utils/atomic-fs.js";
import { runWorkerCommand } from "../utils/cli-runner.js";

const ALLOWED_WEB_EXTRA_EXACT_KEYS = new Set([
  "t3code:theme",
  "t3code:theme-appearance-mode",
  "t3code:theme-follow-system",
  "t3code:theme-halves:v1",
  "t3code:themes:v1",
  "t3code:environment-themes:v1",
  "t3code:typography-advanced",
  "t3code:ui-state:v1",
  "t3code:last-enabled-project-grouping-mode",
]);

function filterAllowedWebExtras(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || v.length > 256_000) continue;
    if (ALLOWED_WEB_EXTRA_EXACT_KEYS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

interface PersistedExtrasDoc {
  readonly webExtras: Record<string, string>;
  readonly updatedAt: string;
}

/**
 * Bidirectional synchronizer bridging T3 Desktop's container-persisted client files
 * (`userdata/client-settings.json` & encrypted `userdata/connection-catalog.json`)
 * with any browser's `localStorage` (`t3code:client-settings:v1`, `t3code:theme*`) and
 * `IndexedDB("t3code:connection-runtime")` (`catalog` -> `"document"`).
 */
export class ClientSyncService {
  private readonly clientSettingsPath: string;
  private readonly extrasPath: string;

  public constructor(
    private readonly gatewayEnv: GatewayEnv,
    private readonly configStore: ConfigStore,
    private readonly supervisor: T3ProcessSupervisor,
    private readonly desktopSupervisor: DesktopSupervisor,
  ) {
    this.clientSettingsPath = path.join(
      gatewayEnv.T3CODE_HOME,
      "userdata",
      "client-settings.json",
    );
    this.extrasPath = path.join(gatewayEnv.T3GW_DATA_DIR, "client-sync-extras.json");
  }

  public async getSyncState(): Promise<ClientSyncState> {
    const localEnvId = await this.resolveLocalEnvironmentId();
    const [clientSettingsRes, extrasRes, catalogSummary] = await Promise.all([
      this.readDesktopClientSettings(),
      this.readPersistedExtras(),
      this.desktopSupervisor.readDesktopCatalogSummary(localEnvId),
    ]);

    const updatedAt = extrasRes.updatedAt ?? clientSettingsRes.mtimeIso ?? null;

    return {
      localEnvironmentId: localEnvId,
      autoSyncOnLogin: this.configStore.get().autoSyncClientConfig,
      clientSettings: clientSettingsRes.settings,
      webExtras: extrasRes.webExtras,
      portableEnvironments: catalogSummary.portableEnvironments,
      relayTargets: catalogSummary.relayTargets,
      updatedAt,
    };
  }

  public async pushFromBrowser(input: ClientSyncPushRequest): Promise<ClientSyncState> {
    if (input.autoSyncOnLogin !== undefined) {
      await this.configStore.update({ autoSyncClientConfig: input.autoSyncOnLogin });
    }

    const nowIso = new Date().toISOString();

    if (input.clientSettings && Object.keys(input.clientSettings).length > 0) {
      const existing = (await this.readDesktopClientSettings()).settings;
      const merged = {
        ...existing,
        ...input.clientSettings,
      };
      await this.writeDesktopClientSettings(merged);
    }

    if (input.webExtras) {
      const existingExtras = (await this.readPersistedExtras()).webExtras;
      const mergedExtras = {
        ...existingExtras,
        ...filterAllowedWebExtras(input.webExtras),
      };
      const doc: PersistedExtrasDoc = {
        webExtras: mergedExtras,
        updatedAt: nowIso,
      };
      await fs.mkdir(path.dirname(this.extrasPath), { recursive: true });
      await writeFileAtomic(this.extrasPath, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
    }

    if (input.portableEnvironments && input.portableEnvironments.length > 0) {
      const localEnvId = await this.resolveLocalEnvironmentId();
      await this.desktopSupervisor.mergePortableEnvironmentsIntoDesktop(
        localEnvId,
        input.portableEnvironments,
      );
    }

    return this.getSyncState();
  }

  private async resolveLocalEnvironmentId(): Promise<string | null> {
    const cached = this.supervisor.getEnvironmentId();
    if (cached) return cached;
    try {
      const res = await fetch(`${this.supervisor.upstreamUrl}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { environmentId?: string };
      return typeof body.environmentId === "string" ? body.environmentId : null;
    } catch {
      return null;
    }
  }

  private async readDesktopClientSettings(): Promise<{
    settings: Record<string, unknown>;
    mtimeIso: string | null;
  }> {
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(this.clientSettingsPath, "utf8"),
        fs.stat(this.clientSettingsPath),
      ]);
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          settings: parsed as Record<string, unknown>,
          mtimeIso: stat.mtime.toISOString(),
        };
      }
    } catch {
      // File may not exist yet
    }
    return { settings: {}, mtimeIso: null };
  }

  private async writeDesktopClientSettings(settings: Record<string, unknown>): Promise<void> {
    const payload = `${JSON.stringify(settings, null, 2)}\n`;
    if (process.platform === "linux" && this.gatewayEnv.CODER_USER) {
      await runWorkerCommand({
        command: process.execPath,
        args: [
          "-e",
          "const fs=require('node:fs'),path=require('node:path'),p=process.argv[1],dir=path.dirname(p),tmp=p+'.tmp';fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(tmp,process.argv[2],{mode:0o600});fs.renameSync(tmp,p);",
          this.clientSettingsPath,
          payload,
        ],
        gatewayEnv: this.gatewayEnv,
        workerEnv: this.configStore.get().workerEnv,
        timeoutMs: 5_000,
      });
      return;
    }
    await fs.mkdir(path.dirname(this.clientSettingsPath), { recursive: true });
    await writeFileAtomic(this.clientSettingsPath, payload, 0o600);
  }

  private async readPersistedExtras(): Promise<{
    webExtras: Record<string, string>;
    updatedAt: string | null;
  }> {
    try {
      const raw = await fs.readFile(this.extrasPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedExtrasDoc>;
      if (parsed && typeof parsed === "object" && parsed.webExtras) {
        return {
          webExtras: filterAllowedWebExtras(parsed.webExtras),
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
        };
      }
    } catch {
      // Not created yet
    }
    return { webExtras: {}, updatedAt: null };
  }
}
