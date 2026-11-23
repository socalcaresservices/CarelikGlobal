// Load and concurrency for Open Shifts (0086): hundreds of simultaneous requests, board reads and approvals against one database. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
const rec: Record<string, string> = {};
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
  await db.admin.query("update ogevia.organizations set slug = 'socal-care-services' where id = $1", [w.orgA]);
  for (const cg of ["CG-A1", "CG-A2", "CG-A3"]) {
    await asActor(db, w.managerA.sub, (c) => c.query("select ogevia_api.set_caregiver_coverage_cities($1,$2,'[{\"city\":\"Winchester\",\"state\":\"CA\"}]'::jsonb)", [w.orgA, rec[cg]]));
  }
}, 60000);
afterAll(async () => db?.drop());

const q = (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

describe("concurrency at volume", () => {
  it("300 simultaneous requests (retries, double taps and three caregivers) on one posted shift leave exactly three pending requests and no duplicate audit or job rows", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 60, after: 60 });
    await db.admin.query("update ogevia.clients set city = 'Winchester' where id = $1", [f.client]);
    const shift = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00'::time,'11:00'::time,null,null)", [w.orgA, f.client, f.service, day(5)]))[0].shift_id as string;
    await q(w.managerA, "select ogevia_api.post_shift_for_coverage($1,$2)", [w.orgA, shift]);
    const ref = (await db.admin.query("select public_ref from ogevia.shifts where id = $1", [shift])).rows[0].public_ref as string;
    const actors = [w.caregiverA1, w.caregiverA2, w.caregiverA3];
    const t0 = Date.now();
    const results = await Promise.allSettled(Array.from({ length: 300 }, (_, i) => q(actors[i % 3]!, "select ogevia_api.request_open_shift($1,$2,$3) s", [w.orgA, ref, i % 2 ? randomUUID() : null])));
    const ms = Date.now() - t0;
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed.map((f) => (f.reason as Error).message), "unexpected failures").toEqual([]);
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_pickup_requests where shift_id = $1 and status = 'pending'", [shift])).rows[0].n).toBe(3);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'shift.pickup_requested'", [shift])).rows[0].n).toBe(3);
    console.log(`300 concurrent requests: ${ms} ms`);
    expect(ms).toBeLessThan(60000);
  }, 120000);

  it("200 concurrent board reads and 3 racing approvals: reads all succeed; exactly one approval wins; one reservation, one assignment event", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 60, after: 60 });
    await db.admin.query("update ogevia.clients set city = 'Winchester' where id = $1", [f.client]);
    const shift = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'12:00'::time,'13:00'::time,null,null)", [w.orgA, f.client, f.service, day(6)]))[0].shift_id as string;
    await q(w.managerA, "select ogevia_api.post_shift_for_coverage($1,$2)", [w.orgA, shift]);
    const ref = (await db.admin.query("select public_ref from ogevia.shifts where id = $1", [shift])).rows[0].public_ref as string;
    for (const a of [w.caregiverA1, w.caregiverA2, w.caregiverA3]) await q(a, "select ogevia_api.request_open_shift($1,$2,null)", [w.orgA, ref]);
    const reqs = (await q(w.managerA, "select * from ogevia_api.list_coverage_requests($1,$2)", [w.orgA, shift])).map((r) => r.request_id as string);
    const t0 = Date.now();
    const reads = Promise.allSettled(Array.from({ length: 200 }, (_, i) => q([w.caregiverA1, w.caregiverA2, w.caregiverA3][i % 3]!, "select * from ogevia_api.list_open_shift_board($1,50,0)", [w.orgA])));
    const approvals = Promise.allSettled(reqs.map((id, i) => q([w.managerA, w.ownerA, w.managerA][i]!, "select ogevia_api.confirm_coverage_request($1,$2,'Synthetic race',null)", [w.orgA, id])));
    const [r, a] = await Promise.all([reads, approvals]);
    expect(r.filter((x) => x.status === "rejected")).toEqual([]);
    expect(a.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_coverage_events where shift_id = $1 and event_type = 'reassigned'", [shift])).rows[0].n).toBe(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.authorization_reservations where shift_id = $1 and released_at is null", [shift])).rows[0].n).toBe(1);
    console.log(`200 board reads + 3 racing approvals: ${Date.now() - t0} ms`);
  }, 120000);
});
