import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Archive, Download, RotateCcw, Trash2, Upload } from "lucide-react";
import { GATEWAY_API_PREFIX, type SnapshotItem, type SnapshotScope } from "@t3-docker/shared";
import { useUiPreferences } from "../i18n/context";
import { gatewayApi } from "../lib/api";
import { Badge, Button, Input, Select } from "../components/ui";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function SnapshotsTab() {
  const { t } = useUiPreferences();
  const [items, setItems] = useState<SnapshotItem[]>([]);
  const [scope, setScope] = useState<SnapshotScope>("full");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = async () => {
    try {
      const res = await gatewayApi.getSnapshots();
      setItems(res.snapshots);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await gatewayApi.createSnapshot(scope, note);
      setNote("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setBusy(false);
    }
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await gatewayApi.importSnapshot(file);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleRestore = async (id: string, targetScope: SnapshotScope) => {
    if (!window.confirm(t.snapshots.confirmRestore)) return;
    setBusy(true);
    setError(null);
    try {
      await gatewayApi.restoreSnapshot(id, targetScope);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{t.snapshots.title}</h2>
          <p className="text-xs text-[var(--muted-foreground)] mt-0.5">{t.snapshots.subtitle}</p>
        </div>

        <div>
          <input
            ref={fileRef}
            type="file"
            accept=".tar.gz,.tgz"
            className="hidden"
            onChange={(e) => void handleImportFile(e)}
          />
          <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            {t.snapshots.importBtn}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
          {error}
        </div>
      )}

      <form onSubmit={handleCreate} className="t3-card p-5 space-y-3.5">
        <h3 className="text-sm font-semibold">{t.snapshots.createTitle}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select
            value={scope}
            onChange={(e) => setScope(e.target.value as SnapshotScope)}
          >
            <option value="full">{t.snapshots.scopeFull}</option>
            <option value="config">{t.snapshots.scopeConfig}</option>
          </Select>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t.snapshots.notePlaceholder}
          />
        </div>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          <Archive className="h-3.5 w-3.5" />
          {t.snapshots.createBtn}
        </Button>
      </form>

      <section className="t3-card p-5 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {t.snapshots.listTitle}
        </h3>
        {items.length === 0 ? (
          <div className="text-xs text-[var(--muted-foreground)] py-2">{t.snapshots.emptyList}</div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {items.map((item) => (
              <div key={item.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-semibold">{item.id}</span>
                    <Badge tone={item.scope === "full" ? "info" : "neutral"}>{item.scope}</Badge>
                    <span className="text-[11px] font-mono text-[var(--muted-foreground)]">
                      {formatBytes(item.sizeBytes)}
                    </span>
                  </div>
                  <div className="text-[11px] text-[var(--muted-foreground)]">
                    {new Date(item.createdAt).toLocaleString()} {item.note ? `· ${item.note}` : ""}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <a
                    href={`${GATEWAY_API_PREFIX}/snapshots/${encodeURIComponent(item.id)}/export`}
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded-[var(--control-radius)] bg-[var(--muted)] border border-[var(--border)] text-xs"
                  >
                    <Download className="h-3 w-3" />
                    {t.snapshots.exportBtn}
                  </a>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleRestore(item.id, "config")}
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t.snapshots.restoreConfigBtn}
                  </Button>
                  {item.scope === "full" && (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => void handleRestore(item.id, "full")}
                    >
                      {t.snapshots.restoreFullBtn}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      void gatewayApi.deleteSnapshot(item.id).then(() => load())
                    }
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
