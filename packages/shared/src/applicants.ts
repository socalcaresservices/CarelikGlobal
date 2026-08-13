import { z } from "zod";
import { organizationIdSchema } from "./tenant";

// Legacy status remains for backwards compatibility with existing applicant
// records. Candidate Hiring V1 uses pipelineStage for the operational workflow.
export const applicantStatusSchema = z.enum(["new", "reviewing", "hired", "rejected", "withdrawn"]);
export type ApplicantStatus = z.infer<typeof applicantStatusSchema>;

export const candidatePipelineStageSchema = z.enum([
  "imported",
  "application_needed",
  "application_received",
  "screening",
  "interview",
  "conditional_offer",
  "hired_onboarding_required",
  "onboarding_scheduled",
  "onboarding",
  "compliance_pending",
  "ready_to_work",
  "care_team",
  "on_hold",
  "rejected",
  "withdrawn"
]);
export type CandidatePipelineStage = z.infer<typeof candidatePipelineStageSchema>;

export const candidateSourceSchema = z.enum([
  "indeed",
  "ziprecruiter",
  "referral",
  "agency_website",
  "manual",
  "other"
]);
export type CandidateSource = z.infer<typeof candidateSourceSchema>;

export const availabilityPreferenceSchema = z.enum(["available", "preferred"]);
export type AvailabilityPreference = z.infer<typeof availabilityPreferenceSchema>;

export const employmentTypeSchema = z.enum(["full_time", "part_time", "per_diem", "contractor"]);
export type EmploymentType = z.infer<typeof employmentTypeSchema>;

export const candidateCredentialSubmissionStatusSchema = z.enum([
  "self_reported",
  "uploaded",
  "pending_review",
  "missing"
]);
export type CandidateCredentialSubmissionStatus = z.infer<typeof candidateCredentialSubmissionStatusSchema>;

export const candidateCredentialVerificationStatusSchema = z.enum(["unverified", "verified", "rejected"]);
export type CandidateCredentialVerificationStatus = z.infer<typeof candidateCredentialVerificationStatusSchema>;

export const candidateOnboardingStatusSchema = z.enum([
  "not_scheduled",
  "scheduled",
  "in_progress",
  "completed",
  "cancelled"
]);
export type CandidateOnboardingStatus = z.infer<typeof candidateOnboardingStatusSchema>;

export const candidateBackgroundCheckStatusSchema = z.enum([
  "not_started",
  "requested",
  "submitted",
  "pending",
  "complete",
  "needs_attention"
]);
export type CandidateBackgroundCheckStatus = z.infer<typeof candidateBackgroundCheckStatusSchema>;

export const candidateComplianceStatusSchema = z.enum(["pending", "needs_attention", "complete"]);
export type CandidateComplianceStatus = z.infer<typeof candidateComplianceStatusSchema>;

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
  pipelineStage: candidatePipelineStageSchema.optional(),
  source: z.string().optional(),
  sourceRecordId: z.string().nullable().optional(),
  positionAppliedFor: z.string().nullable().optional(),
  appliedAt: z.string().nullable().optional(),
  importedAt: z.string().nullable().optional(),
  applicationCompletedAt: z.string().nullable().optional(),
  portalCompletedAt: z.string().nullable().optional(),
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
  // Deprecated, retained for backwards compatibility with older rows.
  preferredCities: z.array(z.string()),
  transportationMethod: z.string().nullable(),
  maxTravelMinutes: z.number().nullable(),
  reliableTransportation: z.boolean().nullable(),
  willingToTransportClients: z.boolean().nullable(),
  validDriversLicense: z.boolean().nullable(),
  vehicleAvailable: z.boolean().nullable(),
  autoInsurance: z.boolean().nullable(),
  // Legacy convenience fields. Generic candidate_credentials is the V1 source
  // for arbitrary certifications and organization-defined requirements.
  tbTestExpiresAt: z.string().nullable(),
  cprExpiresAt: z.string().nullable(),
  backgroundCheckConsent: z.boolean(),
  languages: z.array(z.string()),
  notes: z.string().nullable()
});

export type JobApplicant = z.infer<typeof jobApplicantSchema>;

export const candidateCredentialSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  applicantId: z.string().uuid(),
  credentialType: z.string().min(1),
  issueDate: z.string().nullable(),
  expirationDate: z.string().nullable(),
  doesNotExpire: z.boolean(),
  issuingOrganization: z.string().nullable(),
  credentialNumber: z.string().nullable(),
  submissionStatus: candidateCredentialSubmissionStatusSchema,
  verificationStatus: candidateCredentialVerificationStatusSchema,
  verifiedBy: z.string().uuid().nullable(),
  verifiedAt: z.string().nullable(),
  notes: z.string().nullable()
});
export type CandidateCredential = z.infer<typeof candidateCredentialSchema>;

export const candidateOnboardingSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  applicantId: z.string().uuid(),
  status: candidateOnboardingStatusSchema,
  scheduledAt: z.string().nullable(),
  method: z.string().nullable(),
  location: z.string().nullable(),
  instructions: z.string().nullable(),
  notes: z.string().nullable(),
  backgroundCheckStatus: candidateBackgroundCheckStatusSchema,
  complianceStatus: candidateComplianceStatusSchema,
  completedAt: z.string().nullable()
});
export type CandidateOnboarding = z.infer<typeof candidateOnboardingSchema>;

export const jobApplicantServiceSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  applicantId: z.string().uuid(),
  serviceId: z.string().uuid()
});

export type JobApplicantService = z.infer<typeof jobApplicantServiceSchema>;
