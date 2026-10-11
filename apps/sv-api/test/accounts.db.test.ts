// 0048 through the real Lambda handler: account status, Admin disable/enable, the identity call order, and who may do it.
// SYNTHETIC data only; the identity function is the in-memory stand-in (no Cognito is called).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler, type LogRecord } from "../src/handler";
import { ApiError } from "../src/errors";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
const logs: LogRecord[] = [];
const identity = new MemoryIdentityAdmin();
let handler: ReturnType<typeof createHandler>;
let failIdentity = false;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  const flaky = Object.assign(Object.create(identity), {
    setEnabled: async (sub: string, enabled: boolean) => {
      if (failIdentity) throw new ApiError(502, "identity_unavailable", "down");
      return identity.setEnabled(sub, enabled);
    },
  }) as MemoryIdentityAdmin;
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: flaky, log: (r) => logs.push(r) });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const list = (a: Actor) => call("GET /v1/accounts", a, { query: { organizationId: w.orgA } });
const disable = (a: Actor, userId: string, reason = "Left the agency") => call("POST /v1/accounts/{userId}/disable", a, { path: { userId }, body: { organizationId: w.orgA, reason } });
const enable = (a: Actor, userId: string, reason = "Returned") => call("POST /v1/accounts/{userId}/enable", a, { path: { userId }, body: { organizationId: w.orgA, reason } });

describe("accounts API", () => {
  it("lists plain-language status for the owner only; managers and caregivers get 403; the response holds no email, sub or password", async () => {
    const ok = await list(w.ownerA);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.accounts.find((a: any) => a.userId === w.caregiverA1.userId)).toMatchObject({ accountStatus: "active", role: "caregiver" });
    expect(JSON.stringify(ok.body)).not.toMatch(/cognito|@|password|sub"/i);
    for (const who of [w.managerA, w.schedulerA, w.caregiverA1]) expect((await list(who)).status).toBe(403);
    expect((await disable(w.managerA, w.caregiverA2.userId)).status).toBe(403);
    expect((await enable(w.managerA, w.caregiverA2.userId)).status).toBe(403);
    expect(identity.calls).toHaveLength(0); // a refused request never reaches the identity function
  });

  it("disable: the database blocks first, then the sign-in is switched off; the response never carries the Cognito id", async () => {
    const r = await disable(w.ownerA, w.caregiverA2.userId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.account).toEqual({ userId: w.caregiverA2.userId, accountStatus: "disabled", signInSwitchedOff: true });
    expect(identity.calls.at(-1)).toEqual({ action: "disable", sub: w.caregiverA2.sub });
    expect(JSON.stringify(r.body)).not.toContain(w.caregiverA2.sub);
    // The disabled person is refused by the API at once.
    expect((await call("GET /v1/me", w.caregiverA2)).status).toBe(401);
  });

  it("if the sign-in service is down, the person is STILL blocked in Ogevia, the Admin is told, and a retry finishes the job", async () => {
    failIdentity = true;
    const r = await disable(w.ownerA, w.caregiverA3.userId);
    expect(r.status).toBe(502);
    expect(r.body.error?.message ?? r.body.message).toMatch(/blocked in Ogevia/);
    expect((await call("GET /v1/me", w.caregiverA3)).status).toBe(401);
    failIdentity = false;
    const retry = await disable(w.ownerA, w.caregiverA3.userId);
    expect(retry.status).toBe(200);
    expect(identity.disabled.has(w.caregiverA3.sub)).toBe(true);
  });

  it("enable: the sign-in is switched on FIRST; if that fails nothing changes in Ogevia; then access is restored", async () => {
    failIdentity = true;
    const down = await enable(w.ownerA, w.caregiverA2.userId);
    expect(down.status).toBe(502);
    expect((await call("GET /v1/me", w.caregiverA2)).status).toBe(401); // still blocked
    failIdentity = false;
    const up = await enable(w.ownerA, w.caregiverA2.userId);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(identity.disabled.has(w.caregiverA2.sub)).toBe(false);
    expect((await call("GET /v1/me", w.caregiverA2)).status).toBe(200);
  });

  it("validation and boundaries: reason required, own account refused, another agency's person not found, bad ids rejected", async () => {
    expect((await call("POST /v1/accounts/{userId}/disable", w.ownerA, { path: { userId: w.caregiverA1.userId }, body: { organizationId: w.orgA } })).status).toBe(400);
    expect((await disable(w.ownerA, w.ownerA.userId)).status).toBe(409);
    expect((await disable(w.ownerA, w.caregiverB1.userId)).status).toBe(404);
    expect((await call("POST /v1/accounts/{userId}/disable", w.ownerA, { path: { userId: "not-a-uuid" }, body: { organizationId: w.orgA, reason: "x y z" } })).status).toBe(400);
    expect((await list(w.managerB)).status).toBe(404); // another agency's manager cannot even tell the agency exists
  });
});
