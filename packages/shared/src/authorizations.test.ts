import { describe, expect, it } from "vitest";
import {
  clientAuthorizationSchema,
  getUtilizationStatus,
  isAuthorizationActive
} from "./authorizations";

const validAuthorization = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  clientId: "33333333-3333-4333-8333-333333333333",
  clientName: "Jordan Rivera",
  payer: "Medicaid",
  authorizedHours: 20,
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
  notes: null
};

describe("clientAuthorizationSchema", () => {
  it("accepts a well-formed authorization", () => {
    expect(clientAuthorizationSchema.parse(validAuthorization)).toEqual(validAuthorization);
  });

  it("rejects a period that ends before it starts", () => {
    expect(() =>
      clientAuthorizationSchema.parse({ ...validAuthorization, periodStart: "2026-07-31", periodEnd: "2026-07-01" })
    ).toThrow();
  });

  it("rejects negative authorized hours", () => {
    expect(() => clientAuthorizationSchema.parse({ ...validAuthorization, authorizedHours: -1 })).toThrow();
  });
});

describe("getUtilizationStatus", () => {
  it("returns on_track when scheduled matches authorized", () => {
    expect(getUtilizationStatus(20, 20)).toBe("on_track");
  });

  it("returns under when scheduled falls meaningfully short", () => {
    expect(getUtilizationStatus(20, 10)).toBe("under");
  });

  it("returns over when scheduled meaningfully exceeds authorized", () => {
    expect(getUtilizationStatus(20, 25)).toBe("over");
  });

  it("tolerates small rounding differences as on_track", () => {
    expect(getUtilizationStatus(20, 20.05)).toBe("on_track");
  });
});

describe("isAuthorizationActive", () => {
  const now = new Date("2026-07-19T00:00:00.000Z");

  it("returns true when now falls within the period", () => {
    expect(isAuthorizationActive("2026-07-01", "2026-07-31", now)).toBe(true);
  });

  it("returns false when the period has already ended", () => {
    expect(isAuthorizationActive("2026-06-01", "2026-06-30", now)).toBe(false);
  });

  it("returns false when the period hasn't started yet", () => {
    expect(isAuthorizationActive("2026-08-01", "2026-08-31", now)).toBe(false);
  });
});
