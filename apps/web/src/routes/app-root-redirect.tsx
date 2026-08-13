import { Navigate } from "react-router-dom";
import { useAuth } from "@carelik/auth";
import { useIsPlatformOwner } from "@/lib/use-platform-owner";
import { useMyOrganizations } from "@/lib/use-my-organizations";

/**
 * The landing decision for "/" on app.ogevia.com, once authenticated
 * (ProtectedRoute already sent an unauthenticated visitor to /login
 * before this mounts - see App.tsx). This is the ONLY place that decides
 * where a freshly signed-in user goes - never a subdomain, never
 * localStorage, never a first-organization guess buried inside
 * OrganizationProvider (that was the exact bug this replaces: a stale
 * cached org from a previous, unrelated visit could silently win).
 *
 *   - Platform owner -> /platform/organizations. Their home is managing
 *     every tenant, not any one of them - they reach a specific tenant's
 *     workspace from there ("Enter organization"), same as anyone else.
 *   - Exactly one organization -> straight into it, /org/:slug.
 *   - More than one -> /select-organization, a real chooser.
 *   - Zero -> NoOrganizationPage below, not a redirect loop or a blank
 *     screen.
 */
export function AppRootRedirect() {
  const { isPlatformOwner, loading: platformLoading } = useIsPlatformOwner();
  const { organizations, loading: organizationsLoading } = useMyOrganizations();

  if (platformLoading || organizationsLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  if (isPlatformOwner) {
    return <Navigate to="/platform/organizations" replace />;
  }

  if (organizations.length === 1) {
    return <Navigate to={`/org/${organizations[0]!.slug}`} replace />;
  }

  if (organizations.length > 1) {
    return <Navigate to="/select-organization" replace />;
  }

  return <NoOrganizationPage />;
}

function NoOrganizationPage() {
  const { signOut } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        <p className="text-sm font-medium text-slate-500">Ogevia</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">No organization yet</h1>
        <p className="mt-3 text-slate-600">
          Your account isn't a member of any organization yet. Ask an administrator to invite you, or check that
          you signed in with the right email address.
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-4 text-sm font-medium underline underline-offset-2"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
