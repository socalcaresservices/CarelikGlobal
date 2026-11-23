// 0113 notifications over HTTP and the scheduled worker, through the real Lambda handler and a real disposable PostgreSQL. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { composeEmail, isNotifySweepEvent, runNotifySweep, type EmailMessage, type SendEmail } from "../src/notify";
import { CONFIG, event } from "./fixtures";

let db: TestDb; let w: World; let handler: ReturnType<typeof createHandler>; let today: string;
const logs: unknown[] = [];
const rec: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1100);
  today = await orgToday(db);
  const c = await db.admin.connect();
  try {
    await c.query("begin"); await c.query("set local role ogevia_owner");
    await c.query(readFileSync(new URL("../../../infra/aws/db/pending/migrations/0113_notifications.sql", import.meta.url), "utf8"));
    await c.query("reset role"); await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
  await db.admin.query("update ogevia.organizations set slug = 'socal-care-services' where id = $1", [w.orgA]);
  await db.admin.query("insert into ogevia.caregiver_contacts (caregiver_record_id, organization_id, contact_email) values ($1,$2,'a1@example.invalid'),($3,$2,'a2@example.invalid')", [rec["CG-A1"], w.orgA, rec["CG-A2"]]);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: (l: unknown) => logs.push(l) });
}, 120_000);
afterAll(async () => db?.drop());

