// 0042 The commit-time readiness gate, the enforcement transition, "Service checks", and the availability override.
// SYNTHETIC data only. Dates are computed from the agency-local "today".
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let recA1: string;
let recA2: string;
let recA3: string;
let cpr: string;
let tb: string;
let fx: { client: string; service: string; auth: string };
const LA = "America/Los_Angeles";
const sha = "c".repeat(64);

const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const dowOf = async (d: string) => (await db.admin.query<{ n: number }>("select extract(dow from $1::date)::int n", [d])).rows[0]!.n;
const recOf = async (a: Actor) => (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id as string;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  recA1 = await recOf(w.caregiverA1);
  recA2 = await recOf(w.caregiverA2);
  recA3 = await recOf(w.caregiverA3);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
});
afterAll(async () => db?.drop());

/** Gives a caregiver verified CPR and TB valid far into the future. */
async function makeDocsCurrent(rec: string, owner: Actor) {
  for (const [type, expires] of [[cpr, await add(400)], [tb, null]] as const) {
    let doc = (await db.admin.query("select id from ogevia.staff_documents where caregiver_record_id=$1 and document_type_id=$2 and closed_at is null", [rec, type])).rows[0]?.id as string | undefined;
    if (!doc) doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id;
    const version = randomUUID();
    const row = (await call(owner, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [
      doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, await add(-5), expires]))[0];
    await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]);
  }
}
async function resetCaregiverDocs(rec: string) {
  await db.admin.query("update ogevia.staff_documents set closed_at = now() where caregiver_record_id = $1 and closed_at is null", [rec]);
}
async function baseline(a: Actor, windows: { weekday: number; start_local: string; end_local: string }[]) {
  const rec = await recOf(a);
  await db.admin.query("delete from ogevia.caregiver_availability_windows where caregiver_record_id = $1", [rec]);
  await db.admin.query("delete from ogevia.caregiver_unavailable_dates where caregiver_record_id = $1", [rec]);
  for (const x of windows) await db.admin.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,$4,$5)", [w.orgA, rec, x.weekday, x.start_local, x.end_local]);
}
const allWeek = (s = "00:00", e = "23:59") => [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_local: s, end_local: e }));
const reset = async () => {
  await db.admin.query("delete from ogevia.assignment_readiness_flags; delete from ogevia.shift_readiness_flags;");
  await db.admin.query("delete from ogevia.authorization_reservations where shift_id is not null");
  await db.admin.query("delete from ogevia.shift_coverage_events;");
  await db.admin.query("delete from ogevia.care_request_events; delete from ogevia.care_notifications; delete from ogevia.care_request_offers; delete from ogevia.care_requests");
  await db.admin.query("delete from ogevia.shifts where not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = shifts.id)");
};
const createShift = (a: Actor, day: string, start: string, end: string, rec: string | null, service = fx.service, client = fx.client) =>
  call(a, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,null)", [w.orgA, client, service, day, start, end, rec]);

