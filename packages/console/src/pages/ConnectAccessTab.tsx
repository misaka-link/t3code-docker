import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  LogOut,
  RefreshCw,
  Repeat,
  Trash2,
} from "lucide-react";
import type {
  ClientSyncState,
  ConnectStatus,
  GatewayPersistedConfig,
  SupportedLocale,
} from "@t3-docker/shared";
import { useUiPreferences } from "../i18n/context";
import { gatewayApi } from "../lib/api";
import { applySyncStateToBrowser, collectBrowserSyncPayload } from "../lib/client-sync";
import { Badge, Button, Input, Select, Switch } from "../components/ui";

interface SyncFeedbackBanner {
  readonly direction: "pull" | "push";
  readonly tone: "success" | "warning" | "error";
  readonly title: string;
  readonly detail?: string;
}

function formatSyncCounts(
  template: string,
  counts: { settings: number; extras: number; envs: number },
): string {
  return template
    .replace("{settings}", String(counts.settings))
    .replace("{extras}", String(counts.extras))
    .replace("{envs}", String(counts.envs));
}

export function ConnectAccessTab(props: {
  readonly onRoutesChanged: (adminPath: string, vncPath: string) => void;
}) {
  const { t, locale, setLocale } = useUiPreferences();
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  const [togglingConnect, setTogglingConnect] = useState(false);
  const [syncState, setSyncState] = useState<ClientSyncState | null>(null);
  const [syncBusy, setSyncBusy] = useState<"pull" | "push" | null>(null);
  const [justSynced, setJustSynced] = useState<"pull" | "push" | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<SyncFeedbackBanner | null>(null);
  const syncFeedbackRef = useRef<HTMLDivElement | null>(null);
  const syncNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncBadgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; label?: string; expiresAt?: string }>>([]);
  const [pairingLink, setPairingLink] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const [environmentLabel, setEnvironmentLabel] = useState("");
  const [defaultLocale, setDefaultLocale] = useState<SupportedLocale>(locale);
  const [adminPath, setAdminPath] = useState("/admin");
  const [vncPath, setVncPath] = useState("/vnc");
  const [publicUrl, setPublicUrl] = useState("");
  const [trustProxy, setTrustProxy] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [revokeAll, setRevokeAll] = useState(true);

  const loadAll = async () => {
    try {
      const [c, acc, sync] = await Promise.all([
        gatewayApi.getConnectStatus(),
        gatewayApi.getAccessSessions(),
        gatewayApi.getSyncState(),
      ]);
      setConnect(c);
      setSessions(acc.sessions);
      setSyncState(sync);
      applySettingsForm(acc.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    }
  };

  const applySettingsForm = (cfg: GatewayPersistedConfig) => {
    setEnvironmentLabel(cfg.workerEnv.environmentLabel ?? "");
    setDefaultLocale(cfg.locale);
    setAdminPath(cfg.adminPath);
    setVncPath(cfg.vncPath);
    setPublicUrl(cfg.publicUrl);
    setTrustProxy(cfg.trustProxy);
  };

  useEffect(() => {
    setDefaultLocale(locale);
  }, [locale]);

  useEffect(() => {
    void loadAll();
    return () => {
      if (syncNoticeTimerRef.current) clearTimeout(syncNoticeTimerRef.current);
      if (syncBadgeTimerRef.current) clearTimeout(syncBadgeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (connect?.state !== "authorizing") return undefined;
    const timer = setInterval(() => {
      void gatewayApi
        .getConnectStatus()
        .then((next) => {
          setConnect(next);
          if (next.deviceAuth?.error && next.state !== "authorizing") {
            setError(next.deviceAuth.error);
          }
        })
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [connect?.state]);

  const copyText = async (key: string, val: string) => {
    await navigator.clipboard.writeText(val);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const handleToggleConnect = async (enabled: boolean) => {
    setError(null);
    setTogglingConnect(true);
    try {
      const next = await gatewayApi.toggleConnect(enabled, true);
      setConnect(next);
      if (next.deviceAuth?.error && next.state === "off") {
        setError(next.deviceAuth.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setTogglingConnect(false);
    }
  };

  const handleToggleAutoSync = async (autoSyncOnLogin: boolean) => {
    setError(null);
    try {
      const next = await gatewayApi.pushSyncState({ autoSyncOnLogin });
      setSyncState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    }
  };

  const showSyncFeedback = (banner: SyncFeedbackBanner, doneDirection?: "pull" | "push") => {
    if (syncNoticeTimerRef.current) {
      clearTimeout(syncNoticeTimerRef.current);
      syncNoticeTimerRef.current = null;
    }
    if (syncBadgeTimerRef.current) {
      clearTimeout(syncBadgeTimerRef.current);
      syncBadgeTimerRef.current = null;
    }

    setSyncFeedback(banner);
    if (doneDirection) {
      setJustSynced(doneDirection);
      syncBadgeTimerRef.current = setTimeout(() => {
        setJustSynced(null);
        syncBadgeTimerRef.current = null;
      }, 3_500);
    } else {
      setJustSynced(null);
    }

    if (banner.tone !== "error") {
      syncNoticeTimerRef.current = setTimeout(() => {
        setSyncFeedback(null);
        syncNoticeTimerRef.current = null;
      }, 10_000);
    }

    requestAnimationFrame(() => {
      syncFeedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  };

  const handlePullFromDesktop = async () => {
    setError(null);
    if (syncNoticeTimerRef.current) {
      clearTimeout(syncNoticeTimerRef.current);
      syncNoticeTimerRef.current = null;
    }
    setSyncFeedback(null);
    setJustSynced(null);
    setSyncBusy("pull");
    const minSpin = new Promise<void>((r) => setTimeout(r, 220));
    try {
      const [latest] = await Promise.all([gatewayApi.getSyncState(), minSpin]);
      setSyncState(latest);
      const applied = await applySyncStateToBrowser(latest);
      const totalApplied =
        applied.settingsCount + applied.webExtrasCount + applied.environmentsCount;

      if (totalApplied === 0 && !applied.idbWarning) {
        showSyncFeedback({
          direction: "pull",
          tone: "warning",
          title: t.connect.syncPulledEmptyNotice,
        });
      } else {
        const detail = formatSyncCounts(t.connect.syncPulledDetail, {
          settings: applied.settingsCount,
          extras: applied.webExtrasCount,
          envs: applied.environmentsCount,
        });
        showSyncFeedback(
          {
            direction: "pull",
            tone: applied.idbWarning ? "warning" : "success",
            title: t.connect.syncPulledNotice,
            detail: applied.idbWarning ? `${detail} (${applied.idbWarning})` : detail,
          },
          "pull",
        );
      }
    } catch (err) {
      showSyncFeedback({
        direction: "pull",
        tone: "error",
        title: err instanceof Error ? err.message : t.common.error,
      });
    } finally {
      setSyncBusy(null);
    }
  };

  const handlePushToDesktop = async () => {
    setError(null);
    if (syncNoticeTimerRef.current) {
      clearTimeout(syncNoticeTimerRef.current);
      syncNoticeTimerRef.current = null;
    }
    setSyncFeedback(null);
    setJustSynced(null);
    setSyncBusy("push");
    const minSpin = new Promise<void>((r) => setTimeout(r, 220));
    try {
      const payload = await collectBrowserSyncPayload(syncState?.localEnvironmentId ?? null);
      const [updated] = await Promise.all([gatewayApi.pushSyncState(payload), minSpin]);
      setSyncState(updated);
      showSyncFeedback(
        {
          direction: "push",
          tone: "success",
          title: formatSyncCounts(t.connect.syncPushedNotice, {
            settings: Object.keys(payload.clientSettings ?? {}).length,
            extras: Object.keys(payload.webExtras ?? {}).length,
            envs: (payload.portableEnvironments ?? []).length,
          }),
        },
        "push",
      );
    } catch (err) {
      showSyncFeedback({
        direction: "push",
        tone: "error",
        title: err instanceof Error ? err.message : t.common.error,
      });
    } finally {
      setSyncBusy(null);
    }
  };

  const handleMintPairing = async (regenerate: boolean) => {
    setError(null);
    try {
      const res = await gatewayApi.createPairingLink(regenerate);
      setPairingLink(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    }
  };

  const handleSaveGatewaySettings = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSavingSettings(true);
    try {
      const prevAdmin = window.location.pathname;
      const res = await gatewayApi.updateGatewaySettings({
        environmentLabel,
        locale: defaultLocale,
        adminPath,
        vncPath,
        publicUrl,
        trustProxy,
        ...(newPassword ? { newPassword } : {}),
        revokeAllSessions: Boolean(newPassword && revokeAll),
      });
      setLocale(res.config.locale);
      setNewPassword("");
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2000);
      props.onRoutesChanged(res.config.adminPath, res.config.vncPath);
      if (res.config.adminPath !== prevAdmin && prevAdmin.startsWith("/")) {
        window.history.replaceState(null, "", res.config.adminPath);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setSavingSettings(false);
    }
  };

  const isConnectSwitchOn =
    connect?.state === "on" || connect?.state === "pending" || connect?.state === "authorizing";

  const connectBadge =
    connect?.state === "on"
      ? { tone: "success" as const, text: t.connect.stateOn }
      : connect?.state === "authorizing"
        ? { tone: "warning" as const, text: t.connect.stateAuthorizing }
        : connect?.state === "pending"
          ? { tone: "info" as const, text: t.connect.statePending }
          : connect?.state === "signin"
            ? { tone: "warning" as const, text: t.connect.stateSignin }
            : { tone: "neutral" as const, text: t.connect.stateOff };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{t.connect.title}</h2>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">{t.connect.subtitle}</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400 break-words">
          {error}
        </div>
      )}

      {/* 1. T3 Connect Control Card */}
      <section className="t3-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">{t.connect.t3ConnectTitle}</h3>
              <Badge tone={connectBadge.tone}>{connectBadge.text}</Badge>
            </div>
            <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
              {t.connect.t3ConnectDesc}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {togglingConnect && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--muted-foreground)]" />
            )}
            <Switch
              checked={isConnectSwitchOn}
              disabled={togglingConnect}
              onChange={(next) => void handleToggleConnect(next)}
            />
          </div>
        </div>

        {(connect?.state === "authorizing" || togglingConnect) && !connect?.deviceAuth?.userCode && (
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3.5 flex items-center gap-2.5 text-xs text-blue-300">
            <Loader2 className="h-4 w-4 animate-spin shrink-0 text-blue-400" />
            <span>{t.connect.preparingRelayClient}</span>
          </div>
        )}

        {connect?.deviceAuth?.userCode && (
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-4 space-y-3">
            <div className="text-xs font-medium">{t.connect.deviceCodePrompt}</div>
            <div className="flex flex-wrap items-center gap-3">
              <code className="px-3 py-1.5 rounded-md bg-[var(--code-bg)] border border-[var(--border)] font-mono text-sm font-bold tracking-widest">
                {connect.deviceAuth.userCode}
              </code>
              <Button
                size="sm"
                onClick={() => void copyText("code", connect.deviceAuth!.userCode!)}
              >
                {copiedKey === "code" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedKey === "code" ? t.common.copied : t.common.copy}
              </Button>
              {connect.deviceAuth.verificationUrl && (
                <a
                  href={connect.deviceAuth.verificationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 h-7 px-3 rounded-[var(--control-radius)] bg-[var(--primary)] text-[var(--primary-foreground)] text-xs font-medium"
                >
                  <span>{t.connect.openAuthUrl}</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>
        )}

        <div className="rounded-lg border border-[var(--border)] bg-[var(--muted)]/40 p-3 space-y-2">
          <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed">
            {t.connect.webMultiEnvHint}
          </p>
          <div>
            <a
              href="https://app.t3.codes"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--primary)] hover:underline"
            >
              <span>{t.connect.openHostedWebBtn}</span>
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>

        {connect?.linked && (
          <div className="space-y-3 pt-2 border-t border-[var(--border)]">
            <div className="flex items-center justify-between gap-4">
              <span className="text-xs">{t.connect.publishActivity}</span>
              <Switch
                checked={connect.publishAgentActivity}
                onChange={(val) =>
                  void gatewayApi.updateConnectPreferences({ publishAgentActivity: val }).then(setConnect)
                }
              />
            </div>
            {connect.holdWebhooksWhileOffline !== null && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs">{t.connect.holdWebhooks}</span>
                <Switch
                  checked={Boolean(connect.holdWebhooksWhileOffline)}
                  onChange={(val) =>
                    void gatewayApi
                      .updateConnectPreferences({ holdWebhooksWhileOffline: val })
                      .then(setConnect)
                  }
                />
              </div>
            )}
          </div>
        )}

        {connect && connect.devices.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-[var(--border)]">
            <div className="text-xs font-medium">{t.connect.pendingDevicesTitle}</div>
            {connect.devices.map((dev) => (
              <div key={dev.id} className="flex items-center justify-between py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">{dev.code ?? dev.label}</span>
                  <Badge tone={dev.status === "pending" ? "warning" : "success"}>{dev.status}</Badge>
                </div>
                <div className="flex items-center gap-1.5">
                  {dev.status === "pending" && dev.code && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => void gatewayApi.manageConnectDevice(dev.code!, "approve").then(setConnect)}
                    >
                      {t.connect.approveBtn}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      void gatewayApi.manageConnectDevice(dev.code ?? dev.id, "revoke").then(setConnect)
                    }
                  >
                    {t.connect.revokeBtn}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {connect?.authenticated && (
          <div className="pt-2 border-t border-[var(--border)]">
            <Button
              size="sm"
              variant="danger"
              onClick={() => void gatewayApi.logoutConnect().then(setConnect)}
            >
              <LogOut className="h-3.5 w-3.5" />
              {t.connect.logoutConnectBtn}
            </Button>
          </div>
        )}
      </section>

      {/* 2. Desktop <-> Web Client Config & Direct-Environment Synchronizer */}
      <section className="t3-card p-5 space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Repeat className="h-4 w-4 text-[var(--accent)]" />
            <h3 className="text-sm font-semibold">{t.connect.syncSectionTitle}</h3>
          </div>
          <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
            {t.connect.syncSectionDesc}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--muted)]/30 p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">
              {t.connect.syncStatsSettings}
            </div>
            <div className="text-sm font-mono font-semibold mt-0.5">
              {syncState
                ? Object.keys(syncState.clientSettings).length +
                  Object.keys(syncState.webExtras).length
                : 0}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--muted)]/30 p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">
              {t.connect.syncStatsEnvs}
            </div>
            <div className="text-sm font-mono font-semibold mt-0.5">
              {syncState ? syncState.portableEnvironments.length : 0}
            </div>
          </div>
        </div>

        {syncState && syncState.portableEnvironments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {syncState.portableEnvironments.map((env) => (
              <Badge key={env.connectionId} tone="success">
                {env.label} ({env.httpBaseUrl})
              </Badge>
            ))}
          </div>
        )}

        {syncState && syncState.relayTargets.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-1.5 text-xs">
            <div className="font-medium text-amber-400">
              {t.connect.syncRelayOnlyTitle}{" "}
              <span className="font-mono">
                {syncState.relayTargets.map((r) => r.label).join(", ")}
              </span>
            </div>
            <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed">
              {t.connect.syncRelayOnlyHint}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between gap-4 pt-1">
          <span className="text-xs">{t.connect.syncAutoLabel}</span>
          <Switch
            checked={syncState?.autoSyncOnLogin ?? true}
            onChange={(val) => void handleToggleAutoSync(val)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          <Button
            size="sm"
            variant="primary"
            disabled={syncBusy !== null}
            onClick={() => void handlePullFromDesktop()}
          >
            {syncBusy === "pull" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : justSynced === "pull" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <ArrowDownToLine className="h-3.5 w-3.5" />
            )}
            <span>
              {justSynced === "pull" ? t.connect.syncPullDoneBtn : t.connect.syncPullBtn}
            </span>
          </Button>
          <Button
            size="sm"
            disabled={syncBusy !== null}
            onClick={() => void handlePushToDesktop()}
          >
            {syncBusy === "push" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : justSynced === "push" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <ArrowUpFromLine className="h-3.5 w-3.5" />
            )}
            <span>
              {justSynced === "push" ? t.connect.syncPushDoneBtn : t.connect.syncPushBtn}
            </span>
          </Button>
        </div>

        {syncFeedback && (
          <div
            ref={syncFeedbackRef}
            role="status"
            className={`rounded-lg border px-3.5 py-2.5 text-xs space-y-1.5 ${
              syncFeedback.tone === "success"
                ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
                : syncFeedback.tone === "warning"
                  ? "border-amber-500/35 bg-amber-500/10 text-amber-300"
                  : "border-red-500/35 bg-red-500/10 text-red-400"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium">
                {syncFeedback.tone === "success" ? (
                  <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0" />
                )}
                <span>{syncFeedback.title}</span>
              </div>
              {syncFeedback.direction === "pull" && syncFeedback.tone !== "error" && (
                <a
                  href="/"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[var(--control-radius)] bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 font-medium transition-colors"
                >
                  <span>{t.connect.syncOpenWorkspaceBtn}</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            {syncFeedback.detail && (
              <p className="text-[11px] text-[var(--muted-foreground)] pl-6 leading-relaxed">
                {syncFeedback.detail}
              </p>
            )}
          </div>
        )}
      </section>

      {/* 3. Idempotent Direct Pairing & Sessions */}
      <section className="t3-card p-5 space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t.connect.qrSectionTitle}</h3>
          <p className="text-xs text-[var(--muted-foreground)]">{t.connect.qrSectionDesc}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => void handleMintPairing(false)}>
            <Link2 className="h-3.5 w-3.5" />
            {t.connect.getPairingBtn}
          </Button>
          {pairingLink && (
            <Button size="sm" onClick={() => void handleMintPairing(true)}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t.connect.regeneratePairingBtn}
            </Button>
          )}
        </div>

        {pairingLink && (
          <div className="flex items-center gap-2 rounded-lg bg-[var(--code-bg)] border border-[var(--border)] p-2.5">
            <code className="flex-1 text-[11px] font-mono break-all">{pairingLink}</code>
            <Button size="sm" onClick={() => void copyText("pair", pairingLink)}>
              {copiedKey === "pair" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
        )}

        <div className="space-y-2 pt-2 border-t border-[var(--border)]">
          <div className="text-xs font-medium">{t.connect.activeSessionsTitle}</div>
          {sessions.length === 0 ? (
            <div className="text-xs text-[var(--muted-foreground)]">{t.connect.noSessions}</div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {sessions.map((s) => (
                <div key={s.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                  <div>
                    <span className="font-medium">{s.label || s.id.slice(0, 12)}</span>
                    <span className="ml-2 font-mono text-[11px] text-[var(--muted-foreground)]">
                      {s.id.slice(0, 10)}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      void gatewayApi.revokeSession(s.id).then(() => loadAll())
                    }
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 4. Gateway Dynamic Paths & Password */}
      <form onSubmit={handleSaveGatewaySettings} className="t3-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-[var(--muted-foreground)]" />
          <h3 className="text-sm font-semibold">{t.connect.gatewaySettingsTitle}</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium">{t.connect.envLabelTitle}</label>
            <Input
              value={environmentLabel}
              onChange={(e) => setEnvironmentLabel(e.target.value)}
              placeholder={t.connect.envLabelPlaceholder}
              maxLength={80}
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium">{t.connect.defaultLocaleLabel}</label>
            <Select
              className="w-full"
              value={defaultLocale}
              onChange={(e) => setDefaultLocale(e.target.value as SupportedLocale)}
            >
              <option value="zh-CN">简体中文 (zh-CN)</option>
              <option value="en-US">English (en-US)</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium">{t.connect.adminPathLabel}</label>
            <Input value={adminPath} onChange={(e) => setAdminPath(e.target.value)} className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium">{t.connect.vncPathLabel}</label>
            <Input value={vncPath} onChange={(e) => setVncPath(e.target.value)} className="font-mono" />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <label className="block text-xs font-medium">{t.connect.publicUrlLabel}</label>
            <Input
              value={publicUrl}
              onChange={(e) => setPublicUrl(e.target.value)}
              placeholder="https://t3.example.com"
              className="font-mono"
            />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <label className="block text-xs font-medium">{t.connect.newPasswordLabel}</label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 pt-1">
          <span className="text-xs">{t.connect.trustProxyLabel}</span>
          <Switch checked={trustProxy} onChange={setTrustProxy} />
        </div>

        {newPassword.length > 0 && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs">{t.connect.revokeAllOnPwdChange}</span>
            <Switch checked={revokeAll} onChange={setRevokeAll} />
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button type="submit" variant="primary" disabled={savingSettings}>
            {savingSettings ? t.common.saving : t.common.save}
          </Button>
          {savedNotice && <span className="text-xs text-emerald-500">{t.common.saved}</span>}
        </div>
      </form>
    </div>
  );
}
