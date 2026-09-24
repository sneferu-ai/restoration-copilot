// Login screen — the operator auth gate. Single primary action (sign in),
// honest error messages, shop-floor voice (DESIGN.md §8).

import { FormEvent, useState } from "react";
import { useSession } from "@/shared/session";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { ICONS } from "@/shared/ui/Icon";


export function LoginScreen() {
  const { login } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ padding: "var(--space-6)" }}
    >
      <main className="w-full" style={{ maxWidth: "22rem" }}>
        <header className="flex flex-col items-center gap-4" style={{ marginBottom: "var(--space-8)" }}>
          <img
            src="/static/restoration/app/brand-mark.svg"
            alt=""
            width={48}
            height={48}
            style={{ filter: "var(--drop-shadow-mark)" }}
          />
          <div className="text-center">
            <h1 className="text-2xl font-semibold tracking-tight">Restoration Copilot</h1>
            <p className="text-sm text-fg-tertiary" style={{ marginTop: "var(--space-1)" }}>Operator console</p>
          </div>
        </header>

        <form onSubmit={onSubmit} className="card flex flex-col gap-4" style={{ padding: "var(--space-6)" }}>
          <Input
            label="Operator ID"
            required
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="shop-owner"
            disabled={submitting}
            autoFocus
          />
          <Input
            label="Passphrase"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            error={error}
          />
          <Button
            type="submit"
            variant="primary"
            icon={ICONS.key}
            loading={submitting}
            loadingLabel="Signing in…"
            disabled={!username.trim() || !password}
            disabledReason={!username.trim() || !password ? "Enter operator ID and passphrase to sign in." : undefined}
            className="w-full"
          >
            Sign in
          </Button>
          <p className="text-xs text-fg-tertiary text-center" style={{ marginTop: "var(--space-1)" }}>
            Credentials are set by the shop operator. In-flight tasks keep running during sign-in.
          </p>
        </form>
      </main>
    </div>
  );
}
