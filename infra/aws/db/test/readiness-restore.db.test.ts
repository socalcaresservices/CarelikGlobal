// Recorded rollback ATTEMPTS and restore of exactly one of them (db/scripts/rollbacks.ts + db/restore/*.sql), PR #76 migration chain 0039-0046.
// Each rollback gets a unique attempt id and a complete manifest (including slots with zero records); the restore uses only what the manifest of ONE
// attempt names. Two rollbacks less than 10 minutes apart (here: seconds) are never mixed. Re-applying alone restores nothing. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrations.js";
import { rollbackReadiness, SLOTS, type RollbackResult } from "../scripts/rollbacks.js";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, setBaselineAvailability, type Actor, type TestDb, type World } from "./harness.js";

const RESTORE = readFileSync(new URL("../restore/readiness_restore_from_archives.sql", import.meta.url), "utf8");
const LIST = readFileSync(new URL("../restore/readiness_list_recovery_sets.sql", import.meta.url), "utf8");
const ALL = ["0039", "0040", "0041", "0042", "0043", "0044", "0045", "0046", "0047", "0048", "0049", "0050", "0051"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let db: TestDb;
let w: World;
let rec1: string;
let fx: { client: string; service: string; auth: string };
let cprType: string;
let a1: RollbackResult;
let a2: RollbackResult;
let snap2: Awaited<ReturnType<typeof snap>>;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  rec1 = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id=$1", [w.caregiverA1.userId])).rows[0].id as string;
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 60 });
});
afterAll(async () => db?.drop());

const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const rollback = async (target?: string) => { const c = await db.admin.connect(); try { return await rollbackReadiness(c, { target }); } finally { c.release(); } };
const reapply = async () => { const c = await db.admin.connect(); try { return (await migrate(c)).applied.map((x) => x.slice(0, 4)); } finally { c.release(); } };

async function runRestore(attempt: string, opts: { older?: boolean } = {}) {
  const c = await db.admin.connect();
  const notices: string[] = [];
  c.on("notice", (n) => notices.push(n.message ?? ""));
  try {
    await c.query("select set_config('ogevia.recovery_attempt', $1, false)", [attempt]);
    await c.query("select set_config('ogevia.recovery_allow_older', $1, false)", [opts.older ? "yes" : ""]);
    try { await c.query(RESTORE); } catch (e) { await c.query("rollback"); throw e; }
  } finally {
    await c.query("select set_config('ogevia.recovery_attempt', '', false), set_config('ogevia.recovery_allow_older', '', false)");
    c.removeAllListeners("notice");
    c.release();
  }
  return notices;
}
const refused = async (attempt: string, message: RegExp, opts: { older?: boolean } = {}) => { await expect(runRestore(attempt, opts)).rejects.toThrow(message); };

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
  await db.admin.query(
      `insert into ogevia.availability_overrides (organization_id, caregiver_record_id, client_id, range_start, range_end, reason, authorised_by, expires_at, original_status)
       values ($1,$2,$3, now(), now() + interval '2 hours', $4, $5, now() + interval '30 minutes', 'outside')`, [w.orgA, rec1, fx.client, `Phone agreement ${label}`, w.ownerA.userId]);
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

