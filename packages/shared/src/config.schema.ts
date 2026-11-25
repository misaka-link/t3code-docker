import { z } from "zod";
import {
  DEFAULT_LOCALE,
  IMAGE_VARIANTS,
  RELEASE_CHANNELS,
  RESERVED_ROUTE_PREFIXES,
  SUPPORTED_LOCALES,
  THEME_MODES,
} from "./constants.js";

export function normalizeRoutePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withLeading === "/") return "/";
  return withLeading.replace(/\/+$/, "");
}

export function isReservedRoutePath(normalizedPath: string): boolean {
  const lower = normalizedPath.toLowerCase();
  for (const reserved of RESERVED_ROUTE_PREFIXES) {
    const r = reserved.toLowerCase();
    if (r === "/") {
      if (lower === "/") return true;
      continue;
    }
    if (lower === r || lower.startsWith(`${r}/`)) {
      return true;
    }
  }
  return false;
}

export const CustomRoutePathSchema = z
  .string()
  .transform(normalizeRoutePath)
  .refine((val) => /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(val), {
    message: "Path must start with '/' and contain only letters, digits, '-' or '_'.",
  })
  .refine((val) => !isReservedRoutePath(val), {
    message: "Path collides with a reserved T3 Code or gateway internal route.",
  });

export const DesktopConfigSchema = z.object({
  width: z.number().int().min(800).max(3840).default(1920),
  height: z.number().int().min(600).max(2160).default(1080),
  idleTimeoutMinutes: z.number().int().min(0).max(1440).default(30),
  autoStartT3Desktop: z.boolean().default(true),
  enableDesktopBrowserMcp: z.boolean().default(true),
  cdpPort: z.number().int().min(1024).max(65535).default(9222),
  languageOverride: z.string().default(""),
});
export type DesktopConfig = z.infer<typeof DesktopConfigSchema>;

export const WorkerEnvConfigSchema = z.object({
  environmentLabel: z.string().trim().max(80).default(""),
  disableT3Telemetry: z.boolean().default(true),
  disableAntigravityTelemetry: z.boolean().default(true),
  httpProxy: z.string().default(""),
  httpsProxy: z.string().default(""),
  allProxy: z.string().default(""),
  noProxy: z.string().default("localhost,127.0.0.1,::1"),
  customVars: z
    .record(
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "Invalid environment variable name"),
      z.string(),
    )
    .default({}),
});
export type WorkerEnvConfig = z.infer<typeof WorkerEnvConfigSchema>;

const BaseGatewayPersistedConfigSchema = z.object({
  adminPath: CustomRoutePathSchema.default("/admin"),
  vncPath: CustomRoutePathSchema.default("/vnc"),
  locale: z.enum(SUPPORTED_LOCALES).default(DEFAULT_LOCALE),
  theme: z.enum(THEME_MODES).default("dark"),
  trustProxy: z.boolean().default(false),
  publicUrl: z.string().default(""),
  releaseChannel: z.enum(RELEASE_CHANNELS).default("stable"),
  releaseBaseUrl: z.string().default(""),
  desktop: DesktopConfigSchema.default({}),
  workerEnv: WorkerEnvConfigSchema.default({}),
});

export const GatewayPersistedConfigSchema = BaseGatewayPersistedConfigSchema.refine(
  (cfg) => {
    const a = cfg.adminPath.toLowerCase();
    const v = cfg.vncPath.toLowerCase();
    return a !== v && !a.startsWith(`${v}/`) && !v.startsWith(`${a}/`);
  },
  {
    message: "adminPath and vncPath must not be identical or nested within each other.",
    path: ["vncPath"],
  },
);
export type GatewayPersistedConfig = z.infer<typeof GatewayPersistedConfigSchema>;

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (val) => (typeof val === "string" && val.trim() === "" ? undefined : val),
    schema.optional(),
  );

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((val) => {
    if (typeof val === "boolean") return val;
    if (!val) return undefined;
    const norm = val.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(norm)) return true;
    if (["0", "false", "no", "off"].includes(norm)) return false;
    return undefined;
  });

export const GatewayEnvSchema = z.object({
  PROXY_PORT: z.coerce.number().int().min(1).max(65535).default(3080),
  PROXY_HOST: z.string().default("0.0.0.0"),
  T3_UPSTREAM_HOST: z.string().default("127.0.0.1"),
  T3_UPSTREAM_PORT: z.coerce.number().int().min(1).max(65535).default(3773),
  NOVNC_UPSTREAM_PORT: z.coerce.number().int().min(1).max(65535).default(6080),
  AUTH_TOKEN: emptyToUndefined(z.string()),
  SESSION_SECRET: emptyToUndefined(z.string()),
  ADMIN_PATH: emptyToUndefined(CustomRoutePathSchema),
  VNC_PATH: emptyToUndefined(CustomRoutePathSchema),
  ENVIRONMENT_LABEL: emptyToUndefined(z.string().trim().max(80)),
  T3CODE_ENVIRONMENT_LABEL: emptyToUndefined(z.string().trim().max(80)),
  DEFAULT_LOCALE: emptyToUndefined(z.enum(SUPPORTED_LOCALES)),
  RELEASE_CHANNEL: emptyToUndefined(z.enum(RELEASE_CHANNELS)),
  TRUST_PROXY: booleanFromEnv,
  PUBLIC_URL: emptyToUndefined(z.string()),
  T3GW_VARIANT: z.enum(IMAGE_VARIANTS).default("full"),
  T3GW_DATA_DIR: z.string().default("/data/gateway"),
  T3CODE_HOME: z.string().default("/data/t3"),
  T3GW_PROVIDERS_DIR: z.string().default("/data/providers"),
  T3GW_SNAPSHOTS_DIR: z.string().default("/data/snapshots"),
  T3_WORKSPACE: z.string().default("/workspace"),
  CODER_HOME: z.string().default("/home/coder"),
  CODER_USER: z.string().default(""),
  T3_BIN_PATH: z.string().default(""),
  T3_DESKTOP_BIN_PATH: z.string().default(""),
  CONSOLE_DIST_DIR: z.string().default(""),
  VERSIONS_MIN_FREE_MB: z.coerce.number().int().min(128).default(1536),
  T3_PREINSTALL: z.enum(["core", "all", "none"]).default("core"),
  DESKTOP_WIDTH: emptyToUndefined(z.coerce.number().int().min(800).max(3840)),
  DESKTOP_HEIGHT: emptyToUndefined(z.coerce.number().int().min(600).max(2160)),
  DESKTOP_IDLE_MINUTES: emptyToUndefined(z.coerce.number().int().min(0).max(1440)),
  DISABLE_TELEMETRY: booleanFromEnv,
  DISABLE_T3_TELEMETRY: booleanFromEnv,
  DISABLE_ANTIGRAVITY_TELEMETRY: booleanFromEnv,
  HTTP_PROXY: emptyToUndefined(z.string()),
  HTTPS_PROXY: emptyToUndefined(z.string()),
  ALL_PROXY: emptyToUndefined(z.string()),
  NO_PROXY: emptyToUndefined(z.string()),
});
export type GatewayEnv = z.infer<typeof GatewayEnvSchema>;
