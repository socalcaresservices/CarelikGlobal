// 0085. C08: a caregiver cannot be created directly as Approved/Active around the required-onboarding gate. D10: a visit that never happened (zero worked/billable, explicit
// release for a shift with no visit) is kept apart from actual work with a missing clock-out (worked time kept exactly, audited manager Time Out). SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
});
afterAll(async () => db?.drop());

const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const create = (status: string, last: string, key: string | null = null) =>
  q(w.managerA, "select * from ogevia_api.create_caregiver($1,'Synthetic',$2,null,$3,$4)", [w.orgA, last, status, key]);
const countByLast = async (last: string) => Number((await db.admin.query("select count(*) n from ogevia.caregiver_records where organization_id = $1 and last_name = $2", [w.orgA, last])).rows[0].n);

describe("C08 direct creation cannot bypass the required-onboarding gate", () => {
  it("'ready' and 'active' are refused with the outstanding items named, and nothing is created", async () => {
    for (const status of ["ready", "active"]) {
      const last = `Direct ${status} ${randomUUID().slice(0, 4)}`;
      await expectPgError(create(status, last), "OGC09", /Onboarding is not complete: Required training completed/);
      expect(await countByLast(last)).toBe(0);
    }
  });

  it("'applicant' and 'onboarding' are created as before; an applicant must complete the checklist and the status gate still applies", async () => {
    const a = (await create("applicant", `App ${randomUUID().slice(0, 4)}`))[0];
    const o = (await create("onboarding", `Onb ${randomUUID().slice(0, 4)}`))[0];
    expect(a.caregiver_record_id).toBeTruthy();
    expect(o.caregiver_record_id).toBeTruthy();
    await expectPgError(q(w.managerA, "select * from ogevia_api.set_caregiver_status($1,$2,'ready','Synthetic approval',null)", [w.orgA, a.caregiver_record_id]), "OGC09", /Use Approve for work/);
    // 0086: the one approval step names exactly what is still missing
    await expectPgError(q(w.managerA, "select ogevia_api.approve_caregiver_for_work($1,$2,null)", [w.orgA, a.caregiver_record_id]), "OGC09", /Cannot approve yet\. Waiting on: Background check, Required training, App sign-in/);
  });

  it("an agency with no required item outstanding can still create an Approved caregiver in one step (the gate follows the agency's own requirements)", async () => {
    await db.admin.query("update ogevia.onboarding_requirements set is_active = false where organization_id = $1", [w.orgA]);
    try {
      const last = `Direct ok ${randomUUID().slice(0, 4)}`;
      const row = (await create("ready", last))[0];
      expect(row.caregiver_record_id).toBeTruthy();
      expect(await countByLast(last)).toBe(1);
    } finally {
      await db.admin.query("update ogevia.onboarding_requirements set is_active = true where organization_id = $1 and category = 'training'", [w.orgA]);
    }
  });

  it("another agency's requirements do not decide this agency's creation (tenant scope)", async () => {
    await db.admin.query("update ogevia.onboarding_requirements set is_active = false where organization_id = $1", [w.orgB]);
    try {
      await expectPgError(create("active", `Tenant ${randomUUID().slice(0, 4)}`), "OGC09", /Onboarding is not complete/);
    } finally {
      await db.admin.query("update ogevia.onboarding_requirements set is_active = true where organization_id = $1 and category = 'training'", [w.orgB]);
    }
  });

  it("existing records are untouched: a record already Active without checklist items is still listed and can still be paused and re-approved as before", async () => {
    const id = (await db.admin.query(
      "insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1,'CG-EXIST85','Synthetic','Existing','active') returning id", [w.orgA])).rows[0].id as string;
    const listed = await q(w.managerA, "select * from ogevia_api.list_caregivers($1)", [w.orgA]);
    expect(listed.find((r) => r.caregiver_record_id === id)).toMatchObject({ status: "active" });
    await q(w.managerA, "select * from ogevia_api.set_caregiver_status($1,$2,'inactive','Synthetic pause',null)", [w.orgA, id]);
    // 0086: coming back is "Approve for work" (every hard requirement must be met again); the manual picker no longer sets Approved or Active
    await expectPgError(q(w.managerA, "select * from ogevia_api.set_caregiver_status($1,$2,'active','Synthetic return',null)", [w.orgA, id]), "OGC09", /Use Approve for work/);
  });
});

