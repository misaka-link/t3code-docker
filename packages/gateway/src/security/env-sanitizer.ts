import * as os from "node:os";
import * as path from "node:path";
import type { GatewayEnv, WorkerEnvConfig } from "@t3-docker/shared";

export interface ConsumedGatewaySecrets {
  readonly initialAuthToken?: string;
  readonly initialSessionSecret?: string;
}

const LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1"];

export function mergeNoProxy(rawNoProxy?: string): string {
  const parts = (rawNoProxy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set(parts.map((p) => p.toLowerCase()));
  for (const host of LOOPBACK_NO_PROXY) {
    if (!seen.has(host)) {
      parts.push(host);
      seen.add(host);
    }
  }
  return parts.join(",");
}

const FORBIDDEN_CHILD_ENV_KEYS = new Set([
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "T3CODE_DESKTOP_CLI_LAUNCHER",
  "DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "AUTH_TOKEN",
  "SESSION_SECRET",
  "LC_ALL",
  "LANGUAGE",
]);

/**
 * Consumes AUTH_TOKEN and SESSION_SECRET from process.env and immediately deletes
 * gateway secrets from the live process environment so child processes can never inherit them.
 */
export function consumeAndScrubProcessSecrets(
  targetEnv: NodeJS.ProcessEnv = process.env,
): ConsumedGatewaySecrets {
  const initialAuthToken = targetEnv.AUTH_TOKEN?.trim() || undefined;
  const initialSessionSecret = targetEnv.SESSION_SECRET?.trim() || undefined;

  delete targetEnv.AUTH_TOKEN;
  delete targetEnv.SESSION_SECRET;
  for (const key of Object.keys(targetEnv)) {
    if (key.startsWith("T3GW_SECRET_")) {
      delete targetEnv[key];
    }
  }

  return {
    ...(initialAuthToken ? { initialAuthToken } : {}),
    ...(initialSessionSecret ? { initialSessionSecret } : {}),
  };
}

/**
 * Constructs a clean, isolated environment dictionary for `t3 serve` and `coder` subprocesses.
 * Guarantees:
 * - No NODE_ENV=production (preserves devDependencies in /workspace)
 * - No ELECTRON_RUN_AS_NODE (preserves Electron projects in /workspace)
 * - No DISPLAY or DBUS_SESSION_BUS_ADDRESS when headless
 * - No gateway secrets or T3GW_* control-plane variables
 */
export function buildCleanWorkerEnv(input: {
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly gatewayEnv: GatewayEnv;
  readonly workerEnv: WorkerEnvConfig;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const source = input.baseEnv ?? process.env;
  const result: Record<string, string> = {};

  for (const [key, val] of Object.entries(source)) {
    if (val === undefined) continue;
    if (FORBIDDEN_CHILD_ENV_KEYS.has(key)) continue;
    if (key.startsWith("T3GW_")) continue;
    result[key] = val;
  }

  const npmGlobalBin = path.join(input.gatewayEnv.T3GW_PROVIDERS_DIR, "npm-global", "bin");
  const miseShims = path.join(input.gatewayEnv.T3GW_PROVIDERS_DIR, "mise", "shims");
  const userLocalBin = path.join(input.gatewayEnv.CODER_HOME, ".local", "bin");
  const existingPath = result.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  const pathDelimiter = process.platform === "win32" ? ";" : ":";

  result.HOME = input.gatewayEnv.CODER_HOME;
  result.T3CODE_HOME = input.gatewayEnv.T3CODE_HOME;
  result.T3CODE_SERVER_BROWSER_SANDBOX = "0";
  const configuredLabel =
    input.workerEnv.environmentLabel?.trim() ||
    input.gatewayEnv.ENVIRONMENT_LABEL ||
    input.gatewayEnv.T3CODE_ENVIRONMENT_LABEL ||
    "";
  if (configuredLabel) {
    result.T3CODE_ENVIRONMENT_LABEL = configuredLabel;
  } else if (!result.T3CODE_ENVIRONMENT_LABEL) {
    const rawHost = os.hostname().trim();
    if (/^[0-9a-f]{12}$/i.test(rawHost)) {
      result.T3CODE_ENVIRONMENT_LABEL = "T3 Code Docker";
    }
  }
  result.NPM_CONFIG_PREFIX = path.join(input.gatewayEnv.T3GW_PROVIDERS_DIR, "npm-global");
  result.MISE_DATA_DIR = path.join(input.gatewayEnv.T3GW_PROVIDERS_DIR, "mise");
  result.MISE_CONFIG_DIR = path.join(input.gatewayEnv.T3GW_PROVIDERS_DIR, "mise-config");
  result.LANG = result.LANG || "C.UTF-8";
  result.PATH = [userLocalBin, miseShims, npmGlobalBin, existingPath].join(pathDelimiter);

  if (input.workerEnv.httpProxy) {
    result.HTTP_PROXY = input.workerEnv.httpProxy;
    result.http_proxy = input.workerEnv.httpProxy;
  }
  if (input.workerEnv.httpsProxy) {
    result.HTTPS_PROXY = input.workerEnv.httpsProxy;
    result.https_proxy = input.workerEnv.httpsProxy;
  }
  if (input.workerEnv.allProxy) {
    result.ALL_PROXY = input.workerEnv.allProxy;
    result.all_proxy = input.workerEnv.allProxy;
  }
  if (input.workerEnv.noProxy) {
    result.NO_PROXY = input.workerEnv.noProxy;
    result.no_proxy = input.workerEnv.noProxy;
  }

  if (input.workerEnv.disableT3Telemetry !== false) {
    result.T3CODE_TELEMETRY_ENABLED = "false";
    result.T3CODE_OTEL_SDK_DISABLED = "true";
    result.DO_NOT_TRACK = "1";
  } else {
    result.T3CODE_TELEMETRY_ENABLED = "true";
    delete result.T3CODE_OTEL_SDK_DISABLED;
    delete result.DO_NOT_TRACK;
  }

  if (input.workerEnv.disableAntigravityTelemetry !== false) {
    result.GEMINI_TELEMETRY_ENABLED = "false";
    result.OTEL_SDK_DISABLED = "true";
    result.AGY_TELEMETRY_DISABLED = "1";
  } else {
    delete result.GEMINI_TELEMETRY_ENABLED;
    delete result.OTEL_SDK_DISABLED;
    delete result.AGY_TELEMETRY_DISABLED;
  }

  for (const [customKey, customVal] of Object.entries(input.workerEnv.customVars)) {
    if (!FORBIDDEN_CHILD_ENV_KEYS.has(customKey) && !customKey.startsWith("T3GW_")) {
      result[customKey] = customVal;
    }
  }

  if (input.extraEnv) {
    for (const [k, v] of Object.entries(input.extraEnv)) {
      result[k] = v;
    }
  }

  return result;
}
