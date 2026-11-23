// 0111 (PENDING, infra/aws/db/pending): office assignments (many per person, one primary), office address and county, service counties, caregiver colours. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const UP0110 = new URL("../pending/migrations/0110_offices.sql", import.meta.url);
const UP = new URL("../pending/migrations/0111_office_assignments_counties_colors.sql", import.meta.url);
const DOWN = new URL("../pending/rollback/0111_office_assignments_counties_colors.down.sql", import.meta.url);
const UP0112 = new URL("../pending/migrations/0112_assignment_history.sql", import.meta.url);
const DOWN0112 = new URL("../pending/rollback/0112_assignment_history.down.sql", import.meta.url);
let db: TestDb; let w: World;
let temecula: string; let moreno: string; let corona: string; let cgA: string; let cgB: string; let cgOrgB: string; let preAssignedClient: string;

const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
const create = (name: string, a: Actor = w.ownerA, org = w.orgA) => call(a, "select ogevia_api.create_office($1,$2,null) as id", [org, name]).then((r) => r[0].id as string);
const setOffices = (type: "client" | "caregiver", id: string, primary: string | null, secondary: string[] = [], a: Actor = w.managerA, org = w.orgA) =>
  call(a, "select ogevia_api.set_person_offices($1,$2,$3,$4,$5::uuid[]) as r", [org, type, id, primary, secondary]).then((r) => r[0].r as string);
const assigned = async (type: "client" | "caregiver", id: string) =>
  (await q(`select office_id, is_primary from ogevia.office_assignments where ${type === "client" ? "client_id" : "caregiver_record_id"} = $1 order by is_primary desc, office_id`, [id])) as Array<{ office_id: string; is_primary: boolean }>;
const facets = (a: Actor = w.managerA, org = w.orgA) => call(a, "select ogevia_api.list_people_facets($1) as f", [org]).then((r) => r[0].f);
const audits = async (entity: string, action: string) => (await q("select before_state, after_state from ogevia.audit_events where entity_id = $1 and action = $2 order by occurred_at", [entity, action]));

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1400);
  await run(UP0110);
  // a 0110 assignment that exists BEFORE 0111 (the backfill must keep it as the primary office)
  const old = await call(w.ownerA, "select ogevia_api.create_office($1,'Legacy Office',null) as id", [w.orgA]).then((r) => r[0].id as string);
  preAssignedClient = w.clientA2;
  await call(w.managerA, "select ogevia_api.set_client_office($1,$2,$3)", [w.orgA, preAssignedClient, old]);
  await run(UP);
  await run(UP0112);
  temecula = await create("Temecula"); moreno = await create("Moreno Valley"); corona = await create("Corona");
  cgA = (await q("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1, 'CG-SYN-A', 'Syn', 'One', 'active') returning id", [w.orgA]))[0].id;
  cgB = (await q("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1, 'CG-SYN-B', 'Syn', 'Two', 'active') returning id", [w.orgA]))[0].id;
  cgOrgB = (await q("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1, 'CG-SYN-X', 'Syn', 'Other', 'active') returning id", [w.orgB]))[0].id;
}, 120_000);
afterAll(async () => db?.drop());

describe("0111 existing data", () => {
  it("a 0110 client assignment becomes the PRIMARY assignment and nothing else is invented; unassigned records stay unassigned", async () => {
    const a = await assigned("client", preAssignedClient); expect(a).toHaveLength(1); expect(a[0]!.is_primary).toBe(true);
    expect(await assigned("client", w.clientA1)).toEqual([]);
    expect((await q("select count(*)::int n from ogevia.office_assignments where caregiver_record_id is not null"))[0].n).toBe(0);
    expect((await q("select count(*)::int n from ogevia.clients where service_county is not null"))[0].n).toBe(0);
    expect((await q("select count(*)::int n from ogevia.caregiver_records where profile_color is not null"))[0].n).toBe(0);
  });
});

