// diff_gate_prd.py and assembly_check_prd.py (PRODUCTION release 2026-10-26-redesign) against the REAL synthesized templates and the "live" production stacks derived from the read-only
// capture of 2026-10-26. The gate must pass exactly the release's difference and stop on anything else. No AWS, no network, synthetic.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { API, APPROVAL, AUTH, NET, NEW_KEYS, PRD_STACKS, PREVIOUS_HANDLER_KEY, SCRIPTS_SRC, WEB, WEB_EXPORT, apiResource, liveOf, readJson, release, sh, synth } from "./operator-prd-fixtures.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });
type T = any;
const dir = mkdtempSync(join(tmpdir(), "prd-gate-"));
let n = 0;
const clone = (t: T): T => JSON.parse(JSON.stringify(t));
function gate(stack: string, live: T | string, next: T | string) {
  const w = (x: T | string) => { const p = join(dir, `t${++n}.json`); writeFileSync(p, typeof x === "string" ? x : JSON.stringify(x)); return p; };
  return sh("python3", ["-I", "-B", join(SCRIPTS_SRC, "diff_gate_prd.py"), "template", "--stack", stack, "--live", w(live), "--new", w(next)]);
}
const violation = (r: { code: number | null; out: string }, text: RegExp | string) => { expect(r.code, r.out).toBe(1); expect(r.out).toContain("EXPECTED-ONLY: NO"); expect(r.out).toMatch(typeof text === "string" ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : text); };
beforeAll(() => { synth(); });

describe("the release's difference passes", () => {
  it("API: 13 routes + Handler build + two CORS origins = DELTA", () => {
    const r = gate(API, liveOf(API), release(API));
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("EXPECTED-ONLY: YES (DELTA)");
    expect(r.out).toContain("13 staff API routes added"); expect(r.out).toContain("https://app.ogevia.com"); expect(r.out).toContain("https://admin.ogevia.com"); expect(r.out).toContain(PREVIOUS_HANDLER_KEY.slice(0, 12));
  });
  it("Auth: the app client gains the four app./admin. URLs = DELTA", () => {
    const r = gate(AUTH, liveOf(AUTH), release(AUTH));
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("EXPECTED-ONLY: YES (DELTA)");
  });
  it("WebHosting: only the removed export differs = EXPORT-ONLY (never deployed)", () => {
    const r = gate(WEB, liveOf(WEB), release(WEB));
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("EXPECTED-ONLY: YES (EXPORT-ONLY)"); expect(r.out).toContain(WEB_EXPORT);
  });
  it.each(["Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-Observability", NET])("%s: identical = NONE", (s) => {
    const r = gate(s, release(s), release(s));
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("EXPECTED-ONLY: YES (NONE)");
  });
  it("after the deployment the API and Auth stacks read NONE: nothing to deploy", () => {
    for (const s of [API, AUTH]) { const r = gate(s, release(s), release(s)); expect(r.code, r.out).toBe(0); expect(r.out).toContain("(NONE)"); expect(r.out).toContain("NOTHING TO DEPLOY"); }
  });
  it("the VALUE of the approval tag is ignored (it differs between deployments)", () => {
    const next = clone(release(API)); let hit = 0;
    const walk = (x: T): void => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { if (x.Key === "ogevia:deployment-status") { x.Value = "approved-OTHER-REF"; hit++; } Object.values(x).forEach(walk); } };
    walk(next); expect(hit).toBeGreaterThan(0);
    expect(gate(API, liveOf(API), next).code).toBe(0);
  });
  it("the real production capture has the CORS origin app. twice in the release list (index 0 and 2); appending exactly [app, admin] is still accepted", () => {
    const next = release(API); const k = apiResource(next, "AWS::ApiGatewayV2::Api"); const ao = next.Resources[k].Properties.CorsConfiguration.AllowOrigins;
    expect(ao.slice(-2)).toEqual(["https://app.ogevia.com", "https://admin.ogevia.com"]);
  });
});

