// 0033 Document reminder thresholds (agency default and per type), separate
// review and currency status, reviewer, and one Needs attention definition that
// includes uncovered shifts and documents. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
const recordOf: Record<string, string> = {};
const types: Record<string, string> = {};

const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) =>
  asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const sha = "a".repeat(64);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db);
  today = await orgToday(db);
  for (const [k, a] of Object.entries({ a1: w.caregiverA1, a2: w.caregiverA2, b1: w.caregiverB1 })) {
    recordOf[k] = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id;
  }
});
afterAll(async () => db?.drop());

const listDocs = (a: Actor, org = w.orgA) => call(a, "select * from ogevia_api.list_staff_documents($1)", [org]);
const request = (a: Actor, record: string, type: string, due: string | null, org = w.orgA) =>
  call(a, "select ogevia_api.request_staff_document($1,$2,$3,$4::date,null) as id", [org, record, type, due]).then((r) => r[0]!.id as string);
const upload = (a: Actor, doc: string, opts: { issued?: string | null; expires?: string | null; key?: string | null; org?: string; objectKey?: string } = {}) => {
  const version = randomUUID();
  const org = opts.org ?? w.orgA;
  return call(a, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,$7)", [
    doc, version, opts.objectKey ?? `${org}/documents/${doc}/${version}`, sha, opts.issued ?? null, opts.expires ?? null, opts.key ?? null,
  ]).then((r) => r[0] as { document_version_id: string; version_number: number });
};
const review = (a: Actor, version: string, decision: string, reason: string | null = null) =>
  call(a, "select ogevia_api.review_document_version($1,$2,$3,null) as d", [version, decision, reason]);
const statusOf = async (a: Actor, doc: string) => (await listDocs(a)).find((d) => d.document_id === doc);

const setDays = (a: Actor, type: string | null, days: number[] | null, org = w.orgA) =>
  call(a, "select ogevia_api.set_document_reminder_days($1, $2, $3::integer[], null) as d", [org, type, days]).then((r) => r[0]!.d);
const attention = (a: Actor = w.managerA) => call(a, "select * from ogevia_api.get_attention_summary($1)", [w.orgA]).then((r) => r[0]);