describe("offices: address and county belong to the office", () => {
  it("the Administrator edits name, address, ZIP and county (county accepted in any case, with or without 'County'); assignments and service counties never change; every edit is audited", async () => {
    await setOffices("caregiver", cgA, temecula);
    await call(w.managerA, "select ogevia_api.set_caregiver_service_counties($1,$2,'{riverside}')", [w.orgA, cgA]);
    const r = await call(w.ownerA, "select ogevia_api.update_office($1,$2,'Temecula','27 Synthetic Way','Temecula','92590','riverside county') as r", [w.orgA, temecula]);
    expect(r[0].r).toBe("updated");
    const o = (await call(w.managerA, "select * from ogevia_api.list_offices($1)", [w.orgA])).find((x: any) => x.office_id === temecula);
    expect(o).toMatchObject({ address_line1: "27 Synthetic Way", city: "Temecula", postal_code: "92590", county: "Riverside", caregiver_count: 1 });
    // the office moves: only the office record changes
    expect((await call(w.ownerA, "select ogevia_api.update_office($1,$2,'Temecula','900 Moved Street','Murrieta','92562','Riverside') as r", [w.orgA, temecula]))[0].r).toBe("updated");
    expect(await assigned("caregiver", cgA)).toEqual([{ office_id: temecula, is_primary: true }]);
    expect((await q("select county from ogevia.caregiver_service_counties where caregiver_record_id = $1", [cgA])).map((x) => x.county)).toEqual(["Riverside"]);
    expect((await call(w.ownerA, "select ogevia_api.update_office($1,$2,'Temecula','900 Moved Street','Murrieta','92562','Riverside') as r", [w.orgA, temecula]))[0].r).toBe("unchanged");
    const a = await audits(temecula, "office.updated"); expect(a).toHaveLength(2); expect(a[1]!.before_state.address).toBe("27 Synthetic Way"); expect(a[1]!.after_state.address).toBe("900 Moved Street");
  });
  it("validates: a name that already exists (any case), a bad ZIP, a county that is not a California county; Temecula and Moreno Valley are distinct offices in the same county", async () => {
    await expectPgError(call(w.ownerA, "select ogevia_api.update_office($1,$2,'moreno valley',null,null,null,null)", [w.orgA, temecula]), "OGC09", /already exists/);
    await expectPgError(call(w.ownerA, "select ogevia_api.update_office($1,$2,'Temecula',null,null,'9259',null)", [w.orgA, temecula]), "OGV22", /ZIP/);
    await expectPgError(call(w.ownerA, "select ogevia_api.update_office($1,$2,'Temecula',null,null,null,'Narnia')", [w.orgA, temecula]), "OGV22", /California county/);
    await call(w.ownerA, "select ogevia_api.update_office($1,$2,'Moreno Valley','1 Synthetic Blvd','Moreno Valley','92553','Riverside')", [w.orgA, moreno]);
    const list = await call(w.managerA, "select * from ogevia_api.list_offices($1)", [w.orgA]);
    expect(list.filter((o: any) => o.county === "Riverside").map((o: any) => o.name).sort()).toEqual(["Moreno Valley", "Temecula"]);
  });
  it("only the Administrator edits or reactivates an office; another agency and a caregiver are refused", async () => {
    await expectPgError(call(w.managerA, "select ogevia_api.update_office($1,$2,'X Office',null,null,null,null)", [w.orgA, temecula]), "OGA03", /Administrator/);
    await expectPgError(call(w.caregiverA1, "select ogevia_api.update_office($1,$2,'X Office',null,null,null,null)", [w.orgA, temecula]), "OGA03", /Administrator/);
    await expectPgError(call(w.managerB, "select ogevia_api.update_office($1,$2,'X Office',null,null,null,null)", [w.orgA, temecula]), "OGN04", /Organization not found/);
    await expectPgError(call(w.managerA, "select ogevia_api.reactivate_office($1,$2)", [w.orgA, temecula]), "OGA03", /Administrator/);
  });
});

