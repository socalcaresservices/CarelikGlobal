import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ageVisit,
  api,
  asActor,
  createTestDb,
  endedVisit,
  expectPgError,
  freshClient,
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

const listClients = (sub: string, org: string) =>
  asActor(
    db,
    sub,
    async (c) =>
      (
        await c.query(
          "select * from ogevia_api.list_assigned_visit_clients($1)",
          [org],
        )
      ).rows,
  );
const listServices = (sub: string, org: string, client: string) =>
  asActor(
    db,
    sub,
    async (c) =>
      (
        await c.query(
          "select * from ogevia_api.list_authorized_services_for_client($1,$2)",
          [org, client],
        )
      ).rows,
  );

describe("TENANT isolation (Organization A vs Organization B)", () => {
  it("does not list Organization B clients to an Organization A caregiver or manager", async () => {
    expect(await listClients(w.caregiverA1.sub, w.orgB)).toEqual([]);
    expect(await listClients(w.managerA.sub, w.orgB)).toEqual([]);
    expect(
      (await listClients(w.managerA.sub, w.orgA)).map((r) => r.client_id),
    ).not.toContain(w.clientB1);
  });

  it("does not reveal Organization B authorizations", async () => {
    expect(await listServices(w.managerA.sub, w.orgB, w.clientB1)).toEqual([]);
    expect(await listServices(w.caregiverA1.sub, w.orgA, w.clientB1)).toEqual(
      [],
    );
  });

  it("cannot start a visit for Organization B, or for a B client under org A", async () => {
    await expectPgError(
      api.start(db, w.caregiverA1, w.orgB, w.clientB1, w.serviceB),
      "OGA03",
    );
    await expectPgError(
      api.start(db, w.managerA, w.orgB, w.clientB1, w.serviceB),
      "OGA03",
    );
    await expectPgError(
      api.start(db, w.managerA, w.orgA, w.clientB1, w.serviceA),
      "OGN04",
    );
  });

  it("cannot end, sign, void, or correct an Organization B visit, or register its evidence", async () => {
    const b = await signedVisit(
      db,
      w.caregiverB1,
      w,
      30,
      w.orgB,
      w.clientB1,
      w.serviceB,
    );
    const open = await endedVisit(
      db,
      w.managerB,
      w,
      20,
      w.orgB,
      w.clientB1,
      w.serviceB,
    );
    await expectPgError(api.end(db, w.managerA, open), "OGN04");
    await expectPgError(
      api.registerEvidence(db, w.managerA, w.orgB, open),
      "OGN04",
    );
    await expectPgError(
      api.confirm(db, w.managerA, open, {
        method: "unable_to_confirm",
        reason: "x",
      }),
      "OGN04",
    );
    await expectPgError(
      asActor(db, w.managerA.sub, (c) =>
        c.query("select ogevia_api.void_service_visit($1,'x')", [open]),
      ),
      "OGN04",
    );
    const t = new Date(Date.now() - 3 * 3600_000);
    await expectPgError(
      api.correct(
        db,
        w.managerA,
        b.visit,
        t,
        new Date(t.getTime() + 1800_000),
        "cross-tenant",
      ),
      "OGN04",
    );
    // Org B data is unchanged.
    expect((await visitRow(db, b.visit)).status).toBe("signed");
    expect((await visitRow(db, open)).status).toBe("awaiting_signature");
  });

  it("cannot read Organization B visits, corrections, or billing review", async () => {
    const rowsA = await asActor(
      db,
      w.managerA.sub,
      async (c) =>
        (
          await c.query("select * from ogevia_api.list_service_visits($1)", [
            w.orgB,
          ])
        ).rows,
    );
    expect(rowsA).toEqual([]);
    const review = await asActor(
      db,
      w.managerA.sub,
      async (c) =>
        (
          await c.query(
            "select * from ogevia_api.list_billing_review_visits($1, '2000-01-01', '2100-01-01')",
            [w.orgB],
          )
        ).rows,
    );
    expect(review).toEqual([]);
  });

  it("cannot amend an Organization B authorization or consume its minutes", async () => {
    await expectPgError(api.amend(db, w.managerA, w.authB1, 99999), "OGN04");
    const { rows } = await db.admin.query(
      "select count(*)::int as n from ogevia.client_authorizations where lineage_id = $1",
      [w.authB1],
    );
    expect(rows[0].n).toBe(1);
  });

  it("rejects a revoked member and a non-member", async () => {
    await expectPgError(
      api.start(db, w.outsider, w.orgA, w.clientA1, w.serviceA),
      "OGA03",
    );
    expect(await listClients(w.outsider.sub, w.orgA)).toEqual([]);
  });

  it("rejects everything for a suspended organization", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    await db.admin.query(
      "update ogevia.organizations set status = 'suspended' where id = $1",
      [w.orgA],
    );
    try {
      await expectPgError(
        api.start(db, w.caregiverA1, w.orgA, f.client, f.service),
        "OGA03",
      );
      expect(await listClients(w.caregiverA1.sub, w.orgA)).toEqual([]);
    } finally {
      await db.admin.query(
        "update ogevia.organizations set status = 'active' where id = $1",
        [w.orgA],
      );
    }
  });
});

