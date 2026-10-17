// Synthetic pilot fixture with the owner's 8 h / 40 h work-hour policy and compliance enforcement ENABLED (owner request 2026-10-17, items 2 and 3).
// Runs the real deploy script (db/deploy/06_...) and the real read-only activation preview (db/preview/...) with psql against a disposable database. It never
// touches a live tenant: the only slugs that ever hold a policy are the agency's own and the synthetic pilot's. SYNTHETIC data only.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, asReplica, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let recA1: string;
let recA2: string;
let fx: { client: string; service: string; auth: string };
const PILOT = "scs-pilot-synthetic";
const file = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const dbUrl = () => { const u = new URL(process.env.OGEVIA_TEST_DATABASE_URL!); u.pathname = `/${db.name}`; return u.toString(); };
const psql = (script: string, vars: Record<string, string> = {}) =>
  execFileSync("psql", [dbUrl(), "-X", "-q", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", file(script)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** Splits the preview output into its lettered sections: { A: { header, rows } }. */
function sections(out: string) {
  const res: Record<string, { header: string[]; rows: string[][] }> = {};
  let cur: string | null = null; let lines: string[] = [];
  const flush = () => { if (cur) { const body = lines.filter((l) => l && !/^\(\d+ rows?\)$/.test(l)); res[cur] = { header: (body[0] ?? "").split("|"), rows: body.slice(1).map((l) => l.split("|")) }; } };
  for (const l of out.split("\n")) { const m = /^== ([A-Z])\./.exec(l); if (m) { flush(); cur = m[1]!; lines = []; } else lines.push(l); }
  flush();
  return res;
}
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const mkShift = (a: Actor, d: string, s: string, e: string, rec: string | null) =>
  call(a, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,null)", [w.orgA, fx.client, fx.service, d, s, e, rec]).then((r) => r[0].shift_id as string);
const policyRows = async () => (await q("select organization_slug, version, max_daily_minutes, max_weekly_minutes from ogevia.agency_work_hour_policies order by 1, 2")).rows;
async function sweep() {
  const c = await db.admin.connect();
  try {
    await c.query("begin"); await c.query("set local role ogevia_app");
    const orgs = (await c.query("select ogevia_api.system_compliance_orgs() as id")).rows.map((r) => r.id as string);
    for (const o of orgs) await c.query("select ogevia_api.system_compliance_sweep_org($1)", [o]);
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 100000);
  today = await orgToday(db);
  recA1 = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
  recA2 = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA2.userId])).rows[0].id;
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 40, after: 200 });
  await q("update ogevia.organizations set slug = 'synthetic-test-org' where id = $1", [w.orgA]); // neither the real tenant nor the pilot yet
});
afterAll(async () => db?.drop());

