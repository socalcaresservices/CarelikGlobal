// 0121 (PENDING): one email, one person, within an agency. SYNTHETIC data only.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const P = (n: string) => new URL(`../pending/${n}`, import.meta.url);
let db: TestDb; let w: World; let typeA: string; const rec: Record<string, string> = {};
const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows as any[];
const setContact = (code: string, email: string, org = w.orgA, a: Actor = w.ownerA) => call(a, "select ogevia_api.set_caregiver_contact($1,$2,$3) as r", [org, rec[code], email]);
const MSG = /already used by someone else in this agency/;
let n = 0;
const staff = async (email: string | null, login: string | null = null) => {
  n++;
  return (await q("insert into ogevia.staff_profiles (organization_id, staff_type_id, display_name, contact_email, login_email, status) values ($1,$2,$3,$4,$5,'active') returning id", [w.orgA, typeA, `Staff ${n} (synthetic)`, email, login]))[0].id as string;
};

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1300);
  typeA = (await call(w.ownerA, "select ogevia_api.create_staff_type($1,'Scheduler (synthetic)') as id", [w.orgA]))[0].id;
  for (const r of await q("select id, caregiver_code from ogevia.caregiver_records where organization_id in ($1,$2)", [w.orgA, w.orgB])) rec[r.caregiver_code] = r.id;
  await run(P("migrations/0121_one_email_one_person.sql"));
}, 120_000);
afterAll(async () => db?.drop());

describe("a caregiver's contact email", () => {
  it("is refused when it is a staff member's contact or sign-in address, in any letter case, and the message never names the other person", async () => {
    await staff("admin-one@example.invalid", "admin-login@example.invalid");
    await expectPgError(setContact("CG-A1", "Admin-One@Example.invalid"), "OGC09", MSG);
    await expectPgError(setContact("CG-A1", "admin-login@example.invalid"), "OGC09", MSG);
  });
  it("is refused when another caregiver already has it as contact or has an invitation at it; the caregiver's own address can be saved again", async () => {
    await setContact("CG-A1", "one@example.invalid");
    await expectPgError(setContact("CG-A2", "ONE@example.invalid"), "OGC09", MSG);
    await setContact("CG-A1", "one@example.invalid");
    await q("insert into ogevia.caregiver_invitations (organization_id, caregiver_record_id, user_id, email, existing_account, invited_by) values ($1,$2,$3,'invited@example.invalid',false,$4)", [w.orgA, rec["CG-A1"], w.caregiverA1.userId, w.ownerA.userId]);
    await expectPgError(setContact("CG-A2", "invited@example.invalid"), "OGC09", MSG);
  });
  it("a new, unused address is accepted, and the same address in ANOTHER agency is not a conflict", async () => {
    await setContact("CG-A2", "fresh@example.invalid");
    const other = Object.keys(rec).find((k) => k.startsWith("CG-B"));
    if (other) await setContact(other, "fresh@example.invalid", w.orgB, w.managerB);
  });
});

describe("staff emails and invitations", () => {
  it("creating or changing a staff member to a caregiver's address is refused; an unchanged own address is fine", async () => {
    await expectPgError(call(w.ownerA, "select ogevia_api.create_staff($1,'New Person (synthetic)',$2,'fresh@example.invalid',null)", [w.orgA, typeA]), "OGC09", MSG);
    const s = await staff("mine@example.invalid");
    await expectPgError(call(w.ownerA, "select ogevia_api.update_staff($1,$2,'Staff (synthetic)',$3,'fresh@example.invalid',null,'active')", [w.orgA, s, typeA]), "OGC09", MSG);
    await call(w.ownerA, "select ogevia_api.update_staff($1,$2,'Staff Renamed (synthetic)',$3,'mine@example.invalid',null,'active')", [w.orgA, s, typeA]);
  });
  it("inviting a staff member at a caregiver's contact address, or a caregiver at a staff address, is refused", async () => {
    const s = await staff(null);
    await expectPgError(call(w.ownerA, "select ogevia_api.begin_staff_invitation($1,$2,'fresh@example.invalid','manager')", [w.orgA, s]), "OGC09", MSG);
    await staff("boss@example.invalid");
    const fresh = (await q("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name) values ($1,'CG-NEW','Synthetic','New') returning id", [w.orgA]))[0].id as string;
    await expectPgError(call(w.ownerA, "select ogevia_api.begin_caregiver_invitation($1,$2,'boss@example.invalid')", [w.orgA, fresh]), "OGC09", MSG);
    expect((await call(w.ownerA, "select ogevia_api.begin_caregiver_invitation($1,$2,'unused@example.invalid') as r", [w.orgA, fresh]))[0].r).toBe("unused@example.invalid");
  });
});

const TC = (f: string) => new URL(`../../../../docs/releases/2026-11-20-test-plan/toolchain/${f}`, import.meta.url).pathname;
const psql = (args: string[]) => spawnSync("psql", ["-X", "-At", "-F", "|", ...args, `postgres://postgres@127.0.0.1:5432/${db.name}`], { encoding: "utf8" });

describe("deployment checks", () => {
  it("VERIFY_PENDING passes when present (only the ledger row is missing in a test database) and CHECK_DUPLICATE_EMAILS lists a pre-existing shared address, masked", async () => {
    const pres = psql(["-v", "mig=0121", "-v", "expect=present", "-f", TC("VERIFY_PENDING.sql")]);
    expect(pres.stderr).toBe("");
    expect(pres.stdout.split("\n").filter((l) => l.includes("|f|"))).toEqual(["ledger row 0121 present|f|"]);
    await q("insert into ogevia.staff_profiles (organization_id, staff_type_id, display_name, contact_email, status) values ($1,$2,'Dup One (synthetic)','shared@example.invalid','active'), ($1,$2,'Dup Two (synthetic)','shared@example.invalid','active')", [w.orgA, typeA]);
    const dup = psql(["-f", TC("CHECK_DUPLICATE_EMAILS.sql")]);
    expect(dup.stderr).toBe("");
    expect(dup.stdout).toContain("s***@example.invalid|2|staff contact");
    expect(dup.stdout).not.toContain("shared@");
    await q("delete from ogevia.staff_profiles where contact_email = 'shared@example.invalid'");
  });
});

describe("rollback", () => {
  it("restores the previous behavior and removes the helper; nothing else changes", async () => {
    await run(P("rollback/0121_one_email_one_person.down.sql"));
    const absent = psql(["-v", "mig=0121", "-v", "expect=absent", "-f", TC("VERIFY_PENDING.sql")]);
    expect(absent.stdout.split("\n").filter((l) => l.includes("|f|"))).toEqual([]);
    expect((await q("select to_regprocedure('ogevia.email_used_by_other(uuid,text,uuid,uuid)') is null as gone"))[0].gone).toBe(true);
    await setContact("CG-A2", "boss@example.invalid");
  });
});
