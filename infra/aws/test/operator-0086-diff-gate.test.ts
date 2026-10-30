// diff_gate.py and assembly_check.py (TEST UPGRADE 7870a04 -> fb491a5) against REAL synthesized templates: test/fixtures/operator-0086/release = the five Ogevia-prod-* stacks synthesized from
// the candidate code fb491a5 in deploy mode; .../live = the same five stacks as synthesized from 7870a04 (the release the owner deployed to TEST on 2026-10-25/26, i.e. what TEST runs now).
// The gate must pass ONLY the upgrade's expected change (ONE JWT-authorized staff route, POST /v1/me/staff-invitations/{organizationId}/accept, + the Handler code asset) and fail on
// anything extra, removed or altered. Every CORS, hostname and callback difference is a violation (they are live on TEST since the 7870a04 release; the old catch-up allowance is gone).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PKG_REL, REPO_ROOT, sh } from "./operator-0086-fixtures.js";

const FIX = fileURLToPath(new URL("./fixtures/operator-0086/", import.meta.url));
const GATE = join(REPO_ROOT, PKG_REL, "scripts/diff_gate.py");
const ASSEMBLY = join(REPO_ROOT, PKG_REL, "scripts/assembly_check.py");
const S = ["EvidenceStorage", "NetworkEgress", "WebHosting", "ServiceVerificationApi", "Observability"];
const API = "Ogevia-prod-ServiceVerificationApi", WEB = "Ogevia-prod-WebHosting";
type T = any;
const load = (kind: "live" | "release", stack: string): T => JSON.parse(readFileSync(join(FIX, kind, `${stack}.template.json`), "utf8"));
const clone = (x: T): T => JSON.parse(JSON.stringify(x));
const tmp = mkdtempSync(join(tmpdir(), "gate0086-"));
let n = 0;
const put = (obj: unknown) => { const p = join(tmp, `f${n++}.json`); writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj)); return p; };
const gate = (stack: string, live: T, next: T) => sh("python3", ["-I", "-B", GATE, "template", "--stack", stack, "--live", put(live), "--new", put(next)]);
const handlerOf = (t: T) => Object.entries<any>(t.Resources).find(([k, r]) => r.Type === "AWS::Lambda::Function" && k.startsWith("Handler") && !k.startsWith("IdentityHandler"))!;
const routes = (t: T) => Object.entries<any>(t.Resources).filter(([, r]) => r.Type === "AWS::ApiGatewayV2::Route");
const apiResourceKey = (t: T) => Object.keys(t.Resources).find((k) => t.Resources[k].Type === "AWS::ApiGatewayV2::Api")!;
const ok = (r: { code: number | null; out: string }, word: "DELTA" | "NONE") => { expect(r.code, r.out).toBe(0); expect(r.out).toContain(`EXPECTED-ONLY: YES (${word})`); expect(r.out).not.toContain("VIOLATION"); };
const stop = (r: { code: number | null; out: string }, text: string) => { expect(r.code, r.out).toBe(1); expect(r.out).toContain("EXPECTED-ONLY: NO"); expect(r.out).toContain(text); };

describe("the real upgrade difference is exactly what the gate allows", () => {
  it("ServiceVerificationApi: the ONE accept route and the Handler code asset only → DELTA", () => {
    const live = load("live", API), next = load("release", API);
    const r = gate(API, live, next);
    ok(r, "DELTA");
    expect(r.out).toContain("1 staff API route(s) added, each JWT-authorized like the existing routes");
    expect(r.out).toMatch(/ALLOWED Lambda Handler\w+ code asset 94b73574c5a6\.\.\. -> 2871b03d6be4\.\.\./);
    expect(routes(next).length - routes(live).length).toBe(1);
    expect(routes(next).map(([, x]) => x.Properties.RouteKey)).toContain("POST /v1/me/staff-invitations/{organizationId}/accept");
    expect(handlerOf(next)[1].Properties.Environment).toEqual(handlerOf(live)[1].Properties.Environment);
  });
  it.each(["EvidenceStorage", "NetworkEgress", "WebHosting", "Observability"])("%s: no difference at all", (s) => ok(gate(`Ogevia-prod-${s}`, load("live", `Ogevia-prod-${s}`), load("release", `Ogevia-prod-${s}`)), "NONE"));
  it("a second run after the deployment: the API stack equals the release → NONE with 'NOTHING TO DEPLOY'", () => {
    const r = gate(API, load("release", API), load("release", API));
    ok(r, "NONE"); expect(r.out).toContain("NOTHING TO DEPLOY");
  });
  it("a different approval-tag VALUE alone is not a difference", () => {
    const live = clone(load("release", WEB)); const walk = (x: T) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { if (x.Key === "ogevia:deployment-status") x.Value = "approved-SOME-OTHER-REF"; Object.values(x).forEach(walk); } };
    walk(live); ok(gate(WEB, live, load("release", WEB)), "NONE");
  });
});

