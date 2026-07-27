import type { PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";
import {
  AlertOctagon,
  BadgeCheck,
  Building2,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  Crown,
  HeartHandshake,
  LayoutDashboard,
  LogOut,
  Settings,
  ShieldCheck,
  Users
} from "lucide-react";
import type { Permission } from "@carelik/shared";
import { useAuth } from "@carelik/auth";
import { cn } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { GlobalSearch } from "@/components/global-search";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission?: Permission;
  ownerOnly?: boolean;
}

// Two groups instead of one flat list: routine, daily-operations
// screens up top where they're easy to reach, and system-administration
// screens (org config, membership access, the audit trail) below a
// quieter "Administration" label. Same routes, same permission gating -
// this only changes how prominent each one looks in the sidebar, so a
// scheduler's eye doesn't land on "Organizations" or "Audit" before it
// lands on "Clients" or "Schedule".
const operationsNav: NavItem[] = [
  { to: "/", label: "Command Center", icon: LayoutDashboard },
  { to: "/owner-dashboard", label: "Workforce Insights", icon: Crown, ownerOnly: true },
  { to: "/clients", label: "Clients", icon: Users, permission: "clients.read" },
  { to: "/team", label: "Team", icon: HeartHandshake, permission: "membership.read" },
  { to: "/schedule", label: "Schedule", icon: CalendarClock },
  { to: "/credentials", label: "Credentials", icon: BadgeCheck },
  {
    to: "/authorizations",
    label: "Authorizations",
    icon: ClipboardCheck,
    permission: "authorizations.read"
  },
  { to: "/incidents", label: "Incidents", icon: AlertOctagon }
];

const administrationNav: NavItem[] = [
  { to: "/organizations", label: "Organizations", icon: Building2, permission: "organization.read" },
  { to: "/access", label: "Access", icon: ShieldCheck, permission: "membership.read" },
  { to: "/audit", label: "Audit", icon: ClipboardList, permission: "audit.read" },
  { to: "/settings", label: "Settings", icon: Settings, permission: "settings.read" }
];

function visibleItems(items: NavItem[], hasPermission: (permission: Permission) => boolean, isOwner: boolean) {
  return items.filter(
    (item) => (!item.permission || hasPermission(item.permission)) && (!item.ownerOnly || isOwner)
  );
}

function NavLinkItem({ to, label, icon: Icon }: NavItem) {
  return (
    <NavLink
      key={to}
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium",
          isActive
            ? "bg-slate-900 text-white"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
        )
      }
    >
      <Icon className="h-4 w-4" />
      {label}
    </NavLink>
  );
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
  const { organizations, activeOrganizationId, setActiveOrganizationId, hasPermission, role, loading } =
    useOrganization();

  const isOwner = role === "organization_owner" || role === "platform_owner";

  const visibleOperationsNav = visibleItems(operationsNav, hasPermission, isOwner);
  const visibleAdministrationNav = visibleItems(administrationNav, hasPermission, isOwner);

  const greeting = getGreeting(new Date());

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <div className="border-b border-slate-200 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Care operations
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">CareLik Global</h1>
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto p-3">
          <div className="space-y-1">
            {visibleOperationsNav.map((item) => (
              <NavLinkItem key={item.to} {...item} />
            ))}
          </div>
          {visibleAdministrationNav.length > 0 ? (
            <div>
              <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Administration
              </p>
              <div className="space-y-1">
                {visibleAdministrationNav.map((item) => (
                  <NavLinkItem key={item.to} {...item} />
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
        </div>
      </aside>
      <main className="lg:pl-64">
        <header className="flex flex-wrap items-center gap-4 border-b border-slate-200 bg-white px-6 py-4">
          <p className="shrink-0 text-sm text-slate-600">
            {greeting}
            {role ? <span className="text-slate-400"> · {formatRole(role)}</span> : null}
          </p>
          <div className="order-last w-full sm:order-none sm:flex-1">
            {activeOrganizationId ? <GlobalSearch /> : null}
          </div>
          {organizations.length > 0 ? (
            <select
              value={activeOrganizationId ?? ""}
              onChange={(event) => setActiveOrganizationId(event.target.value)}
              disabled={loading || organizations.length === 1}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 disabled:bg-slate-50"
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.displayName}
                </option>
              ))}
            </select>
          ) : loading ? (
            <p className="text-sm text-slate-400">Loading organizations…</p>
          ) : (
            <p className="text-sm text-slate-400">No organization access</p>
          )}
        </header>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
