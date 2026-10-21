// The production sign-in cutover end to end through the REAL Lambda handler and a real PostgreSQL: the administrator whose sign-in was moved
// to the production pool keeps the same person, agency, role and permissions; the old sign-in and every test-pool token are refused;
// existing workflows keep working; invitations go to the production pool. SYNTHETIC data only; no AWS.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_URL, createTestDb, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { lambdaIdentityAdmin } from "../src/identity";
import { createIdentityHandler } from "../src/identity-handler";
import { claims, event } from "./fixtures";

const SQL = fileURLToPath(new URL("../../../infra/aws/db/deploy/16_prd_relink_sign_in.sql", import.meta.url));
const REGION = "us-west-2";
const PRD_POOL = "us-west-2_PRDONLY01", PILOT_POOL = "us-west-2_SHAREDPILOT";
const id26 = (p: string) => (p + "0".repeat(26)).slice(0, 26);
const PRD_CLIENT = id26("prdwebclient"), PILOT_CLIENT = id26("pilotclient");
const issuerOf = (pool: string) => `https://cognito-idp.${REGION}.amazonaws.com/${pool}`;
const CONFIG = { issuer: issuerOf(PRD_POOL), appClientIds: [PRD_CLIENT], dbSetRole: "ogevia_app" };

let db: TestDb;
let w: World;
let handler: ReturnType<typeof createHandler>;
const cognitoCalls: { name: string; pool: string }[] = [];

// The production identity function, wired exactly as in production: API -> identity function -> Cognito on ITS pool only.
const NEW_SUB = randomUUID();
const identity = lambdaIdentityAdmin((request) =>
  createIdentityHandler(
    { send: async (c: any) => { cognitoCalls.push({ name: c.constructor.name, pool: c.input.UserPoolId }); return { User: { Attributes: [{ Name: "sub", Value: NEW_SUB }] } }; } } as never,
    PRD_POOL,
    () => undefined,
  )(request),
);

const prdToken = (sub: string, extra: Record<string, unknown> = {}) => claims(sub, { iss: issuerOf(PRD_POOL), client_id: PRD_CLIENT, ...extra });
async function call(routeKey: string, sub: string, opts: Parameters<typeof event>[1] = {}, extra: Record<string, unknown> = {}) {
  const r = await handler(event(routeKey, { ...opts, claims: prdToken(sub, extra) }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
function relink(oldSub: string, newSub: string) {
  const u = new URL(ADMIN_URL); u.pathname = `/${db.name}`;
  const r = spawnSync("psql", [u.toString(), "-X", "-At", "-v", "ON_ERROR_STOP=1", "-v", `expected_db=${db.name}`, "-v", `old_sub=${oldSub}`, "-v", `new_sub=${newSub}`, "-v", "approval_ref=owner-go-auth-20261021", "-f", SQL], { encoding: "utf8" });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

const ADMIN_NEW = randomUUID();
let owner: Actor;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  owner = w.ownerA;
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity, log: () => undefined });
});
afterAll(async () => db?.drop());

describe("before the cutover: the existing administrator's sign-in is a plain sign-in id on one person", () => {
  it("is the same person that the production pool will carry", async () => {
    const [me] = (await db.admin.query("select id, cognito_sub from ogevia.app_users where id = $1", [owner.userId])).rows;
    expect(me.cognito_sub).toBe(owner.sub);
  });
});

