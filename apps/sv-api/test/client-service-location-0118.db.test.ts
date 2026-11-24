// 0118: the client's service address, service county and coordinating office read and saved together. Real disposable PostgreSQL, SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, type TestDb, type World } from "../../../infra/aws/db/test/harness";

let db: TestDb; let w: World; let today: string; let temecula: string; let murrieta: string; const rec: Record<string, string> = {};
let winchester: string; let gap: string; let differ: string; let noZip: string;
const P = (f: string) => readFileSync(new URL(`../../../infra/aws/db/pending/${f}`, import.meta.url), "utf8");
async function run(sql: string) {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(sql); await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
const as = <T>(a: { sub: string }, fn: (c: any) => Promise<T>) => asActor(db, a.sub, fn);
const get = (a: { sub: string }, client: string) => as(a, async (c) => (await c.query("select ogevia_api.get_client_service_location($1,$2) as r", [w.orgA, client])).rows[0].r);
const save = (a: { sub: string }, client: string, city: string, zip: string, county: string | null, office: string | null) =>
  as(a, async (c) => (await c.query("select ogevia_api.set_client_service_location($1,$2,$3,$4,$5,$6) as r", [w.orgA, client, city, zip, county, office])).rows[0].r);
const mk = async () => (await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 })).client as string;

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true }); w = await seedWorld(db, 1180); today = await orgToday(db);
  for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql", "0113_notifications.sql", "0117_open_shift_sms.sql"]) await run(P(`migrations/${f}`));
  for (const r of await q("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])) rec[r.caregiver_code] = r.id;
  temecula = (await as(w.ownerA, async (c) => (await c.query("select ogevia_api.create_office($1,'Temecula Office',null) as id", [w.orgA])).rows[0].id)) as string;
  murrieta = (await as(w.ownerA, async (c) => (await c.query("select ogevia_api.create_office($1,'Murrieta Office',null) as id", [w.orgA])).rows[0].id)) as string;
  // the state BEFORE 0118: Winchester only as the service address (the Details city is empty); another client whose two cities differ; one with no ZIP
  winchester = await mk(); gap = await mk(); differ = await mk(); noZip = await mk();
  await q("update ogevia.clients set city = null where id = any($1::uuid[])", [[winchester, gap]]);
  await q("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596','Winchester',$3),($1,$4,'92596','Winchester',$3),($1,$5,'92596','Winchester',$3)", [w.orgA, winchester, w.managerA.userId, gap, differ]);
  await q("update ogevia.clients set city = 'Murrieta' where id = $1", [differ]);
  await q("update ogevia.clients set city = 'Hemet' where id = $1", [noZip]);
  await run(P("migrations/0118_client_service_location.sql"));
}, 180_000);
afterAll(async () => db?.drop());

