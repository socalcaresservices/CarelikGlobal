import type { BillingState } from "@/lib/sv-backend";

/** Billing review formatting (agency time zone; MM/DD/YYYY; AM/PM; minutes with decimal hours). */
export function formatUsDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}

export function formatClock(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true });
}

/** `1 min (0.02 hr)`, `1 h 30 min (1.50 hr)`. */
export function formatDuration(minutes: number | null | undefined): string {
  const m = Math.max(0, Math.round(minutes ?? 0));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const words = h === 0 ? `${m} min` : rest === 0 ? `${h} h` : `${h} h ${rest} min`;
  return `${words} (${(m / 60).toFixed(2)} hr)`;
}

/** The billing states (0062), decided by the server. Approval is not submission or payment; "Already Billed" does not exist. */
export type ApprovalStatus = BillingState;
export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  needs_correction: "Needs Correction",
  waiting_for_signature: "Waiting for signature",
  late_response_to_review: "Signature received — review it",
  ready_for_review: "Ready for Review",
  approved_for_billing: "Approved for Billing",
  voided: "Voided",
  reviewed_not_billable: "Reviewed — not billable",
};
/** One plain line under the state, so nobody reads approval as submission or payment. */
export const APPROVAL_STATUS_NOTE: Partial<Record<ApprovalStatus, string>> = {
  approved_for_billing: "Not submitted or paid",
  ready_for_review: "Not yet approved",
  voided: "Approval voided; it can be approved again",
  needs_correction: "Resolve before it can be approved",
  reviewed_not_billable: "Closed; nothing to bill",
};
export const APPROVAL_STATUS_CLASS: Record<ApprovalStatus, string> = {
  approved_for_billing: "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200",
  ready_for_review: "bg-sky-50 text-sky-900 ring-1 ring-sky-200",
  needs_correction: "bg-amber-50 text-amber-900 ring-1 ring-amber-200",
  reviewed_not_billable: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
  waiting_for_signature: "bg-violet-50 text-violet-900 ring-1 ring-violet-200",
  late_response_to_review: "bg-amber-50 text-amber-900 ring-1 ring-amber-200",
  voided: "bg-rose-50 text-rose-900 ring-1 ring-rose-200",
};

/**
 * The state of a row. The server's answer (0062) is used when present; for an older server the same rules are applied to what the row carries.
 * `hasActiveApproval` is only needed for that fallback.
 */
export function billingStateOf(r: { billingState?: BillingState | null; reviewState: string }, hasActiveApproval = false): ApprovalStatus {
  if (r.billingState) return r.billingState;
  if (hasActiveApproval) return "approved_for_billing";
  if (r.reviewState === "ready" || r.reviewState === "reviewed_eligible") return "ready_for_review";
  if (r.reviewState === "awaiting_signature") return "waiting_for_signature";
  if (r.reviewState === "late_response_to_review") return "late_response_to_review";
  return r.reviewState === "reviewed_not_billable" ? "reviewed_not_billable" : "needs_correction";
}

/** The most minutes a person may approve: the server's eligible minutes when given, else billable. */
export const approvableMinutes = (r: { eligibleMinutes?: number | null; billableMinutes: number | null }) => r.eligibleMinutes ?? r.billableMinutes ?? 0;

export function visitScheduleLabel(mode: "fixed" | "flexible" | null | undefined, shiftId: string | null | undefined): string {
  if (shiftId) return "From a scheduled shift";
  if (mode === "flexible") return "Flexible visit — no shift required";
  return "Unscheduled visit";
}
