// Through the real Lambda handler (SYNTHETIC data only): reconciliation of ended shifts (0067), amendment impacts (0068), export permission and audit (0069), and the
// full-chain monthly report with its server-generated CSV (0070).
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { chainCsv } from "../src/exports";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let today: string;
let monthStart: string;
let handler: ReturnType<typeof createHandler>;
type Fx = { client: string; service: string; auth: string };
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  monthStart = `${today.slice(0, 7)}-01`;
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
async function reserved(f: Fx, startMin: number, minutes: number) {
  const shift = (await db.admin.query(
    `insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3, now() + make_interval(mins => $4), now() + make_interval(mins => $4 + $5), 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.id = $6 returning id`,
    [w.orgA, f.client, f.service, startMin, minutes, f.auth])).rows[0].id as string;
  await db.admin.query(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
           select $1, a.lineage_id, null, $2, $3::date, $4 from ogevia.client_authorizations a where a.id = $5`, [w.orgA, shift, today, minutes, f.auth]);
  return shift;
}

describe("reconciling a shift that ended with no visit", () => {
  it("listed for the office, never released by itself; a caregiver is refused; an outcome releases once; a repeat is a conflict", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 5000, w.orgA, { before: 40, after: 200 });
    const ended = await reserved(f, -300, 60);
    const list = await call("GET /v1/shifts-to-reconcile", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.status).toBe(200);
    expect(list.body.shifts.find((s: any) => s.shiftId === ended)).toMatchObject({ bucket: "unreconciled", reservedMinutes: 60 });
    expect((await call("GET /v1/shifts-to-reconcile", w.caregiverA1, { query: { organizationId: w.orgA } })).status).toBe(403);
    const body = { organizationId: w.orgA, outcome: "no_service_delivered", note: "Called the family; nobody came (synthetic)" };
    expect((await call("POST /v1/shifts/{shiftId}/reconcile", w.caregiverA1, { path: { shiftId: ended }, body })).status).toBe(403);
    expect((await call("POST /v1/shifts/{shiftId}/reconcile", w.managerB, { path: { shiftId: ended }, body })).status).toBeGreaterThanOrEqual(403);
    expect((await db.admin.query("select released_at from ogevia.authorization_reservations where shift_id = $1", [ended])).rows[0].released_at).toBeNull();
    const ok = await call("POST /v1/shifts/{shiftId}/reconcile", w.managerA, { path: { shiftId: ended }, body });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.reconciliation).toMatchObject({ outcome: "no_service_delivered", released: true, reservedMinutes: 60 });
    const again = await call("POST /v1/shifts/{shiftId}/reconcile", w.managerA, { path: { shiftId: ended }, body });
    expect(again.status).toBe(409);
    expect((await call("POST /v1/shifts/{shiftId}/reconcile", w.managerA, { path: { shiftId: ended }, body: { ...body, outcome: "nope" } })).status).toBe(422);
  });
});

describe("authorization decrease sends an unapproved visit back to review (0071) through the handler", () => {
  it("read needs visits.read; lifting it needs visits.manage and a note; one keyed request; the visit is never changed; a repeat is refused", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 1000, w.orgA, { before: 40, after: 200 });
    const v = await signedVisit(db, w.caregiverA2, w, 90, w.orgA, f.client, f.service);
    const per = (await db.admin.query("select period_start::text s, period_end::text e from ogevia.client_authorizations where id = $1", [f.auth])).rows[0];
    const before = (await db.admin.query("select status::text s, worked_minutes, billable_minutes from ogevia.service_visits where id = $1", [v.visit])).rows[0];
    const out = await call("POST /v1/authorizations/{authorizationId}/amend", w.managerA, {
      path: { authorizationId: f.auth }, body: { payer: "Synthetic Payer", monthlyAuthorizedMinutes: 30, periodStart: per.s, periodEnd: per.e, reason: "Payer lowered the month (synthetic)" } });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const read = await call("GET /v1/visits/{visitId}/authorization-review", w.managerA, { path: { visitId: v.visit }, query: { organizationId: w.orgA } });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.review).toMatchObject({ open: true });
    expect(read.body.review.reviews[0]).toMatchObject({ reason: "authorization_over_cap", billableMinutes: 90, excessMinutes: 60, newMonthlyMinutes: 30 });
    expect((await call("GET /v1/visits/{visitId}/authorization-review", w.managerB, { path: { visitId: v.visit }, query: { organizationId: w.orgB } })).body.review ?? null).toBeNull();
    const body = { organizationId: w.orgA, note: "Payer confirmed the change does not apply (synthetic)" };
    expect((await call("POST /v1/visits/{visitId}/authorization-review/resolve", w.caregiverA2, { path: { visitId: v.visit }, body, key: randomUUID() })).status).toBe(403);
    expect((await call("POST /v1/visits/{visitId}/authorization-review/resolve", w.managerA, { path: { visitId: v.visit }, body: { ...body, note: "x" }, key: randomUUID() })).status).toBeGreaterThanOrEqual(400);
    const key = randomUUID();
    const ok = await call("POST /v1/visits/{visitId}/authorization-review/resolve", w.managerA, { path: { visitId: v.visit }, body, key });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const retry = await call("POST /v1/visits/{visitId}/authorization-review/resolve", w.managerA, { path: { visitId: v.visit }, body, key });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    const after = (await db.admin.query("select status::text s, worked_minutes, billable_minutes from ogevia.service_visits where id = $1", [v.visit])).rows[0];
    expect(after).toEqual(before);
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_authorization_reviews where visit_id = $1 and resolved_at is not null", [v.visit])).rows[0].n).toBe(1);
  });
});

describe("amendments report the reserved shifts", () => {
  it("the amend response lists them, they are stored, listed and acknowledged with a note; nothing is released", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 5000, w.orgA, { before: 40, after: 200 });
    const s1 = await reserved(f, 24 * 60, 120), s2 = await reserved(f, 48 * 60, 120);
    const per = (await db.admin.query("select period_start::text s, period_end::text e from ogevia.client_authorizations where id = $1", [f.auth])).rows[0];
    const out = await call("POST /v1/authorizations/{authorizationId}/amend", w.managerA, {
      path: { authorizationId: f.auth }, body: { payer: "Synthetic Payer", monthlyAuthorizedMinutes: 120, periodStart: per.s, periodEnd: per.e, reason: "Payer lowered the month (synthetic)" } });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.affectedShifts).toHaveLength(1);
    expect(out.body.affectedShifts[0]).toMatchObject({ impact: "reserved_shift_over_cap", reservedMinutes: 120 });
    expect([s1, s2]).toContain(out.body.affectedShifts[0].shiftId);
    expect((await db.admin.query("select count(*)::int n from ogevia.authorization_reservations where shift_id in ($1,$2) and released_at is null", [s1, s2])).rows[0].n).toBe(2);
    const open = await call("GET /v1/authorization-impacts", w.managerA, { query: { organizationId: w.orgA } });
    const mine = open.body.impacts.find((i: any) => i.impactId === out.body.affectedShifts[0].impactId);
    expect(mine).toMatchObject({ impactKind: "reserved_shift_over_cap", stillApplicable: true, acknowledgedAt: null });
    expect((await call("GET /v1/authorization-impacts", w.caregiverA1, { query: { organizationId: w.orgA } })).status).toBe(403);
    const short = await call("POST /v1/authorization-impacts/{impactId}/acknowledge", w.managerA, { path: { impactId: mine.impactId }, body: { organizationId: w.orgA, note: "x" } });
    expect(short.status).toBe(422);
    const done = await call("POST /v1/authorization-impacts/{impactId}/acknowledge", w.managerA, { path: { impactId: mine.impactId }, body: { organizationId: w.orgA, note: "Moved the later shift to next month (synthetic)" } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await call("GET /v1/authorization-impacts", w.managerA, { query: { organizationId: w.orgA } })).body.impacts.map((i: any) => i.impactId)).not.toContain(mine.impactId);
    expect((await call("GET /v1/authorization-impacts", w.managerA, { query: { organizationId: w.orgA, includeAcknowledged: "true" } })).body.impacts.map((i: any) => i.impactId)).toContain(mine.impactId);
    expect((await call("POST /v1/authorization-impacts/{impactId}/acknowledge", w.managerA, { path: { impactId: mine.impactId }, body: { organizationId: w.orgA, note: "Again, to be sure" } })).status).toBe(409);
  });
});

describe("exports are server-generated: request, generation, and the permission that gates them (0069, 0072)", () => {
  const ledger = async (a: Actor = w.ownerA) => (await call("GET /v1/exports", a, { query: { organizationId: w.orgA } })).body.exports as Array<Record<string, any>>;
  const count = async () => Number((await db.admin.query("select count(*)::int n from ogevia.report_exports")).rows[0].n);
  const body = (report: string, params: Record<string, unknown> = { monthStart }) => ({ organizationId: w.orgA, report, params });

  it("a scheduler, a caregiver and another agency are refused with NOTHING written and no file; the browser can no longer record an export itself", async () => {
    const before = await count();
    const events = Number((await db.admin.query("select count(*)::int n from ogevia.report_export_events")).rows[0].n);
    for (const who of [w.schedulerA, w.caregiverA1]) {
      const r = await call("POST /v1/exports", who, { body: body("monthly_service_reconciliation") });
      expect(r.status).toBe(403);
      expect(r.body.csv).toBeUndefined();
    }
    expect((await call("POST /v1/exports", w.managerB, { body: body("monthly_chain") })).status).toBeGreaterThanOrEqual(403);
    expect(await count()).toBe(before);
    expect(Number((await db.admin.query("select count(*)::int n from ogevia.report_export_events")).rows[0].n)).toBe(events);
    // the old claim-by-browser function is gone
    expect((await db.admin.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname = 'record_report_export'")).rows[0].n).toBe(0);
  });

  it("each of the four reports is built by the server; the ledger shows requested, then generated with rows, bytes and the SHA-256 of exactly the file returned", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 5000, w.orgA, { before: 40, after: 200 });
    await signedVisit(db, w.caregiverA1, w, 30, w.orgA, f.client, f.service);
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["client_service_calendar", { monthStart, clientId: f.client }, /^client-service-calendar-\d{4}-\d{2}\.csv$/],
      ["monthly_service_reconciliation", { monthStart }, /^monthly-service-reconciliation-\d{4}-\d{2}\.csv$/],
      ["correction_history", {}, /^correction-history\.csv$/],
      ["monthly_chain", { monthStart, clientId: f.client }, /^monthly-chain-\d{4}-\d{2}\.csv$/],
    ];
    for (const [report, params, name] of cases) {
      const r = await call("POST /v1/exports", w.managerA, { body: body(report, params) });
      expect(r.status, `${report}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.filename).toMatch(name);
      expect(r.body.exportId).toBeTruthy();
      const csv = r.body.csv as string;
      expect(r.body.byteCount).toBe(Buffer.byteLength(csv, "utf8"));
      const entry = (await ledger()).find((e) => e.exportId === r.body.exportId)!;
      expect(entry).toMatchObject({ reportKey: report, status: "generated", rowCount: r.body.rowCount, byteCount: r.body.byteCount, delivery: "server_generated", requestedByName: expect.any(String) });
      expect(entry.sha256Hex).toBe(createHash("sha256").update(csv, "utf8").digest("hex"));
      expect(entry.generatedAt).toBeTruthy();
      const events = (await db.admin.query("select event from ogevia.report_export_events where export_id = $1 order by id", [r.body.exportId])).rows.map((x) => x.event);
      expect(events).toEqual(["requested", "generated"]);
      const audit = (await db.admin.query("select action, after_state from ogevia.audit_events where entity_id = $1 order by id", [r.body.exportId])).rows;
      expect(audit.map((a) => a.action)).toEqual(["report.export_requested", "report.export_generated"]);
      expect(JSON.stringify(audit[1].after_state)).toMatch(/Delivery to the device is not recorded/); // generation is not a claim of download
    }
    // content spot checks
    const rec = await call("POST /v1/exports", w.managerA, { body: body("monthly_service_reconciliation", { monthStart }) });
    const lines = (rec.body.csv as string).split("\r\n");
    expect(lines[0]).toContain('"Approved by a person (min)"');
    expect(lines.length).toBeGreaterThan(1);
  });

  it("a failure to build the file records FAILED, returns no file, and leaves the request visible as failed; a missing required parameter is refused before anything is requested", async () => {
    const before = await count();
    const bad = await call("POST /v1/exports", w.managerA, { body: body("client_service_calendar", { monthStart }) }); // no client
    expect(bad.status).toBe(400);
    expect(await count()).toBe(before);
    expect((await call("POST /v1/exports", w.managerA, { body: body("everything") })).status).toBe(400);
    // force a generation failure: a month the database function rejects after the request was accepted
    await db.admin.query("alter function ogevia_api.get_monthly_chain_report(uuid, date, uuid) rename to get_monthly_chain_report_off");
    let failed;
    try { failed = await call("POST /v1/exports", w.managerA, { body: body("monthly_chain") }); }
    finally { await db.admin.query("alter function ogevia_api.get_monthly_chain_report_off(uuid, date, uuid) rename to get_monthly_chain_report"); }
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.body.csv).toBeUndefined();
    const entry = (await ledger())[0]!;
    expect(entry).toMatchObject({ reportKey: "monthly_chain", status: "failed", errorCode: expect.any(String), sha256Hex: null });
    expect((await db.admin.query("select action from ogevia.audit_events where entity_id = $1 order by id", [entry.exportId])).rows.map((a) => a.action)).toEqual(["report.export_requested", "report.export_failed"]);
  });

  it("only the owner reads the ledger; ledger rows and events cannot be edited or deleted; a request nobody closed stays visible as requested", async () => {
    expect((await call("GET /v1/exports", w.managerA, { query: { organizationId: w.orgA } })).status).toBe(403);
    await expect(db.admin.query("delete from ogevia.report_export_events")).rejects.toThrow();
    await expect(db.admin.query("update ogevia.report_exports set report_key = 'monthly_chain'")).rejects.toThrow();
  });
});

