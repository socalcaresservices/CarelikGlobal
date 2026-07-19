import { describe, expect, it } from "vitest";
import { caregiverCredentialSchema, getCredentialStatus } from "./credentials";

const validCredential = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  caregiverUserId: "44444444-4444-4444-8444-444444444444",
  caregiverName: "Sam Caregiver",
  credentialType: "CPR Certification",
  issuedDate: "2026-01-01",
  expiresAt: "2027-01-01",
  notes: null
};

describe("caregiverCredentialSchema", () => {
  it("accepts a well-formed credential", () => {
    expect(caregiverCredentialSchema.parse(validCredential)).toEqual(validCredential);
  });

  it("accepts a credential with no expiration", () => {
    expect(caregiverCredentialSchema.parse({ ...validCredential, expiresAt: null })).toEqual({
      ...validCredential,
      expiresAt: null
    });
  });

  it("rejects an empty credential type", () => {
    expect(() => caregiverCredentialSchema.parse({ ...validCredential, credentialType: "" })).toThrow();
  });
});

describe("getCredentialStatus", () => {
  const now = new Date("2026-07-19T00:00:00.000Z");

  it("returns no_expiration when there is no expiry date", () => {
    expect(getCredentialStatus(null, now)).toBe("no_expiration");
  });

  it("returns expired for a past date", () => {
    expect(getCredentialStatus("2026-01-01T00:00:00.000Z", now)).toBe("expired");
  });

  it("returns expiring_soon within the 30-day window", () => {
    expect(getCredentialStatus("2026-08-01T00:00:00.000Z", now)).toBe("expiring_soon");
  });

  it("returns active when well outside the window", () => {
    expect(getCredentialStatus("2027-01-01T00:00:00.000Z", now)).toBe("active");
  });
});
