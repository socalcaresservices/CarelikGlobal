// Navigation model for the AWS shell: which links exist, which group each belongs to,
// and which one is current. Pure, so it can be tested without rendering the shell.
//
// This file changes presentation only. The links, destinations and the permission
// conditions that decide who sees them are the ones the horizontal menu already had
// (see aws-shell.tsx, where each `show` is computed from the same permissions).

import type { LucideIcon } from "lucide-react";

// Five primary sections for agency staff (Home, Schedule, People, Operations, Settings); a caregiver sees only their own day
// ("My work"). Each section lists its tabs (links without `parent`); a tab may keep smaller links under it (`parent` = the tab's label),
// so no existing page loses its place. The same tabs are shown as a horizontal tab strip above the page (see aws-shell.tsx).
// Visits = records of care delivered and the caregiver-side verification entry points. Approvals = decisions a person must make.
// No queue appears under both (docs/releases/2026-10-19-review-updates/ROUTE_MAP.md).
export const NAV_GROUPS = ["My work", "Home", "Schedule", "People", "Operations", "Settings"] as const;
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
  icon: LucideIcon;
  /** A smaller link shown under its tab (the label of the tab it belongs to, in the same section). */
  parent?: string;
  /** A label with no page of its own: drawn as text, never a link, never current. */
  heading?: boolean;
  /** Workflow colour of the area: Clients blue, Caregivers teal, Scheduling violet, Approvals amber, Reports slate. */
  accent?: string;
  /** Narrows a shared path: given the ?view= value, is this link the current one? */
  matchView?: (view: string | null) => boolean;
}

export const isReportView = (view: string | null) => !!view && REPORT_VIEWS_AS_REPORTS.has(view);
export const isCalendarView = (view: string | null) => view === "calendar";
export const isExceptionsView = (view: string | null) => view === "exceptions";
export const isVisitListView = (view: string | null) => !isReportView(view) && !isCalendarView(view) && !isExceptionsView(view);

export function visibleGroups(links: NavLinkDef[]): { group: NavGroup; links: NavLinkDef[] }[] {
  const shown = links.filter((l) => l.show);
  return NAV_GROUPS.map((group) => ({ group, links: shown.filter((l) => l.group === group) })).filter((g) => g.links.length > 0);
}

/** The tabs of a section: its visible links that are not smaller links under another tab. */
export const tabsOf = (links: NavLinkDef[], group: NavGroup): NavLinkDef[] => links.filter((l) => l.show && l.group === group && !l.parent && !l.heading);

/** Where a section opens: its first tab. */
export const landingOf = (links: NavLinkDef[], group: NavGroup): NavLinkDef | null => tabsOf(links, group)[0] ?? null;

/** The tab the current page belongs to: the current link itself, or the tab it sits under. */
export function activeTab(links: NavLinkDef[], current: NavLinkDef | null): NavLinkDef | null {
  if (!current) return null;
  if (!current.parent) return current;
  return links.find((l) => l.show && l.group === current.group && !l.parent && l.label === current.parent) ?? current;
}

/**
 * Exactly one link is current: the longest matching path, and among links that share a
 * path the one whose matchView accepts the ?view= value. A single visit (/visits/:id)
 * belongs to Visit records.
 */
export function currentLink(links: NavLinkDef[], pathname: string, search: string): NavLinkDef | null {
  const path = pathname.startsWith("/visits/") ? REPORTS_PATH : pathname;
  const view = new URLSearchParams(search).get("view");
  const matches = links
    .filter((l) => l.show && !l.heading)
    .filter((l) => (l.to === "/" ? path === "/" : path === l.to || path.startsWith(`${l.to}/`)))
    .filter((l) => !l.matchView || l.matchView(view));
  return matches.sort((a, b) => b.to.length - a.to.length)[0] ?? null;
}

export const linkKey = (l: Pick<NavLinkDef, "to" | "search">) => `${l.to}${l.search ?? ""}`;
