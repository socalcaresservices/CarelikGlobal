// 0028 Outage visit records and reconciliation. SYNTHETIC data only.
// Every call runs as the application role through begin_request.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let fresh: { client: string; service: string; auth: string };
let small: { client: string; service: string; auth: string };
let yesterday: string;
const rec: Record<string, string> = {};
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
  small = await freshClient(db, w, w.caregiverA2, 60, w.orgA, { before: 40, after: 40 });
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
  const today = await orgToday(db);
  yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
  await asActor(db, w.managerA.sub, (c) => c.query("select ogevia_api.create_continuity_pack($1, $2)", [w.orgA, crypto.randomUUID()]));
});
afterAll(async () => db?.drop());

const record = (a: Actor, n: number, o: Partial<{ org: string; client: string; service: string; caregiver: string; date: string; tin: string; tout: string; conf: string; signer: string | null; key: string | null }> = {}) =>
  asActor(db, a.sub, async (c) => (await c.query(
    "select * from ogevia_api.record_outage_visit($1, $2, $3, $4, $5, $6::date, $7::time, $8::time, $9, $10, $11, $12)",
    [o.org ?? w.orgA, n, o.client ?? fresh.client, o.service ?? fresh.service, o.caregiver ?? rec["CG-A1"], o.date ?? yesterday,
     o.tin ?? "09:00", o.tout ?? "11:00", o.conf ?? "signature_on_form", o.signer === undefined ? "Synthetic Representative" : o.signer, "Synthetic note", o.key ?? null])).rows[0]);
const recon = (a: Actor, open = false) =>
  asActor(db, a.sub, async (c) => (await c.query("select * from ogevia_api.list_outage_reconciliation($1, $2)", [w.orgA, open])).rows);
const visit = async (id: string) => (await db.admin.query("select * from ogevia.service_visits where id = $1", [id])).rows[0];

