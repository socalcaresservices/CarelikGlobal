export interface QueueItem {
  shiftId: string; shiftRef: string; startsAt: string; endsAt: string; serviceCity: string | null; clientCode: string;
  postingState: "not_posted" | "posted" | "unposted"; roundNo: number | null; openSource: string | null; formerCaregiverCode: string | null;
  urgent: boolean; requestCount: number;
  delivery: { queued: number; sent: number; delivered: number; failed: number; unknown: number; suppressed: number; suppressedBy: Record<string, number> };
  escalationReasons: string[];
}
export interface CoverageRequest {
  requestId: string; orderPosition: number; requestedAt: string; caregiverRecordId: string; caregiverCode: string; caregiverName: string | null;
  eligible: boolean; blockers: string[]; preselected: boolean;
}

export const REASON_TEXT: Record<string, string> = {
  missing_city: "No service city. Set it before caregivers can see this shift.",
  no_recipients: "No qualified, opted-in caregiver to text. The shift is on the board; arrange coverage if needed.",
  sms_unavailable: "Texting is off or not set up for this agency. The shift is still on the board.",
  all_sends_failed: "No text went out. The shift is still on the board.",
  unfilled_soon: "Still unfilled close to the start time.",
};
const SUPPRESS_TEXT: Record<string, string> = {
  quota_exceeded: "monthly text limit reached", no_consent: "no text consent", opted_out: "opted out", sms_disabled: "texting off", sender_unavailable: "sender not available",
  not_entitled: "texting not in plan", ineligible: "no longer eligible", caregiver_inactive: "caregiver inactive", round_closed: "opening closed", shift_not_open: "shift no longer open",
};
export const deliverySummary = (d: QueueItem["delivery"]) => {
  const parts = [d.delivered && `${d.delivered} delivered`, d.sent && `${d.sent} sent`, d.queued && `${d.queued} waiting`, d.failed && `${d.failed} failed`, d.unknown && `${d.unknown} outcome unknown`,
    ...Object.entries(d.suppressedBy ?? {}).map(([k, n]) => `${n} not sent (${SUPPRESS_TEXT[k] ?? k})`)].filter(Boolean);
  return parts.length ? parts.join(", ") : "No texts";
};

