// diff_gate.py and assembly_check.py (TEST rehearsal, release 0b593e5) against REAL synthesized templates (test/fixtures/rehearsal-0b593e5: the baseline d893276 and the release
// 0b593e5, deploy mode). The gate must pass ONLY the release's expected change and fail on anything extra, anything removed, anything altered.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, PKG_REL, REPO_ROOT, sh } from "./rehearsal-fixtures.js";

const GATE = join(REPO_ROOT, PKG_REL, "scripts/diff_gate.py");
const ASSEMBLY = join(REPO_ROOT, PKG_REL, "scripts/assembly_check.py");
const NET = "Ogevia-prod-NetworkEgress", API = "Ogevia-prod-ServiceVerificationApi";
const TEST_B = "ogevia-prod-signature-evidence-300094796789-us-west-2", PRD_B = "ogevia-prd-signature-evidence-300094796789-us-west-2";
type T = any;
const load = (kind: string, stack: string): T => JSON.parse(readFileSync(join(FIXTURES, kind, `${stack}.template.json`), "utf8"));
const clone = (x: T): T => JSON.parse(JSON.stringify(x));
const tmp = mkdtempSync(join(tmpdir(), "gate-"));
let n = 0;
const put = (obj: unknown) => { const p = join(tmp, `f${n++}.json`); writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj)); return p; };
const gate = (stack: string, live: T, next: T) => sh("python3", ["-I", "-B", GATE, "template", "--stack", stack, "--live", put(live), "--new", put(next)]);
const epOf = (t: T) => Object.values<any>(t.Resources).find((r) => r.Type === "AWS::EC2::VPCEndpoint" && r.Properties.VpcEndpointType === "Gateway");
const handlerOf = (t: T) => Object.entries<any>(t.Resources).find(([k, r]) => r.Type === "AWS::Lambda::Function" && k.startsWith("Handler") && !k.startsWith("IdentityHandler"))!;
const policyOf = (t: T) => Object.entries<any>(t.Resources).find(([k, r]) => r.Type === "AWS::IAM::ManagedPolicy" && k.startsWith("HandlerPolicy"))!;
const base = { [NET]: load("baseline", NET), [API]: load("baseline", API) };
const rel = { [NET]: load("release", NET), [API]: load("release", API) };
const ok = (r: { code: number | null; out: string }) => { expect(r.code, r.out).toBe(0); expect(r.out).toContain("EXPECTED-ONLY: YES"); expect(r.out).not.toContain("VIOLATION"); };
const stop = (r: { code: number | null; out: string }, text: string | RegExp) => { expect(r.code, r.out).toBe(1); expect(r.out).toContain("EXPECTED-ONLY: NO"); expect(r.out).toMatch(text instanceof RegExp ? text : new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))); };

describe("the real release difference is exactly what the gate allows", () => {
  it("NetworkEgress: only the two client-documents resources are added to the S3 gateway endpoint policy (TEST and production bucket), nothing removed or changed", () => {
    const r = gate(NET, base[NET], rel[NET]);
    ok(r);
    expect(r.out).toContain(`arn:aws:s3:::${PRD_B}/*/client-documents/*/*`);
    expect(r.out).toContain(`arn:aws:s3:::${TEST_B}/*/client-documents/*/*`);
    expect(r.out).toContain("additive only; 6 earlier resources unchanged");
    // and the data behind it: the release endpoint policy is the baseline policy plus those two entries
    const b = epOf(base[NET]).Properties.PolicyDocument.Statement[0].Resource, a = epOf(rel[NET]).Properties.PolicyDocument.Statement[0].Resource;
    expect([...a].filter((x: string) => !b.includes(x)).sort()).toEqual([`arn:aws:s3:::${PRD_B}/*/client-documents/*/*`, `arn:aws:s3:::${TEST_B}/*/client-documents/*/*`]);
    expect(b.filter((x: string) => !a.includes(x))).toEqual([]);
  });
  it("ServiceVerificationApi: only the Handler code asset and the single ClientDocumentObjects statement (TEST bucket only)", () => {
    const r = gate(API, base[API], rel[API]);
    ok(r);
    expect(r.out).toMatch(/ALLOWED Lambda Handler\w+ code asset 929cdb1bde9b\.\.\. -> 6f37bc5510d1\.\.\./);
    expect(r.out).toContain("gains the single statement ClientDocumentObjects");
    const [, hb] = handlerOf(base[API]), [, hr] = handlerOf(rel[API]);
    expect(hr.Properties.Environment).toEqual(hb.Properties.Environment);
  });
  it("a different approval-tag VALUE alone is not a difference", () => {
    const live = clone(base[NET]);
    const tags = epOf(live).Properties.Tags as Array<{ Key: string; Value: string }>;
    tags.find((t) => t.Key === "ogevia:deployment-status")!.Value = "approved-SOME-OTHER-REF";
    ok(gate(NET, live, rel[NET]));
  });
});

