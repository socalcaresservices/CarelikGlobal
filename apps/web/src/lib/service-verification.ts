// Shared formatting/labels for the Service Verification caregiver page and
// admin reports page. All display times use Pacific time regardless of the
// viewer's own device timezone - the underlying timestamptz values are
// always server-set (see 20260809042943_service_verification.sql), this
// module only controls how they're *shown*.
export const PACIFIC_TIME_ZONE = "America/Los_Angeles";

export function formatHours(minutes: number): string {
  return (minutes / 60).toFixed(2).replace(/\.00$/, "");
}

/** Human-readable duration for operational UI and printed reports. */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

/** Compact DD/MM/YY date used in dense operational reports. */
export function formatNumericDate(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    timeZone: PACIFIC_TIME_ZONE,
  }).formatToParts(new Date(value));
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")}`;
}

/** Compact 24-hour time used in report tables. */
export function format24HourTime(value: string | Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: PACIFIC_TIME_ZONE,
  }).format(new Date(value));
}

export function formatTimeRange(timeIn: string, timeOut: string | null): string {
  return timeOut
    ? `${format24HourTime(timeIn)}–${format24HourTime(timeOut)}`
    : format24HourTime(timeIn);
}

export function formatClockTime(value: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: PACIFIC_TIME_ZONE
  }).format(new Date(value));
}

// A visit is linked to its scheduled shift on the server at Time In
// (0013 / 20260826070000). Visits started with no matching shift - and every
// visit recorded before the link existed - have no scheduled window.
export const UNLINKED_VISIT_LABEL = "Unscheduled visit";

export function formatScheduledWindow(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
): string {
  if (!startsAt || !endsAt) return UNLINKED_VISIT_LABEL;
  return `${formatClockTime(startsAt)}–${formatClockTime(endsAt)}`;
}

// Incomplete visits (Report Center "Exceptions"). A visit with Time In but no
// Time Out is a missed clock-out once it runs past its scheduled shift's end;
// a visit with no linked shift has no expected end, so it is flagged once it
// has been open this long. An ended visit that was never confirmed (client
// confirmation or a no-signer reason) is flagged once this long after Time
// Out - the caregiver confirms right after signing out.
export const UNSCHEDULED_OPEN_VISIT_ALERT_HOURS = 12;
export const UNCONFIRMED_VISIT_ALERT_MINUTES = 60;

export type IncompleteVisit =
  | { kind: "missing_time_out"; reason: "past_scheduled_end" | "open_without_schedule"; minutesOverdue: number }
  | { kind: "not_confirmed"; minutesSinceTimeOut: number };

export function classifyIncompleteVisit(
  visit: {
    status: string;
    time_in: string;
    time_out: string | null;
    scheduled_ends_at?: string | null;
  },
  now: Date = new Date()
): IncompleteVisit | null {
  const minutesSince = (value: string) => Math.floor((now.getTime() - new Date(value).getTime()) / 60_000);
  if (visit.status === "draft" && !visit.time_out) {
    if (visit.scheduled_ends_at) {
      const overdue = minutesSince(visit.scheduled_ends_at);
      return overdue > 0 ? { kind: "missing_time_out", reason: "past_scheduled_end", minutesOverdue: overdue } : null;
    }
    const overdue = minutesSince(visit.time_in) - UNSCHEDULED_OPEN_VISIT_ALERT_HOURS * 60;
    return overdue >= 0 ? { kind: "missing_time_out", reason: "open_without_schedule", minutesOverdue: overdue } : null;
  }
  if (visit.status === "awaiting_signature" && visit.time_out) {
    const since = minutesSince(visit.time_out);
    return since >= UNCONFIRMED_VISIT_ALERT_MINUTES ? { kind: "not_confirmed", minutesSinceTimeOut: since } : null;
  }
  return null;
}

export function formatVisitDate(value: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: PACIFIC_TIME_ZONE
  }).format(new Date(value));
}

export function formatDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: PACIFIC_TIME_ZONE
  }).format(new Date(value));
}

// mm:ss under an hour, h:mm:ss at or over - a caregiver glancing at a
// running visit cares about minutes most of the time, but a visit that
// runs long (which does happen) shouldn't show "127:43".
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export type ServiceVisitStatus =
  | "draft"
  | "awaiting_signature"
  | "signed"
  | "administrator_review"
  | "corrected"
  | "voided";

export type VisitAuthorizationStatus =
  | "within_authorization"
  | "limit_reached"
  | "exceeds_authorization"
  | "administrator_override";

export type VisitSignerRole = "client" | "parent" | "guardian" | "authorized_representative";

export const VISIT_STATUS_LABEL: Record<ServiceVisitStatus, string> = {
  draft: "In progress",
  awaiting_signature: "Awaiting signature",
  signed: "Signed",
  administrator_review: "Needs review",
  corrected: "Corrected",
  voided: "Voided"
};

export const AUTHORIZATION_STATUS_LABEL: Record<VisitAuthorizationStatus, string> = {
  within_authorization: "Within authorization",
  limit_reached: "Limit reached",
  exceeds_authorization: "Exceeds authorization",
  administrator_override: "Administrator override"
};

