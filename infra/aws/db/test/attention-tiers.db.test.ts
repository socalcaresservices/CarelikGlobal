// 0058/0059 Attention tiers and queues that stay apart (owner directive 2026-10-17, requirements 2 and 3). SYNTHETIC data only.
//   Shift timing (uncovered OR caregiver blocked): at/after start = Critical; inside 48 h = Urgent; more than 48 h away = Upcoming (not urgent); a shift exactly 48 h away is Urgent (0059).
//   Visit review: Pending Confirmation (<48 h after visit end) and Ready for Approval are routine and never added to what needs a person;
//   confirmation escalates 48 h after the visit end; administrator review is in the queue at once and Urgent after 24 h.
//   Routine document review escalates 48 h after upload, sooner when expired or blocking care. The caregiver's hold is enforced immediately.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let fx: { client: string; service: string; auth: string };
let recA1: string;
let recA2: string;
let today: string;

const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const overview = (a: Actor = w.managerA, hours = 48, org = w.orgA) => call(a, "select ogevia_api.get_attention_overview($1,$2) as o", [org, hours]).then((r) => r[0].o);
const recOf = async (a: Actor) => (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id as string;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  recA1 = await recOf(w.caregiverA1);
  recA2 = await recOf(w.caregiverA2);
});
afterAll(async () => db?.drop());

