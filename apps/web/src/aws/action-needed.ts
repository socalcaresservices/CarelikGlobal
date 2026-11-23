import type { AttentionSummary } from "./aws-workspace";

// ACTION NEEDED: the one definition behind the header badge and the Home banner.
//
// The total is the SUM OF THE CATEGORY COUNTS below. It is not a count of unique
// visits: one visit can sit in two categories only if the server counts it in
// both, and this module never de-duplicates or recomputes a category. Every
// number comes from GET /v1/attention (one query, so the badge and Home share
// the same agency, the same refresh and the same values).
//
// A category the signed-in person may not see arrives as null/undefined from the
// server; it is not listed and adds nothing to the total.
//
// Reminders are NOT part of the total: Waiting for a signature and Documents
// expiring soon stay under REMINDERS on Home.

export const EXCEPTIONS_ROUTE = "/service-verification/reports?view=exceptions";
export const COMPLIANCE_ROUTE = "/compliance";

export interface ActionCategory {
  key: "missingClockOut" | "awaitingConfirmation" | "visitsToReview" | "signaturesToReview" | "unfilledShifts" | "caregiverHolds" | "overdueDocuments" | "documentsToReview" | "readyForApproval";
  label: string;
  count: number;
  to: string;
  hint: string;
}

const seen = (n: number | null | undefined): n is number => n !== null && n !== undefined;

/** The Action needed categories visible to this person, in display order. */
export function actionCategories(a: AttentionSummary): ActionCategory[] {
  const list: ActionCategory[] = [
    { key: "missingClockOut", label: "Missing Clock-Out", count: a.missingTimeOut, to: EXCEPTIONS_ROUTE, hint: "Still open past the shift end, or 12 h without a schedule" },
    { key: "awaitingConfirmation", label: "Awaiting Confirmation", count: a.notConfirmed, to: EXCEPTIONS_ROUTE, hint: "Ended over 48 hours ago, no client confirmation yet" },
    { key: "visitsToReview", label: "Visits to Review", count: a.needsReview, to: EXCEPTIONS_ROUTE, hint: "Unconfirmed, unscheduled, over the schedule rule or over the authorization; open each visit to review it" },
  ];
  if (seen(a.lateResponsesToReview)) {
    list.push({ key: "signaturesToReview", label: "Signatures to Review", count: a.lateResponsesToReview, to: "/billing-review", hint: "A client or representative answered a confirmation request; accept or reject it" });
  }
  if (seen(a.uncoveredShifts)) {
    list.push({ key: "unfilledShifts", label: "Unfilled Shifts", count: a.uncoveredShifts, to: "/schedule", hint: "Upcoming shifts that are open or called out and not replaced" });
  }
  if (a.complianceHolds !== null && a.complianceHolds !== undefined) {
    // Shifts to cover plus visits in progress. The hold never ends a visit: the office arranges safe coverage.
    const c = a.complianceHolds;
    list.push({
      key: "caregiverHolds",
      label: "Caregiver Holds",
      count: c.affectedShifts + c.inProgressVisits,
      to: COMPLIANCE_ROUTE,
      hint: `${c.holds} caregiver${c.holds === 1 ? "" : "s"} on a compliance hold. Cover their shifts${c.inProgressVisits > 0 ? " and the visit in progress" : ""}; nothing is cancelled for you`,
    });
  }
  if (seen(a.documentsBlocking)) {
    list.push({ key: "overdueDocuments", label: "Overdue Documents", count: a.documentsBlocking, to: "/documents", hint: "Staff credentials past their expiry or due date" });
    list.push({ key: "documentsToReview", label: "Documents to Review", count: a.documentsToReview ?? 0, to: "/documents", hint: "Uploaded, not yet verified" });
  }
  if (seen(a.billingReadyUnapproved)) {
    list.push({ key: "readyForApproval", label: "Ready for Approval", count: a.billingReadyUnapproved, to: "/billing-review", hint: "Visits that are Ready for Review and waiting for a person to approve them; approval is not submission or payment" });
  }
  return list;
}

/** missingClockOut + awaitingConfirmation + visitsToReview + signaturesToReview + unfilledShifts + caregiverHolds + overdueDocuments + documentsToReview + readyForApproval */
export function actionNeededTotal(a: AttentionSummary): number {
  return actionCategories(a).reduce((sum, c) => sum + c.count, 0);
}

export interface Reminder {
  label: string;
  count: number;
  to: string;
  hint: string;
}

/** Reminders: shown, never counted. Only non-zero reminders are listed. */
export function reminders(a: AttentionSummary): Reminder[] {
  return [
    ...(a.awaitingSignature ? [{ label: "Waiting for a Signature", count: a.awaitingSignature, to: "/billing-review", hint: "A confirmation was requested; the visit returns to Action needed if the request expires" }] : []),
    ...(a.documentsExpiring ? [{ label: "Documents Expiring Soon", count: a.documentsExpiring, to: "/documents", hint: "Within the agency's reminder days; not yet a problem" }] : []),
  ];
}

export type ActionNeededState =
  | { kind: "checking"; label: string; icon: string; count: null; aria: string }
  | { kind: "unknown"; label: string; icon: string; count: null; aria: string }
  | { kind: "attention"; label: string; icon: string; count: number; aria: string }
  | { kind: "clear"; label: string; icon: string; count: 0; aria: string };

/**
 * Red with a positive total, green only for a CONFIRMED zero, neutral while the
 * summary is loading or when it failed or is unavailable. Never a false zero.
 */
export function actionNeededState(loading: boolean, failed: boolean, summary: AttentionSummary | null | undefined): ActionNeededState {
  if (loading) return { kind: "checking", label: "Checking…", icon: "…", count: null, aria: "Checking items that need action" };
  if (failed || !summary) return { kind: "unknown", label: "Unavailable", icon: "!", count: null, aria: "Unavailable: items that need action could not be checked" };
  const count = actionNeededTotal(summary);
  if (count > 0) return { kind: "attention", label: "Action needed", icon: "⚠", count, aria: `Action needed: ${count}` };
  return { kind: "clear", label: "All clear", icon: "✓", count: 0, aria: "All clear: nothing needs action" };
}
