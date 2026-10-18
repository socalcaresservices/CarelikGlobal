// 0016: the monthly summary's "remaining" subtracts reserved (scheduled) time,
// using the same arithmetic as the assignment cap. SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asActor,
  createTestDb,
  freshClient,
  orgToday,
  seedWorld,
  signedVisit,
  type TestDb,
  type World,
} from "./harness.js";

let db: TestDb;
let w: World;

type Fixture = { client: string; service: string; auth: string };

/** A shift held by an assigned Care Request reservation (as 0011 creates it). */
async function reservedShift(f: Fixture, offsetHours: number, minutes: number) {
  const record = (await db.admin.query<{ id: string }>(
    "select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [w.caregiverA1.userId, w.orgA],
  )).rows[0]!.id;
  const shift = (await db.admin.query<{ id: string }>(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
     values ($1,$2,$3,$4,$5, now() + make_interval(hours => $6), now() + make_interval(hours => $6, mins => $7)) returning id`,
    [w.orgA, f.client, f.service, w.caregiverA1.userId, record, offsetHours, minutes],
  )).rows[0]!.id;
  const request = (await db.admin.query<{ id: string }>(
    `insert into ogevia.care_requests (organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at,
       requested_minutes, status, request_key, assigned_shift_id, assigned_caregiver_record_id, assigned_at)
     select $1, $2, $3, a.lineage_id, s.starts_at, s.ends_at, $4, 'assigned', gen_random_uuid(), s.id, $5, now()
     from ogevia.client_authorizations a, ogevia.shifts s where a.id = $6 and s.id = $7 returning id`,
    [w.orgA, f.client, f.service, minutes, record, f.auth, shift],
  )).rows[0]!.id;
  await db.admin.query(
    `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
     select $1, a.lineage_id, $2, $3, $4::date, $5 from ogevia.client_authorizations a where a.id = $6`,
    [w.orgA, request, shift, await orgToday(db), minutes, f.auth],
  );
  return request;
}

async function summary(f: Fixture) {
  const monthStart = `${(await orgToday(db)).slice(0, 7)}-01`;
  return asActor(db, w.managerA.sub, async (c) =>
    (await c.query("select * from ogevia_api.list_monthly_service_summary($1, $2, $3)", [w.orgA, monthStart, f.client])).rows[0]!,
  );
}

/** What the assignment cap still allows (assign_care_request's arithmetic). */
async function capAllows(f: Fixture) {
  const { rows } = await db.admin.query<{ left: number }>(
    `select (a.monthly_authorized_minutes
             - ogevia.authorization_month_usage(a.lineage_id, $2::date, null)
             - ogevia.care_request_reserved_usage(a.lineage_id, $2::date, null))::int as left
     from ogevia.client_authorizations a where a.id = $1`,
    [f.auth, await orgToday(db)],
  );
  return rows[0]!.left;
}

describe("0016 remaining hours count scheduled (reserved) time", () => {
  beforeAll(async () => {
    db = await createTestDb();
    w = await seedWorld(db, 600);
  });
  afterAll(async () => db?.drop());

  it("reports what can still be scheduled, matching the assignment cap", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    await signedVisit(db, w.caregiverA1, w, 60, w.orgA, f.client, f.service);
    await reservedShift(f, 24, 180);
    const second = await reservedShift(f, 48, 240);

    const s = await summary(f);
    expect(s).toMatchObject({ authorized_minutes: 600, billable_minutes: 60, reserved_minutes: 420, remaining_minutes: 120 });
    // Before 0016 the report said 540 here while the cap allowed only 120.
    expect(await capAllows(f)).toBe(120);

    // A cancelled request releases its reservation; remaining grows back.
    await db.admin.query(
      "update ogevia.authorization_reservations set released_at = now(), release_reason = 'client_cancelled' where care_request_id = $1",
      [second],
    );
    expect(await summary(f)).toMatchObject({ reserved_minutes: 180, remaining_minutes: 360 });
    expect(await capAllows(f)).toBe(360);
  });

  it("0057: reports the real, negative balance when reservations exceed the month (it was floored at 0)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 200);
    await reservedShift(f, 72, 180);
    await reservedShift(f, 96, 180);
    expect(await summary(f)).toMatchObject({
      reserved_minutes: 360, committed_minutes: 360, remaining_minutes: -160, over_limit_minutes: 160, authorization_tier: "critical",
    });
  });

  it("keeps the report readable only through the app role", async () => {
    const { rows } = await db.admin.query(
      `select has_function_privilege('ogevia_app', 'ogevia_api.list_monthly_service_summary(uuid,date,uuid)', 'execute') app,
              has_function_privilege('public', 'ogevia_api.list_monthly_service_summary(uuid,date,uuid)', 'execute') pub`,
    );
    expect(rows[0]).toEqual({ app: true, pub: false });
  });
});
