// 0117 up, down, up: the rollback restores the 0113 / 0104 / 0063 / 0026 behavior and removes every 0117 object; re-applying works. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, type TestDb, type World } from "../../../infra/aws/db/test/harness";

let db: TestDb; let w: World; let today: string; let temecula: string; const rec: Record<string, string> = {};
const P = (f: string) => readFileSync(new URL(`../../../infra/aws/db/pending/${f}`, import.meta.url), "utf8");
async function run(sql: string) {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(sql); await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true }); w = await seedWorld(db, 1195); today = await orgToday(db);
  for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql", "0113_notifications.sql"]) await run(P(`migrations/${f}`));
  for (const r of await q("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])) rec[r.caregiver_code] = r.id;
  temecula = await asActor(db, w.ownerA.sub, async (c) => (await c.query("select ogevia_api.create_office($1,'Temecula Office',null) as id", [w.orgA])).rows[0].id as string);
  for (const code of ["CG-A1", "CG-A2"]) await asActor(db, w.managerA.sub, async (c) => c.query("select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [w.orgA, rec[code], temecula]));
}, 120_000);
afterAll(async () => db?.drop());
const exists = async (sig: string) => (await q("select to_regprocedure($1) as p", [sig]))[0].p !== null;

describe("0117 rollback", () => {
  it("up -> data created -> down removes every new object and restores the 0113 behavior; up again works", async () => {
    await run(P("migrations/0117_open_shift_sms.sql"));
    expect(await exists("ogevia_api.get_sms_settings(uuid)")).toBe(true);
    expect(await exists("ogevia.cover_notify(uuid,uuid,uuid,uuid)")).toBe(false);                   // replaced by the 5-argument form
    // office-category data exists (a call-out alert) before the rollback
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 });
    await q("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596','Winchester',$3)", [w.orgA, f.client, w.managerA.userId]);
    const shift = (await asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'09:50'::time,null,null)", [w.orgA, f.client, f.service, new Date(Date.parse(`${today}T12:00:00Z`) + 2 * 864e5).toISOString().slice(0, 10)])).rows))[0].shift_id as string;
    await asActor(db, w.managerA.sub, async (c) => c.query("select ogevia_api.assign_shift_caregiver($1,$2,$3,null,null)", [w.orgA, shift, rec["CG-A1"]]));
    await asActor(db, w.caregiverA1.sub, async (c) => c.query("select ogevia_api.call_out_my_shift($1,$2,'Sick',null)", [w.orgA, shift]));
    expect((await q("select count(*)::int n from ogevia.user_notifications where category = 'cover_office'"))[0].n).toBeGreaterThan(0);

    await run(P("rollback/0117_open_shift_sms.down.sql"));
    for (const sig of ["ogevia_api.get_sms_settings(uuid)", "ogevia_api.system_sms_claim(integer)", "ogevia.sms_enqueue(uuid,text,text,uuid,text,uuid,integer,text,text,timestamptz)", "ogevia.cover_round(uuid)",
                       "ogevia.cover_notify(uuid,uuid,uuid,uuid,boolean)", "ogevia.cover_on_callout(uuid,ogevia.shifts)", "ogevia.shifts_cover_filled()"]) expect(await exists(sig), sig).toBe(false);
    expect(await exists("ogevia.cover_notify(uuid,uuid,uuid,uuid)")).toBe(true);                    // the 0113 function is back
    expect((await q("select count(*)::int n from pg_tables where schemaname = 'ogevia' and tablename like 'sms\\_%'"))[0].n).toBe(0);
    expect((await q("select count(*)::int n from pg_trigger where tgname in ('shifts_cover_filled','shifts_cover_cancelled')"))[0].n).toBe(0);
    expect((await q("select count(*)::int n from ogevia.user_notifications where category = 'cover_office'"))[0].n).toBe(0);
    await expect(q("insert into ogevia.user_notifications (organization_id, recipient_user_id, category, title, body, dedupe_key) values ($1,$2,'cover_office','t','b','k')", [w.orgA, w.managerA.userId])).rejects.toThrow();   // single category again
    // the old behavior works: the 0104 board columns, call-out without alerts, the 0113 alert
    expect(Object.keys((await asActor(db, w.caregiverA2.sub, async (c) => (await c.query("select * from ogevia_api.list_open_shifts($1)", [w.orgA])).fields.map((x: any) => x.name)))).length).toBeGreaterThan(0);
    expect((await asActor(db, w.caregiverA2.sub, async (c) => (await c.query("select * from ogevia_api.list_open_shifts($1)", [w.orgA])).fields.map((x: any) => x.name))).includes("office_name")).toBe(false);
    const r = (await q("select ogevia.cover_notify($1,$2,null,null) as r", [w.orgA, shift]))[0].r;
    expect(["disabled", "done", "not_needed", "office_required", "address_incomplete"]).toContain(r.state);
    await asActor(db, w.managerA.sub, async (c) => c.query("select ogevia_api.assign_shift_caregiver($1,$2,$3,null,null)", [w.orgA, shift, rec["CG-A2"]]));
    await asActor(db, w.caregiverA2.sub, async (c) => c.query("select ogevia_api.call_out_my_shift($1,$2,'Car',null)", [w.orgA, shift]));
    expect((await q("select shift_is_called_out as x from (select ogevia.shift_is_called_out($1) as shift_is_called_out) t", [shift]))[0].x).toBe(true);

    await run(P("migrations/0117_open_shift_sms.sql"));                                              // up again
    expect(await exists("ogevia_api.get_sms_settings(uuid)")).toBe(true);
    expect(await exists("ogevia.cover_notify(uuid,uuid,uuid,uuid,boolean)")).toBe(true);
  });
});
