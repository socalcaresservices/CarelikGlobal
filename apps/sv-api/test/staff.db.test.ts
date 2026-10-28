// 0086 (PENDING: infra/aws/db/pending) through the real Lambda handler: staff types, staff, invitations, role assignment, and who may do it.
// SYNTHETIC data only; the identity function is the in-memory stand-in (no Cognito is called).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { createTestDbWithPending } from "../../../infra/aws/db/test/pending";
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
let failInvite = false;

beforeAll(async () => {
  db = await createTestDbWithPending();
  w = await seedWorld(db, 700);
  const flaky = Object.assign(Object.create(identity), {
    invite: async (email: string) => {
      if (failInvite) throw new ApiError(502, "identity_unavailable", "down");
      return identity.invite(email);
    },
  }) as MemoryIdentityAdmin;
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: flaky, log: (r) => logs.push(r) });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const get = (route: string, a: Actor, query: Record<string, string> = {}) => call(route, a, { query: { organizationId: w.orgA, ...query } });
const post = (route: string, a: Actor, body: Record<string, unknown>, path: Record<string, string> = {}) => call(route, a, { path, body: { organizationId: w.orgA, ...body } });
const typeId = async (name: string) => (await db.admin.query("select id from ogevia.staff_types where organization_id = $1 and name = $2", [w.orgA, name])).rows[0].id as string;
const people = async () => (await db.admin.query("select (select count(*) from ogevia.app_users)::int u, (select count(*) from ogevia.organization_memberships)::int m, (select count(*) from ogevia.caregiver_records)::int c")).rows[0];

