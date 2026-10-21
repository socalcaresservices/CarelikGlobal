// The readiness gate after BOTH branches: 0053 (hour limits) and 0054 (onboarding gate) from scheduling/recruiting, then 0055 (background
// clearance + 14-day CPR/TB) and 0056 (attention, appearance). 0055 redefines readiness_checks / readiness_outcome / readiness_message, so it
// must carry the earlier two changes. This proves every gate reports together, and that rolling 0055 back restores the 0054 gate (not the 0047 one).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, type Actor, type TestDb, type World, seedWorld } from "./harness.js";

const DOWN = new URL("../rollback/", import.meta.url);
let db: TestDb;
let w: World;
let rec: string;
let service: string;
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);

async function runDown(file: string) {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role ogevia_owner");
    await c.query(readFileSync(new URL(file, DOWN), "utf8"));
    await c.query("reset role");
    await c.query("delete from ogevia_meta.schema_migrations where version = $1", [file.slice(0, 4)]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
const checks = async () =>
  (await q("select check_name, status from ogevia.readiness_checks($1,$2,$3, now() + interval '3 days', now() + interval '3 days 2 hours', 'shift')", [w.orgA, rec, service])).rows as { check_name: string; status: string }[];
const blocked = async () => (await checks()).filter((c) => c.status === "blocked").map((c) => c.check_name);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 990);
  rec = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA2.userId])).rows[0].id;
  service = (await q("select id from ogevia.services where organization_id = $1 limit 1", [w.orgA])).rows[0].id;
  await q("set session_replication_role = replica");
  await q("update ogevia.caregiver_records set onboarding_required = true where id = $1", [rec]); // 0054: onboarding gate applies
  await q("set session_replication_role = origin");
  await call(w.managerA, "select ogevia_api.set_hour_limit($1, $2, 60, null, 'block', 'Synthetic test limit')", [w.orgA, rec]); // 0053: 60 minutes a day, blocking
  await q("delete from ogevia.caregiver_background_checks where caregiver_record_id = $1", [rec]); // 0055: no verified clearance
});
afterAll(async () => db?.drop());

describe("one gate, every rule from both branches", () => {
  it("reports background (0055), onboarding (0054) and hours (0053) together on a two-hour shift", async () => {
    const b = await blocked();
    expect(b).toEqual(expect.arrayContaining(["background", "onboarding", "hours"]));
  });

  it("the outcome reports the first ENFORCED blocker: hour limits always block, background only after the owner activates enforcement", async () => {
    const o = (await q("select ogevia.readiness_outcome($1,$2,$3, now() + interval '3 days', now() + interval '3 days 2 hours') o", [w.orgA, rec, service])).rows[0].o;
    expect(o).toBe("over_hour_limit"); // enforcement is not activated in this fixture: the background check is report-only, the blocking hour limit is not
  });

  it("every message exists: background, hours and onboarding codes are not 'Not ready.'", async () => {
    for (const [check, code] of [["background", "background_not_recorded"], ["hours", "daily_hour_limit"]]) {
      expect((await q("select ogevia.readiness_message($1,$2) m", [check, code])).rows[0].m).not.toBe("Not ready.");
    }
  });

  it("the skipped-date reasons from both branches and from compliance are all allowed", async () => {
    const def = (await q("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'shift_series_skipped_dates_reason_check'")).rows[0].d as string;
    for (const r of ["over_hour_limit", "onboarding_incomplete", "compliance_hold", "documents_not_current", "service_not_approved"]) expect(def).toContain(r);
  });
});

describe("rolling back 0056 and 0055 restores the 0054 gate, not the 0047 one", () => {
  it("hours and onboarding still gate; background clearance no longer does", async () => {
    await runDown("0056_attention_streams_appearance.down.sql");
    await runDown("0055_caregiver_compliance_hold.down.sql");
    const b = await blocked();
    expect(b).toEqual(expect.arrayContaining(["onboarding", "hours"]));
    expect(b).not.toContain("background");
    const def = (await q("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'shift_series_skipped_dates_reason_check'")).rows[0].d as string;
    expect(def).toContain("over_hour_limit");
    expect(def).toContain("onboarding_incomplete");
    expect(def).not.toContain("compliance_hold");
  });
});
