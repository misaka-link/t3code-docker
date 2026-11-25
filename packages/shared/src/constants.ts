export const SUITE_VERSION = "0.1.0";

export const GATEWAY_INTERNAL_PREFIX = "/_t3gw" as const;
export const GATEWAY_API_PREFIX = "/_t3gw/api/v1" as const;
export const GATEWAY_ASSETS_PREFIX = "/_t3gw/assets" as const;

/**
 * Upstream T3 Code WebUI & Gateway internal reserved path prefixes.
 * Custom adminPath and vncPath must never collide with or nest under these.
 */
export const RESERVED_ROUTE_PREFIXES = [
  "/",
  "/pair",
  "/api",
  "/mcp",
  "/.well-known",
  "/assets",
  "/_t3gw",
  "/ws",
  "/oauth",
  "/settings",
] as const;

export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = "zh-CN";

export const THEME_MODES = ["dark", "light", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const RELEASE_CHANNELS = ["stable", "nightly"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export const IMAGE_VARIANTS = ["full", "headless"] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

export const CHROMIUM_SUPPORTED_LOCALES = [
  "zh-CN",
  "zh-TW",
  "en-US",
  "en-GB",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "ru",
  "pt-BR",
] as const;

export const DESKTOP_RESOLUTION_PRESETS = [
  { label: "1080p (1920 × 1080)", width: 1920, height: 1080 },
  { label: "2K QHD (2560 × 1440)", width: 2560, height: 1440 },
  { label: "HD+ (1600 × 900)", width: 1600, height: 900 },
  { label: "WXGA (1366 × 768)", width: 1366, height: 768 },
] as const;

export interface AgentProviderCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly binary: string;
  readonly npmPackage?: string;
  readonly installHint: string;
  readonly supportsCustomGateway: boolean;
  readonly defaultPreinstall: boolean;
}

export const AGENT_PROVIDER_CATALOG: readonly AgentProviderCatalogItem[] = [
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    installHint: "claude auth login",
    supportsCustomGateway: true,
    defaultPreinstall: true,
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    binary: "codex",
    npmPackage: "@openai/codex",
    installHint: "codex login",
    supportsCustomGateway: true,
    defaultPreinstall: true,
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",
    npmPackage: "opencode-ai",
    installHint: "opencode auth login",
    supportsCustomGateway: true,
    defaultPreinstall: true,
  },
  {
    id: "antigravity",
    name: "Google Antigravity",
    binary: "agy",
    npmPackage: "@google/gemini-cli",
    installHint: "Sign in via T3 Providers or VNC browser",
    supportsCustomGateway: false,
    defaultPreinstall: false,
  },
  {
    id: "pi",
    name: "Pi Coding Agent",
    binary: "pi",
    npmPackage: "@mariozechner/pi-coding-agent",
    installHint: "pi login",
    supportsCustomGateway: true,
    defaultPreinstall: false,
  },
  {
    id: "grok",
    name: "Grok CLI",
    binary: "grok",
    npmPackage: "@vibe-kit/grok-cli",
    installHint: "Configure XAI_API_KEY",
    supportsCustomGateway: true,
    defaultPreinstall: false,
  },
] as const;

export interface MiseToolCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly category: "language" | "forge";
  readonly miseSpec: string;
  readonly binary: string;
}

export const MISE_TOOL_CATALOG: readonly MiseToolCatalogItem[] = [
  { id: "go", name: "Go", category: "language", miseSpec: "go@latest", binary: "go" },
  { id: "rust", name: "Rust", category: "language", miseSpec: "rust@latest", binary: "rustc" },
  { id: "bun", name: "Bun", category: "language", miseSpec: "bun@latest", binary: "bun" },
  { id: "deno", name: "Deno", category: "language", miseSpec: "deno@latest", binary: "deno" },
  { id: "glab", name: "GitLab CLI (glab)", category: "forge", miseSpec: "ubi:gitlab.com/gitlab-org/cli[exe=glab]", binary: "glab" },
  { id: "tea", name: "Gitea CLI (tea)", category: "forge", miseSpec: "tea@latest", binary: "tea" },
] as const;
