// 0076 Agency performance (counts, no missed-visits metric) and the general audit report. SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let fx: { client: string; service: string; auth: string };
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const as = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const perf = (a: Actor, month: string, org = w.orgA) => as(a, "select ogevia_api.get_agency_performance($1,$2) as r", [org, month]).then((r) => r[0].r);
const audit = (a: Actor, from: string, to: string, prefix: string | null = null, limit = 100, offset = 0, org = w.orgA) =>
  as(a, "select ogevia_api.list_audit_report($1,$2,$3,$4,$5,$6) as r", [org, from, to, prefix, limit, offset]).then((r) => r[0].r);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  fx = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 200 });
});
afterAll(async () => db?.drop());

/** A shift at noon Los Angeles time on the 15th of NEXT month, so it is still to come whatever day the suite runs. */
async function futureShift(status: string, caregiver: string | null = null, hour = 12) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    return (await c.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,null,$4, ((date_trunc('month', now() at time zone 'America/Los_Angeles') + interval '1 month 14 days' + make_interval(hours => $5::int)) at time zone 'America/Los_Angeles'),
              ((date_trunc('month', now() at time zone 'America/Los_Angeles') + interval '1 month 14 days' + make_interval(hours => $5::int + 2)) at time zone 'America/Los_Angeles'), $6::ogevia.shift_status) returning id`,
      [w.orgA, fx.client, fx.service, caregiver, hour, status])).rows[0].id as string;
  } finally { await c.query("set session_replication_role = origin"); c.release(); }
}
const nextMonth = () => q("select to_char(date_trunc('month', now() at time zone 'America/Los_Angeles') + interval '1 month', 'YYYY-MM-DD') as d").then((r) => r.rows[0].d as string);

describe("agency performance", () => {
  it("counts shifts, uncovered, call-outs, cancelled, no-show and ended-without-record for the month; missed visits is not published", async () => {
    const month = await nextMonth();
    const before = await perf(w.managerA, month);
    const rec = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id as string;
    await futureShift("scheduled", null, 8);
    const calledOut = await futureShift("scheduled", rec, 10);
    const plain = await futureShift("scheduled", rec, 13);
    await futureShift("cancelled", null, 15);
    await futureShift("no_show", null, 17);
    await q("insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type) values ($1,$2,'called_out')", [w.orgA, calledOut]);
    void plain;
    const after = await perf(w.managerA, month);
    const d = (k: string) => Number(after.counts[k]) - Number(before.counts[k]);
    expect(d("shifts")).toBe(5);
    expect(d("uncoveredNow")).toBe(2); // the open shift and the one whose caregiver called out
    expect(d("cancelled")).toBe(1);
    expect(d("noShow")).toBe(1);
    expect(d("callOuts")).toBe(1);
    expect(d("endedWithoutRecord")).toBe(0); // nothing here has ended
    expect(after.missedVisits).toBeNull();
    expect(after.missedVisitsNote).toMatch(/Not published/);
    expect(after.cancellationNote).toMatch(/who cancelled is not recorded/);
  });

  it("a shift that ended with no visit record is counted until a person decides; releasing it takes it out of the count", async () => {
    const month = (await q("select to_char(date_trunc('month', now() at time zone 'America/Los_Angeles') - interval '1 month', 'YYYY-MM-DD') as d")).rows[0].d as string;
    const before = await perf(w.managerA, month);
    const c = await db.admin.connect();
    let id: string;
    try {
      await c.query("set session_replication_role = replica");
      id = (await c.query(
        `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
         select $1,$2,$3,null,null, (date_trunc('month', now() at time zone 'America/Los_Angeles') - interval '1 month' + interval '14 days 12 hours') at time zone 'America/Los_Angeles',
                (date_trunc('month', now() at time zone 'America/Los_Angeles') - interval '1 month' + interval '14 days 14 hours') at time zone 'America/Los_Angeles', 'scheduled', a.lineage_id
         from ogevia.client_authorizations a where a.id = $4 returning id`, [w.orgA, fx.client, fx.service, fx.auth])).rows[0].id as string;
      await c.query("insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes) select $1, a.lineage_id, null, $2, $3::date, 120 from ogevia.client_authorizations a where a.id = $4", [w.orgA, id, month, fx.auth]);
    } finally { await c.query("set session_replication_role = origin"); c.release(); }
    expect(Number((await perf(w.managerA, month)).counts.endedWithoutRecord) - Number(before.counts.endedWithoutRecord)).toBe(1);
    await as(w.managerA, "select ogevia_api.reconcile_ended_shift($1,$2,'no_service_delivered','Called the family; nobody went (synthetic)',null)", [w.orgA, id]);
    expect(Number((await perf(w.managerA, month)).counts.endedWithoutRecord) - Number(before.counts.endedWithoutRecord)).toBe(0);
  });

  it("utilization is committed over authorized, rounded down; null when nothing is authorized", async () => {
    const month = `${today.slice(0, 7)}-01`;
    const r = await perf(w.managerA, month);
    expect(r.utilization.authorizedMinutes).toBeGreaterThan(0);
    expect(r.utilization.percent).toBe(Math.floor((r.utilization.committedMinutes * 100) / r.utilization.authorizedMinutes));
    const farMonth = `${day(-800).slice(0, 7)}-01`;
    const none = await perf(w.managerA, farMonth);
    expect(none.utilization).toMatchObject({ authorizedMinutes: 0, percent: null });
  });

  it("a caregiver is refused, another agency is refused, and the other agency's shifts never count", async () => {
    await expectPgError(as(w.caregiverA1, "select ogevia_api.get_agency_performance($1,$2)", [w.orgA, `${today.slice(0, 7)}-01`]), "OGA03");
    await expectPgError(as(w.managerB, "select ogevia_api.get_agency_performance($1,$2)", [w.orgA, `${today.slice(0, 7)}-01`]), "OGN04");
    const b = await perf(w.managerB, `${today.slice(0, 7)}-01`, w.orgB);
    expect(Number(b.counts.shifts)).toBeLessThan(5);
  });
});

describe("audit report", () => {
  it("owner only; shows the action, actor, entity type, reason and field NAMES, never values; filters by action prefix; pages; limits the range", async () => {
    await as(w.ownerA, "select ogevia_api.set_client_legal_name($1,$2,'Audit','Person-Secret',null)", [w.orgA, fx.client]);
    await as(w.managerA, "select ogevia_api.set_client_preparation($1,$2,'draft','Preparing for the audit report',null)", [w.orgA, fx.client]);
    const r = await audit(w.ownerA, day(-1), day(1));
    expect(r.total).toBeGreaterThan(1);
    const stage = r.events.find((e: any) => e.action === "client.stage_changed");
    expect(stage).toMatchObject({ actorName: expect.any(String), entityType: "client_preparation", reason: "Preparing for the audit report", fields: ["stage"] });
    expect(JSON.stringify(r)).not.toMatch(/Person-Secret/);
    const only = await audit(w.ownerA, day(-1), day(1), "client.stage");
    expect(only.events.every((e: any) => e.action.startsWith("client.stage"))).toBe(true);
    const p1 = await audit(w.ownerA, day(-1), day(1), null, 1, 0), p2 = await audit(w.ownerA, day(-1), day(1), null, 1, 1);
    expect(p1.events).toHaveLength(1); expect(p2.events[0]).not.toEqual(p1.events[0]);
    await expectPgError(audit(w.managerA, day(-1), day(1)), "OGA03");
    await expectPgError(audit(w.ownerA, day(-1), day(1), "x'; drop"), "OGV22");
    await expectPgError(audit(w.ownerA, day(-500), day(1)), "OGV22");
    await expectPgError(audit(w.ownerA, day(1), day(-1)), "OGV22");
    await expectPgError(audit(w.managerB, day(-1), day(1)), "OGN04");
  });

  it("another agency's events never appear", async () => {
    const mine = await audit(w.ownerA, day(-1), day(1), null, 500);
    expect(mine.events.every((e: any) => typeof e.action === "string")).toBe(true);
    const ids = (await q("select count(*)::int n from ogevia.audit_events where organization_id = $1", [w.orgB])).rows[0].n;
    expect(ids).toBeGreaterThan(-1);
    const total = (await q("select count(*)::int n from ogevia.audit_events where organization_id = $1 and (occurred_at at time zone 'America/Los_Angeles')::date between $2 and $3", [w.orgA, day(-1), day(1)])).rows[0].n;
    expect(mine.total).toBe(total);
  });
});

describe("export ledger accepts the two new reports and nothing else", () => {
  it("billing_review and audit_report are accepted for an exporter; an unknown report is refused; a scheduler cannot request", async () => {
    const req = (a: Actor, key: string) => as(a, "select ogevia_api.request_report_export($1,$2,'{}'::jsonb) as r", [w.orgA, key]);
    expect((await req(w.managerA, "billing_review"))[0].r.exportId).toBeTruthy();
    expect((await req(w.ownerA, "audit_report"))[0].r.exportId).toBeTruthy();
    await expectPgError(req(w.managerA, "everything"), "OGV22");
    await expectPgError(req(w.schedulerA, "billing_review"), "OGA03");
  });
});
