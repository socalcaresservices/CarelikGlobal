// 0093 (PENDING, infra/aws/db/pending): R6 duplicate staff report (read-only) and merge-review. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const UP = new URL("../pending/migrations/0093_staff_duplicates.sql", import.meta.url);
const DOWN = new URL("../pending/rollback/0093_staff_duplicates.down.sql", import.meta.url);
let db: TestDb;
let w: World;
let type: string;

const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const staff = async (name: string, email: string | null = null, phone: string | null = null) =>
  (await call(w.ownerA, "select ogevia_api.create_staff($1,$2,$3,$4,$5) as id", [w.orgA, name, type, email, phone]))[0].id as string;
const report = () => call(w.ownerA, "select * from ogevia_api.list_possible_duplicate_staff($1)", [w.orgA]);
const merge = (keep: string, dup: string, reason = "Same person entered twice (synthetic)", a: Actor = w.ownerA, org = w.orgA) =>
  call(a, "select ogevia_api.merge_staff_profiles($1,$2,$3,$4) as r", [org, keep, dup, reason]).then((r) => r[0].r as string);
const status = async (id: string) => (await db.admin.query("select status from ogevia.staff_profiles where id = $1", [id])).rows[0].status as string;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 1200);
  await run(UP);
  type = (await call(w.ownerA, "select ogevia_api.create_staff_type($1,'Office (synthetic)') as id", [w.orgA]))[0].id;
});
afterAll(async () => db?.drop());

describe("0093 duplicate staff", () => {
  it("the report finds the same name and the same phone (digits), includes a caregiver of that name as not mergeable, and changes nothing", async () => {
    const a = await staff("Pat Twin"), b = await staff("pat  TWIN");
    const p1 = await staff("Quinn One", null, "(555) 010-7777"), p2 = await staff("Quinn Two", null, "555.010.7777".replace(/\./g, "-"));
    await staff("Solo Person", "solo@example.com");
    await call(w.managerA, "select * from ogevia_api.create_caregiver($1,'Pat','Twin',null,'onboarding',null)", [w.orgA]).catch(() => call(w.ownerA, "select * from ogevia_api.create_caregiver($1,'Pat','Twin',null,'onboarding',null)", [w.orgA]));
    const before = await db.admin.query("select count(*)::int n, max(updated_at) m from ogevia.staff_profiles where organization_id = $1", [w.orgA]);
    const r = await report();
    const names = r.filter((x) => x.match_basis === "name" && /pat twin/i.test(x.display_name));
    expect(names.length).toBe(3);                                       // two profiles and the caregiver
    expect(names.filter((x) => x.can_merge).map((x) => x.profile_id).sort()).toEqual([a, b].sort());
    expect(names.find((x) => x.source === "caregiver")?.can_merge).toBe(false);
    const phones = r.filter((x) => x.match_basis === "phone");
    expect(phones.map((x) => x.profile_id).sort()).toEqual([p1, p2].sort());
    expect(r.some((x) => /solo person/i.test(x.display_name))).toBe(false);
    const after = await db.admin.query("select count(*)::int n, max(updated_at) m from ogevia.staff_profiles where organization_id = $1", [w.orgA]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("merge: the duplicate becomes inactive and linked, with the reason in an append-only row and an audit event; it leaves the report; repeating is harmless", async () => {
    const keep = await staff("Rae Merge"), dup = await staff("rae merge");
    expect(await merge(keep, dup, "Entered twice by mistake (synthetic)")).toBe("merged");
    expect(await status(dup)).toBe("inactive");
    expect(await status(keep)).toBe("active");
    const link = (await db.admin.query("select match_basis, reason from ogevia.staff_merge_links where merged_profile_id = $1", [dup])).rows[0];
    expect(link).toEqual({ match_basis: "name", reason: "Entered twice by mistake (synthetic)" });
    const audit = await db.admin.query("select reason from ogevia.audit_events where action = 'staff.merged' and entity_id = $1", [dup]);
    expect(audit.rows).toHaveLength(1);
    expect((await report()).some((x) => /rae merge/i.test(x.display_name))).toBe(false);
    expect(await merge(keep, dup)).toBe("already_merged");
    await expect(db.admin.query("delete from ogevia.staff_merge_links where merged_profile_id = $1", [dup])).rejects.toThrow();
  });

  it("refusals: unrelated people, a record with an invitation or sign-in, the same record, a short reason, another agency's record, and a person without staff rights", async () => {
    const x = await staff("Una Unrelated"), y = await staff("Vic Different");
    await expectPgError(merge(x, y), "OGC09", /do not match/);
    const k = await staff("Wes Invited", "wes@example.com"), d = await staff("Wes Invited");
    await db.admin.query("update ogevia.staff_profiles set invited_at = now(), login_email = 'wes@example.com' where id = $1", [d]);
    await expectPgError(merge(k, d), "OGC09", /sign-in or an invitation/);
    await expectPgError(merge(x, x), "OGV22", /two different/);
    await expectPgError(merge(k, x, "no"), "OGV22", /reason/);
    const otherType = (await db.admin.query("insert into ogevia.staff_types (organization_id, name) values ($1,'Other agency type') returning id", [w.orgB])).rows[0].id;
    const foreign = (await db.admin.query("insert into ogevia.staff_profiles (organization_id, staff_type_id, display_name) values ($1,$2,'Una Unrelated') returning id", [w.orgB, otherType])).rows[0].id;
    await expectPgError(merge(x, foreign), "OGN04", /not found/);
    await expectPgError(merge(x, y, "A reason long enough", w.caregiverA1), "OGA03", /./);
    await expectPgError(call(w.caregiverA1, "select * from ogevia_api.list_possible_duplicate_staff($1)", [w.orgA]), "OGA03", /./);
    expect(await status(y)).toBe("active");
    expect(await status(foreign)).toBe("active");
  });

  it("the rollback removes the functions and the link table; merged profiles stay inactive", async () => {
    const keep = await staff("Sol Rollback"), dup = await staff("sol rollback");
    await merge(keep, dup);
    await run(DOWN);
    expect(await status(dup)).toBe("inactive");
    expect((await db.admin.query("select to_regclass('ogevia.staff_merge_links') r")).rows[0].r).toBeNull();
    void randomUUID;
  });
});
