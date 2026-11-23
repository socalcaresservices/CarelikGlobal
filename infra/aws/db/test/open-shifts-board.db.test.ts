// Open Shifts board and automatic SMS (0086). SYNTHETIC data only; the SMS transport is never involved here: these tests drive the database functions
// the worker calls (system_sms_claim / system_sms_record / system_sms_receipt / system_sms_stop / system_coverage_sweep) and assert the rows they leave.
// Brief 2026-11-22, Option A: first come, office approves. Acceptance numbers in the test names refer to the TEST acceptance criteria in the brief.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
const rec: Record<string, string> = {};
const SENDER_A = "+18885550101";
const SENDER_B = "+18885550102";

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
  await db.admin.query("update ogevia.organizations set slug = 'socal-care-services' where id = $1", [w.orgA]);
});
afterAll(async () => db?.drop());

const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
/** The scheduled worker: the application role, no signed-in person. */
async function sys(sql: string, params: unknown[] = []) {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role ogevia_app");
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows as any[];
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
let next = 2;
let slotN = 0;
/** A day inside the 14-day window and an hour block no other fixture uses, so caregivers never collide across tests. */
const slot = () => { const n = slotN++; const h = 5 + Math.floor(n / 11) * 2; const pad = (x: number) => String(x).padStart(2, "0"); return { d: day(1 + (n % 11)), start: `${pad(h)}:00`, end: `${pad(h + 1)}:30` }; };
type Fx = { client: string; service: string; auth: string };

async function fixture(city: string | null = "Winchester", minutes = 20000): Promise<Fx> {
  const f = await freshClient(db, w, w.caregiverA1, minutes, w.orgA, { before: 60, after: 60 });
  await db.admin.query("update ogevia.clients set city = $2 where id = $1", [f.client, city]);
  return f;
}
const openShift = (f: Fx, start?: string, end?: string, d?: string) => { const sl = slot(); return openShiftAt(f, start ?? sl.start, end ?? sl.end, d ?? sl.d); };
const openShiftAt = (f: Fx, start: string, end: string, d: string) =>
  q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,null)", [w.orgA, f.client, f.service, d, start, end]).then((r) => r[0].shift_id as string);
const assignedShift = (f: Fx, cg: string, start?: string, end?: string, d?: string) => { const sl = slot(); return assignedShiftAt(f, cg, start ?? sl.start, end ?? sl.end, d ?? sl.d); };
const assignedShiftAt = (f: Fx, cg: string, start: string, end: string, d: string) =>
  q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,null)", [w.orgA, f.client, f.service, d, start, end, rec[cg]]).then((r) => r[0].shift_id as string);
const ref = async (shift: string) => (await db.admin.query("select public_ref from ogevia.shifts where id = $1", [shift])).rows[0].public_ref as string;
const cities = (cg: string, list: string[]) =>
  q(w.managerA, "select ogevia_api.set_caregiver_coverage_cities($1,$2,$3::jsonb)", [w.orgA, rec[cg], JSON.stringify(list.map((city) => ({ city, state: "CA" })))]);
const post = (shift: string) => q(w.managerA, "select ogevia_api.post_shift_for_coverage($1,$2) s", [w.orgA, shift]).then((r) => r[0].s as string);
const unpost = (shift: string) => q(w.managerA, "select ogevia_api.unpost_shift($1,$2,'Synthetic') s", [w.orgA, shift]).then((r) => r[0].s as string);
const board = (a: Actor, org = w.orgA) => q(a, "select * from ogevia_api.list_open_shift_board($1)", [org]);
const request = (a: Actor, r: string) => q(a, "select ogevia_api.request_open_shift($1,$2) s", [w.orgA, r]).then((x) => x[0].s as string);
const reqs = (shift: string) => q(w.managerA, "select * from ogevia_api.list_coverage_requests($1,$2)", [w.orgA, shift]);
const confirm = (a: Actor, request_id: string, skip: string | null = null) => q(a, "select ogevia_api.confirm_coverage_request($1,$2,$3) s", [w.orgA, request_id, skip]).then((r) => r[0].s as string);
const jobs = async (shift: string, purpose?: string) =>
  (await db.admin.query("select * from ogevia.notification_jobs where shift_id = $1 and ($2::text is null or purpose = $2) order by created_at", [shift, purpose ?? null])).rows;
const rounds = async (shift: string) => (await db.admin.query("select * from ogevia.shift_coverage_rounds where shift_id = $1 order by round_no", [shift])).rows;
const shiftRow = async (id: string) => (await db.admin.query("select caregiver_record_id, status from ogevia.shifts where id = $1", [id])).rows[0];
const reservation = async (id: string) => (await db.admin.query("select reserved_minutes, released_at from ogevia.authorization_reservations where shift_id = $1", [id])).rows;
const requestStatus = async (shift: string, cg: string) =>
  (await db.admin.query("select status, decision_reason from ogevia.shift_pickup_requests where shift_id = $1 and caregiver_record_id = $2 order by request_seq desc limit 1", [shift, rec[cg]])).rows[0];

/** SMS set up for an agency: the platform side (entitlement, verified sender) by SQL, the agency side through the API as the owner. */
async function smsOn(org = w.orgA, owner: Actor | null = w.ownerA, sender = SENDER_A, limit = 100) {
  await db.admin.query("update ogevia.agency_open_shift_settings set sms_entitled = true, sender_status = 'verified', sender_number = $2 where organization_id = $1", [org, sender]);
  if (owner) await asActor(db, owner.sub, (c) => c.query("select ogevia_api.update_open_shift_settings($1,$2::jsonb)", [org, JSON.stringify({ smsEnabled: true, monthlySendLimit: limit, quietBypass: true })]));
  else await db.admin.query("update ogevia.agency_open_shift_settings set sms_enabled = true, monthly_send_limit = $2, quiet_bypass = true where organization_id = $1", [org, limit]);
}
const optIn = (a: Actor, phone: string, org = w.orgA) => q(a, "select ogevia_api.set_my_sms_consent($1,$2,true,'test')", [org, phone]);
const claim = () => sys("select * from ogevia_api.system_sms_claim(50)");

