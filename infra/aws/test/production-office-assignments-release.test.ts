// production-office-assignments-release.py: the template patches for the production release of office assignments, counties, caregiver colour and assignment history, against a synthetic production-shaped template (the state AFTER the Offices release). No AWS.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const helper = join(root, "infra/aws/scripts/production-office-assignments-release.py");
const ASSETS = "cdk-hnb659fds-assets-300094796789-us-west-2";
const NEWKEY = "a".repeat(64) + ".zip"; const OLDKEY = "b".repeat(64) + ".zip";
const NINE = ["POST /v1/offices/{officeId}/update", "POST /v1/offices/{officeId}/reactivate", "GET /v1/people-facets", "POST /v1/clients/{clientId}/offices", "POST /v1/caregivers/{caregiverRecordId}/offices",
  "POST /v1/clients/{clientId}/service-county", "POST /v1/caregivers/{caregiverRecordId}/service-counties", "POST /v1/caregivers/{caregiverRecordId}/color", "GET /v1/assignment-history"];
const IDS = ["ApiPOSTv1officesofficeIdupdateA0A62D1B", "ApiPOSTv1officesofficeIdreactivate979917A0", "ApiGETv1peoplefacets69C143E7", "ApiPOSTv1clientsclientIdoffices47DA6F02", "ApiPOSTv1caregiverscaregiverRecordIdofficesC1965768",
  "ApiPOSTv1clientsclientIdservicecounty2C20AB1E", "ApiPOSTv1caregiverscaregiverRecordIdservicecounties97FEA4F0", "ApiPOSTv1caregiverscaregiverRecordIdcolorA8B94D69", "ApiGETv1assignmenthistory78D24E24"];
// what production already has after the Offices release
const RETAINED = ["GET /v1/attention", "GET /v1/me", "GET /v1/business-documents", "POST /v1/business-documents", "GET /v1/reports/missing-visits", "POST /v1/shifts/{shiftId}/missing-visit", "POST /v1/checkin", "POST /v1/clients/{clientId}/qr-card",
  "POST /v1/care-notifications/read", "POST /v1/documents/{documentId}/cancel", "POST /v1/document-types/{documentTypeId}/retire",
  "GET /v1/offices", "GET /v1/client-offices", "POST /v1/offices", "POST /v1/offices/{officeId}/rename", "POST /v1/offices/{officeId}/retire", "POST /v1/clients/{clientId}/office",
  "POST /v1/caregivers/{caregiverRecordId}/signin-override", "GET /v1/signin-overrides"];
const route = (key: string) => ({ Type: "AWS::ApiGatewayV2::Route", Properties: { ApiId: { Ref: "Api" }, AuthorizationType: "JWT", AuthorizerId: { Ref: "Auth" }, RouteKey: key, Target: { "Fn::Join": ["", ["integrations/", { Ref: "Int" }]] } } });
function live(extra: Record<string, unknown> = {}, keys: string[] = RETAINED) {
  const r: Record<string, unknown> = {
    Handler886CB40B: { Type: "AWS::Lambda::Function", Properties: { Runtime: "nodejs24.x", Code: { S3Bucket: ASSETS, S3Key: OLDKEY }, Environment: { Variables: { DB_NAME: "ogevia_prd", OGEVIA_ENV: "prd", DB_HOST: "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com", COGNITO_USER_POOL_ID: "us-west-2_FHJoX71ca" } } } },
  };
  keys.forEach((k, i) => { r[`R${i}`] = route(k); });
  return { Parameters: {}, Resources: { ...r, ...extra } };
}
function run(args: string[]) { return spawnSync("python3", [helper, ...args], { encoding: "utf8", env: { ...process.env, OGEVIA_UX_SOURCE_ROOT: root } }); }
function withFiles<T>(fn: (d: string, w: (n: string, v: unknown) => string) => T) {
  const d = mkdtempSync(join(tmpdir(), "poa-")); const w = (n: string, v: unknown) => { const p = join(d, n); writeFileSync(p, JSON.stringify(v)); return p; };
  try { return fn(d, w); } finally { rmSync(d, { recursive: true, force: true }); }
}

