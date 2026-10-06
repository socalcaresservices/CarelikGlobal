import type { BillingReviewRow } from "@/lib/sv-backend";
import { VISIT_STATUS_LABEL } from "@/lib/service-verification";
import { APPROVAL_STATUS_LABEL, type ApprovalStatus } from "./billing-format";

// Billing review record filters. They decide which of the ALREADY LOADED rows are
// shown; they never change a record or any hour calculation. The date range is
// not handled here: it is sent to the server (GET /v1/billing-review), which
// returns every row in that range (no paging), so filtering the loaded rows
// covers the whole range. Show/hide columns is a different control (Visit
// records only) and is not touched.

export interface BillingFilters {
  client: string; // client code, or the name when the viewer may see names
  caregiver: string; // caregiver name
  service: string; // service name and code
  visitStatus: string; // service visit status
  approval: ApprovalStatus | "";
}

export const NO_FILTERS: BillingFilters = { client: "", caregiver: "", service: "", visitStatus: "", approval: "" };

export const clientKey = (r: BillingReviewRow) => r.clientCode ?? r.clientName ?? "";
export const clientLabel = (r: BillingReviewRow) => r.clientName ?? r.clientCode ?? "Client";
export const caregiverKey = (r: BillingReviewRow) => r.caregiverName ?? "";
export const serviceKey = (r: BillingReviewRow) => (r.serviceName ? `${r.serviceName} (${r.serviceCode})` : r.serviceCode);

export const activeFilterCount = (f: BillingFilters) => Object.values(f).filter(Boolean).length;

export function applyBillingFilters(rows: BillingReviewRow[], f: BillingFilters, approvalOf: (r: BillingReviewRow) => ApprovalStatus): BillingReviewRow[] {
  return rows.filter(
    (r) =>
      (!f.client || clientKey(r) === f.client) &&
      (!f.caregiver || caregiverKey(r) === f.caregiver) &&
      (!f.service || serviceKey(r) === f.service) &&
      (!f.visitStatus || r.visitStatus === f.visitStatus) &&
      (!f.approval || approvalOf(r) === f.approval),
  );
}

const distinct = (values: Array<[string, string]>) =>
  [...new Map(values.filter(([k]) => k).map(([k, l]) => [k, l] as const)).entries()].sort((a, b) => a[1].localeCompare(b[1]));

/** Choices come from the rows that were loaded for the date range, so every option matches at least one record. */
export function filterOptions(rows: BillingReviewRow[], approvalOf: (r: BillingReviewRow) => ApprovalStatus) {
  return {
    clients: distinct(rows.map((r) => [clientKey(r), clientLabel(r)])),
    caregivers: distinct(rows.map((r) => [caregiverKey(r), caregiverKey(r)])),
    services: distinct(rows.map((r) => [serviceKey(r), serviceKey(r)])),
    visitStatuses: distinct(rows.map((r) => [r.visitStatus, VISIT_STATUS_LABEL[r.visitStatus] ?? r.visitStatus])),
    approvals: distinct(rows.map((r) => [approvalOf(r), APPROVAL_STATUS_LABEL[approvalOf(r)]])),
  };
}
