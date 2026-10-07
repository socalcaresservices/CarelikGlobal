import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ageVisit,
  api,
  asActor,
  createTestDb,
  endedVisit,
  expectPgError,
  freshClient,
  orgToday,
  seedWorld,
  signedVisit,
  visitRow,
  type TestDb,
  type World,
} from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db);
});
afterAll(async () => db?.drop());

const authRow = async (id: string) =>
  (
    await db.admin.query(
      "select * from ogevia.client_authorizations where id = $1",
      [id],
    )
  ).rows[0] as Record<string, unknown>;

/** Signs a visit of `minutes` for a specific client/service using caregiver A1. */
async function signFor(client: string, service: string, minutes: number) {
  return signedVisit(db, w.caregiverA1, w, minutes, w.orgA, client, service);
}

describe("AUTHORIZATION versioning (Phase 0 defect M-1 regression)", () => {
  it("binds a new visit to the CURRENT version after an amendment, never the superseded one", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 60);
    const [amended] = await api.amend(db, w.managerA, f.auth, 600);
    const v2 = amended!.new_authorization_id;
    const visit = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
    );
    expect((await visitRow(db, visit)).service_authorization_id).toBe(v2);
    await asActor(db, w.managerA.sub, (c) =>
      c.query("select ogevia_api.void_service_visit($1,'cleanup')", [visit]),
    );
  });

  it("keeps consumption across the lineage: an amendment does not reset used minutes", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const first = await signFor(f.client, f.service, 50);
    expect(first.result.remaining_minutes).toBe("550");
    const [amended] = await api.amend(db, w.managerA, f.auth, 300);
    expect(amended!.new_version_number).toBe(2);
    // 50 already used on v1 counts against v2's 300-minute cap.
    const second = await signFor(f.client, f.service, 100);
    expect(second.result).toMatchObject({
      status: "signed",
      billable_minutes: 100,
    });
    expect(second.result.month_to_date_minutes).toBe("150");
    expect(second.result.remaining_minutes).toBe("150");
  });

  it("a decrease cannot be bypassed by the old version: usage beyond the amended cap goes to review", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    await signFor(f.client, f.service, 100);
    await api.amend(db, w.managerA, f.auth, 120);
    const r = (await signFor(f.client, f.service, 60)).result;
    expect(r).toMatchObject({
      status: "administrator_review",
      authorization_status: "exceeds_authorization",
      billable_minutes: 20,
    });
    const { rows } = await db.admin.query(
      `select sum(v.billable_minutes)::int as total from ogevia.service_visits v
       join ogevia.client_authorizations a on a.id = v.service_authorization_id
       where a.lineage_id = $1 and v.status in ('signed','administrator_review')`,
      [f.auth],
    );
    expect(rows[0].total).toBe(120);
  });

  it("a visit started under v1 and confirmed after an amendment is capped by, and rebound to, v2", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await endedVisit(
      db,
      w.caregiverA1,
      w,
      90,
      w.orgA,
      f.client,
      f.service,
    );
    expect((await visitRow(db, visit)).service_authorization_id).toBe(f.auth);
    const [amended] = await api.amend(db, w.managerA, f.auth, 30);
    const ev = await api.registerEvidence(db, w.caregiverA1, w.orgA, visit);
    const r = await api.confirm(db, w.caregiverA1, visit, { evidence: ev });
    expect(r).toMatchObject({
      billable_minutes: 30,
      authorization_status: "exceeds_authorization",
    });
    expect((await visitRow(db, visit)).service_authorization_id).toBe(
      amended!.new_authorization_id,
    );
  });

  it("routes to review with zero billable when an amendment removed coverage for the date", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await endedVisit(
      db,
      w.caregiverA1,
      w,
      30,
      w.orgA,
      f.client,
      f.service,
    );
    await api.amend(db, w.managerA, f.auth, 600, "Moved to last year", {
      start: "2001-01-01",
      end: "2001-12-31",
    });
    const ev = await api.registerEvidence(db, w.caregiverA1, w.orgA, visit);
    const r = await api.confirm(db, w.caregiverA1, visit, { evidence: ev });
    expect(r).toMatchObject({
      status: "administrator_review",
      billable_minutes: 0,
      authorization_status: "exceeds_authorization",
    });
  });

  it("refuses to start when only a superseded version would cover the date", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    await api.amend(db, w.managerA, f.auth, 600, "Moved", {
      start: "2001-01-01",
      end: "2001-12-31",
    });
    await expectPgError(
      api.start(db, w.caregiverA1, w.orgA, f.client, f.service),
      "OGC09",
      /No active authorization/,
    );
  });

  it("retains superseded versions, immutable and linked, for audit", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const [amended] = await api.amend(
      db,
      w.managerA,
      f.auth,
      480,
      "Received amended notice",
    );
    const v1 = await authRow(f.auth);
    const v2 = await authRow(amended!.new_authorization_id);
    expect(v1).toMatchObject({
      is_current: false,
      superseded_by_id: v2.id,
      monthly_authorized_minutes: 600,
      version_number: 1,
    });
    expect(v2).toMatchObject({
      is_current: true,
      supersedes_id: f.auth,
      lineage_id: f.auth,
      version_number: 2,
      monthly_authorized_minutes: 480,
    });
    await expectPgError(
      db.admin.query(
        "update ogevia.client_authorizations set monthly_authorized_minutes = 9999 where id = $1",
        [f.auth],
      ),
      "OGC09",
      /immutable/,
    );
    await expectPgError(
      db.admin.query(
        "update ogevia.client_authorizations set monthly_authorized_minutes = 9999 where id = $1",
        [v2.id],
      ),
      "OGC09",
      /immutable/,
    );
    await expectPgError(
      db.admin.query("delete from ogevia.client_authorizations where id = $1", [
        f.auth,
      ]),
      "OGC09",
    );
    await expectPgError(
      api.amend(db, w.managerA, f.auth, 900),
      "OGC09",
      /superseded/,
    );
    const audit = await db.admin.query(
      "select action, before_state, after_state, reason from ogevia.audit_events where entity_id = $1",
      [v2.id],
    );
    expect(audit.rows[0]).toMatchObject({
      action: "client_authorization.amended",
      reason: "Received amended notice",
    });
  });

  it("forbids two CURRENT authorizations covering the same date (exclusion constraint)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const today = await orgToday(db);
    await expectPgError(
      db.admin.query(
        `insert into ogevia.client_authorizations
          (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
         values ($1,$2,$3,'OTHER',99999,$4::date - 3,$4::date + 3)`,
        [w.orgA, f.client, f.service, today],
      ),
      "23P01",
    );
  });

  it("only users with authorizations.update may amend", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    await expectPgError(api.amend(db, w.caregiverA1, f.auth, 9999), "OGA03");
    await expectPgError(api.amend(db, w.schedulerA, f.auth, 9999), "OGA03");
    expect(
      (await api.amend(db, w.ownerA, f.auth, 700))[0]!.new_version_number,
    ).toBe(2);
  });

  it("reports impacted visits on amendment (increase and decrease)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 100);
    const over = (await signFor(f.client, f.service, 150)).visit;
    const up = await api.amend(db, w.managerA, f.auth, 500);
    expect(up.find((r) => r.affected_visit_id === over)?.impact_kind).toBe(
      "increase_may_allow_more",
    );
    const down = await api.amend(
      db,
      w.managerA,
      up[0]!.new_authorization_id,
      50,
    );
    expect(down.find((r) => r.affected_visit_id === over)?.impact_kind).toBe(
      "decrease_now_exceeds",
    );
  });
});

