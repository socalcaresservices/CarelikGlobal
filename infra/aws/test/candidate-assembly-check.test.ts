// slice/candidate_assembly_check.py against the REAL synthesized assembly of this checkout (deploy mode, local, no AWS) and against deliberate mutations of it.
// The checkout under test must be the approved candidate for the pins to hold; on any other commit the first test fails, which is the point.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240000, hookTimeout: 240000 });
const INFRA = fileURLToPath(new URL("..", import.meta.url));
const PY = join(INFRA, "slice", "candidate_assembly_check.py");
const API = "Ogevia-prod-ServiceVerificationApi.template.json";
let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "asm-"));
  // a different approval reference than any real deployment: the check must not depend on it
  const r = spawnSync("npx", ["cdk", "synth", "--quiet", "--no-notices", "-c", "env=prod", "-c", "mode=deploy", "-o", base], { cwd: INFRA, encoding: "utf8", env: { ...process.env, OGEVIA_DEPLOY_APPROVAL: "assembly-check-rehearsal-ref" } });
  if (r.status !== 0) throw new Error("synth failed: " + r.stderr);
});
function check(dir: string, extra: string[] = []) {
  const r = spawnSync("python3", ["-I", PY, "--assembly", dir, ...extra], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}
function mutated(mutate: (t: any, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "asm-mut-"));
  cpSync(base, dir, { recursive: true });
  const f = join(dir, API);
  const t = JSON.parse(readFileSync(f, "utf8"));
  mutate(t, dir);
  writeFileSync(f, JSON.stringify(t));
  return dir;
}
const handler = (t: any) => Object.entries<any>(t.Resources).find(([k, v]) => v.Type === "AWS::Lambda::Function" && !k.startsWith("Identity"))![1];

describe("the real synthesized assembly", () => {
  it("is the approved candidate: pins, resource counts, ENABLED rule, and nothing else different from the baseline", () => {
    const r = check(base);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("PASS all checks");
    expect(r.out.match(/^PASS /gm)!.length).toBeGreaterThanOrEqual(9);
  });
  it("fails when the rule is DISABLED, removed, or doubled", () => {
    for (const m of [(t: any) => { Object.values<any>(t.Resources).find((r) => r.Type === "AWS::Events::Rule").Properties.State = "DISABLED"; },
                     (t: any) => { const k = Object.keys(t.Resources).find((k) => t.Resources[k].Type === "AWS::Events::Rule")!; delete t.Resources[k]; },
                     (t: any) => { t.Resources.ExtraRule = JSON.parse(JSON.stringify(Object.values<any>(t.Resources).find((r) => r.Type === "AWS::Events::Rule"))); }]) {
      expect(check(mutated(m)).code).toBe(1);
    }
  });
  it("fails on any other change: an IAM statement, a Lambda environment value, a different code asset, an extra resource, a removed route", () => {
    expect(check(mutated((t) => { const p = Object.values<any>(t.Resources).find((r) => r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy"); p.Properties.PolicyDocument.Statement.push({ Effect: "Allow", Action: "s3:*", Resource: "*" }); })).code).toBe(1);
    expect(check(mutated((t) => { handler(t).Properties.Environment.Variables.DB_NAME = "ogevia_prd"; })).code).toBe(1);
    expect(check(mutated((t) => { handler(t).Properties.Code.S3Key = "0".repeat(64) + ".zip"; })).code).toBe(1);
    expect(check(mutated((t) => { t.Resources.Surprise = { Type: "AWS::SQS::Queue", Properties: {} }; })).code).toBe(1);
    const noRoute = check(mutated((t) => { const k = Object.keys(t.Resources).find((k) => t.Resources[k].Type === "AWS::ApiGatewayV2::Route")!; delete t.Resources[k]; }));
    expect(noRoute.code).toBe(1);
    expect(noRoute.out).toContain("228 API routes");
  });
  it("fails when a production (Ogevia-prd-*) template is in the assembly, or a TEST template is missing", () => {
    const withPrd = mutated((_t, dir) => writeFileSync(join(dir, "Ogevia-prd-ServiceVerificationApi.template.json"), "{}"));
    expect(check(withPrd).code).toBe(1);
    const missing = mutated((_t, dir) => rmSync(join(dir, "Ogevia-prod-Observability.template.json")));
    expect(check(missing).code).toBe(1);
  });
  it("the approval reference is not part of the comparison (tag values are normalised)", () => {
    const dir = mutated(() => {});
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".template.json"))) {
      writeFileSync(join(dir, f), readFileSync(join(dir, f), "utf8").split("assembly-check-rehearsal-ref").join("owner-go-test-2026-10-19"));
    }
    expect(check(dir).code).toBe(0);
  });
});

describe("the live-template mode", () => {
  it("passes a template that equals the recorded baseline and fails the candidate's own (a live stack already at the candidate is not the baseline)", () => {
    const t = JSON.parse(readFileSync(join(base, API), "utf8"));
    // reconstruct the baseline from the candidate: remove the expected additions and restore the baseline asset
    const py = spawnSync("python3", ["-I", "-c", `import json,sys,importlib.util
spec=importlib.util.spec_from_file_location('c','${PY}'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({'added':m.EXPECTED_ADDED_IDS,'baseline':m.BASELINE_HANDLER_KEY}))`], { encoding: "utf8" });
    const { added, baseline } = JSON.parse(py.stdout);
    for (const id of added) delete t.Resources[id];
    handler(t).Properties.Code.S3Key = baseline;
    const f = join(mkdtempSync(join(tmpdir(), "live-")), "live.json");
    writeFileSync(f, JSON.stringify({ TemplateBody: t }));
    const ok = spawnSync("python3", ["-I", PY, "--live-template", f], { encoding: "utf8" });
    expect(ok.status, ok.stdout).toBe(0);
    const cand = join(mkdtempSync(join(tmpdir(), "live-")), "cand.json");
    cpSync(join(base, API), cand);
    const bad = spawnSync("python3", ["-I", PY, "--live-template", cand], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("Do NOT treat commit d82fefc as the rollback target");
  });
});
