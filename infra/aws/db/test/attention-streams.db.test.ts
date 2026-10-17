// 0056 Attention streams, appearance preferences and the authorizations-missing-a-rate list. SYNTHETIC data only.
// The urgent window is 48 hours (owner decision D10; get_attention_overview, p_urgent_hours).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let fx: { client: string; service: string; auth: string };
let recA1: string;
let recA2: string;

const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const overview = (a: Actor = w.managerA, hours = 48, org = w.orgA) => call(a, "select ogevia_api.get_attention_overview($1,$2) as o", [org, hours]).then((r) => r[0].o);
const recOf = async (a: Actor) => (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id as string;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  recA1 = await recOf(w.caregiverA1);
  recA2 = await recOf(w.caregiverA2);
});
afterAll(async () => db?.drop());

/** A shift at an exact instant (fixture: triggers off, no reservation needed for classification). */
async function shiftAt(hoursFromNow: number, hours: number, caregiver: string | null, opts: { calledOut?: boolean; status?: string } = {}) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    const id = (await c.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,null,$4, now() + make_interval(secs => $5::numeric * 3600), now() + make_interval(secs => ($5::numeric + $6::numeric) * 3600), $7) returning id`,
      [w.orgA, fx.client, fx.service, caregiver, hoursFromNow, hours, opts.status ?? "scheduled"])).rows[0].id as string;
    if (opts.calledOut) {
      await c.query("insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type) values ($1,$2,'called_out')", [w.orgA, id]);
    }
    return id;
  } finally {
    await c.query("set session_replication_role = origin");
    c.release();
  }
}
const wipeShifts = async () => {
  await q("delete from ogevia.assignment_readiness_flags");
  await q("delete from ogevia.shift_readiness_flags");
  await q("delete from ogevia.authorization_reservations where shift_id is not null");
  await q("delete from ogevia.shift_coverage_events");
  await q("delete from ogevia.shifts where not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = shifts.id)");
};

describe("uncovered shifts: urgent inside the window, upcoming after it, ordered by date", () => {
  it("classifies by the 48-hour window and orders the upcoming list soonest first", async () => {
    await wipeShifts();
    const inside = await shiftAt(5, 3, null);
    const edgeIn = await shiftAt(47.5, 2, null);
    const edgeOut = await shiftAt(48.5, 2, null);
    const later = await shiftAt(200, 3, null);
    const soon = await shiftAt(60, 3, null);
    const covered = await shiftAt(6, 2, recA1); // covered: in neither stream
    const o = await overview();
    const urgentIds = o.urgent.items.filter((i: any) => i.kind === "shift").map((i: any) => i.id);
    expect(urgentIds.sort()).toEqual([inside, edgeIn].sort());
    expect(urgentIds).not.toContain(covered);
    expect(o.urgent.items.every((i: any) => i.severity === "red" && i.reasons.includes("uncovered_open"))).toBe(true);
    expect(o.upcoming.count).toBe(3);
    expect(o.upcoming.shifts.map((s: any) => s.shiftId)).toEqual([edgeOut, soon, later]); // soonest first
    expect(o.upcoming.nextStartsAt).toBe(o.upcoming.shifts[0].startsAt);
    // the window is a parameter, not a constant: 72 hours moves the 48.5 and 60-hour shifts into urgent
    const wide = await overview(w.managerA, 72);
    expect(wide.urgent.items.filter((i: any) => i.kind === "shift")).toHaveLength(4);
    expect(wide.upcoming.count).toBe(1);
    expect(o.urgentWindowHours).toBe(48);
  });

  it("a called-out shift with no replacement is uncovered; a shift already running and uncovered is urgent and marked in progress", async () => {
    await wipeShifts();
    const called = await shiftAt(60, 3, recA2, { calledOut: true });
    const running = await shiftAt(-1, 3, null);
    const o = await overview();
    const runningItem = o.urgent.items.find((i: any) => i.id === running);
    expect(runningItem).toMatchObject({ kind: "shift", inProgress: true, severity: "red" });
    expect(o.upcoming.shifts.find((s: any) => s.shiftId === called)).toMatchObject({ reason: "called_out" });
    expect(o.urgent.items.find((i: any) => i.id === called)).toBeUndefined();
  });

  it("past, cancelled and completed shifts are never uncovered", async () => {
    await wipeShifts();
    await shiftAt(-10, 2, null); // ended
    await shiftAt(5, 2, null, { status: "cancelled" });
    await shiftAt(5, 2, null, { status: "completed" });
    const o = await overview();
    expect(o.urgent.itemCount).toBe(0);
    expect(o.upcoming.count).toBe(0);
  });
});

describe("unscheduled visits are visits to review, never uncovered shifts", () => {
  it("an unscheduled visit counts only in Visit review; a visit past its shift end is urgent (amber) with its reason", async () => {
    await wipeShifts();
    const unscheduled = await api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service, null, "Synthetic: client asked for extra help");
    await ageVisit(db, unscheduled, 30);
    await api.end(db, w.caregiverA1, unscheduled);
    await api.confirm(db, w.caregiverA1, unscheduled, { method: "unable_to_confirm", reason: "Synthetic: client asleep" });
    const o = await overview();
    expect(o.upcoming.count).toBe(0); // not a staffing gap
    expect(o.urgent.items.find((i: any) => i.id === unscheduled)).toBeUndefined();
    expect(o.visitReview).toMatchObject({ visitsNeedingAttention: 1, needsReview: 1 });
    expect(o.visitReview.reviewIssues).toBeGreaterThanOrEqual(1);

    // an open visit whose shift ended
    const open = await api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service, null, undefined);
    await q("set session_replication_role = replica");
    await q("update ogevia.shifts sh set starts_at = now() - interval '5 hours', ends_at = now() - interval '2 hours' from ogevia.service_visits v where v.id = $1 and sh.id = v.scheduled_shift_id", [open]);
    await q("update ogevia.service_visits set time_in = now() - interval '5 hours' where id = $1", [open]);
    await q("set session_replication_role = origin");
    const o2 = await overview();
    expect(o2.urgent.items.find((i: any) => i.id === open)).toMatchObject({ kind: "visit", severity: "amber", reasons: ["missing_clock_out"] });
    expect(o2.visitReview.visitsNeedingAttention).toBe(1); // the open visit is not "awaiting review"
  });

  it("visit counts are UNIQUE visits: each visit is in exactly one category and the total equals the distinct ids", async () => {
    const o = await overview();
    const v = o.visitReview;
    expect(v.visitsNeedingAttention).toBe(v.awaitingConfirmation + v.needsReview + v.lateResponses + (v.readyForApproval ?? 0));
    const distinct = (await q(`select count(distinct id)::int n from (
        select id from ogevia.service_visits where status = 'administrator_review' and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = service_visits.id and d.revoked_at is null) and ogevia.visit_recovery_state(id) is null
        union all select id from ogevia.service_visits where status = 'signed' and not exists (select 1 from ogevia.billing_approvals b where b.visit_id = service_visits.id and b.voided_at is null)
        union all select id from ogevia.service_visits where status = 'awaiting_signature' and time_out <= now() - interval '60 minutes') u`)).rows[0].n;
    expect(v.visitsNeedingAttention).toBe(distinct);
  });
});

describe("a blocked caregiver's imminent shift is urgent and linked to the compliance record", () => {
  beforeAll(async () => {
    // earlier tests left visits behind: park them so these cases see only their own records (fixture; triggers off)
    await q("set session_replication_role = replica");
    await q("delete from ogevia.service_visits where status in ('draft', 'awaiting_signature', 'administrator_review')");
    await q("set session_replication_role = origin");
  });
  it("one item per shift with every reason; issues add up the reasons; a shift beyond the window is not urgent", async () => {
    await wipeShifts();
    const near = await shiftAt(10, 3, recA2);
    const far = await shiftAt(80, 3, recA2);
    for (const [shift, kind] of [[near, "compliance"], [near, "document"], [far, "compliance"]] as const) {
      await q("insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail) values ($1,$2,$3,$4,$5,'{}'::jsonb)",
        [w.orgA, shift, recA2, kind, kind === "compliance" ? "compliance_hold" : "documents_missing"]);
    }
    const o = await overview();
    const item = o.urgent.items.find((i: any) => i.id === near);
    expect(item).toMatchObject({ kind: "shift", severity: "red", caregiverRecordId: recA2 });
    expect(item.reasons.sort()).toEqual(["compliance_hold", "documents_not_current"]);
    expect(o.urgent.items.find((i: any) => i.id === far)).toBeUndefined();
    expect(o.urgent.itemCount).toBe(1);
    expect(o.urgent.issueCount).toBe(2); // one shift, two issues: the count says so
  });

  it("a visit in progress for a caregiver on hold is urgent, and a resolved flag no longer shows", async () => {
    await wipeShifts();
    await q("update ogevia.shift_readiness_flags set resolved_at = now()");
    const open = await api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service, null, "Synthetic: unscheduled start");
    await q("insert into ogevia.caregiver_compliance_holds (organization_id, caregiver_record_id, reasons, grace_closed) values ($1,$2,'[{\"requirement\":\"cpr\",\"code\":\"missing_after_deadline\",\"message\":\"CPR missing.\",\"dueDate\":null}]'::jsonb, true)", [w.orgA, recA1]);
    const o = await overview();
    expect(o.urgent.items.find((i: any) => i.id === open)).toMatchObject({ kind: "visit", severity: "red", reasons: ["in_progress_on_hold"] });
    expect(o.documents).toMatchObject({ caregiversOnHold: 1 });
    await q("delete from ogevia.caregiver_compliance_holds");
  });
});

describe("permissions: a section is null, never zero, when the viewer may not see it", () => {
  it("caregiver refused; other agency 404; the window is validated; scheduler and manager see what their role allows", async () => {
    await expectPgError(call(w.caregiverA1, "select ogevia_api.get_attention_overview($1,24)", [w.orgA]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.get_attention_overview($1,24)", [w.orgA]), "OGN04");
    await expectPgError(call(w.managerA, "select ogevia_api.get_attention_overview($1,0)", [w.orgA]), "OGV22");
    await expectPgError(call(w.managerA, "select ogevia_api.get_attention_overview($1,500)", [w.orgA]), "OGV22");
    const s = await overview(w.schedulerA); // visits.read, shifts.manage, readiness.read; no documents.read, no billing
    expect(s.urgent).not.toBeNull();
    expect(s.upcoming).not.toBeNull();
    expect(s.visitReview.readyForApproval).toBeNull();
    expect(s.documents).not.toHaveProperty("overdue"); // no documents.read: only the compliance counts
    const m = await overview(w.managerA);
    expect(m.documents).toHaveProperty("overdue");
    expect(m.visitReview.readyForApproval).not.toBeNull();
    const none = await overview(w.managerB, 24, w.orgB);
    expect(none.urgent.itemCount).toBe(0); // another agency's data is never mixed in
  });
});

describe("appearance: agency defaults, personal overrides, isolation", () => {
  it("built-in defaults apply until something is set; any member reads, only an administrator sets the agency default", async () => {
    const a = (await call(w.caregiverA1, "select ogevia_api.get_appearance($1) as a", [w.orgA]))[0].a;
    expect(a.effective).toEqual({ background: "light", accent: "teal", density: "comfortable", textSize: "standard", chartType: "bar", layout: "standard" });
    expect(a.canSetOrganizationDefaults).toBe(false);
    await expectPgError(call(w.managerA, "select ogevia_api.set_organization_appearance($1,'white','blue','compact','large','donut',null)", [w.orgA]), "OGA03");
    const set = (await call(w.ownerA, "select ogevia_api.set_organization_appearance($1,'white','blue','compact','standard','donut','minimal') as a", [w.orgA]))[0].a;
    expect(set.organization).toEqual({ background: "white", accent: "blue", density: "compact", textSize: "standard", chartType: "donut", layout: "minimal" });
    expect(set.canSetOrganizationDefaults).toBe(true);
    const other = (await call(w.caregiverA2, "select ogevia_api.get_appearance($1) as a", [w.orgA]))[0].a;
    expect(other.effective).toEqual({ background: "white", accent: "blue", density: "compact", textSize: "standard", chartType: "donut", layout: "minimal" });
    expect((await q("select count(*)::int n from ogevia.audit_events where action = 'organization.appearance_set' and actor_user_id = $1", [w.ownerA.userId])).rows[0].n).toBe(1);
  });

  it("a personal choice overrides only that person; clearing it follows the agency default again", async () => {
    const mine = (await call(w.caregiverA1, "select ogevia_api.set_my_appearance($1,'dark',null,'comfortable','large','bar','standard') as a", [w.orgA]))[0].a;
    expect(mine.effective).toEqual({ background: "dark", accent: "blue", density: "comfortable", textSize: "large", chartType: "bar", layout: "standard" });
    expect(mine.mine).toEqual({ background: "dark", accent: null, density: "comfortable", textSize: "large", chartType: "bar", layout: "standard" });
    const neighbour = (await call(w.caregiverA2, "select ogevia_api.get_appearance($1) as a", [w.orgA]))[0].a;
    expect(neighbour.effective.background).toBe("white"); // unaffected
    expect(neighbour.effective.layout).toBe("minimal"); // the agency's layout, not the neighbour's own
    const manager = (await call(w.managerA, "select ogevia_api.get_appearance($1) as a", [w.orgA]))[0].a;
    expect(manager.mine).toEqual({ background: null, accent: null, density: null, textSize: null, chartType: null, layout: null });
    const cleared = (await call(w.caregiverA1, "select ogevia_api.set_my_appearance($1,null,null,null,null,null,null) as a", [w.orgA]))[0].a;
    expect(cleared.effective.background).toBe("white");
    expect((await q("select count(*)::int n from ogevia.user_appearance where organization_id = $1", [w.orgA])).rows[0].n).toBe(1); // one row, cleared
  });

  it("the agency default of one agency never leaks into another; invalid choices and non-members are refused", async () => {
    const b = (await call(w.managerB, "select ogevia_api.get_appearance($1) as a", [w.orgB]))[0].a;
    expect(b.organization).toEqual({ background: null, accent: null, density: null, textSize: null, chartType: null, layout: null });
    expect(b.effective.background).toBe("light");
    await expectPgError(call(w.managerB, "select ogevia_api.get_appearance($1)", [w.orgA]), "OGN04");
    await expectPgError(call(w.managerB, "select ogevia_api.set_my_appearance($1,'dark',null,null,null,null,null)", [w.orgA]), "OGN04");
    await expectPgError(call(w.ownerA, "select ogevia_api.set_organization_appearance($1,'neon',null,null,null,null,null)", [w.orgA]), "OGV22");
    await expectPgError(call(w.caregiverA1, "select ogevia_api.set_my_appearance($1,null,'#ff0000',null,null,null,null)", [w.orgA]), "OGV22");
    await expectPgError(call(w.caregiverA1, "select ogevia_api.set_my_appearance($1,null,null,null,null,'pie',null)", [w.orgA]), "OGV22");
    await expectPgError(call(w.caregiverA1, "select ogevia_api.set_my_appearance($1,null,null,null,null,null,'compact')", [w.orgA]), "OGV22");
    // Cream was replaced by White before release: the old value is refused, and Light and White are two different choices
    await expectPgError(call(w.caregiverA1, "select ogevia_api.set_my_appearance($1,'cream',null,null,null,null,null)", [w.orgA]), "OGV22");
    for (const bg of ["light", "white", "gray", "dark"]) await call(w.caregiverA1, "select ogevia_api.set_my_appearance($1,$2,null,null,null,null,null)", [w.orgA, bg]);
    await call(w.caregiverA1, "select ogevia_api.set_my_appearance($1,null,null,null,null,null,null)", [w.orgA]); // back to following the agency
  });
});

describe("appearance storage: one row per person per agency, nothing shared", () => {
  it("a personal choice is stored under (agency, that person) only; it cannot name another user, and direct table access is denied to the app role", async () => {
    await call(w.managerA, "select ogevia_api.set_my_appearance($1,'gray','plum','compact','large','line',null)", [w.orgA]);
    const rows = (await q("select user_id, organization_id, background from ogevia.user_appearance where organization_id = $1 and background is not null", [w.orgA])).rows;
    expect(rows).toEqual([{ user_id: w.managerA.userId, organization_id: w.orgA, background: "gray" }]);
    // the setter takes no user argument: the person is the signed-in actor
    const args = (await q("select pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname = 'set_my_appearance'")).rows[0].a as string;
    expect(args).not.toMatch(/user/);
    // the application role has no direct access to either table (functions only)
    await expectPgError(call(w.caregiverA1, "select * from ogevia.user_appearance"), "42501");
    await expectPgError(call(w.caregiverA1, "update ogevia.user_appearance set background = 'dark'"), "42501");
  });

  it("changing one person or the agency default never rewrites another person's saved choice; the other agency is untouched", async () => {
    const before = (await q("select user_id, background, accent from ogevia.user_appearance where organization_id = $1 order by user_id", [w.orgA])).rows;
    await call(w.ownerA, "select ogevia_api.set_organization_appearance($1,'light','rust',null,null,null,null)", [w.orgA]);
    await call(w.caregiverA2, "select ogevia_api.set_my_appearance($1,'dark',null,null,null,null,null)", [w.orgA]);
    const after = (await q("select user_id, background, accent from ogevia.user_appearance where organization_id = $1 order by user_id", [w.orgA])).rows;
    // the manager's row is unchanged by the agency default and by the caregiver's change
    expect(after.find((r) => r.user_id === w.managerA.userId)).toEqual(before.find((r) => r.user_id === w.managerA.userId));
    expect((await call(w.managerA, "select ogevia_api.get_appearance($1) as a", [w.orgA]))[0].a.effective).toMatchObject({ background: "gray", accent: "plum" });
    expect((await call(w.caregiverA1, "select ogevia_api.get_appearance($1) as a", [w.orgA]))[0].a.effective).toMatchObject({ background: "light", accent: "rust" });
    // agency B has no rows and no default, and agency A's administrator cannot write there
    expect((await q("select count(*)::int n from ogevia.user_appearance where organization_id = $1", [w.orgB])).rows[0].n).toBe(0);
    expect((await q("select count(*)::int n from ogevia.organization_appearance where organization_id = $1", [w.orgB])).rows[0].n).toBe(0);
    await expectPgError(call(w.ownerA, "select ogevia_api.set_organization_appearance($1,'dark',null,null,null,null,null)", [w.orgB]), "OGN04");
    await expectPgError(call(w.managerB, "select ogevia_api.set_organization_appearance($1,'dark',null,null,null,null,null)", [w.orgA]), "OGN04");
  });
});

describe("authorizations a month's money cannot use", () => {
  it("lists exactly the lineages the Home totals leave out; administrator only; the count follows current data", async () => {
    const day = await orgToday(db);
    const month = `${day.slice(0, 7)}-01`;
    const util = await call(w.ownerA, "select * from ogevia_api.get_utilisation_overview($1,$2::date)", [w.orgA, month]);
    const missingInTotals = util.reduce((t, r) => t + Number(r.lineages_without_rate), 0);
    const list = await call(w.ownerA, "select * from ogevia_api.list_authorizations_missing_rate($1,$2::date)", [w.orgA, month]);
    expect(missingInTotals).toBeGreaterThan(0);
    expect(list).toHaveLength(missingInTotals);
    expect(list[0]).toMatchObject({ client_id: fx.client === list[0].client_id ? fx.client : list[0].client_id, service_code: "RSP" });
    expect(Object.keys(list[0])).not.toContain("hourly_rate_cents");
    expect(await call(w.managerA, "select * from ogevia_api.list_authorizations_missing_rate($1,$2::date)", [w.orgA, month])).toEqual([]);
    expect(await call(w.managerB, "select * from ogevia_api.list_authorizations_missing_rate($1,$2::date)", [w.orgA, month])).toEqual([]);
    await q("set session_replication_role = replica"); // fixture: authorization versions are immutable through the product
    await q("update ogevia.client_authorizations set hourly_rate_cents = 3200 where id = $1", [list[0].authorization_id]);
    await q("set session_replication_role = origin");
    const after = await call(w.ownerA, "select * from ogevia_api.list_authorizations_missing_rate($1,$2::date)", [w.orgA, month]);
    expect(after).toHaveLength(missingInTotals - 1);
    const util2 = await call(w.ownerA, "select * from ogevia_api.get_utilisation_overview($1,$2::date)", [w.orgA, month]);
    expect(util2.reduce((t, r) => t + Number(r.lineages_without_rate), 0)).toBe(after.length);
  });
});