describe("outage visit records", () => {
  it("enters a paper record once: a locked visit in administrator review, 0 billable, reported times labelled, confirmation states the form", async () => {
    const key = crypto.randomUUID();
    const r = await record(w.managerA, 1, { key });
    expect(r).toMatchObject({ worked_minutes: 120, authorization_status: "within_authorization", outage_number: 1 });
    const v = await visit(r.visit_id);
    expect(v).toMatchObject({ status: "administrator_review", verified_minutes: 0, billable_minutes: 0, time_out_entered_by: w.managerA.userId, caregiver_record_id: rec["CG-A1"] });
    expect(v.time_out_reason).toMatch(/^Outage record OUT-000001: times as written on the paper record/);
    expect(v.locked_at).not.toBeNull();
    const local = (await db.admin.query("select to_char(time_in at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') as t from ogevia.service_visits where id = $1", [r.visit_id])).rows[0].t;
    expect(local).toBe(`${yesterday} 09:00`);
    const conf = (await db.admin.query("select confirmation_method, confirmation_reason from ogevia.visit_confirmations where visit_id = $1", [r.visit_id])).rows[0];
    expect(conf.confirmation_method).toBe("unable_to_confirm");
    expect(conf.confirmation_reason).toMatch(/OUT-000001 shows: signature on the paper form by Synthetic Representative\. Review the paper record before any billing/);
    expect((await db.admin.query("select count(*)::int as n from ogevia.audit_events where entity_id = $1 and action = 'service_visit.outage_recorded'", [r.visit_id])).rows[0].n).toBe(1);
    // A retry of the same request returns the same visit; nothing is added.
    expect((await record(w.managerA, 1, { key })).visit_id).toBe(r.visit_id);
  });

  it("never counts a record twice: the same number is refused, whatever else is typed", async () => {
    await expectPgError(record(w.managerA, 1, { date: yesterday, tin: "14:00", tout: "15:00" }), "OGC09", /OUT-000001 was already entered \(visit /);
  });

  it("refuses overlaps with the same caregiver or the same client and service, including visits captured in Ogevia", async () => {
    await expectPgError(record(w.managerA, 2, { tin: "10:00", tout: "12:00", caregiver: rec["CG-A2"] }), "OGC09", /overlaps visit .* same client and service/);
    await expectPgError(record(w.managerA, 2, { tin: "10:30", tout: "10:45", client: small.client, service: small.service }), "OGC09", /overlaps visit/);
    // A visit recorded normally in Ogevia (before the outage) for the same caregiver and client.
    const { visit: live } = await signedVisit(db, w.caregiverA1, w, 45, w.orgA, fresh.client, fresh.service);
    const t = (await db.admin.query(
      `select (time_in at time zone 'America/Los_Angeles')::date::text as d, to_char(time_in at time zone 'America/Los_Angeles', 'HH24:MI') as a, to_char(time_out at time zone 'America/Los_Angeles', 'HH24:MI') as b,
              ogevia.local_time_issue('America/Los_Angeles', (time_in at time zone 'America/Los_Angeles')::date, (time_in at time zone 'America/Los_Angeles')::time) as ai,
              ogevia.local_time_issue('America/Los_Angeles', (time_out at time zone 'America/Los_Angeles')::date, (time_out at time zone 'America/Los_Angeles')::time) as bi
         from ogevia.service_visits where id = $1`, [live])).rows[0];
    // The paper record carries local clock times, so the live visit's times can be replayed only when they exist exactly
    // once in agency time. In the hour a clock change repeats or skips, the same text names two instants (or none).
    if (t.a < t.b && !t.ai && !t.bi) await expectPgError(record(w.managerA, 2, { date: t.d, tin: t.a, tout: t.b }), "OGC09", /overlaps visit/);
  });

  it("refuses numbers not issued to this agency, other agencies, caregivers and future times", async () => {
    await expectPgError(record(w.managerA, 999, { tin: "13:00", tout: "14:00" }), "OGV22", /OUT-000999 was not issued to this agency/);
    await expectPgError(record(w.managerB, 2, { org: w.orgB }), "OGV22", /not issued to this agency/);
    await expectPgError(record(w.managerB, 2), "OGN04");
    await expectPgError(record(w.caregiverA1, 2), "OGA03");
    const tomorrow = new Date(Date.parse(`${yesterday}T12:00:00Z`) + 2 * 864e5).toISOString().slice(0, 10);
    await expectPgError(record(w.managerA, 2, { date: tomorrow }), "OGV22", /cannot be in the future/);
    await expectPgError(record(w.managerA, 2, { conf: "signature_on_form", signer: null, tin: "16:00", tout: "17:00" }), "OGV22", /name of the person/);
  });

  it("flags time beyond the authorization and still bills nothing until a human reviews and approves", async () => {
    const r = await record(w.managerA, 2, { client: small.client, service: small.service, caregiver: rec["CG-A2"], tin: "13:00", tout: "15:00", conf: "verbal" });
    expect(r.authorization_status).toBe("exceeds_authorization");
    expect((await visit(r.visit_id)).billable_minutes).toBe(0);
    await expectPgError(asActor(db, w.ownerA.sub, (c) => c.query("select * from ogevia_api.approve_visit_for_billing($1, 60, null, null)", [r.visit_id])),
      "OGC09", /Only a Billing Ready visit can be approved/);
  });

  it("closes an unused number with a reason; reconciliation shows every issued number: entered, not used or MISSING", async () => {
    await expectPgError(asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia_api.mark_outage_number_unused($1, 3, '  ', null)", [w.orgA])), "OGV22");
    await asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia_api.mark_outage_number_unused($1, 3, 'Form spoiled (synthetic)', null)", [w.orgA]));
    await expectPgError(record(w.managerA, 3, { tin: "18:00", tout: "19:00" }), "OGC09", /OUT-000003 was already marked not used/);
    const all = await recon(w.managerA);
    expect(all).toHaveLength(25);
    expect(all.filter((x) => x.state === "entered").map((x) => x.outage_number)).toEqual([1, 2]);
    expect(all.find((x) => x.outage_number === 3)).toMatchObject({ state: "not_used", reason_not_used: "Form spoiled (synthetic)" });
    const open = await recon(w.managerA, true);
    expect(open.map((x) => x.outage_number)).toEqual(Array.from({ length: 22 }, (_, i) => i + 4));
    expect(open.every((x) => x.state === "missing")).toBe(true);
    await expectPgError(recon(w.caregiverA1), "OGA03");
    await expectPgError(db.admin.query("update ogevia.outage_visit_records set state = 'not_used'"), "OGC09");
    await expectPgError(db.admin.query("delete from ogevia.outage_visit_records"), "OGC09");
  });
});
