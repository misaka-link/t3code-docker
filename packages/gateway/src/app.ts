import * as fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import httpProxy from "http-proxy";
import { ZodError } from "zod";
import { GATEWAY_ASSETS_PREFIX, GATEWAY_INTERNAL_PREFIX } from "@t3-docker/shared";
import {
  GATEWAY_SESSION_COOKIE,
  verifyWebSocketOrigin,
} from "./security/auth-service.js";
import { registerGatewayApiRoutes, type GatewayServices } from "./routes/api-routes.js";
import { fileExists } from "./utils/atomic-fs.js";

function parseCookiesFromHeader(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function resolveConsoleDistDir(configuredDir: string): string {
  if (configuredDir) return path.resolve(configuredDir);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../console/dist");
}

function buildUpstreamStartingHtml(locale: "zh-CN" | "en-US", adminPath: string): string {
  const isZh = locale === "zh-CN";
  const title = isZh ? "正在启动 T3 Code 服务…" : "Starting T3 Code Server…";
  const desc = isZh
    ? "核心引擎正在准备运行环境，就绪后将自动进入工作区。"
    : "The T3 Code backend is warming up and will open automatically once ready.";
  const btn = isZh ? "打开管理控制台" : "Open Admin Console";

  return `<!DOCTYPE html>
<html lang="${locale}" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="refresh" content="2" />
  <title>${title}</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
    .card{max-width:400px;padding:28px;border-radius:12px;background:#121215;border:1px solid rgba(255,255,255,0.08);text-align:center;box-shadow:0 16px 36px -18px rgba(0,0,0,0.8)}
    .dot{width:10px;height:10px;border-radius:50%;background:#3b82f6;display:inline-block;margin-bottom:14px;animation:p 1.4s infinite}
    @keyframes p{0%,100%{opacity:1}50%{opacity:.35}}
    h1{font-size:16px;font-weight:600;margin:0 0 8px}
    p{font-size:13px;color:#a1a1aa;line-height:1.5;margin:0 0 18px}
    a{display:inline-block;padding:7px 14px;font-size:12px;color:#e4e4e7;text-decoration:none;border:1px solid rgba(255,255,255,0.12);border-radius:8px}
    a:hover{background:rgba(255,255,255,0.05)}
  </style>
</head>
<body>
  <div class="card">
    <span class="dot"></span>
    <h1>${title}</h1>
    <p>${desc}</p>
    <a href="${adminPath}">${btn}</a>
  </div>
</body>
</html>`;
}

export async function buildGatewayApp(services: GatewayServices): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024 * 512, // 512 MiB for snapshot archive uploads
  });

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 1024 * 1024 * 512,
      files: 1,
    },
  });

  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0]?.message ?? "Validation error";
      return reply.code(400).send({
        ok: false,
        code: "VALIDATION_ERROR",
        error: firstIssue,
        issues: error.issues,
      });
    }
    const statusCode =
      error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const errMessage = error instanceof Error ? error.message : "Internal server error";
    return reply.code(statusCode >= 400 ? statusCode : 500).send({
      ok: false,
      error: errMessage,
    });
  });

  const consoleDistDir = resolveConsoleDistDir(services.gatewayEnv.CONSOLE_DIST_DIR);
  const assetsDir = path.join(consoleDistDir, "assets");
  if (await fileExists(assetsDir)) {
    await app.register(fastifyStatic, {
      root: assetsDir,
      prefix: `${GATEWAY_ASSETS_PREFIX}/`,
      decorateReply: false,
      immutable: true,
      maxAge: "30d",
    });
  }

  registerGatewayApiRoutes(app, services);

  const t3Proxy = httpProxy.createProxyServer({
    target: services.supervisor.upstreamUrl,
    ws: true,
    xfwd: true,
  });

  const vncProxy = httpProxy.createProxyServer({
    target: services.desktopSupervisor.novncUpstreamUrl,
    ws: true,
    xfwd: true,
  });

  t3Proxy.on("error", (_err, _req, res) => {
    if (res && "writeHead" in res && !res.headersSent) {
      const cfg = services.configStore.get();
      const html = buildUpstreamStartingHtml(cfg.locale, cfg.adminPath);
      res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    }
  });

  vncProxy.on("error", (_err, _req, res) => {
    if (res && "writeHead" in res && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Desktop VNC upstream not ready yet." }));
    }
  });

  const serveConsoleIndexHtml = async (reply: import("fastify").FastifyReply) => {
    const indexPath = path.join(consoleDistDir, "index.html");
    if (await fileExists(indexPath)) {
      const html = await fs.readFile(indexPath, "utf8");
      return reply
        .header("Cache-Control", "no-store")
        .type("text/html; charset=utf-8")
        .send(html);
    }
    return reply
      .type("text/html; charset=utf-8")
      .send("<!doctype html><html><body><h1>T3 Gateway Console (build console first)</h1></body></html>");
  };

  // Dispatch adminPath, vncPath, and T3 Code upstream in `onRequest` BEFORE Fastify parses `req.raw`
  // so POST/PUT bodies (`/api/auth/*`, `/oauth/token`, `/mcp`, uploads) stream intact to `t3Proxy`.
  app.addHook("onRequest", async (req, reply) => {
    const rawUrl = req.raw.url ?? "/";
    const pathname = rawUrl.split("?")[0] ?? "/";

    // 1. Let Fastify handle internal `/_t3gw/*` routes & static assets normally
    if (pathname === GATEWAY_INTERNAL_PREFIX || pathname.startsWith(`${GATEWAY_INTERNAL_PREFIX}/`)) {
      return;
    }

    const cfg = services.configStore.get();

    // 2. Dynamic Admin Console SPA (`adminPath` & subroutes)
    if (pathname === cfg.adminPath || pathname.startsWith(`${cfg.adminPath}/`)) {
      return serveConsoleIndexHtml(reply);
    }

    // 3. Enforce Gateway Setup / Authentication Gate before VNC or T3 WebUI
    const gwSession = services.authService.verifySessionToken(req.cookies[GATEWAY_SESSION_COOKIE]);
    const acceptsHtml = (req.headers.accept ?? "").includes("text/html");

    if (services.authService.isSetupRequired() || !gwSession) {
      if (req.method === "GET" && acceptsHtml) {
        return reply.redirect(`${cfg.adminPath}?next=${encodeURIComponent(rawUrl)}`);
      }
      return reply.code(401).send({ ok: false, code: "UNAUTHORIZED", error: "Gateway authentication required." });
    }

    // 4. Dynamic On-Demand VNC Desktop (`vncPath`)
    if (pathname === cfg.vncPath || pathname.startsWith(`${cfg.vncPath}/`)) {
      if (!services.desktopSupervisor.supported) {
        return reply.code(404).send({
          ok: false,
          code: "CAPABILITY_UNAVAILABLE",
          error: "Virtual desktop is not included in the headless image.",
        });
      }

      if (services.desktopSupervisor.getState() !== "running") {
        void services.desktopSupervisor.start().catch(() => undefined);
        return serveConsoleIndexHtml(reply);
      }

      services.desktopSupervisor.touchActivity();
      if (pathname === cfg.vncPath || pathname === `${cfg.vncPath}/`) {
        const cleanPrefix = cfg.vncPath.slice(1);
        return reply.redirect(
          `${cfg.vncPath}/vnc.html?autoconnect=true&resize=scale&path=${encodeURIComponent(`${cleanPrefix}/websockify`)}`,
        );
      }

      reply.hijack();
      req.raw.url = rawUrl.slice(cfg.vncPath.length) || "/";
      vncProxy.web(req.raw, reply.raw);
      return;
    }

    // 5. T3 Code WebUI upstream readiness & idempotent zero-duplicate pairing bridge
    if (services.supervisor.getState() !== "healthy") {
      if (req.method === "GET" && acceptsHtml) {
        return reply
          .code(503)
          .type("text/html; charset=utf-8")
          .send(buildUpstreamStartingHtml(cfg.locale, cfg.adminPath));
      }
    } else if (
      req.method === "GET" &&
      pathname === "/" &&
      acceptsHtml &&
      !services.authBridge.hasNativeT3SessionCookie(
        req.headers.cookie,
        services.supervisor.getSessionCookieName(),
      )
    ) {
      const proto =
        cfg.trustProxy && typeof req.headers["x-forwarded-proto"] === "string"
          ? req.headers["x-forwarded-proto"].split(",")[0]!.trim()
          : "http";
      const host = req.headers.host ?? `localhost:${services.gatewayEnv.PROXY_PORT}`;
      const publicOrigin = cfg.publicUrl ? cfg.publicUrl.replace(/\/$/, "") : `${proto}://${host}`;

      const bridgeRes = await services.authBridge
        .getOrMintWebPairingRedirect(gwSession.sessionId, publicOrigin)
        .catch(() => null);
      if (bridgeRes && "redirectUrl" in bridgeRes) {
        return reply.redirect(bridgeRes.redirectUrl);
      }
    }

    reply.hijack();
    t3Proxy.web(req.raw, reply.raw);
  });

  app.setNotFoundHandler(async (_req, reply) => {
    return reply.code(404).send({ ok: false, error: "Not found" });
  });

  // Raw HTTP Server Upgrade handler for both VNC Websockify & T3 Code WebUI WebSockets
  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const cfg = services.configStore.get();
    const originOk = verifyWebSocketOrigin({
      originHeader: req.headers.origin,
      hostHeader: req.headers.host,
      ...(cfg.publicUrl ? { publicUrl: cfg.publicUrl } : {}),
    });
    if (!originOk) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const cookies = parseCookiesFromHeader(req.headers.cookie);
    const gwSession = services.authService.verifySessionToken(cookies[GATEWAY_SESSION_COOKIE]);
    if (services.authService.isSetupRequired() || !gwSession) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?")[0] ?? "/";

    if (pathname === cfg.vncPath || pathname.startsWith(`${cfg.vncPath}/`)) {
      if (!services.desktopSupervisor.supported || services.desktopSupervisor.getState() !== "running") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      req.url = rawUrl.slice(cfg.vncPath.length) || "/";
      services.desktopSupervisor.onVncConnectionOpened();
      socket.once("close", () => {
        services.desktopSupervisor.onVncConnectionClosed();
      });
      vncProxy.ws(req, socket, head);
      return;
    }

    t3Proxy.ws(req, socket, head);
  };

  app.server.on("upgrade", handleUpgrade);

  app.addHook("onClose", async () => {
    app.server.off("upgrade", handleUpgrade);
    t3Proxy.close();
    vncProxy.close();
  });

  return app;
}