describe("API stack: anything beyond the release's difference stops", () => {
  const routeKeyOf = (t: T, key: string) => Object.keys(t.Resources).find((k) => t.Resources[k].Type === "AWS::ApiGatewayV2::Route" && t.Resources[k].Properties.RouteKey === key)!;
  const handlerKey = (t: T) => apiResource(t, "AWS::Lambda::Function", (k) => k.startsWith("Handler") && !k.startsWith("IdentityHandler"));
  const cases: Array<[string, (t: T) => void, RegExp | string]> = [
    ["a 14th route", (t) => { const c = clone(t.Resources[routeKeyOf(t, NEW_KEYS[0]!)]); c.Properties.RouteKey = "POST /v1/staff-extra"; t.Resources.ExtraRoute = c; }, "not the 13 staff routes"],
    ["a staff route missing from the release", (t) => { delete t.Resources[routeKeyOf(t, NEW_KEYS[0]!)]; }, "staff routes missing"],
    ["a new route that is not JWT-authorized", (t) => { t.Resources[routeKeyOf(t, NEW_KEYS[1]!)].Properties.AuthorizationType = "NONE"; }, "not JWT-authorized"],
    ["a new route wired to another integration", (t) => { t.Resources[routeKeyOf(t, NEW_KEYS[2]!)].Properties.Target = "integrations/other"; }, "not JWT-authorized"],
    ["a new route with a DELETE method", (t) => { const k = routeKeyOf(t, NEW_KEYS[3]!); t.Resources[k].Properties.RouteKey = "DELETE /v1/staff-types"; }, /not the 13 staff routes|method other than GET or POST/],
    ["a new route with an extra property", (t) => { t.Resources[routeKeyOf(t, NEW_KEYS[4]!)].Properties.ApiKeyRequired = false; }, "unexpected properties"],
    ["an earlier route removed", (t) => { const k = Object.keys(t.Resources).find((x) => t.Resources[x].Type === "AWS::ApiGatewayV2::Route" && !NEW_KEYS.includes(t.Resources[x].Properties.RouteKey))!; delete t.Resources[k]; }, "resource REMOVED"],
    ["an earlier route altered", (t) => { const k = Object.keys(t.Resources).find((x) => t.Resources[x].Type === "AWS::ApiGatewayV2::Route" && !NEW_KEYS.includes(t.Resources[x].Properties.RouteKey))!; t.Resources[k].Properties.AuthorizationType = "NONE"; }, "resource CHANGED outside the allow-list"],
    ["the Handler environment changed", (t) => { t.Resources[handlerKey(t)].Properties.Environment.Variables.NEW_VARIABLE = "x"; }, "changed beyond its code asset"],
    ["the Handler memory changed", (t) => { t.Resources[handlerKey(t)].Properties.MemorySize = 3008; }, "changed beyond its code asset"],
    ["the Handler role changed", (t) => { t.Resources[handlerKey(t)].Properties.Role = "arn:aws:iam::300094796789:role/other"; }, "changed beyond its code asset"],
    ["a code key that is not an asset key", (t) => { t.Resources[handlerKey(t)].Properties.Code.S3Key = "not-an-asset.zip"; }, "not a CDK asset key"],
    ["the identity function's code changed", (t) => { const k = apiResource(t, "AWS::Lambda::Function", (x) => x.startsWith("IdentityHandler")); t.Resources[k].Properties.Code.S3Key = "a".repeat(64) + ".zip"; }, "resource CHANGED outside the allow-list"],
    ["an IAM policy statement added", (t) => { const k = apiResource(t, "AWS::IAM::ManagedPolicy"); t.Resources[k].Properties.PolicyDocument.Statement.push({ Effect: "Allow", Action: "s3:*", Resource: "*" }); }, "resource CHANGED outside the allow-list"],
    ["an IAM role added", (t) => { t.Resources.NewRole = { Type: "AWS::IAM::Role", Properties: {} }; }, "resource ADDED outside the allow-list"],
    ["a Lambda permission added", (t) => { t.Resources.NewPermission = { Type: "AWS::Lambda::Permission", Properties: {} }; }, "resource ADDED outside the allow-list"],
    ["the schedule rule changed", (t) => { const k = apiResource(t, "AWS::Events::Rule"); t.Resources[k].Properties.State = "DISABLED"; }, "resource CHANGED outside the allow-list"],
    ["the authorizer changed", (t) => { const k = apiResource(t, "AWS::ApiGatewayV2::Authorizer"); t.Resources[k].Properties.IdentitySource = ["$request.header.X-Other"]; }, "resource CHANGED outside the allow-list"],
    ["the stage changed", (t) => { const k = apiResource(t, "AWS::ApiGatewayV2::Stage"); t.Resources[k].Properties.AutoDeploy = false; }, "resource CHANGED outside the allow-list"],
    ["a third CORS origin", (t) => { const k = apiResource(t, "AWS::ApiGatewayV2::Api"); t.Resources[k].Properties.CorsConfiguration.AllowOrigins.push("https://evil.example"); }, "resource CHANGED outside the allow-list"],
    ["only the app. CORS origin added", (t) => { const k = apiResource(t, "AWS::ApiGatewayV2::Api"); const ao = t.Resources[k].Properties.CorsConfiguration.AllowOrigins; ao.splice(ao.length - 1, 1); }, "resource CHANGED outside the allow-list"],
    ["the CORS origins reordered", (t) => { const k = apiResource(t, "AWS::ApiGatewayV2::Api"); const ao = t.Resources[k].Properties.CorsConfiguration.AllowOrigins; ao.splice(ao.length - 2, 2, ao[ao.length - 1], ao[ao.length - 2]); }, "resource CHANGED outside the allow-list"],
    ["CORS credentials enabled", (t) => { const k = apiResource(t, "AWS::ApiGatewayV2::Api"); t.Resources[k].Properties.CorsConfiguration.AllowCredentials = true; }, "resource CHANGED outside the allow-list"],
    ["a CORS method added", (t) => { const k = apiResource(t, "AWS::ApiGatewayV2::Api"); t.Resources[k].Properties.CorsConfiguration.AllowMethods.push("DELETE"); }, "resource CHANGED outside the allow-list"],
    ["a new Output", (t) => { t.Outputs = { ...(t.Outputs ?? {}), Extra: { Value: "x" } }; }, "template section Outputs differs"],
    ["a changed Description", (t) => { t.Description = "other"; }, "template section Description differs"],
    ["a new Parameter", (t) => { t.Parameters = { ...(t.Parameters ?? {}), P: { Type: "String" } }; }, "template section Parameters differs"],
    ["a secret resource added", (t) => { t.Resources.NewSecret = { Type: "AWS::SecretsManager::Secret", Properties: {} }; }, "resource ADDED outside the allow-list"],
    ["a log group added", (t) => { t.Resources.NewLogs = { Type: "AWS::Logs::LogGroup", Properties: {} }; }, "resource ADDED outside the allow-list"],
  ];
  it.each(cases)("stops on %s", (_name, mutate, text) => { const next = clone(release(API)); mutate(next); violation(gate(API, liveOf(API), next), text); });
  it("stops when the routes arrive without the Handler build, and when the build arrives without the routes", () => {
    const live = liveOf(API); const noBuild = clone(release(API)); noBuild.Resources[Object.keys(noBuild.Resources).find((k) => k.startsWith("Handler") && !k.startsWith("IdentityHandler") && noBuild.Resources[k].Type === "AWS::Lambda::Function")!].Properties.Code.S3Key = PREVIOUS_HANDLER_KEY;
    violation(gate(API, live, noBuild), "must change together");
    const liveWithRoutes = clone(release(API)); liveWithRoutes.Resources[Object.keys(liveWithRoutes.Resources).find((k) => k.startsWith("Handler") && !k.startsWith("IdentityHandler") && liveWithRoutes.Resources[k].Type === "AWS::Lambda::Function")!].Properties.Code.S3Key = PREVIOUS_HANDLER_KEY;
    violation(gate(API, liveWithRoutes, release(API)), "must change together");
  });
  it("the routes and the Handler without the CORS catch-up stop (the capture showed the CORS difference, so its absence means the live stack is not what was read)", () => {
    const live = liveOf(API); const k = apiResource(live, "AWS::ApiGatewayV2::Api"); const rel = release(API);
    live.Resources[k].Properties.CorsConfiguration.AllowOrigins = clone(rel.Resources[k].Properties.CorsConfiguration.AllowOrigins);
    violation(gate(API, live, rel), "CORS origins did not gain");
  });
  it("a live stack that has no JWT-authorized route to compare with stops", () => {
    const live = liveOf(API); for (const r of Object.values<T>(live.Resources)) if (r.Type === "AWS::ApiGatewayV2::Route") r.Properties.AuthorizationType = "NONE";
    violation(gate(API, live, release(API)), /no JWT-authorized route/);
  });
});

