// 0126 (PENDING): service address history. SYNTHETIC data only. One current home address per client; alternate and historical addresses are kept;
// a one-step switch; stickers of an address that is not current are refused at arrival; a wrong, never-used address can be deleted and its text is scrubbed.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, asActor, createHelperShift, createTestDb, expectPgError, freshClient, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const P = (f: string) => new URL(`../pending/migrations/${f}`, import.meta.url);
const DOWN = new URL("../pending/rollback/0126_service_address_history.down.sql", import.meta.url);
let db: TestDb; let w: World;
const run = async (url: URL) => { const c = await db.admin.connect(); try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => "OGL-" + Array.from(randomBytes(8)).map((b) => ALPHABET[b % ALPHABET.length]).join("");
const HOME = { lat: 34.0522, lng: -118.2437 };

async function register(n = 1) {
  const items = Array.from({ length: n }, () => { const token = randomBytes(32).toString("hex"); return { code: newCode(), token, hash: sha(token), sealed: "sealed:" + randomUUID() }; });
  await call(w.ownerA, "select ogevia_api.register_home_labels($1,$2::jsonb)", [w.orgA, JSON.stringify(items.map(({ code, hash, sealed }) => ({ code, hash, sealed })))]);
  return items;
}
const addHome = (client: string, street = "100 Synthetic Way", a: Actor = w.ownerA, org = w.orgA) =>
  call(a, "select ogevia_api.save_service_location($1,$2,null,'home','Client home',$3,'Synthetictown','CA','90001',$4,$5) as id", [org, client, street, HOME.lat, HOME.lng]).then((r) => r[0].id as string);
const addresses = (client: string, a: Actor = w.ownerA, org = w.orgA) => call(a, "select * from ogevia_api.list_client_service_addresses($1,$2)", [org, client]);
const setState = (loc: string, state: string, reason: string | null = "Test", a: Actor = w.ownerA, org = w.orgA) => call(a, "select ogevia_api.set_service_location_state($1,$2,$3,$4)", [org, loc, state, reason]);
const del = (loc: string, reason: string | null = "Entered by mistake", a: Actor = w.ownerA, org = w.orgA) => call(a, "select ogevia_api.delete_service_location($1,$2,$3)", [org, loc, reason]);
const history = (client: string, a: Actor = w.ownerA, org = w.orgA) => call(a, "select * from ogevia_api.list_service_location_history($1,$2)", [org, client]);
const assign = (code: string, loc: string) => call(w.ownerA, "select ogevia_api.assign_home_label($1,$2,$3,true,false) as id", [w.orgA, code, loc]).then((r) => r[0].id as string);
const punch = (a: Actor, hash: string, intent: "arrival" | "departure") =>
  call(a, "select ogevia_api.record_punch($1,null,$2,null,null,$3,$4,10,$5,false) as r", [hash, intent, HOME.lat, HOME.lng, randomUUID()]).then((r) => r[0].r as any);
const preview = (a: Actor, hash: string) => call(a, "select ogevia_api.preview_home_label($1) as r", [hash]).then((r) => r[0].r as any);
const current = (rows: any[]) => rows.filter((r) => r.is_current && r.kind === "home");
let dupClient = ""; let dupFirst = ""; let dupSecond = "";

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1500);
  for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql", "0124_nfc_qr_visit_verification.sql"]) await run(P(f));
  // BEFORE 0126: a client that already has two current home addresses (0124 allowed it)
  dupClient = (await freshClient(db, w, w.caregiverA1, 600)).client;
  dupFirst = await addHome(dupClient, "1 First St");
  dupSecond = await addHome(dupClient, "2 Second St");
  expect((await db.admin.query("select count(*)::int n from ogevia.client_service_locations where client_id = $1 and is_active", [dupClient])).rows[0].n).toBe(2);
  await run(P("0126_service_address_history.sql"));
}, 240_000);
afterAll(async () => db?.drop());

