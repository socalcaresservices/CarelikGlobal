// 0021 Staff documents: request -> upload (versioned) -> review, derived
// statuses in agency local time, permissions and tenant isolation.
// SYNTHETIC data only; S3 is not involved here (the API test covers files).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

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

describe("document types", () => {
  it("managers configure types; expiry is per type; duplicates, caregivers and schedulers are refused", async () => {
    for (const [name, exp] of [["TB test", true], ["CPR", true], ["Orientation", false]] as const) {
      types[name] = (await call(w.managerA, "select ogevia_api.create_document_type($1,$2,$3,null) as id", [w.orgA, name, exp]))[0]!.id;
    }
    await expectPgError(call(w.managerA, "select ogevia_api.create_document_type($1,'tb TEST',true,null)", [w.orgA]), "OGC09");
    await expectPgError(call(w.caregiverA1, "select ogevia_api.create_document_type($1,'X type',false,null)", [w.orgA]), "OGA03");
    await expectPgError(call(w.schedulerA, "select ogevia_api.create_document_type($1,'X type',false,null)", [w.orgA]), "OGA03");
    const listed = await call(w.caregiverA1, "select name, requires_expiry from ogevia_api.list_document_types($1)", [w.orgA]);
    expect(listed).toEqual([{ name: "CPR", requires_expiry: true }, { name: "Orientation", requires_expiry: false }, { name: "TB test", requires_expiry: true }]);
    expect(await call(w.managerB, "select * from ogevia_api.list_document_types($1)", [w.orgA])).toEqual([]);
  });
});

