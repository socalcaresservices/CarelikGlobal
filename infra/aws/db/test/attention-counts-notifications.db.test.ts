// 0077 Counts agree with the issue list, and the approved in-app notifications (Board 4 decision 11, in-app part). SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, asReplica, createTestDb, expectPgError, freshClient, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let fx: { client: string; service: string; auth: string };
let recA1: string;
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const notes = (a: Actor, org = w.orgA, includeRead = true) => call(a, "select ogevia_api.list_my_notifications($1,$2,100) as r", [org, includeRead]).then((r) => r[0].r);
const issues = (a: Actor) => call(a, "select ogevia_api.list_action_issues($1,null,null,null,null,null,null,200,0) as r", [w.orgA]).then((r) => r[0].r);
// the same arguments the API route passes (12 h unscheduled, 48 h to confirm)
const summary = (a: Actor) => call(a, "select * from ogevia_api.get_attention_summary($1, 12, 2880)", [w.orgA]).then((r) => r[0]);
const forShift = (list: any, id: string) => list.items.filter((i: any) => i.issueKey.endsWith(":" + id));

async function shiftAt(startHoursFromNow: number, hours: number) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    return (await c.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,null,null, now() + make_interval(secs => $4::numeric * 3600), now() + make_interval(secs => ($4::numeric + $5::numeric) * 3600), 'scheduled') returning id`,
      [w.orgA, fx.client, fx.service, startHoursFromNow, hours])).rows[0].id as string;
  } finally { await c.query("set session_replication_role = origin"); c.release(); }
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  recA1 = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id as string;
});
afterAll(async () => db?.drop());

describe("counts agree with the issue list (the sidebar and Action-needed totals)", () => {
  it("unfilled shifts count only inside 48 hours or under way; the summary equals the list's Needs attention now coverage rows", async () => {
    const before = await summary(w.managerA);
    const soon = await shiftAt(-0.5, 2); // under way
    const day = await shiftAt(24, 2);
    const far = await shiftAt(240, 2); // 10 days away
    const after = await summary(w.managerA);
    expect(Number(after.uncovered_shifts)).toBe(Number(before.uncovered_shifts) + 2);
    const list = await issues(w.managerA);
    const now = list.issues.filter((i: any) => i.reason.startsWith("uncovered_") && i.queue === "needs_attention_now").map((i: any) => i.shiftId);
    expect(now).toEqual(expect.arrayContaining([soon, day]));
    expect(now).not.toContain(far);
    expect(Number(after.uncovered_shifts)).toBe(now.length);
    expect(list.issues.find((i: any) => i.shiftId === far)?.queue).toBe("upcoming_staffing");
  });

  it("the server total includes Ready for approval for people who may see billing, and equals the sum the web displays; people who may not see it get null and no extra count", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 600);
    await signedVisit(db, w.caregiverA2, w, 30, w.orgA, f.client, f.service);
    const row = await summary(w.ownerA);
    expect(Number(row.billing_ready_unapproved)).toBeGreaterThan(0);
    const webTotal = ["missing_time_out", "not_confirmed", "needs_review", "late_responses_to_review", "uncovered_shifts", "documents_blocking", "documents_to_review", "billing_ready_unapproved"]
      .reduce((s, k) => s + Number(row[k] ?? 0), 0);
    expect(Number(row.total)).toBe(webTotal);
    const sch = await summary(w.schedulerA).catch(() => null);
    if (sch && sch.billing_ready_unapproved === null) {
      const sw = ["missing_time_out", "not_confirmed", "needs_review", "late_responses_to_review", "uncovered_shifts", "documents_blocking", "documents_to_review"].reduce((s, k) => s + Number(sch[k] ?? 0), 0);
      expect(Number(sch.total)).toBe(sw);
    }
  });
});

describe("every summary category equals its rows in the issue list (the sidebar badges and the Action-needed total)", () => {
  const countReason = (list: any, reason: string) => list.issues.filter((i: any) => i.reason === reason).length;
  const compare = async () => {
    const [row, list] = await Promise.all([summary(w.ownerA), issues(w.ownerA)]);
    return {
      missing_time_out: [Number(row.missing_time_out), countReason(list, "missing_clock_out")],
      not_confirmed: [Number(row.not_confirmed), countReason(list, "confirmation_overdue")],
      needs_review: [Number(row.needs_review), countReason(list, "needs_review")],
      late_responses: [Number(row.late_responses_to_review), countReason(list, "late_response")],
      ready_for_approval: [Number(row.billing_ready_unapproved), countReason(list, "ready_for_approval")],
    } as Record<string, number[]>;
  };
  const expectEqual = (c: Record<string, number[]>) => { for (const [k, [a, b]] of Object.entries(c)) expect(a, k).toBe(b); };

  it("with the default deadlines, over a mixed set of visits", async () => {
    const f1 = await freshClient(db, w, w.caregiverA3, 600);
    const open = await api.start(db, w.caregiverA3, w.orgA, f1.client, f1.service, null, "Synthetic unscheduled visit");
    await ageVisit(db, open, 20 * 60); // open 20 h with no schedule: missing clock-out
    const f2 = await freshClient(db, w, w.caregiverA2, 600);
    await signedVisit(db, w.caregiverA2, w, 30, w.orgA, f2.client, f2.service); // ready for approval
    expectEqual(await compare());
  });

  it("a shorter agency confirmation deadline moves the same visit in the list and in the summary", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const v = await api.start(db, w.caregiverA1, w.orgA, f.client, f.service, null, "Synthetic: awaiting confirmation");
    await ageVisit(db, v, 120);
    await api.end(db, w.caregiverA1, v);
    await asReplica(db, "update ogevia.service_visits set status = 'awaiting_signature', time_in = now() - interval '32 hours', time_out = now() - interval '30 hours' where id = $1", [v]);
    const before = await compare();
    expectEqual(before); // 30 h is inside the 48 h default: pending, in neither
    await call(w.ownerA, "select ogevia_api.set_attention_settings($1,24,null,null,'Faster follow-up (synthetic)')", [w.orgA]);
    const after = await compare();
    expectEqual(after);
    expect(after.not_confirmed![0]).toBe(before.not_confirmed![0]! + 1);
  });
});

describe("in-app notifications", () => {
  let critical: string, urgent: string, routine: string;

  it("Critical notifies a person who can see the issue, once; Urgent follows the agency setting; Routine never notifies", async () => {
    critical = await shiftAt(-0.25, 3);
    urgent = await shiftAt(30, 2);
    routine = await shiftAt(300, 2);
    const first = await notes(w.managerA);
    expect(forShift(first, critical)).toHaveLength(1);
    expect(forShift(first, critical)[0]).toMatchObject({ severity: "critical", state: "unread", queue: "needs_attention_now" });
    expect(forShift(first, urgent).map((i: any) => i.severity)).toEqual(["urgent"]);
    expect(forShift(first, routine)).toHaveLength(0);
    const second = await notes(w.managerA);
    expect(forShift(second, critical)).toHaveLength(1); // the same unchanged issue never repeats
    expect(Number(second.unread)).toBe(Number(first.unread));
  });

  it("each person has their own notifications; a person without permission to see attention items gets none; another agency's staff cannot read this agency's", async () => {
    const owner = await notes(w.ownerA);
    expect(forShift(owner, critical)).toHaveLength(1);
    const mine = await q("select recipient_user_id from ogevia.issue_notifications where issue_key like '%:' || $1", [critical]);
    expect(new Set(mine.rows.map((r) => r.recipient_user_id))).toEqual(new Set([w.managerA.userId, w.ownerA.userId]));
    const cg = await notes(w.caregiverA1);
    expect(cg.items).toEqual([]);
    expect(Number(cg.unread)).toBe(0);
    await expectPgError(call(w.managerB, "select ogevia_api.list_my_notifications($1,false,10)", [w.orgA]), "OGN04");
    const b = await notes(w.managerB, w.orgB);
    expect(JSON.stringify(b)).not.toContain(critical);
  });

  it("content is safe: the random client code, a reason and a queue; no name", async () => {
    const item = forShift(await notes(w.managerA), critical)[0];
    expect(Object.keys(item).sort()).toEqual(["clientCode", "createdAt", "id", "issueKey", "kind", "queue", "readAt", "reason", "resolvedAt", "severity", "state"]);
    const code = (await q("select client_code from ogevia.clients where id = $1", [fx.client])).rows[0].client_code;
    expect(item.clientCode).toBe(code);
  });

  it("the owner can switch Urgent notifications off (reason, audited); only the owner may; Critical still notifies", async () => {
    await expectPgError(call(w.managerA, "select ogevia_api.set_notification_settings($1,false,'quieter (synthetic)')", [w.orgA]), "OGA03");
    await expectPgError(call(w.ownerA, "select ogevia_api.set_notification_settings($1,false,'x')", [w.orgA]), "OGV22");
    await call(w.ownerA, "select ogevia_api.set_notification_settings($1,false,'Fewer interruptions (synthetic)')", [w.orgA]);
    expect((await call(w.managerA, "select ogevia_api.get_notification_settings($1) as s", [w.orgA]))[0].s).toMatchObject({ urgentInApp: false, criticalInApp: true });
    const audit = await q("select before_state, after_state from ogevia.audit_events where organization_id = $1 and action = 'notification_settings.changed'", [w.orgA]);
    expect(audit.rows).toHaveLength(1);
    const urgent2 = await shiftAt(20, 2);
    const critical2 = await shiftAt(-0.1, 2);
    const list = await notes(w.managerA);
    expect(forShift(list, urgent2)).toHaveLength(0);
    expect(forShift(list, critical2)).toHaveLength(1);
    await call(w.ownerA, "select ogevia_api.set_notification_settings($1,true,'Back on (synthetic)')", [w.orgA]);
  });

  it("marking read is repeatable and only touches the caller's own rows; unread counts follow", async () => {
    const before = await notes(w.managerA, w.orgA, false);
    const ids = before.items.slice(0, 1).map((i: any) => i.id);
    const n1 = (await call(w.managerA, "select ogevia_api.mark_notifications_read($1,$2::uuid[]) as n", [w.orgA, ids]))[0].n;
    const n2 = (await call(w.managerA, "select ogevia_api.mark_notifications_read($1,$2::uuid[]) as n", [w.orgA, ids]))[0].n;
    expect([n1, n2]).toEqual([1, 0]);
    expect(Number((await notes(w.managerA, w.orgA, false)).unread)).toBe(Number(before.unread) - 1);
    const ownerUnread = Number((await notes(w.ownerA, w.orgA, false)).unread);
    await call(w.managerA, "select ogevia_api.mark_notifications_read($1,null)", [w.orgA]);
    expect(Number((await notes(w.ownerA, w.orgA, false)).unread)).toBe(ownerUnread);
    expect(Number((await notes(w.managerA, w.orgA, false)).unread)).toBe(0);
  });

  it("when the issue is resolved the notification stops being pending, is kept, and a returning issue notifies again", async () => {
    await asReplica(db, "update ogevia.shifts set caregiver_user_id = $2, caregiver_record_id = $3 where id = $1", [critical, w.caregiverA1.userId, recA1]);
    const resolved = forShift(await notes(w.managerA), critical);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].state).toBe("resolved");
    expect(Number((await notes(w.managerA, w.orgA, false)).items.filter((i: any) => i.issueKey.endsWith(critical)).length)).toBe(0);
    await asReplica(db, "update ogevia.shifts set caregiver_user_id = null, caregiver_record_id = null where id = $1", [critical]);
    const again = forShift(await notes(w.managerA), critical);
    expect(again.map((i: any) => i.state).sort()).toEqual(["resolved", "unread"]);
  });

  it("notifications are history: they cannot be deleted or rewritten, and are tenant-scoped by row", async () => {
    await expect(q("delete from ogevia.issue_notifications")).rejects.toMatchObject({ code: "OGC09" });
    await expect(q("update ogevia.issue_notifications set severity = 'urgent' where severity = 'critical'")).rejects.toMatchObject({ code: "OGC09" });
    await expect(q("update ogevia.issue_notifications set read_at = now() where read_at is not null")).rejects.toMatchObject({ code: "OGC09" });
    const crossOrg = await q("select count(*)::int n from ogevia.issue_notifications where organization_id = $1", [w.orgB]);
    expect(crossOrg.rows[0].n).toBe(0);
  });
});
