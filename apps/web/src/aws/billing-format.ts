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

export type ApprovalStatus = "approved" | "awaiting" | "review" | "not_billable" | "awaiting_signature" | "late_response";
export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  approved: "Approved — not submitted",
  awaiting: "Awaiting approval",
  review: "Needs review",
  not_billable: "Reviewed — not billable",
  awaiting_signature: "Waiting for signature",
  late_response: "Signature received — review it",
};
export const APPROVAL_STATUS_CLASS: Record<ApprovalStatus, string> = {
  approved: "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200",
  awaiting: "bg-sky-50 text-sky-900 ring-1 ring-sky-200",
  review: "bg-amber-50 text-amber-900 ring-1 ring-amber-200",
  not_billable: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
  awaiting_signature: "bg-violet-50 text-violet-900 ring-1 ring-violet-200",
  late_response: "bg-amber-50 text-amber-900 ring-1 ring-amber-200",
};

/** The most minutes a person may approve: the server's eligible minutes when given, else billable. */
export const approvableMinutes = (r: { eligibleMinutes?: number | null; billableMinutes: number | null }) => r.eligibleMinutes ?? r.billableMinutes ?? 0;

export function visitScheduleLabel(mode: "fixed" | "flexible" | null | undefined, shiftId: string | null | undefined): string {
  if (shiftId) return "From a scheduled shift";
  if (mode === "flexible") return "Flexible visit — no shift required";
  return "Unscheduled visit";
}
