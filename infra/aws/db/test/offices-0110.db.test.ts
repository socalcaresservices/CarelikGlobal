// 0110 (PENDING, infra/aws/db/pending): offices and a client's responsible office. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const UP = new URL("../pending/migrations/0110_offices.sql", import.meta.url);
const DOWN = new URL("../pending/rollback/0110_offices.down.sql", import.meta.url);
let db: TestDb;
let w: World;
let north: string;

const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const create = (name: string, a: Actor = w.ownerA, org = w.orgA, key: string | null = null) =>
  call(a, "select ogevia_api.create_office($1,$2,$3) as id", [org, name, key]).then((r) => r[0].id as string);
const setOffice = (client: string, office: string | null, a: Actor = w.managerA, org = w.orgA) =>
  call(a, "select ogevia_api.set_client_office($1,$2,$3) as r", [org, client, office]).then((r) => r[0].r as string);
const offices = (a: Actor = w.managerA, org = w.orgA) => call(a, "select * from ogevia_api.list_offices($1)", [org]);

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1400);
  await run(UP);
}, 120_000);
afterAll(async () => db?.drop());

describe("0110 offices", () => {
  it("the Administrator creates, renames and retires offices; names are unique per agency regardless of case; every change is audited", async () => {
    north = await create("  North Office  ");
    expect((await offices()).map((o: any) => [o.name, o.is_active, o.client_count])).toEqual([["North Office", true, 0]]);
    await expectPgError(create("north office"), "OGC09", /already exists/);
    await expectPgError(create("x"), "OGV22", /between 2 and 80/);
    expect(await call(w.ownerA, "select ogevia_api.rename_office($1,$2,'North County Office') as r", [w.orgA, north]).then((r) => r[0].r)).toBe("renamed");
    expect(await call(w.ownerA, "select ogevia_api.rename_office($1,$2,'North County Office') as r", [w.orgA, north]).then((r) => r[0].r)).toBe("unchanged");
    const audits = (await db.admin.query("select action from ogevia.audit_events where entity_type = 'offices' and entity_id = $1 order by occurred_at", [north])).rows.map((r) => r.action);
    expect(audits).toEqual(["office.created", "office.renamed"]);
  });
  it("create is idempotent with the same key", async () => {
    const key = randomUUID();
    const a = await create("South Office", w.ownerA, w.orgA, key);
    const b = await create("South Office", w.ownerA, w.orgA, key);
    expect(b).toBe(a);
    expect((await offices()).filter((o: any) => o.name === "South Office")).toHaveLength(1);
  });
  it("only the agency Administrator manages offices: a manager, a scheduler and a caregiver are refused; another agency cannot touch them", async () => {
    await expectPgError(create("Manager Office", w.managerA), "OGA03", /Administrator/);
    await expectPgError(create("Scheduler Office", w.schedulerA), "OGA03", /Administrator/);
    await expectPgError(create("Caregiver Office", w.caregiverA1), "OGA03", /Administrator/);
    await expectPgError(call(w.managerB, "select ogevia_api.rename_office($1,$2,'Hijack') as r", [w.orgA, north]), "OGN04", /Organization not found/);
    await expectPgError(call(w.managerB, "select ogevia_api.rename_office($1,$2,'Hijack') as r", [w.orgB, north]), "OGA03", /Administrator/);   // own agency: not an Administrator, and the office is not theirs either
  });
  it("reading offices needs a client-names or billing permission: a caregiver sees none (refused as no rows) and another agency sees none", async () => {
    expect((await offices(w.managerA)).length).toBeGreaterThan(0);
    expect(await offices(w.caregiverA1)).toEqual([]);
    expect(await offices(w.managerB, w.orgB)).toEqual([]);
    expect(await call(w.caregiverA1, "select * from ogevia_api.list_client_offices($1)", [w.orgA])).toEqual([]);
  });
});

