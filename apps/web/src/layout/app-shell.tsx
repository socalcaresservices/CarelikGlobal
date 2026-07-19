import type { PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";
import {
  BadgeCheck,
  Building2,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
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

const navItems: Array<{
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission?: Permission;
}> = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/organizations", label: "Organizations", icon: Building2, permission: "organization.read" },
  { to: "/access", label: "Access", icon: ShieldCheck, permission: "membership.read" },
  { to: "/clients", label: "Clients", icon: Users, permission: "clients.read" },
  { to: "/schedule", label: "Schedule", icon: CalendarClock },
  { to: "/credentials", label: "Credentials", icon: BadgeCheck },
  {
    to: "/authorizations",
    label: "Authorizations",
    icon: ClipboardCheck,
    permission: "authorizations.read"
  },
  { to: "/audit", label: "Audit", icon: ClipboardList, permission: "audit.read" },
  { to: "/settings", label: "Settings", icon: Settings, permission: "settings.read" }
];

export function AppShell({ children }: PropsWithChildren) {
  const { user, signOut } = useAuth();
  const { organizations, activeOrganizationId, setActiveOrganizationId, hasPermission, loading } =
    useOrganization();

  const visibleNavItems = navItems.filter(
    (item) => !item.permission || hasPermission(item.permission)
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <div className="border-b border-slate-200 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Care operations
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">CareLik Global</h1>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {visibleNavItems.map(({ to, label, icon: Icon }) => (
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
          ))}
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
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <p className="text-sm text-slate-600">Phase 1 · Platform Foundation</p>
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