async function configureDocumentRules() {
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
}
const status = (a: Actor = w.ownerA) => call(a, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]).then((r) => r[0].s);
const activate = (a: Actor = w.ownerA, count?: number) =>
  status().then((s) => call(a, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2) as s", [w.orgA, count ?? s.affectedShiftsCount])).then((r) => r[0].s);
const serviceChecks = (a: Actor, on: boolean, reason = "Review complete") => call(a, "select ogevia_api.set_service_checks($1,$2,$3) as s", [w.orgA, on, reason]).then((r) => r[0].s);
const evaluate = (rec: string, svc: string | null, from: string, to: string, ctx = "shift", client: string | null = null) =>
  call(w.managerA, "select ogevia_api.evaluate_assignment_readiness($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,null,$7) as r", [w.orgA, rec, svc, from, to, ctx, client]).then((r) => r[0].r);
const at = (day: string, time: string) => `${day} ${time}-08`;
const approveService = (rec: string, svc: string, reason = "Observed visit completed") =>
  call(w.ownerA, "select ogevia_api.approve_caregiver_service($1,$2,$3,$4::date,null,$5)", [w.orgA, rec, svc, today, reason]);

describe("report-only first: nothing existing is stranded", () => {
  it("before activation every agency is report-only: an unready caregiver can still be scheduled, and the report says what would block", async () => {
    await reset();
    await baseline(w.caregiverA1, allWeek());
    const day = await add(3);
    const made = await createShift(w.managerA, day, "09:00", "11:00", recA1);
    expect(made).toHaveLength(1);
    const st = await status();
    expect(st).toMatchObject({ enforcementActive: false, setupComplete: false, serviceChecks: { state: "Off", label: "Service checks", enabled: false } });
    expect(st.setupGaps.map((g: any) => g.code)).toEqual(["cpr_type_not_set", "tb_type_not_set"]);
    const ev = await evaluate(recA1, fx.service, at(await add(4), "09:00"), at(await add(4), "11:00"));
    expect(ev.ready).toBe(true); // nothing is enforced yet
    expect(ev.wouldBlockAfterActivation).toBe(true);
    expect(ev.checks.find((c: any) => c.check === "cpr")).toMatchObject({ status: "blocked", enforced: false, code: "type_not_set" });
  });

  it("readiness is read by staff only; caregivers and other agencies are refused", async () => {
    await expectPgError(call(w.caregiverA1, "select ogevia_api.get_readiness_status($1)", [w.orgA]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.get_readiness_status($1)", [w.orgA]), "OGN04");
    await expect(status(w.managerA)).resolves.toMatchObject({ enforcementActive: false });
    await expectPgError(call(w.managerA, "select ogevia_api.activate_readiness_enforcement($1,'x reason',0)", [w.orgA]), "OGA03");
    await expectPgError(call(w.managerA, "select ogevia_api.set_service_checks($1,false,'x reason')", [w.orgA]), "OGA03");
    await expectPgError(call(w.caregiverA1, "select ogevia_api.evaluate_assignment_readiness($1,$2,null,now(),now() + interval '1 hour')", [w.orgA, recA1]), "OGA03");
  });
});

describe("activation", () => {
  it("is refused with setup gaps, needs a reason and the reviewed count, and is administrator-only; it is never automatic", async () => {
    await expectPgError(activate(), "OGC09", /Finish the CPR and TB setup/);
    await configureDocumentRules();
    expect((await status()).setupComplete).toBe(true);
    await expectPgError(call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,' ',0)", [w.orgA]), "OGV22", /reason/i);
    await expectPgError(activate(w.ownerA, 999), "OGC09", /affected work changed/i);
    await expectPgError(activate(w.managerA, 0), "OGA03");
    // Service checks cannot be turned On before checks are active.
    await expectPgError(serviceChecks(w.ownerA, true), "OGC09", /Activate readiness checks/);
    // Not active yet: the earlier shift (made before) is still in place and nothing was blocked.
    expect((await status()).enforcementActive).toBe(false);
  });

  it("the report counts affected future work before activation; activation is audited and the settings history is kept", async () => {
    const before = await status();
    expect(before.affectedShiftsCount).toBeGreaterThanOrEqual(1); // A1's shift: no CPR/TB on file
    expect(before.futureWork.shiftsNeedingDocuments).toBeGreaterThanOrEqual(1);
    expect(before.caregivers.withDocumentGaps).toBeGreaterThanOrEqual(3);
    const after = await activate();
    expect(after).toMatchObject({ enforcementActive: true });
    await expectPgError(activate(), "OGC09", /already active/);
    const ev = (await db.admin.query("select setting, old_value, new_value, changed_by, report is not null r from ogevia.readiness_setting_events order by changed_at")).rows;
    expect(ev).toEqual([{ setting: "enforcement", old_value: "report-only", new_value: "active", changed_by: w.ownerA.userId, r: true }]);
    expect((await db.admin.query("select action from ogevia.audit_events where action = 'readiness.enforcement_activated'")).rows).toHaveLength(1);
  });
});

describe("once active: every commit path checks, with messages that match the failure", () => {
  it("direct shift: blocked until CPR and TB are verified and current AND approved hours cover it; each failure is named", async () => {
    await reset();
    await resetCaregiverDocs(recA1);
    await baseline(w.caregiverA1, []);
    const day = await add(3);
    await expectPgError(createShift(w.managerA, day, "09:00", "11:00", recA1), "OGR30", /CPR missing\..*TB missing\./s);
    await expectPgError(createShift(w.managerA, day, "09:00", "11:00", recA1), "OGR30", /Availability not provided\./);
    await makeDocsCurrent(recA1, w.caregiverA1);
    await expectPgError(createShift(w.managerA, day, "09:00", "11:00", recA1), "OGR30", /^Availability not provided\.$/);
    await baseline(w.caregiverA1, [{ weekday: await dowOf(day), start_local: "08:00", end_local: "10:00" }]);
    await expectPgError(createShift(w.managerA, day, "09:00", "11:00", recA1), "OGR30", /^Outside approved hours\.$/);
    await baseline(w.caregiverA1, [{ weekday: await dowOf(day), start_local: "08:00", end_local: "12:00" }]);
    const ok = await createShift(w.managerA, day, "09:00", "11:00", recA1);
    expect(ok).toHaveLength(1);
    // Double-booking keeps its own message.
    await expectPgError(createShift(w.managerA, day, "10:00", "12:00", recA1), "OGC09", /already has a shift/);
  });

  it("an upload alone, a rejection and an expiry each block with their own words; an unverified TB 'needs review'", async () => {
    await reset();
    await resetCaregiverDocs(recA2);
    await baseline(w.caregiverA2, allWeek());
    const day = await add(3);
    const doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, recA2, tb]))[0].id;
    const version = randomUUID();
    await call(w.caregiverA2, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,null,null)", [doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, await add(-5)]);
    await expectPgError(createShift(w.managerA, day, "09:00", "11:00", recA2), "OGR30", /TB needs review\./);
    const cprDoc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, recA2, cpr]))[0].id;
    const v2 = randomUUID();
    const row = (await call(w.caregiverA2, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [cprDoc, v2, `${w.orgA}/documents/${cprDoc}/${v2}`, sha, await add(-400), await add(-1)]))[0];
    await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]);
    await expectPgError(createShift(w.managerA, day, "09:00", "11:00", recA2), "OGR30", /CPR expired\./);
  });

  it("validity must cover the whole work interval, including an overnight shift that crosses the expiry date", async () => {
    await reset();
    await resetCaregiverDocs(recA3);
    await baseline(w.caregiverA3, allWeek());
    const d1 = await add(4);
    const d2 = await add(5);
    await makeDocsCurrent(recA3, w.caregiverA3); // valid 400 days; replace CPR with one that ends on d1
    await resetCaregiverDocs(recA3);
    const cprDoc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, recA3, cpr]))[0].id;
    const v = randomUUID();
    const row = (await call(w.caregiverA3, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [cprDoc, v, `${w.orgA}/documents/${cprDoc}/${v}`, sha, await add(-5), d1]))[0];
    await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]);
    const tbDoc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, recA3, tb]))[0].id;
    const v2 = randomUUID();
    const row2 = (await call(w.caregiverA3, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,null,null)", [tbDoc, v2, `${w.orgA}/documents/${tbDoc}/${v2}`, sha, await add(-5)]))[0];
    await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row2.document_version_id]);
    const ev = await evaluate(recA3, fx.service, at(d1, "22:00"), at(d2, "06:00"));
    expect(ev.checks.find((c: any) => c.check === "cpr")).toMatchObject({ status: "blocked", message: "CPR expires before this work ends." });
    expect(ev.ready).toBe(false);
    expect(await createShift(w.managerA, d1, "09:00", "11:00", recA3)).toHaveLength(1);
  });

  it("reassigning and rescheduling are checked too; the earlier assignment is kept when the new check fails", async () => {
    await reset();
    await makeDocsCurrent(recA1, w.caregiverA1).catch(() => undefined);
    await baseline(w.caregiverA1, allWeek());
    await baseline(w.caregiverA2, allWeek());
    await resetCaregiverDocs(recA2); // A2 has no documents
    const day = await add(6);
    const shift = (await createShift(w.managerA, day, "09:00", "11:00", recA1))[0].shift_id as string;
    await expectPgError(call(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Coverage')", [w.orgA, shift, recA2]), "OGR30", /CPR missing\./);
    expect((await db.admin.query("select caregiver_record_id from ogevia.shifts where id = $1", [shift])).rows[0].caregiver_record_id).toBe(recA1);
    // Reschedule to hours A1 is not available for.
    await baseline(w.caregiverA1, [{ weekday: await dowOf(day), start_local: "08:00", end_local: "12:00" }]);
    await expectPgError(call(w.managerA, "select * from ogevia_api.reschedule_shift($1,$2,$3::date,'14:00','16:00','Client asked')", [w.orgA, shift, day]), "OGR30", /Outside approved hours\./);
    await call(w.managerA, "select * from ogevia_api.reschedule_shift($1,$2,$3::date,'10:00','12:00','Client asked')", [w.orgA, shift, day]);
  });

  it("a recurring series: occurrences that fail are refused unless the scheduler skips them, and the skip records the reason", async () => {
    await reset();
    await makeDocsCurrent(recA1, w.caregiverA1).catch(() => undefined);
    const start = await add(7);
    const dow = await dowOf(start);
    // Available only on the first week's day (a specific-date window), not the following weeks.
    await baseline(w.caregiverA1, []);
    await db.admin.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, specific_date, start_local, end_local) values ($1,$2,$3,'08:00','12:00')", [w.orgA, recA1, start]);
    const series = (conflict: string) => call(w.managerA, "select * from ogevia_api.create_shift_series($1,$2,$3,$4,$5::smallint[],'09:00','11:00',$6::date,$7::date,$8,null)",
      [w.orgA, fx.client, fx.service, recA1, `{${dow}}`, start, null, conflict]);
    await expectPgError(series("refuse"), "OGC09", /availability outside/);
    const res = (await series("skip_flagged"))[0];
    expect(res.created).toBe(1); // the one covered date
    expect(res.skipped).toBeGreaterThan(0);
    const reasons = (await db.admin.query("select distinct reason from ogevia.shift_series_skipped_dates")).rows.map((r) => r.reason);
    expect(reasons).toEqual(["availability_outside"]);
  });
});

