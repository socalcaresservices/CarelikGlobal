// 0113 notifications over HTTP and the scheduled worker, through the real Lambda handler and a real disposable PostgreSQL. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { composeEmail, isNotifySweepEvent, runNotifySweep, type EmailMessage, type SendEmail } from "../src/notify";
import { CONFIG, event } from "./fixtures";

let db: TestDb; let w: World; let handler: ReturnType<typeof createHandler>; let today: string; let temecula: string;
const logs: unknown[] = [];
const rec: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1100);
  today = await orgToday(db);
  const c = await db.admin.connect();
  try {
    await c.query("begin"); await c.query("set local role ogevia_owner");
    for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql", "0113_notifications.sql"]) await c.query(readFileSync(new URL(`../../../infra/aws/db/pending/migrations/${f}`, import.meta.url), "utf8"));
    await c.query("reset role"); await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
  await db.admin.query("update ogevia.organizations set slug = 'socal-care-services' where id = $1", [w.orgA]);
  await db.admin.query("insert into ogevia.caregiver_contacts (caregiver_record_id, organization_id, contact_email) values ($1,$2,'a1@example.invalid'),($3,$2,'a2@example.invalid')", [rec["CG-A1"], w.orgA, rec["CG-A2"]]);
  // one office, Temecula; the two caregivers work from it
  temecula = await asActor(db, w.ownerA.sub, async (c) => (await c.query("select ogevia_api.create_office($1,'Temecula Office',null) as id", [w.orgA])).rows[0].id as string);
  for (const code of ["CG-A1", "CG-A2"]) await asActor(db, w.managerA.sub, async (c) => c.query("select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [w.orgA, rec[code], temecula]));
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
async function openShift(service = true) {
  const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 });
  await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, w.caregiverA2.userId, f.client, f.service, today]);
  if (service) await db.admin.query("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596','Winchester',$3)", [w.orgA, f.client, w.managerA.userId]);
  return asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'11:00'::time,null,null)", [w.orgA, f.client, f.service, day(1)])).rows[0].shift_id as string);
}

