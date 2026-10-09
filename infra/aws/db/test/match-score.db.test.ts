// 0041 Explainable matching. SYNTHETIC data only (made-up ZIP centroids on a meridian, so distances are exact).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveAvailability, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let fresh: { client: string; service: string; auth: string };
const rec: Record<string, string> = {};
const tag: Record<string, string> = {};
let target: { starts: string; ends: string; date: string };

const MILES_PER_DEGREE = (3958.8 * Math.PI) / 180; // straight north-south, same formula as the database
const zipAt = (zip: string, miles: number) =>
  db.admin.query("insert into ogevia.zip_centroids(zip, lat, lng, source, vintage) values ($1, $2, -118, 'SYNTHETIC test table', 'test') on conflict do nothing", [zip, (34 + miles / MILES_PER_DEGREE).toFixed(5)]);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  fresh = await freshClient(db, w, w.caregiverA1, 40000, w.orgA, { before: 40, after: 200 });
  for (const [code, first] of [["CG-A4", "Dana"], ["CG-A5", "Evan"]] as const) {
    await db.admin.query("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1,$2,$3,'Synthetic','active')", [w.orgA, code, first]);
  }
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
  const d = new Date(Date.parse(`${today}T12:00:00Z`) + 10 * 864e5).toISOString().slice(0, 10);
  target = { date: d, starts: `${d}T17:00:00Z`, ends: `${d}T19:00:00Z` }; // 09:00-11:00 or 10:00-12:00 Pacific depending on DST; fixed below
  const t = (await db.admin.query("select (($1::date + time '10:00') at time zone 'America/Los_Angeles')::text s, (($1::date + time '12:00') at time zone 'America/Los_Angeles')::text e", [d])).rows[0];
  target = { date: d, starts: new Date(t.s).toISOString(), ends: new Date(t.e).toISOString() };
});
afterAll(async () => db?.drop());

const q = async <T = any>(a: Actor, sql: string, params: unknown[] = []) =>
  asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const win = (weekday: number, start: string, end: string) => ({ weekday, specific_date: null, start_local: start, end_local: end });
const ACT: Record<string, Actor> = {};
const match = async (occ = [{ starts_at: target.starts, ends_at: target.ends }], a: Actor = w.managerA, client = fresh.client, service = fresh.service) =>
  (await q(a, "select ogevia_api.list_match_candidates($1,$2,$3,$4::jsonb,null) as r", [w.orgA, client, service, JSON.stringify(occ)]))[0]!.r as any;
const by = (r: any, code: string) => r.candidates.find((c: any) => c.caregiver_code === code);
const comp = (c: any, key: string) => c.components.find((x: any) => x.key === key);

// Independent reference for the formula (not the database's code).
function reference(A: number, L: number | null, E: number | null) {
  const base = { a: 0.5, l: L === null ? 0 : 0.25, e: E === null ? 0 : 0.25 };
  const sum = base.a + base.l + base.e;
  return Math.round(100 * ((base.a / sum) * A + (base.l / sum) * (L ?? 0) + (base.e / sum) * (E ?? 0)));
}

describe("setup: tags, locations, approvals, availability (all through the production paths)", () => {
  it("builds a small, fully synthetic world", async () => {
    ACT["CG-A1"] = w.caregiverA1; ACT["CG-A2"] = w.caregiverA2; ACT["CG-A3"] = w.caregiverA3;
    for (const name of ["Behaviour support", "Communication support", "ABA-related experience"]) {
      tag[name] = (await q(w.managerA, "select ogevia_api.create_experience_tag($1,$2) as id", [w.orgA, name]))[0]!.id;
    }
    await expectPgError(q(w.managerA, "select ogevia_api.create_experience_tag($1,' behaviour support ')", [w.orgA]), "OGC09");
    await expectPgError(q(w.caregiverA1, "select ogevia_api.create_experience_tag($1,'Mine')", [w.orgA]), "OGA03");
    // client zip at (34, -118); caregivers at 3, 9, 20, 20 and unknown miles
    await zipAt("90001", 0); await zipAt("90003", 3); await zipAt("90009", 9); await zipAt("90020", 20);
    await q(w.managerA, "select ogevia_api.set_client_location($1,$2,'90001')", [w.orgA, fresh.client]);
    const loc: Record<string, string> = { "CG-A1": "90003", "CG-A2": "90009", "CG-A3": "90020", "CG-A4": "90020" };
    for (const [code, zip] of Object.entries(loc)) await q(w.managerA, "select ogevia_api.set_caregiver_location($1,$2,$3,null)", [w.orgA, rec[code], zip]);
    // service checks on, every caregiver approved for the service
    await q(w.ownerA, "select ogevia_api.set_readiness_settings($1,true,false,30,'Service checks on for the match tests')", [w.orgA]);
    for (const code of ["CG-A1", "CG-A2", "CG-A3", "CG-A4", "CG-A5"]) {
      await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,null,'Approved for the match tests',null)", [w.orgA, rec[code], fresh.service, day(-30)]);
    }
    // approved availability on the target weekday for everyone except A5 (never provided)
    for (const code of ["CG-A1", "CG-A2", "CG-A3"]) await approveAvailability(db, w, ACT[code]!, [win(dow(target.date), "08:00", "18:00")]);
    for (const code of ["CG-A4"]) {
      await q(w.managerA, "select ogevia_api.set_caregiver_availability($1,$2,$3::jsonb,'[]'::jsonb,'Phone confirmation',0)", [w.orgA, rec[code], JSON.stringify([win(dow(target.date), "08:00", "18:00")])]);
    }
  });
});