async function shiftAt(hoursFromNow: number, hours: number, caregiver: string | null, opts: { calledOut?: boolean } = {}) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    const id = (await c.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,null,$4, now() + make_interval(secs => $5::numeric * 3600), now() + make_interval(secs => ($5::numeric + $6::numeric) * 3600), 'scheduled') returning id`,
      [w.orgA, fx.client, fx.service, caregiver, hoursFromNow, hours])).rows[0].id as string;
    if (opts.calledOut) await c.query("insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type) values ($1,$2,'called_out')", [w.orgA, id]);
    return id;
  } finally {
    await c.query("set session_replication_role = origin");
    c.release();
  }
}
const flag = (shift: string, rec: string, kind: "compliance" | "document") =>
  q("insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail) values ($1,$2,$3,$4,$5,'{}'::jsonb)",
    [w.orgA, shift, rec, kind, kind === "compliance" ? "compliance_hold" : "documents_missing"]);
const wipeShifts = async () => {
  await q("delete from ogevia.assignment_readiness_flags");
  await q("delete from ogevia.shift_readiness_flags");
  await q("delete from ogevia.authorization_reservations where shift_id is not null");
  await q("delete from ogevia.shift_coverage_events");
  await q("delete from ogevia.shifts where not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = shifts.id)");
};
const urgentItem = (o: any, id: string) => o.urgent.items.find((i: any) => i.id === id);

describe("the tier function: at or after the start is Critical, before it Urgent", () => {
  const tier = async (starts: string, now: string) => (await q("select ogevia.attention_shift_tier($1::timestamptz,$2::timestamptz) t", [starts, now])).rows[0].t;
  it("exactly at the start time is Critical; one microsecond earlier than start is Urgent; after is Critical", async () => {
    expect(await tier("2026-03-01 10:00:00+00", "2026-03-01 10:00:00+00")).toBe("critical");
    expect(await tier("2026-03-01 10:00:00.000001+00", "2026-03-01 10:00:00+00")).toBe("urgent");
    expect(await tier("2026-03-01 09:59:59+00", "2026-03-01 10:00:00+00")).toBe("critical");
    expect(await tier("2026-03-03 09:59:59+00", "2026-03-01 10:00:00+00")).toBe("urgent");
  });
  it("the rule numbers are in one place", async () => {
    const r = (await q("select ogevia.attention_rule_hours('confirmation_overdue') c, ogevia.attention_rule_hours('review_overdue') r, ogevia.attention_rule_hours('document_review_overdue') d")).rows[0];
    expect(r).toEqual({ c: 48, r: 24, d: 48 });
  });
});

describe("an uncovered shift: Critical at/after start, Urgent inside 48 hours, Upcoming beyond", () => {
  it("each lands in the right place, and the tier is returned with the item", async () => {
    await wipeShifts();
    const running = await shiftAt(-0.5, 3, null);
    const soon = await shiftAt(0.5, 3, null);
    const edgeIn = await shiftAt(47.9, 2, null);
    const edgeOut = await shiftAt(48.1, 2, null);
    const o = await overview();
    expect(urgentItem(o, running)).toMatchObject({ tier: "critical", severity: "red", inProgress: true });
    expect(urgentItem(o, soon)).toMatchObject({ tier: "urgent", severity: "amber" });
    expect(urgentItem(o, edgeIn)).toMatchObject({ tier: "urgent" });
    expect(urgentItem(o, edgeOut)).toBeUndefined();
    expect(o.upcoming.shifts.map((s: any) => s.shiftId)).toEqual([edgeOut]);
    expect(o.urgent).toMatchObject({ itemCount: 3, critical: 1, urgent: 2 });
  });
  it("the window is a parameter: with 24 hours a shift 30 hours away is Upcoming, and one 20 hours away is Urgent", async () => {
    await wipeShifts();
    const near = await shiftAt(20, 2, null);
    const far = await shiftAt(30, 2, null);
    const o = await overview(w.managerA, 24);
    expect(urgentItem(o, near)).toMatchObject({ tier: "urgent" });
    expect(urgentItem(o, far)).toBeUndefined();
    expect(o.upcoming.shifts.map((s: any) => s.shiftId)).toEqual([far]);
  });
});

describe("a compliance-blocked shift follows the same timing, and the hold is enforced regardless", () => {
  it("Upcoming beyond 48 h, Urgent inside 48 h, Critical at/after start, while the flag is unresolved", async () => {
    await wipeShifts();
    const far = await shiftAt(100, 3, recA2);
    const near = await shiftAt(10, 3, recA2);
    const started = await shiftAt(-1, 3, recA2);
    for (const s of [far, near, started]) await flag(s, recA2, "compliance");
    const o = await overview();
    expect(o.upcoming.shifts.find((s: any) => s.shiftId === far)).toMatchObject({ reason: "compliance_hold" });
    expect(urgentItem(o, far)).toBeUndefined();
    expect(urgentItem(o, near)).toMatchObject({ tier: "urgent", reasons: ["compliance_hold"] });
    expect(urgentItem(o, started)).toMatchObject({ tier: "critical", reasons: ["compliance_hold"] });
    // resolved: gone from both
    await q("update ogevia.shift_readiness_flags set resolved_at = now() where shift_id = $1", [started]);
    const o2 = await overview();
    expect(urgentItem(o2, started)).toBeUndefined();
  });
  it("a shift flagged for a document is listed the same way, once even when it also has a hold flag", async () => {
    await wipeShifts();
    const far = await shiftAt(100, 3, recA2);
    await flag(far, recA2, "document");
    await flag(far, recA2, "compliance");
    const o = await overview();
    const rows = o.upcoming.shifts.filter((s: any) => s.shiftId === far);
    expect(rows).toHaveLength(1);
    expect(["compliance_hold", "documents_not_current"]).toContain(rows[0].reason);
    expect(o.upcoming.count).toBe(1);
  });
});

describe("visit review: routine queues never inflate what needs a person", () => {
  const review = async () => (await overview()).visitReview;
  /** One open visit per caregiver is a rule of the product: close the earlier fixtures so the next can start (voided; fixture, triggers off). */
  const park = async () => {
    await q("set session_replication_role = replica");
    await q("update ogevia.service_visits set status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Synthetic fixture' where caregiver_user_id = $1 and status in ('draft', 'awaiting_signature')", [w.caregiverA1.userId, w.managerA.userId]);
    await q("set session_replication_role = origin");
  };
  const endedVisit = async (minutesAgo: number, status: string) => {
    await park();
    const v = await api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service, null, "Synthetic: extra help");
    await ageVisit(db, v, 120);
    await api.end(db, w.caregiverA1, v);
    await q("set session_replication_role = replica");
    await q("update ogevia.service_visits set status = $2, time_in = now() - make_interval(mins => $3 + 120), time_out = now() - make_interval(mins => $3) where id = $1", [v, status, minutesAgo]);
    await q("set session_replication_role = origin");
    return v;
  };

  it("Pending Confirmation inside 48 h is routine; at 48 h and beyond it is overdue and needs a person", async () => {
    const b = await review();
    const young = await endedVisit(47 * 60 + 59, "awaiting_signature");
    let r = await review();
    expect(r.pendingConfirmation - b.pendingConfirmation).toBe(1);
    expect(r.confirmationOverdue - b.confirmationOverdue).toBe(0);
    expect(r.visitsNeedingAttention - b.visitsNeedingAttention).toBe(0); // routine: not added
    await q("set session_replication_role = replica");
    await q("update ogevia.service_visits set time_in = now() - interval '50 hours 1 minute', time_out = now() - interval '48 hours 1 minute' where id = $1", [young]);
    await q("set session_replication_role = origin");
    r = await review();
    expect(r.pendingConfirmation - b.pendingConfirmation).toBe(0);
    expect(r.confirmationOverdue - b.confirmationOverdue).toBe(1);
    expect(r.visitsNeedingAttention - b.visitsNeedingAttention).toBe(1);
    expect(r.awaitingConfirmation - b.awaitingConfirmation).toBe(1);
  });

  it("administrator review is in the queue at once; it is Urgent after 24 h in the queue, not before", async () => {
    await park();
    const b = await review();
    const v = await api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service, null, "Synthetic: unscheduled");
    await ageVisit(db, v, 30);
    await api.end(db, w.caregiverA1, v);
    await api.confirm(db, w.caregiverA1, v, { method: "unable_to_confirm", reason: "Synthetic: client asleep" });
    let r = await review();
    expect(r.needsReview - b.needsReview).toBe(1);
    expect(r.visitsNeedingAttention - b.visitsNeedingAttention).toBe(1); // counted immediately
    expect(r.reviewOverdue - b.reviewOverdue).toBe(0);
    const setAge = async (hours: number, mins = 0) => {
      await q("set session_replication_role = replica");
      await q("update ogevia.service_visits set signed_at = now() - make_interval(hours => $2, mins => $3) where id = $1", [v, hours, mins]);
      await q("set session_replication_role = origin");
    };
    await setAge(23, 59);
    r = await review();
    expect(r.reviewOverdue - b.reviewOverdue).toBe(0);
    await setAge(24, 1);
    r = await review();
    expect(r.reviewOverdue - b.reviewOverdue).toBe(1);
    expect(r.needsReview - b.needsReview).toBe(1); // the same visit, counted once
  });

  it("Ready for Approval has its own count, only for someone who may see billing, and is never part of the total", async () => {
    const b = await review();
    await signedVisit(db, w.caregiverA1, w, 30, w.orgA, fx.client, fx.service);
    const r = await review();
    expect(r.readyForApproval - b.readyForApproval).toBe(1);
    expect(r.visitsNeedingAttention - b.visitsNeedingAttention).toBe(0);
    expect((await overview(w.schedulerA)).visitReview.readyForApproval).toBeNull(); // no billing.visits.read
  });

  it("none of it changes the urgent total or the header badge's count", async () => {
    await wipeShifts();
    const before = (await overview()).urgent.itemCount;
    await park();
    await signedVisit(db, w.caregiverA1, w, 30, w.orgA, fx.client, fx.service); // ready for approval
    await endedVisit(60, "awaiting_signature"); // pending confirmation
    expect((await overview()).urgent.itemCount).toBe(before);
  });
});

describe("0059: the 48-hour boundary, exactly (one transaction so now() is the same instant for the shift and the overview)", () => {
  /** Offsets are seconds from the transaction's now() to the shift start. Everything is rolled back. */
  const classify = async (offsetSeconds: number, reasonFlag: "none" | "compliance" = "none") => {
    const c = await db.admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      const id = (await c.query(
        `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
         values ($1,$2,$3,null,$4, now() + make_interval(secs => $5::numeric), now() + make_interval(secs => $5::numeric + 7200), 'scheduled') returning id`,
        [w.orgA, fx.client, fx.service, reasonFlag === "compliance" ? recA2 : null, offsetSeconds])).rows[0].id as string;
      if (reasonFlag === "compliance") await c.query("insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail) values ($1,$2,$3,'compliance','compliance_hold','{}'::jsonb)", [w.orgA, id, recA2]);
      await c.query("set local session_replication_role = origin");
      await c.query("set local role ogevia_app");
      await c.query("select ogevia_api.begin_request($1, $2)", [w.managerA.sub, randomUUID()]);
      const o = (await c.query("select ogevia_api.get_attention_overview($1, 48) as o", [w.orgA])).rows[0].o;
      return { urgent: urgentItem(o, id) as any, upcoming: o.upcoming.shifts.find((s: any) => s.shiftId === id) as any, o };
    } finally {
      await c.query("rollback");
      c.release();
    }
  };
  const H48 = 48 * 3600;

  it("uncovered: 48 h minus a microsecond is Urgent, EXACTLY 48 h is Urgent, 48 h plus a microsecond is Upcoming", async () => {
    await wipeShifts();
    const before = await classify(H48 - 0.000001);
    expect(before.urgent).toMatchObject({ tier: "urgent" }); expect(before.upcoming).toBeUndefined();
    const at = await classify(H48);
    expect(at.urgent).toMatchObject({ tier: "urgent" }); expect(at.upcoming).toBeUndefined();
    const after = await classify(H48 + 0.000001);
    expect(after.urgent).toBeUndefined(); expect(after.upcoming).toBeDefined();
  });
  it("uncovered: exactly at its start is Critical, a microsecond before is Urgent", async () => {
    await wipeShifts();
    expect((await classify(0)).urgent).toMatchObject({ tier: "critical", severity: "red" });
    expect((await classify(0.000001)).urgent).toMatchObject({ tier: "urgent" });
    expect((await classify(-1)).urgent).toMatchObject({ tier: "critical" });
  });
  it("compliance-blocked: the same three boundaries, and the counts agree with the lists", async () => {
    await wipeShifts();
    const a = await classify(H48, "compliance");
    expect(a.urgent).toMatchObject({ tier: "urgent", reasons: ["compliance_hold"] });
    expect(a.upcoming).toBeUndefined();
    expect(a.o.urgent).toMatchObject({ itemCount: 1, urgent: 1, critical: 0 });
    expect(a.o.upcoming.count).toBe(0);
    const b = await classify(H48 + 0.000001, "compliance");
    expect(b.upcoming).toMatchObject({ reason: "compliance_hold" });
    expect(b.o.urgent.itemCount).toBe(0);
    expect(b.o.upcoming.count).toBe(1);
    expect((await classify(0, "compliance")).urgent).toMatchObject({ tier: "critical" });
  });
  it("every shift is in exactly one list: none is missing and none is in both", async () => {
    await wipeShifts();
    for (const off of [H48 - 1, H48, H48 + 1]) {
      const r = await classify(off);
      expect(Number(!!r.urgent) + Number(!!r.upcoming)).toBe(1);
    }
  });
});

describe("0059: administrator review is counted from when it really became ready for review", () => {
  const review = async () => (await overview()).visitReview;
  const park = async () => {
    await q("set session_replication_role = replica");
    await q("update ogevia.service_visits set status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Synthetic fixture' where caregiver_user_id = $1 and status in ('draft', 'awaiting_signature')", [w.caregiverA1.userId, w.managerA.userId]);
    await q("set session_replication_role = origin");
  };
  const entered = async (v: string) => (await q("select ogevia.visit_review_entered_at($1) t, extract(epoch from now() - ogevia.visit_review_entered_at($1)) / 3600 as hours", [v])).rows[0] as { t: Date | null; hours: string | null };
  const hoursAgo = (r: { hours: string | null }) => Number(r.hours);
  const setSigned = async (v: string, hours: number, mins = 0) => {
    await q("set session_replication_role = replica");
    await q("update ogevia.service_visits set signed_at = now() - make_interval(hours => $2, mins => $3) where id = $1", [v, hours, mins]);
    await q("set session_replication_role = origin");
  };
  /** A visit worked long ago that ONLY NOW goes to review: created 5 days ago, signed (= enters review) just now. */
  const reviewVisit = async () => {
    await park();
    const v = await api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service, null, "Synthetic: unscheduled");
    await ageVisit(db, v, 30);
    await api.end(db, w.caregiverA1, v);
    await q("set session_replication_role = replica");
    await q("update ogevia.service_visits set created_at = now() - interval '5 days' where id = $1", [v]);
    await q("set session_replication_role = origin");
    await api.confirm(db, w.caregiverA1, v, { method: "unable_to_confirm", reason: "Synthetic: client asleep" });
    return v;
  };

  it("a visit created 5 days ago that enters review now is NOT overdue: the clock is its entry, not its creation", async () => {
    const b = await review();
    const v = await reviewVisit();
    expect(hoursAgo(await entered(v))).toBeLessThan(0.1);
    const r = await review();
    expect(r.needsReview - b.needsReview).toBe(1);
    expect(r.reviewOverdue - b.reviewOverdue).toBe(0);
  });
  it("24 h boundary: 23 h 59 m is not overdue, 24 h 01 m is", async () => {
    const v = await reviewVisit();
    const b = await review();
    await setSigned(v, 23, 59);
    expect((await review()).reviewOverdue - b.reviewOverdue).toBe(0);
    await setSigned(v, 24, 1);
    expect((await review()).reviewOverdue - b.reviewOverdue).toBe(1);
  });
  it("a manager correction creates a NEW review item whose clock starts at the correction, however old the original was", async () => {
    const v = await reviewVisit();
    await setSigned(v, 30); // the original has been waiting 30 h
    const b = await review();
    const t0 = new Date(Date.now() - 3 * 3600_000), t1 = new Date(t0.getTime() + 40 * 60_000);
    const corrected = await api.correct(db, w.managerA, v, t0, t1, "Synthetic: client reported the right times");
    const row = (await q("select status from ogevia.service_visits where id = $1", [corrected])).rows[0];
    expect(row.status).toBe("administrator_review");
    expect(hoursAgo(await entered(corrected))).toBeLessThan(0.1);
    const r = await review();
    expect(r.needsReview - b.needsReview).toBe(0); // the original (corrected) leaves the queue, the new row enters
    expect(r.reviewOverdue - b.reviewOverdue).toBe(-1); // the 30 h old original no longer counts as overdue; the new one is not
  });
  it("a revoked review decision puts the visit back in the queue at the revocation, not at its first entry", async () => {
    const v = await reviewVisit();
    await setSigned(v, 40);
    const dec = await asActor(db, w.managerA.sub, async (c) => (await c.query("select ogevia_api.decide_visit_review($1,'close_not_billable','Synthetic: reviewed') as id", [v])).rows[0].id as string);
    const b = await review();
    await asActor(db, w.managerA.sub, (c) => c.query("select ogevia_api.revoke_visit_review_decision($1,'Synthetic: reopened')", [dec]));
    expect(hoursAgo(await entered(v))).toBeLessThan(0.1); // greatest(): the revocation, not the 40 h old signing
    const r = await review();
    expect(r.needsReview - b.needsReview).toBe(1);
    expect(r.reviewOverdue - b.reviewOverdue).toBe(0);
  });
  it("while a confirmation request is open the visit is waiting on the client; when it lapses the clock starts at the lapse", async () => {
    const v = await reviewVisit();
    await setSigned(v, 50);
    const req = await asActor(db, w.managerA.sub, async (c) => (await c.query("select request_id from ogevia_api.create_visit_confirmation_request($1,'paper','Synthetic Signer','client',null,null,null,7)", [v])).rows[0].request_id as string);
    const b = await review();
    expect(b.awaitingResponse).toBeGreaterThanOrEqual(1);
    await q("set session_replication_role = replica");
    await q("update ogevia.visit_confirmation_requests set created_at = now() - interval '10 days', expires_at = now() - interval '2 hours' where id = $1", [req]);
    await q("set session_replication_role = origin");
    const e = await entered(v);
    expect(hoursAgo(e)).toBeGreaterThan(1.9); expect(hoursAgo(e)).toBeLessThan(2.1); // the expiry, not the 50 h old signing
    const r = await review();
    expect(r.reviewOverdue).toBe(b.reviewOverdue); // 2 h in the queue: not escalated
  });
  it("a late client confirmation is its own item: its clock is when it arrived, it escalates after 24 h, and answering it ends it", async () => {
    const v = await reviewVisit();
    await setSigned(v, 60);
    const req = await asActor(db, w.managerA.sub, async (c) => (await c.query("select request_id from ogevia_api.create_visit_confirmation_request($1,'paper','Synthetic Signer','client',null,null,null,7)", [v])).rows[0].request_id as string);
    const lc = randomUUID();
    await q("set session_replication_role = replica");
    await q("update ogevia.visit_confirmation_requests set responded_at = now() - interval '3 hours' where id = $1", [req]);
    await q(`insert into ogevia.visit_late_confirmations (id, organization_id, visit_id, request_id, outcome, method, signer_name, signer_role, attestation_version, confirmed_visit_snapshot, received_at, response_key)
             values ($1,$2,$3,$4,'confirmed','typed','Synthetic Signer','client','test','{}'::jsonb, now() - interval '3 hours', $5)`, [lc, w.orgA, v, req, randomUUID()]);
    await q("set session_replication_role = origin");
    const b = await review();
    expect(b.lateResponses).toBeGreaterThanOrEqual(1);
    const lateAt = (await q("select extract(epoch from now() - ogevia.visit_late_response_at($1)) / 3600 h", [v])).rows[0].h;
    expect(Number(lateAt)).toBeGreaterThan(2.9); expect(Number(lateAt)).toBeLessThan(3.1);
    const base = (await review()).reviewOverdue;
    await q("set session_replication_role = replica");
    await q("update ogevia.visit_late_confirmations set received_at = now() - interval '24 hours 1 minute' where id = $1", [lc]);
    await q("set session_replication_role = origin");
    expect((await review()).reviewOverdue - base).toBe(1);
    // the office answers it: the late-response item ends, and the visit returns to ordinary review from the answer
    await asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia_api.review_late_visit_confirmation($1,'rejected','Synthetic: not accepted')", [lc]));
    expect((await review()).lateResponses).toBe(b.lateResponses - 1);
    expect(hoursAgo(await entered(v))).toBeLessThan(0.1);
  });
  it("a visit with no recorded timing is never escalated and no time is invented (null clock)", async () => {
    const v = await reviewVisit();
    const b = await review();
    await q("set session_replication_role = replica");
    await q("alter table ogevia.service_visits disable trigger user");
    await q("alter table ogevia.service_visits drop constraint service_visits_locked_shape");
    await q("update ogevia.service_visits set signed_at = null where id = $1", [v]);
    try {
      expect((await entered(v)).t).toBeNull();
      const r = await review();
      expect(r.needsReview - b.needsReview).toBe(0); // still counted, same visit
      expect(r.reviewOverdue - b.reviewOverdue).toBe(0); // never escalated
    } finally {
      await q("update ogevia.service_visits set signed_at = now() where id = $1", [v]);
      await q("alter table ogevia.service_visits add constraint service_visits_locked_shape CHECK ((status <> ALL (ARRAY['signed'::ogevia.service_visit_status, 'administrator_review'::ogevia.service_visit_status, 'corrected'::ogevia.service_visit_status])) OR verified_minutes IS NOT NULL AND billable_minutes IS NOT NULL AND authorization_status IS NOT NULL AND signed_at IS NOT NULL AND locked_at IS NOT NULL)");
      await q("alter table ogevia.service_visits enable trigger user");
      await q("set session_replication_role = origin");
    }
  });
});

describe("document review: routine apart, escalated after 48 h, sooner when expired or blocking care", () => {
  const types: Record<string, string> = {};
  const sha = "a".repeat(64);
  const mgr = () => w.managerA;
  const makeDoc = async (rec: string, type: string) =>
    (await call(mgr(), "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id as string;
  const upload = async (doc: string, opts: { issued?: string; expires?: string } = {}) => {
    const version = randomUUID();
    const r = await call(mgr(), "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)",
      [doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, opts.issued ?? null, opts.expires ?? null]);
    return r[0].document_version_id as string;
  };
  const age = async (version: string, hours: number) => {
    await q("set session_replication_role = replica");
    await q("update ogevia.document_versions set uploaded_at = now() - make_interval(hours => $2) where id = $1", [version, hours]);
    await q("set session_replication_role = origin");
  };
  const docs = async () => (await overview()).documents;

  beforeAll(async () => {
    types.cpr = (await call(mgr(), "select ogevia_api.create_document_type($1,'CPR card (tiers)',true,null) as id", [w.orgA]))[0].id;
    types.plain = (await call(mgr(), "select ogevia_api.create_document_type($1,'Orientation (tiers)',false,null) as id", [w.orgA]))[0].id;
    types.third = (await call(mgr(), "select ogevia_api.create_document_type($1,'Training (tiers)',false,null) as id", [w.orgA]))[0].id;
  });

  it("awaiting review inside 48 h is routine and is not in the escalated count; after 48 h it is escalated", async () => {
    const b = await docs();
    const doc = await makeDoc(recA1, types.plain!);
    const v = await upload(doc);
    await age(v, 47);
    let d = await docs();
    expect(d.reviewRoutine - b.reviewRoutine).toBe(1);
    expect(d.reviewOverdue - b.reviewOverdue).toBe(0);
    expect(d.awaitingReview - b.awaitingReview).toBe(1);
    await age(v, 49);
    d = await docs();
    expect(d.reviewRoutine - b.reviewRoutine).toBe(0);
    expect(d.reviewOverdue - b.reviewOverdue).toBe(1);
    expect(d.awaitingReview - b.awaitingReview).toBe(1); // the total is unchanged: it moved between the two
  });

  it("an expired document whose replacement awaits review is escalated at once", async () => {
    const b = await docs();
    const doc = await makeDoc(recA2, types.cpr!);
    const old = await upload(doc, { issued: "2020-01-01", expires: "2020-06-01" });
    await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null) as d", [old]);
    await upload(doc, { issued: today, expires: "2099-01-01" }); // uploaded just now
    const d = await docs();
    expect(d.reviewOverdue - b.reviewOverdue).toBe(1);
    expect(d.reviewRoutine - b.reviewRoutine).toBe(0);
  });

  it("a document that blocks care (its caregiver has an upcoming shift flagged for documents) is escalated at once", async () => {
    await wipeShifts();
    const b = await docs();
    const shift = await shiftAt(100, 3, recA1);
    await flag(shift, recA1, "document");
    const doc = await makeDoc(recA1, types.third!);
    await upload(doc); // uploaded just now, for a caregiver whose shift is blocked
    const d = await docs();
    expect(d.reviewOverdue - b.reviewOverdue).toBe(1);
  });

  it("routine review never inflates the urgent total, and overdue documents stay under documents", async () => {
    const o = await overview();
    expect(o.urgent.itemCount).toBe(o.urgent.items.length);
    expect(o.documents).toHaveProperty("overdue");
  });
});

describe("permissions and tenant isolation", () => {
  it("a caregiver is refused, another agency's manager gets Organization not found, and agency B's records never reach agency A's counts", async () => {
    await expectPgError(call(w.caregiverA1, "select ogevia_api.get_attention_overview($1,48)", [w.orgA]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.get_attention_overview($1,48)", [w.orgA]), "OGN04");
    const before = await overview();
    const fB = await freshClient(db, w, w.caregiverB1, 100000, w.orgB, { before: 5, after: 120 });
    const c = await db.admin.connect();
    try {
      await c.query("set session_replication_role = replica");
      await c.query(
        `insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status)
         values ($1,$2,$3, now() - interval '1 hour', now() + interval '2 hours', 'scheduled')`, [w.orgB, fB.client, fB.service]);
      await c.query("set session_replication_role = origin");
    } finally { c.release(); }
    const after = await overview();
    expect(after.urgent.itemCount).toBe(before.urgent.itemCount);
    expect(after.upcoming.count).toBe(before.upcoming.count);
    expect((await overview(w.managerB, 48, w.orgB)).urgent.critical).toBe(1); // agency B sees its own
  });
  it("a role without documents.read has no review counts; without billing no Ready for Approval; the sections stay null rather than zero", async () => {
    const s = await overview(w.schedulerA);
    expect(s.documents).not.toHaveProperty("reviewOverdue");
    expect(s.visitReview.readyForApproval).toBeNull();
    expect(s.urgent).not.toBeNull();
  });
});

describe("the caregiver's hold is enforced immediately, whatever tier the shift is shown in", () => {
  it("with enforcement active, a caregiver without clearance is refused new work (OGR30) while their far-off flagged shift is listed as Upcoming", async () => {
    await wipeShifts();
    const cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR (hold)',true,null) as id", [w.orgA]))[0].id;
    const tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB (hold)',false,null) as id", [w.orgA]))[0].id;
    await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
    await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
    const status = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
    await call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, status.affectedShiftsCount]);
    await q("delete from ogevia.caregiver_availability_windows where caregiver_record_id = $1", [recA2]);
    for (const d of [0, 1, 2, 3, 4, 5, 6]) await q("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'00:00','23:59')", [w.orgA, recA2, d]);
    await q("update ogevia.caregiver_records set hire_date = $2::date - 40 where id = $1", [recA2, today]);
    await q("delete from ogevia.caregiver_background_checks where caregiver_record_id = $1", [recA2]);
    const far = await shiftAt(100, 3, recA2);
    await flag(far, recA2, "compliance");
    const o = await overview();
    expect(o.upcoming.shifts.find((s: any) => s.shiftId === far)).toMatchObject({ reason: "compliance_hold" }); // shown as Upcoming...
    expect(urgentItem(o, far)).toBeUndefined();
    const d = new Date(Date.parse(`${today}T12:00:00Z`) + 3 * 864e5).toISOString().slice(0, 10);
    // ...yet new work for that caregiver is refused right now by the 0055 gate, exactly as before this migration
    await expectPgError(call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','10:00',$5,null)", [w.orgA, fx.client, fx.service, d, recA2]), "OGR30", /Background check/);
  });
});
void randomUUID;
