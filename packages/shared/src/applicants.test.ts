import { describe, expect, it } from "vitest";
import {
  applicantStatusSchema,
  availabilityPreferenceSchema,
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
  it("accepts a well-formed applicant", () => {
    expect(jobApplicantSchema.parse(validApplicant)).toEqual(validApplicant);
  });

  it("rejects an empty first name", () => {
    expect(() => jobApplicantSchema.parse({ ...validApplicant, firstName: "" })).toThrow();
  });
});

describe("applicantStatusSchema", () => {
  it("accepts every known status", () => {
    for (const value of applicantStatusSchema.options) {
      expect(applicantStatusSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an unknown status", () => {
    expect(() => applicantStatusSchema.parse("archived")).toThrow();
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
