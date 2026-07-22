import { describe, expect, it } from "vitest";
import { globalSearchResultSchema, globalSearchResultTypeSchema } from "./search";

describe("globalSearchResultTypeSchema", () => {
  it("accepts every known result type", () => {
    for (const value of ["client", "caregiver", "credential", "authorization", "incident", "service"]) {
      expect(globalSearchResultTypeSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an unknown result type", () => {
    expect(() => globalSearchResultTypeSchema.parse("invoice")).toThrow();
  });
});

describe("globalSearchResultSchema", () => {
  const base = {
    resultType: "client" as const,
    entityId: "11111111-1111-4111-8111-111111111111",
    title: "Jordan Rivera",
    subtitle: "555-0100"
  };

  it("accepts a well-formed result", () => {
    expect(globalSearchResultSchema.parse(base)).toEqual(base);
  });

  it("accepts a null subtitle", () => {
    expect(globalSearchResultSchema.parse({ ...base, subtitle: null }).subtitle).toBeNull();
  });

  it("rejects a non-uuid entityId", () => {
    expect(() => globalSearchResultSchema.parse({ ...base, entityId: "not-a-uuid" })).toThrow();
  });

  it("rejects a missing title", () => {
    const { title: _title, ...rest } = base;
    expect(() => globalSearchResultSchema.parse(rest)).toThrow();
  });
});
