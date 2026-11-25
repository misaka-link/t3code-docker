import * as path from "node:path";
import type { GatewayEnv } from "@t3-docker/shared";
import type { ConfigStore } from "../config/config-store.js";
import { fileExists } from "../utils/atomic-fs.js";
import {
  parseJsonFromCliStdout,
  resolveT3Binary,
  runWorkerCommand,
} from "../utils/cli-runner.js";

export interface T3PairingRecord {
  readonly id: string;
  readonly label?: string;
  readonly expiresAt?: string;
  readonly token?: string;
  readonly url?: string;
}

export interface T3SessionRecord {
  readonly id: string;
  readonly label?: string;
  readonly subject?: string;
  readonly scopes?: readonly string[];
  readonly createdAt?: string;
  readonly expiresAt?: string;
}

export const ALL_ADMIN_PAIRING_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "providers:manage",
  "environment:maintain",
  "preview:operate",
  "diagnostics:read",
  "terminal:read",
  "terminal:operate",
  "filesystem:read",
  "filesystem:write",
  "source-control:write",
  "access:read",
  "access:write",
  "relay:read",
  "relay:write",
  "relay:configure",
] as const;

function hasFullRelayConfigureScope(session: T3SessionRecord): boolean {
  if (!session.scopes) return true;
  return session.scopes.includes("relay:configure");
}

interface CachedPairingGrant {
  readonly id?: string;
  readonly pairingPathOrUrl: string;
  readonly expiresAtMs: number;
}

