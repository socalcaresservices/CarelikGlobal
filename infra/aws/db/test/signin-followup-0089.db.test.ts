// 0089 (PENDING, infra/aws/db/pending): app sign-in is a follow-up, not a hard requirement for approval or scheduling (owner instruction 2026-11-09).
// Applies the pending migration on top of the released set (0001-0088) exactly as the runner would (as ogevia_owner), then proves, through the real functions:
//   * an approved caregiver who has never signed in (no email, not invited) can be assigned to a client and scheduled on an exact shift;
//   * sign-in stays visible as an outstanding follow-up until the first sign-in, and an invitation alone does not clear it;
//   * background check and required training are still hard requirements, with no override;
//   * the rollback script restores the 0088 rule.
// SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const UP = new URL("../pending/migrations/0089_signin_followup_not_hard_requirement.sql", import.meta.url);
const DOWN = new URL("../pending/rollback/0089_signin_followup_not_hard_requirement.down.sql", import.meta.url);

let db: TestDb;
let w: World;
let today: string;
let fx: { client: string; service: string; auth: string };

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
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const create = async (last: string) =>
  (await call(w.managerA, "select * from ogevia_api.create_caregiver($1,'Synthetic',$2,null,'onboarding',null)", [w.orgA, `${last} ${randomUUID().slice(0, 4)}`]))[0].caregiver_record_id as string;
const readiness = (rec: string) => call(w.managerA, "select ogevia_api.get_caregiver_readiness($1,$2) as r", [w.orgA, rec]).then((r) => r[0].r);
const approve = (rec: string) => call(w.managerA, "select ogevia_api.approve_caregiver_for_work($1,$2,$3) as r", [w.orgA, rec, randomUUID()]).then((r) => r[0].r);
const item = (r: any, key: string) => r.items.find((i: any) => i.requirement === key);
const verifyBackground = (rec: string) => call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Synthetic clearance on file',null)", [w.orgA, rec]);
const training = (rec: string) => call(w.managerA, "select ogevia_api.record_onboarding_item($1,$2,'training','complete',$3::date,null,null,null)", [w.orgA, rec, today]);
const clearShifts = () => db.admin.query("delete from ogevia.authorization_reservations where shift_id is not null; delete from ogevia.shift_coverage_events; delete from ogevia.shifts");

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 700);
  today = await orgToday(db);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  await run(UP);
});
afterAll(async () => db?.drop());

describe("0089: app sign-in does not block approval, assignment or scheduling", () => {
  it("an approved caregiver with no sign-in is assigned to a client and scheduled on an exact shift; sign-in stays outstanding", async () => {
    const rec = await create("NoSignIn");
    await verifyBackground(rec);
    await training(rec);
    const before = await readiness(rec);
    expect(item(before, "signin")).toMatchObject({ kind: "followup", state: "unmet", detail: "No email on file", nextAction: "add_contact" });
    expect(before).toMatchObject({ canApprove: true, waitingOn: [] });
    expect(await approve(rec)).toMatchObject({ approved: true, status: "approved", alreadyApproved: false });

    expect(await call(w.ownerA, "select * from ogevia_api.create_assignment($1,$2,$3,$4,$5::date,null,null)", [w.orgA, rec, fx.client, fx.service, today])).toHaveLength(1);
    const shift = await call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'10:00'::time,$5,$6)", [w.orgA, fx.client, fx.service, await add(2), rec, randomUUID()]);
    expect(shift).toHaveLength(1);
    expect((await db.admin.query("select caregiver_record_id, caregiver_user_id from ogevia.shifts where caregiver_record_id = $1", [rec])).rows)
      .toEqual([{ caregiver_record_id: rec, caregiver_user_id: null }]);
    expect(item(await readiness(rec), "signin")).toMatchObject({ kind: "followup", state: "unmet" });
    await clearShifts();

    // an invitation alone is not a sign-in; the first sign-in clears the follow-up
    const sub = randomUUID();
    const email = `synthetic.${randomUUID().slice(0, 8)}@example.test`;
    await call(w.managerA, "select ogevia_api.begin_caregiver_invitation($1,$2,$3)", [w.orgA, rec, email]);
    await call(w.managerA, "select * from ogevia_api.complete_caregiver_invitation($1,$2,$3,$4,false)", [w.orgA, rec, email, sub]);
    expect(item(await readiness(rec), "signin")).toMatchObject({ state: "unmet", detail: "Invited, has not signed in yet", nextAction: "resend_link" });
    await asActor(db, sub, (c) => c.query("select ogevia_api.note_my_sign_in()"));
    expect(item(await readiness(rec), "signin")).toMatchObject({ state: "met" });
  });

  it("the background check and the required training are still hard requirements, with no override, even for an administrator", async () => {
    const rec = await create("StillHard");
    await expectPgError(approve(rec), "OGC09", /Cannot approve yet\. Waiting on: Background check, Required training$/);
    await expectPgError(call(w.ownerA, "select ogevia_api.approve_caregiver_for_work($1,$2,$3)", [w.orgA, rec, randomUUID()]), "OGC09", /Waiting on: Background check, Required training$/);
    await verifyBackground(rec);
    await expectPgError(approve(rec), "OGC09", /Waiting on: Required training$/);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_work_approvals where caregiver_record_id = $1", [rec])).rows[0].n).toBe(0);
  });

  it("rollback restores the 0088 rule (sign-in is hard again) and changes no row", async () => {
    const rec = await create("Rollback");
    await verifyBackground(rec);
    await training(rec);
    expect(item(await readiness(rec), "signin").kind).toBe("followup");
    await run(DOWN);
    expect(item(await readiness(rec), "signin").kind).toBe("hard");
    await expectPgError(approve(rec), "OGC09", /Waiting on: App sign-in$/);
    await run(UP); // re-apply is safe
    expect(item(await readiness(rec), "signin").kind).toBe("followup");
  });
});
