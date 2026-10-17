// 0062 Billing states decided on the server (owner directive 2026-10-17, requirement 8): Needs Correction, Ready for Review, Approved for Billing, Voided,
// and the preserved 'Reviewed - not billable'. Approval is not submission or payment; 'Already Billed' is deferred and does not exist. SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 700);
});
afterAll(async () => db?.drop());

const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const admin = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const range = "(now() at time zone 'America/Los_Angeles')::date - 2, (now() at time zone 'America/Los_Angeles')::date + 1";
const row = async (visit: string, a: Actor = w.managerA) => (await q(a, `select * from ogevia_api.list_billing_review_visits($1, ${range})`, [w.orgA])).find((r) => r.visit_id === visit);
const stateOf = async (visit: string) => (await admin("select ogevia.visit_billing_state($1) s", [visit])).rows[0].s as string | null;
const review = (a: Actor, visit: string) => q(a, "select * from ogevia_api.get_visit_review($1)", [visit]).then((r) => r[0]);
const approve = (a: Actor, visit: string, minutes: number) => q(a, "select ogevia_api.approve_visit_for_billing($1, $2, null, null) as id", [visit, minutes]).then((r) => r[0].id as string);
const voidIt = (a: Actor, id: string, reason: string) => q(a, "select ogevia_api.void_billing_approval($1, $2, null)", [id, reason]);
const decide = (a: Actor, visit: string, decision: string, reason = "Synthetic review") => q(a, "select ogevia_api.decide_visit_review($1,$2,$3,null) as id", [visit, decision, reason]).then((r) => r[0].id as string);
const readyCounts = async () => ({
  action: (await q(w.managerA, "select billing_ready_unapproved n from ogevia_api.get_attention_summary($1)", [w.orgA]))[0].n as number,
  home: (await q(w.managerA, "select ogevia_api.get_attention_overview($1,48) o", [w.orgA]))[0].o.visitReview.readyForApproval as number,
});
async function noSignerVisit() {
  const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
  const v = await api.start(db, w.caregiverA1, w.orgA, fresh.client, fresh.service);
  await ageVisit(db, v, 20);
  await api.end(db, w.caregiverA1, v);
  await api.confirm(db, w.caregiverA1, v, { method: "unable_to_confirm", reason: "Client asleep (synthetic)" });
  return v;
}
async function cappedVisit() {
  const small = await freshClient(db, w, w.caregiverA2, 30, w.orgA, { before: 40, after: 40 });
  return (await signedVisit(db, w.caregiverA2, w, 50, w.orgA, small.client, small.service)).visit;
}

describe("the states, from signing to approval to void and back", () => {
  it("signed: Ready for Review; approved: Approved for Billing; voided: Voided (with when, why and by whom); approved again: Approved for Billing", async () => {
    const own = await freshClient(db, w, w.caregiverA3, 600);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 30, w.orgA, own.client);
    expect(await row(visit)).toMatchObject({ billing_state: "ready_for_review", active_approval_id: null, last_void_at: null, last_void_reason: null, review_state: "ready" });
    const first = await approve(w.managerA, visit, 30);
    expect(await row(visit)).toMatchObject({ billing_state: "approved_for_billing", active_approval_id: first });
    await voidIt(w.managerA, first, "Approved the wrong minutes (synthetic)");
    const voided = await row(visit);
    expect(voided).toMatchObject({ billing_state: "voided", active_approval_id: null, last_void_reason: "Approved the wrong minutes (synthetic)" });
    expect(voided.last_void_at).toBeTruthy();
    expect(voided.last_voided_by_name).toBeTruthy();
    expect((await admin("select status from ogevia.service_visits where id = $1", [visit])).rows[0].status).toBe("signed"); // the visit itself is untouched
    const second = await approve(w.managerA, visit, 30);
    expect(await row(visit)).toMatchObject({ billing_state: "approved_for_billing", active_approval_id: second, last_void_reason: "Approved the wrong minutes (synthetic)" }); // history stays
    expect((await admin("select count(*)::int n from ogevia.billing_approvals where visit_id = $1", [visit])).rows[0].n).toBe(2); // the voided row is kept
  });

  it("a visit with no client signature Needs Correction; closing the review keeps 'Reviewed - not billable' (neutral, not a correction, not voided)", async () => {
    const v = await noSignerVisit();
    expect(await row(v)).toMatchObject({ billing_state: "needs_correction", review_reasons: ["no_client_signature"] });
    await decide(w.managerA, v, "close_not_billable", "Parent could not be reached; not billable (synthetic)");
    expect(await row(v)).toMatchObject({ billing_state: "reviewed_not_billable", review_state: "reviewed_not_billable", eligible_minutes: 0 });
    await expectPgError(approve(w.managerA, v, 0), "OGC09", /Ready for Review.*Needs Correction/s);
  });

  it("an over-authorization visit Needs Correction until the capped minutes are accepted, then it is Ready for Review and counted as ready", async () => {
    const v = await cappedVisit();
    expect(await stateOf(v)).toBe("needs_correction");
    const before = await readyCounts();
    const id = await decide(w.managerA, v, "accept_capped_billable", "Signed; the minutes over the authorization are not billable (synthetic)");
    expect(await stateOf(v)).toBe("ready_for_review");
    const after = await readyCounts();
    expect(after.action).toBe(before.action + 1); // an accepted-in-review visit is approvable, so it is now counted (it was not before 0062)
    expect(after.home).toBe(before.home + 1);
    await approve(w.managerA, v, 30);
    expect(await stateOf(v)).toBe("approved_for_billing");
    expect(await readyCounts()).toEqual(before);
    void id;
  });

  it("a visit waiting on a client response is Waiting for signature, not a correction", async () => {
    const v = await noSignerVisit();
    await q(w.managerA, "select * from ogevia_api.create_visit_confirmation_request($1,'paper','Synthetic Signer','client',null,null,null,7)", [v]);
    expect(await stateOf(v)).toBe("waiting_for_signature");
  });

  it("the server's two Ready counts always agree, and a voided approval counts again until it is re-approved", async () => {
    const own = await freshClient(db, w, w.caregiverA3, 600);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 30, w.orgA, own.client);
    const base = await readyCounts();
    expect(base.action).toBe(base.home);
    const id = await approve(w.managerA, visit, 30);
    expect(await readyCounts()).toEqual({ action: base.action - 1, home: base.home - 1 });
    await voidIt(w.managerA, id, "Synthetic void");
    expect(await readyCounts()).toEqual(base);
  });
});

