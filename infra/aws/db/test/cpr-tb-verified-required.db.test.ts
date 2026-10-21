// 0081 Owner correction 3: a pending (uploaded, unverified) CPR/TB document does NOT satisfy the requirement for a current VERIFIED document.
// Report-only mode warns; ACTIVE enforcement blocks every assignment path and a new visit start. The 14-day grace no longer lets work go ahead
// (it still delays only the automatic compliance HOLD). SYNTHETIC data only; enforcement is switched on only inside this test database.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let cpr: string;
let tb: string;
let fx: { client: string; service: string; auth: string };
const recs: Record<string, string> = {};
let expiredPerson: Actor;
const sha = "e".repeat(64);

const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const recOf = async (a: Actor) => (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id as string;
const evaluate = (rec: string, day: string, ctx = "shift", client: string | null = fx.client) =>
  call(w.managerA, "select ogevia_api.evaluate_assignment_readiness_local($1,$2,$3,$4::date,'09:00'::time,'11:00'::time,$5,null,$6) as r", [w.orgA, rec, fx.service, day, ctx, client]).then((r) => r[0].r);
const cprRow = (ev: any) => ev.checks.find((c: any) => c.check === "cpr");
const tbRow = (ev: any) => ev.checks.find((c: any) => c.check === "tb");
const createShift = (day: string, rec: string | null, start = "09:00", end = "11:00") =>
  call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,$8)", [w.orgA, fx.client, fx.service, day, start, end, rec, randomUUID()]);
async function deliver(rec: string, type: string, o: { issued: string | null; expires: string | null; verify: "verified" | null }) {
  let doc = (await db.admin.query("select id from ogevia.staff_documents where caregiver_record_id=$1 and document_type_id=$2 and closed_at is null", [rec, type])).rows[0]?.id as string | undefined;
  if (!doc) doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id as string;
  const version = randomUUID();
  const row = (await call(w.managerA, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [
    doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, o.issued, o.expires]))[0];
  if (o.verify) await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]);
}
async function person(): Promise<Actor> {
  const sub = randomUUID();
  const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Pat Caregiver') returning id", [sub])).rows[0].id;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [w.orgA, userId]);
  await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name, status) values ($1,$2,$3,'Synthetic','Pat','active')", [w.orgA, userId, "CG-" + sub.slice(0, 6)]);
  return { userId, sub };
}
const allWeek = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_local: "00:00", end_local: "23:59" }));
const baseline = async (rec: string) => {
  await db.admin.query("delete from ogevia.caregiver_availability_windows where caregiver_record_id = $1", [rec]);
  for (const x of allWeek) await db.admin.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,$4,$5)", [w.orgA, rec, x.weekday, x.start_local, x.end_local]);
};
const clearShifts = async () => {
  await db.admin.query("delete from ogevia.authorization_reservations where shift_id is not null; delete from ogevia.shift_coverage_events;");
  await db.admin.query("delete from ogevia.shifts where not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = shifts.id)");
};

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  recs.V = await recOf(w.caregiverA1); // verified, current
  recs.P = await recOf(w.caregiverA2); // both uploaded, still awaiting review (pending)
  recs.M = await recOf(w.caregiverA3); // nothing uploaded
  expiredPerson = await person();
  recs.E = await recOf(expiredPerson); // verified but expired CPR
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  for (const a of [w.caregiverA2, w.caregiverA3, expiredPerson]) {
    await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, a.userId, fx.client, fx.service, today]);
  }
  cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
  await deliver(recs.V!, cpr, { issued: await add(-5), expires: await add(400), verify: "verified" });
  await deliver(recs.V!, tb, { issued: await add(-5), expires: null, verify: "verified" });
  await deliver(recs.P!, cpr, { issued: await add(-1), expires: await add(400), verify: null }); // uploaded, NOT verified
  await deliver(recs.P!, tb, { issued: await add(-1), expires: null, verify: null });
  await deliver(recs.E!, cpr, { issued: await add(-400), expires: await add(-1), verify: "verified" }); // verified, but expired yesterday
  await deliver(recs.E!, tb, { issued: await add(-5), expires: null, verify: "verified" });
  // all three are new hires INSIDE the 14-day period (the old grace made a pending or missing document "not blocking")
  await db.admin.query("update ogevia.caregiver_records set hire_date = $2::date - 3 where id = any($1::uuid[])", [[recs.P, recs.M, recs.E], today]);
  for (const r of Object.values(recs)) await baseline(r);
  // everything except CPR/TB is in order for every caregiver: approved background clearance and an approved service (so only the documents decide the outcome)
  await db.admin.query("insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at) values ($1,$2,'completed','approved','Synthetic fixture clearance',$3,now())", [recs.E, w.orgA, w.ownerA.userId]);
  for (const r of Object.values(recs)) await call(w.ownerA, "select ogevia_api.approve_caregiver_service($1,$2,$3,$4::date,null,'Observed visit completed')", [w.orgA, r, fx.service, today]);
});
afterAll(async () => db?.drop());

