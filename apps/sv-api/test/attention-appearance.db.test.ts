// The attention-overview, appearance and missing-rate routes (0056) through the real Lambda handler and a real (local, disposable) PostgreSQL.
// SYNTHETIC data only. Covers wiring, validation, status codes, permissions and the cross-tenant boundary.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let today: string;
let handler: ReturnType<typeof createHandler>;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

describe("GET /v1/attention/overview", () => {
  it("is staff-only, validates the window, and returns the four purposes", async () => {
    const q = (extra: Record<string, string> = {}) => ({ query: { organizationId: w.orgA, ...extra } });
    expect((await handler(event("GET /v1/attention/overview", { sub: null, ...q() }))).statusCode).toBe(401);
    expect((await call("GET /v1/attention/overview", w.caregiverA1, q())).status).toBe(403);
    expect((await call("GET /v1/attention/overview", w.managerB, q())).status).toBe(404);
    expect((await call("GET /v1/attention/overview", w.managerA, q({ urgentHours: "0" }))).status).toBe(400);
    expect((await call("GET /v1/attention/overview", w.managerA, q({ urgentHours: "500" }))).status).toBe(400);
    expect((await call("GET /v1/attention/overview", w.managerA, q({ urgentHours: "abc" }))).status).toBe(400);
    const ok = await call("GET /v1/attention/overview", w.managerA, q());
    expect(ok.status).toBe(200);
    expect(ok.body.overview).toMatchObject({ urgentWindowHours: 48 });
    expect(Object.keys(ok.body.overview)).toEqual(expect.arrayContaining(["urgent", "upcoming", "documents", "visitReview"]));
    expect((await call("GET /v1/attention/overview", w.managerA, q({ urgentHours: "24" }))).body.overview.urgentWindowHours).toBe(24);
  });
});

describe("appearance over HTTP", () => {
  it("saves agency defaults (administrator only) and personal choices (that person only), each persisted and isolated by agency", async () => {
    const get = (a: Actor, org = w.orgA) => call("GET /v1/appearance", a, { query: { organizationId: org } });
    expect((await get(w.caregiverA1)).body.appearance.effective).toMatchObject({ background: "light", accent: "teal", density: "comfortable", textSize: "standard", chartType: "bar", layout: "standard" });
    const body = { organizationId: w.orgA, background: "white", accent: "indigo", density: "compact", textSize: "standard", chartType: "donut", layout: "minimal" };
    expect((await call("POST /v1/appearance/organization", w.managerA, { body })).status).toBe(403);
    expect((await call("POST /v1/appearance/organization", w.ownerA, { body, key: null })).status).toBe(200); // this route does not consume an idempotency key (it sets, it does not create)
    expect((await call("POST /v1/appearance/organization", w.ownerA, { body: { ...body, background: "neon" } })).status).toBe(400);
    expect((await call("POST /v1/appearance/organization", w.ownerA, { body: { ...body, chartType: "pie" } })).status).toBe(400);
    expect((await call("POST /v1/appearance/organization", w.ownerA, { body: { ...body, layout: "wide" } })).status).toBe(400);
    expect((await call("POST /v1/appearance/organization", w.ownerA, { body: { ...body, background: "cream" } })).status).toBe(400); // replaced by White before release
    expect((await get(w.caregiverA2)).body.appearance.effective).toMatchObject({ background: "white", accent: "indigo", density: "compact", chartType: "donut", layout: "minimal" });
    const mine = await call("POST /v1/appearance/me", w.caregiverA1, { body: { organizationId: w.orgA, background: "dark", accent: null, density: null, textSize: "large", chartType: null, layout: "standard" } });
    expect(mine.status).toBe(200);
    expect(mine.body.appearance.effective).toMatchObject({ background: "dark", accent: "indigo", density: "compact", textSize: "large", chartType: "donut", layout: "standard" });
    expect((await get(w.caregiverA2)).body.appearance.effective.background).toBe("white"); // unaffected
    expect((await get(w.managerA)).body.appearance.mine.background).toBeNull();
    // another agency: its own defaults, no access to this agency's, and a person cannot save a choice into an agency they are not in
    expect((await get(w.managerB, w.orgB)).body.appearance.effective.background).toBe("light");
    expect((await get(w.managerB, w.orgA)).status).toBe(404);
    expect((await call("POST /v1/appearance/me", w.managerB, { body: { organizationId: w.orgA, background: "dark" } })).status).toBe(404);
    // a refresh (new request) returns what was saved
    expect((await get(w.caregiverA1)).body.appearance.mine).toEqual({ background: "dark", accent: null, density: null, textSize: "large", chartType: null, layout: "standard" });
  });
});

