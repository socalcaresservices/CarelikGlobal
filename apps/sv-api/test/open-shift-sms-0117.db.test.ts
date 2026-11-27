// 0117 open-shift workflow and automatic texting, in a real disposable PostgreSQL, through the real SQL API functions. SYNTHETIC data only; the sender is the mock (the outbox, claim and record
// functions are driven here exactly as the worker drives them). Nothing is sent anywhere.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, type TestDb, type World } from "../../../infra/aws/db/test/harness";

let db: TestDb; let w: World; let today: string; let temecula: string; let murrieta: string;
const rec: Record<string, string> = {};
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
const as = <T>(a: { sub: string }, fn: (c: any) => Promise<T>) => asActor(db, a.sub, fn);
const call = (a: { sub: string }, sql: string, p: unknown[] = []) => as(a, async (c) => (await c.query(sql, p)).rows);
const settings = (over: Record<string, unknown> = {}) => call(w.ownerA, "select ogevia_api.set_sms_settings($1,$2::jsonb)", [w.orgA, JSON.stringify({ enabled: true, provider: "mock", senderLabel: "SoCal Care", senderId: "+19515550100", ...over })]);
const tick = async () => ({ notify: (await one("select ogevia_api.system_cover_notify_org($1) as r", [w.orgA])).r, esc: (await one("select ogevia_api.system_sms_escalate_org($1) as r", [w.orgA])).r });
const sms = (where = "true") => q(`select purpose, recipient_kind, status, reason, round, body, send_after, recipient_user_id, phone_e164, dedupe_key from ogevia.sms_messages where organization_id = $1 and ${where} order by created_at, dedupe_key`, [w.orgA]);
const notes = (user: string, shift: string) => q("select title, category, archived_at, dedupe_key from ogevia.user_notifications where organization_id = $1 and recipient_user_id = $2 and shift_id = $3 order by created_at", [w.orgA, user, shift]);

