// invitation_checks_v4.py (docs/releases/2026-10-28-staff-invitation-fix/scripts): the READ-ONLY V4/V5 checker for migration 0087 (M-1, L-1, L-3), run against a FAKE API handler
// (the script's own --local-invoker mode). It must pass for the world the fix creates and fail, naming the check, for each way that world can be wrong. No AWS, no network, synthetic.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(REPO, "docs/releases/2026-10-28-staff-invitation-fix/scripts/invitation_checks_v4.py");
const OWNER = "owner-sub", INVITEE = "invitee-sub", ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a", ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";

const FAKE = `
import json, os, sys
ev = json.loads(sys.stdin.read())
st = json.load(open(os.environ["FAKE_STATE"]))
sub = ev["requestContext"]["authorizer"]["jwt"]["claims"]["sub"]
route = ev["routeKey"]
q = ev.get("queryStringParameters") or {}
def out(code, body): print(json.dumps({"statusCode": code, "body": json.dumps(body)}))
if route == "GET /v1/me":
    out(200, st["me"][sub]); sys.exit(0)
who = st["me"][sub]["memberships"]
org = q.get("organizationId")
mem = [m for m in who if m["organizationId"] == org]
if route in st.get("staff_routes_for_owner_only", []) or True:
    if not mem: out(st.get("stranger_status", 404), {"error": {"code": "not_found"}}); sys.exit(0)
    if mem[0]["role"] != "organization_owner": out(403, {"error": {"code": "forbidden"}}); sys.exit(0)
    if route == "GET /v1/staff": out(200, {"staff": st.get("staff_rows", [])}); sys.exit(0)
    out(200, {"staffTypes": [{"id": "x"}], "permissions": [{"k": 1}], "events": [{"e": 1}], "staff": st.get("staff_rows", [])})
`;
const mem = (slug: string, role: string, org: string) => ({ organizationSlug: slug, role, organizationId: org, organizationName: slug, permissions: [] });
const worldBefore = () => ({
  me: {
    [OWNER]: { memberships: [mem("agency-a", "organization_owner", ORG_A)], pendingInvitations: [], profile: { displayName: null } },
    [INVITEE]: { memberships: [mem("agency-b", "manager", ORG_B)], pendingInvitations: [{ organizationId: ORG_A, organizationName: "Agency A", role: "read_only" }], profile: { displayName: null } },
  },
  staff_rows: [{ staffKey: "p:1", accessStatus: "invitation_pending" }],
});
function run(phase: string, state: any, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "inv4-"));
  writeFileSync(join(dir, "fake.py"), FAKE); writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  const r = spawnSync("python3", ["-I", "-B", SCRIPT, "--client-id", "test-client", "--owner-sub", OWNER, "--invitee-sub", INVITEE, "--phase", phase, "--local-invoker", `python3 -I -B ${join(dir, "fake.py")}`, ...extra], { encoding: "utf8", env: { ...process.env, FAKE_STATE: join(dir, "state.json") } });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe("phase before: the invitation exists and nothing has been granted (M-1, L-1)", () => {
  it("passes for the world the fix creates", () => { const r = run("before", worldBefore()); expect(r.code, r.out).toBe(0); expect(r.out).toContain("INVITATION CHECKS PASSED"); });
  it("fails when the invitee already holds a membership in the Owner's agency (the pre-0087 behaviour)", () => {
    const w = worldBefore(); w.me[INVITEE]!.memberships.push(mem("agency-a", "read_only", ORG_A)); w.me[INVITEE]!.pendingInvitations = [];
    const r = run("before", w); expect(r.code, r.out).toBe(1); expect(r.out).toContain("NO membership in the Owner's agency"); expect(r.out).toContain("INVITATION CHECKS FAILED");
  });
  it("fails when the invitation is not listed, or lists another role", () => {
    let w = worldBefore(); w.me[INVITEE]!.pendingInvitations = [];
    let r = run("before", w); expect(r.code, r.out).toBe(1); expect(r.out).toContain("pending invitation with role read_only");
    w = worldBefore(); w.me[INVITEE]!.pendingInvitations[0]!.role = "manager";
    r = run("before", w); expect(r.code, r.out).toBe(1);
  });
  it("fails when the invitation leaks the e-mail or a person name (L-1)", () => {
    const w: any = worldBefore(); w.me[INVITEE]!.pendingInvitations[0].email = "x@example.test";
    const r = run("before", w); expect(r.code, r.out).toBe(1); expect(r.out).toContain("only agency id, agency name and role");
  });
  it("fails when the 0087 API is not deployed (no pendingInvitations field)", () => {
    const w: any = worldBefore(); delete w.me[INVITEE]!.pendingInvitations;
    const r = run("before", w); expect(r.code, r.out).toBe(1); expect(r.out).toContain("the 0087 API is deployed");
  });
  it("fails when the invitee is a new account with no agency of their own (not the M-1 situation)", () => {
    const w = worldBefore(); w.me[INVITEE]!.memberships = [];
    const r = run("before", w); expect(r.code, r.out).toBe(1); expect(r.out).toContain("DIFFERENT agency");
  });
  it("fails when the Owner's staff list shows nobody as Invited", () => {
    const w = worldBefore(); w.staff_rows = [];
    const r = run("before", w); expect(r.code, r.out).toBe(1); expect(r.out).toContain("shows at least one person as Invited");
  });
  it("fails when the named Owner is not an Owner", () => {
    const w = worldBefore(); w.me[OWNER]!.memberships[0]!.role = "manager";
    const r = run("before", w); expect(r.code, r.out).toBe(1);
  });
});

