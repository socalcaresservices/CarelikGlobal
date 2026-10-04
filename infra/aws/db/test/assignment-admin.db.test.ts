// 0024 Assignment administration. SYNTHETIC data only. Every call runs as the
// application role through begin_request.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
});
afterAll(async () => db?.drop());

const q = async <T = any>(a: Actor, sql: string, params: unknown[] = []) =>
  asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const assign = (a: Actor, record: string, client: string, service: string, start: string, end: string | null = null, key: string | null = null, org = w.orgA) =>
  q<{ assignment_id: string; has_authorization: boolean }>(a, "select * from ogevia_api.create_assignment($1, $2, $3, $4, $5::date, $6::date, $7)",
    [org, record, client, service, start, end, key]).then((r) => r[0]!);
const endIt = (a: Actor, id: string, end: string | null, reason = "Schedule change (synthetic)") =>
  q<{ end_assignment: string }>(a, "select ogevia_api.end_assignment($1, $2, $3::date, $4)", [w.orgA, id, end, reason]).then((r) => r[0]!.end_assignment);
const myClients = (cg: Actor) => q<{ client_id: string }>(cg, "select * from ogevia_api.list_assigned_visit_clients($1)", [w.orgA]).then((r) => r.map((x) => x.client_id));

/** A synthetic caregiver with a sign-in and an active Care Team record, but no assignment. */
async function caregiver(): Promise<Actor & { record: string }> {
  const sub = crypto.randomUUID();
  const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Caregiver') returning id", [sub])).rows[0].id;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1, $2, 'caregiver', 'active')", [w.orgA, userId]);
  const record = (await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1, $2, $3, 'Synthetic', $3) returning id",
    [w.orgA, userId, "AS-" + sub.slice(0, 8)])).rows[0].id;
  return { userId, sub, record };
}