describe("0110 a client's responsible office", () => {
  it("a manager sets, changes and clears it; the list shows the code, the count follows, and each change is audited", async () => {
    expect(await setOffice(w.clientA1, north)).toBe("set");
    expect(await setOffice(w.clientA1, north)).toBe("unchanged");
    const mapped = await call(w.managerA, "select * from ogevia_api.list_client_offices($1)", [w.orgA]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].client_id).toBe(w.clientA1);
    expect(mapped[0].office_id).toBe(north);
    expect(String(mapped[0].client_code)).toMatch(/^CL-/);
    expect((await offices()).find((o: any) => o.office_id === north)?.client_count).toBe(1);
    expect(await setOffice(w.clientA1, null)).toBe("cleared");
    expect(await call(w.managerA, "select * from ogevia_api.list_client_offices($1)", [w.orgA])).toEqual([]);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where action = 'client.office_set' and entity_id = $1", [w.clientA1])).rows[0].n).toBe(2);
  });
  it("refuses a scheduler, a caregiver, an unknown or other-agency client, and an unknown, retired or other-agency office", async () => {
    await expectPgError(setOffice(w.clientA1, north, w.schedulerA), "OGA03", /permission/);
    await expectPgError(setOffice(w.clientA1, north, w.caregiverA1), "OGA03", /permission/);
    await expectPgError(setOffice(randomUUID(), north), "OGN04", /Client not found/);
    await expectPgError(setOffice(w.clientB1, north, w.managerA), "OGN04", /Client not found/);
    await expectPgError(setOffice(w.clientA1, randomUUID()), "OGV22", /active office/);
    const other = await create("Other Agency Office", w.ownerA, w.orgA);
    expect(await call(w.ownerA, "select ogevia_api.retire_office($1,$2,'Closed (synthetic)') as r", [w.orgA, other]).then((r) => r[0].r)).toBe("retired");
    await expectPgError(setOffice(w.clientA1, other), "OGV22", /active office/);
  });
  it("retiring keeps history: a retired office stays listed (inactive), keeps its clients and cannot be chosen again; a reason is required", async () => {
    await setOffice(w.clientA2, north);
    const temp = await create("Temporary Office");
    await setOffice(w.clientA1, temp);
    await expectPgError(call(w.ownerA, "select ogevia_api.retire_office($1,$2,'') as r", [w.orgA, temp]), "OGV22", /reason/);
    expect(await call(w.ownerA, "select ogevia_api.retire_office($1,$2,'Merged into North (synthetic)') as r", [w.orgA, temp]).then((r) => r[0].r)).toBe("retired");
    expect(await call(w.ownerA, "select ogevia_api.retire_office($1,$2,'Again (synthetic)') as r", [w.orgA, temp]).then((r) => r[0].r)).toBe("already_retired");
    const listed = await offices();
    expect(listed.find((o: any) => o.office_id === temp)).toMatchObject({ is_active: false, client_count: 1 });
    expect(listed[listed.length - 1].is_active).toBe(false);   // inactive offices sort last
    await expectPgError(setOffice(w.clientA2, temp), "OGV22", /active office/);
  });
  it("a client of another agency can never point at this agency's office (composite key)", async () => {
    await expect(db.admin.query("update ogevia.clients set responsible_office_id = $1 where id = $2", [north, w.clientB1])).rejects.toThrow(/clients_responsible_office_fk|violates foreign key/);
  });
});

describe("0110 rollback", () => {
  it("removes the functions, the column and the table together; the rest of the client record is untouched, and it can be re-applied", async () => {
    const before = (await db.admin.query("select id, client_code, status from ogevia.clients order by id")).rows;
    await run(DOWN);
    expect((await db.admin.query("select to_regclass('ogevia.offices') t")).rows[0].t).toBeNull();
    expect((await db.admin.query("select count(*)::int n from information_schema.columns where table_schema='ogevia' and table_name='clients' and column_name='responsible_office_id'")).rows[0].n).toBe(0);
    expect((await db.admin.query("select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='ogevia_api' and p.proname in ('create_office','rename_office','retire_office','list_offices','list_client_offices','set_client_office')")).rows[0].n).toBe(0);
    expect((await db.admin.query("select id, client_code, status from ogevia.clients order by id")).rows).toEqual(before);
    await run(UP);
    expect((await offices()).length).toBe(0);
  });
});
