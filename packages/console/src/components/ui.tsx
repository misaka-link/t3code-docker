import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { Globe, Moon, Sun, Monitor } from "lucide-react";
import { useUiPreferences } from "../i18n/context";

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly variant?: "primary" | "secondary" | "ghost" | "danger";
    readonly size?: "sm" | "md";
  },
) {
  const { variant = "secondary", size = "md", className = "", children, ...rest } = props;
  const sizeCls = size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3.5 text-xs";
  const variantCls =
    variant === "primary"
      ? "bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 font-medium"
      : variant === "danger"
        ? "bg-red-500/15 text-red-500 border border-red-500/30 hover:bg-red-500/25 font-medium"
        : variant === "ghost"
          ? "bg-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--sidebar-row-hover)]"
          : "bg-[var(--muted)] text-[var(--foreground)] border border-[var(--border)] hover:bg-[var(--sidebar-row-hover)]";

  return (
    <button
      data-slot="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-[var(--control-radius)] transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${sizeCls} ${variantCls} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input
      data-slot="input"
      className={`h-8 w-full rounded-[var(--control-radius)] bg-[var(--background)] border border-[var(--border)] px-3 text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-[var(--accent)] transition-colors ${className}`}
      {...rest}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", children, ...rest } = props;
  return (
    <select
      data-slot="select-trigger"
      className={`h-8 rounded-[var(--control-radius)] bg-[var(--background)] border border-[var(--border)] px-2.5 text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--accent)] ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Switch(props: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors disabled:opacity-45 ${
        props.checked ? "bg-[var(--accent)]" : "bg-zinc-500/35"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          props.checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function Badge(props: {
  readonly tone?: "neutral" | "success" | "warning" | "error" | "info";
  readonly children: ReactNode;
}) {
  const tone = props.tone ?? "neutral";
  const cls =
    tone === "success"
      ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/25"
      : tone === "warning"
        ? "bg-amber-500/15 text-amber-500 border-amber-500/25"
        : tone === "error"
          ? "bg-red-500/15 text-red-500 border-red-500/25"
          : tone === "info"
            ? "bg-blue-500/15 text-blue-400 border-blue-500/25"
            : "bg-[var(--muted)] text-[var(--muted-foreground)] border-[var(--border)]";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {props.children}
    </span>
  );
}

export function StatusDot(props: { readonly tone: "green" | "amber" | "red" | "gray" }) {
  const color =
    props.tone === "green"
      ? "bg-emerald-500"
      : props.tone === "amber"
        ? "bg-amber-500 animate-pulse"
        : props.tone === "red"
          ? "bg-red-500"
          : "bg-zinc-500";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

export function TopLocaleThemeControls(props: {
  readonly onPersistPreference?: (patch: {
    locale?: "zh-CN" | "en-US";
    theme?: "dark" | "light" | "system";
  }) => void;
}) {
  const { locale, setLocale, theme, setTheme, t } = useUiPreferences();

  const toggleLocale = () => {
    const next = locale === "zh-CN" ? "en-US" : "zh-CN";
    setLocale(next);
    props.onPersistPreference?.({ locale: next });
  };

  const cycleTheme = () => {
    const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
    setTheme(next);
    props.onPersistPreference?.({ theme: next });
  };

  return (
    <div className="flex items-center gap-1.5">
      <Button variant="ghost" size="sm" onClick={toggleLocale} title="Switch Language">
        <Globe className="h-3.5 w-3.5" />
        <span>{locale === "zh-CN" ? "简体中文" : "EN"}</span>
      </Button>
      <Button variant="ghost" size="sm" onClick={cycleTheme} title="Appearance">
        {theme === "dark" ? (
          <Moon className="h-3.5 w-3.5" />
        ) : theme === "light" ? (
          <Sun className="h-3.5 w-3.5" />
        ) : (
          <Monitor className="h-3.5 w-3.5" />
        )}
        <span className="hidden sm:inline">
          {theme === "dark"
            ? t.common.themeDark
            : theme === "light"
              ? t.common.themeLight
              : t.common.themeSystem}
        </span>
      </Button>
    </div>
  );
}
