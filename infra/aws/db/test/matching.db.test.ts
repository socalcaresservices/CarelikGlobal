// 0043 Explainable matching: eligibility first, then an advisory, versioned, component-by-component score.
// SYNTHETIC data only (including the synthetic ZIP centroids, which are NOT real locations).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, setBaselineAvailability, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let recA1: string;
let recA2: string;
let recA3: string;
let fx: { client: string; service: string; auth: string };
let aba: string;
let dementia: string;
const LA = "America/Los_Angeles";
const MILES_PER_DEGREE_LON_AT_EQUATOR = (3958.8 * 2 * Math.PI) / 360;

const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const dowOf = async (d: string) => (await db.admin.query<{ n: number }>("select extract(dow from $1::date)::int n", [d])).rows[0]!.n;
const recOf = async (a: Actor) => (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id as string;
const iv = (day: string, from: string, to: string, toDay = day) => ({ starts_at: `${day}T${from}:00-07:00`, ends_at: `${toDay}T${to}:00-07:00` });
const allWeek = () => [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_local: "00:00", end_local: "23:59" }));

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  [recA1, recA2, recA3] = [await recOf(w.caregiverA1), await recOf(w.caregiverA2), await recOf(w.caregiverA3)];
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  aba = (await call(w.managerA, "select ogevia_api.create_experience_tag($1,'ABA experience') as id", [w.orgA]))[0].id;
  dementia = (await call(w.managerA, "select ogevia_api.create_experience_tag($1,'Dementia care') as id", [w.orgA]))[0].id;
  for (const a of [w.caregiverA1, w.caregiverA2, w.caregiverA3]) await setBaselineAvailability(db, w.orgA, a, allWeek());
});
afterAll(async () => db?.drop());

const match = (intervals: unknown[], opts: { actor?: Actor; request?: string | null; rule?: string | null; org?: string } = {}) =>
  call(opts.actor ?? w.managerA, "select ogevia_api.match_caregivers($1,$2,$3,$4::jsonb,$5,$6) as r", [opts.org ?? w.orgA, fx.service, fx.client, JSON.stringify(intervals), opts.request ?? null, opts.rule ?? null]).then((r) => r[0].r);
const byCode = (r: any, code: string) => r.candidates.find((c: any) => c.caregiverCode === code);
const component = (cand: any, name: string) => cand.score.components.find((c: any) => c.name === name);

