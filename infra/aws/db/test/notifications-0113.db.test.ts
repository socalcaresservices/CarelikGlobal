// 0113 (PENDING): cover-shift notifications, the notification centre, preferences, the email outbox with retry, and the audit trail. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const UP = new URL("../pending/migrations/0113_notifications.sql", import.meta.url);
const DOWN = new URL("../pending/rollback/0113_notifications.down.sql", import.meta.url);
let db: TestDb; let w: World; let today: string;
const rec: Record<string, string> = {};

const runSql = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const q = (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const admin = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows as any[];
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
let next = 2;
type Fx = { client: string; service: string; auth: string };
async function fixture(caregivers: Actor[] = [w.caregiverA1, w.caregiverA2]): Promise<Fx> {
  const f = await freshClient(db, w, caregivers[0]!, 20000, w.orgA, { before: 40, after: 40 });
  for (const a of caregivers.slice(1)) {
    await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, a.userId, f.client, f.service, today]);
  }
  return f;
}
const openShift = (f: Fx, start = "09:00", end = "11:00", d = day(next++)) =>
  q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,null)", [w.orgA, f.client, f.service, d, start, end]).then((r) => r[0].shift_id as string);
const settings = (a: Actor, enabled: boolean, email: boolean, auto: boolean, win = 48, max = 25) =>
  q(a, "select ogevia_api.set_cover_notification_settings($1,$2,$3,$4,$5,$6,'Synthetic test') as s", [w.orgA, enabled, email, auto, win, max]).then((r) => r[0].s);
const notify = (shift: string, a: Actor = w.managerA) => q(a, "select ogevia_api.notify_cover_shift($1,$2) as r", [w.orgA, shift]).then((r) => r[0].r);
const inbox = (a: Actor, state = "inbox", cat: string | null = null) => q(a, "select ogevia_api.list_user_notifications($1,$2,$3) as r", [w.orgA, state, cat]).then((r) => r[0].r);

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  for (const r of await admin("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])) rec[r.caregiver_code] = r.id;
  await admin("update ogevia.organizations set slug = 'socal-care-services' where id = $1", [w.orgA]);
  await runSql(UP);
  // contact addresses for the worker (synthetic, never printed)
  for (const [code, email] of [["CG-A1", "a1@example.invalid"], ["CG-A2", "a2@example.invalid"]] as const) if (rec[code]) await admin("insert into ogevia.caregiver_contacts (caregiver_record_id, organization_id, contact_email) values ($1,$2,$3)", [rec[code], w.orgA, email]);
}, 120_000);
afterAll(async () => db?.drop());

describe("settings (off by default, owner only, audited)", () => {
  it("is off until the owner turns it on; nothing is created while off", async () => {
    const f = await fixture(); const s = await openShift(f);
    expect(await q(w.managerA, "select ogevia_api.get_cover_notification_settings($1) as s", [w.orgA]).then((r) => r[0].s)).toMatchObject({ enabled: false, emailEnabled: false, autoNotify: false });
    expect(await notify(s)).toEqual({ state: "disabled" });
    expect(Number((await admin("select count(*) n from ogevia.user_notifications"))[0].n)).toBe(0);
  });
  it("only the owner changes it, with a reason, and the change is audited", async () => {
    await expectPgError(settings(w.managerA, true, true, false), "OGA03");
    await expectPgError(q(w.ownerA, "select ogevia_api.set_cover_notification_settings($1,true,true,false,48,25,'') ", [w.orgA]), "OGV22");
    await expectPgError(settings(w.ownerA, true, true, false, 0), "OGV22");
    expect(await settings(w.ownerA, true, true, false)).toMatchObject({ enabled: true, emailEnabled: true });
    const a = await admin("select before_state, after_state from ogevia.audit_events where action = 'cover_notification_settings.changed'");
    expect(a.length).toBe(1); expect(a[0].after_state).toMatchObject({ enabled: true });
  });
});