describe("production-office-assignments-release.py", () => {
  it("patch-code changes only the Handler Code and refuses if a release route is already there, an accepted route is missing, or the stack is not production", () => withFiles((d, w) => {
    const out = join(d, "out.json"); const r = run(["patch-code", w("live.json", live()), out, NEWKEY]); expect(r.status, r.stderr).toBe(0);
    const t = JSON.parse(readFileSync(out, "utf8")); expect(t.Resources.Handler886CB40B.Properties.Code).toEqual({ S3Bucket: ASSETS, S3Key: NEWKEY });
    expect(JSON.stringify({ ...t.Resources, Handler886CB40B: 0 })).toBe(JSON.stringify({ ...live().Resources, Handler886CB40B: 0 }));
    expect(run(["patch-code", w("a.json", live({ RX: route(NINE[8]!) })), out, NEWKEY]).stderr).toContain("must still be absent");
    expect(run(["patch-code", w("m.json", live({}, RETAINED.filter((k) => k !== "GET /v1/offices"))), out, NEWKEY]).stderr).toContain("accepted production route is missing");   // the Offices release is a prerequisite
    const notProd = live(); (notProd.Resources.Handler886CB40B as any).Properties.Environment.Variables.DB_NAME = "ogevia_sv_test";
    expect(run(["patch-code", w("b.json", notProd), out, NEWKEY]).stderr).toContain("not the production API stack");
    expect(run(["patch-code", w("c.json", live()), out, "../x.zip"]).stderr).toContain("unexpected asset key");
  }));
  it("patch-routes adds exactly the nine routes, as JWT routes copied from the reference route, and nothing else", () => withFiles((d, w) => {
    const out = join(d, "out.json"); const r = run(["patch-routes", w("live.json", live()), out]); expect(r.status, r.stderr).toBe(0);
    const t = JSON.parse(readFileSync(out, "utf8")); const keys = Object.values(t.Resources as Record<string, any>).filter((x) => x.Type === "AWS::ApiGatewayV2::Route").map((x) => x.Properties.RouteKey);
    for (const k of NINE) expect(keys).toContain(k);
    expect(keys.length).toBe(RETAINED.length + 9);
    for (const x of Object.values(t.Resources as Record<string, any>)) if (x.Type === "AWS::ApiGatewayV2::Route") expect(x.Properties.AuthorizationType).toBe("JWT");
    expect(Object.keys(t.Resources).filter((k) => IDS.includes(k)).length).toBe(9);
    expect(run(["routes", out, "present"]).status).toBe(0); expect(run(["routes", w("l.json", live()), "absent"]).status).toBe(0);
    expect(run(["routes", w("l2.json", live()), "present"]).status).not.toBe(0);
  }));
  it("patch-routes refuses a route that is already there, a missing reference route, and a route that must stay off", () => withFiles((d, w) => {
    const out = join(d, "out.json");
    expect(run(["patch-routes", w("a.json", live({ RX: route(NINE[2]!) })), out]).stderr).toContain("already has the route");
    expect(run(["patch-routes", w("b.json", live({ RX: route("GET /v1/staff/duplicates") })), out]).stderr).toContain("must stay off");
    expect(run(["patch-routes", w("c.json", live({}, RETAINED.filter((k) => k !== "GET /v1/attention"))), out]).stderr).toMatch(/reference route missing|accepted production route is missing/);
  }));
  it("changes-routes-add / -remove accept exactly the nine route changes and reject anything else", () => withFiles((_d, w) => {
    const cs = (action: string, list: string[], status = "CREATE_COMPLETE") => ({ Status: status, ExecutionStatus: "AVAILABLE", Changes: list.map((id) => ({ ResourceChange: { LogicalResourceId: id, ResourceType: "AWS::ApiGatewayV2::Route", Action: action, Replacement: "False" } })) });
    expect(run(["changes-routes-add", w("a.json", cs("Add", IDS))]).status).toBe(0);
    expect(run(["changes-routes-remove", w("b.json", cs("Remove", IDS))]).status).toBe(0);
    expect(run(["changes-routes-add", w("c.json", cs("Add", IDS.slice(1)))]).status).not.toBe(0);
    expect(run(["changes-routes-add", w("d.json", cs("Add", [...IDS, "X"]))]).status).not.toBe(0);
    expect(run(["changes-routes-add", w("e.json", cs("Add", IDS, "CREATE_PENDING"))]).status).not.toBe(0);
    expect(run(["changes-routes-add", w("f.json", cs("Modify", IDS))]).status).not.toBe(0);
    expect(run(["changes-routes-add", w("i.json", cs("Remove", IDS))]).status).not.toBe(0);
    expect(run(["changes-routes-remove", w("j.json", cs("Add", IDS))]).status).not.toBe(0);
  }));
  it("the nine routes and their ids match the current CDK source and a real production synthesis shape", () => {
    const src = readFileSync(join(root, "infra/aws/lib/service-verification-api-stack.ts"), "utf8");
    for (const k of NINE) { const [m, p] = k.split(" "); expect(src).toContain(`path: "${p}"`); expect(src).toContain(`HttpMethod.${m}`); }
    expect(src).toMatch(/\/v1\/assignment-history", feature: "assignmentHistory"/);
    expect((src.match(/feature: "officeAssignments"/g) ?? []).length).toBe(8);
  });
  it("the SQL guards the exact 109-row ledger and applies 0111 then 0112; the rollback SQL guards the 111 rows and removes both", () => {
    const up = run(["sql"]); expect(up.status, up.stderr).toBe(0);
    expect(up.stdout).toContain("Production ledger differs from the accepted 109 rows"); expect(up.stdout.indexOf("0111_office_assignments_counties_colors.sql")).toBeLessThan(up.stdout.indexOf("0112_assignment_history.sql"));
    expect((up.stdout.match(/^insert into ogevia_meta\.schema_migrations/gm) ?? []).length).toBe(2); expect((up.stdout.match(/^begin;/gm) ?? []).length).toBe(1); expect((up.stdout.match(/^commit;/gm) ?? []).length).toBe(1);
    const down = run(["rollback-sql"]); expect(down.status, down.stderr).toBe(0);
    expect(down.stdout).toContain("exactly the 111 rows"); expect(down.stdout.indexOf("drop function if exists ogevia_api.list_assignment_history")).toBeLessThan(down.stdout.indexOf("drop function if exists ogevia_api.list_people_facets"));   // 0112 comes out before 0111
    expect(down.stdout).toContain("delete from ogevia_meta.schema_migrations where version = '0112'"); expect(down.stdout).toContain("delete from ogevia_meta.schema_migrations where version = '0111'");
  });
  it("hash and deployed compare a Handler zip's index.js", () => withFiles((d) => {
    const z = join(d, "h.zip"); expect(spawnSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('index.js','code'); z.close()", z]).status).toBe(0);
    const h = run(["hash", z]).stdout.trim(); expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(run(["deployed", z, h]).status).toBe(0); expect(run(["deployed", z, "0".repeat(64)]).status).not.toBe(0);
  }));
});