describe("eligibility first, score second", () => {
  it("with no optional tags the experience component is not applicable and the weights are redistributed and shown", async () => {
    const r = await match();
    const c1 = by(r, "CG-A1");
    expect(c1.eligibility).toBe("eligible");
    const e = comp(c1, "experience");
    expect(e.status).toBe("not_applicable");
    expect(comp(c1, "availability").weight).toBeCloseTo(2 / 3, 3);
    expect(comp(c1, "location").weight).toBeCloseTo(1 / 3, 3);
    expect(c1.score).toBe(93); // 100 x (2/3 x 1 + 1/3 x 0.8)
    expect(by(r, "CG-A2").score).toBe(80); // d = 9, L = 0.4
    expect(by(r, "CG-A3").score).toBe(67); // d = 20 clamps to 0: 100 x 2/3
    expect(c1.score_status).toBe("complete");
    expect(r.version).toBe("match-v1");
  });

  it("score arithmetic with optional tags: worked examples, verified experience only, and an independent reference agrees", async () => {
    await q(w.managerA, "select ogevia_api.set_client_support_preference($1,$2,$3,3,false,'Family asked for behaviour support')", [w.orgA, fresh.client, tag["Behaviour support"]]);
    await q(w.managerA, "select ogevia_api.set_client_support_preference($1,$2,$3,2,false,'Family asked for communication support')", [w.orgA, fresh.client, tag["Communication support"]]);
    // A1 holds both (verified), A2 holds Behaviour support (3 of 5), A3 holds nothing and is marked reviewed
    const submit = (a: Actor, record: string, t: string) => q(a, "select ogevia_api.record_experience($1,$2,$3,'Worked with a client who needed it',false) as id", [w.orgA, record, t]).then((x) => x[0]!.id as string);
    const e1 = await submit(w.caregiverA1, rec["CG-A1"]!, tag["Behaviour support"]!);
    const e2 = await submit(w.caregiverA1, rec["CG-A1"]!, tag["Communication support"]!);
    const e3 = await submit(w.caregiverA2, rec["CG-A2"]!, tag["Behaviour support"]!);
    // submitted is NOT verified: nothing counts yet, and with experience unreviewed the component is unknown
    let r = await match();
    expect(comp(by(r, "CG-A1"), "experience").status).toBe("unknown");
    expect(by(r, "CG-A1").score).toBeNull();
    expect(by(r, "CG-A1").score_status).toBe("incomplete");
    // a caregiver cannot verify their own; an administrator does
    await expectPgError(q(w.caregiverA1, "select ogevia_api.review_experience($1,'verify',null)", [e1]), "OGA03");
    for (const id of [e1, e2, e3]) await q(w.managerA, "select ogevia_api.review_experience($1,'verify',null)", [id]);
    await q(w.managerA, "select ogevia_api.mark_experience_reviewed($1,$2)", [w.orgA, rec["CG-A3"]]);
    // A2 holds 3 of the 5 requested points of experience; until an administrator marks the rest reviewed, the rest is "not recorded"
    expect(comp(by(await match(), "CG-A2"), "experience").status).toBe("unknown");
    await q(w.managerA, "select ogevia_api.mark_experience_reviewed($1,$2)", [w.orgA, rec["CG-A2"]]);
    r = await match();
    const [c1, c2, c3] = [by(r, "CG-A1"), by(r, "CG-A2"), by(r, "CG-A3")];
    expect(comp(c1, "experience")).toMatchObject({ status: "known" });
    expect(comp(c1, "experience").value).toBe(1);
    expect(c1.score).toBe(95); // 100 x (.50 + .25 x .8 + .25 x 1)
    expect(c2.score).toBe(75); // 100 x (.50 + .25 x .4 + .25 x .6), d = 9
    expect(c3.score).toBe(50); // reviewed, none held: E = 0, d = 20 -> L = 0
    expect(c3.score_status).toBe("complete");
    for (const c of [c1, c2, c3]) {
      expect(c.score).toBe(reference(comp(c, "availability").value, comp(c, "location").value, comp(c, "experience").value));
      const weights = c.components.reduce((s: number, x: any) => s + x.weight, 0);
      expect(weights).toBeCloseTo(1, 3);
      expect(c.components.every((x: any) => x.status !== "known" || typeof x.points === "number")).toBe(true);
    }
    expect(r.candidates.map((c: any) => c.caregiver_code).slice(0, 3)).toEqual(["CG-A1", "CG-A2", "CG-A3"].filter((c) => by(r, c).eligibility === "eligible"));
  });

  it("not recorded is not 'no experience': an unreviewed caregiver with unmatched tags is incomplete, not zero", async () => {
    const r = await match();
    const c4 = by(r, "CG-A4"); // same location as A3 but nobody has reviewed their experience
    expect(comp(c4, "experience")).toMatchObject({ status: "unknown", points: null });
    expect(c4.score).toBeNull();
    expect(c4.score_status).toBe("incomplete");
    // the known components are still shown, with their points
    expect(comp(c4, "availability").points).toBeGreaterThan(0);
    expect(c4.eligibility).toBe("eligible"); // incomplete is a score state, not an eligibility failure
  });

  it("unknown location makes the score incomplete; turning location off makes it not applicable with weights redistributed; the radius is configurable", async () => {
    let r = await match();
    const c5 = by(r, "CG-A5"); // no location recorded and never provided availability
    expect(comp(c5, "location")).toMatchObject({ status: "unknown" });
    expect(comp(c5, "location").detail.caregiver_location).toBe("not recorded");
    expect(c5.score_status).toBe("incomplete");
    // zip recorded but no coordinates in the reference table -> unknown, labelled
    await q(w.managerA, "select ogevia_api.set_caregiver_location($1,$2,'99999',null)", [w.orgA, rec["CG-A5"]]);
    r = await match();
    expect(comp(by(r, "CG-A5"), "location").detail.coordinates).toBe("not available for this ZIP");
    try {
      // radius 25: A2 (9 miles, E=.6) -> L = .64: 100 x (.5 + .25 x .64 + .25 x .6) = 81
      await expectPgError(q(w.managerA, "select ogevia_api.set_match_settings($1,25,true,'Longer radius')", [w.orgA]), "OGA03");
      await expectPgError(q(w.ownerA, "select ogevia_api.set_match_settings($1,0,true,'Zero radius')", [w.orgA]), "OGV22");
      await q(w.ownerA, "select ogevia_api.set_match_settings($1,25,true,'Try a 25 mile reference radius')", [w.orgA]);
      expect(by(await match(), "CG-A2").score).toBe(81);
      // location off: A and E only -> weights 2/3 and 1/3: A2 = 100 x (2/3 + 1/3 x .6) = 87
      await q(w.ownerA, "select ogevia_api.set_match_settings($1,15,false,'Location data is not loaded yet')", [w.orgA]);
      r = await match();
      expect(comp(by(r, "CG-A2"), "location").status).toBe("not_applicable");
      expect(by(r, "CG-A2").score).toBe(87);
      expect(by(r, "CG-A5").score_status).toBe("incomplete"); // A5 still has unreviewed experience
    } finally {
      await q(w.ownerA, "select ogevia_api.set_match_settings($1,15,true,'Back to the defaults')", [w.orgA]);
    }
  });

  it("ties are ordered by a documented rule, never at random", async () => {
    // A3 and A4 sit at the same distance; mark A4's experience reviewed so both are complete and equal
    await q(w.managerA, "select ogevia_api.mark_experience_reviewed($1,$2)", [w.orgA, rec["CG-A4"]]);
    const codes = [] as string[][];
    for (let i = 0; i < 4; i++) codes.push((await match()).candidates.map((c: any) => c.caregiver_code));
    expect(new Set(codes.map((c) => c.join(","))).size).toBe(1);
    const r = await match();
    expect(by(r, "CG-A3").score).toBe(by(r, "CG-A4").score);
    expect(r.candidates.findIndex((c: any) => c.caregiver_code === "CG-A3")).toBeLessThan(r.candidates.findIndex((c: any) => c.caregiver_code === "CG-A4"));
  });
});

