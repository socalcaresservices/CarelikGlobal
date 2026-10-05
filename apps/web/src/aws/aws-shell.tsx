import { useState, type CSSProperties, type PropsWithChildren } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@carelik/auth";
import { cn } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useAttention, useBranding, useLogo, useMyDisplayName, viewKind, VIEW_TITLE } from "./aws-workspace";

export const EXCEPTIONS_PATH = "/service-verification/reports?view=exceptions";
const DEFAULT_ACCENT = "#0f172a"; // slate-900: the colour used before agency branding existed

/**
 * Shell for the AWS build: agency identity first, the signed-in person and
 * their view (ADMINISTRATOR / MANAGER / CAREGIVER VIEW), NEEDS ATTENTION, and
 * role-appropriate navigation. Navigation only decides what is shown; every
 * screen's data is authorized again in PostgreSQL.
 */
export function AwsShell({ children }: PropsWithChildren) {
  const { signOut, user } = useAuth();
  const { organizations, activeOrganization, activeOrganizationId, setActiveOrganizationId, hasPermission, role, loading } = useOrganization();
  const { displayName, loading: nameLoading } = useMyDisplayName();
  const branding = useBranding();
  const logo = useLogo();
  const attention = useAttention();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

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

  const view = viewKind(role);
  const isCaregiver = view === "CAREGIVER";
  const canSeeAttention = hasPermission("visits.read");
  const links = [
    { to: "/", label: "Home", show: !isCaregiver },
    { to: "/service-verification", label: "Verify visit", show: isCaregiver || hasPermission("visits.manage") },
    { to: "/service-verification/reports", label: "Visit records", show: hasPermission("visits.read") },
    { to: "/billing-review", label: "Billing review", show: hasPermission("billing.visits.read") },
    { to: "/schedule", label: "Schedule", show: hasPermission("shifts.manage") || (!isCaregiver && hasPermission("visits.manage")) },
    { to: "/my-shifts", label: "My shifts", show: isCaregiver },
    { to: "/care-requests", label: "Care requests", show: hasPermission("care_requests.read") },
    { to: "/clients", label: "Clients", show: hasPermission("clients.names.read") },
    { to: "/care-team", label: "Care Team", show: hasPermission("caregivers.manage") || hasPermission("visits.manage") },
    { to: "/services", label: "Services", show: !isCaregiver && hasPermission("authorizations.read") },
    { to: "/documents", label: hasPermission("documents.read") ? "Documents" : "My documents", show: hasPermission("documents.read") || hasPermission("documents.manage_own") },
    { to: "/availability", label: "Availability", show: isCaregiver },
    { to: "/continuity", label: "Continuity", show: !isCaregiver && hasPermission("continuity.export") },
    { to: "/outage-visits", label: "Outage records", show: !isCaregiver && hasPermission("visits.manage") },
    { to: "/settings/branding", label: "Settings", show: hasPermission("organization.update") },
  ].filter((l) => l.show);
  // Longest matching path wins (/service-verification/reports is Visit records, not Verify visit).
  const current =
    links
      .filter((l) => (l.to === "/" ? location.pathname === "/" : location.pathname === l.to || location.pathname.startsWith(`${l.to}/`)))
      .sort((a, b) => b.to.length - a.to.length)[0] ?? null;
  const agencyName = branding.data?.displayName ?? activeOrganization?.displayName ?? "Organization";
  const accent = branding.data?.accentColor ?? DEFAULT_ACCENT;
  const count = attention.data?.total ?? null;
  const attentionState = attentionBadge(attention.isLoading, attention.isError, count);

  return (
    <div className="min-h-screen bg-slate-50" style={{ "--agency-accent": accent } as CSSProperties}>
      <header className="border-b border-slate-200 border-t-4 bg-white print:hidden" style={{ borderTopColor: accent }}>
        <div className="mx-auto max-w-6xl px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {logo.data ? <img src={logo.data} alt={`${agencyName} logo`} className="h-10 max-w-[120px] object-contain" /> : null}
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-slate-950">{agencyName}</p>
                <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Powered by Ogevia</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-right">
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wide" style={{ color: accent }} data-testid="view-label">
                  {view} VIEW
                </p>
                <p className="text-sm text-slate-900">
                  {VIEW_TITLE[view]}:{" "}
                  {displayName ? (
                    <span className="font-medium">{displayName}</span>
                  ) : nameLoading ? (
                    <span className="text-slate-500">…</span>
                  ) : (
                    <Link to="/profile" className="font-medium text-amber-800 underline">Name not set – add your name</Link>
                  )}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {user?.email}
                  {displayName ? <> · <Link to="/profile" className="underline">Profile</Link></> : null}
                </p>
              </div>
              <button type="button" className="min-h-[40px] rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-100" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </div>
          {organizations.length > 1 ? (
            <select
              aria-label="Organization"
              value={activeOrganizationId}
              onChange={(e) => setActiveOrganizationId(e.target.value)}
              className="mt-2 rounded-lg border border-slate-200 px-2 py-1 text-sm"
            >
              {organizations.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
            </select>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canSeeAttention ? (
              // Green only when zero is CONFIRMED by the server; loading or a failed check stays neutral.
              <Link
                to={EXCEPTIONS_PATH}
                className={cn(
                  "inline-flex min-h-[40px] items-center gap-2 rounded-lg border-2 px-3 text-sm font-bold uppercase tracking-wide",
                  attentionState.kind === "attention" && "border-red-700 text-red-700 hover:bg-red-50",
                  attentionState.kind === "clear" && "border-emerald-700 text-emerald-800 hover:bg-emerald-50",
                  (attentionState.kind === "checking" || attentionState.kind === "unknown") && "border-slate-400 text-slate-700 hover:bg-slate-50",
                )}
                aria-label={attentionState.aria}
              >
                <span aria-hidden="true">{attentionState.icon}</span> {attentionState.label}
                {attentionState.count !== null ? (
                  <span className={cn("rounded-full px-2 py-0.5 text-xs text-white", attentionState.kind === "clear" ? "bg-emerald-700" : "bg-red-700")}>{attentionState.count}</span>
                ) : null}
              </Link>
            ) : null}
            <button
              type="button"
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800 md:hidden"
              aria-expanded={menuOpen}
              aria-controls="aws-main-nav"
              onClick={() => setMenuOpen((o) => !o)}
            >
              Menu <span className="text-slate-500">· {current?.label ?? "Choose a section"}</span>
            </button>
          </div>
          <nav
            id="aws-main-nav"
            aria-label="Main"
            className={cn("mt-2 flex-col gap-1 md:flex md:flex-row md:flex-wrap", menuOpen ? "flex" : "hidden")}
          >
            {links.map((l) => {
              // Exactly one item is current: the longest matching path (computed above).
              // NavLink's own prefix matching would also mark "Verify visit" on Visit records.
              const active = l.to === current?.to;
              return (
                <Link
                  key={l.to}
                  to={l.to}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                  className={cn("rounded-lg px-3 py-2 text-sm", active ? "font-medium text-white" : "text-slate-700 hover:bg-slate-100")}
                  style={active ? { backgroundColor: accent } : undefined}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 print:max-w-none print:p-0">{children}</main>
    </div>
  );
}

/** Caregivers land on Verify Visit; everyone else on Home. */
export function AwsLanding({ home }: { home: React.ReactNode }) {
  const { role, hasPermission } = useOrganization();
  if (role === "caregiver") return <Navigate to="/service-verification" replace />;
  if (hasPermission("visits.read")) return <>{home}</>;
  return <p className="text-sm text-slate-600">Your role has no Service Verification screens.</p>;
}

/** NEEDS ATTENTION badge: red with a count, green only for a confirmed zero, neutral while checking or when the check failed. */
function attentionBadge(loading: boolean, failed: boolean, count: number | null) {
  if (loading) return { kind: "checking" as const, label: "Checking…", icon: "…", count: null, aria: "Checking items that need attention" };
  if (failed || count === null) return { kind: "unknown" as const, label: "Unable to check", icon: "?", count: null, aria: "Unable to check items that need attention" };
  if (count > 0) return { kind: "attention" as const, label: "Needs attention", icon: "⚠", count, aria: `Needs attention: ${count} ${count === 1 ? "item" : "items"}` };
  return { kind: "clear" as const, label: "All clear", icon: "✓", count: 0, aria: "All clear: 0 items need attention" };
}
