import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { Button, Card } from "@carelik/ui";
import { supabase } from "@/lib/supabase";
import { getAuthErrorMessage } from "@/lib/auth-errors";

const MIN_PASSWORD_LENGTH = 8;
const RECOVERY_DETECT_TIMEOUT_MS = 6000;

type Phase = "checking" | "ready" | "invalid" | "success";

// Supabase reports an expired/already-used recovery link by redirecting
// back with error params instead of a code/token - in the query string
// for PKCE, in the hash for the older implicit flow. Checked before
// anything else so a dead link goes straight to the expired state
// instead of sitting on "verifying…" until the timeout.
function readUrlError(): string | null {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const description = query.get("error_description") ?? hash.get("error_description");
  if (description) return description;
  if (query.get("error") ?? hash.get("error")) {
    return "This link is invalid or has expired.";
  }
  return null;
}

// Strips recovery tokens/codes/errors out of the visible URL and browser
// history once they've been consumed, so they don't linger somewhere a
// screenshot, shared link, or browser-history sync could expose them.
function scrubRecoveryParamsFromUrl() {
  window.history.replaceState(null, "", window.location.pathname);
}

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const urlError = readUrlError();
    if (urlError) {
      setError(urlError);
      setPhase("invalid");
      scrubRecoveryParamsFromUrl();
      return;
    }

    let settled = false;

    // PASSWORD_RECOVERY is the one reliable signal that the current
    // session came from a recovery link rather than an ordinary
    // persisted sign-in - a plain "is there a session" check would let
    // someone with an unrelated active session visit this page directly
    // and change their password without ever clicking a reset link.
    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        settled = true;
        setPhase("ready");
        scrubRecoveryParamsFromUrl();
      }
    });

    const timeout = window.setTimeout(() => {
      if (!settled) {
        setPhase("invalid");
      }
    }, RECOVERY_DETECT_TIMEOUT_MS);

    return () => {
      subscription.unsubscribe();
      window.clearTimeout(timeout);
    };
  }, []);

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
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      // The recovery session has done its one job - sign it out so the
      // account isn't left signed in on whatever device opened the
      // email link, and send the user through a normal sign-in instead.
      await supabase.auth.signOut();
      setPhase("success");
    } catch (cause) {
      setError(getAuthErrorMessage(cause, "Could not update your password. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <p className="text-sm text-slate-500">Verifying your link…</p>
      </div>
    );
  }

  if (phase === "invalid") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-sm">
          <p className="text-sm font-medium text-slate-500">Ogevia</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Link expired</h1>
          <p className="mt-3 text-sm text-slate-600">
            {error ?? "This password reset link is no longer valid."} Request a new one from the sign-in page.
          </p>
          <Link
            to="/login"
            className="mt-6 block w-full rounded-lg border border-slate-200 px-4 py-2.5 text-center text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to sign in
          </Link>
        </Card>
      </div>
    );
  }

  if (phase === "success") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-sm">
          <p className="text-sm font-medium text-slate-500">Ogevia</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Password updated</h1>
          <p className="mt-3 text-sm text-slate-600">
            Your password has been changed. Sign in with your new password to continue.
          </p>
          <Button className="mt-6 w-full" onClick={() => navigate("/login", { replace: true })}>
            Go to sign in
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Care operations</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">Set a new password</h1>
        <p className="mt-2 text-sm text-slate-600">Choose a new password for your account.</p>

        {error ? <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

        <form onSubmit={handleSubmit} className="mt-6 space-y-3">
          <div>
            <label htmlFor="reset-password-new" className="block text-xs font-medium text-slate-600">
              New password
            </label>
            <div className="relative mt-1">
              <input
                id="reset-password-new"
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 pr-10 text-sm text-slate-900"
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div>
            <label htmlFor="reset-password-confirm" className="block text-xs font-medium text-slate-600">
              Confirm new password
            </label>
            <input
              id="reset-password-confirm"
              type={showPassword ? "text" : "password"}
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <Button type="submit" loading={submitting} className="w-full">
            {submitting ? "Saving…" : "Update password"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
