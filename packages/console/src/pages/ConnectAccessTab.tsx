import { useEffect, useState, type FormEvent } from "react";
import { Check, Copy, ExternalLink, KeyRound, Link2, LogOut, RefreshCw, Trash2 } from "lucide-react";
import type { ConnectStatus, GatewayPersistedConfig, SupportedLocale } from "@t3-docker/shared";
import { useUiPreferences } from "../i18n/context";
import { gatewayApi } from "../lib/api";
import { Badge, Button, Input, Select, Switch } from "../components/ui";

export function ConnectAccessTab(props: {
  readonly onRoutesChanged: (adminPath: string, vncPath: string) => void;
}) {
  const { t, locale, setLocale } = useUiPreferences();
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; label?: string; expiresAt?: string }>>([]);
  const [pairingLink, setPairingLink] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const [defaultLocale, setDefaultLocale] = useState<SupportedLocale>(locale);
  const [adminPath, setAdminPath] = useState("/admin");
  const [vncPath, setVncPath] = useState("/vnc");
  const [publicUrl, setPublicUrl] = useState("");
  const [trustProxy, setTrustProxy] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [revokeAll, setRevokeAll] = useState(true);

  const loadAll = async () => {
    try {
      const [c, acc] = await Promise.all([
        gatewayApi.getConnectStatus(),
        gatewayApi.getAccessSessions(),
      ]);
      setConnect(c);
      setSessions(acc.sessions);
      applySettingsForm(acc.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    }
  };

  const applySettingsForm = (cfg: GatewayPersistedConfig) => {
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
  }, []);

  useEffect(() => {
    if (connect?.state !== "authorizing") return undefined;
    const timer = setInterval(() => {
      void gatewayApi.getConnectStatus().then(setConnect).catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [connect?.state]);

  const copyText = async (key: string, val: string) => {
    await navigator.clipboard.writeText(val);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const handleToggleConnect = async (enabled: boolean) => {
    setError(null);
    try {
      setConnect(await gatewayApi.toggleConnect(enabled, true));
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
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
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
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
          <Switch
            checked={isConnectSwitchOn}
            onChange={(next) => void handleToggleConnect(next)}
          />
        </div>

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

      {/* 2. Idempotent Direct Pairing & Sessions */}
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

      {/* 3. Gateway Dynamic Paths & Password */}
      <form onSubmit={handleSaveGatewaySettings} className="t3-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-[var(--muted-foreground)]" />
          <h3 className="text-sm font-semibold">{t.connect.gatewaySettingsTitle}</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div className="sm:col-span-2 space-y-1.5">
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
