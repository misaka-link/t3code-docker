import { z } from "zod";
import {
  IMAGE_VARIANTS,
  RELEASE_CHANNELS,
  SUPPORTED_LOCALES,
  THEME_MODES,
} from "./constants.js";
import {
  CustomAiGatewaySchema,
  CustomRoutePathSchema,
  DesktopConfigSchema,
  WorkerEnvConfigSchema,
} from "./config.schema.js";

export const SupervisorStateEnum = z.enum([
  "stopped",
  "starting",
  "healthy",
  "restarting",
  "updating",
  "maintenance",
  "degraded",
]);
export type SupervisorState = z.infer<typeof SupervisorStateEnum>;

export const DesktopStateEnum = z.enum([
  "unsupported",
  "hibernated",
  "waking",
  "running",
  "stopping",
  "degraded",
]);
export type DesktopState = z.infer<typeof DesktopStateEnum>;

export const BootstrapResponseSchema = z.object({
  suiteVersion: z.string(),
  variant: z.enum(IMAGE_VARIANTS),
  capabilities: z.object({
    desktopSupported: z.boolean(),
  }),
  setupRequired: z.boolean(),
  authenticated: z.boolean(),
  locale: z.enum(SUPPORTED_LOCALES),
  theme: z.enum(THEME_MODES),
  routes: z.object({
    adminPath: z.string(),
    vncPath: z.string(),
  }),
});
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;

export const SetupRequestSchema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters").max(128),
  locale: z.enum(SUPPORTED_LOCALES).optional(),
  theme: z.enum(THEME_MODES).optional(),
});
export type SetupRequest = z.infer<typeof SetupRequestSchema>;

export const LoginRequestSchema = z.object({
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const SupervisorStatusSchema = z.object({
  state: SupervisorStateEnum,
  pid: z.number().nullable(),
  uptimeSeconds: z.number(),
  upstreamUrl: z.string(),
  activeVersion: z.string().nullable(),
  environmentId: z.string().nullable(),
  sessionCookieName: z.string().nullable(),
  restartCount: z.number(),
  lastError: z.string().nullable(),
  system: z.object({
    platform: z.string(),
    arch: z.string(),
    memoryRssMb: z.number(),
    freeDiskMb: z.number().nullable(),
    headlessBrowserInstalled: z.boolean(),
  }),
});
export type SupervisorStatus = z.infer<typeof SupervisorStatusSchema>;

export const SupervisorActionRequestSchema = z.object({
  action: z.enum(["start", "stop", "restart", "doctor", "warm-headless-browser"]),
});
export type SupervisorActionRequest = z.infer<typeof SupervisorActionRequestSchema>;

export const ReleaseItemSchema = z.object({
  version: z.string(),
  tagName: z.string(),
  channel: z.enum(RELEASE_CHANNELS),
  publishedAt: z.string(),
  notesSummary: z.string(),
  assetName: z.string().nullable(),
  assetSizeMb: z.number().nullable(),
  installed: z.boolean(),
  active: z.boolean(),
});
export type ReleaseItem = z.infer<typeof ReleaseItemSchema>;

export const VersionsOverviewSchema = z.object({
  channel: z.enum(RELEASE_CHANNELS),
  activeVersion: z.string().nullable(),
  installedVersions: z.array(
    z.object({
      version: z.string(),
      installedAt: z.string(),
      sizeMb: z.number(),
      active: z.boolean(),
    }),
  ),
  remoteReleases: z.array(ReleaseItemSchema),
  updateAvailable: z.string().nullable(),
  switching: z.boolean(),
  lastOperationError: z.string().nullable(),
});
export type VersionsOverview = z.infer<typeof VersionsOverviewSchema>;

export const InstallVersionRequestSchema = z.object({
  version: z.string().min(1).max(80),
  channel: z.enum(RELEASE_CHANNELS).optional(),
  createSnapshotBeforeSwitch: z.boolean().default(true),
});
export type InstallVersionRequest = z.infer<typeof InstallVersionRequestSchema>;

export const ConnectStateEnum = z.enum(["off", "signin", "authorizing", "pending", "on"]);
export type ConnectState = z.infer<typeof ConnectStateEnum>;

export const ConnectStatusSchema = z.object({
  state: ConnectStateEnum,
  desired: z.boolean(),
  authenticated: z.boolean(),
  linked: z.boolean(),
  revoked: z.boolean(),
  relayHost: z.string().nullable(),
  publishAgentActivity: z.boolean(),
  holdWebhooksWhileOffline: z.boolean().nullable(),
  deviceAuth: z
    .object({
      verificationUrl: z.string().nullable(),
      userCode: z.string().nullable(),
      expiresInSeconds: z.number().nullable(),
      identity: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  devices: z.array(
    z.object({
      id: z.string(),
      code: z.string().optional(),
      label: z.string(),
      status: z.enum(["pending", "approved"]),
      createdAt: z.string().optional(),
    }),
  ),
});
export type ConnectStatus = z.infer<typeof ConnectStatusSchema>;

export const ConnectToggleRequestSchema = z.object({
  enabled: z.boolean(),
  restartImmediately: z.boolean().default(true),
});
export type ConnectToggleRequest = z.infer<typeof ConnectToggleRequestSchema>;

export const ConnectPreferencesRequestSchema = z.object({
  publishAgentActivity: z.boolean().optional(),
  holdWebhooksWhileOffline: z.boolean().optional(),
});
export type ConnectPreferencesRequest = z.infer<typeof ConnectPreferencesRequestSchema>;

export const ConnectDeviceActionSchema = z.object({
  action: z.enum(["approve", "revoke"]),
});
export type ConnectDeviceAction = z.infer<typeof ConnectDeviceActionSchema>;

export const DesktopStatusSchema = z.object({
  supported: z.boolean(),
  state: DesktopStateEnum,
  pid: z.number().nullable(),
  activeConnections: z.number(),
  idleSeconds: z.number(),
  autoSleepRemainingSeconds: z.number().nullable(),
  activeLocale: z.string(),
  t3DesktopRunning: z.boolean(),
  chromiumRunning: z.boolean(),
  config: DesktopConfigSchema,
  lastError: z.string().nullable(),
});
export type DesktopStatus = z.infer<typeof DesktopStatusSchema>;

export const DesktopActionRequestSchema = z.object({
  action: z.enum(["start", "stop", "restart", "launch-t3-desktop", "launch-chromium"]),
});
export type DesktopActionRequest = z.infer<typeof DesktopActionRequestSchema>;

export const ProvidersOverviewSchema = z.object({
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      binary: z.string(),
      npmPackage: z.string().optional(),
      installed: z.boolean(),
      version: z.string().nullable(),
      installHint: z.string(),
      supportsCustomGateway: z.boolean(),
    }),
  ),
  toolchains: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      category: z.enum(["language", "forge"]),
      binary: z.string(),
      installed: z.boolean(),
      version: z.string().nullable(),
    }),
  ),
  workerEnv: WorkerEnvConfigSchema,
  aiGateways: z.array(
    CustomAiGatewaySchema.omit({ apiKey: true }).extend({
      apiKeyMasked: z.string(),
    }),
  ),
  desktopBrowserMcpEnabled: z.boolean(),
  headlessPlaywrightMcpEnabled: z.boolean(),
  busyTask: z.string().nullable(),
});
export type ProvidersOverview = z.infer<typeof ProvidersOverviewSchema>;

