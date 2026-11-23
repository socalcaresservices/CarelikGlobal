// production-offices-release.py: the template patches for the production Offices + request-cleanup release, against a synthetic production-shaped template. No AWS.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const helper = join(root, "infra/aws/scripts/production-offices-release.py");
const ASSETS = "cdk-hnb659fds-assets-300094796789-us-west-2";
const NEWKEY = "a".repeat(64) + ".zip"; const OLDKEY = "b".repeat(64) + ".zip";
const CLEANUP = ["POST /v1/care-notifications/read", "POST /v1/documents/{documentId}/cancel", "POST /v1/document-types/{documentTypeId}/retire"];
const OFFICES = ["GET /v1/offices", "GET /v1/client-offices", "POST /v1/offices", "POST /v1/offices/{officeId}/rename", "POST /v1/offices/{officeId}/retire", "POST /v1/clients/{clientId}/office"];
const route = (key: string) => ({ Type: "AWS::ApiGatewayV2::Route", Properties: { ApiId: { Ref: "Api" }, AuthorizationType: "JWT", AuthorizerId: { Ref: "Auth" }, RouteKey: key, Target: { "Fn::Join": ["", ["integrations/", { Ref: "Int" }]] } } });
function live(extra: Record<string, unknown> = {}) {
  const r: Record<string, unknown> = {
    Handler886CB40B: { Type: "AWS::Lambda::Function", Properties: { Runtime: "nodejs24.x", Code: { S3Bucket: ASSETS, S3Key: OLDKEY }, Environment: { Variables: { DB_NAME: "ogevia_prd", OGEVIA_ENV: "prd", DB_HOST: "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com", COGNITO_USER_POOL_ID: "us-west-2_FHJoX71ca" } } } },
  };
  ["GET /v1/attention", "GET /v1/me", "GET /v1/business-documents", "POST /v1/business-documents", "GET /v1/reports/missing-visits", "POST /v1/shifts/{shiftId}/missing-visit", "POST /v1/checkin", "POST /v1/clients/{clientId}/qr-card", "POST /v1/caregivers/{caregiverRecordId}/signin-override", "GET /v1/signin-overrides"]
    .forEach((k, i) => { r[`R${i}`] = route(k); });
  return { Parameters: {}, Resources: { ...r, ...extra } };
}
function run(args: string[]) { return spawnSync("python3", [helper, ...args], { encoding: "utf8", env: { ...process.env, OGEVIA_UX_SOURCE_ROOT: root } }); }
function withFiles<T>(fn: (d: string, w: (n: string, v: unknown) => string) => T) {
  const d = mkdtempSync(join(tmpdir(), "po-")); const w = (n: string, v: unknown) => { const p = join(d, n); writeFileSync(p, JSON.stringify(v)); return p; };
  try { return fn(d, w); } finally { rmSync(d, { recursive: true, force: true }); }
}