describe("Service checks (separate, audited, never touching CPR/TB)", () => {
  it("defaults Off with the required wording; On blocks 'Not approved for this service.'; Off again never disables CPR/TB", async () => {
    await reset();
    await makeDocsCurrent(recA1, w.caregiverA1).catch(() => undefined);
    await baseline(w.caregiverA1, allWeek());
    const s0 = await status();
    expect(s0.serviceChecks).toEqual({ label: "Service checks", state: "Off", enabled: false, offHeadline: "Service checks: Off", offMessage: "Caregivers can be assigned without service approval.", action: "Review services" });
    const day = await add(8);
    expect(await createShift(w.managerA, day, "09:00", "11:00", recA1)).toHaveLength(1); // no approval needed while Off
    await expectPgError(serviceChecks(w.managerA, true), "OGA03");
    await expectPgError(serviceChecks(w.ownerA, true, " "), "OGV22", /reason/i);
    const on = await serviceChecks(w.ownerA, true);
    expect(on.serviceChecks).toMatchObject({ state: "On", offHeadline: null, offMessage: null });
    await expectPgError(createShift(w.managerA, await add(9), "09:00", "11:00", recA1), "OGR30", /^Not approved for this service\.$/);
    await approveService(recA1, fx.service);
    expect(await createShift(w.managerA, await add(9), "09:00", "11:00", recA1)).toHaveLength(1);
    await expectPgError(serviceChecks(w.ownerA, true), "OGC09", /already On/);
    await serviceChecks(w.ownerA, false, "Temporarily off while approvals are reviewed");
    // Off: service no longer blocks, but a missing CPR still does.
    await resetCaregiverDocs(recA1);
    await expectPgError(createShift(w.managerA, await add(10), "09:00", "11:00", recA1), "OGR30", /CPR missing\./);
    await makeDocsCurrent(recA1, w.caregiverA1);
    const events = (await db.admin.query("select setting, old_value, new_value from ogevia.readiness_setting_events where setting = 'service_checks' order by changed_at")).rows;
    expect(events).toEqual([{ setting: "service_checks", old_value: "Off", new_value: "On" }, { setting: "service_checks", old_value: "On", new_value: "Off" }]);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where action = 'readiness.service_checks_changed'")).rows[0].n).toBe(2);
  });
});