describe("approval is not submission or payment, and Already Billed does not exist", () => {
  it("no state, enum value or column anywhere says billed, submitted or paid; every visit maps to a state from the approved set", async () => {
    const states = (await admin("select distinct ogevia.visit_billing_state(id) s from ogevia.service_visits")).rows.map((r) => r.s).filter(Boolean);
    const allowed = ["needs_correction", "waiting_for_signature", "late_response_to_review", "ready_for_review", "approved_for_billing", "voided", "reviewed_not_billable"];
    for (const s of states) expect(allowed).toContain(s);
    const src = (await admin("select pg_get_functiondef('ogevia.visit_billing_state(uuid)'::regprocedure) d")).rows[0].d as string;
    expect(src).not.toMatch(/billed|submitted|paid|invoice/i);
    const cols = (await admin(`select column_name from information_schema.columns where table_schema = 'ogevia' and table_name = 'billing_approvals' and column_name ~* '(submit|billed|paid|invoice|payment)'`)).rows;
    expect(cols).toEqual([]);
    const enumVals = (await admin(`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typnamespace = 'ogevia'::regnamespace and e.enumlabel ~* '(billed|submitted|paid)'`)).rows;
    expect(enumVals).toEqual([]);
  });
  it("approving changes nothing but the approval row and its audit: the visit, its minutes and the authorization are unchanged", async () => {
    const own = await freshClient(db, w, w.caregiverA3, 600);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 30, w.orgA, own.client);
    const before = (await admin("select * from ogevia.service_visits where id = $1", [visit])).rows[0];
    await approve(w.managerA, visit, 30);
    expect((await admin("select * from ogevia.service_visits where id = $1", [visit])).rows[0]).toEqual(before);
  });
});

describe("who sees what", () => {
  it("get_visit_review carries the state only for someone who may see billing; a scheduler and a caregiver get none, and another agency sees nothing", async () => {
    const own = await freshClient(db, w, w.caregiverA3, 600);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 30, w.orgA, own.client);
    expect((await review(w.managerA, visit)).billing_state).toBe("ready_for_review");
    const sch = await review(w.schedulerA, visit);
    if (sch) expect(sch.billing_state).toBeNull();
    expect(await q(w.schedulerA, `select * from ogevia_api.list_billing_review_visits($1, ${range})`, [w.orgA])).toEqual([]);
    expect(await q(w.managerB, `select * from ogevia_api.list_billing_review_visits($1, ${range})`, [w.orgA])).toEqual([]);
    expect(await review(w.managerB, visit)).toBeUndefined();
    await expectPgError(approve(w.schedulerA, visit, 30), "OGA03");
  });
});
