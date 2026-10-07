// 0022 Client and authorization administration. SYNTHETIC data only. Every
// call runs as the application role through begin_request, like the API.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

const q = async <T = any>(a: Actor, sql: string, params: unknown[] = []) =>
  asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);

const createClient = (a: Actor, org: string, first: string, last: string, extra: { city?: string | null; type?: string | null; label?: string | null; key?: string | null } = {}) =>
  q<{ client_id: string; client_code: string }>(a, "select * from ogevia_api.create_client($1, $2, $3, $4, $5, $6, $7)",
    [org, first, last, extra.city ?? null, extra.type ?? null, extra.label ?? null, extra.key ?? null]).then((r) => r[0]!);

const createAuth = (a: Actor, client: string, opts: { start: string; end: string; minutes?: number; rate?: number | null; service?: string; key?: string | null; org?: string }) =>
  q<{ id: string }>(a, "select ogevia_api.create_client_authorization($1, $2, $3, 'Synthetic Payer', $4, $5::date, $6::date, 'SYN-123', null, null, $7, $8) as id",
    [opts.org ?? w.orgA, client, opts.service ?? w.serviceA, opts.minutes ?? 1200, opts.start, opts.end, opts.rate ?? null, opts.key ?? null]).then((r) => r[0]!.id);

const audit = (entity: string, action: string) =>
  db.admin.query("select * from ogevia.audit_events where entity_id = $1 and action = $2 order by id", [entity, action]).then((r) => r.rows);

describe("client types", () => {
  it("manager creates agency-specific types; duplicates (any case) refused; caregivers and other agencies cannot", async () => {
    const [{ id }] = await q(w.managerA, "select ogevia_api.create_client_type($1, 'Respite') as id", [w.orgA]);
    await expectPgError(q(w.managerA, "select ogevia_api.create_client_type($1, ' respite ')", [w.orgA]), "OGC09");
    await expectPgError(q(w.caregiverA1, "select ogevia_api.create_client_type($1, 'X')", [w.orgA]), "OGA03");
    await expectPgError(q(w.managerB, "select ogevia_api.create_client_type($1, 'X')", [w.orgA]), "OGN04");
    const types = await q(w.managerA, "select * from ogevia_api.list_client_types($1)", [w.orgA]);
    expect(types.map((t) => t.client_type_id)).toContain(id);
    expect(await q(w.managerB, "select * from ogevia_api.list_client_types($1)", [w.orgA])).toEqual([]);
  });
});

