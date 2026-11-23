// 0113 (PENDING): cover-shift notifications, the notification centre, preferences, the email outbox with retry, and the audit trail. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const U = (n: string) => new URL(`../pending/migrations/${n}`, import.meta.url);
const UP = U("0113_notifications.sql");
const DOWN = new URL("../pending/rollback/0113_notifications.down.sql", import.meta.url);
let db: TestDb; let w: World; let today: string; let temecula: string; let corona: string;
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
async function fixture(caregivers: Actor[] = [w.caregiverA1, w.caregiverA2], service: { zip: string; city: string } | null = { zip: "92596", city: "Winchester" }): Promise<Fx> {
  const f = await freshClient(db, w, caregivers[0]!, 20000, w.orgA, { before: 40, after: 40 });
  for (const a of caregivers.slice(1)) {
    await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, a.userId, f.client, f.service, today]);
  }
  if (service) await db.admin.query("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,$3,$4,$5)", [w.orgA, f.client, service.zip, service.city, w.managerA.userId]);
  return f;
}
const openShift = (f: Fx, start = "09:00", end = "11:00", d = day(next++)) =>
  q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,null)", [w.orgA, f.client, f.service, d, start, end]).then((r) => r[0].shift_id as string);
const TPL = "Open shift in {city} | {date} | {time}";
const settings = (a: Actor, enabled: boolean, email: boolean, auto: boolean, win = 48, max = 25, audience = "office", tpl = TPL) =>
  q(a, "select ogevia_api.set_cover_notification_settings($1,$2,$3,$4,$5,$6,$7,$8,'Synthetic test') as s", [w.orgA, enabled, email, auto, win, max, audience, tpl]).then((r) => r[0].s);
