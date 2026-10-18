import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { SEVERITY_TONE, type ActionIssue, type IssueList } from "./action-issues";
import { REFRESH_MS } from "./attention";
import { useAwsApi } from "./aws-workspace";
import type { Shift } from "./schedule-page";

/** The current time, re-read every `ms` so "in progress" and "last updated" do not freeze on a page left open. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** Visits still to come or running now, soonest first. Finished and cancelled shifts are on the schedule, not here. */
export function todaysVisits(shifts: Shift[], now: number): Shift[] {
  return shifts
    .filter((s) => (s.coverageState === "covered" || s.coverageState === "needs_coverage") && Date.parse(s.endsAt) > now)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.shiftId < b.shiftId ? -1 : 1));
}

export const REASON_SHORT: Record<string, string> = {
  uncovered_open: "No caregiver", uncovered_called_out: "Called out", compliance_hold: "Caregiver on a hold", documents_not_current: "Document not current",
  missing_clock_out: "Still open", in_progress_on_hold: "Caregiver on a hold",
};

/** The same server list as Action needed (limit 50, already ordered Critical, Urgent, Routine). One query feeds the panel and the highlights in Today's visits. */
export function useHomeIssues() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const allowed = hasPermission("visits.read") || hasPermission("shifts.manage") || hasPermission("documents.read") || hasPermission("readiness.read");
  return useQuery({
    queryKey: ["action-issues", "home", activeOrganizationId],
    queryFn: async () => api.get<IssueList>("/v1/action-issues", { organizationId: activeOrganizationId, limit: "50" }),
    enabled: !!activeOrganizationId && allowed,
    refetchInterval: REFRESH_MS,
  });
}

/** Today's visits: a shift whose caregiver is blocked (hold or document) is marked, not just an uncovered one (B1-R3). */
export function shiftIssueLabel(issues: ActionIssue[] | undefined, shiftId: string): { tone: "red" | "amber"; label: string } | null {
  const hit = (issues ?? []).filter((i) => i.shiftId === shiftId && i.severity !== "routine" && (i.reason === "compliance_hold" || i.reason === "documents_not_current"))
    .sort((a, b) => (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1))[0];
  return hit ? { tone: SEVERITY_TONE[hit.severity] as "red" | "amber", label: REASON_SHORT[hit.reason] ?? "Blocked" } : null;
}

/** A section a person can fold away on this device. Alerts are never inside one: they stay visible whatever the saved choice. */
export function useCollapsed(key: string): [boolean, () => void] {
  const { activeOrganizationId } = useOrganization();
  const storageKey = `ogevia.home.collapsed.${activeOrganizationId ?? "none"}.${key}`;
  const read = () => { try { return window.localStorage.getItem(storageKey) === "1"; } catch { return false; } };
  const [collapsed, setCollapsed] = useState(read);
  useEffect(() => { setCollapsed(read()); }, [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return [collapsed, () => {
    const next = !collapsed;
    setCollapsed(next);
    try { window.localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* a blocked store only means the choice is not remembered */ }
  }];
}