describe("the fixture script writes only the synthetic pilot's policy", () => {
  it("refuses to run when the synthetic pilot organization is not in the database, and writes nothing", async () => {
    const before = await policyRows();
    expect(() => psql("../deploy/06_pilot_work_hour_policy_synthetic.sql")).toThrow(/not in this database/);
    expect(await policyRows()).toEqual(before);
  });
  it("before it runs, a 9-hour shift is not limited for the pilot organization (no policy exists for that slug)", async () => {
    await q("update ogevia.organizations set slug = $2 where id = $1", [w.orgA, PILOT]);
    const id = await mkShift(w.managerA, day(3), "06:00", "15:00", recA1);
    await call(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic: policy not yet set')", [w.orgA, id]);
  });
  it("runs once, is repeatable, writes exactly one pilot row and leaves the agency's own policy and every other slug untouched", async () => {
    const before = await policyRows();
    psql("../deploy/06_pilot_work_hour_policy_synthetic.sql");
    psql("../deploy/06_pilot_work_hour_policy_synthetic.sql"); // second run: nothing new
    const after = await policyRows();
    expect(after.filter((r) => r.organization_slug === PILOT)).toEqual([{ organization_slug: PILOT, version: 1, max_daily_minutes: 480, max_weekly_minutes: 2400 }]);
    expect(after.filter((r) => r.organization_slug !== PILOT)).toEqual(before.filter((r) => r.organization_slug !== PILOT));
    expect(new Set(after.map((r) => r.organization_slug))).toEqual(new Set(["socal-care-services", PILOT]));
  });
});

describe("the pilot enforces 8 h/day and 40 h/week with no override", () => {
  it("the policy is readable by the organization's manager; another agency sees none", async () => {
    expect((await call(w.managerA, "select * from ogevia_api.get_work_hour_policy($1)", [w.orgA]))[0]).toMatchObject({ applies: true, max_daily_minutes: 480, max_weekly_minutes: 2400 });
    expect((await call(w.managerB, "select * from ogevia_api.get_work_hour_policy($1)", [w.orgB]))[0]).toMatchObject({ applies: false });
  });
  it("a 9-hour shift is refused; an 8-hour shift is accepted; the 41st weekly hour is refused even when no day exceeds 8", async () => {
    await expectPgError(mkShift(w.managerA, day(3), "06:00", "15:00", recA1), "OGR30", /daily hour limit/i);
    // five 8-hour days = 40 h in one local week, then one more hour in the same week
    const monday = (() => { const d = new Date(`${day(10)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); return d.toISOString().slice(0, 10); })();
    for (let i = 0; i < 5; i++) await mkShift(w.managerA, new Date(Date.parse(`${monday}T12:00:00Z`) + i * 864e5).toISOString().slice(0, 10), "08:00", "16:00", recA1);
    await expectPgError(mkShift(w.managerA, new Date(Date.parse(`${monday}T12:00:00Z`) + 5 * 864e5).toISOString().slice(0, 10), "08:00", "09:00", recA1), "OGR30", /weekly hour limit/i);
    // a different caregiver in the same week is unaffected
    await mkShift(w.managerA, new Date(Date.parse(`${monday}T12:00:00Z`) + 5 * 864e5).toISOString().slice(0, 10), "08:00", "09:00", recA2);
  });
});

describe("the exact boundaries: 40 hours is allowed, 40 hours and one minute is not (and 8 hours / 8 hours and one minute)", () => {
  // Wording corrected 2026-10-17: the earlier note said a sixth shift was refused "as the 41st hour". What the first test above does is: five 8-hour days = 2400 minutes
  // (allowed), then a 1-HOUR shift on the sixth day = 2460 minutes (refused). A sixth 8-HOUR day would total 2880 minutes (48 hours) and is refused for the same weekly rule.
  // This block states every boundary in minutes, with the week total read back from the database.
  const monday = () => { const d = new Date(`${day(22)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); return d.toISOString().slice(0, 10); };
  const plus = (m: string, n: number) => new Date(Date.parse(`${m}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const weekMinutes = async (rec: string, m: string) =>
    Number((await q(`select coalesce(sum(extract(epoch from (s.ends_at - s.starts_at)) / 60), 0)::int n from ogevia.shifts s
                     where s.caregiver_record_id = $1 and s.status = 'scheduled' and (s.starts_at at time zone 'America/Los_Angeles')::date >= $2::date and (s.starts_at at time zone 'America/Los_Angeles')::date < $2::date + 7`, [rec, m])).rows[0].n);

  it("weekly: 2400 minutes (exactly 40 h) is accepted; 2401 and 2415 are refused; a sixth 8-hour day (2880) is refused; the next Monday starts a new week", async () => {
    // The scheduling API's shortest shift is 15 minutes, so the exact boundary is reached with 2385 + 15 = 2400 and tested with 2385 + 16 = 2401.
    const m = monday();
    for (let i = 0; i < 4; i++) await mkShift(w.managerA, plus(m, i), "08:00", "16:00", recA2); // 1920
    await mkShift(w.managerA, plus(m, 4), "08:00", "15:45", recA2); // 465 -> 2385
    expect(await weekMinutes(recA2, m)).toBe(2385);
    await expectPgError(mkShift(w.managerA, plus(m, 5), "08:00", "08:16", recA2), "OGR30", /weekly hour limit/i); // 2385 + 16 = 2401: refused
    expect(await weekMinutes(recA2, m)).toBe(2385);
    await mkShift(w.managerA, plus(m, 5), "08:00", "08:15", recA2); // 2385 + 15 = 2400: exactly 40 hours, accepted
    expect(await weekMinutes(recA2, m)).toBe(2400);
    await expectPgError(mkShift(w.managerA, plus(m, 5), "09:00", "09:15", recA2), "OGR30", /weekly hour limit/i); // 2415
    await expectPgError(mkShift(w.managerA, plus(m, 6), "08:00", "16:00", recA2), "OGR30", /weekly hour limit/i); // a sixth 8-hour day: 2880 minutes (48 h)
    // below the API: a direct 1-minute insert at 2400 is refused by the database trigger (2401), whoever writes it
    await expect(q(`insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_record_id, starts_at, ends_at, status)
       select $1,$2,$3,$4, (($5::date + time '10:00') at time zone 'America/Los_Angeles'), (($5::date + time '10:01') at time zone 'America/Los_Angeles'), 'scheduled'`, [w.orgA, fx.client, fx.service, recA2, plus(m, 6)]))
      .rejects.toMatchObject({ code: "OGR30" });
    expect(await weekMinutes(recA2, m)).toBe(2400);
    await mkShift(w.managerA, plus(m, 7), "08:00", "08:15", recA2); // Monday of the next week: a new week
  });

  it("daily: 480 minutes (exactly 8 h) is accepted; 481 is refused, on that local day only", async () => {
    const m = plus(monday(), 14);
    await mkShift(w.managerA, m, "06:00", "13:45", recA2); // 465
    await expectPgError(mkShift(w.managerA, m, "13:45", "14:01", recA2), "OGR30", /daily hour limit/i); // 465 + 16 = 481
    await mkShift(w.managerA, m, "13:45", "14:00", recA2); // 465 + 15 = 480: accepted
    await expectPgError(mkShift(w.managerA, m, "14:00", "14:15", recA2), "OGR30", /daily hour limit/i); // 495
    await mkShift(w.managerA, plus(m, 1), "06:00", "06:15", recA2); // the next day is a new day
  });
});

describe("compliance enforcement ENABLED in the pilot, with the read-only activation preview", () => {
  let held: string;      // caregiver with no clearance, no hire date: would be held
  let heldShift: string;
  let visit: string;
  const counts = async () => (await q(`select (select count(*) from ogevia.caregiver_compliance_holds)::int holds, (select count(*) from ogevia.shift_readiness_flags)::int sflags,
      (select count(*) from ogevia.assignment_readiness_flags)::int aflags, (select count(*) from ogevia.audit_events)::int audit,
      (select enforcement_active_from from ogevia.organization_readiness_settings where organization_id = $1) enforcement`, [w.orgA])).rows[0];

  beforeAll(async () => {
    held = recA1;
    // activation refuses until CPR and TB are configured (document type + validity rule), exactly as in a real tenant
    const cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
    const tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
    await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
    await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
    await q("delete from ogevia.caregiver_background_checks where caregiver_record_id = $1", [held]);
    await q("update ogevia.caregiver_records set hire_date = null where id = $1", [held]);
    heldShift = (await q("select id from ogevia.shifts where caregiver_record_id = $1 and status = 'scheduled' order by starts_at limit 1", [held])).rows[0].id;
    await asReplica(db, "update ogevia.service_visits set status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Synthetic fixture' where caregiver_user_id = $1 and status = 'draft'", [w.caregiverA1.userId, w.managerA.userId]);
    visit = await api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service, null, "Synthetic: visit open at activation");
  });

  it("the preview is read-only, lists the caregiver, the shifts, the visit in progress and the hour-limit state, and changes nothing", async () => {
    const before = await counts();
    expect(before.enforcement).toBeNull();
    const out = sections(psql("../preview/enforcement_activation_preview.sql", { org_slug: PILOT }));
    expect(await counts()).toEqual(before); // nothing written: no hold, no flag, no audit row, enforcement still off
    expect(out.A!.rows[0]![0]).toBe(PILOT);
    expect(out.A!.rows[0]).toContain("8.0 h/day, 40.0 h/week (policy v1)");
    const heldCodes = new Set(out.B!.rows.map((r) => r[0]));
    const code = (await q("select caregiver_code from ogevia.caregiver_records where id = $1", [held])).rows[0].caregiver_code;
    expect(heldCodes.has(code)).toBe(true);
    const flaggedShifts = out.C!.rows.map((r) => r[1]);
    expect(flaggedShifts).toContain(heldShift);
    expect(out.E!.rows.map((r) => r[1])).toContain(visit);
    const totals = out.I!.rows[0]!;
    expect(Number(totals[1])).toBe(heldCodes.size);
    expect(Number(totals[3])).toBeGreaterThanOrEqual(1);
    // the preview contains no names or identifiers beyond codes
    expect(JSON.stringify(out)).not.toMatch(/Synthetic (Alpha|Beta)/);
  });

  it("after the owner's activation, the scheduled run holds exactly the caregivers the preview listed and flags exactly the shifts it listed; the visit in progress is not ended", async () => {
    const out = sections(psql("../preview/enforcement_activation_preview.sql", { org_slug: PILOT }));
    const previewCodes = [...new Set(out.B!.rows.map((r) => r[0]))].sort();
    const previewShifts = out.C!.rows.map((r) => r[1]).sort();
    const status = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
    await call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Synthetic pilot: reviewed the preview',$2)", [w.orgA, status.affectedShiftsCount]);
    await sweep();
    const holds = (await q("select r.caregiver_code from ogevia.caregiver_compliance_holds h join ogevia.caregiver_records r on r.id = h.caregiver_record_id where h.released_at is null order by 1")).rows.map((r) => r.caregiver_code);
    expect(holds).toEqual(previewCodes);
    const flagged = (await q("select shift_id from ogevia.shift_readiness_flags where kind = 'compliance' and resolved_at is null")).rows.map((r) => r.shift_id).sort();
    expect(flagged).toEqual(previewShifts);
    expect((await q("select status::text s, time_out from ogevia.service_visits where id = $1", [visit])).rows[0]).toMatchObject({ s: "draft", time_out: null });
  });

  it("with enforcement on, the pilot still refuses a 9-hour shift for a caregiver who is not on hold, and the hold blocks new work for the held caregiver", async () => {
    await expectPgError(mkShift(w.managerA, day(5), "06:00", "15:00", recA2), "OGR30", /daily hour limit/i);
    await expect(mkShift(w.managerA, day(5), "09:00", "10:00", held)).rejects.toThrow();
  });

  it("the real tenant's policy and every other organization are unchanged by all of the above", async () => {
    const rows = await policyRows();
    expect(rows.filter((r) => r.organization_slug === "socal-care-services")).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect((await q("select count(*)::int n from ogevia.organization_readiness_settings where organization_id <> $1 and enforcement_active_from is not null", [w.orgA])).rows[0].n).toBe(0);
  });
});
