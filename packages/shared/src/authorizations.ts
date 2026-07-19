import { z } from "zod";
import { organizationIdSchema } from "./tenant";

// payer is free text, not an enum - same reasoning as credentialType in
// ./credentials.ts: payer/program names vary too much by agency to guess
// a fixed list.
export const clientAuthorizationSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: organizationIdSchema,
    clientId: z.string().uuid(),
    clientName: z.string(),
    payer: z.string().min(1),
    authorizedHours: z.number().min(0),
    periodStart: z.string(),
    periodEnd: z.string(),
    notes: z.string().nullable()
  })
  .refine((row) => new Date(row.periodStart).getTime() < new Date(row.periodEnd).getTime(), {
    message: "periodStart must be before periodEnd",
    path: ["periodEnd"]
  });

export type ClientAuthorization = z.infer<typeof clientAuthorizationSchema>;

export type UtilizationStatus = "under" | "on_track" | "over";

// A small tolerance avoids flagging a client as "over" for a fraction of
// an hour of rounding noise - only a meaningful gap counts.
const UTILIZATION_TOLERANCE_HOURS = 0.1;

export function getUtilizationStatus(authorizedHours: number, scheduledHours: number): UtilizationStatus {
  if (scheduledHours > authorizedHours + UTILIZATION_TOLERANCE_HOURS) return "over";
  if (scheduledHours < authorizedHours - UTILIZATION_TOLERANCE_HOURS) return "under";
  return "on_track";
}

export function isAuthorizationActive(periodStart: string, periodEnd: string, now: Date = new Date()): boolean {
  const start = new Date(periodStart).getTime();
  const end = new Date(periodEnd).getTime();
  const nowTime = now.getTime();
  return start <= nowTime && nowTime <= end;
}
