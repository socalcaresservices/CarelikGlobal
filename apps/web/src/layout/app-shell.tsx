import type { PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";
import { Building2, LayoutDashboard, Settings, ShieldCheck } from "lucide-react";
import { cn } from "@carelik/ui";

const navItems = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/organizations", label: "Organizations", icon: Building2 },
  { to: "/access", label: "Access", icon: ShieldCheck },
  { to: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({ children }: PropsWithChildren) {
  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white lg:block">
        <div className="border-b border-slate-200 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Care operations
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">CareLik Global</h1>
        </div>
        <nav className="space-y-1 p-3">
          {navItems.map(({ to, label, icon: Icon }) => (
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
      </aside>
      <main className="lg:pl-64">
        <header className="border-b border-slate-200 bg-white px-6 py-4">
          <p className="text-sm text-slate-600">Phase 1 · Platform Foundation</p>
        </header>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