describe("assignments", () => {
  it("manager assigns a caregiver: access starts, authorization coverage is reported, audited, listed with state", async () => {
    const cg = await caregiver();
    expect(await myClients(cg)).not.toContain(w.clientA1);
    const a = await assign(w.managerA, cg.record, w.clientA1, w.serviceA, today);
    expect(a.has_authorization).toBe(true);
    expect(await myClients(cg)).toContain(w.clientA1);
    expect(await api.start(db, cg, w.orgA, w.clientA1, w.serviceA)).toBeTruthy();
    const rows = await q(w.managerA, "select * from ogevia_api.list_assignments($1, $2, null)", [w.orgA, w.clientA1]);
    expect(rows.find((r) => r.assignment_id === a.assignment_id)).toMatchObject({ caregiver_record_id: cg.record, state: "current", has_authorization: true, effective_end: null });
    const audit = (await db.admin.query("select * from ogevia.audit_events where entity_id = $1 and action = 'assignment.created'", [a.assignment_id])).rows;
    expect(audit).toHaveLength(1);
  });

  it("an assignment without authorization coverage is added but reported as uncovered", async () => {
    const cg = await caregiver();
    const a = await assign(w.ownerA, cg.record, w.clientA2, w.serviceA, today);
    expect(a.has_authorization).toBe(false);
  });

  it("overlapping assignments of the same caregiver to the same client and service are refused; back-to-back is fine", async () => {
    const cg = await caregiver();
    await assign(w.managerA, cg.record, w.clientA1, w.serviceA, today, day(10));
    await expectPgError(assign(w.managerA, cg.record, w.clientA1, w.serviceA, day(5), null), "OGC09", /already assigned/);
    await expectPgError(assign(w.managerA, cg.record, w.clientA1, w.serviceA, day(10), day(20)), "OGC09");
    const next = await assign(w.managerA, cg.record, w.clientA1, w.serviceA, day(11), day(20));
    const row = (await q(w.managerA, "select * from ogevia_api.list_assignments($1, null, $2)", [w.orgA, cg.record])).find((r) => r.assignment_id === next.assignment_id);
    expect(row).toMatchObject({ state: "upcoming" });
  });

  it("refuses inactive clients, already-ended dates and people without assignments.manage", async () => {
    const [noLogin] = await q<{ caregiver_record_id: string }>(w.managerA, "select * from ogevia_api.create_caregiver($1, 'Synthetic', 'No Login', null, 'active')", [w.orgA]);
    // Since 0025 a caregiver without a sign-in can be assigned (planned, no access).
    expect(await assign(w.managerA, noLogin!.caregiver_record_id, w.clientA1, w.serviceA, today)).toMatchObject({ grants_access: false });
    const cg = await caregiver();
    const [inactive] = await q<{ client_id: string }>(w.managerA, "select * from ogevia_api.create_client($1, 'Synthetic', 'Client Paused')", [w.orgA]);
    await q(w.managerA, "select ogevia_api.set_client_status($1, $2, 'inactive', 'Paused (synthetic)')", [w.orgA, inactive!.client_id]);
    await expectPgError(assign(w.managerA, cg.record, inactive!.client_id, w.serviceA, today), "OGV22", /client must be active/);
    await expectPgError(assign(w.managerA, cg.record, w.clientA1, w.serviceA, day(-10), day(-1)), "OGV22", /already ended/);
    await expectPgError(assign(w.managerA, cg.record, w.clientA1, w.serviceA, day(5), day(1)), "OGV22");
    await expectPgError(assign(w.schedulerA, cg.record, w.clientA1, w.serviceA, today), "OGA03");
    await expectPgError(assign(w.caregiverA1, cg.record, w.clientA1, w.serviceA, today), "OGA03");
    await expectPgError(assign(w.managerB, cg.record, w.clientA1, w.serviceA, today, null, null, w.orgA), "OGN04");
    expect(await q(w.managerB, "select * from ogevia_api.list_assignments($1)", [w.orgA])).toEqual([]);
    expect(await q(w.caregiverA1, "select * from ogevia_api.list_assignments($1)", [w.orgA])).toEqual([]);
  });

  it("ending: a running assignment ends after its last day (access stops), a future one is cancelled; history is kept", async () => {
    const cg = await caregiver();
    const running = await assign(w.managerA, cg.record, w.clientA1, w.serviceA, day(-5));
    await expectPgError(endIt(w.managerA, running.assignment_id, day(-1), " "), "OGV22");
    await expectPgError(endIt(w.managerA, running.assignment_id, day(-6)), "OGV22");
    expect(await endIt(w.managerA, running.assignment_id, day(-1))).toBe("ended");
    expect(await myClients(cg)).not.toContain(w.clientA1);
    await expectPgError(endIt(w.managerA, running.assignment_id, day(-1)), "OGC09", /already ended/);
    const future = await assign(w.managerA, cg.record, w.clientA1, w.serviceA, day(3), day(9));
    expect(await endIt(w.managerA, future.assignment_id, null)).toBe("cancelled");
    const rows = await q(w.managerA, "select * from ogevia_api.list_assignments($1, null, $2)", [w.orgA, cg.record]);
    expect(rows.map((r) => r.state).sort()).toEqual(["ended", "ended"]);
    const audit = (await db.admin.query("select reason, after_state from ogevia.audit_events where entity_id = $1 and action = 'assignment.ended'", [running.assignment_id])).rows;
    expect(audit[0]).toMatchObject({ reason: "Schedule change (synthetic)", after_state: { outcome: "ended" } });
  });

  it("ending before today is refused while a visit is in progress; ending today (last day) is allowed; only shortening", async () => {
    const cg = await caregiver();
    const a = await assign(w.managerA, cg.record, w.clientA1, w.serviceA, day(-3), day(30));
    expect(await api.start(db, cg, w.orgA, w.clientA1, w.serviceA)).toBeTruthy();
    await expectPgError(endIt(w.managerA, a.assignment_id, day(-1)), "OGC09", /in progress/);
    await expectPgError(endIt(w.managerA, a.assignment_id, day(31)), "OGV22", /extend/);
    expect(await endIt(w.managerA, a.assignment_id, today)).toBe("ends_later");
    expect(await myClients(cg)).toContain(w.clientA1);
  });

  it("two simultaneous identical assignments: exactly one is created; a retry with the same key returns the same one", async () => {
    const cg = await caregiver();
    const results = await Promise.allSettled([
      assign(w.managerA, cg.record, w.clientA1, w.serviceA, today),
      assign(w.ownerA, cg.record, w.clientA1, w.serviceA, today),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("OGC09");
    const cg2 = await caregiver();
    const key = crypto.randomUUID();
    const first = await assign(w.managerA, cg2.record, w.clientA1, w.serviceA, today, null, key);
    expect(await assign(w.managerA, cg2.record, w.clientA1, w.serviceA, today, null, key)).toEqual(first);
  });
});