describe("0118 service location", () => {
  it("existing values are preserved; only an EMPTY Details city is filled from the service address once", async () => {
    expect((await q("select city from ogevia.clients where id = $1", [winchester]))[0].city).toBe("Winchester");        // was empty: filled
    expect((await q("select city from ogevia.clients where id = $1", [gap]))[0].city).toBe("Winchester");
    expect((await q("select city from ogevia.clients where id = $1", [differ]))[0].city).toBe("Murrieta");              // differed: NOT overwritten
    expect((await q("select city from ogevia.clients where id = $1", [noZip]))[0].city).toBe("Hemet");
    expect((await q("select zip, city from ogevia.client_service_zip where client_id = $1", [differ]))[0]).toEqual({ zip: "92596", city: "Winchester" });
  });
  it("reads city, ZIP, county, office together and says exactly what is missing", async () => {
    const r = await get(w.managerA, winchester);
    expect(r).toMatchObject({ city: "Winchester", zip: "92596", state: "CA", county: null, office: null, complete: true, missing: [] });
    const incomplete = await get(w.managerA, noZip);
    expect(incomplete).toMatchObject({ city: "Hemet", zip: null, complete: false, missing: ["zip"] });      // the city exists, the ZIP does not: the missing part is named, nothing is guessed
    const none = await mk(); await q("update ogevia.clients set city = null where id = $1", [none]);
    expect((await get(w.managerA, none)).missing).toEqual(["city", "zip"]);
  });
  it("one save writes the service address, the county (as 'Riverside County' or 'Riverside') and the coordinating office, with one audit row that holds no address", async () => {
    const r = await save(w.managerA, winchester, "Winchester", "92596", "Riverside County", temecula);
    expect(r).toMatchObject({ city: "Winchester", zip: "92596", county: "Riverside", complete: true, office: { officeId: temecula, name: "Temecula Office" } });
    expect((await q("select responsible_office_id, service_county, city from ogevia.clients where id = $1", [winchester]))[0]).toEqual({ responsible_office_id: temecula, service_county: "Riverside", city: "Winchester" });
    const audit = await q("select action, before_state, after_state from ogevia.audit_events where organization_id = $1 and action = 'client.service_location_set' and entity_id = $2", [w.orgA, winchester]);
    expect(audit).toHaveLength(1); expect(JSON.stringify(audit)).not.toMatch(/92596|Winchester/);
    expect(audit[0].after_state.changed.sort()).toEqual(["county", "office"]);   // the address was already Winchester 92596: not reported as changed
    expect((await save(w.managerA, winchester, "Winchester", "92596", "Riverside", null)).office.officeId).toBe(temecula);   // a null office leaves the office as it is
    expect((await q("select count(*)::int n from ogevia.audit_events where organization_id = $1 and action = 'client.service_location_set' and entity_id = $2", [w.orgA, winchester]))[0].n).toBe(2);
  });
  it("changing the coordinating office keeps the client's other offices; a blank county clears it; the Details city follows the service city", async () => {
    await as(w.managerA, async (c) => c.query("select ogevia_api.set_person_offices($1,'client',$2,$3,$4::uuid[])", [w.orgA, gap, temecula, [murrieta]]));
    const r = await save(w.managerA, gap, "Winchester", "92596", "", murrieta);
    expect(r.office.officeId).toBe(murrieta); expect(r.otherOffices.map((o: any) => o.officeId)).toEqual([temecula]); expect(r.county).toBeNull();
    await save(w.managerA, differ, "Winchester", "92596", null, null);
    expect((await q("select city from ogevia.clients where id = $1", [differ]))[0].city).toBe("Winchester");               // the next save aligns the two
    await q("update ogevia.client_service_zip set city = 'Temecula' where client_id = $1", [differ]);
    expect((await q("select city from ogevia.clients where id = $1", [differ]))[0].city).toBe("Temecula");                 // and any later change of the service city carries over
  });
  it("is refused for those who may not manage clients, for another agency, and for bad input", async () => {
    await expect(get(w.caregiverA1, winchester)).rejects.toThrow(/permission/i);
    await expect(save(w.schedulerA, winchester, "Winchester", "92596", null, null)).rejects.toThrow(/permission/i);
    await expect(get(w.managerB, winchester)).rejects.toThrow();
    await expect(save(w.managerB, winchester, "X", "92596", null, null)).rejects.toThrow();
    await expect(save(w.managerA, winchester, "", "92596", null, null)).rejects.toThrow(/city/);
    await expect(save(w.managerA, winchester, "Winchester", "9259", null, null)).rejects.toThrow(/ZIP/);
    await expect(save(w.managerA, winchester, "Winchester", "92596", "Narnia", null)).rejects.toThrow(/California county/);
    await expect(save(w.managerA, winchester, "Winchester", "92596", null, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/active office/);
  });
  it("suggests the county from the agency's own records, or from a loaded ZIP reference (which wins); staff still choose", async () => {
    const fresh = await mk(); await q("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596','Winchester',$3)", [w.orgA, fresh, w.managerA.userId]);
    expect((await get(w.managerA, fresh)).countySuggestion).toEqual({ county: "Riverside", basis: "agency_clients" });     // the Winchester client above is in Riverside
    await q("insert into ogevia.zip_county_reference (zip, county, source, licence, vintage) values ('92596','Riverside','Synthetic test list','test only','2026')");
    expect((await get(w.managerA, fresh)).countySuggestion).toEqual({ county: "Riverside", basis: "zip_reference" });
    expect((await get(w.managerA, winchester)).countySuggestion).toBeNull();                                               // a county is already chosen: no suggestion
    await q("delete from ogevia.zip_county_reference");
    expect((await get(w.managerA, noZip)).countySuggestion).toBeNull();                                                    // no ZIP, no suggestion
  });
  it("matching and alerts use Winchester while the client's coordinating office handles the request (no per-shift office needed)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 });
    for (const u of [w.caregiverA2]) await q("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, u.userId, f.client, f.service, today]);
    await save(w.managerA, f.client, "Winchester", "92596", "Riverside", temecula);
    for (const code of ["CG-A1", "CG-A2"]) await as(w.managerA, async (c) => c.query("select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [w.orgA, rec[code], temecula]));
    await as(w.ownerA, async (c) => c.query("select ogevia_api.set_cover_notification_settings($1,true,false,false,72,50,'office','Open shift in {city} | {date} | {time}','test')", [w.orgA]));
    const d = new Date(Date.parse(`${today}T12:00:00Z`) + 2 * 864e5).toISOString().slice(0, 10);
    const shift = (await as(w.managerA, async (c) => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'11:50'::time,null,null)", [w.orgA, f.client, f.service, d])).rows[0].shift_id)) as string;
    expect((await q("select coordinating_office_id from ogevia.shifts where id = $1", [shift]))[0].coordinating_office_id).toBeNull();
    const r = (await q("select ogevia.cover_notify($1,$2,null,null) as r", [w.orgA, shift]))[0].r;
    expect(r).toMatchObject({ state: "done", serviceCity: "Winchester", office: "Temecula Office" });                      // two offices exist, yet nobody had to choose
    expect(r.subject).toMatch(/^Open shift in Winchester \| /);
    const board = await as(w.caregiverA2, async (c) => (await c.query("select * from ogevia_api.list_open_shifts($1)", [w.orgA])).rows);
    expect(board.find((x: any) => x.shift_id === shift)).toMatchObject({ city: "Winchester", office_name: "Temecula Office" });
    // a shift's own choice still wins over the client's office
    await q("update ogevia.shifts set coordinating_office_id = $2 where id = $1", [shift, murrieta]);
    expect((await q("select ogevia.cover_office_for($1, s) as o from ogevia.shifts s where s.id = $2", [w.orgA, shift]))[0].o).toBe(murrieta);
  });
  it("rollback: down restores the 0117 office rule and drops the new objects; the stored values stay; up again works", async () => {
    await run(P("rollback/0118_client_service_location.down.sql"));
    expect((await q("select to_regprocedure('ogevia_api.get_client_service_location(uuid,uuid)') as p"))[0].p).toBeNull();
    expect((await q("select count(*)::int n from pg_trigger where tgname = 'client_service_zip_sync_city'"))[0].n).toBe(0);
    expect((await q("select service_county, responsible_office_id from ogevia.clients where id = $1", [winchester]))[0]).toEqual({ service_county: "Riverside", responsible_office_id: temecula });
    await run(P("migrations/0118_client_service_location.sql"));
    expect((await q("select to_regprocedure('ogevia_api.get_client_service_location(uuid,uuid)') as p"))[0].p).not.toBeNull();
  });
});
