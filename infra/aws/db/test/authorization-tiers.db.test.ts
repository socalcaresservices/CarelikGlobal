// 0057 Authorization tiers (Healthy below 80%, Near Limit 80% to below 95%, Critical 95% and above), the 30-day expiry warning, the approved
// committed-utilization definition, and balances that tell the truth (no silent floor at zero). SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let monthStart: string;
let recA1: string;

const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const as = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const summary = (a: Actor, client: string | null = null, org = w.orgA) =>
  as(a, "select * from ogevia_api.list_monthly_service_summary($1,$2,$3)", [org, monthStart, client]);
const rowFor = async (client: string) => (await summary(w.managerA, client))[0];
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  monthStart = `${today.slice(0, 7)}-01`;
  recA1 = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
});
afterAll(async () => db?.drop());

type Fx = { client: string; service: string; auth: string };
/** A shift held by an assigned Care Request reservation (as 0011 creates it), `minutes` long. */
async function reserve(f: Fx, minutes: number, offsetHours = 30) {
  const shift = (await q(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
     values ($1,$2,$3,$4,$5, now() + make_interval(hours => $6), now() + make_interval(hours => $6, mins => $7)) returning id`,
    [w.orgA, f.client, f.service, w.caregiverA1.userId, recA1, offsetHours, minutes])).rows[0].id as string;
  const request = (await q(
    `insert into ogevia.care_requests (organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at,
       requested_minutes, status, request_key, assigned_shift_id, assigned_caregiver_record_id, assigned_at)
     select $1,$2,$3,a.lineage_id,s.starts_at,s.ends_at,$4,'assigned',gen_random_uuid(),s.id,$5,now()
     from ogevia.client_authorizations a, ogevia.shifts s where a.id = $6 and s.id = $7 returning id`,
    [w.orgA, f.client, f.service, minutes, recA1, f.auth, shift])).rows[0].id as string;
  await q(
    `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
     select $1, a.lineage_id, $2, $3, $4::date, $5 from ogevia.client_authorizations a where a.id = $6`,
    [w.orgA, request, shift, today, minutes, f.auth]);
}

describe("the tier function: exact boundaries on integer arithmetic", () => {
  const tier = async (committed: number | null, authorized: number | null) => (await q("select ogevia.authorization_tier($1::bigint,$2::bigint) t", [committed, authorized])).rows[0].t;
  it("Healthy below 80%, Near Limit from 80% to below 95%, Critical from 95% upward", async () => {
    expect(await tier(7999, 10000)).toBe("healthy");
    expect(await tier(8000, 10000)).toBe("near_limit");
    expect(await tier(9499, 10000)).toBe("near_limit");
    expect(await tier(9500, 10000)).toBe("critical");
    expect(await tier(10000, 10000)).toBe("critical");
    expect(await tier(12000, 10000)).toBe("critical");
    expect(await tier(0, 10000)).toBe("healthy");
  });
  it("small authorizations: 80% of 5 minutes is 4, 95% of 20 minutes is 19; no rounding in the comparison", async () => {
    expect(await tier(3, 5)).toBe("healthy");
    expect(await tier(4, 5)).toBe("near_limit");
    expect(await tier(18, 20)).toBe("near_limit");
    expect(await tier(19, 20)).toBe("critical");
  });
  it("a zero authorization has no percentage: Critical if anything is committed, Healthy otherwise; unknown stays unknown", async () => {
    expect(await tier(0, 0)).toBe("healthy");
    expect(await tier(1, 0)).toBe("critical");
    expect(await tier(null, 100)).toBeNull();
    expect(await tier(100, null)).toBeNull();
  });
});

describe("the report carries the tier, the percentage and the signed balance", () => {
  it("each tier is reached at its boundary through real reservations (1000 minutes authorized)", async () => {
    const cases: [number, string, number][] = [[799, "healthy", 79.9], [800, "near_limit", 80], [949, "near_limit", 94.9], [950, "critical", 95], [1000, "critical", 100]];
    for (const [reserved, expected, pct] of cases) {
      const f = await freshClient(db, w, w.caregiverA1, 1000);
      await reserve(f, reserved);
      expect(await rowFor(f.client), `${reserved} reserved`).toMatchObject({ authorized_minutes: 1000, committed_minutes: reserved, authorization_tier: expected, utilization_percent: pct, remaining_minutes: 1000 - reserved, over_limit_minutes: 0 });
    }
  });

  it("committed = billable + approved rounding adjustments + reserved; remaining = authorized - committed (the approved definition)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 1000);
    const v = await signedVisit(db, w.caregiverA1, w, 60, w.orgA, f.client, f.service);
    await reserve(f, 180);
    const lineage = (await q("select lineage_id from ogevia.client_authorizations where id = $1", [f.auth])).rows[0].lineage_id;
    await q("set session_replication_role = replica");
    const policy = (await q(
      `insert into ogevia.billing_rounding_policies (organization_id, payer_key, payer_label, service_id, version, method, effective_from, reason, created_by)
       values ($1,'none-test','None (synthetic)',$2,1,'none',$3,'Synthetic fixture',$4) returning id`, [w.orgA, f.service, monthStart, w.ownerA.userId])).rows[0].id;
    await q(
      `insert into ogevia.billing_rounding_adjustments (organization_id, unit_kind, authorization_lineage_id, client_id, service_id, service_date, policy_id,
         covered_visit_ids, base_minutes, proposed_minutes, adjustment_minutes, capped_by_authorization, approved_by)
       values ($1,'day',$2,$3,$4,$5::date,$6,$7::uuid[],60,90,30,false,$8)`, [w.orgA, lineage, f.client, f.service, today, policy, [v.visit], w.ownerA.userId]);
    await q("set session_replication_role = origin");
    expect(await rowFor(f.client)).toMatchObject({
      billable_minutes: 60, adjustment_minutes: 30, reserved_minutes: 180, committed_minutes: 270, remaining_minutes: 730, over_limit_minutes: 0, utilization_percent: 27, authorization_tier: "healthy",
    });
  });

  it("over the limit the balance is NEGATIVE and the overage is its own column (it used to read 0)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 200);
    await reserve(f, 180, 30);
    await reserve(f, 180, 54);
    expect(await rowFor(f.client)).toMatchObject({ committed_minutes: 360, remaining_minutes: -160, over_limit_minutes: 160, authorization_tier: "critical", utilization_percent: 180 });
  });
});

describe("the expiry warning is separate from the tiers: 0 to 30 days inclusive", () => {
  it("period end today, in 1 day and in 30 days warn; in 31 days does not; the tier is unaffected", async () => {
    for (const [after, warn] of [[0, true], [1, true], [30, true], [31, false]] as const) {
      const f = await freshClient(db, w, w.caregiverA1, 1000, w.orgA, { before: 5, after });
      const r = await rowFor(f.client);
      expect(r, `ends in ${after} days`).toMatchObject({ days_until_expiry: after, expiring_soon: warn, authorization_tier: "healthy" });
    }
  });
});

describe("Home totals reconcile with the per-authorization rows", () => {
  it("remaining adds up unused time only; the overage is reported beside it; authorized - committed = remaining - over limit", async () => {
    // one authorization well over its limit and one with plenty of room, on the same service
    const over = await freshClient(db, w, w.caregiverA1, 300);
    await reserve(over, 500, 30);
    const roomy = await freshClient(db, w, w.caregiverA1, 3000);
    await reserve(roomy, 180, 56);
    const rows = await summary(w.managerA);
    const sum = (k: string) => rows.filter((r: any) => r.service_id === over.service).reduce((t: number, r: any) => t + Number(r[k]), 0);
    const ov = (await as(w.managerA, "select * from ogevia_api.get_utilisation_overview($1,$2)", [w.orgA, monthStart])).find((r: any) => r.service_id === over.service);
    expect(ov.committed_minutes).toBe(sum("committed_minutes"));
    expect(ov.over_limit_minutes).toBe(sum("over_limit_minutes"));
    expect(ov.over_limit_minutes).toBeGreaterThanOrEqual(200);
    // each authorization's unused time counts; the over-limit one does not use up the roomy one's hours
    expect(ov.remaining_minutes).toBe(rows.filter((r: any) => r.service_id === over.service).reduce((t: number, r: any) => t + Math.max(Number(r.remaining_minutes), 0), 0));
    expect(ov.authorized_minutes - ov.committed_minutes).toBe(ov.remaining_minutes - ov.over_limit_minutes);
    expect(ov.critical_authorizations).toBeGreaterThanOrEqual(1);
    expect(ov.near_limit_authorizations + ov.critical_authorizations).toBe(rows.filter((r: any) => r.service_id === over.service && r.authorization_tier !== "healthy").length);
  });
});

describe("what a visit records and what a shift refuses", () => {
  it("the confirmation records the real balance: negative when the month is already over, not 0", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 100);
    await signedVisit(db, w.caregiverA1, w, 60, w.orgA, f.client, f.service); // 60 used of 100
    // the authorization is amended down below what is already used (fixture; triggers off)
    await q("set session_replication_role = replica");
    await q("update ogevia.client_authorizations set monthly_authorized_minutes = 30 where id = $1", [f.auth]);
    await q("set session_replication_role = origin");
    const second = await signedVisit(db, w.caregiverA1, w, 45, w.orgA, f.client, f.service);
    // the cap check is unchanged: nothing more is billable once the month is over (30 - 60 < 0)
    expect(second.result).toMatchObject({ billable_minutes: 0 });
    expect(Number(second.result.remaining_minutes)).toBe(-30);
    const snap = (await q("select confirmed_visit_snapshot s from ogevia.visit_confirmations where visit_id = $1", [second.visit])).rows[0].s;
    expect(snap).toMatchObject({ authorizedMinutes: 30, billableMinutes: 0, remainingMinutes: -30 });
  });

  it("a shift that does not fit still refuses (OGC09); the wording says how far over the limit the authorization already is", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 200);
    await reserve(f, 180, 30);
    await reserve(f, 180, 54);
    const d = day(1);
    await expectPgError(as(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','10:00',$5,null)", [w.orgA, f.client, f.service, d, recA1]), "OGC09", /already 2 hr 40 min over its limit this month, and this shift needs 1 hr/);
  });

  it("when time remains but not enough, the wording is the same as before: what is available and what the shift needs", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    await reserve(f, 180, 30);
    await expectPgError(as(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','12:00',$5,null)", [w.orgA, f.client, f.service, day(1), recA1]), "OGC09", /2 hr available, this shift needs 3 hr/);
  });
});

describe("permissions and tenant isolation are unchanged", () => {
  it("the new columns ride on the same checks: visits.read to read, another agency sees nothing, a caregiver is refused", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 1000);
    expect((await summary(w.managerA, f.client)).length).toBe(1);
    expect(await summary(w.managerB, f.client, w.orgA)).toEqual([]); // not a member of agency A: no rows
    expect(await summary(w.caregiverA1, f.client)).toEqual([]); // no visits.read
    expect(await as(w.managerB, "select * from ogevia_api.get_utilisation_overview($1,$2)", [w.orgA, monthStart])).toEqual([]);
    const appRole = (await q("select has_function_privilege('ogevia_app','ogevia_api.list_monthly_service_summary(uuid,date,uuid)','execute') a, has_function_privilege('public','ogevia_api.list_monthly_service_summary(uuid,date,uuid)','execute') p, has_function_privilege('ogevia_app','ogevia_api.get_utilisation_overview(uuid,date)','execute') u, has_function_privilege('public','ogevia_api.get_utilisation_overview(uuid,date)','execute') up")).rows[0];
    expect(appRole).toEqual({ a: true, p: false, u: true, up: false });
  });
  it("the helpers are not callable by the public", async () => {
    const r = (await q("select has_function_privilege('public','ogevia.authorization_tier(bigint,bigint)','execute') a, has_function_privilege('public','ogevia.authorization_shortfall_message(bigint,bigint)','execute') b")).rows[0];
    expect(r).toEqual({ a: false, b: false });
  });
  it("concurrency: two managers filling the last hour of an authorization cannot both succeed (the lineage lock is untouched)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 60);
    const attempt = (d: string, key: string) => as(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','10:00',null,$5)", [w.orgA, f.client, f.service, d, key]).then(() => "ok", (e) => String(e.code ?? e.message));
    const results = await Promise.all([attempt(day(1), crypto.randomUUID()), attempt(day(2), crypto.randomUUID())]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "OGC09")).toHaveLength(1);
  });
});
void api;