describe("Auth stack", () => {
  const client = (t: T) => Object.keys(t.Resources).find((k) => t.Resources[k].Type === "AWS::Cognito::UserPoolClient")!;
  const cases: Array<[string, (t: T) => void, RegExp | string]> = [
    ["a third sign-in URL", (t) => { t.Resources[client(t)].Properties.CallbackURLs.push("https://evil.example/auth/callback"); }, "resource CHANGED outside the allow-list"],
    ["a missing admin. sign-in URL", (t) => { t.Resources[client(t)].Properties.CallbackURLs.pop(); }, "resource CHANGED outside the allow-list"],
    ["a missing sign-out URL", (t) => { t.Resources[client(t)].Properties.LogoutURLs.pop(); }, "resource CHANGED outside the allow-list"],
    ["the sign-in URLs reordered", (t) => { const c = t.Resources[client(t)].Properties.CallbackURLs; c.splice(c.length - 2, 2, c[c.length - 1], c[c.length - 2]); }, "resource CHANGED outside the allow-list"],
    ["an OAuth flow change", (t) => { t.Resources[client(t)].Properties.AllowedOAuthFlows = ["implicit"]; }, "resource CHANGED outside the allow-list"],
    ["a token validity change", (t) => { t.Resources[client(t)].Properties.RefreshTokenValidity = 3650; }, "resource CHANGED outside the allow-list"],
    ["a client secret turned on", (t) => { t.Resources[client(t)].Properties.GenerateSecret = true; }, "resource CHANGED outside the allow-list"],
    ["the user pool changed (MFA off)", (t) => { const k = Object.keys(t.Resources).find((x) => t.Resources[x].Type === "AWS::Cognito::UserPool")!; t.Resources[k].Properties.MfaConfiguration = "OFF"; }, "resource CHANGED outside the allow-list"],
    ["a resource removed", (t) => { delete t.Resources[Object.keys(t.Resources).find((x) => t.Resources[x].Type === "AWS::Cognito::UserPoolDomain")!]; }, "resource REMOVED"],
    ["a resource added", (t) => { t.Resources.Extra = { Type: "AWS::Cognito::UserPoolGroup", Properties: {} }; }, "resource ADDED outside the allow-list"],
  ];
  it.each(cases)("stops on %s", (_n, mutate, text) => { const next = clone(release(AUTH)); mutate(next); violation(gate(AUTH, liveOf(AUTH), next), text); });
  it("stops when the live stack's URLs are not a prefix of the release's (another URL was added by hand)", () => {
    const live = liveOf(AUTH); live.Resources[client(live)].Properties.CallbackURLs.push("https://hand-added.example/cb");
    violation(gate(AUTH, live, release(AUTH)), "resource CHANGED outside the allow-list");
  });
});

