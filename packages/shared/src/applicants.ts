import { z } from "zod";
import { organizationIdSchema } from "./tenant";

export const applicantStatusSchema = z.enum(["new", "reviewing", "hired", "rejected", "withdrawn"]);
export type ApplicantStatus = z.infer<typeof applicantStatusSchema>;

export const availabilityPreferenceSchema = z.enum(["available", "preferred"]);
export type AvailabilityPreference = z.infer<typeof availabilityPreferenceSchema>;

export const employmentTypeSchema = z.enum(["full_time", "part_time", "per_diem", "contractor"]);
export type EmploymentType = z.infer<typeof employmentTypeSchema>;

export const jobApplicantSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  firstName: z.string().min(1),
  middleName: z.string().nullable(),
  lastName: z.string().min(1),
  preferredName: z.string().nullable(),
  dateOfBirth: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  alternatePhone: z.string().nullable(),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  status: applicantStatusSchema,
  employmentType: employmentTypeSchema.nullable(),
  availableStartDate: z.string().nullable(),
  addressStreet: z.string().nullable(),
  addressLine2: z.string().nullable(),
  addressCity: z.string().nullable(),
  addressState: z.string().nullable(),
  addressZip: z.string().nullable(),
  addressCountry: z.string(),
  desiredWeeklyHours: z.number().nullable(),
  minWeeklyHours: z.number().nullable(),
  maxWeeklyHours: z.number().nullable(),
  desiredMonthlyHours: z.number().nullable(),
  minMonthlyHours: z.number().nullable(),
  maxMonthlyHours: z.number().nullable(),
  minShiftHours: z.number().nullable(),
  maxShiftHours: z.number().nullable(),
  // Deprecated, no longer collected by the application form (superseded
  // by structured address + travel-radius fields below). Kept nullable
  // for backward read compatibility with rows submitted before this
  // change, not for new writes.
  preferredCities: z.array(z.string()),
  transportationMethod: z.string().nullable(),
  maxTravelMinutes: z.number().nullable(),
  reliableTransportation: z.boolean().nullable(),
  willingToTransportClients: z.boolean().nullable(),
  validDriversLicense: z.boolean().nullable(),
  vehicleAvailable: z.boolean().nullable(),
  autoInsurance: z.boolean().nullable(),
  tbTestExpiresAt: z.string().nullable(),
  cprExpiresAt: z.string().nullable(),
  backgroundCheckConsent: z.boolean(),
  languages: z.array(z.string()),
  notes: z.string().nullable()
});

export type JobApplicant = z.infer<typeof jobApplicantSchema>;

export const jobApplicantServiceSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  applicantId: z.string().uuid(),
  serviceId: z.string().uuid()
});

export type JobApplicantService = z.infer<typeof jobApplicantServiceSchema>;