describe("routes", () => {
  it("settings: owner only, validated; defaults are off", async () => {
    expect((await get(w.managerA, "GET /v1/cover-notification-settings")).body.settings).toMatchObject({ enabled: false });
    expect((await post(w.managerA, "POST /v1/cover-notification-settings", { enabled: true, emailEnabled: true, autoNotify: false, windowHours: 48, maxRecipients: 25, audience: "office", subjectTemplate: "Open shift in {city} | {date} | {time}", reason: "Synthetic" })).status).toBe(403);
    expect((await post(w.ownerA, "POST /v1/cover-notification-settings", { enabled: "yes", emailEnabled: true, autoNotify: false, windowHours: 48, maxRecipients: 25, audience: "office", subjectTemplate: "Open shift in {city} | {date} | {time}", reason: "Synthetic" })).status).toBe(400);
    expect((await post(w.ownerA, "POST /v1/cover-notification-settings", { enabled: true, emailEnabled: true, autoNotify: false, windowHours: 400, maxRecipients: 25, audience: "office", subjectTemplate: "Open shift in {city} | {date} | {time}", reason: "Synthetic" })).status).toBe(400);
    // the service city must stay in the subject; other tokens are refused; the audience is one of two words
    expect((await post(w.ownerA, "POST /v1/cover-notification-settings", { enabled: true, emailEnabled: false, autoNotify: false, windowHours: 48, maxRecipients: 25, audience: "office", subjectTemplate: "Open shift | {date} | {time}", reason: "Synthetic" })).status).toBe(422);
    expect((await post(w.ownerA, "POST /v1/cover-notification-settings", { enabled: true, emailEnabled: false, autoNotify: false, windowHours: 48, maxRecipients: 25, audience: "everyone", subjectTemplate: "Open shift in {city} | {date} | {time}", reason: "Synthetic" })).status).toBe(400);
    expect((await post(w.ownerA, "POST /v1/cover-notification-settings", { enabled: true, emailEnabled: true, autoNotify: true, windowHours: 72, maxRecipients: 25, audience: "office", subjectTemplate: "Open shift in {city} | {date} | {time}", reason: "Synthetic" })).body.settings).toMatchObject({ enabled: true, autoNotify: true, windowHours: 72 });
    expect((await get(null, "GET /v1/cover-notification-settings")).status).toBe(401);
  });
  it("notify, then the notification centre: list, filter, mark read, archive, preferences", async () => {
    const shift = await openShift();
    expect((await post(w.caregiverA1, "POST /v1/shifts/{shiftId}/notify-cover", {}, { shiftId: shift })).status).toBe(403);
    const r = await post(w.managerA, "POST /v1/shifts/{shiftId}/notify-cover", {}, { shiftId: shift });
    expect(r.status).toBe(200); expect(r.body.result).toMatchObject({ state: "done", notified: 2, emailQueued: 2, serviceCity: "Winchester", office: "Temecula Office" });
    expect(r.body.result.subject).toMatch(/^Open shift in Winchester \| /);
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

describe("open-shift alert blocks and the office choice (HTTP)", () => {
  it("an incomplete service address blocks the alert with the client to fix; a second office makes the sender choose, and the choice is accepted", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 });
    const shift = await asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'11:00'::time,null,null)", [w.orgA, f.client, f.service, day(2)])).rows[0].shift_id as string);
    const blocked = await post(w.managerA, "POST /v1/shifts/{shiftId}/notify-cover", {}, { shiftId: shift });
    expect(blocked.body.result).toMatchObject({ state: "address_incomplete", clientId: f.client, missing: ["city", "zip"] });
    await db.admin.query("update ogevia.clients set city = 'Winchester' where id = $1", [f.client]);
    await db.admin.query("insert into ogevia.client_service_zip (organization_id, client_id, zip, set_by) values ($1,$2,'92596',$3)", [w.orgA, f.client, w.managerA.userId]);
    const corona = await asActor(db, w.ownerA.sub, async (c) => (await c.query("select ogevia_api.create_office($1,'Corona Office',null) as id", [w.orgA])).rows[0].id as string);
    const needs = await post(w.managerA, "POST /v1/shifts/{shiftId}/notify-cover", {}, { shiftId: shift });
    expect(needs.body.result.state).toBe("office_required"); expect(needs.body.result.offices.map((o: any) => o.name).sort()).toEqual(["Corona Office", "Temecula Office"]);
    expect((await post(w.managerA, "POST /v1/shifts/{shiftId}/notify-cover", { officeId: "not-a-uuid" }, { shiftId: shift })).status).toBe(400);
    const sent = await post(w.managerA, "POST /v1/shifts/{shiftId}/notify-cover", { officeId: temecula }, { shiftId: shift });
    expect(sent.body.result).toMatchObject({ state: "done", office: "Temecula Office", serviceCity: "Winchester" });
    expect(corona).toBeTruthy();
  });
  it("office audience routes: the owner sets an override, a manager cannot, and the list shows it", async () => {
    expect((await post(w.managerA, "POST /v1/offices/{officeId}/cover-audience", { audience: "none", reason: "Synthetic" }, { officeId: temecula })).status).toBe(403);
    expect((await post(w.ownerA, "POST /v1/offices/{officeId}/cover-audience", { audience: "sometimes", reason: "Synthetic" }, { officeId: temecula })).status).toBe(400);
    expect((await post(w.ownerA, "POST /v1/offices/{officeId}/cover-audience", { audience: "none", reason: "Synthetic" }, { officeId: temecula })).status).toBe(200);
    expect((await get(w.managerA, "GET /v1/cover-office-audiences")).body.offices.find((o: any) => o.officeId === temecula)).toMatchObject({ audienceOverride: "none" });
    expect((await post(w.ownerA, "POST /v1/offices/{officeId}/cover-audience", { audience: null, reason: "Synthetic: restore" }, { officeId: temecula })).status).toBe(200);
  });
});

