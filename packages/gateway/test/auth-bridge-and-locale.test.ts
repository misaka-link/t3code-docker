import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayEnvSchema } from "@t3-docker/shared";
import {
  MANUAL_PAIRING_LABEL,
  T3AuthBridge,
  VNC_DESKTOP_SESSION_LABEL,
  type CommandExecutor,
} from "../src/auth-bridge/t3-auth-bridge.js";
import { ConfigStore } from "../src/config/config-store.js";
import { parseDeviceCodeOutput } from "../src/connect/t3-connect-service.js";
import {
  buildBrowserLocaleBundle,
  normalizeBrowserLocale,
  toT3ClientLanguage,
} from "../src/desktop/browser-locale.js";
import { parseSha256Sums, resolveExpectedAssetName } from "../src/versions/version-hub.js";

describe("T3AuthBridge Zero-Duplicate Issuance & Browser Locale Sync", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("detects existing native t3_session_* cookies and deduplicates concurrent web pairing mints", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "t3gw-bridge-"));
    tempDirs.push(tmp);

    const env = GatewayEnvSchema.parse({
      T3GW_DATA_DIR: path.join(tmp, "gw"),
      T3CODE_HOME: path.join(tmp, "t3"),
    });
    const store = new ConfigStore(env);
    await store.init();

    let createCalls = 0;
    let revokedIds: string[] = [];
    let activeSessions: Array<Record<string, unknown>> = [];
    let activePairings: Array<Record<string, unknown>> = [];

    const mockExecutor: CommandExecutor = {
      async runT3Auth(args) {
        if (args[0] === "pairing" && args[1] === "create") {
          createCalls += 1;
          await new Promise((r) => setTimeout(r, 30));
          const id = `pair-${createCalls}`;
          const labelIdx = args.indexOf("--label");
          const label = labelIdx >= 0 ? args[labelIdx + 1] : undefined;
          activePairings.push({ credentialId: id, ...(label ? { client: { label } } : {}) });
          return {
            code: 0,
            stdout: JSON.stringify({ credentialId: id, credential: `tok_${createCalls}` }),
            stderr: "",
          };
        }
        if (args[0] === "pairing" && args[1] === "list") {
          return { code: 0, stdout: JSON.stringify(activePairings), stderr: "" };
        }
        if (args[0] === "pairing" && args[1] === "revoke") {
          revokedIds.push(args[2]!);
          activePairings = activePairings.filter((p) => p.credentialId !== args[2] && p.id !== args[2]);
          return { code: 0, stdout: "{}", stderr: "" };
        }
        if (args[0] === "session" && args[1] === "list") {
          return { code: 0, stdout: JSON.stringify(activeSessions), stderr: "" };
        }
        if (args[0] === "session" && args[1] === "revoke") {
          revokedIds.push(args[2]!);
          activeSessions = activeSessions.filter((s) => s.sessionId !== args[2] && s.id !== args[2]);
          return { code: 0, stdout: "{}", stderr: "" };
        }
        return { code: 0, stdout: "[]", stderr: "" };
      },
    };

    const bridge = new T3AuthBridge(env, store, mockExecutor);

    // 1. Native cookie detection
    expect(
      bridge.hasNativeT3SessionCookie(
        "t3gw_session=abc; t3_session_3773_deadbeef1234=live_cookie",
        "t3_session_3773_deadbeef1234",
      ),
    ).toBe(true);
    expect(
      bridge.hasNativeT3SessionCookie("t3gw_session=abc", "t3_session_3773_deadbeef1234"),
    ).toBe(false);

    // 2. Singleflight: 6 concurrent requests for the same gateway session mint ONLY ONE token
    const concurrentResults = await Promise.all(
      Array.from({ length: 6 }, () =>
        bridge.getOrMintWebPairingRedirect("gwsession-001", "http://localhost:3080"),
      ),
    );
    expect(createCalls).toBe(1);
    for (const res of concurrentResults) {
      expect(res).toEqual({ redirectUrl: "/pair#token=tok_1" });
    }

    // Immediate repeat redirect within cooldown trips loop circuit breaker instead of re-minting
    const secondImmediate = await bridge.getOrMintWebPairingRedirect(
      "gwsession-001",
      "http://localhost:3080",
    );
    expect(secondImmediate).toEqual({ circuitBroken: true });
    expect(createCalls).toBe(1);

    // 3. VNC Desktop session reuse: skips issuance when connection-catalog.json (or legacy saved-environments.json) + 1 session exist
    const userdataDir = path.join(env.T3CODE_HOME, "userdata");
    await fs.mkdir(userdataDir, { recursive: true });
    await fs.writeFile(
      path.join(userdataDir, "connection-catalog.json"),
      JSON.stringify({ version: 1, encryptedCatalog: "dGVzdA==" }),
      "utf8",
    );
    activeSessions = [
      {
        sessionId: "sess-vnc-1",
        method: "dpop-access-token",
        subject: "one-time-token",
        client: { label: VNC_DESKTOP_SESSION_LABEL },
        issuedAt: "2026-11-25T13:30:55.565Z",
        expiresAt: "2027-11-25T13:30:55.565Z",
      },
    ];

    const normalizedSessions = await bridge.listSessions();
    expect(normalizedSessions).toEqual([
      {
        id: "sess-vnc-1",
        label: VNC_DESKTOP_SESSION_LABEL,
        subject: "one-time-token",
        createdAt: "2026-11-25T13:30:55.565Z",
        expiresAt: "2027-11-25T13:30:55.565Z",
      },
    ]);

    const reusedDesktopLink = await bridge.ensureVncDesktopPairingAppLink("http://127.0.0.1:3773");
    expect(reusedDesktopLink).toBeNull();
    expect(createCalls).toBe(1);

    // 4. Manual QR pairing reuse & clean revocation on regenerate
    const qr1 = await bridge.getOrCreateManualPairing("https://t3.example.com", false);
    const qr2 = await bridge.getOrCreateManualPairing("https://t3.example.com", false);
    expect(qr1.url).toBe(qr2.url);
    expect(createCalls).toBe(2);

    const qr3 = await bridge.getOrCreateManualPairing("https://t3.example.com", true);
    expect(qr3.url).not.toBe(qr1.url);
    expect(revokedIds).toContain("pair-2");
    expect((await bridge.listPairings()).filter((p) => p.label === MANUAL_PAIRING_LABEL)).toHaveLength(1);
  });

  it("resolves Chromium --lang, --accept-lang, and Linux LANGUAGE env overrides without conflict", () => {
    expect(normalizeBrowserLocale("zh")).toBe("zh-CN");
    expect(normalizeBrowserLocale("zh_TW.UTF-8")).toBe("zh-TW");
    expect(normalizeBrowserLocale("en_US.UTF-8")).toBe("en-US");

    const zhBundle = buildBrowserLocaleBundle("zh-CN");
    expect(zhBundle.chromiumArgs).toEqual([
      "--lang=zh-CN",
      "--accept-lang=zh-CN,zh;q=0.9",
    ]);
    expect(zhBundle.envOverrides).toEqual({
      LANG: "zh_CN.UTF-8",
      LANGUAGE: "zh_CN:zh",
    });

    const enBundle = buildBrowserLocaleBundle("en-US");
    expect(enBundle.chromiumArgs).toEqual([
      "--lang=en-US",
      "--accept-lang=en-US,en;q=0.9",
    ]);
    expect(enBundle.envOverrides).toEqual({
      LANG: "en_US.UTF-8",
      LANGUAGE: "en_US:en",
    });

    expect(toT3ClientLanguage("zh-CN")).toBe("zh");
    expect(toT3ClientLanguage("zh-TW")).toBe("zh");
    expect(toT3ClientLanguage("en-US")).toBe("en");
    expect(toT3ClientLanguage("ja")).toBe("ja");
    expect(toT3ClientLanguage("pt-BR")).toBe("pt-BR");
  });

  it("parses T3 Connect headless device-code output and SHA256SUMS accurately", () => {
    const sample = `
  Open this URL on a device with a browser:
    https://app.t3.codes/activate
  Confirm this code when asked: K7QM-2XFD
  Waiting for approval (expires in 15 min).
`;
    const parsed = parseDeviceCodeOutput(sample);
    expect(parsed.verificationUrl).toBe("https://app.t3.codes/activate");
    expect(parsed.userCode).toBe("K7QM-2XFD");
    expect(parsed.expiresInSeconds).toBe(900);
    expect(parsed.authorized).toBe(false);

    expect(resolveExpectedAssetName("0.1.12", "full", "arm64")).toBe(
      "T3-Code-0.1.12-arm64.deb",
    );
    expect(resolveExpectedAssetName("0.1.12", "headless", "x64")).toBe(
      "t3-0.1.12-linux-x64.tar.gz",
    );

    const sums = `
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  *T3-Code-0.1.12-amd64.deb
`;
    expect(parseSha256Sums(sums, "T3-Code-0.1.12-amd64.deb")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