describe("reminder thresholds", () => {
  it("default is 90, 60, 30, 14, 7; agency default and per-type overrides are validated, audited and permissioned", async () => {
    types.cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0]!.id;
    types.orient = (await call(w.managerA, "select ogevia_api.create_document_type($1,'Orientation',false,null) as id", [w.orgA]))[0]!.id;
    expect((await call(w.managerA, "select * from ogevia_api.list_document_types($1)", [w.orgA])).find((t) => t.document_type_id === types.cpr))
      .toMatchObject({ reminder_days: [90, 60, 30, 14, 7], uses_agency_default: true });
    for (const bad of [[], [0], [400], [30, 30], [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
      await expectPgError(setDays(w.managerA, types.cpr!, bad), "OGV22", /Reminder days/);
    }
    await expectPgError(setDays(w.managerA, null, null), "OGV22");
    await expectPgError(setDays(w.caregiverA1, types.cpr!, [30]), "OGA03");
    await expectPgError(setDays(w.managerB, types.cpr!, [30]), "OGN04");
    expect(await setDays(w.managerA, types.cpr!, [7, 30, 14])).toEqual([30, 14, 7]);
    expect((await call(w.managerA, "select * from ogevia_api.list_document_types($1)", [w.orgA])).find((t) => t.document_type_id === types.cpr))
      .toMatchObject({ reminder_days: [30, 14, 7], uses_agency_default: false });
    expect(await setDays(w.managerA, types.cpr!, null)).toBeNull(); // back to the agency default
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where action = 'documents.reminder_days_set'")).rows[0].n).toBe(2);
  });
});

describe("document status dimensions", () => {
  it("27 days left: verified + expiring at the 30-day stage, with reviewer and date; a type without expiry never alerts", async () => {
    const doc = await request(w.managerA, recordOf.a1!, types.cpr!, null);
    const v = await upload(w.caregiverA1, doc, { expires: addDays(today, 27) });
    await review(w.managerA, v.document_version_id, "verified");
    expect(await statusOf(w.managerA, doc)).toMatchObject({
      review_state: "verified", currency_status: "expiring", reminder_stage: 30, days_until: 27, display_status: "expiring",
      reviewed_by_name: expect.any(String), reviewed_at: expect.any(Date),
    });
    // An expiry typed on a document type that does not require one is ignored for alerts.
    const o = await request(w.managerA, recordOf.a1!, types.orient!, null);
    const ov = await upload(w.caregiverA1, o, { expires: addDays(today, 3) });
    await review(w.managerA, ov.document_version_id, "verified");
    expect(await statusOf(w.managerA, o)).toMatchObject({ review_state: "verified", currency_status: "no_expiry_required", display_status: "verified", reminder_stage: null });
  });

  it("the expiring window follows the type's largest threshold: 75 days left is expiring at 90, current at 30", async () => {
    const tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB test',true,null) as id", [w.orgA]))[0]!.id;
    const doc = await request(w.managerA, recordOf.a2!, tb, null);
    const v = await upload(w.caregiverA2, doc, { expires: addDays(today, 75) });
    await review(w.managerA, v.document_version_id, "verified");
    expect(await statusOf(w.managerA, doc)).toMatchObject({ currency_status: "expiring", reminder_stage: 90 });
    await setDays(w.managerA, tb, [30, 14, 7]);
    expect(await statusOf(w.managerA, doc)).toMatchObject({ currency_status: "current", reminder_stage: null, display_status: "verified" });
  });

  it("awaiting review and rejected are review states, separate from expiry", async () => {
    const doc = await request(w.managerA, recordOf.a2!, types.cpr!, addDays(today, -1));
    expect(await statusOf(w.managerA, doc)).toMatchObject({ review_state: "overdue", currency_status: "not_verified" });
    const v = await upload(w.caregiverA2, doc, { expires: addDays(today, 200) });
    expect(await statusOf(w.managerA, doc)).toMatchObject({ review_state: "awaiting_review", currency_status: "not_verified" });
    await review(w.managerA, v.document_version_id, "rejected", "Blurry (synthetic)");
    expect(await statusOf(w.managerA, doc)).toMatchObject({ review_state: "rejected", currency_status: "not_verified" });
  });
});

describe("one Needs attention definition", () => {
  it("total includes uncovered upcoming shifts and blocking/review documents, only for people allowed to see them; expiring is informational", async () => {
    const before = await attention();
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    // 0077 counts a shift as uncovered Action needed only when it starts within 48 hours. Tomorrow at 09:00 (agency time) is between 9 and 33 hours away whatever the time of day;
    // the day after tomorrow is inside 48 hours only after 09:00, which made this test pass or fail with the clock.
    const date = addDays(today, 1);
    await call(w.managerA, "select * from ogevia_api.create_shift($1, $2, $3, $4::date, '09:00'::time, '10:00'::time, null, null)", [w.orgA, fresh.client, fresh.service, date]);
    const after = await attention();
    expect(after.uncovered_shifts).toBe(before.uncovered_shifts + 1);
    expect(after.total).toBe(before.total + 1);
    expect(after.total).toBe(after.missing_time_out + after.not_confirmed + after.needs_review + after.uncovered_shifts + after.documents_blocking + after.documents_to_review);
    expect(after.documents_expiring).toBeGreaterThanOrEqual(1);
    // A scheduler sees coverage but not documents; the total counts only what they may see.
    const s = await attention(w.schedulerA);
    expect(s).toMatchObject({ documents_blocking: null, documents_to_review: null, documents_expiring: null, uncovered_shifts: after.uncovered_shifts });
    expect(s.total).toBe(s.missing_time_out + s.not_confirmed + s.needs_review + s.uncovered_shifts);
    expect(await call(w.caregiverA1, "select * from ogevia_api.get_attention_summary($1)", [w.orgA])).toEqual([]);
    expect(await call(w.managerB, "select * from ogevia_api.get_attention_summary($1)", [w.orgA])).toEqual([]);
  });
});
