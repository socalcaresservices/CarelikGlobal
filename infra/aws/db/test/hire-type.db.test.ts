// 0030 Caregiver hire type, scheduling mode and family relationship; flexible
// (EOR) visits without a shift vs Direct Hire visits from a scheduled shift;
// readable billing review rows. SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
const rec: Record<string, string> = {};
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
});
afterAll(async () => db?.drop());

const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const setEmployment = (a: Actor, record: string, hire: string | null, mode: string | null, org = w.orgA) =>
  q(a, "select * from ogevia_api.set_caregiver_employment($1, $2, $3, $4, 'Synthetic', null)", [org, record, hire, mode]).then((r) => r[0]);
const caregivers = (a: Actor = w.managerA) => q(a, "select * from ogevia_api.list_caregivers($1)", [w.orgA]);
const review = (a: Actor = w.managerA) =>
  q(a, "select * from ogevia_api.list_billing_review_visits($1, (now() at time zone 'America/Los_Angeles')::date - 1, (now() at time zone 'America/Los_Angeles')::date + 1)", [w.orgA]);

describe("inventory and defaults", () => {
  it("existing Care Team records keep every value: hire type not recorded, scheduling fixed, relationship not recorded", async () => {
    const rows = await caregivers();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toMatchObject({ hire_type: null, scheduling_mode: "fixed" });
    const rel = (await db.admin.query("select count(*)::int n from ogevia.caregiver_assignments where family_relationship is not null")).rows[0].n;
    expect(rel).toBe(0);
  });
});

describe("separate fields", () => {
  it("a manager records Direct Hire + fixed and EOR + flexible; audited; others refused; invalid values refused", async () => {
    expect(await setEmployment(w.managerA, rec["CG-A1"]!, "direct_hire", "fixed")).toMatchObject({ hire_type: "direct_hire", scheduling_mode: "fixed" });
    expect(await setEmployment(w.managerA, rec["CG-A2"]!, "eor", "flexible")).toMatchObject({ hire_type: "eor", scheduling_mode: "flexible" });
    const rows = await caregivers();
    expect(rows.find((r) => r.caregiver_record_id === rec["CG-A2"])).toMatchObject({ hire_type: "eor", scheduling_mode: "flexible" });
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where action = 'caregiver.employment_set'")).rows[0].n).toBe(2);
    await expectPgError(setEmployment(w.caregiverA1, rec["CG-A1"]!, "eor", "fixed"), "OGA03");
    await expectPgError(setEmployment(w.schedulerA, rec["CG-A1"]!, "eor", "fixed"), "OGA03");
    await expectPgError(setEmployment(w.managerB, rec["CG-A1"]!, "eor", "fixed"), "OGN04");
    await expectPgError(setEmployment(w.managerB, rec["CG-A1"]!, "eor", "fixed", w.orgB), "OGN04", /Care Team member not found/);
    await expectPgError(setEmployment(w.managerA, rec["CG-A1"]!, "family", "fixed"), "OGV22", /Hire type/);
    await expectPgError(setEmployment(w.managerA, rec["CG-A1"]!, "direct_hire", "sometimes"), "OGV22", /fixed .* or flexible/);
  });

  it("family relationship is per client assignment and independent of hire type (EOR is not automatically family)", async () => {
    const assignments = await q(w.managerA, "select * from ogevia_api.list_assignments($1, null, null)", [w.orgA]);
    const a2 = assignments.find((a) => a.caregiver_record_id === rec["CG-A2"])!;
    const a1 = assignments.find((a) => a.caregiver_record_id === rec["CG-A1"])!;
    expect(a2.family_relationship).toBeNull();
    // EOR caregiver who is NOT family; Direct Hire caregiver who IS family.
    await q(w.managerA, "select * from ogevia_api.set_assignment_family_relationship($1, $2, 'none', null)", [w.orgA, a2.assignment_id]);
    await q(w.managerA, "select * from ogevia_api.set_assignment_family_relationship($1, $2, 'parent', null)", [w.orgA, a1.assignment_id]);
    const after = await q(w.managerA, "select * from ogevia_api.list_assignments($1, null, null)", [w.orgA]);
    expect(after.find((a) => a.assignment_id === a2.assignment_id).family_relationship).toBe("none");
    expect(after.find((a) => a.assignment_id === a1.assignment_id).family_relationship).toBe("parent");
    expect((await caregivers()).find((r) => r.caregiver_record_id === rec["CG-A2"]).hire_type).toBe("eor");
    await expectPgError(q(w.managerA, "select * from ogevia_api.set_assignment_family_relationship($1, $2, 'cousin-ish', null)", [w.orgA, a1.assignment_id]), "OGV22");
    await expectPgError(q(w.caregiverA1, "select * from ogevia_api.set_assignment_family_relationship($1, $2, 'none', null)", [w.orgA, a1.assignment_id]), "OGA03");
  });
});

