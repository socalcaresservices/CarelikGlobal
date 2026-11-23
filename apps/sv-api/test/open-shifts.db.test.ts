// Open Shifts through the real Lambda handler, the SMS worker (mock transport) and a disposable PostgreSQL. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { awsEndUserMessagingTransport, isCoverageSmsEvent, MockSmsTransport, runCoverageSms, smsSegments, SmsTransportError } from "../src/sms";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let today: string;
let handler: ReturnType<typeof createHandler>;
const rec: Record<string, string> = {};
const SENDER = "+18885550111";
const origin = "https://test.ogevia.example";

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
  await db.admin.query("update ogevia.organizations set slug = 'socal-care-services', display_name = 'SoCal Care Services' where id = $1", [w.orgA]);
  await db.admin.query("update ogevia.agency_open_shift_settings set sms_entitled = true, sender_status = 'verified', sender_number = $2, sms_enabled = true, quiet_bypass = true where organization_id = $1", [w.orgA, SENDER]);
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any>, raw: r.body };
}
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const worker = (transport: MockSmsTransport, extra: Partial<Parameters<typeof runCoverageSms>[0]> = {}) =>
  runCoverageSms({ db: { connect: () => db.admin.connect() }, dbSetRole: "ogevia_app", transport, appOrigin: origin, log: () => {}, ...extra });

async function posted(city = "Winchester", d = day(3), start = "09:00", end = "10:30") {
  const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 60, after: 60 });
  await db.admin.query("update ogevia.clients set city = $2 where id = $1", [f.client, city]);
  const shift = await asActor(db, w.managerA.sub, async (c) =>
    (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,null)", [w.orgA, f.client, f.service, d, start, end])).rows[0].shift_id as string);
  const r = await call("POST /v1/shifts/{shiftId}/post-coverage", w.managerA, { path: { shiftId: shift }, body: { organizationId: w.orgA } });
  expect(r.status, r.raw).toBe(200);
  const ref = (await db.admin.query("select public_ref from ogevia.shifts where id = $1", [shift])).rows[0].public_ref as string;
  return { f, shift, ref };
}

describe("setup through the API", () => {
  it("cities, consent and settings are set through the routes with the right permissions", async () => {
    for (const cg of ["CG-A2", "CG-A3"]) {
      const r = await call("POST /v1/caregivers/{caregiverRecordId}/coverage-cities", w.managerA, { path: { caregiverRecordId: rec[cg]! }, body: { organizationId: w.orgA, cities: [{ city: "Winchester", state: "CA" }] } });
      expect(r.status, r.raw).toBe(200);
    }
    const denied = await call("POST /v1/caregivers/{caregiverRecordId}/coverage-cities", w.caregiverA2, { path: { caregiverRecordId: rec["CG-A2"]! }, body: { organizationId: w.orgA, cities: [{ city: "Anywhere" }] } });
    expect(denied.status).toBe(403);
    expect((await call("POST /v1/my-sms-consent", w.caregiverA2, { body: { organizationId: w.orgA, phone: "(310) 555-0112", optIn: true } })).status).toBe(200);
    const mine = await call("GET /v1/my-sms-consent", w.caregiverA2, { query: { organizationId: w.orgA } });
    expect(mine.body.consent).toMatchObject({ status: "opted_in", phoneMasked: "***0112" });
    expect(mine.raw).not.toContain("3105550112");
    expect((await call("POST /v1/open-shift-settings", w.managerA, { body: { organizationId: w.orgA, monthlySendLimit: 5 } })).status).toBe(403); // owner only
    const ok = await call("POST /v1/open-shift-settings", w.ownerA, { body: { organizationId: w.orgA, monthlySendLimit: 50 } });
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.body.settings).toMatchObject({ monthlySendLimit: 50, smsAvailable: true, senderStatus: "verified" });
    expect(ok.raw).not.toContain(SENDER); // the sender number is not shown to the agency screen
  });
});