describe("any CORS, hostname or callback difference stops (they are live on TEST already; no catch-up is allowed any more)", () => {
  const cors = (t: T) => t.Resources[apiResourceKey(t)].Properties.CorsConfiguration;
  const bad = (label: string, mutate: (live: T, next: T) => void) => it(`stops: ${label}`, () => { const live = clone(load("live", API)), next = clone(load("release", API)); mutate(live, next); stop(gate(API, live, next), "resource CHANGED outside the allow-list: Api"); });
  bad("an origin added", (_l, n) => { cors(n).AllowOrigins.push("https://other.example"); });
  bad("the demo origin missing from the live template (the old 7870a04 catch-up)", (l, _n) => { cors(l).AllowOrigins = cors(l).AllowOrigins.filter((o: string) => o !== "https://demo.ogevia.com"); });
  bad("the wildcard origin", (_l, n) => { cors(n).AllowOrigins.push("*"); });
  bad("a method added", (_l, n) => { cors(n).AllowMethods.push("DELETE"); });
  bad("another property of the API resource changes", (_l, n) => { n.Resources[apiResourceKey(n)].Properties.Name = "renamed"; });
  it("WebHosting: a changed alias or Cognito client is a violation", () => {
    const live = clone(load("live", WEB)), next = clone(load("release", WEB)); const k = Object.keys(next.Resources).find((x) => next.Resources[x].Type === "AWS::Cognito::UserPoolClient")!; next.Resources[k].Properties.CallbackURLs = [...(next.Resources[k].Properties.CallbackURLs ?? []), "https://evil.example/cb"];
    stop(gate(WEB, live, next), "resource CHANGED outside the allow-list");
  });
});

