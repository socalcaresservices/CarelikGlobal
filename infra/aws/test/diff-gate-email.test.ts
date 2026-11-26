// diff_gate_email.py against REAL synthesized templates: turning the TEST email function on is exactly the allowed additions (and nothing else); a rollback assembly is code-only; tampering is refused.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { newApp } from "./helpers.js";

const GATE = fileURLToPath(new URL("../../../docs/releases/2026-11-20-test-plan/toolchain/diff_gate_email.py", import.meta.url));
const ARN = "arn:aws:ses:us-west-2:300094796789:identity/ogevia.com";
const feats = { ...ENVIRONMENTS.prod.features, requestCleanup: true, offices: true, officeAssignments: true, assignmentHistory: true, notifications: true, openShiftSms: true, serviceLocation: true };
const base = { ...ENVIRONMENTS.prod, features: feats } as OgeviaEnvironmentConfig;
const withEmail = { ...base, notificationEmail: { from: "Ogevia <scheduling@ogevia.com>", replyTo: "admin.ogevia@gmail.com", sesIdentityArn: ARN, allowedRecipients: ["admin.ogevia@gmail.com"] } } as OgeviaEnvironmentConfig;
const dump = (cfg: OgeviaEnvironmentConfig) => Object.fromEntries(buildOgeviaApp(newApp(), cfg, "plan").map((p) => [p.stack.stackName.replace(/^Ogevia-prod-/, ""), Template.fromStack(p.stack).toJSON() as any]));
const RECIPIENT_ARN = "arn:aws:ses:us-west-2:300094796789:identity/admin.ogevia@gmail.com";
const withRecipient = { ...withEmail, notificationEmail: { ...withEmail.notificationEmail!, recipientIdentityArns: [RECIPIENT_ARN] } } as OgeviaEnvironmentConfig;
const EXTRA = "caregiver.test@example.invalid", EXTRA_ARN = `arn:aws:ses:us-west-2:300094796789:identity/${EXTRA}`;
const withTwo = { ...withEmail, notificationEmail: { ...withEmail.notificationEmail!, allowedRecipients: ["admin.ogevia@gmail.com", EXTRA], recipientIdentityArns: [RECIPIENT_ARN, EXTRA_ARN] } } as OgeviaEnvironmentConfig;
const off = dump(base), on = dump(withEmail), rec = dump(withRecipient), two = dump(withTwo);

