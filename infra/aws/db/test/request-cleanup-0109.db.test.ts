// 0109 (PENDING, infra/aws/db/pending): cancel a document request, retire a document type, clear care-request alerts. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const UP = new URL("../pending/migrations/0109_request_cleanup.sql", import.meta.url);
const DOWN = new URL("../pending/rollback/0109_request_cleanup.down.sql", import.meta.url);
let db: TestDb;
let w: World;
let rec: string;
let typeA: string;
let typeB: string;

const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const requestDoc = async (type: string) => (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id as string;
const cancel = (doc: string, reason = "Requested by mistake (synthetic)", a: Actor = w.managerA, org = w.orgA, key: string | null = null) =>
  call(a, "select ogevia_api.cancel_staff_document_request($1,$2,$3,$4) as r", [org, doc, reason, key]).then((r) => r[0].r as string);
const listed = async () => (await call(w.managerA, "select * from ogevia_api.list_staff_documents($1, null)", [w.orgA])).map((r: any) => r.document_id ?? r.id);

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1300);
  await run(UP);
  rec = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [w.caregiverA1.userId, w.orgA])).rows[0].id;
  typeA = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR/FIRST AID (synthetic)',false,null) as id", [w.orgA]))[0].id;
  typeB = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB TEST (synthetic)',false,null) as id", [w.orgA]))[0].id;
}, 120_000);
afterAll(async () => db?.drop());

describe("0109 cancel a document request", () => {
  it("closes a request with no upload, records who and why, audits it, and drops it from the list", async () => {
    const doc = await requestDoc(typeA);
    expect(await listed()).toContain(doc);
    expect(await cancel(doc)).toBe("cancelled");
    const row = (await db.admin.query("select closed_at, cancelled_by, cancel_reason from ogevia.staff_documents where id = $1", [doc])).rows[0];
    expect(row.closed_at).not.toBeNull();
    expect(row.cancelled_by).toBe(w.managerA.userId);
    expect(row.cancel_reason).toBe("Requested by mistake (synthetic)");
    expect(await listed()).not.toContain(doc);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where action = 'document.request_cancelled' and entity_id = $1", [doc])).rows[0].n).toBe(1);
    // The same document can be requested again afterwards (the one-open-request rule is about OPEN requests).
    expect(await requestDoc(typeA)).not.toBe(doc);
  });
  it("is idempotent with the same key, and refuses an already-closed request without one", async () => {
    const doc = (await db.admin.query("select id from ogevia.staff_documents where document_type_id = $1 and closed_at is null", [typeA])).rows[0].id;
    const key = randomUUID();
    expect(await cancel(doc, "Duplicate request (synthetic)", w.managerA, w.orgA, key)).toBe("cancelled");
    expect(await cancel(doc, "Duplicate request (synthetic)", w.managerA, w.orgA, key)).toBe("cancelled");
    await expectPgError(cancel(doc), "OGC09", /already closed/);
  });
  it("refuses a request that already has an upload", async () => {
    const doc = await requestDoc(typeB);
    await db.admin.query(
      "insert into ogevia.document_versions (organization_id, document_id, version_number, object_key, content_type, byte_size, sha256, uploaded_by) values ($1,$2,1,$3,'application/pdf',10,repeat('a',64),$4)",
      [w.orgA, doc, `synthetic/${randomUUID()}`, w.managerA.userId],
    );
    await expectPgError(cancel(doc), "OGC09", /already has an upload/);
  });
  it("requires a reason, the manage permission and the same organization", async () => {
    const doc = (await db.admin.query("select id from ogevia.staff_documents where document_type_id = $1 and closed_at is null", [typeA])).rows[0]?.id ?? await requestDoc(typeA);
    await expectPgError(cancel(doc, "  "), "OGV22");
    await expectPgError(cancel(doc, "Not mine (synthetic)", w.caregiverA2), "OGA03");
    await expectPgError(cancel(doc, "Other agency (synthetic)", w.managerB, w.orgB), "OGN04");
    await expectPgError(cancel(doc, "Wrong org id (synthetic)", w.managerA, w.orgB), "OGN04");
  });
});