describe("WebHosting and the stacks that must not change", () => {
  it("WebHosting: a changed resource, a different removed output, an extra removed output and an added output all stop", () => {
    const rel = release(WEB);
    let next = clone(rel); const dist = Object.keys(next.Resources).find((k) => next.Resources[k].Type === "AWS::CloudFront::Distribution")!; next.Resources[dist].Properties.DistributionConfig.Aliases = ["evil.example"];
    violation(gate(WEB, liveOf(WEB), next), "resource CHANGED outside the allow-list");
    const live = liveOf(WEB); live.Outputs.ExportsOutputSomethingElse = { Value: "x" };
    violation(gate(WEB, live, rel), "template section Outputs differs");
    next = clone(rel); next.Outputs = { ...(next.Outputs ?? {}), Added: { Value: "x" } };
    violation(gate(WEB, liveOf(WEB), next), "template section Outputs differs");
    const noExport = clone(rel); violation(gate(WEB, rel, Object.assign(clone(rel), { Outputs: { ...(rel.Outputs ?? {}), [WEB_EXPORT]: { Value: "x" } } })), "template section Outputs differs"); void noExport;
  });
  it.each([["Ogevia-prd-DatabaseSecret"], ["Ogevia-prd-EvidenceStorage"], ["Ogevia-prd-Observability"], [NET]])("%s: any difference at all stops", (s) => {
    const next = clone(release(s)); next.Resources.Added = { Type: "AWS::SSM::Parameter", Properties: {} };
    violation(gate(s, release(s), next), "resource ADDED outside the allow-list");
    const changed = clone(release(s)); const k = Object.keys(changed.Resources).find((x) => changed.Resources[x].Type !== "AWS::CDK::Metadata")!; changed.Resources[k].Properties = { ...(changed.Resources[k].Properties ?? {}), Zed: 1 };
    violation(gate(s, release(s), changed), "resource CHANGED outside the allow-list");
  });
  it("an unknown stack, a TEST stack, a pattern, unreadable input and a non-template stop (exit 1 or 2)", () => {
    for (const s of ["Ogevia-prod-ServiceVerificationApi", "Ogevia-prod-WebHosting", "Ogevia-prd-*", "Ogevia-prd-Other", ""]) { const r = gate(s, release(API), release(API)); expect(r.code, `${s}: ${r.out}`).not.toBe(0); }
    expect(gate(API, "not json", release(API)).code).toBe(2);
    expect(gate(API, "{}", release(API)).code).toBe(2);
    expect(gate(API, { Resources: {} }, "").code).toBe(2);
  });
});

