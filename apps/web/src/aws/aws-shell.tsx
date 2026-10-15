import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PropsWithChildren } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import {
  CalendarClock,
  CalendarDays,
  CalendarHeart,
  ChartNoAxesColumn,
  ClipboardCheck,
  Clock,
  FileArchive,
  FileText,
  FolderOpen,
  HandHeart,
  HeartHandshake,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Settings,
  Stethoscope,
  UserCircle,
  UserCog,
  Users,
  X,
} from "lucide-react";
import { useAuth } from "@carelik/auth";
import { cn } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { actionCategories, actionNeededState, EXCEPTIONS_ROUTE } from "./action-needed";
import { useAttention, useBranding, useLogo, useMyDisplayName, viewKind, VIEW_TITLE } from "./aws-workspace";
import { EnvironmentBanner } from "./environment-marker";
import { currentLink, isCalendarView, isExceptionsView, isReportView, isVisitListView, linkKey, REPORTS_PATH, visibleGroups, type NavLinkDef } from "./nav-model";

export const EXCEPTIONS_PATH = EXCEPTIONS_ROUTE;
const DEFAULT_ACCENT = "#0f172a"; // slate-900: the colour used before agency branding existed
const COLLAPSE_KEY = "ogevia.sidebar.collapsed";
/** Workflow colour per area (icon tint and selected row). Status colour is separate: amber = waiting, red = blocking. */
const ACCENT = { clients: "#0369a1", caregivers: "#0f766e", scheduling: "#6d28d9", approvals: "#b45309", reports: "#475569" } as const;
/** Which Action-needed categories each area shows as its badge (same server summary as the header count). */
const AREA_BADGE: Record<string, readonly string[]> = {
  "/care-team": ["overdueDocuments", "documentsToReview"],
  "/schedule": ["unfilledShifts"],
  Approvals: ["missingClockOut", "awaitingConfirmation", "visitsToReview", "signaturesToReview", "readyForApproval"],
};
const BLOCKING = new Set(["missingClockOut", "overdueDocuments"]);
const MOBILE_QUERY = "(max-width: 767px)";

/** The remembered sidebar choice. Storage can be blocked (private windows), so every access is guarded. */
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* the choice still applies for this session */
      }
      return next;
    });
  }, []);
  return [collapsed, toggle] as const;
}

/** True below 768px. Without matchMedia (tests) the desktop layout is used. */
function useIsMobile() {
  const [mobile, setMobile] = useState(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_QUERY).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mobile;
}

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

/**
 * Shell for the AWS build: agency identity, the signed-in person and their view
 * (ADMINISTRATOR / MANAGER / CAREGIVER VIEW), ACTION NEEDED, and role-appropriate
 * navigation in a collapsible right-hand menu (a drawer below 768px). Navigation only decides what is
 * shown; every screen's data is authorized again in PostgreSQL.
 */
