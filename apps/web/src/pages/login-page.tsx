import { useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Github } from "lucide-react";
import { useAuth } from "@carelik/auth";
import { Card } from "@carelik/ui";

interface LocationState {
  from?: { pathname: string };
}

export function LoginPage() {
  const { user, loading, signInWithGithub } = useAuth();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("error_description") ?? params.get("error");
  });

  if (!loading && user) {
    const state = location.state as LocationState | null;
    return <Navigate to={state?.from?.pathname ?? "/"} replace />;
  }

  async function handleSignIn() {
    setError(null);
    setSubmitting(true);
    try {
      await signInWithGithub();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Care operations
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">CareLik Global</h1>
        <p className="mt-2 text-sm text-slate-600">
          Access is by invitation only. Sign in with the GitHub account your
          organization administrator invited.
        </p>

        {error ? (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          onClick={handleSignIn}
          disabled={submitting || loading}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Github className="h-4 w-4" />
          {submitting ? "Redirecting to GitHub…" : "Sign in with GitHub"}
        </button>
      </Card>
    </div>
  );
}