describe("NetworkEgress: anything but the additive client-documents entries STOPS", () => {
  const net = () => ({ live: clone(base[NET]), next: clone(rel[NET]) });
  const stmt = (t: T) => epOf(t).Properties.PolicyDocument.Statement;
  it("a resource ADDED to the stack", () => { const { live, next } = net(); next.Resources.ExtraSg = { Type: "AWS::EC2::SecurityGroup", Properties: { GroupDescription: "x" } }; stop(gate(NET, live, next), "resource ADDED: ExtraSg"); });
  it("a resource REMOVED from the stack", () => { const { live, next } = net(); delete next.Resources[Object.keys(next.Resources).find((k) => next.Resources[k].Type !== "AWS::EC2::VPCEndpoint" && next.Resources[k].Type !== "AWS::CDK::Metadata")!]; stop(gate(NET, live, next), "resource REMOVED"); });
  it("the endpoint policy LOSES a production entry (the production bucket's access)", () => {
    const { live, next } = net();
    stmt(next)[0].Resource = stmt(next)[0].Resource.filter((r: string) => r !== `arn:aws:s3:::${PRD_B}/*/documents/*/*`);
    stop(gate(NET, live, next), "an existing statement was removed or altered");
  });
  it("the endpoint policy loses a TEST entry", () => { const { live, next } = net(); stmt(next)[0].Resource = stmt(next)[0].Resource.filter((r: string) => r !== `arn:aws:s3:::${TEST_B}/*/branding/logo/*`); stop(gate(NET, live, next), "removed or altered"); });
  it("an extra resource beyond the two client-documents ARNs", () => { const { live, next } = net(); stmt(next)[0].Resource.push(`arn:aws:s3:::${PRD_B}/*`); stop(gate(NET, live, next), "unexpected resources added"); });
  it("only ONE of the two client-documents ARNs (the production one missing)", () => { const { live, next } = net(); stmt(next)[0].Resource = stmt(next)[0].Resource.filter((r: string) => r !== `arn:aws:s3:::${PRD_B}/*/client-documents/*/*`); stop(gate(NET, live, next), "unexpected resources added"); });
  it("the Condition is altered", () => { const { live, next } = net(); stmt(next)[0].Condition.StringEquals["aws:PrincipalAccount"] = "111111111111"; stop(gate(NET, live, next), "removed or altered"); });
  it("the Principal is altered", () => { const { live, next } = net(); stmt(next)[0].Principal = { AWS: "arn:aws:iam::300094796789:root" }; stop(gate(NET, live, next), "removed or altered"); });
  it("an Action is added (s3:DeleteObject)", () => { const { live, next } = net(); stmt(next)[0].Action.push("s3:DeleteObject"); stop(gate(NET, live, next), "removed or altered"); });
  it("an extra statement is added", () => { const { live, next } = net(); stmt(next).push({ Effect: "Allow", Principal: { AWS: "*" }, Action: "s3:*", Resource: "*" }); stop(gate(NET, live, next), "an unexpected statement was added"); });
  it("a route table or any other endpoint property changes", () => { const { live, next } = net(); epOf(next).Properties.RouteTableIds.push("rtb-0123456789abcdef0"); stop(gate(NET, live, next), "changed outside Properties.PolicyDocument"); });
  it("an output or a template section changes", () => { const { live, next } = net(); next.Outputs = { ...(next.Outputs ?? {}), Extra: { Value: "x" } }; stop(gate(NET, live, next), "template section Outputs differs"); });
  it("a resource changes type (a replacement)", () => { const { live, next } = net(); const k = Object.keys(next.Resources).find((x) => next.Resources[x].Type === "AWS::EC2::VPCEndpoint" && next.Resources[x].Properties.VpcEndpointType === "Gateway")!; next.Resources[k].Type = "AWS::EC2::SecurityGroup"; stop(gate(NET, live, next), "changes TYPE"); });
  it("no change at all (nothing to deploy) is not accepted as the release", () => { stop(gate(NET, clone(rel[NET]), clone(rel[NET])), "expected exactly 1 allowed change"); });
});

