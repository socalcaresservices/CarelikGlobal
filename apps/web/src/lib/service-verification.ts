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
