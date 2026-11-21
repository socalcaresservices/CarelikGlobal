import { describe, expect, it } from "vitest";
import { ENVIRONMENTS } from "../lib/config.js";

describe("TEST database foundation isolation", () => {
  it("TEST and production do not share mutable foundation objects", () => {
    const test = ENVIRONMENTS.prod.existing;
    const production = ENVIRONMENTS.prd.existing;
    expect(test).not.toBe(production);
    expect(test.databases.prod).not.toBe(production.databases.prod);
    expect(test.databases.prod.securityGroupIds).not.toBe(production.databases.prod.securityGroupIds);
    expect(test.securityGroups).not.toBe(production.securityGroups);
  });
  it("preserves the verified production database and TEST's current target until cutover approval", () => {
    expect(ENVIRONMENTS.prd.existing.databases.prod).toMatchObject({
      instanceIdentifier: "ogevia-prod-postgres",
      endpointAddress: "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com",
      securityGroupIds: ["sg-00530a1f4f7648e65"],
      owner: { kind: "cloudformation", stackName: "ogevia-prod-data-layer", logicalId: "PostgreSQLDatabase" },
    });
    expect(ENVIRONMENTS.prod.existing).toEqual(ENVIRONMENTS.prd.existing);
    expect(ENVIRONMENTS.prod.database.name).toBe("ogevia_sv_test");
    expect(ENVIRONMENTS.prd.database.name).toBe("ogevia_prd");
  });
});
