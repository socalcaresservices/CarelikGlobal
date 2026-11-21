import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@carelik/auth";
import { Button, Card } from "@carelik/ui";
import { EnvironmentBanner } from "./environment-marker";

/** The environment band sits above the card on every sign-in screen (TEST and not-verified builds; production shows none). */
function Centered({ children }: PropsWithChildren) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <EnvironmentBanner />
      <div className="flex flex-1 items-center justify-center px-4">{children}</div>
    </div>
  );
}

function fromPath(state: unknown): string {
  const from = (state as { from?: { pathname?: string; search?: string } } | null)?.from;
  return from?.pathname ? `${from.pathname}${from.search ?? ""}` : "/";
}

/** AWS build sign-in: hands off to Cognito managed login (code + PKCE). */
export function AwsLoginPage() {
  const { user, loading, signIn, error, sessionExpired } = useAuth();
  const location = useLocation();
  const [redirecting, setRedirecting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!loading && user) return <Navigate to={fromPath(location.state)} replace />;

  async function start() {
    setFailure(null);
    setRedirecting(true);
    try {
      await signIn(fromPath(location.state));
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Sign-in did not start. Check your connection and try again.");
      setRedirecting(false);
    }
  }

  const notice = failure ?? error?.message ?? (sessionExpired ? "Your session expired. Sign in again." : null);
  return (
    <Centered>
      <Card className="w-full max-w-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Care operations</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">Ogevia</h1>
        <p className="mt-2 text-sm text-slate-600">
          Sign in with the account your administrator created for you.
        </p>
        {notice ? <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p> : null}
        <Button type="button" className="mt-6 w-full" loading={redirecting} disabled={loading || redirecting} onClick={() => void start()}>
          {redirecting ? "Opening sign-in…" : "Sign in"}
        </Button>
      </Card>
    </Centered>
  );
}

/** /auth/callback: completes the code exchange exactly once, then returns to the saved in-app path. */
export function AuthCallbackPage() {
  const { completeSignIn } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return; // StrictMode double-invoke: the code is single-use
    started.current = true;
    const url = window.location.href;
    // Remove code/state from the address bar and history immediately.
    window.history.replaceState(null, "", window.location.pathname);
    completeSignIn(url)
      .then((returnTo) => navigate(returnTo, { replace: true }))
      .catch((cause: unknown) => setFailure(cause instanceof Error ? cause.message : "Sign-in did not complete. Go back to sign in and try again."));
  }, [completeSignIn, navigate]);

  return (
    <Centered>
      {failure ? (
        <Card className="w-full max-w-sm">
          <p role="alert" className="text-sm text-red-700">{failure}</p>
          <Button type="button" className="mt-4 w-full" onClick={() => navigate("/login", { replace: true })}>
            Back to sign in
          </Button>
        </Card>
      ) : (
        <p className="text-sm text-slate-500">Signing you in…</p>
      )}
    </Centered>
  );
}

/** Protected area: loading, expired-session and signed-out states. */
export function AwsProtectedRoute({ children }: PropsWithChildren) {
  const { user, loading, sessionExpired } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <Centered>
        <p className="text-sm text-slate-500">Loading…</p>
      </Centered>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location, expired: sessionExpired }} />;
  }
  return <>{children}</>;
}