describe("GET /v1/authorizations/missing-rate", () => {
  it("lists authorizations without a rate for the administrator only", async () => {
    const monthStart = `${today.slice(0, 7)}-01`;
    const q = { query: { organizationId: w.orgA, monthStart } };
    const owner = await call("GET /v1/authorizations/missing-rate", w.ownerA, q);
    expect(owner.status).toBe(200);
    expect(owner.body.authorizations.length).toBeGreaterThan(0);
    expect(owner.body.authorizations[0]).toMatchObject({ clientId: expect.any(String), serviceCode: "RSP" });
    expect(JSON.stringify(owner.body)).not.toMatch(/hourlyRate|rateCents/);
    expect((await call("GET /v1/authorizations/missing-rate", w.managerA, q)).body.authorizations).toEqual([]);
    expect((await call("GET /v1/authorizations/missing-rate", w.managerA, { query: { organizationId: w.orgA, monthStart: "nope" } })).status).toBe(400);
    expect((await call("GET /v1/authorizations/missing-rate", w.managerB, q)).body.authorizations).toEqual([]);
  });
});

describe("0057 and 0058 through the Lambda: tiers, queues and honest balances", () => {
  const q = (extra: Record<string, string> = {}) => ({ query: { organizationId: w.orgA, ...extra } });

  it("the overview carries the tier on urgent items, the critical/urgent counts, and the separated review and visit queues", async () => {
    const c = await db.admin.connect();
    try {
      const f = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
      await c.query("set session_replication_role = replica");
      await c.query(`insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status) values ($1,$2,$3, now() - interval '1 hour', now() + interval '2 hours', 'scheduled')`, [w.orgA, f.client, f.service]);
      await c.query(`insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status) values ($1,$2,$3, now() + interval '5 hours', now() + interval '8 hours', 'scheduled')`, [w.orgA, f.client, f.service]);
      await c.query("set session_replication_role = origin");
    } finally { c.release(); }
    const o = (await call("GET /v1/attention/overview", w.managerA, q())).body.overview;
    expect(o.urgent.items.map((i: any) => i.tier).sort()).toEqual(["critical", "urgent"]);
    expect(o.urgent).toMatchObject({ critical: 1, urgent: 1 });
    expect(o.urgent.items.find((i: any) => i.tier === "critical").severity).toBe("red");
    expect(Object.keys(o.visitReview)).toEqual(expect.arrayContaining(["pendingConfirmation", "confirmationOverdue", "reviewOverdue", "readyForApproval"]));
    expect(Object.keys(o.documents)).toEqual(expect.arrayContaining(["reviewRoutine", "reviewOverdue"]));
    // a scheduler without billing and a manager see the same tiers; another agency sees none of agency A's items
    expect((await call("GET /v1/attention/overview", w.schedulerA, q())).body.overview.urgent.critical).toBe(1);
    expect((await call("GET /v1/attention/overview", w.managerB, { query: { organizationId: w.orgB } })).body.overview.urgent.itemCount).toBe(0);
  });

  it("the monthly summary and the Home utilisation route return the signed balance, the overage and the tier; the totals reconcile", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 200);
    const rec = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
    for (const hours of [30, 54]) {
      const shift = (await db.admin.query(`insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at) values ($1,$2,$3,$4,$5, now() + make_interval(hours => $6), now() + make_interval(hours => $6, mins => 180)) returning id`, [w.orgA, f.client, f.service, w.caregiverA1.userId, rec, hours])).rows[0].id;
      const request = (await db.admin.query(`insert into ogevia.care_requests (organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at, requested_minutes, status, request_key, assigned_shift_id, assigned_caregiver_record_id, assigned_at) select $1,$2,$3,a.lineage_id,s.starts_at,s.ends_at,180,'assigned',gen_random_uuid(),s.id,$4,now() from ogevia.client_authorizations a, ogevia.shifts s where a.id = $5 and s.id = $6 returning id`, [w.orgA, f.client, f.service, rec, f.auth, shift])).rows[0].id;
      await db.admin.query(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes) select $1, a.lineage_id, $2, $3, $4::date, 180 from ogevia.client_authorizations a where a.id = $5`, [w.orgA, request, shift, today, f.auth]);
    }
    const monthStart = `${today.slice(0, 7)}-01`;
    const rows = (await call("GET /v1/reports/monthly-service-summary", w.managerA, { query: { organizationId: w.orgA, clientId: f.client, monthStart } })).body.services as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ authorizedMinutes: 200, committedMinutes: 360, remainingMinutes: -160, overLimitMinutes: 160, authorizationTier: "critical", utilizationPercent: 180 });
    const home = (await call("GET /v1/reports/utilisation", w.managerA, { query: { organizationId: w.orgA, monthStart } })).body.services as any[];
    const all = (await call("GET /v1/reports/monthly-service-summary", w.managerA, { query: { organizationId: w.orgA, monthStart } })).body.services as any[];
    const svc = home.find((r) => r.serviceId === f.service);
    const sum = (k: string, fn = (n: number) => n) => all.filter((r) => r.serviceId === f.service).reduce((t, r) => t + fn(Number(r[k])), 0);
    expect(svc.overLimitMinutes).toBe(sum("overLimitMinutes"));
    expect(svc.remainingMinutes).toBe(sum("remainingMinutes", (n) => Math.max(n, 0)));
    expect(svc.authorizedMinutes - svc.committedMinutes).toBe(svc.remainingMinutes - svc.overLimitMinutes);
    // the agency boundary and the permission are unchanged
    const other = await call("GET /v1/reports/monthly-service-summary", w.managerB, { query: { organizationId: w.orgA, monthStart } });
    expect(other.body.services ?? []).toEqual([]); // not a member of agency A: no rows, whatever the status code
    const cg = await call("GET /v1/reports/utilisation", w.caregiverA1, { query: { organizationId: w.orgA, monthStart } });
    expect(cg.body.services ?? []).toEqual([]); // a caregiver has no visits.read: no rows
  });

  it("the sidebar's summary uses the same 48-hour rule for confirmations (it used 60 minutes)", async () => {
    const fx = await freshClient(db, w, w.caregiverA2, 100000, w.orgA, { before: 5, after: 120 });
    const read = async () => (await call("GET /v1/attention", w.managerA, { query: { organizationId: w.orgA } })).body.summary.notConfirmed as number;
    const before = await read();
    const v = await api.start(db, w.caregiverA2, w.orgA, fx.client, fx.service, null, "Synthetic: extra help");
    await ageVisit(db, v, 120);
    await api.end(db, w.caregiverA2, v);
    const set = async (mins: number) => {
      await db.admin.query("set session_replication_role = replica");
      await db.admin.query("update ogevia.service_visits set status = 'awaiting_signature', time_in = now() - make_interval(mins => $2 + 120), time_out = now() - make_interval(mins => $2) where id = $1", [v, mins]);
      await db.admin.query("set session_replication_role = origin");
    };
    await set(47 * 60 + 59);
    expect(await read()).toBe(before);
    await set(48 * 60 + 1);
    expect(await read()).toBe(before + 1);
  });
});