describe("Direct Hire with a scheduled shift vs EOR flexible visits", () => {
  it("Direct Hire: the visit links to the scheduled shift and becomes Billing Ready", async () => {
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const t = (await db.admin.query(`select to_char(now() at time zone 'America/Los_Angeles' + interval '20 minutes', 'YYYY-MM-DD') d,
      to_char(now() at time zone 'America/Los_Angeles' + interval '20 minutes', 'HH24:MI') s, to_char(now() at time zone 'America/Los_Angeles' + interval '140 minutes', 'HH24:MI') e`)).rows[0];
    const [shift] = await q(w.managerA, "select * from ogevia_api.create_shift($1, $2, $3, $4::date, $5::time, $6::time, $7, null)",
      [w.orgA, fresh.client, fresh.service, t.d, t.s, t.e, rec["CG-A1"]]);
    const visit = await api.start(db, w.caregiverA1, w.orgA, fresh.client, fresh.service);
    expect((await db.admin.query("select scheduled_shift_id from ogevia.service_visits where id = $1", [visit])).rows[0].scheduled_shift_id).toBe(shift.shift_id);
    await ageVisit(db, visit, 30);
    await api.end(db, w.caregiverA1, visit);
    const evidence = await api.registerEvidence(db, w.caregiverA1, w.orgA, visit);
    const r = await api.confirm(db, w.caregiverA1, visit, { evidence });
    expect(r.status).toBe("signed");
    expect((await review()).find((x) => x.visit_id === visit)).toMatchObject({ review_state: "ready", caregiver_scheduling_mode: "fixed", scheduled_shift_id: shift.shift_id });
  });

  it("EOR flexible: an authorized visit without any shift is Billing Ready, not an exception; every visit rule still applies", async () => {
    const fresh = await freshClient(db, w, w.caregiverA2, 6000, w.orgA, { before: 40, after: 40 });
    const { visit, result } = await signedVisit(db, w.caregiverA2, w, 45, w.orgA, fresh.client, fresh.service);
    expect(result.status).toBe("signed");
    const row = (await review()).find((x) => x.visit_id === visit);
    expect(row).toMatchObject({ review_state: "ready", caregiver_scheduling_mode: "flexible", scheduled_shift_id: null, billable_minutes: 45 });
    const listed = (await q(w.managerA, "select * from ogevia_api.list_service_visits($1)", [w.orgA])).find((v) => v.id === visit);
    expect(listed).toMatchObject({ caregiver_scheduling_mode: "flexible", scheduled_shift_id: null });
    const att = (await q(w.managerA, "select * from ogevia_api.get_attention_summary($1)", [w.orgA]))[0];
    expect(att.missing_time_out).toBe(0);
    // Still required: an assignment for this client and service.
    const unassigned = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    await expectPgError(api.start(db, w.caregiverA2, w.orgA, unassigned.client, unassigned.service), "OGA03", /not assigned to you/);
    // Still required: a current authorization.
    const noAuth = (await db.admin.query("insert into ogevia.clients (organization_id) values ($1) returning id", [w.orgA])).rows[0].id;
    await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1, $2, $3, $4, (now() at time zone 'America/Los_Angeles')::date)",
      [w.orgA, w.caregiverA2.userId, noAuth, w.serviceA]);
    await expectPgError(api.start(db, w.caregiverA2, w.orgA, noAuth, w.serviceA), "OGC09", /No active authorization/);
    // Still capped: a visit beyond the authorized monthly minutes is not fully billable.
    const small = await freshClient(db, w, w.caregiverA2, 30, w.orgA, { before: 40, after: 40 });
    const over = await signedVisit(db, w.caregiverA2, w, 50, w.orgA, small.client, small.service);
    expect(over.result.status).toBe("administrator_review");
    expect((await db.admin.query("select billable_minutes, authorization_status from ogevia.service_visits where id = $1", [over.visit])).rows[0])
      .toEqual({ billable_minutes: 30, authorization_status: "exceeds_authorization" });
    // Still requires confirmation: without it, nothing is billable.
    const unconf = await freshClient(db, w, w.caregiverA2, 6000, w.orgA, { before: 40, after: 40 });
    const ended = await (async () => { const v = await api.start(db, w.caregiverA2, w.orgA, unconf.client, unconf.service); await ageVisit(db, v, 20); await api.end(db, w.caregiverA2, v); return v; })();
    const r2 = await api.confirm(db, w.caregiverA2, ended, { method: "unable_to_confirm", reason: "No signer (synthetic)" });
    expect(r2.status).toBe("administrator_review");
  });

  it("a caregiver without an active sign-in still cannot start a visit, flexible or not", async () => {
    const fresh = await freshClient(db, w, w.caregiverA2, 6000, w.orgA, { before: 40, after: 40 });
    await db.admin.query("update ogevia.organization_memberships set status = 'suspended' where user_id = $1 and organization_id = $2", [w.caregiverA2.userId, w.orgA]);
    try {
      await expectPgError(api.start(db, w.caregiverA2, w.orgA, fresh.client, fresh.service), "OGA03");
    } finally {
      await db.admin.query("update ogevia.organization_memberships set status = 'active' where user_id = $1 and organization_id = $2", [w.caregiverA2.userId, w.orgA]);
    }
  });
});

