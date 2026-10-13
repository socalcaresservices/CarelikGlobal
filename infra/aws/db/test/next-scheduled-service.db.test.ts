// 0017: the caregiver start screen gets the service of today's scheduled
// visit, so a multi-service client's visit starts on the scheduled service
// and links to its shift. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  asActor,
  createTestDb,
  freshClient,
  seedWorld,
  visitRow,
  type Actor,
  type TestDb,
  type World,
} from "./harness.js";

let db: TestDb;
let w: World;

async function recordOf(a: Actor) {
  return (
    await db.admin.query<{ id: string }>(
      "select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2",
      [a.userId, w.orgA],
    )
  ).rows[0]!.id;
}

/** A client with two authorized, assigned services for `a`. */
async function twoServiceClient(a: Actor) {
  const f = await freshClient(db, w, a, 600);
  const second = (
    await db.admin.query<{ id: string }>(
      "insert into ogevia.services (organization_id, code, name) values ($1, $2, 'Second service (synthetic)') returning id",
      [w.orgA, `S2-${randomUUID().slice(0, 6)}`],
    )
  ).rows[0]!.id;
  await db.admin.query(
    `insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
     select organization_id, client_id, $2, payer, monthly_authorized_minutes, period_start, period_end
     from ogevia.client_authorizations where id = $1`,
    [f.auth, second],
  );
  await db.admin.query(
    `insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start)
     select organization_id, caregiver_user_id, client_id, $2, effective_start
     from ogevia.caregiver_assignments where client_id = $1 and service_id = $3`,
    [f.client, second, f.service],
  );
  return { client: f.client, first: f.service, second };
}

/**
 * A shift `offsetMin` minutes from now that STARTS ON the organization's local today, which is what the start screen
 * looks for. In the last minutes of the day "now + offset" falls on tomorrow, so the start is held at 23:59 local
 * (still an upcoming shift today); at any other time it is exactly now + offset.
 */
async function shift(a: Actor, client: string, service: string, offsetMin: number) {
  return (
    await db.admin.query<{ id: string }>(
      `with t as (
         select least(
                  now() + make_interval(mins => $6),
                  (((now() at time zone o.timezone)::date + 1)::timestamp - interval '1 minute') at time zone o.timezone
                ) as starts_at
         from ogevia.organizations o where o.id = $1)
       insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
       select $1,$2,$3,$4,$5, t.starts_at, t.starts_at + interval '210 minutes' from t returning id`,
      [w.orgA, client, service, a.userId, await recordOf(a), offsetMin],
    )
  ).rows[0]!.id;
}

async function pickerRow(a: Actor, client: string) {
  return asActor(db, a.sub, async (c) =>
    (
      await c.query<{ client_id: string; active_service_count: number; next_scheduled_service_id: string | null }>(
        "select client_id, active_service_count, next_scheduled_service_id from ogevia_api.list_assigned_visit_clients($1)",
        [w.orgA],
      )
    ).rows.find((r) => r.client_id === client),
  );
}

describe("0017 the start screen knows the scheduled visit's service", () => {
  beforeAll(async () => {
    db = await createTestDb();
    w = await seedWorld(db, 600);
  });
  afterAll(async () => db?.drop());

  it("returns no service when the caregiver has no shift today for the client", async () => {
    const c = await twoServiceClient(w.caregiverA1);
    const row = await pickerRow(w.caregiverA1, c.client);
    expect(row).toMatchObject({ active_service_count: 2, next_scheduled_service_id: null });
  });

  it("returns the caller's own shift's service; starting on it links the visit to the shift", async () => {
    const c = await twoServiceClient(w.caregiverA1);
    const s = await shift(w.caregiverA1, c.client, c.second, 30);
    expect((await pickerRow(w.caregiverA1, c.client))?.next_scheduled_service_id).toBe(c.second);

    const linked = await api.start(db, w.caregiverA1, w.orgA, c.client, c.second, null, null);
    expect((await visitRow(db, linked)).scheduled_shift_id).toBe(s);
  });

  it("never reports another caregiver's shift or a called-out shift", async () => {
    const c = await twoServiceClient(w.caregiverA2);
    await shift(w.caregiverA3, c.client, c.second, 30);
    expect((await pickerRow(w.caregiverA2, c.client))?.next_scheduled_service_id).toBeNull();

    const own = await shift(w.caregiverA2, c.client, c.second, 45);
    expect((await pickerRow(w.caregiverA2, c.client))?.next_scheduled_service_id).toBe(c.second);
    await db.admin.query(
      "insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type) values ($1,$2,'called_out')",
      [w.orgA, own],
    );
    expect((await pickerRow(w.caregiverA2, c.client))?.next_scheduled_service_id).toBeNull();
  });

  it("stays executable only by the app role", async () => {
    const { rows } = await db.admin.query(
      `select has_function_privilege('ogevia_app', 'ogevia_api.list_assigned_visit_clients(uuid)', 'execute') as app,
              has_function_privilege('public', 'ogevia_api.list_assigned_visit_clients(uuid)', 'execute') as pub`,
    );
    expect(rows[0]).toEqual({ app: true, pub: false });
  });
});