describe("ServiceVerificationApi: anything but the code asset and ClientDocumentObjects STOPS", () => {
  const api = () => ({ live: clone(base[API]), next: clone(rel[API]) });
  it("a Lambda environment variable changes", () => { const { live, next } = api(); handlerOf(next)[1].Properties.Environment.Variables.OGEVIA_ENV = "prd"; stop(gate(API, live, next), "changed beyond its code asset"); });
  it("the Lambda role, memory or runtime changes", () => { const { live, next } = api(); handlerOf(next)[1].Properties.MemorySize = 4096; stop(gate(API, live, next), "changed beyond its code asset"); });
  it("an extra IAM statement in the handler policy", () => { const { live, next } = api(); policyOf(next)[1].Properties.PolicyDocument.Statement.push({ Effect: "Allow", Action: "s3:*", Resource: "*" }); stop(gate(API, live, next), "an unexpected statement was added"); });
  it("ClientDocumentObjects is wider than the client-documents key shape", () => { const { live, next } = api(); const s = policyOf(next)[1].Properties.PolicyDocument.Statement.find((x: any) => x.Sid === "ClientDocumentObjects"); s.Resource = `arn:aws:s3:::${TEST_B}/*`; stop(gate(API, live, next), /unexpected statement was added|expected new statement ClientDocumentObjects is not present/); });
  it("ClientDocumentObjects names the PRODUCTION bucket", () => { const { live, next } = api(); const s = policyOf(next)[1].Properties.PolicyDocument.Statement.find((x: any) => x.Sid === "ClientDocumentObjects"); s.Resource = `arn:aws:s3:::${PRD_B}/*/client-documents/*/*`; stop(gate(API, live, next), /unexpected statement was added/); });
  it("ClientDocumentObjects gains an action (s3:DeleteObject)", () => { const { live, next } = api(); policyOf(next)[1].Properties.PolicyDocument.Statement.find((x: any) => x.Sid === "ClientDocumentObjects").Action.push("s3:DeleteObject"); stop(gate(API, live, next), /unexpected statement was added/); });
  it("an existing IAM statement is removed or weakened", () => { const { live, next } = api(); policyOf(next)[1].Properties.PolicyDocument.Statement = policyOf(next)[1].Properties.PolicyDocument.Statement.filter((x: any) => x.Sid !== "AgencyLogoObjects"); stop(gate(API, live, next), "removed or altered"); });
  it("the managed policy changes outside its document (e.g. its roles)", () => { const { live, next } = api(); policyOf(next)[1].Properties.Description = "changed"; stop(gate(API, live, next), "changed outside its PolicyDocument"); });
  it("the identity Lambda changes", () => { const { live, next } = api(); const k = Object.keys(next.Resources).find((x) => x.startsWith("IdentityHandler") && next.Resources[x].Type === "AWS::Lambda::Function")!; next.Resources[k].Properties.Code.S3Key = "0".repeat(64) + ".zip"; stop(gate(API, live, next), "resource CHANGED outside the allow-list"); });
  it("a route is added or a permission removed", () => {
    let { live, next } = api(); next.Resources.ApiGETv1extra = { Type: "AWS::ApiGatewayV2::Route", Properties: {} }; stop(gate(API, live, next), "resource ADDED: ApiGETv1extra");
    ({ live, next } = api()); delete next.Resources[Object.keys(next.Resources).find((x) => next.Resources[x].Type === "AWS::Lambda::Permission")!]; stop(gate(API, live, next), "resource REMOVED");
  });
  it("any other resource changes (a route integration, the API itself)", () => { const { live, next } = api(); const k = Object.keys(next.Resources).find((x) => next.Resources[x].Type === "AWS::ApiGatewayV2::Route")!; next.Resources[k].Properties.AuthorizationType = "NONE"; stop(gate(API, live, next), "resource CHANGED outside the allow-list"); });
  it("the Lambda code key is not a CDK asset key, or did not change", () => {
    let { live, next } = api(); handlerOf(next)[1].Properties.Code.S3Key = "evil.zip"; stop(gate(API, live, next), "not a CDK asset key");
    ({ live, next } = api()); next.Resources[policyOf(next)[0]] = clone(live.Resources[policyOf(live)[0]]); handlerOf(next)[1].Properties.Code.S3Key = handlerOf(live)[1].Properties.Code.S3Key; handlerOf(next)[1].Metadata = clone(handlerOf(live)[1].Metadata); stop(gate(API, live, next), /no allowed change|expected exactly 2/);
  });
  it("no ClientDocumentObjects statement (only the code changed) is not the release", () => { const { live, next } = api(); policyOf(next)[1].Properties.PolicyDocument = clone(policyOf(live)[1].Properties.PolicyDocument); stop(gate(API, live, next), "expected exactly 2 allowed change"); });
});

