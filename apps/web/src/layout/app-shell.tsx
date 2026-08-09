import type { CSSProperties, PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertOctagon,
  BadgeCheck,
  CalendarClock,
  CalendarPlus,
  ClipboardCheck,
  Crown,
  FileText,
  HeartHandshake,
  LayoutDashboard,
  LogOut,
  PenLine,
  Settings,
  ShieldCheck,
  UserPlus,
  Users
} from "lucide-react";
import type { Permission } from "@carelik/shared";
import { useAuth } from "@carelik/auth";
import { cn } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { GlobalSearch } from "@/components/global-search";
import { ContextBar } from "@/components/context-bar";
import { supabase } from "@/lib/supabase";

// The six counts get_actionable_counts (20260728010000) returns - one
// per nav destination that has an "issues" concept worth surfacing as a
// badge. Not every nav item has a badgeKey; ones that don't (Command
// Center, Team, Organizations, Audit, Settings...) just never render a
// pill. A null count means the caller lacks permission to know, which
// looks identical to zero (no badge) - the distinction only matters
// server-side, for not leaking a number to someone who can't see the
// underlying page.
interface ActionableCounts {
  clients_uncovered: number | null;
  schedule_issues: number | null;
  access_pending: number | null;
  credentials_issues: number | null;
  authorizations_issues: number | null;
  incidents_open: number | null;
}

type BadgeKey = keyof ActionableCounts;

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission?: Permission;
  ownerOnly?: boolean;
  badgeKey?: BadgeKey;
}

// Five groups instead of one flat nine-item list, split by what each
// screen is *for* rather than just "routine vs admin": the screens you
// check every day (Overview), the people you manage (People), the
// compliance surfaces that carry expiration risk (Compliance), and
// system administration (Administration, unchanged from before). Same
// routes, same permission gating, same badge keys - this only changes
// how the sidebar groups and labels them, so scanning for "is anything
// expiring" or "who do I need to follow up with" doesn't require
// reading all nine labels in one flat list every time.
const overviewNav: NavItem[] = [
  { to: "/", label: "Command Center", icon: LayoutDashboard },
  { to: "/owner-dashboard", label: "Workforce Insights", icon: Crown, ownerOnly: true },
  { to: "/schedule", label: "Schedule", icon: CalendarClock, badgeKey: "schedule_issues" },
  // No permission gate - every caregiver needs to be able to schedule
  // their own visits; caregiver_assignments (not this nav item) is the
  // real gate on which clients/services they can pick from.
  { to: "/staff/visits", label: "Schedule a visit", icon: CalendarPlus },
  // No permission gate - every caregiver needs this to record their own
  // visits, and the RLS/RPC layer already scopes what each caregiver can
  // see to their own assigned shifts regardless of nav visibility.
  { to: "/service-verification", label: "Service Verification", icon: PenLine },
  { to: "/service-verification/reports", label: "Visit Reports", icon: FileText, permission: "visits.read" }
];

const peopleNav: NavItem[] = [
  { to: "/applicants", label: "Applicants", icon: UserPlus, permission: "applicants.read" },
  { to: "/clients", label: "Clients", icon: Users, permission: "clients.read", badgeKey: "clients_uncovered" },
  { to: "/team", label: "Team", icon: HeartHandshake, permission: "membership.read" }
];

const complianceNav: NavItem[] = [
  { to: "/credentials", label: "Credentials", icon: BadgeCheck, badgeKey: "credentials_issues" },
  {
    to: "/authorizations",
    label: "Authorizations",
    icon: ClipboardCheck,
    permission: "authorizations.read",
    badgeKey: "authorizations_issues"
  },
  { to: "/incidents", label: "Incidents", icon: AlertOctagon, badgeKey: "incidents_open" }
];

