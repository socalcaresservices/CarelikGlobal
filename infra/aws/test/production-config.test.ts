// Production (env=prd) isolation contract: the database, secret and stacks are
// separate from the pilot/test slice (env=prod), and nothing falls back to it.
import { readFileSync } from "node:fs";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { assertDatabaseConfig, ENVIRONMENTS, resolveEnvironment, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { ServiceVerificationApiStack } from "../lib/service-verification-api-stack.js";
import { newApp } from "./helpers.js";

const prd = ENVIRONMENTS.prd;
const prod = ENVIRONMENTS.prod;
const prdStacks = buildOgeviaApp(newApp(), prd, "plan");
const prodStacks = buildOgeviaApp(newApp(), prod, "plan");
const tpl = (planned: typeof prdStacks, suffix: string) =>
  Template.fromStack(planned.find((p) => p.stack.stackName.endsWith(suffix))!.stack);
const lambdaEnv = (t: Template) => {
  const fns = Object.values(t.findResources("AWS::Lambda::Function")).filter((f) => f.Properties?.Environment?.Variables?.DB_NAME);
  expect(fns).toHaveLength(1);
  return fns[0]!.Properties.Environment.Variables as Record<string, unknown>;
};

describe("environment selection", () => {
  it("env=prd and env=production select production; env=prod stays the pilot/test slice", () => {
    expect(resolveEnvironment("prd").database.name).toBe("ogevia_prd");
    expect(resolveEnvironment("production").database.name).toBe("ogevia_prd");
    expect(resolveEnvironment("prod").database.name).toBe("ogevia_sv_test");
    expect(resolveEnvironment("prod").testSlice.databaseName).toBe("ogevia_sv_test");
  });
  it("there is no default environment", () => {
    expect(() => resolveEnvironment(undefined)).toThrow(/prd/);
    expect(() => resolveEnvironment("staging")).toThrow();
  });
});

describe("production fails closed", () => {
  const broken = (patch: Partial<OgeviaEnvironmentConfig["database"]>): OgeviaEnvironmentConfig => ({ ...prd, database: { ...prd.database, ...patch } });
  it("refuses the test database, a test-like name, or a missing name", () => {
    expect(() => assertDatabaseConfig(broken({ name: "ogevia_sv_test" }))).toThrow();
    expect(() => assertDatabaseConfig(broken({ name: "ogevia_prd_test" }))).toThrow();
    expect(() => assertDatabaseConfig(broken({ name: "" }))).toThrow();
  });
  it("refuses the shared login, a missing login, the test secret, or a missing secret", () => {
    expect(() => assertDatabaseConfig(broken({ appLogin: "ogevia_app" }))).toThrow();
    expect(() => assertDatabaseConfig(broken({ appLogin: undefined }))).toThrow();
    expect(() => assertDatabaseConfig(broken({ appSecretName: "ogevia/database/app" }))).toThrow();
    expect(() => assertDatabaseConfig(broken({ appSecretName: undefined }))).toThrow();
  });
  it("refuses a production database on the prod (test-slice) environment, and a test database on prd", () => {
    expect(() => assertDatabaseConfig({ ...prod, database: { ...prd.database } })).toThrow();
    expect(() => assertDatabaseConfig({ ...prd, database: { purpose: "test-slice", name: "ogevia_sv_test" } })).toThrow();
  });
  it("the production API stack cannot be built without its dedicated secret", () => {
    const app = newApp();
    const evidence = prdStacks.find((p) => p.stack.stackName.endsWith("-EvidenceStorage"))!.stack as unknown as { dataKey: never };
    expect(
      () =>
        new ServiceVerificationApiStack(app, "NoSecret", {
          config: prd,
          env: { account: prd.account, region: prd.region },
          evidenceKey: evidence.dataKey,
        }),
    ).toThrow(/dedicated database secret/);
  });
});

describe("production deployment (Ogevia-prd-*)", () => {
  it("synthesizes separate stacks and does not create a second NetworkEgress", () => {
    const names = prdStacks.map((p) => p.stack.stackName).sort();
    expect(names).toEqual([
      "Ogevia-prd-Auth",
      "Ogevia-prd-DatabaseSecret",
      "Ogevia-prd-EvidenceStorage",
      "Ogevia-prd-Observability",
      "Ogevia-prd-ServiceVerificationApi",
      "Ogevia-prd-WebHosting",
    ]);
  });

  it("the Lambda gets DB_NAME and OGEVIA_ENV from the selected configuration", () => {
    const env = lambdaEnv(tpl(prdStacks, "-ServiceVerificationApi"));
    expect(env.DB_NAME).toBe("ogevia_prd");
    expect(env.OGEVIA_ENV).toBe("prd");
    expect(env.DB_SET_ROLE).toBe("ogevia_app");
    expect(env.IDENTITY_FUNCTION_NAME).toBe("Ogevia-prd-IdentityAdmin");
  });

  it("the pilot Lambda is unchanged: still ogevia_sv_test on the test secret", () => {
    const env = lambdaEnv(tpl(prodStacks, "-ServiceVerificationApi"));
    expect(env.DB_NAME).toBe("ogevia_sv_test");
    expect(env.OGEVIA_ENV).toBe("prod");
    expect(JSON.stringify(env.DB_SECRET_ARN)).toContain("ogevia/database/app-JsOTVQ");
  });

  it("no production template mentions the test database or the test secret", () => {
    for (const { stack } of prdStacks) {
      const json = JSON.stringify(Template.fromStack(stack).toJSON());
      expect(json, stack.stackName).not.toContain("ogevia_sv_test");
      expect(json, stack.stackName).not.toContain("ogevia/database/app-JsOTVQ");
    }
  });

  it("the Lambda reads only the production secret, imported from the DatabaseSecret stack", () => {
    const t = tpl(prdStacks, "-ServiceVerificationApi");
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain("Ogevia-prd-DatabaseSecret:ExportsOutputRef");
    const policies = Object.values(t.findResources("AWS::IAM::ManagedPolicy"));
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement as Array<{ Sid?: string; Resource: unknown }>);
    const secretStatement = statements.find((s) => s.Sid === "ReadAppDatabaseSecret")!;
    expect(JSON.stringify(secretStatement.Resource)).toContain("DatabaseSecret");
  });

  it("the database secret is generated, retained, and holds no password in the template", () => {
    const t = tpl(prdStacks, "-DatabaseSecret");
    const secrets = Object.values(t.findResources("AWS::SecretsManager::Secret"));
    expect(secrets).toHaveLength(1);
    const s = secrets[0]!;
    expect(s.DeletionPolicy).toBe("Retain");
    expect(s.Properties.Name).toBe("ogevia/prd/database/app");
    expect(JSON.parse(s.Properties.GenerateSecretString.SecretStringTemplate)).toEqual({ username: "ogevia_prd_app", dbname: "ogevia_prd" });
    expect(JSON.stringify(s)).not.toMatch(/"password"\s*:\s*"[^"]/);
  });

  it("production has its own evidence bucket, distinct from the pilot's", () => {
    const names = (planned: typeof prdStacks) =>
      Object.values(tpl(planned, "-EvidenceStorage").findResources("AWS::S3::Bucket")).map((b) => b.Properties.BucketName).filter(Boolean);
    const prdBuckets = names(prdStacks);
    const prodBuckets = names(prodStacks);
    expect(prdBuckets.length).toBeGreaterThan(0);
    for (const b of prdBuckets) expect(prodBuckets).not.toContain(b);
  });

  it("the pilot's NetworkEgress endpoints additionally admit the production secret, bucket and identity function", () => {
    const json = JSON.stringify(tpl(prodStacks, "-NetworkEgress").toJSON());
    expect(json).toContain("secret:ogevia/prd/database/app-??????");
    expect(json).toContain("ogevia-prd-signature-evidence-");
    expect(json).toContain("function:Ogevia-prd-IdentityAdmin");
    expect(json).toContain("function:Ogevia-prod-IdentityAdmin");
    expect(json).toContain("ogevia/database/app-JsOTVQ");
  });
});