describe("availability override: one caregiver, one client, one shift; lifts only the hours (0047)", () => {
  it("administrator-only, reason required, used once and linked to the shift; never lifts documents, service or double-booking", async () => {
    await reset();
    await makeDocsCurrent(recA1, w.caregiverA1).catch(() => undefined);
    await baseline(w.caregiverA1, []);
    const day = await add(11);
    const authorize = (a: Actor, rec: string, start = "09:00", end = "11:00", reason = "Caregiver agreed by phone", client = fx.client) =>
      call(a, "select ogevia_api.authorize_availability_override($1,$2,($3::date + $4::time) at time zone 'America/Los_Angeles',($3::date + $5::time) at time zone 'America/Los_Angeles',$6,$7) as id",
        [w.orgA, rec, day, start, end, reason, client]).then((r) => r[0].id as string);
    await expectPgError(createShift(w.managerA, day, "09:00", "11:00", recA1), "OGR30", /Availability not provided\./);
    await expectPgError(authorize(w.managerA, recA1), "OGA03");
    await expectPgError(authorize(w.ownerA, recA1, "09:00", "11:00", " "), "OGV22", /reason/i);
    await expectPgError(authorize(w.managerB, recA1), "OGN04");
    const id = await authorize(w.ownerA, recA1);
    const made = await createShift(w.managerA, day, "09:00", "11:00", recA1);
    expect(made).toHaveLength(1);
    const ov = (await db.admin.query("select used_count, consumed_at, shift_id, client_id, original_status from ogevia.availability_overrides where id = $1", [id])).rows[0];
    expect(ov.used_count).toBe(1);
    expect(ov.consumed_at).not.toBeNull();
    expect(ov.shift_id).toBe(made[0].shift_id);
    expect(ov.client_id).toBe(fx.client);
    expect(ov.original_status).toBe("not_provided");
    expect((await db.admin.query("select action from ogevia.audit_events where action like 'availability.override%' order by id")).rows.map((r) => r.action))
      .toEqual(["availability.override_authorized", "availability.override_used", "availability.override_linked"]);
    // The shift list says it was assigned under an administrator override, and why.
    const listed = await call(w.managerA, "select * from ogevia_api.list_shifts($1,$2::date,$2::date,null)", [w.orgA, day]);
    expect(listed.find((r) => r.shift_id === made[0].shift_id)).toMatchObject({ availability_override: true, availability_override_reason: "Caregiver agreed by phone" });
    // Double-booking still applies.
    await expectPgError(createShift(w.managerA, day, "10:00", "12:00", recA1), "OGC09", /already has a shift/);
    // The override was for ONE shift: the same hours on another day, or another shift after this one, are refused again.
    await expectPgError(createShift(w.managerA, await add(13), "09:00", "11:00", recA1), "OGR30", /Availability not provided\./);
    await expectPgError(createShift(w.managerA, day, "13:00", "15:00", recA1), "OGR30", /Availability not provided\./);
    // A missing CPR is NOT overridden by an availability override (and the unused override survives the refusal).
    const second = await authorize(w.ownerA, recA1, "13:00", "15:00");
    await resetCaregiverDocs(recA1);
    await expectPgError(createShift(w.managerA, day, "13:00", "15:00", recA1), "OGR30", /CPR missing\./);
    expect((await db.admin.query("select consumed_at from ogevia.availability_overrides where id = $1", [second])).rows[0].consumed_at).toBeNull();
    await makeDocsCurrent(recA1, w.caregiverA1);
    expect(await createShift(w.managerA, day, "13:00", "15:00", recA1)).toHaveLength(1);
    // A time that does not match the approved shift, or another client, does not use it.
    await authorize(w.ownerA, recA1, "16:00", "18:00");
    await expectPgError(createShift(w.managerA, day, "16:00", "17:00", recA1), "OGR30", /Availability not provided\./);
    const other = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
    await expectPgError(createShift(w.managerA, day, "16:00", "18:00", recA1, other.service, other.client), "OGR30", /different client/);
    // The failed attempt rolled back, so the override is still unused and still works for the right shift.
    expect(await createShift(w.managerA, day, "16:00", "18:00", recA1)).toHaveLength(1);
    // The override expires.
    await authorize(w.ownerA, recA1, "19:00", "21:00");
    await db.admin.query("update ogevia.availability_overrides set expires_at = now() - interval '1 minute' where consumed_at is null");
    await expectPgError(createShift(w.managerA, day, "19:00", "21:00", recA1), "OGR30", /Availability not provided\./);
    // Nothing to override when the caregiver is already available.
    await baseline(w.caregiverA1, allWeek());
    await expectPgError(authorize(w.ownerA, recA1, "09:00", "11:00"), "OGV22", /nothing to override/);
    // Stored availability is never changed by an override.
    expect((await db.admin.query("select count(*)::int n from ogevia.availability_requests where source = 'administrator' and reason like '%phone%'")).rows[0].n).toBe(0);
  });
});