describe("service address rules on the client routes (COVER_ALERT_ADDRESS_RULES=on)", () => {
  const created: string[] = [];
  it("create needs the service city and a 5-digit ZIP and stores both; with the rules off nothing changes", async () => {
    const client = (body: Record<string, unknown>) => post(w.ownerA, "POST /v1/clients", { firstName: "Synthetic", lastName: `Client${created.length + 1}`, ...body });
    expect((await client({ city: "Winchester" })).status).toBe(201);   // rules OFF (default): city only, as before
    process.env.COVER_ALERT_ADDRESS_RULES = "on";
    try {
      expect((await client({ city: "Winchester" })).status).toBe(400);                      // ZIP missing
      expect((await client({ serviceZip: "92596" })).status).toBe(400);                      // city missing
      expect((await client({ city: "Winchester", serviceZip: "9259" })).status).toBe(400);   // not 5 digits
      const ok = await client({ city: "Winchester", serviceZip: "92596" });
      expect(ok.status).toBe(201);
      const id = ok.body.client.clientId as string;
      expect((await db.admin.query("select zip, city from ogevia.client_service_zip where client_id = $1", [id])).rows[0]).toEqual({ zip: "92596", city: "Winchester" });
      created.push(id);
    } finally { delete process.env.COVER_ALERT_ADDRESS_RULES; }
  });
  it("editing needs the city and a ZIP (sent, or already on the record); the zip route needs the city", async () => {
    const id = created[0]!;
    process.env.COVER_ALERT_ADDRESS_RULES = "on";
    try {
      const edit = (body: Record<string, unknown>) => post(w.ownerA, "POST /v1/clients/{clientId}/details", { firstName: "Synthetic", lastName: "Client1", ...body }, { clientId: id });
      expect((await edit({})).status).toBe(400);                                                       // no city
      expect((await edit({ city: "Murrieta" })).status).toBe(200);                                       // the ZIP is already on the record
      const noZip = await post(w.ownerA, "POST /v1/clients", { firstName: "Synthetic", lastName: "Old", city: "Perris" });   // rules were ON for the call? no: simulate an old client
      expect(noZip.status).toBe(400);
      await db.admin.query("insert into ogevia.clients (organization_id, client_code, city) values ($1,'CL-OLD00000001','Perris')", [w.orgA]);
      const old = (await db.admin.query("select id from ogevia.clients where client_code = 'CL-OLD00000001'")).rows[0].id as string;
      await db.admin.query("insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by) values ($1,$2,'Synthetic','Old',$3)", [old, w.orgA, w.ownerA.userId]);
      expect((await post(w.ownerA, "POST /v1/clients/{clientId}/details", { firstName: "Synthetic", lastName: "Old", city: "Perris" }, { clientId: old })).status).toBe(400);   // existing client with no ZIP: refused until completed
      expect((await post(w.ownerA, "POST /v1/clients/{clientId}/details", { firstName: "Synthetic", lastName: "Old", city: "Perris", serviceZip: "92570" }, { clientId: old })).status).toBe(200);
      expect((await post(w.ownerA, "POST /v1/clients/{clientId}/zip", { zip: "92570" }, { clientId: old })).status).toBe(400);   // zip route without the city
      expect((await post(w.ownerA, "POST /v1/clients/{clientId}/zip", { zip: "92570", city: "Perris" }, { clientId: old })).status).toBe(200);
    } finally { delete process.env.COVER_ALERT_ADDRESS_RULES; }
  });
});


describe("list payloads are camelCase (what the web reads)", () => {
  it("the history and the office audiences use camelCase keys", async () => {
    const h = (await get(w.managerA, "GET /v1/cover-notification-history")).body.history[0];
    expect(Object.keys(h)).toEqual(expect.arrayContaining(["notificationId", "shiftId", "caregiverCode", "createdAt", "inApp", "emailStatus", "emailAttempts"]));
    expect(JSON.stringify(h)).not.toMatch(/_[a-z]/);
    expect(Object.keys((await get(w.managerA, "GET /v1/cover-office-audiences")).body.offices[0])).toEqual(["officeId", "officeName", "audienceOverride"]);
  });
});
