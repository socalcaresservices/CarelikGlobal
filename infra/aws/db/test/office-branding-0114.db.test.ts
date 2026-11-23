// 0114 (PENDING): office branding for invitation emails. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const U = (n: string) => new URL(`../pending/migrations/${n}`, import.meta.url);
let db: TestDb; let w: World; let office: string; let other: string; let cg: string;
const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const set = (a: Actor, o: string, color: string | null, logo: string | null, mail: string | null) => call(a, "select ogevia_api.set_office_branding($1,$2,$3,$4,$5) as r", [w.orgA, o, color, logo, mail]).then((r) => r[0].r);

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1400);
  for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql", "0114_office_branding.sql"]) await run(U(f));
  office = await call(w.ownerA, "select ogevia_api.create_office($1,'Temecula Office',null) as id", [w.orgA]).then((r) => r[0].id);
  other = await call(w.ownerA, "select ogevia_api.create_office($1,'Corona Office',null) as id", [w.orgA]).then((r) => r[0].id);
  cg = (await db.admin.query("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1,'CG-BR-1','Syn','One','active') returning id", [w.orgA])).rows[0].id;
}, 120_000);
afterAll(async () => db?.drop());

describe("office branding", () => {
  it("only the Administrator sets it; values are validated; the change is audited with before and after", async () => {
    await expectPgError(set(w.managerA, office, "#112233", null, null), "OGA03");
    await expectPgError(set(w.ownerA, office, "teal", null, null), "OGV22");
    await expectPgError(set(w.ownerA, office, null, "http://x.example/l.png", null), "OGV22");
    await expectPgError(set(w.ownerA, office, null, null, "nope"), "OGV22");
    await expectPgError(set(w.ownerA, "00000000-0000-4000-8000-000000000000", "#112233", null, null), "OGN04");
    expect(await set(w.ownerA, office, "#112233", "https://cdn.example.invalid/t.png", "help@example.invalid")).toEqual({ accentColor: "#112233", logoUrl: "https://cdn.example.invalid/t.png", supportEmail: "help@example.invalid" });
    await set(w.ownerA, office, "#445566", null, null);
    const a = (await db.admin.query("select before_state, after_state from ogevia.audit_events where action = 'office_branding.changed' and entity_id = $1 order by occurred_at", [office])).rows;
    expect(a).toHaveLength(2); expect(a[1].before_state).toMatchObject({ accentColor: "#112233" }); expect(a[1].after_state).toMatchObject({ accentColor: "#445566", logoUrl: null });
  });
  it("lists the active offices with their look; a caregiver cannot list; another agency cannot touch it", async () => {
    const l = await call(w.managerA, "select * from ogevia_api.list_office_branding($1)", [w.orgA]);
    expect(l.find((r) => r.office_id === office)).toMatchObject({ office_name: "Temecula Office", accent_color: "#445566" });
    expect(l.find((r) => r.office_id === other)).toMatchObject({ accent_color: null });
    await expectPgError(call(w.caregiverA1, "select * from ogevia_api.list_office_branding($1)", [w.orgA]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.set_office_branding($1,$2,'#112233',null,null)", [w.orgA, office]), "OGN04");
  });
  it("the invitation look is the caregiver's PRIMARY office (name plus branding); none when unassigned; clearing every field removes the row", async () => {
    expect(await call(w.managerA, "select ogevia_api.get_invitation_look($1,$2) as r", [w.orgA, cg]).then((r) => r[0].r)).toEqual({});
    await call(w.managerA, "select ogevia_api.set_person_offices($1,'caregiver',$2,$3,$4::uuid[])", [w.orgA, cg, office, [other]]);
    expect(await call(w.managerA, "select ogevia_api.get_invitation_look($1,$2) as r", [w.orgA, cg]).then((r) => r[0].r)).toEqual({ officeName: "Temecula Office", officeColor: "#445566" });
    await set(w.ownerA, office, null, null, null);
    expect(await call(w.managerA, "select ogevia_api.get_invitation_look($1,$2) as r", [w.orgA, cg]).then((r) => r[0].r)).toEqual({ officeName: "Temecula Office" });
    expect(Number((await db.admin.query("select count(*) n from ogevia.office_branding where office_id = $1", [office])).rows[0].n)).toBe(0);
    await expectPgError(call(w.caregiverA1, "select ogevia_api.get_invitation_look($1,$2)", [w.orgA, cg]), "OGA03");
  });
  it("rollback drops the table and functions", async () => {
    await run(new URL("../pending/rollback/0114_office_branding.down.sql", import.meta.url));
    expect(Number((await db.admin.query("select count(*) n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'ogevia_api' and p.proname in ('set_office_branding','get_invitation_look')")).rows[0].n)).toBe(0);
  });
});