describe("0126 one current home address", () => {
  it("the migration kept the oldest address current and made the other an alternate, each recorded", async () => {
    const rows = await addresses(dupClient);
    expect(current(rows).map((r) => r.location_id)).toEqual([dupFirst]);
    expect(rows.find((r) => r.location_id === dupSecond)).toMatchObject({ address_state: "alternate", is_current: false });
    const h = await history(dupClient);
    expect(h.filter((e: any) => e.action === "made_alternate" && e.location_id === dupSecond)).toHaveLength(1);
    expect(h.filter((e: any) => e.action === "created")).toHaveLength(2);
  });

  it("a second home address added later is an alternate: it never becomes current by being typed in", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    const a = await addHome(f.client, "10 Parent One Rd"); const b = await addHome(f.client, "20 Parent Two Ave");
    const rows = await addresses(f.client);
    expect(current(rows).map((r) => r.location_id)).toEqual([a]);
    expect(rows.find((r) => r.location_id === b)).toMatchObject({ address_state: "alternate", is_current: false, can_delete: true });
    // the database itself refuses two current home addresses, whatever the caller does
    await expect(db.admin.query("update ogevia.client_service_locations set is_active = true, inactive_kind = null where id = $1", [b])).rejects.toThrow(/one_current_home|duplicate key/);
  });

  it("a community place is not limited to one", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    for (const n of ["Library", "Park"]) await call(w.ownerA, "select ogevia_api.save_service_location($1,$2,null,'community',$3,'1 Main St','Synthetictown','CA','90001',null,null)", [w.orgA, f.client, n]);
    expect((await addresses(f.client)).filter((r) => r.kind === "community" && r.is_current)).toHaveLength(2);
  });
});

describe("0126 switching and states", () => {
  it("one step switches the current address; the old one becomes an alternate; there is never a moment with two or none through the switch", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    const a = await addHome(f.client, "10 Parent One Rd"); const b = await addHome(f.client, "20 Parent Two Ave");
    await setState(b, "active", "Week with parent two");
    const rows = await addresses(f.client);
    expect(current(rows).map((r) => r.location_id)).toEqual([b]);
    expect(rows.find((r) => r.location_id === a)).toMatchObject({ address_state: "alternate" });
    await setState(a, "active", null);
    expect(current(await addresses(f.client)).map((r) => r.location_id)).toEqual([a]);
    const acts = (await history(f.client)).map((e: any) => e.action);
    expect(acts).toEqual(expect.arrayContaining(["activated", "made_alternate", "created"]));
    // asking for what is already true changes nothing and records nothing new
    const before = (await history(f.client)).length; await setState(a, "active", null); expect((await history(f.client)).length).toBe(before);
  });

  it("marking inactive needs a reason; historical turns the address sticker off; the record stays and can be made current again", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    const a = await addHome(f.client, "10 Old Place"); const b = await addHome(f.client, "20 New Place");
    const [lab] = await register(); await assign(lab!.code, a);
    await expectPgError(setState(a, "historical", null), "OGV22", /reason/i);
    await setState(b, "active", "Moved");
    await setState(a, "historical", "Moved out");
    expect(await addresses(f.client).then((r) => r.find((x) => x.location_id === a))).toMatchObject({ address_state: "historical", label_id: null, can_delete: false });
    expect((await db.admin.query("select status, sealed_token from ogevia.home_labels where label_code = $1", [lab!.code])).rows[0]).toEqual({ status: "disabled", sealed_token: null });
    // a historical address cannot take a new sticker, but an alternate can
    const [lab2] = await register();
    await expectPgError(assign(lab2!.code, a), "OGN04");
    const c = await addHome(f.client, "30 Other Place"); await assign(lab2!.code, c);
    await setState(a, "active", "Back again");
    expect(current(await addresses(f.client)).map((r) => r.location_id)).toEqual([a]);
  });

  it("only staff who manage clients can change states; another agency cannot see or change them", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    const a = await addHome(f.client); const b = await addHome(f.client, "20 Second Ave");
    await expectPgError(setState(b, "active", "x", w.caregiverA1), "OGA03");
    await expectPgError(del(b, "x", w.caregiverA1), "OGA03");
    await expectPgError(setState(b, "active", "x", w.managerB, w.orgA), "OGA03");
    await expectPgError(addresses(f.client, w.managerB, w.orgA), "OGN04");
    await expectPgError(history(f.client, w.caregiverA1), "OGN04");
    await expectPgError(setState(a, "bogus", "x"), "OGV22");
    expect(current(await addresses(f.client)).map((r) => r.location_id)).toEqual([a]);
  });
});

