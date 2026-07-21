import { describe, expect, it } from "vitest";
import { serviceSchema } from "./services";

const validService = {
  id: "55555555-5555-4555-8555-555555555555",
  organizationId: "11111111-1111-4111-8111-111111111111",
  name: "Personal care",
  isActive: true
};

describe("serviceSchema", () => {
  it("accepts a well-formed service", () => {
    expect(serviceSchema.parse(validService)).toEqual(validService);
  });

  it("rejects an empty name", () => {
    expect(() => serviceSchema.parse({ ...validService, name: "" })).toThrow();
  });
});
