// The label under the person's name in the menu footer uses the same role names as Staff and Roles & Permissions.
import { describe, expect, it } from "vitest";
import { VIEW_TITLE, viewKind } from "./aws-workspace";

describe("view label", () => {
  it.each([
    ["organization_owner", "OWNER"],
    ["organization_admin", "ADMINISTRATOR"],
    ["manager", "MANAGER"],
    ["scheduler", "SCHEDULER"],
    ["coordinator", "SCHEDULER"],
    ["caregiver", "CAREGIVER"],
    ["read_only", "STAFF"],
    [null, "STAFF"],
  ])("%s shows %s VIEW", (role, label) => {
    expect(viewKind(role)).toBe(label);
  });

  it("the Owner is never labelled Administrator", () => {
    expect(viewKind("organization_owner")).not.toBe("ADMINISTRATOR");
    expect(VIEW_TITLE.OWNER).toBe("Owner");
  });
});
