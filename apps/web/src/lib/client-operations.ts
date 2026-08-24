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
  remainingHours: number | null;
  projectedHours: number | null;
  utilizationPercent: number | null;
  health: ServiceHealth;
}

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
  const deliveredHours = Math.max(0, Number(row.delivered_minutes ?? 0) / 60);
  const authorized =
    row.max_monthly_hours === null
      ? null
      : Math.max(0, Number(row.max_monthly_hours));

  if (!row.service_id) {
    return {
      deliveredHours,
      remainingHours: null,
      projectedHours: null,
      utilizationPercent: null,
      health: "no-service",
    };
  }

  if (authorized === null) {
    return {
      deliveredHours,
      remainingHours: null,
      projectedHours: null,
      utilizationPercent: null,
      health: "no-authorization",
    };
  }

  const localDate = datePartsInTimeZone(now, timeZone);
  const daysInMonth = new Date(
    Date.UTC(localDate.year, localDate.month, 0),
  ).getUTCDate();
  const currentDay = Math.min(localDate.day, daysInMonth);
  const projectedHours =
    currentDay > 0
      ? (deliveredHours / currentDay) * daysInMonth
      : deliveredHours;
  const remainingHours = Math.max(0, authorized - deliveredHours);
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
      utilizationPercent,
      health: "authorization-expired",
    };
  }

  if (row.assigned_caregivers.length === 0) {
    return {
      deliveredHours,
      remainingHours,
      projectedHours,
      utilizationPercent,
      health: "unassigned",
    };
  }

  return {
    deliveredHours,
    remainingHours,
    projectedHours,
    utilizationPercent,
    health: projectedHours < authorized * 0.9 ? "behind" : "on-track",
  };
}

export function formatHours(value: number | null) {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
