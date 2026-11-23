// production-request-cleanup-routes-release.py and ...-deploy.sh (turn the request-cleanup switch ON in production: three routes added to the LIVE template).
// Stand-in `aws` and `curl`; nothing touches AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const helperSrc = join(scripts, "production-request-cleanup-routes-release.py");
const deploySrc = join(scripts, "production-request-cleanup-routes-deploy.sh");
const KEYS = ["POST /v1/care-notifications/read", "POST /v1/documents/{documentId}/cancel", "POST /v1/document-types/{documentTypeId}/retire"];
const IDS = ["ApiPOSTv1carenotificationsread36182164", "ApiPOSTv1documentsdocumentIdcancelB924AA20", "ApiPOSTv1documenttypesdocumentTypeIdretireB9059636"];
const route = (RouteKey: string) => ({ Type: "AWS::ApiGatewayV2::Route", Properties: { ApiId: { Ref: "ApiF70053CD" }, AuthorizationType: "JWT", AuthorizerId: { Ref: "ApiCognitoJwt1870F097" }, RouteKey, Target: { "Fn::Join": ["", ["integrations/", { Ref: "ApiGETv1meHandlerCDA9441F" }]] } } });

function live(extra: Record<string, unknown> = {}) {
  const base = ["GET /v1/business-documents", "POST /v1/business-documents", "GET /v1/reports/missing-visits", "POST /v1/shifts/{shiftId}/missing-visit", "POST /v1/checkin", "POST /v1/clients/{clientId}/qr-card", "GET /v1/attention", "GET /v1/signin-overrides"];
  return {
    Parameters: { P1: { Type: "String" } },
    Resources: {
      Handler886CB40B: { Type: "AWS::Lambda::Function", Properties: { Runtime: "nodejs24.x", Environment: { Variables: { DB_NAME: "ogevia_prd", OGEVIA_ENV: "prd", DB_HOST: "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com" } } } },
      ...Object.fromEntries(base.map((k, i) => [`R${i}`, route(k)])),
      ...extra,
    },
  };
}
const run = (args: string[]) => spawnSync("python3", [helperSrc, ...args], { encoding: "utf8" });
function patchOut(t: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "rc-")); const i = join(dir, "in.json"), o = join(dir, "out.json"); writeFileSync(i, JSON.stringify(t));
  return { r: run(["patch", i, o]), o };
}

describe("helper", () => {
  it("adds exactly the three routes, copying the sibling's API, authorizer and integration, and changes nothing else", () => {
    const before = live(); const { r, o } = patchOut(before);
    expect(r.status, r.stderr).toBe(0);
    const after = JSON.parse(readFileSync(o, "utf8"));
    expect(Object.keys(after.Resources).filter((k) => !(k in before.Resources)).sort()).toEqual([...IDS].sort());
    for (const [i, id] of IDS.entries()) expect(after.Resources[id].Properties).toEqual(route(KEYS[i]!).Properties);
    for (const id of IDS) delete after.Resources[id];
    expect(after).toEqual(before);
  });
  it("refuses when a route already exists, an accepted route is missing, a stay-off route is present, the reference route is missing or it is not production", () => {
    const cases: Record<string, (t: any) => void> = {
      "already on": (t) => { t.Resources.X = route(KEYS[0]!); },
      "accepted route missing": (t) => { delete t.Resources.R0; },
      "import on": (t) => { t.Resources.X = route("POST /v1/imports/{kind}"); },
      "no reference route": (t) => { delete t.Resources.R6; },
      "not production": (t) => { t.Resources.Handler886CB40B.Properties.Environment.Variables.DB_NAME = "ogevia_sv_test"; },
      "reference not JWT": (t) => { t.Resources.R6.Properties.AuthorizationType = "NONE"; },
    };
    for (const [name, mutate] of Object.entries(cases)) { const t: any = live(); mutate(t); expect(patchOut(t).r.status, name).not.toBe(0); }
  });
  it("accepts a change set of exactly the three routes (Add, or Remove for the rollback) and refuses anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-cs-")); const p = join(dir, "cs.json");
    const cs = (action: string, ids = IDS, extra: unknown[] = []) => ({ Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Changes: [...ids.map((id) => ({ ResourceChange: { LogicalResourceId: id, ResourceType: "AWS::ApiGatewayV2::Route", Action: action } })), ...extra] });
    writeFileSync(p, JSON.stringify(cs("Add"))); expect(run(["changes", p]).status).toBe(0); expect(run(["rollback-changes", p]).status).not.toBe(0);
    writeFileSync(p, JSON.stringify(cs("Remove"))); expect(run(["rollback-changes", p]).status).toBe(0);
    writeFileSync(p, JSON.stringify(cs("Add", IDS.slice(0, 2)))); expect(run(["changes", p]).status).not.toBe(0);
    writeFileSync(p, JSON.stringify(cs("Add", IDS, [{ ResourceChange: { LogicalResourceId: "Handler886CB40B", ResourceType: "AWS::Lambda::Function", Action: "Modify" } }]))); expect(run(["changes", p]).status).not.toBe(0);
  });
  it("refuses a deployed Handler that is not the release code", () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-zip-")); const z = join(dir, "h.zip");
    spawnSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('index.js','old code'); z.close()", z]);
    const r = run(["deployed", z]); expect(r.status).not.toBe(0); expect(r.stderr).toContain("not the release code");
  });
});

