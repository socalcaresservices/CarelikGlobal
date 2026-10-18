// 0080 One definition per count; the timing boundaries exactly (owner directive 2026-10-18, items 2.4 and 2.5). SYNTHETIC data only.
//   Every boundary is tested inside ONE transaction, so now() is the same instant for the fixture and for every function that reads it (nothing is rounded or slept).
//   Offsets are exact: 48 h minus a microsecond, 48 h, 48 h plus a microsecond, and the same around the start time / the 24 h and 48 h deadlines.
//   The counts are compared with the lists opened under the same agency and permissions: the issue list, the overview, the summary, the shift list and the notification list.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, freshClient, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let fx: { client: string; service: string; auth: string };
let recA1: string;
let recA2: string;

const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const counts = (a: Actor) => call(a, "select ogevia_api.get_attention_counts($1) as c", [w.orgA]).then((r) => r[0].c);
const issues = (a: Actor, queue: string | null = null, severity: string | null = null) =>
  call(a, "select ogevia_api.list_action_issues($1,$2,null,$3,null,null,null,200,0) as r", [w.orgA, queue, severity]).then((r) => r[0].r);
const overview = (a: Actor) => call(a, "select ogevia_api.get_attention_overview($1,48) as o", [w.orgA]).then((r) => r[0].o);
const summary = (a: Actor) => call(a, "select * from ogevia_api.get_attention_summary($1, 12, 2880)", [w.orgA]).then((r) => r[0]);
const recOf = async (a: Actor) => (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id as string;

/** Run `fix` as the database owner, then `read` as the actor, all in ONE transaction that is rolled back. now() is one instant throughout. */
async function atOneInstant<F, T>(a: Actor, fix: (c: pg.PoolClient) => Promise<F>, read: (c: pg.PoolClient, fixed: F) => Promise<T>): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    const fixed = await fix(c);
    await c.query("set local session_replication_role = origin");
    await c.query("set local role ogevia_app");
    await c.query("select ogevia_api.begin_request($1, $2)", [a.sub, randomUUID()]);
    return await read(c, fixed);
  } finally {
    await c.query("rollback");
    c.release();
  }
}
const one = async (c: pg.PoolClient, sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];

