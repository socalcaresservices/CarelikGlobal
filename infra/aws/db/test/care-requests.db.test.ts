import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, seedWorld, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;

async function asPublic<T>(fn: (client: pg.PoolClient) => Promise<T>) {
  const client = await db.admin.connect();
  try {
    await client.query("begin");
    await client.query("set local role ogevia_app");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

describe("care request -> availability -> offer -> assignment -> replacement", () => {
  beforeAll(async () => {
    db = await createTestDb();
    w = await seedWorld(db, 600);
  });
  afterAll(async () => db?.drop());

  it("keeps agency assignment control while allowing link/app self service", async () => {
    const fixture = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 10, after: 10 });
    const portal = await asActor(db, w.managerA.sub, async (c) =>
      (await c.query<{ portal_id: string; token: string }>(
        "select * from ogevia_api.create_client_care_portal($1,$2,null)", [w.orgA, fixture.client],
      )).rows[0]!,
    );

    const slot = await db.admin.query<{ starts_at: string; ends_at: string; dow: number }>(
      "select (date_trunc('day', now()) + interval '2 days 17 hours')::timestamptz::text starts_at, (date_trunc('day', now()) + interval '2 days 21 hours')::timestamptz::text ends_at, extract(dow from date_trunc('day', now()) + interval '2 days')::int dow",
    );
    const { starts_at, ends_at, dow } = slot.rows[0]!;

    for (const actor of [w.caregiverA1, w.caregiverA2]) {
      await asActor(db, actor.sub, async (c) => {
        await c.query("select ogevia_api.replace_my_availability($1,$2::jsonb,'[]'::jsonb)", [
          w.orgA,
          JSON.stringify([{ weekday: dow, specific_date: null, start_local: "08:00", end_local: "23:00" }]),
        ]);
      });
    }

    const created = await asPublic(async (c) =>
      (await c.query<{ request_id: string }>(
        "select * from ogevia_api.public_create_care_request($1,$2,$3,$4,'Need respite',$5)",
        [portal.token, fixture.service, starts_at, ends_at, randomUUID()],
      )).rows[0]!,
    );

    const candidates = await asActor(db, w.managerA.sub, async (c) =>
      (await c.query<{ caregiver_record_id: string; current_client_match: boolean }>(
        "select * from ogevia_api.list_available_caregivers($1,$2)", [w.orgA, created.request_id],
      )).rows,
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.current_client_match).toBe(true);

    const offer = await asActor(db, w.managerA.sub, async (c) =>
      (await c.query<{ offer_id: string; token: string }>(
        "select * from ogevia_api.send_care_offer($1,$2,$3)",
        [w.orgA, created.request_id, candidates[0]!.caregiver_record_id],
      )).rows[0]!,
    );
    await asPublic((c) => c.query("select ogevia_api.public_respond_care_offer($1,true,null)", [offer.token]));

    const beforeAssign = await db.admin.query("select assigned_shift_id from ogevia.care_requests where id=$1", [created.request_id]);
    expect(beforeAssign.rows[0]!.assigned_shift_id).toBeNull();

    const shiftId = await asActor(db, w.managerA.sub, async (c) =>
      (await c.query<{ id: string }>("select ogevia_api.assign_care_request($1,$2,$3) id", [w.orgA, created.request_id, offer.offer_id])).rows[0]!.id,
    );
    const assigned = await db.admin.query(
      "select r.status, s.id shift_id, ar.reserved_minutes from ogevia.care_requests r join ogevia.shifts s on s.id=r.assigned_shift_id join ogevia.authorization_reservations ar on ar.care_request_id=r.id where r.id=$1",
      [created.request_id],
    );
    expect(assigned.rows[0]).toMatchObject({ status: "assigned", shift_id: shiftId, reserved_minutes: 240 });

    await asPublic((c) => c.query("select ogevia_api.public_cancel_assigned_offer($1,'Cannot work')", [offer.token]));
    expect((await db.admin.query("select status from ogevia.care_requests where id=$1", [created.request_id])).rows[0]!.status).toBe("coverage_needed");
    expect((await db.admin.query("select released_at from ogevia.authorization_reservations where care_request_id=$1", [created.request_id])).rows[0]!.released_at).toBeNull();

    const replacement = candidates[1]!;
    const replacementOffer = await asActor(db, w.managerA.sub, async (c) =>
      (await c.query<{ offer_id: string; token: string }>("select * from ogevia_api.send_care_offer($1,$2,$3)", [w.orgA, created.request_id, replacement.caregiver_record_id])).rows[0]!,
    );
    await asPublic((c) => c.query("select ogevia_api.public_respond_care_offer($1,true,null)", [replacementOffer.token]));
    const replacementShift = await asActor(db, w.managerA.sub, async (c) =>
      (await c.query<{ id: string }>("select ogevia_api.assign_care_request($1,$2,$3) id", [w.orgA, created.request_id, replacementOffer.offer_id])).rows[0]!.id,
    );
    expect(replacementShift).toBe(shiftId);
    expect((await db.admin.query("select count(*)::int n from ogevia.authorization_reservations where care_request_id=$1", [created.request_id])).rows[0]!.n).toBe(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.care_request_events where care_request_id=$1 and event_key='reassigned'", [created.request_id])).rows[0]!.n).toBe(1);
  });
});
