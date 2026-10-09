// PostgreSQL integration-test harness. Every test file gets its own
// disposable database, migrated from zero with the real runner, seeded with
// SYNTHETIC fixtures only, and dropped afterwards.
//
//   OGEVIA_TEST_DATABASE_URL=postgres://<admin>@127.0.0.1:55432/postgres
//
// Calls run exactly as the Phase 4 API will: one transaction, SET LOCAL ROLE
// ogevia_app (no table privileges), ogevia_api.begin_request(<cognito sub>).

import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect } from "vitest";
import { assertSafeTarget, migrate } from "../scripts/migrations.js";

export const ADMIN_URL = process.env.OGEVIA_TEST_DATABASE_URL ?? "";

export interface TestDb {
  readonly name: string;
  readonly admin: pg.Pool;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  if (!ADMIN_URL) throw new Error("OGEVIA_TEST_DATABASE_URL is not set");
  assertSafeTarget(ADMIN_URL);
  const name = `ogevia_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`create database ${name}`);
  await root.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: url.toString(), max: 30 });
  // Teardown uses DROP DATABASE ... WITH (FORCE), which terminates idle pool
  // connections (57P01). That one code is expected; anything else is a failure.
  admin.on("error", (error: Error & { code?: string }) => {
    if (error.code !== "57P01") throw error;
  });
  const client = await admin.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }
  return {
    name,
    admin,
    async drop() {
      await admin.end();
      const r = new pg.Client({ connectionString: ADMIN_URL });
      await r.connect();
      await r.query(`drop database if exists ${name} with (force)`);
      await r.end();
    },
  };
}

/** Runs fn as the application role for the given Cognito sub, in one transaction. */
export async function asActor<T>(
  db: TestDb,
  sub: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.admin.connect();
  try {
    await client.query("begin");
    await client.query("set local role ogevia_app");
    await client.query("select ogevia_api.begin_request($1, $2)", [
      sub,
      randomUUID(),
    ]);
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

export async function expectPgError(
  promise: Promise<unknown>,
  code: string,
  message?: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; message: string };
    expect(e.code, e.message).toBe(code);
    if (message) expect(e.message).toMatch(message);
    return;
  }
  throw new Error(`Expected SQLSTATE ${code}, but the call succeeded`);
}

/**
 * TEST-ONLY: move a draft visit's server time_in into the past so it can be
 * ended (end requires >= 1 minute). Uses session_replication_role=replica in
 * a separate admin session to bypass the immutability trigger; production
 * code has no such path.
 */
export async function ageVisit(
  db: TestDb,
  visitId: string,
  minutes: number,
): Promise<void> {
  const client = await db.admin.connect();
  try {
    await client.query("set session_replication_role = replica");
    await client.query(
      "update ogevia.service_visits set time_in = time_in - make_interval(mins => $2) where id = $1",
      [visitId, minutes],
    );
  } finally {
    await client.query("reset session_replication_role");
    client.release();
  }
}

/**
 * TEST-ONLY: move a caregiver's earlier fixture shifts 30 days into the past, so a later fixture can
 * place its own shift "around now" without overlapping them. Real bookings cannot overlap (the
 * readiness gate refuses them); fixtures that insert directly must not rely on overlapping. Uses
 * session_replication_role=replica like ageVisit; production code has no such path.
 */
export async function retireOldShifts(db: TestDb, caregiverUserId: string): Promise<void> {
  const client = await db.admin.connect();
  try {
    await client.query("set session_replication_role = replica");
    await client.query(
      "update ogevia.shifts set starts_at = starts_at - interval '30 days', ends_at = ends_at - interval '30 days' where caregiver_user_id = $1 and starts_at > now() - interval '10 days'",
      [caregiverUserId],
    );
  } finally {
    await client.query("reset session_replication_role");
    client.release();
  }
}

/**
 * Sets a caregiver's APPROVED availability the way production does: the caregiver submits a request
 * with a reason, an administrator (the org A manager) approves it. A request identical to what is
 * already approved is not an error here (the end state is what the caller wants).
 */
export async function approveAvailability(
  db: TestDb,
  w: Pick<World, "orgA" | "managerA">,
  caregiver: Actor,
  windows: unknown[],
  unavailable: unknown[] = [],
): Promise<void> {
  let id: string | null = null;
  try {
    id = await asActor(db, caregiver.sub, async (c) => {
      const state = (await c.query("select ogevia_api.get_my_availability_state($1) as s", [w.orgA])).rows[0]!.s as { version: number };
      return (
        await c.query<{ id: string }>("select ogevia_api.request_availability_change($1,'Test availability',$2::jsonb,$3::jsonb,$4,null) as id", [
          w.orgA,
          JSON.stringify(windows),
          JSON.stringify(unavailable),
          state.version,
        ])
      ).rows[0]!.id;
    });
  } catch (error) {
    if (/same as your approved availability/.test((error as Error).message)) return;
    throw error;
  }
  await asActor(db, w.managerA.sub, (c) => c.query("select ogevia_api.review_availability_request($1,'approve','Approved for the test',null)", [id]));
}

// ---------------------------------------------------------------------------
// Synthetic world
// ---------------------------------------------------------------------------

export interface Actor {
  readonly userId: string;
  readonly sub: string;
}

export interface World {
  orgA: string;
  orgB: string;
  ownerA: Actor;
  managerA: Actor;
  schedulerA: Actor;
  caregiverA1: Actor;
  caregiverA2: Actor;
  caregiverA3: Actor;
  caregiverB1: Actor;
  managerB: Actor;
  outsider: Actor;
  clientA1: string;
  clientA2: string;
  clientB1: string;
  serviceA: string;
  serviceB: string;
  authA1: string;
  authB1: string;
}

/** Org-local "today" for org A (America/Los_Angeles). */
export async function orgToday(db: TestDb): Promise<string> {
  const { rows } = await db.admin.query<{ d: string }>(
    "select to_char((now() at time zone 'America/Los_Angeles')::date, 'YYYY-MM-DD') as d",
  );
  return rows[0]!.d;
}

export async function seedWorld(
  db: TestDb,
  monthlyMinutes = 600,
): Promise<World> {
  const q = (sql: string, params: unknown[] = []) =>
    db.admin.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) =>
    ((await q(sql, params)).rows[0] as { id: string }).id;

  const user = async (name: string): Promise<Actor> => {
    const sub = randomUUID();
    const userId = await one(
      "insert into ogevia.app_users (cognito_sub, display_name) values ($1, $2) returning id",
      [sub, name],
    );
    return { userId, sub };
  };
  const org = (slug: string) =>
    one(
      "insert into ogevia.organizations (slug, display_name) values ($1, $1) returning id",
      [slug],
    );
  const member = (orgId: string, a: Actor, role: string, status = "active") =>
    q(
      "insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,$3,$4)",
      [orgId, a.userId, role, status],
    );
  const record = (orgId: string, a: Actor, code: string) =>
    q(
      "insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,$3,'Synthetic',$3)",
      [orgId, a.userId, code],
    );

  const orgA = await org("org-a");
  const orgB = await org("org-b");
  const w = {
    orgA,
    orgB,
    ownerA: await user("OWNER_A"),
    managerA: await user("MANAGER_A"),
    schedulerA: await user("SCHEDULER_A"),
    caregiverA1: await user("CAREGIVER_A1"),
    caregiverA2: await user("CAREGIVER_A2"),
    caregiverA3: await user("CAREGIVER_A3"),
    caregiverB1: await user("CAREGIVER_B1"),
    managerB: await user("MANAGER_B"),
    outsider: await user("OUTSIDER"),
  } as World;

  await member(orgA, w.ownerA, "organization_owner");
  await member(orgA, w.managerA, "manager");
  await member(orgA, w.schedulerA, "scheduler");
  await member(orgA, w.caregiverA1, "caregiver");
  await member(orgA, w.caregiverA2, "caregiver");
  await member(orgA, w.caregiverA3, "caregiver");
  await member(orgB, w.caregiverB1, "caregiver");
  await member(orgB, w.managerB, "manager");
  await record(orgA, w.caregiverA1, "CG-A1");
  await record(orgA, w.caregiverA2, "CG-A2");
  await record(orgA, w.caregiverA3, "CG-A3");
  await record(orgB, w.caregiverB1, "CG-B1");

  w.clientA1 = await one(
    "insert into ogevia.clients (organization_id) values ($1) returning id",
    [orgA],
  );
  w.clientA2 = await one(
    "insert into ogevia.clients (organization_id) values ($1) returning id",
    [orgA],
  );
  w.clientB1 = await one(
    "insert into ogevia.clients (organization_id) values ($1) returning id",
    [orgB],
  );
  w.serviceA = await one(
    "insert into ogevia.services (organization_id, code, name) values ($1, 'RSP', 'Synthetic Respite') returning id",
    [orgA],
  );
  w.serviceB = await one(
    "insert into ogevia.services (organization_id, code, name) values ($1, 'RSP', 'Synthetic Respite') returning id",
    [orgB],
  );

  const today = await orgToday(db);
  const assign = (
    orgId: string,
    a: Actor,
    client: string,
    service: string,
    start: string,
    end: string | null,
    active = true,
  ) =>
    q(
      "insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start, effective_end, is_active) values ($1,$2,$3,$4,$5::date,$6::date,$7)",
      [orgId, a.userId, client, service, start, end, active],
    );
  // A1: active. A2: expired yesterday. A3: inactive. B1: active in org B.
  await assign(orgA, w.caregiverA1, w.clientA1, w.serviceA, `${today}`, null);
  await q(
    "insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start, effective_end) values ($1,$2,$3,$4,$5::date - 30,$5::date - 1)",
    [orgA, w.caregiverA2.userId, w.clientA1, w.serviceA, today],
  );
  await assign(orgA, w.caregiverA3, w.clientA1, w.serviceA, today, null, false);
  await assign(orgB, w.caregiverB1, w.clientB1, w.serviceB, today, null);

  const auth = (orgId: string, client: string, service: string) =>
    one(
      `insert into ogevia.client_authorizations
         (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
       values ($1,$2,$3,'SYNTHETIC-PAYER',$4, date_trunc('month', $5::date)::date,
               (date_trunc('month', $5::date) + interval '1 month - 1 day')::date)
       returning id`,
      [orgId, client, service, monthlyMinutes, today],
    );
  w.authA1 = await auth(orgA, w.clientA1, w.serviceA);
  w.authB1 = await auth(orgB, w.clientB1, w.serviceB);
  return w;
}

// ---------------------------------------------------------------------------
// API call helpers
// ---------------------------------------------------------------------------

export const api = {
  start: (
    db: TestDb,
    a: Actor,
    org: string,
    client: string,
    service: string,
    key: string | null = null,
  ) =>
    asActor(
      db,
      a.sub,
      async (c) =>
        (
          await c.query<{ id: string }>(
            "select ogevia_api.start_ad_hoc_service_visit($1,$2,$3,'{}',null,$4) as id",
            [org, client, service, key],
          )
        ).rows[0]!.id,
    ),
  end: (db: TestDb, a: Actor, visit: string) =>
    asActor(
      db,
      a.sub,
      async (c) =>
        (
          await c.query("select * from ogevia_api.end_service_visit($1)", [
            visit,
          ])
        ).rows[0] as {
          visit_id: string;
          worked_minutes: number;
          time_in: Date;
          time_out: Date;
        },
    ),
  registerEvidence: (
    db: TestDb,
    a: Actor,
    org: string,
    visit: string,
    key: string | null = null,
    sha = "a".repeat(64),
  ) =>
    asActor(
      db,
      a.sub,
      async (c) =>
        (
          await c.query<{ id: string }>(
            "select ogevia_api.register_visit_evidence($1,$2,'v1','image/png',2048,$3,$4) as id",
            [visit, `${org}/${visit}/client-signature.png`, sha, key],
          )
        ).rows[0]!.id,
    ),
  confirm: (
    db: TestDb,
    a: Actor,
    visit: string,
    opts: {
      method?: string;
      evidence?: string | null;
      role?: string;
      name?: string | null;
      reason?: string | null;
      key?: string | null;
    } = {},
  ) =>
    asActor(
      db,
      a.sub,
      async (c) =>
        (
          await c.query(
            "select * from ogevia_api.confirm_service_visit($1,$2,$3,$4,$5,null,$6,$7)",
            [
              visit,
              opts.role ?? "client",
              opts.method ?? "draw",
              opts.evidence ?? null,
              opts.name ?? null,
              opts.reason ?? null,
              opts.key ?? null,
            ],
          )
        ).rows[0] as {
          visit_id: string;
          status: string;
          authorization_status: string;
          worked_minutes: number;
          billable_minutes: number;
          month_to_date_minutes: string;
          remaining_minutes: string;
        },
    ),
  correct: (
    db: TestDb,
    a: Actor,
    visit: string,
    timeIn: Date,
    timeOut: Date,
    reason: string,
    key: string | null = null,
  ) =>
    asActor(
      db,
      a.sub,
      async (c) =>
        (
          await c.query<{ id: string }>(
            "select ogevia_api.correct_service_visit($1,$2,$3,$4,$5) as id",
            [visit, timeIn, timeOut, reason, key],
          )
        ).rows[0]!.id,
    ),
  amend: async (
    db: TestDb,
    a: Actor,
    auth: string,
    minutes: number,
    reason = "Synthetic amendment",
    period?: { start: string; end: string },
  ) => {
    // The runtime role cannot read tables, so the test reads the period as admin.
    const p = period ??
      (
        await db.admin.query<{ start: string; end: string }>(
          "select period_start::text as start, period_end::text as end from ogevia.client_authorizations where id = $1",
          [auth],
        )
      ).rows[0] ?? { start: "2000-01-01", end: "2000-12-31" };
    return asActor(
      db,
      a.sub,
      async (c) =>
        (
          await c.query(
            "select * from ogevia_api.amend_client_authorization($1,$2,$3::date,$4::date,'SYNTHETIC-PAYER',$5)",
            [auth, minutes, p.start, p.end, reason],
          )
        ).rows as Array<{
          new_authorization_id: string;
          new_version_number: number;
          affected_visit_id: string | null;
          impact_kind: string | null;
        }>,
    );
  },
};

/** Start -> age -> end: a visit awaiting signature with `minutes` worked. */
export async function endedVisit(
  db: TestDb,
  a: Actor,
  w: World,
  minutes: number,
  org = w.orgA,
  client = w.clientA1,
  service = w.serviceA,
) {
  const visit = await api.start(db, a, org, client, service);
  await ageVisit(db, visit, minutes);
  await api.end(db, a, visit);
  return visit;
}

/** Start -> end -> evidence -> draw confirmation. */
export async function signedVisit(
  db: TestDb,
  a: Actor,
  w: World,
  minutes: number,
  org = w.orgA,
  client = w.clientA1,
  service = w.serviceA,
) {
  const visit = await endedVisit(db, a, w, minutes, org, client, service);
  const evidence = await api.registerEvidence(db, a, org, visit);
  const result = await api.confirm(db, a, visit, { evidence });
  return { visit, evidence, result };
}

export async function visitRow(db: TestDb, id: string) {
  return (
    await db.admin.query("select * from ogevia.service_visits where id = $1", [
      id,
    ])
  ).rows[0] as Record<string, unknown>;
}

/**
 * A new synthetic client in `org` with an active assignment for `caregiver`
 * and a current-month authorization of `minutes`. Keeps each test's cap usage
 * independent of every other test in the same database.
 */
export async function freshClient(
  db: TestDb,
  w: World,
  caregiver: Actor,
  minutes: number,
  org = w.orgA,
  periodDays?: { before: number; after: number },
) {
  const service = org === w.orgA ? w.serviceA : w.serviceB;
  const today = await orgToday(db);
  const client = (
    await db.admin.query<{ id: string }>(
      "insert into ogevia.clients (organization_id) values ($1) returning id",
      [org],
    )
  ).rows[0]!.id;
  await db.admin.query(
    "insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)",
    [org, caregiver.userId, client, service, today],
  );
  const auth = (
    await db.admin.query<{ id: string }>(
      `insert into ogevia.client_authorizations
       (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
     values ($1,$2,$3,'SYNTHETIC-PAYER',$4,
             case when $6::int is null then date_trunc('month', $5::date)::date else $5::date - $6::int end,
             case when $7::int is null then (date_trunc('month', $5::date) + interval '1 month - 1 day')::date
                  else $5::date + $7::int end) returning id`,
      [
        org,
        client,
        service,
        minutes,
        today,
        periodDays?.before ?? null,
        periodDays?.after ?? null,
      ],
    )
  ).rows[0]!.id;
  return { client, service, auth };
}