describe("0109 retire a document type", () => {
  const retire = (type: string, reason = "Duplicate of the standard type (synthetic)", a: Actor = w.managerA) =>
    call(a, "select ogevia_api.retire_document_type($1,$2,$3) as r", [w.orgA, type, reason]).then((r) => r[0].r as string);
  it("refuses while the type has open requests, then retires it once they are cancelled; a retired type cannot be requested", async () => {
    await expectPgError(retire(typeA), "OGC09", /open request/);
    for (const r of (await db.admin.query("select id from ogevia.staff_documents where document_type_id = $1 and closed_at is null", [typeA])).rows) await cancel(r.id);
    expect(await retire(typeA)).toBe("retired");
    expect(await retire(typeA)).toBe("already_retired");
    await expectPgError(requestDoc(typeA), "OGN04", /Document type not found/);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where action = 'document_type.retired' and entity_id = $1", [typeA])).rows[0].n).toBe(1);
  });
  it("refuses the type used for the agency's CPR or TB requirement", async () => {
    const t = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR requirement (synthetic)',false,null) as id", [w.orgA]))[0].id;
    await db.admin.query("update ogevia.document_types set work_requirement = 'cpr' where id = $1", [t]);
    await expectPgError(retire(t), "OGC09", /CPR requirement/);
  });
  it("needs the manage permission", async () => {
    await expectPgError(retire(typeB, "Not allowed (synthetic)", w.caregiverA2), "OGA03");
  });
});

describe("0109 clear care-request alerts", () => {
  let request: string;
  const notify = async (user: string, org = w.orgA, req = request) =>
    (await db.admin.query("insert into ogevia.care_notifications (organization_id, care_request_id, recipient_type, recipient_user_id, event_key) values ($1,$2,'staff',$3,'care_request_created') returning id", [org, req, user])).rows[0].id as string;
  const unread = (a: Actor) => call(a, "select * from ogevia_api.list_staff_care_notifications($1)", [w.orgA]);
  beforeAll(async () => {
    request = (await db.admin.query(
      `insert into ogevia.care_requests (organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at, requested_minutes, request_key)
       values ($1,$2,$3,$4, now() + interval '3 days', now() + interval '3 days 4 hours', 240, gen_random_uuid()) returning id`,
      [w.orgA, w.clientA1, w.serviceA, w.authA1])).rows[0].id;
  });
  it("marks only the caller's own alerts read (one, then all), and they leave the unread list", async () => {
    const mine1 = await notify(w.managerA.userId);
    const mine2 = await notify(w.managerA.userId);
    const theirs = await notify(w.ownerA.userId);
    expect((await unread(w.managerA)).length).toBe(2);
    expect((await call(w.managerA, "select ogevia_api.mark_staff_care_notifications_read($1,$2::uuid[]) n", [w.orgA, [mine1]]))[0].n).toBe(1);
    expect((await unread(w.managerA)).map((n: any) => n.notification_id)).toEqual([mine2]);
    // Another person's alert id is ignored, never marked.
    expect((await call(w.managerA, "select ogevia_api.mark_staff_care_notifications_read($1,$2::uuid[]) n", [w.orgA, [theirs]]))[0].n).toBe(0);
    expect((await call(w.managerA, "select ogevia_api.mark_staff_care_notifications_read($1,null) n", [w.orgA]))[0].n).toBe(1);
    expect(await unread(w.managerA)).toEqual([]);
    expect((await unread(w.ownerA)).length).toBe(1);
  });
  it("refuses a person without access to care requests, and a different organization", async () => {
    await expectPgError(call(w.caregiverA2, "select ogevia_api.mark_staff_care_notifications_read($1,null)", [w.orgA]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.mark_staff_care_notifications_read($1,null)", [w.orgA]), "OGA03");
  });
});

describe("0109 rollback", () => {
  it("removes the functions and columns; cancelled requests stay closed", async () => {
    await run(DOWN);
    expect((await db.admin.query("select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'ogevia_api' and p.proname in ('cancel_staff_document_request','retire_document_type','mark_staff_care_notifications_read')")).rows[0].n).toBe(0);
    expect((await db.admin.query("select count(*)::int n from ogevia.staff_documents where document_type_id = $1 and closed_at is null", [typeA])).rows[0].n).toBe(0);
    await run(UP);   // re-applies cleanly
  });
});
