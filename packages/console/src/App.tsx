import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Archive,
  ArrowLeft,
  Cpu,
  Layers,
  LogOut,
  Monitor,
  Shield,
  Terminal,
} from "lucide-react";
import type { BootstrapResponse, SupervisorStatus } from "@t3-docker/shared";
import { UiPreferencesProvider, useUiPreferences } from "./i18n/context";
import { gatewayApi } from "./lib/api";
import { Badge, Button, StatusDot, TopLocaleThemeControls } from "./components/ui";
import { SetupView } from "./pages/SetupView";
import { LoginView } from "./pages/LoginView";
import { VncWakeView } from "./pages/VncWakeView";
import { OverviewTab } from "./pages/OverviewTab";
import { VersionsTab } from "./pages/VersionsTab";
import { ConnectAccessTab } from "./pages/ConnectAccessTab";
import { DesktopTab } from "./pages/DesktopTab";
import { ProvidersTab } from "./pages/ProvidersTab";
import { SnapshotsTab } from "./pages/SnapshotsTab";

type TabId = "overview" | "versions" | "connect" | "desktop" | "providers" | "snapshots";

function ConsoleShell(props: {
  readonly bootstrap: BootstrapResponse;
  readonly onRefreshBootstrap: () => Promise<void>;
}) {
  const { t } = useUiPreferences();
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [supervisor, setSupervisor] = useState<SupervisorStatus | null>(null);
  const [routes, setRoutes] = useState(props.bootstrap.routes);

  const refreshSupervisor = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      setSupervisor(await gatewayApi.getSupervisorStatus());
    } catch {
      // Ignore
    }
  }, []);

  const handleRoutesChanged = useCallback((nextAdmin: string, nextVnc: string) => {
    setRoutes({ adminPath: nextAdmin, vncPath: nextVnc });
  }, []);

  useEffect(() => {
    if (!props.bootstrap.authenticated || props.bootstrap.setupRequired) return undefined;
    void refreshSupervisor();
    const timer = setInterval(() => void refreshSupervisor(), 5000);
    return () => clearInterval(timer);
  }, [props.bootstrap.authenticated, props.bootstrap.setupRequired, refreshSupervisor]);

  const handleAuthComplete = async () => {
    const params = new URLSearchParams(window.location.search);
    const nextUrl = params.get("next");
    if (nextUrl && nextUrl.startsWith("/") && !nextUrl.startsWith("//")) {
      window.location.replace(nextUrl);
      return;
    }
    await props.onRefreshBootstrap();
  };

  if (props.bootstrap.setupRequired) {
    return <SetupView onCompleted={handleAuthComplete} />;
  }

  if (!props.bootstrap.authenticated) {
    return <LoginView onLoggedIn={handleAuthComplete} />;
  }

  // If browser navigated directly to `vncPath` while desktop was hibernated, show waking transition
  if (
    props.bootstrap.capabilities.desktopSupported &&
    (window.location.pathname === routes.vncPath ||
      window.location.pathname.startsWith(`${routes.vncPath}/`))
  ) {
    return <VncWakeView vncPath={routes.vncPath} adminPath={routes.adminPath} />;
  }

  const navItems: Array<{ id: TabId; label: string; icon: typeof Activity; hidden?: boolean }> = [
    { id: "overview", label: t.nav.overview, icon: Activity },
    { id: "versions", label: t.nav.versions, icon: Layers },
    { id: "connect", label: t.nav.connect, icon: Shield },
    {
      id: "desktop",
      label: t.nav.desktop,
      icon: Monitor,
      hidden: !props.bootstrap.capabilities.desktopSupported,
    },
    { id: "providers", label: t.nav.providers, icon: Cpu },
    { id: "snapshots", label: t.nav.snapshots, icon: Archive },
  ];

  const persistPref = (patch: {
    locale?: "zh-CN" | "en-US";
    theme?: "dark" | "light" | "system";
  }) => {
    void gatewayApi
      .updateGatewaySettings({ ...patch, revokeAllSessions: false })
      .catch(() => undefined);
  };

  const handleLogout = async () => {
    await gatewayApi.logout();
    await props.onRefreshBootstrap();
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[var(--background)] text-[var(--foreground)]">
      {/* T3 Settings-styled Sidebar */}
      <aside
        data-slot="sidebar"
        className="w-full md:w-60 shrink-0 bg-[var(--sidebar)] border-b md:border-b-0 md:border-r border-[var(--sidebar-border)] flex flex-col"
      >
        <div className="h-[52px] px-3.5 flex items-center justify-between border-b border-[var(--sidebar-border)]">
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--sidebar-foreground)] hover:opacity-80"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>{t.brand.backToWorkspace}</span>
          </a>
          <Badge tone="neutral">v{props.bootstrap.suiteVersion}</Badge>
        </div>

        <nav className="p-2 flex md:flex-col gap-1 overflow-x-auto">
          {navItems
            .filter((item) => !item.hidden)
            .map((item) => {
              const Icon = item.icon;
              const selected = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-[var(--control-radius)] text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                    selected
                      ? "bg-[var(--sidebar-row-selected)] text-[var(--foreground)]"
                      : "text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-row-hover)] hover:text-[var(--sidebar-foreground)]"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
        </nav>

        <div className="hidden md:flex mt-auto p-3 border-t border-[var(--sidebar-border)] items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-[var(--sidebar-muted)]">
            <Terminal className="h-3.5 w-3.5" />
            <span className="font-mono">{props.bootstrap.variant}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void handleLogout()}>
            <LogOut className="h-3.5 w-3.5" />
            <span>{t.brand.logout}</span>
          </Button>
        </div>
      </aside>

      {/* Main Content Workspace */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-[52px] px-5 border-b border-[var(--border)] t3-surface-glass sticky top-0 z-20 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <StatusDot
              tone={
                supervisor?.state === "healthy"
                  ? "green"
                  : supervisor?.state === "degraded"
                    ? "red"
                    : "amber"
              }
            />
            <span className="text-xs font-medium">{t.brand.title}</span>
            {supervisor?.activeVersion && (
              <Badge tone="info">T3 {supervisor.activeVersion}</Badge>
            )}
          </div>

          <TopLocaleThemeControls onPersistPreference={persistPref} />
        </header>

        <main data-settings-page-scroll className="flex-1 p-5 md:p-7 max-w-4xl w-full mx-auto">
          {activeTab === "overview" && (
            <OverviewTab status={supervisor} onRefreshStatus={refreshSupervisor} />
          )}
          {activeTab === "versions" && (
            <VersionsTab onVersionChanged={refreshSupervisor} />
          )}
          {activeTab === "connect" && (
            <ConnectAccessTab onRoutesChanged={handleRoutesChanged} />
          )}
          {activeTab === "desktop" && props.bootstrap.capabilities.desktopSupported && (
            <DesktopTab vncPath={routes.vncPath} />
          )}
          {activeTab === "providers" && (
            <ProvidersTab desktopSupported={props.bootstrap.capabilities.desktopSupported} />
          )}
          {activeTab === "snapshots" && <SnapshotsTab />}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadBootstrap = useCallback(async () => {
    try {
      const data = await gatewayApi.getBootstrap();
      setBootstrap(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to reach gateway");
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-[#0a0a0c] text-zinc-200 text-xs font-mono">
        Gateway connection error: {loadError}
      </div>
    );
  }

  if (!bootstrap) {
    return <div className="min-h-screen bg-[#0a0a0c]" />;
  }

  return (
    <UiPreferencesProvider initialLocale={bootstrap.locale} initialTheme={bootstrap.theme}>
      <ConsoleShell bootstrap={bootstrap} onRefreshBootstrap={loadBootstrap} />
    </UiPreferencesProvider>
  );
}
