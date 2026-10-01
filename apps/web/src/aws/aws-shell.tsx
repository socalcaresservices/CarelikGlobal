import type { PropsWithChildren } from "react";
import { Navigate, NavLink } from "react-router-dom";
import { useAuth } from "@carelik/auth";
import { cn } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";

/** Minimal shell for the AWS Service Verification build. */
export function AwsShell({ children }: PropsWithChildren) {
  const { signOut, user } = useAuth();
  const { organizations, activeOrganization, activeOrganizationId, setActiveOrganizationId, hasPermission, role, loading } = useOrganization();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center"><p className="text-sm text-slate-500">Loading…</p></div>;
  }
  if (!activeOrganizationId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium text-slate-900">Your account is not active in any organization.</p>
          <p className="mt-1 text-sm text-slate-600">Ask your organization administrator to grant access.</p>
          <button type="button" className="mt-4 text-sm underline" onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>
    );
  }

  const links = [
    { to: "/service-verification", label: "Verify visit", show: role === "caregiver" || hasPermission("visits.manage") },
    { to: "/service-verification/reports", label: "Visit records", show: hasPermission("visits.read") },
    { to: "/billing-review", label: "Billing review", show: hasPermission("billing.visits.read") },
  ].filter((l) => l.show);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <span className="text-base font-semibold text-slate-950">Ogevia</span>
          {organizations.length > 1 ? (
            <select
              aria-label="Organization"
              value={activeOrganizationId}
              onChange={(e) => setActiveOrganizationId(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-sm"
            >
              {organizations.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
            </select>
          ) : (
            <span className="text-sm text-slate-600">{activeOrganization?.displayName}</span>
          )}
          <nav className="flex flex-wrap gap-1" aria-label="Main">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end className={({ isActive }) => cn("rounded-lg px-3 py-1.5 text-sm", isActive ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100")}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-slate-500 sm:inline">{user?.email}</span>
            <button type="button" className="text-sm text-slate-700 underline" onClick={() => void signOut()}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

/** Caregivers land on Verify Visit; reviewers on Visit records. */
export function AwsLanding() {
  const { role, hasPermission } = useOrganization();
  if (role === "caregiver") return <Navigate to="/service-verification" replace />;
  if (hasPermission("visits.read")) return <Navigate to="/service-verification/reports" replace />;
  return <p className="text-sm text-slate-600">Your role has no Service Verification screens.</p>;
}
