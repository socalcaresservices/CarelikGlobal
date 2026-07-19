import { describe, expect, it } from "vitest";
import { membershipStatusSchema, organizationMembershipSchema } from "./membership";

const validMembership = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "33333333-3333-4333-8333-333333333333",
  role: "organization_admin" as const,
  status: "active" as const
};

describe("membershipStatusSchema", () => {
  it("accepts every known status", () => {
    for (const value of membershipStatusSchema.options) {
      expect(membershipStatusSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an unknown status", () => {
    expect(() => membershipStatusSchema.parse("pending")).toThrow();
  });
});

describe("organizationMembershipSchema", () => {
  it("accepts a well-formed membership", () => {
    expect(organizationMembershipSchema.parse(validMembership)).toEqual(validMembership);
  });

  it("allows role 'platform_owner' at the schema level", () => {
    // systemRoleSchema is shared with user_profiles.platform_role, so it
    // includes platform_owner. The database disallows it on
    // organization_memberships specifically via a check constraint
    // (organization_memberships_role_check), not via this shared schema.
    expect(() =>
      organizationMembershipSchema.parse({ ...validMembership, role: "platform_owner" })
    ).not.toThrow();
  });

  it("rejects an invalid status", () => {
    expect(() =>
      organizationMembershipSchema.parse({ ...validMembership, status: "pending" })
    ).toThrow();
  });

  it("rejects a non-uuid id", () => {
    expect(() =>
      organizationMembershipSchema.parse({ ...validMembership, id: "not-a-uuid" })
    ).toThrow();
  });
});
