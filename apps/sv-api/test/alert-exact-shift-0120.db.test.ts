// 0120: an alert opens the exact shift, is short, and says whether it can still be requested. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, orgToday, seedWorld } from "../../../infra/aws/db/test/harness";

const P = (f: string) => readFileSync(new URL(`../../../infra/aws/db/pending/${f}`, import.meta.url), "utf8");

describe("0120 alert for the exact shift", () => {
  it("link, short copy, live status per caregiver, the shift page lookup, and rollback", async () => {
    const db = await createTestDb({ includeLiveTest: true });
    try {
      const w = await seedWorld(db, 1200);
      const run = async (sql: string) => { const c = await db.admin.connect(); try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(sql); await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
      const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
      const today = await orgToday(db);
      for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql", "0113_notifications.sql", "0117_open_shift_sms.sql", "0119_cover_key_legacy_round0.sql", "0120_alert_opens_exact_shift.sql"]) await run(P(`migrations/${f}`));
      const rec: Record<string, string> = {}; for (const r of await q("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])) rec[r.caregiver_code] = r.id;
      const office = await asActor(db, w.ownerA.sub, async (c) => (await c.query("select ogevia_api.create_office($1,'Temecula',null) as id", [w.orgA])).rows[0].id as string);
      for (const code of ["CG-A1", "CG-A2"]) await asActor(db, w.managerA.sub, async (c) => c.query("select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [w.orgA, rec[code], office]));
      await asActor(db, w.ownerA.sub, async (c) => c.query("select ogevia_api.set_cover_notification_settings($1,true,true,true,72,50,'office','Open shift in {city} | {date} | {time}','test')", [w.orgA]));
      const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 });
      await q("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, w.caregiverA2.userId, f.client, f.service, today]);
      await q("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596','Winchester',$3)", [w.orgA, f.client, w.managerA.userId]);
      const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
      const mk = async (d: string, a: string, b: string) => (await asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,null)", [w.orgA, f.client, f.service, d, a, b])).rows[0].shift_id)) as string;
      const shift = await mk(day(2), "09:00", "09:50");
      await q("select ogevia_api.system_cover_notify_org($1)", [w.orgA]);

      // the stored alert: exact-shift link, short body, no office name, no client detail
      const n = (await q("select * from ogevia.user_notifications where shift_id = $1 and recipient_user_id = $2 and category = 'cover_shift'", [shift, w.caregiverA2.userId]))[0];
      expect(n.link).toBe(`/my-shifts?shift=${shift}`);
      expect(n.body).toContain("Winchester"); expect(n.body).toContain("View the shift to request it"); expect(n.body).not.toMatch(/Coordinating office|Temecula|92596/);
      expect(n.body.split("\n")).toHaveLength(3);

      // the card: live summary and status, from the caller's point of view; nothing identifying
      const list = (sub: string) => asActor(db, sub, async (c) => (await c.query("select ogevia_api.list_user_notifications($1,'all',null,30,null) as r", [w.orgA])).rows[0].r as { items: Array<{ shift: Record<string, unknown> }> });
      const card = (await list(w.caregiverA2.sub)).items[0]!.shift;
      expect(card).toMatchObject({ shiftId: shift, status: "open", city: "Winchester", officeName: "Temecula" });
      expect(Object.keys(card).sort()).toEqual(["city", "endsAt", "minutes", "officeName", "serviceName", "shiftId", "startsAt", "status"]);

      // requested, then filled for the other caregiver and yours for the confirmed one
      await asActor(db, w.caregiverA2.sub, async (c) => c.query("select ogevia_api.pickup_open_shift($1,$2,null)", [w.orgA, shift]));
      expect(((await list(w.caregiverA2.sub)).items[0]!.shift as { status: string }).status).toBe("requested");
      const reqId = (await q("select id from ogevia.shift_pickup_requests where shift_id = $1 and status = 'pending'", [shift]))[0].id as string;
      await asActor(db, w.managerA.sub, async (c) => c.query("select ogevia_api.confirm_shift_pickup($1,$2,null)", [w.orgA, reqId]));
      expect(((await list(w.caregiverA2.sub)).items.find((i) => (i.shift as { shiftId: string }).shiftId === shift)!.shift as { status: string }).status).toBe("yours");
      const a1 = (await list(w.caregiverA1.sub)).items.find((i) => i.shift && (i.shift as { shiftId: string }).shiftId === shift);
      if (a1) expect((a1.shift as { status: string }).status).toBe("filled");
      const look = (sub: string, id: string) => asActor(db, sub, async (c) => (await c.query("select ogevia_api.get_cover_shift($1,$2) as r", [w.orgA, id])).rows[0].r as { status: string });
      expect((await look(w.caregiverA1.sub, shift)).status).toBe("filled");                 // assigned to the client: allowed, and it is filled
      expect((await look(w.managerA.sub, shift)).status).toBe("filled");                    // office staff may look

      // cancelled, and already started
      const s2 = await mk(day(3), "09:00", "09:50"); await asActor(db, w.managerA.sub, async (c) => c.query("select ogevia_api.cancel_shift($1,$2,'Client cancelled',null)", [w.orgA, s2]));
      expect((await look(w.caregiverA1.sub, s2)).status).toBe("cancelled");
      const s3 = await mk(day(4), "09:00", "09:50"); await q("update ogevia.shifts set starts_at = now() - interval '1 hour', ends_at = now() + interval '1 hour' where id = $1", [s3]);
      expect((await look(w.caregiverA1.sub, s3)).status).toBe("started");
      const s4 = await mk(day(5), "09:00", "09:50");
      expect((await look(w.caregiverA1.sub, s4)).status).toBe("open");

      // someone with no connection to it sees nothing, and an unknown id looks the same
      expect((await look(w.caregiverA1.sub, "00000000-0000-4000-8000-000000000000")).status).toBe("unavailable");

      // rollback: the old link and body come back, the new functions are gone
      await run(P("rollback/0120_alert_opens_exact_shift.down.sql"));
      expect((await q("select to_regprocedure('ogevia_api.get_cover_shift(uuid,uuid)') is null as gone"))[0].gone).toBe(true);
      const s5 = await mk(day(2), "14:00", "14:50"); await q("select ogevia_api.system_cover_notify_org($1)", [w.orgA]);
      const old = (await q("select link, body from ogevia.user_notifications where shift_id = $1 and recipient_user_id = $2 and category = 'cover_shift'", [s5, w.caregiverA2.userId]))[0];
      expect(old.link).toBe("/schedule"); expect(old.body).toContain("Coordinating office: Temecula");
      expect(((await asActor(db, w.caregiverA2.sub, async (c) => (await c.query("select ogevia_api.list_user_notifications($1,'all',null,30,null) as r", [w.orgA])).rows[0].r)) as { items: Array<Record<string, unknown>> }).items[0]).not.toHaveProperty("shift");
    } finally { await db.drop(); }
  }, 180_000);
});
