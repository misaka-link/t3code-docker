import { useEffect, useState, type FormEvent } from "react";
import { Chrome, ExternalLink, Monitor, Play, RotateCw, Square } from "lucide-react";
import {
  CHROMIUM_SUPPORTED_LOCALES,
  DESKTOP_RESOLUTION_PRESETS,
  type DesktopStatus,
} from "@t3-docker/shared";
import { useUiPreferences } from "../i18n/context";
import { gatewayApi } from "../lib/api";
import { Badge, Button, Input, Select, StatusDot } from "../components/ui";

export function DesktopTab(props: { readonly vncPath: string }) {
  const { t } = useUiPreferences();
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [resolutionKey, setResolutionKey] = useState("1920x1080");
  const [idleMinutes, setIdleMinutes] = useState(30);
  const [langOverride, setLangOverride] = useState("");

  const load = async () => {
    try {
      const st = await gatewayApi.getDesktopStatus();
      setStatus(st);
      setResolutionKey(`${st.config.width}x${st.config.height}`);
      setIdleMinutes(st.config.idleTimeoutMinutes);
      setLangOverride(st.config.languageOverride);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  const runAction = async (
    action: "start" | "stop" | "restart" | "launch-t3-desktop" | "launch-chromium",
  ) => {
    setBusy(action);
    setError(null);
    try {
      setStatus(await gatewayApi.desktopAction(action));
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setBusy(null);
    }
  };

  const handleSaveConfig = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("save");
    setError(null);
    try {
      const [wStr, hStr] = resolutionKey.split("x");
      const next = await gatewayApi.updateDesktopConfig({
        width: Number(wStr) || 1920,
        height: Number(hStr) || 1080,
        idleTimeoutMinutes: idleMinutes,
        languageOverride: langOverride,
      });
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setBusy(null);
    }
  };

  const dotTone =
    status?.state === "running"
      ? "green"
      : status?.state === "waking" || status?.state === "stopping"
        ? "amber"
        : status?.state === "degraded"
          ? "red"
          : "gray";

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

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.desktop.activeConns}</div>
            <div className="text-xs font-mono font-semibold mt-1">
              {status?.activeConnections ?? 0}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.desktop.autoSleepIn}</div>
            <div className="text-xs font-mono font-semibold mt-1">
              {status?.autoSleepRemainingSeconds != null
                ? `${Math.ceil(status.autoSleepRemainingSeconds / 60)} min`
                : "—"}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">T3 Desktop</div>
            <div className="text-xs font-medium mt-1">
              {status?.t3DesktopRunning ? t.common.enabled : t.common.disabled}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">Locale</div>
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
        </div>
      </section>

      <form onSubmit={handleSaveConfig} className="t3-card p-5 space-y-4">
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
              value={idleMinutes}
              onChange={(e) => setIdleMinutes(Number(e.target.value))}
            />
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

        <Button type="submit" variant="primary" disabled={busy !== null}>
          {busy === "save" ? t.common.saving : t.common.save}
        </Button>
      </form>
    </div>
  );
}
