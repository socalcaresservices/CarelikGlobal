// 0086 caregiver readiness over HTTP, through the real Lambda handler and a real (local, disposable) PostgreSQL. SYNTHETIC data only.
// Covers wiring, validation, status codes, permissions, the cross-tenant boundary and the sign-in link (create / resend / rate limit / no email in responses or logs).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let today: string;
let handler: ReturnType<typeof createHandler>;
let identity: MemoryIdentityAdmin;
const logs: unknown[] = [];

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 800);
  today = await orgToday(db);
  identity = new MemoryIdentityAdmin();
  // CPR/TB document types and rules, so a missing document reads as "missing" (pending/overdue) rather than "agency rule not set up"
  const as = (a: Actor, sql: string, params: unknown[]) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
  const cpr = (await as(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  const tb = (await as(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
  await as(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await as(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await as(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await as(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity, log: (l: unknown) => logs.push(l) });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const day = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const newCaregiver = async (last: string) => {
  const r = await call("POST /v1/caregivers", w.managerA, { body: { organizationId: w.orgA, firstName: "Synthetic", lastName: `${last} ${randomUUID().slice(0, 4)}`, preferredName: null, status: "onboarding" } });
  expect(r.status).toBe(201);
  return r.body.caregiver.caregiverRecordId as string;
};
const path = (id: string) => ({ caregiverRecordId: id });
const item = (r: any, key: string) => r.items.find((i: any) => i.requirement === key);

describe("readiness and approval over HTTP", () => {
  it("reads need a signed-in office user of this agency; a caregiver is refused and another agency gets 404", async () => {
    const id = await newCaregiver("Read");
    const ok = await call("GET /v1/caregivers/{caregiverRecordId}/readiness", w.managerA, { path: path(id), query: { organizationId: w.orgA } });
    expect(ok.status).toBe(200);
    expect(ok.body.readiness).toMatchObject({ status: "not_ready", approved: false, canApprove: false, total: 5 });
    expect(ok.body.readiness.waitingOn).toEqual(["Background check", "Required training", "App sign-in"]);
    expect(ok.body.readiness.items.map((i: any) => i.requirement)).toEqual(["background", "training", "signin", "cpr", "tb"]);
    expect((await call("GET /v1/caregivers/{caregiverRecordId}/readiness", w.caregiverA1, { path: path(id), query: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("GET /v1/caregivers/{caregiverRecordId}/readiness", w.managerB, { path: path(id), query: { organizationId: w.orgA } })).status).toBe(404);
    expect((await call("GET /v1/caregivers/{caregiverRecordId}/readiness", w.managerA, { path: path("not-a-uuid"), query: { organizationId: w.orgA } })).status).toBe(400);
  });

  it("approve: needs an Idempotency-Key, names what is missing (409), is refused for a caregiver (403) and another agency (404), and writes nothing when refused", async () => {
    const id = await newCaregiver("Approve");
    const body = { organizationId: w.orgA };
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/approve", w.managerA, { path: path(id), body, key: null })).status).toBe(400);
    const refused = await call("POST /v1/caregivers/{caregiverRecordId}/approve", w.managerA, { path: path(id), body });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/^Cannot approve yet\. Waiting on: Background check, Required training, App sign-in$/);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/approve", w.caregiverA1, { path: path(id), body })).status).toBe(403);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/approve", w.managerB, { path: path(id), body })).status).toBe(404);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_work_approvals where caregiver_record_id = $1", [id])).rows[0].n).toBe(0);
  });

  it("the full path over HTTP: contact, sign-in link, sign-in, training, background clearance, then Approve for work once", async () => {
    const id = await newCaregiver("Full");
    const email = `full.${randomUUID().slice(0, 6)}@example.test`;
    // no email on file: the link cannot be sent and the response says why
    const none = await call("POST /v1/caregivers/{caregiverRecordId}/signin-link", w.managerA, { path: path(id), body: { organizationId: w.orgA } });
    expect(none.status).toBe(409);
    expect(none.body.error.message).toMatch(/Add an email address first/);
    expect(identity.calls).toHaveLength(0);
    // add the contact (validated; the response never echoes it)
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/contact", w.managerA, { path: path(id), body: { organizationId: w.orgA, email: "nope" } })).status).toBe(422);
    const saved = await call("POST /v1/caregivers/{caregiverRecordId}/contact", w.managerA, { path: path(id), body: { organizationId: w.orgA, email } });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(email);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/contact", w.caregiverA1, { path: path(id), body: { organizationId: w.orgA, email } })).status).toBe(403);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/contact", w.managerB, { path: path(id), body: { organizationId: w.orgA, email } })).status).toBe(404);
    // send: first an invitation, then a resend; a second send within a minute is refused
    const first = await call("POST /v1/caregivers/{caregiverRecordId}/signin-link", w.managerA, { path: path(id), body: { organizationId: w.orgA } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(identity.calls.map((c) => c.action)).toEqual(["invite"]);
    expect(JSON.stringify(first.body)).not.toContain(email);
    const tooSoon = await call("POST /v1/caregivers/{caregiverRecordId}/signin-link", w.managerA, { path: path(id), body: { organizationId: w.orgA } });
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.error.message).toMatch(/just sent/);
    await db.admin.query("update ogevia.caregiver_invitations set last_sent_at = now() - interval '2 minutes' where caregiver_record_id = $1", [id]);
    const again = await call("POST /v1/caregivers/{caregiverRecordId}/signin-link", w.managerA, { path: path(id), body: { organizationId: w.orgA } });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(identity.calls.map((c) => c.action)).toEqual(["invite", "resend"]);
    const mid = (await call("GET /v1/caregivers/{caregiverRecordId}/readiness", w.managerA, { path: path(id), query: { organizationId: w.orgA } })).body.readiness;
    expect(item(mid, "signin")).toMatchObject({ state: "unmet", detail: "Invited, has not signed in yet", nextAction: "resend_link" });
    expect(item(mid, "signin").extra.sendCount).toBe(2);
    // the list says whether a contact exists, never the address
    const listed = await call("GET /v1/caregivers", w.managerA, { query: { organizationId: w.orgA } });
    expect(listed.body.caregivers.find((c: any) => c.caregiverRecordId === id)).toMatchObject({ hasContact: true, signedIn: false, workStatus: "not_ready", readinessMet: 0, readinessTotal: 5 });
    // first sign-in, training, clearance
    const sub = identity.users.get(email)!.sub;
    expect((await handler(event("GET /v1/me", { sub }))).statusCode).toBe(200);
    await db.admin.query("update ogevia.caregiver_invitations set first_signed_in_at = now() where caregiver_record_id = $1", [id]);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/onboarding/items", w.managerA, { path: path(id), body: { organizationId: w.orgA, requirementKey: "training", action: "complete", completedOn: today } })).status).toBe(200);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/approve", w.managerA, { path: path(id), body: { organizationId: w.orgA } })).status).toBe(409); // still no background clearance
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/background-check/verify", w.managerA, { path: path(id), body: { organizationId: w.orgA, result: "approved", evidenceNote: "Synthetic" } })).status).toBe(403); // administrator only
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/background-check/verify", w.ownerA, { path: path(id), body: { organizationId: w.orgA, result: "approved", evidenceNote: "Synthetic clearance on file" } })).status).toBe(200);
    const approved = await call("POST /v1/caregivers/{caregiverRecordId}/approve", w.managerA, { path: path(id), body: { organizationId: w.orgA } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.readiness).toMatchObject({ approved: true, status: "approved", alreadyApproved: false, met: 3 });
    const double = await call("POST /v1/caregivers/{caregiverRecordId}/approve", w.managerA, { path: path(id), body: { organizationId: w.orgA } });
    expect(double.body.readiness).toMatchObject({ alreadyApproved: true });
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_work_approvals where caregiver_record_id = $1", [id])).rows[0].n).toBe(1);
    // a caregiver who has signed in cannot be sent another link
    const signed = await call("POST /v1/caregivers/{caregiverRecordId}/signin-link", w.managerA, { path: path(id), body: { organizationId: w.orgA } });
    expect(signed.status).toBe(409);
    expect(JSON.stringify(logs)).not.toContain(email);
  });
});

