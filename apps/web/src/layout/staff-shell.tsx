import type { CSSProperties, PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";
import { CalendarCheck, CalendarPlus, LayoutDashboard, LogOut, PenLine } from "lucide-react";
import { useAuth } from "@carelik/auth";
import { cn } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useOrgPath } from "@/lib/use-org-path";

// A genuinely separate, mobile-first shell for the caregiver role - not
// AppShell with items hidden by permission checks (the OGEVIA SaaS
// structure spec explicitly calls that pattern out: "Do not reuse one
// sidebar with different visibility hacks"). Rendered by TenantShell
// instead of AppShell whenever the signed-in user's role in the active
// organization is "caregiver".
//
// Nav is deliberately short and only points at pages that actually
// exist and actually work today: Home, My Schedule (list_shifts()
// already scopes itself to "just the shifts you're the caregiver on"
// when the caller lacks shifts.read - see schedule-page.tsx's own
// comment - so this is safe to reuse as-is, no new query needed),
// Schedule a visit, and Clock In / Service Verification.
//
// The spec's staff nav also lists Tasks, Messages, Documents, and
// Profile. None of those exist as real features anywhere in this
// codebase (no /tasks, /messages route; no caregiver self-service
// documents or profile page - CaregiverDetailPage is an admin view of
// a caregiver, not a caregiver's own self-service page). Building
// stub pages for them would be exactly the kind of fabricated,
// half-finished feature this codebase's own house rules
// (docs/PRODUCT_CONSTITUTION.md's "no fabricated numbers" doctrine)
// exist to prevent - they're left out of this nav entirely rather than
// faked, and tracked as real follow-up work instead.
interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const staffNav: NavItem[] = [
  { to: "/", label: "Home", icon: LayoutDashboard },
  { to: "/schedule", label: "My Schedule", icon: CalendarCheck },
  { to: "/staff/visits", label: "Schedule a visit", icon: CalendarPlus },
  { to: "/service-verification", label: "Clock in / Verify visit", icon: PenLine }
];

function brandStyle(primaryColor: string | null | undefined): CSSProperties {
  if (!primaryColor) return {};
  return { "--color-accent": primaryColor, "--color-accent-foreground": "#ffffff" } as CSSProperties;
}

function getGreeting(now: Date) {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// Bottom tab bar on mobile (the primary device for this role, per the
// marketing page's own "built for a phone in the field" claim) - a
// left sidebar only appears at desktop widths, mirroring AppShell's own
// lg breakpoint so both shells behave consistently once a caregiver is
// on a large screen.
export function StaffShell({ children }: PropsWithChildren) {
  const { user, signOut } = useAuth();
  const { activeOrganization, loading } = useOrganization();
  const orgPath = useOrgPath();
  const greeting = getGreeting(new Date());

  return (
    <div className="min-h-screen bg-slate-50 pb-20 lg:pb-0" style={brandStyle(activeOrganization?.primaryColor)}>
      <aside className="fixed inset-y-0 left-0 hidden w-56 border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <div className="border-b border-slate-200 px-5 py-5">
          {activeOrganization?.logoUrl ? (
            <img
              src={activeOrganization.logoUrl}
              alt={activeOrganization.displayName}
              className="max-h-9 max-w-full object-contain"
            />
          ) : (
            <h1 className="text-lg font-semibold text-slate-950">{activeOrganization?.displayName ?? "Ogevia"}</h1>
          )}
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {staffNav.map((item) => (
            <NavLink
              key={item.to}
              to={orgPath(item.to)}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium",
                  isActive
                    ? "bg-[var(--color-accent,#0f172a)] text-[var(--color-accent-foreground,#ffffff)]"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
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

      <main className="lg:pl-56">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <p className="text-sm text-slate-600">
            {greeting}
            {loading ? null : <span className="text-slate-400"> · {activeOrganization?.displayName ?? "Ogevia"}</span>}
          </p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-sm font-medium text-slate-500 lg:hidden"
          >
            Sign out
          </button>
        </header>
        <div className="p-4">{children}</div>
      </main>

      {/* Mobile bottom tab bar - large touch targets, one thumb-reachable
          row, exactly the "built for a phone in the field" experience the
          marketing page promises but AppShell (a desktop-first sidebar
          collapsing into a hamburger-less header) never delivered for
          this role. */}
      <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-slate-200 bg-white lg:hidden">
        {staffNav.map((item) => (
          <NavLink
            key={item.to}
            to={orgPath(item.to)}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium",
                isActive ? "text-[var(--color-accent,#0f172a)]" : "text-slate-500"
              )
            }
          >
            <item.icon className="h-5 w-5" />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