describe("availability override on the other assignment paths (0047)", () => {
  const grant = (rec: string, day: string, start: string, end: string, client = fx.client) =>
    call(w.ownerA, "select ogevia_api.authorize_availability_override($1,$2,($3::date + $4::time) at time zone 'America/Los_Angeles',($3::date + $5::time) at time zone 'America/Los_Angeles','Agency asked for this caregiver',$6) as id",
      [w.orgA, rec, day, start, end, client]).then((r) => r[0].id as string);

  it("filling an OPEN shift under an override links it to that shift and uses it up; a different or later shift needs its own", async () => {
    await reset();
    await makeDocsCurrent(recA1, w.caregiverA1).catch(() => undefined);
    await baseline(w.caregiverA1, []);
    const day = await add(14);
    const open = (await createShift(w.managerA, day, "09:00", "11:00", null))[0].shift_id as string;
    const other = (await createShift(w.managerA, day, "13:00", "15:00", null))[0].shift_id as string;
    const assign = (shift: string) => call(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,null,null) as s", [w.orgA, shift, recA1]);
    await expectPgError(assign(open), "OGR30", /Availability not provided\./);
    const id = await grant(recA1, day, "09:00", "11:00");
    await expectPgError(assign(other), "OGR30", /Availability not provided\./); // the override is for the 09:00 shift only
    expect((await assign(open))[0].s).toBe("covered");
    expect((await db.admin.query("select shift_id, consumed_context from ogevia.availability_overrides where id = $1", [id])).rows[0]).toMatchObject({ shift_id: open, consumed_context: "reschedule" });
    expect((await db.admin.query("select caregiver_record_id from ogevia.shifts where id = $1", [open])).rows[0].caregiver_record_id).toBe(recA1);
    // Used up: it cannot be reused for the same hours after the caregiver is removed and the shift is refilled.
    await call(w.managerA, "select ogevia_api.record_shift_callout($1,$2,'Caregiver unwell',null)", [w.orgA, open]);
    await expectPgError(assign(open), "OGC09"); // the caregiver who called out cannot be put back on it
    expect((await db.admin.query("select used_count from ogevia.availability_overrides where id = $1", [id])).rows[0].used_count).toBe(1);
  });

  it("a recurring series is never built on an override: the outside-hours date is still flagged", async () => {
    await reset();
    await baseline(w.caregiverA1, []);
    const day = await add(15);
    const dow = (await db.admin.query("select extract(dow from $1::date)::int d", [day])).rows[0].d as number;
    const preview = () => call(w.managerA, "select *, local_date::text as local_date from ogevia_api.preview_shift_series($1,$2,$3,$4,$5::smallint[],'09:00'::time,'11:00'::time,$6::date,$6::date)",
      [w.orgA, fx.client, fx.service, recA1, [dow], day]);
    expect((await preview())[0].outcome).toMatch(/^availability_/);
    await grant(recA1, day, "09:00", "11:00");
    expect((await preview())[0].outcome).toMatch(/^availability_/); // an override does not apply to a series
    await expectPgError(
      call(w.managerA, "select * from ogevia_api.create_shift_series($1,$2,$3,$4,$5::smallint[],'09:00'::time,'11:00'::time,$6::date,$6::date,'refuse',null)", [w.orgA, fx.client, fx.service, recA1, [dow], day]),
      "OGC09");
    // The same date as an ordinary shift under the override works; the series can then skip that date.
    expect(await createShift(w.managerA, day, "09:00", "11:00", recA1)).toHaveLength(1);
  });
});