describe("assignments: zero, one or many offices; exactly one primary", () => {
  it("a client: first office is the primary; add secondary offices; change the primary; remove; clear; duplicates collapse; one row per office", async () => {
    expect(await setOffices("client", w.clientA1, temecula)).toBe("set");
    expect(await assigned("client", w.clientA1)).toEqual([{ office_id: temecula, is_primary: true }]);
    expect(await setOffices("client", w.clientA1, temecula, [moreno, moreno, temecula])).toBe("set");
    expect((await assigned("client", w.clientA1)).map((x) => [x.office_id, x.is_primary])).toEqual([[temecula, true], [moreno, false]]);
    expect(await setOffices("client", w.clientA1, temecula, [moreno])).toBe("unchanged");
    expect(await setOffices("client", w.clientA1, moreno, [temecula])).toBe("set");   // the primary office changes
    expect((await assigned("client", w.clientA1)).map((x) => [x.office_id, x.is_primary])).toEqual([[moreno, true], [temecula, false]]);
    expect((await q("select responsible_office_id from ogevia.clients where id = $1", [w.clientA1]))[0].responsible_office_id).toBe(moreno);   // 0110's field stays the primary office
    const a = await audits(w.clientA1, "client.offices_set"); expect(a.length).toBeGreaterThanOrEqual(3);
    expect(a.at(-1)!.before_state.primary).toBe(temecula); expect(a.at(-1)!.after_state.primary).toBe(moreno);
    expect(await setOffices("client", w.clientA1, temecula, [])).toBe("set");   // moreno removed
    expect((await assigned("client", w.clientA1)).map((x) => x.office_id)).toEqual([temecula]);
    expect(await setOffices("client", w.clientA1, null, [])).toBe("set");   // cleared: unassigned again
    expect(await assigned("client", w.clientA1)).toEqual([]);
    expect((await q("select responsible_office_id from ogevia.clients where id = $1", [w.clientA1]))[0].responsible_office_id).toBeNull();
  });
  it("a caregiver can hold a primary and a secondary office; secondary offices without a primary are refused", async () => {
    expect(await setOffices("caregiver", cgA, temecula, [moreno])).toBe("set");
    expect((await assigned("caregiver", cgA)).map((x) => [x.office_id, x.is_primary])).toEqual([[temecula, true], [moreno, false]]);
    await expectPgError(setOffices("caregiver", cgB, null, [moreno]), "OGV22", /primary office/);
    expect(await assigned("caregiver", cgB)).toEqual([]);
  });
  it("the database itself refuses two primaries, and a person with offices but no primary", async () => {
    await expect(db.admin.query("insert into ogevia.office_assignments (organization_id, caregiver_record_id, office_id, is_primary, assigned_by) values ($1, $2, $3, true, (select id from ogevia.app_users limit 1))", [w.orgA, cgA, corona])).rejects.toThrow(/duplicate key|primary/);
    const c = await db.admin.connect();
    try {
      await c.query("begin");
      await c.query("update ogevia.office_assignments set is_primary = false where caregiver_record_id = $1", [cgA]);
      await expect(c.query("commit")).rejects.toThrow(/exactly one primary/);
    } finally { await c.query("rollback").catch(() => {}); c.release(); }
    expect((await assigned("caregiver", cgA))[0]!.is_primary).toBe(true);
  });
  it("another agency's office or record is refused; a caregiver cannot assign; permissions are the existing ones", async () => {
    const other = await create("Other Agency Office", w.ownerA, w.orgA); void other;
    const orgBOffice = await call(w.managerB, "select 1").then(() => null).catch(() => null); void orgBOffice;
    await expectPgError(setOffices("caregiver", cgOrgB, temecula), "OGN04", /Record not found/);
    await expectPgError(setOffices("client", w.clientB1, temecula, [], w.managerB, w.orgB), "OGN04", /Office not found/);
    await expectPgError(setOffices("client", w.clientA1, temecula, [], w.caregiverA1), "OGA03", /permission/);
    await expectPgError(setOffices("client", w.clientA1, temecula, [], w.managerB, w.orgA), "OGN04", /Organization not found/);
  });
  it("an inactive office keeps its existing links and history, cannot be newly assigned, and the people can be reassigned; reactivating makes it selectable again", async () => {
    const closed = await create("Closing Office");
    await setOffices("client", w.clientA1, temecula, [closed]);
    await call(w.ownerA, "select ogevia_api.retire_office($1,$2,'Closed (synthetic)')", [w.orgA, closed]);
    expect((await assigned("client", w.clientA1)).map((x) => x.office_id).sort()).toEqual([temecula, closed].sort());   // the link stays
    await expectPgError(setOffices("client", w.clientA2, closed), "OGV22", /active office/);   // not for a new assignment
    expect(await setOffices("client", w.clientA1, temecula, [closed, moreno])).toBe("set");   // an existing link can stay while another is added
    expect(await setOffices("client", w.clientA1, temecula, [moreno])).toBe("set");   // and the affected person can be reassigned
    await call(w.ownerA, "select ogevia_api.reactivate_office($1,$2)", [w.orgA, closed]);
    expect(await setOffices("client", w.clientA2, closed)).toBe("set");
    expect((await audits(closed, "office.reactivated"))).toHaveLength(1);
  });
});

