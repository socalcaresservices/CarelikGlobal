// Navigation model for the AWS shell: which links exist, which group each belongs to, and which one is current. Pure, so it can be tested without rendering the shell.
//
// This file changes presentation only. Every destination and the permission conditions that decide who sees it are the ones the application already had
// (aws-shell.tsx computes each `show` from the same permissions; every screen is authorized again in PostgreSQL).
//
// Each group lists the destinations shown in the sidebar and, in the strip of tabs above the page, the related pages that keep their place there (`tabOnly`).
// A tab-only page is highlighted under the sidebar item it belongs to (`under`). Nothing is removed to make the menu shorter.
export const NAV_GROUPS = ["Dashboard", "Clients", "Staff", "Scheduling", "Operations", "Settings", "My Work"] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export const REPORTS_PATH = "/service-verification/reports";
/** Moved by Batch 4 (the old paths redirect: see aws-root.tsx and ROUTE_MAP.md). */
export const SHIFT_REQUESTS_PATH = "/schedule/shift-requests";
export const SERVICES_PATH = "/settings/services";
export const AUTHORIZATIONS_PATH = "/authorization-impacts";

/** Report views that are reports (not the visit list or the exceptions list). */
const REPORT_VIEWS_AS_REPORTS = new Set(["overview", "caregiver", "reconciliation", "corrections", "staff-access"]);

export interface NavLinkDef {
  /** Route path. */
  to: string;
  /** Optional query string appended to the link (for example "?view=calendar"). */
  search?: string;
  label: string;
  group: NavGroup;
  show: boolean;
  /** Shown only in the strip of tabs above the page, not in the sidebar. */
  tabOnly?: boolean;
  /** For a tab-only page: the label of the sidebar item it is highlighted under. */
  under?: string;
  /** Narrows a shared path: given the ?view= value, is this link the current one? */
  matchView?: (view: string | null) => boolean;
}

export const isReportView = (view: string | null) => !!view && REPORT_VIEWS_AS_REPORTS.has(view);
export const isCalendarView = (view: string | null) => view === "calendar";
export const isExceptionsView = (view: string | null) => view === "exceptions";
export const isVisitListView = (view: string | null) => !isReportView(view) && !isCalendarView(view) && !isExceptionsView(view);

/** The groups that have something to show in the sidebar, each with its sidebar items. */
export function visibleGroups(links: NavLinkDef[]): { group: NavGroup; links: NavLinkDef[] }[] {
  const shown = links.filter((l) => l.show && !l.tabOnly);
  return NAV_GROUPS.map((group) => ({ group, links: shown.filter((l) => l.group === group) })).filter((g) => g.links.length > 0);
}

/** The tabs of a group: every visible link of it, sidebar items first and related pages after. */
export const tabsOf = (links: NavLinkDef[], group: NavGroup): NavLinkDef[] => links.filter((l) => l.show && l.group === group);

/** Where a group opens: its first sidebar item. */
export const landingOf = (links: NavLinkDef[], group: NavGroup): NavLinkDef | null => links.find((l) => l.show && !l.tabOnly && l.group === group) ?? null;

/** The tab the current page is: the current link itself. */
export const activeTab = (_links: NavLinkDef[], current: NavLinkDef | null): NavLinkDef | null => current;

/** Is this sidebar item the one to highlight for the current page (the page itself, or a related page that lives under it)? */
export const isSidebarCurrent = (item: NavLinkDef, current: NavLinkDef | null): boolean =>
  current !== null && (linkKey(item) === linkKey(current) || (current.tabOnly === true && current.group === item.group && current.under === item.label));

/**
 * Exactly one link is current: the longest matching path, and among links that share a
 * path the one whose matchView accepts the ?view= value. A single visit (/visits/:id)
 * belongs to Visit records.
 */
export function currentLink(links: NavLinkDef[], pathname: string, search: string): NavLinkDef | null {
  const path = pathname.startsWith("/visits/") ? REPORTS_PATH : pathname;
  const view = new URLSearchParams(search).get("view");
  const matches = links
    .filter((l) => l.show)
    .filter((l) => (l.to === "/" ? path === "/" : path === l.to || path.startsWith(`${l.to}/`)))
    .filter((l) => !l.matchView || l.matchView(view));
  return matches.sort((a, b) => b.to.length - a.to.length)[0] ?? null;
}

export const linkKey = (l: Pick<NavLinkDef, "to" | "search">) => `${l.to}${l.search ?? ""}`;