export interface CommandExecutor {
  runT3Auth(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

const WEB_PAIRING_TTL_MS = 110_000; // Slightly under 2m CLI TTL
const MANUAL_PAIRING_TTL_MS = 14 * 60_000; // Slightly under 15m CLI TTL
const REDIRECT_COOLDOWN_MS = 45_000;
export const VNC_DESKTOP_SESSION_LABEL = "gw-vnc-desktop";
export const MANUAL_PAIRING_LABEL = "gw-manual-qr";

/**
 * Central authority for T3 Code native pairing & session issuance.
 * Strictly enforces zero-duplicate issuance via:
 * 1. Native `t3_session_*` cookie presence detection before minting web tokens
 * 2. Per-gateway-session singleflight & unexpired pending token reuse + redirect loop circuit breaker
 * 3. Persistent `gw-vnc-desktop` session reconciliation for VNC T3 Desktop
 * 4. Manual QR pairing reuse & automatic revocation of superseded unused tokens
 */
export class T3AuthBridge {
  private readonly pendingWebTokens = new Map<string, CachedPairingGrant>();
  private readonly inflightWebMints = new Map<string, Promise<string>>();
  private readonly lastRedirectAt = new Map<string, number>();
  private cachedManualPairing: CachedPairingGrant | null = null;
  private inflightManualMint: Promise<CachedPairingGrant> | null = null;

  public constructor(
    private readonly gatewayEnv: GatewayEnv,
    private readonly configStore: ConfigStore,
    private readonly customExecutor?: CommandExecutor,
  ) {}

  /**
   * Checks whether the browser request already carries a T3 native session cookie.
   * When present, the gateway proxies straight through with ZERO token issuance.
   */
  public hasNativeT3SessionCookie(
    cookieHeader: string | undefined,
    expectedCookieName: string | null,
  ): boolean {
    if (!cookieHeader) return false;
    const cookies = cookieHeader.split(";").map((part) => part.trim());
    for (const entry of cookies) {
      const eqIdx = entry.indexOf("=");
      if (eqIdx <= 0) continue;
      const name = entry.slice(0, eqIdx).trim();
      const val = entry.slice(eqIdx + 1).trim();
      if (!val) continue;
      if (expectedCookieName) {
        if (name === expectedCookieName) return true;
      } else if (name === "t3_session" || name.startsWith("t3_session_")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns a `/pair#token=...` redirect target for an un-paired browser session,
   * or `null` if the redirect circuit breaker tripped within the cooldown window.
   */
  public async getOrMintWebPairingRedirect(
    gwSessionId: string,
    publicOrigin: string,
  ): Promise<{ redirectUrl: string } | { circuitBroken: true }> {
    const now = Date.now();
    const existing = this.pendingWebTokens.get(gwSessionId);
    if (existing && existing.expiresAtMs > now) {
      const last = this.lastRedirectAt.get(gwSessionId) ?? 0;
      if (now - last < REDIRECT_COOLDOWN_MS) {
        return { circuitBroken: true };
      }
      this.lastRedirectAt.set(gwSessionId, now);
      return { redirectUrl: existing.pairingPathOrUrl };
    }

    const last = this.lastRedirectAt.get(gwSessionId) ?? 0;
    if (now - last < REDIRECT_COOLDOWN_MS) {
      return { circuitBroken: true };
    }

    const inflight = this.inflightWebMints.get(gwSessionId);
    if (inflight) {
      const url = await inflight;
      return { redirectUrl: url };
    }

    const mintPromise = (async () => {
      const created = await this.createPairingCredential({
        label: `gw-web:${gwSessionId.slice(0, 8)}`,
        ttl: "2m",
        baseUrl: publicOrigin,
      });
      const grant: CachedPairingGrant = {
        ...(created.id ? { id: created.id } : {}),
        pairingPathOrUrl: created.redirectPath,
        expiresAtMs: Date.now() + WEB_PAIRING_TTL_MS,
      };
      this.pendingWebTokens.set(gwSessionId, grant);
      this.lastRedirectAt.set(gwSessionId, Date.now());
      return created.redirectPath;
    })();

    this.inflightWebMints.set(gwSessionId, mintPromise);
    try {
      const redirectUrl = await mintPromise;
      return { redirectUrl };
    } finally {
      this.inflightWebMints.delete(gwSessionId);
    }
  }

  /**
   * Ensures VNC T3 Desktop never accumulates duplicate sessions:
   * Returns `null` when an active `gw-vnc-desktop` session and saved environment file already exist,
   * so `DesktopSupervisor` launches `t3-code` directly with ZERO pairing issuance.
   */
  public async ensureVncDesktopPairingAppLink(
    loopbackUpstreamUrl: string,
  ): Promise<string | null> {
    const catalogPath = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "connection-catalog.json",
    );
    const savedEnvPath = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "saved-environments.json",
    );
    const hasSavedFile = (await fileExists(catalogPath)) || (await fileExists(savedEnvPath));
    const sessions = await this.listSessions();
    const activeDesktopSessions = sessions.filter((s) => s.label === VNC_DESKTOP_SESSION_LABEL);

    if (
      hasSavedFile &&
      activeDesktopSessions.length === 1 &&
      hasFullRelayConfigureScope(activeDesktopSessions[0]!)
    ) {
      return null;
    }

    // Deduplicate if multiple stale sessions exist or saved file was wiped
    for (const stale of activeDesktopSessions) {
      await this.revokeSession(stale.id).catch(() => undefined);
    }
    const pairings = await this.listPairings();
    for (const p of pairings) {
      if (p.label === VNC_DESKTOP_SESSION_LABEL) {
        await this.revokePairing(p.id).catch(() => undefined);
      }
    }

    const created = await this.createPairingCredential({
      label: VNC_DESKTOP_SESSION_LABEL,
      ttl: "10m",
      baseUrl: loopbackUpstreamUrl,
    });
    const fullUrl = created.fullUrl ?? `${loopbackUpstreamUrl.replace(/\/$/, "")}${created.redirectPath}`;
    return `t3code://pair?pairingUrl=${encodeURIComponent(fullUrl)}`;
  }

  /**
   * Exchanges a freshly minted one-time pairing credential directly against loopback `/oauth/token`
   * (RFC 8693 form-urlencoded) so `DesktopSupervisor` can pre-seed an encrypted `connection-catalog.json`
   * before launching Electron — completely eliminating the interactive "Add the backend at ...?" modal.
   */
  public async bootstrapVncDesktopBearerSession(
    loopbackUpstreamUrl: string,
  ): Promise<
    | { readonly status: "reused" }
    | {
        readonly status: "minted";
        readonly environmentId: string;
        readonly label: string;
        readonly httpBaseUrl: string;
        readonly wsBaseUrl: string;
        readonly bearerToken: string;
      }
  > {
    const catalogPath = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "connection-catalog.json",
    );
    const savedEnvPath = path.join(
      this.gatewayEnv.T3CODE_HOME,
      "userdata",
      "saved-environments.json",
    );
    const hasSavedFile = (await fileExists(catalogPath)) || (await fileExists(savedEnvPath));
    const sessions = await this.listSessions();
    const activeDesktopSessions = sessions.filter((s) => s.label === VNC_DESKTOP_SESSION_LABEL);

    if (
      hasSavedFile &&
      activeDesktopSessions.length === 1 &&
      hasFullRelayConfigureScope(activeDesktopSessions[0]!)
    ) {
      return { status: "reused" };
    }

    for (const stale of activeDesktopSessions) {
      await this.revokeSession(stale.id).catch(() => undefined);
    }
    const pairings = await this.listPairings();
    for (const p of pairings) {
      if (p.label === VNC_DESKTOP_SESSION_LABEL) {
        await this.revokePairing(p.id).catch(() => undefined);
      }
    }

    const cleanHttpBase = loopbackUpstreamUrl.replace(/\/$/, "");
    const created = await this.createPairingCredential({
      label: VNC_DESKTOP_SESSION_LABEL,
      ttl: "10m",
      baseUrl: cleanHttpBase,
    });
    if (!created.rawToken) {
      throw new Error("Missing raw bootstrap token from `t3 auth pairing create`");
    }

    const descRes = await fetch(`${cleanHttpBase}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!descRes.ok) {
      throw new Error(`Descriptor probe failed with HTTP ${descRes.status}`);
    }
    const desc = (await descRes.json()) as { environmentId?: string; label?: string };
    if (!desc.environmentId) {
      throw new Error("Descriptor missing environmentId");
    }

    const tokenForm = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: created.rawToken,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: VNC_DESKTOP_SESSION_LABEL,
      client_device_type: "desktop",
      client_os: "linux",
    });

    const tokenRes = await fetch(`${cleanHttpBase}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenForm.toString(),
      signal: AbortSignal.timeout(8_000),
    });
    if (!tokenRes.ok) {
      throw new Error(`OAuth token exchange failed with HTTP ${tokenRes.status}`);
    }
    const tokenPayload = (await tokenRes.json()) as { access_token?: string };
    if (!tokenPayload.access_token) {
      throw new Error("OAuth token exchange response missing access_token");
    }

    const parsedBase = new URL(cleanHttpBase);
    const wsProtocol = parsedBase.protocol === "https:" ? "wss:" : "ws:";
    const wsBaseUrl = `${wsProtocol}//${parsedBase.host}${parsedBase.pathname === "/" ? "" : parsedBase.pathname}`;

    return {
      status: "minted",
      environmentId: desc.environmentId,
      label: desc.label || "Local Workspace",
      httpBaseUrl: cleanHttpBase,
      wsBaseUrl,
      bearerToken: tokenPayload.access_token,
    };
  }

  /**
   * Idempotently returns an unexpired manual pairing link for mobile/external desktop QR scan,
   * revoking the previous unused token first when `forceRegenerate` is requested.
   */
  public async getOrCreateManualPairing(
    publicOrigin: string,
    forceRegenerate = false,
  ): Promise<{ url: string; expiresAtMs: number }> {
    const now = Date.now();
    if (!forceRegenerate && this.cachedManualPairing && this.cachedManualPairing.expiresAtMs > now) {
      return {
        url: this.cachedManualPairing.pairingPathOrUrl,
        expiresAtMs: this.cachedManualPairing.expiresAtMs,
      };
    }

    if (!forceRegenerate && this.inflightManualMint) {
      const res = await this.inflightManualMint;
      return { url: res.pairingPathOrUrl, expiresAtMs: res.expiresAtMs };
    }

    const task = (async () => {
      const activePairings = await this.listPairings();
      for (const p of activePairings) {
        if (p.label === MANUAL_PAIRING_LABEL) {
          await this.revokePairing(p.id).catch(() => undefined);
        }
      }

      const created = await this.createPairingCredential({
        label: MANUAL_PAIRING_LABEL,
        ttl: "15m",
        baseUrl: publicOrigin,
      });
      const fullUrl =
        created.fullUrl ?? `${publicOrigin.replace(/\/$/, "")}${created.redirectPath}`;
      const grant: CachedPairingGrant = {
        ...(created.id ? { id: created.id } : {}),
        pairingPathOrUrl: fullUrl,
        expiresAtMs: Date.now() + MANUAL_PAIRING_TTL_MS,
      };
      this.cachedManualPairing = grant;
      return grant;
    })();

    this.inflightManualMint = task;
    try {
      const grant = await task;
      return { url: grant.pairingPathOrUrl, expiresAtMs: grant.expiresAtMs };
    } finally {
      this.inflightManualMint = null;
    }
  }

  public async listSessions(): Promise<T3SessionRecord[]> {
    const res = await this.execAuth(["session", "list", "--base-dir", this.gatewayEnv.T3CODE_HOME, "--json"]);
    if (res.code !== 0) return [];
    const parsed = parseJsonFromCliStdout<unknown>(res.stdout);
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { sessions?: unknown }).sessions)
        ? (parsed as { sessions: unknown[] }).sessions
        : [];
    return items
      .map((item) => normalizeSessionRecord(item))
      .filter((item): item is T3SessionRecord => item !== null);
  }

  public async listPairings(): Promise<T3PairingRecord[]> {
    const res = await this.execAuth(["pairing", "list", "--base-dir", this.gatewayEnv.T3CODE_HOME, "--json"]);
    if (res.code !== 0) return [];
    const parsed = parseJsonFromCliStdout<unknown>(res.stdout);
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { pairings?: unknown }).pairings)
        ? (parsed as { pairings: unknown[] }).pairings
        : [];
    return items
      .map((item) => normalizePairingRecord(item))
      .filter((item): item is T3PairingRecord => item !== null);
  }

  public async revokeSession(sessionId: string): Promise<boolean> {
    const res = await this.execAuth([
      "session",
      "revoke",
      sessionId,
      "--base-dir",
      this.gatewayEnv.T3CODE_HOME,
    ]);
    return res.code === 0;
  }

  public async revokePairing(pairingId: string): Promise<boolean> {
    const res = await this.execAuth([
      "pairing",
      "revoke",
      pairingId,
      "--base-dir",
      this.gatewayEnv.T3CODE_HOME,
    ]);
    return res.code === 0;
  }

  public async revokeAllTokensAndSessions(): Promise<void> {
    this.pendingWebTokens.clear();
    this.lastRedirectAt.clear();
    this.cachedManualPairing = null;

    const [pairings, sessions] = await Promise.all([this.listPairings(), this.listSessions()]);
    await Promise.all([
      ...pairings.map((p) => this.revokePairing(p.id).catch(() => false)),
      ...sessions.map((s) => this.revokeSession(s.id).catch(() => false)),
    ]);
  }

  private async createPairingCredential(input: {
    readonly label: string;
    readonly ttl: string;
    readonly baseUrl: string;
  }): Promise<{ id?: string; redirectPath: string; fullUrl?: string; rawToken?: string }> {
    const scopeArgs = ALL_ADMIN_PAIRING_SCOPES.flatMap((s) => ["--scope", s]);
    const res = await this.execAuth([
      "pairing",
      "create",
      "--base-dir",
      this.gatewayEnv.T3CODE_HOME,
      "--label",
      input.label,
      "--ttl",
      input.ttl,
      "--base-url",
      input.baseUrl,
      ...scopeArgs,
      "--json",
    ]);
    if (res.code !== 0) {
      throw new Error(`Failed to create T3 pairing token: ${res.stderr || res.stdout}`);
    }

    const parsed = parseJsonFromCliStdout<Record<string, unknown>>(res.stdout);
    const id =
      (typeof parsed?.id === "string" && parsed.id) ||
      (typeof parsed?.pairingId === "string" && parsed.pairingId) ||
      (typeof parsed?.credentialId === "string" && parsed.credentialId) ||
      undefined;
    const rawUrl =
      (typeof parsed?.pairUrl === "string" && parsed.pairUrl) ||
      (typeof parsed?.url === "string" && parsed.url) ||
      (typeof parsed?.pairingUrl === "string" && parsed.pairingUrl) ||
      undefined;
    let rawToken =
      (typeof parsed?.credential === "string" && parsed.credential) ||
      (typeof parsed?.token === "string" && parsed.token) ||
      (typeof parsed?.secret === "string" && parsed.secret) ||
      undefined;

    if (rawUrl) {
      try {
        const u = new URL(rawUrl);
        if (!rawToken) {
          const hashParams = new URLSearchParams(u.hash.replace(/^#/, ""));
          rawToken =
            hashParams.get("token") ||
            u.searchParams.get("token") ||
            u.searchParams.get("pairingCode") ||
            undefined;
        }
        return {
          ...(id ? { id } : {}),
          redirectPath: `${u.pathname}${u.search}${u.hash}`,
          fullUrl: rawUrl,
          ...(rawToken ? { rawToken } : {}),
        };
      } catch {
        // Fallback below
      }
    }

    if (rawToken) {
      const redirectPath = `/pair#token=${encodeURIComponent(rawToken)}`;
      return {
        ...(id ? { id } : {}),
        redirectPath,
        fullUrl: `${input.baseUrl.replace(/\/$/, "")}${redirectPath}`,
        rawToken,
      };
    }

    throw new Error("Unexpected JSON response from `t3 auth pairing create`");
  }

  private async execAuth(
    subArgs: readonly string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.customExecutor) {
      return this.customExecutor.runT3Auth(subArgs);
    }
    const bin = await resolveT3Binary(this.gatewayEnv);
    return runWorkerCommand({
      command: bin,
      args: ["auth", ...subArgs],
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      timeoutMs: 15_000,
    });
  }
}

