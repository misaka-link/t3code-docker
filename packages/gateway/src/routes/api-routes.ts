import * as fsSync from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ConnectDeviceActionSchema,
  ConnectPreferencesRequestSchema,
  ConnectToggleRequestSchema,
  CreateSnapshotRequestSchema,
  DesktopActionRequestSchema,
  DesktopConfigSchema,
  GATEWAY_API_PREFIX,
  InstallVersionRequestSchema,
  LoginRequestSchema,
  PackageMutationRequestSchema,
  RestoreSnapshotRequestSchema,
  SUITE_VERSION,
  SetupRequestSchema,
  SupervisorActionRequestSchema,
  UpdateGatewaySettingsRequestSchema,
  WorkerEnvConfigSchema,
  type GatewayEnv,
} from "@t3-docker/shared";
import type { T3AuthBridge } from "../auth-bridge/t3-auth-bridge.js";
import type { ConfigStore } from "../config/config-store.js";
import type { T3ConnectService } from "../connect/t3-connect-service.js";
import type { DesktopSupervisor } from "../desktop/desktop-supervisor.js";
import type { ProviderToolchainService } from "../providers/provider-service.js";
import {
  GATEWAY_SESSION_COOKIE,
  resolveClientIp,
  verifyWebSocketOrigin,
  type GatewayAuthService,
  type VerifiedGatewaySession,
} from "../security/auth-service.js";
import type { SnapshotService } from "../snapshots/snapshot-service.js";
import type { T3ProcessSupervisor } from "../supervisor/t3-supervisor.js";
import type { VersionHubService } from "../versions/version-hub.js";

export interface GatewayServices {
  readonly gatewayEnv: GatewayEnv;
  readonly configStore: ConfigStore;
  readonly authService: GatewayAuthService;
  readonly authBridge: T3AuthBridge;
  readonly supervisor: T3ProcessSupervisor;
  readonly versionHub: VersionHubService;
  readonly desktopSupervisor: DesktopSupervisor;
  readonly connectService: T3ConnectService;
  readonly providerService: ProviderToolchainService;
  readonly snapshotService: SnapshotService;
}

function resolvePublicOrigin(req: FastifyRequest, services: GatewayServices): string {
  const cfg = services.configStore.get();
  if (cfg.publicUrl) {
    return cfg.publicUrl.replace(/\/$/, "");
  }
  const proto =
    cfg.trustProxy && typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"].split(",")[0]!.trim()
      : "http";
  const host = req.headers.host ?? `localhost:${services.gatewayEnv.PROXY_PORT}`;
  return `${proto}://${host}`;
}

function isSecureRequest(req: FastifyRequest, trustProxy: boolean): boolean {
  if (trustProxy && req.headers["x-forwarded-proto"] === "https") return true;
  return req.protocol === "https";
}