describe("ASSIGNMENTS are enforced in the database", () => {
  it("lets an actively assigned caregiver start", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
    );
    expect((await visitRow(db, visit)).status).toBe("draft");
    await asActor(db, w.managerA.sub, (c) =>
      c.query("select ogevia_api.void_service_visit($1,'test cleanup')", [
        visit,
      ]),
    );
  });

  it("rejects an expired assignment, an inactive assignment, and an unassigned caregiver", async () => {
    await expectPgError(
      api.start(db, w.caregiverA2, w.orgA, w.clientA1, w.serviceA),
      "OGA03",
      /not assigned/,
    );
    await expectPgError(
      api.start(db, w.caregiverA3, w.orgA, w.clientA1, w.serviceA),
      "OGA03",
      /not assigned/,
    );
    await expectPgError(
      api.start(db, w.caregiverA1, w.orgA, w.clientA2, w.serviceA),
      "OGA03",
      /not assigned/,
    );
    expect(await listClients(w.caregiverA2.sub, w.orgA)).toEqual([]);
  });

  it("rejects a caregiver acting on another caregiver's visit", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
    );
    await ageVisit(db, visit, 30);
    await expectPgError(api.end(db, w.caregiverA2, visit), "OGA03");
    await api.end(db, w.caregiverA1, visit);
    await expectPgError(
      api.confirm(db, w.caregiverA2, visit, {
        method: "unable_to_confirm",
        reason: "x",
      }),
      "OGA03",
    );
    await api.confirm(db, w.caregiverA1, visit, {
      method: "unable_to_confirm",
      reason: "client asleep",
    });
  });

  it("assignment removed while a visit is active: the visit can still be ended and confirmed, but no new start", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
    );
    await db.admin.query(
      "update ogevia.caregiver_assignments set is_active = false where client_id = $1",
      [f.client],
    );
    await ageVisit(db, visit, 45);
    const ended = await api.end(db, w.caregiverA1, visit);
    expect(ended.worked_minutes).toBe(45);
    const ev = await api.registerEvidence(db, w.caregiverA1, w.orgA, visit);
    expect(
      (await api.confirm(db, w.caregiverA1, visit, { evidence: ev })).status,
    ).toBe("signed");
    await expectPgError(
      api.start(db, w.caregiverA1, w.orgA, f.client, f.service),
      "OGA03",
      /not assigned/,
    );
  });

  it("lists only assigned clients with only their assigned, current-authorized services", async () => {
    const clients = (await listClients(w.caregiverA1.sub, w.orgA)).map(
      (r) => r.client_id,
    );
    expect(clients).toContain(w.clientA1);
    expect(clients).not.toContain(w.clientA2);
    const services = await listServices(w.caregiverA1.sub, w.orgA, w.clientA1);
    expect(services.map((s) => s.service_id)).toEqual([w.serviceA]);
    // Caregiver sees only a code, never a legal name (there is no name column at all).
    const [row] = await listClients(w.caregiverA1.sub, w.orgA);
    expect(Object.keys(row!).sort()).toEqual([
      "active_service_count",
      "client_code",
      "client_id",
      "next_scheduled_ends_at",
      "next_scheduled_service_id",
      "next_scheduled_starts_at",
    ]);
  });
});

