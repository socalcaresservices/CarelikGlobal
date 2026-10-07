// Shared formatting/labels for the Service Verification caregiver page and
// admin reports page. All display times use Pacific time regardless of the
// viewer's own device timezone - the underlying timestamptz values are
// always server-set (see 20260809042943_service_verification.sql), this
// module only controls how they're *shown*.
export const PACIFIC_TIME_ZONE = "America/Los_Angeles";

export function formatHours(minutes: number): string {
  return (minutes / 60).toFixed(2).replace(/\.00$/, "");
}

export function formatClockTime(value: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: PACIFIC_TIME_ZONE
  }).format(new Date(value));
}

// A visit is linked to its scheduled shift on the server at Time In
// (20260826070000). Visits started with no matching shift - and every visit
// recorded before the link existed - have no scheduled window.
export const UNLINKED_VISIT_LABEL = "Not linked to a scheduled shift";

export function formatScheduledWindow(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined
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
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

export function formatScheduledTime(startsAt: string | Date, endsAt: string | Date): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: PACIFIC_TIME_ZONE
  });
  const dayName = formatter.format(new Date(startsAt));

  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: PACIFIC_TIME_ZONE
  });
  const startTime = timeFormatter.format(new Date(startsAt));
  const endTime = timeFormatter.format(new Date(endsAt));

  return `${dayName} · ${startTime} – ${endTime}`;
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
