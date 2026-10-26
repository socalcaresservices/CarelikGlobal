import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PropsWithChildren } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import {
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  IdCard,
  LayoutDashboard,
  LogOut,
  Menu,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Settings,
  UserCircle,
  Users,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "@carelik/auth";
import { cn } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { EXCEPTIONS_ROUTE } from "./action-needed";
import { urgentBadge, useAttentionOverview } from "./attention";
import { NotificationsBell } from "./notifications-bell";
import { AppearanceApplier } from "./appearance/use-appearance";
import { useAttentionCounts, useBranding, useLogo, useMyDisplayName, viewKind } from "./aws-workspace";
import { EnvironmentBanner } from "./environment-marker";
import { activeTab, AUTHORIZATIONS_PATH, currentLink, isCalendarView, isExceptionsView, isReportView, isSidebarCurrent, isVisitListView, landingOf, linkKey, REPORTS_PATH, SERVICES_PATH, SHIFT_REQUESTS_PATH, tabsOf, visibleGroups, type NavGroup, type NavLinkDef } from "./nav-model";

export const EXCEPTIONS_PATH = EXCEPTIONS_ROUTE;
const DEFAULT_ACCENT = "#0f172a"; // slate-900: the colour used before agency branding existed
const COLLAPSE_KEY = "ogevia.sidebar.collapsed";
/** The icon of each group (the only icons in the sidebar, all the same size). */
const GROUP_ICON: Record<NavGroup, LucideIcon> = { Dashboard: LayoutDashboard, Clients: Users, Staff: IdCard, Scheduling: CalendarDays, Operations: ClipboardCheck, Settings, "My Work": PenLine };
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
 * (OWNER / ADMINISTRATOR / MANAGER / CAREGIVER VIEW), ACTION NEEDED, and role-appropriate
 * navigation in a collapsible left-hand sidebar (a drawer below 768px). Navigation only decides what is
 * shown; every screen's data is authorized again in PostgreSQL.
 */
export function AwsShell({ children }: PropsWithChildren) {
  const { signOut, user } = useAuth();
  const { organizations, activeOrganization, activeOrganizationId, setActiveOrganizationId, hasPermission, role, loading } = useOrganization();
  const { displayName, loading: nameLoading } = useMyDisplayName();
  const branding = useBranding();
  const logo = useLogo();
  const attention = useAttentionCounts(); // per-area work-waiting badges in the navigation (server counts; the web never recomputes them)
  const overview = useAttentionOverview(); // the header badge: what needs attention now
  const location = useLocation();
  const [collapsedPref, toggleCollapsed] = useSidebarCollapsed();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});   // groups the person opened or closed by hand; the group of the current page is opened whenever the page moves into it
  const [seenGroup, setSeenGroup] = useState<string | null>(null);
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

  // Going back or forward (or any route change) closes the drawer; the route itself is never changed by opening or closing it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (drawerShown) closeButtonRef.current?.focus();
  }, [drawerShown]);

  if (loading) {
    return <div className="flex min-h-screen flex-col"><EnvironmentBanner /><div className="flex flex-1 items-center justify-center"><p className="text-sm text-slate-500">Loading…</p></div></div>;
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
  // The same destinations and the same permission conditions as before; only the grouping and the labels changed. Sidebar items are the first of each group's tabs;
  // `tabOnly` pages keep their place in the strip of tabs above the page and are highlighted under the sidebar item named in `under`.
  const canManageVisits = hasPermission("visits.manage");
  const canBill = hasPermission("billing.visits.read");
  const canSettings = hasPermission("organization.update");
  const staff = !isCaregiver;
  const canServices = hasPermission("authorizations.read");
  const canContinuity = hasPermission("continuity.export");
  const agencyTo = canSettings ? "/settings/branding" : canServices ? SERVICES_PATH : "/continuity";
  const links: NavLinkDef[] = [
    { to: "/", label: "Dashboard", group: "Dashboard", show: staff },
    { to: "/action-needed", label: "Action Needed", group: "Dashboard", tabOnly: true, under: "Dashboard", show: staff && canSeeAttention },
    { to: "/clients", label: "Clients", group: "Clients", show: hasPermission("clients.names.read") },
    // There is no Care Plans page: the closest existing screen is the review of authorization changes (see docs/releases/2026-10-26-redesign).
    { to: AUTHORIZATIONS_PATH, label: "Authorization changes", group: "Clients", show: hasPermission("authorizations.update") || hasPermission("shifts.manage") },
    { to: "/care-team", label: "Caregivers", group: "Staff", show: hasPermission("caregivers.manage") || canManageVisits },
    { to: "/staff", label: "Staff", group: "Staff", show: staff && hasPermission("staff.read") },
    { to: "/settings/staff-types", label: "Staff Types", group: "Staff", show: staff && hasPermission("staff.read") },
    { to: "/care-team/recruiting", label: "Recruiting", group: "Staff", tabOnly: true, under: "Caregivers", show: hasPermission("caregivers.manage") },
    { to: "/documents", label: "Documents", group: "Staff", tabOnly: true, under: "Caregivers", show: staff && hasPermission("documents.read") },
    { to: "/schedule", label: "Schedule", group: "Scheduling", show: hasPermission("shifts.manage") || (staff && canManageVisits) },
    { to: REPORTS_PATH, search: "?view=calendar", label: "Calendar", group: "Scheduling", tabOnly: true, under: "Schedule", show: canReadVisits, matchView: isCalendarView },
    { to: SHIFT_REQUESTS_PATH, label: "Requests", group: "Scheduling", tabOnly: true, under: "Schedule", show: hasPermission("care_requests.read") },
    { to: REPORTS_PATH, search: "?view=overview", label: "Reports", group: "Operations", show: canReadVisits, matchView: isReportView },
    // Billing opens Ready for Approval (a person approves; nothing is billed automatically). Visits to review is exception review; the two are never merged.
    { to: "/billing-review", label: "Billing", group: "Operations", show: canBill },
    { to: REPORTS_PATH, label: "Visits", group: "Operations", tabOnly: true, under: "Reports", show: canReadVisits, matchView: isVisitListView },
    { to: REPORTS_PATH, search: "?view=exceptions", label: "Visits to review", group: "Operations", tabOnly: true, under: "Reports", show: canBill ? canReadVisits : staff && canManageVisits, matchView: isExceptionsView },
    { to: "/service-verification", label: "Verify visit", group: "Operations", tabOnly: true, under: "Reports", show: staff && canManageVisits },
    { to: "/outage-visits", label: "Outage records", group: "Operations", tabOnly: true, under: "Reports", show: staff && canManageVisits },
    { to: "/settings/roles", label: "Roles & Permissions", group: "Settings", show: staff && hasPermission("staff.read") },
    // Agency Settings opens the first agency page the person may use (branding, then services, then continuity); the others are its tabs.
    { to: agencyTo, label: "Agency Settings", group: "Settings", show: staff && (canSettings || canServices || canContinuity) },
    { to: "/accounts", label: "Accounts", group: "Settings", tabOnly: true, under: "Roles & Permissions", show: staff && hasPermission("accounts.manage") },
    { to: "/settings/branding", label: "Branding", group: "Settings", tabOnly: true, under: "Agency Settings", show: staff && canSettings && agencyTo !== "/settings/branding" },
    { to: SERVICES_PATH, label: "Services", group: "Settings", tabOnly: true, under: "Agency Settings", show: staff && canServices && agencyTo !== SERVICES_PATH },
    { to: "/continuity", label: "Continuity", group: "Settings", tabOnly: true, under: "Agency Settings", show: staff && canContinuity && agencyTo !== "/continuity" },
    // Appearance is everyone's; it is also in the menu footer next to Profile.
    { to: "/settings/appearance", label: "Appearance", group: "Settings", tabOnly: true, under: "Agency Settings", show: true },
    // The caregiver's own day. There is no separate tasks page: verifying a visit is the caregiver's task.
    { to: "/my-shifts", label: "My Schedule", group: "My Work", show: isCaregiver },
    { to: "/service-verification", label: "Verify Visit", group: "My Work", show: isCaregiver },
    { to: "/availability", label: "Availability", group: "My Work", tabOnly: true, under: "My Schedule", show: isCaregiver },
    { to: "/documents", label: "My documents", group: "My Work", tabOnly: true, under: "My Schedule", show: isCaregiver && hasPermission("documents.manage_own") },
  ];
  const groups = visibleGroups(links);
  // Each badge is ONE server count (COUNT_DEFINITIONS.md). Billing shows what is ready for approval and Visits to review shows exception review: the two are never merged.
  // Red only when the server says Critical.
  const counts = attention.data ?? null;
  const countOf = (l: NavLinkDef): { count: number; critical: number } | null => {
    if (!counts) return null;
    if (l.label === "Visits to review") return counts.approvals.exceptions;
    if (l.to === "/care-team" && l.group === "Staff") return counts.caregivers;
    if (l.to === "/schedule") return counts.scheduling;
    if (l.to === "/billing-review") return counts.approvals.readyForApproval === null ? null : { count: counts.approvals.readyForApproval, critical: 0 };
    return null;
  };
  const badgeOf = (l: NavLinkDef): { n: number; blocking: boolean } | null => {
    const c = countOf(l);
    return c && c.count > 0 ? { n: c.count, blocking: c.critical > 0 } : null;
  };
  const current = currentLink(links, location.pathname, location.search);
  if (current && current.group !== seenGroup) {
    // The page moved into another group: open it (a group closed by hand stays closed until the page moves into it again).
    setSeenGroup(current.group);
    setOpenGroups((m) => ({ ...m, [current.group]: true }));
  }
  const stripTabs = current ? tabsOf(links, current.group) : [];
  const stripActive = activeTab(links, current);
  const agencyName = branding.data?.displayName ?? activeOrganization?.displayName ?? "Organization";
  const accent = branding.data?.accentColor ?? DEFAULT_ACCENT;
  // The same classification and query result as the Home tiles (attention.ts): unique shifts and visits needing attention now.
  const badge = urgentBadge(overview.isLoading, overview.isError, overview.data);
  // Home's own first row shows this same count (and its loading / unavailable state), so the header badge appears everywhere else.
  const showBadge = canSeeAttention && badge.kind !== "hidden" && location.pathname !== "/";

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

  // Sidebar rows: 32px (44px for coarse pointers), 16px icons with an 8px gap, 13.5px text. The active page has a filled row and a bar on its left edge.
  const itemClass = (active: boolean) =>
    cn(
      "flex min-h-[32px] items-center gap-2 rounded-md px-2.5 py-1 text-[13.5px] leading-5 [@media(pointer:coarse)]:min-h-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-accent",
      collapsed && "justify-center px-0",
      active ? "bg-og-active font-semibold text-og-accent shadow-[inset_3px_0_0_0_currentColor]" : "font-medium text-og-ink hover:bg-og-ink/5",
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
      <AppearanceApplier />
      <aside
        id="aws-sidebar"
        ref={asideRef}
        hidden={sidebarHidden}
        aria-label="Menu"
        onKeyDown={trapFocus}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex-col border-r border-og-line bg-og-side print:hidden",
          sidebarHidden ? "hidden" : "flex",
          isMobile ? "w-[min(88vw,20rem)] shadow-2xl" : collapsed ? "w-[76px]" : "w-64",
        )}
      >
        <div className={cn("flex items-center gap-2 px-3 pb-2 pt-4", collapsed ? "flex-col" : "justify-between")}>
          <div className="flex min-w-0 items-center gap-2">
            {/* No Ogevia logo image exists in the repository: the wordmark is text. */}
            <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-og-link text-base font-bold text-og-on-accent">O</span>
            <span className={cn("truncate text-lg font-bold tracking-tight text-og-ink", collapsed && "sr-only")}>Ogevia</span>
          </div>
          {isMobile ? (
            <button ref={closeButtonRef} type="button" aria-label="Close menu" onClick={closeDrawer} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-og-ink hover:bg-og-ink/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-og-accent">
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
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-og-ink hover:bg-og-ink/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-og-accent"
            >
              {collapsed ? <PanelRightOpen className="h-5 w-5" aria-hidden="true" /> : <PanelRightClose className="h-5 w-5" aria-hidden="true" />}
            </button>
          )}
        </div>

        <div className={cn("mx-3 mb-2 border-b border-og-line pb-2", collapsed && "flex justify-center")}>
          <div className="flex min-w-0 items-center gap-2">
            {logo.data ? (
              <img src={logo.data} alt={`${agencyName} logo`} className="h-8 max-w-[40px] shrink-0 object-contain" />
            ) : (
              <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-og-active text-xs font-bold text-og-active-ink">{initialsOf(agencyName)}</span>
            )}
            <div className={cn("min-w-0", collapsed && "sr-only")}>
              <p className="truncate text-[13px] font-semibold text-og-ink">{agencyName}</p>
            </div>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
        <nav id="aws-main-nav" aria-label="Main" className="flex flex-1 flex-col overflow-y-auto px-3 pb-6">
          {groups.map(({ group, links: items }) => {
            const GroupIcon = GROUP_ICON[group];
            const isCurrentGroup = current?.group === group;
            const open = !collapsed && (openGroups[group] ?? group === "My Work");
            const landing = landingOf(links, group);
            const waiting = tabsOf(links, group).map(badgeOf).filter((b): b is { n: number; blocking: boolean } => b !== null);
            // A closed group shows what is waiting inside it: the count when one page has work waiting, or a bare dot when several do (counts of different things are never added together).
            const groupBadge = waiting.length === 1 ? waiting[0]! : waiting.length > 1 ? { n: 0, blocking: waiting.some((b) => b.blocking) } : null;
            const badgeEl = (b: { n: number; blocking: boolean }, floating: boolean) => (
              <span
                data-testid="nav-badge"
                aria-label={b.n > 0 ? `${b.n} waiting` : "Items waiting"}
                className={cn("rounded-full px-1.5 text-[11px] font-bold leading-[18px] ring-1", b.blocking ? "bg-red-100 text-red-800 ring-red-700" : "bg-amber-100 text-amber-900 ring-amber-600", floating && "absolute -mt-5 ml-4")}
              >
                {b.n > 0 ? b.n : "•"}
              </span>
            );
            const single = group === "Dashboard" && items.length === 1 ? items[0]! : null;
            return (
              // Settings follows the other groups, set apart by a divider.
              <div key={group} className={cn("first:mt-1", collapsed ? "mt-1.5" : "mt-1", group === "Settings" && !collapsed && "mt-2 border-t border-og-line pt-2")} data-testid="nav-section">
                {collapsed || single ? (
                  // Icon-only menu: one icon per group, opening its first page. The Dashboard has one page, so it is a plain link.
                  landing ? (
                    <Link
                      to={`${landing.to}${landing.search ?? ""}`}
                      aria-current={isCurrentGroup ? "page" : undefined}
                      onClick={() => { setTip(null); if (isMobile) setDrawerOpen(false); }}
                      onMouseEnter={(e) => showTip(group, e.currentTarget)}
                      onFocus={(e) => showTip(group, e.currentTarget)}
                      onMouseLeave={() => setTip(null)}
                      onBlur={() => setTip(null)}
                      data-nav-level={single ? "tab" : undefined}
                      className={itemClass(isCurrentGroup)}
                    >
                      <GroupIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className={cn(collapsed && "sr-only")}>{single ? single.label : group}</span>
                      {groupBadge ? badgeEl(groupBadge, collapsed) : null}
                    </Link>
                  ) : null
                ) : (
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={`nav-${group.replace(/\s+/g, "-").toLowerCase()}`}
                    onClick={() => setOpenGroups((m) => ({ ...m, [group]: !open }))}
                    className={cn(itemClass(false), "w-full text-left font-semibold", isCurrentGroup ? "text-og-accent" : "text-og-ink")}
                    data-nav-level="section"
                  >
                    <GroupIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 break-words">{group}</span>
                    {!open && groupBadge ? badgeEl(groupBadge, false) : null}
                    <ChevronDown className={cn("h-4 w-4 shrink-0 text-og-sub transition-transform", open ? "rotate-0" : "-rotate-90")} aria-hidden="true" />
                  </button>
                )}
                {open && !single ? (
                  <ul id={`nav-${group.replace(/\s+/g, "-").toLowerCase()}`} className="mb-1 ml-[18px] mt-0.5 space-y-0.5 border-l border-og-line pl-2">
                    {items.map((l) => {
                      const active = isSidebarCurrent(l, current);
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
                            data-nav-level="child"
                            className={cn(itemClass(active), "min-h-[30px] py-0.5 text-[13px]", "[@media(pointer:coarse)]:min-h-[44px]", !active && "text-og-sub hover:text-og-ink")}
                          >
                            <span className="min-w-0 flex-1 break-words">{l.label}</span>
                            {badge ? badgeEl(badge, false) : null}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </nav>
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-og-side to-transparent" />
        </div>

        <div className="border-t border-og-line p-3">
          <div className={cn("flex items-center gap-2", collapsed && "justify-center")}>
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-og-active text-xs font-bold text-og-active-ink">{displayName ? initialsOf(displayName) : <UserCircle className="h-4 w-4" />}</span>
            <div className={cn("min-w-0 flex-1", collapsed && "sr-only")}>
              <p className="text-[10.5px] font-bold uppercase tracking-wide text-og-link" data-testid="view-label">{view} VIEW</p>
              <p className="truncate text-[13px] leading-4 text-og-ink">
                {displayName ? (
                  <span className="font-semibold">{displayName}</span>
                ) : nameLoading ? (
                  <span className="text-og-sub">…</span>
                ) : (
                  <Link to="/profile" className="font-semibold text-amber-900 underline">Name not set – add your name</Link>
                )}
              </p>
              <p className="truncate text-[11.5px] text-og-sub">{user?.email}</p>
            </div>
          </div>
          <div className="mt-1.5 flex flex-col">
            {displayName ? (
              <Link
                to="/profile"
                aria-current={location.pathname === "/profile" ? "page" : undefined}
                onClick={() => isMobile && setDrawerOpen(false)}
                onMouseEnter={(e) => showTip("Profile", e.currentTarget)}
                onFocus={(e) => showTip("Profile", e.currentTarget)}
                onMouseLeave={() => setTip(null)}
                onBlur={() => setTip(null)}
                className={cn(itemClass(location.pathname === "/profile"), "min-h-[30px] py-0.5 text-[13px]")}
              >
                <UserCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className={cn(collapsed && "sr-only")}>Profile</span>
              </Link>
            ) : null}
            <Link
              to="/settings/appearance"
              aria-current={location.pathname === "/settings/appearance" ? "page" : undefined}
              onClick={() => isMobile && setDrawerOpen(false)}
              onMouseEnter={(e) => showTip("Appearance", e.currentTarget)}
              onFocus={(e) => showTip("Appearance", e.currentTarget)}
              onMouseLeave={() => setTip(null)}
              onBlur={() => setTip(null)}
              className={cn(itemClass(location.pathname === "/settings/appearance"), "min-h-[30px] py-0.5 text-[13px]")}
            >
              <Palette className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className={cn(collapsed && "sr-only")}>Appearance</span>
            </Link>
            <button
              type="button"
              onClick={() => void signOut()}
              onMouseEnter={(e) => showTip("Sign out", e.currentTarget)}
              onFocus={(e) => showTip("Sign out", e.currentTarget)}
              onMouseLeave={() => setTip(null)}
              onBlur={() => setTip(null)}
              className={cn(itemClass(false), "min-h-[30px] py-0.5 text-left text-[13px]")}
            >
              <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className={cn(collapsed && "sr-only")}>Sign out</span>
            </button>
          </div>
        </div>
      </aside>
      {collapsed && tip ? (
        <div role="presentation" aria-hidden="true" className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-lg bg-og-ink px-3 py-1.5 text-sm font-medium text-white shadow-lg" style={{ left: 84, top: tip.top }}>
          {tip.label}
        </div>
      ) : null}

      <div className={cn("print:pl-0", !isMobile && (collapsed ? "pl-[76px]" : "pl-64"))}>
        <EnvironmentBanner />
        <header className="border-b border-og-line bg-og-card print:hidden" style={{ borderTop: `4px solid ${accent}` }}>
          <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 md:px-6">
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
            {showBadge ? (
              // Red only for care blocked or at risk now, amber for approaching risk; every state has a word and a symbol.
              <Link
                to="/attention"
                className={cn(
                  "inline-flex min-h-[44px] items-center gap-2 rounded-lg border px-3 text-sm font-semibold md:min-h-[40px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link",
                  badge.tone === "red" && "border-red-700 bg-red-50 text-red-800 hover:bg-red-100",
                  badge.tone === "amber" && "border-amber-600 bg-amber-50 text-amber-900 hover:bg-amber-100",
                  badge.tone === "neutral" && (badge.kind === "clear" ? "border-transparent font-normal text-og-sub hover:bg-og-page" : "border-og-line text-og-ink hover:bg-og-page"),
                )}
                aria-label={badge.aria}
                data-testid="attention-badge"
              >
                <span aria-hidden="true">{badge.icon}</span> {badge.label}
                {badge.count !== null ? <span className="font-og-mono tabular-nums">{badge.count}</span> : null}
              </Link>
            ) : null}
            {canSeeAttention ? <NotificationsBell /> : null}
            {/* A user who belongs to more than one organization switches here (unchanged behaviour). */}
            {organizations.length > 1 ? (
              <select
                aria-label="Organization"
                value={activeOrganizationId}
                onChange={(e) => setActiveOrganizationId(e.target.value)}
                className="ml-auto min-h-[40px] rounded-lg border border-og-line bg-og-card px-2 text-sm"
              >
                {organizations.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
              </select>
            ) : null}
          </div>
        </header>
        <main className="mx-auto max-w-[1240px] px-3 py-3 md:px-6 print:max-w-none print:p-0">
          {stripTabs.length > 1 ? (
            // The current section's tabs, above the page (print hides them). Smaller links under a tab keep the tab highlighted.
            <nav aria-label="Section tabs" data-testid="section-tabs" className="-mx-3 mb-3 flex overflow-x-auto border-b border-og-line px-3 md:mx-0 md:px-0 print:hidden">
              {stripTabs.map((l) => {
                const on = stripActive !== null && linkKey(l) === linkKey(stripActive);
                const badge = badgeOf(l);
                return (
                  <Link
                    key={linkKey(l)}
                    to={`${l.to}${l.search ?? ""}`}
                    aria-current={on ? "page" : undefined}
                    className={cn("-mb-px inline-flex min-h-[44px] shrink-0 items-center gap-2 border-b-2 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-og-accent md:min-h-[40px]", on ? "border-og-ink font-semibold text-og-ink" : "border-transparent text-og-sub hover:text-og-ink")}
                  >
                    {l.label}
                    {badge ? (
                      <span data-testid="tab-badge" aria-label={`${badge.n} waiting`} className={cn("rounded-full px-1.5 text-[11px] font-bold leading-[18px] ring-1", badge.blocking ? "bg-red-100 text-red-800 ring-red-700" : "bg-amber-100 text-amber-900 ring-amber-600")}>{badge.n}</span>
                    ) : null}
                  </Link>
                );
              })}
            </nav>
          ) : null}
          {children}
        </main>
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
