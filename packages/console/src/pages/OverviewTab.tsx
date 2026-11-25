import { useEffect, useRef, useState } from "react";
import { Play, RotateCw, Square, Stethoscope, Trash2 } from "lucide-react";
import { GATEWAY_API_PREFIX, type SupervisorStatus } from "@t3-docker/shared";
import { useUiPreferences } from "../i18n/context";
import { gatewayApi } from "../lib/api";
import { Badge, Button, StatusDot } from "../components/ui";

interface LogLine {
  readonly id: number;
  readonly timestamp: string;
  readonly stream: string;
  readonly line: string;
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function OverviewTab(props: {
  readonly status: SupervisorStatus | null;
  readonly onRefreshStatus: () => Promise<void>;
}) {
  const { t } = useUiPreferences();
  const [busy, setBusy] = useState<string | null>(null);
  const [doctorOutput, setDoctorOutput] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const es = new EventSource(`${GATEWAY_API_PREFIX}/supervisor/logs?stream=1`, {
      withCredentials: true,
    });
    es.onmessage = (ev) => {
      try {
        const entry = JSON.parse(ev.data) as LogLine;
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 400 ? next.slice(next.length - 400) : next;
        });
      } catch {
        // Ignore
      }
    };
    return () => {
      es.close();
    };
  }, []);

  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  const runAction = async (action: "start" | "stop" | "restart" | "doctor") => {
    setBusy(action);
    try {
      const res = await gatewayApi.supervisorAction(action);
      if (action === "doctor" && res.output) {
        setDoctorOutput(res.output);
      }
      await props.onRefreshStatus();
    } finally {
      setBusy(null);
    }
  };

  const st = props.status;
  const tone =
    st?.state === "healthy"
      ? "green"
      : st?.state === "starting" || st?.state === "restarting" || st?.state === "updating"
        ? "amber"
        : st?.state === "degraded"
          ? "red"
          : "gray";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{t.overview.title}</h2>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">{t.overview.subtitle}</p>
      </div>

      <section className="t3-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <StatusDot tone={tone} />
            <span className="text-sm font-medium">{t.overview.engineCard}</span>
            {st && (
              <Badge tone={st.state === "healthy" ? "success" : st.state === "degraded" ? "error" : "neutral"}>
                {t.overview.states[st.state]}
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null || st?.state === "healthy"}
              onClick={() => void runAction("start")}
            >
              <Play className="h-3.5 w-3.5" />
              {t.overview.startBtn}
            </Button>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void runAction("restart")}
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t.overview.restartBtn}
            </Button>
            <Button
              size="sm"
              disabled={busy !== null || st?.state === "stopped"}
              onClick={() => void runAction("stop")}
            >
              <Square className="h-3.5 w-3.5" />
              {t.overview.stopBtn}
            </Button>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void runAction("doctor")}
            >
              <Stethoscope className="h-3.5 w-3.5" />
              {t.overview.doctorBtn}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-1">
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.overview.version}</div>
            <div className="text-xs font-mono font-semibold mt-1">
              {st?.activeVersion ?? "—"}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.overview.pid}</div>
            <div className="text-xs font-mono font-semibold mt-1">{st?.pid ?? "—"}</div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.overview.uptime}</div>
            <div className="text-xs font-mono font-semibold mt-1">
              {st ? formatDuration(st.uptimeSeconds) : "—"}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.overview.memory}</div>
            <div className="text-xs font-mono font-semibold mt-1">
              {st ? `${st.system.memoryRssMb} MB` : "—"}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">{t.overview.freeDisk}</div>
            <div className="text-xs font-mono font-semibold mt-1">
              {st?.system.freeDiskMb != null ? `${st.system.freeDiskMb} MB` : "—"}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] p-3">
            <div className="text-[11px] text-[var(--muted-foreground)]">
              {t.overview.headlessBrowser}
            </div>
            <div className="text-xs font-medium mt-1">
              {st?.system.headlessBrowserInstalled ? t.overview.ready : t.overview.onFirstUse}
            </div>
          </div>
        </div>

        {doctorOutput && (
          <pre className="rounded-lg bg-[var(--code-bg)] border border-[var(--border)] p-3 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap">
            {doctorOutput}
          </pre>
        )}
      </section>

      <section className="t3-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            {t.overview.logsTitle}
          </h3>
          <Button size="sm" variant="ghost" onClick={() => setLogs([])}>
            <Trash2 className="h-3.5 w-3.5" />
            {t.overview.clearLogs}
          </Button>
        </div>

        <div
          ref={logBoxRef}
          className="h-72 overflow-y-auto rounded-lg bg-[var(--code-bg)] border border-[var(--border)] p-3 font-mono text-[11px] leading-relaxed space-y-0.5"
        >
          {logs.length === 0 ? (
            <div className="text-[var(--muted-foreground)]">Waiting for server logs…</div>
          ) : (
            logs.map((item) => (
              <div key={item.id} className="break-all">
                <span className="text-[var(--muted-foreground)] mr-2">
                  {item.timestamp.slice(11, 19)}
                </span>
                <span
                  className={
                    item.stream === "stderr"
                      ? "text-amber-400"
                      : item.stream === "system"
                        ? "text-blue-400"
                        : "text-[var(--foreground)]"
                  }
                >
                  {item.line}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