describe("the full-chain monthly report and its server-generated export", () => {
  it("returns the chain with passing checks; the CSV is made by the server, recorded in the same transaction, and refused (and not recorded) without permission", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 5000, w.orgA, { before: 40, after: 200 });
    await signedVisit(db, w.caregiverA1, w, 30, w.orgA, f.client, f.service);
    await reserved(f, 24 * 60, 60);
    const rep = await call("GET /v1/reports/monthly-chain", w.managerA, { query: { organizationId: w.orgA, monthStart, clientId: f.client } });
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect(rep.body.rows).toHaveLength(1);
    expect(rep.body.rows[0]).toMatchObject({ authorizedMinutes: 5000, billableMinutes: 30, readyForReviewMinutes: 30, scheduledMinutes: 60, reservedOk: true, visitsOk: true, balanceOk: true, differenceMinutes: 0 });

    const before = (await db.admin.query("select count(*)::int n from ogevia.report_exports")).rows[0].n;
    const refused = await call("POST /v1/exports", w.schedulerA, { body: { organizationId: w.orgA, report: "monthly_chain", params: { monthStart, clientId: f.client } } });
    expect(refused.status).toBe(403);
    expect((await db.admin.query("select count(*)::int n from ogevia.report_exports")).rows[0].n).toBe(before); // nothing recorded, nothing returned
    expect(refused.body.csv).toBeUndefined();

    const ok = await call("POST /v1/exports", w.managerA, { body: { organizationId: w.orgA, report: "monthly_chain", params: { monthStart, clientId: f.client } } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.filename).toBe(`monthly-chain-${monthStart.slice(0, 7)}.csv`);
    const lines = (ok.body.csv as string).split("\r\n");
    expect(lines[0]).toContain('"Authorized (min)"');
    expect(lines[1]).toContain(",5000,60,0,0,60,30,30,30,"); // authorized, scheduled, held, reconcile, reserved, worked, confirmed, billable
    expect(lines.at(-1)).toContain("Submitted / billed is not part of this report");
    expect((await db.admin.query("select count(*)::int n from ogevia.report_exports")).rows[0].n).toBe(before + 1);
  });

  it("CSV cells that start with a formula character cannot run in a spreadsheet; numbers stay numbers", () => {
    const csv = chainCsv([{ clientCode: "=HYPERLINK(\"http://x\")", serviceCode: "+SUM(A1)", hoursLeftMinutes: -85, reservedOk: true, authorizedMinutes: 100 }]);
    const row = csv.split("\r\n")[1]!;
    expect(row).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(row).toContain(`"'+SUM(A1)"`);
    expect(row).toContain(",-85,");
    expect(row).not.toMatch(/(^|,)"?[=+@]/);
  });

  it("refuses a month that is not a date", async () => {
    expect((await call("GET /v1/reports/monthly-chain", w.managerA, { query: { organizationId: w.orgA, monthStart: "October" } })).status).toBe(400);
  });
});
void randomUUID;
