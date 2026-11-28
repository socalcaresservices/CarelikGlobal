// 0116 (PENDING): duplicate staff merge hardening on top of 0106: preview, conflict resolution, snapshots, undo with protection, history. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const P = (n: string) => new URL(`../pending/${n}`, import.meta.url);
let db: TestDb; let w: World; let typeA: string; let typeB: string;
const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows as any[];
let n = 0;
async function person(name: string, opts: { email?: string | null; phone?: string | null; type?: string } = {}) {
  n++;
  return (await q("insert into ogevia.staff_profiles (organization_id, staff_type_id, display_name, contact_email, phone, status) values ($1,$2,$3,$4,$5,'active') returning id",
    [w.orgA, opts.type ?? typeA, name, opts.email ?? null, opts.phone ?? null]))[0].id as string;
}
const preview = (keep: string, dup: string, a: Actor = w.ownerA) => call(a, "select ogevia_api.preview_staff_merge($1,$2,$3) as r", [w.orgA, keep, dup]).then((r) => r[0].r);
const merge = (keep: string, dup: string, res: Record<string, string> = {}, reason = "Same person entered twice", a: Actor = w.ownerA) =>
  call(a, "select ogevia_api.merge_staff_profiles_v2($1,$2,$3,$4,$5::jsonb) as r", [w.orgA, keep, dup, reason, JSON.stringify(res)]).then((r) => r[0].r);
const unmerge = (link: string, reason = "Merged by mistake", a: Actor = w.ownerA) => call(a, "select ogevia_api.unmerge_staff_profiles($1,$2,$3) as r", [w.orgA, link, reason]).then((r) => r[0].r);
const row = async (id: string) => (await q("select display_name, staff_type_id, contact_email, phone, status from ogevia.staff_profiles where id = $1", [id]))[0];

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1000);
  await run(P("migrations/0105_bulk_import.sql")); await run(P("migrations/0106_staff_duplicates.sql")); await run(P("migrations/0116_staff_merge_hardening.sql"));
  typeA = (await call(w.ownerA, "select ogevia_api.create_staff_type($1,'Scheduler (synthetic)') as id", [w.orgA]))[0].id;
  typeB = (await call(w.ownerA, "select ogevia_api.create_staff_type($1,'Coordinator (synthetic)') as id", [w.orgA]))[0].id;
}, 120_000);
afterAll(async () => db?.drop());