describe("board visibility by service city (acceptance 1, 3)", () => {
  it("a saved unassigned shift is off the board until staff posts it; a caregiver covering the city sees it with city and time only; others and other agencies do not", async () => {
    await cities("CG-A2", ["Winchester"]);
    await cities("CG-A3", ["Temecula"]);
    const f = await fixture("Winchester");
    const s = await openShift(f);
    expect(await board(w.caregiverA2)).toEqual([]);
    expect(await post(s)).toBe("posted");
    expect(await post(s)).toBe("posted"); // repeat: no second round
    expect(await rounds(s)).toHaveLength(1);
    const rows = await board(w.caregiverA2);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["ends_at", "my_request_status", "service_city", "shift_ref", "starts_at", "timezone", "total_count"]);
    expect(rows[0]).toMatchObject({ service_city: "Winchester", shift_ref: await ref(s), my_request_status: null });
    expect(JSON.stringify(rows)).not.toContain(f.client);
    expect(await board(w.caregiverA3)).toEqual([]);
    expect(await board(w.caregiverB1, w.orgB)).toEqual([]);
    // a copied link or a direct call for a shift outside the caregiver's cities, or another agency's shift: the same answer as "does not exist"
    await expectPgError(request(w.caregiverA3, await ref(s)), "OGC09", /no longer available/);
    await expectPgError(q(w.caregiverB1, "select ogevia_api.request_open_shift($1,$2) s", [w.orgB, await ref(s)]), "OGC09", /no longer available/);
    await expectPgError(q(w.caregiverB1, "select ogevia_api.request_open_shift($1,$2) s", [w.orgA, await ref(s)]), "OGA03");
    const link = await q(w.caregiverA3, "select * from ogevia_api.get_open_shift($1,$2)", [w.orgA, await ref(s)]);
    expect(link[0]).toMatchObject({ state: "unavailable", service_city: null, starts_at: null });
  });

  it("a shift with no city is not exposed and shows the office why; setting the city exposes it", async () => {
    const f = await fixture(null);
    const s = await openShift(f);
    await post(s);
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).not.toContain(await ref(s));
    const queue = await q(w.managerA, "select * from ogevia_api.list_coverage_queue($1)", [w.orgA]);
    expect(queue.find((r) => r.shift_id === s)).toMatchObject({ posting_state: "posted", escalation_reasons: expect.arrayContaining(["missing_city"]) });
    await q(w.managerA, "select ogevia_api.set_shift_service_city($1,$2,'Winchester','CA')", [w.orgA, s]);
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).toContain(await ref(s));
  });

  it("two cities with the same name in different states are different coverage areas", async () => {
    const f = await fixture(null);
    const s = await openShift(f);
    await q(w.managerA, "select ogevia_api.set_shift_service_city($1,$2,'Springfield','OR')", [w.orgA, s]);
    await post(s);
    await q(w.managerA, "select ogevia_api.set_caregiver_coverage_cities($1,$2,$3::jsonb)", [w.orgA, rec["CG-A3"], JSON.stringify([{ city: "springfield", state: "CA" }])]);
    expect(await board(w.caregiverA3)).toEqual([]);
    await q(w.managerA, "select ogevia_api.set_caregiver_coverage_cities($1,$2,$3::jsonb)", [w.orgA, rec["CG-A3"], JSON.stringify([{ city: "  SPRINGFIELD ", state: "or" }, { city: "Temecula", state: "CA" }])]);
    expect((await board(w.caregiverA3)).map((r) => r.shift_ref)).toContain(await ref(s));
    await cities("CG-A3", ["Temecula"]);
  });
});

describe("requests, withdrawal and the checks that stay (acceptance 2)", () => {
  it("a caregiver requests and withdraws; the request never assigns; an overlapping shift blocks the request with a useful message", async () => {
    const f = await fixture("Winchester");
    const s = await openShift(f, "13:00", "15:00");
    await post(s);
    expect(await request(w.caregiverA2, await ref(s))).toBe("requested");
    expect(await request(w.caregiverA2, await ref(s))).toBe("requested"); // repeat tap
    expect((await board(w.caregiverA2)).find((r) => r.my_request_status === "requested")).toBeTruthy();
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
    expect((await q(w.caregiverA2, "select ogevia_api.withdraw_open_shift_request($1,$2) s", [w.orgA, await ref(s)]))[0].s).toBe("withdrawn");
    // an overlapping assignment of the same caregiver on the same day
    const d = day(next++);
    const other = await assignedShift(f, "CG-A2", "10:00", "12:00", d);
    const t = await openShift(f, "11:00", "13:00", d);
    await post(t);
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).not.toContain(await ref(t));
    expect(other).toBeTruthy();
  });

  it("the caregiver who called out never sees, requests or is texted for the shift again", async () => {
    const f = await fixture("Winchester");
    await cities("CG-A1", ["Winchester"]);
    const s = await assignedShift(f, "CG-A1");
    await q(w.managerA, "select ogevia_api.record_shift_callout($1,$2,'Synthetic sick',null)", [w.orgA, s]);
    expect((await board(w.caregiverA1)).map((r) => r.shift_ref)).not.toContain(await ref(s));
    await expectPgError(request(w.caregiverA1, await ref(s)), "OGC09");
  });
});

describe("call-out reposts the same shift; client cancellation closes it (acceptance 3, 9)", () => {
  it("a call-out auto-posts the SAME shift in a new round with its reservation intact; the caller-out gets a receipt job and the office a notice", async () => {
    await q(w.ownerA, "select ogevia_api.upsert_office_contact($1,null,'Synthetic office','+13105550001',null,true,false,false,true)", [w.orgA]);
    await q(w.ownerA, "select ogevia_api.upsert_office_contact($1,null,'Synthetic on-call','+13105550002',null,true,false,true,true)", [w.orgA]);
    const f = await fixture("Winchester");
    const s = await assignedShift(f, "CG-A1");
    const before = await reservation(s);
    await q(w.managerA, "select ogevia_api.record_shift_callout($1,$2,'Synthetic sick',null)", [w.orgA, s]);
    const rs = await rounds(s);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ state: "posted", open_source: "callout", round_no: 1, former_caregiver_record_id: rec["CG-A1"] });
    expect(await reservation(s)).toEqual(before);
    expect((await jobs(s, "callout_receipt")).map((j) => j.recipient_caregiver_record_id)).toEqual([rec["CG-A1"]]);
    expect((await jobs(s, "office_callout")).length).toBeGreaterThanOrEqual(1);
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).toContain(await ref(s));
    // an ordinary edit or a repeat of the call-out does not make another round or another receipt
    await expectPgError(q(w.managerA, "select ogevia_api.record_shift_callout($1,$2,'Synthetic again',null)", [w.orgA, s]), "OGC09");
    expect(await rounds(s)).toHaveLength(1);
    expect(await jobs(s, "callout_receipt")).toHaveLength(1);
  });

  it("a client cancellation closes the posting and its requests, releases the reservation, stops unsent recruitment, tells the assigned caregiver, and old links say unavailable", async () => {
    await smsOn();
    await optIn(w.caregiverA2, "310-555-0102");
    const f = await fixture("Winchester");
    const s = await openShift(f);
    await post(s);
    await request(w.caregiverA2, await ref(s));
    expect((await jobs(s, "open_shift")).length).toBe(1);
    await q(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic client cancelled',null)", [w.orgA, s]);
    expect((await rounds(s))[0]).toMatchObject({ state: "closed", closed_reason: "client_cancelled" });
    expect((await jobs(s, "open_shift"))[0]).toMatchObject({ status: "suppressed" });
    expect((await requestStatus(s, "CG-A2"))).toMatchObject({ status: "closed" });
    expect((await reservation(s))[0].released_at).not.toBeNull();
    expect(await jobs(s, "client_cancel")).toHaveLength(0); // nobody was assigned
    await claim();
    const l = await q(w.caregiverA2, "select * from ogevia_api.get_open_shift($1,$2)", [w.orgA, await ref(s)]);
    expect(l[0]).toMatchObject({ state: "unavailable" });
    // an assigned shift cancelled by the client texts the assigned caregiver only
    const a = await assignedShift(f, "CG-A2");
    await q(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic client cancelled',null)", [w.orgA, a]);
    expect((await jobs(a, "client_cancel")).map((j) => j.recipient_caregiver_record_id)).toEqual([rec["CG-A2"]]);
  });
});