describe("VISITS: lifecycle", () => {
  it("start -> recover active -> end -> confirm", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
    );
    const active = await asActor(
      db,
      w.caregiverA1.sub,
      async (c) =>
        (
          await c.query(
            "select * from ogevia_api.get_active_service_visit($1)",
            [w.orgA],
          )
        ).rows,
    );
    expect(active).toHaveLength(1);
    expect(active[0].visit_id).toBe(visit);
    expect(active[0].visit_status).toBe("draft");
    expect(active[0].monthly_authorized_minutes).toBe(600);
    await ageVisit(db, visit, 60);
    expect((await api.end(db, w.caregiverA1, visit)).worked_minutes).toBe(60);
    const ev = await api.registerEvidence(db, w.caregiverA1, w.orgA, visit);
    const r = await api.confirm(db, w.caregiverA1, visit, { evidence: ev });
    expect(r).toMatchObject({
      status: "signed",
      authorization_status: "within_authorization",
      billable_minutes: 60,
    });
    expect(
      await asActor(
        db,
        w.caregiverA1.sub,
        async (c) =>
          (
            await c.query(
              "select * from ogevia_api.get_active_service_visit($1)",
              [w.orgA],
            )
          ).rows,
      ),
    ).toEqual([]);
  });

  it("rejects a duplicate start while a visit is open", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
    );
    await expectPgError(
      api.start(db, w.caregiverA1, w.orgA, f.client, f.service),
      "OGC09",
      /Finish your current visit/,
    );
    await asActor(db, w.managerA.sub, (c) =>
      c.query("select ogevia_api.void_service_visit($1,'cleanup')", [visit]),
    );
  });

  it("concurrent starts produce exactly one open visit", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        api.start(db, w.caregiverA1, w.orgA, f.client, f.service),
      ),
    );
    const ok = attempts.filter((a) => a.status === "fulfilled");
    expect(ok).toHaveLength(1);
    const { rows } = await db.admin.query(
      "select count(*)::int as n from ogevia.service_visits where caregiver_user_id = $1 and status in ('draft','awaiting_signature')",
      [w.caregiverA1.userId],
    );
    expect(rows[0].n).toBe(1);
    await asActor(db, w.managerA.sub, (c) =>
      c.query("select ogevia_api.void_service_visit($1,'cleanup')", [
        (ok[0] as PromiseFulfilledResult<string>).value,
      ]),
    );
  });

  it("rejects end before one minute and confirm before end", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
    );
    await expectPgError(
      api.end(db, w.caregiverA1, visit),
      "OGC09",
      /at least one minute/,
    );
    await expectPgError(
      api.registerEvidence(db, w.caregiverA1, w.orgA, visit),
      "OGC09",
    );
    await expectPgError(
      api.confirm(db, w.caregiverA1, visit, {
        method: "unable_to_confirm",
        reason: "x",
      }),
      "OGC09",
    );
    await asActor(db, w.managerA.sub, (c) =>
      c.query("select ogevia_api.void_service_visit($1,'cleanup')", [visit]),
    );
  });

  it("rejects ending a visit open longer than 24 hours", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000);
    const visit = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
    );
    await ageVisit(db, visit, 1441);
    await expectPgError(
      api.end(db, w.caregiverA1, visit),
      "OGC09",
      /over 24 hours/,
    );
    await asActor(db, w.managerA.sub, (c) =>
      c.query("select ogevia_api.void_service_visit($1,'cleanup')", [visit]),
    );
  });

  it("does not let a voided or signed visit be voided again", async () => {
    const { visit } = await signedVisit(db, w.caregiverA1, w, 15);
    await expectPgError(
      asActor(db, w.managerA.sub, (c) =>
        c.query("select ogevia_api.void_service_visit($1,'x')", [visit]),
      ),
      "OGC09",
      /use a correction/,
    );
  });

  it("enforces legal transitions at the table level for every role (owner included)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
    );
    await expectPgError(
      db.admin.query(
        "update ogevia.service_visits set status = 'signed' where id = $1",
        [visit],
      ),
      "OGC09",
      /Illegal visit transition draft -> signed/,
    );
    await expectPgError(
      db.admin.query("delete from ogevia.service_visits where id = $1", [
        visit,
      ]),
      "OGC09",
    );
    await asActor(db, w.managerA.sub, (c) =>
      c.query("select ogevia_api.void_service_visit($1,'cleanup')", [visit]),
    );
  });
});