describe("billing review rows", () => {
  it("carry client code and legal name (names permission), caregiver and service names; no other agency; no rates", async () => {
    const fresh = await freshClient(db, w, w.caregiverA3, 6000, w.orgA, { before: 40, after: 40 });
    await db.admin.query("insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by) values ($1, $2, 'Synthetic', 'Reviewname', $3)",
      [fresh.client, w.orgA, w.ownerA.userId]);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 1, w.orgA, fresh.client, fresh.service);
    const row = (await review()).find((x) => x.visit_id === visit);
    expect(row).toMatchObject({ client_name: "Synthetic Reviewname", service_name: expect.any(String), caregiver_name: expect.any(String), worked_minutes: 1 });
    expect(row.client_code).toBeTruthy();
    expect(Object.keys(row).some((k) => /rate|cents|amount/.test(k))).toBe(false);
    expect((await review(w.managerB)).find((x) => x.visit_id === visit)).toBeUndefined();
    expect(await review(w.caregiverA3)).toEqual([]);
  });
});

describe("monthly approval summary (reconciliation: Approved separate from Billable)", () => {
  it("returns approved minutes per authorization lineage, minutes only; voided approvals do not count; agency and role isolated", async () => {
    const fresh = await freshClient(db, w, w.caregiverA3, 6000, w.orgA, { before: 40, after: 40 });
    const { visit } = await signedVisit(db, w.caregiverA3, w, 30, w.orgA, fresh.client, fresh.service);
    const lineage = (await db.admin.query("select a.lineage_id from ogevia.service_visits v join ogevia.client_authorizations a on a.id = v.service_authorization_id where v.id = $1", [visit])).rows[0].lineage_id;
    const month = "date_trunc('month', now() at time zone 'America/Los_Angeles')::date";
    const summary = (a: Actor, org = w.orgA) => q(a, `select * from ogevia_api.list_monthly_approval_summary($1, ${month}, $2)`, [org, fresh.client]);
    expect(await summary(w.managerA)).toEqual([]);
    const approve = (minutes: number) => q(w.managerA, "select ogevia_api.approve_visit_for_billing($1, $2, null, null) as id", [visit, minutes]).then((r) => r[0].id as string);
    const id = await approve(20);
    const rows = await summary(w.managerA);
    expect(rows).toEqual([{ authorization_lineage_id: lineage, approved_minutes: 20, approved_visit_count: 1, rounding_adjustment_minutes: 0 }]);
    expect(Object.keys(rows[0]).some((k) => /rate|cents|amount|value/.test(k))).toBe(false);
    // Billable (eligible) stays 30 in the service summary; approved is a separate fact.
    const svc = (await q(w.managerA, `select * from ogevia_api.list_monthly_service_summary($1, ${month}, $2)`, [w.orgA, fresh.client]))[0];
    expect(svc).toMatchObject({ billable_minutes: 30, authorization_lineage_id: lineage });
    await q(w.managerA, "select ogevia_api.void_billing_approval($1, 'Synthetic void', null)", [id]);
    expect(await summary(w.managerA)).toEqual([]);
    expect(await summary(w.managerB)).toEqual([]);
    expect(await summary(w.managerB, w.orgB)).toEqual([]);
    expect(await summary(w.caregiverA3)).toEqual([]);
  });
});