describe("eligibility is separate from the score", () => {
  it("every eligible caregiver is listed (not only the already-assigned one); availability gives them all the same value for one covered shift", async () => {
    const day = await add(3);
    const r = await match([iv(day, "09:00", "11:00")]);
    expect(r).toMatchObject({ ruleVersion: "v0-provisional-50-25-25", ruleStatus: "provisional" });
    const eligible = r.candidates.filter((c: any) => c.eligibility === "eligible").map((c: any) => c.caregiverCode);
    expect(eligible.sort()).toEqual(["CG-A1", "CG-A2", "CG-A3"]); // A1 is assigned to the client; A2 and A3 are not, and are still eligible
    expect(byCode(r, "CG-A1").assignedToClient).toBe(true);
    expect(byCode(r, "CG-A2").assignedToClient).toBe(false);
    for (const code of ["CG-A1", "CG-A2", "CG-A3"]) expect(component(byCode(r, code), "availability")).toMatchObject({ points: 50, status: "scored", reason: "1 of 1 time range covered" });
  });

  it("without availability a caregiver is not eligible, even before enforcement is active ('Not provided' is not available), and whatever else scores well", async () => {
    const day = await add(3);
    await setBaselineAvailability(db, w.orgA, w.caregiverA3, []);
    const r = await match([iv(day, "09:00", "11:00")]);
    const a3 = byCode(r, "CG-A3");
    expect(a3.eligibility).toBe("not_eligible");
    expect(a3.blockedChecks).toEqual([{ check: "availability", status: "blocked", code: "availability_not_provided", message: "Availability not provided.", occurrences: 1 }]);
    // Not-eligible candidates are listed last, never above an eligible one.
    expect(r.candidates.map((c: any) => c.eligibility)).toEqual(["eligible", "eligible", "not_eligible"]);
    await setBaselineAvailability(db, w.orgA, w.caregiverA3, allWeek());
  });

  it("a double-booked caregiver is not eligible; the failed check is named; the score cannot rescue them", async () => {
    const day = await add(4);
    await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5, ($6 || ' 09:00')::timestamp at time zone $7, ($6 || ' 11:00')::timestamp at time zone $7, 'scheduled')`,
      [w.orgA, fx.client, fx.service, w.caregiverA2.userId, recA2, day, LA]);
    const r = await match([iv(day, "10:00", "12:00")]);
    const a2 = byCode(r, "CG-A2");
    expect(a2.eligibility).toBe("not_eligible");
    expect(a2.blockedChecks[0]).toMatchObject({ check: "conflict", message: "Already booked." });
    expect(r.candidates[r.candidates.length - 1].caregiverCode).toBe("CG-A2");
    await db.admin.query("delete from ogevia.shifts where caregiver_record_id = $1 and status = 'scheduled'", [recA2]);
  });

  it("recurring work shows covered/total; a partly covered caregiver is 'partial', ranks below fully covered ones, and the uncovered dates are listed", async () => {
    const d = [await add(7), await add(14), await add(21), await add(28)];
    // A2 is unavailable on the third date only (an approved exception).
    await db.admin.query("insert into ogevia.caregiver_unavailable_dates(organization_id, caregiver_record_id, unavailable_date) values ($1,$2,$3)", [w.orgA, recA2, d[2]]);
    const r = await match(d.map((x) => iv(x, "09:00", "11:00")));
    const a2 = byCode(r, "CG-A2");
    expect(a2.eligibility).toBe("partial");
    expect(a2.coverage).toEqual({ covered: 3, total: 4, uncoveredDates: [d[2]] });
    expect(component(a2, "availability")).toMatchObject({ points: 37.5, reason: "3 of 4 dates covered" });
    expect(r.candidates.map((c: any) => c.eligibility)).toEqual(["eligible", "eligible", "partial"]);
    expect(byCode(r, "CG-A1").coverage).toEqual({ covered: 4, total: 4, uncoveredDates: [] });
    await db.admin.query("delete from ogevia.caregiver_unavailable_dates where caregiver_record_id = $1", [recA2]);
  });
});

describe("missing inputs are never zero and never perfect", () => {
  it("with no distance data every score is incomplete, says why, and the list is not ordered by score", async () => {
    const r = await match([iv(await add(3), "09:00", "11:00")]);
    const a1 = byCode(r, "CG-A1");
    expect(component(a1, "location")).toMatchObject({ status: "missing", points: null, reason: "Distance data is not loaded." });
    expect(component(a1, "experience")).toMatchObject({ status: "not_applicable", points: null }); // the client states no wishes yet
    expect(a1.score).toMatchObject({ complete: false, label: "Score incomplete", total: null });
    expect(r.rankedByScore).toBe(false);
    expect(r.note).toMatch(/not ordered by score/);
    // Deterministic order without a score: assigned to this client first, then code.
    expect(r.candidates.map((c: any) => c.caregiverCode)).toEqual(["CG-A1", "CG-A2", "CG-A3"]);
  });
});

describe("worked scoring: arithmetic with synthetic ZIP centroids and reviewed experience", () => {
  const ZIP = { client: "90001", a1: "90002", a2: "90003", a3: "90004" };
  let miles: Record<string, number>;
  beforeAll(async () => {
    // Synthetic points on the equator: the client at 0.000, A1 at 0 mi, A2 at 12.5 mi, A3 at 40 mi.
    const lon = (mi: number) => (mi / MILES_PER_DEGREE_LON_AT_EQUATOR).toFixed(6);
    miles = { a1: 0, a2: 12.5, a3: 40 };
    for (const [zip, mi] of [[ZIP.client, 0], [ZIP.a1, 0], [ZIP.a2, 12.5], [ZIP.a3, 40]] as const) {
      await db.admin.query("insert into ogevia.zip_centroids(zip, lat, lon, source, licence, vintage) values ($1, 0, $2, 'SYNTHETIC TEST DATA', 'not real data', 'test')", [zip, lon(mi)]);
    }
    await call(w.managerA, "select ogevia_api.set_client_service_zip($1,$2,$3)", [w.orgA, fx.client, ZIP.client]);
    for (const [rec, zip] of [[recA1, ZIP.a1], [recA2, ZIP.a2], [recA3, ZIP.a3]] as const) await call(w.managerA, "select ogevia_api.set_caregiver_zip($1,$2,$3)", [w.orgA, rec, zip]);
    await call(w.managerA, "select ogevia_api.set_client_experience_requirements($1,$2,$3::jsonb,'Family asked for these')", [w.orgA, fx.client, JSON.stringify([{ tagId: aba, mandatory: false }, { tagId: dementia, mandatory: false }])]);
  });

  it("reported tags earn nothing; 'not reviewed' (missing) differs from 'reviewed, no match' (0)", async () => {
    await call(w.caregiverA1, "select ogevia_api.report_my_experience($1,$2::uuid[])", [w.orgA, `{${aba},${dementia}}`]);
    const r = await match([iv(await add(3), "09:00", "11:00")]);
    expect(component(byCode(r, "CG-A1"), "experience")).toMatchObject({ status: "missing", points: null, reason: "Experience has not been reviewed." });
    expect(byCode(r, "CG-A1").score.label).toBe("Score incomplete");
    // The administrator reviews: A1 confirmed both, A2 confirmed one, A3 reviewed with nothing confirmed.
    await call(w.managerA, "select ogevia_api.review_caregiver_experience($1,$2,$3::uuid[],'Checked references')", [w.orgA, recA1, `{${aba},${dementia}}`]);
    await call(w.managerA, "select ogevia_api.review_caregiver_experience($1,$2,$3::uuid[],null)", [w.orgA, recA2, `{${aba}}`]);
    await call(w.managerA, "select ogevia_api.review_caregiver_experience($1,$2,$3::uuid[],null)", [w.orgA, recA3, `{}`]);
  });

  it("scores: availability 50 + location 25 x (1 - miles/25) floored at 0 + experience 25 x confirmed/wanted, as a percentage of 100", async () => {
    const r = await match([iv(await add(3), "09:00", "11:00")]);
    expect(r.rankedByScore).toBe(true);
    const [a1, a2, a3] = ["CG-A1", "CG-A2", "CG-A3"].map((c) => byCode(r, c));
    expect(component(a1, "location")).toMatchObject({ points: 25, reason: "Approx. distance 0 mi" });
    expect(component(a2, "location").points).toBeCloseTo(12.5, 1);
    expect(component(a3, "location")).toMatchObject({ points: 0, reason: "Approx. distance 40 mi" }); // beyond 25 mi: 0 points, still ELIGIBLE (not a travel limit)
    expect(component(a1, "experience")).toMatchObject({ points: 25, reason: "2 of 2 wanted experience tags confirmed." });
    expect(component(a2, "experience")).toMatchObject({ points: 12.5, reason: "1 of 2 wanted experience tags confirmed." });
    expect(component(a3, "experience")).toMatchObject({ points: 0, reason: "Reviewed: no matching experience." });
    expect(a1.score.total).toBe(100);
    expect(a2.score.total).toBeCloseTo(75, 0); // 50 + 12.5 + 12.5
    expect(a3.score.total).toBe(50); // 50 + 0 + 0
    expect(a3.eligibility).toBe("eligible");
    expect(r.candidates.map((c: any) => c.caregiverCode)).toEqual(["CG-A1", "CG-A2", "CG-A3"]);
    expect(a1.score.ruleVersion).toBe("v0-provisional-50-25-25");
  });

  it("ties break the same way every time: assigned to this client, then fewer minutes already scheduled that week, then code", async () => {
    // Make A2 and A3 score identically.
    await call(w.managerA, "select ogevia_api.set_caregiver_zip($1,$2,$3)", [w.orgA, recA3, ZIP.a2]);
    await call(w.managerA, "select ogevia_api.review_caregiver_experience($1,$2,$3::uuid[],null)", [w.orgA, recA3, `{${aba}}`]);
    const day = await add(10);
    await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5, ($6 || ' 06:00')::timestamp at time zone $7, ($6 || ' 07:00')::timestamp at time zone $7, 'scheduled')`,
      [w.orgA, fx.client, fx.service, w.caregiverA2.userId, recA2, day, LA]);
    const orders = new Set<string>();
    for (let i = 0; i < 3; i++) orders.add((await match([iv(day, "13:00", "15:00")])).candidates.map((c: any) => c.caregiverCode).join(","));
    expect([...orders]).toEqual(["CG-A1,CG-A3,CG-A2"]); // A3 and A2 tie on score; A3 has fewer scheduled minutes that week
    await db.admin.query("delete from ogevia.shifts where caregiver_record_id = $1 and status = 'scheduled'", [recA2]);
  });

  it("matching output never contains a ZIP or an address", async () => {
    const r = await match([iv(await add(3), "09:00", "11:00")]);
    const text = JSON.stringify(r);
    for (const z of Object.values(ZIP)) expect(text).not.toContain(z);
  });
});

