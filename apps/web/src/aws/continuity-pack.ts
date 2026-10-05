import { formatDateOnly, formatWallClock } from "@/lib/service-verification";
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

/**
 * Continuity pack (0027) data, offline file builder and status. The server
 * decides the agency and the permission (continuity.export); this builds a
 * single offline HTML file from the server's answer. The file name carries no
 * client or caregiver names.
 */
export interface ContinuityPack {
  agency: string;
  timezone: string;
  data_as_of: string;
  exported_by: string;
  includes_client_names: boolean;
  outage_numbers: { first: number; last: number };
  shifts: Array<{ local_date: string; start: string; end: string; client_code: string; client_label: string | null; client_name: string | null; service: string | null; caregiver: string | null; caregiver_code: string | null; coverage: string }>;
  clients: Array<{ client_code: string; client_label: string | null; city: string | null; client_name: string | null }>;
  authorizations: Array<{ client_code: string; client_label: string | null; service: string | null; period_start: string; period_end: string; authorized_minutes: number; reserved_minutes: number; billable_minutes: number; review_minutes: number; remaining_minutes: number }>;
  caregivers: Array<{ caregiver_code: string; name: string; status: string }>;
}
export interface ContinuityStatus { lastDownloadedAt: string | null; lastDownloadedBy: string | null; hoursSince: number | string | null; downloadsLast7Days: number; outageNumbersIssued: number }

export const STALE_AFTER_HOURS = 24;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hrs = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
export const outageNumber = (n: number) => `OUT-${String(n).padStart(6, "0")}`;

export function continuityFileName(pack: Pick<ContinuityPack, "data_as_of" | "timezone">): string {
  const d = new Date(pack.data_as_of);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: pack.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return `ogevia-continuity-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}.html`;
}

