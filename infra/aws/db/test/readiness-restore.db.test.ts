// Archive -> re-apply -> RESTORE of an explicitly selected recovery set (db/restore/*.sql), PR #76 migration chain 0039-0046.
// Re-applying alone restores nothing. The restore script needs ONE explicitly selected, complete recovery set (one rollback attempt),
// refuses mixed / incomplete / missing / unknown / not-newest sets and unexpected non-empty destinations, keeps ids and dependencies in one
// transaction, and never turns enforcement on. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrations.js";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, setBaselineAvailability, type Actor, type TestDb, type World } from "./harness.js";

const DIR = new URL("../rollback/", import.meta.url);
const RESTORE = readFileSync(new URL("../restore/readiness_restore_from_archives.sql", import.meta.url), "utf8");
const LIST = readFileSync(new URL("../restore/readiness_list_recovery_sets.sql", import.meta.url), "utf8");
const DOWNS = ["0046_visit_start_availability", "0045_manual_care_offer", "0044_readiness_review", "0043_explainable_matching", "0042_readiness_gate", "0041_required_documents", "0040_caregiver_service_approvals", "0039_availability_approval"];

let db: TestDb;
let w: World;
let rec1: string;
let fx: { client: string; service: string; auth: string };
let cprType: string;
let attempt1: string[] = [];
let attempt2: string[] = [];
let snap2: Awaited<ReturnType<typeof snap>>;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  rec1 = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id=$1", [w.caregiverA1.userId])).rows[0].id as string;
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 60 });
});
afterAll(async () => db?.drop());

async function runDown(f: string) {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role ogevia_owner");
    await c.query(readFileSync(new URL(`${f}.down.sql`, DIR), "utf8"));
    await c.query("reset role");
    await c.query("delete from ogevia_meta.schema_migrations where version = $1", [f.slice(0, 4)]);
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const rollbackAll = async () => { for (const f of DOWNS) await runDown(f); };
const reapply = async () => { const c = await db.admin.connect(); try { return (await migrate(c)).applied.map((x) => x.slice(0, 4)); } finally { c.release(); } };
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const archiveNames = async () => (await db.admin.query("select tablename from pg_catalog.pg_tables where schemaname='ogevia' and tablename ~ '^archived_.+_[0-9]{4}_[0-9]{14}$' order by 1")).rows.map((r) => r.tablename as string);

/** Makes every archive that exists now look like it came from a rollback long ago (a second, later attempt then has a distinct set). */
async function ageArchives() {
  for (const n of await archiveNames()) {
    if (/_20200101\d{6}$/.test(n)) continue;
    await db.admin.query(`alter table ogevia."${n}" rename to "${n.replace(/_\d{14}$/, "_20200101000000")}"`);
  }
}

async function runRestore(set: string[], opts: { older?: boolean } = {}) {
  const c = await db.admin.connect();
  const notices: string[] = [];
  c.on("notice", (n) => notices.push(n.message ?? ""));
  try {
    await c.query("select set_config('ogevia.recovery_set', $1, false)", [set.join(",")]);
    await c.query("select set_config('ogevia.recovery_allow_older', $1, false)", [opts.older ? "yes" : ""]);
    try { await c.query(RESTORE); } catch (e) { await c.query("rollback"); throw e; }
  } finally {
    await c.query("select set_config('ogevia.recovery_set', '', false), set_config('ogevia.recovery_allow_older', '', false)");
    c.removeAllListeners("notice");
    c.release();
  }
  return notices;
}
const refused = async (set: string[], message: RegExp, opts: { older?: boolean } = {}) => {
  await expect(runRestore(set, opts)).rejects.toThrow(message);
};

async function populate(label: "one" | "two") {
  const today = await orgToday(db);
  await setBaselineAvailability(db, w.orgA, w.caregiverA1, [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_local: "00:00", end_local: "23:59" })));
  if (!cprType) cprType = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR',true,null) as id", [w.orgA]))[0].id;
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Policy')", [w.orgA, cprType]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Policy')", [w.orgA]);
  if (label === "one") {
    // Only the FIRST attempt had a (revoked) service approval and active enforcement.
    const approval = (await call(w.ownerA, "select ogevia_api.approve_caregiver_service($1,$2,$3,$4::date,null,'Observed visit') as id", [w.orgA, rec1, fx.service, today]))[0].id;
    await call(w.ownerA, "select ogevia_api.revoke_caregiver_service($1,$2,'Competency concern',null)", [w.orgA, approval]);
    await db.admin.query("insert into ogevia.organization_readiness_settings(organization_id, enforcement_active_from, service_checks) values ($1, now(), true)", [w.orgA]);
  }
  await db.admin.query("insert into ogevia.readiness_setting_events(organization_id, setting, old_value, new_value, reason, changed_by) values ($1,'service_checks','Off','On',$2,$3)", [w.orgA, `Test ${label}`, w.ownerA.userId]);
  await call(w.ownerA, "select ogevia_api.authorize_availability_override($1,$2,now(), now() + interval '2 days',$3)", [w.orgA, rec1, `Phone agreement ${label}`]);
  const tag = (await call(w.managerA, "select ogevia_api.create_experience_tag($1,$2) as id", [w.orgA, label === "one" ? "ABA experience" : "Dementia care"]))[0].id;
  await call(w.managerA, "select ogevia_api.review_caregiver_experience($1,$2,$3::uuid[],'ok')", [w.orgA, rec1, `{${tag}}`]);
  await call(w.managerA, "select ogevia_api.set_caregiver_zip($1,$2,$3)", [w.orgA, rec1, label === "one" ? "90210" : "90001"]);
}
async function snap() {
  const q = async (sql: string) => (await db.admin.query(sql)).rows;
  return {
    approvals: await q("select id, revoked_at is not null revoked, revocation_reason from ogevia.caregiver_service_approvals order by id"),
    policies: await q("select organization_id, requirement, validity_basis, validity_days from ogevia.document_requirement_policies order by requirement"),
    overrides: await q("select id, reason, range_start, range_end from ogevia.availability_overrides order by id"),
    tags: await q("select id, label from ogevia.experience_tags order by id"),
    experience: await q("select caregiver_record_id, tag_id, status from ogevia.caregiver_experience order by 1,2"),
    zip: await q("select caregiver_record_id, zip from ogevia.caregiver_zip order by 1"),
    events: await q("select id, setting, reason from ogevia.readiness_setting_events order by id"),
    designations: await q("select id, work_requirement from ogevia.document_types where work_requirement is not null order by id"),
  };
}
const nothingRestored = async () => {
  const s = await snap();
  expect(s.approvals).toEqual([]);
  expect(s.tags).toEqual([]);
  expect(s.experience).toEqual([]);
  expect(s.zip).toEqual([]);
  expect(s.overrides).toEqual([]);
  expect(s.events).toEqual([]);
  expect(s.policies).toEqual([]);
  expect(s.designations).toEqual([]);
};