describe("cover-shift notifications", () => {
  it("notifies eligible assigned caregivers once (repeat creates nothing), with no client detail, and audits counts only", async () => {
    const f = await fixture(); const s = await openShift(f);
    const r = await notify(s);
    expect(r).toMatchObject({ state: "done", notified: 2, emailQueued: 2, alreadyNotified: 0 });
    expect(await notify(s)).toMatchObject({ notified: 0, alreadyNotified: 2 });
    const mine = await inbox(w.caregiverA1);
    expect(mine.unread).toBeGreaterThanOrEqual(1);
    const n = mine.items.find((i: any) => i.shiftId === s);
    expect(n.title).toBe("A shift needs cover"); expect(n.state).toBe("unread");
    const client = (await admin("select client_code from ogevia.clients where id = $1", [f.client]))[0].client_code;
    expect(JSON.stringify(n)).not.toContain(client);
    const audit = await admin("select after_state, reason from ogevia.audit_events where action = 'cover_notification.created' and entity_id = $1", [s]);
    expect(audit.length).toBe(1); expect(Object.keys(audit[0].after_state).sort()).toEqual(["alreadyNotified", "emailQueued", "notEligible", "notified"]);
  });
  it("does not notify a caregiver who is not assigned, nor the caregiver who called out; the others are notified", async () => {
    const f = await fixture([w.caregiverA1, w.caregiverA2]);
    const s0 = await openShift(f);
    expect((await inbox(w.caregiverA3).then((r) => r.items)).find((i: any) => i.shiftId === s0)).toBeUndefined();
    await notify(s0);
    expect((await inbox(w.caregiverA3)).items.find((i: any) => i.shiftId === s0)).toBeUndefined();   // not assigned to this client
    const s = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','11:00',$5,null)", [w.orgA, f.client, f.service, day(next++), rec["CG-A1"]]))[0].shift_id as string;
    await q(w.caregiverA1, "select ogevia_api.call_out_my_shift($1,$2,'Synthetic: sick',null)", [w.orgA, s]);
    expect(await notify(s)).toMatchObject({ state: "done", notified: 1 });
    expect((await inbox(w.caregiverA1)).items.find((i: any) => i.shiftId === s)).toBeUndefined();
    expect((await inbox(w.caregiverA2)).items.find((i: any) => i.shiftId === s)).toBeDefined();
  });
  it("respects preferences: in-app off and email off for one caregiver creates nothing for them; email off only keeps the in-app row without a delivery", async () => {
    const f = await fixture(); const s = await openShift(f);
    await q(w.caregiverA2, "select ogevia_api.set_my_notification_preferences($1,'cover_shift',false,false)", [w.orgA]);
    await q(w.caregiverA1, "select ogevia_api.set_my_notification_preferences($1,'cover_shift',true,false)", [w.orgA]);
    const r = await notify(s);
    expect(r).toMatchObject({ notified: 1, emailQueued: 0 });
    expect((await inbox(w.caregiverA2)).items.find((i: any) => i.shiftId === s)).toBeUndefined();
    expect((await inbox(w.caregiverA1)).items.find((i: any) => i.shiftId === s)).toBeDefined();
    await q(w.caregiverA2, "select ogevia_api.set_my_notification_preferences($1,'cover_shift',true,true)", [w.orgA]);
    await q(w.caregiverA1, "select ogevia_api.set_my_notification_preferences($1,'cover_shift',true,true)", [w.orgA]);
  });
  it("only a scheduler or manager can notify; a caregiver cannot; another agency cannot", async () => {
    const f = await fixture(); const s = await openShift(f);
    await expectPgError(notify(s, w.caregiverA1), "OGA03");
    await expectPgError(q(w.managerB, "select ogevia_api.notify_cover_shift($1,$2)", [w.orgA, s]), "OGN04");
  });
  it("a filled shift needs no notification", async () => {
    const f = await fixture();
    const s = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','11:00',$5,null)", [w.orgA, f.client, f.service, day(next++), rec["CG-A1"]]))[0].shift_id as string;
    expect(await notify(s)).toMatchObject({ state: "not_needed" });
  });
});

