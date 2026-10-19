// 'Over limit' in Action needed (migration 0084; owner decision 2026-10-18: pay all actual hours worked, warn about overages, never bill beyond the monthly authorized hours).
// One Urgent issue per authorization lineage for the agency-local month in which committed minutes (Billable + Rounding + Pending + Reserved, the per-authorization
// Over limit figure) exceed Authorized. It is in the issue list, the counts (which equal the list), the category/queue filters and the in-app notifications, with a stable
// identity (resolves when Over limit returns to 0, reappears if it recurs), and only for people who hold visits.read. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
});
afterAll(async () => db?.drop());

type Fx = { client: string; service: string; auth: string; cg: Actor };
const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
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
  return { ...(await freshClient(db, w, cg, minutes)), cg };
}
const recordOf = async (a: Actor) => (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [a.userId, w.orgA])).rows[0].id as string;
/** a reserved (scheduled, not yet started) shift of `minutes` against the fixture authorization, counted in today's month: fixture, not a product path. Far enough ahead that a visit started now is not linked to it. */
async function reservedShift(f: Fx, minutes: number) {
  const shift = (await db.admin.query(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3,$4,$5, now() + interval '30 hours', now() + interval '30 hours' + make_interval(mins => $6), 'scheduled', a.lineage_id
     from ogevia.client_authorizations a where a.id = $7 returning id`, [w.orgA, f.client, f.service, f.cg.userId, await recordOf(f.cg), minutes, f.auth])).rows[0].id as string;
  await db.admin.query(
    `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
     select $1, a.lineage_id, null, $2, $3::date, $4 from ogevia.client_authorizations a where a.id = $5`, [w.orgA, shift, today, minutes, f.auth]);
  return shift;
}
const release = (shift: string) => db.admin.query("update ogevia.authorization_reservations set released_at = now(), release_reason = 'cancelled' where shift_id = $1", [shift]);
const endedUnscheduled = async (f: Fx, worked: number) => {
  const v = await api.start(db, f.cg, w.orgA, f.client, f.service, null, "Client asked for extra help (synthetic)");
  await ageVisit(db, v, worked);
  await api.end(db, f.cg, v);
  return v;
};
const monthStart = () => `${today.slice(0, 7)}-01`;
const list = async (a: Actor, args = "null,null,null,null,null,null") => (await q(a, `select ogevia_api.list_action_issues($1,${args},200,0) as r`, [w.orgA]))[0].r;
const overLimit = (r: any, client?: string) => (r.issues as any[]).filter((i) => i.reason === "over_limit" && (!client || i.clientId === client));
const counts = async (a: Actor) => (await q(a, "select ogevia_api.get_attention_counts($1) as c", [w.orgA]))[0].c;
const summary = async (f: Fx) => (await q(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1, $2::date, $3)", [w.orgA, monthStart(), f.client]))[0];
const history = async (key: string) => (await q(w.managerA, "select ogevia_api.get_action_issue_history($1,$2) as h", [w.orgA, key]))[0].h;

describe("0084: an Over limit item in Action needed", () => {
  it("authorized 600 with 600 scheduled, a 45-minute visit ends: ONE Urgent item (visit_review / authorization) with the numbers, the action and the client/service; the figure equals the summary's Over limit", async () => {
    const f = await fx(600);
    await reservedShift(f, 600);
    await endedUnscheduled(f, 45);
    expect(await summary(f)).toMatchObject({ hours_over_limit_minutes: 45, hours_left_minutes: -45 });
    const items = overLimit(await list(w.managerA), f.client);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "authorization", reason: "over_limit", queue: "visit_review", category: "authorization", severity: "urgent", status: "open",
      clientId: f.client, serviceId: f.service, action: "review_authorization_limit", overLimitMinutes: 45, authorizedMinutes: 600, deadline: null,
    });
    expect(items[0].recommendedAction).toBe("0.75 h over the monthly authorization (10 h authorized). Over-limit time cannot be billed; worked time is kept.");
    expect(items[0].issueKey).toMatch(/^authorization:over_limit:[0-9a-f-]{36}$/);
    expect(items[0].severity).not.toBe("critical"); // red must not automatically mean Critical
  });

  it("boundary: exactly at the limit is NOT an item (555 scheduled + 45 worked = 600); one more minute is (1 min over, '0.02 h')", async () => {
    const f = await fx(600);
    await reservedShift(f, 555);
    await endedUnscheduled(f, 45);
    expect(await summary(f)).toMatchObject({ hours_left_minutes: 0, hours_over_limit_minutes: 0 });
    expect(overLimit(await list(w.managerA), f.client)).toHaveLength(0);
    await reservedShift(f, 1);
    const items = overLimit(await list(w.managerA), f.client);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ overLimitMinutes: 1 });
    expect(items[0].recommendedAction).toMatch(/^0\.02 h over the monthly authorization \(10 h authorized\)\./);
  });

  it("per authorization, never netted: an over-limit client is listed with its own figure while another client with hours to spare adds nothing", async () => {
    const over = await fx(600);
    const spare = await fx(6000);
    await reservedShift(over, 600);
    await endedUnscheduled(over, 45);
    await reservedShift(spare, 60);
    const r = await list(w.managerA);
    expect(overLimit(r, over.client)).toHaveLength(1);
    expect(overLimit(r, over.client)[0].overLimitMinutes).toBe(45);
    expect(overLimit(r, spare.client)).toHaveLength(0);
  });

  it("stable identity: the same key every time; it resolves on its own when Over limit returns to 0 (history: opened, resolved) and REAPPEARS as the same issue, reopened, if it recurs", async () => {
    const f = await fx(600);
    const shift = await reservedShift(f, 600);
    await endedUnscheduled(f, 45);
    const first = overLimit(await list(w.managerA), f.client)[0];
    const again = overLimit(await list(w.managerA), f.client)[0];
    expect(again.issueKey).toBe(first.issueKey);
    expect(again.firstSeenAt).toBe(first.firstSeenAt);
    await release(shift); // 45 committed of 600: Over limit is 0
    expect(await summary(f)).toMatchObject({ hours_over_limit_minutes: 0 });
    expect(overLimit(await list(w.managerA), f.client)).toHaveLength(0);
    expect((await history(first.issueKey)).state).toMatchObject({ status: "resolved" });
    await reservedShift(f, 600); // recurs
    const back = overLimit(await list(w.managerA), f.client)[0];
    expect(back.issueKey).toBe(first.issueKey);
    expect(back.reopenCount).toBe(1);
    expect((await history(first.issueKey)).events.map((e: any) => e.event)).toEqual(["opened", "resolved", "reopened"]);
  });

  it("counts equal the list: actionNeeded, byQueue.visit_review, get_attention_counts.needsAction (all +1 for the new item, none Critical), the category and queue filters, and NOT Needs attention / Scheduling / Approvals exceptions", async () => {
    const before = { l: await list(w.managerA), c: await counts(w.managerA) };
    const f = await fx(600);
    await reservedShift(f, 600);
    await endedUnscheduled(f, 45);
    const l = await list(w.managerA);
    const c = await counts(w.managerA);
    const added = overLimit(l).length - overLimit(before.l).length;
    expect(added).toBe(1);
    expect(l.counts.actionNeeded).toBe(before.l.counts.actionNeeded + 1);
    expect(l.counts.urgent).toBe(before.l.counts.urgent + 1);
    expect(l.counts.critical).toBe(before.l.counts.critical);
    expect(l.counts.byQueue.visit_review).toBe((before.l.counts.byQueue.visit_review ?? 0) + 2); // the Over limit item and the ended visit's own routine Pending Confirmation reminder
    expect(c.needsAction.count).toBe(l.counts.actionNeeded);
    expect(c.needsAction.critical).toBe(before.c.needsAction.critical);
    expect(c.needsAttention.count).toBe(before.c.needsAttention.count);
    expect(c.scheduling.count).toBe(before.c.scheduling.count);
    expect(c.approvals.exceptions.count).toBe(before.c.approvals.exceptions.count);
    expect(c.approvals.readyForApproval).toBe(before.c.approvals.readyForApproval);
    const byCategory = await list(w.managerA, "null,'authorization',null,null,null,null");
    expect(overLimit(byCategory, f.client)).toHaveLength(1);
    const byQueue = await list(w.managerA, "'visit_review',null,'urgent',null,null,null");
    expect(overLimit(byQueue, f.client)).toHaveLength(1);
    const byClient = await list(w.managerA, `null,null,null,'${f.client}',null,null`);
    expect(byClient.issues.filter((i: any) => i.reason === "over_limit")).toHaveLength(1);
    const wrongQueue = await list(w.managerA, "'documents_compliance',null,null,null,null,null");
    expect(overLimit(wrongQueue, f.client)).toHaveLength(0);
  });

  it("who sees it: the owner, the manager and the scheduler (visits.read) see the same item; a caregiver is refused; another agency never sees it; without visits.read nobody sees it, and the counts agree", async () => {
    const f = await fx(600);
    await reservedShift(f, 600);
    await endedUnscheduled(f, 45);
    for (const a of [w.ownerA, w.managerA, w.schedulerA]) {
      const r = await list(a);
      expect(overLimit(r, f.client)).toHaveLength(1);
      expect((await counts(a)).needsAction.count).toBe(r.counts.actionNeeded);
    }
    await expect(list(w.caregiverA1)).rejects.toThrow(/permission/i);
    await expect(q(w.managerB, "select ogevia_api.list_action_issues($1,null,null,null,null,null,null,50,0)", [w.orgA])).rejects.toThrow(/Organization not found/);
    expect(JSON.stringify(await list(w.managerB).catch(() => ({})))).not.toContain(f.client);
    // remove visits.read from the scheduler (global to this throwaway test database); it keeps readiness.read, so it may still open the list, but the item is gone
    const before = (await list(w.schedulerA)).counts.actionNeeded;
    await db.admin.query("delete from ogevia.role_permissions where role = 'scheduler' and permission_key = 'visits.read'");
    try {
      const r = await list(w.schedulerA);
      expect(overLimit(r, f.client)).toHaveLength(0);
      expect(r.counts.actionNeeded).toBeLessThan(before);
      expect((await counts(w.schedulerA)).needsAction.count).toBe(r.counts.actionNeeded);
    } finally {
      await db.admin.query("insert into ogevia.role_permissions (role, permission_key) values ('scheduler', 'visits.read') on conflict do nothing");
    }
  });

  it("in-app notifications: the existing rule covers it (Urgent notifies per the agency setting, default on), one per person and issue; it stops when the issue resolves", async () => {
    const f = await fx(600);
    const shift = await reservedShift(f, 600);
    await endedUnscheduled(f, 45);
    const mine = async (a: Actor) => (await q(a, "select ogevia_api.list_my_notifications($1,false,100) as n", [w.orgA]))[0].n;
    const n1 = await mine(w.ownerA);
    const own = (n1.items as any[]).filter((i) => i.reason === "over_limit" && i.clientCode);
    expect(own.length).toBeGreaterThanOrEqual(1);
    expect(own[0]).toMatchObject({ kind: "authorization", queue: "visit_review", severity: "urgent" });
    const key = (await list(w.managerA)).issues.find((i: any) => i.reason === "over_limit" && i.clientId === f.client).issueKey;
    expect((await mine(w.ownerA)).items.filter((i: any) => i.issueKey === key)).toHaveLength(1); // repeating the read adds nothing
    await release(shift);
    expect((await mine(w.ownerA)).items.filter((i: any) => i.issueKey === key)).toHaveLength(0); // resolved: stops counting
  });
});
