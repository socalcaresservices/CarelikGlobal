// production-0109-release.py: the production template patch and the change-set check. No AWS calls.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const helper = join(root, "infra/aws/scripts/production-0109-release.py");
const KEY = "0877a461644480499fff3a5f2e80c0624b9692a2b15536643ff54bba25a6c739.zip";
const run = (...args: string[]) => spawnSync("python3", [helper, ...args], { encoding: "utf8", env: { ...process.env, OGEVIA_UX_SOURCE_ROOT: root } });
function fixture() {
  const routes = ["GET /v1/business-documents", "POST /v1/business-documents", "GET /v1/reports/missing-visits", "POST /v1/shifts/{shiftId}/missing-visit", "POST /v1/checkin", "POST /v1/clients/{clientId}/qr-card"];
  return {
    Parameters: { ClientQrEncryptionKey: { Type: "String", NoEcho: true, Default: "" } },
    Resources: {
      Handler886CB40B: { Type: "AWS::Lambda::Function", Properties: { Runtime: "nodejs24.x", Code: { S3Bucket: "cdk-hnb659fds-assets-300094796789-us-west-2", S3Key: "ed01f08a2df9d8870ed44c25912ce9c9d18f4e6dd73dba29594c954a538c983b.zip" }, Environment: { Variables: {
        DB_NAME: "ogevia_prd", DB_HOST: "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com", OGEVIA_ENV: "prd", COGNITO_USER_POOL_ID: "us-west-2_FHJoX71ca", OGEVIA_QR_ENCRYPTION_KEY: { Ref: "ClientQrEncryptionKey" },
      } } } },
      ...Object.fromEntries(routes.map((RouteKey, i) => [`Route${i}`, { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey } }])),
    },
  };
}
function patch(t: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "prd0109-")); const input = join(dir, "before.json"), output = join(dir, "after.json");
  writeFileSync(input, JSON.stringify(t));
  return { result: run("patch", input, output), output };
}

it("changes only the Handler Code to this release's asset and keeps every route, the QR key and the production auth", () => {
  const before = fixture(); const { result, output } = patch(before);
  expect(result.status, result.stderr).toBe(0);
  const after = JSON.parse(readFileSync(output, "utf8"));
  expect(after.Resources.Handler886CB40B.Properties.Code).toEqual({ S3Bucket: "cdk-hnb659fds-assets-300094796789-us-west-2", S3Key: KEY });
  after.Resources.Handler886CB40B.Properties.Code = before.Resources.Handler886CB40B.Properties.Code;
  expect(after).toEqual(before);
});
it("refuses when the switch is already on (any of the three routes present), the test database, the test pool, an exposed QR key or a removed accepted route", () => {
  for (const route of ["POST /v1/care-notifications/read", "POST /v1/documents/{documentId}/cancel", "POST /v1/document-types/{documentTypeId}/retire"]) {
    const t: any = fixture(); t.Resources.On = { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: route } };
    expect(patch(t).result.status, route).not.toBe(0);
  }
  for (const kind of ["test database", "test pool", "qr", "route"]) {
    const t: any = fixture(); const env = t.Resources.Handler886CB40B.Properties.Environment.Variables;
    if (kind === "test database") env.DB_NAME = "ogevia_sv_test"; if (kind === "test pool") env.COGNITO_USER_POOL_ID = "us-west-2_849AYz5J7";
    if (kind === "qr") env.OGEVIA_QR_ENCRYPTION_KEY = "literal-secret"; if (kind === "route") delete t.Resources.Route0;
    expect(patch(t).result.status, kind).not.toBe(0);
  }
});
it("accepts the two sign-in override routes that are live in production since 2026-11-15, and still refuses import and duplicate-staff routes", () => {
  const live: any = fixture();
  live.Resources.O1 = { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: "GET /v1/signin-overrides" } };
  live.Resources.O2 = { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: "POST /v1/caregivers/{caregiverRecordId}/signin-override" } };
  const { result, output } = patch(live);
  expect(result.status, result.stderr).toBe(0);
  const after = JSON.parse(readFileSync(output, "utf8")); after.Resources.Handler886CB40B.Properties.Code = live.Resources.Handler886CB40B.Properties.Code;
  expect(after).toEqual(live);
  for (const route of ["POST /v1/imports/{kind}", "GET /v1/staff/duplicates", "POST /v1/staff/{profileId}/merge"]) {
    const t: any = fixture(); t.Resources.X = { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: route } };
    expect(patch(t).result.status, route).not.toBe(0);
  }
});
it("refuses when production is already on this code", () => {
  const t: any = fixture(); t.Resources.Handler886CB40B.Properties.Code.S3Key = KEY;
  expect(patch(t).result.status).not.toBe(0);
});
it("accepts a change set that updates only the Handler Code, and refuses a replacement or an unreviewed dependent", () => {
  const dir = mkdtempSync(join(tmpdir(), "prd0109-cs-")); const p = join(dir, "cs.json");
  const handler = { ResourceChange: { LogicalResourceId: "Handler886CB40B", ResourceType: "AWS::Lambda::Function", Action: "Modify", Replacement: "False", Scope: ["Properties"], Details: [{ Target: { Attribute: "Properties", Name: "Code" } }] } };
  const ok = { Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Changes: [handler] };
  writeFileSync(p, JSON.stringify(ok)); expect(run("changes", p).status).toBe(0);
  writeFileSync(p, JSON.stringify({ ...ok, Changes: [{ ResourceChange: { ...handler.ResourceChange, Replacement: "True" } }] })); expect(run("changes", p).status).not.toBe(0);
  writeFileSync(p, JSON.stringify({ ...ok, Changes: [handler, { ResourceChange: { LogicalResourceId: "SomeRole", ResourceType: "AWS::IAM::Role", Action: "Modify", Replacement: "False", Scope: ["Properties"], Details: [] } }] })); expect(run("changes", p).status).not.toBe(0);
});