describe("the alert window, quiet hours and agency time (acceptance 4)", () => {
  it("a shift 20 days out is posted now, texts nobody until it enters the 14-day window, then texts once; a shift filled before dispatch sends nothing", async () => {
    await smsOn();
    await optIn(w.caregiverA2, "310-555-0102");
    const f = await fixture("Winchester");
    const far = await openShift(f, "09:00", "11:00", day(20));
    await post(far);
    expect(await jobs(far, "open_shift")).toHaveLength(0);
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).toContain(await ref(far)); // visible on the board now
    await sys("select ogevia_api.system_coverage_sweep()");
    expect(await jobs(far, "open_shift")).toHaveLength(0); // still outside the window
    // the window opens (settings change stands in for the calendar moving): the next sweep plans exactly one text
    await q(w.ownerA, "select ogevia_api.update_open_shift_settings($1,'{\"alertWindowDays\":30}'::jsonb)", [w.orgA]);
    await sys("select ogevia_api.system_coverage_sweep()");
    await sys("select ogevia_api.system_coverage_sweep()");
    expect(await jobs(far, "open_shift")).toHaveLength(1);
    await q(w.ownerA, "select ogevia_api.update_open_shift_settings($1,'{\"alertWindowDays\":14}'::jsonb)", [w.orgA]);
    // filled before dispatch: no text
    await q(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Synthetic office fill',null)", [w.orgA, far, rec["CG-A3"]]);
    const sent = await claim();
    expect(sent.filter((c) => c.body_template.includes("Open shift"))).toEqual([]);
    expect((await jobs(far, "open_shift"))[0]).toMatchObject({ status: "suppressed" });
  });

  it("recruitment texts wait out quiet hours (and are re-checked then); the agency-local date and an overnight shift's two dates are rendered correctly", async () => {
    const [{ fmt }] = (await db.admin.query(
      "select ogevia.fmt_sms_when(timestamptz '2026-11-27 13:30-08', timestamptz '2026-11-27 17:00-08', 'America/Los_Angeles') fmt")).rows;
    expect(fmt).toBe("Fri Nov 27, 1:30-5:00 PM");
    expect((await db.admin.query("select ogevia.fmt_sms_when(timestamptz '2026-11-27 11:00-08', timestamptz '2026-11-27 14:00-08', 'America/Los_Angeles') f")).rows[0].f).toBe("Fri Nov 27, 11:00 AM-2:00 PM");
    expect((await db.admin.query("select ogevia.fmt_sms_when(timestamptz '2026-11-27 22:00-08', timestamptz '2026-11-28 02:00-08', 'America/Los_Angeles') f")).rows[0].f).toBe("Fri Nov 27, 10:00 PM-Sat Nov 28, 2:00 AM");
    // 2026-11-28 03:00 UTC is Fri Nov 27 7:00 PM in Los Angeles: the agency-local date is the 27th, not the 28th
    expect((await db.admin.query("select ogevia.fmt_sms_when(timestamptz '2026-11-28 03:00+00', timestamptz '2026-11-28 05:00+00', 'America/Los_Angeles') f")).rows[0].f).toBe("Fri Nov 27, 7:00-9:00 PM");

    await smsOn();
    await db.admin.query("update ogevia.agency_open_shift_settings set quiet_bypass = false, quiet_start = (now() at time zone 'America/Los_Angeles')::time - interval '1 hour', quiet_end = (now() at time zone 'America/Los_Angeles')::time + interval '1 hour' where organization_id = $1", [w.orgA]);
    await optIn(w.caregiverA2, "310-555-0102");
    const f = await fixture("Winchester");
    const s = await openShift(f);
    await post(s);
    const job = (await jobs(s, "open_shift")).find((j) => j.recipient_caregiver_record_id === rec["CG-A2"])!;
    expect(job.status).toBe("queued");
    expect((await claim()).filter((c) => c.job_id === job.id)).toEqual([]);
    const after = (await jobs(s, "open_shift")).find((j) => j.id === job.id)!;
    expect(after.status).toBe("queued");
    expect(new Date(after.not_before).getTime()).toBeGreaterThan(Date.now());
    await q(w.ownerA, "select ogevia_api.update_open_shift_settings($1,'{\"quietBypass\":true}'::jsonb)", [w.orgA]);
    await db.admin.query("update ogevia.notification_jobs set not_before = now() where id = $1", [job.id]);
    expect((await claim()).filter((c) => c.job_id === job.id)).toHaveLength(1);
  });
});

