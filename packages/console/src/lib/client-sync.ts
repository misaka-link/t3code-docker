import type {
  ClientSyncPushRequest,
  ClientSyncState,
  PortableEnvironmentBundle,
} from "@t3-docker/shared";
import { gatewayApi } from "./api";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";
const LOCAL_STORAGE_CHANGE_EVENT = "t3code:local_storage_change";
const IDB_NAME = "t3code:connection-runtime";
const IDB_VERSION = 5;
const IDB_OPEN_TIMEOUT_MS = 3_000;
const CATALOG_STORE = "catalog";
const CATALOG_DOC_KEY = "document";

const SYNCABLE_WEB_EXTRA_KEYS = [
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
] as const;

interface T3CatalogDocument {
  schemaVersion: 1;
  targets: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  credentials: Array<Record<string, unknown>>;
  remoteDpopTokens: unknown[];
  disabledEnvironmentIds: string[];
  githubRoutingPermissions?: unknown[];
}

function emptyCatalogDoc(): T3CatalogDocument {
  return {
    schemaVersion: 1,
    targets: [],
    profiles: [],
    credentials: [],
    remoteDpopTokens: [],
    disabledEnvironmentIds: [],
  };
}

function isLoopbackHost(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return true;
  }
}

function ensureT3ObjectStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains("catalog")) db.createObjectStore("catalog");
  if (!db.objectStoreNames.contains("shell")) db.createObjectStore("shell");
  if (!db.objectStoreNames.contains("thread")) db.createObjectStore("thread");
  if (!db.objectStoreNames.contains("server-config")) db.createObjectStore("server-config");
  if (!db.objectStoreNames.contains("vcs-refs")) db.createObjectStore("vcs-refs");
  if (!db.objectStoreNames.contains("query")) {
    db.createObjectStore("query").createIndex("environment-updated", [
      "environmentId",
      "updatedAt",
      "bytes",
    ]);
  }
}

function openIdbWithGuard(version?: number): Promise<{ db: IDBDatabase; createdFresh: boolean }> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this browser context."));
      return;
    }

    let settled = false;
    let createdFresh = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Timed out opening t3code:connection-runtime IndexedDB."));
      }
    }, IDB_OPEN_TIMEOUT_MS);

    let req: IDBOpenDBRequest;
    try {
      req = version !== undefined ? indexedDB.open(IDB_NAME, version) : indexedDB.open(IDB_NAME);
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    req.addEventListener("upgradeneeded", (ev) => {
      if (version !== undefined) {
        ensureT3ObjectStores(req.result);
      } else if (ev.oldVersion === 0) {
        createdFresh = true;
      }
    });
    req.addEventListener("blocked", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("IndexedDB connection is temporarily blocked by another open tab."));
      }
    });
    req.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(req.error ?? new Error("Failed to open t3code:connection-runtime IndexedDB"));
      }
    });
    req.addEventListener("success", () => {
      if (settled) {
        req.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ db: req.result, createdFresh });
    });
  });
}

/**
 * Opens `t3code:connection-runtime` compatibly across all T3 Code versions:
 * - If the DB already exists (v5, v6, or newer Nightly), opens at its native version without `VersionError`;
 * - If no DB exists yet on a fresh browser, initializes T3's v5 objectStore schema cleanly.
 */
async function openT3ConnectionDatabase(): Promise<IDBDatabase> {
  const probe = await openIdbWithGuard();
  if (!probe.createdFresh && probe.db.objectStoreNames.contains(CATALOG_STORE)) {
    return probe.db;
  }
  probe.db.close();
  const upgraded = await openIdbWithGuard(IDB_VERSION);
  return upgraded.db;
}

function notifyT3LocalStorageKeyChanged(key: string): void {
  try {
    window.dispatchEvent(new CustomEvent(LOCAL_STORAGE_CHANGE_EVENT, { detail: { key } }));
  } catch {
    // Ignore custom event dispatch errors
  }
}

async function readBrowserCatalogDoc(): Promise<T3CatalogDocument> {
  const db = await openT3ConnectionDatabase();
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(CATALOG_STORE, "readonly");
      const getReq = tx.objectStore(CATALOG_STORE).get(CATALOG_DOC_KEY);
      getReq.addEventListener("error", () => reject(getReq.error ?? new Error("IDB read failed")));
      getReq.addEventListener("success", () => resolve(getReq.result));
    });
    if (typeof raw === "string" && raw.trim()) {
      const parsed = JSON.parse(raw) as Partial<T3CatalogDocument>;
      if (parsed && typeof parsed === "object") {
        return {
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
    return emptyCatalogDoc();
  } catch {
    return emptyCatalogDoc();
  } finally {
    db.close();
  }
}

async function writeBrowserCatalogDoc(doc: T3CatalogDocument): Promise<void> {
  const db = await openT3ConnectionDatabase();
  try {
    const serialized = JSON.stringify(doc);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CATALOG_STORE, "readwrite");
      tx.addEventListener("abort", () => reject(tx.error ?? new Error("IDB write aborted")));
      tx.addEventListener("complete", () => resolve());
      tx.objectStore(CATALOG_STORE).put(serialized, CATALOG_DOC_KEY);
    });
  } finally {
    db.close();
  }
}

export interface ApplySyncResult {
  readonly settingsCount: number;
  readonly webExtrasCount: number;
  readonly environmentsCount: number;
  readonly idbWarning?: string;
}

