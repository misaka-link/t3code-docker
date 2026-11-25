import { memo, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Chrome, ExternalLink, Monitor, Play, RotateCw, Square } from "lucide-react";
import {
  CHROMIUM_SUPPORTED_LOCALES,
  DESKTOP_RESOLUTION_PRESETS,
  type DesktopConfig,
  type DesktopStatus,
} from "@t3-docker/shared";
import { useUiPreferences } from "../i18n/context";
import { gatewayApi } from "../lib/api";
import { Badge, Button, Input, Select, StatusDot } from "../components/ui";

const IDLE_PRESETS = [0, 5, 15, 30, 60] as const;

function formatSleepCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

interface DesktopSettingsFormProps {
  readonly syncedRevision: number;
  readonly initialWidth: number;
  readonly initialHeight: number;
  readonly initialIdleMinutes: number;
  readonly initialLangOverride: string;
  readonly saving: boolean;
  readonly savedNotice: boolean;
  readonly onSave: (patch: Partial<DesktopConfig>) => Promise<void>;
}

/**
 * Memoized form isolated from 5s status polling so open `<select>` dropdowns
 * and half-typed inputs never reset or re-render while background status updates.
 */
const DesktopSettingsForm = memo(function DesktopSettingsForm(props: DesktopSettingsFormProps) {
  const { t } = useUiPreferences();
  const [resolutionKey, setResolutionKey] = useState(
    `${props.initialWidth}x${props.initialHeight}`,
  );
  const [idleInput, setIdleInput] = useState(String(props.initialIdleMinutes));
  const [langOverride, setLangOverride] = useState(props.initialLangOverride);

  useEffect(() => {
    setResolutionKey(`${props.initialWidth}x${props.initialHeight}`);
    setIdleInput(String(props.initialIdleMinutes));
    setLangOverride(props.initialLangOverride);
  }, [
    props.syncedRevision,
    props.initialWidth,
    props.initialHeight,
    props.initialIdleMinutes,
    props.initialLangOverride,
  ]);

  const parsedIdle = Number.parseInt(idleInput.trim(), 10);
  const effectiveIdle = Number.isFinite(parsedIdle)
    ? Math.min(1440, Math.max(0, parsedIdle))
    : 0;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const [wStr, hStr] = resolutionKey.split("x");
    setIdleInput(String(effectiveIdle));
    void props.onSave({
      width: Number(wStr) || 1920,
      height: Number(hStr) || 1080,
      idleTimeoutMinutes: effectiveIdle,
      languageOverride: langOverride,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="t3-card p-5 space-y-4">
      <h3 className="text-sm font-semibold">{t.desktop.settingsTitle}</h3>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium">{t.desktop.resolutionLabel}</label>
          <Select
            className="w-full"
            value={resolutionKey}
            onChange={(e) => setResolutionKey(e.target.value)}
          >
            {DESKTOP_RESOLUTION_PRESETS.map((p) => (
              <option key={`${p.width}x${p.height}`} value={`${p.width}x${p.height}`}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium">{t.desktop.idleTimeoutLabel}</label>
          <Input
            type="number"
            min={0}
            max={1440}
            inputMode="numeric"
            value={idleInput}
            onChange={(e) => setIdleInput(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            <span className="text-[11px] text-[var(--muted-foreground)] mr-0.5">
              {t.desktop.sleepPresetsLabel}
            </span>
            {IDLE_PRESETS.map((mins) => {
              const active = idleInput.trim() !== "" && effectiveIdle === mins;
              return (
                <button
                  key={mins}
                  type="button"
                  onClick={() => setIdleInput(String(mins))}
                  className={`px-1.5 py-0.5 rounded text-[11px] border transition-colors cursor-pointer ${
                    active
                      ? "bg-[var(--primary)] text-[var(--primary-foreground)] border-transparent font-medium"
                      : "bg-[var(--muted)]/60 text-[var(--muted-foreground)] border-[var(--border)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {mins === 0 ? t.desktop.presetNever : `${mins}${t.desktop.presetMinutes}`}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium">{t.desktop.langOverrideLabel}</label>
          <Select
            className="w-full"
            value={langOverride}
            onChange={(e) => setLangOverride(e.target.value)}
          >
            <option value="">Auto</option>
            {CHROMIUM_SUPPORTED_LOCALES.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={props.saving}>
          {props.saving ? t.common.saving : t.common.save}
        </Button>
        {props.savedNotice && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
            <Check className="h-3.5 w-3.5" />
            {t.common.saved}
          </span>
        )}
      </div>
    </form>
  );
});

export function DesktopTab(props: { readonly vncPath: string }) {
  const { t } = useUiPreferences();
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [formConfig, setFormConfig] = useState<DesktopConfig | null>(null);
  const [syncedRevision, setSyncedRevision] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const initializedFormRef = useRef(false);

  const pollStatus = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const st = await gatewayApi.getDesktopStatus();
      setStatus(st);
      if (!initializedFormRef.current) {
        initializedFormRef.current = true;
        setFormConfig(st.config);
        setSyncedRevision((r) => r + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    }
  }, [t.common.error]);

  useEffect(() => {
    void pollStatus();
    const timer = setInterval(() => void pollStatus(), 5000);
    return () => clearInterval(timer);
  }, [pollStatus]);

  const runAction = async (
    action: "start" | "stop" | "restart" | "launch-t3-desktop" | "launch-chromium",
  ) => {
    setBusy(action);
    setError(null);
    setActionNotice(null);
    try {
      const next = await gatewayApi.desktopAction(action);
      setStatus(next);
      if (action === "launch-t3-desktop") {
        setActionNotice(t.desktop.launchedT3Notice);
        setTimeout(() => setActionNotice(null), 2500);
      } else if (action === "launch-chromium") {
        setActionNotice(t.desktop.launchedChromeNotice);
        setTimeout(() => setActionNotice(null), 2500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setBusy(null);
    }
  };

  const handleSaveConfig = useCallback(
    async (patch: Partial<DesktopConfig>) => {
      setBusy("save");
      setError(null);
      try {
        const next = await gatewayApi.updateDesktopConfig(patch);
        setStatus(next);
        setFormConfig(next.config);
        setSyncedRevision((r) => r + 1);
        setSavedNotice(true);
        setTimeout(() => setSavedNotice(false), 2200);
      } catch (err) {
        setError(err instanceof Error ? err.message : t.common.error);
      } finally {
        setBusy(null);
      }
    },
    [t.common.error],
  );

  const dotTone =
    status?.state === "running"
      ? "green"
      : status?.state === "waking" || status?.state === "stopping"
        ? "amber"
        : status?.state === "degraded"
          ? "red"
          : "gray";

  const sleepDisplay = (() => {
    if (!status || status.state !== "running") return "—";
    if (status.config.idleTimeoutMinutes <= 0) return t.desktop.stayAwake;
    if (status.activeConnections > 0) return t.desktop.inUseCountdown;
    if (status.autoSleepRemainingSeconds != null) {
      return formatSleepCountdown(status.autoSleepRemainingSeconds);
    }
    return "—";
  })();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{t.desktop.title}</h2>
          <p className="text-xs text-[var(--muted-foreground)] mt-0.5">{t.desktop.subtitle}</p>
        </div>

        <a
          href={props.vncPath}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-[var(--control-radius)] bg-[var(--primary)] text-[var(--primary-foreground)] text-xs font-medium"
        >
          <span>{t.brand.openVnc}</span>
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
          {error}
        </div>
      )}

      <section className="t3-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <StatusDot tone={dotTone} />
            <span className="text-sm font-medium">{t.desktop.statusCard}</span>
            {status && (
              <Badge tone={status.state === "running" ? "success" : "neutral"}>
                {t.desktop.states[status.state]}
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null || status?.state === "running"}
              onClick={() => void runAction("start")}
            >
              <Play className="h-3.5 w-3.5" />
              {t.desktop.startDesktop}
            </Button>
            <Button
              size="sm"
              disabled={busy !== null || status?.state !== "running"}
              onClick={() => void runAction("restart")}
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t.desktop.restartDesktop}
            </Button>
            <Button
              size="sm"
              disabled={busy !== null || status?.state === "hibernated"}
              onClick={() => void runAction("stop")}
            >
              <Square className="h-3.5 w-3.5" />
              {t.desktop.stopDesktop}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.desktop.activeConns}</div>
            <div className="text-xs font-mono font-semibold mt-1">
              {status?.activeConnections ?? 0}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.desktop.autoSleepIn}</div>
            <div className="text-xs font-mono font-semibold mt-1">{sleepDisplay}</div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.desktop.t3AppCard}</div>
            <div className="text-xs font-medium mt-1">
              {status?.t3DesktopRunning ? t.desktop.states.running : t.common.disabled}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.desktop.chromiumCard}</div>
            <div className="text-xs font-medium mt-1">
              {status?.chromiumRunning ? t.desktop.states.running : t.common.disabled}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.desktop.localeCard}</div>
            <div className="text-xs font-mono font-semibold mt-1">
              {status?.activeLocale ?? "zh-CN"}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[var(--border)]">
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void runAction("launch-t3-desktop")}
          >
            <Monitor className="h-3.5 w-3.5" />
            {t.desktop.launchT3App}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void runAction("launch-chromium")}
          >
            <Chrome className="h-3.5 w-3.5" />
            {t.desktop.launchChrome}
          </Button>
          {actionNotice && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
              <Check className="h-3.5 w-3.5" />
              {actionNotice}
            </span>
          )}
        </div>
      </section>

      <DesktopSettingsForm
        syncedRevision={syncedRevision}
        initialWidth={formConfig?.width ?? 1920}
        initialHeight={formConfig?.height ?? 1080}
        initialIdleMinutes={formConfig?.idleTimeoutMinutes ?? 30}
        initialLangOverride={formConfig?.languageOverride ?? ""}
        saving={busy === "save"}
        savedNotice={savedNotice}
        onSave={handleSaveConfig}
      />
    </div>
  );
}
