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
  "t3code:sidebar:working-expanded",
  "t3code:right-panel-state:v2",
]);

const LEVELDB_BLOCK_SIZE = 32_768;
const LEVELDB_HEADER_SIZE = 7;
const ELECTRON_APP_ORIGIN_PREFIX = Buffer.from("_t3code://app\x00", "latin1");

function decodeBlinkStorageString(buf: Buffer): string | null {
  if (buf.length === 0) return "";
  const formatTag = buf[0];
  const payload = buf.subarray(1);
  if (formatTag === 0x01) {
    return payload.toString("latin1");
  }
  if (formatTag === 0x00) {
    return payload.toString("utf16le");
  }
  return null;
}

function readVarint32(
  buf: Buffer,
  startOffset: number,
): { value: number; nextOffset: number } | null {
  let result = 0;
  let shift = 0;
  let offset = startOffset;
  while (shift <= 28 && offset < buf.length) {
    const byte = buf[offset]!;
    offset += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, nextOffset: offset };
    }
    shift += 7;
  }
  return null;
}

/**
 * Parses a Chromium/Electron `Local Storage/leveldb/*.log` file (LevelDB 32 KiB block log +
 * WriteBatch records) and applies `t3code://app` allowlisted keys/deletions into `targetMap`.
 */