describe("who is texted, and exactly once (acceptance 5)", () => {
  it("opted-out, ineligible, other-city and called-out caregivers get no recruitment text; the caller-out still gets their own receipt; retries and a repeated worker run never duplicate", async () => {
    await smsOn();
    await optIn(w.caregiverA1, "310-555-0101");
    await optIn(w.caregiverA2, "310-555-0102");
    await optIn(w.caregiverA3, "310-555-0103");
    await q(w.caregiverA3, "select ogevia_api.set_my_sms_consent($1,'310-555-0103',false,'test')", [w.orgA]); // opted out
    await cities("CG-A1", ["Winchester"]);
    await cities("CG-A2", ["Winchester"]);
    await cities("CG-A3", ["Winchester"]);
    const f = await fixture("Winchester");
    const s = await assignedShift(f, "CG-A1");
    await q(w.managerA, "select ogevia_api.record_shift_callout($1,$2,'Synthetic sick',null)", [w.orgA, s]);
    const open = await jobs(s, "open_shift");
    expect(open.map((j) => j.recipient_caregiver_record_id)).toEqual([rec["CG-A2"]]); // A1 called out, A3 opted out
    expect((await jobs(s, "callout_receipt")).map((j) => j.recipient_caregiver_record_id)).toEqual([rec["CG-A1"]]);
    const first = (await claim()).filter((c) => open.some((j) => j.id === c.job_id));
    expect(first).toHaveLength(1);
    expect(first[0].body_template).toMatch(/^(SoCal|socal-care-services|[^:]+): Open shift in Winchester, /);
    expect(first[0].body_template).not.toMatch(/Synthetic|client/i);
    expect(first[0].to_phone).toBe("+13105550102");
    expect(first[0].sender_number).toBe(SENDER_A);
    // a repeated worker run claims nothing new for the same job
    expect((await claim()).filter((c) => c.job_id === first[0].job_id)).toEqual([]);
    // late opt-out after queueing: a new posting queued, then the caregiver opts out before dispatch
    const s2 = await openShift(f);
    await post(s2);
    await q(w.caregiverA2, "select ogevia_api.set_my_sms_consent($1,'310-555-0102',false,'test')", [w.orgA]);
    expect((await jobs(s2, "open_shift")).find((j) => j.recipient_caregiver_record_id === rec["CG-A2"])).toMatchObject({ status: "suppressed", suppress_reason: "opted_out" });
    await optIn(w.caregiverA2, "310-555-0102");
  });

  it("a provider timeout is 'unknown' and never retried; a definite transient failure is retried at most three times; success counts segments and the first-message STOP wording is added once", async () => {
    await smsOn();
    await cities("CG-A2", ["Winchester"]);
    await optIn(w.caregiverA2, "310-555-0102");
    await db.admin.query("update ogevia.caregiver_sms_consent set first_message_at = null where caregiver_record_id = $1", [rec["CG-A2"]]);
    const f = await fixture("Winchester");
    const s = await openShift(f);
    await post(s);
    const job = (await jobs(s, "open_shift")).find((j) => j.recipient_caregiver_record_id === rec["CG-A2"])!;
    let c = (await claim()).find((x) => x.job_id === job.id)!;
    expect(c.body_template).toContain("Reply STOP to opt out");
    expect(await sys("select ogevia_api.system_sms_record($1,$2,'transient',null,null,null,'Throttling') r", [c.job_id, c.claim_token])).toEqual([{ r: "queued" }]);
    // a stale claim token or a repeated report changes nothing
    expect((await sys("select ogevia_api.system_sms_record($1,$2,'accepted','x',1,0,null) r", [c.job_id, randomUUID()]))[0].r).toBe("queued");
    await db.admin.query("update ogevia.notification_jobs set not_before = now() where id = $1", [job.id]);
    c = (await claim()).find((x) => x.job_id === job.id)!;
    expect(await sys("select ogevia_api.system_sms_record($1,$2,'unknown',null,null,null,'Timeout') r", [c.job_id, c.claim_token])).toEqual([{ r: "unknown" }]);
    await db.admin.query("update ogevia.notification_jobs set not_before = now() where id = $1", [job.id]);
    expect((await claim()).filter((x) => x.job_id === job.id)).toEqual([]); // not retried
    // a second posting: accepted once
    const s2 = await openShift(f);
    await post(s2);
    const j2 = (await jobs(s2, "open_shift")).find((j) => j.recipient_caregiver_record_id === rec["CG-A2"])!;
    const c2 = (await claim()).find((x) => x.job_id === j2.id)!;
    expect(await sys("select ogevia_api.system_sms_record($1,$2,'accepted','msg-1',2,7500,null) r", [c2.job_id, c2.claim_token])).toEqual([{ r: "accepted" }]);
    expect((await jobs(s2, "open_shift")).find((j) => j.id === j2.id)).toMatchObject({ status: "accepted", provider_message_id: "msg-1", segments: 2 });
    expect(await sys("select ogevia_api.system_sms_receipt($1,'msg-1',true,null) r", [SENDER_A])).toEqual([{ r: "recorded" }]);
    expect(await sys("select ogevia_api.system_sms_receipt($1,'msg-1',true,null) r", [SENDER_B])).toEqual([{ r: "ignored" }]); // another sender cannot touch it
    expect((await jobs(s2, "open_shift")).find((j) => j.id === j2.id)!.status).toBe("delivered");
    const s3 = await openShift(f);
    await post(s3);
    const j3 = (await jobs(s3, "open_shift")).find((j) => j.recipient_caregiver_record_id === rec["CG-A2"])!;
    const c3 = (await claim()).find((x) => x.job_id === j3.id)!;
    expect(c3.body_template).not.toContain("Reply STOP"); // only the first message to a number
  });

  it("the monthly limit is enforced atomically, blocked sends are counted and shown, and the board still works", async () => {
    await smsOn(w.orgA, w.ownerA, SENDER_A, 0);
    await cities("CG-A2", ["Winchester"]);
    await optIn(w.caregiverA2, "310-555-0102");
    const f = await fixture("Winchester");
    const s = await openShift(f);
    await post(s);
    await claim();
    expect((await jobs(s, "open_shift")).find((j) => j.recipient_caregiver_record_id === rec["CG-A2"])).toMatchObject({ status: "suppressed", suppress_reason: "quota_exceeded" });
    const st = await q(w.ownerA, "select ogevia_api.get_open_shift_settings($1) s", [w.orgA]);
    expect(st[0].s.usage.blocked).toBeGreaterThanOrEqual(1);
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).toContain(await ref(s));
    await smsOn(); // restore the limit
  });

  it("no qualified recipient, or SMS unavailable: the posting stays on the board and the office queue says why", async () => {
    await db.admin.query("update ogevia.agency_open_shift_settings set sms_enabled = false where organization_id = $1", [w.orgA]);
    const f = await fixture("Winchester");
    const s = await openShift(f);
    await post(s);
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).toContain(await ref(s));
    const row = (await q(w.managerA, "select * from ogevia_api.list_coverage_queue($1)", [w.orgA])).find((r) => r.shift_id === s);
    expect(row.escalation_reasons).toEqual(expect.arrayContaining(["sms_unavailable", "no_recipients"]));
    await smsOn();
  });
});

