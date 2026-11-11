// 0091 (PENDING, infra/aws/db/pending): owner decision R23. A caregiver sees "first name + last initial + code" for a client they are assigned to
// or scheduled with, and "code + city" only for an open shift. The label is computed on the server; an unassigned caregiver never receives a name.
// SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const UP = new URL("../pending/migrations/0104_caregiver_client_labels.sql", import.meta.url);
const DOWN = new URL("../pending/rollback/0104_caregiver_client_labels.down.sql", import.meta.url);
let db: TestDb;
let w: World;
let assigned: { client: string };
let other: { client: string };

const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const name = (client: string, first: string, last: string, city: string | null) =>
  db.admin.query("with n as (insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by) select $1, organization_id, $2, $3, $5 from ogevia.clients where id = $1 returning 1) update ogevia.clients set city = $4 where id = $1", [client, first, last, city, w.ownerA.userId]);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 900);
  assigned = await freshClient(db, w, w.caregiverA1, 100000);
  other = await freshClient(db, w, w.caregiverA2, 100000);
  await name(assigned.client, "Alexandra", "Fernandez-Synthetic", "Springfield");
  await name(other.client, "Brenda", "Quillfeather-Synthetic", "Shelbyville");
  await run(UP);
});
afterAll(async () => db?.drop());

describe("0091 caregiver client labels", () => {
  it("an assigned caregiver gets first name + last initial, and never the full surname", async () => {
    const rows = await call(w.caregiverA1, "select * from ogevia_api.list_assigned_visit_clients($1)", [w.orgA]);
    const mine = rows.find((r) => r.client_id === assigned.client);
    expect(mine.display_label).toBe("Alexandra F.");
    expect(JSON.stringify(rows)).not.toMatch(/Fernandez|Quillfeather|Brenda/);
    const legacy = await call(w.caregiverA1, "select ogevia_api.caregiver_visible_client_name($1,$2,'client') label", [w.orgA, assigned.client]);
    expect(legacy[0].label).toBe("Alexandra F.");
  });

  it("negative: a caregiver with no assignment or shift for a client does not receive that client at all, so no name", async () => {
    const rows = await call(w.caregiverA1, "select * from ogevia_api.list_assigned_visit_clients($1)", [w.orgA]);
    expect(rows.find((r) => r.client_id === other.client)).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain("Quillfeather");
  });

  it("an open shift carries the client code and city, and no name field", async () => {
    // An open shift for the client the second caregiver is assigned to, created by the manager with no caregiver.
    const svc = w.serviceA;
    const day = (await db.admin.query("select to_char((now() at time zone 'America/Los_Angeles')::date + 3, 'YYYY-MM-DD') d")).rows[0].d as string;
    await call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00','12:00',null,null)", [w.orgA, other.client, svc, day]);
    const open = await call(w.caregiverA2, "select * from ogevia_api.list_open_shifts($1)", [w.orgA]);
    const s = open.find((r) => r.city === "Shelbyville");
    expect(s).toBeTruthy();
    expect(s.client_code).toBeTruthy();
    expect(Object.keys(s).some((k) => /name/i.test(k.replace("service_name", "")))).toBe(false);
    expect(JSON.stringify(open)).not.toMatch(/Quillfeather|Brenda/);
  });

  it("the rollback restores the previous shape (no label, no city)", async () => {
    await run(DOWN);
    const rows = await call(w.caregiverA1, "select * from ogevia_api.list_assigned_visit_clients($1)", [w.orgA]);
    expect("display_label" in rows[0]).toBe(false);
    const open = await call(w.caregiverA2, "select * from ogevia_api.list_open_shifts($1)", [w.orgA]);
    expect(open.every((r) => !("city" in r))).toBe(true);
  });
});