function setup(opts: { smoke?: "ok" | "bad"; handler?: "release" | "old" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rcd-")); const op = join(dir, "op"), bin = join(dir, "bin"), st = join(dir, "state"), calls = join(dir, "calls");
  mkdirSync(op); mkdirSync(bin); mkdirSync(st); writeFileSync(calls, ""); writeFileSync(join(st, "mode"), "before");
  // a Handler zip, and a copy of the helper whose pinned release hash is that zip's hash (the real hash belongs to the real bundle)
  const zip = join(dir, "handler.zip");
  spawnSync("python3", ["-c", `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('index.js','${opts.handler === "old" ? "old" : "release"} code'); z.close()`, zip]);
  const hash = spawnSync("python3", ["-c", "import zipfile,hashlib,sys; print(hashlib.sha256(zipfile.ZipFile(sys.argv[1]).read('index.js')).hexdigest())", join(dir, "release.zip")], { encoding: "utf8" });
  spawnSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('index.js','release code'); z.close()", join(dir, "release.zip")]);
  const h = spawnSync("python3", ["-c", "import zipfile,hashlib,sys; print(hashlib.sha256(zipfile.ZipFile(sys.argv[1]).read('index.js')).hexdigest())", join(dir, "release.zip")], { encoding: "utf8" }).stdout.trim();
  void hash;
  writeFileSync(join(op, "production-request-cleanup-routes-release.py"), readFileSync(helperSrc, "utf8").replace(/JS_HASH = '[0-9a-f]{64}'/, `JS_HASH = '${h}'`));
  copyFileSync(deploySrc, join(op, "production-request-cleanup-routes-deploy.sh"));
  const liveT = live(); const onT = JSON.parse(JSON.stringify(liveT)); IDS.forEach((id, i) => { onT.Resources[id] = { Type: "AWS::ApiGatewayV2::Route", Properties: route(KEYS[i]!).Properties, Metadata: { "aws:cdk:path": `Ogevia-prd-ServiceVerificationApi/Api/${["POST--v1--care-notifications--read", "POST--v1--documents--{documentId}--cancel", "POST--v1--document-types--{documentTypeId}--retire"][i]}/Resource` } }; });
  writeFileSync(join(dir, "live.json"), JSON.stringify(liveT)); writeFileSync(join(dir, "on.json"), JSON.stringify(onT));
  const changes = (action: string) => ({ Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Changes: IDS.map((id) => ({ ResourceChange: { LogicalResourceId: id, ResourceType: "AWS::ApiGatewayV2::Route", Action: action } })) });
  writeFileSync(join(dir, "cs-add.json"), JSON.stringify(changes("Add"))); writeFileSync(join(dir, "cs-remove.json"), JSON.stringify(changes("Remove")));
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env python3
import sys, json
a = sys.argv[1:]
while a[:2] in (["--cli-connect-timeout", "5"], ["--cli-read-timeout", "60"]): a = a[2:]
line = " ".join(a); open(${JSON.stringify(calls)}, "a").write("aws " + line + "\\n")
mode = open(${JSON.stringify(join(st, "mode"))}).read().strip()
D = ${JSON.stringify(dir)}
if "sts get-caller-identity" in line: print("300094796789")
elif "describe-stacks" in line and "StackStatus" in line: print("UPDATE_COMPLETE")
elif "describe-stacks" in line: print(json.dumps(["P1"]))
elif "get-template" in line: print(open(D + ("/on.json" if mode == "on" else "/live.json")).read())
elif "list-stack-resources" in line and "Handler" in line: print("fn")
elif "list-stack-resources" in line and "Api'" in line: print("zk527zk4ua")
elif "get-function-configuration" in line: print("SHA\\togevia_prd\\tprd")
elif "lambda get-function" in line: print("https://example.invalid/code.zip")
elif "s3 cp" in line: pass
elif "create-change-set" in line: print("{}")
elif "wait" in line: pass
elif "describe-change-set" in line: print(open(D + ("/cs-remove.json" if "rollback" in line else "/cs-add.json")).read())
elif "execute-change-set" in line: open(${JSON.stringify(join(st, "mode"))}, "w").write("before" if "rollback" in line else "on")
elif "delete-change-set" in line: pass
elif "apigatewayv2 get-routes" in line: print("JWT")
elif "logs filter-log-events" in line: pass
else: sys.stderr.write("UNEXPECTED AWS CALL: " + line + "\\n"); sys.exit(9)
`);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
url=""; out=""; prev=""; for x in "$@"; do [[ "$prev" == "-o" ]] && out="$x"; [[ "$x" == http* ]] && url="$x"; prev="$x"; done
mode=$(cat ${JSON.stringify(join(st, "mode"))})
case "$url" in
  *code.zip) cp ${JSON.stringify(zip)} "$out";;
  */v1/me) echo -n 401;;
  *) if [[ "$mode" == on && ${JSON.stringify(opts.smoke ?? "ok")} == ok ]]; then echo -n 401; else echo -n 404; fi;;
esac
`);
  chmodSync(join(bin, "aws"), 0o755); chmodSync(join(bin, "curl"), 0o755);
  return { dir, op: join(op, "production-request-cleanup-routes-deploy.sh"), bin, calls, st };
}
const sh = (s: ReturnType<typeof setup>, args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [s.op, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, OGEVIA_SMOKE_SLEEP: "0", OGEVIA_DEPLOY_APPROVAL: "owner-production-request-cleanup-go", OGEVIA_RELEASE_SHA: "ef90a2a42c21e2c68e6fbf3f361e618806699b8d", ...env } });
const SHA = "ef90a2a42c21e2c68e6fbf3f361e618806699b8d";
const wsOf = (out: string) => /workspace (\/tmp\/ogevia-request-cleanup\.\w+)/.exec(out)![1]!;
const changesMade = (s: ReturnType<typeof setup>) => readFileSync(s.calls, "utf8").split("\n").filter((l) => /execute-change-set|create-change-set|s3 cp/.test(l));

