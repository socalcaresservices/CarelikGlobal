import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@carelik/auth";
import { Button, Card } from "@carelik/ui";
import { getAuthErrorMessage } from "@/lib/auth-errors";

const MIN_PASSWORD_LENGTH = 8;

// Reached two ways, both of which leave the browser holding a temporary
// Supabase session before this page ever mounts (supabase-js's
// detectSessionInUrl picks up the access token from the URL fragment
// automatically): clicking an invite-member email link (see
// supabase/functions/invite-member/index.ts's redirectTo), or clicking a
// "forgot password" reset link (see login-page.tsx's
// resetPasswordForEmail call). Either way, the job here is the same -
// let whoever that temporary session belongs to set a real password via
// updatePassword(), then send them into the app.
export function SetPasswordPage() {
  const { user, loading, updatePassword } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return <Navigate to="/" replace />;
  }

  if (!loading && !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-sm">
          <p className="text-sm font-medium text-slate-500">CareLik Global</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Link expired</h1>
          <p className="mt-3 text-sm text-slate-600">
            This invite or reset link is no longer valid. Ask your administrator to resend it, or request a new
            password reset from the sign-in page.
          </p>
        </Card>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    try {
      await updatePassword(password);
      setDone(true);
    } catch (cause) {
      setError(getAuthErrorMessage(cause, "Could not set password. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Care operations</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">Set your password</h1>
        <p className="mt-2 text-sm text-slate-600">Choose a password to finish setting up your account.</p>

        {error ? <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

        <form onSubmit={handleSubmit} className="mt-6 space-y-3">
          <div>
            <label htmlFor="set-password" className="block text-xs font-medium text-slate-600">
              New password
            </label>
            <input
              id="set-password"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <div>
            <label htmlFor="set-password-confirm" className="block text-xs font-medium text-slate-600">
              Confirm password
            </label>
            <input
              id="set-password-confirm"
              type="password"
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <Button type="submit" disabled={loading} loading={submitting} className="w-full">
            {submitting ? "Saving…" : "Set password and continue"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
