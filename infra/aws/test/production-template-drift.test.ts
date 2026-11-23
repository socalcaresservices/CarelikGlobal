import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS } from "../lib/config.js";
import { newApp } from "./helpers.js";

// production-template-drift.py: the read-only report that says how the CDK code differs from the LIVE production stack (the first step of aligning them). It is exercised on the real
// synthesized production template, with a "live" template built the way production actually differs: six extra routes, a different QR parameter, a manually packaged Handler code.
const tool = fileURLToPath(new URL("../scripts/production-template-drift.py", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "drift-"));
let n = 0;
const file = (x: unknown) => { const p = join(dir, `t${n++}.json`); writeFileSync(p, JSON.stringify(x)); return p; };
const run = (live: unknown, code: unknown, ...extra: string[]) => { const r = spawnSync("python3", [tool, file(live), file(code), ...extra], { encoding: "utf8" }); return { status: r.status, out: r.stdout + r.stderr }; };

const SIX = ["GET /v1/business-documents", "POST /v1/business-documents", "GET /v1/reports/missing-visits", "POST /v1/shifts/{shiftId}/missing-visit", "POST /v1/checkin", "POST /v1/clients/{clientId}/qr-card"];
let code: any;
const copy = () => structuredClone(code);
const handlerId = (t: any) => Object.keys(t.Resources).find((k) => t.Resources[k].Type === "AWS::Lambda::Function" && k.startsWith("Handler"))!;

beforeAll(() => {
  const app = newApp(); app.node.setContext("aws:cdk:enable-path-metadata", true);
  const api = buildOgeviaApp(app, ENVIRONMENTS.prd, "plan").find((p) => p.stack.stackName.endsWith("-ServiceVerificationApi"))!;
  code = Template.fromStack(api.stack).toJSON();
}, 60000);

describe("production-template-drift.py", () => {
  it("reports NO DRIFT for identical templates, ignoring the cdk construct-path metadata", () => {
    const live = copy(); for (const r of Object.values<any>(live.Resources)) delete r.Metadata;
    const r = run(live, code); expect(r.status).toBe(0); expect(r.out).toContain("NO DRIFT");
    expect(run(live, code, "--fail-on-drift").status).toBe(0);
  });

  it("reports how production really differs: the six routes only in live, the QR parameter and the Handler code, and fails with --fail-on-drift", () => {
    const live = copy(), hid = handlerId(live);
    SIX.forEach((k, i) => { live.Resources[`Live${i}`] = structuredClone(live.Resources.ApiGETv1attention23065B04); live.Resources[`Live${i}`].Properties.RouteKey = k; });
    live.Parameters = { ...(live.Parameters ?? {}), QrEncryptionKey0102: { Type: "String", NoEcho: true, Default: "" } };
    live.Resources[hid].Properties.Environment.Variables.OGEVIA_QR_ENCRYPTION_KEY = { Ref: "QrEncryptionKey0102" };
    live.Resources[hid].Properties.Code = { S3Bucket: "cdk-bucket", S3Key: "manually-packaged.zip" };
    const r = run(live, code, "--fail-on-drift");
    expect(r.status).toBe(1);
    expect(r.out).toContain("Routes only in LIVE (the code would REMOVE them on a deploy): 6");
    for (const k of SIX) expect(r.out).toContain(k);
    expect(r.out).toContain("Routes only in CODE (a deploy would ADD them): 0");
    expect(r.out).toMatch(/Parameters: only in live \['QrEncryptionKey0102'\]/);
    expect(r.out).toContain(`${hid}  [AWS::Lambda::Function]`);
    expect(r.out).toContain("env OGEVIA_QR_ENCRYPTION_KEY: only in live");
    expect(r.out).toMatch(/Code: live .*manually-packaged\.zip/);
    expect(r.out).toContain("DRIFT: ");
    expect(run(live, code).status).toBe(0);      // a report, not a failure, without the flag
  });

  it("flags a route whose logical id differs (CloudFormation would delete and recreate it)", () => {
    const live = copy(); live.Resources.RenamedAttention = live.Resources.ApiGETv1attention23065B04; delete live.Resources.ApiGETv1attention23065B04;
    const r = run(live, code);
    expect(r.out).toMatch(/Same route, DIFFERENT logical id .*: 1/); expect(r.out).toContain("GET /v1/attention  live RenamedAttention | code ApiGETv1attention23065B04");
  });

  it("never prints the value of a secret-looking setting, on either side", () => {
    const live = copy(), hid = handlerId(live);
    live.Resources[hid].Properties.Environment.Variables.SOME_API_TOKEN = "live-secret-value-123";
    const c = copy(); c.Resources[hid].Properties.Environment.Variables.SOME_API_TOKEN = "code-secret-value-456";
    const r = run(live, c);
    expect(r.out).toContain("env SOME_API_TOKEN: differs (value hidden)");
    expect(r.out).not.toContain("live-secret-value-123"); expect(r.out).not.toContain("code-secret-value-456");
  });

  it("is read-only and offline: no AWS or network calls and no writes", () => {
    const text = require("node:fs").readFileSync(tool, "utf8");
    expect(text).not.toMatch(/boto|subprocess|urllib|requests|socket|\bopen\([^)]*['"]w/);
  });
});
