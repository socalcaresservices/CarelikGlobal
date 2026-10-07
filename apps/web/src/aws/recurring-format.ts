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
  outcome: "ok" | "exceeds_authorization" | "no_authorization" | "caregiver_conflict" | "already_started" | "time_does_not_exist" | "time_occurs_twice";
}
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

