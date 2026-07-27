import { z } from "zod";
import { organizationIdSchema } from "./tenant";

export const applicantStatusSchema = z.enum(["new", "reviewing", "hired", "rejected", "withdrawn"]);
export type ApplicantStatus = z.infer<typeof applicantStatusSchema>;

export const availabilityPreferenceSchema = z.enum(["available", "preferred"]);
export type AvailabilityPreference = z.infer<typeof availabilityPreferenceSchema>;

export const jobApplicantSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string(),
  phone: z.string().nullable(),
  status: applicantStatusSchema,
  desiredWeeklyHours: z.number().nullable(),
  minWeeklyHours: z.number().nullable(),
  maxWeeklyHours: z.number().nullable(),
  minShiftHours: z.number().nullable(),
  maxShiftHours: z.number().nullable(),
  preferredCities: z.array(z.string()),
  maxTravelMinutes: z.number().nullable(),
  transportationMethod: z.string().nullable(),
  willingToTransportClients: z.boolean().nullable(),
  languages: z.array(z.string()),
  notes: z.string().nullable()
});

export type JobApplicant = z.infer<typeof jobApplicantSchema>;
