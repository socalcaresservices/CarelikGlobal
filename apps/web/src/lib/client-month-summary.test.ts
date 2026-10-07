// Calendar summary: caregiver and service totals come from the same counted
// visits as the day grid, and agree with the server. SYNTHETIC data only.
import { describe, expect, it } from "vitest";
import type { MonthlyServiceSummaryRow, VisitReportRow } from "@/lib/sv-backend";
import { buildClientMonthSummary } from "./client-month-summary";

let n = 0;
function visit(p: Partial<VisitReportRow>): VisitReportRow {
  n += 1;
  return {
    id: `v${n}`, visit_number: `V-${n}`, client_id: "c1", client_code: "CL-1", client_legal_name: "Synthetic Client",
    caregiver_user_id: "cg1", caregiver_name: "Synthetic Ana", service_id: "s1", service_name: "Respite",
    service_date: "2026-10-04", time_in: `2026-10-04T16:${String(n).padStart(2, "0")}:00Z`, time_out: null,
    worked_minutes: 60, verified_minutes: 60, billable_minutes: 60, status: "signed", authorization_status: "within_authorization",
    signed_at: null, original_visit_id: null, is_corrected: false, month_to_date_before_minutes: null,
    month_to_date_after_minutes: null, remaining_minutes: null, ...p,
  } as VisitReportRow;
}
const server = (serviceId: string, serviceName: string, workedMinutes: number): MonthlyServiceSummaryRow => ({
  clientId: "c1", clientCode: "CL-1", serviceId, serviceCode: serviceId.toUpperCase(), serviceName, authorizationLineageId: `l-${serviceId}`,
  authorizationPeriodStart: "2026-10-01", authorizationPeriodEnd: "2026-10-31", authorizedMinutes: 600, workedMinutes,
  verifiedMinutes: workedMinutes, billableMinutes: workedMinutes, remainingMinutes: 0, reviewMinutes: 0, visitCount: 1,
});

describe("buildClientMonthSummary", () => {
  const rows = [
    visit({ worked_minutes: 61, billable_minutes: 61 }),
    visit({ caregiver_user_id: "cg2", caregiver_name: "Synthetic Ben", worked_minutes: 1, billable_minutes: 1, service_date: "2026-10-05" }),
    visit({ caregiver_user_id: "cg2", caregiver_name: "Synthetic Ben", service_id: "s2", service_name: "Personal care", worked_minutes: 45, billable_minutes: 30, status: "administrator_review" }),
    visit({ worked_minutes: 999, status: "corrected" }), // replaced original
    visit({ worked_minutes: 500, status: "voided" }),
    visit({ worked_minutes: null, status: "draft" }), // still open
    visit({ worked_minutes: 20, status: "awaiting_signature" }),
    visit({ worked_minutes: 30, service_date: "2026-11-01" }), // other month
  ];

  it("counts signed and in-review visits only; replaced, voided and other months are excluded", () => {
    const s = buildClientMonthSummary(rows, "2026-10", [server("s1", "Respite", 62), server("s2", "Personal care", 45)]);
    expect(s.counted.map((r) => r.worked_minutes)).toEqual([61, 45, 1]);
    expect(s.dailyTotalMinutes).toBe(107);
    expect(s.caregiverTotalMinutes).toBe(107);
    expect(s.billableTotalMinutes).toBe(92);
    expect(s.incomplete.map((r) => r.status)).toEqual(["draft", "awaiting_signature"]);
  });

  it("gives each caregiver by name, minutes per service and a total, to the minute", () => {
    const s = buildClientMonthSummary(rows, "2026-10", null);
    expect(s.caregivers.map((c) => [c.caregiverName, c.totalMinutes, Object.fromEntries(c.minutesByService)])).toEqual([
      ["Synthetic Ana", 61, { s1: 61 }],
      ["Synthetic Ben", 46, { s1: 1, s2: 45 }],
    ]);
    expect(s.services).toEqual([{ serviceId: "s2", serviceName: "Personal care" }, { serviceId: "s1", serviceName: "Respite" }]);
  });

  it("reconciles with the server's service totals; any difference, or no server totals, is not reconciled", () => {
    expect(buildClientMonthSummary(rows, "2026-10", [server("s1", "Respite", 62), server("s2", "Personal care", 45)]).reconciles).toBe(true);
    const off = buildClientMonthSummary(rows, "2026-10", [server("s1", "Respite", 63), server("s2", "Personal care", 45)]);
    expect(off.reconciles).toBe(false);
    expect(off.checks.find((c) => c.serviceId === "s1")).toMatchObject({ calendarMinutes: 62, serverMinutes: 63 });
    expect(buildClientMonthSummary(rows, "2026-10", null).reconciles).toBe(false);
  });

  it("a service with an authorization but no visits shows 0 and still reconciles", () => {
    const s = buildClientMonthSummary(rows, "2026-10", [server("s1", "Respite", 62), server("s2", "Personal care", 45), server("s3", "Day care", 0)]);
    expect(s.checks.find((c) => c.serviceId === "s3")).toMatchObject({ calendarMinutes: 0, serverMinutes: 0 });
    expect(s.reconciles).toBe(true);
  });
});
