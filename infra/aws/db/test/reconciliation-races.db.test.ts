// Reconciliation of an ended shift racing with late-confirmation acceptance and with a visit being signed (owner request 2026-10-17, item 2): reservations, delivered
// time, approval eligibility and audit history stay consistent, with no double counting and no lost evidence. SYNTHETIC data only.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, asReplica, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
type Fx = { client: string; service: string; auth: string };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const as = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const summaryFor = async (f: Fx) => (await as(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1,$2::date,$3)", [w.orgA, `${(await orgToday(db)).slice(0, 7)}-01`, f.client]))[0];
const reconcile = (a: Actor, shift: string, outcome: string) =>
  as(a, "select ogevia_api.reconcile_ended_shift($1,$2,$3,'Checked with the family and the caregiver (synthetic)',$4) r", [w.orgA, shift, outcome, randomUUID()]).then((r) => r[0].r as Record<string, any>);
const bucket = async (shift: string) => (await q("select ogevia.reservation_bucket(r.id) b from ogevia.authorization_reservations r where r.shift_id = $1", [shift])).rows[0].b as string | null;

/** The late client response, as the public page sends it (the same calls the API makes), then the person's acceptance is a separate step. */
async function lateResponse(visit: string) {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const tokenHash = sha(token);
  const codeHash = sha(`${tokenHash}:123456`);
  await as(w.managerA, "select * from ogevia_api.create_visit_confirmation_request($1,'link',$2,'parent',$3,$4,$5,7,null)",
    [visit, "Synthetic Parent", "Called the number on file and confirmed the parent's name", tokenHash, codeHash]);
  const c = await db.admin.connect();
  try {
    await c.query("begin"); await c.query("set local role ogevia_app");
    const res = (await c.query("select * from ogevia_api.public_respond_visit_confirmation($1,$2,$3,'confirmed','typed',$4,null,true,null,null,null,null,$5)",
      [tokenHash, codeHash, randomUUID(), "Synthetic Parent", randomUUID()])).rows[0];
    await c.query("commit");
    return res.late_confirmation_id as string;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const acceptLate = (id: string) => as(w.managerA, "select * from ogevia_api.review_late_visit_confirmation($1,'accepted','Checked against the schedule (synthetic)',null)", [id]).then((r) => r[0]);

/** An ended shift whose linked visit is in review with no billable minutes (the client did not sign). */
async function endedShiftWithReviewVisit(minutes: number) {
  const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
  const rec = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
  const shift = (await q(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3,$4,$5, now() - interval '2 minutes', now() + interval '118 minutes', 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.id = $6 returning id`,
    [w.orgA, f.client, f.service, w.caregiverA1.userId, rec, f.auth])).rows[0].id as string;
  await q(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
           select $1, a.lineage_id, null, $2, (now() at time zone 'America/Los_Angeles')::date, 120 from ogevia.client_authorizations a where a.id = $3`, [w.orgA, shift, f.auth]);
  const visit = await api.start(db, w.caregiverA1, w.orgA, f.client, f.service, null, null);
  expect((await q("select scheduled_shift_id from ogevia.service_visits where id = $1", [visit])).rows[0].scheduled_shift_id).toBe(shift);
  await ageVisit(db, visit, minutes);
  await api.end(db, w.caregiverA1, visit);
  await api.confirm(db, w.caregiverA1, visit, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
  await asReplica(db, "update ogevia.shifts set starts_at = now() - interval '5 hours', ends_at = now() - interval '3 hours' where id = $1", [shift]); // the shift is over
  return { f, shift, visit };
}

beforeAll(async () => { db = await createTestDb(); w = await seedWorld(db, 600); });
afterAll(async () => db?.drop());

describe("reconcile racing the acceptance of a late confirmation", () => {
  it("the reconcile is always refused (a visit exists); the acceptance always succeeds; the reservation is not released and not double counted; the delivered time counts once and is approvable; the audit trail is complete", async () => {
    for (const outcome of ["no_service_delivered", "delivered_unverified"]) {
      for (let round = 0; round < 3; round++) {
        const { f, shift, visit } = await endedShiftWithReviewVisit(45);
        const lateId = await lateResponse(visit);
        expect(await bucket(shift)).toBe("held_review");
        const res = await Promise.allSettled([reconcile(w.managerA, shift, outcome), acceptLate(lateId)]);
        const [rec, acc] = res;
        expect(rec!.status).toBe("rejected");
        expect((rec as PromiseRejectedResult).reason.code).toBe("OGC09");
        expect(acc!.status, acc!.status === "rejected" ? String((acc as PromiseRejectedResult).reason) : "").toBe("fulfilled");
        // reservation: untouched, and no longer part of the reserved total (the accepted minutes are used instead): counted once
        const r = (await q("select released_at, release_reason, reserved_minutes from ogevia.authorization_reservations where shift_id = $1", [shift])).rows[0];
        expect(r).toEqual({ released_at: null, release_reason: null, reserved_minutes: 120 });
        expect(await bucket(shift)).toBeNull();
        const s = await summaryFor(f);
        expect(s).toMatchObject({ reserved_minutes: 0, reserved_reconcile_minutes: 0, billable_minutes: 45 });
        expect(s.authorized_minutes).toBe(s.billable_minutes + s.adjustment_minutes + s.reserved_minutes + s.remaining_minutes);
        // delivered time is approvable at the accepted minutes (and not more)
        await expectPgError(as(w.managerA, "select ogevia_api.approve_visit_for_billing($1, 46, null, null)", [visit]), "OGV22");
        await as(w.managerA, "select ogevia_api.approve_visit_for_billing($1, 45, null, null)", [visit]);
        expect((await q("select ogevia.visit_billing_state($1) s", [visit])).rows[0].s).toBe("approved_for_billing");
        // no reconciliation decision, no release event; the late confirmation review and its evidence are intact
        expect((await q("select count(*)::int n from ogevia.shift_reconciliations where shift_id = $1", [shift])).rows[0].n).toBe(0);
        const actions = (await q("select action from ogevia.audit_events where entity_id in ($1, $2) or (after_state ->> 'visit_id') = $2::text", [r && (await q("select id from ogevia.authorization_reservations where shift_id = $1", [shift])).rows[0].id, visit])).rows.map((x) => x.action);
        expect(actions).not.toContain("authorization_reservation.reconciled_released");
        expect(actions).toContain("visit.late_confirmation_reviewed");
        expect((await q("select count(*)::int n from ogevia.visit_late_confirmations where visit_id = $1", [visit])).rows[0].n).toBe(1);
        expect((await q("select count(*)::int n from ogevia.visit_review_decisions where visit_id = $1 and decision = 'accept_late_confirmation' and revoked_at is null", [visit])).rows[0].n).toBe(1);
      }
    }
  });

  it("sequential orders agree with the race: accept first then reconcile is refused; reconcile attempt first (refused) then accept succeeds", async () => {
    const a = await endedShiftWithReviewVisit(30);
    const la = await lateResponse(a.visit);
    await acceptLate(la);
    await expectPgError(reconcile(w.managerA, a.shift, "no_service_delivered"), "OGC09");
    const b = await endedShiftWithReviewVisit(30);
    const lb = await lateResponse(b.visit);
    await expectPgError(reconcile(w.managerA, b.shift, "no_service_delivered"), "OGC09");
    await acceptLate(lb);
    expect((await summaryFor(b.f))).toMatchObject({ billable_minutes: 30, reserved_minutes: 0 });
  });

  it("revoking the acceptance puts the reservation back in the reserved total (still counted once) and the shift is still not reconcilable while the visit exists", async () => {
    const { f, shift, visit } = await endedShiftWithReviewVisit(40);
    const lateId = await lateResponse(visit);
    await acceptLate(lateId);
    const decision = (await q("select id from ogevia.visit_review_decisions where visit_id = $1 and decision = 'accept_late_confirmation' and revoked_at is null", [visit])).rows[0].id;
    await as(w.managerA, "select ogevia_api.revoke_visit_review_decision($1, 'Entered in error (synthetic)', null)", [decision]);
    expect(await summaryFor(f)).toMatchObject({ billable_minutes: 0, reserved_minutes: 120, reserved_review_minutes: 120 });
    expect(await bucket(shift)).toBe("held_review");
    await expectPgError(reconcile(w.managerA, shift, "no_service_delivered"), "OGC09");
  });
});

describe("reconcile racing a visit being signed", () => {
  it("an ended shift whose visit is still open cannot be reconciled; confirming at the same moment leaves no reconciliation row and no release by it, and the time counted once as used", async () => {
    for (let round = 0; round < 4; round++) {
      const f = await freshClient(db, w, w.caregiverA2, 20000, w.orgA, { before: 40, after: 200 });
      const rec = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA2.userId])).rows[0].id;
      const shift = (await q(
        `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
         select $1,$2,$3,$4,$5, now() - interval '2 minutes', now() + interval '118 minutes', 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.id = $6 returning id`,
        [w.orgA, f.client, f.service, w.caregiverA2.userId, rec, f.auth])).rows[0].id as string;
      await q(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
               select $1, a.lineage_id, null, $2, (now() at time zone 'America/Los_Angeles')::date, 120 from ogevia.client_authorizations a where a.id = $3`, [w.orgA, shift, f.auth]);
      const visit = await api.start(db, w.caregiverA2, w.orgA, f.client, f.service, null, null);
      await ageVisit(db, visit, 50);
      await api.end(db, w.caregiverA2, visit);
      await asReplica(db, "update ogevia.shifts set starts_at = now() - interval '5 hours', ends_at = now() - interval '3 hours' where id = $1", [shift]);
      const evidence = await api.registerEvidence(db, w.caregiverA2, w.orgA, visit);
      const res = await Promise.allSettled([reconcile(w.managerA, shift, "no_service_delivered"), api.confirm(db, w.caregiverA2, visit, { evidence })]);
      expect(res[0]!.status).toBe("rejected");
      expect((res[0] as PromiseRejectedResult).reason.code).toBe("OGC09");
      expect(res[1]!.status).toBe("fulfilled");
      // signed: released by the existing rule (visit_signed); in review because it is shorter than its shift: kept but excluded from the reserved total (0052). Either way never released by a reconciliation.
      expect([null, "visit_signed"]).toContain((await q("select release_reason from ogevia.authorization_reservations where shift_id = $1", [shift])).rows[0].release_reason);
      expect(await bucket(shift)).toBeNull();
      expect((await q("select count(*)::int n from ogevia.shift_reconciliations where shift_id = $1", [shift])).rows[0].n).toBe(0);
      const s = await summaryFor(f);
      expect(s).toMatchObject({ billable_minutes: 50, reserved_minutes: 0 });
      expect(s.authorized_minutes).toBe(s.billable_minutes + s.adjustment_minutes + s.reserved_minutes + s.remaining_minutes);
    }
  });
});