describe("report-only: a pending, a missing and an expired document all give the same Warning (nothing is blocked yet)", () => {
  it("each is status 'blocked' but not enforced, outcome Warning; the verified caregiver is Allowed", async () => {
    const day = await add(3);
    const P = await evaluate(recs.P!, day), M = await evaluate(recs.M!, day), E = await evaluate(recs.E!, day), V = await evaluate(recs.V!, day);
    expect(V).toMatchObject({ outcome: "allowed", summary: "Allowed" });
    expect(cprRow(P)).toMatchObject({ status: "blocked", code: "awaiting_review", enforced: false, blocking: false, message: "CPR needs review." });
    expect(tbRow(P)).toMatchObject({ status: "blocked", code: "awaiting_review", enforced: false, blocking: false });
    expect(cprRow(M)).toMatchObject({ status: "blocked", code: "missing", enforced: false, blocking: false, message: "CPR missing." });
    expect(cprRow(E)).toMatchObject({ status: "blocked", code: "expired", enforced: false, blocking: false, message: "CPR expired." });
    for (const ev of [P, M, E]) expect(ev).toMatchObject({ outcome: "warning", ready: true, wouldBlockAfterActivation: true });
    expect(P.summary).toBe("Warning: CPR needs review.");
    // report-only never blocks: the pending caregiver can still be put on a shift (the Warning is the whole effect)
    expect(await createShift(await add(3), recs.P!)).toHaveLength(1);
    expect(await createShift(await add(4), recs.M!)).toHaveLength(1);
  });
});