const notify = (shift: string, a: Actor = w.managerA, office: string | null = null) => q(a, "select ogevia_api.notify_cover_shift($1,$2,$3) as r", [w.orgA, shift, office]).then((r) => r[0].r);
const inbox = (a: Actor, state = "inbox", cat: string | null = null) => q(a, "select ogevia_api.list_user_notifications($1,$2,$3) as r", [w.orgA, state, cat]).then((r) => r[0].r);

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  for (const r of await admin("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])) rec[r.caregiver_code] = r.id;
  await admin("update ogevia.organizations set slug = 'socal-care-services' where id = $1", [w.orgA]);
  for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql", "0113_notifications.sql"]) await runSql(U(f));
  // one office, Temecula; two caregivers work from it (a third works from nowhere yet)
  temecula = await q(w.ownerA, "select ogevia_api.create_office($1,'Temecula Office',null) as id", [w.orgA]).then((r) => r[0].id);
  for (const code of ["CG-A1", "CG-A2"]) await q(w.managerA, "select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [w.orgA, rec[code], temecula]);
  // contact addresses for the worker (synthetic, never printed)
  for (const [code, email] of [["CG-A1", "a1@example.invalid"], ["CG-A2", "a2@example.invalid"]] as const) if (rec[code]) await admin("insert into ogevia.caregiver_contacts (caregiver_record_id, organization_id, contact_email) values ($1,$2,$3)", [rec[code], w.orgA, email]);
}, 120_000);
afterAll(async () => db?.drop());

describe("settings (off by default, owner only, audited)", () => {
  it("is off until the owner turns it on; nothing is created while off", async () => {
    const f = await fixture(); const s = await openShift(f);
    expect(await q(w.managerA, "select ogevia_api.get_cover_notification_settings($1) as s", [w.orgA]).then((r) => r[0].s)).toMatchObject({ enabled: false, emailEnabled: false, autoNotify: false, audience: "office", subjectTemplate: TPL });
    expect(await notify(s)).toEqual({ state: "disabled" });
    expect(Number((await admin("select count(*) n from ogevia.user_notifications"))[0].n)).toBe(0);
  });
  it("only the owner changes it, with a reason, and the change is audited", async () => {
    await expectPgError(settings(w.managerA, true, true, false), "OGA03");
    await expectPgError(q(w.ownerA, "select ogevia_api.set_cover_notification_settings($1,true,true,false,48,25,'office','Open shift in {city} | {date} | {time}','') ", [w.orgA]), "OGV22");
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
    expect(n.title).toMatch(/^Open shift in Winchester \| [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} \| 9:00–11:00 AM$/); expect(n.state).toBe("unread");
    const client = (await admin("select client_code from ogevia.clients where id = $1", [f.client]))[0].client_code;
    expect(JSON.stringify(n)).not.toContain(client);
    const audit = await admin("select after_state, reason from ogevia.audit_events where action = 'cover_notification.created' and entity_id = $1", [s]);
    expect(audit.length).toBe(1); expect(Object.keys(audit[0].after_state).sort()).toEqual(["alreadyNotified", "audience", "emailQueued", "notEligible", "notified", "officeId"]);
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

describe("open-shift routing and content (owner decisions of 2026-11-23)", () => {
  const cityOf = async (office: string) => (await admin("select city from ogevia.offices where id = $1", [office]))[0]?.city;
  it("one office: used automatically. The subject names the SERVICE city (Winchester), the body names the coordinating office (Temecula), and neither carries the client's name, code, street or ZIP", async () => {
    await q(w.ownerA, "select ogevia_api.update_office($1,$2,'Temecula Office','1 Office Way','Temecula','92590','Riverside')", [w.orgA, temecula]);
    expect(await cityOf(temecula)).toBe("Temecula");
    await settings(w.ownerA, true, false, false);
    const f = await fixture(); const s = await openShift(f);
    const r = await notify(s);
    expect(r).toMatchObject({ state: "done", notified: 2, serviceCity: "Winchester", office: "Temecula Office" });
    expect(r.subject).toMatch(/^Open shift in Winchester \| [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} \| 9:00–11:00 AM$/);
    const n = (await inbox(w.caregiverA1)).items.find((i: any) => i.shiftId === s);
    expect(n.title).toBe(r.subject); expect(n.body).toContain("Coordinating office: Temecula Office"); expect(n.body).toContain("Service city: Winchester");
    const row = (await admin("select title, body from ogevia.user_notifications where shift_id = $1 limit 1", [s]))[0];
    const client = (await admin("select c.client_code, n.legal_first_name, n.legal_last_name from ogevia.clients c left join ogevia.client_private_names n on n.client_id = c.id where c.id = $1", [f.client]))[0];
    for (const secret of [client.client_code, client.legal_first_name, client.legal_last_name, "92596", "1 Office Way", "92590"].filter(Boolean)) { expect(row.title).not.toContain(secret); expect(row.body).not.toContain(secret); }
    expect(row.title).not.toContain("Temecula");   // the office's city is never the service city
  });
  it("a Winchester shift coordinated by Temecula (several offices): the subject says Winchester and the audience is Temecula's, not Corona's", async () => {
    corona = await q(w.ownerA, "select ogevia_api.create_office($1,'Corona Office',null) as id", [w.orgA]).then((r) => r[0].id);
    await q(w.managerA, "select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [w.orgA, rec["CG-A3"] ?? rec["CG-A2"], corona]);   // a Corona-only caregiver
    const corOnly = rec["CG-A3"] ? w.caregiverA3 : null;
    const f = await fixture([w.caregiverA1, w.caregiverA2, ...(corOnly ? [corOnly] : [])]);
    const s = await openShift(f);
    await admin("update ogevia.shifts set coordinating_office_id = $1 where id = $2", [temecula, s]);
    const r = await notify(s);
    expect(r).toMatchObject({ state: "done", serviceCity: "Winchester", office: "Temecula Office" });
    expect(r.subject).toContain("Open shift in Winchester");
    expect((await inbox(w.caregiverA1)).items.some((i: any) => i.shiftId === s)).toBe(true);
    expect((await inbox(w.caregiverA2)).items.some((i: any) => i.shiftId === s)).toBe(true);
    if (corOnly) expect((await inbox(corOnly)).items.some((i: any) => i.shiftId === s)).toBe(false);   // Corona's caregiver is not in Temecula's audience
  });
  it("the agency audience setting and a per-office override are honored ('agency' tells every eligible caregiver; 'none' sends nothing; removing the override restores the setting)", async () => {
    const f = await fixture([w.caregiverA1, w.caregiverA2, w.caregiverA3]); const s = await openShift(f);
    await admin("update ogevia.shifts set coordinating_office_id = $1 where id = $2", [temecula, s]);
    await expectPgError(q(w.managerA, "select ogevia_api.set_cover_office_audience($1,$2,'none','Synthetic')", [w.orgA, temecula]), "OGA03");
    await q(w.ownerA, "select ogevia_api.set_cover_office_audience($1,$2,'none','Synthetic: pause Temecula')", [w.orgA, temecula]);
    expect(await notify(s)).toMatchObject({ state: "office_audience_off", office: "Temecula Office" });
    await q(w.ownerA, "select ogevia_api.set_cover_office_audience($1,$2,'agency','Synthetic: whole agency')", [w.orgA, temecula]);
    expect(await notify(s)).toMatchObject({ state: "done", notified: 3 });   // A1, A2 and the Corona caregiver A3 (same agency, eligible)
    await q(w.ownerA, "select ogevia_api.set_cover_office_audience($1,$2,null,'Synthetic: back to the setting')", [w.orgA, temecula]);
    const listed = await q(w.ownerA, "select * from ogevia_api.list_cover_office_audiences($1)", [w.orgA]);
    expect(listed.find((r) => r.office_id === temecula).audience_override).toBeNull();
    await settings(w.ownerA, true, false, false, 48, 25, "agency");
    const s2 = await openShift(await fixture([w.caregiverA1, w.caregiverA2, w.caregiverA3])); await admin("update ogevia.shifts set coordinating_office_id = $1 where id = $2", [temecula, s2]);
    expect(await notify(s2)).toMatchObject({ notified: 3 });
    await settings(w.ownerA, true, false, false, 48, 25, "office");
  });
  it("several offices and none assigned to the shift: the sender must choose; the choice is recorded on the shift; an office of another agency is never accepted", async () => {
    const f = await fixture(); const s = await openShift(f);
    const r = await notify(s);
    expect(r.state).toBe("office_required"); expect(r.offices.map((o: any) => o.name).sort()).toEqual(["Corona Office", "Temecula Office"]);
    expect(Number((await admin("select count(*) n from ogevia.user_notifications where shift_id = $1", [s]))[0].n)).toBe(0);
    await admin("insert into ogevia.offices (organization_id, name, created_by) values ($1, 'Foreign Office', $2)", [w.orgB, w.managerB.userId]);
    const foreignId = (await admin("select id from ogevia.offices where organization_id = $1 limit 1", [w.orgB]))[0]?.id;
    if (foreignId) expect((await notify(s, w.managerA, foreignId)).state).toBe("office_required");
    expect(await notify(s, w.managerA, temecula)).toMatchObject({ state: "done", office: "Temecula Office" });
    expect((await admin("select coordinating_office_id from ogevia.shifts where id = $1", [s]))[0].coordinating_office_id).toBe(temecula);
    expect(await notify(s)).toMatchObject({ state: "done", notified: 0, alreadyNotified: 2 });   // the shift now has its office; a second publish adds nobody
  });
  it("an incomplete service address blocks the alert (missing city, missing ZIP, or both), names what is missing and the client, and never substitutes the office city", async () => {
    const noZip = await fixture(undefined, null); const s1 = await openShift(noZip);
    await admin("update ogevia.clients set city = null where id = $1", [noZip.client]);
    await admin("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596',null,$3)", [w.orgA, noZip.client, w.managerA.userId]);
    const r1 = await notify(s1, w.managerA, temecula);
    expect(r1).toMatchObject({ state: "address_incomplete", clientId: noZip.client, missing: ["city"] });   // the ZIP is there, the city is not (Temecula is NOT used instead)
    const none = await fixture(undefined, null); const s2 = await openShift(none);
    expect(await notify(s2, w.managerA, temecula)).toMatchObject({ state: "address_incomplete", missing: ["city", "zip"] });
    await admin("update ogevia.clients set city = 'Winchester' where id = $1", [none.client]);
    expect(await notify(s2, w.managerA, temecula)).toMatchObject({ state: "address_incomplete", missing: ["zip"] });
    await admin("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596',null,$3)", [w.orgA, none.client, w.managerA.userId]);
    expect(await notify(s2, w.managerA, temecula)).toMatchObject({ state: "done", serviceCity: "Winchester" });   // the client's own city counts once the ZIP is set
    expect(Number((await admin("select count(*) n from ogevia.user_notifications where shift_id = $1", [s1]))[0].n)).toBe(0);
  });
  it("the sender never receives the alert (even eligible, even when someone else reported the call-out); a caregiver in two offices gets exactly one copy", async () => {
    const f = await fixture(); const s = await openShift(f);
    await admin("update ogevia.shifts set coordinating_office_id = $1 where id = $2", [temecula, s]);
    await q(w.managerA, "select ogevia_api.set_person_offices($1,'caregiver',$2,$3,$4::uuid[])", [w.orgA, rec["CG-A1"], temecula, [corona]]);   // A1 in BOTH offices
    // the internal publisher with A1 as the sender (a person who is also a caregiver): she is excluded, A2 is told once
    const r = (await admin("select ogevia.cover_notify($1,$2,null,$3) as r", [w.orgA, s, w.caregiverA1.userId]))[0].r;
    expect(r).toMatchObject({ state: "done", notified: 1 });
    expect((await inbox(w.caregiverA1)).items.some((i: any) => i.shiftId === s)).toBe(false);
    expect((await inbox(w.caregiverA2)).items.some((i: any) => i.shiftId === s)).toBe(true);
    // the scheduled run (no sender) tells A1 once, even though she is in two offices; repeating adds nobody
    expect((await admin("select ogevia.cover_notify($1,$2,null,null) as r", [w.orgA, s]))[0].r).toMatchObject({ notified: 1, alreadyNotified: 1 });
    expect(Number((await admin("select count(*) n from ogevia.user_notifications where shift_id = $1 and recipient_user_id = $2", [s, w.caregiverA1.userId]))[0].n)).toBe(1);
    const alerts = await admin("select sent_by, service_city, recipients from ogevia.cover_alerts where shift_id = $1 order by created_at", [s]);
    expect(alerts.map((a) => a.service_city)).toEqual(["Winchester", "Winchester"]); expect(alerts[0].sent_by).toBe(w.caregiverA1.userId); expect(alerts[1].sent_by).toBeNull();
  });
  it("another agency is isolated: its manager cannot publish this agency's shift, its caregivers (even assigned to a same-named office) are never told, and the alert row stays in this agency", async () => {
    const f = await fixture(); const s = await openShift(f);
    await admin("update ogevia.shifts set coordinating_office_id = $1 where id = $2", [temecula, s]);
    await expectPgError(q(w.managerB, "select ogevia_api.notify_cover_shift($1,$2,null)", [w.orgA, s]), "OGN04");
    // naming their OWN agency with this agency's shift: their agency has the feature off (nothing happens); with it on, the shift is not found there
    expect(await q(w.managerB, "select ogevia_api.notify_cover_shift($1,$2,null) as r", [w.orgB, s]).then((r) => r[0].r)).toEqual({ state: "disabled" });
    await admin("insert into ogevia.cover_notification_settings (organization_id, enabled) values ($1, true) on conflict (organization_id) do update set enabled = true", [w.orgB]);
    await expectPgError(q(w.managerB, "select ogevia_api.notify_cover_shift($1,$2,null)", [w.orgB, s]), "OGN04");
    await notify(s);
    expect(Number((await admin("select count(*) n from ogevia.user_notifications where organization_id = $1", [w.orgB]))[0].n)).toBe(0);
    expect(Number((await admin("select count(*) n from ogevia.cover_alerts where shift_id = $1 and organization_id <> $2", [s, w.orgA]))[0].n)).toBe(0);
  });
  it("the scheduled run publishes what it can and counts what it cannot (office missing, address incomplete), leaving those for a person", async () => {
    await settings(w.ownerA, true, false, true, 72);
    const ok = await openShift(await fixture(), "09:00", "11:00", day(1)); await admin("update ogevia.shifts set coordinating_office_id = $1 where id = $2", [temecula, ok]);
    const noOffice = await openShift(await fixture(), "12:00", "14:00", day(1));
    const noAddress = await openShift(await fixture(undefined, null), "15:00", "17:00", day(1)); await admin("update ogevia.shifts set coordinating_office_id = $1 where id = $2", [temecula, noAddress]);
    const r = (await admin("select ogevia_api.system_cover_notify_org($1) as r", [w.orgA]))[0].r;
    expect(r.blocked).toMatchObject({ office_required: expect.any(Number), address_incomplete: expect.any(Number) });
    expect(Number((await admin("select count(*) n from ogevia.user_notifications where shift_id = $1", [ok]))[0].n)).toBeGreaterThan(0);
    for (const s of [noOffice, noAddress]) expect(Number((await admin("select count(*) n from ogevia.user_notifications where shift_id = $1", [s]))[0].n)).toBe(0);
  });
  it("the subject format may be customised but must keep the service city; other tokens and line breaks are refused", async () => {
    await settings(w.ownerA, true, false, false, 48, 25, "office", "{service} in {city} | {time}");
    const s = await openShift(await fixture()); await admin("update ogevia.shifts set coordinating_office_id = $1 where id = $2", [temecula, s]);
    const r = await notify(s); expect(r.subject).toMatch(/^.+ in Winchester \| 9:00–11:00 AM$/);
    for (const bad of ["Open shift | {date} | {time}", "Open shift in {city} for {client}", "Open shift in {city}\nBcc: x", "short"]) await expectPgError(settings(w.ownerA, true, false, false, 48, 25, "office", bad), "OGV22");
    await settings(w.ownerA, true, false, false, 48, 25, "office", TPL);
  });
});

describe("rollback", () => {
  it("the down script removes what 0113 created and leaves the audit trail", async () => {
    await runSql(DOWN);
    expect(Number((await admin("select count(*) n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'ogevia_api' and p.proname in ('notify_cover_shift','system_email_claim')"))[0].n)).toBe(0);
    expect(Number((await admin("select count(*) n from ogevia.audit_events where action = 'cover_notification.created'"))[0].n)).toBeGreaterThan(0);
  });
});
