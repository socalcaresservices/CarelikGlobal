import { z } from "zod";
import { organizationIdSchema } from "./tenant";

// category is free text, not an enum - same reasoning as credentialType
// and payer: agencies categorize incidents differently. severity and
// status are workflow concepts, not business content, so those are enums.
export const incidentSeveritySchema = z.enum(["low", "medium", "high"]);
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;

export const incidentStatusSchema = z.enum(["open", "under_review", "resolved"]);
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;

export const incidentSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  clientId: z.string().uuid().nullable(),
  clientName: z.string().nullable(),
  caregiverUserId: z.string().uuid().nullable(),
  caregiverName: z.string().nullable(),
  occurredAt: z.string(),
  category: z.string().min(1),
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  description: z.string().min(1),
  reportedBy: z.string().uuid().nullable(),
  reportedByName: z.string().nullable(),
  resolutionNotes: z.string().nullable(),
  resolvedAt: z.string().nullable()
});

export type Incident = z.infer<typeof incidentSchema>;