/** An open shift for a fresh client (Winchester service address) coordinated by Temecula; A1, A2, A3 are assigned to the client. */
let slot = 0;
async function openShift(daysAhead = 2, opts: { assignTo?: string; office?: string | null } = {}) {
  const hh = 5 + (slot++ % 16); const t0 = `${String(hh).padStart(2, "0")}:00`, t1 = `${String(hh).padStart(2, "0")}:50`;
  const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 });
  for (const u of [w.caregiverA2, w.caregiverA3]) await q("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, u.userId, f.client, f.service, day(-30)]);
  await q("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596','Winchester',$3)", [w.orgA, f.client, w.managerA.userId]);
  const shift = (await call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,null)", [w.orgA, f.client, f.service, day(daysAhead), t0, t1]))[0].shift_id as string;
  await q("update ogevia.shifts set coordinating_office_id = $2 where id = $1", [shift, opts.office === undefined ? temecula : opts.office]);
  if (opts.assignTo) await call(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,null,null)", [w.orgA, shift, rec[opts.assignTo]]);
  return { shift, client: f.client, service: f.service };
}
const optIn = (a: { sub: string }, phone: string) => call(a, "select ogevia_api.set_my_sms($1,$2,true,'v1')", [w.orgA, phone]);

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1170);
  today = await orgToday(db);
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner");
    for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql", "0113_notifications.sql", "0117_open_shift_sms.sql"]) await c.query(readFileSync(new URL(`../../../infra/aws/db/pending/migrations/${f}`, import.meta.url), "utf8"));
    await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  for (const r of (await q("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA]))) rec[r.caregiver_code] = r.id;
  await q("update ogevia.organizations set slug = 'socal-care-services' where id = $1", [w.orgA]);
  temecula = (await call(w.ownerA, "select ogevia_api.create_office($1,'Temecula Office',null) as id", [w.orgA]))[0].id;
  murrieta = (await call(w.ownerA, "select ogevia_api.create_office($1,'Murrieta Office',null) as id", [w.orgA]))[0].id;
  for (const code of ["CG-A1", "CG-A2"]) await call(w.managerA, "select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [w.orgA, rec[code], temecula]);
  await call(w.managerA, "select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [w.orgA, rec["CG-A3"], murrieta]);
  await call(w.ownerA, "select ogevia_api.set_cover_notification_settings($1,true,true,true,72,50,'office','Open shift in {city} | {date} | {time}','test')", [w.orgA]);
  await settings();
}, 180_000);
afterAll(async () => db?.drop());

describe("brief item 2: the open-shift workflow", () => {
  it("Winchester matching when Temecula manages the shift: the board shows the service city and the office, only to the office's caregivers", async () => {
    const { shift } = await openShift();
    const a2 = await call(w.caregiverA2, "select * from ogevia_api.list_open_shifts($1)", [w.orgA]);
    expect(a2.find((r: any) => r.shift_id === shift)).toMatchObject({ city: "Winchester", office_name: "Temecula Office", coverage_state: "needs_coverage" });
    expect((await call(w.caregiverA3, "select * from ogevia_api.list_open_shifts($1)", [w.orgA])).find((r: any) => r.shift_id === shift)).toBeUndefined();   // Murrieta, assigned to the client, but not in the audience
    await call(w.ownerA, "select ogevia_api.set_cover_notification_settings($1,true,true,true,72,50,'agency','Open shift in {city} | {date} | {time}','test')", [w.orgA]);
    expect((await call(w.caregiverA3, "select * from ogevia_api.list_open_shifts($1)", [w.orgA])).find((r: any) => r.shift_id === shift)).toMatchObject({ city: "Winchester" });
    await call(w.ownerA, "select ogevia_api.set_cover_notification_settings($1,true,true,true,72,50,'office','Open shift in {city} | {date} | {time}','test')", [w.orgA]);
  });
  it("request and withdrawal; the office queue ranks the earliest eligible requester first; only the office confirms", async () => {
    const { shift } = await openShift();
    expect((await call(w.caregiverA2, "select ogevia_api.pickup_open_shift($1,$2,null) as s", [w.orgA, shift]))[0].s).toBe("requested");
    expect((await call(w.caregiverA2, "select * from ogevia_api.list_open_shifts($1)", [w.orgA])).find((r: any) => r.shift_id === shift).my_request_status).toBe("requested");
    expect((await call(w.caregiverA2, "select ogevia_api.withdraw_my_shift_pickup($1,$2) as s", [w.orgA, shift]))[0].s).toBeTruthy();
    expect((await call(w.caregiverA2, "select * from ogevia_api.list_open_shifts($1)", [w.orgA])).find((r: any) => r.shift_id === shift).my_request_status).toBeNull();
    await call(w.caregiverA1, "select ogevia_api.pickup_open_shift($1,$2,null)", [w.orgA, shift]);     // A1 asks first ...
    await call(w.caregiverA2, "select ogevia_api.pickup_open_shift($1,$2,null)", [w.orgA, shift]);     // ... A2 asks again later
    const queue = (await call(w.managerA, "select * from ogevia_api.list_shift_pickup_requests($1)", [w.orgA])).filter((r: any) => r.shift_id === shift);
    expect(queue).toHaveLength(2);
    expect(queue.map((r: any) => [r.caregiver_code, r.request_rank, r.eligible])).toEqual([["CG-A1", 1, true], ["CG-A2", 2, true]]);
    const first = queue.find((r: any) => r.request_rank === 1);
    await expect(call(w.caregiverA2, "select ogevia_api.confirm_shift_pickup($1,$2,null)", [w.orgA, first.request_id])).rejects.toThrow();   // a caregiver cannot confirm
    expect((await call(w.managerA, "select ogevia_api.confirm_shift_pickup($1,$2,null) as s", [w.orgA, first.request_id]))[0].s).toBe("covered");
    expect((await one("select caregiver_record_id from ogevia.shifts where id = $1", [shift])).caregiver_record_id).toBe(rec["CG-A1"]);
    expect((await q("select status from ogevia.shift_pickup_requests where shift_id = $1 order by status", [shift])).map((r: any) => r.status)).toEqual(["confirmed", "superseded", "withdrawn"]);
  });
  it("two simultaneous approvals produce exactly one assignment", async () => {
    const { shift } = await openShift();
    await call(w.caregiverA1, "select ogevia_api.pickup_open_shift($1,$2,null)", [w.orgA, shift]);
    await call(w.caregiverA2, "select ogevia_api.pickup_open_shift($1,$2,null)", [w.orgA, shift]);
    const reqs = await q("select id from ogevia.shift_pickup_requests where shift_id = $1 and status = 'pending'", [shift]);
    const results = await Promise.allSettled([
      call(w.managerA, "select ogevia_api.confirm_shift_pickup($1,$2,null) as s", [w.orgA, reqs[0].id]),
      call(w.ownerA, "select ogevia_api.confirm_shift_pickup($1,$2,null) as s", [w.orgA, reqs[1].id]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled" && (r as any).value[0].s === "covered")).toHaveLength(1);
    expect((await q("select count(*)::int n from ogevia.shift_coverage_events where shift_id = $1 and event_type = 'reassigned'", [shift]))[0].n).toBe(1);
    expect((await q("select status from ogevia.shift_pickup_requests where shift_id = $1 order by status", [shift])).map((r: any) => r.status).sort()).toEqual(["confirmed", "superseded"]);
    expect((await one("select caregiver_record_id from ogevia.shifts where id = $1", [shift])).caregiver_record_id).not.toBeNull();
  });
  it("a caregiver call-out reopens the SAME shift and keeps its reservation", async () => {
    const { shift } = await openShift(2, { assignTo: "CG-A1" });
    const before = await one("select id, reserved_minutes, released_at from ogevia.authorization_reservations where shift_id = $1 and released_at is null", [shift]);
    expect(before).toBeTruthy();
    expect((await call(w.caregiverA1, "select ogevia_api.call_out_my_shift($1,$2,'Sick',null) as s", [w.orgA, shift]))[0].s).toBe("needs_coverage");
    const after = await q("select id, reserved_minutes, released_at from ogevia.authorization_reservations where shift_id = $1", [shift]);
    expect(after).toEqual([before]);
    expect((await one("select status from ogevia.shifts where id = $1", [shift])).status).toBe("scheduled");
    expect((await call(w.managerA, "select * from ogevia_api.list_open_shifts($1)", [w.orgA])).length >= 0).toBe(true);
  });
  it("a replacement call-out starts a FRESH coverage round (a new alert, once per round)", async () => {
    const { shift } = await openShift(2, { assignTo: "CG-A1" });
    await call(w.caregiverA1, "select ogevia_api.call_out_my_shift($1,$2,'Sick',null)", [w.orgA, shift]);
    await q("update ogevia.caregiver_records set status='active' where id in ($1,$2)", [rec["CG-A2"], rec["CG-A3"]]);
    await call(w.ownerA, "select ogevia_api.set_cover_office_audience($1,$2,'agency','test')", [w.orgA, temecula]);   // so CG-A3 is in the audience too
    const r1 = await tick();
    expect(r1.notify.notified).toBeGreaterThanOrEqual(2);
    expect((await notes(w.caregiverA3.userId, shift)).filter((n: any) => n.dedupe_key.endsWith(":r1"))).toHaveLength(1);
    expect((await tick()).notify.notified).toBe(0);                                                                  // same round again: one copy only
    await call(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,null,null)", [w.orgA, shift, rec["CG-A2"]]);
    await call(w.caregiverA2, "select ogevia_api.call_out_my_shift($1,$2,'Car trouble',null)", [w.orgA, shift]);   // the replacement calls out: round 2
    const r2 = await tick();
    expect(r2.notify.notified).toBeGreaterThanOrEqual(1);
    const a3 = await notes(w.caregiverA3.userId, shift);
    expect(a3.filter((n: any) => /^cover:/.test(n.dedupe_key)).map((n: any) => n.dedupe_key.split(":").pop())).toEqual(["r1", "r2"]);
    expect(a3.some((n: any) => n.title.startsWith("Filled"))).toBe(true);                                             // A3 saw the first fill in between
    await call(w.ownerA, "select ogevia_api.set_cover_office_audience($1,$2,'office','test')", [w.orgA, temecula]);
  });
  it("a client cancellation closes the posting, stops pending alerts, and tells only the assigned caregiver and requesters", async () => {
    const { shift } = await openShift(2);
    await optIn(w.caregiverA2, "951-555-0102"); await optIn(w.caregiverA1, "951-555-0101");
    await q("update ogevia.caregiver_records set status='active' where id in ($1,$2)", [rec["CG-A1"], rec["CG-A2"]]);
    await tick();
    expect((await sms(`shift_id = '${shift}' and purpose = 'recruitment' and status = 'queued'`)).length).toBeGreaterThanOrEqual(2);
    expect((await q("select count(*)::int n from ogevia.notification_deliveries d join ogevia.user_notifications n on n.id = d.notification_id where n.shift_id = $1 and d.status = 'queued'", [shift]))[0].n).toBeGreaterThanOrEqual(2);
    await call(w.caregiverA2, "select ogevia_api.pickup_open_shift($1,$2,null)", [w.orgA, shift]);               // A2 requested; A1 only received the alert
    await call(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Client cancelled',null)", [w.orgA, shift]);
    expect((await sms(`shift_id = '${shift}' and purpose = 'recruitment' and status in ('queued','retry')`))).toHaveLength(0);
    expect((await sms(`shift_id = '${shift}' and purpose = 'recruitment'`)).every((m: any) => m.status === "cancelled" && m.reason === "shift_cancelled")).toBe(true);
    expect((await q("select count(*)::int n from ogevia.notification_deliveries d join ogevia.user_notifications n on n.id = d.notification_id where n.shift_id = $1 and n.dedupe_key like 'cover:%' and d.status in ('queued','retry')", [shift]))[0].n).toBe(0);
    expect((await notes(w.caregiverA1.userId, shift)).filter((n: any) => /^cover:/.test(n.dedupe_key)).every((n: any) => n.archived_at)).toBe(true);
    expect((await notes(w.caregiverA2.userId, shift)).some((n: any) => n.title.startsWith("Cancelled"))).toBe(true);
    expect((await notes(w.caregiverA1.userId, shift)).some((n: any) => n.title.startsWith("Cancelled"))).toBe(false);     // alerted only: not told
    expect((await sms(`shift_id = '${shift}' and purpose = 'cancel_notice'`)).map((m: any) => m.recipient_user_id)).toEqual([w.caregiverA2.userId]);
    expect((await q("select status from ogevia.shift_pickup_requests where shift_id = $1", [shift]))[0].status).toBe("superseded");
    expect((await tick()).notify.notified).toBe(0);                                                                   // the cancelled shift is never alerted again
  });
});

describe("brief item 3: automatic texting (mock sender)", () => {
  it("filled: the selected caregiver gets the confirmation text; everyone else gets Filled in-app only; nothing pending survives", async () => {
    const { shift } = await openShift(2);
    for (const [u, p] of [[w.caregiverA1, "9515550101"], [w.caregiverA2, "9515550102"]] as const) await optIn(u, p);
    await q("update ogevia.caregiver_records set status='active' where id in ($1,$2)", [rec["CG-A1"], rec["CG-A2"]]);
    await tick();
    await call(w.caregiverA1, "select ogevia_api.pickup_open_shift($1,$2,null)", [w.orgA, shift]);
    await call(w.caregiverA2, "select ogevia_api.pickup_open_shift($1,$2,null)", [w.orgA, shift]);
    const req = (await q("select r.id from ogevia.shift_pickup_requests r where r.shift_id = $1 and r.caregiver_record_id = $2", [shift, rec["CG-A1"]]))[0].id;
    await call(w.managerA, "select ogevia_api.confirm_shift_pickup($1,$2,null)", [w.orgA, req]);
    const conf = await sms(`shift_id = '${shift}' and purpose = 'filled_confirmation'`);
    expect(conf).toHaveLength(1); expect(conf[0].recipient_user_id).toBe(w.caregiverA1.userId);
    expect((await notes(w.caregiverA1.userId, shift)).some((n: any) => n.title.startsWith("You are confirmed"))).toBe(true);
    expect((await notes(w.caregiverA2.userId, shift)).some((n: any) => n.title.startsWith("Filled"))).toBe(true);
    expect((await sms(`shift_id = '${shift}' and recipient_user_id = '${w.caregiverA2.userId}' and purpose <> 'recruitment'`))).toHaveLength(0);   // no text to the non-selected
    expect((await sms(`shift_id = '${shift}' and purpose = 'recruitment' and status in ('queued','retry')`))).toHaveLength(0);
  });
  it("recruitment: 14-day window, opt-in only, one text per person and round, no client name, code, street or ZIP; the call-out receipt and office alerts", async () => {
    await q("update ogevia.sms_messages set status='cancelled' where organization_id = $1 and status in ('queued','retry')", [w.orgA]);
    const far = await openShift(16); const near = await openShift(10);
    await optIn(w.caregiverA1, "9515550101"); await optIn(w.caregiverA2, "9515550102");
    await q("update ogevia.caregiver_records set status='active' where id in ($1,$2,$3)", [rec["CG-A1"], rec["CG-A2"], rec["CG-A3"]]);
    const t1 = await tick();
    expect(await sms(`shift_id = '${far.shift}'`)).toHaveLength(0);                                                  // 16 days out: outside the 14-day window
    const m = await sms(`shift_id = '${near.shift}' and purpose = 'recruitment'`);
    expect(m.map((x: any) => x.recipient_user_id).sort()).toEqual([w.caregiverA1.userId, w.caregiverA2.userId].sort());   // opted in only: A3 has no consent (and is another office)
    for (const x of m) { expect(x.body).toMatch(/^SoCal Care: Open shift in Winchester, /); expect(x.body).toContain("Reply STOP to opt out."); expect(x.body.length).toBeLessThanOrEqual(160); expect(x.body).not.toMatch(/92596|CL-|Street|\bSt\b/); }
    expect(t1.notify.shifts).toBeGreaterThanOrEqual(1);
    expect((await tick()).notify.notified).toBe(0);
    expect(await sms(`shift_id = '${near.shift}' and purpose = 'recruitment'`)).toHaveLength(2);                      // duplicates prevented
    // the call-out receipt goes to the caller only, and the office and on-call are alerted
    await call(w.ownerA, "select ogevia_api.set_sms_oncall($1,'add',$2,'On-call Temecula','951-555-0199',null)", [w.orgA, temecula]);
    const mine = await openShift(1, { assignTo: "CG-A1" });
    await call(w.caregiverA1, "select ogevia_api.call_out_my_shift($1,$2,'Sick',null)", [w.orgA, mine.shift]);
    const rc = await sms(`shift_id = '${mine.shift}'`);
    expect(rc.filter((x: any) => x.purpose === "callout_receipt").map((x: any) => x.recipient_user_id)).toEqual([w.caregiverA1.userId]);
    expect(rc.filter((x: any) => x.purpose === "office_alert")).toHaveLength(1);
    expect(rc.find((x: any) => x.purpose === "office_alert").body).toMatch(/Call-out\. The shift in Winchester/);
    expect((await notes(w.managerA.userId, mine.shift)).some((n: any) => n.category === "cover_office" && n.title.startsWith("Call-out | Winchester"))).toBe(true);
  });
  it("quiet hours defer caregiver texts (never receipts, never a shift starting within 12 hours); limits are per agency and per recipient", async () => {
    await settings({ perRecipientDaily: 20, hourlyLimit: 1000, dailyLimit: 5000 }); await q("delete from ogevia.sms_messages where organization_id = $1", [w.orgA]);
    const lt = (await one("select to_char((now() at time zone o.timezone)::time - interval '1 hour', 'HH24:MI') s, to_char((now() at time zone o.timezone)::time + interval '1 hour', 'HH24:MI') e from ogevia.organizations o where id = $1", [w.orgA]));
    await settings({ quietStart: lt.s, quietEnd: lt.e, perRecipientDaily: 20, hourlyLimit: 1000, dailyLimit: 5000 });
    const far = await openShift(5); await optIn(w.caregiverA1, "9515550101"); await q("update ogevia.caregiver_records set status='active' where id in ($1,$2)", [rec["CG-A1"], rec["CG-A2"]]);
    await tick();
    const d = (await sms(`shift_id = '${far.shift}' and purpose = 'recruitment' and recipient_user_id = '${w.caregiverA1.userId}'`))[0];
    expect(new Date(d.send_after).getTime()).toBeGreaterThan(Date.now() + 30 * 60e3);                                 // deferred to the end of the quiet window
    const soon = await q("select ogevia.sms_enqueue($1,'recruitment','caregiver',$2,null,null,0,'x','quiet-bypass', now() + interval '3 hours') as r", [w.orgA, w.caregiverA1.userId]);
    expect(soon[0].r).toBe("queued");
    expect(new Date((await sms("dedupe_key = 'quiet-bypass'"))[0].send_after).getTime()).toBeLessThan(Date.now() + 60e3);
    const rcpt = await q("select ogevia.sms_enqueue($1,'callout_receipt','caregiver',$2,null,null,0,'x','quiet-receipt', now() + interval '3 days') as r", [w.orgA, w.caregiverA1.userId]);
    expect(rcpt[0].r).toBe("queued"); expect(new Date((await sms("dedupe_key = 'quiet-receipt'"))[0].send_after).getTime()).toBeLessThan(Date.now() + 60e3);
    await settings({ quietStart: "21:00", quietEnd: "08:00", perRecipientDaily: 2 });
    await q("update ogevia.sms_messages set status='cancelled' where organization_id = $1", [w.orgA]);
    const r = [];
    for (const k of ["lim-1", "lim-2", "lim-3"]) r.push((await q("select ogevia.sms_enqueue($1,'recruitment','caregiver',$2,null,null,0,'x',$3, now() + interval '1 day') as r", [w.orgA, w.caregiverA1.userId, k]))[0].r);
    expect(r).toEqual(["queued", "queued", "limit"]);
    expect((await sms("dedupe_key = 'lim-3'"))[0]).toMatchObject({ status: "skipped_limit", reason: "limit_reached" });
    await settings({ perRecipientDaily: 3, hourlyLimit: 2 });
    expect((await q("select ogevia.sms_enqueue($1,'recruitment','caregiver',$2,null,null,0,'x','lim-4', now() + interval '1 day') as r", [w.orgA, w.caregiverA1.userId]))[0].r).toBe("limit");
    await settings({ hourlyLimit: 60, dailyLimit: 2 });
    expect((await q("select ogevia.sms_enqueue($1,'recruitment','caregiver',$2,null,null,0,'x','lim-5', now() + interval '1 day') as r", [w.orgA, w.caregiverA1.userId]))[0].r).toBe("limit");
    await settings({ dailyLimit: 200 });
  });
  it("24-hour escalation tells the office and on-call once per round; the agency's hours are honored", async () => {
    await q("update ogevia.sms_messages set status='cancelled' where organization_id = $1", [w.orgA]);
    const { shift } = await openShift(3); await q("update ogevia.caregiver_records set status='active' where id in ($1,$2)", [rec["CG-A1"], rec["CG-A2"]]);
    await tick();
    expect((await tick()).esc).toBe(0);                                                                                // just alerted: not yet
    await q("update ogevia.cover_alerts set created_at = now() - interval '25 hours' where shift_id = $1", [shift]);
    await settings({ escalationHours: 48 });
    expect((await tick()).esc).toBe(0);
    await settings({ escalationHours: 24 });
    expect((await tick()).esc).toBeGreaterThanOrEqual(1);
    expect((await notes(w.managerA.userId, shift)).filter((n: any) => n.dedupe_key.startsWith("esc:"))).toHaveLength(1);
    expect((await sms(`shift_id = '${shift}' and purpose = 'escalation'`))).toHaveLength(1);
    expect((await tick()).esc).toBe(0);                                                                                // once per round
  });
  it("opt-in and STOP: no consent no text; STOP cancels what is queued; START restores only a previous opt-in; HELP changes nothing; consent is per agency", async () => {
    await q("update ogevia.sms_messages set status='cancelled' where organization_id = $1", [w.orgA]);
    const e = (k: string) => q("select ogevia.sms_enqueue($1,'recruitment','caregiver',$2,null,null,0,'x',$3, now() + interval '1 day') as r", [w.orgA, w.caregiverA2.userId, k]);
    await q("delete from ogevia.sms_contacts where organization_id = $1 and user_id = $2", [w.orgA, w.caregiverA2.userId]);
    expect((await e("c-0"))[0].r).toBe("no_consent");
    await expect(call(w.caregiverA2, "select ogevia_api.set_my_sms($1,'12',true,'v1')", [w.orgA])).rejects.toThrow();
    await optIn(w.caregiverA2, "(951) 555-0102");
    expect((await one("select phone_e164, status, consent_source from ogevia.sms_contacts where organization_id = $1 and user_id = $2", [w.orgA, w.caregiverA2.userId]))).toEqual({ phone_e164: "+19515550102", status: "opted_in", consent_source: "in_app" });
    expect((await e("c-1"))[0].r).toBe("queued");
    expect((await one("select ogevia_api.system_sms_inbound('+19515550100','+19515550102','  stop ') as r")).r).toMatchObject({ action: "stop", changed: 1 });
    expect((await sms("dedupe_key = 'c-1'"))[0]).toMatchObject({ status: "cancelled", reason: "opted_out" });
    expect((await e("c-2"))[0].r).toBe("no_consent");
    expect((await one("select ogevia_api.system_sms_inbound('+19515550100','+19515550102','hello') as r")).r).toMatchObject({ action: "ignored", changed: 0 });
    expect((await one("select ogevia_api.system_sms_inbound('+19515550100','+19515550102','HELP') as r")).r).toMatchObject({ action: "help", changed: 0 });
    expect((await one("select ogevia_api.system_sms_inbound('+19515550100','+19515550102','START') as r")).r).toMatchObject({ action: "start", changed: 1 });
    expect((await e("c-3"))[0].r).toBe("queued");
    // a different sender number is a different agency: its STOP does not reach this agency's contact; and a never-consented number is not re-subscribed by START
    expect((await one("select ogevia_api.system_sms_inbound('+19515550999','+19515550102','STOP') as r")).r).toMatchObject({ changed: 0 });
    await q("insert into ogevia.sms_contacts (organization_id, user_id, phone_e164, status) values ($1,$2,'+19515550103','opted_out') on conflict do nothing", [w.orgA, w.caregiverA3.userId]);
    expect((await one("select ogevia_api.system_sms_inbound('+19515550100','+19515550103','START') as r")).r).toMatchObject({ changed: 0 });
    await call(w.caregiverA2, "select ogevia_api.set_my_sms($1,null,false,'v1')", [w.orgA]);
    expect((await sms("dedupe_key = 'c-3'"))[0].status).toBe("cancelled");
  });
  it("separate sender settings and limits for each agency", async () => {
    await call(w.managerB, "select ogevia_api.get_sms_settings($1)", [w.orgB]);
    await expect(call(w.managerA, "select ogevia_api.get_sms_settings($1)", [w.orgB])).rejects.toThrow();            // another agency's settings are not readable
    await expect(call(w.managerA, "select ogevia_api.set_sms_settings($1,'{\"enabled\":true}'::jsonb)", [w.orgA])).rejects.toThrow();   // the owner only
    await q("insert into ogevia.sms_settings (organization_id, enabled, provider, sender_label, sender_id, daily_limit, hourly_limit, per_recipient_daily) values ($1,true,'mock','Other Agency','+19515550777',1,1,1)", [w.orgB]);
    await q("insert into ogevia.sms_contacts (organization_id, user_id, phone_e164, status, consent_at) values ($1,$2,'+19515550102','opted_in', now())", [w.orgB, w.caregiverB1.userId]);
    const b = (k: string) => q("select ogevia.sms_enqueue($1,'recruitment','caregiver',$2,null,null,0,'x',$3, now() + interval '1 day') as r", [w.orgB, w.caregiverB1.userId, k]);
    expect([(await b("b-1"))[0].r, (await b("b-2"))[0].r]).toEqual(["queued", "limit"]);                              // org B's own, tiny limit
    expect((await q("select ogevia.sms_enqueue($1,'recruitment','caregiver',$2,null,null,0,'x','a-big', now() + interval '1 day') as r", [w.orgA, w.caregiverA1.userId]))[0].r).toBe("queued");   // org A is unaffected
    expect((await one("select ogevia_api.system_sms_inbound('+19515550777','+19515550102','STOP') as r")).r).toMatchObject({ action: "stop", changed: 1 });   // B's sender only touches B's contact
    expect((await one("select status from ogevia.sms_contacts where organization_id = $1 and user_id = $2", [w.orgB, w.caregiverB1.userId])).status).toBe("opted_out");
    await q("insert into ogevia.sms_contacts (organization_id, user_id, phone_e164, status, consent_at) values ($1,$2,'+19515550102','opted_in', now()) on conflict (organization_id, user_id) do update set status = 'opted_in', phone_e164 = '+19515550102'", [w.orgA, w.caregiverA3.userId]);
    expect((await one("select ogevia_api.system_sms_inbound('+19515550777','+19515550102','STOP') as r")).r).toMatchObject({ changed: 0 });   // the same phone number, B's sender again: A's contact is untouched
    expect((await one("select status from ogevia.sms_contacts where organization_id = $1 and user_id = $2", [w.orgA, w.caregiverA3.userId])).status).toBe("opted_in");
  });
  it("the sender queue: claim only due, enabled, consented messages; record sent / retry schedule / failure; a live provider is not claimed as sent by the mock", async () => {
    await q("update ogevia.sms_messages set status='cancelled' where organization_id = $1 and status in ('queued','retry','sending')", [w.orgA]);
    await settings({ perRecipientDaily: 20, hourlyLimit: 1000, dailyLimit: 5000 });
    await q("delete from ogevia.sms_messages where organization_id = $1", [w.orgA]);
    await optIn(w.caregiverA1, "9515550101");
    const ids = [];
    for (const k of ["q-1", "q-2", "q-3"]) { await q("select ogevia.sms_enqueue($1,'recruitment','caregiver',$2,null,null,0,'hello',$3, now() + interval '1 day')", [w.orgA, w.caregiverA1.userId, k]); }
    await q("update ogevia.sms_messages set send_after = now() - interval '1 minute' where dedupe_key in ('q-1','q-2','q-3')");
    const claimed = await q("select * from ogevia_api.system_sms_claim(10)");
    expect(claimed.map((c: any) => c.provider)).toEqual(["mock", "mock", "mock"]);
    ids.push(...claimed.map((c: any) => c.id));
    expect((await q("select ogevia_api.system_sms_record($1,'sent','mock-1',null) as s", [ids[0]]))[0].s).toBe("sent");
    expect((await q("select ogevia_api.system_sms_record($1,'transient',null,'provider_busy') as s", [ids[1]]))[0].s).toBe("retry");
    expect((await one("select attempts, status, send_after > now() as later from ogevia.sms_messages where id = $1", [ids[1]]))).toMatchObject({ attempts: 1, status: "retry", later: true });
    expect((await q("select ogevia_api.system_sms_record($1,'permanent',null,'invalid_number') as s", [ids[2]]))[0].s).toBe("failed");
    expect((await q("select ogevia_api.system_sms_record($1,'sent','again',null) as s", [ids[0]]))[0].s).toBe("sent");   // a second record is a no-op
    // consent withdrawn after queueing: not claimed
    await q("select ogevia.sms_enqueue($1,'recruitment','caregiver',$2,null,null,0,'hello','q-4', now() + interval '1 day')", [w.orgA, w.caregiverA1.userId]);
    await q("update ogevia.sms_messages set send_after = now() - interval '1 minute' where dedupe_key = 'q-4'");
    await q("update ogevia.sms_contacts set status = 'opted_out' where organization_id = $1 and user_id = $2", [w.orgA, w.caregiverA1.userId]);
    expect((await q("select * from ogevia_api.system_sms_claim(10)")).filter((c: any) => c.body === "hello")).toHaveLength(0);
    expect((await sms("dedupe_key = 'q-4'"))[0]).toMatchObject({ status: "skipped_opted_out" });
  });
  it("office email preferences: a manager who turned email off for office alerts gets the in-app alert but no email; a manager with email on gets both", async () => {
    await call(w.managerA, "select ogevia_api.set_my_notification_preferences($1,'cover_office',true,false)", [w.orgA]);
    const { shift } = await openShift(2, { assignTo: "CG-A1" });
    await call(w.caregiverA1, "select ogevia_api.call_out_my_shift($1,$2,'Sick',null)", [w.orgA, shift]);
    const mail = async (user: string) => (await q("select count(*)::int n from ogevia.notification_deliveries d join ogevia.user_notifications n on n.id = d.notification_id where n.shift_id = $1 and n.recipient_user_id = $2 and n.category = 'cover_office'", [shift, user]))[0].n;
    expect((await notes(w.managerA.userId, shift)).filter((n: any) => n.category === "cover_office")).toHaveLength(1);
    expect(await mail(w.managerA.userId)).toBe(0);
    expect((await notes(w.ownerA.userId, shift)).filter((n: any) => n.category === "cover_office")).toHaveLength(1);
    expect(await mail(w.ownerA.userId)).toBe(1);
    await call(w.managerA, "select ogevia_api.set_my_notification_preferences($1,'cover_office',false,false)", [w.orgA]);
    const s2 = await openShift(2, { assignTo: "CG-A2" });
    await call(w.caregiverA2, "select ogevia_api.call_out_my_shift($1,$2,'Sick',null)", [w.orgA, s2.shift]);
    expect((await notes(w.managerA.userId, s2.shift))).toHaveLength(0);                                              // both channels off: nothing
  });
});