describe("new visit starts and standing assignments", () => {
  it("a caregiver cannot START a visit without current CPR/TB (also via a standing assignment); a visit already in progress is not interrupted", async () => {
    await reset();
    const f2 = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
    await resetCaregiverDocs(recA1);
    const start = () => call(w.caregiverA1, "select ogevia_api.start_ad_hoc_service_visit($1,$2,$3,'{}',null,null,'Synthetic unscheduled test visit') as id", [w.orgA, f2.client, f2.service]).then((r) => r[0].id as string);
    await expectPgError(start(), "OGR30", /CPR missing\.\s+TB missing\./);
    await makeDocsCurrent(recA1, w.caregiverA1);
    await baseline(w.caregiverA1, allWeek()); // 0046: a new visit also needs approved availability once readiness is active
    const visit = await start();
    expect(visit).toBeTruthy();
    // CPR then stops being current (the agency tightens its rule): the visit already in progress is left alone,
    // and a new start by another visit is blocked.
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','issue_plus_days',1,'Tightened for the test')", [w.orgA]);
    expect((await db.admin.query("select status from ogevia.document_requirement_check($1,$2,'cpr')", [w.orgA, recA1])).rows[0].status).toBe("expired");
    expect((await db.admin.query("select status::text s from ogevia.service_visits where id = $1", [visit])).rows[0].s).toBe("draft");
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Back to the certificate date')", [w.orgA]);
  });

  it("a standing assignment that takes effect needs ready documents on its first day; a planned one (no access yet) can still be prepared", async () => {
    await reset();
    await resetCaregiverDocs(recA2);
    const f3 = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
    const create = (rec: string) => call(w.managerA, "select * from ogevia_api.create_assignment($1,$2,$3,$4,$5::date,null,null)", [w.orgA, rec, f3.client, f3.service, today]);
    await expectPgError(create(recA2), "OGR30", /CPR missing\./);
    // A caregiver still being onboarded may have a planned assignment: it grants nothing.
    const onboarding = (await db.admin.query<{ id: string }>("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1,'CG-ONB','Onboarding','Person','onboarding') returning id", [w.orgA])).rows[0]!.id;
    const planned = await create(onboarding);
    expect(planned[0]).toMatchObject({ grants_access: false });
    await makeDocsCurrent(recA2, w.caregiverA2);
    expect((await create(recA2))[0]).toMatchObject({ grants_access: true });
  });
});

