// Rolling back 0043 -> 0039 on a POPULATED database keeps every record (archived, count-checked), restores the
// previous behaviour of each function, and the release can be re-applied. SYNTHETIC data only.
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
    await db.admin.query(
      `insert into ogevia.availability_overrides (organization_id, caregiver_record_id, client_id, range_start, range_end, reason, authorised_by, expires_at, original_status)
       values ($1,$2,$3, now(), now() + interval '2 hours', $4, $5, now() + interval '30 minutes', 'outside')`, [w.orgA, rec1, fx.client, 'Phone agreement', w.ownerA.userId]);
    // 0043: tags, experience, ZIPs and a rule.
    const tag = (await call(w.managerA, "select ogevia_api.create_experience_tag($1,'ABA experience') as id", [w.orgA]))[0].id;
    await call(w.managerA, "select ogevia_api.review_caregiver_experience($1,$2,$3::uuid[],'ok')", [w.orgA, rec1, `{${tag}}`]);
    await call(w.managerA, "select ogevia_api.set_caregiver_zip($1,$2,'90210')", [w.orgA, rec1]);
    const before = {
      shifts: (await db.admin.query("select count(*)::int n from ogevia.shifts")).rows[0].n,
      approvals: (await db.admin.query("select count(*)::int n from ogevia.caregiver_service_approvals")).rows[0].n,
      audit: (await db.admin.query("select count(*)::int n from ogevia.audit_events")).rows[0].n,
    };
    for (const f of ["0066_compliance_shift_document_risks", "0065_office_assignment_authorization_recheck", "0064_compliance_hold_history_and_alerts", "0063_open_shift_pickup_requires_confirmation", "0062_billing_states", "0061_recurring_save_valid_report_rejected", "0060_agency_work_hour_limits", "0059_attention_boundary_review_clock", "0058_attention_tiers_separate_queues", "0057_authorization_tiers_unclamped_balances", "0056_attention_streams_appearance", "0055_caregiver_compliance_hold", "0054_recruiting_onboarding_checklist", "0053_scheduling_patterns_hour_limits_makeup", "0052_reservation_not_counted_when_review_visit_counted_as_used", "0051_wave1_open_shift_pickup", "0050_wave1_visit_review_and_variance_rule", "0049_reservation_not_counted_when_late_confirmation_accepted", "0048_account_status_enable_disable", "0047_availability_override_one_shift", "0046_visit_start_availability", "0045_manual_care_offer", "0044_readiness_review", "0043_explainable_matching", "0042_readiness_gate", "0041_required_documents", "0040_caregiver_service_approvals", "0039_availability_approval"]) {
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
      expect((await migrate(client)).applied.map((x) => x.slice(0, 4))).toEqual(["0039", "0040", "0041", "0042", "0043", "0044", "0045", "0046", "0047", "0048", "0049", "0050", "0051", "0052", "0053", "0054", "0055", "0056", "0057", "0058", "0059", "0060", "0061", "0062", "0063", "0064", "0065", "0066"]);
    } finally {
      client.release();
    }
    const status = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
    expect(status).toMatchObject({ enforcementActive: false, serviceChecks: { state: "Off" } });
    // Reapplication creates operational tables; it does NOT restore archived
    // records. Archives are plain copies without the live dependency constraints.
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_service_approvals")).rows[0].n).toBe(0);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_experience")).rows[0].n).toBe(0);
    expect((await db.admin.query(`select count(*)::int n from ogevia.${arch}`)).rows[0].n).toBe(before.approvals);
    expect((await db.admin.query("select count(*)::int n from pg_constraint where conrelid=$1::regclass", [`ogevia.${arch}`])).rows[0].n).toBe(0);
    expect((await db.admin.query(`select count(*)::int n from ogevia.${arch} a join ogevia.caregiver_records c on c.id=a.caregiver_record_id join ogevia.services s on s.id=a.service_id`)).rows[0].n).toBe(before.approvals);
  });
});
