// Production sign-in relink (deploy/15 inspect, deploy/16 relink) against a real PostgreSQL migrated from zero, SYNTHETIC data only.
// Proves: the existing person record is kept (no duplicate person or agency), memberships and permissions stay enforced, the old sign-in
// stops working, a duplicate is refused, the procedure is idempotent and reversible, and no output shows a sign-in id.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_URL, asActor, createTestDb, expectPgError, seedWorld, type TestDb, type World } from "./harness.js";

const DEPLOY = fileURLToPath(new URL("../deploy/", import.meta.url));
const REF = "owner-go-auth-20261021";
let db: TestDb;
let w: World;

const urlOf = (database: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${database}`; return u.toString(); };
function psql(file: string, vars: Record<string, string>) {
  const args = [urlOf(db.name), "-X", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-v", `expected_db=${db.name}`];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  const r = spawnSync("psql", [...args, "-f", join(DEPLOY, file)], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const relink = (oldSub: string, newSub: string, extra: Record<string, string> = {}) => psql("16_prd_relink_sign_in.sql", { old_sub: oldSub, new_sub: newSub, approval_ref: REF, ...extra });
const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows as T[];
const counts = async () => (await q(`select
  (select count(*) from ogevia.organizations) orgs, (select count(*) from ogevia.app_users) people, (select count(*) from ogevia.organization_memberships) memberships,
  (select count(*) from ogevia.caregiver_records) caregivers, (select count(*) from ogevia.clients) clients, (select count(*) from ogevia.caregiver_assignments) assignments,
  (select count(*) from ogevia.service_visits) visits, (select count(*) from ogevia.audit_events) audits`))[0];
const subOf = async (userId: string) => (await q("select cognito_sub from ogevia.app_users where id = $1", [userId]))[0].cognito_sub as string;
const context = (sub: string) => asActor(db, sub, async (c) => (await c.query("select organization_id, role, permissions from ogevia_api.get_my_context() order by organization_id")).rows);
const fresh = () => randomUUID();

beforeAll(async () => { db = await createTestDb(); w = await seedWorld(db, 600); });
afterAll(async () => db?.drop());

describe("inspect (read only)", () => {
  it("lists every person with their access and writes nothing, and shows no sign-in id", async () => {
    const before = JSON.stringify(await counts());
    const r = psql("15_prd_inspect_sign_ins.sql", {});
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("organization_owner");
    expect(r.out).toContain("caregiver");
    expect(r.out).toContain("--- checks that protect against duplicates");
    for (const a of [w.ownerA, w.managerA, w.caregiverA1, w.outsider]) expect(r.out, "no sign-in id in the output").not.toContain(a.sub);
    expect(r.out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*[0-9a-f]{64}/);
    expect(JSON.stringify(await counts())).toBe(before);
  });

  it("refuses to run against any other database", () => {
    const r = spawnSync("psql", [urlOf(db.name), "-X", "-At", "-v", "ON_ERROR_STOP=1", "-f", join(DEPLOY, "15_prd_inspect_sign_ins.sql")], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("only against the production database");
  });
});

describe("relink one person to the production pool", () => {
  const NEW = fresh();
  let oldSub: string, personId: string, ctxBefore: unknown, ownerMembership: unknown, auditBefore: number;

  it("moves only the sign-in id: the same person, agency, role, memberships and history, with no new person or agency", async () => {
    personId = w.ownerA.userId; oldSub = await subOf(personId);
    ctxBefore = await context(oldSub);
    ownerMembership = await q("select organization_id, role, status from ogevia.organization_memberships where user_id = $1 order by organization_id", [personId]);
    const before = await counts(); auditBefore = Number(before!.audits);
    const r = relink(oldSub, NEW);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("RELINKED");
    expect(r.out).not.toContain(oldSub); expect(r.out).not.toContain(NEW);
    const after = await counts();
    expect({ ...after, audits: 0 }).toEqual({ ...before, audits: 0 });          // no person, agency, membership, record or visit added or removed
    expect(Number(after!.audits)).toBe(auditBefore + 1);                         // one audit event for the one agency
    expect(await subOf(personId)).toBe(NEW);                                     // same person id, new sign-in
    expect(await q("select organization_id, role, status from ogevia.organization_memberships where user_id = $1 order by organization_id", [personId])).toEqual(ownerMembership);
  });

  it("the audit event names the move, the approval and the agency", async () => {
    const [a] = await q("select * from ogevia.audit_events where action = 'account.sign_in_relinked' and entity_id = $1", [personId]);
    expect(a.organization_id).toBe(w.orgA);
    expect(a.entity_type).toBe("app_users");
    expect(a.before_state).toEqual({ sign_in: oldSub });
    expect(a.after_state).toMatchObject({ sign_in: NEW, approval: REF });
  });

  it("the production administrator can sign in as the same person: same agency, role and permissions", async () => {
    expect(await context(NEW)).toEqual(ctxBefore);
    // begin_request resolves the sign-in to the person it belongs to (the application role cannot read the internal helper).
    const [row] = await asActor(db, NEW, async (c) => (await c.query("select ogevia_api.begin_request($1) as id", [NEW])).rows);
    expect(row.id).toBe(personId);
  });

  it("the old sign-in no longer authenticates", async () => {
    await expectPgError(asActor(db, oldSub, async (c) => c.query("select 1")), "OGA01");
  });

  it("agency membership and permissions stay enforced for the relinked person and everyone else", async () => {
    // The relinked owner still administers their own agency...
    const accounts = await asActor(db, NEW, async (c) => (await c.query("select * from ogevia_api.list_accounts($1)", [w.orgA])).rows);
    expect(accounts.length).toBeGreaterThan(0);
    // ...is still locked out of another agency...
    await expectPgError(asActor(db, NEW, async (c) => c.query("select * from ogevia_api.list_accounts($1)", [w.orgB])), "OGN04");
    // ...and a manager, who was not relinked, still lacks the owner-only permission.
    await expectPgError(asActor(db, w.managerA.sub, async (c) => c.query("select * from ogevia_api.list_accounts($1)", [w.orgA])), "OGA03");
    // A person of the other agency is unaffected and cannot see this agency.
    await expectPgError(asActor(db, w.managerB.sub, async (c) => c.query("select * from ogevia_api.list_accounts($1)", [w.orgA])), "OGN04");
  });

  it("is idempotent: running it again changes nothing and says so", async () => {
    const before = JSON.stringify(await counts());
    const r = relink(oldSub, NEW);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("ALREADY RELINKED");
    expect(JSON.stringify(await counts())).toBe(before);
  });

  it("is reversible: the same procedure with the two ids swapped restores the original sign-in on the same person", async () => {
    const r = relink(NEW, oldSub);
    expect(r.code, r.out).toBe(0);
    expect(await subOf(personId)).toBe(oldSub);
    expect(await context(oldSub)).toEqual(ctxBefore);
    await expectPgError(asActor(db, NEW, async (c) => c.query("select 1")), "OGA01");
    const events = await q("select before_state, after_state from ogevia.audit_events where action = 'account.sign_in_relinked' and entity_id = $1 order by occurred_at", [personId]);
    expect(events).toHaveLength(2);
    // put it back for the remaining tests
    expect(relink(oldSub, NEW).code).toBe(0);
  });
});

describe("refusals (nothing is changed)", () => {
  const snapshot = async () => JSON.stringify({ c: await counts(), s: await q("select id, cognito_sub from ogevia.app_users order by id") });

  it("refuses a new sign-in that already belongs to another person record (a duplicate person would result)", async () => {
    const dup = fresh();
    const [stray] = await q("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Stray duplicate') returning id", [dup]);
    await q("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1, $2, 'organization_owner', 'active')", [w.orgA, stray.id]);
    const before = await snapshot();
    const r = relink(w.managerA.sub, dup);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("ALREADY linked to a different person record");
    expect(await snapshot()).toBe(before);
  });

  it("refuses a new sign-in held by a stray person record with no membership", async () => {
    const dup = fresh();
    await q("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Orphan')", [dup]);
    const before = await snapshot();
    const r = relink(w.managerA.sub, dup);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("ALREADY linked");
    expect(await snapshot()).toBe(before);
  });

  it("refuses when no person holds the old sign-in", async () => {
    const before = await snapshot();
    const r = relink(fresh(), fresh());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("No person record uses the old sign-in");
    expect(await snapshot()).toBe(before);
  });

  it("refuses a disabled person and a person with no membership", async () => {
    const [disabled] = await q("insert into ogevia.app_users (cognito_sub, display_name, status) values ($1, 'Disabled', 'disabled') returning cognito_sub", [fresh()]);
    const rd = relink(disabled.cognito_sub, fresh());
    expect(rd.code).not.toBe(0); expect(rd.out).toContain("not active");
    const [alone] = await q("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'No membership') returning cognito_sub", [fresh()]);
    const rn = relink(alone.cognito_sub, fresh());
    expect(rn.code).not.toBe(0); expect(rn.out).toContain("no agency membership");
  });

  it.each([
    ["malformed old sign-in", { old: "nope", next: fresh() }, "lower-case UUIDs"],
    ["malformed new sign-in", { old: fresh(), next: "UPPER-CASE-NOT-ALLOWED" }, "lower-case UUIDs"],
    ["old equals new", { old: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", next: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, "are the same"],
  ])("refuses %s", (_l, v, text) => {
    const r = relink(v.old, v.next);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(text);
  });

  it("refuses a malformed approval reference and a missing variable", () => {
    const bad = relink(w.managerA.sub, fresh(), { approval_ref: "x" });
    expect(bad.code).not.toBe(0); expect(bad.out).toContain("approval reference is malformed");
    const r = spawnSync("psql", [urlOf(db.name), "-X", "-At", "-v", "ON_ERROR_STOP=1", "-v", `expected_db=${db.name}`, "-v", "old_sub=x", "-f", join(DEPLOY, "16_prd_relink_sign_in.sql")], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("set old_sub, new_sub and approval_ref");
  });

  it("refuses to run against any database other than the expected production database", () => {
    const r = spawnSync("psql", [urlOf(db.name), "-X", "-At", "-v", "ON_ERROR_STOP=1", "-v", "old_sub=a", "-v", "new_sub=b", "-v", "approval_ref=owner-go-x1234", "-f", join(DEPLOY, "16_prd_relink_sign_in.sql")], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("only against the production database");
  });
});

describe("a person in two agencies keeps both memberships and gets one audit event per agency", () => {
  it("relinks once and preserves both memberships", async () => {
    const [p] = await q("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Works in two agencies') returning id, cognito_sub", [fresh()]);
    await q("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1, $3, 'manager', 'active'), ($2, $3, 'scheduler', 'active')", [w.orgA, w.orgB, p.id]);
    const auditBefore = Number((await counts())!.audits);
    const next = fresh();
    const r = relink(p.cognito_sub, next);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("2 agency membership(s) unchanged");
    expect(Number((await counts())!.audits)).toBe(auditBefore + 2);
    expect((await context(next)).map((x: any) => x.role).sort()).toEqual(["manager", "scheduler"]);
  });
});
