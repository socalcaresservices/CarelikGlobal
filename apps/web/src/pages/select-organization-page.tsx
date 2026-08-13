import { Link } from "react-router-dom";
import { useAuth } from "@carelik/auth";
import { useMyOrganizations } from "@/lib/use-my-organizations";

// Shown only when a signed-in user belongs to more than one organization -
// AppRootRedirect sends anyone with exactly one straight into it, and
// anyone with zero to its own "no organization" message. This page's only
// job is picking which /org/:slug to enter; it never decides membership
// or access itself (the organizations list is already RLS-scoped to what
// this user may see - see useMyOrganizations()).
export function SelectOrganizationPage() {
  const { organizations, loading } = useMyOrganizations();
  const { signOut } = useAuth();

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
      <p className="text-sm font-medium text-slate-500">Ogevia</p>
      <h1 className="mt-1 text-2xl font-semibold text-slate-950">Choose an organization</h1>
      <p className="mt-2 text-sm text-slate-600">
        You belong to more than one organization - pick which one to open.
      </p>

      {loading ? (
        <p className="mt-6 text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="mt-6 space-y-3">
          {organizations.map((org) => (
            <Link
              key={org.id}
              to={`/org/${org.slug}`}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-slate-300 hover:bg-slate-50"
            >
              <span className="font-medium text-slate-900">{org.displayName}</span>
              <span className="text-xs text-slate-400">{org.slug}</span>
            </Link>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => void signOut()}
        className="mt-8 self-start text-sm font-medium text-slate-500 underline underline-offset-2 hover:text-slate-700"
      >
        Sign out
      </button>
    </div>
  );
}