describe("assembly_check_prd.py: the deploy-mode synthesis IS the approved release", () => {
  const check = (asm: string, rel: string, approval: string | null = APPROVAL) => sh("python3", ["-I", "-B", join(SCRIPTS_SRC, "assembly_check_prd.py"), "--assembly", asm, "--release-templates", rel, ...(approval ? ["--approval", approval] : [])]);
  const copy = (src: string) => { const d = mkdtempSync(join(tmpdir(), "prd-asm-")); cpSync(src, d, { recursive: true }); return d; };
  it("passes on the real assembly: six production stacks, the pinned Handler and Identity builds, 241 routes, every approval tag", () => {
    const r = check(synth().deploy, synth().rel);
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("PASS all checks"); expect(r.out).toContain("94b73574c5a6"); expect(r.out).toContain("241 API routes"); expect(r.out).toContain(`approved-${APPROVAL}`);
  });
  it("fails on a different approval reference", () => { const r = check(synth().deploy, synth().rel, "OTHER-REF-000000"); expect(r.code, r.out).toBe(1); expect(r.out).toContain("ogevia:deployment-status"); });
  it("fails when the assembly holds a TEST stack, lacks a production stack, or has a tampered template", () => {
    let a = copy(synth().deploy); cpSync(join(synth().prod, `${NET}.template.json`), join(a, `${NET}.template.json`)); expect(check(a, synth().rel).code).toBe(1);
    a = copy(synth().deploy); rmSync(join(a, `${AUTH}.template.json`)); expect(check(a, synth().rel).code).toBe(2);
    a = copy(synth().deploy); const p = join(a, `${WEB}.template.json`); const t = readJson(p); t.Resources.Extra = { Type: "AWS::SSM::Parameter", Properties: {} }; writeFileSync(p, JSON.stringify(t));
    const r = check(a, synth().rel); expect(r.code, r.out).toBe(1); expect(r.out).toContain(`FAIL ${WEB} equals the bundled release template`);
  });
  it("fails on another Handler build, a missing staff route, a missing asset directory and a missing manifest", () => {
    let a = copy(synth().deploy); let p = join(a, `${API}.template.json`); let t = readJson(p);
    t.Resources[apiResource(t, "AWS::Lambda::Function", (k) => k.startsWith("Handler") && !k.startsWith("IdentityHandler"))].Properties.Code.S3Key = PREVIOUS_HANDLER_KEY; writeFileSync(p, JSON.stringify(t));
    let r = check(a, synth().rel); expect(r.code, r.out).toBe(1); expect(r.out).toContain("FAIL Handler code asset is the release's build");
    a = copy(synth().deploy); p = join(a, `${API}.template.json`); t = readJson(p);
    delete t.Resources[Object.keys(t.Resources).find((k) => t.Resources[k].Properties?.RouteKey === NEW_KEYS[0])!]; writeFileSync(p, JSON.stringify(t));
    r = check(a, synth().rel); expect(r.code, r.out).toBe(1); expect(r.out).toMatch(/FAIL 240 API routes|FAIL each of the 13 staff routes/);
    a = copy(synth().deploy); rmSync(join(a, `asset.94b73574c5a681d5a8c22b4264742f64e5a6d40aa1ace783be12e7383b9d8a9e`), { recursive: true, force: true }); r = check(a, synth().rel); expect(r.code, r.out).toBe(1); expect(r.out).toContain("asset directory asset.94b73574c5a6");
    a = copy(synth().deploy); rmSync(join(a, "manifest.json")); r = check(a, synth().rel); expect(r.code, r.out).toBe(1); expect(r.out).toContain("manifest.json");
  });
  it("fails when the bundled release templates differ from the assembly (a stale package)", () => {
    const rel = copy(synth().rel); const p = join(rel, `${API}.json`); const t = readJson(p); t.Resources[apiResource(t, "AWS::ApiGatewayV2::Api")].Properties.Name = "other"; writeFileSync(p, JSON.stringify(t));
    const r = check(synth().deploy, rel); expect(r.code, r.out).toBe(1); expect(r.out).toContain(`FAIL ${API} equals the bundled release template`);
  });
  void mkdirSync; void rmSync;
});
