import { useState, type FormEvent } from "react";
import { ShieldCheck, Terminal } from "lucide-react";
import { useUiPreferences } from "../i18n/context";
import { gatewayApi } from "../lib/api";
import { Badge, Button, Input, Select, TopLocaleThemeControls } from "../components/ui";

export function SetupView(props: { readonly onCompleted: () => Promise<void> }) {
  const { t, locale, setLocale, theme } = useUiPreferences();
  const [environmentLabel, setEnvironmentLabel] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError(t.setup.tooShortError);
      return;
    }
    if (password !== confirm) {
      setError(t.setup.mismatchError);
      return;
    }
    setSubmitting(true);
    try {
      await gatewayApi.completeSetup({
        password,
        locale,
        theme,
        ...(environmentLabel.trim() ? { environmentLabel: environmentLabel.trim() } : {}),
      });
      await props.onCompleted();
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
        <TopLocaleThemeControls />
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <form onSubmit={handleSubmit} className="t3-card w-full max-w-[420px] p-6 space-y-5">
          <div className="space-y-2">
            <Badge tone="info">
              <ShieldCheck className="h-3 w-3" />
              {t.setup.badge}
            </Badge>
            <h1 className="text-lg font-semibold tracking-tight">{t.setup.title}</h1>
            <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
              {t.setup.description}
            </p>
          </div>

          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">{t.setup.languageLabel}</label>
              <Select
                className="w-full"
                value={locale}
                onChange={(e) => setLocale(e.target.value as "zh-CN" | "en-US")}
              >
                <option value="zh-CN">简体中文 (默认)</option>
                <option value="en-US">English</option>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium">{t.setup.envLabelTitle}</label>
              <Input
                value={environmentLabel}
                onChange={(e) => setEnvironmentLabel(e.target.value)}
                placeholder={t.setup.envLabelPlaceholder}
                maxLength={80}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium">{t.setup.passwordLabel}</label>
              <Input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t.setup.passwordPlaceholder}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium">{t.setup.confirmLabel}</label>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={t.setup.confirmPlaceholder}
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}

          <Button type="submit" variant="primary" className="w-full h-9" disabled={submitting}>
            {submitting ? t.common.saving : t.setup.submitButton}
          </Button>
        </form>
      </main>
    </div>
  );
}