describe("ServiceVerificationApi: anything beyond the accept route and the code asset STOPS", () => {
  const ACCEPT = "POST /v1/me/staff-invitations/{organizationId}/accept";
  const pair = () => ({ live: clone(load("live", API)), next: clone(load("release", API)) });
  const accept = (t: T) => routes(t).find(([, x]) => x.Properties.RouteKey === ACCEPT)!;
  it("a route REMOVED", () => { const { live, next } = pair(); delete next.Resources[routes(next).find(([, x]) => x.Properties.RouteKey === "GET /v1/me")![0]]; stop(gate(API, live, next), "REMOVED"); });
  it("an existing route ALTERED (target)", () => { const { live, next } = pair(); routes(next).find(([, x]) => x.Properties.RouteKey === "GET /v1/me")![1].Properties.Target = "integrations/other"; stop(gate(API, live, next), "resource CHANGED outside the allow-list"); });
  it("a second added route", () => {
    const { live, next } = pair(); const [, base] = accept(next);
    next.Resources.ExtraRoute = { Type: "AWS::ApiGatewayV2::Route", Properties: { ...clone(base.Properties), RouteKey: "POST /v1/staff-export" } };
    stop(gate(API, live, next), "routes added that are not the 1 staff route this upgrade adds");
  });
  it("an accept route that is not JWT-authorized", () => { const { live, next } = pair(); const [, r] = accept(next); r.Properties.AuthorizationType = "NONE"; delete r.Properties.AuthorizerId; stop(gate(API, live, next), "is not JWT-authorized by the same authorizer"); });
  it("an accept route wired to another integration", () => { const { live, next } = pair(); accept(next)[1].Properties.Target = "integrations/elsewhere"; stop(gate(API, live, next), "same integration"); });
  it("an accept route with an unexpected property or a DELETE method", () => {
    let { live, next } = pair(); accept(next)[1].Properties.ApiKeyRequired = true; stop(gate(API, live, next), "unexpected properties");
    ({ live, next } = pair()); accept(next)[1].Properties.RouteKey = "DELETE /v1/me/staff-invitations/{organizationId}/accept"; stop(gate(API, live, next), "not the 1 staff route");
  });
  it("the accept route missing while the code changes, and the route without a code change", () => {
    let { live, next } = pair(); delete next.Resources[accept(next)[0]]; stop(gate(API, live, next), "must change together");
    ({ live, next } = pair()); handlerOf(next)[1].Properties.Code.S3Key = handlerOf(live)[1].Properties.Code.S3Key; stop(gate(API, live, next), "must change together");
  });
  it("the Handler's environment, role, memory or timeout changes with the code", () => {
    for (const [label, mutate] of [["environment", (p: T) => { p.Environment.Variables.EXTRA = "x"; }], ["memory", (p: T) => { p.MemorySize = 3008; }], ["timeout", (p: T) => { p.Timeout = 900; }], ["role", (p: T) => { p.Role = { "Fn::GetAtt": ["Other", "Arn"] }; }]] as Array<[string, (p: T) => void]>) {
      const { live, next } = pair(); mutate(handlerOf(next)[1].Properties); stop(gate(API, live, next), "changed beyond its code asset"); expect(label).toBeTruthy();
    }
  });
  it("a Handler code key that is not a CDK asset key", () => { const { live, next } = pair(); handlerOf(next)[1].Properties.Code.S3Key = "latest.zip"; stop(gate(API, live, next), "is not a CDK asset key"); });
  it("any IAM policy, permission, authorizer, stage, rule or secret change; any added or removed resource of another type", () => {
    for (const type of ["AWS::IAM::ManagedPolicy", "AWS::IAM::Role", "AWS::Lambda::Permission", "AWS::ApiGatewayV2::Authorizer", "AWS::ApiGatewayV2::Stage", "AWS::Events::Rule", "AWS::SecretsManager::Secret", "AWS::Logs::LogGroup"]) {
      const { live, next } = pair(); const k = Object.keys(next.Resources).find((x) => next.Resources[x].Type === type);
      if (!k) continue;
      next.Resources[k].Properties = { ...(next.Resources[k].Properties ?? {}), Zz: "changed" }; stop(gate(API, live, next), "resource CHANGED outside the allow-list");
      const p2 = pair(); p2.next.Resources.Added = { Type: type, Properties: {} }; stop(gate(API, p2.live, p2.next), "resource ADDED outside the allow-list");
    }
  });
  it("a changed Parameter, Output, Condition or Description; a replaced resource type", () => {
    for (const sec of ["Description", "Parameters", "Outputs", "Conditions", "Mappings"]) { const { live, next } = pair(); next[sec] = sec === "Description" ? "changed" : { ...(typeof next[sec] === "object" ? next[sec] : {}), Zz: "x" }; stop(gate(API, live, next), `template section ${sec} differs`); }
    const { live, next } = pair(); const [k, r] = handlerOf(next); next.Resources[k] = { ...r, Type: "AWS::Serverless::Function" }; stop(gate(API, live, next), "changes TYPE");
  });
  it("a stack outside the five, an unreadable file, a non-template", () => {
    stop(gate("Ogevia-prd-ServiceVerificationApi", load("live", API), load("release", API)), "no allow-list exists");
    const r = sh("python3", ["-I", "-B", GATE, "template", "--stack", API, "--live", put("not json"), "--new", put(load("release", API))]);
    expect(r.code, r.out).toBe(2); expect(r.out).toContain("treated as a failure");
    const r2 = sh("python3", ["-I", "-B", GATE, "template", "--stack", API, "--live", put({ nope: 1 }), "--new", put(load("release", API))]);
    expect(r2.code, r2.out).toBe(2);
  });
});

