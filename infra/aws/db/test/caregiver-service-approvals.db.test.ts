// 0040 Caregiver service approvals. SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let recA1: string;
let recA2: string;
let serviceA2: string;
const LA = "America/Los_Angeles";

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  recA1 = await recordOf(w.caregiverA1);
  recA2 = await recordOf(w.caregiverA2);
  serviceA2 = (await db.admin.query<{ id: string }>("insert into ogevia.services (organization_id, code, name) values ($1, 'PER', 'Synthetic Personal Care') returning id", [w.orgA])).rows[0]!.id;
});
afterAll(async () => db?.drop());

const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
async function recordOf(a: Actor) {
  return (await db.admin.query<{ id: string }>("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0]!.id;
}
const reset = () => db.admin.query("delete from ogevia.assignment_readiness_flags; delete from ogevia.shift_readiness_flags; delete from ogevia.caregiver_service_approvals; delete from ogevia.shifts where status = 'scheduled' and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = shifts.id);");
const status = async (rec: string, svc: string, d1: string, t1: string, d2: string, t2: string) =>
  (await db.admin.query<{ s: string }>(
    "select ogevia.service_approval_status($1,$2,$3, ($4 || ' ' || $5)::timestamp at time zone $8, ($6 || ' ' || $7)::timestamp at time zone $8) s",
    [w.orgA, rec, svc, d1, t1, d2, t2, LA],
  )).rows[0]!.s;
const approve = (a: Actor, rec: string, svc: string, from: string, until: string | null = null, reason = "Completed training and observed visit", key: string | null = null) =>
  asActor(db, a.sub, async (c) => (await c.query<{ id: string }>("select ogevia_api.approve_caregiver_service($1,$2,$3,$4::date,$5::date,$6,$7) as id", [w.orgA, rec, svc, from, until, reason, key])).rows[0]!.id);
const revoke = (a: Actor, id: string, reason: string, on: string | null = null) =>
  asActor(db, a.sub, async (c) => (await c.query<{ r: any }>("select ogevia_api.revoke_caregiver_service($1,$2,$3,$4::date) as r", [w.orgA, id, reason, on])).rows[0]!.r);
const list = (a: Actor, rec: string | null = null, org = w.orgA) =>
  asActor(db, a.sub, async (c) => (await c.query("select * from ogevia_api.list_caregiver_service_approvals($1,$2)", [org, rec])).rows);
async function shift(rec: string, user: string, svc: string, day: string, from: string, to: string, toDay = day) {
  return (await db.admin.query<{ id: string }>(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
     values ($1,$2,$3,$4,$5, ($6 || ' ' || $7)::timestamp at time zone $9, ($8 || ' ' || $10)::timestamp at time zone $9, 'scheduled') returning id`,
    [w.orgA, w.clientA1, svc, user, rec, day, from, toDay, LA, to],
  )).rows[0]!.id;
}

describe("who may approve and read", () => {
  it("only an administrator approves; managers and schedulers read; a caregiver reads only their own and cannot approve", async () => {
    await reset();
    await expectPgError(approve(w.managerA, recA1, w.serviceA, today), "OGA03", /administrator/i);
    await expectPgError(approve(w.schedulerA, recA1, w.serviceA, today), "OGA03");
    await expectPgError(approve(w.caregiverA1, recA1, w.serviceA, today), "OGA03");
    await expectPgError(approve(w.managerB, recA1, w.serviceA, today), "OGN04");
    const id = await approve(w.ownerA, recA1, w.serviceA, today);
    expect((await list(w.managerA)).map((r) => r.approval_id)).toEqual([id]);
    expect((await list(w.schedulerA)).map((r) => r.approval_id)).toEqual([id]);
    expect((await list(w.caregiverA1)).map((r) => r.approval_id)).toEqual([id]);
    expect(await list(w.caregiverA2)).toEqual([]); // sees only their own (none)
    await expectPgError(list(w.caregiverA2, recA1), "OGA03");
    await expectPgError(list(w.managerB, null), "OGN04");
    await expectPgError(list(w.caregiverB1, null, w.orgA), "OGN04");
    // The caregiver's own view does not show who approved or the revocation note.
    expect((await list(w.caregiverA1))[0]).toMatchObject({ approved_by_name: null, state: "approved" });
    expect((await list(w.managerA))[0]).toMatchObject({ approved_by_name: "OWNER_A" });
  });

  it("nobody approves their own caregiver record", async () => {
    await reset();
    await db.admin.query("update ogevia.caregiver_records set linked_user_id = $1 where id = $2", [w.ownerA.userId, recA2]);
    await db.admin.query("update ogevia.caregiver_records set linked_user_id = $1 where id = $2", [w.caregiverA2.userId, recA2]);
    // Give the owner their own caregiver record.
    const ownRec = (await db.admin.query<{ id: string }>("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,'CG-OWN','Owner','Self') returning id", [w.orgA, w.ownerA.userId])).rows[0]!.id;
    await expectPgError(approve(w.ownerA, ownRec, w.serviceA, today), "OGA03", /own services/i);
    const bulk = asActor(db, w.ownerA.sub, (c) => c.query("select ogevia_api.bulk_approve_reviewed_services($1,$2::jsonb,1,$3::date,'Reviewed')", [w.orgA, JSON.stringify([{ caregiverRecordId: ownRec, serviceId: w.serviceA }]), today]));
    await expectPgError(bulk, "OGA03", /own services/i);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_service_approvals")).rows[0].n).toBe(0);
  });
});

describe("approval records and coverage", () => {
  it("needs a reason and valid dates, refuses an overlapping approval, and an idempotent retry returns the same record", async () => {
    await reset();
    await expectPgError(approve(w.ownerA, recA1, w.serviceA, today, null, " "), "OGV22", /reason/i);
    await expectPgError(approve(w.ownerA, recA1, w.serviceA, today, await add(-1)), "OGV22", /end date/i);
    const key = "22222222-2222-4222-8222-222222222222";
    const id = await approve(w.ownerA, recA1, w.serviceA, today, await add(30), "Reviewed training file", key);
    expect(await approve(w.ownerA, recA1, w.serviceA, today, await add(30), "Reviewed training file", key)).toBe(id);
    await expectPgError(approve(w.ownerA, recA1, w.serviceA, await add(10), null), "OGC09", /already has an approval/i);
    // A different caregiver, or a different service, is a different approval.
    await approve(w.ownerA, recA2, w.serviceA, today);
    await approve(w.ownerA, recA1, serviceA2, today);
    const audit = (await db.admin.query("select action from ogevia.audit_events where entity_id = $1", [id])).rows;
    expect(audit).toEqual([{ action: "caregiver_service.approved" }]);
  });

  it("two administrators approving the same pair at once produce one approval", async () => {
    await reset();
    const results = await Promise.allSettled([approve(w.ownerA, recA1, w.serviceA, today), approve(w.ownerA, recA1, w.serviceA, today)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("OGC09");
  });

  it("must cover the WHOLE interval, including overnight and an ending approval", async () => {
    await reset();
    const d1 = await add(3);
    const d2 = await add(4);
    await approve(w.ownerA, recA1, w.serviceA, today, d1); // ends on d1 (inclusive)
    expect(await status(recA1, w.serviceA, d1, "08:00", d1, "12:00")).toBe("approved");
    expect(await status(recA1, w.serviceA, d1, "22:00", d2, "06:00")).toBe("partial"); // ends after midnight on d2
    expect(await status(recA1, w.serviceA, d2, "08:00", d2, "12:00")).toBe("expired");
    expect(await status(recA1, w.serviceA, await add(-5), "08:00", await add(-5), "12:00")).toBe("not_approved"); // before it started
    // Extending with a second approval makes the overnight shift fully covered.
    await approve(w.ownerA, recA1, w.serviceA, d2, null, "Renewed after review");
    expect(await status(recA1, w.serviceA, d1, "22:00", d2, "06:00")).toBe("approved");
    // Another service or another caregiver is unaffected.
    expect(await status(recA1, serviceA2, d1, "08:00", d1, "12:00")).toBe("not_approved");
    expect(await status(recA2, w.serviceA, d1, "08:00", d1, "12:00")).toBe("not_approved");
  });

  it("is never inferred from assignments, shifts or visits: the review list shows them and approves nothing", async () => {
    await reset();
    // A1 has an active assignment (seed) and a future shift; A2 has an expired assignment only.
    await shift(recA1, w.caregiverA1.userId, w.serviceA, await add(2), "09:00", "11:00");
    expect(await status(recA1, w.serviceA, await add(2), "09:00", await add(2), "11:00")).toBe("not_approved");
    const pairs = await asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.list_service_review_pairs($1)", [w.orgA])).rows);
    const a1 = pairs.find((p) => p.caregiver_record_id === recA1 && p.service_id === w.serviceA);
    expect(a1).toMatchObject({ active_assignments: 1, future_shifts: 1, approval_state: "not_approved" });
    expect(pairs.find((p) => p.caregiver_record_id === recA2)).toBeUndefined(); // expired assignment: not a current link
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_service_approvals")).rows[0].n).toBe(0);
    await expectPgError(asActor(db, w.caregiverA1.sub, (c) => c.query("select * from ogevia_api.list_service_review_pairs($1)", [w.orgA])), "OGA03");
  });
});

describe("revocation keeps history and flags future work", () => {
  it("records who/when/why, keeps earlier dates covered, flags future shifts and assignments, and leaves visits and billing alone", async () => {
    await reset();
    const id = await approve(w.ownerA, recA1, w.serviceA, await add(-10));
    const future = await shift(recA1, w.caregiverA1.userId, w.serviceA, await add(2), "09:00", "11:00");
    const visit = (await signedVisit(db, w.caregiverA1, w, 30)).visit;
    const before = (await db.admin.query("select count(*)::int n, max(status::text) s from ogevia.service_visits")).rows[0];
    await expectPgError(revoke(w.ownerA, id, " "), "OGV22", /reason/i);
    await expectPgError(revoke(w.managerA, id, "Competency concern"), "OGA03");
    await expectPgError(revoke(w.ownerA, id, "Competency concern", await add(-1)), "OGV22", /past/i);
    const res = await revoke(w.ownerA, id, "Competency concern raised by supervisor");
    expect(res.affectedShifts.map((s: any) => s.shiftId)).toEqual([future]);
    expect(res.affectedAssignments).toHaveLength(1);
    expect(res.note).toMatch(/does not change past visits, booked shifts or billing approvals/);
    await expectPgError(revoke(w.ownerA, id, "Again"), "OGC09", /already revoked/i);
    // History: the past stays covered (evidence), today and later does not.
    expect(await status(recA1, w.serviceA, await add(-3), "09:00", await add(-3), "11:00")).toBe("approved");
    expect(await status(recA1, w.serviceA, await add(2), "09:00", await add(2), "11:00")).toBe("revoked");
    const row = (await db.admin.query("select revoked_by, revoked_effective_on::text d, revocation_reason from ogevia.caregiver_service_approvals where id = $1", [id])).rows[0];
    expect(row).toMatchObject({ revoked_by: w.ownerA.userId, d: today, revocation_reason: "Competency concern raised by supervisor" });
    expect((await list(w.caregiverA1))[0]).toMatchObject({ state: "revoked" });
    // The booked shift is untouched; the flag is advice only.
    expect((await db.admin.query("select status::text s, caregiver_record_id from ogevia.shifts where id = $1", [future])).rows[0]).toMatchObject({ s: "scheduled", caregiver_record_id: recA1 });
    const flags = await asActor(db, w.managerA.sub, async (c) => (await c.query("select subject, reason_code from ogevia_api.list_service_flags($1) order by subject", [w.orgA])).rows);
    expect(flags).toEqual([{ subject: "assignment", reason_code: "service_revoked" }, { subject: "shift", reason_code: "service_revoked" }]);
    // Visits and billing are untouched.
    expect((await db.admin.query("select count(*)::int n, max(status::text) s from ogevia.service_visits")).rows[0]).toEqual(before);
    expect((await db.admin.query("select status::text s from ogevia.service_visits where id = $1", [visit])).rows[0].s).toBe("signed");
    // Re-approving clears the flags.
    await approve(w.ownerA, recA1, w.serviceA, today, null, "Retrained and re-observed");
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_readiness_flags where resolved_at is null and kind = 'service'")).rows[0].n).toBe(0);
    expect((await db.admin.query("select count(*)::int n from ogevia.assignment_readiness_flags where resolved_at is null")).rows[0].n).toBe(0);
  });
});

describe("administrator-confirmed bulk approval", () => {
  it("approves exactly the listed pairs, refuses a count mismatch, a foreign service and an empty list, and never approves the rest", async () => {
    await reset();
    const bulk = (pairs: unknown[], count = pairs.length, a: Actor = w.ownerA) =>
      asActor(db, a.sub, async (c) => (await c.query<{ r: any }>("select ogevia_api.bulk_approve_reviewed_services($1,$2::jsonb,$3,$4::date,'Reviewed against training records') as r", [w.orgA, JSON.stringify(pairs), count, today])).rows[0]!.r);
    const reviewed = [{ caregiverRecordId: recA1, serviceId: w.serviceA }];
    await expectPgError(bulk(reviewed, 1, w.managerA), "OGA03");
    await expectPgError(bulk(reviewed, 2), "OGC09", /does not match/i);
    await expectPgError(bulk([], 0), "OGV22");
    await expectPgError(bulk([{ caregiverRecordId: recA1, serviceId: w.serviceB }]), "OGN04");
    const res = await bulk(reviewed);
    expect(res).toMatchObject({ approved: 1, alreadyApproved: 0 });
    expect((await bulk(reviewed)).alreadyApproved).toBe(1);
    expect(await status(recA1, w.serviceA, today, "09:00", today, "10:00")).toBe("approved");
    expect(await status(recA2, w.serviceA, today, "09:00", today, "10:00")).toBe("not_approved");
    expect(await status(recA1, serviceA2, today, "09:00", today, "10:00")).toBe("not_approved");
    const row = (await db.admin.query("select source, review_batch_id from ogevia.caregiver_service_approvals")).rows;
    expect(row).toHaveLength(1);
    expect(row[0].source).toBe("bulk_review");
  });
});
