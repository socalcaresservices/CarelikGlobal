import { describe, expect, it } from "vitest";
import { organizationIdSchema, organizationSchema } from "./tenant";

const validOrganization = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme-care",
  legalName: "Acme Care LLC",
  displayName: "Acme Care",
  status: "active" as const,
  timezone: "America/Los_Angeles"
};

describe("organizationIdSchema", () => {
  it("accepts a uuid", () => {
    expect(organizationIdSchema.parse(validOrganization.id)).toBe(validOrganization.id);
  });

  it("rejects a non-uuid string", () => {
    expect(() => organizationIdSchema.parse("not-a-uuid")).toThrow();
  });
});

describe("organizationSchema", () => {
  it("accepts a well-formed organization", () => {
    expect(organizationSchema.parse(validOrganization)).toEqual(validOrganization);
  });

  it("rejects an invalid status", () => {
    expect(() =>
      organizationSchema.parse({ ...validOrganization, status: "archived" })
    ).toThrow();
  });

  it("rejects a slug shorter than 2 characters", () => {
    expect(() => organizationSchema.parse({ ...validOrganization, slug: "a" })).toThrow();
  });

  it("rejects a legal name shorter than 2 characters", () => {
    expect(() =>
      organizationSchema.parse({ ...validOrganization, legalName: "A" })
    ).toThrow();
  });
});