describe("deploy-production.sh", () => {
  const script = readFileSync(new URL("../scripts/deploy-production.sh", import.meta.url), "utf8");
  it("is strict, never traces, and never echoes secret variables", () => {
    expect(script).toContain("set -euo pipefail");
    expect(script).not.toMatch(/^\s*set -x|\bset -[a-z]*x[a-z]*\b/m);
    expect(script).not.toMatch(/echo[^\n]*\$\{?(APP_PASSWORD|TEST_PASSWORD|MASTER_PASS|PGPASSWORD|MASTER)\b/);
  });
  it("targets only ogevia_prd and never hard-codes the test database or an admin email", () => {
    expect(script).not.toContain("ogevia_sv_test");
    expect(script).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|org|net)/);
  });
  it("orders the steps: secret and egress and database before infra and smoke", () => {
    const order = script.slice(script.indexOf("  all)")).match(/do_(check|snapshot|secret|egress|database|infra|smoke)/g);
    expect(order).toEqual(["do_check", "do_snapshot", "do_secret", "do_egress", "do_database", "do_infra", "do_smoke"]);
  });
  it("does not delete or destroy anything", () => {
    expect(script).not.toMatch(/\b(delete-db|delete-secret|destroy|drop database|drop table|rm -rf)\b/i);
  });
});
