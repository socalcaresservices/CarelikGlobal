// R11 bulk import over HTTP (pending migration 0092, applied on top of 0001-0088) through the real Lambda handler and a real disposable PostgreSQL.
// SYNTHETIC data only.
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let handler: ReturnType<typeof createHandler>;
const logs: unknown[] = [];
const ROUTE = "POST /v1/imports/{kind}";

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 1100);
  const c = await db.admin.connect();
  try {
    await c.query("begin"); await c.query("set local role ogevia_owner");
    await c.query(readFileSync(new URL("../../../infra/aws/db/pending/migrations/0092_bulk_import.sql", import.meta.url), "utf8"));
    await c.query("reset role"); await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: (l: unknown) => logs.push(l) });
});
afterAll(async () => db?.drop());

async function call(actor: Actor | null, kind: string, body: Record<string, unknown>) {
  const r = await handler(event(ROUTE, { ...(actor ? { sub: actor.sub } : {}), path: { kind }, body }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const people = (csv: string, over: Record<string, unknown> = {}) => ({ organizationId: w.orgA, fileName: "people.csv", contentBase64: b64(csv), ...over });
const count = async (t: string) => (await db.admin.query(`select count(*)::int n from ogevia.${t} where organization_id = $1`, [w.orgA])).rows[0].n as number;

describe("POST /v1/imports/{kind}", () => {
  it("preview (default) returns counts and writes nothing; confirm creates the new rows; the same file again creates nothing", async () => {
    const csv = "first_name,last_name,type\nRita,Http,Caregiver\nRita,Http,Caregiver\n";
    const before = await count("caregiver_records");
    const p = await call(w.ownerA, "people", people(csv));
    expect(p.status).toBe(200);
    expect(p.body.import).toMatchObject({ mode: "preview", counts: { total: 2, new: 1, duplicate: 1, invalid: 0 } });
    expect(await count("caregiver_records")).toBe(before);
    const c = await call(w.ownerA, "people", people(csv, { confirm: true }));
    expect(c.body.import).toMatchObject({ mode: "applied", created: 1 });
    expect(await count("caregiver_records")).toBe(before + 1);
    const again = await call(w.ownerA, "people", people(csv, { confirm: true }));
    expect(again.body.import.mode).toBe("already_imported");
    expect(await count("caregiver_records")).toBe(before + 1);
  });

  it("reads an .xlsx upload the same way", async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("c");
    ws.addRow(["first_name", "last_name", "city"]); ws.addRow(["Xena", "Sheet", "Springfield"]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await call(w.ownerA, "clients", { organizationId: w.orgA, fileName: "clients.xlsx", contentBase64: b64(bytes), confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.import.created).toBe(1);
  });

  it("malformed files are 422 with a plain message and nothing is written; a bad type is 404; bad base64 is 400", async () => {
    const before = await count("caregiver_records");
    const a = await call(w.ownerA, "people", people("first_name\nOnly\n"));
    expect(a.status).toBe(422);
    expect(a.body.error.message).toMatch(/missing: last name/);
    expect((await call(w.ownerA, "people", people("a,b\n\"never closed,1\n"))).status).toBe(422);
    expect((await call(w.ownerA, "vehicles", people("first_name,last_name\nA,B\n"))).status).toBe(404);
    expect((await call(w.ownerA, "people", { organizationId: w.orgA, fileName: "x.csv", contentBase64: "not base64!!" })).status).toBe(400);
    expect(await count("caregiver_records")).toBe(before);
  });

  it("invalid rows: preview lists them; confirm is refused (422) and creates nothing", async () => {
    const csv = "first_name,last_name\nGood,Row\n=HYPERLINK(1),Evil\n";
    const before = await count("caregiver_records");
    const p = await call(w.ownerA, "people", people(csv));
    expect(p.body.import.counts.invalid).toBe(1);
    expect(p.body.import.rows[0]).toMatchObject({ row: 3, status: "invalid" });
    const c = await call(w.ownerA, "people", people(csv, { confirm: true }));
    expect(c.status).toBe(422);
    expect(await count("caregiver_records")).toBe(before);
  });

  it("permissions and tenant: a caregiver is 403, no sign-in is 401, another agency's administrator cannot import into this one (404)", async () => {
    const csv = "first_name,last_name\nNo,Access\n";
    expect((await call(w.caregiverA1, "people", people(csv))).status).toBe(403);
    expect((await call(null, "people", people(csv))).status).toBe(401);
    expect((await call(w.managerB, "people", people(csv, { confirm: true }))).status).toBe(404);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_records where last_name = 'Access'")).rows[0].n).toBe(0);
  });

  it("no file content or names are written to the logs", async () => {
    await call(w.ownerA, "people", people("first_name,last_name\nSecretFirst,SecretLast\n", { confirm: true }));
    expect(JSON.stringify(logs)).not.toMatch(/SecretFirst|SecretLast/);
  });
});
