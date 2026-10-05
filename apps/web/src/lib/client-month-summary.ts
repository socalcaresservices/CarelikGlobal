// One client's month for the printable calendar: caregiver and service
// subtotals built from exactly the visits the day grid counts, a cross-check
// against the server's per-service totals, and the work that is not counted
// yet (still open or awaiting confirmation) listed separately.
import type { MonthlyServiceSummaryRow, VisitReportRow } from "@/lib/sv-backend";

/** Visits that count: confirmed (signed) and in review. Replaced originals
 *  ("corrected") and voided visits are excluded, so a correction is never
 *  counted twice. */
export const COUNTED_STATUSES = new Set(["signed", "administrator_review"]);
/** Not finished yet: listed separately, never added to the totals. */
export const INCOMPLETE_STATUSES = new Set(["draft", "awaiting_signature"]);

export interface CaregiverMonthRow {
  caregiverUserId: string;
  caregiverName: string;
  minutesByService: Map<string, number>;
  totalMinutes: number;
}

export interface ServiceCheck {
  serviceId: string;
  serviceName: string;
  calendarMinutes: number;
  /** null when the server summary has no row for this service. */
  serverMinutes: number | null;
}

export interface ClientMonthSummary {
  counted: VisitReportRow[];
  incomplete: VisitReportRow[];
  services: Array<{ serviceId: string; serviceName: string }>;
  caregivers: CaregiverMonthRow[];
  dailyTotalMinutes: number;
  caregiverTotalMinutes: number;
  billableTotalMinutes: number;
  checks: ServiceCheck[];
  /** Daily grid, caregiver summary and the server's service totals agree to the minute. */
  reconciles: boolean;
}

export function buildClientMonthSummary(
  rows: VisitReportRow[],
  monthValue: string,
  serverRows: MonthlyServiceSummaryRow[] | null,
): ClientMonthSummary {
  const inMonth = rows.filter((row) => row.service_date.startsWith(`${monthValue}-`));
  const counted = inMonth
    .filter((row) => COUNTED_STATUSES.has(row.status))
    .sort((a, b) => a.service_date.localeCompare(b.service_date) || a.time_in.localeCompare(b.time_in));
  const incomplete = inMonth
    .filter((row) => INCOMPLETE_STATUSES.has(row.status))
    .sort((a, b) => a.service_date.localeCompare(b.service_date) || a.time_in.localeCompare(b.time_in));

  const services = new Map<string, string>();
  const caregivers = new Map<string, CaregiverMonthRow>();
  const calendarByService = new Map<string, number>();
  let dailyTotalMinutes = 0;
  let billableTotalMinutes = 0;
  for (const row of counted) {
    const minutes = row.worked_minutes ?? 0;
    services.set(row.service_id, row.service_name);
    dailyTotalMinutes += minutes;
    billableTotalMinutes += row.billable_minutes ?? 0;
    calendarByService.set(row.service_id, (calendarByService.get(row.service_id) ?? 0) + minutes);
    const cg = caregivers.get(row.caregiver_user_id) ?? {
      caregiverUserId: row.caregiver_user_id,
      caregiverName: row.caregiver_name,
      minutesByService: new Map<string, number>(),
      totalMinutes: 0,
    };
    cg.minutesByService.set(row.service_id, (cg.minutesByService.get(row.service_id) ?? 0) + minutes);
    cg.totalMinutes += minutes;
    caregivers.set(row.caregiver_user_id, cg);
  }
  const caregiverTotalMinutes = Array.from(caregivers.values()).reduce((t, c) => t + c.totalMinutes, 0);

  const serverByService = new Map<string, number>();
  for (const row of serverRows ?? []) {
    if (!services.has(row.serviceId)) services.set(row.serviceId, row.serviceName);
    serverByService.set(row.serviceId, (serverByService.get(row.serviceId) ?? 0) + row.workedMinutes);
  }
  const serviceList = Array.from(services.entries())
    .map(([serviceId, serviceName]) => ({ serviceId, serviceName }))
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName));
  const checks = serviceList.map(({ serviceId, serviceName }) => ({
    serviceId,
    serviceName,
    calendarMinutes: calendarByService.get(serviceId) ?? 0,
    serverMinutes: serverRows ? (serverByService.get(serviceId) ?? null) : null,
  }));
  const reconciles =
    dailyTotalMinutes === caregiverTotalMinutes &&
    serverRows !== null &&
    checks.every((c) => c.calendarMinutes === (c.serverMinutes ?? 0));

  return {
    counted,
    incomplete,
    services: serviceList,
    caregivers: Array.from(caregivers.values()).sort((a, b) => a.caregiverName.localeCompare(b.caregiverName)),
    dailyTotalMinutes,
    caregiverTotalMinutes,
    billableTotalMinutes,
    checks,
    reconciles,
  };
}
