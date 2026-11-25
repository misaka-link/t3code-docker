import { useState, type FormEvent } from "react";
import { Lock, Terminal, ArrowRight } from "lucide-react";
import { useUiPreferences } from "../i18n/context";
import { gatewayApi } from "../lib/api";
import { Badge, Button, Input } from "../components/ui";

export function LoginView(props: { readonly onLoggedIn: () => Promise<void> }) {
  const { t } = useUiPreferences();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setError(null);
    setSubmitting(true);
    try {
      await gatewayApi.login(password);
      await props.onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)] text-[var(--foreground)]">
      <header className="h-[52px] px-5 flex items-center justify-between border-b border-[var(--border)]">
        <div className="flex items-center gap-2 text-xs font-semibold tracking-tight">
          <Terminal className="h-4 w-4 text-[var(--accent)]" />
          <span>T3 Code</span>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <form onSubmit={handleSubmit} className="t3-card w-full max-w-[390px] p-6 space-y-5">
          <div className="space-y-2">
            <Badge tone="neutral">
              <Lock className="h-3 w-3" />
              {t.login.badge}
            </Badge>
            <h1 className="text-lg font-semibold tracking-tight">{t.login.title}</h1>
            <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
              {t.login.description}
            </p>
          </div>

          <div className="space-y-2">
            <Input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t.login.passwordPlaceholder}
              className="h-9"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            className="w-full h-9"
            disabled={submitting || !password}
          >
            <span>{submitting ? t.common.loading : t.login.submitButton}</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </form>
      </main>
    </div>
  );
}
