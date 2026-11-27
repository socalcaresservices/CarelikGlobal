// What an open-shift alert is about right now, for the notification card and the page it opens. Statuses come from the server (0120), per caregiver.
export type CoverStatus = "open" | "requested" | "yours" | "filled" | "cancelled" | "started" | "closed" | "unavailable";
export interface CoverShiftSummary { shiftId: string; status: CoverStatus; startsAt: string; endsAt: string; city: string | null; serviceName: string | null; officeName: string | null; minutes: number }

/** Short label on the card and on the shift page. */
export const STATUS_LABEL: Record<CoverStatus, string> = {
  open: "Open — you can request it",
  requested: "Requested — waiting for the office",
  yours: "You are confirmed",
  filled: "Filled",
  cancelled: "Cancelled",
  started: "Shift already started",
  closed: "Closed",
  unavailable: "Not available to you",
};
/** Longer sentence for the shift page when the shift cannot be requested. */
export const STATUS_SENTENCE: Record<CoverStatus, string> = {
  open: "This shift is open.",
  requested: "Requested — waiting for the office. The shift is not yours until they confirm it.",
  yours: "You are confirmed for this shift. It is in your list below.",
  filled: "Filled. Someone else was confirmed for this shift. No action needed.",
  cancelled: "Cancelled. Nothing more is needed from you.",
  started: "Shift already started. It can't be requested now.",
  closed: "Closed. This shift is no longer open.",
  unavailable: "This shift isn't available to you.",
};
/** Can the caregiver still do something about it? */
export const isActionable = (s: CoverStatus | undefined) => s === "open" || s === "requested";
export const STATUS_TONE: Record<CoverStatus, string> = {
  open: "bg-sky-100 text-sky-900", requested: "bg-amber-100 text-amber-900", yours: "bg-emerald-100 text-emerald-900",
  filled: "bg-slate-200 text-slate-800", cancelled: "bg-slate-200 text-slate-800", started: "bg-slate-200 text-slate-800", closed: "bg-slate-200 text-slate-800", unavailable: "bg-slate-200 text-slate-800",
};
