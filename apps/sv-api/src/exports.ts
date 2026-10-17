// Server-generated report exports (0072). The file is built HERE from the report functions the caller is allowed to read, after the server has checked reports.export and
// written the request to the ledger; the ledger then records "generated" with the row count, byte count and SHA-256 of the file. Nothing here proves the file was downloaded.
import { createHash } from "node:crypto";
import type { Queryable } from "@carelik/auth/server";
import { ApiError } from "./errors";
import { toCamel } from "./routes";

export const REPORT_KEYS = ["client_service_calendar", "monthly_service_reconciliation", "correction_history", "monthly_chain"] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export interface ExportParams {
  monthStart?: string;
  clientId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  serviceId?: string | null;
  caregiverUserId?: string | null;
  correctedByUserId?: string | null;
  status?: string | null;
}

type Row = Record<string, any>;
const rowsOf = async (db: Queryable, sql: string, params: unknown[]): Promise<Row[]> => (await db.query(sql, params)).rows.map(toCamel) as Row[];

/** CSV for the full-chain report. Text cells that start with = + - @ or a control character get a leading apostrophe so a spreadsheet never runs them as a formula. */
export const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let t = String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
};
const CHAIN_COLUMNS: Array<[string, string]> = [
  ["Client code", "clientCode"], ["Service", "serviceCode"], ["Authorization version", "authorizationVersion"], ["Period start", "periodStart"], ["Period end", "periodEnd"],
  ["Authorized (min)", "authorizedMinutes"], ["Scheduled (min)", "scheduledMinutes"], ["Held for confirmation or review (min)", "heldReviewMinutes"], ["Needs reconciliation (min)", "needsReconciliationMinutes"],
  ["Reserved total (min)", "reservedMinutes"], ["Worked (min)", "workedMinutes"], ["Confirmed (min)", "confirmedMinutes"], ["Billable (min)", "billableMinutes"],
  ["Needs correction (min)", "needsCorrectionMinutes"], ["Waiting for client (min)", "waitingMinutes"], ["Ready for review (min)", "readyForReviewMinutes"],
  ["Approved for billing (min)", "approvedForBillingMinutes"], ["Reviewed - not billable (min)", "reviewedNotBillableMinutes"], ["Approved by a person (min)", "humanApprovedMinutes"],
  ["Needs correction (visits)", "needsCorrectionVisits"], ["Waiting (visits)", "waitingVisits"], ["Ready for review (visits)", "readyForReviewVisits"], ["Approved (visits)", "approvedVisits"], ["Voided approvals", "voidedApprovals"],
  ["Rounding adjustments (min)", "adjustmentMinutes"], ["Committed (min)", "committedMinutes"], ["Remaining (min, signed)", "remainingMinutes"], ["Over limit (min)", "overLimitMinutes"],
  ["Reserved adds up", "reservedOk"], ["Visits add up", "visitsOk"], ["Authorization adds up", "balanceOk"], ["Difference (min)", "differenceMinutes"],
];
export function chainCsv(data: Array<Record<string, unknown>>): string {
  const lines = [CHAIN_COLUMNS.map(([h]) => csvCell(h)).join(",")];
  for (const r of data) lines.push(CHAIN_COLUMNS.map(([, k]) => csvCell(r[k])).join(","));
  lines.push(csvCell("Submitted / billed is not part of this report: approval is not submission or payment."));
  return lines.join("\r\n");
}

const line = (cells: unknown[]) => cells.map(csvCell).join(",");
const iso = (v: unknown) => (v === null || v === undefined || v === "" ? "" : new Date(String(v)).toISOString());
const mins = (v: unknown) => (v === null || v === undefined ? "" : Number(v));

/** Names come only from the restricted directory: the server returns them to roles with clients.names.read and nothing to everyone else. */
async function clientNames(db: Queryable, org: string): Promise<Map<string, string>> {
  const dir = await rowsOf(db, "select * from ogevia_api.list_client_directory($1)", [org]);
  return new Map(dir.filter((c) => c.legalFirstName && c.legalLastName).map((c) => [String(c.clientId), `${c.legalFirstName} ${c.legalLastName}`]));
}

function withNames(rows: Row[], names: Map<string, string>) {
  const any = rows.some((r) => names.has(String(r.clientId)));
  return { header: any ? ["Client name", "Client code"] : ["Client code"], cells: (r: Row) => (any ? [names.get(String(r.clientId)) ?? "", r.clientCode] : [r.clientCode]) };
}

export interface Built { csv: string; rowCount: number }