describe("enforcement ACTIVE (a synthetic agency only): pending is exactly as blocking as missing or expired", () => {
  beforeAll(async () => {
    const st = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
    await call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, st.affectedShiftsCount]);
  });

  it("the outcome is Blocked with the document words, in every context, for pending, missing and expired alike; a verified current document is Allowed", async () => {
    const day = await add(5);
    for (const ctx of ["shift", "reschedule", "series", "care_request", "visit_start"]) {
      const P = await evaluate(recs.P!, day, ctx), M = await evaluate(recs.M!, day, ctx), E = await evaluate(recs.E!, day, ctx), V = await evaluate(recs.V!, day, ctx);
      expect(P, ctx).toMatchObject({ outcome: "blocked", ready: false, summary: "Blocked: CPR needs review." });
      expect(cprRow(P), ctx).toMatchObject({ status: "blocked", enforced: true, blocking: true, code: "awaiting_review" });
      expect(tbRow(P), ctx).toMatchObject({ status: "blocked", enforced: true, blocking: true });
      expect(M, ctx).toMatchObject({ outcome: "blocked", summary: "Blocked: CPR missing." });
      expect(E, ctx).toMatchObject({ outcome: "blocked", summary: "Blocked: CPR expired." });
      expect(V.outcome, ctx).toBe("allowed");
      // the SAME status and blocking for a pending document as for a missing one: no 'pending' status remains
      expect([cprRow(P).status, cprRow(P).blocking]).toEqual([cprRow(M).status, cprRow(M).blocking]);
      for (const ev of [P, M, E]) expect(ev.checks.some((c: any) => c.status === "pending")).toBe(false);
    }
  });

  it("create: a shift for the pending caregiver is refused with the document words, and nothing is saved", async () => {
    await expectPgError(createShift(await add(6), recs.P!), "OGR30", /CPR needs review\./);
    await expectPgError(createShift(await add(6), recs.M!), "OGR30", /CPR missing\./);
    await expectPgError(createShift(await add(6), recs.E!), "OGR30", /CPR expired\./);
    expect((await db.admin.query("select count(*)::int n from ogevia.shifts where caregiver_record_id = any($1::uuid[]) and starts_at::date >= $2::date + 6", [[recs.P, recs.M, recs.E], today])).rows[0].n).toBe(0);
    expect(await createShift(await add(6), recs.V!)).toHaveLength(1); // the verified caregiver is unaffected
  });

  it("reschedule: a shift the pending caregiver already holds cannot be moved while they lack verified documents", async () => {
    const held = await db.admin.query("select id from ogevia.shifts where caregiver_record_id = $1 and status = 'scheduled'", [recs.P]);
    expect(held.rows).toHaveLength(1); // created while the agency was report-only
    await expectPgError(call(w.managerA, "select * from ogevia_api.reschedule_shift($1,$2,$3::date,'12:00'::time,'14:00'::time,'Synthetic: later start',null)", [w.orgA, held.rows[0].id, await add(3)]), "OGR30", /CPR needs review\./);
  });

  it("assign: putting the pending caregiver on an open shift is refused; the shift stays open", async () => {
    const open = (await createShift(await add(7), null))[0];
    await expectPgError(call(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Synthetic fill',$4)", [w.orgA, open.shift_id, recs.P, randomUUID()]), "OGR30", /CPR needs review\./);
    expect((await db.admin.query("select caregiver_record_id from ogevia.shifts where id = $1", [open.shift_id])).rows[0].caregiver_record_id).toBeNull();
    await call(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Synthetic fill',$4)", [w.orgA, open.shift_id, recs.V, randomUUID()]); // verified: allowed
  });

  it("series: a recurring series for the pending caregiver is refused as a whole (nothing saved)", async () => {
    const day = await add(8);
    const dow = (await db.admin.query<{ d: number }>("select extract(dow from $1::date)::int d", [day])).rows[0]!.d;
    await expectPgError(call(w.managerA, "select * from ogevia_api.create_shift_series($1,$2,$3,$4,$5::smallint[],'09:00'::time,'11:00'::time,$6::date,$6::date,'refuse',null)",
      [w.orgA, fx.client, fx.service, recs.P, [dow], day]), "OGC09", /documents not current\).*Nothing was saved/);
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_series where client_id = $1 and caregiver_record_id = $2", [fx.client, recs.P])).rows[0].n).toBe(0);
  });

  it("make-up: a make-up shift for the pending caregiver is refused", async () => {
    // cancel the (report-only era) shift of M, then try to make it up with M on a later day in the same month
    const held = (await db.admin.query("select id, (starts_at at time zone 'America/Los_Angeles')::date::text d from ogevia.shifts where caregiver_record_id = $1 and status = 'scheduled'", [recs.M])).rows[0];
    await call(w.managerA, "select * from ogevia_api.cancel_shift($1,$2,'Synthetic: client unwell',null)", [w.orgA, held.id]);
    const sameMonth = held.d.slice(0, 7);
    const day = (await add(4)).slice(0, 7) === sameMonth ? await add(5) : held.d;
    await expectPgError(call(w.managerA, "select * from ogevia_api.schedule_makeup_shift($1,$2,$3::date,'13:00'::time,'14:00'::time,$4,null)", [w.orgA, held.id, day, recs.M]), "OGR30", /CPR missing\./);
  });

  it("pickup: a pending caregiver who asks for an open shift cannot have the pickup confirmed", async () => {
    const open = (await createShift(await add(9), null))[0];
    let requestId: string | null = null;
    try {
      await call(w.caregiverA2, "select ogevia_api.pickup_open_shift($1,$2,null) as s", [w.orgA, open.shift_id]);
      requestId = (await db.admin.query("select id from ogevia.shift_pickup_requests where shift_id = $1 and caregiver_record_id = $2", [open.shift_id, recs.P])).rows[0]?.id ?? null;
    } catch (e) {
      expect((e as { code?: string }).code).toBe("OGR30"); // refused already when asking
    }
    if (requestId) await expectPgError(call(w.managerA, "select ogevia_api.confirm_shift_pickup($1,$2,null) as s", [w.orgA, requestId]), "OGR30", /CPR needs review\./);
    expect((await db.admin.query("select caregiver_record_id from ogevia.shifts where id = $1", [open.shift_id])).rows[0].caregiver_record_id).toBeNull();
  });

  it("care request: the pending caregiver cannot be assigned to a client's care request", async () => {
    const f2 = await freshClient(db, w, w.caregiverA2, 600, w.orgA, { before: 10, after: 10 });
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const { createHash } = await import("node:crypto");
    const hash = (value: string) => createHash("sha256").update(value, "hex").digest("hex");
    await call(w.managerA, "select ogevia_api.create_client_care_portal($1,$2,$3,null)", [w.orgA, f2.client, hash(token)]);
    const slot = (await db.admin.query<{ starts_at: string; ends_at: string }>(
      "select (date_trunc('day', now()) + interval '2 days 17 hours')::timestamptz::text starts_at, (date_trunc('day', now()) + interval '2 days 21 hours')::timestamptz::text ends_at")).rows[0]!;
    const pub = async <T>(sql: string, params: unknown[]) => {
      const c = await db.admin.connect();
      try { await c.query("begin"); await c.query("set local role ogevia_app"); const r = await c.query(sql, params); await c.query("commit"); return r.rows as T[]; }
      catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
    };
    const created = (await pub<{ request_id: string }>("select * from ogevia_api.public_create_care_request($1,$2,$3,$4,'Need respite',$5)", [hash(token), f2.service, slot.starts_at, slot.ends_at, randomUUID()]))[0]!;
    const offerToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    let offerId: string | null = null;
    try {
      offerId = (await call(w.managerA, "select ogevia_api.send_care_offer($1,$2,$3,$4) offer_id", [w.orgA, created.request_id, recs.P, hash(offerToken)]))[0].offer_id;
      await pub("select ogevia_api.public_respond_care_offer($1,true,null)", [hash(offerToken)]);
    } catch (e) {
      expect((e as { code?: string }).code).toMatch(/OGR30|OGC09|OGV22/); // refused before the assignment: the gate is not bypassed
    }
    if (offerId) {
      await expectPgError(call(w.managerA, "select ogevia_api.assign_care_request($1,$2,$3) id", [w.orgA, created.request_id, offerId]), "OGR30", /CPR needs review\./);
    }
    expect((await db.admin.query("select assigned_shift_id from ogevia.care_requests where id = $1", [created.request_id])).rows[0].assigned_shift_id).toBeNull();
  });

  it("visit start: a new visit cannot be started by the pending caregiver, while the verified caregiver can", async () => {
    const f2 = await freshClient(db, w, w.caregiverA2, 600, w.orgA, { before: 10, after: 10 });
    await expectPgError(api.start(db, w.caregiverA2, w.orgA, f2.client, f2.service, null, "Client asked for extra help (synthetic)"), "OGR30", /CPR needs review\./);
    expect((await db.admin.query("select count(*)::int n from ogevia.service_visits where caregiver_user_id = $1", [w.caregiverA2.userId])).rows[0].n).toBe(0);
    const f3 = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 10, after: 10 });
    expect(await api.start(db, w.caregiverA1, w.orgA, f3.client, f3.service, null, "Client asked for extra help (synthetic)")).toBeTruthy();
  });

  it("once the documents are VERIFIED the same caregiver passes everywhere (a verified current document, nothing else, satisfies the requirement)", async () => {
    await clearShifts();
    for (const [type, expires] of [[cpr, await add(400)], [tb, null]] as const) {
      const doc = (await db.admin.query("select id from ogevia.staff_documents where caregiver_record_id=$1 and document_type_id=$2 and closed_at is null", [recs.P, type])).rows[0].id as string;
      const ver = (await db.admin.query("select id from ogevia.document_versions where document_id = $1 order by version_number desc limit 1", [doc])).rows[0].id as string;
      await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [ver]);
      expect(expires === null || typeof expires === "string").toBe(true);
    }
    expect((await evaluate(recs.P!, await add(10))).outcome).toBe("allowed");
    expect(await createShift(await add(10), recs.P!)).toHaveLength(1);
  });
});

describe("what the 14-day period still does (unchanged): it delays only the automatic compliance hold", () => {
  it("a new hire inside the 14 days with a missing document has no hold and is shown as inside the period, yet is not assignable while enforcement is active", async () => {
    const snap = (await call(w.managerA, "select ogevia_api.get_caregiver_compliance($1,$2) as c", [w.orgA, recs.M]))[0].c;
    expect(snap).toMatchObject({ inGrace: true, hold: null });
    expect((await evaluate(recs.M!, await add(11))).outcome).toBe("blocked");
  });
});