describe("0126 stickers on addresses that are not current", () => {
  async function pair(cg: Actor = w.caregiverA1) {
    await db.admin.query("update ogevia.shifts set status = 'cancelled' where caregiver_user_id = $1 and status = 'scheduled'", [cg.userId]);
    const f = await freshClient(db, w, cg, 600);
    const a = await addHome(f.client, "10 Parent One Rd"); const b = await addHome(f.client, "20 Parent Two Ave");
    const [la, lb] = await register(2);
    await assign(la!.code, a); await assign(lb!.code, b);              // the alternate's sticker is assigned IN ADVANCE
    await createHelperShift(db, w.orgA, cg.userId, f.client, f.service);
    return { ...f, a, b, la: la!, lb: lb!, cg };
  }

  it("an arrival at the sticker of the alternate is refused with a plain reason and shows in Visit exceptions; the current address works; after a switch they swap", async () => {
    const s = await pair();
    expect(await preview(w.caregiverA1, sha(s.lb.token))).toMatchObject({ state: "blocked", reason: "address_not_current" });
    const refused = await punch(w.caregiverA1, sha(s.lb.token), "arrival");
    expect(refused).toMatchObject({ outcome: "not_saved", reason: "address_not_current" });
    expect(refused.message).toMatch(/not the current service address/);
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_exceptions where kind = 'failed_punch' and detail->>'reason' = 'address_not_current' and organization_id = $1 and client_id = $2", [w.orgA, s.client])).rows[0].n).toBeGreaterThan(0);
    expect((await db.admin.query("select count(*)::int n from ogevia.service_visits where client_id = $1", [s.client])).rows[0].n).toBe(0);
    // switch: parent two's home becomes current, parent one's sticker is now the refused one
    await setState(s.b, "active", "Switched");
    expect(await punch(w.caregiverA1, sha(s.la.token), "arrival")).toMatchObject({ outcome: "not_saved", reason: "address_not_current" });
    expect(await punch(w.caregiverA1, sha(s.lb.token), "arrival")).toMatchObject({ outcome: "saved" });
  });

  it("a departure is never blocked: a visit that began before a switch can still be ended at its sticker", async () => {
    const s = await pair(w.caregiverA2);
    const arr = await punch(w.caregiverA2, sha(s.la.token), "arrival");
    expect(arr).toMatchObject({ outcome: "saved" });
    await ageVisit(db, arr.visitId, 10);
    await setState(s.b, "active", "Switched during the visit");
    const dep = await punch(w.caregiverA2, sha(s.la.token), "departure");
    expect(dep, JSON.stringify(dep)).toMatchObject({ outcome: "saved" });
  });
});

