// Through the real Lambda handler (SYNTHETIC data only): reconciliation of ended shifts (0067), amendment impacts (0068), export permission and audit (0069), and the
// full-chain monthly report with its server-generated CSV (0070).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { chainCsv } from "../src/routes";
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

describe("export permission and audit through the API", () => {
  it("a manager exports and the owner reads the ledger; a scheduler and a caregiver are refused; nothing is recorded for a refusal", async () => {
    const before = (await db.admin.query("select count(*)::int n from ogevia.report_exports")).rows[0].n;
    const body = { organizationId: w.orgA, report: "monthly_service_reconciliation", rowCount: 4, params: { month: monthStart } };
    expect((await call("POST /v1/exports", w.schedulerA, { body })).status).toBe(403);
    expect((await call("POST /v1/exports", w.caregiverA1, { body })).status).toBe(403);
    expect((await call("POST /v1/exports", w.managerB, { body })).status).toBeGreaterThanOrEqual(403);
    expect((await db.admin.query("select count(*)::int n from ogevia.report_exports")).rows[0].n).toBe(before);
    const ok = await call("POST /v1/exports", w.managerA, { body });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.export.exportId).toBeTruthy();
    expect((await call("POST /v1/exports", w.managerA, { body: { ...body, report: "everything" } })).status).toBe(422);
    expect((await call("POST /v1/exports", w.managerA, { body: { ...body, rowCount: -3 } })).status).toBe(400);
    const ledger = await call("GET /v1/exports", w.ownerA, { query: { organizationId: w.orgA } });
    expect(ledger.body.exports[0]).toMatchObject({ reportKey: "monthly_service_reconciliation", rowCount: 4, delivery: "browser_assembled" });
    expect((await call("GET /v1/exports", w.managerA, { query: { organizationId: w.orgA } })).status).toBe(403);
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
    const refused = await call("POST /v1/reports/monthly-chain/export", w.schedulerA, { body: { organizationId: w.orgA, monthStart, clientId: f.client } });
    expect(refused.status).toBe(403);
    expect((await db.admin.query("select count(*)::int n from ogevia.report_exports")).rows[0].n).toBe(before); // nothing recorded, nothing returned
    expect(refused.body.csv).toBeUndefined();

    const ok = await call("POST /v1/reports/monthly-chain/export", w.managerA, { body: { organizationId: w.orgA, monthStart, clientId: f.client } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.filename).toBe(`monthly-chain-${monthStart.slice(0, 7)}.csv`);
    const lines = (ok.body.csv as string).split("\r\n");
    expect(lines[0]).toContain('"Authorized (min)"');
    expect(lines[1]).toContain(",5000,60,0,0,60,30,30,30,"); // authorized, scheduled, held, reconcile, reserved, worked, confirmed, billable
    expect(lines.at(-1)).toContain("Submitted / billed is not part of this report");
    const row = (await db.admin.query("select * from ogevia.report_exports where id = $1", [ok.body.exportId])).rows[0];
    expect(row).toMatchObject({ report_key: "monthly_chain", delivery: "server_generated", row_count: 1, exported_by: w.managerA.userId });
    expect((await db.admin.query("select count(*)::int n from ogevia.report_exports")).rows[0].n).toBe(before + 1);
  });

  it("CSV cells that start with a formula character cannot run in a spreadsheet; numbers stay numbers", () => {
    const csv = chainCsv([{ clientCode: "=HYPERLINK(\"http://x\")", serviceCode: "+SUM(A1)", remainingMinutes: -85, reservedOk: true, authorizedMinutes: 100 }]);
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