describe("concurrency and unprotected paths", () => {
  it("two care requests for the same caregiver at overlapping times assigned at the same moment: exactly one is assigned", async () => {
    await reset();
    await makeDocsCurrent(recA1, w.caregiverA1).catch(() => undefined);
    const day = await add(14);
    await baseline(w.caregiverA1, allWeek());
    const mk = async (start: string, end: string) => {
      const r = await db.admin.query<{ id: string }>(
        `insert into ogevia.care_requests(organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at, requested_minutes, request_key, status)
         values ($1,$2,$3,$4, ($5 || ' ' || $6)::timestamp at time zone $8, ($5 || ' ' || $7)::timestamp at time zone $8, 210, gen_random_uuid(), 'accepted_pending_assignment') returning id`,
        [w.orgA, fx.client, fx.service, fx.auth, day, start, end, LA]);
      const o = await db.admin.query<{ id: string }>(
        `insert into ogevia.care_request_offers(organization_id, care_request_id, caregiver_record_id, token_hash, status) values ($1,$2,$3,$4,'available') returning id`,
        [w.orgA, r.rows[0]!.id, recA1, randomBytes(32).toString("hex")]);
      return { request: r.rows[0]!.id, offer: o.rows[0]!.id };
    };
    const a = await mk("08:00", "11:30");
    const b = await mk("10:00", "13:30");
    const go = (x: { request: string; offer: string }) => call(w.managerA, "select ogevia_api.assign_care_request($1,$2,$3) id", [w.orgA, x.request, x.offer]);
    const results = await Promise.allSettled([go(a), go(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as { code: string }).code).toBe("OGC09");
    expect((await db.admin.query("select count(*)::int n from ogevia.shifts where caregiver_record_id = $1 and starts_at::date >= $2::date", [recA1, today])).rows[0].n).toBe(1);
  });

  it("a revocation and an assignment racing for one caregiver never leave a shift that nobody was told about", async () => {
    await reset();
    await makeDocsCurrent(recA1, w.caregiverA1).catch(() => undefined);
    await baseline(w.caregiverA1, allWeek());
    await serviceChecks(w.ownerA, true).catch(() => undefined);
    await db.admin.query("delete from ogevia.caregiver_service_approvals");
    const id = (await approveService(recA1, fx.service))[0] ? (await db.admin.query("select id from ogevia.caregiver_service_approvals where caregiver_record_id = $1", [recA1])).rows[0].id as string : "";
    const day = await add(15);
    const assign = createShift(w.managerA, day, "09:00", "11:00", recA1);
    const revoke = call(w.ownerA, "select ogevia_api.revoke_caregiver_service($1,$2,'Competency concern',null)", [w.orgA, id]);
    const [a, r] = await Promise.allSettled([assign, revoke]);
    expect(r.status).toBe("fulfilled");
    const shiftExists = (await db.admin.query("select count(*)::int n from ogevia.shifts where caregiver_record_id = $1 and status = 'scheduled' and starts_at > now()", [recA1])).rows[0].n > 0;
    if (a.status === "fulfilled") {
      // The shift committed first; the revocation then flagged it for review.
      expect(shiftExists).toBe(true);
      expect((await db.admin.query("select count(*)::int n from ogevia.shift_readiness_flags where kind = 'service' and resolved_at is null")).rows[0].n).toBe(1);
    } else {
      expect((a.reason as { code: string }).code).toBe("OGR30");
      expect(shiftExists).toBe(false);
    }
    await serviceChecks(w.ownerA, false, "Reset for the next test");
  });

  it("every database function that writes a caregiver onto a shift is on the protected list (or is documented as exempt)", async () => {
    const rows = (await db.admin.query(
      `select p.proname, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('ogevia', 'ogevia_api') and p.prokind = 'f'
         and (pg_get_functiondef(p.oid) ~* 'insert into ogevia\\.shifts' or pg_get_functiondef(p.oid) ~* 'update ogevia\\.shifts\\s+set[^;]*caregiver_(user_|record_)id')
       order by 1`)).rows as { proname: string; def: string }[];
    const names = rows.map((r) => r.proname);
    // Paths that PLACE a caregiver on work, all moved onto the gate in this release:
    const gated: Record<string, RegExp> = {
      assign_care_request: /assert_ready_for_work/,
      assign_shift_caregiver: /check_shift_caregiver\([^)]*v_s\.service_id\)/,
      create_shift: /check_shift_caregiver\([^)]*p_service_id\)/,
      reschedule_shift: /check_shift_caregiver\([^)]*v_s\.service_id\)/,
      pickup_open_shift: /check_shift_caregiver\(/, // Wave 1 (0051): the same readiness gate as an office assignment
      series_materialize: /series_evaluate/, // outcomes come from series_evaluate, which includes readiness_outcome
    };
    // Paths that write the caregiver column but do not newly commit a person to work (documented):
    const exempt: Record<string, string> = {
      callout_shift: "removes the caregiver (call-out); commits nobody",
      cancel_shift: "cancels; commits nobody",
      sync_record_assignment_access: "mirrors the caregiver's own user id onto a record link; no new work",
      link_caregiver_record_to_user: "links a sign-in to a record; no new work",
    };
    for (const n of names) {
      expect(Object.keys(gated).concat(Object.keys(exempt)), `Unreviewed function writes shifts: ${n}`).toContain(n);
    }
    for (const [n, re] of Object.entries(gated)) {
      const def = rows.find((r) => r.proname === n)?.def;
      if (def) expect(def, n).toMatch(re);
    }
    const evaluator = (await db.admin.query("select pg_get_functiondef(p.oid) d from pg_proc p where p.proname = 'series_evaluate'")).rows[0].d as string;
    expect(evaluator).toMatch(/readiness_outcome/);
    // No function still calls the 5-argument check_shift_caregiver (which cannot see the service).
    const five = (await db.admin.query(
      `select p.proname from pg_proc p where p.proname <> 'check_shift_caregiver' and p.prokind = 'f' and p.pronamespace in (select oid from pg_namespace where nspname in ('ogevia','ogevia_api'))
         and pg_get_functiondef(p.oid) ~* 'check_shift_caregiver\\([^;]*,[^;]*,[^;]*,[^;]*,[^;,]*\\)\\s*;' and pg_get_functiondef(p.oid) !~* 'check_shift_caregiver\\([^;]*,[^;]*,[^;]*,[^;]*,[^;]*,[^;]*\\)'`)).rows;
    expect(five).toEqual([]);
    expect(names.length).toBeGreaterThan(0);
  });
});

// Keeps the rollback test honest about what exists.
describe("migration files", () => {
  it("0042 ships with a classified rollback", () => {
    const down = readFileSync(new URL("../rollback/0042_readiness_gate.down.sql", import.meta.url), "utf8");
    expect(down).toMatch(/CLASS: BACKUP REQUIRED/);
    expect(readdirSync(new URL("../migrations/", import.meta.url))).toContain("0042_readiness_gate.sql");
  });
});
