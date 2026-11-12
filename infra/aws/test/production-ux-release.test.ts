import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const helper = fileURLToPath(new URL("../scripts/production-ux-release.py", import.meta.url));
const run = (...args: string[]) => {
  const r = spawnSync(process.env.PYTHON ?? "python3", [helper, ...args], { encoding: "utf8" });
  return { ...r, stdout: r.stdout?.replaceAll("\r\n", "\n") };
};
function fixture() {
  const routes = ["GET /v1/business-documents", "POST /v1/business-documents", "GET /v1/reports/missing-visits", "POST /v1/shifts/{shiftId}/missing-visit", "POST /v1/checkin", "POST /v1/clients/{clientId}/qr-card"];
  return {
    Parameters: { ClientQrEncryptionKey: { Type: "String", NoEcho: true, Default: "" } },
    Resources: {
      Handler886CB40B: { Type: "AWS::Lambda::Function", Properties: { Runtime: "nodejs24.x", Code: { S3Bucket: { Ref: "RepairCodeBucket" }, S3Key: { Ref: "RepairCodeKey" } }, Environment: { Variables: {
        DB_NAME: "ogevia_prd", DB_HOST: "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com", OGEVIA_ENV: "prd", COGNITO_USER_POOL_ID: "us-west-2_FHJoX71ca", OGEVIA_QR_ENCRYPTION_KEY: { Ref: "ClientQrEncryptionKey" },
      } } } },
      ...Object.fromEntries(routes.map((RouteKey, i) => [`Route${i}`, { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey } }])),
    },
  };
}
function patch(t: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "production-ux-"));
  const input = join(dir, "before.json"), output = join(dir, "after.json");
  writeFileSync(input, JSON.stringify(t));
  return { result: run("patch", input, output), output };
}
it("changes only Handler Code and preserves QR, production auth and every existing route", () => {
  const before = fixture();
  const { result, output } = patch(before);
  expect(result.status, result.stderr).toBe(0);
  const after = JSON.parse(readFileSync(output, "utf8"));
  expect(after.Resources.Handler886CB40B.Properties.Code.S3Key).toBe("ed01f08a2df9d8870ed44c25912ce9c9d18f4e6dd73dba29594c954a538c983b.zip");
  after.Resources.Handler886CB40B.Properties.Code = before.Resources.Handler886CB40B.Properties.Code;
  expect(after).toEqual(before);
});
it("preserves the production Auth stack import as well as its resolved runtime pool", () => {
  const t: any = fixture();
  t.Resources.Handler886CB40B.Properties.Environment.Variables.COGNITO_USER_POOL_ID = { "Fn::ImportValue": "Ogevia-prd-Auth:ExportsOutputRefUserPool19CF3AE1" };
  expect(patch(t).result.status).toBe(0);
  t.Resources.Handler886CB40B.Properties.Environment.Variables.COGNITO_USER_POOL_ID = { "Fn::ImportValue": "Ogevia-prod-Auth:ExportsOutputRefUserPool19CF3AE1" };
  expect(patch(t).result.status).not.toBe(0);
});
it.each(["test database", "test identity pool", "exposed QR key", "removed accepted route", "enabled import"])("refuses %s", (kind) => {
  const t: any = fixture();
  const env = t.Resources.Handler886CB40B.Properties.Environment.Variables;
  if (kind === "test database") env.DB_NAME = "ogevia_sv_test";
  if (kind === "test identity pool") env.COGNITO_USER_POOL_ID = "us-west-2_849AYz5J7";
  if (kind === "exposed QR key") env.OGEVIA_QR_ENCRYPTION_KEY = "literal-secret";
  if (kind === "removed accepted route") delete t.Resources.Route0;
  if (kind === "enabled import") t.Resources.Import = { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: "POST /v1/imports/{kind}" } };
  expect(patch(t).result.status).not.toBe(0);
});
it("refuses a change set that replaces the Handler or changes permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "production-changes-")), path = join(dir, "changes.json");
  const d: any = { Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Changes: [{ ResourceChange: { LogicalResourceId: "Handler886CB40B", ResourceType: "AWS::Lambda::Function", Action: "Modify", Replacement: "False", Scope: ["Properties"], Details: [{ Target: { Attribute: "Properties", Name: "Code" } }] } }] };
  writeFileSync(path, JSON.stringify(d)); expect(run("changes", path).status).toBe(0);
  d.Changes[0].ResourceChange.Replacement = "True";
  writeFileSync(path, JSON.stringify(d)); expect(run("changes", path).status).not.toBe(0);
  d.Changes[0].ResourceChange.Replacement = "False";
  d.Changes[0].ResourceChange.Details[0].Target.Name = "Role";
  writeFileSync(path, JSON.stringify(d)); expect(run("changes", path).status).not.toBe(0);
});
it("generates a single transaction with an exact baseline guard and no TEST seed or database creation", () => {
  const r = run("sql"); expect(r.status, r.stderr).toBe(0);
  expect(r.stdout.startsWith("begin;\n")).toBe(true);
  expect(r.stdout.trimEnd().endsWith("commit;")).toBe(true);
  expect(r.stdout).toContain("current_database() <> 'ogevia_prd'");
  expect(r.stdout.match(/insert into ogevia_meta.schema_migrations/g)).toHaveLength(5);
  expect(r.stdout).not.toMatch(/create database|seed_synthetic|create role/i);
  expect(run("sql", "ogevia_sv_test").status).not.toBe(0);
});