describe("two rollback attempts, then restore of one explicitly selected recovery set", () => {
  it("attempt 1 (with a revoked service approval and enforcement) is archived, aged, and the release re-applied clean", async () => {
    await populate("one");
    await rollbackAll();
    attempt1 = (await archiveNames());
    expect(attempt1.some((n) => n.startsWith("archived_caregiver_service_approvals_0040_"))).toBe(true);
    expect(attempt1.some((n) => n.startsWith("archived_organization_readiness_settings_0042_"))).toBe(true);
    await ageArchives();
    attempt1 = await archiveNames();
    expect(await reapply()).toEqual(["0039", "0040", "0041", "0042", "0043", "0044", "0045", "0046"]);
    await nothingRestored(); // re-applying alone restores nothing
  });

  it("attempt 2 (later; NO service approval at all) is archived and the release re-applied", async () => {
    await populate("two");
    snap2 = await snap();
    expect(snap2.approvals).toEqual([]);
    await rollbackAll();
    attempt2 = (await archiveNames()).filter((n) => !attempt1.includes(n));
    expect(attempt2.length).toBeGreaterThan(5);
    expect(attempt2.some((n) => n.startsWith("archived_caregiver_service_approvals_"))).toBe(false); // the later rollback had no approvals to archive
    expect(await reapply()).toEqual(["0039", "0040", "0041", "0042", "0043", "0044", "0045", "0046"]);
    await nothingRestored();
  });

  it("the listing shows two recovery sets, the later one without an approvals archive", async () => {
    const rows = (await db.admin.query(LIST)).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].archive_names.split(",").sort()).toEqual([...attempt1].sort());
    expect(rows[1].archive_names.split(",").sort()).toEqual([...attempt2].sort());
    expect(rows[1].archive_names).not.toMatch(/caregiver_service_approvals/);
  });

  it("refuses: no selection, a non-archive name, a missing table, an unknown archive, a mixed set, an incomplete set, and an older set; nothing is restored", async () => {
    await refused([], /no recovery set selected/);
    await refused(["caregiver_zip"], /is not an archive table name/);
    await refused([...attempt2, "archived_caregiver_zip_0043_20261231235959"], /does not exist/);
    await db.admin.query("create table ogevia.archived_bogus_0043_20261010101010 (id int)");
    await refused([...attempt2, "archived_bogus_0043_20261010101010"], /not a known readiness archive/);
    await db.admin.query("drop table ogevia.archived_bogus_0043_20261010101010");
    // MIXED: the outdated approval from attempt 1 together with attempt 2's other archives (the reviewer's reproduction).
    const oldApprovals = attempt1.find((n) => n.startsWith("archived_caregiver_service_approvals_0040_"))!;
    await refused([...attempt2, oldApprovals], /more than one rollback attempt/);
    // two archives of the same table
    const zip1 = attempt1.find((n) => n.startsWith("archived_caregiver_zip_0043_"))!;
    const zip2 = attempt2.find((n) => n.startsWith("archived_caregiver_zip_0043_"))!;
    await refused([...attempt2, zip1], /two archives of caregiver_zip_0043|more than one rollback attempt/);
    // INCOMPLETE: one archive of the attempt left out
    await refused(attempt2.filter((n) => n !== zip2), /incomplete set/);
    // Not the newest set (attempt 2 is newer)
    await refused(attempt1, /not the newest recovery set/);
    await nothingRestored();
  });

  it("refuses a destination table that is not in the set but already holds rows (a new approval created after the re-apply)", async () => {
    const today = await orgToday(db);
    await call(w.ownerA, "select ogevia_api.approve_caregiver_service($1,$2,$3,$4::date,null,'New approval after re-apply')", [w.orgA, rec1, fx.service, today]);
    await refused(attempt2, /caregiver_service_approvals is not in the selected set but already holds 1 row/);
    const c = await db.admin.connect();
    try { await c.query("set session_replication_role = replica"); await c.query("delete from ogevia.caregiver_service_approvals"); } finally { await c.query("reset session_replication_role"); c.release(); }
    await nothingRestored();
  });

  it("a broken dependency fails the whole restore and leaves nothing half-restored", async () => {
    const zip2 = attempt2.find((n) => n.startsWith("archived_caregiver_zip_0043_"))!;
    await db.admin.query(`update ogevia.${zip2} set caregiver_record_id = gen_random_uuid()`);
    await expect(runRestore(attempt2)).rejects.toMatchObject({ code: "23503" }); // foreign_key_violation
    await nothingRestored(); // tags (restored before the failing ZIP table) were rolled back with it
    await db.admin.query(`update ogevia.${zip2} set caregiver_record_id = $1`, [rec1]);
  });

  it("restores attempt 2 with the same ids; the outdated approval from attempt 1 is NOT restored; enforcement stays off", async () => {
    const notices = await runRestore(attempt2);
    const restored = await snap();
    expect(restored.tags).toEqual(snap2.tags);
    expect(restored.experience).toEqual(snap2.experience);
    expect(restored.zip).toEqual(snap2.zip);
    expect(restored.policies).toEqual(snap2.policies);
    expect(restored.overrides).toEqual(snap2.overrides);
    expect(restored.events).toEqual(snap2.events);
    expect(restored.designations).toEqual(snap2.designations);
    expect(restored.approvals).toEqual([]); // attempt 1's approval is stale and was never selected
    expect(notices.join("\n")).toMatch(/caregiver_zip : restored 1 of 1/);
    expect((await db.admin.query("select count(*)::int n from ogevia.organization_readiness_settings")).rows[0].n).toBe(0);
    expect((await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s).toMatchObject({ enforcementActive: false });
    // Dependencies hold.
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_experience e left join ogevia.experience_tags t on t.id = e.tag_id where t.id is null")).rows[0].n).toBe(0);
  });

  it("a rerun of the same set changes nothing; a restored record that was changed is never overwritten", async () => {
    const before = await snap();
    const notices = await runRestore(attempt2);
    expect(notices.join("\n")).toMatch(/already restored/);
    expect(await snap()).toEqual(before);
    await db.admin.query("update ogevia.experience_tags set label = 'Edited after restore'");
    await refused(attempt2, /already holds .* row\(s\) that differ from the archive/);
    await db.admin.query("update ogevia.experience_tags t set label = s.label from (select unnest($1::uuid[]) id, unnest($2::text[]) label) s where s.id = t.id", [snap2.tags.map((t: any) => t.id), snap2.tags.map((t: any) => t.label)]);
    expect(await snap()).toEqual(before);
  });

  it("restoring the older set is only possible with an explicit override, and still never over non-empty or different records", async () => {
    await refused(attempt1, /not the newest recovery set/);
    await refused(attempt1, /already holds .* row\(s\) that differ from the archive/, { older: true }); // the destinations already hold attempt 2's records
    expect((await snap()).approvals).toEqual([]);
  });
});