export async function applySyncStateToBrowser(state: ClientSyncState): Promise<ApplySyncResult> {
  let settingsCount = 0;
  if (Object.keys(state.clientSettings).length > 0) {
    let existingSettings: Record<string, unknown> = {};
    try {
      const raw = window.localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existingSettings = parsed as Record<string, unknown>;
        }
      }
    } catch {
      existingSettings = {};
    }
    const merged = {
      ...existingSettings,
      ...state.clientSettings,
    };
    window.localStorage.setItem(CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify(merged));
    notifyT3LocalStorageKeyChanged(CLIENT_SETTINGS_STORAGE_KEY);
    settingsCount = Object.keys(state.clientSettings).length;
  }

  let webExtrasCount = 0;
  for (const [key, val] of Object.entries(state.webExtras)) {
    try {
      window.localStorage.setItem(key, val);
      notifyT3LocalStorageKeyChanged(key);
      webExtrasCount += 1;
    } catch {
      // Ignore quota errors
    }
  }

  const incoming = state.portableEnvironments.filter(
    (b) =>
      b.environmentId &&
      (!state.localEnvironmentId || b.environmentId !== state.localEnvironmentId) &&
      !isLoopbackHost(b.httpBaseUrl),
  );

  let appliedEnvCount = 0;
  let idbWarning: string | undefined;

  if (incoming.length > 0) {
    try {
      const currentDoc = await readBrowserCatalogDoc();
      const incomingEnvIds = new Set(incoming.map((b) => b.environmentId));
      const incomingConnIds = new Set(incoming.map((b) => b.connectionId));

      const keptTargets = currentDoc.targets.filter((t) => {
        if (t._tag !== "BearerConnectionTarget") return true;
        const envId = typeof t.environmentId === "string" ? t.environmentId : "";
        const connId = typeof t.connectionId === "string" ? t.connectionId : "";
        return !incomingEnvIds.has(envId) && !incomingConnIds.has(connId);
      });
      const removedConnIds = new Set(
        currentDoc.targets
          .filter((t) => !keptTargets.includes(t))
          .map((t) => (typeof t.connectionId === "string" ? t.connectionId : ""))
          .filter(Boolean),
      );

      const keptProfiles = currentDoc.profiles.filter((p) => {
        const connId = typeof p.connectionId === "string" ? p.connectionId : "";
        return !incomingConnIds.has(connId) && !removedConnIds.has(connId);
      });
      const keptCredentials = currentDoc.credentials.filter((c) => {
        const connId = typeof c.connectionId === "string" ? c.connectionId : "";
        return !incomingConnIds.has(connId) && !removedConnIds.has(connId);
      });

      const nextDoc: T3CatalogDocument = {
        ...currentDoc,
        schemaVersion: 1,
        targets: [
          ...keptTargets,
          ...incoming.map((b) => ({
            _tag: "BearerConnectionTarget",
            environmentId: b.environmentId,
            label: b.label,
            connectionId: b.connectionId,
          })),
        ],
        profiles: [
          ...keptProfiles,
          ...incoming.map((b) => ({
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
          ...incoming.map((b) => ({
            connectionId: b.connectionId,
            credential: {
              _tag: "BearerConnectionCredential",
              token: b.bearerToken,
            },
          })),
        ],
      };

      await writeBrowserCatalogDoc(nextDoc);
      appliedEnvCount = incoming.length;
    } catch (err) {
      idbWarning = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    settingsCount,
    webExtrasCount,
    environmentsCount: appliedEnvCount,
    ...(idbWarning ? { idbWarning } : {}),
  };
}

export async function collectBrowserSyncPayload(
  localEnvironmentId: string | null,
): Promise<ClientSyncPushRequest> {
  let clientSettings: Record<string, unknown> = {};
  try {
    const raw = window.localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        clientSettings = parsed as Record<string, unknown>;
      }
    }
  } catch {
    clientSettings = {};
  }

  const webExtras: Record<string, string> = {};
  for (const key of SYNCABLE_WEB_EXTRA_KEYS) {
    const v = window.localStorage.getItem(key);
    if (typeof v === "string") {
      webExtras[key] = v;
    }
  }

  const portableEnvironments: PortableEnvironmentBundle[] = [];
  try {
    const doc = await readBrowserCatalogDoc();
    for (const t of doc.targets) {
      if (t._tag !== "BearerConnectionTarget" || typeof t.connectionId !== "string") continue;
      const envId = typeof t.environmentId === "string" ? t.environmentId : "";
      if (!envId || (localEnvironmentId && envId === localEnvironmentId)) continue;

      const prof = doc.profiles.find(
        (p) => p._tag === "BearerConnectionProfile" && p.connectionId === t.connectionId,
      );
      const credEntry = doc.credentials.find((c) => c.connectionId === t.connectionId);
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

      if (!httpBaseUrl || !wsBaseUrl || !bearerToken || isLoopbackHost(httpBaseUrl)) continue;

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
  } catch {
    // Ignore IndexedDB errors
  }

  return {
    clientSettings,
    webExtras,
    portableEnvironments,
  };
}

export async function autoHydrateBrowserOnLogin(): Promise<void> {
  try {
    const state = await gatewayApi.getSyncState();
    if (!state.autoSyncOnLogin) return;
    await applySyncStateToBrowser(state);
  } catch {
    // Best-effort auto-sync; never block login redirect
  }
}