describe("staff API: the owner's workflow", () => {
  it("types, staff, invitation, resend, role change, directory, roles and history, end to end; nothing sensitive in any response", async () => {
    const types = await get("GET /v1/staff-types", w.ownerA);
    expect(types.status, JSON.stringify(types.body)).toBe(200);
    expect(types.body.staffTypes.map((t: any) => t.name)).toContain("Office Assistant");

    const newType = await post("POST /v1/staff-types", w.ownerA, { name: "Billing Specialist" });
    expect(newType.status, JSON.stringify(newType.body)).toBe(201);
    expect((await post("POST /v1/staff-types", w.ownerA, { name: "billing specialist" })).status).toBe(409);
    expect((await post("POST /v1/staff-types/{staffTypeId}/rename", w.ownerA, { name: "Billing Lead" }, { staffTypeId: newType.body.staffType.id })).status).toBe(200);

    const created = await post("POST /v1/staff", w.ownerA, { displayName: "Bea Billing", staffTypeId: newType.body.staffType.id, contactEmail: "bea.contact@example.test", phone: "555 0100" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.staff.id as string;
    expect((await post("POST /v1/staff/{profileId}", w.ownerA, { displayName: "Bea Billing", staffTypeId: await typeId("Coordinator"), contactEmail: "bea.contact@example.test", phone: "555 0100", status: "active" }, { profileId: id })).status).toBe(200);

    const before = await people();
    const inv = await post("POST /v1/staff/{profileId}/invitation", w.ownerA, { email: "bea.signin@example.test", role: "scheduler" }, { profileId: id });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.invitation).toEqual({ profileId: id });   // 0087 (L-1): the reply says nothing about the account
    expect(identity.calls.at(-1)).toEqual({ action: "invite", email: "bea.signin@example.test" });   // the SIGN-IN email, not the contact email
    const after = await people();
    expect(after).toEqual({ u: before.u + 1, m: before.m + 1, c: before.c });   // one new person and membership, no caregiver record, no duplicate

    const resend = await post("POST /v1/staff/{profileId}/invitation/resend", w.ownerA, {}, { profileId: id });
    expect(resend.status, JSON.stringify(resend.body)).toBe(200);
    expect(resend.body.invitation.sendCount).toBe(2);
    expect(identity.calls.at(-1)).toEqual({ action: "resend", email: "bea.signin@example.test" });

    const dir = await get("GET /v1/staff", w.ownerA);
    const row = dir.body.staff.find((s: any) => s.profileId === id);
    expect(row).toMatchObject({ displayName: "Bea Billing", staffTypeName: "Coordinator", systemRole: "scheduler", accessStatus: "invitation_pending", contactEmail: "bea.contact@example.test" });
    const userId = row.userId as string;

    const role = await post("POST /v1/staff-roles/{userId}", w.ownerA, { role: "coordinator", reason: "Takes over coordination" }, { userId });
    expect(role.status, JSON.stringify(role.body)).toBe(200);
    expect(role.body.staff).toMatchObject({ userId, role: "coordinator" });

    const roles = await get("GET /v1/role-permissions", w.ownerA);
    expect(roles.status).toBe(200);
    expect(roles.body.roles.find((r: any) => r.role === "organization_owner").permissions.map((p: any) => p.key)).toContain("staff.manage");

    const history = await get("GET /v1/staff-audit", w.ownerA, { profileId: id });
    expect(history.status).toBe(200);
    expect(history.body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(["staff.created", "staff.updated", "staff.invited", "staff.invitation_resent", "staff.role_changed"]));

    for (const r of [types, newType, created, inv, resend, dir, role, roles, history]) expect(JSON.stringify(r.body), "no password, Cognito id or sign-in email in a response").not.toMatch(/cognito|password|bea\.signin/i);
  });
});

describe("staff API: who may, and what is refused before anything is sent", () => {
  it("managers, schedulers and caregivers get 403 on every staff route and never reach the identity function", async () => {
    const calls = identity.calls.length;
    const type = await typeId("Manager");
    for (const who of [w.managerA, w.schedulerA, w.caregiverA1]) {
      for (const route of ["GET /v1/staff-types", "GET /v1/staff", "GET /v1/role-permissions", "GET /v1/staff-audit"]) expect((await get(route, who)).status, `${route}`).toBe(403);
      expect((await post("POST /v1/staff-types", who, { name: "Nope" })).status).toBe(403);
      expect((await post("POST /v1/staff", who, { displayName: "Nope", staffTypeId: type })).status).toBe(403);
      expect((await post("POST /v1/staff/{profileId}/invitation", who, { email: "nope@example.test", role: "staff" }, { profileId: "11111111-1111-4111-8111-111111111111" })).status).toBe(403);
      expect((await post("POST /v1/staff-roles/{userId}", who, { role: "staff", reason: "x y z" }, { userId: w.caregiverA2.userId })).status).toBe(403);
    }
    expect(identity.calls.length).toBe(calls);
  });

  it("another agency's owner, an outsider and a cross-agency target get 404; the owner cannot reach into another agency", async () => {
    expect((await call("GET /v1/staff", w.managerB, { query: { organizationId: w.orgA } })).status).toBe(404);
    expect((await call("GET /v1/staff", w.outsider, { query: { organizationId: w.orgA } })).status).toBe(404);
    expect((await call("GET /v1/staff", w.ownerA, { query: { organizationId: w.orgB } })).status).toBe(404);
    expect((await post("POST /v1/staff-roles/{userId}", w.ownerA, { role: "staff", reason: "cross agency" }, { userId: w.managerB.userId })).status).toBe(404);
  });

  it("an unsupported role, a bad body or a bad id is refused before the sign-in service is called, and a failing sign-in service links nothing", async () => {
    const profile = await post("POST /v1/staff", w.ownerA, { displayName: "Gil Guarded", staffTypeId: await typeId("Supervisor") });
    const id = profile.body.staff.id as string;
    const calls = identity.calls.length, before = await people();
    for (const role of ["organization_owner", "caregiver", "platform_owner", "superuser"]) {
      expect((await post("POST /v1/staff/{profileId}/invitation", w.ownerA, { email: "gil@example.test", role }, { profileId: id })).status, role).toBe(422);
    }
    expect((await post("POST /v1/staff/{profileId}/invitation", w.ownerA, { email: "not-an-email", role: "staff" }, { profileId: id })).status).toBe(422);
    expect((await post("POST /v1/staff/{profileId}/invitation", w.ownerA, { role: "staff" }, { profileId: id })).status).toBe(400);
    expect((await post("POST /v1/staff/{profileId}", w.ownerA, { displayName: "Gil", staffTypeId: await typeId("Supervisor"), status: "gone" }, { profileId: id })).status).toBe(400);
    expect((await post("POST /v1/staff-types/{staffTypeId}/active", w.ownerA, { active: "yes" }, { staffTypeId: await typeId("Supervisor") })).status).toBe(400);
    expect((await post("POST /v1/staff-roles/{userId}", w.ownerA, { role: "staff", reason: "x y z" }, { userId: "not-a-uuid" })).status).toBe(400);
    expect(identity.calls.length).toBe(calls);
    expect(await people()).toEqual(before);
    failInvite = true;
    try {
      expect((await post("POST /v1/staff/{profileId}/invitation", w.ownerA, { email: "gil@example.test", role: "staff" }, { profileId: id })).status).toBe(502);
    } finally { failInvite = false; }
    expect(await people()).toEqual(before);   // nothing was linked; the invitation can simply be sent again
    expect((await db.admin.query("select user_id from ogevia.staff_profiles where id = $1", [id])).rows[0].user_id).toBeNull();
    expect((await post("POST /v1/staff/{profileId}/invitation", w.ownerA, { email: "gil@example.test", role: "staff" }, { profileId: id })).status).toBe(201);
  });

  it("M-1: inviting an e-mail that already signs in elsewhere grants nothing until that person accepts it (end to end through the handler)", async () => {
    identity.users.set("mia.elsewhere@example.test", { sub: w.managerB.sub, confirmed: true });
    const type = await typeId("Coordinator");
    const created = await post("POST /v1/staff", w.ownerA, { displayName: "Mia Elsewhere", staffTypeId: type });
    const id = created.body.staff.id as string;
    const inv = await post("POST /v1/staff/{profileId}/invitation", w.ownerA, { email: "mia.elsewhere@example.test", role: "manager" }, { profileId: id });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.invitation).toEqual({ profileId: id });
    // nothing yet: the person still sees only their own agency, plus the invitation; agency A refuses them
    const me = await call("GET /v1/me", w.managerB);
    expect(me.status).toBe(200);
    expect(me.body.memberships.map((m: any) => m.organizationId)).toEqual([w.orgB]);
    expect(me.body.pendingInvitations).toEqual([expect.objectContaining({ organizationId: w.orgA, role: "manager" })]);
    expect(JSON.stringify(me.body.pendingInvitations)).not.toMatch(/mia|example/i);
    expect((await call("GET /v1/staff", w.managerB, { query: { organizationId: w.orgA } })).status).toBe(404);
    // somebody else cannot accept it for them
    expect((await call("POST /v1/me/staff-invitations/{organizationId}/accept", w.caregiverA1, { path: { organizationId: w.orgA }, body: {} })).status).toBe(404);
    expect((await call("GET /v1/me", w.managerB)).body.pendingInvitations).toHaveLength(1);
    // their own acceptance
    const ok = await call("POST /v1/me/staff-invitations/{organizationId}/accept", w.managerB, { path: { organizationId: w.orgA }, body: {} });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.accepted).toEqual({ organizationId: w.orgA, role: "manager" });
    const after = await call("GET /v1/me", w.managerB);
    expect(after.body.memberships.map((m: any) => m.organizationId).sort()).toEqual([w.orgA, w.orgB].sort());
    expect(after.body.pendingInvitations).toEqual([]);
    expect((await call("POST /v1/me/staff-invitations/{organizationId}/accept", w.managerB, { path: { organizationId: w.orgA }, body: {} })).status).toBe(200);   // a repeated accept changes nothing
    expect((await call("POST /v1/me/staff-invitations/{organizationId}/accept", w.managerB, { path: { organizationId: "not-a-uuid" }, body: {} })).status).toBe(400);
  });

  it("the Owner role cannot be assigned or changed through the API, and nobody changes their own role", async () => {
    expect((await post("POST /v1/staff-roles/{userId}", w.ownerA, { role: "manager", reason: "self change" }, { userId: w.ownerA.userId })).status).toBe(409);
    expect((await post("POST /v1/staff-roles/{userId}", w.ownerA, { role: "organization_owner", reason: "promote" }, { userId: w.managerA.userId })).status).toBe(422);
    expect((await db.admin.query("select role::text r from ogevia.organization_memberships where organization_id = $1 and user_id = $2", [w.orgA, w.managerA.userId])).rows[0].r).toBe("manager");
  });
});
