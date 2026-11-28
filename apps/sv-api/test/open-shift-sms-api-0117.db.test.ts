// 0117 texting over HTTP (real Lambda handler) and through the scheduled worker with the MOCK sender, on a real disposable PostgreSQL. SYNTHETIC data only. Nothing is sent anywhere.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { runNotifySweep } from "../src/notify";
import { createSmsSender, MockSmsSender, runSmsSweep } from "../src/sms";
import { loadConfig } from "../src/config";
import { CONFIG, event } from "./fixtures";

let db: TestDb; let w: World; let handler: ReturnType<typeof createHandler>; let today: string; let temecula: string;
const rec: Record<string, string> = {};
const logs: string[] = [];
beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1190); today = await orgToday(db);
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner");
    for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql", "0113_notifications.sql", "0117_open_shift_sms.sql"]) await c.query(readFileSync(new URL(`../../../infra/aws/db/pending/migrations/${f}`, import.meta.url), "utf8"));
    await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
  temecula = await asActor(db, w.ownerA.sub, async (c) => (await c.query("select ogevia_api.create_office($1,'Temecula Office',null) as id", [w.orgA])).rows[0].id as string);
  for (const code of ["CG-A1", "CG-A2"]) await asActor(db, w.managerA.sub, async (c) => c.query("select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [w.orgA, rec[code], temecula]));
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: (l: unknown) => logs.push(JSON.stringify(l)) });
}, 120_000);
afterAll(async () => db?.drop());