describe("the four other stacks allow NO difference", () => {
  it.each(S.filter((s) => s !== "ServiceVerificationApi"))("%s: an added, removed or changed resource, a tag or a policy edit stops", (s) => {
    const stack = `Ogevia-prod-${s}`;
    const base = () => ({ live: clone(load("live", stack)), next: clone(load("release", stack)) });
    let { live, next } = base(); next.Resources.Extra = { Type: "AWS::SSM::Parameter", Properties: { Type: "String", Value: "x" } }; stop(gate(stack, live, next), "resource ADDED");
    ({ live, next } = base()); const victim = Object.keys(next.Resources).find((k) => next.Resources[k].Type !== "AWS::CDK::Metadata")!; delete next.Resources[victim]; stop(gate(stack, live, next), "REMOVED");
    ({ live, next } = base()); const k2 = Object.keys(next.Resources).find((k) => next.Resources[k].Properties && next.Resources[k].Type !== "AWS::CDK::Metadata")!; next.Resources[k2].Properties.Zz = "x"; stop(gate(stack, live, next), "CHANGED");
    ({ live, next } = base()); next.Outputs = { ...(next.Outputs ?? {}), Zz: { Value: "x" } }; stop(gate(stack, live, next), "template section Outputs differs");
  });
});

describe("assembly_check.py pins the release synthesis", () => {
  const write = (d: string, mutate?: (s: string, t: T) => T | null) => {
    for (const s of S) { let t = load("release", `Ogevia-prod-${s}`); if (mutate) t = mutate(s, t); if (t) writeFileSync(join(d, `Ogevia-prod-${s}.template.json`), JSON.stringify(t)); }
  };
  const asm = (d: string) => sh("python3", ["-I", "-B", ASSEMBLY, "--assembly", d]);
  it("accepts the five release templates", () => {
    const d = mkdtempSync(join(tmpdir(), "asm-")); write(d); const r = asm(d);
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("PASS all checks"); expect(r.out).toContain("242 API routes"); expect(r.out).not.toContain("FAIL");
  });
  it.each<[string, (s: string, t: T) => T | null, string, number]>([
    ["a production stack file", (s, t) => t, "no Ogevia-prd-* stack", 1],
    ["a changed Handler asset", (s, t) => { if (s === "ServiceVerificationApi") handlerOf(t)[1].Properties.Code.S3Key = "0".repeat(64) + ".zip"; return t; }, "FAIL Handler code asset", 1],
    ["a changed IdentityHandler asset", (s, t) => { if (s === "ServiceVerificationApi") Object.entries<any>(t.Resources).find(([k]) => k.startsWith("IdentityHandler") && t.Resources[k].Type === "AWS::Lambda::Function")![1].Properties.Code.S3Key = "1".repeat(64) + ".zip"; return t; }, "FAIL IdentityHandler code asset", 1],
    ["a removed staff route", (s, t) => { if (s === "ServiceVerificationApi") delete t.Resources[routes(t).find(([, x]) => x.Properties.RouteKey === "GET /v1/staff")![0]]; return t; }, "FAIL", 1],
    ["a disabled compliance sweep", (s, t) => { if (s === "ServiceVerificationApi") Object.values<any>(t.Resources).find((r) => r.Type === "AWS::Events::Rule").Properties.State = "DISABLED"; return t; }, "FAIL exactly one EventBridge rule", 1],
    ["a tampered Observability stack", (s, t) => { if (s === "Observability") t.Description = "tampered"; return t; }, "FAIL Ogevia-prod-Observability", 1],
    ["a missing WebHosting template", (s) => (s === "WebHosting" ? null : load("release", `Ogevia-prod-${s}`)), "cannot read the assembly", 2],
  ])("refuses %s", (_n, mutate, text, code) => {
    const d = mkdtempSync(join(tmpdir(), "asm-")); write(d, mutate);
    if (_n === "a production stack file") writeFileSync(join(d, "Ogevia-prd-ServiceVerificationApi.template.json"), "{}");
    const r = asm(d); expect(r.code, r.out).toBe(code); expect(r.out).toContain(text);
  });
  it("usage without arguments is a failure", () => { expect(sh("python3", ["-I", "-B", ASSEMBLY]).code).not.toBe(0); });
});
