// 0073 Agency-configurable shorter deadlines and the one issue list with stable identity (Board 4 decisions 1, 3, 6, 7, 9, 10, 12, 13). SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, asReplica, createTestDb, expectPgError, freshClient, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let fx: { client: string; service: string; auth: string };
let recA1: string;
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const overview = (a: Actor = w.managerA) => call(a, "select ogevia_api.get_attention_overview($1,48) as o", [w.orgA]).then((r) => r[0].o);
const issues = (a: Actor = w.managerA, f: Record<string, unknown> = {}, org = w.orgA) =>
  call(a, "select ogevia_api.list_action_issues($1,$2,$3,$4,$5,$6,$7,$8,$9) as r", [org, f.queue ?? null, f.category ?? null, f.severity ?? null, f.client ?? null, f.caregiver ?? null, f.service ?? null, f.limit ?? 200, f.offset ?? 0]).then((r) => r[0].r);
const settings = (a: Actor, c: number | null, r: number | null, d: number | null, reason = "The agency wants quicker follow-up (synthetic)") =>
  call(a, "select ogevia_api.set_attention_settings($1,$2,$3,$4,$5) as s", [w.orgA, c, r, d, reason]).then((x) => x[0].s);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  recA1 = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id as string;
});
afterAll(async () => db?.drop());

