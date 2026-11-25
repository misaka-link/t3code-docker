import { useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import type { VersionsOverview } from "@t3-docker/shared";
import { useUiPreferences } from "../i18n/context";
import { gatewayApi } from "../lib/api";
import { Badge, Button, Select, Switch } from "../components/ui";

export function VersionsTab(props: { readonly onVersionChanged: () => Promise<void> }) {
  const { t } = useUiPreferences();
  const [data, setData] = useState<VersionsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoSnapshot, setAutoSnapshot] = useState(true);
  const [switchingVer, setSwitchingVer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasSwitchingRef = useRef(false);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const next = await gatewayApi.getVersions(refresh);
      setData(next);
      if (next.switching && next.switchProgress) {
        setSwitchingVer(next.switchProgress.targetVersion);
      } else if (next.lastOperationError) {
        setError(next.lastOperationError);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
  }, []);

  useEffect(() => {
    const isSwitching = Boolean(data?.switching);
    if (isSwitching) {
      wasSwitchingRef.current = true;
    }
    if (!isSwitching) {
      return;
    }

    let cancelled = false;
    let pollFailures = 0;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const latest = await gatewayApi.getVersions(false);
          if (cancelled) return;
          pollFailures = 0;
          setData(latest);

          if (!latest.switching) {
            setSwitchingVer(null);
            if (latest.lastOperationError) {
              setError(latest.lastOperationError);
            } else if (wasSwitchingRef.current) {
              wasSwitchingRef.current = false;
              await props.onVersionChanged();
            }
          }
        } catch {
          pollFailures += 1;
          if (pollFailures >= 8 && !cancelled) {
            setSwitchingVer(null);
          }
        }
      })();
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [data?.switching]);

  const handleChannelChange = async (channel: "stable" | "nightly") => {
    await gatewayApi.updateGatewaySettings({ releaseChannel: channel, revokeAllSessions: false });
    await load(true);
  };

  const handleInstallSwitch = async (version: string) => {
    setSwitchingVer(version);
    setError(null);
    wasSwitchingRef.current = true;
    try {
      const next = await gatewayApi.installVersion({
        version,
        createSnapshotBeforeSwitch: autoSnapshot,
        async: true,
      });
      setData(next);
      if (!next.switching) {
        setSwitchingVer(null);
        if (next.lastOperationError) {
          setError(next.lastOperationError);
        } else {
          await props.onVersionChanged();
        }
      }
    } catch (err) {
      setSwitchingVer(null);
      wasSwitchingRef.current = false;
      setError(err instanceof Error ? err.message : t.common.error);
    }
  };

  const handleRemove = async (version: string) => {
    setError(null);
    try {
      setData(await gatewayApi.deleteVersion(version));
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    }
  };

  const isBusy = Boolean(data?.switching) || switchingVer !== null;
  const prog = data?.switchProgress ?? null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{t.versions.title}</h2>
          <p className="text-xs text-[var(--muted-foreground)] mt-0.5">{t.versions.subtitle}</p>
        </div>

        <div className="flex items-center gap-2">
          <Select
            value={data?.channel ?? "stable"}
            disabled={isBusy}
            onChange={(e) => void handleChannelChange(e.target.value as "stable" | "nightly")}
          >
            <option value="stable">{t.versions.stable}</option>
            <option value="nightly">{t.versions.nightly}</option>
          </Select>
          <Button size="sm" onClick={() => void load(true)} disabled={loading || isBusy}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t.versions.checkUpdates}
          </Button>
        </div>
      </div>

      {error && !isBusy && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400 break-words">
          {error}
        </div>
      )}

      {isBusy && (
        <section className="t3-card p-4 space-y-2.5 border border-blue-500/30 bg-blue-500/5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />
              <span className="font-mono font-semibold">
                {prog?.targetVersion ?? switchingVer}
              </span>
              <span className="text-[var(--muted-foreground)]">
                {prog ? t.versions.progressPhases[prog.phase] : t.versions.switchingBtn}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] font-mono text-[var(--muted-foreground)]">
              {prog && prog.attempt > 1 && (
                <Badge tone="warning">
                  {t.versions.resumeBadge}
                  {prog.attempt}
                </Badge>
              )}
              {prog?.phase === "downloading" && prog.downloadedMb != null && (
                <span>
                  {prog.downloadedMb.toFixed(1)}
                  {prog.totalMb != null ? ` / ${prog.totalMb.toFixed(1)} MB` : " MB"}
                  {prog.percent != null ? ` (${prog.percent}%)` : ""}
                </span>
              )}
            </div>
          </div>

          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
            {prog?.percent != null ? (
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${Math.max(3, prog.percent)}%` }}
              />
            ) : (
              <div className="h-full w-1/3 rounded-full bg-blue-500 animate-pulse" />
            )}
          </div>
        </section>
      )}

      <section className="t3-card p-4 flex items-center justify-between gap-4">
        <span className="text-xs font-medium">{t.versions.autoSnapshotLabel}</span>
        <Switch checked={autoSnapshot} onChange={setAutoSnapshot} />
      </section>

      <section className="t3-card p-5 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {t.versions.installedSection}
        </h3>
        {!data || data.installedVersions.length === 0 ? (
          <div className="text-xs text-[var(--muted-foreground)] py-2">{t.versions.noInstalled}</div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {data.installedVersions.map((item) => (
              <div key={item.version} className="py-2.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="text-xs font-mono font-semibold">{item.version}</span>
                  <span className="text-[11px] text-[var(--muted-foreground)] font-mono">
                    {item.sizeMb} MB
                  </span>
                  {item.active && <Badge tone="success">{t.common.active}</Badge>}
                </div>
                <div className="flex items-center gap-1.5">
                  {!item.active && (
                    <>
                      <Button
                        size="sm"
                        disabled={isBusy}
                        onClick={() => void handleInstallSwitch(item.version)}
                      >
                        <RotateCcw className="h-3 w-3" />
                        {(prog?.targetVersion ?? switchingVer) === item.version && isBusy
                          ? t.versions.switchingBtn
                          : t.versions.switchBtn}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={isBusy}
                        onClick={() => void handleRemove(item.version)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="t3-card p-5 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {t.versions.remoteSection}
        </h3>
        <div className="divide-y divide-[var(--border)]">
          {(data?.remoteReleases ?? []).map((rel) => (
            <div key={rel.tagName} className="py-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-semibold">{rel.version}</span>
                  <Badge tone={rel.channel === "stable" ? "info" : "warning"}>
                    {rel.channel}
                  </Badge>
                  {rel.assetSizeMb != null && (
                    <span className="text-[11px] font-mono text-[var(--muted-foreground)]">
                      {rel.assetSizeMb} MB
                    </span>
                  )}
                  {rel.active && <Badge tone="success">{t.common.active}</Badge>}
                </div>

                {!rel.active && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={isBusy}
                    onClick={() => void handleInstallSwitch(rel.version)}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {(prog?.targetVersion ?? switchingVer) === rel.version && isBusy
                      ? t.versions.switchingBtn
                      : rel.installed
                        ? t.versions.switchBtn
                        : t.versions.installSwitchBtn}
                  </Button>
                )}
              </div>
              {rel.notesSummary && (
                <p className="text-[11px] text-[var(--muted-foreground)] line-clamp-3 whitespace-pre-line">
                  {rel.notesSummary}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
