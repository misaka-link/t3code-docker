import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, type SupportedLocale, type ThemeMode } from "@t3-docker/shared";
import { zhCN, type TranslationDict } from "./zh-CN";
import { enUS } from "./en-US";

const DICTS: Record<SupportedLocale, TranslationDict> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

function syncBrowserT3ClientLanguage(locale: SupportedLocale): void {
  try {
    const key = "t3code:client-settings:v1";
    const targetLang = locale === "zh-CN" ? "zh" : "en";
    const raw = localStorage.getItem(key);
    let parsed: Record<string, unknown> = {};
    if (raw) {
      const candidate: unknown = JSON.parse(raw);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    }
    if (parsed.language === targetLang) return;
    localStorage.setItem(key, JSON.stringify({ ...parsed, language: targetLang }));
  } catch {
    // Ignore storage errors
  }
}

interface UiPreferencesContextValue {
  readonly locale: SupportedLocale;
  readonly t: TranslationDict;
  readonly setLocale: (next: SupportedLocale) => void;
  readonly theme: ThemeMode;
  readonly setTheme: (next: ThemeMode) => void;
}

const UiPreferencesContext = createContext<UiPreferencesContextValue | null>(null);

export function UiPreferencesProvider(props: {
  readonly initialLocale?: SupportedLocale;
  readonly initialTheme?: ThemeMode;
  readonly children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    const saved = localStorage.getItem("t3gw_locale");
    if (saved === "zh-CN" || saved === "en-US") return saved;
    return props.initialLocale ?? DEFAULT_LOCALE;
  });

  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("t3gw_theme");
    if (saved === "dark" || saved === "light" || saved === "system") return saved;
    return props.initialTheme ?? "dark";
  });

  useEffect(() => {
    document.documentElement.lang = locale;
    syncBrowserT3ClientLanguage(locale);
  }, [locale]);

  useEffect(() => {
    const root = document.documentElement;
    const apply = (isDark: boolean) => {
      root.classList.toggle("dark", isDark);
    };
    if (theme === "system") {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      apply(mql.matches);
      const handler = (e: MediaQueryListEvent) => apply(e.matches);
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
    apply(theme === "dark");
    return undefined;
  }, [theme]);

  const setLocale = (next: SupportedLocale) => {
    setLocaleState(next);
    localStorage.setItem("t3gw_locale", next);
  };

  const setTheme = (next: ThemeMode) => {
    setThemeState(next);
    localStorage.setItem("t3gw_theme", next);
  };

  return (
    <UiPreferencesContext.Provider
      value={{
        locale,
        t: DICTS[locale],
        setLocale,
        theme,
        setTheme,
      }}
    >
      {props.children}
    </UiPreferencesContext.Provider>
  );
}

export function useUiPreferences(): UiPreferencesContextValue {
  const ctx = useContext(UiPreferencesContext);
  if (!ctx) {
    throw new Error("useUiPreferences must be used within UiPreferencesProvider");
  }
  return ctx;
}
