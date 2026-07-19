import { describe, expect, it } from "vitest";
import { incidentSchema, incidentSeveritySchema, incidentStatusSchema } from "./incidents";

const validIncident = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  clientId: "33333333-3333-4333-8333-333333333333",
  clientName: "Jordan Rivera",
  caregiverUserId: "44444444-4444-4444-8444-444444444444",
  caregiverName: "Sam Caregiver",
  occurredAt: "2026-07-19T09:00:00.000Z",
  category: "Fall",
  severity: "medium" as const,
  status: "open" as const,
  description: "Client had a minor fall while getting out of bed.",
  reportedBy: "44444444-4444-4444-8444-444444444444",
  reportedByName: "Sam Caregiver",
  resolutionNotes: null,
  resolvedAt: null
};

describe("incidentSeveritySchema", () => {
  it("accepts every known severity", () => {
    for (const value of incidentSeveritySchema.options) {
      expect(incidentSeveritySchema.parse(value)).toBe(value);
    }
  });
});

describe("incidentStatusSchema", () => {
  it("accepts every known status", () => {
    for (const value of incidentStatusSchema.options) {
      expect(incidentStatusSchema.parse(value)).toBe(value);
    }
  });
});

describe("incidentSchema", () => {
  it("accepts a well-formed incident", () => {
    expect(incidentSchema.parse(validIncident)).toEqual(validIncident);
  });

  it("accepts an incident with no client or caregiver linked", () => {
    const incident = { ...validIncident, clientId: null, clientName: null, caregiverUserId: null, caregiverName: null };
    expect(incidentSchema.parse(incident)).toEqual(incident);
  });

  it("rejects an empty description", () => {
    expect(() => incidentSchema.parse({ ...validIncident, description: "" })).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => incidentSchema.parse({ ...validIncident, status: "closed" })).toThrow();
  });
});