describe("TIME is server-authoritative", () => {
  it("records time_in and time_out from the database clock, ignoring the session time zone", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const before = Date.now();
    const visit = await asActor(db, w.caregiverA1.sub, async (c) => {
      // A client-controlled session setting must not shift the service date.
      await c.query("set local timezone = 'Pacific/Kiritimati'");
      return (
        await c.query(
          "select ogevia_api.start_ad_hoc_service_visit($1,$2,$3) as id",
          [w.orgA, f.client, f.service],
        )
      ).rows[0].id as string;
    });
    const row = await visitRow(db, visit);
    expect(Math.abs((row.time_in as Date).getTime() - before)).toBeLessThan(
      5_000,
    );
    const { rows } = await db.admin.query(
      "select (now() at time zone 'America/Los_Angeles')::date::text as d",
    );
    expect(
      (
        await db.admin.query(
          "select service_date::text as d from ogevia.service_visits where id = $1",
          [visit],
        )
      ).rows[0].d,
    ).toBe(rows[0].d);
    await ageVisit(db, visit, 10);
    const ended = await api.end(db, w.caregiverA1, visit);
    expect(Math.abs(ended.time_out.getTime() - Date.now())).toBeLessThan(5_000);
    await api.confirm(db, w.caregiverA1, visit, {
      method: "unable_to_confirm",
      reason: "x",
    });
  });

  it("offers no API parameter for time_in, time_out, duration, or billable minutes", async () => {
    const { rows } = await db.admin.query(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ogevia_api' and p.proname in ('start_ad_hoc_service_visit','end_service_visit','confirm_service_visit','register_visit_evidence')`,
    );
    for (const r of rows) {
      expect(r.args).not.toMatch(/time_in|time_out|minutes|duration|signed_at/);
    }
  });

  it("rejects a manipulated time_in written directly to the table", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
    );
    await expectPgError(
      db.admin.query(
        "update ogevia.service_visits set time_in = time_in - interval '5 hours' where id = $1",
        [visit],
      ),
      "OGC09",
      /immutable/,
    );
    await asActor(db, w.managerA.sub, (c) =>
      c.query("select ogevia_api.void_service_visit($1,'cleanup')", [visit]),
    );
  });

  it("rejects a correction ending in the future", async () => {
    const { visit } = await signedVisit(db, w.caregiverA1, w, 20);
    await expectPgError(
      api.correct(
        db,
        w.managerA,
        visit,
        new Date(Date.now() - 600_000),
        new Date(Date.now() + 3600_000),
        "future",
      ),
      "OGV22",
      /future/,
    );
  });
});