describe("office approval: first come, office approves (acceptance 6, 8, 10)", () => {
  async function threeRequests() {
    await cities("CG-A1", ["Winchester"]); await cities("CG-A2", ["Winchester"]); await cities("CG-A3", ["Winchester"]);
    const f = await fixture("Winchester");
    const s = await openShift(f, "09:00", "10:30", day(30 + next++)); // far out: no SMS involved, no clash with other fixtures
    await post(s);
    const r = await ref(s);
    for (const [a, cg] of [[w.caregiverA1, "CG-A1"], [w.caregiverA2, "CG-A2"], [w.caregiverA3, "CG-A3"]] as const) {
      try { await request(a, r); } catch (e) { throw new Error(`${cg}: ${(e as Error).message} ${JSON.stringify((await db.admin.query("select s.starts_at, s.ends_at, x.check_name, x.message from ogevia.shifts s, lateral ogevia.readiness_checks(s.organization_id, $2, s.service_id, s.starts_at, s.ends_at, 'reschedule', s.id, s.client_id, true) x where s.public_ref = $1 and x.status = 'blocked'", [r, rec[cg]])).rows)} ${JSON.stringify((await db.admin.query("select starts_at, ends_at, status, (select caregiver_code from ogevia.caregiver_records c where c.id = s.caregiver_record_id) cg from ogevia.shifts s where caregiver_record_id = $1 and status = 'scheduled' order by starts_at", [rec[cg]])).rows)}`); }
    }
    return { f, s, r };
  }

  it("requests are listed in submission order, the earliest eligible is pre-selected, and approving it assigns exactly that caregiver with a text to them alone", async () => {
    await smsOn();
    for (const [a, p] of [[w.caregiverA1, "310-555-0101"], [w.caregiverA2, "310-555-0102"], [w.caregiverA3, "310-555-0103"]] as const) await optIn(a, p);
    const { s } = await threeRequests();
    const list = await reqs(s);
    expect(list.map((r) => r.caregiver_code)).toEqual(["CG-A1", "CG-A2", "CG-A3"]);
    expect(list.map((r) => r.order_position)).toEqual([1, 2, 3]);
    expect(list.map((r) => r.preselected)).toEqual([true, false, false]);
    expect(await confirm(w.managerA, list[0].request_id)).toBe("covered");
    expect((await shiftRow(s)).caregiver_record_id).toBe(rec["CG-A1"]);
    const st = await db.admin.query("select r.caregiver_record_id c, r.status, r.approved_order_position p, skipped_earlier_reason k from ogevia.shift_pickup_requests r join ogevia.caregiver_records cr on cr.id = r.caregiver_record_id where shift_id = $1 order by request_seq", [s]);
    expect(st.rows.map((r) => [r.status, r.p, r.k])).toEqual([["confirmed", 1, null], ["superseded", null, null], ["superseded", null, null]]);
    expect((await jobs(s, "assignment_confirmed")).map((j) => j.recipient_caregiver_record_id)).toEqual([rec["CG-A1"]]); // approved caregiver only
    const outcomes = await q(w.caregiverA2, "select * from ogevia_api.list_my_open_shift_requests($1)", [w.orgA]);
    expect(outcomes.find((o) => o.outcome === "filled")).toBeTruthy(); // in-app Filled, and no text job exists for them
    expect((await jobs(s)).filter((j) => j.recipient_caregiver_record_id === rec["CG-A2"] && j.purpose === "assignment_confirmed")).toEqual([]);
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).not.toContain(await ref(s));
    expect((await rounds(s))[0]).toMatchObject({ state: "closed", closed_reason: "filled" });
  });

  it("if the earliest request fails the recheck at approval, the next in submission order moves up with the reason; choosing someone else needs a reason that is recorded", async () => {
    const { s } = await threeRequests();
    await db.admin.query("update ogevia.caregiver_coverage_cities set removed_at = now() where caregiver_record_id = $1 and removed_at is null", [rec["CG-A1"]]);
    const list = await reqs(s);
    expect(list[0]).toMatchObject({ caregiver_code: "CG-A1", eligible: false, preselected: false });
    expect(list[0].blockers.join(" ")).toMatch(/service city/);
    expect(list[1]).toMatchObject({ caregiver_code: "CG-A2", order_position: 2, preselected: true });
    await expectPgError(confirm(w.managerA, list[0].request_id), "OGC09", /service city/); // an ineligible request cannot be approved
    await expectPgError(confirm(w.managerA, list[2].request_id), "OGV22", /reason/); // skipping an eligible earlier request needs a reason
    expect(await confirm(w.managerA, list[2].request_id, "Synthetic: lives closest")).toBe("covered");
    const done = (await db.admin.query("select approved_order_position p, skipped_earlier_reason k from ogevia.shift_pickup_requests where id = $1", [list[2].request_id])).rows[0];
    expect(done).toEqual({ p: 3, k: "Synthetic: lives closest" });
    expect((await shiftRow(s)).caregiver_record_id).toBe(rec["CG-A3"]);
    await cities("CG-A1", ["Winchester"]);
  });

  it("two approvals at the same instant yield exactly one assignment and one reservation; the loser changes nothing", async () => {
    const { s } = await threeRequests();
    const list = await reqs(s);
    const before = await reservation(s);
    const [a, b] = await Promise.allSettled([confirm(w.managerA, list[0].request_id), confirm(w.ownerA, list[1].request_id, "Synthetic race")]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(await reservation(s)).toEqual(before);
    const winner = a.status === "fulfilled" ? rec["CG-A1"] : rec["CG-A2"];
    expect((await shiftRow(s)).caregiver_record_id).toBe(winner);
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_coverage_events where shift_id = $1 and event_type = 'reassigned'", [s])).rows[0].n).toBe(1);
    expect((await jobs(s, "assignment_confirmed")).length).toBeLessThanOrEqual(1);
  });

  it("nothing is assigned by requests alone; an unpost resolves waiting requests visibly and a repost reuses the same round", async () => {
    const { s } = await threeRequests();
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
    expect(await unpost(s)).toBe("unposted");
    expect((await requestStatus(s, "CG-A2")).status).toBe("closed");
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).not.toContain(await ref(s));
    expect(await post(s)).toBe("posted");
    expect(await rounds(s)).toHaveLength(1);
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).toContain(await ref(s));
  });

  it("a replacement who calls out reopens the shift in a NEW round; competing requests from the old round need fresh agreement; the new caller-out is excluded", async () => {
    const { s } = await threeRequests();
    const list = await reqs(s);
    await confirm(w.managerA, list[1].request_id, "Synthetic: earliest is on leave");
    await q(w.managerA, "select ogevia_api.record_shift_callout($1,$2,'Synthetic replacement sick',null)", [w.orgA, s]);
    const rs = await rounds(s);
    expect(rs.map((r) => [r.round_no, r.state, r.open_source])).toEqual([[1, "closed", "manual"], [2, "posted", "replacement_callout"]]);
    expect(rs[0].closed_reason).toBe("filled");
    expect(rs[1]).toMatchObject({ former_caregiver_record_id: rec["CG-A2"] });
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).not.toContain(await ref(s));
    expect((await board(w.caregiverA1)).map((r) => r.shift_ref)).toContain(await ref(s)); // A1 may request again
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_pickup_requests where shift_id = $1 and status = 'pending'", [s])).rows[0].n).toBe(0);
  });

  it("changing the date, time or city after requests were made invalidates them for fresh agreement; an approval cannot go through on a stale request", async () => {
    const { s } = await threeRequests();
    const list = await reqs(s);
    await q(w.managerA, "select ogevia_api.set_shift_service_city($1,$2,'Temecula','CA')", [w.orgA, s]);
    expect((await requestStatus(s, "CG-A2")).status).toBe("invalidated");
    await expectPgError(confirm(w.managerA, list[0].request_id), "OGC09", /already invalidated/);
    const outcomes = await q(w.caregiverA2, "select * from ogevia_api.list_my_open_shift_requests($1)", [w.orgA]);
    expect(outcomes.find((o) => o.outcome === "changed")).toBeTruthy();
  });
});