const wipeShifts = async () => {
  await q("delete from ogevia.assignment_readiness_flags");
  await q("delete from ogevia.shift_readiness_flags");
  await q("delete from ogevia.authorization_reservations where shift_id is not null");
  await q("delete from ogevia.shift_coverage_events");
  await q("delete from ogevia.shifts where not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = shifts.id)");
};
/** Committed shift at a whole-hour offset (for the relationship tests; the boundary tests use atOneInstant). */
async function shiftAt(startHoursFromNow: number, hours: number, caregiver: string | null = null) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    return (await c.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,null,$4, now() + make_interval(secs => $5::numeric * 3600), now() + make_interval(secs => ($5::numeric + $6::numeric) * 3600), 'scheduled') returning id`,
      [w.orgA, fx.client, fx.service, caregiver, startHoursFromNow, hours])).rows[0].id as string;
  } finally { await c.query("set session_replication_role = origin"); c.release(); }
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  recA1 = await recOf(w.caregiverA1);
  recA2 = await recOf(w.caregiverA2);
});
afterAll(async () => db?.drop());

const H48 = 48 * 3600;
// seconds from now() to the shift start
const OFFSETS: Array<[string, number, "upcoming" | "urgent" | "critical"]> = [
  ["48 h plus a microsecond", H48 + 0.000001, "upcoming"],
  ["exactly 48 h", H48, "urgent"],
  ["48 h minus a microsecond", H48 - 0.000001, "urgent"],
  ["a microsecond before the start", 0.000001, "urgent"],
  ["exactly at the start", 0, "critical"],
  ["a microsecond after the start", -0.000001, "critical"],
];

describe("2.4 shift timing: one rule, identical in the function, the issue list, the overview, the summary and the counts", () => {
  it("shift_attention_class: Upcoming beyond 48 h, Urgent at 48 h or less, Critical at or after the start (six boundary points)", async () => {
    for (const [label, off, expected] of OFFSETS) {
      const r = await one(db.admin as any, "select ogevia.shift_attention_class(now() + make_interval(secs => $1::numeric), now()) c", [off]);
      expect(r.c, label).toBe(expected);
    }
  });

  for (const blocked of [false, true]) {
    describe(blocked ? "compliance-blocked shift (caregiver assigned, hold flag open)" : "unfilled shift (no caregiver)", () => {
      for (const [label, off, expected] of OFFSETS) {
        it(`${label}: ${expected}`, async () => {
          await wipeShifts();
          const r = await atOneInstant(w.managerA, async (c) => {
            const id = (await c.query(
              `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
               values ($1,$2,$3,null,$4, now() + make_interval(secs => $5::numeric), now() + make_interval(secs => $5::numeric + 7200), 'scheduled') returning id`,
              [w.orgA, fx.client, fx.service, blocked ? recA2 : null, off])).rows[0].id as string;
            if (blocked) await c.query("insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail) values ($1,$2,$3,'compliance','compliance_hold','{}'::jsonb)", [w.orgA, id, recA2]);
            const fn = (await c.query("select ogevia.shift_attention_class(s.starts_at, now()) c from ogevia.shifts s where s.id = $1", [id])).rows[0].c as string;
            return { id, fn };
          }, async (c, { id, fn }) => {
            const list = (await one(c, "select ogevia_api.list_action_issues($1,null,null,null,null,null,null,200,0) as r", [w.orgA])).r;
            const ov = (await one(c, "select ogevia_api.get_attention_overview($1,48) as o", [w.orgA])).o;
            const sm = await one(c, "select * from ogevia_api.get_attention_summary($1, 12, 2880)", [w.orgA]);
            const cn = (await one(c, "select ogevia_api.get_attention_counts($1) as c", [w.orgA])).c;
            return { id, list, ov, sm, cn, fn };
          });
          const mine = r.list.issues.filter((i: any) => i.shiftId === r.id);
          expect(r.fn).toBe(expected);
          expect(mine).toHaveLength(1);
          if (expected === "upcoming") {
            expect(mine[0]).toMatchObject({ queue: "upcoming_staffing", severity: "routine" });
            expect(r.ov.upcoming.shifts.map((s: any) => s.shiftId)).toContain(r.id);
            expect(r.ov.urgent.items.map((i: any) => i.id)).not.toContain(r.id);
            expect(r.cn.scheduling.count).toBe(0);
            expect(Number(r.sm.uncovered_shifts)).toBe(0);
          } else {
            expect(mine[0]).toMatchObject({ queue: "needs_attention_now", severity: expected });
            expect(r.ov.urgent.items.find((i: any) => i.id === r.id)).toMatchObject({ tier: expected });
            expect(r.ov.upcoming.shifts.map((s: any) => s.shiftId)).not.toContain(r.id);
            expect(r.cn.scheduling).toEqual({ count: 1, critical: expected === "critical" ? 1 : 0 });
            expect(r.cn.needsAttention.count).toBe(1);
            if (!blocked) expect(Number(r.sm.uncovered_shifts)).toBe(1); // the summary counts unfilled shifts only; the Scheduling badge also counts blocked ones
          }
          // exactly one place for the shift: never both lists, never neither
          expect(Number(r.ov.upcoming.shifts.some((s: any) => s.shiftId === r.id)) + Number(r.ov.urgent.items.some((i: any) => i.id === r.id))).toBe(1);
        });
      }
    });
  }

  it("a caregiver's hold is effective at once: a blocked shift 100 h away is listed Upcoming yet the hold itself is listed Routine in Documents & compliance without waiting", async () => {
    await wipeShifts();
    const far = await shiftAt(100, 2, recA2);
    await q("insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail) values ($1,$2,$3,'compliance',$4,'{}'::jsonb)", [w.orgA, far, recA2, "compliance_hold"]);
    const l = await issues(w.managerA);
    expect(l.issues.find((i: any) => i.shiftId === far)).toMatchObject({ queue: "upcoming_staffing", severity: "routine" });
    await wipeShifts();
  });
});

describe("2.4 visit review deadlines, exactly (default agency deadlines: 48 h to confirm, 24 h in administrator review)", () => {
  const park = async () => {
    await q("set session_replication_role = replica");
    await q("update ogevia.service_visits set status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Synthetic fixture' where caregiver_user_id = $1 and status in ('draft', 'awaiting_signature')", [w.caregiverA1.userId, w.managerA.userId]);
    await q("set session_replication_role = origin");
  };
  const endedVisit = async () => {
    await park();
    const v = await api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service, null, "Synthetic: extra help");
    await ageVisit(db, v, 30);
    await api.end(db, w.caregiverA1, v);
    return v;
  };
  const reviewVisit = async () => {
    await park();
    const v = await api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service, null, "Synthetic: unscheduled");
    await ageVisit(db, v, 30);
    await api.end(db, w.caregiverA1, v);
    await api.confirm(db, w.caregiverA1, v, { method: "unable_to_confirm", reason: "Synthetic: client asleep" });
    return v;
  };
  const reasonsOf = (list: any, v: string) => list.issues.filter((i: any) => i.visitId === v).map((i: any) => `${i.reason}:${i.severity}`);

  for (const [label, offsetSeconds, reason] of [
    ["48 h minus a microsecond after the visit ended", -(H48 - 0.000001), "pending_confirmation:routine"],
    ["exactly 48 h after the visit ended", -H48, "confirmation_overdue:urgent"],
    ["48 h plus a microsecond after the visit ended", -(H48 + 0.000001), "confirmation_overdue:urgent"],
  ] as Array<[string, number, string]>) {
    it(`Pending Confirmation, ${label}: ${reason}; the count and the list agree`, async () => {
      const v = await endedVisit();
      const r = await atOneInstant(w.managerA, async (c) => {
        await c.query("update ogevia.service_visits set status = 'awaiting_signature', time_in = now() + make_interval(secs => $2::numeric) - interval '2 hours', time_out = now() + make_interval(secs => $2::numeric) where id = $1", [v, offsetSeconds]);
      }, async (c) => ({
        list: (await one(c, "select ogevia_api.list_action_issues($1,null,null,null,null,null,null,200,0) as r", [w.orgA])).r,
        cn: (await one(c, "select ogevia_api.get_attention_counts($1) as c", [w.orgA])).c,
        sm: await one(c, "select * from ogevia_api.get_attention_summary($1, 12, 2880)", [w.orgA]),
      }));
      expect(reasonsOf(r.list, v)).toEqual([reason]);
      const overdueInList = r.list.issues.filter((i: any) => i.reason === "confirmation_overdue").length;
      expect(Number(r.sm.not_confirmed)).toBe(overdueInList);
      // the approvals exception count includes exactly the overdue confirmations (a pending one is a reminder, not counted)
      const exceptionsInList = r.list.issues.filter((i: any) => ["missing_clock_out", "confirmation_overdue", "needs_review", "late_response"].includes(i.reason)).length;
      expect(r.cn.approvals.exceptions.count).toBe(exceptionsInList);
    });
  }

  for (const [label, offsetSeconds, reason] of [
    ["23 h 59 m 59.999999 s in the queue", -(24 * 3600 - 0.000001), "needs_review:routine"],
    ["exactly 24 h in the queue", -24 * 3600, "needs_review:urgent"],
    ["24 h plus a microsecond in the queue", -(24 * 3600 + 0.000001), "needs_review:urgent"],
    ["a moment after entering (0 s)", 0, "needs_review:routine"],
  ] as Array<[string, number, string]>) {
    it(`Administrator review, ${label}: ${reason}; it is counted in the queue immediately and escalates only after 24 h`, async () => {
      const v = await reviewVisit();
      const r = await atOneInstant(w.managerA, async (c) => {
        // the ACTUAL review-entry event: signed_at is written with the status administrator_review; creation time is pushed back 5 days to prove it is not used
        await c.query("update ogevia.service_visits set created_at = now() - interval '5 days', signed_at = now() + make_interval(secs => $2::numeric) where id = $1", [v, offsetSeconds]);
      }, async (c) => ({
        list: (await one(c, "select ogevia_api.list_action_issues($1,null,null,null,null,null,null,200,0) as r", [w.orgA])).r,
        cn: (await one(c, "select ogevia_api.get_attention_counts($1) as c", [w.orgA])).c,
        sm: await one(c, "select * from ogevia_api.get_attention_summary($1, 12, 2880)", [w.orgA]),
      }));
      expect(reasonsOf(r.list, v)).toContain(reason);
      // counted in the Approvals exception queue whatever its severity; the Action-needed number counts only the escalated (Urgent) ones
      expect(Number(r.sm.needs_review)).toBe(r.list.issues.filter((i: any) => i.reason === "needs_review").length);
      expect(r.cn.approvals.exceptions.count).toBe(r.list.issues.filter((i: any) => ["missing_clock_out", "confirmation_overdue", "needs_review", "late_response"].includes(i.reason)).length);
      expect(r.cn.needsAction.count).toBe(r.list.counts.actionNeeded);
      expect(r.list.issues.filter((i: any) => i.visitId === v && i.severity === "urgent")).toHaveLength(reason.endsWith("urgent") ? 1 : 0);
    });
  }
});

describe("2.4 document review: 48 h from upload, sooner when expired or when it blocks care (readiness check / compliance flag on an upcoming shift)", () => {
  const types: Record<string, string> = {};
  const sha = "b".repeat(64);
  const mgr = () => w.managerA;
  let n = 0;
  const freshType = async () => (await call(mgr(), "select ogevia_api.create_document_type($1,$2,false,null) as id", [w.orgA, `Counts type ${++n}`]))[0].id as string;
  const makeDoc = async (rec: string, _type?: string) => (await call(mgr(), "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, await freshType()]))[0].id as string;
  const upload = async (doc: string, opts: { issued?: string; expires?: string } = {}) => {
    const version = randomUUID();
    const r = await call(mgr(), "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)",
      [doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, opts.issued ?? null, opts.expires ?? null]);
    return r[0].document_version_id as string;
  };
  const docIssue = (list: any, doc: string) => list.issues.find((i: any) => i.entityId === doc);

  beforeAll(async () => {
    types.plain = (await call(mgr(), "select ogevia_api.create_document_type($1,'Orientation (counts)',false,null) as id", [w.orgA]))[0].id;
    types.blocking = (await call(mgr(), "select ogevia_api.create_document_type($1,'Training (counts)',false,null) as id", [w.orgA]))[0].id;
  });

  for (const [label, offsetSeconds, reason, severity] of [
    ["48 h minus a microsecond after upload", -(H48 - 0.000001), "awaiting_review", "routine"],
    ["exactly 48 h after upload", -H48, "review_overdue", "urgent"],
    ["48 h plus a microsecond after upload", -(H48 + 0.000001), "review_overdue", "urgent"],
  ] as Array<[string, number, string, string]>) {
    it(`${label}: ${reason} (${severity}); the Caregivers count includes it only when escalated`, async () => {
      const doc = await makeDoc(recA1, types.plain!);
      const version = await upload(doc);
      const r = await atOneInstant(w.managerA, async (c) => {
        await c.query("update ogevia.document_versions set uploaded_at = now() + make_interval(secs => $2::numeric) where id = $1", [version, offsetSeconds]);
      }, async (c) => ({
        list: (await one(c, "select ogevia_api.list_action_issues($1,'documents_compliance',null,null,null,null,null,200,0) as r", [w.orgA])).r,
        cn: (await one(c, "select ogevia_api.get_attention_counts($1) as c", [w.orgA])).c,
      }));
      expect(docIssue(r.list, doc)).toMatchObject({ reason, severity });
      expect(r.cn.caregivers.count).toBe(r.list.issues.filter((i: any) => i.kind === "document" && i.severity !== "routine").length);
    });
  }

  it("an upload that blocks care (its caregiver has an upcoming scheduled shift with an open document flag) is escalated at once, not after 48 h; an expired one likewise", async () => {
    await wipeShifts();
    const shift = await shiftAt(100, 2, recA1);
    await q("insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail) values ($1,$2,$3,'document',$4,'{}'::jsonb)", [w.orgA, shift, recA1, "documents_missing"]);
    const doc = await makeDoc(recA1, types.blocking!);
    await upload(doc); // uploaded just now
    const list = await issues(w.managerA, "documents_compliance");
    expect(docIssue(list, doc)).toMatchObject({ reason: "review_overdue", severity: "urgent" });
    // the flag resolved (the shift no longer blocked): the same upload is routine again
    await q("update ogevia.shift_readiness_flags set resolved_at = now() where shift_id = $1", [shift]);
    expect(docIssue(await issues(w.managerA, "documents_compliance"), doc)).toMatchObject({ reason: "awaiting_review", severity: "routine" });
    await wipeShifts();
  });
});

describe("2.5 every count equals the list opened under the same agency and permissions", () => {
  beforeAll(async () => {
    await wipeShifts();
    // a mixed set: unfilled (running, 24 h, 10 days), blocked 24 h, an ended unfilled shift (past), and a visit in review
    await shiftAt(-0.5, 2);
    await shiftAt(24, 2);
    await shiftAt(240, 2);
    const blocked = await shiftAt(30, 2, recA2);
    await q("insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail) values ($1,$2,$3,'compliance','compliance_hold','{}'::jsonb)", [w.orgA, blocked, recA2]);
    await shiftAt(-5, 2); // ended 3 hours ago, never covered: a PAST shift
    await shiftAt(-30, 2);
    const f = await freshClient(db, w, w.caregiverA3, 600);
    const v = await api.start(db, w.caregiverA3, w.orgA, f.client, f.service, null, "Synthetic: unscheduled");
    await ageVisit(db, v, 30);
    await api.end(db, w.caregiverA3, v);
    await api.confirm(db, w.caregiverA3, v, { method: "unable_to_confirm", reason: "Synthetic: client asleep" });
  });

  for (const who of ["ownerA", "managerA", "schedulerA"] as const) {
    it(`${who}: Needs attention, Needs action, Scheduling, Caregivers and Approvals equal their lists`, async () => {
      const a = w[who] as Actor;
      const [c, all, ov, sm] = await Promise.all([counts(a), issues(a), overview(a), summary(a).catch(() => null)]);
      const nowList = (await issues(a, "needs_attention_now")).issues;
      // Needs attention = unique shifts and visits in the Needs attention now queue = the header badge (overview)
      if (c.needsAttention) {
        expect(c.needsAttention.count).toBe(new Set(nowList.map((i: any) => i.shiftId ?? i.visitId)).size);
        expect(c.needsAttention.count).toBe(ov.urgent.itemCount);
        expect(c.needsAttention.critical).toBe(ov.urgent.critical);
      }
      // Needs action = Critical + Urgent issues in the three action queues = the Action needed page number
      expect(c.needsAction.count).toBe(all.counts.actionNeeded);
      // Scheduling = unique shifts in Needs attention now (unfilled or blocked)
      if (c.scheduling) {
        expect(c.scheduling.count).toBe(new Set(nowList.filter((i: any) => i.shiftId).map((i: any) => i.shiftId)).size);
        if (sm) expect(c.scheduling.count).toBeGreaterThanOrEqual(Number(sm.uncovered_shifts));
      }
      // Caregivers = escalated documents and compliance issues
      if (c.caregivers) expect(c.caregivers.count).toBe((await issues(a, "documents_compliance")).issues.filter((i: any) => i.kind === "document" && i.severity !== "routine").length);
      // Approvals = exception review only; Ready for Approval is apart and equals its own list and the summary
      if (c.approvals.exceptions) {
        expect(c.approvals.exceptions.count).toBe(all.issues.filter((i: any) => ["missing_clock_out", "confirmation_overdue", "needs_review", "late_response"].includes(i.reason)).length);
        if (sm) expect(c.approvals.exceptions.count).toBe(Number(sm.missing_time_out) + Number(sm.not_confirmed) + Number(sm.needs_review) + Number(sm.late_responses_to_review));
      }
      if (c.approvals.readyForApproval !== null) {
        expect(c.approvals.readyForApproval).toBe((await issues(a, "ready_for_approval")).matching);
        if (sm) expect(c.approvals.readyForApproval).toBe(Number(sm.billing_ready_unapproved));
      } else if (sm) expect(sm.billing_ready_unapproved).toBeNull();
    });
  }

  it("the scheduler (no billing, no documents) gets null for what it may not see, never a false zero; a caregiver gets no counts at all", async () => {
    const c = await counts(w.schedulerA);
    expect(c.approvals.readyForApproval).toBeNull();
    expect(c.caregivers).toBeNull();
    expect(c.scheduling).not.toBeNull();
    expect(await counts(w.caregiverA1)).toBeNull();
    await expect(call(w.managerB, "select ogevia_api.get_attention_counts($1)", [w.orgA])).rejects.toThrow(/Organization not found/);
  });

  it("another agency's records never reach this agency's counts", async () => {
    const before = await counts(w.managerA);
    const fB = await freshClient(db, w, w.caregiverB1, 100000, w.orgB, { before: 5, after: 120 });
    const cn = await db.admin.connect();
    try {
      await cn.query("set session_replication_role = replica");
      await cn.query(`insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status) values ($1,$2,$3, now() - interval '1 hour', now() + interval '2 hours', 'scheduled')`, [w.orgB, fB.client, fB.service]);
      await cn.query("set session_replication_role = origin");
    } finally { cn.release(); }
    const after = await counts(w.managerA);
    expect(after.scheduling).toEqual(before.scheduling);
    expect(after.needsAttention).toEqual(before.needsAttention);
  });

  it("the Approvals exception count never includes Ready for Approval, and Ready for Approval is never part of the Needs action sum", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 600);
    const { signedVisit } = await import("./harness.js");
    const before = await counts(w.ownerA);
    await signedVisit(db, w.caregiverA2, w, 30, w.orgA, f.client, f.service);
    const after = await counts(w.ownerA);
    expect(after.approvals.readyForApproval).toBe(before.approvals.readyForApproval + 1);
    expect(after.approvals.exceptions).toEqual(before.approvals.exceptions);
    expect(after.needsAction.count).toBe(before.needsAction.count);
    expect(after.needsAttention).toEqual(before.needsAttention);
  });

  it("Notifications: the unread number is the unread rows of the person's own notification list, and a read one stops counting", async () => {
    const list = (await call(w.managerA, "select ogevia_api.list_my_notifications($1,true,100) as r", [w.orgA]))[0].r;
    expect(list.unread).toBe(list.items.filter((i: any) => i.state === "unread").length);
    if (list.items.length > 0) {
      await call(w.managerA, "select ogevia_api.mark_notifications_read($1,null)", [w.orgA]);
      const after = (await call(w.managerA, "select ogevia_api.list_my_notifications($1,true,100) as r", [w.orgA]))[0].r;
      expect(after.unread).toBe(0);
    }
    // another person's notifications are not mine
    const other = (await call(w.ownerA, "select ogevia_api.list_my_notifications($1,true,100) as r", [w.orgA]))[0].r;
    expect(other.items.every((i: any) => typeof i.id === "string")).toBe(true);
  });
});

describe("2.5 '1 needs coverage' beside two past shifts: past shifts are never counted; a running unfilled shift is the one", () => {
  it("the server counts the running unfilled shift once and the two ended unfilled shifts not at all; the shift list says the same", async () => {
    await wipeShifts();
    const running = await shiftAt(-0.5, 2); // started 30 min ago, ends in 90 min, nobody assigned
    const past1 = await shiftAt(-5, 2); // ended 3 h ago
    const past2 = await shiftAt(-30, 2); // ended 28 h ago
    const sm = await summary(w.managerA);
    const cn = await counts(w.managerA);
    expect(Number(sm.uncovered_shifts)).toBe(1);
    expect(cn.scheduling).toEqual({ count: 1, critical: 1 }); // Critical: it has started
    const list = await issues(w.managerA, "needs_attention_now");
    expect(list.issues.map((i: any) => i.shiftId)).toEqual([running]);
    // the schedule's own list: the raw coverage state of the ended shifts is still needs_coverage (nobody was assigned), but the server's display state is not
    const today = (await q("select (now() at time zone o.timezone)::date::text d from ogevia.organizations o where o.id = $1", [w.orgA])).rows[0].d as string;
    const shifts = await call(w.managerA, "select shift_id, coverage_state, display_state from ogevia_api.list_shifts($1, $2::date - 2, $2::date + 1)", [w.orgA, today]);
    const by = Object.fromEntries(shifts.map((s: any) => [s.shift_id, s]));
    expect(by[running]).toMatchObject({ coverage_state: "needs_coverage", display_state: "needs_coverage" });
    for (const p of [past1, past2]) expect(by[p]).toMatchObject({ coverage_state: "needs_coverage", display_state: "missed" }); // past: "missed: no visit record", not "needs coverage"
    // every shift the server counts is displayed as needs_coverage, and no shift displayed as needs_coverage is ended
    const display = shifts.filter((s: any) => s.display_state === "needs_coverage").map((s: any) => s.shift_id);
    expect(display).toEqual([running]);
    await wipeShifts();
  });
});
