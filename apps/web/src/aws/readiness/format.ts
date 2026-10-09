// Shared words and small pure helpers for the caregiver-readiness screens (availability, approved services,
// required documents, assignment checks, matching). One place for every label so screens never disagree.
// The server decides everything; this file only chooses the words.

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface HoursRange {
  weekday?: number | null;
  start_local: string;
  end_local: string;
}

/** "08:00" -> "8:00 AM". Invalid input is returned unchanged rather than guessed. */
export function timeLabel(value: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return value;
  const h = Number(m[1]);
  const minutes = m[2];
  return `${h % 12 === 0 ? 12 : h % 12}:${minutes} ${h < 12 ? "AM" : "PM"}`;
}

/** "8:00 AM – 8:00 PM"; a range that ends earlier than it starts runs overnight. */
export function rangeLabel(r: Pick<HoursRange, "start_local" | "end_local">): string {
  const overnight = r.end_local.slice(0, 5) < r.start_local.slice(0, 5);
  return `${timeLabel(r.start_local)} – ${timeLabel(r.end_local)}${overnight ? " (next day)" : ""}`;
}

/** All seven days with their ranges, in Sunday-first order, so a day with no hours is shown as such. */
export function weeklySummary(windows: HoursRange[]): { weekday: number; name: string; ranges: string[] }[] {
  return DAY_NAMES.map((name, weekday) => ({
    weekday,
    name,
    ranges: windows.filter((w) => w.weekday === weekday).sort((a, b) => a.start_local.localeCompare(b.start_local)).map(rangeLabel),
  }));
}

export const REQUEST_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  declined: "Declined",
  withdrawn: "Withdrawn",
  superseded: "Superseded",
};

export const REQUEST_STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-950",
  approved: "bg-emerald-100 text-emerald-950",
  declined: "bg-red-100 text-red-950",
  withdrawn: "bg-slate-100 text-slate-800",
  superseded: "bg-slate-100 text-slate-800",
};

export const SERVICE_STATE_LABEL: Record<string, string> = {
  approved: "Approved",
  revoked: "Revoked",
  expired: "Expired",
  not_started: "Not started",
};

/** Required-document status as the short label (and a detail line when the label alone would mislead). */
export function documentStatusLabel(code: string | null | undefined, requirement: "cpr" | "tb"): { label: string; detail: string | null; ok: boolean } {
  const name = requirement.toUpperCase();
  switch (code) {
    case "ok": return { label: "Current", detail: null, ok: true };
    case "missing": return { label: "Missing", detail: `${name} is not on file.`, ok: false };
    case "awaiting_review": return { label: "Needs review", detail: `${name} was uploaded and is waiting for an administrator.`, ok: false };
    case "rejected": return { label: "Unverified", detail: `${name} was rejected; upload a new one.`, ok: false };
    case "expired": return { label: "Expired", detail: `${name} has expired.`, ok: false };
    case "expires_during": return { label: "Expires soon", detail: `${name} ends before this work ends.`, ok: false };
    case "expiry_missing": return { label: "Needs review", detail: `${name} has no date to measure validity from.`, ok: false };
    case "policy_not_set":
    case "type_not_set": return { label: "Setup incomplete", detail: `The agency has not finished setting up the ${name} rule.`, ok: false };
    default: return { label: "Not provided", detail: null, ok: false };
  }
}

/** The check groups of the assignment panel, in the order they are shown. */
export const CHECK_GROUPS: { key: string; title: string; checks: string[] }[] = [
  { key: "availability", title: "Availability", checks: ["availability"] },
  { key: "service", title: "Approved services", checks: ["service"] },
  { key: "documents", title: "Documents", checks: ["cpr", "tb"] },
  { key: "conflicts", title: "Conflicts", checks: ["conflict", "client", "caregiver"] },
];

export interface CheckRow {
  check: string;
  status: "ok" | "blocked" | "overridden" | "not_checked";
  code: string | null;
  message: string | null;
  enforced: boolean;
  blocking: boolean;
}

/** One line per group: what is wrong (the server's exact words), what is fine, or what is not checked. */
export function groupOutcome(rows: CheckRow[], group: (typeof CHECK_GROUPS)[number]): { state: "ok" | "blocked" | "would_block" | "overridden" | "not_checked"; messages: string[] } {
  const mine = rows.filter((r) => group.checks.includes(r.check));
  const blocking = mine.filter((r) => r.blocking);
  if (blocking.length) return { state: "blocked", messages: blocking.map((r) => r.message ?? "Not ready.") };
  const wouldBlock = mine.filter((r) => r.status === "blocked");
  if (wouldBlock.length) return { state: "would_block", messages: wouldBlock.map((r) => r.message ?? "Not ready.") };
  if (mine.some((r) => r.status === "overridden")) return { state: "overridden", messages: mine.filter((r) => r.status === "overridden").map((r) => r.message ?? "Overridden.") };
  if (mine.length === 0 || mine.every((r) => r.status === "not_checked")) return { state: "not_checked", messages: [] };
  return { state: "ok", messages: [] };
}

export const ELIGIBILITY_LABEL: Record<string, string> = {
  eligible: "Eligible",
  partial: "Partly covered",
  not_eligible: "Not available",
};

/** "83.3% (provisional)" or "Score incomplete". Never a number the server did not compute. */
export function scoreLabel(score: { complete: boolean; label: string | null; total: number | null; ruleStatus?: string }): string {
  if (!score.complete || score.total === null || score.total === undefined) return score.label ?? "Score incomplete";
  return `${Number.isInteger(score.total) ? score.total : score.total.toFixed(1)}%${score.ruleStatus === "provisional" ? " (provisional)" : ""}`;
}

/** Extra context for an action error: keeps the server's words, never replaces them with a generic line. */
export function actionError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