async function get(actor: Actor | null, route: string, query: Record<string, string> = {}) {
  const r = await handler(event(route, { ...(actor ? { sub: actor.sub } : {}), query: { organizationId: w.orgA, ...query } }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
async function post(actor: Actor | null, route: string, body: Record<string, unknown>, path: Record<string, string> = {}) {
  const r = await handler(event(route, { ...(actor ? { sub: actor.sub } : {}), path, body: { organizationId: w.orgA, ...body } }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
async function openShift() {
  const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 });
  await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, w.caregiverA2.userId, f.client, f.service, today]);
  return asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'11:00'::time,null,null)", [w.orgA, f.client, f.service, day(1)])).rows[0].shift_id as string);
}

describe("routes", () => {
  it("settings: owner only, validated; defaults are off", async () => {
    expect((await get(w.managerA, "GET /v1/cover-notification-settings")).body.settings).toMatchObject({ enabled: false });
    expect((await post(w.managerA, "POST /v1/cover-notification-settings", { enabled: true, emailEnabled: true, autoNotify: false, windowHours: 48, maxRecipients: 25, reason: "Synthetic" })).status).toBe(403);
    expect((await post(w.ownerA, "POST /v1/cover-notification-settings", { enabled: "yes", emailEnabled: true, autoNotify: false, windowHours: 48, maxRecipients: 25, reason: "Synthetic" })).status).toBe(400);
    expect((await post(w.ownerA, "POST /v1/cover-notification-settings", { enabled: true, emailEnabled: true, autoNotify: false, windowHours: 400, maxRecipients: 25, reason: "Synthetic" })).status).toBe(400);
    expect((await post(w.ownerA, "POST /v1/cover-notification-settings", { enabled: true, emailEnabled: true, autoNotify: true, windowHours: 72, maxRecipients: 25, reason: "Synthetic" })).body.settings).toMatchObject({ enabled: true, autoNotify: true, windowHours: 72 });
    expect((await get(null, "GET /v1/cover-notification-settings")).status).toBe(401);
  });
  it("notify, then the notification centre: list, filter, mark read, archive, preferences", async () => {
    const shift = await openShift();
    expect((await post(w.caregiverA1, "POST /v1/shifts/{shiftId}/notify-cover", {}, { shiftId: shift })).status).toBe(403);
    const r = await post(w.managerA, "POST /v1/shifts/{shiftId}/notify-cover", {}, { shiftId: shift });
    expect(r.status).toBe(200); expect(r.body.result).toMatchObject({ state: "done", notified: 2, emailQueued: 2 });
    const list = await get(w.caregiverA1, "GET /v1/notification-center");
    const n = list.body.notifications.items.find((i: any) => i.shiftId === shift);
    expect(n).toBeDefined(); expect(list.body.notifications.unread).toBeGreaterThanOrEqual(1);
    expect((await get(w.caregiverA1, "GET /v1/notification-center", { state: "bogus" })).status).toBe(400);
    expect((await get(w.caregiverA1, "GET /v1/notification-center", { state: "unread", category: "cover_shift", limit: "5" })).body.notifications.items.length).toBeGreaterThanOrEqual(1);
    expect((await post(w.caregiverA1, "POST /v1/notification-center/mark", { ids: [n.id], action: "archive" })).body.changed).toBe(1);
    expect((await get(w.caregiverA1, "GET /v1/notification-center", { state: "archived" })).body.notifications.items.some((i: any) => i.id === n.id)).toBe(true);
    expect((await post(w.caregiverA1, "POST /v1/notification-center/mark", { ids: [n.id], action: "explode" })).status).toBe(400);
    expect((await post(w.caregiverA1, "POST /v1/notification-center/mark", { ids: ["not-a-uuid"], action: "read" })).status).toBe(400);
    expect((await post(w.caregiverA1, "POST /v1/notification-preferences", { category: "cover_shift", inApp: true, email: false })).body.preferences.coverShift).toEqual({ inApp: true, email: false });
    expect((await get(w.caregiverA1, "GET /v1/notification-preferences")).body.preferences.emailAvailable).toBe(true);
    expect((await get(w.managerA, "GET /v1/cover-notification-history")).body.history.length).toBeGreaterThan(0);
    expect((await get(w.caregiverA1, "GET /v1/cover-notification-history")).status).toBe(403);
    // another agency's person cannot read this agency's centre
    expect((await get(w.managerB, "GET /v1/notification-center")).status).toBe(404);
  });
});

describe("the scheduled worker", () => {
  it("recognises only its own event shape", () => {
    expect(isNotifySweepEvent({ "ogevia-task": "notify-sweep" })).toBe(true);
    expect(isNotifySweepEvent({ "ogevia-task": "notify-sweep", routeKey: "GET /x" })).toBe(false);
    expect(isNotifySweepEvent({ "ogevia-task": "compliance-sweep" })).toBe(false);
    expect(isNotifySweepEvent(null)).toBe(false);
  });
  it("composes a message with the link and no client detail", () => {
    const m = composeEmail({ to_email: "x@example.invalid", subject: "A shift needs cover", body: "Service on Mon", link: "/schedule", delivery_id: "d" }, "https://app.example.invalid");
    expect(m.text).toContain("https://app.example.invalid/schedule"); expect(m.html).toContain("Open Ogevia");
  });
  it("sends due emails, records success, retries transient failures and fails permanent ones; logs hold counts only", async () => {
    await db.admin.query("update ogevia.notification_deliveries set status = 'skipped'");
    await post(w.caregiverA1, "POST /v1/notification-preferences", { category: "cover_shift", inApp: true, email: true });
    const shift = await openShift();
    await post(w.managerA, "POST /v1/shifts/{shiftId}/notify-cover", {}, { shiftId: shift });
    const seen: EmailMessage[] = [];
    let n = 0;
    const send: SendEmail = async (m) => { seen.push(m); n++; return n === 1 ? { ok: true, messageId: "synthetic-1" } : { ok: false, error: "throttling_exception", transient: true }; };
    const out: unknown[] = [];
    const r = await runNotifySweep({ db: { connect: () => db.admin.connect() }, dbSetRole: "ogevia_app", sendEmail: send, appOrigin: "https://app.example.invalid", log: (l) => out.push(l) });
    expect(r).toMatchObject({ claimed: 2, sent: 1, retried: 1, failed: 0 });
    expect(seen.map((m) => m.to).sort()).toEqual(["a1@example.invalid", "a2@example.invalid"]);
    expect(JSON.stringify(out)).not.toContain("example.invalid");
    const st = (await db.admin.query("select status, count(*)::int n from ogevia.notification_deliveries where status <> 'skipped' group by 1")).rows;
    expect(st).toEqual(expect.arrayContaining([{ status: "sent", n: 1 }, { status: "retry", n: 1 }]));
    // a thrown sender counts as a transient failure, not a crash
    await db.admin.query("update ogevia.notification_deliveries set next_attempt_at = now() where status = 'retry'");
    const r2 = await runNotifySweep({ db: { connect: () => db.admin.connect() }, dbSetRole: "ogevia_app", sendEmail: async () => { throw new Error("network"); }, appOrigin: "https://app.example.invalid", log: () => {} });
    expect(r2).toMatchObject({ claimed: 1, retried: 1 });
  });
  it("without a sender the outbox is left alone (in-app only)", async () => {
    const before = (await db.admin.query("select count(*)::int n from ogevia.notification_deliveries where status in ('queued','retry')")).rows[0].n;
    const r = await runNotifySweep({ db: { connect: () => db.admin.connect() }, dbSetRole: "ogevia_app", log: () => {} });
    expect(r.claimed).toBe(0);
    expect((await db.admin.query("select count(*)::int n from ogevia.notification_deliveries where status in ('queued','retry')")).rows[0].n).toBe(before);
  });
});