async function get(actor: Actor | null, route: string, query: Record<string, string> = {}) {
  const r = await handler(event(route, { ...(actor ? { sub: actor.sub } : {}), query: { organizationId: w.orgA, ...query } }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
async function post(actor: Actor | null, route: string, body: Record<string, unknown>) {
  const r = await handler(event(route, { ...(actor ? { sub: actor.sub } : {}), body: { organizationId: w.orgA, ...body } }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const SETTINGS = { enabled: true, provider: "mock", senderLabel: "SoCal Care", senderId: "+19515550100", dailyLimit: 200, hourlyLimit: 60, perRecipientDaily: 3, quietStart: "21:00", quietEnd: "08:00", recruitmentDays: 14, escalationHours: 24,
  recruitOn: true, receiptOn: true, cancelOn: true, confirmOn: true, officeOn: true };
const dbSource = { connect: () => db.admin.connect() } as any;

describe("texting routes", () => {
  it("settings: off by default, owner only, validated; a live sender needs a number; nothing live is possible", async () => {
    expect((await get(w.managerA, "GET /v1/sms-settings")).body.settings).toMatchObject({ enabled: false, provider: "mock", dailyLimit: 200, recruitmentDays: 14, escalationHours: 24, liveSending: false });
    expect((await get(w.caregiverA1, "GET /v1/sms-settings")).status).toBe(403);
    expect((await get(null, "GET /v1/sms-settings")).status).toBe(401);
    expect((await post(w.managerA, "POST /v1/sms-settings", SETTINGS)).status).toBe(403);
    expect((await post(w.ownerA, "POST /v1/sms-settings", { ...SETTINGS, recruitmentDays: 15 })).status).toBe(400);
    expect((await post(w.ownerA, "POST /v1/sms-settings", { ...SETTINGS, quietStart: "25:99" })).status).toBeGreaterThanOrEqual(400);
    expect((await post(w.ownerA, "POST /v1/sms-settings", { ...SETTINGS, senderId: "95155" })).status).toBeGreaterThanOrEqual(400);
    expect((await post(w.ownerA, "POST /v1/sms-settings", { ...SETTINGS, provider: "live", senderId: "" })).status).toBeGreaterThanOrEqual(400);
    const ok = await post(w.ownerA, "POST /v1/sms-settings", SETTINGS);
    expect(ok.status).toBe(200); expect(ok.body.settings).toMatchObject({ enabled: true, senderLabel: "SoCal Care", quietStart: "21:00", quietEnd: "08:00", liveSending: false });
    expect((await db.admin.query("select action from ogevia.audit_events where organization_id = $1 and action = 'sms_settings.updated'", [w.orgA])).rowCount).toBe(1);
    expect(JSON.stringify((await db.admin.query("select before_state, after_state from ogevia.audit_events where action = 'sms_settings.updated'")).rows)).not.toContain("+1951555");   // the sender number is not in the audit trail
  });
  it("my texting: a caregiver opts in with their own number and can opt out; the number is never echoed back in full", async () => {
    expect((await get(w.caregiverA1, "GET /v1/my-sms")).body.sms).toMatchObject({ available: true, status: "none" });
    expect((await post(w.caregiverA1, "POST /v1/my-sms", { consent: true, phone: "12" })).status).toBeGreaterThanOrEqual(400);
    const r = await post(w.caregiverA1, "POST /v1/my-sms", { consent: true, phone: "(951) 555-0101" });
    expect(r.status).toBe(200); expect(r.body.sms).toMatchObject({ status: "opted_in", phoneLast4: "0101" });
    expect(JSON.stringify(r.body)).not.toContain("5550101");
    expect((await post(w.caregiverA2, "POST /v1/my-sms", { consent: true, phone: "951-555-0102" })).status).toBe(200);
    const off = await post(w.caregiverA2, "POST /v1/my-sms", { consent: false });
    expect(off.body.sms).toMatchObject({ status: "opted_out" });
    await post(w.caregiverA2, "POST /v1/my-sms", { consent: true, phone: "951-555-0102" });
    expect((await post(w.caregiverA1, "POST /v1/my-sms", { phone: "9515550101" })).status).toBe(400);        // consent must be an explicit yes/no
  });
  it("on-call numbers: owner adds and removes; the list shows only the last four digits", async () => {
    expect((await post(w.managerA, "POST /v1/sms-oncall", { action: "add", officeId: temecula, label: "On-call", phone: "9515550199" })).status).toBe(403);
    expect((await post(w.ownerA, "POST /v1/sms-oncall", { action: "add", officeId: temecula, label: "On-call Temecula", phone: "951-555-0199" })).status).toBe(200);
    expect((await post(w.ownerA, "POST /v1/sms-oncall", { action: "add", officeId: temecula, label: "Dupe", phone: "951-555-0199" })).status).toBeGreaterThanOrEqual(400);
    const list = await get(w.managerA, "GET /v1/sms-oncall");
    expect(list.body.contacts).toHaveLength(1); expect(list.body.contacts[0]).toMatchObject({ label: "On-call Temecula", phoneLast4: "0199", officeName: "Temecula Office" });
    expect(JSON.stringify(list.body)).not.toContain("5550199");
    expect((await get(w.caregiverA1, "GET /v1/sms-oncall")).body.contacts).toEqual([]);   // a caregiver sees nothing
  });
});

describe("the worker with the mock sender", () => {
  async function openShift() {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 });
    await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, w.caregiverA2.userId, f.client, f.service, today]);
    await db.admin.query("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596','Winchester',$3)", [w.orgA, f.client, w.managerA.userId]);
    const d = new Date(Date.parse(`${today}T12:00:00Z`) + 2 * 864e5).toISOString().slice(0, 10);
    const shift = await asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'09:50'::time,null,null)", [w.orgA, f.client, f.service, d])).rows[0].shift_id as string);
    await db.admin.query("update ogevia.shifts set coordinating_office_id = $2 where id = $1", [shift, temecula]);
    return shift;
  }
  it("sends the queued recruitment text through the sender once, records it, and never logs a number or message", async () => {
    await post(w.ownerA, "POST /v1/cover-notification-settings", { enabled: true, emailEnabled: false, autoNotify: true, windowHours: 72, maxRecipients: 50, audience: "office", subjectTemplate: "Open shift in {city} | {date} | {time}", reason: "test" });
    await db.admin.query("update ogevia.sms_settings set quiet_start = '00:00', quiet_end = '00:00' where organization_id = $1", [w.orgA]);   // quiet hours off for this run
    await db.admin.query("update ogevia.caregiver_records set status = 'active' where organization_id = $1", [w.orgA]);
    const shift = await openShift();
    const sender = new MockSmsSender(); logs.length = 0;
    const r = await runNotifySweep({ db: dbSource, sms: sender, log: (l) => logs.push(JSON.stringify(l)) });
    expect(r.smsSent).toBeGreaterThanOrEqual(1);
    const mine = sender.sent.filter((m) => /Open shift in Winchester/.test(m.body));
    expect(mine.length).toBeGreaterThanOrEqual(1);
    for (const m of mine) { expect(m.to).toMatch(/^\+1951555010[12]$/); expect(m.from).toBe("+19515550100"); expect(m.body).toContain("Reply STOP to opt out."); }
    expect((await db.admin.query("select status, provider_message_id from ogevia.sms_messages where shift_id = $1 and purpose = 'recruitment'", [shift])).rows.every((x: any) => x.status === "sent" && /^mock-/.test(x.provider_message_id))).toBe(true);
    expect(logs.join("\n")).not.toMatch(/\+1951|Winchester|Request it in Ogevia/);                      // counts only
    const again = await runNotifySweep({ db: dbSource, sms: sender, log: () => undefined });
    expect(again.smsSent).toBe(0);                                                                      // nothing is sent twice
    expect(sender.sent.length).toBe(mine.length);
  });
  it("a failing sender retries on the schedule and then fails; a 'live' agency setting is never sent by the mock", async () => {
    await db.admin.query("update ogevia.sms_messages set status = 'cancelled' where organization_id = $1 and status in ('queued','retry','sending')", [w.orgA]);
    await db.admin.query("select ogevia.sms_enqueue($1,'recruitment','caregiver',$2,null,null,0,'hello','retry-1', now())", [w.orgA, w.caregiverA1.userId]);
    const sender = new MockSmsSender(); sender.failWith = { error: "provider_busy", transient: true };
    const a = await runSmsSweep({ db: dbSource, sender, log: () => undefined });
    expect(a).toMatchObject({ claimed: 1, sent: 0, retried: 1 });
    expect((await db.admin.query("select status, attempts, reason, send_after > now() as later from ogevia.sms_messages where dedupe_key = 'retry-1'")).rows[0]).toMatchObject({ status: "retry", attempts: 1, reason: "provider_busy", later: true });
    expect((await runSmsSweep({ db: dbSource, sender, log: () => undefined })).claimed).toBe(0);        // not due yet
    await db.admin.query("update ogevia.sms_settings set provider = 'live' where organization_id = $1", [w.orgA]);
    await db.admin.query("update ogevia.sms_messages set send_after = now() - interval '1 minute' where dedupe_key = 'retry-1'");
    const ok = new MockSmsSender();
    expect(await runSmsSweep({ db: dbSource, sender: ok, log: () => undefined })).toMatchObject({ claimed: 1, sent: 0, failed: 1 });   // the agency chose 'live', the mock is the only sender: refused, recorded, never sent
    expect(ok.sent).toHaveLength(0);
    expect((await db.admin.query("select status, reason from ogevia.sms_messages where dedupe_key = 'retry-1'")).rows[0]).toEqual({ status: "failed", reason: "live_not_enabled" });
  });
  it("only the mock exists: SMS_MODE=live is refused at startup; an unset mode means no texting at all", () => {
    expect(createSmsSender(undefined)).toBeUndefined();
    expect(createSmsSender("mock")).toBeInstanceOf(MockSmsSender);
    expect(() => loadConfig({ ...(process.env as Record<string, string>), SMS_MODE: "live" } as any)).toThrow();
  });
});
