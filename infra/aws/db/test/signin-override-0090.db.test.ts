// 0090 (PENDING, infra/aws/db/pending): the administrator override for a caregiver who has not signed in yet (owner decision 2026-11-10).
// Applies the pending migration on top of the released set (0001-0088) as the runner would (as ogevia_owner), then proves through the real functions:
//   * an administrator can record the override; a reason is required; approver, time and an audit event are written; approving for work then succeeds;
//   * the BACKGROUND CHECK is still a hard block (no override is recorded without a clear check), and so is every other hard requirement;
//   * a manager, a scheduler and another agency's administrator cannot use it; a caregiver who has signed in needs none;
//   * it is idempotent and concurrency-safe (one record, one audit event), append-only, and its badge list shows the caregiver only until the first sign-in;
//   * the rollback restores the 0088 rule and drops the table; re-applying is safe.
// SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const UP = new URL("../pending/migrations/0103_caregiver_signin_override.sql", import.meta.url);
const DOWN = new URL("../pending/rollback/0103_caregiver_signin_override.down.sql", import.meta.url);

let db: TestDb;
let w: World;

const run = async (url: URL) => {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role ogevia_owner");
    await c.query(readFileSync(url, "utf8"));
    await c.query("reset role");
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const create = async (last: string) =>
  (await call(w.managerA, "select * from ogevia_api.create_caregiver($1,'Synthetic',$2,null,'onboarding',null)", [w.orgA, `${last} ${randomUUID().slice(0, 4)}`]))[0].caregiver_record_id as string;
const readiness = (rec: string) => call(w.managerA, "select ogevia_api.get_caregiver_readiness($1,$2) as r", [w.orgA, rec]).then((r) => r[0].r);
const approve = (rec: string) => call(w.managerA, "select ogevia_api.approve_caregiver_for_work($1,$2,$3) as r", [w.orgA, rec, randomUUID()]).then((r) => r[0].r);
const item = (r: any, key: string) => r.items.find((i: any) => i.requirement === key);
const verifyBackground = (rec: string) => call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Synthetic clearance on file',null)", [w.orgA, rec]);
const training = async (rec: string) => call(w.managerA, "select ogevia_api.record_onboarding_item($1,$2,'training','complete',(now() at time zone 'America/Los_Angeles')::date,null,null,null)", [w.orgA, rec]);
const override = (a: Actor, rec: string, reason: string, org = w.orgA) => call(a, "select ogevia_api.approve_signin_override($1,$2,$3) as r", [org, rec, reason]).then((r) => r[0].r);
const audits = async (rec: string) => (await db.admin.query("select reason from ogevia.audit_events where action = 'caregiver.signin_override' and entity_id = $1", [rec])).rows;
const overrideRows = async (rec: string) => (await db.admin.query("select count(*)::int n from ogevia.caregiver_signin_overrides where caregiver_record_id = $1", [rec])).rows[0].n as number;
/** A ready-but-for-sign-in caregiver: background clear, training done, no sign-in. */
const ready = async (last: string) => { const rec = await create(last); await verifyBackground(rec); await training(rec); return rec; };

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 800);
  await run(UP);
});
afterAll(async () => db?.drop());

