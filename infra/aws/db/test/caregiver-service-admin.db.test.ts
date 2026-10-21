// 0023 Care Team (caregiver records) and service administration. SYNTHETIC
// data only. Every call runs as the application role through begin_request.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

const q = async <T = any>(a: Actor, sql: string, params: unknown[] = []) =>
  asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const audit = (entity: string, action: string) =>
  db.admin.query("select * from ogevia.audit_events where entity_id = $1 and action = $2 order by id", [entity, action]).then((r) => r.rows);
// Since 0085 the API refuses to create an Approved/Active caregiver around the onboarding gate; a fixture that needs one creates it as onboarding and sets the status directly.
const createCaregiver = async (a: Actor, first: string, last: string, status = "onboarding", key: string | null = null, org = w.orgA) => {
  const direct = status === "ready" || status === "active";
  const row = await q<{ caregiver_record_id: string; caregiver_code: string }>(a, "select * from ogevia_api.create_caregiver($1, $2, $3, null, $4, $5)", [org, first, last, direct ? "onboarding" : status, key]).then((r) => r[0]!);
  if (direct) await db.admin.query("update ogevia.caregiver_records set status = $2, onboarding_required = false where id = $1", [row.caregiver_record_id, status]);
  return row;
};

/** A synthetic caregiver with a sign-in, a record and an active assignment to clientA1 (authorized for serviceA). */
async function linkedCaregiver(): Promise<Actor & { record: string }> {
  const sub = crypto.randomUUID();
  const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Caregiver') returning id", [sub])).rows[0].id;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1, $2, 'caregiver', 'active')", [w.orgA, userId]);
  const record = (await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1, $2, $3, 'Synthetic', $3) returning id",
    [w.orgA, userId, "UT-" + sub.slice(0, 8)])).rows[0].id;
  await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1, $2, $3, $4, $5::date - 10)",
    [w.orgA, userId, w.clientA1, w.serviceA, await orgToday(db)]);
  return { userId, sub, record };
}

describe("Care Team records", () => {
  it("manager adds a caregiver with a random code; audited; a retry returns the same record; list shows no sign-in yet", async () => {
    const key = crypto.randomUUID();
    const c = await createCaregiver(w.managerA, " Synthetic ", "Caregiver Juno", "onboarding", key);
    expect(c.caregiver_code).toMatch(/^CG-[0-9A-F]{8}$/);
    expect(await createCaregiver(w.managerA, " Synthetic ", "Caregiver Juno", "onboarding", key)).toEqual(c);
    const row = (await q(w.managerA, "select * from ogevia_api.list_caregivers($1)", [w.orgA])).find((r) => r.caregiver_record_id === c.caregiver_record_id);
    expect(row).toMatchObject({ first_name: "Synthetic", last_name: "Caregiver Juno", status: "onboarding", has_sign_in: false, sign_in_status: null, active_assignments: 0 });
    expect(await audit(c.caregiver_record_id, "caregiver.created")).toHaveLength(1);
  });

  it("refuses bad names, starting as inactive, and people without caregivers.manage; other agencies see nothing", async () => {
    await expectPgError(createCaregiver(w.managerA, "", "X"), "OGV22");
    await expectPgError(createCaregiver(w.managerA, "A", "B", "inactive"), "OGV22");
    await expectPgError(createCaregiver(w.schedulerA, "A", "B"), "OGA03");
    await expectPgError(createCaregiver(w.caregiverA1, "A", "B"), "OGA03");
    await expectPgError(createCaregiver(w.managerB, "A", "B"), "OGN04");
    expect(await q(w.caregiverA1, "select * from ogevia_api.list_caregivers($1)", [w.orgA])).toEqual([]);
    expect(await q(w.managerB, "select * from ogevia_api.list_caregivers($1)", [w.orgA])).toEqual([]);
  });

  it("rename keeps before/after in the audit trail and never rewrites past visit snapshots", async () => {
    const c = await createCaregiver(w.ownerA, "Synthetic", "Caregiver Kai", "active");
    await q(w.managerA, "select ogevia_api.update_caregiver($1, $2, 'Synthetic', 'Caregiver Kailani', 'Kai')", [w.orgA, c.caregiver_record_id]);
    const [a] = await audit(c.caregiver_record_id, "caregiver.updated");
    expect(a.before_state).toMatchObject({ last_name: "Caregiver Kai", preferred_name: null });
    expect(a.after_state).toMatchObject({ last_name: "Caregiver Kailani", preferred_name: "Kai" });
    await expectPgError(q(w.managerB, "select ogevia_api.update_caregiver($1, $2, 'A', 'B')", [w.orgB, c.caregiver_record_id]), "OGN04");
  });

  it("inactive ends active assignments and suspends the caregiver sign-in at once; reactivation restores the sign-in only", async () => {
    const cg = await linkedCaregiver();
    expect((await q(cg, "select * from ogevia_api.list_assigned_visit_clients($1)", [w.orgA])).length).toBeGreaterThan(0);
    await expectPgError(q(w.managerA, "select * from ogevia_api.set_caregiver_status($1, $2, 'inactive', ' ')", [w.orgA, cg.record]), "OGV22");
    const [r] = await q(w.managerA, "select * from ogevia_api.set_caregiver_status($1, $2, 'inactive', 'Left the agency (synthetic)')", [w.orgA, cg.record]);
    expect(r).toMatchObject({ ended_assignments: 1, sign_in_status: "suspended" });
    // Access is gone immediately: no clients, no visit start.
    expect(await q(cg, "select * from ogevia_api.list_assigned_visit_clients($1)", [w.orgA])).toEqual([]);
    await expectPgError(api.start(db, cg, w.orgA, w.clientA1, w.serviceA), "OGA03");
    const [a] = await audit(cg.record, "caregiver.status_changed");
    expect(a).toMatchObject({ reason: "Left the agency (synthetic)", after_state: { status: "inactive", ended_assignments: 1, sign_in_status: "suspended" } });
    const [back] = await q(w.managerA, "select * from ogevia_api.set_caregiver_status($1, $2, 'active', 'Rehired (synthetic)')", [w.orgA, cg.record]);
    expect(back).toMatchObject({ ended_assignments: 0, sign_in_status: "active" });
    const row = (await q(w.managerA, "select * from ogevia_api.list_caregivers($1)", [w.orgA])).find((x) => x.caregiver_record_id === cg.record);
    expect(row).toMatchObject({ status: "active", sign_in_status: "active", active_assignments: 0 });
  });

  it("inactive is refused while the caregiver has a visit in progress", async () => {
    const cg = await linkedCaregiver();
    expect(await api.start(db, cg, w.orgA, w.clientA1, w.serviceA)).toBeTruthy();
    await expectPgError(q(w.managerA, "select * from ogevia_api.set_caregiver_status($1, $2, 'inactive', 'Left (synthetic)')", [w.orgA, cg.record]), "OGC09", /in progress/);
  });
});

