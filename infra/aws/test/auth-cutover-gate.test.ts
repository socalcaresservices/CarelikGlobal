import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS } from "../lib/config.js";
import { newApp } from "./helpers.js";

// These gates test the authentication separation / web header releases against snapshots taken before the staff routes existed. The staff-routes switch is held OFF for
// production here so the tests keep proving exactly what they were written to prove; the staff routes are covered by staff-routes-switch.test.ts and the production gate for this release.
const withoutStaffRoutes = (env: "prod" | "prd") => (env === "prd" ? { ...ENVIRONMENTS.prd, features: { staffManagement: false } } : ENVIRONMENTS[env]);

// The expected-only gate (docs/releases/2026-10-21-auth-separation/scripts/auth_cutover_gate.py), run on:
//   LIVE proxy = templates synthesized from the UNMODIFIED release-branch code (fa3ca07), committed as fixtures/auth-separation/before;
//   NEW        = the templates this code synthesizes now.
// The real run compares the owner's actual live templates; this proves the gate accepts exactly the intended change and nothing else.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const GATE = fileURLToPath(new URL("../../../docs/releases/2026-10-21-auth-separation/scripts/auth_cutover_gate.py", import.meta.url));
const BEFORE = fileURLToPath(new URL("./fixtures/auth-separation/before", import.meta.url));
const SHARED = ENVIRONMENTS.prod.existing.cognitoUserPoolId;
const work = mkdtempSync(join(tmpdir(), "authgate-"));
const NEW = join(work, "new");
const API = "Ogevia-prd-ServiceVerificationApi";