describe("a mandatory client requirement is a gate, never bonus points", () => {
  it("a caregiver without administrator-confirmed experience is not eligible; reported-only does not count; confirming it makes them eligible", async () => {
    await call(w.managerA, "select ogevia_api.set_client_experience_requirements($1,$2,$3::jsonb,'Medical need')", [w.orgA, fx.client, JSON.stringify([{ tagId: dementia, mandatory: true }])]);
    const day = await add(3);
    let r = await match([iv(day, "09:00", "11:00")]);
    expect(byCode(r, "CG-A1").eligibility).toBe("eligible"); // confirmed dementia care earlier
    for (const c of ["CG-A2", "CG-A3"]) {
      expect(byCode(r, c).eligibility).toBe("not_eligible");
      expect(byCode(r, c).blockedChecks[0]).toMatchObject({ check: "client", message: "Required experience not confirmed: Dementia care." });
    }
    await call(w.caregiverA2, "select ogevia_api.report_my_experience($1,$2::uuid[])", [w.orgA, `{${dementia}}`]);
    r = await match([iv(day, "09:00", "11:00")]);
    expect(byCode(r, "CG-A2").eligibility).toBe("not_eligible"); // a report is not a confirmation
    await call(w.managerA, "select ogevia_api.review_caregiver_experience($1,$2,$3::uuid[],null)", [w.orgA, recA2, `{${dementia}}`]);
    expect(byCode(await match([iv(day, "09:00", "11:00")]), "CG-A2").eligibility).toBe("eligible");
    // The same gate stops a direct shift: a mandatory requirement is enforced at commit time, not only in the list.
    await db.admin.query("delete from ogevia.client_experience_requirements");
  });
});