describe("clients", () => {
  it("manager creates a client with a random code, names, city and type; audited; a retry returns the same client", async () => {
    const [{ id: type }] = await q(w.managerA, "select ogevia_api.create_client_type($1, 'Personal assistance') as id", [w.orgA]);
    const key = crypto.randomUUID();
    const c = await createClient(w.managerA, w.orgA, " Synthetic ", "Client Delta", { city: "Riverside", type, key });
    expect(c.client_code).toMatch(/^CL-[0-9A-F]{10}$/);
    const again = await createClient(w.managerA, w.orgA, " Synthetic ", "Client Delta", { city: "Riverside", type, key });
    expect(again).toEqual(c);
    const row = (await q(w.managerA, "select * from ogevia_api.list_clients($1)", [w.orgA])).find((r) => r.client_id === c.client_id);
    expect(row).toMatchObject({ legal_first_name: "Synthetic", legal_last_name: "Client Delta", city: "Riverside",
      client_type_id: type, client_type_name: "Personal assistance", status: "active", current_authorizations: 0 });
    expect(await audit(c.client_id, "client.created")).toHaveLength(1);
  });

  it("names and city are hidden from roles without clients.names.read; caregivers and other agencies see nothing", async () => {
    const c = await createClient(w.ownerA, w.orgA, "Synthetic", "Client Echo", { city: "Ontario" });
    const sched = (await q(w.schedulerA, "select * from ogevia_api.list_clients($1)", [w.orgA])).find((r) => r.client_id === c.client_id);
    expect(sched).toMatchObject({ legal_first_name: null, legal_last_name: null, city: null, client_code: c.client_code });
    expect(await q(w.caregiverA1, "select * from ogevia_api.list_clients($1)", [w.orgA])).toEqual([]);
    expect(await q(w.managerB, "select * from ogevia_api.list_clients($1)", [w.orgA])).toEqual([]);
  });

  it("refuses bad input, foreign client types, duplicate caregiver labels and roles without clients.manage", async () => {
    await expectPgError(createClient(w.managerA, w.orgA, "", "X"), "OGV22");
    await expectPgError(createClient(w.managerA, w.orgA, "A", "B", { label: "ab" }), "OGV22");
    const [{ id: typeB }] = await q(w.managerB, "select ogevia_api.create_client_type($1, 'Other agency type') as id", [w.orgB]);
    await expectPgError(createClient(w.managerA, w.orgA, "A", "B", { type: typeB }), "OGV22", /active client types/);
    await createClient(w.managerA, w.orgA, "Synthetic", "Label One", { label: "Blue Door" });
    await expectPgError(createClient(w.managerA, w.orgA, "Synthetic", "Label Two", { label: "blue door" }), "OGC09");
    await expectPgError(createClient(w.schedulerA, w.orgA, "A", "B"), "OGA03");
    await expectPgError(createClient(w.caregiverA1, w.orgA, "A", "B"), "OGA03");
    await expectPgError(createClient(w.managerB, w.orgA, "A", "B"), "OGN04");
  });

  it("update keeps before/after in the audit trail", async () => {
    const c = await createClient(w.managerA, w.orgA, "Synthetic", "Client Fox", { city: "Corona" });
    await q(w.managerA, "select ogevia_api.update_client($1, $2, 'Synthetic', 'Client Foxtrot', 'Norco', null, null, null)", [w.orgA, c.client_id]);
    const [a] = await audit(c.client_id, "client.updated");
    expect(a.before_state).toMatchObject({ legal_last_name: "Client Fox", city: "Corona" });
    expect(a.after_state).toMatchObject({ legal_last_name: "Client Foxtrot", city: "Norco" });
    await expectPgError(q(w.managerB, "select ogevia_api.update_client($1, $2, 'A', 'B', null, null, null, null)", [w.orgB, c.client_id]), "OGN04");
  });

  it("status change needs a reason, is audited, and is refused while a visit is in progress", async () => {
    await expectPgError(q(w.managerA, "select ogevia_api.set_client_status($1, $2, 'inactive', '  ')", [w.orgA, w.clientA2]), "OGV22");
    const visit = await api.start(db, w.caregiverA1, w.orgA, w.clientA1, w.serviceA);
    expect(visit).toBeTruthy();
    await expectPgError(q(w.managerA, "select ogevia_api.set_client_status($1, $2, 'inactive', 'Moved away')", [w.orgA, w.clientA1]), "OGC09", /in progress/);
    const c = await createClient(w.managerA, w.orgA, "Synthetic", "Client Golf");
    await q(w.managerA, "select ogevia_api.set_client_status($1, $2, 'discharged', 'Services ended')", [w.orgA, c.client_id]);
    const [a] = await audit(c.client_id, "client.status_changed");
    expect(a).toMatchObject({ reason: "Services ended", before_state: { status: "active" }, after_state: { status: "discharged" } });
    await expectPgError(q(w.managerA, "select ogevia_api.set_client_status($1, $2, 'discharged', 'Again')", [w.orgA, c.client_id]), "OGC09");
  });
});