describe("the gate refuses what it has no rule for, and fails closed on bad input", () => {
  it("any stack other than the two (including the production names)", () => {
    for (const s of ["Ogevia-prod-WebHosting", "Ogevia-prod-EvidenceStorage", "Ogevia-prod-Observability", "Ogevia-prd-ServiceVerificationApi", "Ogevia-prd-NetworkEgress", "*"]) {
      const r = gate(s, base[NET], rel[NET]);
      stop(r, "no allow-list exists for stack");
    }
  });
  it("a missing file, a non-template and invalid JSON exit non-zero (never a pass)", () => {
    expect(sh("python3", ["-I", "-B", GATE, "template", "--stack", NET, "--live", join(tmp, "nope.json"), "--new", put(rel[NET])]).code).toBe(2);
    expect(gate(NET, { not: "a template" }, rel[NET]).code).toBe(2);
    expect(sh("python3", ["-I", "-B", GATE, "template", "--stack", NET, "--live", put("{broken"), "--new", put(rel[NET])]).code).toBe(2);
    const bad = sh("python3", ["-I", "-B", GATE, "template", "--stack", NET, "--live", join(tmp, "nope.json"), "--new", put(rel[NET])]);
    expect(bad.out).not.toContain("EXPECTED-ONLY: YES");
  });
});

describe("endpoint-policy mode: the live policy after the NetworkEgress deployment is additive-only (production access preserved)", () => {
  const pol = (t: T) => clone(epOf(t).Properties.PolicyDocument);
  const run = (before: unknown, after: unknown) => sh("python3", ["-I", "-B", GATE, "endpoint-policy", "--before", put(before), "--after", put(after)]);
  const good = () => ({ before: pol(base[NET]), after: pol(rel[NET]) });
  it("the release policy is the baseline plus the two entries", () => { const { before, after } = good(); const r = run(before, after); expect(r.code, r.out).toBe(0); expect(r.out).toContain("ENDPOINT POLICY ADDITIVE-ONLY: YES"); });
  it("accepts the policy as AWS prints it: a JSON string, entries in a different order", () => {
    const { before, after } = good(); after.Statement[0].Resource.reverse();
    const r = run(JSON.stringify(JSON.stringify(before)), JSON.stringify(JSON.stringify(after))); expect(r.code, r.out).toBe(0);
  });
  it.each([
    ["lost a PRODUCTION entry", (a: T) => { a.Statement[0].Resource = a.Statement[0].Resource.filter((r: string) => r !== `arn:aws:s3:::${PRD_B}/*/client-signature.png`.replace("/*/client-signature.png", "/*/*/client-signature.png")); }, "PRODUCTION"],
    ["lost every production entry", (a: T) => { a.Statement[0].Resource = a.Statement[0].Resource.filter((r: string) => !r.includes(PRD_B)); }, "PRODUCTION bucket lost access"],
    ["lost a TEST entry", (a: T) => { a.Statement[0].Resource = a.Statement[0].Resource.filter((r: string) => !(r.includes(TEST_B) && r.includes("/documents/"))); }, "TEST bucket lost access"],
    ["gained an unexpected resource", (a: T) => { a.Statement[0].Resource.push(`arn:aws:s3:::${PRD_B}/*`); }, "unexpected"],
    ["changed its Condition", (a: T) => { delete a.Statement[0].Condition; }, "removed or altered"],
    ["changed its Principal", (a: T) => { a.Statement[0].Principal = "*"; }, "removed or altered"],
    ["gained a statement", (a: T) => { a.Statement.push({ Effect: "Deny", Principal: "*", Action: "s3:*", Resource: "*" }); }, "unexpected statement was added"],
    ["lost its only statement", (a: T) => { a.Statement = []; }, "removed or altered"],
    ["changed its Version", (a: T) => { a.Version = "2008-10-17"; }, "Version changed"],
  ])("fails when the policy %s", (_n, mutate, text) => {
    const { before, after } = good(); mutate(after);
    const r = run(before, after);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("ENDPOINT POLICY ADDITIVE-ONLY: NO");
    expect(r.out).toContain(text as string);
  });
  it("fails when nothing was added (the deployment did not take effect) and on unreadable input", () => {
    const b = pol(base[NET]);
    const r = run(b, b); expect(r.code, r.out).toBe(1); expect(r.out).toContain("did not gain exactly the two client-documents resources");
    expect(run("not json", b).code).toBe(2);
  });
});

