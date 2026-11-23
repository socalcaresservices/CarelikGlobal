// Rollback of 0086 on a POPULATED database (posted shifts, requests, jobs, consent): operational records survive, board-only data is removed, and the
// 0063 behavior is restored. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => { db = await createTestDb(); w = await seedWorld(db, 600); await db.admin.query("update ogevia.organizations set slug = 'socal-care-services' where id = $1", [w.orgA]); }, 60000);
afterAll(async () => db?.drop());
const q = (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);

describe("0086 down script on populated data", () => {
  it("keeps shifts, reservations, assignments and the legacy pickup requests; removes only the board's tables; the legacy confirmation works again; re-applying 0086 works", async () => {
    const today = await orgToday(db);
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 60, after: 60 });
    await db.admin.query("update ogevia.clients set city = 'Winchester' where id = $1", [f.client]);
    const d = new Date(Date.parse(`${today}T12:00:00Z`) + 4 * 864e5).toISOString().slice(0, 10);
    const shift = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00'::time,'11:00'::time,null,null)", [w.orgA, f.client, f.service, d]))[0].shift_id as string;
    await q(w.managerA, "select ogevia_api.post_shift_for_coverage($1,$2)", [w.orgA, shift]);
    const before = (await db.admin.query("select (select count(*) from ogevia.shifts) s, (select count(*) from ogevia.authorization_reservations) r, (select count(*) from ogevia.shift_pickup_requests) q, (select count(*) from ogevia.audit_events) a")).rows[0];
    const c = await db.admin.connect();
    try {
      await c.query("begin");
      await c.query("set local role ogevia_owner");
      await c.query(readFileSync(new URL("../rollback/0086_open_shifts_board_and_sms.down.sql", import.meta.url), "utf8"));
      await c.query("reset role");
      await c.query("delete from ogevia_meta.schema_migrations where version = '0086'");
      await c.query("commit");
    } finally { c.release(); }
    const after = (await db.admin.query("select (select count(*) from ogevia.shifts) s, (select count(*) from ogevia.authorization_reservations) r, (select count(*) from ogevia.shift_pickup_requests) q, (select count(*) from ogevia.audit_events) a")).rows[0];
    expect(after).toEqual(before);
    expect((await db.admin.query("select to_regclass('ogevia.shift_coverage_rounds') r, to_regclass('ogevia.notification_jobs') j")).rows[0]).toEqual({ r: null, j: null });
    expect((await db.admin.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname in ('post_shift_for_coverage','request_open_shift','confirm_coverage_request')")).rows[0].n).toBe(0);
    // the 0063 pickup path works again: a caregiver asks, the office confirms
    const open = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'12:00'::time,'13:00'::time,null,null)", [w.orgA, f.client, f.service, d]))[0].shift_id as string;
    expect((await q(w.caregiverA1, "select ogevia_api.pickup_open_shift($1,$2,null) s", [w.orgA, open]))[0].s).toBe("requested");
    const [req] = await q(w.managerA, "select * from ogevia_api.list_shift_pickup_requests($1)", [w.orgA]);
    expect((await q(w.managerA, "select ogevia_api.confirm_shift_pickup($1,$2,null) s", [w.orgA, req.request_id]))[0].s).toBe("covered");
    // and the migration re-applies cleanly
    const { migrate } = await import("../scripts/migrations.js");
    const cl = await db.admin.connect();
    try { expect((await migrate(cl)).applied.map((x: string) => x.slice(0, 4))).toEqual(["0086"]); } finally { cl.release(); }
  }, 120000);
});