/** A self-contained, printable file that opens in any browser without Ogevia. */
export function buildContinuityHtml(pack: ContinuityPack): string {
  // MM/DD/YYYY h:mm AM/PM in the pack's own agency zone (the file is read without Ogevia).
  const asOfParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: pack.timezone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true })
    .formatToParts(new Date(pack.data_as_of)).map((p) => [p.type, p.value]));
  const asOf = `${asOfParts.weekday} ${asOfParts.month}/${asOfParts.day}/${asOfParts.year} ${asOfParts.hour}:${asOfParts.minute} ${asOfParts.dayPeriod}`;
  const nameByCode = new Map(pack.clients.map((c) => [c.client_code, c.client_name]));
  const table = (head: string[], rows: string[][]) =>
    `<div class="tw"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
      rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${head.length}">None</td></tr>`
    }</tbody></table></div>`;
  const client = (code: string, label: string | null, name: string | null) => [code, label && label !== code ? label : "", name ?? ""].filter(Boolean).join(" · ");
  const numbers: string[] = [];
  for (let n = pack.outage_numbers.first; n <= pack.outage_numbers.last; n++) numbers.push(outageNumber(n));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Continuity pack: ${esc(pack.agency)}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;margin:16px;line-height:1.4}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:24px 0 8px;border-bottom:2px solid #0f172a}
.asof{font-size:18px;font-weight:700;background:#fef3c7;border:2px solid #b45309;padding:8px;margin:12px 0}
.tw{overflow-x:auto;max-width:100%}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #94a3b8;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#e2e8f0}.note{font-size:13px;color:#334155}.form{border:2px solid #0f172a;padding:8px;margin-top:8px;page-break-inside:avoid}
.form div{border-bottom:1px solid #94a3b8;padding:10px 0 2px}.nums{columns:3;font-family:ui-monospace,monospace;font-size:13px}.nums div{white-space:nowrap}
@media print{.pb{page-break-before:always}}
</style></head><body>
<h1>${esc(pack.agency)}: Ogevia continuity pack</h1>
<p class="asof">Data as of ${esc(asOf)} (${esc(pack.timezone)}). Anything changed in Ogevia after this time is NOT in this file.</p>
<p class="note">Downloaded by ${esc(pack.exported_by)}. CONFIDENTIAL: contains protected client information${pack.includes_client_names ? " including client names" : ""}.
Keep it only on agency-approved encrypted storage; delete or shred it when a newer pack replaces it. This file is not a billing record.</p>

<h2>Schedule: next 14 days</h2>
${table(["Date", "Time", "Client", "Service", "Caregiver", "Coverage"], pack.shifts.map((s) => [formatDateOnly(s.local_date), `${formatWallClock(s.start)}–${formatWallClock(s.end)}`, client(s.client_code, s.client_label, s.client_name), s.service ?? "", s.caregiver ? `${s.caregiver} (${s.caregiver_code ?? ""})` : "OPEN", s.coverage === "needs_coverage" ? "NEEDS COVERAGE" : s.coverage]))}

<h2>Authorized hours this month</h2>
<p class="note">"Remaining" already subtracts approved-eligible (billable) time and time reserved by scheduled shifts. Hours worked during an outage are not included until entered in Ogevia.</p>
${table(["Client", "Service", "Period", "Authorized", "Reserved", "Billable so far", "In review", "Remaining"], pack.authorizations.map((a) => [client(a.client_code, a.client_label, nameByCode.get(a.client_code) ?? null), a.service ?? "", `${formatDateOnly(a.period_start)} to ${formatDateOnly(a.period_end)}`, hrs(a.authorized_minutes), hrs(a.reserved_minutes), hrs(a.billable_minutes), hrs(a.review_minutes), hrs(a.remaining_minutes)]))}

<h2>Active clients</h2>
${table(["Client code", "Label", "City", "Name"], pack.clients.map((c) => [c.client_code, c.client_label ?? "", c.city ?? "", c.client_name ?? ""]))}

<h2>Care Team</h2>
${table(["Code", "Name", "Status"], pack.caregivers.map((c) => [c.caregiver_code, c.name, c.status]))}

<h2 class="pb">Outage visit records</h2>
<p class="note">Use ONE number per visit, in order, and never reuse a number. After Ogevia is back, the office enters each record once with its number. Ogevia refuses a number that was already entered, and it lists issued numbers that were never entered.
These numbers were issued to this agency only: ${esc(outageNumber(pack.outage_numbers.first))} to ${esc(outageNumber(pack.outage_numbers.last))}.</p>
<div class="nums">${numbers.map((n) => `<div>☐ ${esc(n)}</div>`).join("")}</div>
<div class="form"><strong>OUTAGE VISIT RECORD</strong> (copy one per visit)
<div>Record number: OUT-______</div><div>Client code:</div><div>Service:</div><div>Caregiver name:</div>
<div>Date:</div><div>Time in (from a clock):</div><div>Time out (from a clock):</div>
<div>Client/representative confirmation: ☐ signature below ☐ verbal ☐ unable to confirm ☐ declined</div>
<div>Client/representative signature and printed name:</div><div>Caregiver signature:</div><div>Notes:</div></div>
</body></html>`;
}

export function useContinuityStatus() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const enabled = Boolean(activeOrganizationId) && hasPermission("continuity.export");
  return useQuery({
    queryKey: ["aws-continuity-status", activeOrganizationId],
    enabled,
    queryFn: async () => (await api.get<{ status: ContinuityStatus | null }>("/v1/continuity/status", { organizationId: activeOrganizationId })).status,
  });
}

export function continuityState(status: ContinuityStatus | null | undefined): { stale: boolean; text: string } {
  if (!status?.lastDownloadedAt) return { stale: true, text: "No continuity pack has been downloaded yet" };
  const h = Number(status.hoursSince);
  const ago = h < 1 ? "less than an hour ago" : `${Math.floor(h)} hours ago`;
  return { stale: h >= STALE_AFTER_HOURS, text: `Continuity pack last downloaded ${ago} by ${status.lastDownloadedBy ?? "staff"}` };
}

