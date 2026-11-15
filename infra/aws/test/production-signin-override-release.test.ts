import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { newApp } from "./helpers.js";

// The production release that enables the sign-in override adds exactly two routes. This gate is what the operator runs before and after the change set.
const helper = fileURLToPath(new URL("../scripts/production-signin-override-release.py", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "signin-override-release-"));
let n = 0;
const file = (x: unknown) => { const p = join(dir, `f${n++}.json`); writeFileSync(p, JSON.stringify(x)); return p; };
const run = (...args: string[]) => spawnSync(process.env.PYTHON ?? "python3", [helper, ...args], { encoding: "utf8" });

const POST = "ApiPOSTv1caregiverscaregiverRecordIdsigninoverrideB56070DA", GET = "ApiGETv1signinoverrides231FC345";
const KEYS = { [POST]: "POST /v1/caregivers/{caregiverRecordId}/signin-override", [GET]: "GET /v1/signin-overrides" };
const route = (RouteKey: string, over: Record<string, unknown> = {}) => ({
  Type: "AWS::ApiGatewayV2::Route",
  Properties: { ApiId: { Ref: "ApiF70053CD" }, AuthorizationType: "JWT", AuthorizerId: { Ref: "ApiCognitoJwt1870F097" }, RouteKey, Target: { "Fn::Join": ["", ["integrations/", { Ref: "ApiGETv1meHandlerCDA9441F" }]] }, ...over },
});
const live = (): any => ({
  Parameters: { QrEncryptionKey0102: { Type: "String", NoEcho: true } },
  Resources: {
    Handler886CB40B: { Type: "AWS::Lambda::Function", Properties: { Environment: { Variables: { DB_NAME: "ogevia_prd", OGEVIA_ENV: "prd", DB_HOST: "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com" } }, Code: { S3Bucket: "b", S3Key: "k.zip" } } },
    ApiGETv1attention23065B04: route("GET /v1/attention"),
    ...Object.fromEntries(["GET /v1/business-documents", "POST /v1/business-documents", "GET /v1/reports/missing-visits", "POST /v1/shifts/{shiftId}/missing-visit", "POST /v1/checkin", "POST /v1/clients/{clientId}/qr-card"].map((k, i) => [`Retained${i}`, route(k)])),
  },
});
const candidate = (): any => {
  const t = live();
  t.Resources.Handler886CB40B.Properties.Code = { S3Bucket: "other", S3Key: "different.zip" }; // the synthesized asset differs from the manually packaged live code: it must not matter
  for (const [id, key] of Object.entries(KEYS)) t.Resources[id] = route(key);
  return t;
};
const patch = (l: unknown, c: unknown) => { const out = join(dir, `out${n++}.json`); return { r: run("patch", file(l), file(c), out), out }; };