describe("a score never bypasses a failed requirement", () => {
  it("a wrong, expired or revoked service approval keeps a high score out of the eligible group", async () => {
    const apr = (await db.admin.query("select id from ogevia.caregiver_service_approvals where caregiver_record_id = $1 and revoked_at is null", [rec["CG-A1"]])).rows[0].id;
    await q(w.managerA, "select ogevia_api.revoke_caregiver_service_approval($1,'Under review',null)", [apr]);
    const c1 = by(await match(), "CG-A1");
    expect(c1.eligibility).toBe("not_eligible");
    expect(c1.score).toBe(95); // the score is still computed and shown, but is not what decides
    expect(c1.reasons.map((x: any) => x.label)).toContain("Service not approved");
    // and the assignment gate refuses it however it is reached
    await expectPgError(q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00','12:00',$5,null)", [w.orgA, fresh.client, fresh.service, target.date, rec["CG-A1"]]), "OGV22", /Service not approved/);
    // approval for a different service does not help
    const other = (await db.admin.query("insert into ogevia.services (organization_id, code, name) values ($1,'XTR','Other service') returning id", [w.orgA])).rows[0].id;
    await db.admin.query(
      "insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end) values ($1,$2,$3,'SYNTHETIC-PAYER',30000,$4::date - 40,$4::date + 200)", [w.orgA, fresh.client, other, today]);
    await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,null,'Approved for the other service',null)", [w.orgA, rec["CG-A1"], other, day(-30)]);
    expect(by(await match(undefined, w.managerA, fresh.client, other), "CG-A1").eligibility).toBe("eligible");
    expect(by(await match(), "CG-A1").eligibility).toBe("not_eligible");
    // restore
    await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,null,'Re-approved after review',null)", [w.orgA, rec["CG-A1"], fresh.service, day(-30)]);
    expect(by(await match(), "CG-A1").eligibility).toBe("eligible");
  });

  it("revocation between listing the candidates and assigning refuses the assignment", async () => {
    const listed = by(await match(), "CG-A2");
    expect(listed.eligibility).toBe("eligible");
    const apr = (await db.admin.query("select id from ogevia.caregiver_service_approvals where caregiver_record_id = $1 and service_id = $2 and revoked_at is null", [rec["CG-A2"], fresh.service])).rows[0].id;
    await q(w.managerA, "select ogevia_api.revoke_caregiver_service_approval($1,'Revoked after the list was shown',null)", [apr]);
    await expectPgError(q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00','12:00',$5,null)", [w.orgA, fresh.client, fresh.service, target.date, rec["CG-A2"]]), "OGV22", /Service not approved/);
    await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,null,'Re-approved',null)", [w.orgA, rec["CG-A2"], fresh.service, day(-30)]);
  });

  it("a mandatory client requirement is a hard check; an optional preference never is; ABA-related experience is optional unless an administrator says otherwise", async () => {
    // optional ABA preference: caregivers without it are still eligible
    await q(w.managerA, "select ogevia_api.set_client_support_preference($1,$2,$3,1,false,'Optional preference')", [w.orgA, fresh.client, tag["ABA-related experience"]]);
    let r = await match();
    expect(by(r, "CG-A1").eligibility).toBe("eligible");
    expect(comp(by(r, "CG-A1"), "experience").detail.requested_tags).toBe(3);
    // verified ABA-related experience raises the fit but is described only as experience
    const e = (await q(w.managerA, "select ogevia_api.record_experience($1,$2,$3,'Assisted an ABA-supervised program',true) as id", [w.orgA, rec["CG-A2"], tag["ABA-related experience"]]))[0]!.id;
    r = await match();
    expect(comp(by(r, "CG-A2"), "experience").detail.verified_matches).toBe(2);
    // an administrator marks it mandatory: now it is a requirement, not a preference
    await q(w.managerA, "select ogevia_api.set_client_support_preference($1,$2,$3,1,true,'Plan requires this experience')", [w.orgA, fresh.client, tag["ABA-related experience"]]);
    r = await match();
    expect(by(r, "CG-A2").eligibility).toBe("eligible");
    const c1 = by(r, "CG-A1");
    expect(c1.eligibility).toBe("not_eligible");
    expect(c1.reasons.map((x: any) => x.label)).toContain("ABA-related experience required");
    expect(comp(c1, "experience").detail.requested_tags).toBe(2); // a mandatory tag is not double counted in the score
    await expectPgError(q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00','12:00',$5,null)", [w.orgA, fresh.client, fresh.service, target.date, rec["CG-A1"]]), "OGV22", /ABA-related experience required/);
    // remove the requirement again so the later tests start from the same place
    const pref = (await q(w.managerA, "select * from ogevia_api.list_client_support_preferences($1,$2)", [w.orgA, fresh.client])).find((p: any) => p.tag_id === tag["ABA-related experience"]);
    await q(w.managerA, "select ogevia_api.remove_client_support_preference($1,'Requirement lifted')", [pref.preference_id]);
    expect(by(await match(), "CG-A1").eligibility).toBe("eligible");
    void e;
  });

  it("the stated travel limit is enforced separately and only when the distance is known", async () => {
    await q(w.managerA, "select ogevia_api.set_caregiver_location($1,$2,'90009',5)", [w.orgA, rec["CG-A2"]]); // 9 miles away, limit 5
    const c2 = by(await match(), "CG-A2");
    expect(c2.eligibility).toBe("not_eligible");
    expect(c2.travel_limit_exceeded).toBe(true);
    await q(w.managerA, "select ogevia_api.set_caregiver_location($1,$2,'99999',5)", [w.orgA, rec["CG-A5"]]); // unknown coordinates: not blocked
    expect(by(await match(), "CG-A5").travel_limit_exceeded).toBe(false);
    await q(w.managerA, "select ogevia_api.set_caregiver_location($1,$2,'90009',null)", [w.orgA, rec["CG-A2"]]);
  });
});

