// 0119: round 0 keeps the original alert key, so a shift alerted BEFORE 0117 is not alerted a second time after it (found on TEST, 2026-11-24). SYNTHETIC data only.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, type TestDb, type World } from "../../../infra/aws/db/test/harness";

const P = (f: string) => readFileSync(new URL(`../../../infra/aws/db/pending/${f}`, import.meta.url), "utf8");
async function scenario(db: TestDb, w: World, with0119: boolean) {
  const run = async (sql: string) => { const c = await db.admin.connect(); try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(sql); await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
  const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
  const today = await orgToday(db);
  for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql", "0113_notifications.sql"]) await run(P(`migrations/${f}`));
  const rec: Record<string, string> = {}; for (const r of await q("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])) rec[r.caregiver_code] = r.id;
  const office = await asActor(db, w.ownerA.sub, async (c) => (await c.query("select ogevia_api.create_office($1,'Temecula',null) as id", [w.orgA])).rows[0].id as string);
  for (const code of ["CG-A1", "CG-A2"]) await asActor(db, w.managerA.sub, async (c) => c.query("select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [w.orgA, rec[code], office]));
  await asActor(db, w.ownerA.sub, async (c) => c.query("select ogevia_api.set_cover_notification_settings($1,true,true,true,72,50,'office','Open shift in {city} | {date} | {time}','test')", [w.orgA]));
  const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 });
  await q("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, w.caregiverA2.userId, f.client, f.service, today]);
  await q("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596','Winchester',$3)", [w.orgA, f.client, w.managerA.userId]);
  const d = new Date(Date.parse(`${today}T12:00:00Z`) + 2 * 864e5).toISOString().slice(0, 10);
  const shift = (await asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'09:50'::time,null,null)", [w.orgA, f.client, f.service, d])).rows[0].shift_id)) as string;
  // BEFORE 0117 (stage 1 state): the shift is alerted once, under the original key
  await q("select ogevia.cover_notify($1,$2,null,null)", [w.orgA, shift]);
  const keys = async () => (await q("select dedupe_key from ogevia.user_notifications where shift_id = $1 and recipient_user_id = $2 and category = 'cover_shift' and dedupe_key like 'cover:%' order by created_at", [shift, w.caregiverA2.userId])).map((r: any) => r.dedupe_key as string);
  expect(await keys()).toHaveLength(1); expect((await keys())[0]).toMatch(/^cover:[0-9a-f-]{36}:[0-9]+$/);
  await run(P("migrations/0117_open_shift_sms.sql")); if (with0119) await run(P("migrations/0119_cover_key_legacy_round0.sql"));
  await q("select ogevia_api.system_cover_notify_org($1)", [w.orgA]);                                       // the first scheduled run after the upgrade
  return { keys, shift, rec, run, q, office };
}

describe("0119 alert key compatibility", () => {
  it("WITHOUT 0119 (0117 alone) the upgrade alerts an already-alerted shift a second time: the bug found on TEST", async () => {
    const db = await createTestDb({ includeLiveTest: true });
    try { const w = await seedWorld(db, 1196); const s = await scenario(db, w, false); const k = await s.keys(); expect(k).toHaveLength(2); expect(k[1]).toMatch(/:r0$/);
      // the reviewed clean-up: preview writes nothing; apply archives the duplicate and skips its queued email; the first alert stays untouched
      const url = `postgres://postgres:postgres@127.0.0.1:5432/${db.name}`; const sql = new URL("../../../docs/releases/2026-11-20-test-plan/toolchain/CLEANUP_DUPLICATE_ALERTS.sql", import.meta.url).pathname;
      const psql = (...args: string[]) => spawnSync("psql", ["-X", "-A", "-F", " | ", ...args, "-f", sql, url], { encoding: "utf8" });
      const dupe = () => s.q("select n.archived_at, d.status from ogevia.user_notifications n left join ogevia.notification_deliveries d on d.notification_id = n.id where n.shift_id = $1 and n.recipient_user_id = $2 and n.dedupe_key like '%:r0'", [s.shift, w.caregiverA2.userId]);
      const pre = psql(); expect(pre.stdout, pre.stderr).toContain("duplicate_alerts_found | 2"); expect(pre.stdout).toContain("PREVIEW ONLY"); expect((await dupe())[0]).toMatchObject({ archived_at: null, status: "queued" });
      const ap = psql("-v", "apply=1"); expect(ap.stdout, ap.stderr).toContain("APPLIED"); expect((await dupe())[0].archived_at).not.toBeNull(); expect((await dupe())[0].status).toBe("skipped");
      const first = await s.q("select n.archived_at, d.status from ogevia.user_notifications n left join ogevia.notification_deliveries d on d.notification_id = n.id where n.shift_id = $1 and n.recipient_user_id = $2 and n.dedupe_key not like '%:r0'", [s.shift, w.caregiverA2.userId]);
      expect(first[0]).toMatchObject({ archived_at: null, status: "queued" });
      expect(psql("-v", "apply=1").stdout).toContain("duplicate_alerts_found | 0");                                    // nothing left to clean
    } finally { await db.drop(); }
  }, 120_000);
  it("WITH 0119 the shift keeps ONE notification; a replacement call-out (round 1) still alerts again; text keys follow; rollback restores the 0117 key", async () => {
    const db = await createTestDb({ includeLiveTest: true });
    try {
      const w = await seedWorld(db, 1197); const s = await scenario(db, w, true);
      expect(await s.keys()).toHaveLength(1);
      await s.q("select ogevia_api.system_cover_notify_org($1)", [w.orgA]);
      expect(await s.keys()).toHaveLength(1);                                                                  // and again: still one
      // a call-out starts round 1: a fresh alert with the round suffix
      await s.q("update ogevia.caregiver_records set status = 'active' where organization_id = $1", [w.orgA]);
      await asActor(db, w.managerA.sub, async (c) => c.query("select ogevia_api.assign_shift_caregiver($1,$2,$3,null,null)", [w.orgA, s.shift, s.rec["CG-A1"]]));
      await asActor(db, w.caregiverA1.sub, async (c) => c.query("select ogevia_api.call_out_my_shift($1,$2,'Sick',null)", [w.orgA, s.shift]));
      await s.q("select ogevia_api.system_cover_notify_org($1)", [w.orgA]);
      const k = await s.keys(); expect(k).toHaveLength(2); expect(k[1]).toMatch(/:r1$/);
      // text keys: the 0117 round-0 form is re-keyed by 0119 (apply the text row first, then the migration again)
      await s.run(P("rollback/0119_cover_key_legacy_round0.down.sql"));
      await s.q("insert into ogevia.sms_messages (organization_id, purpose, recipient_kind, recipient_user_id, phone_e164, shift_id, round, body, dedupe_key) values ($1,'recruitment','caregiver',$2,'+19515550101',$3,0,'x', $4)",
        [w.orgA, w.caregiverA2.userId, s.shift, `sms:cover:${s.shift}:1795539600:r0:${w.caregiverA2.userId}`]);
      await s.run(P("migrations/0119_cover_key_legacy_round0.sql"));
      expect((await s.q("select dedupe_key from ogevia.sms_messages where shift_id = $1", [s.shift]))[0].dedupe_key).toBe(`sms:cover:${s.shift}:1795539600:${w.caregiverA2.userId}`);
      await s.run(P("rollback/0119_cover_key_legacy_round0.down.sql"));
      expect((await s.q("select dedupe_key from ogevia.sms_messages where shift_id = $1", [s.shift]))[0].dedupe_key).toBe(`sms:cover:${s.shift}:1795539600:r0:${w.caregiverA2.userId}`);
    } finally { await db.drop(); }
  }, 120_000);
});
