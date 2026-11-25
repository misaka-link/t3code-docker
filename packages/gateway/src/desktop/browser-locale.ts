import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CHROMIUM_SUPPORTED_LOCALES, type SupportedLocale } from "@t3-docker/shared";

const SUPPORTED_SET = new Set<string>(CHROMIUM_SUPPORTED_LOCALES);

const EXPLICIT_LOCALE_MAP: Readonly<Record<string, string>> = {
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-sg": "zh-CN",
  "zh-tw": "zh-TW",
  "zh-hk": "zh-TW",
  "zh-hant": "zh-TW",
  en: "en-US",
  "en-us": "en-US",
  "en-gb": "en-GB",
  "en-uk": "en-GB",
  ja: "ja",
  "ja-jp": "ja",
  ko: "ko",
  "ko-kr": "ko",
  es: "es",
  "es-es": "es",
  fr: "fr",
  "fr-fr": "fr",
  de: "de",
  "de-de": "de",
  ru: "ru",
  "ru-ru": "ru",
  pt: "pt-BR",
  "pt-br": "pt-BR",
};

export interface BrowserLocaleBundle {
  /** Normalized Chromium UI locale (e.g. `zh-CN`, `en-US`). */
  readonly bcp47: string;
  /** Command-line flags to pass BEFORE the target URL. */
  readonly chromiumArgs: readonly string[];
  /** Subprocess environment overrides so Linux Glibc/GTK LANGUAGE never overrides `--lang`. */
  readonly envOverrides: Readonly<Record<string, string>>;
}

export function normalizeBrowserLocale(raw: string | undefined | null): string {
  if (!raw) return "";
  const cleaned = raw.trim().split(".")[0]?.replace(/_/g, "-") ?? "";
  if (!cleaned) return "";
  const lower = cleaned.toLowerCase();

  const mapped = EXPLICIT_LOCALE_MAP[lower];
  if (mapped) return mapped;

  if (lower.startsWith("zh")) {
    return lower.includes("tw") || lower.includes("hk") || lower.includes("hant")
      ? "zh-TW"
      : "zh-CN";
  }
  if (lower.startsWith("en")) {
    return lower.includes("gb") || lower.includes("uk") ? "en-GB" : "en-US";
  }
  for (const prefix of ["ja", "ko", "es", "fr", "de", "ru"]) {
    if (lower === prefix || lower.startsWith(`${prefix}-`)) {
      return prefix;
    }
  }
  if (lower === "pt" || lower.startsWith("pt-")) {
    return "pt-BR";
  }
  return SUPPORTED_SET.has(cleaned) ? cleaned : "";
}

export function buildBrowserLocaleBundle(bcp47Locale: string): BrowserLocaleBundle {
  const normalized = normalizeBrowserLocale(bcp47Locale) || "zh-CN";
  const primary = normalized.split("-")[0] ?? "zh";
  const posixBase = normalized.includes("-")
    ? normalized.replace("-", "_")
    : normalized === "ja"
      ? "ja_JP"
      : normalized === "ko"
        ? "ko_KR"
        : `${normalized}_${normalized.toUpperCase()}`;

  const acceptLang = primary !== normalized ? `${normalized},${primary};q=0.9` : normalized;

  return {
    bcp47: normalized,
    chromiumArgs: [`--lang=${normalized}`, `--accept-lang=${acceptLang}`],
    envOverrides: {
      LANG: `${posixBase}.UTF-8`,
      LANGUAGE: `${posixBase}:${primary}`,
    },
  };
}

export async function resolveEffectiveDesktopLocale(input: {
  readonly languageOverride: string;
  readonly t3HomeDir: string;
  readonly gatewayLocale: SupportedLocale;
}): Promise<BrowserLocaleBundle> {
  const fromOverride = normalizeBrowserLocale(input.languageOverride);
  if (fromOverride) {
    return buildBrowserLocaleBundle(fromOverride);
  }

  try {
    const clientSettingsPath = path.join(input.t3HomeDir, "userdata", "client-settings.json");
    const raw = await fs.readFile(clientSettingsPath, "utf8");
    const parsed = JSON.parse(raw) as { locale?: unknown; language?: unknown };
    const candidate =
      typeof parsed.locale === "string"
        ? parsed.locale
        : typeof parsed.language === "string"
          ? parsed.language
          : "";
    const fromT3Client = normalizeBrowserLocale(candidate);
    if (fromT3Client) {
      return buildBrowserLocaleBundle(fromT3Client);
    }
  } catch {
    // Ignore missing client-settings.json
  }

  return buildBrowserLocaleBundle(input.gatewayLocale);
}