describe("services (Administrator only)", () => {
  it("Administrator adds a service (code normalised, unique per agency, any case); managers cannot", async () => {
    const [{ id }] = await q(w.ownerA, "select ogevia_api.create_service($1, ' pcs-2 ', 'Synthetic Personal Care') as id", [w.orgA]);
    const list = await q(w.managerA, "select * from ogevia_api.list_services($1)", [w.orgA]);
    expect(list.find((s) => s.service_id === id)).toMatchObject({ code: "PCS-2", name: "Synthetic Personal Care", is_active: true });
    await expectPgError(q(w.ownerA, "select ogevia_api.create_service($1, 'Pcs-2', 'Duplicate')", [w.orgA]), "OGC09");
    await expectPgError(q(w.ownerA, "select ogevia_api.create_service($1, 'bad code!', 'X service')", [w.orgA]), "OGV22");
    await expectPgError(q(w.managerA, "select ogevia_api.create_service($1, 'MGR', 'Manager service')", [w.orgA]), "OGA03", /Administrator/);
    expect(await audit(id, "service.created")).toHaveLength(1);
  });

  it("rename is audited; deactivation is refused while a current authorization uses the service; reactivation works", async () => {
    await q(w.ownerA, "select ogevia_api.rename_service($1, $2, 'Synthetic Respite (renamed)')", [w.orgA, w.serviceA]);
    const [r] = await audit(w.serviceA, "service.renamed");
    expect(r.after_state).toEqual({ name: "Synthetic Respite (renamed)" });
    await expectPgError(q(w.ownerA, "select ogevia_api.set_service_active($1, $2, false, 'No longer offered')", [w.orgA, w.serviceA]), "OGC09", /current authorizations/);
    const [{ id }] = await q(w.ownerA, "select ogevia_api.create_service($1, 'TMP', 'Synthetic Temporary') as id", [w.orgA]);
    await expectPgError(q(w.ownerA, "select ogevia_api.set_service_active($1, $2, false, '')", [w.orgA, id]), "OGV22");
    await q(w.ownerA, "select ogevia_api.set_service_active($1, $2, false, 'Not offered (synthetic)')", [w.orgA, id]);
    expect((await q(w.ownerA, "select * from ogevia_api.list_services($1)", [w.orgA])).find((s) => s.service_id === id)).toMatchObject({ is_active: false });
    // An inactive service cannot be used for a new authorization.
    const client = (await q<{ client_id: string }>(w.managerA, "select * from ogevia_api.create_client($1, 'Synthetic', 'Client Svc')", [w.orgA]))[0]!.client_id;
    await expectPgError(q(w.managerA, "select ogevia_api.create_client_authorization($1, $2, $3, 'Payer', 600, '2026-10-01'::date, '2026-10-31'::date)", [w.orgA, client, id]), "OGV22");
    await q(w.ownerA, "select ogevia_api.set_service_active($1, $2, true, 'Offered again (synthetic)')", [w.orgA, id]);
    expect(await audit(id, "service.reactivated")).toHaveLength(1);
    await expectPgError(q(w.managerB, "select ogevia_api.rename_service($1, $2, 'X service')", [w.orgB, w.serviceA]), "OGA03");
  });
});