describe("service counties and caregiver colour", () => {
  it("a client has one service county, a caregiver any number; independent of offices; refused for a non-county", async () => {
    expect((await call(w.managerA, "select ogevia_api.set_client_service_county($1,$2,'San Bernardino') as r", [w.orgA, w.clientA1]))[0].r).toBe("set");
    expect((await call(w.managerA, "select ogevia_api.set_client_service_county($1,$2,'san bernardino county') as r", [w.orgA, w.clientA1]))[0].r).toBe("unchanged");
    await expectPgError(call(w.managerA, "select ogevia_api.set_client_service_county($1,$2,'Gotham')", [w.orgA, w.clientA1]), "OGV22", /California county/);
    expect((await call(w.managerA, "select ogevia_api.set_caregiver_service_counties($1,$2,'{riverside,\"San Diego\",riverside}') as r", [w.orgA, cgB]))[0].r).toBe("set");
    expect((await q("select county from ogevia.caregiver_service_counties where caregiver_record_id = $1 order by 1", [cgB])).map((x) => x.county)).toEqual(["Riverside", "San Diego"]);
    expect((await call(w.managerA, "select ogevia_api.set_caregiver_service_counties($1,$2,'{}') as r", [w.orgA, cgB]))[0].r).toBe("set");   // cleared
    await call(w.managerA, "select ogevia_api.set_caregiver_service_counties($1,$2,'{Riverside,\"San Diego\"}')", [w.orgA, cgB]);
    expect(await assigned("caregiver", cgB)).toEqual([]);   // no office was implied by the counties
    expect((await audits(cgB, "caregiver.service_counties_set")).length).toBe(3);
    await expectPgError(call(w.caregiverA1, "select ogevia_api.set_caregiver_service_counties($1,$2,'{Riverside}')", [w.orgA, cgB]), "OGA03", /permission/);
  });
  it("red, yellow, blue (and the other named colours) save and clear; anything else is refused; audited", async () => {
    for (const c of ["red", "yellow", "blue", "green", "purple", "orange", "teal", "gray"]) {
      expect((await call(w.managerA, "select ogevia_api.set_caregiver_color($1,$2,$3) as r", [w.orgA, cgA, c]))[0].r).toBe("set");
      expect((await q("select profile_color from ogevia.caregiver_records where id = $1", [cgA]))[0].profile_color).toBe(c);
    }
    expect((await call(w.managerA, "select ogevia_api.set_caregiver_color($1,$2,' YELLOW ') as r", [w.orgA, cgA]))[0].r).toBe("set");
    expect((await call(w.managerA, "select ogevia_api.set_caregiver_color($1,$2,'yellow') as r", [w.orgA, cgA]))[0].r).toBe("unchanged");
    await expectPgError(call(w.managerA, "select ogevia_api.set_caregiver_color($1,$2,'#ff0000')", [w.orgA, cgA]), "OGV22", /listed colors/);
    expect((await audits(cgA, "caregiver.color_set")).length).toBeGreaterThanOrEqual(9);
    expect((await call(w.managerA, "select ogevia_api.set_caregiver_color($1,$2,null) as r", [w.orgA, cgA]))[0].r).toBe("cleared");
    await call(w.managerA, "select ogevia_api.set_caregiver_color($1,$2,'blue')", [w.orgA, cgA]);
    await expectPgError(call(w.managerA, "select ogevia_api.set_caregiver_color($1,$2,'red')", [w.orgA, cgOrgB]), "OGN04", /Caregiver not found/);
  });
});

describe("the facets read and the counts", () => {
  it("returns codes, office links (primary flagged), counties and colours for the agency only; a caregiver and another agency are refused; counts match", async () => {
    await setOffices("caregiver", cgA, temecula, [moreno]);
    const f = await facets();
    const mine = f.caregiverOffices.filter((x: any) => x.caregiverRecordId === cgA);
    expect(mine.map((x: any) => [x.officeId, x.isPrimary])).toEqual([[temecula, true], [moreno, false]]);
    expect(f.caregiverOffices.every((x: any) => x.caregiverCode.startsWith("CG-SYN-"))).toBe(true);
    expect(f.caregiverCounties.filter((x: any) => x.caregiverRecordId === cgB).map((x: any) => x.county).sort()).toEqual(["Riverside", "San Diego"]);
    expect(f.clientCounties).toEqual([{ clientId: w.clientA1, county: "San Bernardino" }]);
    expect(f.caregiverColors).toEqual([{ caregiverRecordId: cgA, userId: null, color: "blue" }]);
    expect(JSON.stringify(f)).not.toContain("cgOrgB"); expect(JSON.stringify(f)).not.toContain(cgOrgB);
    await expectPgError(facets(w.caregiverA1), "OGA03", /permission/);
    await expectPgError(facets(w.managerB, w.orgA), "OGN04", /Organization not found/);
    const list = await call(w.managerA, "select * from ogevia_api.list_offices($1)", [w.orgA]);
    expect(list.find((o: any) => o.office_id === temecula)).toMatchObject({ caregiver_count: 1 });
    expect(list.find((o: any) => o.office_id === moreno).client_count).toBeGreaterThanOrEqual(1);
  });
});