describe("the notification centre", () => {
  it("lists only the person's own, filters, counts unread, and archives and restores", async () => {
    const f = await fixture(); const s = await openShift(f); await notify(s);
    const mine = await inbox(w.caregiverA1); const n = mine.items.find((i: any) => i.shiftId === s);
    await expectPgError(inbox(w.caregiverB1), "OGN04");   // another agency: no access at all
    expect((await inbox(w.caregiverA3)).items.find((i: any) => i.id === n.id)).toBeUndefined();
    const before = mine.unread;
    expect(await q(w.caregiverA1, "select ogevia_api.mark_user_notifications($1,$2::uuid[],'read') as n", [w.orgA, [n.id]]).then((r) => r[0].n)).toBe(1);
    expect((await inbox(w.caregiverA1)).unread).toBe(before - 1);
    expect(await q(w.caregiverA1, "select ogevia_api.mark_user_notifications($1,$2::uuid[],'archive') as n", [w.orgA, [n.id]]).then((r) => r[0].n)).toBe(1);
    expect((await inbox(w.caregiverA1)).items.find((i: any) => i.id === n.id)).toBeUndefined();
    expect((await inbox(w.caregiverA1, "archived")).items.find((i: any) => i.id === n.id)?.state).toBe("archived");
    await q(w.caregiverA1, "select ogevia_api.mark_user_notifications($1,$2::uuid[],'unarchive')", [w.orgA, [n.id]]);
    expect((await inbox(w.caregiverA1, "inbox", "cover_shift")).items.find((i: any) => i.id === n.id)).toBeDefined();
    // another person's id changes nothing
    expect(await q(w.caregiverA2, "select ogevia_api.mark_user_notifications($1,$2::uuid[],'archive') as n", [w.orgA, [n.id]]).then((r) => r[0].n)).toBe(0);
    await expectPgError(inbox(w.caregiverA1, "bogus"), "OGV22");
  });
  it("history is kept: a notification cannot be deleted or rewritten", async () => {
    const id = (await admin("select id from ogevia.user_notifications limit 1"))[0].id;
    await expect(db.admin.query("delete from ogevia.user_notifications where id = $1", [id])).rejects.toMatchObject({ code: "OGC09" });
    await expect(db.admin.query("update ogevia.user_notifications set body = 'x' where id = $1", [id])).rejects.toMatchObject({ code: "OGC09" });
  });
  it("the office history shows statuses by caregiver code with no address", async () => {
    const h = await q(w.managerA, "select * from ogevia_api.list_cover_notification_history($1,20)", [w.orgA]);
    expect(h.length).toBeGreaterThan(0); expect(JSON.stringify(h)).not.toContain("example.invalid");
    await expectPgError(q(w.caregiverA1, "select * from ogevia_api.list_cover_notification_history($1,20)", [w.orgA]), "OGA03");
  });
});

