// The one issue list (0073): types and the destination of each recommended action. Context (shift, visit, caregiver) travels in the link so nothing is re-entered.
export type IssueSeverity = "critical" | "urgent" | "routine";
export interface ActionIssue {
  issueKey: string; kind: string; reason: string; queue: string; category: string; severity: IssueSeverity;
  deadline: string | null; since: string | null; shiftId: string | null; visitId: string | null; entityId: string; caregiverRecordId: string | null; clientId: string | null; serviceId: string | null;
  clientCode: string | null; caregiverCode: string | null; serviceCode: string | null; status: "open"; firstSeenAt: string | null; reopenCount: number | null;
  action: string; recommendedAction: string;
}
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
export const KIND_LABEL: Record<string, string> = { shift: "Shift", visit: "Visit", document: "Document", caregiver: "Caregiver", pickup_request: "Pickup request", impact: "Authorization change" };

/** Where the primary action goes, with the issue's context in the link. Permissions are still enforced by the server on every request. */
export function issueDestination(i: ActionIssue): { to: string; label: string } {
  const visit = i.visitId ?? i.entityId;
  switch (i.action) {
    case "assign_caregiver": return { to: `/schedule?coverage=1&shift=${i.shiftId ?? i.entityId}${i.deadline ? `&at=${encodeURIComponent(i.deadline)}` : ""}`, label: "Choose a caregiver" };
    case "review_hold": return { to: i.caregiverRecordId ? `/care-team/${i.caregiverRecordId}` : "/compliance", label: "Review the hold" };
    case "review_documents": return { to: i.caregiverRecordId ? `/care-team/${i.caregiverRecordId}` : "/documents", label: "Review the documents" };
    case "arrange_coverage": return { to: `/visits/${visit}`, label: "Open the visit" };
    case "review_visit": case "follow_up_confirmation": case "wait_or_resend": case "review_authorization": return { to: `/visits/${visit}`, label: "Open the visit" };
    case "approve_billing": return { to: "/billing-review", label: "Go to billing review" };
    case "confirm_pickup": return { to: `/schedule?pickups=1&shift=${i.shiftId ?? ""}`, label: "Review the request" };
    case "reconcile_shift": return { to: `/schedule?reconcile=1&shift=${i.shiftId ?? i.entityId}${i.since ? `&at=${encodeURIComponent(i.since)}` : ""}`, label: "Reconcile the shift" };
    case "review_document": case "renew_document": case "request_renewal": case "follow_up_document": return { to: "/documents", label: "Open documents" };
    default: return { to: "/authorization-impacts", label: "Review the change" };
  }
}
