// diff_gate_rt2.py (TEST release of Release Train 2, stage "notifications") against REAL templates synthesized from this repository.
// "live" = the TEST API with the already-released switches ON and the notifications switch OFF, with an older Handler/Identity code asset;
// "off"/"on" = the same environment at the release commit. The gate must accept exactly the stage's delta and refuse anything else. Nothing touches AWS.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { newApp } from "./helpers.js";

const GATE = fileURLToPath(new URL("../../../docs/releases/2026-11-20-test-plan/toolchain/diff_gate_rt2.py", import.meta.url));
const BUCKET = "cdk-hnb659fds-assets-300094796789-us-west-2";
type T = { Resources: Record<string, any>; [k: string]: any };
const synth = (notifications: boolean): T => {
  const cfg = { ...ENVIRONMENTS.prod, features: { ...ENVIRONMENTS.prod.features, requestCleanup: true, offices: true, officeAssignments: true, assignmentHistory: true, notifications } } as OgeviaEnvironmentConfig;
  const p = buildOgeviaApp(newApp(), cfg, "plan").find((x) => x.stack.stackName.endsWith("-ServiceVerificationApi"))!;
  return JSON.parse(JSON.stringify(Template.fromStack(p.stack).toJSON()));
};
/** Make the code assets look like real CDK assets in the asset bucket; `tag` stands for the code version. */
const assets = (t: T, tag: string): T => {
  const c: T = JSON.parse(JSON.stringify(t));
  for (const [k, r] of Object.entries(c.Resources)) if (r.Type === "AWS::Lambda::Function" && (k.startsWith("Handler") || k.startsWith("IdentityHandler"))) {
    r.Properties.Code = { S3Bucket: BUCKET, S3Key: `${tag}-${k}.zip` }; r.Metadata = { ...(r.Metadata ?? {}), "aws:asset:path": `asset.${tag}` };
  }
  return c;
};
let dir = "";
const file = (name: string, t: T) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(t)); return p; };
const run = (live: T, now: T, expect: "off" | "on" | "post") => {
  const r = spawnSync("python3", [GATE, "--stage", "notifications", "--live", file("live.json", live), "--new", file("new.json", now), "--expect", expect], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
};
let LIVE: T, OFF: T, ON: T;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "rt2-gate-")); LIVE = assets(synth(false), "old"); OFF = assets(synth(false), "new"); ON = assets(synth(true), "new"); }, 120_000);
const clone = (t: T): T => JSON.parse(JSON.stringify(t));

describe("diff_gate_rt2.py (stage notifications)", () => {
  it("off: only the code assets change -> YES", () => { const r = run(LIVE, OFF, "off"); expect(r.out).toContain("EXPECTED-ONLY: YES (notifications, off)"); expect(r.code).toBe(0); });
  it("on: exactly the 10 routes, the schedule, its permission and the Handler env var (plus code) -> YES", () => {
    const r = run(LIVE, ON, "on"); expect(r.out, r.out).toContain("routes added: 10"); expect(r.out).toContain("COVER_ALERT_ADDRESS_RULES"); expect(r.out).toContain("EXPECTED-ONLY: YES (notifications, on)"); expect(r.code).toBe(0);
  });
  it("post: identical templates -> YES; a leftover difference -> NO", () => {
    expect(run(ON, clone(ON), "post").code).toBe(0);
    expect(run(LIVE, ON, "post").code).toBe(1);
  });
  it("refuses the ON assembly when asked for off (routes appear)", () => { const r = run(LIVE, ON, "off"); expect(r.code).toBe(1); expect(r.out).toContain("UNEXPECTED added resource"); });
  it("refuses an extra resource, a missing route, a changed policy, a changed environment variable and an extra environment variable", () => {
    const extra = clone(ON); extra.Resources.Sneaky = { Type: "AWS::SQS::Queue", Properties: {} }; expect(run(LIVE, extra, "on").code).toBe(1);
    const missing = clone(ON); const rid = Object.keys(missing.Resources).find((k) => missing.Resources[k].Properties?.RouteKey === "POST /v1/notification-center/mark")!; delete missing.Resources[rid]; const m = run(LIVE, missing, "on"); expect(m.code).toBe(1); expect(m.out).toContain("missing");
    const policy = clone(ON); const pid = Object.keys(policy.Resources).find((k) => policy.Resources[k].Type === "AWS::IAM::ManagedPolicy" || policy.Resources[k].Type === "AWS::IAM::Policy")!; policy.Resources[pid].Properties.PolicyDocument.Statement.push({ Effect: "Allow", Action: "s3:*", Resource: "*" }); expect(run(LIVE, policy, "on").out).toContain("CHANGED resource");
    const env = clone(ON); const hid = Object.keys(env.Resources).find((k) => k.startsWith("Handler") && env.Resources[k].Type === "AWS::Lambda::Function")!; env.Resources[hid].Properties.Environment.Variables.DB_NAME = "ogevia_prd"; expect(run(LIVE, env, "on").code).toBe(1);
    const extraEnv = clone(ON); extraEnv.Resources[hid].Properties.Environment.Variables.EMAIL_FUNCTION_NAME = "x"; expect(run(LIVE, extraEnv, "on").code).toBe(1);
  });
  it("refuses a code asset outside the CDK asset bucket and a changed non-code property of the Identity function", () => {
    const bucket = clone(ON); const hid = Object.keys(bucket.Resources).find((k) => k.startsWith("Handler") && bucket.Resources[k].Type === "AWS::Lambda::Function")!; bucket.Resources[hid].Properties.Code.S3Bucket = "attacker-bucket"; expect(run(LIVE, bucket, "on").code).toBe(1);
    const idn = clone(ON); const iid = Object.keys(idn.Resources).find((k) => k.startsWith("IdentityHandler") && idn.Resources[k].Type === "AWS::Lambda::Function")!; idn.Resources[iid].Properties.Timeout = 899; expect(run(LIVE, idn, "on").code).toBe(1);
  });
  it("refuses a change in Outputs/Parameters", () => { const o = clone(ON); o.Outputs = { ...(o.Outputs ?? {}), Extra: { Value: "x" } }; expect(run(LIVE, o, "on").out).toContain("section Outputs differs"); });
});
