import { describe, expect, it } from "vitest";
import { permissionSchema, systemRoleSchema } from "./permissions";

describe("permissionSchema", () => {
  it("accepts every known permission key", () => {
    for (const value of permissionSchema.options) {
      expect(permissionSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an unknown permission key", () => {
    expect(() => permissionSchema.parse("organization.delete")).toThrow();
  });
});

describe("systemRoleSchema", () => {
  it("accepts every known role", () => {
    for (const value of systemRoleSchema.options) {
      expect(systemRoleSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an unknown role", () => {
    expect(() => systemRoleSchema.parse("super_admin")).toThrow();
  });
});