describe("caregiver board API: privacy and the same answer for what they may not see (acceptance 1, 6)", () => {
  it("lists city and time only; no client id, code, name, address or other caregiver appears in the list, the link landing or an error", async () => {
    const { f, shift, ref } = await posted();
    const list = await call("GET /v1/open-shift-board", w.caregiverA2, { query: { organizationId: w.orgA } });
    expect(list.status, list.raw).toBe(200);
    const mine = list.body.shifts.find((s: any) => s.shiftRef === ref);
    expect(mine).toMatchObject({ serviceCity: "Winchester", myRequestStatus: null });
    expect(Object.keys(mine).sort()).toEqual(["endsAt", "myRequestStatus", "serviceCity", "shiftRef", "startsAt", "timezone", "totalCount"]);
    const code = (await db.admin.query("select client_code from ogevia.clients where id = $1", [f.client])).rows[0].client_code as string;
    for (const text of [list.raw, (await call("GET /v1/open-shift-board/{shiftRef}", w.caregiverA2, { path: { shiftRef: ref }, query: { organizationId: w.orgA } })).raw]) {
      expect(text).not.toContain(f.client);
      expect(text).not.toContain(shift);
      if (code) expect(text).not.toContain(code);
    }
    // a caregiver who covers other cities, another agency's caregiver and a stranger all get the same refusal text as for a shift that never existed
    const none = await call("POST /v1/open-shift-board/{shiftRef}/request", w.caregiverA1, { path: { shiftRef: randomUUID() }, body: { organizationId: w.orgA }, key: randomUUID() });
    const other = await call("POST /v1/open-shift-board/{shiftRef}/request", w.caregiverA1, { path: { shiftRef: ref }, body: { organizationId: w.orgA }, key: randomUUID() });
    expect(other.status).toBe(none.status);
    expect(other.body.error.message).toBe(none.body.error.message);
    const foreign = await call("POST /v1/open-shift-board/{shiftRef}/request", w.caregiverB1, { path: { shiftRef: ref }, body: { organizationId: w.orgB }, key: randomUUID() });
    expect(foreign.body.error.message).toBe(none.body.error.message);
    const crossTenant = await call("GET /v1/open-shift-board/{shiftRef}", w.caregiverB1, { path: { shiftRef: ref }, query: { organizationId: w.orgA } });
    expect([403, 404]).toContain(crossTenant.status);
  });

  it("request, withdraw and the office's ordered approval work end to end; the approved caregiver gets only normal assigned-shift access", async () => {
    const { shift, ref } = await posted("Winchester", day(7), "13:00", "14:30");
    const req = await call("POST /v1/open-shift-board/{shiftRef}/request", w.caregiverA2, { path: { shiftRef: ref }, body: { organizationId: w.orgA }, key: randomUUID() });
    expect(req.status, req.raw).toBe(200);
    expect(req.body).toMatchObject({ requestState: "requested" });
    await call("POST /v1/open-shift-board/{shiftRef}/request", w.caregiverA3, { path: { shiftRef: ref }, body: { organizationId: w.orgA }, key: randomUUID() });
    const wd = await call("POST /v1/open-shift-board/{shiftRef}/withdraw", w.caregiverA3, { path: { shiftRef: ref }, body: { organizationId: w.orgA } });
    expect(wd.body).toMatchObject({ requestState: "withdrawn" });
    const queue = await call("GET /v1/coverage-queue/{shiftId}/requests", w.managerA, { path: { shiftId: shift }, query: { organizationId: w.orgA } });
    expect(queue.body.requests).toHaveLength(1);
    expect(queue.body.requests[0]).toMatchObject({ orderPosition: 1, eligible: true, preselected: true });
    expect((await call("GET /v1/coverage-queue", w.caregiverA2, { query: { organizationId: w.orgA } })).body.items ?? []).toEqual([]);
    const approve = await call("POST /v1/coverage-requests/{requestId}/confirm", w.managerA, { path: { requestId: queue.body.requests[0].requestId }, body: { organizationId: w.orgA }, key: randomUUID() });
    expect(approve.status, approve.raw).toBe(200);
    const mineAfter = await call("GET /v1/my-open-shift-requests", w.caregiverA2, { query: { organizationId: w.orgA } });
    expect(mineAfter.body.requests.find((r: any) => r.shiftRef === ref)).toMatchObject({ outcome: "confirmed" });
    const shifts = await call("GET /v1/my-shifts", w.caregiverA2, { query: { organizationId: w.orgA } });
    expect(JSON.stringify(shifts.body)).toContain(shift);
  });
});