describe("assembly_check.py pins the release synthesis", () => {
  it("accepts the five release templates and refuses a production stack, a changed Handler asset, a missing stack, and a tampered template", () => {
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    const write = (d: string, mutate?: (s: string, t: T) => T | null) => {
      for (const s of ["EvidenceStorage", "NetworkEgress", "WebHosting", "ServiceVerificationApi", "Observability"]) {
        let t = load("release", `Ogevia-prod-${s}`); if (mutate) t = mutate(s, t); if (t) writeFileSync(join(d, `Ogevia-prod-${s}.template.json`), JSON.stringify(t));
      }
    };
    write(dir); let r = sh("python3", ["-I", "-B", ASSEMBLY, "--assembly", dir]); expect(r.code, r.out).toBe(0); expect(r.out).toContain("PASS all checks");
    const d2 = mkdtempSync(join(tmpdir(), "asm-")); write(d2); writeFileSync(join(d2, "Ogevia-prd-ServiceVerificationApi.template.json"), "{}");
    r = sh("python3", ["-I", "-B", ASSEMBLY, "--assembly", d2]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("no Ogevia-prd-* stack");
    const d3 = mkdtempSync(join(tmpdir(), "asm-")); write(d3, (s, t) => { if (s === "ServiceVerificationApi") handlerOf(t)[1].Properties.Code.S3Key = "0".repeat(64) + ".zip"; return t; });
    r = sh("python3", ["-I", "-B", ASSEMBLY, "--assembly", d3]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("FAIL Handler code asset");
    const d4 = mkdtempSync(join(tmpdir(), "asm-")); write(d4, (s, t) => { if (s === "Observability") t.Description = "tampered"; return t; });
    r = sh("python3", ["-I", "-B", ASSEMBLY, "--assembly", d4]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("FAIL Ogevia-prod-Observability");
    const d5 = mkdtempSync(join(tmpdir(), "asm-")); write(d5, (s) => (s === "WebHosting" ? null : load("release", `Ogevia-prod-${s}`)));
    r = sh("python3", ["-I", "-B", ASSEMBLY, "--assembly", d5]); expect(r.code).toBe(2);
  });
  it("--live-dir: the baseline passes for both deployed stacks; a live stack that is not the baseline stops; the others only warn", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-"));
    for (const s of ["EvidenceStorage", "NetworkEgress", "WebHosting", "ServiceVerificationApi", "Observability"]) {
      const kind = s === "NetworkEgress" || s === "ServiceVerificationApi" ? "baseline" : "release";
      writeFileSync(join(dir, `Ogevia-prod-${s}.json`), JSON.stringify(load(kind, `Ogevia-prod-${s}`)));
    }
    let r = sh("python3", ["-I", "-B", ASSEMBLY, "--live-dir", dir]); expect(r.code, r.out).toBe(0);
    // the live API stack is already the release (or anything else): stop
    writeFileSync(join(dir, `${API}.json`), JSON.stringify(rel[API]));
    r = sh("python3", ["-I", "-B", ASSEMBLY, "--live-dir", dir]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("FAIL LIVE Ogevia-prod-ServiceVerificationApi");
    writeFileSync(join(dir, `${API}.json`), JSON.stringify(base[API]));
    const o = load("release", "Ogevia-prod-Observability"); o.Description = "drift"; writeFileSync(join(dir, "Ogevia-prod-Observability.json"), JSON.stringify(o));
    r = sh("python3", ["-I", "-B", ASSEMBLY, "--live-dir", dir]); expect(r.code, r.out).toBe(0); expect(r.out).toContain("WARN LIVE Ogevia-prod-Observability differs");
  });
});