describe("phase after: the invitee accepted in the browser", () => {
  const after = () => { const w = worldBefore(); w.me[INVITEE]!.memberships.push(mem("agency-a", "read_only", ORG_A)); w.me[INVITEE]!.pendingInvitations = []; return w; };
  it("passes: they hold the role, nothing is pending, their own agency is unchanged, and they are refused on the staff routes as a member without the permission", () => {
    const r = run("after", after()); expect(r.code, r.out).toBe(0); expect(r.out).toContain("INVITATION CHECKS PASSED");
  });
  it("fails when the invitation is still pending, or the role differs", () => {
    let w = after(); w.me[INVITEE]!.pendingInvitations = [{ organizationId: ORG_A, organizationName: "Agency A", role: "read_only" }];
    let r = run("after", w); expect(r.code, r.out).toBe(1); expect(r.out).toContain("no longer pending");
    w = after(); w.me[INVITEE]!.memberships[1]!.role = "manager";
    r = run("after", w); expect(r.code, r.out).toBe(1);
  });
});

describe("phase inactive: the Owner set the profile inactive (L-3)", () => {
  it("passes when the membership is gone and the staff routes refuse the stranger", () => {
    const r = run("inactive", worldBefore()); expect(r.code, r.out).toBe(0);
  });
  it("fails when the membership is still there", () => {
    const w = worldBefore(); w.me[INVITEE]!.memberships.push(mem("agency-a", "read_only", ORG_A));
    const r = run("inactive", w); expect(r.code, r.out).toBe(1); expect(r.out).toContain("NO membership in the Owner's agency");
  });
});

describe("the script only ever reads", () => {
  it("never calls a POST route and prints no e-mail address or token", () => {
    const text = spawnSync("grep", ["-c", "POST", SCRIPT], { encoding: "utf8" }).stdout.trim();
    expect(Number(text)).toBeLessThanOrEqual(3);   // only the explanatory text
    expect(spawnSync("grep", ["-n", "inv.call(\"POST", SCRIPT], { encoding: "utf8" }).stdout.trim()).toBe("");
    expect(spawnSync("grep", ["-Ein", "password|secret|@gmail|access_token", SCRIPT], { encoding: "utf8" }).stdout.trim()).toBe("");
  });
});