describe("the SMS worker with a mock transport (acceptance 4, 5, 7)", () => {
  it("sends one text per eligible opted-in caregiver with the signed-in link, never client details; a second run sends nothing more", async () => {
    await call("POST /v1/my-sms-consent", w.caregiverA3, { body: { organizationId: w.orgA, phone: "310-555-0113", optIn: true } });
    const { shift, ref } = await posted("Winchester", day(4), "09:00", "10:30");
    const t = new MockSmsTransport();
    const first = await worker(t, { allowlist: new Set(["+13105550112", "+13105550113"]) });
    expect(first.accepted).toBeGreaterThanOrEqual(2);
    const mine = t.sent.filter((m) => m.body.includes(ref));
    expect(mine.map((m) => m.to).sort()).toEqual(["+13105550112", "+13105550113"]);
    for (const m of mine) {
      expect(m.from).toBe(SENDER);
      expect(m.body).toMatch(/^SoCal Care Services: Open shift in Winchester, /);
      expect(m.body).toContain(`${origin}/open-shifts?ref=${ref}`);
      expect(m.body).not.toMatch(/Synthetic|\bclient\b/i);
    }
    const second = await worker(new MockSmsTransport());
    expect(second.claimed).toBe(0);
    expect((await db.admin.query("select status, segments from ogevia.notification_jobs where shift_id = $1 and purpose = 'open_shift'", [shift])).rows.every((r) => r.status === "accepted" && r.segments >= 1)).toBe(true);
    // the opened link, signed in, lands on the right opening
    const landing = await call("GET /v1/open-shift-board/{shiftRef}", w.caregiverA2, { path: { shiftRef: ref }, query: { organizationId: w.orgA } });
    expect(landing.body.opening).toMatchObject({ state: "available", serviceCity: "Winchester" });
  });

  it("a number outside the TEST allowlist is never texted; a transient failure retries later; a timeout is unknown and is not retried; a permanent failure leaves the opening on the board", async () => {
    const a = await posted("Winchester", day(5), "09:00", "10:30");
    const t0 = new MockSmsTransport();
    const r0 = await worker(t0, { allowlist: new Set(["+13105550999"]) });
    expect(t0.sent).toEqual([]);
    expect(r0.failed).toBeGreaterThanOrEqual(2);
    const b = await posted("Winchester", day(5), "11:00", "12:30");
    const t1 = new MockSmsTransport();
    t1.failWith = new SmsTransportError("transient", "Throttling");
    const r1 = await worker(t1);
    expect(r1.retryLater).toBeGreaterThanOrEqual(2);
    await db.admin.query("update ogevia.notification_jobs set not_before = now() where shift_id = $1", [b.shift]);
    const t2 = new MockSmsTransport();
    t2.failWith = new SmsTransportError("unknown", "Timeout");
    const r2 = await worker(t2);
    expect(r2.unknown).toBeGreaterThanOrEqual(2);
    await db.admin.query("update ogevia.notification_jobs set not_before = now() where shift_id = $1", [b.shift]);
    const t3 = new MockSmsTransport();
    expect((await worker(t3)).claimed).toBe(0); // unknown is never re-sent
    expect((await db.admin.query("select count(*)::int n from ogevia.notification_jobs where shift_id = $1 and status = 'unknown'", [b.shift])).rows[0].n).toBeGreaterThanOrEqual(2);
    for (const x of [a, b]) {
      const board = await call("GET /v1/open-shift-board", w.caregiverA2, { query: { organizationId: w.orgA, limit: "200" } });
      expect(board.body.shifts.map((s: any) => s.shiftRef)).toContain(x.ref);
    }
    const queue = await call("GET /v1/coverage-queue", w.managerA, { query: { organizationId: w.orgA } });
    const row = queue.body.items.find((i: any) => i.shiftId === b.shift);
    expect(row.delivery.unknown).toBeGreaterThanOrEqual(2);
  });

  it("claims are exclusive: two workers at once never send the same job twice", async () => {
    const { ref } = await posted("Winchester", day(6), "09:00", "10:30");
    const ta = new MockSmsTransport();
    const tb = new MockSmsTransport();
    await Promise.all([worker(ta), worker(tb)]);
    const sent = [...ta.sent, ...tb.sent].filter((m) => m.body.includes(ref));
    expect(new Set(sent.map((m) => m.to)).size).toBe(sent.length);
  });

  it("the task event cannot be produced by an HTTP request, and the worker refuses a malformed origin", async () => {
    expect(isCoverageSmsEvent({ "ogevia-task": "coverage-sms" })).toBe(true);
    expect(isCoverageSmsEvent({ "ogevia-task": "coverage-sms", routeKey: "GET /x" })).toBe(false);
    expect(isCoverageSmsEvent({ "ogevia-task": "coverage-sms", requestContext: {} })).toBe(false);
    await expect(worker(new MockSmsTransport(), { appOrigin: "javascript:alert(1)" })).rejects.toThrow(/APP_ORIGIN/);
  });
});

describe("transport and segment helpers", () => {
  it("counts GSM-7 and Unicode segments; the AWS transport maps provider errors without leaking message text", async () => {
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("é".repeat(70))).toBe(1);
    expect(smsSegments("日".repeat(71))).toBe(2);
    const sample = "SoCal Care Services: Open shift in Winchester, Fri Nov 27, 1:30-5:00 PM. Request in Ogevia: https://app.ogevia.com/open-shifts?ref=00000000-0000-0000-0000-000000000000 Reply STOP to opt out.";
    expect(smsSegments(sample)).toBe(2); // the first message to a number is two segments; later ones are one (cost note in the release docs)
    const mk = (err: unknown) => awsEndUserMessagingTransport({ send: async () => { throw err; } }, (x) => x);
    const msg = { to: "+13105550112", from: SENDER, body: "x", idempotencyToken: "t" };
    await expect(mk(Object.assign(new Error("secret text"), { name: "ThrottlingException" })).send(msg)).rejects.toMatchObject({ kind: "transient", code: "ThrottlingException" });
    await expect(mk(Object.assign(new Error("secret text"), { name: "ValidationException" })).send(msg)).rejects.toMatchObject({ kind: "permanent" });
    await expect(mk(Object.assign(new Error("secret text"), { name: "TimeoutError" })).send(msg)).rejects.toMatchObject({ kind: "unknown" });
    const ok = awsEndUserMessagingTransport({ send: async () => ({ MessageId: "abc" }) }, (x) => x);
    expect(await ok.send(msg)).toEqual({ messageId: "abc" });
  });
});