describe("production sign-in override release gate", () => {
  it("adds exactly the two routes to the live template and leaves the live Handler code and everything else untouched", () => {
    const { r, out } = patch(live(), candidate());
    expect(r.status, r.stderr).toBe(0);
    const after = JSON.parse(readFileSync(out, "utf8"));
    expect(Object.keys(after.Resources).filter((k) => !(k in live().Resources)).sort()).toEqual([GET, POST].sort());
    for (const id of [GET, POST]) delete after.Resources[id];
    expect(after).toEqual(live());
  });

  it.each([
    ["the TEST database", (l: any) => { l.Resources.Handler886CB40B.Properties.Environment.Variables.DB_NAME = "ogevia_sv_test"; }],
    ["a TEST environment name", (l: any) => { l.Resources.Handler886CB40B.Properties.Environment.Variables.OGEVIA_ENV = "prod"; }],
    ["a route that is already live", (l: any) => { l.Resources.Already = route(KEYS[GET]); }],
    ["a missing accepted route", (l: any) => { delete l.Resources.Retained0; }],
    ["bulk import already live", (l: any) => { l.Resources.Import = route("POST /v1/imports/{kind}"); }],
    ["no reference route", (l: any) => { delete l.Resources.ApiGETv1attention23065B04; }],
  ])("refuses a live template with %s", (_name, mutate) => {
    const l = live(); mutate(l);
    expect(patch(l, candidate()).r.status).not.toBe(0);
  });

  it.each([
    ["a candidate that enables bulk import", (c: any) => { c.Resources.Import = route("POST /v1/imports/{kind}"); }],
    ["a candidate that enables duplicate-staff review", (c: any) => { c.Resources.Dup = route("GET /v1/staff/duplicates"); }],
    ["a missing override route", (c: any) => { delete c.Resources[GET]; }],
    ["a public override route", (c: any) => { c.Resources[POST] = route(KEYS[POST], { AuthorizationType: "NONE" }); }],
    ["a route with another authorizer", (c: any) => { c.Resources[GET] = route(KEYS[GET], { AuthorizerId: { Ref: "SomeOtherAuthorizer" } }); }],
    ["a route to a different integration", (c: any) => { c.Resources[GET] = route(KEYS[GET], { Target: "integrations/abc" }); }],
    ["an extra route property", (c: any) => { c.Resources[GET].Properties.OperationName = "x"; }],
    ["a route with DependsOn", (c: any) => { c.Resources[GET].DependsOn = ["Handler886CB40B"]; }],
    ["a renamed logical id", (c: any) => { c.Resources.Renamed = c.Resources[GET]; delete c.Resources[GET]; }],
  ])("refuses %s", (_name, mutate) => {
    const c = candidate(); mutate(c);
    expect(patch(live(), c).r.status).not.toBe(0);
  });

  const changeSet = (action: string, ids = [POST, GET], over: Record<string, unknown> = {}) => ({
    Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE",
    Changes: ids.map((LogicalResourceId) => ({ ResourceChange: { LogicalResourceId, ResourceType: "AWS::ApiGatewayV2::Route", Action: action, Replacement: "False", Scope: ["Properties"], ...over } })),
  });
  it("accepts a change set that adds exactly the two routes, and a rollback that removes exactly them", () => {
    expect(run("changes", file(changeSet("Add"))).status).toBe(0);
    expect(run("rollback-changes", file(changeSet("Remove"))).status).toBe(0);
  });
  it.each([
    ["an added route that is not an override route", changeSet("Add", [POST, "ApiGETv1attention23065B04"])],
    ["only one route", changeSet("Add", [POST])],
    ["a third change (the Handler)", { ...changeSet("Add"), Changes: [...changeSet("Add").Changes, { ResourceChange: { LogicalResourceId: "Handler886CB40B", ResourceType: "AWS::Lambda::Function", Action: "Modify", Replacement: "False" } }] }],
    ["a modify instead of an add", changeSet("Modify")],
    ["a replacement", changeSet("Add", [POST, GET], { Replacement: "True" })],
    ["a change set that is not ready", { ...changeSet("Add"), ExecutionStatus: "UNAVAILABLE" }],
  ])("refuses a change set with %s", (_name, cs) => {
    expect(run("changes", file(cs)).status).not.toBe(0);
  });
  it("refuses a rollback change set that adds, and a forward change set that removes", () => {
    expect(run("rollback-changes", file(changeSet("Add"))).status).not.toBe(0);
    expect(run("changes", file(changeSet("Remove"))).status).not.toBe(0);
  });

  it("checks that both routes are present after, and absent before, the change", () => {
    expect(run("routes", file(candidate()), "present").status).toBe(0);
    expect(run("routes", file(live()), "absent").status).toBe(0);
    expect(run("routes", file(live()), "present").status).not.toBe(0);
    const one = candidate(); delete one.Resources[GET];
    expect(run("routes", file(one), "present").status).not.toBe(0);
    expect(run("routes", file(candidate()), "absent").status).not.toBe(0);
    expect(run("equal", file(live()), file(live())).status).toBe(0);
    expect(run("equal", file(live()), file(candidate())).status).not.toBe(0);
  });

  it("works on the real synthesized production templates: the live template stands in as the switch-off synthesis plus the six accepted routes it carries outside CDK, and patching it gives the candidate plus those six", () => {
    const synth = (on: boolean) => {
      const cfg = { ...ENVIRONMENTS.prd, features: { ...ENVIRONMENTS.prd.features, signInOverride: on } } as OgeviaEnvironmentConfig;
      const api = buildOgeviaApp(newApp(), cfg, "plan").find((p) => p.stack.stackName.endsWith("-ServiceVerificationApi"))!;
      return Template.fromStack(api.stack).toJSON() as any;
    };
    const off = synth(false), on = synth(true);
    // the logical ids and definitions the gate pins are the ones CDK really produces
    for (const [id, key] of Object.entries(KEYS)) expect(on.Resources[id]?.Properties?.RouteKey, id).toBe(key);
    // Production's live API carries six accepted routes (the liveTestRepairs set) that the CDK code does NOT synthesize for prd: a cdk deploy of this stack would REMOVE them.
    // That is why this release patches the captured live template and never deploys the synthesized one.
    const retained = ["GET /v1/business-documents", "POST /v1/business-documents", "GET /v1/reports/missing-visits", "POST /v1/shifts/{shiftId}/missing-visit", "POST /v1/checkin", "POST /v1/clients/{clientId}/qr-card"];
    const synthesized = new Set(Object.values<any>(off.Resources).filter((r) => r.Type === "AWS::ApiGatewayV2::Route").map((r) => r.Properties.RouteKey));
    for (const k of retained) expect(synthesized.has(k), `${k} is not synthesized for prd`).toBe(false);
    const liveLike = structuredClone(off);
    retained.forEach((k, i) => { liveLike.Resources[`Retained${i}`] = structuredClone(liveLike.Resources.ApiGETv1attention23065B04); liveLike.Resources[`Retained${i}`].Properties.RouteKey = k; });
    const { r, out } = patch(liveLike, on);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const patched = JSON.parse(readFileSync(out, "utf8"));
    retained.forEach((_k, i) => delete patched.Resources[`Retained${i}`]);
    expect(patched).toEqual(on);
  }, 60000);
});