export const PackageMutationRequestSchema = z.object({
  kind: z.enum(["agent", "toolchain"]),
  id: z.string().min(1).max(64),
  action: z.enum(["install", "upgrade", "uninstall"]),
});
export type PackageMutationRequest = z.infer<typeof PackageMutationRequestSchema>;

export const SnapshotScopeEnum = z.enum(["config", "full"]);
export type SnapshotScope = z.infer<typeof SnapshotScopeEnum>;

export const SnapshotItemSchema = z.object({
  id: z.string(),
  filename: z.string(),
  scope: SnapshotScopeEnum,
  note: z.string(),
  createdAt: z.string(),
  sizeBytes: z.number(),
  suiteVersion: z.string(),
  t3Version: z.string().nullable(),
  sha256: z.string(),
});
export type SnapshotItem = z.infer<typeof SnapshotItemSchema>;

export const CreateSnapshotRequestSchema = z.object({
  scope: SnapshotScopeEnum.default("full"),
  note: z.string().max(120).default(""),
});
export type CreateSnapshotRequest = z.infer<typeof CreateSnapshotRequestSchema>;

export const RestoreSnapshotRequestSchema = z.object({
  scope: SnapshotScopeEnum.default("full"),
});
export type RestoreSnapshotRequest = z.infer<typeof RestoreSnapshotRequestSchema>;

export const UpdateGatewaySettingsRequestSchema = z.object({
  adminPath: CustomRoutePathSchema.optional(),
  vncPath: CustomRoutePathSchema.optional(),
  locale: z.enum(SUPPORTED_LOCALES).optional(),
  theme: z.enum(THEME_MODES).optional(),
  trustProxy: z.boolean().optional(),
  publicUrl: z.string().max(256).optional(),
  releaseChannel: z.enum(RELEASE_CHANNELS).optional(),
  releaseBaseUrl: z.string().max(256).optional(),
  newPassword: z.string().min(6).max(128).optional(),
  revokeAllSessions: z.boolean().default(false),
});
export type UpdateGatewaySettingsRequest = z.infer<typeof UpdateGatewaySettingsRequestSchema>;