export async function buildReportCsv(db: Queryable, org: string, report: ReportKey, p: ExportParams): Promise<Built> {
  if (report === "monthly_chain") {
    const data = await rowsOf(db, "select * from ogevia_api.get_monthly_chain_report($1, $2, $3)", [org, p.monthStart, p.clientId ?? null]);
    return { csv: chainCsv(data), rowCount: data.length };
  }
  if (report === "client_service_calendar" || report === "monthly_service_reconciliation") {
    if (report === "client_service_calendar" && !p.clientId) throw new Error("A client is required for the client service calendar.");
    const summary = await rowsOf(db, "select * from ogevia_api.list_monthly_service_summary($1, $2, $3)", [org, p.monthStart, p.clientId ?? null]);
    const names = await clientNames(db, org);
    const n = withNames(summary, names);
    const recon = report === "monthly_service_reconciliation";
    const approvals = recon ? new Map((await rowsOf(db, "select * from ogevia_api.list_monthly_approval_summary($1, $2, $3)", [org, p.monthStart, p.clientId ?? null])).map((a) => [String(a.authorizationLineageId), a])) : new Map<string, Row>();
    const header = [...n.header, "Service", "Authorization period start", "Authorization period end", "Authorized (min)", "Worked (min)", "Confirmed (min)", "Billable (min)",
      ...(recon ? ["Approved by a person (min)", "Approved rounding adjustment (min)"] : []),
      "Reserved - not yet worked or signed (min)", "Scheduled ahead or underway (min)", "Held for confirmation or review (min)", "Needs reconciliation (min)",
      "Remaining (min, signed)", "Over limit (min)", "Authorization tier", "In review (min worked)", ...(recon ? ["Worked minus billable (min)"] : [])];
    const lines = [line(header)];
    for (const r of summary) {
      const a = approvals.get(String(r.authorizationLineageId));
      lines.push(line([...n.cells(r), `${r.serviceCode} ${r.serviceName}`, r.authorizationPeriodStart, r.authorizationPeriodEnd, mins(r.authorizedMinutes), mins(r.workedMinutes), mins(r.verifiedMinutes), mins(r.billableMinutes),
        ...(recon ? [mins(a?.approvedMinutes ?? 0), mins(a?.roundingAdjustmentMinutes ?? 0)] : []),
        mins(r.reservedMinutes), mins(Number(r.reservedAheadMinutes ?? 0) + Number(r.reservedUnderwayMinutes ?? 0)), mins(r.reservedReviewMinutes), mins(r.reservedReconcileMinutes),
        mins(r.remainingMinutes), mins(r.overLimitMinutes), r.authorizationTier, mins(r.reviewMinutes), ...(recon ? [Math.max(0, Number(r.workedMinutes) - Number(r.billableMinutes))] : [])]));
    }
    return { csv: lines.join("\r\n"), rowCount: summary.length };
  }
  const corrections = await rowsOf(db, "select * from ogevia_api.list_correction_history_report($1, $2, $3, $4, $5, $6, $7, $8)",
    [org, p.dateFrom ?? null, p.dateTo ?? null, p.clientId ?? null, p.serviceId ?? null, p.caregiverUserId ?? null, p.correctedByUserId ?? null, p.status ?? null]);
  const names = await clientNames(db, org);
  const n = withNames(corrections, names);
  const snap = (s: Row | null | undefined, k: string) => (s ? (s[k] ?? s[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]) : undefined);
  const lines = [line(["Visit ref", ...n.header, "Service", "Service date", "Caregiver", "Original time in (UTC)", "Original time out (UTC)", "Corrected time in (UTC)", "Corrected time out (UTC)",
    "Original worked (min)", "Corrected worked (min)", "Corrected by", "Status", "Reason", "Corrected on (UTC)"])];
  for (const r of corrections) {
    lines.push(line([r.visitNumber, ...n.cells(r), `${r.serviceCode} ${r.serviceName}`, r.serviceDate, r.caregiverName,
      iso(snap(r.beforeSnapshot, "timeIn")), iso(snap(r.beforeSnapshot, "timeOut")), iso(snap(r.afterSnapshot, "timeIn")), iso(snap(r.afterSnapshot, "timeOut")),
      mins(snap(r.beforeSnapshot, "workedMinutes")), mins(snap(r.afterSnapshot, "workedMinutes")), r.correctedByName, r.correctedVisitStatus, r.reason, iso(r.createdAt)]));
  }
  return { csv: lines.join("\r\n"), rowCount: corrections.length };
}

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The file travels in the API response (Lambda's synchronous response limit is 6 MB). A larger one is refused and recorded as failed rather than cut short or silently truncated. */
export const MAX_EXPORT_BYTES = 4_000_000;
export function assertExportSize(bytes: number): void {
  if (bytes > MAX_EXPORT_BYTES) throw new ApiError(413, "export_too_large", "This export is too large to return in one file. Narrow the month or filters and try again. Nothing was returned.");
}