export function registerGatewayApiRoutes(app: FastifyInstance, services: GatewayServices): void {
  const {
    gatewayEnv,
    configStore,
    authService,
    authBridge,
    supervisor,
    versionHub,
    desktopSupervisor,
    connectService,
    providerService,
    snapshotService,
  } = services;

  const requireAdmin = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<VerifiedGatewaySession | null> => {
    if (authService.isSetupRequired()) {
      void reply.code(403).send({ ok: false, code: "SETUP_REQUIRED", error: "Initial setup required." });
      return null;
    }
    const token = req.cookies[GATEWAY_SESSION_COOKIE];
    const session = authService.verifySessionToken(token);
    if (!session) {
      void reply.code(401).send({ ok: false, code: "UNAUTHORIZED", error: "Authentication required." });
      return null;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      const cfg = configStore.get();
      const originOk = verifyWebSocketOrigin({
        originHeader: req.headers.origin,
        hostHeader: req.headers.host,
        ...(cfg.publicUrl ? { publicUrl: cfg.publicUrl } : {}),
      });
      if (!originOk) {
        void reply.code(403).send({ ok: false, code: "CSRF_ORIGIN_MISMATCH", error: "Invalid request origin." });
        return null;
      }
    }
    return session;
  };

  // Healthcheck endpoint for Docker HEALTHCHECK
  app.get("/_t3gw/healthz", async () => ({
    ok: true,
    suiteVersion: SUITE_VERSION,
    upstreamState: supervisor.getState(),
    desktopState: desktopSupervisor.getState(),
  }));

  // Loopback-only internal wake endpoint for `@t3-docker/desktop-browser-mcp`
  app.post("/_t3gw/internal/desktop-wake", async (req, reply) => {
    const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (remote !== "127.0.0.1" && remote !== "::1") {
      return reply.code(403).send({ ok: false, error: "Loopback only" });
    }
    const token = req.headers["x-t3gw-wake-token"];
    if (typeof token !== "string" || !providerService.verifyDesktopWakeToken(token)) {
      return reply.code(401).send({ ok: false, error: "Invalid wake token" });
    }
    if (!desktopSupervisor.supported) {
      return reply.code(403).send({ ok: false, error: "CAPABILITY_UNAVAILABLE" });
    }
    const status = await desktopSupervisor.start();
    await desktopSupervisor.launchChromiumBrowser().catch(() => undefined);
    return { ok: true, status: desktopSupervisor.getStatus() };
  });

  // Loopback-only internal launcher endpoint for VNC desktop icons, taskbar & right-click menu
  app.post("/_t3gw/internal/desktop-launch", async (req, reply) => {
    const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (remote !== "127.0.0.1" && remote !== "::1") {
      return reply.code(403).send({ ok: false, error: "Loopback only" });
    }
    const token = req.headers["x-t3gw-wake-token"];
    if (typeof token !== "string" || !providerService.verifyDesktopWakeToken(token)) {
      return reply.code(401).send({ ok: false, error: "Invalid wake token" });
    }
    if (!desktopSupervisor.supported) {
      return reply.code(403).send({ ok: false, error: "CAPABILITY_UNAVAILABLE" });
    }
    const target = (req.body as { target?: string } | undefined)?.target;
    if (target === "chromium") {
      await desktopSupervisor.launchChromiumBrowser(true);
    } else {
      await desktopSupervisor.launchT3DesktopApp();
    }
    return { ok: true, status: desktopSupervisor.getStatus() };
  });

  // Public bootstrap metadata for Setup / Login / Console UI
  app.get(`${GATEWAY_API_PREFIX}/bootstrap`, async (req) => {
    const cfg = configStore.get();
    const session = authService.verifySessionToken(req.cookies[GATEWAY_SESSION_COOKIE]);
    return {
      suiteVersion: SUITE_VERSION,
      variant: gatewayEnv.T3GW_VARIANT,
      capabilities: {
        desktopSupported: desktopSupervisor.supported,
      },
      setupRequired: authService.isSetupRequired(),
      authenticated: session !== null,
      locale: cfg.locale,
      effectiveAppLocale: cfg.desktop.languageOverride || cfg.locale,
      theme: cfg.theme,
      routes: {
        adminPath: cfg.adminPath,
        vncPath: cfg.vncPath,
      },
    };
  });

  // First-boot setup wizard
  app.post(`${GATEWAY_API_PREFIX}/auth/setup`, async (req, reply) => {
    if (!authService.isSetupRequired()) {
      return reply.code(409).send({ ok: false, error: "Gateway is already initialized." });
    }
    const body = SetupRequestSchema.parse(req.body);
    await authService.setPassword(body.password, false);
    const prevEnvLabel = configStore.get().workerEnv.environmentLabel;
    if (body.locale || body.theme || body.environmentLabel !== undefined) {
      await configStore.update({
        ...(body.locale ? { locale: body.locale } : {}),
        ...(body.theme ? { theme: body.theme } : {}),
        ...(body.environmentLabel !== undefined
          ? {
              workerEnv: {
                ...configStore.get().workerEnv,
                environmentLabel: body.environmentLabel,
              },
            }
          : {}),
      });
    }
    if (
      body.environmentLabel !== undefined &&
      body.environmentLabel !== prevEnvLabel &&
      supervisor.getState() === "healthy"
    ) {
      await supervisor.restart();
      await desktopSupervisor.syncEnvironmentLabel().catch(() => undefined);
    }
    await desktopSupervisor.syncLocaleFromGateway(configStore.get().locale);
    const issued = authService.issueSessionToken();
    reply.setCookie(GATEWAY_SESSION_COOKIE, issued.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureRequest(req, configStore.get().trustProxy),
      maxAge: issued.maxAgeSeconds,
    });
    return { ok: true };
  });

  // Password login with IP brute-force rate limit
  app.post(`${GATEWAY_API_PREFIX}/auth/login`, async (req, reply) => {
    if (authService.isSetupRequired()) {
      return reply.code(403).send({ ok: false, code: "SETUP_REQUIRED", error: "Complete setup first." });
    }
    const cfg = configStore.get();
    const clientIp = resolveClientIp(
      req.socket.remoteAddress,
      req.headers["x-forwarded-for"],
      cfg.trustProxy,
    );
    const limit = authService.checkRateLimit(clientIp);
    if (!limit.allowed) {
      return reply.code(429).send({
        ok: false,
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
        error: `Too many failed attempts. Try again in ${limit.retryAfterSeconds}s.`,
      });
    }

    const body = LoginRequestSchema.parse(req.body);
    const valid = await authService.verifyPassword(body.password);
    authService.recordAuthAttempt(clientIp, valid);

    if (!valid) {
      return reply.code(401).send({ ok: false, code: "INVALID_PASSWORD", error: "Invalid access code." });
    }

    const issued = authService.issueSessionToken();
    reply.setCookie(GATEWAY_SESSION_COOKIE, issued.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureRequest(req, cfg.trustProxy),
      maxAge: issued.maxAgeSeconds,
    });
    return { ok: true };
  });

  app.post(`${GATEWAY_API_PREFIX}/auth/logout`, async (_req, reply) => {
    reply.clearCookie(GATEWAY_SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // Supervisor status, actions & SSE live logs
  app.get(`${GATEWAY_API_PREFIX}/supervisor/status`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return supervisor.getStatus();
  });

  app.post(`${GATEWAY_API_PREFIX}/supervisor/action`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { action } = SupervisorActionRequestSchema.parse(req.body);
    if (action === "start") {
      await supervisor.start();
    } else if (action === "stop") {
      await supervisor.stop();
    } else if (action === "restart") {
      await supervisor.restart();
    } else if (action === "doctor") {
      const doctorRes = await supervisor.runDoctorFix();
      return { ok: doctorRes.ok, output: doctorRes.output, status: await supervisor.getStatus() };
    } else if (action === "warm-headless-browser") {
      supervisor.logs.push("system", "[supervisor] Triggering T3 headless browser check...");
    }
    return { ok: true, status: await supervisor.getStatus() };
  });

  app.get(`${GATEWAY_API_PREFIX}/supervisor/logs`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const query = req.query as { stream?: string };
    if (query.stream !== "1") {
      return { entries: supervisor.logs.snapshot(300) };
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    for (const entry of supervisor.logs.snapshot(150)) {
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const unsubscribe = supervisor.logs.subscribe((entry) => {
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return reply;
  });

  // Version Hub
  app.get(`${GATEWAY_API_PREFIX}/versions`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const refresh = (req.query as { refresh?: string }).refresh === "1";
    return versionHub.getOverview(refresh);
  });

  app.post(`${GATEWAY_API_PREFIX}/versions/install`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const body = InstallVersionRequestSchema.parse(req.body);
    if (body.channel) {
      await configStore.update({ releaseChannel: body.channel });
    }
    if (body.async) {
      return versionHub.startInstallAndSwitchVersion({
        version: body.version,
        createSnapshotBeforeSwitch: body.createSnapshotBeforeSwitch,
      });
    }
    return versionHub.installAndSwitchVersion({
      version: body.version,
      createSnapshotBeforeSwitch: body.createSnapshotBeforeSwitch,
    });
  });

  app.delete(`${GATEWAY_API_PREFIX}/versions/:version`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { version } = req.params as { version: string };
    return versionHub.removeInstalledVersion(version);
  });

  // T3 Connect & Access / Pairing
  app.get(`${GATEWAY_API_PREFIX}/connect/status`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return connectService.getStatus();
  });

  app.post(`${GATEWAY_API_PREFIX}/connect/toggle`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const body = ConnectToggleRequestSchema.parse(req.body);
    return connectService.toggle(body.enabled, body.restartImmediately);
  });

  app.post(`${GATEWAY_API_PREFIX}/connect/preferences`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const body = ConnectPreferencesRequestSchema.parse(req.body);
    return connectService.updatePreferences({
      ...(body.publishAgentActivity !== undefined
        ? { publishAgentActivity: body.publishAgentActivity }
        : {}),
      ...(body.holdWebhooksWhileOffline !== undefined
        ? { holdWebhooksWhileOffline: body.holdWebhooksWhileOffline }
        : {}),
    });
  });

  app.post(`${GATEWAY_API_PREFIX}/connect/devices/:code`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { code } = req.params as { code: string };
    const { action } = ConnectDeviceActionSchema.parse(req.body);
    return connectService.manageDevice(code, action);
  });

  app.post(`${GATEWAY_API_PREFIX}/connect/logout`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return connectService.logout();
  });

  app.get(`${GATEWAY_API_PREFIX}/access/sessions`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const [sessions, pairings] = await Promise.all([
      authBridge.listSessions(),
      authBridge.listPairings(),
    ]);
    return {
      sessions,
      pairings,
      settings: configStore.get(),
    };
  });

  app.post(`${GATEWAY_API_PREFIX}/access/pairings`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const force = Boolean((req.body as { regenerate?: boolean } | undefined)?.regenerate);
    const origin = resolvePublicOrigin(req, services);
    return authBridge.getOrCreateManualPairing(origin, force);
  });

  app.delete(`${GATEWAY_API_PREFIX}/access/sessions/:id`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { id } = req.params as { id: string };
    const ok = await authBridge.revokeSession(id);
    return { ok };
  });

  app.put(`${GATEWAY_API_PREFIX}/settings`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const body = UpdateGatewaySettingsRequestSchema.parse(req.body);
    const prevEnvLabel = configStore.get().workerEnv.environmentLabel;

    const updated = await configStore.update({
      ...(body.adminPath ? { adminPath: body.adminPath } : {}),
      ...(body.vncPath ? { vncPath: body.vncPath } : {}),
      ...(body.locale ? { locale: body.locale } : {}),
      ...(body.theme ? { theme: body.theme } : {}),
      ...(body.trustProxy !== undefined ? { trustProxy: body.trustProxy } : {}),
      ...(body.publicUrl !== undefined ? { publicUrl: body.publicUrl } : {}),
      ...(body.releaseChannel ? { releaseChannel: body.releaseChannel } : {}),
      ...(body.releaseBaseUrl !== undefined ? { releaseBaseUrl: body.releaseBaseUrl } : {}),
      ...(body.environmentLabel !== undefined
        ? {
            workerEnv: {
              ...configStore.get().workerEnv,
              environmentLabel: body.environmentLabel,
            },
          }
        : {}),
    });

    if (body.environmentLabel !== undefined && body.environmentLabel !== prevEnvLabel) {
      if (supervisor.getState() === "healthy") {
        await supervisor.restart();
      }
      await desktopSupervisor.syncEnvironmentLabel().catch(() => undefined);
    }

    if (body.newPassword) {
      await authService.setPassword(body.newPassword, body.revokeAllSessions);
      if (body.revokeAllSessions) {
        await authBridge.revokeAllTokensAndSessions();
      }
      const fresh = authService.issueSessionToken();
      reply.setCookie(GATEWAY_SESSION_COOKIE, fresh.token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: isSecureRequest(req, updated.trustProxy),
        maxAge: fresh.maxAgeSeconds,
      });
    }

    if (body.locale) {
      await desktopSupervisor.syncLocaleFromGateway(body.locale);
    }

    return { ok: true, config: updated };
  });

  // Virtual Desktop Control
  app.get(`${GATEWAY_API_PREFIX}/desktop/status`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return desktopSupervisor.getStatus();
  });

  app.post(`${GATEWAY_API_PREFIX}/desktop/action`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    if (!desktopSupervisor.supported) {
      return reply.code(403).send({ ok: false, code: "CAPABILITY_UNAVAILABLE", error: "Desktop not supported in headless variant." });
    }
    const { action } = DesktopActionRequestSchema.parse(req.body);
    if (action === "start") return desktopSupervisor.start();
    if (action === "stop") return desktopSupervisor.stop();
    if (action === "restart") return desktopSupervisor.restart();
    if (action === "launch-t3-desktop") {
      await desktopSupervisor.launchT3DesktopApp();
      return desktopSupervisor.getStatus();
    }
    await desktopSupervisor.launchChromiumBrowser();
    return desktopSupervisor.getStatus();
  });

  app.put(`${GATEWAY_API_PREFIX}/desktop/config`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    if (!desktopSupervisor.supported) {
      return reply.code(403).send({ ok: false, code: "CAPABILITY_UNAVAILABLE", error: "Desktop not supported in headless variant." });
    }
    const patch = DesktopConfigSchema.partial().parse(req.body);
    return desktopSupervisor.updateConfig(patch);
  });

  // Providers, Browser MCP & Mise Toolchains
  app.get(`${GATEWAY_API_PREFIX}/providers`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return providerService.getOverview();
  });

  app.post(`${GATEWAY_API_PREFIX}/providers/packages`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const body = PackageMutationRequestSchema.parse(req.body);
    return providerService.mutatePackage(body);
  });

  app.put(`${GATEWAY_API_PREFIX}/providers/env`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const payload = req.body as { workerEnv?: unknown; restartServer?: boolean };
    const parsedEnv = WorkerEnvConfigSchema.parse(payload.workerEnv ?? {});
    return providerService.updateWorkerEnv(parsedEnv, payload.restartServer !== false);
  });

  app.post(`${GATEWAY_API_PREFIX}/providers/browser-mcp`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const body = req.body as { desktopBrowserMcp?: boolean; headlessPlaywrightMcp?: boolean };
    return providerService.syncBrowserMcpRegistrations(
      Boolean(body.desktopBrowserMcp),
      Boolean(body.headlessPlaywrightMcp),
    );
  });

  // Snapshots & Restore
  app.get(`${GATEWAY_API_PREFIX}/snapshots`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { snapshots: await snapshotService.listSnapshots() };
  });

  app.post(`${GATEWAY_API_PREFIX}/snapshots`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const body = CreateSnapshotRequestSchema.parse(req.body);
    const created = await snapshotService.createSnapshot(body);
    return { ok: true, snapshot: created };
  });

  app.post(`${GATEWAY_API_PREFIX}/snapshots/:id/restore`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { id } = req.params as { id: string };
    const body = RestoreSnapshotRequestSchema.parse(req.body);
    await snapshotService.restoreSnapshot(id, body.scope);
    return { ok: true };
  });

  app.delete(`${GATEWAY_API_PREFIX}/snapshots/:id`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { id } = req.params as { id: string };
    const deleted = await snapshotService.deleteSnapshot(id);
    return { ok: deleted };
  });

  app.get(`${GATEWAY_API_PREFIX}/snapshots/:id/export`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { id } = req.params as { id: string };
    const archivePath = await snapshotService.resolveExportPath(id);
    if (!archivePath) {
      return reply.code(404).send({ ok: false, error: "Snapshot archive not found." });
    }
    reply.header("Content-Type", "application/gzip");
    reply.header("Content-Disposition", `attachment; filename="${id}.tar.gz"`);
    return reply.send(fsSync.createReadStream(archivePath));
  });

  app.post(`${GATEWAY_API_PREFIX}/snapshots/import`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ ok: false, error: "No archive file uploaded." });
    }
    const buf = await file.toBuffer();
    const imported = await snapshotService.importSnapshot(buf, file.filename);
    return { ok: true, snapshot: imported };
  });
}