function gate(api: [any, any], egress: [any, any], expect: string) {
  const dir = mkdtempSync(join(tmpdir(), "gate-email-"));
  try {
    const f = (n: string, v: unknown) => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    return spawnSync("python3", [GATE, "--api-live", f("al", api[0]), "--api-new", f("an", api[1]), "--egress-live", f("el", egress[0]), "--egress-new", f("en", egress[1]), "--expect", expect], { encoding: "utf8" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const A = (o: any) => o.ServiceVerificationApi, E = (o: any) => o.NetworkEgress;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe("diff_gate_email.py on real synthesis", () => {
  it("on: exactly the email function, its log group, policy and role, one invoke statement, two environment variables, and one endpoint ARN", () => {
    const r = gate([A(off), A(on)], [E(off), E(on)], "on");
    expect(r.status, r.stdout + r.stderr).toBe(0); expect(r.stdout).toContain("EXPECTED-ONLY: YES (email, on)");
  });
  it("same: the rollback assembly (no email) against the live stack with email is NOT allowed to differ beyond code; against the pre-email live stack it passes", () => {
    expect(gate([A(off), A(off)], [E(off), E(off)], "same").status).toBe(0);
    expect(gate([A(on), A(off)], [E(on), E(off)], "same").status).toBe(1);   // removing the function is a rollback deploy, not a 'same' assembly
  });
  it("post: no difference at all; any difference fails", () => {
    expect(gate([A(on), A(on)], [E(on), E(on)], "post").status).toBe(0);
    expect(gate([A(off), A(on)], [E(off), E(on)], "post").status).toBe(1);
  });
  it("refuses tampering: an extra variable, a second added resource, the function inside a VPC, a wider invoke statement, a changed endpoint, an extra egress resource", () => {
    const names = Object.keys(A(on).Resources);
    let t = clone(A(on)); t.Resources[names.find((k) => k.startsWith("Handler") && t.Resources[k].Type === "AWS::Lambda::Function" && t.Resources[k].Properties.Description === "Ogevia Service Verification API")!].Properties.Environment.Variables.EXTRA = "x";
    expect(gate([A(off), t], [E(off), E(on)], "on").status).toBe(1);
    t = clone(A(on)); t.Resources.SneakyQueue = { Type: "AWS::SQS::Queue", Properties: {} };
    expect(gate([A(off), t], [E(off), E(on)], "on").status).toBe(1);
    t = clone(A(on)); const fn = names.find((k) => t.Resources[k].Type === "AWS::Lambda::Function" && String(t.Resources[k].Properties.FunctionName ?? "").endsWith("-NotificationEmail"))!; t.Resources[fn].Properties.VpcConfig = { SubnetIds: [] };
    expect(gate([A(off), t], [E(off), E(on)], "on").status).toBe(1);
    t = clone(A(on)); const pol = names.find((k) => k.startsWith("HandlerPolicy"))!; const st = t.Resources[pol].Properties.PolicyDocument.Statement.find((s: any) => s.Sid === "InvokeNotificationEmail"); st.Resource = "*";
    expect(gate([A(off), t], [E(off), E(on)], "on").status).toBe(1);
    const e = clone(E(on)); const ep = Object.keys(e.Resources).find((k) => e.Resources[k].Type === "AWS::EC2::VPCEndpoint" && JSON.stringify(e.Resources[k]).includes("NotificationEmail"))!; e.Resources[ep].Properties.PolicyDocument.Statement[0].Resource.push("arn:aws:lambda:us-west-2:300094796789:function:Other");
    expect(gate([A(off), A(on)], [E(off), e], "on").status).toBe(1);
    const e2 = clone(E(on)); e2.Resources.ExtraEndpoint = { Type: "AWS::EC2::VPCEndpoint", Properties: {} };
    expect(gate([A(off), A(on)], [E(off), e2], "on").status).toBe(1);
  });
  it("the allow-list reaches the function and the sender and reply-to are exactly the approved ones", () => {
    const fn = Object.values(A(on).Resources as Record<string, any>).find((r) => r.Type === "AWS::Lambda::Function" && String(r.Properties.FunctionName ?? "").endsWith("-NotificationEmail"));
    expect(fn.Properties.Environment.Variables).toEqual({ SES_FROM: "Ogevia <scheduling@ogevia.com>", SES_REPLY_TO: "admin.ogevia@gmail.com", SES_ALLOWED_RECIPIENTS: "admin.ogevia@gmail.com" });
    expect(() => buildOgeviaApp(newApp(), { ...withEmail, notificationEmail: { ...withEmail.notificationEmail!, allowedRecipients: [] } } as OgeviaEnvironmentConfig, "plan")).toThrow(/allowedRecipients/);
    expect(() => buildOgeviaApp(newApp(), { ...withEmail, notificationEmail: { ...withEmail.notificationEmail!, allowedRecipients: ["not an address"] } } as OgeviaEnvironmentConfig, "plan")).toThrow(/allowedRecipients/);
  });
  it("identity: exactly one SES identity ARN added to the single send statement, nothing else; any other change is refused", () => {
    const r = gate([A(on), A(rec)], [E(on), E(rec)], "identity"); expect(r.status, r.stdout + r.stderr).toBe(0); expect(r.stdout).toContain("EXPECTED-ONLY: YES (email, identity)");
    const send = Object.values(A(rec).Resources as Record<string, any>).flatMap((x) => (x.Type === "AWS::IAM::ManagedPolicy" ? x.Properties.PolicyDocument.Statement : [])).find((x: any) => x.Sid === "SendFromOneIdentity");
    expect([...send.Resource].sort()).toEqual(["arn:aws:ses:us-west-2:300094796789:identity/ogevia.com", RECIPIENT_ARN].sort());
    expect(gate([A(off), A(rec)], [E(off), E(rec)], "identity").status).toBe(1);   // adding the function itself is not this change set
    const pol = (t: any) => Object.keys(t.Resources).find((k) => k.startsWith("EmailPolicy"))!;
    let t = clone(A(rec)); t.Resources[pol(t)].Properties.PolicyDocument.Statement.find((x: any) => x.Sid === "SendFromOneIdentity").Resource.push("arn:aws:ses:us-west-2:300094796789:identity/other@example.com");
    expect(gate([A(on), t], [E(on), E(rec)], "identity").status).toBe(1);             // two added
    t = clone(A(rec)); t.Resources[pol(t)].Properties.PolicyDocument.Statement.find((x: any) => x.Sid === "SendFromOneIdentity").Resource[1] = "*";
    expect(gate([A(on), t], [E(on), E(rec)], "identity").status).toBe(1);             // a wildcard is not an identity ARN
    t = clone(A(rec)); t.Resources[pol(t)].Properties.PolicyDocument.Statement.push({ Sid: "Extra", Effect: "Allow", Action: "ses:*", Resource: "*" });
    expect(gate([A(on), t], [E(on), E(rec)], "identity").status).toBe(1);             // an extra statement
    expect(gate([A(on), A(rec)], [E(on), E(rec)], "post").status).toBe(1);
    expect(() => buildOgeviaApp(newApp(), { ...withEmail, notificationEmail: { ...withEmail.notificationEmail!, recipientIdentityArns: ["*"] } } as OgeviaEnvironmentConfig, "plan")).toThrow(/recipientIdentityArns/);
  });
  it("recipient: one more allowed address AND one more identity ARN, nothing else; anything beyond that is refused", () => {
    const r = gate([A(rec), A(two)], [E(rec), E(two)], "recipient"); expect(r.status, r.stdout + r.stderr).toBe(0); expect(r.stdout).toContain("EXPECTED-ONLY: YES (email, recipient)");
    const fn = (t: any) => Object.keys(t.Resources).find((k) => k.startsWith("EmailHandler"))!;
    expect(A(two).Resources[fn(A(two))].Properties.Environment.Variables.SES_ALLOWED_RECIPIENTS).toBe(`admin.ogevia@gmail.com,${EXTRA}`);
    let t = clone(A(two)); t.Resources[fn(t)].Properties.Environment.Variables.SES_ALLOWED_RECIPIENTS = `admin.ogevia@gmail.com,${EXTRA},third@example.invalid`;
    expect(gate([A(rec), t], [E(rec), E(two)], "recipient").status).toBe(1);        // two added addresses
    t = clone(A(two)); t.Resources[fn(t)].Properties.Environment.Variables.SES_ALLOWED_RECIPIENTS = "*";
    expect(gate([A(rec), t], [E(rec), E(two)], "recipient").status).toBe(1);        // a wildcard
    t = clone(A(two)); t.Resources[fn(t)].Properties.Environment.Variables.SES_FROM = "Other <x@example.invalid>";
    expect(gate([A(rec), t], [E(rec), E(two)], "recipient").status).toBe(1);        // another variable changed
    t = clone(A(two)); t.Resources[fn(t)].Properties.Environment.Variables.SES_ALLOWED_RECIPIENTS = "admin.ogevia@gmail.com";
    expect(gate([A(rec), t], [E(rec), E(two)], "recipient").status).toBe(1);        // the permission gained an ARN but the allow-list did not
    expect(gate([A(on), A(two)], [E(on), E(two)], "recipient").status).toBe(1);     // two ARNs and one address from the stage-4 state is not this change set
  });
});
