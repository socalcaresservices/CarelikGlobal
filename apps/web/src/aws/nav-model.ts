// Navigation model for the AWS shell: which links exist, which group each belongs to,
// and which one is current. Pure, so it can be tested without rendering the shell.
//
// This file changes presentation only. The links, destinations and the permission
// conditions that decide who sees them are the ones the horizontal menu already had
// (see aws-shell.tsx, where each `show` is computed from the same permissions).

import type { LucideIcon } from "lucide-react";

// Organised by workflow. HOME is a single link shown without a heading.
//   MY WORK  the caregiver's own day: verify a visit, my shifts, availability, my documents.
//   WORK     in this order: Schedule, Visits, Approvals, Clients, Caregivers, Documents, Reports. Related pages
//            (shift requests, visit records ...) sit under their area as smaller links.
//   SETUP    Settings and what belongs to it, always last (pinned to the bottom of the menu).
// Visits = records of care delivered and the caregiver-side verification entry points. Approvals = decisions a
// person must make. No queue appears under both (docs/releases/2026-10-19-review-updates/ROUTE_MAP.md).
export const NAV_GROUPS = ["HOME", "MY WORK", "WORK", "SETUP"] as const;
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
  /** A smaller link shown under its area (the label of the primary row it belongs to). */
  parent?: string;
  /** A section label with no page of its own (for example Visits): drawn as text, never a link, never current. Its children stay reachable when the menu is collapsed. */
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

/** Collapsed menu: the smaller links are hidden, except under a section label (it has no page of its own, so they would be unreachable). */
export function shownWhenCollapsed(l: NavLinkDef, links: NavLinkDef[]): boolean {
  return !l.parent || links.some((p) => p.show && p.heading && p.label === l.parent);
}

export function visibleGroups(links: NavLinkDef[]): { group: NavGroup; links: NavLinkDef[] }[] {
  const shown = links.filter((l) => l.show);
  return NAV_GROUPS.map((group) => ({ group, links: shown.filter((l) => l.group === group) })).filter((g) => g.links.length > 0);
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
