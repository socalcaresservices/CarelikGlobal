import { describe, expect, it } from "vitest";
import { organizationSettingSchema } from "./organization-settings";

const validSetting = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  key: "notifications.default_channel",
  value: { channel: "email" },
  version: 1,
  updatedBy: "33333333-3333-4333-8333-333333333333",
  updatedAt: "2026-07-19T00:00:00.000Z"
};

describe("organizationSettingSchema", () => {
  it("accepts a well-formed setting", () => {
    expect(organizationSettingSchema.parse(validSetting)).toEqual(validSetting);
  });

  it("allows an arbitrary jsonb value shape, including primitives", () => {
    expect(() => organizationSettingSchema.parse({ ...validSetting, value: "email" })).not.toThrow();
    expect(() => organizationSettingSchema.parse({ ...validSetting, value: 42 })).not.toThrow();
    expect(() => organizationSettingSchema.parse({ ...validSetting, value: null })).not.toThrow();
  });

  it("allows a null updatedBy (setting never touched by a user)", () => {
    expect(() =>
      organizationSettingSchema.parse({ ...validSetting, updatedBy: null })
    ).not.toThrow();
  });

  it("rejects a non-uuid organizationId", () => {
    expect(() =>
      organizationSettingSchema.parse({ ...validSetting, organizationId: "not-a-uuid" })
    ).toThrow();
  });

  it("rejects an empty key", () => {
    expect(() => organizationSettingSchema.parse({ ...validSetting, key: "" })).toThrow();
  });

  it("rejects a non-positive version", () => {
    expect(() => organizationSettingSchema.parse({ ...validSetting, version: 0 })).toThrow();
  });
});
