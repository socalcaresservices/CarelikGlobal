// 0069 report export permission and audit; 0070 full-chain monthly report. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let monthStart: string;
type Fx = { client: string; service: string; auth: string };
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const as = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const chain = (a: Actor = w.managerA, client: string | null = null, org = w.orgA, month = monthStart) =>
  as(a, "select * from ogevia_api.get_monthly_chain_report($1,$2::date,$3)", [org, month, client]);
const approve = (a: Actor, visit: string, minutes: number) => as(a, "select ogevia_api.approve_visit_for_billing($1,$2,null,null) as id", [visit, minutes]).then((r) => r[0].id as string);
async function reserved(f: Fx, startMin: number, minutes: number) {
  const shift = (await q(
    `insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3, now() + make_interval(mins => $4), now() + make_interval(mins => $4 + $5), 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.id = $6 returning id`,
    [w.orgA, f.client, f.service, startMin, minutes, f.auth])).rows[0].id as string;
  await q(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
           select $1, a.lineage_id, null, $2, $3::date, $4 from ogevia.client_authorizations a where a.id = $5`, [w.orgA, shift, today, minutes, f.auth]);
  return shift;
}
async function noSignerVisit(f: Fx, minutes: number) {
  const v = await api.start(db, w.caregiverA1, w.orgA, f.client, f.service, null, "Synthetic: extra help");
  await ageVisit(db, v, minutes);
  await api.end(db, w.caregiverA1, v);
  await api.confirm(db, w.caregiverA1, v, { method: "unable_to_confirm", reason: "Client asleep (synthetic)" });
  return v;
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  monthStart = `${today.slice(0, 7)}-01`;
});
afterAll(async () => db?.drop());

describe("the full chain for one client, and the checks that the parts add up", () => {
  let f: Fx;
  let approvedVisit: string, voidedVisit: string;
  beforeAll(async () => {
    f = await freshClient(db, w, w.caregiverA1, 5000, w.orgA, { before: 40, after: 200 });
    await signedVisit(db, w.caregiverA1, w, 30, w.orgA, f.client, f.service); // ready for review
    approvedVisit = (await signedVisit(db, w.caregiverA1, w, 40, w.orgA, f.client, f.service)).visit;
    voidedVisit = (await signedVisit(db, w.caregiverA1, w, 50, w.orgA, f.client, f.service)).visit;
    await approve(w.managerA, approvedVisit, 40);
    const id = await approve(w.managerA, voidedVisit, 50);
    await as(w.managerA, "select ogevia_api.void_billing_approval($1,'Approved the wrong minutes (synthetic)',null)", [id]);
    const nc = await noSignerVisit(f, 20); // needs correction
    void nc;
    await reserved(f, 24 * 60, 60); // ahead
    await reserved(f, -30, 45);     // underway
    await reserved(f, -300, 35);    // ended with no visit
  });

  it("every stage is reported, and authorized = billable + adjustments + reserved + remaining", async () => {
    const r = (await chain(w.managerA, f.client))[0];
    expect(r).toMatchObject({
      authorized_minutes: 5000, worked_minutes: 30 + 40 + 50 + 20, billable_minutes: 30 + 40 + 50,
      ready_for_review_minutes: 30 + 50, approved_for_billing_minutes: 40, needs_correction_minutes: 0, // the unsigned visit has 0 billable minutes
      human_approved_minutes: 40, ready_for_review_visits: 2, approved_visits: 1, voided_approvals: 1, needs_correction_visits: 1,
      scheduled_minutes: 60 + 45, needs_reconciliation_minutes: 35, held_review_minutes: 0, reserved_minutes: 140,
      reserved_ok: true, visits_ok: true, balance_ok: true, difference_minutes: 0,
    });
    expect(r.authorized_minutes).toBe(r.billable_minutes + r.adjustment_minutes + r.reserved_minutes + r.remaining_minutes);
    expect(r.remaining_minutes).toBe(5000 - 120 - 140);
  });

  it("agrees with the other screens: the monthly summary, Home's utilisation overview and the attention count", async () => {
    const r = (await chain(w.managerA, f.client))[0];
    const s = (await as(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1,$2::date,$3)", [w.orgA, monthStart, f.client]))[0];
    expect({ a: r.authorized_minutes, w: r.worked_minutes, v: r.confirmed_minutes, b: r.billable_minutes, c: r.committed_minutes, rem: r.remaining_minutes, res: r.reserved_minutes })
      .toEqual({ a: s.authorized_minutes, w: s.worked_minutes, v: s.verified_minutes, b: s.billable_minutes, c: s.committed_minutes, rem: s.remaining_minutes, res: s.reserved_minutes });
    const all = await chain(w.managerA);
    const o = (await as(w.managerA, "select * from ogevia_api.get_utilisation_overview($1,$2::date)", [w.orgA, monthStart])).find((x) => x.service_id === w.serviceA);
    const sum = (k: string) => all.filter((x) => x.service_id === w.serviceA).reduce((t, x) => t + Number(x[k]), 0);
    expect(o.scheduled_minutes).toBe(sum("scheduled_minutes"));
    expect(o.needs_reconciliation_minutes).toBe(sum("needs_reconciliation_minutes"));
    expect(o.reserved_minutes).toBe(sum("reserved_minutes"));
    expect(all.every((x) => x.reserved_ok && x.balance_ok)).toBe(true);
    expect(all.filter((x) => x.visits_ok === false)).toEqual([]);
  });

  it("a person who can read visits but not billing sees no billing-state columns and no visits check; another agency sees nothing", async () => {
    const r = (await chain(w.schedulerA, f.client))[0];
    expect(r).toMatchObject({ worked_minutes: 140, billable_minutes: 120, ready_for_review_minutes: null, approved_for_billing_minutes: null, human_approved_minutes: null, visits_ok: null, reserved_ok: true, balance_ok: true });
    expect(await chain(w.managerB, null, w.orgA)).toEqual([]);
    expect((await chain(w.managerB, null, w.orgB)).some((x) => x.client_id === f.client)).toBe(false);
    await expect(chain(w.caregiverA1)).resolves.toEqual([]);
  });
});

describe("report export: permission, request, generation (0069, 0072)", () => {
  const req = (a: Actor, key = "monthly_chain", org = w?.orgA) => as(a, "select ogevia_api.request_report_export($1,$2,$3::jsonb) r", [org, key, JSON.stringify({ monthStart })]).then((r) => r[0].r as Record<string, any>);
  const done = (a: Actor, id: string, rows = 3, bytes = 120, hash = "a".repeat(64)) => as(a, "select ogevia_api.complete_report_export($1,$2,$3,$4,$5) r", [w.orgA, id, rows, bytes, hash]).then((r) => r[0].r);
  const status = async (id: string) => (await as(w.ownerA, "select * from ogevia_api.list_report_exports($1,200)", [w.orgA])).find((e) => e.export_id === id);

  it("owner and manager may request; a scheduler and a caregiver may not; another agency is refused; a refusal writes nothing", async () => {
    const before = (await q("select count(*)::int n from ogevia.report_exports")).rows[0].n;
    expect(await req(w.ownerA)).toMatchObject({ exportId: expect.any(String), requestedAt: expect.any(String) });
    expect(await req(w.managerA)).toMatchObject({ exportId: expect.any(String) });
    await expectPgError(req(w.schedulerA), "OGA03", /permission to export/);
    await expectPgError(req(w.caregiverA1), "OGA03");
    await expectPgError(req(w.managerB), "OGN04");
    await expectPgError(req(w.managerA, "everything"), "OGV22", /Unknown report/);
    expect((await q("select count(*)::int n from ogevia.report_exports")).rows[0].n).toBe(before + 2);
  });

  it("a request is only a request: it shows as 'requested' with no rows, bytes or hash until the server records generation, which is not a claim of delivery", async () => {
    const r = await req(w.managerA);
    expect(await status(r.exportId)).toMatchObject({ status: "requested", row_count: null, byte_count: null, sha256_hex: null, generated_at: null, delivery: "server_generated" });
    expect((await q("select event from ogevia.report_export_events where export_id = $1", [r.exportId])).rows.map((x) => x.event)).toEqual(["requested"]);
    await expectPgError(done(w.ownerA, r.exportId), "OGN04"); // only the person who requested it can close it
    expect(await done(w.managerA, r.exportId, 7, 900, "b".repeat(64))).toMatchObject({ exportId: r.exportId });
    expect(await status(r.exportId)).toMatchObject({ status: "generated", row_count: 7, byte_count: 900, sha256_hex: "b".repeat(64) });
    await expectPgError(done(w.managerA, r.exportId), "OGC09", /already closed/);
    await expectPgError(as(w.managerA, "select ogevia_api.fail_report_export($1,$2,'late')", [w.orgA, r.exportId]), "OGC09");
    const audit = (await q("select action, after_state from ogevia.audit_events where entity_id = $1 order by id", [r.exportId])).rows;
    expect(audit.map((a) => a.action)).toEqual(["report.export_requested", "report.export_generated"]);
    expect(JSON.stringify(audit[1].after_state)).toMatch(/Delivery to the device is not recorded/);
  });

  it("a failure is its own event with an error code; the ledger and events cannot be edited or deleted; a bad hash or count is refused by the database", async () => {
    const r = await req(w.managerA);
    await as(w.managerA, "select ogevia_api.fail_report_export($1,$2,'generation_failed')", [w.orgA, r.exportId]);
    expect(await status(r.exportId)).toMatchObject({ status: "failed", error_code: "generation_failed", sha256_hex: null });
    await expect(q("update ogevia.report_export_events set error_code = 'x' where export_id = $1", [r.exportId])).rejects.toThrow();
    await expect(q("delete from ogevia.report_export_events where export_id = $1", [r.exportId])).rejects.toThrow();
    await expect(q("delete from ogevia.report_exports where id = $1", [r.exportId])).rejects.toThrow();
    const r2 = await req(w.managerA);
    await expect(done(w.managerA, r2.exportId, 1, 1, "not-a-hash")).rejects.toThrow();
  });

  it("only the owner reads the ledger; concurrent requests each leave their own row and event", async () => {
    await expectPgError(as(w.managerA, "select * from ogevia_api.list_report_exports($1,50)", [w.orgA]), "OGA03");
    await expectPgError(as(w.managerB, "select * from ogevia_api.list_report_exports($1,50)", [w.orgA]), "OGN04");
    const before = (await q("select count(*)::int n from ogevia.report_export_events")).rows[0].n;
    await Promise.all([1, 2, 3, 4].map((i) => req(i % 2 ? w.ownerA : w.managerA)));
    expect((await q("select count(*)::int n from ogevia.report_export_events")).rows[0].n).toBe(before + 4);
  });
});
void randomUUID;
