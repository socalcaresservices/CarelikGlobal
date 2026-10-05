// 0027 Agency continuity pack. SYNTHETIC data only.
// Every call runs as the application role through begin_request.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let fresh: { client: string; service: string; auth: string };
let freshB: { client: string; service: string; auth: string };
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
  freshB = await freshClient(db, w, w.caregiverB1, 6000, w.orgB, { before: 40, after: 40 });
  await db.admin.query("update ogevia.clients set client_code = 'CL-A-CONT', caregiver_display_code = 'Synthetic A' where id = $1", [fresh.client]);
  await db.admin.query("update ogevia.clients set client_code = 'CL-B-CONT', caregiver_display_code = 'Synthetic B' where id = $1", [freshB.client]);
  await db.admin.query(
    "insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by) values ($1, $2, 'Synthetic', 'Continuity', $3)",
    [fresh.client, w.orgA, w.ownerA.userId]);
  const today = await orgToday(db);
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
  await asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia_api.create_shift($1, $2, $3, $4::date, '09:00', '11:00', null, null)",
    [w.orgA, fresh.client, fresh.service, tomorrow]));
  await asActor(db, w.managerB.sub, (c) => c.query("select * from ogevia_api.create_shift($1, $2, $3, $4::date, '09:00', '11:00', null, null)",
    [w.orgB, freshB.client, freshB.service, tomorrow]));
});
afterAll(async () => db?.drop());

const pack = (a: Actor, org: string, key: string = crypto.randomUUID()) =>
  asActor(db, a.sub, async (c) => (await c.query("select ogevia_api.create_continuity_pack($1, $2) as p", [org, key])).rows[0].p);
const status = (a: Actor, org: string) =>
  asActor(db, a.sub, async (c) => (await c.query("select * from ogevia_api.get_continuity_status($1)", [org])).rows[0]);

describe("continuity pack", () => {
  it("gives a manager the agency's own schedule, clients, hours and Care Team, with a data-as-of time; audited", async () => {
    const before = Date.now();
    const p = await pack(w.managerA, w.orgA);
    expect(Date.parse(p.data_as_of)).toBeGreaterThanOrEqual(before - 5000);
    expect(p.outage_numbers).toEqual({ first: 1, last: 25 });
    expect(p.shifts.map((s: any) => s.client_code)).toContain("CL-A-CONT");
    expect(p.shifts.find((s: any) => s.client_code === "CL-A-CONT")).toMatchObject({ start: "09:00", end: "11:00", coverage: "needs_coverage" });
    expect(p.clients.find((c: any) => c.client_code === "CL-A-CONT").client_name).toBe("Synthetic Continuity");
    const a = p.authorizations.find((x: any) => x.client_code === "CL-A-CONT");
    // The shift (tomorrow) reserves 120 minutes in this month's figures unless tomorrow is next month.
    const sameMonth = (await orgToday(db)).slice(0, 7) === new Date(Date.now() + 864e5).toISOString().slice(0, 7);
    expect(a).toMatchObject({ authorized_minutes: 6000, client_label: "Synthetic A" });
    if (sameMonth) expect(a.reserved_minutes).toBe(120);
    expect(p.caregivers.length).toBeGreaterThan(0);
    const audit = await db.admin.query("select count(*)::int as n from ogevia.audit_events where entity_id = $1 and action = 'continuity.pack_downloaded'", [p.export_id]);
    expect(audit.rows[0].n).toBe(1);
  });

  it("never contains another agency's records, money, rates, payer or member identifiers", async () => {
    const p = await pack(w.ownerA, w.orgA);
    const text = JSON.stringify(p);
    expect(text).not.toContain("CL-B-CONT");
    expect(text).not.toMatch(/rate|cents|amount|payer|SYNTHETIC-PAYER|uci|medicaid|birth|dob/i);
    const b = await pack(w.managerB, w.orgB);
    expect(JSON.stringify(b)).not.toContain("CL-A-CONT");
    // Agency B's numbers are its own sequence.
    expect(b.outage_numbers.first).toBe(1);
  });

  it("refuses caregivers, schedulers, other agencies' managers and outsiders", async () => {
    await expectPgError(pack(w.caregiverA1, w.orgA), "OGA03", /permission to download the continuity pack/);
    await expectPgError(pack(w.schedulerA, w.orgA), "OGA03");
    await expectPgError(pack(w.managerB, w.orgA), "OGN04");
    await expectPgError(pack(w.outsider, w.orgA), "OGN04");
    await expectPgError(status(w.caregiverA1, w.orgA), "OGA03");
  });

  it("a retried request returns the same outage numbers; concurrent downloads never share numbers", async () => {
    const key = crypto.randomUUID();
    const one = await pack(w.managerA, w.orgA, key);
    const again = await pack(w.managerA, w.orgA, key);
    expect(again.outage_numbers).toEqual(one.outage_numbers);
    expect(again.export_id).toBe(one.export_id);
    await expectPgError(pack(w.ownerA, w.orgA, key), "OGC09", /another download/);
    const many = await Promise.all([1, 2, 3, 4].map(() => pack(w.managerA, w.orgA)));
    const ranges = [one, ...many].map((p) => [p.outage_numbers.first, p.outage_numbers.last]).sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1);
  });

  it("status shows the latest download, who and how long ago", async () => {
    const s = await status(w.managerA, w.orgA);
    expect(Number(s.hours_since)).toBeLessThan(1);
    expect(s.last_downloaded_by).toBeTruthy();
    expect(s.downloads_last_7_days).toBeGreaterThanOrEqual(6);
    expect(s.outage_numbers_issued % 25).toBe(0);
  });

  it("the download history cannot be changed or deleted, and rollback 0027 refuses while it exists", async () => {
    await expectPgError(db.admin.query("update ogevia.continuity_exports set shift_count = 0"), "OGC09", /append-only/);
    await expectPgError(db.admin.query("delete from ogevia.continuity_exports"), "OGC09", /never deleted/);
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query("set local role ogevia_owner");
      await expectPgError(client.query(readFileSync(new URL("../rollback/0027_continuity_pack.down.sql", import.meta.url), "utf8")),
        "P0001", /ROLLBACK REFUSED: continuity pack downloads are recorded/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
