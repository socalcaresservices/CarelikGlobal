import { describe, expect, it } from "vitest";
import { clientSchema, clientStatusSchema, shiftSchema, shiftStatusSchema } from "./care";

const validClient = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  firstName: "Jordan",
  lastName: "Rivera",
  phone: "555-0100",
  email: null,
  address: null,
  careNotes: null,
  status: "active" as const
};

const validShift = {
  id: "33333333-3333-4333-8333-333333333333",
  organizationId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  caregiverUserId: "44444444-4444-4444-8444-444444444444",
  startsAt: "2026-07-20T09:00:00.000Z",
  endsAt: "2026-07-20T11:00:00.000Z",
  status: "scheduled" as const,
  notes: null
};

describe("clientStatusSchema", () => {
  it("accepts every known status", () => {
    for (const value of clientStatusSchema.options) {
      expect(clientStatusSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an unknown status", () => {
    expect(() => clientStatusSchema.parse("pending")).toThrow();
  });
});

describe("clientSchema", () => {
  it("accepts a well-formed client", () => {
    expect(clientSchema.parse(validClient)).toEqual(validClient);
  });

  it("rejects an empty first name", () => {
    expect(() => clientSchema.parse({ ...validClient, firstName: "" })).toThrow();
  });
});

describe("shiftStatusSchema", () => {
  it("accepts every known status", () => {
    for (const value of shiftStatusSchema.options) {
      expect(shiftStatusSchema.parse(value)).toBe(value);
    }
  });
});

describe("shiftSchema", () => {
  it("accepts a well-formed shift", () => {
    expect(shiftSchema.parse(validShift)).toEqual(validShift);
  });

  it("rejects a shift that ends before it starts", () => {
    expect(() =>
      shiftSchema.parse({ ...validShift, startsAt: "2026-07-20T11:00:00.000Z", endsAt: "2026-07-20T09:00:00.000Z" })
    ).toThrow();
  });

  it("rejects a non-uuid clientId", () => {
    expect(() => shiftSchema.parse({ ...validShift, clientId: "not-a-uuid" })).toThrow();
  });
});