describe("deploy script", () => {
  it("refuses without the approval reference, in the wrong account, or for a different commit, before any change", () => {
    let s = setup();
    try {
      let r = sh(s, ["plan"], { OGEVIA_DEPLOY_APPROVAL: "owner-signin-override-go" }); expect(r.status).toBe(1); expect(r.stderr).toContain("owner approval is missing");
      r = sh(s, ["plan"], { OGEVIA_RELEASE_SHA: "0".repeat(40) }); expect(r.status).toBe(1); expect(r.stderr).toContain("this one commit");
      expect(changesMade(s)).toEqual([]);
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
    s = setup();
    try { writeFileSync(join(s.bin, "aws"), "#!/bin/sh\necho 111111111111\n"); const r = sh(s, ["plan"]); expect(r.status).toBe(1); expect(r.stderr).toContain("wrong AWS account"); } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });
  it("plan stops, changing nothing in AWS, when the production Handler is not the release code", () => {
    const s = setup({ handler: "old" });
    try { const r = sh(s, ["plan"]); expect(r.status).not.toBe(0); expect(r.stderr).toContain("not the release code"); expect(changesMade(s)).toEqual([]); } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });
  it("plan creates and guards a change set without executing it; apply executes it, verifies the live template and the 401 smoke, and reports success", () => {
    const s = setup();
    try {
      const p = sh(s, ["plan"]); expect(p.status, p.stderr + p.stdout).toBe(0);
      expect(p.stdout).toContain("PASS: the live production template plus exactly three JWT routes"); expect(p.stdout).toContain("PASS: the change set adds exactly the three request-cleanup routes"); expect(p.stdout).toContain("PLAN READY");
      expect(readFileSync(s.calls, "utf8")).not.toContain("execute-change-set");
      const ws = wsOf(p.stdout);
      const a = sh(s, ["apply", ws]); expect(a.status, a.stderr + a.stdout).toBe(0);
      expect(a.stdout).toContain("REQUEST CLEANUP IS ON IN PRODUCTION"); expect((a.stdout.match(/: 401/g) ?? []).length).toBeGreaterThanOrEqual(5);
      expect(readFileSync(s.calls, "utf8").match(/execute-change-set/g)?.length).toBe(1);
      expect(readFileSync(s.calls, "utf8")).not.toMatch(/ogevia_sv_test|Ogevia-prod-|lambda update|cloudformation deploy/);
      rmSync(ws, { recursive: true, force: true });
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  }, 60000);
  it("apply rolls back by itself when the smoke check fails, and ends with the stack equal to its captured template", () => {
    const s = setup({ smoke: "bad" });
    try {
      const p = sh(s, ["plan"]); const ws = wsOf(p.stdout);
      const a = sh(s, ["apply", ws]); expect(a.status).toBe(1);
      expect(a.stdout + a.stderr).toContain("SMOKE FAILED: rolling back"); expect(a.stdout).toContain("ROLLED BACK");
      expect(readFileSync(s.calls, "utf8").match(/execute-change-set/g)?.length).toBe(2);
      expect(readFileSync(join(s.st, "mode"), "utf8").trim()).toBe("before");
      rmSync(ws, { recursive: true, force: true });
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
    void existsSync;
  }, 60000);
});