export const SIGNER_ROLE_LABEL: Record<VisitSignerRole, string> = {
  client: "Client",
  parent: "Parent",
  guardian: "Guardian",
  authorized_representative: "Authorized representative"
};

// ---------------------------------------------------------------------------
// Manager-entered Time Out. Every time on these screens is shown in Pacific
// time, so entry is Pacific too (not the manager's device timezone), split
// into date, hour, minute and an explicit AM/PM.

export type Meridiem = "AM" | "PM";

export interface PacificWallTime {
  /** YYYY-MM-DD */
  date: string;
  /** 1-12, or null while not chosen */
  hour: number | null;
  /** 0-59, or null while not chosen */
  minute: number | null;
  meridiem: Meridiem | null;
}

function pacificFields(utcMs: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** The Pacific date/hour/minute/AM-PM of an instant, for pre-filling the form. */
export function toPacificWallTime(value: string | Date): PacificWallTime {
  const f = pacificFields(new Date(value).getTime());
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${f.year}-${pad(f.month)}-${pad(f.day)}`,
    hour: f.hour % 12 === 0 ? 12 : f.hour % 12,
    minute: f.minute,
    meridiem: f.hour < 12 ? "AM" : "PM",
  };
}

export type WallTimeResult =
  | { ok: true; value: Date }
  | { ok: false; error: string };

/** Converts a Pacific wall-clock entry to an instant, rejecting incomplete or non-existent times. */
export function pacificWallTimeToDate(entry: PacificWallTime): WallTimeResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    return { ok: false, error: "Enter the date the visit ended." };
  }
  if (entry.hour === null || entry.minute === null || entry.meridiem === null) {
    return { ok: false, error: "Choose the hour, minute, and AM or PM." };
  }
  const [year, month, day] = entry.date.split("-").map(Number) as [number, number, number];
  const hour24 = (entry.hour % 12) + (entry.meridiem === "PM" ? 12 : 0);
  const asUtc = Date.UTC(year, month - 1, day, hour24, entry.minute);
  // Pacific offset at the guessed instant, re-checked once for a DST edge.
  const offsetAt = (ms: number) => {
    const f = pacificFields(ms);
    return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) - ms;
  };
  let instant = asUtc - offsetAt(asUtc);
  const second = asUtc - offsetAt(instant);
  if (second !== instant) instant = second;
  const check = pacificFields(instant);
  if (check.year !== year || check.month !== month || check.day !== day || check.hour !== hour24 || check.minute !== entry.minute) {
    return {
      ok: false,
      error: "That time does not exist on this date (daylight saving change). Choose another time.",
    };
  }
  return { ok: true, value: new Date(instant) };
}

/** Same limits the server enforces on a manager-entered Time Out (0015 / 20260826090000). */
export const MAX_VISIT_MINUTES = 24 * 60;

export function validateManagerTimeOut(
  timeIn: string,
  timeOut: Date,
  now: Date = new Date(),
): string | null {
  const start = new Date(timeIn);
  const minutes = Math.floor((timeOut.getTime() - start.getTime()) / 60_000);
  const describe = (d: Date) => `${formatVisitDate(d)}, ${formatClockTime(d)}`;
  if (timeOut.getTime() > now.getTime()) {
    return `Time Out (${describe(timeOut)}) is in the future. Check the date and AM/PM.`;
  }
  if (minutes < 1) {
    return `Time Out (${describe(timeOut)}) must be after Time In (${describe(start)}). Check the date and AM/PM.`;
  }
  if (minutes > MAX_VISIT_MINUTES) {
    return `This would make the visit ${formatDuration(minutes)}. A visit cannot be longer than 24 hours. Check the date.`;
  }
  return null;
}

/**
 * A corrected time for submission. When the entry still shows the original
 * time (same Pacific date, hour, minute and AM/PM), the original value is
 * sent unchanged, so an untouched Time In or Time Out keeps its seconds
 * instead of being re-entered as a whole minute.
 */
export function correctedTimeValue(
  entry: PacificWallTime,
  original: string | null,
): { ok: true; iso: string; value: Date } | { ok: false; error: string } {
  if (original) {
    const was = toPacificWallTime(original);
    if (
      was.date === entry.date &&
      was.hour === entry.hour &&
      was.minute === entry.minute &&
      was.meridiem === entry.meridiem
    ) {
      return { ok: true, iso: original, value: new Date(original) };
    }
  }
  const parsed = pacificWallTimeToDate(entry);
  return parsed.ok ? { ok: true, iso: parsed.value.toISOString(), value: parsed.value } : parsed;
}

/** Plain-language confirmation methods (stored values stay unchanged). */
export const CONFIRMATION_METHOD_LABEL: Record<string, string> = {
  draw: "Drawn signature",
  assisted_mark: "Assisted mark",
  typed: "Typed name",
  verbal: "Verbal confirmation",
  unable_to_confirm: "Unable to confirm",
};
export const confirmationMethodLabel = (method: string | null | undefined) =>
  method ? CONFIRMATION_METHOD_LABEL[method] ?? method : "—";
