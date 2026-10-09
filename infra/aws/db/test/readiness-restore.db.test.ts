// Archive -> re-apply -> RESTORE (db/restore/readiness_restore_from_archives.sql) on a POPULATED database, PR #76 migration chain 0039-0045.
// Re-applying alone restores nothing; the restore script puts the archived records back with their ids, all-or-nothing. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrations.js";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, setBaselineAvailability, type Actor, type TestDb, type World } from "./harness.js";

const DIR = new URL("../rollback/", import.meta.url);
let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

async function runDown(file: string) {
  const client = await db.admin.connect();
  try {
    await client.query("begin");
    await client.query("set local role ogevia_owner");
    await client.query(readFileSync(new URL(file, DIR), "utf8"));
    await client.query("reset role");
    await client.query("delete from ogevia_meta.schema_migrations where version = $1", [file.slice(0, 4)]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const archived = async () => (await db.admin.query("select table_name from information_schema.tables where table_schema='ogevia' and table_name like 'archived\\_%' order by 1")).rows.map((r) => r.table_name.replace(/_\d{14}$/, ""));

describe("readiness release rollback keeps data", () => {
  it("archives approvals, rules, settings, overrides, experience and flags; the old functions work again; re-apply succeeds", async () => {
    const today = await orgToday(db);
    const rec1 = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id=$1", [w.caregiverA1.userId])).rows[0].id as string;
    const fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 60 });
    await setBaselineAvailability(db, w.orgA, w.caregiverA1, [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_local: "00:00", end_local: "23:59" })));
    // 0040: an approval that is later revoked (with a future shift flagged).
    const approval = (await call(w.ownerA, "select ogevia_api.approve_caregiver_service($1,$2,$3,$4::date,null,'Observed visit') as id", [w.orgA, rec1, fx.service, today]))[0].id;
    await db.admin.query(`insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
      values ($1,$2,$3,$4,$5, now() + interval '3 days', now() + interval '3 days 2 hours', 'scheduled')`, [w.orgA, fx.client, fx.service, w.caregiverA1.userId, rec1]);
    await call(w.ownerA, "select ogevia_api.revoke_caregiver_service($1,$2,'Competency concern',null)", [w.orgA, approval]);
    // 0041/0042: document rules, enforcement settings and an override.
    const cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR',true,null) as id", [w.orgA]))[0].id;
    await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Policy')", [w.orgA, cpr]);
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Policy')", [w.orgA]);
    await db.admin.query("insert into ogevia.organization_readiness_settings(organization_id, enforcement_active_from, service_checks) values ($1, now(), true)", [w.orgA]);
    await db.admin.query("insert into ogevia.readiness_setting_events(organization_id, setting, old_value, new_value, reason, changed_by) values ($1,'service_checks','Off','On','Test',$2)", [w.orgA, w.ownerA.userId]);
    await call(w.ownerA, "select ogevia_api.authorize_availability_override($1,$2,now(), now() + interval '2 days','Phone agreement')", [w.orgA, rec1]);
    // 0043: tags, experience, ZIPs and a rule.
    const tag = (await call(w.managerA, "select ogevia_api.create_experience_tag($1,'ABA experience') as id", [w.orgA]))[0].id;
    await call(w.managerA, "select ogevia_api.review_caregiver_experience($1,$2,$3::uuid[],'ok')", [w.orgA, rec1, `{${tag}}`]);
    await call(w.managerA, "select ogevia_api.set_caregiver_zip($1,$2,'90210')", [w.orgA, rec1]);
    const snap = async () => ({
      approvals: (await db.admin.query("select id, revoked_at is not null revoked, revocation_reason from ogevia.caregiver_service_approvals order by id")).rows,
      policies: (await db.admin.query("select organization_id, requirement, validity_basis, validity_days from ogevia.document_requirement_policies order by requirement")).rows,
      overrides: (await db.admin.query("select id, reason, range_start, range_end from ogevia.availability_overrides order by id")).rows,
      tags: (await db.admin.query("select id, label from ogevia.experience_tags order by id")).rows,
      experience: (await db.admin.query("select caregiver_record_id, tag_id, status from ogevia.caregiver_experience order by 1,2")).rows,
      zip: (await db.admin.query("select caregiver_record_id, zip from ogevia.caregiver_zip order by 1")).rows,
      events: (await db.admin.query("select id, setting, new_value from ogevia.readiness_setting_events order by id")).rows,
      designations: (await db.admin.query("select id, work_requirement from ogevia.document_types where work_requirement is not null order by id")).rows,
    });
    const snapBefore = await snap();
    const before = {
      shifts: (await db.admin.query("select count(*)::int n from ogevia.shifts")).rows[0].n,
      approvals: (await db.admin.query("select count(*)::int n from ogevia.caregiver_service_approvals")).rows[0].n,
      audit: (await db.admin.query("select count(*)::int n from ogevia.audit_events")).rows[0].n,
    };
    for (const f of ["0045_manual_care_offer", "0044_readiness_review", "0043_explainable_matching", "0042_readiness_gate", "0041_required_documents", "0040_caregiver_service_approvals", "0039_availability_approval"]) {
      await runDown(`${f}.down.sql`);
    }
    // Records that existed before the release are untouched; audit history only grows.
    expect((await db.admin.query("select count(*)::int n from ogevia.shifts")).rows[0].n).toBe(before.shifts);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events")).rows[0].n).toBeGreaterThanOrEqual(before.audit);
    // Everything the release recorded is archived (named, count-checked), not dropped.
    const names = await archived();
    for (const n of [
      "archived_caregiver_service_approvals_0040", "archived_shift_service_flags_0040", "archived_assignment_readiness_flags_0040",
      "archived_document_requirement_policies_0041", "archived_organization_readiness_settings_0042", "archived_readiness_setting_events_0042",
      "archived_availability_overrides_0042", "archived_experience_tags_0043", "archived_caregiver_experience_0043", "archived_caregiver_zip_0043",
    ]) expect(names, n).toContain(n);
    const arch = (await db.admin.query("select table_name from information_schema.tables where table_schema='ogevia' and table_name like 'archived_caregiver_service_approvals_0040_%'")).rows[0].table_name;
    expect((await db.admin.query(`select count(*)::int n from ogevia.${arch}`)).rows[0].n).toBe(before.approvals);
    // The old behaviour is back: a shift for a caregiver with no CPR is accepted again by the 0035 create_shift.
    const day = (await db.admin.query("select to_char($1::date + 9, 'YYYY-MM-DD') d", [today])).rows[0].d;
    const made = await call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','11:00',$5,null)", [w.orgA, fx.client, fx.service, day, rec1]);
    expect(made).toHaveLength(1);
    // Re-applying the whole release works and starts clean.
    const client = await db.admin.connect();
    try {
      expect((await migrate(client)).applied.map((x) => x.slice(0, 4))).toEqual(["0039", "0040", "0041", "0042", "0043", "0044", "0045"]);
    } finally {
      client.release();
    }
    const status = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
    expect(status).toMatchObject({ enforcementActive: false, serviceChecks: { state: "Off" } });
    // ---- RESTORE: archive + re-apply does NOT bring records back by itself; the restore script does, with the same ids. ----
    const empty = await snap();
    expect(empty.approvals).toEqual([]); // re-applying starts clean: the records are only in the archives
    expect(empty.tags).toEqual([]);
    expect(snapBefore.approvals.length).toBeGreaterThan(0);
    expect(snapBefore.policies.length).toBeGreaterThan(0);
    expect(snapBefore.designations.length).toBeGreaterThan(0);

    const restoreSql = readFileSync(new URL("../restore/readiness_restore_from_archives.sql", import.meta.url), "utf8");
    const runRestore = async () => {
      const c = await db.admin.connect();
      const notices: string[] = [];
      c.on("notice", (n) => notices.push(n.message ?? ""));
      try {
        await c.query("begin");
        await c.query(restoreSql);
        await c.query("commit");
      } catch (error) {
        await c.query("rollback");
        throw error;
      } finally {
        c.removeAllListeners("notice");
        c.release();
      }
      return notices;
    };

    // All-or-nothing: an archived row whose parent no longer exists (dependency broken) fails the whole restore and restores NOTHING.
    const zipArchive = (await db.admin.query("select table_name from information_schema.tables where table_schema='ogevia' and table_name like 'archived_caregiver_zip_0043_%'")).rows[0].table_name as string;
    await db.admin.query(`update ogevia.${zipArchive} set caregiver_record_id = gen_random_uuid()`);
    await expect(runRestore()).rejects.toMatchObject({ code: "23503" }); // foreign_key_violation
    expect((await snap()).tags).toEqual([]); // the earlier tables were rolled back with it
    expect((await snap()).approvals).toEqual([]);
    await db.admin.query(`update ogevia.${zipArchive} set caregiver_record_id = $1`, [rec1]);

    const notices = await runRestore();
    const restored = await snap();
    expect(restored.approvals).toEqual(snapBefore.approvals); // same ids, and the revocation (reason) is still there
    expect(restored.policies).toEqual(snapBefore.policies);
    expect(restored.overrides).toEqual(snapBefore.overrides);
    expect(restored.tags).toEqual(snapBefore.tags);
    expect(restored.experience).toEqual(snapBefore.experience); // the experience rows still point at the same tag and caregiver
    expect(restored.zip).toEqual(snapBefore.zip);
    expect(restored.events).toEqual(snapBefore.events);
    expect(restored.designations).toEqual(snapBefore.designations);
    expect(notices.join("\n")).toMatch(/caregiver_service_approvals : restored 1 of 1/);
    // Dependencies hold: every restored child has its parent (checked by the foreign keys and re-checked here).
    expect((await db.admin.query(`select count(*)::int n from ogevia.caregiver_experience e left join ogevia.experience_tags t on t.id = e.tag_id where t.id is null`)).rows[0].n).toBe(0);
    expect((await db.admin.query(`select count(*)::int n from ogevia.caregiver_service_approvals a left join ogevia.caregiver_records r on r.id = a.caregiver_record_id where r.id is null`)).rows[0].n).toBe(0);
    // Enforcement is NOT switched back on by a restore: that is a deliberate act.
    expect((await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s).toMatchObject({ enforcementActive: false });
    // Running it again duplicates nothing.
    await runRestore();
    expect(await snap()).toEqual(restored);
    // The restored revoked approval still does not approve the service (history preserved, not resurrected).
    expect((await db.admin.query("select ogevia.service_approval_status($1,$2,$3, now(), now() + interval '1 hour') s", [w.orgA, rec1, fx.service])).rows[0].s).not.toBe("approved");
  });
});