describe("preview and conflict review", () => {
  it("shows both records, the match basis, conflicts (both filled, different), fills (blank on the kept record) and no blockers for a clean pair", async () => {
    const k = await person("Pat Sample", { email: "pat@example.invalid", phone: null });
    const d = await person("Pat Sample", { email: "pat@example.invalid", phone: "(555) 010-2222", type: typeB });
    const r = await preview(k, d);
    expect(r).toMatchObject({ matchBasis: "email", canMerge: true, blockers: [] });
    expect(r.conflicts).toEqual([{ field: "staff_type_id", keep: "Scheduler (synthetic)", duplicate: "Coordinator (synthetic)" }]);
    expect(r.fills).toEqual([{ field: "phone", value: "(555) 010-2222" }]);
  });
  it("names every blocker: no match, a sign-in, an inactive record, an earlier merge; a caregiver or another agency cannot preview", async () => {
    const a = await person("Alex One", { email: "alex1@example.invalid" }); const b = await person("Blair Two", { email: "blair@example.invalid" });
    expect((await preview(a, b)).blockers).toEqual(["These records do not match on email, phone or name, so they cannot be merged"]);
    const c = await person("Alex One", {}); await q("update ogevia.staff_profiles set invited_at = now(), login_email = 'x@example.invalid' where id = $1", [c]);
    expect((await preview(a, c)).blockers[0]).toMatch(/sign-in or an invitation/);
    await expectPgError(call(w.caregiverA1, "select ogevia_api.preview_staff_merge($1,$2,$3)", [w.orgA, a, b]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.preview_staff_merge($1,$2,$3)", [w.orgA, a, b]), "OGN04");
  });
});

describe("merge with conflict handling", () => {
  it("refuses until every conflict is resolved, then applies the choices, fills the blanks, stores the snapshot and audits the choices", async () => {
    const k = await person("Dana Sample", { email: "dana@example.invalid" });
    const d = await person("Dana Sample", { email: "dana@example.invalid", phone: "(555) 010-3333", type: typeB });
    await expectPgError(merge(k, d), "OGV22", /Choose which value to keep for: staff_type_id/);
    await expectPgError(merge(k, d, { staff_type_id: "maybe" }), "OGV22");
    await expectPgError(merge(k, d, { staff_type_id: "duplicate", bogus: "keep" }), "OGV22", /Unknown field/);
    await expectPgError(merge(k, d, { staff_type_id: "keep" }, "no"), "OGV22");
    const r = await merge(k, d, { staff_type_id: "duplicate" });
    expect(r.state).toBe("merged");
    expect(await row(k)).toMatchObject({ staff_type_id: typeB, phone: "(555) 010-3333", status: "active" });   // chosen type, filled phone
    expect(await row(d)).toMatchObject({ status: "inactive", phone: "(555) 010-3333" });                        // the duplicate keeps its own values
    expect((await q("select resolutions, kept_before from ogevia.staff_merge_snapshots where link_id = $1", [r.linkId]))[0]).toMatchObject({ resolutions: { staff_type_id: "duplicate" }, kept_before: { staff_type_id: typeA, phone: null } });
    const a = await q("select reason, after_state from ogevia.audit_events where action = 'staff.merged' and entity_id = $1", [d]);
    expect(a[0].after_state).toMatchObject({ resolutions: { staff_type_id: "duplicate" }, merged_into: k }); expect(a[0].reason).toBe("Same person entered twice");
    expect(await merge(k, d, { staff_type_id: "duplicate" })).toEqual({ state: "already_merged" });
    await expectPgError(merge(d, k, {}), "OGC09");   // the merged record cannot be merged again
  });
  it("the 0106 entry point uses the same path and refuses a conflict by name", async () => {
    const k = await person("Eli Sample", { email: "eli@example.invalid" }); const d = await person("Eli Sample", { email: "eli@example.invalid", type: typeB });
    await expectPgError(call(w.ownerA, "select ogevia_api.merge_staff_profiles($1,$2,$3,'Same person twice')", [w.orgA, k, d]), "OGV22", /staff_type_id/);
    const k2 = await person("Fay Sample", { phone: "(555) 010-4444" }); const d2 = await person("Fay Sample", { phone: "(555) 010-4444" });
    expect((await call(w.ownerA, "select ogevia_api.merge_staff_profiles($1,$2,$3,'Same person twice') as r", [w.orgA, k2, d2]))[0].r).toBe("merged");
  });
  it("the duplicate report hides a merged duplicate and shows it again after the merge is undone", async () => {
    const k = await person("Gus Sample", { email: "gus@example.invalid" }); const d = await person("Gus Sample", { email: "gus@example.invalid" });
    const listed = async () => (await call(w.ownerA, "select * from ogevia_api.list_possible_duplicate_staff($1)", [w.orgA])).filter((r) => r.profile_id === d || r.profile_id === k).length;
    expect(await listed()).toBe(4);   // the two records appear in two groups: same email and same name
    const m = await merge(k, d); expect(await listed()).toBe(0);
    await unmerge(m.linkId); expect(await listed()).toBe(4);
  });
});

describe("undo with rollback protection", () => {
  it("restores the kept record's earlier values and reactivates the duplicate; the reversal is recorded and audited; a repeat is a no-op; the pair can be merged again", async () => {
    const k = await person("Hal Sample", { email: "hal@example.invalid" }); const d = await person("Hal Sample", { email: "hal@example.invalid", phone: "(555) 010-5555", type: typeB });
    const m = await merge(k, d, { staff_type_id: "duplicate" });
    await expectPgError(unmerge(m.linkId, "no"), "OGV22");
    expect(await unmerge(m.linkId)).toEqual({ state: "reversed" });
    expect(await row(k)).toMatchObject({ staff_type_id: typeA, phone: null, status: "active" });
    expect(await row(d)).toMatchObject({ status: "active", staff_type_id: typeB });
    expect(await unmerge(m.linkId)).toEqual({ state: "already_reversed" });
    expect((await q("select count(*)::int n from ogevia.audit_events where action = 'staff.unmerged' and entity_id = $1", [d]))[0].n).toBe(1);
    await expect(db.admin.query("delete from ogevia.staff_merge_reversals")).rejects.toMatchObject({ code: "OGC09" });
    expect((await merge(k, d, { staff_type_id: "keep" })).state).toBe("merged");   // merge again after a reversal
  });
  it("refuses the undo when the kept record changed after the merge, or the merged record got a sign-in; changes nothing", async () => {
    const k = await person("Ida Sample", { email: "ida@example.invalid" }); const d = await person("Ida Sample", { email: "ida@example.invalid" });
    const m = await merge(k, d);
    await q("update ogevia.staff_profiles set phone = '(555) 010-6666' where id = $1", [k]);
    await expectPgError(unmerge(m.linkId), "OGC09", /kept record was changed/);
    expect(await row(d)).toMatchObject({ status: "inactive" });
    const k2 = await person("Jon Sample", { email: "jon@example.invalid" }); const d2 = await person("Jon Sample", { email: "jon@example.invalid" });
    const m2 = await merge(k2, d2);
    await q("update ogevia.staff_profiles set invited_at = now(), login_email = 'jon.login@example.invalid' where id = $1", [d2]);
    await expectPgError(unmerge(m2.linkId), "OGC09", /merged record was changed/);
  });
  it("history lists merges with who, why, basis and whether each can be undone now; a caregiver cannot read it", async () => {
    const h = await call(w.ownerA, "select * from ogevia_api.list_staff_merges($1)", [w.orgA]);
    expect(h.length).toBeGreaterThan(3);
    expect(h.find((r) => r.kept_name === "Ida Sample")).toMatchObject({ can_undo: false, has_snapshot: true, match_basis: "email", reason: "Same person entered twice" });
    expect(h.find((r) => r.kept_name === "Fay Sample")).toBeDefined();
    await expectPgError(call(w.caregiverA1, "select * from ogevia_api.list_staff_merges($1)", [w.orgA]), "OGA03");
  });
  it("a merge made before 0116 (no snapshot) lists as history but cannot be undone", async () => {
    const k = await person("Kim Sample", { email: "kim@example.invalid" }); const d = await person("Kim Sample", { email: "kim@example.invalid" });
    const link = (await q("insert into ogevia.staff_merge_links (organization_id, kept_profile_id, merged_profile_id, match_basis, reason, merged_by) values ($1,$2,$3,'email','Legacy merge (synthetic)',$4) returning id", [w.orgA, k, d, w.ownerA.userId]))[0].id;
    await q("update ogevia.staff_profiles set status = 'inactive' where id = $1", [d]);
    await expectPgError(unmerge(link), "OGC09", /before undo was available/);
  });
});

describe("rollback script", () => {
  it("refuses while a profile has more than one merge link (a merge was reversed and repeated), and restores the 0106 behaviour once that is resolved", async () => {
    await expect(run(P("rollback/0116_staff_merge_hardening.down.sql"))).rejects.toThrow(/more than one merge link/);
    // resolve by hand (test setup, as the owner would): keep only the latest link per merged profile
    const c = await db.admin.connect();
    try {
      await c.query("set session_replication_role = replica");   // test clean-up only: the tables are append-only for everyone else
      await c.query("delete from ogevia.staff_merge_reversals"); await c.query("delete from ogevia.staff_merge_snapshots");
      await c.query("delete from ogevia.staff_merge_links l using ogevia.staff_merge_links m where l.merged_profile_id = m.merged_profile_id and l.merged_at < m.merged_at");
    } finally { await c.query("reset session_replication_role"); c.release(); }
    await run(P("rollback/0116_staff_merge_hardening.down.sql"));
    expect((await q("select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'ogevia_api' and p.proname in ('unmerge_staff_profiles','preview_staff_merge')"))[0].n).toBe(0);
    const k = await person("Lee Rollback", { email: "lee@example.invalid" }); const d = await person("Lee Rollback", { email: "lee@example.invalid" });
    expect((await call(w.ownerA, "select ogevia_api.merge_staff_profiles($1,$2,$3,'Same person twice') as r", [w.orgA, k, d]))[0].r).toBe("merged");
  });
});