function normalizeSessionRecord(raw: unknown): T3SessionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id =
    (typeof obj.id === "string" && obj.id) ||
    (typeof obj.sessionId === "string" && obj.sessionId) ||
    "";
  if (!id) return null;
  const client =
    obj.client && typeof obj.client === "object"
      ? (obj.client as Record<string, unknown>)
      : undefined;
  const label =
    (typeof obj.label === "string" && obj.label) ||
    (typeof client?.label === "string" && client.label) ||
    undefined;
  const subject = typeof obj.subject === "string" ? obj.subject : undefined;
  const scopes = Array.isArray(obj.scopes)
    ? obj.scopes.filter((s): s is string => typeof s === "string")
    : undefined;
  const createdAt =
    (typeof obj.createdAt === "string" && obj.createdAt) ||
    (typeof obj.issuedAt === "string" && obj.issuedAt) ||
    undefined;
  const expiresAt = typeof obj.expiresAt === "string" ? obj.expiresAt : undefined;
  return {
    id,
    ...(label ? { label } : {}),
    ...(subject ? { subject } : {}),
    ...(scopes ? { scopes } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function normalizePairingRecord(raw: unknown): T3PairingRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id =
    (typeof obj.id === "string" && obj.id) ||
    (typeof obj.pairingId === "string" && obj.pairingId) ||
    (typeof obj.credentialId === "string" && obj.credentialId) ||
    "";
  if (!id) return null;
  const client =
    obj.client && typeof obj.client === "object"
      ? (obj.client as Record<string, unknown>)
      : undefined;
  const label =
    (typeof obj.label === "string" && obj.label) ||
    (typeof client?.label === "string" && client.label) ||
    undefined;
  const expiresAt = typeof obj.expiresAt === "string" ? obj.expiresAt : undefined;
  const token =
    (typeof obj.token === "string" && obj.token) ||
    (typeof obj.credential === "string" && obj.credential) ||
    undefined;
  const url =
    (typeof obj.url === "string" && obj.url) ||
    (typeof obj.pairUrl === "string" && obj.pairUrl) ||
    (typeof obj.pairingUrl === "string" && obj.pairingUrl) ||
    undefined;
  return {
    id,
    ...(label ? { label } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(token ? { token } : {}),
    ...(url ? { url } : {}),
  };
}
