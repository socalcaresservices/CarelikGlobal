import type { MonthlyServiceSummaryRow } from "@/lib/sv-backend";

/**
 * Only the CURRENT authorization of a service counts as authorized time. A replaced authorization is a historical record: it is never added to, or listed beside,
 * the current one. Current = the authorization of that service with the latest period start (then latest period end). Worked, billable and reserved time that
 * belongs to an earlier authorization stays visible in the totals table (its hours are never hidden), but it carries no authorized time.
 */
export function currentAuthorizationIds(rows: MonthlyServiceSummaryRow[]): Set<string> {
  const best = new Map<string, MonthlyServiceSummaryRow>();
  for (const r of rows) {
    const cur = best.get(r.serviceId);
    const newer = !cur || r.authorizationPeriodStart > cur.authorizationPeriodStart || (r.authorizationPeriodStart === cur.authorizationPeriodStart && r.authorizationPeriodEnd > cur.authorizationPeriodEnd);
    if (newer) best.set(r.serviceId, r);
  }
  return new Set([...best.values()].map((r) => r.authorizationLineageId));
}
