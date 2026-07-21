import { describe, expect, it } from "vitest";
import {
  clientAuthorizationSchema,
  getAuthorizationExpiryStatus,
  getAuthorizationUsageStatus,
  isAuthorizationActive
} from "./authorizations";

const validAuthorization = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  clientId: "33333333-3333-4333-8333-333333333333",
  clientName: "Jordan Rivera",
  serviceId: "44444444-4444-4444-8444-444444444444",
  serviceName: "Personal care",
  payer: "Medicaid",
  authorizationNumber: "AUTH-100",
  maxMonthlyHours: 20,
  periodStart: "2026-07-01",
  periodEnd: "2026-12-31",
  notes: null
};

describe("clientAuthorizationSchema", () => {
  it("accepts a well-formed authorization", () => {
    expect(clientAuthorizationSchema.parse(validAuthorization)).toEqual(validAuthorization);
  });

  it("accepts a null authorization number", () => {
    expect(
      clientAuthorizationSchema.parse({ ...validAuthorization, authorizationNumber: null })
    ).toMatchObject({ authorizationNumber: null });
  });

  it("rejects a period that ends before it starts", () => {
    expect(() =>
      clientAuthorizationSchema.parse({ ...validAuthorization, periodStart: "2026-07-31", periodEnd: "2026-07-01" })
    ).toThrow();
  });

  it("rejects negative max monthly hours", () => {
    expect(() => clientAuthorizationSchema.parse({ ...validAuthorization, maxMonthlyHours: -1 })).toThrow();
  });
});

describe("getAuthorizationUsageStatus", () => {
  it("returns normal when well under the monthly cap", () => {
    expect(getAuthorizationUsageStatus(20, 5, 5)).toBe("normal");
  });

  it("returns approaching_limit at 90% or more of the cap", () => {
    expect(getAuthorizationUsageStatus(20, 10, 8)).toBe("approaching_limit");
  });

  it("returns at_limit when used+scheduled equals the cap", () => {
    expect(getAuthorizationUsageStatus(20, 12, 8)).toBe("at_limit");
  });

  it("tolerates small rounding differences as at_limit rather than over", () => {
    expect(getAuthorizationUsageStatus(20, 12, 8.05)).toBe("at_limit");
  });

  it("returns over_limit when used+scheduled meaningfully exceeds the cap", () => {
    expect(getAuthorizationUsageStatus(20, 15, 10)).toBe("over_limit");
  });

  it("counts scheduled-but-not-completed hours toward the cap", () => {
    expect(getAuthorizationUsageStatus(20, 0, 25)).toBe("over_limit");
  });

  it("treats a zero/absent cap with no hours committed as normal, not fabricated", () => {
    expect(getAuthorizationUsageStatus(0, 0, 0)).toBe("normal");
  });

  it("treats a zero cap with any committed hours as over_limit", () => {
    expect(getAuthorizationUsageStatus(0, 1, 0)).toBe("over_limit");
  });
});

describe("getAuthorizationExpiryStatus", () => {
  const now = new Date("2026-07-19T00:00:00.000Z");

  it("returns expired when the period has already ended", () => {
    expect(getAuthorizationExpiryStatus("2026-06-30T00:00:00.000Z", now)).toBe("expired");
  });

  it("returns expiring_soon within the 30-day window", () => {
    expect(getAuthorizationExpiryStatus("2026-08-01T00:00:00.000Z", now)).toBe("expiring_soon");
  });

  it("returns active well before the period ends", () => {
    expect(getAuthorizationExpiryStatus("2027-01-01T00:00:00.000Z", now)).toBe("active");
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
