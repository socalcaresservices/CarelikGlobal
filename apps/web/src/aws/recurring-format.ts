// Recurring shifts (0034): view-model types and pure helpers for the screens.
import { formatWallClock } from "@/lib/service-verification";

export interface Occurrence {
  localDate: string;
  startsAt: string;
  endsAt: string;
  minutes: number;
  monthStart: string;
  authorizationLineageId: string | null;
  authorizedMinutes: number | null;
  usedMinutes: number | null;
  reservedMinutes: number | null;
  seriesMinutesBefore: number | null;
  outcome: "ok" | "exceeds_authorization" | "no_authorization" | "caregiver_conflict" | "already_started" | "time_does_not_exist" | "time_occurs_twice"
    | "documents_not_current" | "service_not_approved" | "availability_outside" | "availability_not_provided" | "over_hour_limit";
}
/** 0053: how a series repeats beyond "these weekdays". Absent = every selected weekday, every week. */
export interface RepeatPattern { every_weeks?: number; anchor?: string; nth?: number[]; except_nth?: number[]; exclude_dates?: string[] }
export interface SeriesRow {
  seriesId: string;
  status: "active" | "ended";
  clientId: string;
  clientCode: string;
  clientName: string | null;
  serviceId: string;
  serviceName: string;
  serviceCode: string;
  caregiverRecordId: string | null;
  caregiverName: string | null;
  weekdays: number[];
  startTime: string;
  endTime: string;
  startsOn: string;
  endsOn: string | null;
  generatedThrough: string;
  upcomingOccurrences: number;
  skippedDates: Array<{ date: string; reason: string; minutes: number }>;
  pattern?: RepeatPattern | null;
}

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const OUTCOME_LABEL: Record<Occurrence["outcome"], string> = {
  ok: "Fits",
  exceeds_authorization: "Over the month's authorized hours",
  no_authorization: "No authorization covers this date",
  caregiver_conflict: "Caregiver already has a shift then",
  already_started: "Already started",
  time_does_not_exist: "This time does not exist that day (clocks move forward)",
  time_occurs_twice: "This time happens twice that day (clocks move back)",
  documents_not_current: "Caregiver's required documents are not current",
  service_not_approved: "Caregiver is not approved for this service",
  availability_outside: "Outside the caregiver's approved hours",
  availability_not_provided: "Caregiver has not provided availability",
  over_hour_limit: "Over the caregiver's hour limit",
};
export const monthLabel = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
export const hhmm = (t: string) => t.slice(0, 5);

export interface MonthSummary {
  monthStart: string;
  authorized: number | null;
  used: number | null;
  reserved: number | null;
  fits: number;
  fitsMinutes: number;
  flagged: Occurrence[];
  availableAfter: number | null;
}

/** Per month (and authorization) from the server's preview: what is already used/reserved, what this series adds, what is left. */
export function summarizeOccurrences(rows: Occurrence[]): MonthSummary[] {
  const out = new Map<string, MonthSummary>();
  for (const r of rows) {
    const k = `${r.monthStart}|${r.authorizationLineageId ?? "none"}`;
    const m = out.get(k) ?? { monthStart: r.monthStart, authorized: r.authorizedMinutes, used: r.usedMinutes, reserved: r.reservedMinutes, fits: 0, fitsMinutes: 0, flagged: [], availableAfter: null };
    if (r.outcome === "ok") { m.fits += 1; m.fitsMinutes += r.minutes; } else m.flagged.push(r);
    if (m.used === null && r.usedMinutes !== null) { m.used = r.usedMinutes; m.reserved = r.reservedMinutes; m.authorized = r.authorizedMinutes; }
    out.set(k, m);
  }
  return [...out.values()].map((m) => ({
    ...m,
    availableAfter: m.authorized === null || m.used === null || m.reserved === null ? null : m.authorized - m.used - m.reserved - m.fitsMinutes,
  }));
}

export function patternText(weekdays: number[], start: string, end: string) {
  return `Every ${weekdays.map((d) => WEEKDAY_SHORT[d]).join(", ")} · ${formatWallClock(hhmm(start))}–${formatWallClock(hhmm(end))}`;
}


const ORDINAL = ["", "first", "second", "third", "fourth", "fifth"];
const listOf = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** Plain-language rule, e.g. "Every other week · except the first of the month · skips 2 dates". "" for a plain weekly series. */
export function describePattern(p: RepeatPattern | null | undefined): string {
  if (!p) return "";
  const out: string[] = [];
  if (p.every_weeks && p.every_weeks > 1) out.push(p.every_weeks === 2 ? "every other week" : `every ${p.every_weeks}${p.every_weeks === 3 ? "rd" : "th"} week`);
  if (p.nth?.length) out.push(`only the ${listOf(p.nth.map((n) => ORDINAL[n] ?? String(n)))} of the month`);
  if (p.except_nth?.length) out.push(`except the ${listOf(p.except_nth.map((n) => ORDINAL[n] ?? String(n)))} of the month`);
  if (p.exclude_dates?.length) out.push(`skips ${p.exclude_dates.length} ${p.exclude_dates.length === 1 ? "date" : "dates"}`);
  return out.join(" · ");
}

export interface PatternForm { everyWeeks: number; weekOffset: 0 | 1; dates: "all" | "only" | "except"; nth: number[]; excludeDates: string[] }
export const PLAIN_PATTERN: PatternForm = { everyWeeks: 1, weekOffset: 0, dates: "all", nth: [], excludeDates: [] };
const addDaysIso = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** The pattern to send, or null when the form says "every week, every date". `startsOn` fixes which week is week 1. */
export function buildPattern(f: PatternForm, startsOn: string): RepeatPattern | null {
  const out: RepeatPattern = {};
  if (f.everyWeeks > 1) { out.every_weeks = f.everyWeeks; out.anchor = addDaysIso(startsOn, f.weekOffset * 7); }
  if (f.dates === "only" && f.nth.length) out.nth = [...f.nth].sort();
  if (f.dates === "except" && f.nth.length) out.except_nth = [...f.nth].sort();
  if (f.excludeDates.length) out.exclude_dates = [...f.excludeDates].sort();
  return Object.keys(out).length ? out : null;
}