describe("production-offices-release.py", () => {
  it("patch-code changes only the Handler Code and refuses if a release route is already there or the stack is not production", () => withFiles((d, w) => {
    const out = join(d, "out.json"); const r = run(["patch-code", w("live.json", live()), out, NEWKEY]); expect(r.status, r.stderr).toBe(0);
    const t = JSON.parse(readFileSync(out, "utf8")); expect(t.Resources.Handler886CB40B.Properties.Code).toEqual({ S3Bucket: ASSETS, S3Key: NEWKEY });
    expect(JSON.stringify({ ...t.Resources, Handler886CB40B: 0 })).toBe(JSON.stringify({ ...live().Resources, Handler886CB40B: 0 }));
    expect(run(["patch-code", w("a.json", live({ RX: route(OFFICES[0]!) })), out, NEWKEY]).stderr).toContain("must still be absent");
    const notProd = live(); (notProd.Resources.Handler886CB40B as any).Properties.Environment.Variables.DB_NAME = "ogevia_sv_test";
    expect(run(["patch-code", w("b.json", notProd), out, NEWKEY]).stderr).toContain("not the production API stack");
    expect(run(["patch-code", w("c.json", live()), out, "../x.zip"]).stderr).toContain("unexpected asset key");
  }));
  it("patch-routes adds exactly the nine routes (three request cleanup, six offices), as JWT routes copied from the reference route, and nothing else", () => withFiles((d, w) => {
    const out = join(d, "out.json"); const r = run(["patch-routes", w("live.json", live()), out]); expect(r.status, r.stderr).toBe(0);
    const t = JSON.parse(readFileSync(out, "utf8")); const keys = Object.values(t.Resources as Record<string, any>).filter((x) => x.Type === "AWS::ApiGatewayV2::Route").map((x) => x.Properties.RouteKey);
    for (const k of [...CLEANUP, ...OFFICES]) expect(keys).toContain(k);
    expect(keys.length).toBe(Object.keys(live().Resources).length - 1 + 9);
    for (const x of Object.values(t.Resources as Record<string, any>)) if (x.Type === "AWS::ApiGatewayV2::Route") expect(x.Properties.AuthorizationType).toBe("JWT");
    expect(run(["routes", out, "present"]).status).toBe(0); expect(run(["routes", w("l.json", live()), "absent"]).status).toBe(0);
    expect(run(["routes", w("l2.json", live()), "present"]).status).not.toBe(0);
  }));
  it("patch-routes refuses a route that is already there, a missing reference route, and a route that must stay off", () => withFiles((d, w) => {
    const out = join(d, "out.json");
    expect(run(["patch-routes", w("a.json", live({ RX: route(CLEANUP[2]!) })), out]).stderr).toContain("already has the route");
    expect(run(["patch-routes", w("b.json", live({ RX: route("GET /v1/staff/duplicates") })), out]).stderr).toContain("must stay off");
    const noSib = live(); delete (noSib.Resources as any).R0;
    expect(run(["patch-routes", w("c.json", noSib), out]).stderr).toContain("reference route missing");
  }));
  it("changes-routes accepts exactly the nine route additions (or removals) and rejects anything else", () => withFiles((_d, w) => {
    const ids = ["ApiPOSTv1carenotificationsread36182164", "ApiPOSTv1documentsdocumentIdcancelB924AA20", "ApiPOSTv1documenttypesdocumentTypeIdretireB9059636", "ApiGETv1offices49969B79", "ApiGETv1clientofficesDA8F1F34", "ApiPOSTv1offices4301D2D3", "ApiPOSTv1officesofficeIdrenameBBB7BE62", "ApiPOSTv1officesofficeIdretireCF76B9F0", "ApiPOSTv1clientsclientIdofficeD78D1374"];
    const cs = (action: string, list: string[], status = "CREATE_COMPLETE") => ({ Status: status, ExecutionStatus: "AVAILABLE", Changes: list.map((id) => ({ ResourceChange: { LogicalResourceId: id, ResourceType: id === "X" ? "AWS::Lambda::Function" : "AWS::ApiGatewayV2::Route", Action: action, Replacement: "False" } })) });
    expect(run(["changes-routes", w("a.json", cs("Add", ids))]).status).toBe(0);
    expect(run(["changes-routes", w("b.json", cs("Remove", ids)), "Remove"]).status).toBe(0);
    expect(run(["changes-routes", w("c.json", cs("Add", ids.slice(1)))]).status).not.toBe(0);
    expect(run(["changes-routes", w("d.json", cs("Add", [...ids, "X"]))]).status).not.toBe(0);
    expect(run(["changes-routes", w("e.json", cs("Add", ids, "CREATE_PENDING"))]).status).not.toBe(0);
    expect(run(["changes-routes", w("f.json", cs("Modify", ids))]).status).not.toBe(0);
    expect(run(["changes-routes-add", w("g.json", cs("Add", ids))]).status).toBe(0);
    expect(run(["changes-routes-remove", w("h.json", cs("Remove", ids))]).status).toBe(0);
    expect(run(["changes-routes-add", w("i.json", cs("Remove", ids))]).status).not.toBe(0);
    expect(run(["changes-routes-remove", w("j.json", cs("Add", ids))]).status).not.toBe(0);
  }));
  it("the logical ids and CDK paths of the nine routes are the ones the current CDK source produces", () => {
    const src = readFileSync(join(root, "infra/aws/lib/service-verification-api-stack.ts"), "utf8");
    for (const k of [...CLEANUP, ...OFFICES]) { const [m, p] = k.split(" "); expect(src).toContain(`path: "${p}"`); expect(src).toContain(`HttpMethod.${m}`); }
  });
  it("hash and deployed compare a Handler zip's index.js", () => withFiles((d) => {
    const z = join(d, "h.zip"); expect(spawnSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('index.js','code'); z.close()", z]).status).toBe(0);
    const h = run(["hash", z]).stdout.trim(); expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(run(["deployed", z, h]).status).toBe(0); expect(run(["deployed", z, "0".repeat(64)]).status).not.toBe(0);
  }));
});