describe("escalation and the office (acceptance 9)", () => {
  it("a cancellation alerts office contacts whatever the date; the on-call contact is added only outside office hours; an unfilled opening within 24 hours escalates once", async () => {
    await smsOn();
    await db.admin.query("update ogevia.agency_open_shift_settings set office_open = '00:00', office_close = '23:59:59' where organization_id = $1", [w.orgA]);
    const f = await fixture("Winchester");
    const far = await assignedShift(f, "CG-A2", "09:00", "11:00", day(40));
    await q(w.managerA, "select ogevia_api.record_shift_callout($1,$2,'Synthetic far call-out',null)", [w.orgA, far]);
    const during = await jobs(far, "office_callout");
    expect(during).toHaveLength(1); // the office contact only (office hours all day)
    await db.admin.query("update ogevia.agency_open_shift_settings set office_open = '00:00', office_close = '00:00:01' where organization_id = $1", [w.orgA]);
    const far2 = await assignedShift(f, "CG-A3", "09:00", "11:00", day(41));
    await q(w.managerA, "select ogevia_api.record_shift_callout($1,$2,'Synthetic after hours',null)", [w.orgA, far2]);
    expect((await jobs(far2, "office_callout")).length).toBe(2); // office contact + on-call
    // a shift that starts tomorrow and is unfilled: one escalation per round
    await q(w.ownerA, "select ogevia_api.update_open_shift_settings($1,'{\"escalationHours\":96}'::jsonb)", [w.orgA]);
    const near = await openShift(f, "04:00", "04:30", day(1));
    await post(near);
    await sys("select ogevia_api.system_coverage_sweep()");
    await sys("select ogevia_api.system_coverage_sweep()");
    expect((await jobs(near, "office_escalation")).length).toBeGreaterThanOrEqual(1);
    const per = await db.admin.query("select recipient_contact_id, count(*)::int n from ogevia.notification_jobs where shift_id = $1 and purpose = 'office_escalation' group by 1", [near]);
    expect(per.rows.every((r) => r.n === 1)).toBe(true);
    // filled: pending escalation text is suppressed
    await q(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Synthetic fill',null)", [w.orgA, near, rec["CG-A2"]]);
    await claim();
    expect((await jobs(near, "office_escalation")).every((j) => j.status === "suppressed")).toBe(true);
    await db.admin.query("update ogevia.agency_open_shift_settings set office_open = '08:00', office_close = '18:00' where organization_id = $1", [w.orgA]);
  });
});

describe("two agencies (acceptance: separate sender, consent, quota, callbacks)", () => {
  it("each agency texts from its own sender with its own consent and quota; a STOP on one sender opts the number out of that agency only; suspending one leaves the other sending", async () => {
    // A caregiver record for the same person in agency B (same phone).
    await smsOn(w.orgA, w.ownerA, SENDER_A);
    await smsOn(w.orgB, null, SENDER_B);
    await cities("CG-A2", ["Winchester"]);
    await optIn(w.caregiverA2, "310-555-0199");
    await optIn(w.caregiverB1, "310-555-0199", w.orgB);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_sms_consent where phone_e164 = '+13105550199' and status = 'opted_in'")).rows[0].n).toBe(2);
    // STOP arrives on A's sender: only agency A's consent for that number changes
    expect((await sys("select ogevia_api.system_sms_stop($1,$2) n", [SENDER_A, "+13105550199"]))[0].n).toBe(1);
    const rows = (await db.admin.query("select organization_id o, status s from ogevia.caregiver_sms_consent where phone_e164 = '+13105550199'")).rows;
    expect(rows.find((r) => r.o === w.orgA)!.s).toBe("opted_out");
    expect(rows.find((r) => r.o === w.orgB)!.s).toBe("opted_in");
    // an unknown sender attributes to nobody
    expect((await sys("select ogevia_api.system_sms_stop($1,$2) n", ["+18885559999", "+13105550199"]))[0].n).toBe(0);
    // suspend A; B still sends, and A's board still works
    await db.admin.query("update ogevia.agency_open_shift_settings set sender_status = 'suspended' where organization_id = $1", [w.orgA]);
    expect((await db.admin.query("select ogevia.sms_available($1) a", [w.orgA])).rows).toEqual([{ a: false }]);
    expect((await db.admin.query("select ogevia.sms_available($1) a", [w.orgB])).rows).toEqual([{ a: true }]);
    const f = await fixture("Winchester");
    const s = await openShift(f);
    await post(s);
    expect((await board(w.caregiverA2)).map((r) => r.shift_ref)).toContain(await ref(s));
    await optIn(w.caregiverA2, "310-555-0102");
    await db.admin.query("update ogevia.agency_open_shift_settings set sender_status = 'verified' where organization_id = $1", [w.orgA]);
  });

  it("the sender number belongs to one agency only", async () => {
    await expect(db.admin.query("update ogevia.agency_open_shift_settings set sender_number = $2 where organization_id = $1", [w.orgB, SENDER_A])).rejects.toThrow(/duplicate key/);
  });
});

describe("permissions and privacy", () => {
  it("only the agency owner changes settings and contacts; a scheduler can run the queue but not the settings; caregivers cannot read the queue or another's requests", async () => {
    await expectPgError(q(w.schedulerA, "select ogevia_api.update_open_shift_settings($1,'{\"smsEnabled\":true}'::jsonb)", [w.orgA]), "OGA03");
    await expectPgError(q(w.caregiverA2, "select ogevia_api.post_shift_for_coverage($1,$2)", [w.orgA, randomUUID()]), "OGA03");
    expect(await q(w.caregiverA2, "select * from ogevia_api.list_coverage_queue($1)", [w.orgA])).toEqual([]);
    expect(await q(w.caregiverA2, "select * from ogevia_api.list_office_contacts($1)", [w.orgA]).catch(() => [])).toEqual([]);
    await expectPgError(q(w.managerB, "select ogevia_api.post_shift_for_coverage($1,$2)", [w.orgA, randomUUID()]), "OGN04");
    const contacts = await q(w.ownerA, "select * from ogevia_api.list_office_contacts($1)", [w.orgA]);
    expect(JSON.stringify(contacts)).not.toMatch(/\+1310555000/); // phone numbers are returned masked only
  });

  it("no pending job survives for a posting that was cancelled after the text was queued", async () => {
    await smsOn();
    await cities("CG-A2", ["Winchester"]);
    await optIn(w.caregiverA2, "310-555-0102");
    const f = await fixture("Winchester");
    const s = await openShift(f);
    await post(s);
    expect((await jobs(s, "open_shift"))[0].status).toBe("queued");
    await q(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic',null)", [w.orgA, s]);
    const mine = await ref(s);
    expect((await claim()).filter((c) => String(c.link_path).includes(mine))).toEqual([]);
    expect((await jobs(s, "open_shift")).every((j) => j.status === "suppressed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Completion pass: audit on every transition, emergency stop, urgent alerts, schedule-change notice, edits, reconciliation, report, requeue, tenant fail-closed.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const reschedule = (shift: string, d: string, start: string, end: string) =>
  q(w.managerA, "select * from ogevia_api.reschedule_shift($1,$2,$3::date,$4::time,$5::time,'Synthetic edit',$6)", [w.orgA, shift, d, start, end, randomUUID()]);
const auditActions = async (shift: string) => (await db.admin.query("select action from ogevia.audit_events where entity_id = $1 order by id", [shift])).rows.map((r) => r.action as string);

describe("audit logging on every state transition", () => {
  it("posted, requested, withdrawn, approved, round closed as filled, unposted, called out, cancelled and escalated are all in the audit trail", async () => {
    await cities("CG-A2", ["Winchester"]);
    const f = await fixture("Winchester");
    const s = await openShift(f, "04:00", "05:00", day(30 + next++));
    await post(s);
    await request(w.caregiverA2, await ref(s));
    await q(w.caregiverA2, "select ogevia_api.withdraw_open_shift_request($1,$2)", [w.orgA, await ref(s)]);
    await request(w.caregiverA2, await ref(s));
    const [r1] = await reqs(s);
    await confirm(w.managerA, r1.request_id);
    await q(w.managerA, "select ogevia_api.record_shift_callout($1,$2,'Synthetic',null)", [w.orgA, s]);
    await unpost(s);
    await q(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic',null)", [w.orgA, s]);
    const a = await auditActions(s);
    for (const x of ["shift.coverage_posted", "shift.pickup_requested", "shift.pickup_withdrawn", "shift.coverage_request_approved", "shift.pickup_confirmed", "shift.coverage_round_closed",
      "shift.called_out", "shift.coverage_auto_posted", "shift.coverage_unposted", "shift.cancelled"]) expect(a, x).toContain(x);
    const trail = await q(w.ownerA, "select * from ogevia_api.list_open_shift_audit($1,200)", [w.orgA]);
    expect(trail.map((t) => t.action)).toContain("shift.coverage_posted");
    await expectPgError(q(w.caregiverA2, "select * from ogevia_api.list_open_shift_audit($1,10)", [w.orgA]).then((r) => { if (r.length === 0) throw Object.assign(new Error("empty"), { code: "OGA03" }); }), "OGA03");
  });
});

describe("emergency stop, urgent and escalation alerts, schedule changes (go-live safeguards)", () => {
  it("the platform emergency switch stops every send for every agency at once and releasing it lets queued messages go", async () => {
    await smsOn();
    await cities("CG-A2", ["Winchester"]);
    await optIn(w.caregiverA2, "310-555-0102");
    const f = await fixture("Winchester");
    const s = await openShift(f);
    await db.admin.query("select ogevia.set_sms_emergency_disable(true, 'Synthetic drill')");
    await post(s);
    const mine = await ref(s);
    expect((await claim()).filter((c) => String(c.link_path).includes(mine))).toEqual([]);
    expect((await jobs(s, "open_shift")).every((j) => j.suppress_reason === "platform_disabled")).toBe(true);
    await db.admin.query("select ogevia.set_sms_emergency_disable(false, null)");
  });

  it("urgent (within 48 h) and escalation (within 24 h) alerts go to the office once per round, never both at once, with URGENT in the text", async () => {
    await smsOn();
    await db.admin.query("update ogevia.agency_open_shift_settings set escalation_hours = 24, urgent_hours = 48, quiet_bypass = true where organization_id = $1", [w.orgA]);
    const f = await fixture("Winchester");
    // starts in ~36 hours: urgent only
    const t36 = new Date(Date.now() + 36 * 3600_000);
    const local = (d: Date) => ({ d: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d), t: new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit" }).format(d) });
    const a = local(t36);
    const s = await openShiftAt(f, a.t, `${String((Number(a.t.slice(0, 2)) + 1) % 24).padStart(2, "0")}:${a.t.slice(3)}`, a.d);
    await post(s);
    await sys("select ogevia_api.system_coverage_sweep()");
    await sys("select ogevia_api.system_coverage_sweep()");
    expect((await jobs(s, "office_urgent")).length).toBeGreaterThanOrEqual(1);
    expect(await jobs(s, "office_escalation")).toHaveLength(0);
    const c = (await claim()).filter((x) => String(x.body_template).includes("URGENT"));
    expect(c.length).toBeGreaterThanOrEqual(1);
    // the sweep reports unfilled urgent shifts for monitoring
    expect((await sys("select ogevia_api.system_coverage_sweep() r"))[0].r.urgentUnfilled).toBeGreaterThanOrEqual(1);
    // a shift posted inside 24 h: escalation only
    const t10 = local(new Date(Date.now() + 10 * 3600_000));
    const s2 = await openShiftAt(f, t10.t, `${String((Number(t10.t.slice(0, 2)) + 1) % 24).padStart(2, "0")}:${t10.t.slice(3)}`, t10.d);
    await post(s2);
    expect((await jobs(s2, "office_escalation")).length).toBeGreaterThanOrEqual(1);
    expect(await jobs(s2, "office_urgent")).toHaveLength(0);
  });

  it("an assigned shift whose time changes texts the assigned caregiver once for those exact details; the same edit twice or an unassigned edit sends nothing", async () => {
    await smsOn();
    await optIn(w.caregiverA2, "310-555-0102");
    const f = await fixture("Winchester");
    const s = await assignedShift(f, "CG-A2", "15:00", "16:30", day(9));
    await reschedule(s, day(9), "16:00", "17:30");
    const sc = await jobs(s, "schedule_change");
    expect(sc.map((j) => j.recipient_caregiver_record_id)).toEqual([rec["CG-A2"]]);
    const c = (await claim()).find((x) => x.job_id === sc[0].id)!;
    expect(c.body_template).toMatch(/Your shift on \w{3} \w{3} \d+ changed\. Open Ogevia to review: \{link\}/);
    const o = await openShift(f);
    await reschedule(o, day(9), "19:00", "20:00");
    expect(await jobs(o, "schedule_change")).toHaveLength(0);
  });

  it("editing a posted shift sends no second text and invalidates waiting requests; a replacement call-out contacts a previously texted caregiver once in the new round", async () => {
    await smsOn();
    await cities("CG-A2", ["Winchester"]); await cities("CG-A1", ["Winchester"]);
    await optIn(w.caregiverA2, "310-555-0102");
    const f = await fixture("Winchester");
    const s = await openShift(f, "21:00", "22:00", day(2));
    await post(s);
    const before = (await jobs(s, "open_shift")).length;
    await request(w.caregiverA2, await ref(s));
    await reschedule(s, day(2), "21:30", "22:30");
    expect((await jobs(s, "open_shift")).length).toBe(before);
    expect((await requestStatus(s, "CG-A2")).status).toBe("invalidated");
    // fill with A1, then A1 calls out: round 2 contacts A2 again (new round), not A1
    await q(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Synthetic',null)", [w.orgA, s, rec["CG-A1"]]);
    await q(w.managerA, "select ogevia_api.record_shift_callout($1,$2,'Synthetic',null)", [w.orgA, s]);
    const r2 = (await rounds(s))[1];
    const second = (await jobs(s, "open_shift")).filter((j) => j.round_id === r2.id).map((j) => j.recipient_caregiver_record_id);
    expect(second).toContain(rec["CG-A2"]);
    expect(second).not.toContain(rec["CG-A1"]);
  });
});

describe("reconciliation, report, alerts and requeue", () => {
  it("accepted texts with no receipt after 24 h are flagged once, never re-sent; the report and alerts show sent, failed, unknown, usage and escalations", async () => {
    await smsOn();
    await cities("CG-A2", ["Winchester"]);
    await optIn(w.caregiverA2, "310-555-0102");
    const f = await fixture("Winchester");
    const s = await openShift(f);
    await post(s);
    const job = (await jobs(s, "open_shift")).find((j) => j.recipient_caregiver_record_id === rec["CG-A2"])!;
    const c = (await claim()).find((x) => x.job_id === job.id)!;
    await sys("select ogevia_api.system_sms_record($1,$2,'accepted','m-9',1,3000,null)", [c.job_id, c.claim_token]);
    await db.admin.query("update ogevia.notification_jobs set sent_at = now() - interval '30 hours' where id = $1", [job.id]);
    const r = (await sys("select ogevia_api.system_sms_reconcile() r"))[0].r;
    expect(r.newlyFlaggedNoReceipt).toBeGreaterThanOrEqual(1);
    expect((await sys("select ogevia_api.system_sms_reconcile() r"))[0].r.newlyFlaggedNoReceipt).toBe(0);
    const alerts = await q(w.managerA, "select * from ogevia_api.list_coverage_alerts($1)", [w.orgA]);
    expect(alerts.find((a) => a.job_id === job.id)).toMatchObject({ kind: "notification_problem", job_status: "accepted", job_reason: "no_receipt" });
    const rep = (await q(w.managerA, "select ogevia_api.get_open_shift_report($1,$2::date,$3::date) r", [w.orgA, day(-1), day(30)]))[0].r;
    expect(rep.texts.accepted).toBeGreaterThanOrEqual(1);
    expect(rep.quota.limit).toBe(100);
    expect(rep.quota.estimatedCostMicros).toBeGreaterThanOrEqual(3000);
    expect(rep.openings.currentlyPosted).toBeGreaterThanOrEqual(1);
    expect(Object.keys(rep.openings).sort()).toEqual(["clientCancelled", "currentlyNeedCoverage", "currentlyPosted", "escalations", "expiredUnfilled", "filled", "roundsOpened", "urgentUnfilledNow"]);
    await expectPgError(q(w.caregiverA2, "select ogevia_api.get_open_shift_report($1,$2::date,$3::date) r", [w.orgA, day(-1), day(1)]), "OGA03");
  });

  it("a failed notification can be sent again by the office; an unknown outcome needs explicit confirmation; nothing else can be requeued", async () => {
    const f = await fixture("Winchester");
    const s = await openShift(f);
    await post(s);
    const [job] = await jobs(s, "office_callout").then((x) => (x.length ? x : jobs(s)));
    const target = job ?? (await db.admin.query("insert into ogevia.notification_jobs (organization_id, purpose, shift_id, recipient_kind, recipient_caregiver_record_id, dedupe_key, status) values ($1,'callout_receipt',$2,'caregiver',$3,$4,'failed') returning *", [w.orgA, s, rec["CG-A2"], `t|${randomUUID()}`])).rows[0];
    await db.admin.query("update ogevia.notification_jobs set status = 'failed' where id = $1", [target.id]);
    expect((await q(w.managerA, "select ogevia_api.requeue_notification($1,$2) s", [w.orgA, target.id]))[0].s).toBe("queued");
    await expectPgError(q(w.managerA, "select ogevia_api.requeue_notification($1,$2) s", [w.orgA, target.id]), "OGC09");
    await db.admin.query("update ogevia.notification_jobs set status = 'unknown' where id = $1", [target.id]);
    await expectPgError(q(w.managerA, "select ogevia_api.requeue_notification($1,$2) s", [w.orgA, target.id]), "OGC09", /unknown/);
    expect((await q(w.managerA, "select ogevia_api.requeue_notification($1,$2,true) s", [w.orgA, target.id]))[0].s).toBe("queued");
    await expectPgError(q(w.managerB, "select ogevia_api.requeue_notification($1,$2) s", [w.orgB, target.id]), "OGN04");
  });
});

describe("tenant isolation: every new function fails closed for foreign tenant ids", () => {
  it("agency B's people get nothing and no confirmation from agency A's shift, request, job, settings, report, contacts or cities, whichever organization id they send", async () => {
    await cities("CG-A2", ["Winchester"]);
    const f = await fixture("Winchester");
    const s = await openShift(f);
    await post(s);
    await request(w.caregiverA2, await ref(s));
    const [r] = await reqs(s);
    const job = (await jobs(s))[0];
    for (const org of [w.orgA, w.orgB]) {
      for (const sql of [
        ["select * from ogevia_api.list_coverage_queue($1)", [org]],
        ["select * from ogevia_api.list_coverage_requests($1,$2)", [org, s]],
        ["select * from ogevia_api.list_coverage_alerts($1)", [org]],
        ["select * from ogevia_api.list_open_shift_board($1)", [org]],
        ["select * from ogevia_api.list_my_open_shift_requests($1)", [org]],
        ["select * from ogevia_api.get_shift_coverage_status($1,$2)", [org, s]],
        ["select * from ogevia_api.list_office_contacts($1)", [org]],
        ["select * from ogevia_api.list_caregiver_coverage_cities($1,$2)", [org, rec["CG-A2"]]],
        ["select * from ogevia_api.list_open_shift_audit($1,50)", [org]],
      ] as const) {
        for (const actor of [w.managerB, w.caregiverB1]) {
          const rows = await q(actor, sql[0], [...sql[1]]).catch((e) => { expect(["OGN04", "OGA03"]).toContain(e.code); return []; });
          expect(JSON.stringify(rows), sql[0]).not.toContain(s);
          expect(JSON.stringify(rows), sql[0]).not.toContain(r.request_id);
        }
      }
      for (const sql of [
        ["select ogevia_api.post_shift_for_coverage($1,$2)", [org, s]],
        ["select ogevia_api.unpost_shift($1,$2,'x')", [org, s]],
        ["select ogevia_api.set_shift_service_city($1,$2,'Temecula','CA')", [org, s]],
        ["select ogevia_api.confirm_coverage_request($1,$2,null,null)", [org, r.request_id]],
        ["select ogevia_api.requeue_notification($1,$2)", [org, job.id]],
        ["select ogevia_api.set_caregiver_coverage_cities($1,$2,'[]'::jsonb)", [org, rec["CG-A2"]]],
        ["select ogevia_api.update_open_shift_settings($1,'{\"smsEnabled\":false}'::jsonb)", [org]],
      ] as const) {
        await expect(q(w.managerB, sql[0], [...sql[1]]), sql[0]).rejects.toMatchObject({ code: expect.stringMatching(/^OG(N04|A03|C09)$/) });
      }
    }
    await expect(q(w.managerB, "select ogevia_api.get_open_shift_report($1,current_date,current_date)", [w.orgA])).rejects.toMatchObject({ code: "OGA03" });
    expect((await requestStatus(s, "CG-A2")).status).toBe("pending");
    expect((await rounds(s))[0].state).toBe("posted");
  });
});
