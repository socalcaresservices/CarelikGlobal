import { z } from "zod";
import { organizationIdSchema } from "./tenant";

// payer is free text, not an enum - same reasoning as credentialType in
// ./credentials.ts: payer/program names vary too much by agency to guess
// a fixed list. maxMonthlyHours is a monthly cap, not a period total -
// periodStart/periodEnd remain the authorization's overall validity
// window, but the hours ceiling resets each calendar month within it.
// serviceId ties the authorization to one entry in ./services.ts, so a
// client with more than one authorization (e.g. Medicaid personal care
// plus a private-pay companionship authorization) can have hours
// tracked separately for each.
export const clientAuthorizationSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: organizationIdSchema,
    clientId: z.string().uuid(),
    clientName: z.string(),
    serviceId: z.string().uuid(),
    serviceName: z.string(),
    payer: z.string().min(1),
    authorizationNumber: z.string().nullable(),
    maxMonthlyHours: z.number().min(0),
    periodStart: z.string(),
    periodEnd: z.string(),
    notes: z.string().nullable()
  })
  .refine((row) => new Date(row.periodStart).getTime() < new Date(row.periodEnd).getTime(), {
    message: "periodStart must be before periodEnd",
    path: ["periodEnd"]
  });

export type ClientAuthorization = z.infer<typeof clientAuthorizationSchema>;

// Usage against the monthly cap - hours already delivered (completed
// shifts) plus hours already on the schedule (not yet completed) both
// count against the same ceiling, since a scheduled hour is a
// commitment even before it happens. Four tiers, not three: "at limit"
// (right at the cap) is a distinct, actionable signal from "over
// limit" (already past it) and from "approaching" (still under, but
// close) - collapsing them would hide exactly the moment a coordinator
// needs to stop scheduling more hours.
export type AuthorizationUsageStatus = "normal" | "approaching_limit" | "at_limit" | "over_limit";

// A small tolerance avoids flip-flopping between "at limit" and "over
// limit" for a fraction of an hour of rounding noise.
const AT_LIMIT_TOLERANCE_HOURS = 0.1;
const APPROACHING_LIMIT_RATIO = 0.9;

export function getAuthorizationUsageStatus(
  maxMonthlyHours: number,
  hoursUsedThisMonth: number,
  hoursScheduledThisMonth: number
): AuthorizationUsageStatus {
  const committedHours = hoursUsedThisMonth + hoursScheduledThisMonth;
  if (maxMonthlyHours <= 0) return committedHours > 0 ? "over_limit" : "normal";
  if (committedHours > maxMonthlyHours + AT_LIMIT_TOLERANCE_HOURS) return "over_limit";
  if (committedHours >= maxMonthlyHours - AT_LIMIT_TOLERANCE_HOURS) return "at_limit";
  if (committedHours / maxMonthlyHours >= APPROACHING_LIMIT_RATIO) return "approaching_limit";
  return "normal";
}

// Authorization validity (period_start/period_end) is a separate
// concern from monthly usage - an authorization can be fully within its
// hours cap and still be expiring soon, or vice versa. Same shape and
// 30-day threshold as getCredentialStatus in ./credentials.ts, derived
// at read time rather than stored, for the same reason.
export type AuthorizationExpiryStatus = "expired" | "expiring_soon" | "active";

const EXPIRING_SOON_WINDOW_DAYS = 30;

export function getAuthorizationExpiryStatus(periodEnd: string, now: Date = new Date()): AuthorizationExpiryStatus {
  const end = new Date(periodEnd).getTime();
  const nowTime = now.getTime();
  if (end < nowTime) return "expired";
  const daysUntilEnd = (end - nowTime) / (24 * 60 * 60 * 1000);
  if (daysUntilEnd <= EXPIRING_SOON_WINDOW_DAYS) return "expiring_soon";
  return "active";
}

export function isAuthorizationActive(periodStart: string, periodEnd: string, now: Date = new Date()): boolean {
  const start = new Date(periodStart).getTime();
  const end = new Date(periodEnd).getTime();
  const nowTime = now.getTime();
  return start <= nowTime && nowTime <= end;
}