export function applyChromiumLevelDbLogBuffer(
  buf: Buffer,
  targetMap: Map<string, string>,
): void {
  const writeBatches: Buffer[] = [];
  let pendingFragments: Buffer[] = [];
  let blockStart = 0;

  while (blockStart < buf.length) {
    const blockEnd = Math.min(buf.length, blockStart + LEVELDB_BLOCK_SIZE);
    let pos = blockStart;

    while (pos + LEVELDB_HEADER_SIZE <= blockEnd) {
      const length = buf.readUInt16LE(pos + 4);
      const recType = buf[pos + 6]!;
      pos += LEVELDB_HEADER_SIZE;

      if (recType === 0 && length === 0) {
        break;
      }
      if (pos + length > blockEnd) {
        pendingFragments = [];
        break;
      }

      const slice = buf.subarray(pos, pos + length);
      pos += length;

      if (recType === 1) {
        pendingFragments = [];
        writeBatches.push(slice);
      } else if (recType === 2) {
        pendingFragments = [slice];
      } else if (recType === 3 && pendingFragments.length > 0) {
        pendingFragments.push(slice);
      } else if (recType === 4 && pendingFragments.length > 0) {
        pendingFragments.push(slice);
        writeBatches.push(Buffer.concat(pendingFragments));
        pendingFragments = [];
      } else {
        pendingFragments = [];
      }
    }

    blockStart += LEVELDB_BLOCK_SIZE;
  }

  for (const batch of writeBatches) {
    if (batch.length < 12) continue;
    const count = batch.readUInt32LE(8);
    let offset = 12;

    for (let i = 0; i < count && offset < batch.length; i += 1) {
      const tag = batch[offset]!;
      offset += 1;

      const keyLen = readVarint32(batch, offset);
      if (!keyLen || keyLen.nextOffset + keyLen.value > batch.length) break;
      const keyBytes = batch.subarray(keyLen.nextOffset, keyLen.nextOffset + keyLen.value);
      offset = keyLen.nextOffset + keyLen.value;

      let decodedKey: string | null = null;
      if (
        keyBytes.length > ELECTRON_APP_ORIGIN_PREFIX.length &&
        keyBytes.subarray(0, ELECTRON_APP_ORIGIN_PREFIX.length).equals(ELECTRON_APP_ORIGIN_PREFIX)
      ) {
        decodedKey = decodeBlinkStorageString(keyBytes.subarray(ELECTRON_APP_ORIGIN_PREFIX.length));
      }

      if (tag === 0x01) {
        const valLen = readVarint32(batch, offset);
        if (!valLen || valLen.nextOffset + valLen.value > batch.length) break;
        const valBytes = batch.subarray(valLen.nextOffset, valLen.nextOffset + valLen.value);
        offset = valLen.nextOffset + valLen.value;

        if (decodedKey && ALLOWED_WEB_EXTRA_EXACT_KEYS.has(decodedKey)) {
          const decodedVal = decodeBlinkStorageString(valBytes);
          if (decodedVal !== null && decodedVal.length <= 256_000) {
            targetMap.set(decodedKey, decodedVal);
          }
        }
      } else if (tag === 0x00) {
        if (decodedKey && ALLOWED_WEB_EXTRA_EXACT_KEYS.has(decodedKey)) {
          targetMap.delete(decodedKey);
        }
      } else {
        break;
      }
    }
  }
}

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
    const [clientSettingsRes, extrasRes, desktopLevelDbRes, catalogSummary] = await Promise.all([
      this.readDesktopClientSettings(),
      this.readPersistedExtras(),
      this.readDesktopElectronLocalStorageExtras(),
      this.desktopSupervisor.readDesktopCatalogSummary(localEnvId),
    ]);

    const rawPersistedMs = extrasRes.updatedAt ? Date.parse(extrasRes.updatedAt) : 0;
    const persistedMs = Number.isFinite(rawPersistedMs) ? rawPersistedMs : 0;

    const mergedWebExtras =
      desktopLevelDbRes.mtimeMs > persistedMs
        ? { ...extrasRes.webExtras, ...desktopLevelDbRes.webExtras }
        : { ...desktopLevelDbRes.webExtras, ...extrasRes.webExtras };

    const rawSettingsMs = clientSettingsRes.mtimeIso ? Date.parse(clientSettingsRes.mtimeIso) : 0;
    const settingsMs = Number.isFinite(rawSettingsMs) ? rawSettingsMs : 0;
    const latestMs = Math.max(persistedMs, desktopLevelDbRes.mtimeMs, settingsMs);
    const updatedAt = latestMs > 0 ? new Date(latestMs).toISOString() : null;

    return {
      localEnvironmentId: localEnvId,
      autoSyncOnLogin: this.configStore.get().autoSyncClientConfig,
      clientSettings: clientSettingsRes.settings,
      webExtras: mergedWebExtras,
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
    let desktopMutated = false;

    if (input.clientSettings && Object.keys(input.clientSettings).length > 0) {
      const existing = (await this.readDesktopClientSettings()).settings;
      const merged = {
        ...existing,
        ...input.clientSettings,
      };
      await this.writeDesktopClientSettings(merged);
      desktopMutated = true;
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
      const catalogUpdated = await this.desktopSupervisor.mergePortableEnvironmentsIntoDesktop(
        localEnvId,
        input.portableEnvironments,
        { reloadRunningApp: false },
      );
      if (catalogUpdated) {
        desktopMutated = true;
      }
    }

    if (desktopMutated) {
      await this.desktopSupervisor.reloadRunningT3DesktopApp();
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

  private async readDesktopElectronLocalStorageExtras(): Promise<{
    webExtras: Record<string, string>;
    mtimeMs: number;
    mtimeIso: string | null;
  }> {
    const configRoot = path.join(this.gatewayEnv.CODER_HOME, ".config");
    const candidateDirs = [
      path.join(configRoot, "T3 Code", "Local Storage", "leveldb"),
      path.join(configRoot, "t3code", "Local Storage", "leveldb"),
      path.join(configRoot, "t3code-v2", "Local Storage", "leveldb"),
    ];

    const dirSnapshots: Array<{ dirLatestMtimeMs: number; buffers: Buffer[] }> = [];
    let latestMtimeMs = 0;

    for (const levelDbDir of candidateDirs) {
      try {
        const entries = await fs.readdir(levelDbDir, { withFileTypes: true });
        const logFiles = entries
          .filter((e) => e.isFile() && e.name.endsWith(".log"))
          .map((e) => e.name)
          .sort();
        if (logFiles.length === 0) continue;

        const buffers: Buffer[] = [];
        let dirLatestMtimeMs = 0;
        for (const filename of logFiles) {
          const fullPath = path.join(levelDbDir, filename);
          const [buf, stat] = await Promise.all([fs.readFile(fullPath), fs.stat(fullPath)]);
          if (stat.mtimeMs > dirLatestMtimeMs) {
            dirLatestMtimeMs = stat.mtimeMs;
          }
          if (stat.mtimeMs > latestMtimeMs) {
            latestMtimeMs = stat.mtimeMs;
          }
          buffers.push(buf);
        }
        dirSnapshots.push({ dirLatestMtimeMs, buffers });
      } catch {
        // Directory may not exist before VNC Desktop has been launched
      }
    }

    dirSnapshots.sort((a, b) => a.dirLatestMtimeMs - b.dirLatestMtimeMs);
    const collected = new Map<string, string>();
    for (const snap of dirSnapshots) {
      for (const buf of snap.buffers) {
        applyChromiumLevelDbLogBuffer(buf, collected);
      }
    }

    const webExtras: Record<string, string> = {};
    for (const [k, v] of collected.entries()) {
      webExtras[k] = v;
    }

    return {
      webExtras,
      mtimeMs: latestMtimeMs,
      mtimeIso: latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null,
    };
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
