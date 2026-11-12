// The one issue list (0073): types and the destination of each recommended action. Context (shift, visit, caregiver) travels in the link so nothing is re-entered.
import { nameWithCode } from "./name-label";
export type IssueSeverity = "critical" | "urgent" | "routine";
export interface ActionIssue {
  issueKey: string; kind: string; reason: string; queue: string; category: string; severity: IssueSeverity;
  deadline: string | null; since: string | null; shiftId: string | null; visitId: string | null; entityId: string; caregiverRecordId: string | null; clientId: string | null; serviceId: string | null;
  clientCode: string | null; caregiverCode: string | null; serviceCode: string | null; status: "open"; firstSeenAt: string | null; reopenCount: number | null;
  action: string; recommendedAction: string;
  /** reason over_limit only (0084): minutes committed above the monthly authorization, and the authorization, for the agency-local month. */
  overLimitMinutes?: number | null; authorizedMinutes?: number | null;
  /** Names-first (F01/I07): present only when the server says this caller may see them. The codes above stay on the row for support. */
  clientName?: string; duplicateName?: boolean; caregiverName?: string; caregiverDuplicateName?: boolean;
}

/** Client shown by name (code beside it only when the name is shared); the code alone when no name is visible to this role. */
export const issueClient = (i: Pick<ActionIssue, "clientName" | "clientCode" | "duplicateName">): string | null =>
  i.clientName ? nameWithCode(i.clientName, i.clientCode, i.duplicateName) : i.clientCode;
export const issueCaregiver = (i: Pick<ActionIssue, "caregiverName" | "caregiverCode" | "caregiverDuplicateName">): string | null =>
  i.caregiverName ? nameWithCode(i.caregiverName, i.caregiverCode, i.caregiverDuplicateName) : i.caregiverCode;
export interface IssueList {
  asOf: string; matching: number; limit: number; offset: number;
  counts: { total: number; critical: number; urgent: number; routine: number; actionNeeded: number; byQueue: Record<string, number> };
  issues: ActionIssue[];
}
export const SEVERITY_TONE = { critical: "red", urgent: "amber", routine: "neutral" } as const;
export const QUEUE_LABEL: Record<string, string> = {
  needs_attention_now: "Needs attention now", upcoming_staffing: "Upcoming staffing", documents_compliance: "Documents & compliance", visit_review: "Visit review",
  ready_for_approval: "Ready for approval", pickup_requests: "Pickup requests", reconciliation: "Shifts to reconcile", authorization_changes: "Authorization changes",
};
export const CATEGORY_LABEL: Record<string, string> = { coverage: "Coverage", visits: "Visits", documents: "Documents", compliance: "Compliance", authorization: "Authorization", staffing: "Staffing" };
export const KIND_LABEL: Record<string, string> = { authorization: "Over limit", shift: "Shift", visit: "Visit", document: "Document", caregiver: "Caregiver", pickup_request: "Pickup request", impact: "Authorization change" };

/** Where the primary action goes, with the issue's context in the link. Permissions are still enforced by the server on every request. */
export function issueDestination(i: ActionIssue): { to: string; label: string } {
  if (i.kind === "business_document") return { to: "/business-compliance", label: "Review renewals" };
  const visit = i.visitId ?? i.entityId;
  switch (i.action) {
    case "assign_caregiver": return { to: `/schedule?coverage=1&shift=${i.shiftId ?? i.entityId}${i.deadline ? `&at=${encodeURIComponent(i.deadline)}` : ""}`, label: "Choose a caregiver" };
    case "review_hold": return { to: i.caregiverRecordId ? `/care-team/${i.caregiverRecordId}` : "/compliance", label: "Review the hold" };
    case "review_documents": return { to: i.caregiverRecordId ? `/care-team/${i.caregiverRecordId}` : "/documents", label: "Review the documents" };
    case "arrange_coverage": return { to: `/visits/${visit}`, label: "Open the visit" };
    case "review_visit": case "follow_up_confirmation": case "wait_or_resend": case "review_authorization": return { to: `/visits/${visit}`, label: "Open the visit" };
    case "review_authorization_limit": return { to: i.clientId ? `/clients/${i.clientId}#authorizations` : "/clients", label: "Amend or add an authorization" };
    case "approve_billing": return { to: "/billing-review", label: "Go to billing review" };
    case "confirm_pickup": return { to: `/schedule?pickups=1&shift=${i.shiftId ?? ""}`, label: "Review the request" };
    case "reconcile_shift": return { to: `/schedule?reconcile=1&shift=${i.shiftId ?? i.entityId}${i.since ? `&at=${encodeURIComponent(i.since)}` : ""}`, label: "Reconcile the shift" };
    case "review_document": case "renew_document": case "request_renewal": case "follow_up_document": return { to: "/documents", label: "Open documents" };
    default: return { to: "/authorization-impacts", label: "Review the change" };
  }
}

/** The row's reason in a few words; the full recommended sentence stays in the row for screen readers and as the tooltip. */
const REASON_PHRASE: Record<string, string> = {
  business_document_renewal: "Renewal due",
  uncovered_open: "No caregiver", uncovered_called_out: "Called out", compliance_hold: "Caregiver on hold", documents_not_current: "Document not current", missing_clock_out: "Still open",
  in_progress_on_hold: "Visit on hold", pending_confirmation: "Awaiting confirmation", confirmation_overdue: "Confirmation overdue", needs_review: "Needs review", late_response: "Late response",
  ready_for_approval: "Ready to approve", authorization_decreased: "Authorization lowered", pending_pickup: "Pickup requested", expired: "Expired", overdue: "Overdue", review_overdue: "Review overdue",
  awaiting_review: "Awaiting review", expiring: "Expiring", rejected: "Rejected", reconcile_unreconciled: "No visit record", reconcile_awaiting_record: "Awaiting record",
};
export function reasonPhrase(i: Pick<ActionIssue, "reason" | "overLimitMinutes">): string {
  if (i.reason === "over_limit" && i.overLimitMinutes) return `Over by ${Math.round((i.overLimitMinutes / 60) * 100) / 100} h`;
  return REASON_PHRASE[i.reason] ?? "";
}
