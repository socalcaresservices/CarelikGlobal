import { describe, expect, it } from "vitest";
import {
  applicantStatusSchema,
  availabilityPreferenceSchema,
  candidateBackgroundCheckStatusSchema,
  candidateComplianceStatusSchema,
  candidateCredentialSchema,
  candidateOnboardingSchema,
  candidatePipelineStageSchema,
  candidateSourceSchema,
  employmentTypeSchema,
  jobApplicantSchema,
  jobApplicantServiceSchema
} from "./applicants";

const validApplicant = {
  id: "55555555-5555-4555-8555-555555555555",
  organizationId: "11111111-1111-4111-8111-111111111111",
  firstName: "Ashley",
  middleName: null,
  lastName: "Rivera",
  preferredName: null,
  dateOfBirth: null,
  email: "ashley@example.com",
  phone: null,
  alternatePhone: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  status: "new" as const,
  pipelineStage: "application_received" as const,
  source: "indeed",
  sourceRecordId: "indeed-123",
  positionAppliedFor: "Caregiver",
  appliedAt: "2026-08-13T12:00:00.000Z",
  importedAt: null,
  applicationCompletedAt: "2026-08-13T12:00:00.000Z",
  portalCompletedAt: null,
  employmentType: "full_time" as const,
  availableStartDate: "2026-08-15",
  addressStreet: "123 Main St",
  addressLine2: null,
  addressCity: "Corona",
  addressState: "CA",
  addressZip: "92879",
  addressCountry: "US",
  desiredWeeklyHours: 30,
  minWeeklyHours: 20,
  maxWeeklyHours: 40,
  desiredMonthlyHours: null,
  minMonthlyHours: null,
  maxMonthlyHours: null,
  minShiftHours: 4,
  maxShiftHours: 8,
  preferredCities: ["Corona", "Riverside"],
  transportationMethod: "own car",
  maxTravelMinutes: 30,
  reliableTransportation: true,
  willingToTransportClients: true,
  validDriversLicense: true,
  vehicleAvailable: true,
  autoInsurance: true,
  tbTestExpiresAt: "2027-01-01",
  cprExpiresAt: "2026-12-01",
  backgroundCheckConsent: true,
  languages: ["English", "Spanish"],
  notes: null
};

describe("jobApplicantSchema", () => {
  it("accepts a well-formed Candidate Hiring V1 record", () => {
    expect(jobApplicantSchema.parse(validApplicant)).toEqual(validApplicant);
  });

  it("rejects an empty first name", () => {
    expect(() => jobApplicantSchema.parse({ ...validApplicant, firstName: "" })).toThrow();
  });
});

describe("candidatePipelineStageSchema", () => {
  it("includes the full administrative recruiting and onboarding workflow", () => {
    expect(candidatePipelineStageSchema.options).toEqual([
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
  });

  it("rejects unknown workflow values", () => {
    expect(() => candidatePipelineStageSchema.parse("auto_recommended")).toThrow();
  });
});

describe("candidateSourceSchema", () => {
  it("supports common external recruiting sources and organization intake", () => {
    expect(candidateSourceSchema.options).toEqual([
      "indeed",
      "ziprecruiter",
      "referral",
      "agency_website",
      "manual",
      "other"
    ]);
  });
});

describe("legacy applicantStatusSchema", () => {
  it("remains backwards compatible", () => {
    for (const value of applicantStatusSchema.options) {
      expect(applicantStatusSchema.parse(value)).toBe(value);
    }
  });
});

describe("availabilityPreferenceSchema", () => {
  it("accepts available and preferred", () => {
    expect(availabilityPreferenceSchema.options).toEqual(["available", "preferred"]);
  });
});

describe("employmentTypeSchema", () => {
  it("accepts every known employment type", () => {
    for (const value of employmentTypeSchema.options) {
      expect(employmentTypeSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an unknown employment type", () => {
    expect(() => employmentTypeSchema.parse("seasonal")).toThrow();
  });
});

describe("candidate credential and onboarding schemas", () => {
  it("accepts a generic credential instead of hard-coding one certification", () => {
    const credential = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      organizationId: "11111111-1111-4111-8111-111111111111",
      applicantId: "55555555-5555-4555-8555-555555555555",
      credentialType: "Organization-defined credential",
      issueDate: "2026-08-01",
      expirationDate: "2027-08-01",
      doesNotExpire: false,
      issuingOrganization: "Example Issuer",
      credentialNumber: "ABC-123",
      submissionStatus: "self_reported" as const,
      verificationStatus: "unverified" as const,
      verifiedBy: null,
      verifiedAt: null,
      notes: null
    };
    expect(candidateCredentialSchema.parse(credential)).toEqual(credential);
  });

  it("accepts an onboarding record", () => {
    const onboarding = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      organizationId: "11111111-1111-4111-8111-111111111111",
      applicantId: "55555555-5555-4555-8555-555555555555",
      status: "scheduled" as const,
      scheduledAt: "2026-08-20T17:00:00.000Z",
      method: "in_person",
      location: "Main office",
      instructions: "Bring requested documents.",
      notes: null,
      backgroundCheckStatus: "not_started" as const,
      complianceStatus: "pending" as const,
      completedAt: null
    };
    expect(candidateOnboardingSchema.parse(onboarding)).toEqual(onboarding);
    expect(candidateBackgroundCheckStatusSchema.parse("pending")).toBe("pending");
    expect(candidateComplianceStatusSchema.parse("complete")).toBe("complete");
  });
});

describe("jobApplicantServiceSchema", () => {
  it("accepts a well-formed applicant/service link", () => {
    const validLink = {
      id: "66666666-6666-4666-8666-666666666666",
      organizationId: "11111111-1111-4111-8111-111111111111",
      applicantId: "55555555-5555-4555-8555-555555555555",
      serviceId: "77777777-7777-4777-8777-777777777777"
    };
    expect(jobApplicantServiceSchema.parse(validLink)).toEqual(validLink);
  });
});
