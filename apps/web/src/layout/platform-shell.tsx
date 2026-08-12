/**
 * Platform App Shell (platform.carelik.com)
 *
 * Minimal shell for Ogevia platform operations
 * Shows ONLY platform navigation:
 * - Organizations (registry)
 * - Subscriptions (global plan catalog - see subscriptions-page.tsx)
 * - Feature Flags (system-wide)
 * - Audit (platform events)
 *
 * Future:
 * - Platform Home / dashboard
 * - Per-organization Billing & Support (needs an org picker - today
 *   still embedded in the Organizations row-expand)
 * - Analytics
 * - System Health
 *
 * No tenant branding, no organization context, no switcher
 */

import { PropsWithChildren } from "react";
import { Link, NavLink } from "react-router-dom";
import { Building2, CreditCard, ExternalLink, Flag, ClipboardList, LogOut } from "lucide-react";
import { useAuth } from "@carelik/auth";
import { cn } from "@carelik/ui";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Building2;
}

const platformNav: NavItem[] = [
  { to: "/organizations", label: "Organizations", icon: Building2 },
  { to: "/subscriptions", label: "Subscriptions", icon: CreditCard },
  { to: "/feature-flags", label: "Feature Flags", icon: Flag },
  { to: "/audit", label: "Audit", icon: ClipboardList }
];

function NavItem({ to, label, icon: Icon }: NavItem) {
  return (
    <NavLink
      to={to}
      end={to === "/organizations"}
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
      <span>{label}</span>
    </NavLink>
  );
}

export function PlatformShell({ children }: PropsWithChildren) {
  const { user, signOut } = useAuth();

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white lg:flex lg:flex-col">
        {/* Header */}
        <div className="border-b border-slate-200 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Ogevia Platform
          </p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {platformNav.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-slate-200 px-3 py-4">
          <div className="mb-3 flex items-center gap-3 rounded-lg px-3 py-2 text-sm">
            <div className="h-8 w-8 rounded-full bg-slate-200" />
            <div className="flex-1">
              <p className="text-xs font-medium text-slate-900">{user?.email}</p>
              {/* Static, not derived here - safe only because App.tsx never
                  mounts PlatformShell except inside RequirePlatformOwner,
                  which already confirmed isPlatformOwner. Don't render this
                  shell anywhere that guard doesn't wrap. */}
              <p className="text-xs text-slate-500">Platform Super Admin</p>
            </div>
          </div>
          <Link
            to="/"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950"
          >
            <ExternalLink className="h-4 w-4" />
            <span>View public website</span>
          </Link>
          <button
            onClick={() => signOut()}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950"
          >
            <LogOut className="h-4 w-4" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="lg:ml-64">
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}