describe("0126 delete an address entered by mistake, history and scrubbing", () => {
  it("a never-used home address is deleted; its text is scrubbed from the history, which still shows that it was deleted and why", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    const a = await addHome(f.client, "10 Right Place"); const wrong = await addHome(f.client, "999 Wrong Street");
    await call(w.ownerA, "select ogevia_api.save_service_location($1,$2,$3,'home','Client home','998 Wrong Street','Synthetictown','CA','90001',null,null)", [w.orgA, f.client, wrong]);
    await expectPgError(del(wrong, null), "OGV22", /reason/i);
    await del(wrong, "Typed the wrong street");
    expect((await addresses(f.client)).map((r) => r.location_id)).toEqual([a]);
    const h = await history(f.client);
    expect(JSON.stringify(h)).not.toMatch(/Wrong Street/);
    const ev = h.filter((e: any) => e.location_id === wrong);
    expect(ev.map((e: any) => e.action).sort()).toEqual(["created", "deleted", "updated"]);
    expect(ev.find((e: any) => e.action === "deleted")).toMatchObject({ reason: "Typed the wrong street" });
    expect(ev.filter((e: any) => e.action !== "deleted").every((e: any) => e.details.scrubbed === true)).toBe(true);
    // the surviving address history is untouched
    expect(JSON.stringify(h.filter((e: any) => e.location_id === a))).toContain("Synthetictown");
  });

  it("an address that has had a sticker cannot be deleted (history is kept); a community place cannot be deleted either", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    const a = await addHome(f.client); const [lab] = await register(); await assign(lab!.code, a);
    await expectPgError(del(a), "OGC09", /had a sticker/);
    const com = (await call(w.ownerA, "select ogevia_api.save_service_location($1,$2,null,'community','Park','1 Main St','Synthetictown','CA','90001',null,null) as id", [w.orgA, f.client]))[0].id as string;
    await expectPgError(del(com), "OGC09", /home address/);
    expect((await addresses(f.client)).map((r) => r.location_id).sort()).toEqual([a, com].sort());
  });

  it("an edit keeps the previous address in the history; the history cannot be edited or deleted by anyone", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    const a = await addHome(f.client, "10 Old Street");
    await call(w.ownerA, "select ogevia_api.save_service_location($1,$2,$3,'home','Client home','12 New Street','Synthetictown','CA','90001',null,null)", [w.orgA, f.client, a]);
    const upd = (await history(f.client)).find((e: any) => e.action === "updated")!;
    expect(upd.details.before).toMatchObject({ street: "10 Old Street" });
    await expect(db.admin.query("update ogevia.service_location_events set reason = 'x' where location_id = $1", [a])).rejects.toThrow(/append-only/);
    await expect(db.admin.query("delete from ogevia.service_location_events where location_id = $1", [a])).rejects.toThrow(/append-only/);
    await expect(db.admin.query("update ogevia.service_location_events set details = '{\"scrubbed\":true}' where location_id = $1", [a])).rejects.toThrow(/append-only/);
  });
});

describe("0126 rollback", () => {
  it("restores the 0124 functions exactly and removes what 0126 added; the addresses stay", async () => {
    const before = (await db.admin.query("select count(*)::int n from ogevia.client_service_locations")).rows[0].n;
    await run(DOWN);
    expect((await db.admin.query("select to_regclass('ogevia.service_location_events') a, to_regprocedure('ogevia_api.set_service_location_state(uuid,uuid,text,text)') b")).rows[0]).toEqual({ a: null, b: null });
    expect((await db.admin.query("select count(*)::int n from information_schema.columns where table_name = 'client_service_locations' and column_name like 'inactive%'")).rows[0].n).toBe(0);
    expect((await db.admin.query("select count(*)::int n from ogevia.client_service_locations")).rows[0].n).toBe(before);
    const def = (await db.admin.query("select pg_get_functiondef('ogevia_api.record_punch(text,uuid,text,uuid,uuid,numeric,numeric,integer,uuid,boolean)'::regprocedure) d")).rows[0].d as string;
    expect(def).not.toContain("address_not_current");
    await run(P("0126_service_address_history.sql"));                      // and it applies again
    expect((await db.admin.query("select pg_get_functiondef('ogevia_api.record_punch(text,uuid,text,uuid,uuid,numeric,numeric,integer,uuid,boolean)'::regprocedure) d")).rows[0].d).toContain("address_not_current");
  });
});