// Tenant Administration (Build 022: Platform/Tenant separation) - the
// tenant workspace shows only tenant-scoped administration. Platform
// administration (organization registry, feature flags, audit) lives
// exclusively on platform.carelik.com's PlatformShell - never here, even
// for a user who happens to also be a platform owner and a real member
// of this tenant (e.g. its creator). A tenant workspace is entirely
// about the one organization it's scoped to; which host you're on
// decides whether you see platform tools at all, not who you are.
const administrationNav: NavItem[] = [
  { to: "/access", label: "Access", icon: ShieldCheck, permission: "membership.read", badgeKey: "access_pending" },
  { to: "/settings", label: "Settings", icon: Settings, permission: "settings.read" }
];

function visibleItems(items: NavItem[], hasPermission: (permission: Permission) => boolean, isOwner: boolean) {
  return items.filter(
    (item) => (!item.permission || hasPermission(item.permission)) && (!item.ownerOnly || isOwner)
  );
}

// The active nav item reads the same --color-accent/--color-accent-
// foreground custom properties Button's primary variant does (see
// packages/ui/src/button.tsx) - both fall back to the platform default
// slate-900/white whenever there's no org, no active org, or the org
// hasn't set a primary_color yet. brandStyle() below sets those
// properties once on AppShell's root element from the active org's
// primary_color, so this component no longer needs its own accentColor
// prop/inline-style branch - it just uses the var like every other
// branded surface.
function NavLinkItem({
  to,
  label,
  icon: Icon,
  badgeCount
}: NavItem & { badgeCount?: number | null | undefined }) {
  return (
    <NavLink
      key={to}
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium",
          isActive
            ? "bg-[var(--color-accent,#0f172a)] text-[var(--color-accent-foreground,#ffffff)]"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
        )
      }
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1">{label}</span>
      {badgeCount ? (
        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
          {badgeCount}
        </span>
      ) : null}
    </NavLink>
  );
}

// Sets --color-accent/--color-accent-foreground from the active org's
// primary_color, scoped to AppShell's root element so it cascades to
// every descendant - the sidebar's active nav item, and every packages/ui
// Button rendered anywhere inside the app (Save/Submit/Send/Add.../File...
// buttons across every page, previously always a flat slate-900
// regardless of which org you were looking at). Mirrors apply-page.tsx's
// brandStyle() helper, but keyed off primary_color rather than
// accent_color - see the Build 023 migration comment for why the public-
// facing pages deliberately use a different organization column than the
// internal app's chrome does. Returns {} (no override, default palette
// applies) whenever the org hasn't set a primary_color.
function brandStyle(primaryColor: string | null | undefined): CSSProperties {
  if (!primaryColor) return {};
  return { "--color-accent": primaryColor, "--color-accent-foreground": "#ffffff" } as CSSProperties;
}

function formatRole(role: string) {
  return role.replace(/_/g, " ");
}

