import { useEffect, useState } from "react";
import { MonitorPlay } from "lucide-react";
import { useUiPreferences } from "../i18n/context";
import { gatewayApi } from "../lib/api";
import { Button } from "../components/ui";

export function VncWakeView(props: {
  readonly vncPath: string;
  readonly adminPath: string;
}) {
  const { t } = useUiPreferences();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const status = await gatewayApi.getDesktopStatus();
        if (!active) return;
        if (status.state === "running") {
          const clean = props.vncPath.replace(/^\//, "");
          window.location.replace(
            `${props.vncPath}/vnc.html?autoconnect=true&resize=scale&path=${encodeURIComponent(`${clean}/websockify`)}`,
          );
          return;
        }
        if (status.state === "degraded" && status.lastError) {
          setError(status.lastError);
          return;
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Failed to wake desktop");
      }
      if (active) {
        setTimeout(() => void poll(), 900);
      }
    };
    void poll();
    return () => {
      active = false;
    };
  }, [props.vncPath]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--background)] text-[var(--foreground)]">
      <div className="t3-card max-w-md w-full p-6 text-center space-y-4">
        <div className="mx-auto h-10 w-10 rounded-xl bg-blue-500/15 text-blue-400 flex items-center justify-center">
          <MonitorPlay className="h-5 w-5 animate-pulse" />
        </div>
        <h1 className="text-base font-semibold">{t.vncWake.title}</h1>
        <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
          {t.vncWake.description}
        </p>
        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-400 font-mono">
            {error}
          </div>
        )}
        <div className="pt-2">
          <Button onClick={() => window.location.assign(props.adminPath)}>
            {t.vncWake.backAdmin}
          </Button>
        </div>
      </div>
    </div>
  );
}