// ---- D10
type Fx = { client: string; service: string; auth: string; cg: Actor; lineage: string };
async function person(): Promise<Actor> {
  const sub = randomUUID();
  const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Pat Caregiver') returning id", [sub])).rows[0].id;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [w.orgA, userId]);
  await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,$3,'Synthetic','Pat')", [w.orgA, userId, "CG-" + sub.slice(0, 6)]);
  await db.admin.query(`insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at)
    select r.id, r.organization_id, 'completed', 'approved', 'Synthetic fixture clearance', $2, now() from ogevia.caregiver_records r where r.linked_user_id = $1 and r.organization_id = $3`, [userId, w.ownerA.userId, w.orgA]);
  return { userId, sub };
}
async function fx(minutes: number): Promise<Fx> {
  const cg = await person();
  const f = await freshClient(db, w, cg, minutes);
  const lineage = (await db.admin.query("select lineage_id from ogevia.client_authorizations where id = $1", [f.auth])).rows[0].lineage_id as string;
  return { ...f, cg, lineage };
}
const monthStart = () => `${today.slice(0, 7)}-01`;
const summary = async (f: Fx) => (await q(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1, $2::date, $3)", [w.orgA, monthStart(), f.client]))[0];
const visitRow = async (v: string) => (await db.admin.query("select status::text s, worked_minutes wk, billable_minutes b, time_out_entered_by tby, time_out_reason tr from ogevia.service_visits where id = $1", [v])).rows[0];
const audits = async (entity: string, action: string) => (await db.admin.query("select * from ogevia.audit_events where entity_id = $1 and action = $2 order by id", [entity, action])).rows;
const start = (f: Fx, aged: number) => api.start(db, f.cg, w.orgA, f.client, f.service, null, "Client asked for extra help (synthetic)").then(async (v) => { await ageVisit(db, v, aged); return v; });

describe("D10 a visit that never happened is not a visit with a missing clock-out", () => {
  it("started in error, no service delivered: voided with a reason -> zero worked, zero Pending, zero billable; the audit says no service was delivered; a repeated call is a no-op; only a visit manager may", async () => {
    const f = await fx(600);
    const v = await start(f, 10);
    await expectPgError(q(f.cg, "select ogevia_api.void_service_visit($1,'Started by mistake (synthetic)')", [v]), "OGA03", /Only an administrator can void/);
    await expectPgError(q(w.managerA, "select ogevia_api.void_service_visit($1,'   ')", [v]), "OGV22", /reason is required/);
    await q(w.managerA, "select ogevia_api.void_service_visit($1,'Started by mistake; no service delivered (synthetic)')", [v]);
    await q(w.managerA, "select ogevia_api.void_service_visit($1,'Started by mistake; no service delivered (synthetic)')", [v]); // lost response, retried
    expect(await visitRow(v)).toMatchObject({ s: "voided" });
    const s = await summary(f);
    expect(s).toMatchObject({ hours_pending_minutes: 0, hours_billable_minutes: 0, hours_over_limit_minutes: 0 });
    const ev = await audits(v, "service_visit.voided");
    expect(ev).toHaveLength(1);
    expect(ev[0].after_state).toMatchObject({ status: "voided", service_delivered: false });
  });

  it("an ended shift with no visit: 'no service delivered' is an explicit audited reconciliation that releases the reservation; nothing is worked or billable", async () => {
    const f = await fx(600);
    const rec = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [f.cg.userId, w.orgA])).rows[0].id as string;
    const shift = (await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
       select $1,$2,$3,$4,$5, now() - interval '3 hours', now() - interval '2 hours', 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.id = $6 returning id`,
      [w.orgA, f.client, f.service, f.cg.userId, rec, f.auth])).rows[0].id as string;
    await db.admin.query(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
      select $1, a.lineage_id, null, $2, $3::date, 60 from ogevia.client_authorizations a where a.id = $4`, [w.orgA, shift, today, f.auth]);
    expect(await summary(f)).toMatchObject({ hours_reserved_minutes: 60 });
    const res = await q(w.managerA, "select ogevia_api.reconcile_ended_shift($1,$2,'no_service_delivered','Called the client; no one came (synthetic)',null) as r", [w.orgA, shift]);
    expect(res[0].r).toMatchObject({ outcome: "no_service_delivered", released: true });
    expect(await summary(f)).toMatchObject({ hours_reserved_minutes: 0, hours_pending_minutes: 0, hours_billable_minutes: 0 });
    expect((await db.admin.query("select count(*) n from ogevia.service_visits where scheduled_shift_id = $1", [shift])).rows[0].n).toBe("0");
  });

  it("actual work with a missing clock-out: the manager's Time Out keeps the real worked minutes exactly, records who and why, is Pending (not billable) until confirmed", async () => {
    const f = await fx(600);
    const v = await start(f, 90);
    const closed = await q(w.managerA, "select * from ogevia_api.close_missed_service_visit($1, now() - interval '30 minutes', 'Caregiver forgot to end; client confirmed she left 30 minutes ago (synthetic)', null)", [v]);
    expect(closed[0].worked_minutes).toBe(60);
    const row = await visitRow(v);
    expect(row).toMatchObject({ s: "awaiting_signature", wk: 60, b: null, tby: w.managerA.userId });
    expect(row.tr).toMatch(/forgot to end/);
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 60, hours_billable_minutes: 0 });
    const ev = await audits(v, "service_visit.closed_by_manager");
    expect(ev).toHaveLength(1);
    expect(ev[0].before_state).toMatchObject({ status: "draft" });
    expect(ev[0].after_state).toMatchObject({ status: "awaiting_signature", worked_minutes: 60, time_out_entered_by: w.managerA.userId });
    expect(ev[0].reason).toMatch(/forgot to end/);
  });

  it("a signed (confirmed) visit can never be zeroed by 'no service delivered': it needs a correction", async () => {
    const f = await fx(600);
    const v = await start(f, 40);
    await api.end(db, f.cg, v);
    await api.confirm(db, f.cg, v, { method: "draw", evidence: await api.registerEvidence(db, f.cg, w.orgA, v) });
    expect((await visitRow(v)).s).toMatch(/signed|administrator_review/);
    await expectPgError(q(w.managerA, "select ogevia_api.void_service_visit($1,'Trying to erase worked time (synthetic)')", [v]), "OGC09", /cannot be voided/);
  });
});