function getGreeting(now: Date) {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function AppShell({ children }: PropsWithChildren) {
  const { user, signOut } = useAuth();
  const {
    activeOrganization,
    activeOrganizationId,
    hasPermission,
    role,
    loading
  } = useOrganization();
  // Defaults to shown - an organization opts OUT of platform attribution
  // rather than opting in (see the show_powered_by column's comment,
  // 20260728020000).
  const showPoweredBy = activeOrganization?.showPoweredBy !== false;

  const isOwner = role === "organization_owner" || role === "platform_owner";

  const visibleOverviewNav = visibleItems(overviewNav, hasPermission, isOwner);
  const visiblePeopleNav = visibleItems(peopleNav, hasPermission, isOwner);
  const visibleComplianceNav = visibleItems(complianceNav, hasPermission, isOwner);
  const visibleAdministrationNav = visibleItems(administrationNav, hasPermission, isOwner);

  const greeting = getGreeting(new Date());

  // Powers the nav-rail badges - one query per organization/session
  // covers every badge at once, rather than each destination page
  // fetching its own count. Gated on membership.read the same way the
  // RPC itself is, and on having at least one badgeKey nav item visible
  // so a platform owner with no active organization doesn't fire it.
  const countsQuery = useQuery({
    queryKey: ["actionable-counts", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_actionable_counts", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (Array.isArray(data) ? data[0] : data) as ActionableCounts | undefined;
    },
    enabled: !!activeOrganizationId && hasPermission("membership.read")
  });
  const counts = countsQuery.data;

  function badgeFor(item: NavItem) {
    if (!item.badgeKey || !counts) return undefined;
    return counts[item.badgeKey];
  }

  return (
    <div className="min-h-screen bg-slate-50" style={brandStyle(activeOrganization?.primaryColor)}>
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <div className="border-b border-slate-200 px-6 py-5">
          {activeOrganization?.logoUrl ? (
            <img
              src={activeOrganization.logoUrl}
              alt={activeOrganization.displayName}
              className="max-h-9 max-w-full object-contain"
            />
          ) : (
            <>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Care operations
              </p>
              <h1 className="mt-1 text-xl font-semibold text-slate-950">
                {activeOrganization?.displayName ?? "CareLik Global"}
              </h1>
            </>
          )}
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto p-3">
          <div className="space-y-1">
            {visibleOverviewNav.map((item) => (
              <NavLinkItem key={item.to} {...item} badgeCount={badgeFor(item)} />
            ))}
          </div>
          {visiblePeopleNav.length > 0 ? (
            <div>
              <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                People
              </p>
              <div className="space-y-1">
                {visiblePeopleNav.map((item) => (
                  <NavLinkItem key={item.to} {...item} badgeCount={badgeFor(item)} />
                ))}
              </div>
            </div>
          ) : null}
          {visibleComplianceNav.length > 0 ? (
            <div>
              <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Compliance
              </p>
              <div className="space-y-1">
                {visibleComplianceNav.map((item) => (
                  <NavLinkItem key={item.to} {...item} badgeCount={badgeFor(item)} />
                ))}
              </div>
            </div>
          ) : null}
          {visibleAdministrationNav.length > 0 ? (
            <div>
              <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Administration
              </p>
              <div className="space-y-1">
                {visibleAdministrationNav.map((item) => (
                  <NavLinkItem key={item.to} {...item} badgeCount={badgeFor(item)} />
                ))}
              </div>
            </div>
          ) : null}
        </nav>
        <div className="border-t border-slate-200 p-3">
          <p className="truncate px-3 text-xs text-slate-500">{user?.email}</p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
          {showPoweredBy ? (
            <p className="mt-3 px-3 text-[11px] text-slate-400">Powered by CareLik</p>
          ) : null}
        </div>
      </aside>
      <main className="lg:pl-64">
        <header className="flex flex-wrap items-center gap-4 border-b border-slate-200 bg-white px-6 py-4">
          <NavLink
            to="/service-verification"
            className="inline-flex min-h-12 items-center gap-2 rounded-lg bg-[var(--color-accent,#0f172a)] px-3 text-sm font-semibold text-[var(--color-accent-foreground,#ffffff)] lg:hidden"
          >
            <PenLine className="h-4 w-4" />
            Verify visit
          </NavLink>
          <p className="shrink-0 text-sm text-slate-600">
            {greeting}
            {role ? <span className="text-slate-400"> · {formatRole(role)}</span> : null}
          </p>
          <div className="order-last w-full sm:order-none sm:flex-1">
            {activeOrganizationId ? <GlobalSearch /> : null}
          </div>
          {/* Build 022: Organization switcher hidden in tenant context
              In a true multi-tenant SaaS, users are scoped to one tenant/subdomain.
              Switcher will be re-evaluated if we support users with access to multiple
              organizations (Phase 4+). For now, show only active org name. */}
          {activeOrganization ? (
            <p className="text-sm font-medium text-slate-900">{activeOrganization.displayName}</p>
          ) : loading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : (
            <p className="text-sm text-slate-400">No organization</p>
          )}
        </header>
        <ContextBar />
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