describe("request, upload, review", () => {
  let tb: string;

  it("a manager requests a document; one open request per person and type; other agencies cannot", async () => {
    tb = await request(w.managerA, recordOf.a1!, types["TB test"]!, addDays(today, 14));
    await expectPgError(request(w.managerA, recordOf.a1!, types["TB test"]!, null), "OGC09");
    await expectPgError(request(w.managerB, recordOf.a1!, types["TB test"]!, null), "OGN04");
    await expectPgError(request(w.caregiverA1, recordOf.a1!, types["CPR"]!, null), "OGA03");
    // Another agency's caregiver record cannot be targeted from org A.
    await expectPgError(request(w.managerA, recordOf.b1!, types["CPR"]!, null), "OGN04");
    const [d] = (await listDocs(w.caregiverA1)).filter((x) => x.document_id === tb);
    expect(d).toMatchObject({ display_status: "requested", days_until: 14, latest_version_id: null });
  });

  it("each person sees only their own; schedulers and other agencies see nothing", async () => {
    expect((await listDocs(w.caregiverA2)).some((d) => d.document_id === tb)).toBe(false);
    expect(await listDocs(w.schedulerA)).toEqual([]);
    expect(await listDocs(w.managerB)).toEqual([]);
    expect(await listDocs(w.outsider)).toEqual([]);
  });

  it("upload validation: expiry required for the type, sane dates, server-built key, own document only", async () => {
    await expectPgError(upload(w.caregiverA1, tb, { issued: today }), "OGV22", /expiry date/);
    await expectPgError(upload(w.caregiverA1, tb, { issued: today, expires: today }), "OGV22", /after the issue date/);
    await expectPgError(upload(w.caregiverA1, tb, { issued: addDays(today, 1), expires: addDays(today, 400) }), "OGV22", /future/);
    await expectPgError(upload(w.caregiverA1, tb, { issued: today, expires: addDays(today, 365), objectKey: "elsewhere/x" }), "OGV22");
    await expectPgError(upload(w.caregiverA2, tb, { issued: today, expires: addDays(today, 365) }), "OGN04");
    await expectPgError(upload(w.managerB, tb, { issued: today, expires: addDays(today, 365) }), "OGN04");
  });

  it("uploaded is not verified: it waits for review; a retry with the same key does not add a version", async () => {
    const key = randomUUID();
    const v1 = await upload(w.caregiverA1, tb, { issued: today, expires: addDays(today, 365), key });
    expect(v1.version_number).toBe(1);
    const again = await upload(w.caregiverA1, tb, { issued: today, expires: addDays(today, 365), key });
    expect(again.document_version_id).toBe(v1.document_version_id);
    const replay = await call(w.caregiverA1, "select * from ogevia_api.get_document_upload_replay($1,$2)", [tb, key]);
    expect(replay[0]).toMatchObject({ document_version_id: v1.document_version_id, version_number: 1 });
    expect(await statusOf(w.managerA, tb)).toMatchObject({ display_status: "awaiting_review", latest_version_number: 1 });
  });

  it("review: managers only, a reason to reject, once; caregivers and other agencies cannot", async () => {
    const [{ latest_version_id: v1 }] = (await listDocs(w.managerA)).filter((d) => d.document_id === tb);
    await expectPgError(review(w.caregiverA1, v1, "verified"), "OGA03");
    await expectPgError(review(w.managerB, v1, "verified"), "OGN04");
    await expectPgError(review(w.managerA, v1, "rejected", "  "), "OGV22");
    await review(w.managerA, v1, "rejected", "Photo is blurred (synthetic)");
    await expectPgError(review(w.ownerA, v1, "verified"), "OGC09");
    expect(await statusOf(w.caregiverA1, tb)).toMatchObject({ display_status: "rejected", latest_rejection_reason: "Photo is blurred (synthetic)" });
  });

  it("a new version replaces it; verified with a far expiry is Verified; history is kept and append-only", async () => {
    const v2 = await upload(w.caregiverA1, tb, { issued: today, expires: addDays(today, 365) });
    expect(v2.version_number).toBe(2);
    await review(w.managerA, v2.document_version_id, "verified");
    expect(await statusOf(w.managerA, tb)).toMatchObject({ display_status: "verified", days_until: 365 });
    const n = await db.admin.query("select count(*)::int as n from ogevia.document_versions where document_id = $1", [tb]);
    expect(n.rows[0].n).toBe(2);
    await expectPgError(db.admin.query("update ogevia.document_versions set byte_size = 1 where id = $1", [v2.document_version_id]), "OGC09");
    await expectPgError(db.admin.query("delete from ogevia.document_versions where id = $1", [v2.document_version_id]), "OGC09");
  });

  it("expiring within 30 days, expired, and overdue requests are derived from agency-local dates", async () => {
    const cpr = await request(w.managerA, recordOf.a1!, types["CPR"]!, null);
    const v = await upload(w.caregiverA1, cpr, { issued: addDays(today, -700), expires: addDays(today, 10) });
    await review(w.managerA, v.document_version_id, "verified");
    expect(await statusOf(w.managerA, cpr)).toMatchObject({ display_status: "expiring", days_until: 10 });

    const old = await request(w.managerA, recordOf.a2!, types["CPR"]!, null);
    const vo = await upload(w.caregiverA2, old, { issued: addDays(today, -800), expires: addDays(today, -1) });
    await review(w.managerA, vo.document_version_id, "verified");
    expect(await statusOf(w.managerA, old)).toMatchObject({ display_status: "expired", days_until: -1 });

    const orient = await request(w.managerA, recordOf.a2!, types["Orientation"]!, addDays(today, -3));
    expect(await statusOf(w.managerA, orient)).toMatchObject({ display_status: "overdue", days_until: -3 });

    const [alerts] = await call(w.managerA, "select * from ogevia_api.get_document_alerts($1)", [w.orgA]);
    expect(alerts).toMatchObject({ expired: 1, expiring: 1, overdue: 1 });
    expect(await call(w.caregiverA1, "select * from ogevia_api.get_document_alerts($1)", [w.orgA])).toEqual([]);
  });

  it("a manager may upload on someone's behalf but cannot review their own upload", async () => {
    const doc = await request(w.managerA, recordOf.a2!, types["TB test"]!, null);
    const v = await upload(w.managerA, doc, { issued: today, expires: addDays(today, 365) });
    await expectPgError(review(w.managerA, v.document_version_id, "verified"), "OGA03");
    await review(w.ownerA, v.document_version_id, "verified");
  });

  it("opening a file is permission-checked and audited", async () => {
    const [{ latest_version_id: v }] = (await listDocs(w.managerA)).filter((d) => d.document_id === tb);
    const [file] = await call(w.caregiverA1, "select * from ogevia_api.open_document_version($1)", [v]);
    expect(file.object_key).toBe(`${w.orgA}/documents/${tb}/${v}`);
    await expectPgError(call(w.caregiverA2, "select * from ogevia_api.open_document_version($1)", [v]), "OGN04");
    await expectPgError(call(w.managerB, "select * from ogevia_api.open_document_version($1)", [v]), "OGN04");
    await expectPgError(call(w.schedulerA, "select * from ogevia_api.open_document_version($1)", [v]), "OGN04");
    const audit = await db.admin.query("select actor_user_id from ogevia.audit_events where action = 'document.viewed' and entity_id = $1", [v]);
    expect(audit.rows.map((r) => r.actor_user_id)).toEqual([w.caregiverA1.userId]);
  });

  it("the application role cannot read document tables directly", async () => {
    await expect(asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia.document_versions"))).rejects.toMatchObject({ code: "42501" });
  });
});
