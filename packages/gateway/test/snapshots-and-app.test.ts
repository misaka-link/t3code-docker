import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_API_PREFIX, GatewayEnvSchema } from "@t3-docker/shared";
import { buildGatewayApp } from "../src/app.js";
import { T3AuthBridge } from "../src/auth-bridge/t3-auth-bridge.js";
import { ConfigStore } from "../src/config/config-store.js";
import { T3ConnectService } from "../src/connect/t3-connect-service.js";
import { DesktopSupervisor } from "../src/desktop/desktop-supervisor.js";
import { ProviderToolchainService } from "../src/providers/provider-service.js";
import { GatewayAuthService } from "../src/security/auth-service.js";
import {
  SnapshotService,
  isUnsafeArchiveEntryPath,
} from "../src/snapshots/snapshot-service.js";
import { T3ProcessSupervisor } from "../src/supervisor/t3-supervisor.js";
import {
  VersionHubService,
  downloadArchiveResumable,
  formatTransferError,
  parseElectronBuilderSha512,
  parseElectronBuilderSize,
  parseSha256Sums,
} from "../src/versions/version-hub.js";

describe("Snapshot Archive Safety & Fastify Unified Gateway Integration", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("parses both SHA256SUMS (CLI tarballs) and electron-builder latest-linux.yml sha512 (.deb)", () => {
    const sums = "9ba3db46e3554fb9970fd5ede9e823c2f6d6f6763f40340bd4c8ef6b09501c54  t3-0.1.12-linux-x64.tar.gz\n";
    expect(parseSha256Sums(sums, "t3-0.1.12-linux-x64.tar.gz")).toBe(
      "9ba3db46e3554fb9970fd5ede9e823c2f6d6f6763f40340bd4c8ef6b09501c54",
    );

    const latestLinuxYml = [
      "version: 0.1.12",
      "files:",
      "  - url: T3-Code-x86_64.AppImage",
      "    sha512: v80LyuuYEN+sbDq0exwrDuPjwcENKcrLvqvUY4aW9AJaUsL3vYnr/ExRC7oWQvEmtUBdDTXIvW+orXxoCP8h/Q==",
      "  - url: T3-Code-0.1.12-amd64.deb",
      "    sha512: eeZAoG5Ynn2+0dv3+xADiN9ay2dfbx2T5b6oHpGVmst+A6CiMUHsNV1yGUhGRec/6cGTS/z+a+wSYkj+9xGUtg==",
      "    size: 209475484",
    ].join("\n");
    expect(parseElectronBuilderSha512(latestLinuxYml, "T3-Code-0.1.12-amd64.deb")).toBe(
      "eeZAoG5Ynn2+0dv3+xADiN9ay2dfbx2T5b6oHpGVmst+A6CiMUHsNV1yGUhGRec/6cGTS/z+a+wSYkj+9xGUtg==",
    );
    expect(parseElectronBuilderSize(latestLinuxYml, "T3-Code-0.1.12-amd64.deb")).toBe(209475484);

    const undiciTerminated = new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    expect(formatTransferError(undiciTerminated)).toContain("UND_ERR_SOCKET: other side closed");
    expect(formatTransferError(undiciTerminated)).not.toBe("terminated");
  });

  it("resumes interrupted downloads via HTTP 206 Range across mid-stream TCP socket drops", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "t3gw-range-"));
    tempDirs.push(tmp);

    const fullPayload = crypto.randomBytes(300 * 1024); // 300 KiB deterministic payload
    const expectedSha = crypto.createHash("sha256").update(fullPayload).digest("hex");
    let requestCount = 0;

    const server = http.createServer((req, res) => {
      requestCount += 1;
      const rangeHeader = req.headers.range;
      let start = 0;
      if (rangeHeader) {
        const m = /^bytes=(\d+)-/.exec(rangeHeader);
        if (m?.[1]) start = Number.parseInt(m[1], 10);
      }

      // Drop TCP connection mid-stream on the first 2 attempts (~100 KiB per segment)
      const sliceEnd =
        requestCount <= 2
          ? Math.min(fullPayload.length, start + 100 * 1024)
          : fullPayload.length;

      if (start > 0) {
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${fullPayload.length - 1}/${fullPayload.length}`,
          "Content-Length": String(fullPayload.length - start),
        });
      } else {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Accept-Ranges": "bytes",
          "Content-Length": String(fullPayload.length),
        });
      }

      res.write(fullPayload.subarray(start, sliceEnd), () => {
        if (requestCount <= 2) {
          // Simulate abrupt cross-border TCP reset (`TypeError: terminated` in undici)
          req.socket.destroy();
        } else {
          res.end();
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const destPath = path.join(tmp, "release-test.deb");
      const retriesSeen: number[] = [];
      await downloadArchiveResumable({
        url: `http://127.0.0.1:${port}/release-test.deb`,
        destPath,
        expectedSizeBytes: fullPayload.length,
        preferCurl: false,
        chunkTimeoutMs: 5_000,
        onRetry: ({ attempt }) => retriesSeen.push(attempt),
      });

      expect(requestCount).toBe(3);
      expect(retriesSeen).toEqual([2, 3]);
      const downloaded = await fs.readFile(destPath);
      expect(downloaded.length).toBe(fullPayload.length);
      expect(crypto.createHash("sha256").update(downloaded).digest("hex")).toBe(expectedSha);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("blocks Zip-Slip path traversal entries and creates/restores verified snapshots", async () => {
    expect(isUnsafeArchiveEntryPath("../etc/passwd")).toBe(true);
    expect(isUnsafeArchiveEntryPath("/etc/shadow")).toBe(true);
    expect(isUnsafeArchiveEntryPath("userdata/../../evil")).toBe(true);
    expect(isUnsafeArchiveEntryPath("userdata/settings.json")).toBe(false);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "t3gw-snap-"));
    tempDirs.push(tmp);

    const env = GatewayEnvSchema.parse({
      T3GW_DATA_DIR: path.join(tmp, "gateway"),
      T3CODE_HOME: path.join(tmp, "t3"),
      T3GW_SNAPSHOTS_DIR: path.join(tmp, "snapshots"),
      T3GW_PROVIDERS_DIR: path.join(tmp, "providers"),
      T3_WORKSPACE: path.join(tmp, "workspace"),
      T3GW_VARIANT: "headless",
    });

    const configStore = new ConfigStore(env);
    await configStore.init();
    const supervisor = new T3ProcessSupervisor(env, configStore);
    const snapshotService = new SnapshotService(env, configStore, supervisor);

    const userdataDir = path.join(env.T3CODE_HOME, "userdata");
    await fs.mkdir(userdataDir, { recursive: true });
    await fs.writeFile(
      path.join(userdataDir, "settings.json"),
      JSON.stringify({ customFlag: "before-snapshot" }),
      "utf8",
    );

    const snap = await snapshotService.createSnapshot({
      scope: "config",
      note: "unit-test-backup",
    });
    expect(snap.scope).toBe("config");
    expect(snap.sha256).toHaveLength(64);

    // Mutate live file and restore from snapshot
    await fs.writeFile(
      path.join(userdataDir, "settings.json"),
      JSON.stringify({ customFlag: "mutated" }),
      "utf8",
    );
    await snapshotService.restoreSnapshot(snap.id, "config");

    const restored = JSON.parse(
      await fs.readFile(path.join(userdataDir, "settings.json"), "utf8"),
    ) as { customFlag: string };
    expect(restored.customFlag).toBe("before-snapshot");
  });

  it("enforces setup gate, session cookie auth, reserved path blocking, and hot adminPath updates", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "t3gw-http-"));
    tempDirs.push(tmp);

    const consoleDist = path.join(tmp, "console-dist");
    await fs.mkdir(consoleDist, { recursive: true });
    await fs.writeFile(path.join(consoleDist, "index.html"), "<html>T3Console</html>", "utf8");

    const gatewayEnv = GatewayEnvSchema.parse({
      T3GW_DATA_DIR: path.join(tmp, "gateway"),
      T3CODE_HOME: path.join(tmp, "t3"),
      T3GW_SNAPSHOTS_DIR: path.join(tmp, "snapshots"),
      T3GW_PROVIDERS_DIR: path.join(tmp, "providers"),
      T3_WORKSPACE: path.join(tmp, "workspace"),
      CONSOLE_DIST_DIR: consoleDist,
      T3GW_VARIANT: "headless",
    });

    const configStore = new ConfigStore(gatewayEnv);
    await configStore.init();
    const authService = new GatewayAuthService(gatewayEnv.T3GW_DATA_DIR);
    await authService.init();
    const authBridge = new T3AuthBridge(gatewayEnv, configStore);
    const supervisor = new T3ProcessSupervisor(gatewayEnv, configStore);
    const desktopSupervisor = new DesktopSupervisor(gatewayEnv, configStore, authBridge);
    const snapshotService = new SnapshotService(
      gatewayEnv,
      configStore,
      supervisor,
      desktopSupervisor,
    );
    const versionHub = new VersionHubService(
      gatewayEnv,
      configStore,
      supervisor,
      snapshotService,
      desktopSupervisor,
    );
    const connectService = new T3ConnectService(gatewayEnv, configStore, supervisor);
    const providerService = new ProviderToolchainService(gatewayEnv, configStore, supervisor);
    await providerService.init();

    const app = await buildGatewayApp({
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
    });

    try {
      // 1. Healthz is public
      const health = await app.inject({ method: "GET", url: "/_t3gw/healthz" });
      expect(health.statusCode).toBe(200);

      // 2. Uninitialized root HTML GET redirects to /admin setup gate
      const rootUnauth = await app.inject({
        method: "GET",
        url: "/",
        headers: { accept: "text/html" },
      });
      expect(rootUnauth.statusCode).toBe(302);
      expect(rootUnauth.headers.location).toContain("/admin");

      // 3. Complete initial setup
      const setupRes = await app.inject({
        method: "POST",
        url: `${GATEWAY_API_PREFIX}/auth/setup`,
        payload: { password: "strong-password-123", locale: "zh-CN" },
      });
      expect(setupRes.statusCode).toBe(200);
      const setCookieHeader = setupRes.headers["set-cookie"];
      const cookiePair = (Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader)!
        .split(";")[0]!;

      // 4. Rejects reserved route `/pair` when updating adminPath
      const badPathRes = await app.inject({
        method: "PUT",
        url: `${GATEWAY_API_PREFIX}/settings`,
        headers: { cookie: cookiePair, host: "localhost:3080", origin: "http://localhost:3080" },
        payload: { adminPath: "/pair" },
      });
      expect(badPathRes.statusCode).toBe(400);

      // 5. Hot-switches adminPath to `/console` without rebuilding SPA
      const goodPathRes = await app.inject({
        method: "PUT",
        url: `${GATEWAY_API_PREFIX}/settings`,
        headers: { cookie: cookiePair, host: "localhost:3080", origin: "http://localhost:3080" },
        payload: { adminPath: "/console" },
      });
      expect(goodPathRes.statusCode).toBe(200);

      const newConsolePage = await app.inject({
        method: "GET",
        url: "/console",
      });
      expect(newConsolePage.statusCode).toBe(200);
      expect(newConsolePage.body).toContain("T3Console");

      // 6. Headless variant returns 404 on `/vnc`
      const vncRes = await app.inject({
        method: "GET",
        url: "/vnc",
        headers: { cookie: cookiePair, accept: "text/html" },
      });
      expect(vncRes.statusCode).toBe(404);

      // 7. Bidirectional Desktop <-> Web ClientSyncService round-trip
      const pushSyncRes = await app.inject({
        method: "POST",
        url: `${GATEWAY_API_PREFIX}/sync/push`,
        headers: { cookie: cookiePair, host: "localhost:3080", origin: "http://localhost:3080" },
        payload: {
          clientSettings: {
            fontSizeCode: 16,
            sendShortcut: "mod-enter",
          },
          webExtras: {
            "t3code:theme": "tokyo-night",
            "evil:untrusted-key": "ignored",
          },
          portableEnvironments: [
            {
              connectionId: "bearer:env-remote-box:https://box.example.com",
              environmentId: "env-remote-box",
              label: "Home Workstation",
              httpBaseUrl: "https://box.example.com",
              wsBaseUrl: "wss://box.example.com",
              bearerToken: "secret-bearer-token-xyz",
            },
            {
              connectionId: "bearer:env-loopback:http://127.0.0.1:3773",
              environmentId: "env-loopback",
              label: "Loopback Ignored",
              httpBaseUrl: "http://127.0.0.1:3773",
              wsBaseUrl: "ws://127.0.0.1:3773",
              bearerToken: "ignored-loopback",
            },
          ],
        },
      });
      expect(pushSyncRes.statusCode).toBe(200);

      const syncStateRes = await app.inject({
        method: "GET",
        url: `${GATEWAY_API_PREFIX}/sync/state`,
        headers: { cookie: cookiePair },
      });
      expect(syncStateRes.statusCode).toBe(200);
      const syncState = syncStateRes.json() as {
        clientSettings: Record<string, unknown>;
        webExtras: Record<string, string>;
        portableEnvironments: Array<{ environmentId: string; label: string }>;
      };
      expect(syncState.clientSettings.fontSizeCode).toBe(16);
      expect(syncState.clientSettings.sendShortcut).toBe("mod-enter");
      expect(syncState.webExtras["t3code:theme"]).toBe("tokyo-night");
      expect(syncState.webExtras["evil:untrusted-key"]).toBeUndefined();
      expect(syncState.portableEnvironments).toHaveLength(1);
      expect(syncState.portableEnvironments[0]?.environmentId).toBe("env-remote-box");
    } finally {
      await app.close();
      await desktopSupervisor.shutdown();
    }
  });
});
