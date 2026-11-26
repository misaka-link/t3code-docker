import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayEnvSchema, WorkerEnvConfigSchema } from "@t3-docker/shared";
import {
  GatewayAuthService,
  resolveClientIp,
  verifyWebSocketOrigin,
} from "../src/security/auth-service.js";
import {
  buildCleanWorkerEnv,
  consumeAndScrubProcessSecrets,
} from "../src/security/env-sanitizer.js";
import {
  detectHeadlessBrowserInstalled,
  mergeDefaultT3ServerSettings,
} from "../src/supervisor/t3-supervisor.js";
import { buildT3CliBinShim, syncT3CliBinShim } from "../src/utils/cli-runner.js";

describe("Environment Sanitizer & Gateway Security", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("consumes AUTH_TOKEN and SESSION_SECRET and scrubs them from process env", () => {
    const fakeEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      AUTH_TOKEN: "my-super-secret",
      SESSION_SECRET: "custom-session-key",
      T3GW_SECRET_INTERNAL: "hidden",
    };

    const consumed = consumeAndScrubProcessSecrets(fakeEnv);
    expect(consumed.initialAuthToken).toBe("my-super-secret");
    expect(consumed.initialSessionSecret).toBe("custom-session-key");
    expect(fakeEnv.AUTH_TOKEN).toBeUndefined();
    expect(fakeEnv.SESSION_SECRET).toBeUndefined();
    expect(fakeEnv.T3GW_SECRET_INTERNAL).toBeUndefined();
  });

  it("builds a clean worker env free of NODE_ENV, ELECTRON_RUN_AS_NODE, DISPLAY, and T3GW_* vars", () => {
    const dirtyBase: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin",
      NODE_ENV: "production",
      ELECTRON_RUN_AS_NODE: "1",
      T3CODE_DESKTOP_CLI_LAUNCHER: "1",
      DISPLAY: ":99",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/dbus",
      LC_ALL: "zh_CN.UTF-8",
      LANGUAGE: "zh_CN:zh",
      AUTH_TOKEN: "leaked",
      T3GW_VARIANT: "full",
    };

    const gatewayEnv = GatewayEnvSchema.parse({});
    const workerEnv = WorkerEnvConfigSchema.parse({
      httpProxy: "http://127.0.0.1:7890",
      customVars: {
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
    });

    const clean = buildCleanWorkerEnv({
      baseEnv: dirtyBase,
      gatewayEnv,
      workerEnv,
    });

    expect(clean.NODE_ENV).toBeUndefined();
    expect(clean.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(clean.T3CODE_DESKTOP_CLI_LAUNCHER).toBeUndefined();
    expect(clean.DISPLAY).toBeUndefined();
    expect(clean.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    expect(clean.LC_ALL).toBeUndefined();
    expect(clean.LANGUAGE).toBeUndefined();
    expect(clean.AUTH_TOKEN).toBeUndefined();
    expect(clean.T3GW_VARIANT).toBeUndefined();

    expect(clean.T3CODE_SERVER_BROWSER_SANDBOX).toBe("0");
    expect(clean.HOME).toBe("/home/coder");
    expect(clean.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(clean.ANTHROPIC_API_KEY).toBe("sk-ant-test");

    // Both T3 Code and Antigravity telemetry are disabled by default
    expect(clean.T3CODE_TELEMETRY_ENABLED).toBe("false");
    expect(clean.T3CODE_OTEL_SDK_DISABLED).toBe("true");
    expect(clean.DO_NOT_TRACK).toBe("1");
    expect(clean.GEMINI_TELEMETRY_ENABLED).toBe("false");
    expect(clean.OTEL_SDK_DISABLED).toBe("true");
    expect(clean.AGY_TELEMETRY_DISABLED).toBe("1");

    // Toggling T3 telemetry ON while keeping Antigravity telemetry OFF works independently
    const partialClean = buildCleanWorkerEnv({
      baseEnv: dirtyBase,
      gatewayEnv,
      workerEnv: WorkerEnvConfigSchema.parse({
        disableT3Telemetry: false,
        disableAntigravityTelemetry: true,
      }),
    });
    expect(partialClean.T3CODE_TELEMETRY_ENABLED).toBe("true");
    expect(partialClean.DO_NOT_TRACK).toBeUndefined();
    expect(partialClean.T3CODE_OTEL_SDK_DISABLED).toBeUndefined();
    expect(partialClean.GEMINI_TELEMETRY_ENABLED).toBe("false");
    expect(partialClean.OTEL_SDK_DISABLED).toBe("true");
    expect(partialClean.AGY_TELEMETRY_DISABLED).toBe("1");

    // Custom environmentLabel injects T3CODE_ENVIRONMENT_LABEL cleanly
    const labeledEnv = buildCleanWorkerEnv({
      baseEnv: dirtyBase,
      gatewayEnv,
      workerEnv: WorkerEnvConfigSchema.parse({
        environmentLabel: "My Cloud Devbox",
      }),
    });
    expect(labeledEnv.T3CODE_ENVIRONMENT_LABEL).toBe("My Cloud Devbox");
  });

  it("hashes passwords with scrypt, invalidates old sessions on epoch bump, and rate-limits brute force", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "t3gw-auth-"));
    tempDirs.push(tmp);

    const auth = new GatewayAuthService(tmp, 3, 60_000, 60_000);
    await auth.init();
    expect(auth.isSetupRequired()).toBe(true);

    await auth.setPassword("correct-horse", false);
    expect(auth.isSetupRequired()).toBe(false);
    expect(await auth.verifyPassword("wrong")).toBe(false);
    expect(await auth.verifyPassword("correct-horse")).toBe(true);

    const issued1 = auth.issueSessionToken();
    expect(auth.verifySessionToken(issued1.token)?.sessionId).toBe(issued1.session.sessionId);

    // Rotating password with bumpEpoch=true immediately invalidates previously issued cookies
    await auth.setPassword("new-battery-staple", true);
    expect(auth.verifySessionToken(issued1.token)).toBeNull();
    const issued2 = auth.issueSessionToken();
    expect(auth.verifySessionToken(issued2.token)).not.toBeNull();

    // Brute-force lockout after 3 failed attempts
    const ip = "203.0.113.9";
    auth.recordAuthAttempt(ip, false);
    auth.recordAuthAttempt(ip, false);
    expect(auth.checkRateLimit(ip).allowed).toBe(true);
    auth.recordAuthAttempt(ip, false);
    const blocked = auth.checkRateLimit(ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("validates WebSocket Origin headers and X-Forwarded-For trust boundary", () => {
    expect(resolveClientIp("10.0.0.2", "1.2.3.4", false)).toBe("10.0.0.2");
    expect(resolveClientIp("10.0.0.2", "1.2.3.4, 10.0.0.1", true)).toBe("1.2.3.4");

    expect(
      verifyWebSocketOrigin({
        originHeader: "http://localhost:3080",
        hostHeader: "localhost:3080",
      }),
    ).toBe(true);
    expect(
      verifyWebSocketOrigin({
        originHeader: "https://evil.example.com",
        hostHeader: "localhost:3080",
        publicUrl: "https://t3.myhost.dev",
      }),
    ).toBe(false);
    expect(
      verifyWebSocketOrigin({
        originHeader: "https://t3.myhost.dev",
        hostHeader: "127.0.0.1:3080",
        publicUrl: "https://t3.myhost.dev",
      }),
    ).toBe(true);
  });

  it("seeds addProjectBaseDirectory to /workspace while preserving explicit custom paths", () => {
    const seeded = mergeDefaultT3ServerSettings({}, "/workspace");
    expect(seeded.changed).toBe(true);
    expect(seeded.next.addProjectBaseDirectory).toBe("/workspace");

    const seededFromBlank = mergeDefaultT3ServerSettings({ addProjectBaseDirectory: "   " }, "/workspace");
    expect(seededFromBlank.changed).toBe(true);
    expect(seededFromBlank.next.addProjectBaseDirectory).toBe("/workspace");

    const preserved = mergeDefaultT3ServerSettings(
      { addProjectBaseDirectory: "/workspace/repos", ghqCloneLayout: true },
      "/workspace",
    );
    expect(preserved.changed).toBe(false);
    expect(preserved.next.addProjectBaseDirectory).toBe("/workspace/repos");
    expect(preserved.next.ghqCloneLayout).toBe(true);
  });

  it("detects chrome-headless-shell in $T3CODE_HOME/tools (and legacy userdata/tools) and syncs dynamic bin/t3 shim", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "t3gw-tools-"));
    tempDirs.push(tmp);

    // 1. Empty directory does not false-positive
    const emptyShellDir = path.join(tmp, "tools", "chrome-headless-shell");
    await fs.mkdir(emptyShellDir, { recursive: true });
    expect(await detectHeadlessBrowserInstalled(tmp)).toBe(false);

    // 2. Real T3 layout: $T3CODE_HOME/tools/chrome-headless-shell/linux64/<ver>/chrome-headless-shell
    const realBinDir = path.join(emptyShellDir, "linux64", "158.0.8127.88");
    await fs.mkdir(realBinDir, { recursive: true });
    await fs.writeFile(path.join(realBinDir, "chrome-headless-shell"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    expect(await detectHeadlessBrowserInstalled(tmp)).toBe(true);

    // 3. Legacy fallback layout: $T3CODE_HOME/userdata/tools/chrome-headless-shell/...
    const tmpLegacy = await fs.mkdtemp(path.join(os.tmpdir(), "t3gw-legacy-tools-"));
    tempDirs.push(tmpLegacy);
    const legacyBinDir = path.join(
      tmpLegacy,
      "userdata",
      "tools",
      "chrome-headless-shell",
      "linux-arm64",
      "158.0.0.1",
    );
    await fs.mkdir(legacyBinDir, { recursive: true });
    await fs.writeFile(path.join(legacyBinDir, "chrome-headless-shell"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    expect(await detectHeadlessBrowserInstalled(tmpLegacy)).toBe(true);

    // 4. syncT3CliBinShim overwrites stale Desktop-hardcoded versions/<ver> shim with dynamic runtime/current wrapper
    const gatewayEnv = GatewayEnvSchema.parse({ T3CODE_HOME: tmp });
    const workerEnv = WorkerEnvConfigSchema.parse({});
    const binDir = path.join(tmp, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      path.join(binDir, "t3"),
      "#!/bin/sh\napp='/data/t3/runtime/versions/0.1.12/opt/T3 Code (Beta)/t3code'\n",
      "utf8",
    );

    const syncedShimPath = await syncT3CliBinShim(gatewayEnv, workerEnv);
    expect(syncedShimPath).toBe(path.join(tmp, "bin", "t3"));
    const shimBody = await fs.readFile(syncedShimPath, "utf8");
    expect(shimBody).toBe(buildT3CliBinShim(tmp));
    expect(shimBody).toContain("$home/runtime/current/t3-server-launcher");
    expect(shimBody).not.toContain("runtime/versions/0.1.12");

    // 5. buildCleanWorkerEnv includes $T3CODE_HOME/bin on PATH
    const clean = buildCleanWorkerEnv({ gatewayEnv, workerEnv });
    expect(clean.PATH?.split(process.platform === "win32" ? ";" : ":")).toContain(
      path.join(tmp, "bin"),
    );
  });
});