describe("0090: administrator override for a caregiver who has not signed in", () => {
  it("without the override, sign-in still blocks approval (the 0088 rule)", async () => {
    const rec = await ready("Blocked");
    await expectPgError(approve(rec), "OGC09", /Waiting on: App sign-in$/);
  });

  it("an administrator records it with a reason; approver, time and the audit event are written; then approval succeeds and the readiness row says so", async () => {
    const rec = await ready("Override");
    const out = await override(w.ownerA, rec, "Starts Monday; app invitation sent (synthetic)");
    expect(out).toMatchObject({ overrideRecorded: true });
    expect(item(out, "signin")).toMatchObject({ state: "met", kind: "hard", detail: "Approved by override: not signed in", extra: { override: true } });
    const row = (await db.admin.query("select reason, approved_by, approved_at from ogevia.caregiver_signin_overrides where caregiver_record_id = $1", [rec])).rows[0];
    expect(row.reason).toBe("Starts Monday; app invitation sent (synthetic)");
    expect(row.approved_by).not.toBeNull();
    expect(row.approved_at).toBeInstanceOf(Date);
    expect(await audits(rec)).toEqual([{ reason: "Starts Monday; app invitation sent (synthetic)" }]);
    expect(await approve(rec)).toMatchObject({ approved: true, alreadyApproved: false });
    // the override is not repeated in the readiness read (no reason leaks to roles that only read readiness)
    expect(JSON.stringify(await readiness(rec))).not.toContain("Starts Monday");
  });

  it("a reason is required: empty, blank or too short is refused and nothing is recorded", async () => {
    const rec = await ready("NoReason");
    for (const reason of ["", "   ", "ok", "a  b"]) await expectPgError(override(w.ownerA, rec, reason), "OGV22", /Write why/);
    await expectPgError(override(w.ownerA, rec, "x".repeat(501)), "OGV22", /too long/);
    expect(await overrideRows(rec)).toBe(0);
    expect(await audits(rec)).toEqual([]);
  });

  it("the background check is a hard block: no override is recorded and approval still waits on it", async () => {
    const rec = await create("NoBackground");
    await training(rec);
    await expectPgError(override(w.ownerA, rec, "Needs to start now (synthetic)"), "OGC09", /There is no override for it/);
    expect(await overrideRows(rec)).toBe(0);
    await expectPgError(approve(rec), "OGC09", /Waiting on: Background check, App sign-in$/);
  });

  it("every other hard requirement stays: with the override but without the required training, approval still waits on training", async () => {
    const rec = await create("NoTraining");
    await verifyBackground(rec);
    expect(await override(w.ownerA, rec, "Background is clear; training next (synthetic)")).toMatchObject({ overrideRecorded: true });
    await expectPgError(approve(rec), "OGC09", /Waiting on: Required training$/);
  });

  it("a manager, a scheduler, a caregiver and another agency's administrator cannot use it; nothing is written", async () => {
    const rec = await ready("Roles");
    for (const who of [w.managerA, w.schedulerA, w.caregiverA1]) await expectPgError(override(who, rec, "Trying without the right (synthetic)"), "OGA03", /Only an administrator|Organization not found/);
    await expectPgError(override(w.managerB, rec, "Other agency (synthetic)", w.orgB), "OGA03", /Only an administrator/);
    await expectPgError(override(w.ownerA, rec, "Wrong agency (synthetic)", w.orgB), "OGN04", /Organization not found/);
    expect(await overrideRows(rec)).toBe(0);
  });

  it("another agency's caregiver id is not found for this agency's administrator (cross-tenant)", async () => {
    const other = (await call(w.managerB, "select * from ogevia_api.create_caregiver($1,'Synthetic','Other Agency',null,'onboarding',null)", [w.orgB]))[0].caregiver_record_id as string;
    await expectPgError(override(w.ownerA, other, "Cross tenant (synthetic)"), "OGN04", /Caregiver not found/);
    expect(await overrideRows(other)).toBe(0);
  });

  it("a caregiver who has already signed in needs no override", async () => {
    const rec = await ready("SignedIn");
    const sub = randomUUID();
    const email = `synthetic.${randomUUID().slice(0, 8)}@example.test`;
    await call(w.managerA, "select ogevia_api.begin_caregiver_invitation($1,$2,$3)", [w.orgA, rec, email]);
    await call(w.managerA, "select * from ogevia_api.complete_caregiver_invitation($1,$2,$3,$4,false)", [w.orgA, rec, email, sub]);
    await asActor(db, sub, (c) => c.query("select ogevia_api.note_my_sign_in()"));
    await expectPgError(override(w.ownerA, rec, "Not needed (synthetic)"), "OGC09", /already signed in/);
  });

  it("is idempotent: a second call and two at once leave ONE record and ONE audit event", async () => {
    const rec = await ready("Twice");
    expect(await override(w.ownerA, rec, "First (synthetic)")).toMatchObject({ overrideRecorded: true });
    expect(await override(w.ownerA, rec, "Second reason ignored (synthetic)")).toMatchObject({ overrideRecorded: false });
    const rec2 = await ready("Parallel");
    const both = await Promise.allSettled([override(w.ownerA, rec2, "Admin one (synthetic)"), override(w.ownerA, rec2, "Admin two (synthetic)")]);
    expect(both.every((x) => x.status === "fulfilled")).toBe(true);
    expect(await overrideRows(rec)).toBe(1);
    expect(await overrideRows(rec2)).toBe(1);
    expect(await audits(rec)).toHaveLength(1);
    expect(await audits(rec2)).toHaveLength(1);
    expect((await audits(rec))[0].reason).toBe("First (synthetic)");
  });

  it("the record is append-only: update and delete are refused", async () => {
    const rec = await ready("AppendOnly");
    await override(w.ownerA, rec, "Keep this (synthetic)");
    await expect(db.admin.query("update ogevia.caregiver_signin_overrides set reason = 'changed to something else' where caregiver_record_id = $1", [rec])).rejects.toThrow(/append-only/);
    await expect(db.admin.query("delete from ogevia.caregiver_signin_overrides where caregiver_record_id = $1", [rec])).rejects.toThrow(/append-only/);
  });

  it("the badge list shows the caregiver until the first sign-in, hides the reason from a scheduler, and never lists another agency's caregiver", async () => {
    const rec = await ready("Badge");
    await override(w.ownerA, rec, "Badge reason (synthetic)");
    const asManager = await call(w.managerA, "select * from ogevia_api.list_signin_overrides($1)", [w.orgA]);
    expect(asManager.find((r: any) => r.caregiver_record_id === rec)).toMatchObject({ reason: "Badge reason (synthetic)" });
    expect(asManager.find((r: any) => r.caregiver_record_id === rec).approved_by_name).toBeTruthy();
    const asScheduler = await call(w.schedulerA, "select * from ogevia_api.list_signin_overrides($1)", [w.orgA]);
    expect(asScheduler.find((r: any) => r.caregiver_record_id === rec)).toMatchObject({ reason: null, approved_by_name: null });
    await expectPgError(call(w.managerB, "select * from ogevia_api.list_signin_overrides($1)", [w.orgA]), "OGN04", /Organization not found/);
    expect((await call(w.managerB, "select * from ogevia_api.list_signin_overrides($1)", [w.orgB])).some((r: any) => r.caregiver_record_id === rec)).toBe(false);
    await expectPgError(call(w.caregiverA1, "select * from ogevia_api.list_signin_overrides($1)", [w.orgA]), "OGA03", /permission/);
    // the first sign-in removes the badge, and the ordinary readiness row takes over
    const sub = randomUUID();
    const email = `synthetic.${randomUUID().slice(0, 8)}@example.test`;
    await call(w.managerA, "select ogevia_api.begin_caregiver_invitation($1,$2,$3)", [w.orgA, rec, email]);
    await call(w.managerA, "select * from ogevia_api.complete_caregiver_invitation($1,$2,$3,$4,false)", [w.orgA, rec, email, sub]);
    expect((await call(w.managerA, "select * from ogevia_api.list_signin_overrides($1)", [w.orgA])).some((r: any) => r.caregiver_record_id === rec)).toBe(true);   // invited is not signed in
    await asActor(db, sub, (c) => c.query("select ogevia_api.note_my_sign_in()"));
    expect((await call(w.managerA, "select * from ogevia_api.list_signin_overrides($1)", [w.orgA])).some((r: any) => r.caregiver_record_id === rec)).toBe(false);
    expect(item(await readiness(rec), "signin")).toMatchObject({ state: "met", detail: expect.not.stringContaining("override") });
    expect(await overrideRows(rec)).toBe(1);   // the record stays as history
  });

  it("rollback restores the 0088 rule and drops the table; re-applying is safe", async () => {
    const rec = await ready("Rollback");
    await override(w.ownerA, rec, "Before rollback (synthetic)");
    await run(DOWN);
    expect(item(await readiness(rec), "signin")).toMatchObject({ state: "unmet" });
    await expect(db.admin.query("select 1 from ogevia.caregiver_signin_overrides")).rejects.toThrow(/does not exist/);
    await run(UP);
    expect(item(await readiness(rec), "signin")).toMatchObject({ state: "unmet" });   // the dropped rows are gone, as the rollback header says
  });
});
