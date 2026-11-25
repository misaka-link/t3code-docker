import {
  GATEWAY_API_PREFIX,
  type BootstrapResponse,
  type ConnectStatus,
  type DesktopConfig,
  type DesktopStatus,
  type GatewayPersistedConfig,
  type ProvidersOverview,
  type SnapshotItem,
  type SnapshotScope,
  type SupervisorStatus,
  type UpdateGatewaySettingsRequest,
  type VersionsOverview,
  type WorkerEnvConfig,
} from "@t3-docker/shared";

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GATEWAY_API_PREFIX}${path}`, {
    credentials: "same-origin",
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!res.ok) {
    let payload: { error?: string; code?: string } = {};
    try {
      payload = (await res.json()) as { error?: string; code?: string };
    } catch {
      // Ignore
    }
    throw new ApiError(payload.error || `HTTP ${res.status}`, res.status, payload.code);
  }

  return (await res.json()) as T;
}

export const gatewayApi = {
  getBootstrap: () => requestJson<BootstrapResponse>("/bootstrap"),

  completeSetup: (input: {
    password: string;
    locale?: "zh-CN" | "en-US";
    theme?: "dark" | "light" | "system";
    environmentLabel?: string;
  }) =>
    requestJson<{ ok: boolean }>("/auth/setup", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  login: (password: string) =>
    requestJson<{ ok: boolean }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  logout: () => requestJson<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  getSupervisorStatus: () => requestJson<SupervisorStatus>("/supervisor/status"),

  supervisorAction: (action: "start" | "stop" | "restart" | "doctor" | "warm-headless-browser") =>
    requestJson<{ ok: boolean; output?: string; status: SupervisorStatus }>("/supervisor/action", {
      method: "POST",
      body: JSON.stringify({ action }),
    }),

  getVersions: (refresh = false) =>
    requestJson<VersionsOverview>(`/versions${refresh ? "?refresh=1" : ""}`),

  installVersion: (input: {
    version: string;
    channel?: "stable" | "nightly";
    createSnapshotBeforeSwitch?: boolean;
    async?: boolean;
  }) =>
    requestJson<VersionsOverview>("/versions/install", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  deleteVersion: (version: string) =>
    requestJson<VersionsOverview>(`/versions/${encodeURIComponent(version)}`, {
      method: "DELETE",
    }),

  getConnectStatus: () => requestJson<ConnectStatus>("/connect/status"),

  toggleConnect: (enabled: boolean, restartImmediately = true) =>
    requestJson<ConnectStatus>("/connect/toggle", {
      method: "POST",
      body: JSON.stringify({ enabled, restartImmediately }),
    }),

  updateConnectPreferences: (prefs: {
    publishAgentActivity?: boolean;
    holdWebhooksWhileOffline?: boolean;
  }) =>
    requestJson<ConnectStatus>("/connect/preferences", {
      method: "POST",
      body: JSON.stringify(prefs),
    }),

  manageConnectDevice: (code: string, action: "approve" | "revoke") =>
    requestJson<ConnectStatus>(`/connect/devices/${encodeURIComponent(code)}`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),

  logoutConnect: () => requestJson<ConnectStatus>("/connect/logout", { method: "POST" }),

  getAccessSessions: () =>
    requestJson<{
      sessions: Array<{ id: string; label?: string; createdAt?: string; expiresAt?: string }>;
      pairings: Array<{ id: string; label?: string; expiresAt?: string }>;
      settings: GatewayPersistedConfig;
    }>("/access/sessions"),

  createPairingLink: (regenerate = false) =>
    requestJson<{ url: string; expiresAtMs: number }>("/access/pairings", {
      method: "POST",
      body: JSON.stringify({ regenerate }),
    }),

  revokeSession: (id: string) =>
    requestJson<{ ok: boolean }>(`/access/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  updateGatewaySettings: (input: UpdateGatewaySettingsRequest) =>
    requestJson<{ ok: boolean; config: GatewayPersistedConfig }>("/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  getDesktopStatus: () => requestJson<DesktopStatus>("/desktop/status"),

  desktopAction: (
    action: "start" | "stop" | "restart" | "launch-t3-desktop" | "launch-chromium",
  ) =>
    requestJson<DesktopStatus>("/desktop/action", {
      method: "POST",
      body: JSON.stringify({ action }),
    }),

  updateDesktopConfig: (patch: Partial<DesktopConfig>) =>
    requestJson<DesktopStatus>("/desktop/config", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  getProviders: () => requestJson<ProvidersOverview>("/providers"),

  mutatePackage: (input: {
    kind: "agent" | "toolchain";
    id: string;
    action: "install" | "upgrade" | "uninstall";
  }) =>
    requestJson<ProvidersOverview>("/providers/packages", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateWorkerEnv: (workerEnv: WorkerEnvConfig, restartServer = true) =>
    requestJson<ProvidersOverview>("/providers/env", {
      method: "PUT",
      body: JSON.stringify({ workerEnv, restartServer }),
    }),

  syncBrowserMcp: (desktopBrowserMcp: boolean, headlessPlaywrightMcp: boolean) =>
    requestJson<ProvidersOverview>("/providers/browser-mcp", {
      method: "POST",
      body: JSON.stringify({ desktopBrowserMcp, headlessPlaywrightMcp }),
    }),

  getSnapshots: () => requestJson<{ snapshots: SnapshotItem[] }>("/snapshots"),

  createSnapshot: (scope: SnapshotScope, note: string) =>
    requestJson<{ ok: boolean; snapshot: SnapshotItem }>("/snapshots", {
      method: "POST",
      body: JSON.stringify({ scope, note }),
    }),

  restoreSnapshot: (id: string, scope: SnapshotScope) =>
    requestJson<{ ok: boolean }>(`/snapshots/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ scope }),
    }),

  deleteSnapshot: (id: string) =>
    requestJson<{ ok: boolean }>(`/snapshots/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  importSnapshot: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return requestJson<{ ok: boolean; snapshot: SnapshotItem }>("/snapshots/import", {
      method: "POST",
      body: fd,
    });
  },
};
