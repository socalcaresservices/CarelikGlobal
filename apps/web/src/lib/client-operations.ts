export interface RequestedWindow {
  day: string;
  start: string;
  end: string;
  notes: string | null;
}

export interface ClientOperationRow {
  client_id: string;
  client_name: string;
  client_code: string;
  caregiver_display_code: string | null;
  client_status: "active" | "inactive" | "discharged";
  location: string | null;
  service_id: string | null;
  service_name: string | null;
  max_monthly_hours: number | null;
  authorization_period_end: string | null;
  delivered_minutes: number;
  assigned_caregivers: string[];
  requested_windows: RequestedWindow[];
  top_match_name: string | null;
  top_match_score: number | null;
  gap_reason: string | null;
  gap_notes: string | null;
  gap_resolved: boolean;
  // Month breakdown in minutes (20260826040000). Optional so the page keeps
  // working against a database that does not have the migration yet.
  requested_minutes?: number | null;
  scheduled_minutes?: number | null;
  upcoming_scheduled_minutes?: number | null;
  worked_minutes?: number | null;
  confirmed_minutes?: number | null;
  billable_minutes?: number | null;
  remaining_minutes?: number | null;
  projected_minutes?: number | null;
}

export type ServiceHealth =
  | "no-service"
  | "no-authorization"
  | "authorization-expired"
  | "unassigned"
  | "behind"
  | "on-track";

export interface ServiceProgress {
  deliveredHours: number;
  /** Authorized - worked - still-scheduled; negative when the plan exceeds the authorization. */
  remainingHours: number | null;
  projectedHours: number | null;
  /** "plan" = worked + still-scheduled shifts (server); "pace" = legacy straight-line fallback. */
  projectionBasis: "plan" | "pace" | null;
  utilizationPercent: number | null;
  health: ServiceHealth;
  breakdown: {
    requestedHours: number;
    scheduledHours: number;
    upcomingHours: number;
    confirmedHours: number;
    billableHours: number;
  } | null;
}

const toHours = (minutes: number | null | undefined) =>
  minutes === null || minutes === undefined ? null : Number(minutes) / 60;

function datePartsInTimeZone(
  now = new Date(),
  timeZone = "America/Los_Angeles",
) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return {
    year: Number(parts.find((part) => part.type === "year")!.value),
    month: Number(parts.find((part) => part.type === "month")!.value),
    day: Number(parts.find((part) => part.type === "day")!.value),
  };
}

export function monthStartInTimeZone(
  now = new Date(),
  timeZone = "America/Los_Angeles",
) {
  const { year, month } = datePartsInTimeZone(now, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

export function calculateServiceProgress(
  row: ClientOperationRow,
  now = new Date(),
  timeZone = "America/Los_Angeles",
): ServiceProgress {
  const deliveredHours = Math.max(0, Number(row.worked_minutes ?? row.delivered_minutes ?? 0) / 60);
  const hasBreakdown = row.projected_minutes !== undefined && row.scheduled_minutes !== undefined;
  const breakdown = hasBreakdown
    ? {
        requestedHours: toHours(row.requested_minutes) ?? 0,
        scheduledHours: toHours(row.scheduled_minutes) ?? 0,
        upcomingHours: toHours(row.upcoming_scheduled_minutes) ?? 0,
        confirmedHours: toHours(row.confirmed_minutes) ?? 0,
        billableHours: toHours(row.billable_minutes) ?? 0,
      }
    : null;
  const authorized =
    row.max_monthly_hours === null
      ? null
      : Math.max(0, Number(row.max_monthly_hours));

  if (!row.service_id) {
    return {
      deliveredHours,
      remainingHours: null,
      projectedHours: null,
      projectionBasis: null,
      utilizationPercent: null,
      health: "no-service",
      breakdown,
    };
  }

  if (authorized === null) {
    return {
      deliveredHours,
      remainingHours: null,
      projectedHours: hasBreakdown ? toHours(row.projected_minutes) : null,
      projectionBasis: hasBreakdown ? "plan" : null,
      utilizationPercent: null,
      health: "no-authorization",
      breakdown,
    };
  }

  const localDate = datePartsInTimeZone(now, timeZone);
  const daysInMonth = new Date(
    Date.UTC(localDate.year, localDate.month, 0),
  ).getUTCDate();
  const currentDay = Math.min(localDate.day, daysInMonth);
  // Prefer the server's plan (worked + still-scheduled shifts); fall back to
  // the old straight-line pace only when the breakdown is not available.
  const projectionBasis: "plan" | "pace" = hasBreakdown ? "plan" : "pace";
  const projectedHours = hasBreakdown
    ? toHours(row.projected_minutes) ?? deliveredHours
    : currentDay > 0
      ? (deliveredHours / currentDay) * daysInMonth
      : deliveredHours;
  const remainingHours = hasBreakdown
    ? toHours(row.remaining_minutes) ?? authorized - deliveredHours
    : Math.max(0, authorized - deliveredHours);
  const utilizationPercent =
    authorized === 0 ? 100 : Math.min(100, (deliveredHours / authorized) * 100);

  if (
    row.authorization_period_end &&
    row.authorization_period_end < monthStartInTimeZone(now, timeZone)
  ) {
    return {
      deliveredHours,
      remainingHours,
      projectedHours,
      projectionBasis,
      utilizationPercent,
      health: "authorization-expired",
      breakdown,
    };
  }

  if (row.assigned_caregivers.length === 0) {
    return {
      deliveredHours,
      remainingHours,
      projectedHours,
      projectionBasis,
      utilizationPercent,
      health: "unassigned",
      breakdown,
    };
  }

  return {
    deliveredHours,
    remainingHours,
    projectedHours,
    projectionBasis,
    utilizationPercent,
    health: projectedHours < authorized * 0.9 ? "behind" : "on-track",
    breakdown,
  };
}

export function formatHours(value: number | null) {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