describe("two rollbacks seconds apart: the first holds a service approval, the second holds none", () => {
  it("attempt 1 is recorded with a unique id and a complete manifest (zero-record slots included); the release is re-applied clean", async () => {
    await populate("one");
    a1 = await rollback();
    expect(a1.rolledBack).toEqual([...ALL].reverse());
    expect(a1.manifest).toHaveLength(SLOTS.length);
    const approvals = a1.manifest.find((m) => m.stem === "caregiver_service_approvals_0040")!;
    expect(approvals).toMatchObject({ sourceRows: 1, archiveRows: 1 });
    expect(approvals.archiveTable).toMatch(/^archived_caregiver_service_approvals_0040_\d{14}$/);
    // Slots that held no records are in the manifest too, with no archive.
    expect(a1.manifest.find((m) => m.stem === "zip_centroids_0043")).toMatchObject({ sourceRows: 0, archiveTable: null, archiveRows: null });
    expect(a1.manifest.filter((m) => !m.archiveTable).length).toBeGreaterThan(3);
    expect((await db.admin.query("select slot_count from ogevia.readiness_rollback_attempts where attempt_id = $1", [a1.attemptId])).rows[0].slot_count).toBe(SLOTS.length);
    expect(await reapply()).toEqual(ALL);
    await nothingRestored(); // re-applying alone restores nothing
  });

  it("the rollback runner refuses a target below 0039 and a target that is not applied", async () => {
    await expect(rollback("0038")).rejects.toThrow(/0039 or later/);
    await expect(rollback("0052")).rejects.toThrow(/no applied migration at or above 0052/);
  });

  it("attempt 2 (seconds later, same 10-minute window) holds NO service approval: its manifest records that slot with zero rows", async () => {
    await populate("two");
    snap2 = await snap();
    expect(snap2.approvals).toEqual([]);
    await sleep(1100); // archive table names carry a one-second timestamp; a same-second second attempt would be refused harmlessly, not mixed
    a2 = await rollback();
    expect(a2.attemptId).not.toBe(a1.attemptId);
    expect(a2.manifest).toHaveLength(SLOTS.length);
    expect(a2.manifest.find((m) => m.stem === "caregiver_service_approvals_0040")).toMatchObject({ sourceRows: 0, archiveTable: null, archiveRows: null });
    const gap = (await db.admin.query("select (select started_at from ogevia.readiness_rollback_attempts where attempt_id = $2) - (select started_at from ogevia.readiness_rollback_attempts where attempt_id = $1) as gap", [a1.attemptId, a2.attemptId])).rows[0].gap;
    expect(gap.minutes ?? 0).toBeLessThan(10); // the old time-window grouping would have treated these as ONE rollback
    expect(await reapply()).toEqual(ALL);
    await nothingRestored();
  });

  it("the listing shows both attempts, newest first, with their archived and zero-record slots", async () => {
    const rows = (await db.admin.query(LIST)).rows;
    expect(rows.map((r) => r.attempt_id)).toEqual([a2.attemptId, a1.attemptId]);
    expect(Number(rows[0].service_approvals_archived)).toBe(0);
    expect(Number(rows[1].service_approvals_archived)).toBe(1);
    expect(Number(rows[0].manifest_rows)).toBe(SLOTS.length);
  });

  it("refuses: no/invalid/unknown attempt, an older attempt, an incomplete manifest, a missing, changed or mixed-across-attempts archive; nothing is restored", async () => {
    await refused("", /no rollback attempt selected/);
    await refused("not-a-uuid", /not a valid attempt id/);
    await refused("00000000-0000-4000-8000-000000000000", /unknown rollback attempt/);
    await refused(a1.attemptId, /not the newest rollback attempt/);
    const arch = (a: RollbackResult, stem: string) => a.manifest.find((m) => m.stem === stem)!.archiveTable!;
    const manifestDelete = (stem: string) => db.admin.query("delete from ogevia.readiness_rollback_manifest where attempt_id = $1 and stem = $2 returning *", [a2.attemptId, stem]);

    // incomplete manifest
    const removed = (await manifestDelete("zip_centroids_0043")).rows[0];
    await refused(a2.attemptId, /manifest of attempt .* is incomplete/);
    await db.admin.query("insert into ogevia.readiness_rollback_manifest (attempt_id, stem, migration, source_rows, archive_table, archive_rows) values ($1,$2,$3,$4,$5,$6)",
      [removed.attempt_id, removed.stem, removed.migration, removed.source_rows, removed.archive_table, removed.archive_rows]);

    // an archive missing
    const tags2 = arch(a2, "experience_tags_0043");
    await db.admin.query(`alter table ogevia.${tags2} rename to hidden_${tags2}`);
    await refused(a2.attemptId, /is missing/);
    await db.admin.query(`alter table ogevia.hidden_${tags2} rename to ${tags2}`);

    // an archive changed after the rollback
    const zip2 = arch(a2, "caregiver_zip_0043");
    await db.admin.query(`insert into ogevia.${zip2} select * from ogevia.${zip2} limit 1`);
    await refused(a2.attemptId, /changed after the rollback/);
    await db.admin.query(`delete from ogevia.${zip2} where ctid = (select max(ctid) from ogevia.${zip2})`);

    // MIXED across attempts (1): the database refuses to name one archive in two attempts
    const old = arch(a1, "caregiver_service_approvals_0040");
    await expect(db.admin.query("update ogevia.readiness_rollback_manifest set archive_table = $1, archive_rows = 1 where attempt_id = $2 and stem = 'caregiver_service_approvals_0040'", [old, a2.attemptId])).rejects.toMatchObject({ code: "23505" });
    // MIXED across attempts (2): even with that constraint removed, the attempt tag on the archive itself refuses it
    await db.admin.query("alter table ogevia.readiness_rollback_manifest drop constraint readiness_rollback_manifest_archive_table_key");
    await db.admin.query("update ogevia.readiness_rollback_manifest set archive_table = $1, archive_rows = 1 where attempt_id = $2 and stem = 'caregiver_service_approvals_0040'", [old, a2.attemptId]);
    await refused(a2.attemptId, /tagged for a different rollback attempt/);
    await db.admin.query("update ogevia.readiness_rollback_manifest set archive_table = null, archive_rows = null where attempt_id = $1 and stem = 'caregiver_service_approvals_0040'", [a2.attemptId]);
    await db.admin.query("alter table ogevia.readiness_rollback_manifest add constraint readiness_rollback_manifest_archive_table_key unique (archive_table)");
    // an archive tagged with this attempt but absent from its manifest
    await db.admin.query(`comment on table ogevia.${old} is 'readiness rollback attempt ${a2.attemptId}'`);
    await refused(a2.attemptId, /is tagged for attempt .* but is not in its manifest/);
    await db.admin.query(`comment on table ogevia.${old} is 'readiness rollback attempt ${a1.attemptId}'`);
    await nothingRestored();
  });

  it("a slot that held no records in the attempt must still be empty: a new approval is never mixed in, and nothing around it is restored", async () => {
    const today = await orgToday(db);
    await call(w.ownerA, "select ogevia_api.approve_caregiver_service($1,$2,$3,$4::date,null,'New approval after re-apply')", [w.orgA, rec1, fx.service, today]);
    await refused(a2.attemptId, /caregiver_service_approvals held no records in attempt .* but now holds 1 row/);
    const c = await db.admin.connect();
    try { await c.query("set session_replication_role = replica"); await c.query("delete from ogevia.caregiver_service_approvals"); } finally { await c.query("reset session_replication_role"); c.release(); }
    await nothingRestored();
  });

  it("a broken dependency fails the whole restore and leaves nothing half-restored", async () => {
    const zip2 = a2.manifest.find((m) => m.stem === "caregiver_zip_0043")!.archiveTable!;
    await db.admin.query(`update ogevia.${zip2} set caregiver_record_id = gen_random_uuid()`);
    await expect(runRestore(a2.attemptId)).rejects.toMatchObject({ code: "23503" }); // foreign_key_violation
    await nothingRestored(); // tags (restored before the failing ZIP table) were rolled back with it
    await db.admin.query(`update ogevia.${zip2} set caregiver_record_id = $1`, [rec1]);
  });

  it("restoring attempt 2 NEVER restores attempt 1's approval, though attempt 1 is only seconds older; enforcement stays off", async () => {
    const oldApprovalIds = (await db.admin.query(`select id from ogevia.${a1.manifest.find((m) => m.stem === "caregiver_service_approvals_0040")!.archiveTable}`)).rows.map((r) => r.id as string);
    expect(oldApprovalIds).toHaveLength(1);
    const notices = await runRestore(a2.attemptId);
    const restored = await snap();
    expect(restored.tags).toEqual(snap2.tags);
    expect(restored.experience).toEqual(snap2.experience);
    expect(restored.zip).toEqual(snap2.zip);
    expect(restored.policies).toEqual(snap2.policies);
    expect(restored.overrides).toEqual(snap2.overrides);
    expect(restored.events).toEqual(snap2.events);
    expect(restored.designations).toEqual(snap2.designations);
    expect(restored.approvals).toEqual([]);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_service_approvals where id = any($1::uuid[])", [oldApprovalIds])).rows[0].n).toBe(0);
    expect(notices.join("\n")).toMatch(/caregiver_zip : restored 1 of 1/);
    expect((await db.admin.query("select count(*)::int n from ogevia.organization_readiness_settings")).rows[0].n).toBe(0);
    expect((await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s).toMatchObject({ enforcementActive: false });
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_experience e left join ogevia.experience_tags t on t.id = e.tag_id where t.id is null")).rows[0].n).toBe(0);
  });

  it("a rerun changes nothing; a restored record that was changed is never overwritten; the older attempt is still refused", async () => {
    const before = await snap();
    expect((await runRestore(a2.attemptId)).join("\n")).toMatch(/already restored/);
    expect(await snap()).toEqual(before);
    await db.admin.query("update ogevia.experience_tags set label = 'Edited after restore'");
    await refused(a2.attemptId, /already holds .* row\(s\) that differ from the archive/);
    await db.admin.query("update ogevia.experience_tags t set label = s.label from (select unnest($1::uuid[]) id, unnest($2::text[]) label) s where s.id = t.id", [snap2.tags.map((t: any) => t.id), snap2.tags.map((t: any) => t.label)]);
    expect(await snap()).toEqual(before);
    await refused(a1.attemptId, /not the newest rollback attempt/);
    await refused(a1.attemptId, /already holds .* row\(s\) that differ from the archive|held no records in attempt|RESTORE REFUSED/, { older: true }); // explicit override, still never over other records
    expect((await snap()).approvals).toEqual([]);
  });

  it("a database that never recorded a rollback attempt refuses (archives from a hand-run down script are not restorable by this script)", async () => {
    const c = await db.admin.connect();
    try { await c.query("drop table ogevia.readiness_rollback_manifest; drop table ogevia.readiness_rollback_attempts"); } finally { c.release(); }
    await refused(a2.attemptId, /no rollback attempt has been recorded/);
  });
});