describe("rollback", () => {
  it("removes the new data, keeps every client's primary office and the 0110 functions working, and the migration can be applied again", async () => {
    const primaryBefore = (await q("select id, responsible_office_id from ogevia.clients where responsible_office_id is not null order by id")) as any[];
    await run(DOWN);
    expect((await q("select count(*)::int n from information_schema.tables where table_schema = 'ogevia' and table_name in ('office_assignments', 'caregiver_service_counties')"))[0].n).toBe(0);
    expect((await q("select id, responsible_office_id from ogevia.clients where responsible_office_id is not null order by id"))).toEqual(primaryBefore);
    expect((await call(w.managerA, "select * from ogevia_api.list_offices($1)", [w.orgA])).every((o: any) => !("address_line1" in o))).toBe(true);
    expect((await call(w.managerA, "select ogevia_api.set_client_office($1,$2,$3) as r", [w.orgA, w.clientA1, temecula]))[0].r).toMatch(/set|unchanged/);
    await run(UP);
    expect((await q("select count(*)::int n from ogevia.office_assignments where client_id is not null and is_primary"))[0].n).toBeGreaterThanOrEqual(2);   // the backfill ran again from the kept primary offices
  });

  it("the web county list is exactly the database list (same spelling, same order)", async () => {
    const ts = readFileSync(new URL("../../../../apps/web/src/aws/ca-counties.ts", import.meta.url), "utf8");
    const web = [...ts.slice(ts.indexOf("[")).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const dbList = (await q("select unnest(ogevia.california_counties()) c")).map((r: { c: string }) => r.c);
    expect(web).toEqual(dbList);
  });

  it("0112: who changed an assignment and when (newest first, with before and after), for one client or caregiver only", async () => {
    await setOffices("client", w.clientA1, corona, [temecula]);
    await setOffices("client", w.clientA1, temecula, [corona]);
    await call(w.managerA, "select ogevia_api.set_client_service_county($1,$2,'Riverside')", [w.orgA, w.clientA1]);
    await setOffices("caregiver", cgA, moreno, [temecula]);
    await call(w.managerA, "select ogevia_api.set_caregiver_color($1,$2,'yellow')", [w.orgA, cgA]);
    const h = await call<any>(w.managerA, "select * from ogevia_api.list_assignment_history($1,'client',$2,50)", [w.orgA, w.clientA1]);
    expect(h.slice(0, 3).map((r: any) => r.action)).toEqual(["client.service_county_set", "client.offices_set", "client.offices_set"]);   // newest first (earlier tests also changed this client)
    expect(h[1].before_state.primary).toBe(corona); expect(h[1].after_state.primary).toBe(temecula);   // the primary office change, with both values
    expect(h.every((r: any) => r.actor_name !== undefined && r.occurred_at)).toBe(true);
    expect(h.some((r: any) => r.action.startsWith("caregiver"))).toBe(false);
    const c = await call<any>(w.managerA, "select * from ogevia_api.list_assignment_history($1,'caregiver',$2,50)", [w.orgA, cgA]);
    expect(c.slice(0, 2).map((r: any) => r.action)).toEqual(["caregiver.color_set", "caregiver.offices_set"]);
    expect(c[0].after_state.color).toBe("yellow");
    expect((await call<any>(w.managerA, "select * from ogevia_api.list_assignment_history($1,'caregiver',$2,50)", [w.orgA, cgB])).every((r: any) => r.action.startsWith("caregiver."))).toBe(true);
  });
  it("0112: permission and tenant checks; rollback drops only the function", async () => {
    await expectPgError(call(w.managerB, "select * from ogevia_api.list_assignment_history($1,'client',$2,50)", [w.orgA, w.clientA1]), "OGN04", /Organization not found/);
    await expectPgError(call(w.managerA, "select * from ogevia_api.list_assignment_history($1,'client',$2,50)", [w.orgA, w.clientB1]), "OGN04", /Record not found/);
    await expectPgError(call(w.managerA, "select * from ogevia_api.list_assignment_history($1,'staff',$2,50)", [w.orgA, w.clientA1]), "OGV22", /Unknown record type/);
    const n = (await q("select count(*)::int n from ogevia.audit_events where entity_id = $1", [w.clientA1]))[0].n;
    await run(DOWN0112);
    expect((await q("select to_regprocedure('ogevia_api.list_assignment_history(uuid,text,uuid,integer)') as f"))[0].f).toBeNull();
    expect((await q("select count(*)::int n from ogevia.audit_events where entity_id = $1", [w.clientA1]))[0].n).toBe(n);   // the audit events stay
    await run(UP0112);
  });
});