async function endedAgo(minutesAgo: number) {
  await asReplica(db, "update ogevia.service_visits set status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Synthetic fixture' where caregiver_user_id = $1 and status in ('draft', 'awaiting_signature')", [w.caregiverA1.userId, w.managerA.userId]);
  const v = await api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service, null, "Synthetic: extra help");
  await ageVisit(db, v, 120);
  await api.end(db, w.caregiverA1, v);
  await asReplica(db, "update ogevia.service_visits set status = 'awaiting_signature', time_in = now() - make_interval(mins => $2 + 120), time_out = now() - make_interval(mins => $2) where id = $1", [v, minutesAgo]);
  return v;
}
async function shiftAt(hoursFromNow: number, hours: number, caregiver: string | null) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    return (await c.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,null,$4, now() + make_interval(secs => $5::numeric * 3600), now() + make_interval(secs => ($5::numeric + $6::numeric) * 3600), 'scheduled') returning id`,
      [w.orgA, fx.client, fx.service, caregiver, hoursFromNow, hours])).rows[0].id as string;
  } finally { await c.query("set session_replication_role = origin"); c.release(); }
}

describe("agency deadlines: shorter only, recorded, and used", () => {
  it("only the owner may change them; longer than the default, a short reason, and another agency are refused", async () => {
    await expectPgError(settings(w.managerA, 24, null, null), "OGA03");
    await expectPgError(settings(w.ownerA, 60, null, null), "OGV22");
    await expectPgError(settings(w.ownerA, 24, 30, null), "OGV22");
    await expectPgError(settings(w.ownerA, null, null, 0), "OGV22");
    await expectPgError(settings(w.ownerA, 24, null, null, "short"), "OGV22");
    await expectPgError(call(w.managerB, "select ogevia_api.get_attention_settings($1)", [w.orgA]), "OGN04");
    const got = await call(w.managerA, "select ogevia_api.get_attention_settings($1) as s", [w.orgA]).then((r) => r[0].s);
    expect(got).toMatchObject({ confirmationOverdueHours: 48, reviewOverdueHours: 24, documentReviewOverdueHours: 48 });
  });

  it("a shorter confirmation deadline moves a pending confirmation to overdue; the change is an append-only event with who, why, before and after; it never approves anything", async () => {
    const v = await endedAgo(30 * 60);
    let o = await overview();
    expect(o.visitReview).toMatchObject({ pendingConfirmation: 1, confirmationOverdue: 0 });
    const after = await settings(w.ownerA, 24, null, null);
    expect(after).toMatchObject({ confirmationOverdueHours: 24, reviewOverdueHours: 24 });
    o = await overview();
    expect(o.visitReview).toMatchObject({ pendingConfirmation: 0, confirmationOverdue: 1 });
    expect((await q("select status::text s from ogevia.service_visits where id = $1", [v])).rows[0].s).toBe("awaiting_signature"); // nothing approved or signed
    const ev = (await q("select reason, before_state, after_state, changed_by from ogevia.agency_attention_setting_events where organization_id = $1", [w.orgA])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ changed_by: w.ownerA.userId, before_state: { confirmationOverdueHours: 48 }, after_state: { confirmationOverdueHours: 24 } });
    await expectPgError(q("update ogevia.agency_attention_setting_events set reason = 'x'"), "OGC09");
    expect((await q("select count(*)::int n from ogevia.audit_events where action = 'attention.deadlines_changed' and organization_id = $1", [w.orgA])).rows[0].n).toBe(1);
    // another agency is untouched
    const other = await call(w.managerB, "select ogevia_api.get_attention_overview($1,48) as o", [w.orgB]).then((r) => r[0].o);
    expect(other.visitReview?.confirmationOverdue ?? 0).toBe(0);
    await settings(w.ownerA, null, null, null, "Back to the defaults (synthetic)");
    o = await overview();
    expect(o.visitReview).toMatchObject({ pendingConfirmation: 1, confirmationOverdue: 0 });
  });
});

describe("one issue list: counts equal the overview, stable keys, ordering, filters, paging", () => {
  let critical: string, urgent: string, upcoming: string, blocked: string;
  beforeAll(async () => {
    await q("delete from ogevia.shifts where organization_id = $1 and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = shifts.id)", [w.orgA]).catch(() => undefined);
    critical = await shiftAt(-1, 3, null);
    urgent = await shiftAt(10, 2, null);
    upcoming = await shiftAt(100, 2, null);
    blocked = await shiftAt(6, 2, recA1);
    await q("insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail) values ($1,$2,$3,'compliance','compliance_hold','{}'::jsonb)", [w.orgA, blocked, recA1]);
    await endedAgo(50 * 60); // confirmation overdue
  });

  it("the count by queue equals the overview, and the urgent total equals the sum of the urgent and critical issues", async () => {
    const o = await overview();
    const r = await issues();
    expect(r.counts.byQueue.needs_attention_now ?? 0).toBe(o.urgent.issueCount);
    expect(r.counts.byQueue.upcoming_staffing ?? 0).toBe(o.upcoming.count);
    const rows = r.issues as any[];
    expect(rows.filter((i) => i.queue === "needs_attention_now" && i.severity === "critical")).toHaveLength(o.urgent.items.filter((i: any) => i.tier === "critical").reduce((n: number, i: any) => n + i.reasons.length, 0));
    expect(rows.filter((i) => i.queue === "visit_review" && ["needs_review", "late_response", "confirmation_overdue"].includes(i.reason)).length).toBe(o.visitReview.visitsNeedingAttention);
    expect(rows.filter((i) => i.queue === "visit_review" && i.reason === "pending_confirmation").length).toBe(o.visitReview.pendingConfirmation);
    expect(r.matching).toBe(rows.length);
    expect(r.counts.total).toBe(rows.length);
  });

  it("keys are stable across calls, unique, and name the problem and the record; the same problem is the same issue every time", async () => {
    const a = (await issues()).issues as any[]; const b = (await issues()).issues as any[];
    expect(a.map((i) => i.issueKey)).toEqual(b.map((i) => i.issueKey));
    expect(new Set(a.map((i) => i.issueKey)).size).toBe(a.length);
    expect(a.find((i) => i.shiftId === critical)).toMatchObject({ issueKey: `shift:uncovered_open:${critical}`, severity: "critical", queue: "needs_attention_now", category: "coverage", action: "assign_caregiver" });
    expect(a.find((i) => i.shiftId === urgent)).toMatchObject({ severity: "urgent" });
    expect(a.find((i) => i.shiftId === upcoming)).toMatchObject({ severity: "routine", queue: "upcoming_staffing" });
    expect(a.find((i) => i.shiftId === blocked)).toMatchObject({ reason: "compliance_hold", category: "compliance", caregiverRecordId: recA1 });
  });

  it("ordered Critical, Urgent, Routine, then by deadline; every issue carries a recommended action", async () => {
    const rows = (await issues()).issues as any[];
    const rank = (s: string) => ({ critical: 0, urgent: 1, routine: 2 })[s]!;
    for (let i = 1; i < rows.length; i++) expect(rank(rows[i].severity)).toBeGreaterThanOrEqual(rank(rows[i - 1].severity));
    const urgentOnes = rows.filter((r) => r.severity === "urgent" && r.deadline);
    for (let i = 1; i < urgentOnes.length; i++) expect(Date.parse(urgentOnes[i].deadline)).toBeGreaterThanOrEqual(Date.parse(urgentOnes[i - 1].deadline));
    expect(rows.every((r) => typeof r.recommendedAction === "string" && r.recommendedAction.length > 10 && r.action)).toBe(true);
  });

  it("filters by queue, category, severity, client, caregiver and service; paging never repeats or loses an issue; unknown filters are refused", async () => {
    const all = (await issues()).issues as any[];
    expect((await issues(w.managerA, { severity: "critical" })).issues.every((i: any) => i.severity === "critical")).toBe(true);
    expect((await issues(w.managerA, { category: "coverage" })).issues.every((i: any) => i.category === "coverage")).toBe(true);
    expect((await issues(w.managerA, { queue: "upcoming_staffing" })).issues.every((i: any) => i.queue === "upcoming_staffing")).toBe(true);
    expect((await issues(w.managerA, { caregiver: recA1 })).issues.every((i: any) => i.caregiverRecordId === recA1)).toBe(true);
    expect((await issues(w.managerA, { client: fx.client, service: fx.service })).issues.length).toBeGreaterThan(0);
    expect((await issues(w.managerA, { client: w.clientA2 })).issues.filter((i: any) => i.clientId !== w.clientA2)).toHaveLength(0);
    const p1 = (await issues(w.managerA, { limit: 2, offset: 0 })).issues as any[];
    const p2 = (await issues(w.managerA, { limit: 2, offset: 2 })).issues as any[];
    expect(p1).toHaveLength(2);
    expect([...p1, ...p2].map((i) => i.issueKey)).toEqual(all.slice(0, p1.length + p2.length).map((i) => i.issueKey));
    await expectPgError(issues(w.managerA, { queue: "nope" }), "OGV22");
    await expectPgError(issues(w.managerA, { severity: "high" }), "OGV22");
  });

  it("permissions and tenants: a caregiver is refused; another agency sees none of these issues; a non-member is refused", async () => {
    await expectPgError(issues(w.caregiverA1), "OGA03");
    await expectPgError(issues(w.managerB, {}, w.orgA), "OGN04");
    await expectPgError(issues(w.outsider, {}, w.orgA), "OGN04");
    const other = (await issues(w.managerB, {}, w.orgB)).issues as any[];
    const mine = new Set(((await issues()).issues as any[]).map((i) => i.issueKey));
    expect(other.filter((i) => mine.has(i.issueKey))).toHaveLength(0);
  });
});

describe("issue history: opened, severity changed, resolved, reopened (as observed)", () => {
  it("records each transition once with who observed it; a repeat read adds nothing; reopening keeps the earlier history", async () => {
    const sh = await shiftAt(10, 2, null); // urgent
    const key = `shift:uncovered_open:${sh}`;
    await issues();
    await issues(); // nothing new
    let h = await call(w.managerA, "select ogevia_api.get_action_issue_history($1,$2) as h", [w.orgA, key]).then((r) => r[0].h);
    expect(h.events.map((e: any) => e.event)).toEqual(["opened"]);
    expect(h.state).toMatchObject({ status: "open", reopenCount: 0 });
    await q("update ogevia.shifts set starts_at = now() - interval '1 hour', ends_at = now() + interval '1 hour' where id = $1", [sh]); // now started: Critical
    await issues();
    await q("update ogevia.shifts set status = 'cancelled' where id = $1", [sh]); // gone
    await issues();
    await q("update ogevia.shifts set status = 'scheduled' where id = $1", [sh]); // back
    await issues();
    h = await call(w.managerA, "select ogevia_api.get_action_issue_history($1,$2) as h", [w.orgA, key]).then((r) => r[0].h);
    expect(h.events.map((e: any) => e.event)).toEqual(["opened", "severity_changed", "resolved", "reopened"]);
    expect(h.events.map((e: any) => e.severity)).toEqual(["urgent", "critical", "critical", "critical"]);
    expect(h.events.every((e: any) => e.observedByName)).toBe(true);
    expect(h.state).toMatchObject({ status: "open", reopenCount: 1 });
    await expectPgError(q("delete from ogevia.action_issue_events"), "OGC09");
    await expectPgError(call(w.managerB, "select ogevia_api.get_action_issue_history($1,$2)", [w.orgA, key]), "OGN04");
  });
});