describe("permissions, tenancy and the care-request list", () => {
  it("matching is staff-only; caregivers and other agencies are refused; ZIP and experience administration is manager/owner only", async () => {
    const day = await add(3);
    await expectPgError(match([iv(day, "09:00", "11:00")], { actor: w.caregiverA1 }), "OGA03");
    await expectPgError(match([iv(day, "09:00", "11:00")], { actor: w.managerB }), "OGN04");
    await expectPgError(match([iv(day, "09:00", "11:00")], { rule: "v9-unknown" }), "OGV22");
    await expectPgError(match([]), "OGV22");
    await expectPgError(call(w.caregiverA1, "select ogevia_api.set_caregiver_zip($1,$2,'90210')", [w.orgA, recA1]), "OGA03");
    await expectPgError(call(w.schedulerA, "select ogevia_api.create_experience_tag($1,'Anything')", [w.orgA]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.review_caregiver_experience($1,$2,'{}'::uuid[],null)", [w.orgA, recA1]), "OGN04");
    await expectPgError(call(w.managerA, "select ogevia_api.set_caregiver_zip($1,$2,'9021')", [w.orgA, recA1]), "OGV22");
    // A caregiver sees only their own experience record.
    expect((await call(w.caregiverA1, "select ogevia_api.get_caregiver_experience($1,null) as r", [w.orgA]))[0].r.caregiverRecordId).toBe(recA1);
    await expectPgError(call(w.caregiverA1, "select ogevia_api.get_caregiver_experience($1,$2)", [w.orgA, recA2]), "OGA03");
    await expectPgError(call(w.caregiverB1, "select ogevia_api.list_experience_tags($1)", [w.orgA]), "OGN04");
    // Distance data status shows provenance and counts, never a ZIP.
    const st = (await call(w.managerA, "select ogevia_api.location_data_status($1) as s", [w.orgA]))[0].s;
    expect(st).toMatchObject({ distanceDataLoaded: true, caregiversWithZip: 3, clientsWithZip: 1 });
    expect(JSON.stringify(st)).not.toMatch(/9000\d/);
  });

  it("the care-request list now offers only ELIGIBLE caregivers, and still drops those who declined", async () => {
    const day = await add(5);
    const mk = async () => (await db.admin.query<{ id: string }>(
      `insert into ogevia.care_requests(organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at, requested_minutes, request_key, status)
       values ($1,$2,$3,$4, ($5 || ' 09:00')::timestamp at time zone $6, ($5 || ' 12:30')::timestamp at time zone $6, 210, gen_random_uuid(), 'requested') returning id`,
      [w.orgA, fx.client, fx.service, fx.auth, day, LA])).rows[0]!.id;
    const req = await mk();
    await setBaselineAvailability(db, w.orgA, w.caregiverA3, []);
    const list = () => call(w.managerA, "select * from ogevia_api.list_available_caregivers($1,$2)", [w.orgA, req]);
    expect((await list()).map((x) => x.caregiver_name.split(" ").pop()).sort()).toEqual(["CG-A1", "CG-A2"]);
    expect((await list())[0].current_client_match).toBe(true);
    await db.admin.query("insert into ogevia.care_request_offers(organization_id, care_request_id, caregiver_record_id, token_hash, status) values ($1,$2,$3,$4,'not_available')", [w.orgA, req, recA2, "d".repeat(64)]);
    expect((await list()).map((x) => x.caregiver_name.split(" ").pop())).toEqual(["CG-A1"]);
    await expectPgError(call(w.caregiverA1, "select * from ogevia_api.list_available_caregivers($1,$2)", [w.orgA, req]).then((r) => { if (r.length === 0) throw Object.assign(new Error("none"), { code: "OGA03" }); }), "OGA03");
  });
});

it("suggests only an unambiguous city from the active agency and guards access", async () => {
  const zip = "01234";
  const suggest = () => call(w.managerA, "select ogevia_api.suggest_matching_city($1,$2) as city", [w.orgA, zip]);
  expect((await suggest())[0].city).toBeNull();
  await call(w.managerA, "select ogevia_api.set_caregiver_zip($1,$2,$3,$4)", [w.orgA, recA1, zip, "Example City"]);
  expect((await suggest())[0].city).toBe("Example City");
  await call(w.managerA, "select ogevia_api.set_client_service_zip($1,$2,$3,$4)", [w.orgA, fx.client, zip, "Different City"]);
  expect((await suggest())[0].city).toBeNull();
  await expectPgError(call(w.caregiverA1, "select ogevia_api.suggest_matching_city($1,$2)", [w.orgA, zip]), "OGA03");
  await expectPgError(call(w.managerA, "select ogevia_api.suggest_matching_city($1,$2)", [w.orgA, "1234"]), "OGV22");
});
