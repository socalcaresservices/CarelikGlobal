import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Github } from "lucide-react";
import { useAuth } from "@carelik/auth";
import { Button, Card } from "@carelik/ui";
import { getAuthErrorMessage } from "@/lib/auth-errors";

interface LocationState {
  from?: { pathname: string };
}

// Email/password is the primary sign-in path - a paying customer
// organization can't be expected to have a GitHub account. GitHub OAuth
// stays available below it as a secondary option, not removed.
export function LoginPage() {
  const { user, loading, signInWithGithub, signInWithPassword, resetPasswordForEmail } = useAuth();
  const location = useLocation();

  const [mode, setMode] = useState<"password" | "forgot">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [githubSubmitting, setGithubSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("error_description") ?? params.get("error");
  });
  const [resetSent, setResetSent] = useState(false);

  if (!loading && user) {
    const state = location.state as LocationState | null;
    return <Navigate to={state?.from?.pathname ?? "/"} replace />;
  }

  async function handleGithubSignIn() {
    setError(null);
    setGithubSubmitting(true);
    try {
      await signInWithGithub();
    } catch (cause) {
      setError(getAuthErrorMessage(cause, "Sign-in failed. Try again."));
      setGithubSubmitting(false);
    }
  }

  async function handlePasswordSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signInWithPassword(email, password);
    } catch (cause) {
      setError(getAuthErrorMessage(cause, "Sign-in failed. Check your email and password."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleForgotPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await resetPasswordForEmail(email);
      setResetSent(true);
    } catch (cause) {
      setError(getAuthErrorMessage(cause, "Could not send a reset email. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  function switchMode(nextMode: "password" | "forgot") {
    setMode(nextMode);
    setError(null);
    setResetSent(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Care operations</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">CareLik Global</h1>
        <p className="mt-2 text-sm text-slate-600">
          {mode === "forgot"
            ? "Enter your email and we'll send you a link to set a new password."
            : "Access is by invitation only. Sign in with the email and password your organization administrator set up for you."}
        </p>

        {error ? <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        {resetSent ? (
          <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Check your email for a link to set a new password.
          </p>
        ) : null}

        {mode === "password" ? (
          <form onSubmit={handlePasswordSignIn} className="mt-6 space-y-3">
            <div>
              <label htmlFor="login-email" className="block text-xs font-medium text-slate-600">
                Email
              </label>
              <input
                id="login-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="block text-xs font-medium text-slate-600">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <Button type="submit" loading={submitting} className="w-full">
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
            <button
              type="button"
              onClick={() => switchMode("forgot")}
              className="w-full text-center text-xs font-medium text-slate-500 underline-offset-2 hover:underline"
            >
              Forgot password?
            </button>
          </form>
        ) : (
          <form onSubmit={handleForgotPassword} className="mt-6 space-y-3">
            <div>
              <label htmlFor="reset-email" className="block text-xs font-medium text-slate-600">
                Email
              </label>
              <input
                id="reset-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <Button type="submit" loading={submitting} className="w-full">
              {submitting ? "Sending…" : "Send reset link"}
            </Button>
            <button
              type="button"
              onClick={() => switchMode("password")}
              className="w-full text-center text-xs font-medium text-slate-500 underline-offset-2 hover:underline"
            >
              Back to sign in
            </button>
          </form>
        )}

        <div className="mt-6 flex items-center gap-3 text-xs text-slate-400">
          <div className="h-px flex-1 bg-slate-200" />
          or
          <div className="h-px flex-1 bg-slate-200" />
        </div>

        <button
          type="button"
          onClick={handleGithubSignIn}
          disabled={githubSubmitting}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Github className="h-4 w-4" />
          {githubSubmitting ? "Redirecting to GitHub…" : "Sign in with GitHub"}
        </button>
      </Card>
    </div>
  );
}