describe("authorizations", () => {
  it("creates version 1; overlapping coverage for the same service is refused with 'amend instead'; a later period is allowed", async () => {
    const c = await createClient(w.managerA, w.orgA, "Synthetic", "Client Hotel");
    const a1 = await createAuth(w.managerA, c.client_id, { start: "2026-10-01", end: "2026-12-31" });
    await expectPgError(createAuth(w.managerA, c.client_id, { start: "2026-12-01", end: "2027-02-28" }), "OGC09", /amend that one instead/);
    await createAuth(w.managerA, c.client_id, { start: "2027-01-01", end: "2027-03-31" });
    const rows = await q(w.managerA, "select * from ogevia_api.list_client_authorizations($1, $2)", [w.orgA, c.client_id]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.authorization_id === a1)).toMatchObject({ version_number: 1, is_current: true, monthly_authorized_minutes: 1200, payer: "Synthetic Payer" });
    expect(await audit(a1, "client_authorization.created")).toHaveLength(1);
  });

  it("validates minutes (catches hours typed as minutes), dates and the service", async () => {
    const c = await createClient(w.managerA, w.orgA, "Synthetic", "Client India");
    await expectPgError(createAuth(w.managerA, c.client_id, { start: "2026-10-01", end: "2026-10-31", minutes: 0 }), "OGV22");
    await expectPgError(createAuth(w.managerA, c.client_id, { start: "2026-10-01", end: "2026-10-31", minutes: 60 * 800 }), "OGV22");
    await expectPgError(createAuth(w.managerA, c.client_id, { start: "2026-10-31", end: "2026-10-01" }), "OGV22");
    await expectPgError(createAuth(w.managerA, c.client_id, { start: "2026-10-01", end: "2026-10-31", service: w.serviceB }), "OGV22");
  });

  it("only the Administrator sets a rate and only billing.read sees it", async () => {
    const c = await createClient(w.managerA, w.orgA, "Synthetic", "Client Juliet");
    await expectPgError(createAuth(w.managerA, c.client_id, { start: "2026-10-01", end: "2026-10-31", rate: 3000 }), "OGA03", /Administrator/);
    const a = await createAuth(w.ownerA, c.client_id, { start: "2026-10-01", end: "2026-10-31", rate: 3000 });
    const asOwner = (await q(w.ownerA, "select * from ogevia_api.list_client_authorizations($1, $2)", [w.orgA, c.client_id]))[0];
    const asManager = (await q(w.managerA, "select * from ogevia_api.list_client_authorizations($1, $2)", [w.orgA, c.client_id]))[0];
    expect(asOwner).toMatchObject({ authorization_id: a, hourly_rate_cents: 3000 });
    expect(asManager).toMatchObject({ authorization_id: a, hourly_rate_cents: null });
    expect(await q(w.caregiverA1, "select * from ogevia_api.list_client_authorizations($1, $2)", [w.orgA, c.client_id])).toEqual([]);
    expect(await q(w.managerB, "select * from ogevia_api.list_client_authorizations($1, $2)", [w.orgA, c.client_id])).toEqual([]);
    const [audited] = await audit(a, "client_authorization.created");
    expect(JSON.stringify(audited.after_state)).not.toContain("3000");
  });

  it("an amendment keeps the history, carries the rate forward, and the monthly summary uses the new cap", async () => {
    const c = await createClient(w.managerA, w.orgA, "Synthetic", "Client Kilo");
    const month = "2026-11-01";
    const a = await createAuth(w.ownerA, c.client_id, { start: "2026-11-01", end: "2026-11-30", minutes: 1800, rate: 2500 });
    const [amended] = await q(w.managerA,
      "select * from ogevia_api.amend_client_authorization($1, 2400, '2026-11-01'::date, '2026-11-30'::date, 'Synthetic Payer', 'Amendment received', 'SYN-123')", [a]);
    const rows = await q(w.ownerA, "select * from ogevia_api.list_client_authorizations($1, $2)", [w.orgA, c.client_id]);
    expect(rows.map((r) => [r.version_number, r.is_current, r.monthly_authorized_minutes, r.hourly_rate_cents])).toEqual([[2, true, 2400, 2500], [1, false, 1800, 2500]]);
    expect(rows[0].authorization_id).toBe(amended.new_authorization_id);
    const [summary] = await q(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1, $2::date, $3)", [w.orgA, month, c.client_id]);
    expect(summary).toMatchObject({ authorized_minutes: 2400, remaining_minutes: 2400 });
  });

  it("two simultaneous creations of overlapping coverage: exactly one succeeds", async () => {
    const c = await createClient(w.managerA, w.orgA, "Synthetic", "Client Lima");
    const results = await Promise.allSettled([
      createAuth(w.managerA, c.client_id, { start: "2026-10-01", end: "2026-12-31" }),
      createAuth(w.ownerA, c.client_id, { start: "2026-11-01", end: "2027-01-31" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("OGC09");
    expect(await q(w.managerA, "select * from ogevia_api.list_client_authorizations($1, $2)", [w.orgA, c.client_id])).toHaveLength(1);
  });

  it("a retry with the same idempotency key returns the same authorization, not a duplicate", async () => {
    const c = await createClient(w.managerA, w.orgA, "Synthetic", "Client Mike");
    const key = crypto.randomUUID();
    const a = await createAuth(w.managerA, c.client_id, { start: "2026-10-01", end: "2026-10-31", key });
    expect(await createAuth(w.managerA, c.client_id, { start: "2026-10-01", end: "2026-10-31", key })).toBe(a);
  });
});