describe("CPR/TB extensions and the agency setting over HTTP", () => {
  it("extend: administrator only, valid requirement and date, a reason, a date after the current due date; the history lists it", async () => {
    const id = await newCaregiver("Extend");
    await db.admin.query("update ogevia.caregiver_records set hire_date = $2::date - 40 where id = $1", [id, today]);
    const ok = { organizationId: w.orgA, requirement: "cpr", newDueDate: await day(7), reason: "Waiting on the clinic (synthetic)" };
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/cpr-tb/extend", w.ownerA, { path: path(id), body: ok, key: null })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/cpr-tb/extend", w.ownerA, { path: path(id), body: { ...ok, requirement: "xyz" } })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/cpr-tb/extend", w.ownerA, { path: path(id), body: { ...ok, newDueDate: "2026-02-31" } })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/cpr-tb/extend", w.ownerA, { path: path(id), body: { ...ok, reason: " " } })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/cpr-tb/extend", w.ownerA, { path: path(id), body: { ...ok, newDueDate: await day(-20) } })).status).toBe(422);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/cpr-tb/extend", w.managerA, { path: path(id), body: ok })).status).toBe(403); // not an administrator
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/cpr-tb/extend", w.managerB, { path: path(id), body: ok })).status).toBe(404);
    const done = await call("POST /v1/caregivers/{caregiverRecordId}/cpr-tb/extend", w.ownerA, { path: path(id), body: ok });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(item(done.body.readiness, "cpr")).toMatchObject({ state: "pending", dueDate: await day(7) });
    const hist = await call("GET /v1/caregivers/{caregiverRecordId}/cpr-tb/extensions", w.managerA, { path: path(id), query: { organizationId: w.orgA } });
    expect(hist.body.extensions).toHaveLength(1);
    expect(hist.body.extensions[0]).toMatchObject({ requirement: "cpr", reason: "Waiting on the clinic (synthetic)" });
  });

  it("settings: anyone with compliance access reads; only an administrator changes it, with a reason and a whole number from 0 to 365", async () => {
    expect((await call("GET /v1/compliance/settings", w.managerA, { query: { organizationId: w.orgA } })).body.settings).toMatchObject({ cprTbDueDays: 30 });
    expect((await call("GET /v1/compliance/settings", w.caregiverA1, { query: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("GET /v1/compliance/settings", w.managerB, { query: { organizationId: w.orgA } })).status).toBe(404);
    const body = { organizationId: w.orgA, cprTbDueDays: 45, reason: "Owner decision (synthetic)" };
    expect((await call("POST /v1/compliance/settings", w.ownerA, { body, key: null })).status).toBe(400);
    expect((await call("POST /v1/compliance/settings", w.ownerA, { body: { ...body, cprTbDueDays: "abc" } })).status).toBe(400);
    expect((await call("POST /v1/compliance/settings", w.ownerA, { body: { ...body, cprTbDueDays: 1.5 } })).status).toBe(400);
    expect((await call("POST /v1/compliance/settings", w.ownerA, { body: { ...body, cprTbDueDays: 999 } })).status).toBe(422);
    expect((await call("POST /v1/compliance/settings", w.ownerA, { body: { ...body, reason: "" } })).status).toBe(400);
    expect((await call("POST /v1/compliance/settings", w.managerA, { body })).status).toBe(403);
    expect((await call("POST /v1/compliance/settings", w.managerB, { body })).status).toBe(404);
    const ok = await call("POST /v1/compliance/settings", w.ownerA, { body });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.settings).toMatchObject({ cprTbDueDays: 45 });
    expect((await call("GET /v1/compliance/settings", w.managerB, { query: { organizationId: w.orgB } })).body.settings).toMatchObject({ cprTbDueDays: 30 });
  });
});
