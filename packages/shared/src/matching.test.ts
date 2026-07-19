import { describe, expect, it } from "vitest";
import { caregiverLocationSchema, caregiverMatchSchema, clientLocationNeedsSchema } from "./matching";

describe("caregiverLocationSchema", () => {
  it("accepts a fully populated location", () => {
    const location = {
      addressCity: "San Diego",
      addressState: "CA",
      addressZip: "92101",
      languages: ["English", "Spanish"],
      skills: ["Dementia care"]
    };
    expect(caregiverLocationSchema.parse(location)).toEqual(location);
  });

  it("accepts null address fields with empty arrays", () => {
    const location = {
      addressCity: null,
      addressState: null,
      addressZip: null,
      languages: [],
      skills: []
    };
    expect(caregiverLocationSchema.parse(location)).toEqual(location);
  });
});

describe("clientLocationNeedsSchema", () => {
  it("accepts a fully populated set of needs", () => {
    const needs = {
      addressCity: "San Diego",
      addressState: "CA",
      addressZip: "92101",
      languageNeeds: ["Spanish"],
      careNeeds: ["Hoyer lift"]
    };
    expect(clientLocationNeedsSchema.parse(needs)).toEqual(needs);
  });
});

describe("caregiverMatchSchema", () => {
  const validMatch = {
    caregiverUserId: "44444444-4444-4444-8444-444444444444",
    caregiverName: "Sam Caregiver",
    matchScore: 78,
    proximityScore: 30,
    languageScore: 25,
    availabilityScore: 15,
    skillsScore: 8,
    historyScore: 0
  };

  it("accepts a well-formed match", () => {
    expect(caregiverMatchSchema.parse(validMatch)).toEqual(validMatch);
  });

  it("rejects a match score above 100", () => {
    expect(() => caregiverMatchSchema.parse({ ...validMatch, matchScore: 101 })).toThrow();
  });

  it("rejects a negative component score", () => {
    expect(() => caregiverMatchSchema.parse({ ...validMatch, historyScore: -1 })).toThrow();
  });
});
