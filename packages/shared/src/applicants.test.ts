import { describe, expect, it } from "vitest";
import { applicantStatusSchema, availabilityPreferenceSchema, jobApplicantSchema } from "./applicants";

const validApplicant = {
  id: "55555555-5555-4555-8555-555555555555",
  organizationId: "11111111-1111-4111-8111-111111111111",
  firstName: "Ashley",
  lastName: "Rivera",
  email: "ashley@example.com",
  phone: null,
  status: "new" as const,
  desiredWeeklyHours: 30,
  minWeeklyHours: 20,
  maxWeeklyHours: 40,
  minShiftHours: 4,
  maxShiftHours: 8,
  preferredCities: ["Corona", "Riverside"],
  maxTravelMinutes: 30,
  transportationMethod: "own car",
  willingToTransportClients: true,
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