const read = (dir: string, stack: string) => JSON.parse(readFileSync(join(dir, `${stack}.json`), "utf8"));
const write = (dir: string, stack: string, t: unknown) => writeFileSync(join(dir, `${stack}.json`), JSON.stringify(t));
function gate(newDir: string, liveDir = BEFORE) {
  const r = spawnSync("python3", ["-I", "-B", GATE, "--live-dir", liveDir, "--new-dir", newDir, "--shared-pool", SHARED], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
/** a mutated copy of the new templates */
function mutated(name: string, fn: (dirs: { live: string; next: string }) => void) {
  const live = join(work, `${name}-live`), next = join(work, `${name}-new`);
  cpSync(BEFORE, live, { recursive: true }); cpSync(NEW, next, { recursive: true });
  fn({ live, next });
  return gate(next, live);
}
const resource = (t: any, type: string, pick?: (r: any) => boolean) => Object.values<any>(t.Resources).find((r) => r.Type === type && (!pick || pick(r)))!;

beforeAll(() => {
  mkdirSync(NEW, { recursive: true });
  for (const env of ["prd", "prod"] as const) {
    for (const p of buildOgeviaApp(newApp(), withoutStaffRoutes(env), "plan")) {
      if (env === "prod" && p.stack.stackName !== "Ogevia-prod-NetworkEgress") continue;
      write(NEW, p.stack.stackName, Template.fromStack(p.stack).toJSON());
    }
  }
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("expected-only gate for the authentication separation", () => {
  it("PASSES on the real before/after pair: Auth is new, the API differs only by the allow-listed settings, the identity code is unchanged", () => {
    const r = gate(NEW);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("PASS");
    expect(r.out).toContain("'authorizer': 2, 'handler-env': 3, 'identity-env': 1, 'iam': 2");
  });

  it("PASSES on templates synthesized in DEPLOY mode (the real run): only the approval-reference tag values differ from live, and they are ignored", () => {
    const deploy = join(work, "deploy-mode"); mkdirSync(deploy, { recursive: true });
    for (const env of ["prd", "prod"] as const) {
      for (const p of buildOgeviaApp(newApp(), withoutStaffRoutes(env), "deploy", "owner-go-auth-20261021")) {
        if (env === "prod" && p.stack.stackName !== "Ogevia-prod-NetworkEgress") continue;
        write(deploy, p.stack.stackName, Template.fromStack(p.stack).toJSON());
      }
    }
    expect(JSON.stringify(read(deploy, API))).toContain("approved-owner-go-auth-20261021");   // really synthesized with the approval
    const r = gate(deploy);
    expect(r.code, r.out).toBe(0);
    // but a tag is the ONLY thing ignored: the same deploy-mode templates with a changed Lambda timeout are refused
    const bad = join(work, "deploy-mode-bad"); cpSync(deploy, bad, { recursive: true });
    const t = read(bad, API); resource(t, "AWS::Lambda::Function", (x) => x.Properties.Environment?.Variables?.OGEVIA_ENV).Properties.Timeout = 99; write(bad, API, t);
    expect(gate(bad).code).toBe(1);
  });

  it("the committed baseline really is the OLD shape: shared pool, legacy client, no Auth stack", () => {
    const api = read(BEFORE, API);
    const authorizer = resource(api, "AWS::ApiGatewayV2::Authorizer");
    expect(authorizer.Properties.JwtConfiguration.Issuer).toContain(SHARED);
    expect(authorizer.Properties.JwtConfiguration.Audience[0]).toBe(ENVIRONMENTS.prod.auth.appClientId);
    expect(() => readFileSync(join(BEFORE, "Ogevia-prd-Auth.json"))).toThrow();
  });

  it("REFUSES an extra client in the audience (the legacy client added back)", () => {
    const r = mutated("aud", ({ next }) => { const t = read(next, API); resource(t, "AWS::ApiGatewayV2::Authorizer").Properties.JwtConfiguration.Audience.push(ENVIRONMENTS.prod.auth.appClientId); write(next, API, t); });
    expect(r.code).toBe(1); expect(r.out).toContain("Audience");
  });

  it("REFUSES the shared pool inside the new issuer", () => {
    const r = mutated("iss", ({ next }) => { const t = read(next, API); resource(t, "AWS::ApiGatewayV2::Authorizer").Properties.JwtConfiguration.Issuer = `https://cognito-idp.us-west-2.amazonaws.com/${SHARED}`; write(next, API, t); });
    expect(r.code).toBe(1);
  });

  it("REFUSES a wrong forbidden-pool value, and an unexpected extra Lambda variable", () => {
    const wrong = mutated("forb", ({ next }) => { const t = read(next, API); resource(t, "AWS::Lambda::Function", (x) => x.Properties.Environment?.Variables?.OGEVIA_FORBIDDEN_POOL_IDS).Properties.Environment.Variables.OGEVIA_FORBIDDEN_POOL_IDS = "us-west-2_SOMETHINGELSE"; write(next, API, t); });
    expect(wrong.code).toBe(1);
    const extra = mutated("extra", ({ next }) => { const t = read(next, API); resource(t, "AWS::Lambda::Function", (x) => x.Properties.Environment?.Variables?.OGEVIA_ENV).Properties.Environment.Variables.NEW_FLAG = "1"; write(next, API, t); });
    expect(extra.code).toBe(1); expect(extra.out).toContain("NEW_FLAG");
  });

  it("REFUSES a change to the database name, the environment name or the timeout (anything not allow-listed)", () => {
    const r = mutated("env", ({ next }) => { const t = read(next, API); const f = resource(t, "AWS::Lambda::Function", (x) => x.Properties.Environment?.Variables?.OGEVIA_ENV); f.Properties.Environment.Variables.DB_NAME = "ogevia_sv_test"; f.Properties.Timeout = 99; write(next, API, t); });
    expect(r.code).toBe(1); expect(r.out).toContain("DB_NAME"); expect(r.out).toContain("Timeout");
  });

  it("REFUSES a changed identity function code, a route added, a resource removed", () => {
    const code = mutated("idcode", ({ next }) => { const t = read(next, API); const f = resource(t, "AWS::Lambda::Function", (x) => Object.keys(x.Properties.Environment?.Variables ?? {}).join() === "COGNITO_USER_POOL_ID"); f.Properties.Code.S3Key = "other.zip"; write(next, API, t); });
    expect(code.code).toBe(1);
    const route = mutated("route", ({ next }) => { const t = read(next, API); t.Resources.ExtraRoute = { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: "GET /v1/x", AuthorizationType: "NONE" } }; write(next, API, t); });
    expect(route.code).toBe(1); expect(route.out).toContain("ADDED ExtraRoute");
    const removed = mutated("rm", ({ next }) => { const t = read(next, API); delete t.Resources[Object.keys(t.Resources).find((k) => t.Resources[k].Type === "AWS::ApiGatewayV2::Route")!]; write(next, API, t); });
    expect(removed.code).toBe(1); expect(removed.out).toContain("REMOVED");
  });

  it("REFUSES an identity IAM statement that still names the shared pool, or a widened action", () => {
    const shared = mutated("iam", ({ next }) => { const t = read(next, API); for (const p of Object.values<any>(t.Resources).filter((r) => r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy")) for (const s of p.Properties.PolicyDocument.Statement) if (s.Sid === "SwitchSignInsOnOff") s.Resource = `arn:aws:cognito-idp:us-west-2:300094796789:userpool/${SHARED}`; write(next, API, t); });
    expect(shared.code).toBe(1);
    const widened = mutated("act", ({ next }) => { const t = read(next, API); for (const p of Object.values<any>(t.Resources).filter((r) => r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy")) for (const s of p.Properties.PolicyDocument.Statement) if (s.Sid === "CreateCaregiverSignIns") s.Action = [...[s.Action].flat(), "cognito-idp:AdminSetUserPassword"]; write(next, API, t); });
    expect(widened.code).toBe(1);
  });

  it("REFUSES any other production stack changing (web, evidence, database secret, alarms)", () => {
    for (const stack of ["Ogevia-prd-EvidenceStorage", "Ogevia-prd-DatabaseSecret", "Ogevia-prd-Observability"]) {
      const r = mutated(`other-${stack}`, ({ next }) => { const t = read(next, stack); t.Description = `${t.Description} changed`; write(next, stack, t); });
      expect(r.code, stack).toBe(1); expect(r.out).toContain(stack);
    }
    const web = mutated("web", ({ next }) => { const t = read(next, "Ogevia-prd-WebHosting"); const c = resource(t, "AWS::Cognito::UserPoolClient"); c.Properties.AccessTokenValidity = 5; write(next, "Ogevia-prd-WebHosting", t); });
    expect(web.code).toBe(1);
  });

  it("allows the web stack template to differ ONLY by the dropped export of the old client (and the live stack is not deployed)", () => {
    const web = (dir: string) => read(dir, "Ogevia-prd-WebHosting");
    const before = web(BEFORE), after = web(NEW);
    expect(Object.keys(before.Outputs).filter((k) => !(k in after.Outputs))).toEqual(["ExportsOutputRefTestSliceAppClient5EA2F71F"]);
    expect(Object.keys(after.Outputs).filter((k) => !(k in before.Outputs))).toEqual([]);
    // The ONLY resource difference is the website's Content-Security-Policy: the shared pilot sign-in domain replaced by production's dedicated one.
    const policy = (t: any) => Object.values<any>(t.Resources).find((r) => r.Type === "AWS::CloudFront::ResponseHeadersPolicy")!.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy;
    const strip = (t: any) => { const c = JSON.parse(JSON.stringify(t.Resources)); for (const r of Object.values<any>(c)) if (r.Type === "AWS::CloudFront::ResponseHeadersPolicy") delete r.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy; return c; };
    expect(strip(before)).toEqual(strip(after));
    expect(policy(before).ContentSecurityPolicy).toContain("us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com");
    expect(policy(after).ContentSecurityPolicy).toContain("ogevia-prd-300094796789.auth.us-west-2.amazoncognito.com");
    expect(policy(after).ContentSecurityPolicy).not.toContain("us-west-2849ayz5j7");
  });

  it("REFUSES any other change to the website's security header (a widened policy, a different domain, an http origin)", () => {
    const cspRes = (t: any) => Object.values<any>(t.Resources).find((r) => r.Type === "AWS::CloudFront::ResponseHeadersPolicy")!.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy;
    const edit = (name: string, fn: (v: string) => string) => mutated(name, ({ next }) => { const t = read(next, "Ogevia-prd-WebHosting"); const c = cspRes(t); c.ContentSecurityPolicy = fn(c.ContentSecurityPolicy); write(next, "Ogevia-prd-WebHosting", t); });
    for (const [n, f] of [["wide", (v: string) => v.replace("connect-src 'self'", "connect-src 'self' https://*.amazoncognito.com")], ["other", (v: string) => v.replace("ogevia-prd-300094796789", "ogevia-prd-999999999999")], ["both", (v: string) => v.replace("form-action 'self'", "form-action 'self' https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com")], ["script", (v: string) => v.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")]] as const) {
      const r = edit(n, f); expect(r.code, n).toBe(1); expect(r.out, n).toContain("Ogevia-prd-WebHosting: differs from live");
    }
  });

  it("REFUSES when the Auth stack already exists live, when the pool is not retained, and when MFA or deletion protection is weakened", () => {
    const exists = mutated("exists", ({ live, next }) => { write(live, "Ogevia-prd-Auth", read(next, "Ogevia-prd-Auth")); });
    expect(exists.code).toBe(1); expect(exists.out).toContain("already exists live");
    const noRetain = mutated("retain", ({ next }) => { const t = read(next, "Ogevia-prd-Auth"); delete resource(t, "AWS::Cognito::UserPool").DeletionPolicy; write(next, "Ogevia-prd-Auth", t); });
    expect(noRetain.code).toBe(1); expect(noRetain.out).toContain("Retain");
    const weak = mutated("mfa", ({ next }) => { const t = read(next, "Ogevia-prd-Auth"); const p = resource(t, "AWS::Cognito::UserPool").Properties; p.MfaConfiguration = "OPTIONAL"; p.DeletionProtection = "INACTIVE"; write(next, "Ogevia-prd-Auth", t); });
    expect(weak.code).toBe(1); expect(weak.out).toContain("MFA"); expect(weak.out).toContain("deletion protection");
  });

  it("--reverse (rollback check): the previous commit's templates plus the allow-list equal the current live state", () => {
    const live = join(work, "reverse-current-live");
    cpSync(NEW, live, { recursive: true });                                      // the post-change live state (Auth present)
    const r = spawnSync("python3", ["-I", "-B", GATE, "--reverse", "--live-dir", live, "--new-dir", BEFORE, "--shared-pool", SHARED], { encoding: "utf8" });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("PASS");
    // a previous-commit tree that drifted (an extra Lambda variable) must not pass
    const drift = join(work, "reverse-drift");
    cpSync(BEFORE, drift, { recursive: true });
    const t = read(drift, API); resource(t, "AWS::Lambda::Function", (x) => x.Properties.Environment?.Variables?.OGEVIA_ENV).Properties.Environment.Variables.DRIFT = "1"; write(drift, API, t);
    const d = spawnSync("python3", ["-I", "-B", GATE, "--reverse", "--live-dir", live, "--new-dir", drift, "--shared-pool", SHARED], { encoding: "utf8" });
    expect(d.status).toBe(1);
    // and when the Auth stack is missing from the "current live" there is nothing to roll back from
    const noAuth = join(work, "reverse-noauth"); cpSync(NEW, noAuth, { recursive: true }); rmSync(join(noAuth, "Ogevia-prd-Auth.json"));
    expect(spawnSync("python3", ["-I", "-B", GATE, "--reverse", "--live-dir", noAuth, "--new-dir", BEFORE, "--shared-pool", SHARED], { encoding: "utf8" }).status).toBe(1);
  });

  it("REFUSES a missing template on either side and a bad shared-pool argument", () => {
    expect(mutated("miss", ({ next }) => rmSync(join(next, `${API}.json`))).code).toBe(1);
    expect(spawnSync("python3", ["-I", "-B", GATE, "--live-dir", BEFORE, "--new-dir", NEW, "--shared-pool", "nope"], { encoding: "utf8" }).status).toBe(2);
  });
});
