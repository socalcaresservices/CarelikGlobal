// Not every document expires. Expiry is configured per document type
// (document_types.requires_expiry). SYNTHETIC data only.
//   * a type that requires expiry refuses a version without an expiry date;
//   * a type that does not never needs a date, never expires, never warns;
//   * a missing expiry date on a non-expiring type does not make it overdue;
//   * the SUBMISSION due date is separate: a requested document past its due
//     date is overdue even if it never expires.
// KNOWN LIMIT (asserted below so a change is noticed): there is no "optional
// expiry" state. A date typed on a non-expiring type is stored but ignored for
// status and alerts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let record: string;
let expiring: string;
let seq = 0;
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const request = (type: string, due: string | null) =>
  call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,$4::date,null) as id", [w.orgA, record, type, due]).then((r) => r[0]!.id as string);
const upload = (doc: string, expires: string | null) => {
  const version = randomUUID();
  return call(w.caregiverA1, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,null,$5::date,null)", [
    doc, version, `${w.orgA}/documents/${doc}/${version}`, "a".repeat(64), expires,
  ]).then((r) => r[0] as { document_version_id: string });
};
const verify = (v: string) => call(w.managerA, "select ogevia_api.review_document_version($1,'verified',null,null) as d", [v]);
const statusOf = async (doc: string) => (await call(w.managerA, "select * from ogevia_api.list_staff_documents($1)", [w.orgA])).find((d) => d.document_id === doc);
// One open request per person and type, so each case gets its own non-expiring type.
const permanentType = () =>
  call(w.managerA, "select ogevia_api.create_document_type($1,$2,false,null) as id", [w.orgA, `Orientation ${++seq}`]).then((r) => r[0]!.id as string);
const alerts = () => call(w.managerA, "select * from ogevia_api.get_document_alerts($1)", [w.orgA]).then((r) => r[0]);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db);
  today = await orgToday(db);
  record = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
  expiring = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0]!.id;
});
afterAll(async () => db?.drop());

describe("document expiry is per document type", () => {
  it("a type that requires expiry refuses a version with no expiry date", async () => {
    const doc = await request(expiring, null);
    await expectPgError(upload(doc, null), "OGV22", /needs its expiry date/);
  });

  it("a non-expiring type: no date needed; verified, never expired or expiring, no reminder stage, no alert", async () => {
    const before = await alerts();
    const doc = await request(await permanentType(), null);
    const v = await upload(doc, null);
    await verify(v.document_version_id);
    expect(await statusOf(doc)).toMatchObject({ review_state: "verified", currency_status: "no_expiry_required", display_status: "verified", days_until: null, reminder_stage: null });
    expect(await alerts()).toEqual(before); // nothing expired, expiring or overdue was added
  });

  it("a missing expiry date alone does not make a non-expiring document overdue", async () => {
    const doc = await request(await permanentType(), null); // no due date, nothing uploaded yet
    expect(await statusOf(doc)).toMatchObject({ review_state: "requested", display_status: "requested", currency_status: "no_expiry_required" });
  });

  it("the submission due date is separate: a non-expiring document past its due date is overdue for submission", async () => {
    const before = (await alerts()).overdue as number;
    const doc = await request(await permanentType(), addDays(today, -3));
    expect(await statusOf(doc)).toMatchObject({ review_state: "overdue", display_status: "overdue", currency_status: "no_expiry_required" });
    expect((await alerts()).overdue).toBe(before + 1);
    // Once it is uploaded and verified it is no longer overdue, and still never expires.
    const v = await upload(doc, null);
    await verify(v.document_version_id);
    expect(await statusOf(doc)).toMatchObject({ review_state: "verified", display_status: "verified" });
    expect((await alerts()).overdue).toBe(before);
  });

  it("KNOWN LIMIT: no 'optional expiry' state; a date typed on a non-expiring type is ignored for status and alerts", async () => {
    const doc = await request(await permanentType(), null);
    const v = await upload(doc, addDays(today, 3));
    await verify(v.document_version_id);
    expect(await statusOf(doc)).toMatchObject({ currency_status: "no_expiry_required", display_status: "verified", reminder_stage: null });
  });
});
