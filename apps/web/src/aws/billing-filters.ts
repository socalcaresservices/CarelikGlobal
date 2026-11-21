import type { BillingReviewRow } from "@/lib/sv-backend";
import { nameWithCode } from "./name-label";
import { officeMatches } from "./offices";
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
  reason: string; // a review reason code (VIS-26: the office can narrow the list to one reason)
  office: string; // 0110: an office id ("none" = clients with no office); needs the offices release switch
}

export const NO_FILTERS: BillingFilters = { client: "", caregiver: "", service: "", visitStatus: "", approval: "", reason: "", office: "" };

/** Why a visit is held for review, in plain words. An unknown code is shown as its own words, never hidden. */
export const REVIEW_REASON_LABEL: Record<string, string> = {
  unscheduled: "Started with no scheduled shift",
  schedule_variance: "Worked time differs from the schedule",
  no_client_signature: "No client signature or mark",
  over_authorization: "Over the monthly authorization",
  authorization_decreased: "Authorization was decreased",
};
export const reviewReasonLabel = (code: string) => REVIEW_REASON_LABEL[code] ?? code.replace(/_/g, " ");

export const clientKey = (r: BillingReviewRow) => r.clientCode ?? r.clientName ?? "";
export const clientLabel = (r: BillingReviewRow) => (r.clientName ? nameWithCode(r.clientName, r.clientCode, r.clientNameDuplicate) : r.clientCode) ?? "Client";
export const caregiverKey = (r: BillingReviewRow) => r.caregiverName ?? "";
export const serviceKey = (r: BillingReviewRow) => (r.serviceName ? `${r.serviceName} (${r.serviceCode})` : r.serviceCode);

export const activeFilterCount = (f: BillingFilters) => Object.values(f).filter(Boolean).length;

/** officeOf gives the responsible office id of a row's client (undefined = none). Without it an office choice is ignored. */
export function applyBillingFilters(rows: BillingReviewRow[], f: BillingFilters, approvalOf: (r: BillingReviewRow) => ApprovalStatus, officeOf?: (r: BillingReviewRow) => string | undefined): BillingReviewRow[] {
  return rows.filter(
    (r) =>
      (!f.client || clientKey(r) === f.client) &&
      (!f.caregiver || caregiverKey(r) === f.caregiver) &&
      (!f.service || serviceKey(r) === f.service) &&
      (!f.visitStatus || r.visitStatus === f.visitStatus) &&
      (!f.approval || approvalOf(r) === f.approval) &&
      (!f.reason || (r.reviewReasons ?? []).includes(f.reason)) &&
      (!officeOf || officeMatches(f.office, officeOf(r))),
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
    reasons: distinct(rows.flatMap((r) => (r.reviewReasons ?? []).map((code): [string, string] => [code, reviewReasonLabel(code)]))),
  };
}