describe("availability is a gate with a separate 'needs override' group", () => {
  it("a caregiver who never provided availability is 'needs override' with the plain reason; a partial cover shows its fraction", async () => {
    const r = await match();
    const c5 = by(r, "CG-A5");
    expect(c5.eligibility).toBe("needs_override");
    expect(c5.reasons.map((x: any) => x.label)).toContain("Availability not provided");
    expect(comp(c5, "availability").value).toBe(0);
    // A3 loses the second hour: approved window 08:00-11:00 against a 10:00-12:00 request -> half covered
    await q(w.managerA, "select ogevia_api.set_caregiver_availability($1,$2,$3::jsonb,null,'Shorter day this month',$4)", [w.orgA, rec["CG-A3"], JSON.stringify([win(dow(target.date), "08:00", "11:00")]), (await q(w.managerA, "select ogevia_api.get_caregiver_availability($1,$2) as s", [w.orgA, rec["CG-A3"]]))[0]!.s.version]);
    const c3 = by(await match(), "CG-A3");
    expect(c3.eligibility).toBe("needs_override");
    expect(c3.reasons.map((x: any) => x.label)).toContain("Outside availability");
    expect(comp(c3, "availability").value).toBe(0.5);
    // groups are separate and ordered: eligible first, then needs override, then not eligible
    const order = (await match()).candidates.map((c: any) => c.eligibility);
    expect(order).toEqual([...order].sort((a: string, b: string) => ["eligible", "partial", "needs_override", "not_eligible"].indexOf(a) - ["eligible", "partial", "needs_override", "not_eligible"].indexOf(b)));
    // the exception exists only for the authorised administrator, with a reason
    const viaOverride = (a: Actor, reason: string) => asActor(db, a.sub, async (c) => {
      await c.query("select ogevia_api.begin_availability_override($1,$2)", [w.orgA, reason]);
      return (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00','12:00',$5,null)", [w.orgA, fresh.client, fresh.service, target.date, rec["CG-A3"]])).rows[0];
    });
    // availability is only required for shifts when the agency switch is on
    await q(w.ownerA, "select ogevia_api.set_readiness_settings($1,true,true,30,'Availability required for the override test')", [w.orgA]);
    await expectPgError(q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00','12:00',$5,null)", [w.orgA, fresh.client, fresh.service, target.date, rec["CG-A3"]]), "OGV22", /Needs override/);
    await expectPgError(viaOverride(w.caregiverA2, "I would like this one"), "OGA03");
    expect((await viaOverride(w.managerA, "Family prefers this caregiver")).shift_id).toBeTruthy();
    await q(w.ownerA, "select ogevia_api.set_readiness_settings($1,true,false,30,'Back to service checks only')", [w.orgA]);
  });

  it("recurring work shows coverage separately: covered occurrences are listed, uncovered ones are never assigned", async () => {
    const dates = [10, 17, 24, 31].map((n) => day(n));
    const occ = await Promise.all(dates.map(async (d) => {
      const t = (await db.admin.query("select (($1::date + time '10:00') at time zone 'America/Los_Angeles')::text s, (($1::date + time '12:00') at time zone 'America/Los_Angeles')::text e", [d])).rows[0];
      return { starts_at: new Date(t.s).toISOString(), ends_at: new Date(t.e).toISOString() };
    }));
    // A1: approved availability only covers the first three occurrences (a date exception removes the fourth)
    await q(w.managerA, "select ogevia_api.set_caregiver_availability($1,$2,$3::jsonb,$4::jsonb,'Away on the last date',$5)", [w.orgA, rec["CG-A1"], JSON.stringify([win(dow(dates[0]!), "08:00", "18:00")]), JSON.stringify([dates[3]]),
      (await q(w.managerA, "select ogevia_api.get_caregiver_availability($1,$2) as s", [w.orgA, rec["CG-A1"]]))[0]!.s.version]);
    const r = await match(occ);
    const c1 = by(r, "CG-A1");
    expect(c1.eligibility).toBe("needs_override"); // no hard failure, but one occurrence is outside availability
    expect(c1.cover.occurrences).toBe(4);
    expect(c1.cover.ready).toBe(3);
    const ms = (x: string) => new Date(x).getTime();
    expect(c1.cover.covered.map((x: any) => ms(x.starts_at))).toEqual(occ.slice(0, 3).map((x) => ms(x.starts_at)));
    expect(c1.cover.not_covered).toHaveLength(1);
    expect(ms(c1.cover.not_covered[0].starts_at)).toBe(ms(occ[3]!.starts_at));
    expect(comp(c1, "availability").value).toBe(0.75);
    expect(comp(c1, "availability").detail).toMatchObject({ covered_minutes: 360, requested_minutes: 480 });
    // a hard failure on one occurrence (a conflicting shift) makes the cover partial, listing exactly what is assignable
    await db.admin.query("insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status) values ($1,$2,$3,$4,$5,$6,$7,'scheduled')",
      [w.orgA, fresh.client, fresh.service, w.caregiverA1.userId, rec["CG-A1"], occ[1]!.starts_at, occ[1]!.ends_at]);
    const r2 = await match(occ);
    const c1b = by(r2, "CG-A1");
    expect(c1b.eligibility).toBe("partial");
    expect(c1b.cover.covered.map((x: any) => ms(x.starts_at))).toEqual([ms(occ[0]!.starts_at), ms(occ[2]!.starts_at)]);
    expect(c1b.cover.not_covered.map((x: any) => x.status)).toEqual(["blocked", "needs_override"]);
  });
});

describe("overnight and daylight-saving cases", () => {
  it("an overnight shift is covered by an overnight window, and by two adjacent windows", async () => {
    const sat = "2026-10-31"; // a Saturday; the agency leaves daylight time on 2026-11-01
    const night = [{ starts_at: new Date((await db.admin.query("select (($1::date + time '23:00') at time zone 'America/Los_Angeles')::text s", [sat])).rows[0].s).toISOString(),
                    ends_at: new Date((await db.admin.query("select ((($1::date + 1) + time '05:00') at time zone 'America/Los_Angeles')::text s", [sat])).rows[0].s).toISOString() }];
    // a one-window overnight availability: Saturday 22:00 to 06:00
    await q(w.managerA, "select ogevia_api.set_caregiver_availability($1,$2,$3::jsonb,'[]'::jsonb,'Night shifts only',$4)", [w.orgA, rec["CG-A2"], JSON.stringify([win(6, "22:00", "06:00")]),
      (await q(w.managerA, "select ogevia_api.get_caregiver_availability($1,$2) as s", [w.orgA, rec["CG-A2"]]))[0]!.s.version]);
    const c = by(await match(night), "CG-A2");
    expect(comp(c, "availability").value).toBe(1);
    // the real length of that night is 7 hours (the extra hour when clocks go back); it is measured in instants
    expect(comp(c, "availability").detail.requested_minutes).toBe(7 * 60);
  });
});

describe("the decision record", () => {
  it("is computed on the server, versioned, and holds ids and numbers only; nobody can inject a score", async () => {
    const occ = [{ starts_at: target.starts, ends_at: target.ends }];
    const ref = "11111111-2222-4333-8444-555555555555";
    const id = (await q(w.managerA, "select ogevia_api.record_assignment_decision($1,$2,$3,$4,$5::jsonb,'shift',$6,'Closest verified match','') as id",
      [w.orgA, rec["CG-A2"], fresh.client, fresh.service, JSON.stringify(occ), ref]).catch(async () =>
      (await q(w.managerA, "select ogevia_api.record_assignment_decision($1,$2,$3,$4,$5::jsonb,'shift',$6,'Closest verified match',null) as id",
      [w.orgA, rec["CG-A2"], fresh.client, fresh.service, JSON.stringify(occ), ref]))))[0]!.id;
    const row = (await db.admin.query("select * from ogevia.assignment_decisions where id = $1", [id])).rows[0];
    expect(row).toMatchObject({ decided_by: w.managerA.userId, score_version: "match-v1", context: "shift", rationale: "Closest verified match" });
    expect(row.score).toBe(by(await match(), "CG-A2").score);
    const text = JSON.stringify(row);
    expect(text).not.toMatch(/9000|ZIP|zip/);
    expect(Object.keys(row.input_refs)).toEqual(expect.arrayContaining(["availability_version", "reference_radius_miles", "service_checks"]));
    const listed = await q(w.managerA, "select * from ogevia_api.list_assignment_decisions($1,$2)", [w.orgA, ref]);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.caregiver_code).toBe("CG-A2");
    await expect(db.admin.query("update ogevia.assignment_decisions set score = 100 where id = $1", [id])).rejects.toThrow();
    await expectPgError(q(w.caregiverA1, "select ogevia_api.record_assignment_decision($1,$2,$3,$4,$5::jsonb,'shift',$6,null,null)", [w.orgA, rec["CG-A2"], fresh.client, fresh.service, JSON.stringify(occ), ref]), "OGA03");
    await expectPgError(q(w.managerB, "select ogevia_api.record_assignment_decision($1,$2,$3,$4,$5::jsonb,'shift',$6,null,null)", [w.orgA, rec["CG-A2"], fresh.client, fresh.service, JSON.stringify(occ), ref]), "OGN04");
    await expectPgError(q(w.managerA, "select ogevia_api.record_assignment_decision($1,$2,$3,$4,$5::jsonb,'nonsense',$6,null,null)", [w.orgA, rec["CG-A2"], fresh.client, fresh.service, JSON.stringify(occ), ref]), "OGV22");
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where action = 'assignment.decision_recorded' and entity_id = $1", [id])).rows[0].n).toBe(1);
  });
});

describe("access, privacy and isolation", () => {
  it("only schedulers and managers see matches; caregivers and other agencies are refused; the output holds no ZIP code or address", async () => {
    const occ = JSON.stringify([{ starts_at: target.starts, ends_at: target.ends }]);
    await expectPgError(q(w.caregiverA1, "select ogevia_api.list_match_candidates($1,$2,$3,$4::jsonb,null)", [w.orgA, fresh.client, fresh.service, occ]), "OGA03");
    await expectPgError(q(w.managerB, "select ogevia_api.list_match_candidates($1,$2,$3,$4::jsonb,null)", [w.orgA, fresh.client, fresh.service, occ]), "OGN04");
    await expectPgError(q(w.managerA, "select ogevia_api.list_match_candidates($1,$2,$3,$4::jsonb,null)", [w.orgA, w.clientB1, fresh.service, occ]), "OGN04");
    await expectPgError(q(w.managerA, "select ogevia_api.list_match_candidates($1,$2,$3,'[]'::jsonb,null)", [w.orgA, fresh.client, fresh.service]), "OGV22");
    await expectPgError(q(w.managerA, "select ogevia_api.list_match_candidates($1,$2,$3,$4::jsonb,null)", [w.orgA, fresh.client, fresh.service, JSON.stringify([{ starts_at: target.ends, ends_at: target.starts }])]), "OGV22");
    const sched = await q(w.schedulerA, "select ogevia_api.list_match_candidates($1,$2,$3,$4::jsonb,null) as r", [w.orgA, fresh.client, fresh.service, occ]);
    expect(JSON.stringify(sched[0]!.r)).not.toMatch(/"zip"|9000[0-9]|9002[0-9]|street/i);
    // stored locations are readable only by the administrators who maintain them
    await expectPgError(q(w.schedulerA, "select * from ogevia_api.get_caregiver_location($1,$2)", [w.orgA, rec["CG-A1"]]), "OGA03");
    await expectPgError(q(w.caregiverA1, "select * from ogevia_api.get_caregiver_location($1,$2)", [w.orgA, rec["CG-A1"]]), "OGA03");
    await expectPgError(q(w.schedulerA, "select * from ogevia_api.get_client_location($1,$2)", [w.orgA, fresh.client]), "OGA03");
    expect((await q(w.managerA, "select * from ogevia_api.get_caregiver_location($1,$2)", [w.orgA, rec["CG-A1"]]))[0]).toMatchObject({ zip: "90003", coordinates_known: true });
    // ZIP must be five digits; locations and tags of another agency cannot be touched
    await expectPgError(q(w.managerA, "select ogevia_api.set_client_location($1,$2,'9000')", [w.orgA, fresh.client]), "OGV22");
    await expectPgError(q(w.managerB, "select ogevia_api.set_client_location($1,$2,'90001')", [w.orgA, fresh.client]), "OGN04");
    await expectPgError(q(w.managerA, "select ogevia_api.set_client_support_preference($1,$2,$3,1,false,'Cross agency')", [w.orgA, w.clientB1, tag["Behaviour support"]]), "OGN04");
    // the audit trail records that a location changed, not the ZIP
    const a = (await db.admin.query("select after_state from ogevia.audit_events where action = 'client_location.set' order by id desc limit 1")).rows[0];
    expect(a.after_state).toEqual({ changed: true });
  });

  it("caregivers see their own experience only; verification, declines and removals keep the history and need a note", async () => {
    const mine = await q(w.caregiverA1, "select * from ogevia_api.list_caregiver_experience($1,$2)", [w.orgA, rec["CG-A1"]]);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    await expectPgError(q(w.caregiverA1, "select * from ogevia_api.list_caregiver_experience($1,$2)", [w.orgA, rec["CG-A2"]]), "OGA03");
    await expectPgError(q(w.caregiverA1, "select ogevia_api.record_experience($1,$2,$3,null,false)", [w.orgA, rec["CG-A2"], tag["Behaviour support"]]), "OGA03");
    await expectPgError(q(w.caregiverA1, "select ogevia_api.record_experience($1,$2,$3,null,true)", [w.orgA, rec["CG-A1"], tag["ABA-related experience"]]), "OGA03"); // cannot self-verify
    const id = (await q(w.caregiverA1, "select ogevia_api.record_experience($1,$2,$3,'Short course',false) as id", [w.orgA, rec["CG-A1"], tag["ABA-related experience"]]))[0]!.id;
    await expectPgError(q(w.caregiverA1, "select ogevia_api.record_experience($1,$2,$3,null,false)", [w.orgA, rec["CG-A1"], tag["ABA-related experience"]]), "OGC09"); // already pending
    await expectPgError(q(w.managerA, "select ogevia_api.review_experience($1,'decline',' ')", [id]), "OGV22");
    await q(w.managerA, "select ogevia_api.review_experience($1,'decline','Course certificate not seen')", [id]);
    await expectPgError(q(w.managerA, "select ogevia_api.review_experience($1,'verify',null)", [id]), "OGC09");
    const after = await q(w.caregiverA1, "select * from ogevia_api.list_caregiver_experience($1,$2)", [w.orgA, rec["CG-A1"]]);
    expect(after.find((x: any) => x.experience_id === id)).toMatchObject({ status: "declined", review_note: "Course certificate not seen" });
    // another agency cannot verify
    await expectPgError(q(w.managerB, "select ogevia_api.review_experience($1,'verify',null)", [id]), "OGN04");
    // the row and its decline remain (append-only)
    expect((await db.admin.query("select status from ogevia.caregiver_experience where id = $1", [id])).rows[0].status).toBe("declined");
    await expect(db.admin.query("delete from ogevia.caregiver_experience where id = $1", [id])).rejects.toThrow();
  });

  it("the new tables are not directly readable or writable by the application role", async () => {
    for (const t of ["experience_tags", "caregiver_experience", "caregiver_experience_reviews", "client_support_preferences", "client_locations", "caregiver_locations", "zip_centroids", "assignment_decisions"]) {
      await expectPgError(q(w.managerA, `select * from ogevia.${t}`), "42501");
    }
  });
});