describe("after relinking the administrator to the production pool", () => {
  beforeAll(() => relink(owner.sub, ADMIN_NEW));

  it("MY PRODUCTION ADMINISTRATOR CAN SIGN IN: a production-pool token returns the same agency, role and permissions", async () => {
    const r = await call("GET /v1/me", ADMIN_NEW);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.memberships).toHaveLength(1);
    expect(r.body.memberships[0]).toMatchObject({ organizationId: w.orgA, role: "organization_owner" });
    expect(r.body.memberships[0].permissions).toEqual(expect.arrayContaining(["accounts.manage", "billing.approve", "organization.update"]));
  });

  it("the old (test-pool) sign-in is refused even with a well-formed token", async () => {
    const r = await call("GET /v1/me", owner.sub);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthenticated");
  });

  it("test-pool tokens are rejected by production before any database work, even for the relinked person's new sign-in id", async () => {
    for (const extra of [{ iss: issuerOf(PILOT_POOL), client_id: PILOT_CLIENT }, { iss: issuerOf(PILOT_POOL), client_id: PRD_CLIENT }, { client_id: PILOT_CLIENT }]) {
      const r = await call("GET /v1/me", ADMIN_NEW, {}, extra);
      expect(r.status).toBe(401);
    }
  });

  it("existing workflows keep working for the relinked administrator (clients, caregivers, accounts)", async () => {
    const clients = await call("GET /v1/clients", ADMIN_NEW, { query: { organizationId: w.orgA } });
    expect(clients.status, JSON.stringify(clients.body)).toBe(200);
    expect(JSON.stringify(clients.body)).toContain(w.clientA1);
    const accounts = await call("GET /v1/accounts", ADMIN_NEW, { query: { organizationId: w.orgA } });
    expect(accounts.status, JSON.stringify(accounts.body)).toBe(200);
    const caregivers = await call("GET /v1/caregivers", ADMIN_NEW, { query: { organizationId: w.orgA } });
    expect(caregivers.status).toBe(200);
  });

  it("agency membership and permissions remain enforced", async () => {
    // The other agency: list endpoints return an EMPTY list for a non-member (the existing design) and never the other agency's data;
    // owner-only account administration is refused outright.
    const other = await call("GET /v1/clients", ADMIN_NEW, { query: { organizationId: w.orgB } });
    expect([200, 403, 404]).toContain(other.status);
    if (other.status === 200) expect(other.body.clients).toEqual([]);
    expect(JSON.stringify(other.body)).not.toContain(w.clientB1);
    expect((await call("GET /v1/accounts", ADMIN_NEW, { query: { organizationId: w.orgB } })).status).toBe(404);
    // a manager (not relinked) still cannot use the owner-only account administration; a caregiver still cannot see agency data
    // (the caregiver and manager keep their test-pool ids in this fixture; their tokens are shaped like production tokens only to exercise authorization)
    expect((await call("GET /v1/accounts", w.managerA.sub, { query: { organizationId: w.orgA } })).status).toBe(403);
    const cg = await call("GET /v1/clients", w.caregiverA1.sub, { query: { organizationId: w.orgA } });
    expect(cg.status === 200 ? cg.body.clients : []).toEqual([]);                      // a caregiver is shown no agency client list
    expect((await call("POST /v1/caregivers", w.caregiverA1.sub, { body: { organizationId: w.orgA, firstName: "X", lastName: "Y", status: "onboarding" } })).status).toBe(403);
    // the owner of the other agency cannot administer this one
    expect((await call("GET /v1/accounts", w.managerB.sub, { query: { organizationId: w.orgA } })).status).toBe(404);
  });

  it("PRODUCTION INVITATIONS USE THE NEW POOL: inviting a caregiver calls Cognito on the production pool only", async () => {
    const created = await call("POST /v1/caregivers", ADMIN_NEW, { body: { organizationId: w.orgA, firstName: "Synthetic", lastName: "Invitee", status: "onboarding" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const record = created.body.caregiver.caregiverRecordId as string;
    await db.admin.query("update ogevia.caregiver_records set status = 'ready', onboarding_required = false where id = $1", [record]);
    cognitoCalls.length = 0;
    const inv = await call("POST /v1/caregivers/{caregiverRecordId}/invitation", ADMIN_NEW, { path: { caregiverRecordId: record }, body: { organizationId: w.orgA, email: "invitee@example.test" } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(cognitoCalls.length).toBeGreaterThan(0);
    for (const c of cognitoCalls) expect(c.pool).toBe(PRD_POOL);
    expect(cognitoCalls.some((c) => c.name === "AdminCreateUserCommand")).toBe(true);
    expect(JSON.stringify(cognitoCalls)).not.toContain(PILOT_POOL);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_invitations where caregiver_record_id = $1", [record])).rows[0].n).toBe(1);
  });

  it("no second person record or agency was created by the cutover", async () => {
    expect((await db.admin.query("select count(*)::int n from ogevia.app_users where id = $1", [owner.userId])).rows[0].n).toBe(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.organization_memberships where user_id = $1 and role = 'organization_owner'", [owner.userId])).rows[0].n).toBe(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.organizations")).rows[0].n).toBe(2);
  });
});