export function AwsShell({ children }: PropsWithChildren) {
  const { signOut, user } = useAuth();
  const { organizations, activeOrganization, activeOrganizationId, setActiveOrganizationId, hasPermission, role, loading } = useOrganization();
  const { displayName, loading: nameLoading } = useMyDisplayName();
  const branding = useBranding();
  const logo = useLogo();
  const attention = useAttention();
  const location = useLocation();
  const [collapsedPref, toggleCollapsed] = useSidebarCollapsed();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  // The drawer is always expanded; the remembered choice only applies to the desktop sidebar.
  const collapsed = collapsedPref && !isMobile;
  const drawerShown = isMobile && drawerOpen;
  const sidebarHidden = isMobile && !drawerOpen;

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (drawerShown) closeButtonRef.current?.focus();
  }, [drawerShown]);

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center"><p className="text-sm text-slate-500">Loading…</p></div>;
  }
  if (!activeOrganizationId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium text-slate-900">Your account is not active in any organization.</p>
          <p className="mt-1 text-sm text-slate-600">Ask your organization administrator to grant access.</p>
          <button type="button" className="mt-4 rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>
    );
  }

  const view = viewKind(role);
  const isCaregiver = view === "CAREGIVER";
  const canSeeAttention = hasPermission("visits.read");
  const canReadVisits = hasPermission("visits.read");
  // Same destinations and the same permission conditions as before; only the grouping and the labels changed.
  // Five areas (Clients, Caregivers, Scheduling, Approvals, Reports), their related pages as smaller links,
  // and administration last. Colour = area (see ACCENT); badges = work waiting, from the same server summary as ACTION NEEDED.
  const canManageVisits = hasPermission("visits.manage");
  const canBill = hasPermission("billing.visits.read");
  const links: NavLinkDef[] = [
    { to: "/", label: "Home", group: "HOME", icon: LayoutDashboard, show: !isCaregiver },
    // The caregiver's own day.
    { to: "/service-verification", label: "Verify visit", group: "MY WORK", icon: PenLine, show: isCaregiver },
    { to: "/my-shifts", label: "My shifts", group: "MY WORK", icon: CalendarClock, show: isCaregiver },
    { to: "/availability", label: "Availability", group: "MY WORK", icon: Clock, show: isCaregiver },
    { to: "/documents", label: "My documents", group: "MY WORK", icon: FolderOpen, show: isCaregiver && hasPermission("documents.manage_own") },
    // The five areas.
    { to: "/clients", label: "Clients", group: "WORK", icon: Users, accent: ACCENT.clients, show: hasPermission("clients.names.read") },
    { to: "/care-requests", label: "Care requests", group: "WORK", parent: "/clients", icon: HandHeart, show: hasPermission("care_requests.read") },
    { to: REPORTS_PATH, search: "?view=calendar", label: "Monthly calendar", group: "WORK", parent: "/clients", icon: CalendarHeart, show: canReadVisits, matchView: isCalendarView },
    { to: "/care-team", label: "Caregivers", group: "WORK", icon: HeartHandshake, accent: ACCENT.caregivers, show: hasPermission("caregivers.manage") || canManageVisits },
    { to: "/documents", label: "Documents", group: "WORK", parent: "/care-team", icon: FolderOpen, show: !isCaregiver && hasPermission("documents.read") },
    { to: "/schedule", label: "Scheduling", group: "WORK", icon: CalendarDays, accent: ACCENT.scheduling, show: hasPermission("shifts.manage") || (!isCaregiver && canManageVisits) },
    canBill
      ? { to: "/billing-review", label: "Approvals", group: "WORK", icon: ClipboardCheck, accent: ACCENT.approvals, show: true }
      : { to: REPORTS_PATH, search: "?view=exceptions", label: "Approvals", group: "WORK", icon: ClipboardCheck, accent: ACCENT.approvals, show: !isCaregiver && canManageVisits, matchView: isExceptionsView },
    { to: REPORTS_PATH, search: "?view=exceptions", label: "Visits to review", group: "WORK", parent: "/approvals", icon: ClipboardCheck, show: canBill && canReadVisits, matchView: isExceptionsView },
    { to: REPORTS_PATH, label: "Visit records", group: "WORK", parent: "/approvals", icon: FileText, show: canReadVisits, matchView: isVisitListView },
    { to: "/service-verification", label: "Verify visit", group: "WORK", parent: "/approvals", icon: PenLine, show: !isCaregiver && canManageVisits },
    { to: REPORTS_PATH, search: "?view=overview", label: "Reports", group: "WORK", icon: ChartNoAxesColumn, accent: ACCENT.reports, show: canReadVisits, matchView: isReportView },
    // Administration and settings, last.
    { to: "/services", label: "Services", group: "SETUP", icon: Stethoscope, show: !isCaregiver && hasPermission("authorizations.read") },
    { to: "/continuity", label: "Continuity pack", group: "SETUP", icon: LifeBuoy, show: !isCaregiver && hasPermission("continuity.export") },
    { to: "/outage-visits", label: "Outage records", group: "SETUP", icon: FileArchive, show: !isCaregiver && canManageVisits },
    { to: "/accounts", label: "Accounts", group: "SETUP", icon: UserCog, show: !isCaregiver && hasPermission("accounts.manage") },
    { to: "/settings/branding", label: "Settings", group: "SETUP", icon: Settings, show: hasPermission("organization.update") },
  ];
  const groups = visibleGroups(links);
  const cats = attention.data ? actionCategories(attention.data) : [];
  const badgeOf = (l: NavLinkDef): { n: number; blocking: boolean } | null => {
    const keys = AREA_BADGE[l.to] ?? (l.label === "Approvals" ? AREA_BADGE.Approvals : undefined);
    if (!keys || l.parent) return null;
    const hit = cats.filter((c) => keys.includes(c.key));
    const n = hit.reduce((sum, c) => sum + c.count, 0);
    return n > 0 ? { n, blocking: hit.some((c) => c.count > 0 && BLOCKING.has(c.key)) } : null;
  };
  const current = currentLink(links, location.pathname, location.search);
  const agencyName = branding.data?.displayName ?? activeOrganization?.displayName ?? "Organization";
  const accent = branding.data?.accentColor ?? DEFAULT_ACCENT;
  // The same function and the same query result as the Home banner (action-needed.ts).
  const attentionState = actionNeededState(attention.isLoading, attention.isError, attention.data);

  function trapFocus(e: KeyboardEvent<HTMLElement>) {
    if (!drawerShown) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      closeDrawer();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = Array.from(asideRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function showTip(label: string, el: HTMLElement) {
    if (!collapsed) return;
    const r = el.getBoundingClientRect();
    setTip({ label, top: r.top + r.height / 2 });
  }

  const itemClass = (active: boolean) =>
    cn(
      // Sidebar "Option B": 14px/500 links, 40px rows (44px for coarse pointers), 18px icons with an 8px gap, no accent bar.
      "flex min-h-[40px] items-center gap-2 rounded-md px-3 py-1.5 text-[14px] leading-5 [@media(pointer:coarse)]:min-h-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0F6674]",
      collapsed && "justify-center px-0",
      active ? "bg-[#E8F5F4] font-semibold text-[#0F6674]" : "font-medium text-[#243244] hover:bg-[#F0F7F7]",
    );

  return (
    <div
      className="og-app min-h-screen bg-og-page font-og text-og-ink print:min-h-0 print:bg-white"
      style={{ "--agency-accent": accent } as CSSProperties}
      onKeyDown={(e) => {
        if (e.key === "Escape" && tip) setTip(null);
      }}
    >
      {drawerShown ? <div aria-hidden="true" className="fixed inset-0 z-40 bg-og-ink/40 md:hidden print:hidden" onClick={closeDrawer} /> : null}
      <aside
        id="aws-sidebar"
        ref={asideRef}
        hidden={sidebarHidden}
        aria-label="Menu"
        onKeyDown={trapFocus}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex-col border-l border-[#E2E8EC] bg-[#FAFBFC] print:hidden",
          sidebarHidden ? "hidden" : "flex",
          isMobile ? "w-[min(88vw,20rem)] shadow-2xl" : collapsed ? "w-[76px]" : "w-64",
        )}
      >
        <div className={cn("flex items-center gap-2 px-3 pb-2 pt-4", collapsed ? "flex-col" : "justify-between")}>
          <div className="flex min-w-0 items-center gap-2">
            {/* No Ogevia logo image exists in the repository: the wordmark is text. */}
            <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-og-link text-base font-bold text-white">O</span>
            <span className={cn("truncate text-lg font-bold tracking-tight text-og-ink", collapsed && "sr-only")}>Ogevia</span>
          </div>
          {isMobile ? (
            <button ref={closeButtonRef} type="button" aria-label="Close menu" onClick={closeDrawer} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-og-ink hover:bg-[#F0F7F7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0F6674]">
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              aria-label={collapsed ? "Expand menu" : "Collapse menu"}
              aria-expanded={!collapsed}
              aria-controls="aws-sidebar"
              onClick={() => {
                setTip(null);
                toggleCollapsed();
              }}
              onMouseEnter={(e) => showTip("Expand menu", e.currentTarget)}
              onFocus={(e) => showTip("Expand menu", e.currentTarget)}
              onMouseLeave={() => setTip(null)}
              onBlur={() => setTip(null)}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-og-ink hover:bg-[#F0F7F7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0F6674]"
            >
              {collapsed ? <PanelRightOpen className="h-5 w-5" aria-hidden="true" /> : <PanelRightClose className="h-5 w-5" aria-hidden="true" />}
            </button>
          )}
        </div>

        <div className={cn("mx-3 mb-2 rounded-og border border-og-line bg-white p-2.5", collapsed && "flex justify-center px-0")}>
          <div className="flex min-w-0 items-center gap-2.5">
            {logo.data ? (
              <img src={logo.data} alt={`${agencyName} logo`} className="h-9 max-w-[44px] shrink-0 object-contain" />
            ) : (
              <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-og-active text-sm font-bold text-og-active-ink">{initialsOf(agencyName)}</span>
            )}
            <div className={cn("min-w-0", collapsed && "sr-only")}>
              <p className="truncate text-sm font-semibold text-og-ink">{agencyName}</p>
              <p className="text-[11px] font-medium text-og-sub">Powered by Ogevia</p>
            </div>
          </div>
        </div>

        <nav id="aws-main-nav" aria-label="Main" className="flex flex-1 flex-col overflow-y-auto px-3 pb-3">
          {groups.map(({ group, links: items }) => (
            // SETUP is pinned to the bottom of the menu.
            <div key={group} className={cn("first:mt-1", collapsed ? "mt-2" : "mt-4", group === "SETUP" && "mt-auto pt-2")}>
              {/* Headings are hidden when collapsed; the links keep their accessible names. */}
              {group === "HOME" || collapsed ? null : (
                <p className="mx-3 mb-1.5 text-[11px] font-semibold leading-[18px] tracking-[0.08em] text-[#64748B]" data-testid="nav-group-heading">{group}</p>
              )}
              <ul className="space-y-0.5">
                {items.filter((l) => !l.parent || !collapsed).map((l) => {
                  const active = current !== null && linkKey(l) === linkKey(current);
                  const Icon = l.icon;
                  const badge = badgeOf(l);
                  return (
                    <li key={linkKey(l)}>
                      <Link
                        to={`${l.to}${l.search ?? ""}`}
                        aria-current={active ? "page" : undefined}
                        onClick={() => {
                          setTip(null);
                          if (isMobile) setDrawerOpen(false);
                        }}
                        onMouseEnter={(e) => showTip(l.label, e.currentTarget)}
                        onFocus={(e) => showTip(l.label, e.currentTarget)}
                        onMouseLeave={() => setTip(null)}
                        onBlur={() => setTip(null)}
                        className={cn(itemClass(active), l.parent && !collapsed && "ml-5 min-h-[34px] py-1 text-[13px] font-normal")}
                        style={active && l.accent ? { backgroundColor: `${l.accent}14`, color: l.accent } : undefined}
                      >
                        <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" style={l.accent ? { color: l.accent } : undefined} />
                        <span className={cn("min-w-0 flex-1 break-words", collapsed && "sr-only")}>{l.label}</span>
                        {badge ? (
                          <span
                            data-testid="nav-badge"
                            aria-label={`${badge.n} waiting`}
                            className={cn("rounded-full px-1.5 text-[11px] font-bold leading-[18px] text-white", badge.blocking ? "bg-red-700" : "bg-amber-600", collapsed && "absolute -mt-5 ml-4")}
                          >
                            {badge.n}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-[#E2E8EC] p-3">
          <div className={cn("flex items-start gap-2.5", collapsed && "justify-center")}>
            <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-og-active text-xs font-bold text-og-active-ink">{displayName ? initialsOf(displayName) : <UserCircle className="h-5 w-5" />}</span>
            <div className={cn("min-w-0 flex-1", collapsed && "sr-only")}>
              <p className="text-[11px] font-bold uppercase tracking-wide text-og-link" data-testid="view-label">{view} VIEW</p>
              <p className="text-sm text-og-ink">
                {VIEW_TITLE[view]}:{" "}
                {displayName ? (
                  <span className="font-semibold">{displayName}</span>
                ) : nameLoading ? (
                  <span className="text-og-sub">…</span>
                ) : (
                  <Link to="/profile" className="font-semibold text-amber-900 underline">Name not set – add your name</Link>
                )}
              </p>
              <p className="truncate text-xs text-og-sub">{user?.email}</p>
            </div>
          </div>
          <div className={cn("mt-2 flex gap-1", collapsed ? "flex-col" : "flex-row")}>
            {displayName ? (
              <Link
                to="/profile"
                onClick={() => isMobile && setDrawerOpen(false)}
                onMouseEnter={(e) => showTip("Profile", e.currentTarget)}
                onFocus={(e) => showTip("Profile", e.currentTarget)}
                onMouseLeave={() => setTip(null)}
                onBlur={() => setTip(null)}
                className={cn(itemClass(false), !collapsed && "flex-1")}
              >
                <UserCircle className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                <span className={cn(collapsed && "sr-only")}>Profile</span>
              </Link>
            ) : null}
            <button
              type="button"
              onClick={() => void signOut()}
              onMouseEnter={(e) => showTip("Sign out", e.currentTarget)}
              onFocus={(e) => showTip("Sign out", e.currentTarget)}
              onMouseLeave={() => setTip(null)}
              onBlur={() => setTip(null)}
              className={cn(itemClass(false), !collapsed && "flex-1")}
            >
              <LogOut className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
              <span className={cn(collapsed && "sr-only")}>Sign out</span>
            </button>
          </div>
        </div>
      </aside>
      {collapsed && tip ? (
        <div role="presentation" aria-hidden="true" className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-lg bg-og-ink px-3 py-1.5 text-sm font-medium text-white shadow-lg" style={{ right: 84, top: tip.top }}>
          {tip.label}
        </div>
      ) : null}

      <div className={cn("print:pr-0", !isMobile && (collapsed ? "pr-[76px]" : "pr-64"))}>
        <EnvironmentBanner />
        <header className="border-b border-og-line bg-white print:hidden" style={{ borderTop: `4px solid ${accent}` }}>
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 md:px-8">
            <button
              ref={menuButtonRef}
              type="button"
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-og-line px-3 text-sm font-medium text-og-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link md:hidden"
              aria-expanded={drawerShown}
              aria-controls="aws-sidebar"
              onClick={() => setDrawerOpen(true)}
            >
              <Menu className="h-4 w-4" aria-hidden="true" />
              Menu <span className="text-og-sub">· {current?.label ?? "Choose a section"}</span>
            </button>
            {canSeeAttention ? (
              // Green only when zero is CONFIRMED by the server; loading or a failed check stays neutral.
              // Opens the Home list built from the same server summary as this count (0033).
              <Link
                to="/"
                className={cn(
                  "inline-flex min-h-[40px] items-center gap-2 rounded-lg border-2 px-3 text-sm font-bold uppercase tracking-wide focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link",
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
            {/* A user who belongs to more than one organization switches here (unchanged behaviour). */}
            {organizations.length > 1 ? (
              <select
                aria-label="Organization"
                value={activeOrganizationId}
                onChange={(e) => setActiveOrganizationId(e.target.value)}
                className="ml-auto min-h-[40px] rounded-lg border border-og-line bg-white px-2 text-sm"
              >
                {organizations.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
              </select>
            ) : null}
          </div>
        </header>
        <main className="mx-auto max-w-[1180px] px-4 py-6 md:px-8 print:max-w-none print:p-0">{children}</main>
      </div>
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