describe("the email outbox: claim, retry, failure, audit", () => {
  const sys = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows as any[];
  async function oneDelivery() {
    const f = await fixture(); const s = await openShift(f); await notify(s);
    return (await admin("select d.id from ogevia.notification_deliveries d join ogevia.user_notifications n on n.id = d.notification_id where n.shift_id = $1 limit 1", [s]))[0].id as string;
  }
  it("claims due deliveries once with the address resolved server-side; a second claim returns none of the same", async () => {
    await admin("update ogevia.notification_deliveries set status = 'skipped'");   // clear earlier ones
    const id = await oneDelivery();
    const first = await sys("select * from ogevia_api.system_email_claim(10)");
    const mine = first.find((r) => r.delivery_id === id);
    expect(mine).toBeDefined(); expect(mine.to_email).toMatch(/@example\.invalid$/); expect(mine.attempt).toBe(1);
    expect(mine.body).not.toMatch(/CL-|client/i);
    expect((await sys("select * from ogevia_api.system_email_claim(10)")).find((r) => r.delivery_id === id)).toBeUndefined();
  });
  it("transient failures retry with growing delay and fail after the 5th attempt; permanent fails at once; a repeat report changes nothing", async () => {
    await admin("update ogevia.notification_deliveries set status = 'skipped'");
    const id = await oneDelivery();
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      await admin("update ogevia.notification_deliveries set next_attempt_at = now() where id = $1", [id]);
      const c = (await sys("select * from ogevia_api.system_email_claim(50)")).find((r) => r.delivery_id === id);
      expect(c.attempt).toBe(attempt);
      const state = (await sys("select ogevia_api.system_email_record($1,'transient',null,'throttled') as s", [id]))[0].s;
      if (attempt < 5) { expect(state).toBe("retry"); delays.push(Math.round(Number((await admin("select extract(epoch from (next_attempt_at - now())) s from ogevia.notification_deliveries where id = $1", [id]))[0].s) / 60)); }
      else expect(state).toBe("failed");
    }
    expect(delays).toEqual([5, 15, 45, 135].map((m) => expect.closeTo(m, 0)));
    expect((await sys("select ogevia_api.system_email_record($1,'sent') as s", [id]))[0].s).toBe("failed");
    const ev = (await admin("select event from ogevia.notification_delivery_events where delivery_id = $1 order by occurred_at, id", [id])).map((r) => r.event);
    expect(ev.filter((e) => e === "claimed").length).toBe(5); expect(ev.filter((e) => e === "retry_scheduled").length).toBe(4); expect(ev.at(-1)).toBe("failed");
    expect((await admin("select count(*) n from ogevia.audit_events where action = 'notification.delivery_failed' and entity_id = $1", [id]))[0].n).toBe("1");
    const id2 = await oneDelivery();
    await sys("select * from ogevia_api.system_email_claim(50)");
    expect((await sys("select ogevia_api.system_email_record($1,'permanent',null,'rejected') as s", [id2]))[0].s).toBe("failed");
  });
  it("a sent delivery records the provider id; a crashed claim (sending for over 10 minutes) is reclaimed; a person without an address is skipped", async () => {
    await admin("update ogevia.notification_deliveries set status = 'skipped'");
    const id = await oneDelivery();
    await sys("select * from ogevia_api.system_email_claim(50)");
    await admin("update ogevia.notification_deliveries set updated_at = now() - interval '11 minutes' where id = $1", [id]);
    const again = (await sys("select * from ogevia_api.system_email_claim(50)")).find((r) => r.delivery_id === id);
    expect(again.attempt).toBe(2);
    expect((await sys("select ogevia_api.system_email_record($1,'sent','synthetic-message-id') as s", [id]))[0].s).toBe("sent");
    const d = (await admin("select status, provider_message_id, sent_at from ogevia.notification_deliveries where id = $1", [id]))[0];
    expect(d.status).toBe("sent"); expect(d.provider_message_id).toBe("synthetic-message-id"); expect(d.sent_at).not.toBeNull();
    expect((await admin("select count(*) n from ogevia.notification_delivery_events where delivery_id = $1 and event = 'reclaimed'", [id]))[0].n).toBe("1");
    await admin("update ogevia.notification_deliveries set status = 'skipped'");
    const id3 = await oneDelivery();
    await admin("delete from ogevia.caregiver_contacts"); await admin("delete from ogevia.caregiver_invitations");
    await sys("select * from ogevia_api.system_email_claim(50)");
    expect((await admin("select status, last_error_code from ogevia.notification_deliveries where id = $1", [id3]))[0]).toMatchObject({ status: "skipped", last_error_code: "no_email" });
  });
  it("the delivery audit is append-only", async () => {
    const id = (await admin("select id from ogevia.notification_delivery_events limit 1"))[0].id;
    await expect(db.admin.query("delete from ogevia.notification_delivery_events where id = $1", [id])).rejects.toMatchObject({ code: "OGC09" });
  });
});

describe("the scheduled run (auto-notify)", () => {
  it("creates notifications only for agencies with auto-notify on, for shifts inside the window, once", async () => {
    await settings(w.ownerA, true, false, false);
    const f = await fixture(); const near = await openShift(f, "09:00", "11:00", day(1)); const far = await openShift(f, "09:00", "11:00", day(30));
    expect((await admin("select * from ogevia_api.system_cover_notify_orgs()")).length).toBe(0);
    await settings(w.ownerA, true, false, true, 72);
    expect((await admin("select * from ogevia_api.system_cover_notify_orgs()")).length).toBe(1);
    const r = (await admin("select ogevia_api.system_cover_notify_org($1) as r", [w.orgA]))[0].r;
    expect(r.shifts).toBeGreaterThanOrEqual(1);
    expect(Number((await admin("select count(*) n from ogevia.user_notifications where shift_id = $1", [near]))[0].n)).toBeGreaterThan(0);
    expect(Number((await admin("select count(*) n from ogevia.user_notifications where shift_id = $1", [far]))[0].n)).toBe(0);
    expect((await admin("select ogevia_api.system_cover_notify_org($1) as r", [w.orgA]))[0].r.notified).toBe(0);
  });
});

describe("rollback", () => {
  it("the down script removes what 0113 created and leaves the audit trail", async () => {
    await runSql(DOWN);
    expect(Number((await admin("select count(*) n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'ogevia_api' and p.proname in ('notify_cover_shift','system_email_claim')"))[0].n)).toBe(0);
    expect(Number((await admin("select count(*) n from ogevia.audit_events where action = 'cover_notification.created'"))[0].n)).toBeGreaterThan(0);
  });
});
