import { useEffect, useState, type FormEvent } from "react";
import { Cpu, Download, RefreshCw, Trash2 } from "lucide-react";
import type { ProvidersOverview } from "@t3-docker/shared";
import { useUiPreferences } from "../i18n/context";
import { gatewayApi } from "../lib/api";
import { Badge, Button, Input, Switch } from "../components/ui";

export function ProvidersTab(props: { readonly desktopSupported: boolean }) {
  const { t } = useUiPreferences();
  const [data, setData] = useState<ProvidersOverview | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Outbound proxy form
  const [httpProxy, setHttpProxy] = useState("");
  const [httpsProxy, setHttpsProxy] = useState("");
  const [noProxy, setNoProxy] = useState("localhost,127.0.0.1,::1");

  const load = async () => {
    try {
      const res = await gatewayApi.getProviders();
      setData(res);
      setHttpProxy(res.workerEnv.httpProxy);
      setHttpsProxy(res.workerEnv.httpsProxy);
      setNoProxy(res.workerEnv.noProxy);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleMutate = async (
    kind: "agent" | "toolchain",
    id: string,
    action: "install" | "upgrade" | "uninstall",
  ) => {
    setBusyId(`${kind}:${id}`);
    setError(null);
    try {
      setData(await gatewayApi.mutatePackage({ kind, id, action }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveProxy = async (e: FormEvent) => {
    e.preventDefault();
    if (!data) return;
    setBusyId("proxy");
    setError(null);
    try {
      const res = await gatewayApi.updateWorkerEnv(
        {
          ...data.workerEnv,
          httpProxy,
          httpsProxy,
          noProxy,
        },
        true,
      );
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{t.providers.title}</h2>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">{t.providers.subtitle}</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* 1. Zero-Injection Dual-Track Browser MCP */}
      <section className="t3-card p-5 space-y-3.5">
        <h3 className="text-sm font-semibold">{t.providers.browserMcpTitle}</h3>
        {props.desktopSupported && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs text-[var(--muted-foreground)] leading-relaxed">
              {t.providers.desktopMcpLabel}
            </span>
            <Switch
              checked={Boolean(data?.desktopBrowserMcpEnabled)}
              onChange={(val) =>
                void gatewayApi
                  .syncBrowserMcp(val, Boolean(data?.headlessPlaywrightMcpEnabled))
                  .then(setData)
              }
            />
          </div>
        )}
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs text-[var(--muted-foreground)] leading-relaxed">
            {t.providers.headlessMcpLabel}
          </span>
          <Switch
            checked={Boolean(data?.headlessPlaywrightMcpEnabled)}
            onChange={(val) =>
              void gatewayApi
                .syncBrowserMcp(Boolean(data?.desktopBrowserMcpEnabled), val)
                .then(setData)
            }
          />
        </div>
      </section>

      {/* 2. Coding Agent CLIs */}
      <section className="t3-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-[var(--muted-foreground)]" />
          <h3 className="text-sm font-semibold">{t.providers.agentsTitle}</h3>
        </div>

        <div className="divide-y divide-[var(--border)]">
          {(data?.agents ?? []).map((agent) => (
            <div key={agent.id} className="py-2.5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold">{agent.name}</span>
                  <code className="text-[11px] font-mono text-[var(--muted-foreground)]">
                    {agent.binary}
                  </code>
                  <Badge tone={agent.installed ? "success" : "neutral"}>
                    {agent.installed ? agent.version ?? t.common.installed : t.common.notInstalled}
                  </Badge>
                </div>
                <div className="text-[11px] text-[var(--muted-foreground)] mt-0.5 font-mono">
                  {agent.installHint}
                </div>
              </div>

              {agent.npmPackage && (
                <div className="flex items-center gap-1.5">
                  {!agent.installed ? (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busyId !== null}
                      onClick={() => void handleMutate("agent", agent.id, "install")}
                    >
                      <Download className="h-3 w-3" />
                      {t.providers.installBtn}
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() => void handleMutate("agent", agent.id, "upgrade")}
                      >
                        <RefreshCw className="h-3 w-3" />
                        {t.providers.upgradeBtn}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busyId !== null}
                        onClick={() => void handleMutate("agent", agent.id, "uninstall")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 3. Mise Toolchains */}
      <section className="t3-card p-5 space-y-3">
        <h3 className="text-sm font-semibold">{t.providers.toolchainsTitle}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {(data?.toolchains ?? []).map((tool) => (
            <div
              key={tool.id}
              className="rounded-lg border border-[var(--border)] bg-[var(--muted)]/35 p-3 flex items-center justify-between gap-2"
            >
              <div>
                <div className="text-xs font-medium">{tool.name}</div>
                <div className="text-[11px] font-mono text-[var(--muted-foreground)]">
                  {tool.installed ? tool.version : t.common.notInstalled}
                </div>
              </div>
              {!tool.installed ? (
                <Button
                  size="sm"
                  disabled={busyId !== null}
                  onClick={() => void handleMutate("toolchain", tool.id, "install")}
                >
                  {t.providers.installBtn}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId !== null}
                  onClick={() => void handleMutate("toolchain", tool.id, "upgrade")}
                >
                  {t.providers.upgradeBtn}
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 4. Worker Outbound Proxy */}
      <form onSubmit={handleSaveProxy} className="t3-card p-5 space-y-3.5">
        <h3 className="text-sm font-semibold">{t.providers.proxySectionTitle}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="block text-[11px] font-mono text-[var(--muted-foreground)]">
              {t.providers.httpProxyLabel}
            </label>
            <Input
              value={httpProxy}
              onChange={(e) => setHttpProxy(e.target.value)}
              placeholder="http://host.docker.internal:7890"
              className="font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-[11px] font-mono text-[var(--muted-foreground)]">
              {t.providers.httpsProxyLabel}
            </label>
            <Input
              value={httpsProxy}
              onChange={(e) => setHttpsProxy(e.target.value)}
              placeholder="http://host.docker.internal:7890"
              className="font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-[11px] font-mono text-[var(--muted-foreground)]">
              {t.providers.noProxyLabel}
            </label>
            <Input
              value={noProxy}
              onChange={(e) => setNoProxy(e.target.value)}
              className="font-mono"
            />
          </div>
        </div>
        <Button type="submit" size="sm" variant="primary" disabled={busyId === "proxy"}>
          {busyId === "proxy" ? t.common.saving : t.common.save}
        </Button>
      </form>
    </div>
  );
}