describe("AUTHORIZATION consumption is exact and authoritative", () => {
  it("computes exact integer remaining minutes", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const r = (await signFor(f.client, f.service, 75)).result;
    expect(r).toMatchObject({
      status: "signed",
      authorization_status: "within_authorization",
      billable_minutes: 75,
    });
    expect(r.month_to_date_minutes).toBe("75");
    expect(r.remaining_minutes).toBe("525");
    const services = await asActor(
      db,
      w.caregiverA1.sub,
      async (c) =>
        (
          await c.query(
            "select * from ogevia_api.list_authorized_services_for_client($1,$2)",
            [w.orgA, f.client],
          )
        ).rows,
    );
    expect(services[0]).toMatchObject({
      monthly_authorized_minutes: 600,
      minutes_used_this_month: "75",
    });
  });

  it("marks limit_reached when a visit uses exactly the remaining minutes", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 100);
    const r = (await signFor(f.client, f.service, 100)).result;
    expect(r).toMatchObject({
      status: "signed",
      authorization_status: "limit_reached",
      billable_minutes: 100,
    });
    expect(r.remaining_minutes).toBe("0");
  });

  it("caps an exceeding visit and routes it to administrator review", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 100);
    await signFor(f.client, f.service, 80);
    const r = (await signFor(f.client, f.service, 50)).result;
    expect(r).toMatchObject({
      status: "administrator_review",
      authorization_status: "exceeds_authorization",
      worked_minutes: 50,
      billable_minutes: 20,
    });
    const row = await visitRow(db, r.visit_id);
    expect(row).toMatchObject({
      worked_minutes: 50,
      verified_minutes: 50,
      billable_minutes: 20,
    });
  });

  it("records administrator_override when a manager correction is fully within the cap", async () => {
    // Period spans +/-10 days so the corrected time never crosses a month edge.
    const f = await freshClient(db, w, w.caregiverA3, 600, w.orgA, {
      before: 10,
      after: 10,
    });
    const { visit } = await signedVisit(
      db,
      w.caregiverA3,
      w,
      30,
      w.orgA,
      f.client,
      f.service,
    );
    const t = new Date(Date.now() - 6 * 3600_000);
    const corrected = await api.correct(
      db,
      w.managerA,
      visit,
      t,
      new Date(t.getTime() + 45 * 60_000),
      "Late clock-in",
    );
    expect(await visitRow(db, corrected)).toMatchObject({
      status: "signed",
      authorization_status: "administrator_override",
      billable_minutes: 45,
    });
  });

  it("serializes concurrent confirmations so two visits can never both spend the last minutes", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 100);
    await db.admin.query(
      "insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)",
      [w.orgA, w.caregiverA2.userId, f.client, f.service, await orgToday(db)],
    );
    const v1 = await endedVisit(
      db,
      w.caregiverA1,
      w,
      80,
      w.orgA,
      f.client,
      f.service,
    );
    const v2 = await endedVisit(
      db,
      w.caregiverA2,
      w,
      80,
      w.orgA,
      f.client,
      f.service,
    );
    const e1 = await api.registerEvidence(db, w.caregiverA1, w.orgA, v1);
    const e2 = await api.registerEvidence(db, w.caregiverA2, w.orgA, v2);
    const [r1, r2] = await Promise.all([
      api.confirm(db, w.caregiverA1, v1, { evidence: e1 }),
      api.confirm(db, w.caregiverA2, v2, { evidence: e2 }),
    ]);
    expect(r1!.billable_minutes + r2!.billable_minutes).toBe(100);
    expect([r1!.authorization_status, r2!.authorization_status].sort()).toEqual(
      ["exceeds_authorization", "within_authorization"],
    );
  });

  it("many concurrent confirmations never exceed the cap in total", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 150);
    const caregivers = [w.caregiverA1, w.caregiverA2, w.caregiverA3];
    const today = await orgToday(db);
    for (const cg of caregivers.slice(1)) {
      await db.admin.query(
        "insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)",
        [w.orgA, cg.userId, f.client, f.service, today],
      );
    }
    // A3's earlier inactive assignment is irrelevant; this one is active.
    const visits = [];
    for (const cg of caregivers) {
      const v = await api.start(db, cg, w.orgA, f.client, f.service);
      await ageVisit(db, v, 70);
      await api.end(db, cg, v);
      visits.push({ cg, v, e: await api.registerEvidence(db, cg, w.orgA, v) });
    }
    const results = await Promise.all(
      visits.map(({ cg, v, e }) => api.confirm(db, cg, v, { evidence: e })),
    );
    expect(results.reduce((sum, r) => sum + r.billable_minutes, 0)).toBe(150);
  });
});
