// Upgrade rehearsal: a POPULATED database at migration 0049 (visits already signed, one in review, one unscheduled and
// signed under the old rules) is upgraded to 0052 with the real runner. Proves what the Wave 1 migrations do to existing
// visit data: no stored row changes, old visits stay readable through the new outcome function with correct reasons, and
// the authorization position of those clients does not move. SYNTHETIC data only.
// (Closes catalog IDs VIS-21b, VIS-27 and MIG-W1c; the 0046-to-0048 rehearsal covers the earlier migrations.)
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrations.js";
import { api, asActor, createTestDb, endedVisit, freshClient, orgToday, seedWorld, type TestDb, type World } from "./harness.js";

const DOWN = new URL("../rollback/", import.meta.url);
let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb(); // 0001-0072
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

async function runDown(file: string) {
  const client = await db.admin.connect();
  try {
    await client.query("begin");
    await client.query("set local role ogevia_owner");
    await client.query(readFileSync(new URL(file, DOWN), "utf8"));
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

/** Fingerprint of existing rows on the columns that existed at 0049 (columns added by 0050 do not count as a change). */
const TABLES: Record<string, string> = {
  service_visits: "to_jsonb(t) - 'unscheduled_reason'",
  visit_confirmations: "to_jsonb(t) - 'attestation_version'",
  visit_evidence: "to_jsonb(t)",
  shifts: "to_jsonb(t) - 'makeup_for_shift_id'",
  authorization_reservations: "to_jsonb(t)",
  client_authorizations: "to_jsonb(t)",
  audit_events: "to_jsonb(t)",
};
async function fingerprints() {
  const out: Record<string, { rows: number; hash: string }> = {};
  for (const [table, expr] of Object.entries(TABLES)) {
    const r = await db.admin.query(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from (select ${expr} x from ogevia.${table} t) s`);
    out[table] = { rows: r.rows[0].n, hash: r.rows[0].h };
  }
  return out;
}
const position = async (lineage: string, day: string) =>
  (await db.admin.query("select ogevia.authorization_month_usage($1,$2::date,null)::int used, ogevia.authorization_month_reserved($1,$2::date)::int reserved", [lineage, day])).rows[0];

describe("upgrade from 0049 to 0052 on a populated database", () => {
  it("changes no existing row; old visits stay readable with correct reasons; authorization position does not move; the runner applies exactly 0050, 0051, 0052, 0053, 0054, 0055 and 0056", async () => {
    const cg = w.caregiverA1;
    const f = await freshClient(db, w, cg, 600);
    // Three visits as the 0049 rules produced them: signed on a shift, in review (client could not sign), and an
    // unscheduled visit that the old rules left SIGNED (made here as unscheduled, then put into its old-world state).
    const signed = await endedVisit(db, cg, w, 60, w.orgA, f.client, f.service);
    await api.confirm(db, cg, signed, { evidence: await api.registerEvidence(db, cg, w.orgA, signed) });
    const noSigner = await endedVisit(db, cg, w, 30, w.orgA, f.client, f.service);
    await api.confirm(db, cg, noSigner, { method: "unable_to_confirm", reason: "Synthetic: client asleep" });
    const unscheduled = await endedVisit(db, cg, w, 20, w.orgA, f.client, f.service, "Synthetic: not on my schedule");
    await api.confirm(db, cg, unscheduled, { evidence: await api.registerEvidence(db, cg, w.orgA, unscheduled) });
    // Remove everything that did not exist before 0050 (what a database that never ran 0050 would not have), as the test
    // owner: rule evaluations, reasons, attestation versions; and put the unscheduled visit in its 0049 state (signed).
    await db.admin.query("set session_replication_role = replica");
    await db.admin.query("delete from ogevia.visit_rule_evaluations");
    await db.admin.query("update ogevia.visit_confirmations set attestation_version = null");
    await db.admin.query("update ogevia.service_visits set unscheduled_reason = null where unscheduled_reason is not null");
    await db.admin.query("update ogevia.service_visits set status = 'signed' where id = $1", [unscheduled]);
    await db.admin.query("set session_replication_role = origin");
    const statusBefore = Object.fromEntries((await db.admin.query("select id, status::text s, billable_minutes b from ogevia.service_visits where id = any($1)", [[signed, noSigner, unscheduled]])).rows.map((r) => [r.id, [r.s, r.b]]));

    for (const file of ["0072_export_request_and_generation.down.sql", "0071_authorization_decrease_review_and_delivered_unverified.down.sql", "0070_monthly_chain_report.down.sql", "0069_report_export_permission_and_audit.down.sql", "0068_authorization_amendment_impacts.down.sql", "0067_reservation_buckets_and_reconciliation.down.sql", "0066_compliance_shift_document_risks.down.sql", "0065_office_assignment_authorization_recheck.down.sql", "0064_compliance_hold_history_and_alerts.down.sql", "0063_open_shift_pickup_requires_confirmation.down.sql", "0062_billing_states.down.sql", "0061_recurring_save_valid_report_rejected.down.sql", "0060_agency_work_hour_limits.down.sql", "0059_attention_boundary_review_clock.down.sql", "0058_attention_tiers_separate_queues.down.sql", "0057_authorization_tiers_unclamped_balances.down.sql", "0056_attention_streams_appearance.down.sql", "0055_caregiver_compliance_hold.down.sql", "0054_recruiting_onboarding_checklist.down.sql", "0053_scheduling_patterns_hour_limits_makeup.down.sql", "0052_reservation_not_counted_when_review_visit_counted_as_used.down.sql", "0051_wave1_open_shift_pickup.down.sql", "0050_wave1_visit_review_and_variance_rule.down.sql"]) await runDown(file);
    expect((await db.admin.query("select max(version) v from ogevia_meta.schema_migrations")).rows[0].v).toBe("0049");
    const day = await orgToday(db);
    const lineage = (await db.admin.query("select lineage_id from ogevia.client_authorizations where id = $1", [f.auth])).rows[0].lineage_id as string;
    const before = await fingerprints();
    const positionBefore = await position(lineage, day);
    expect(before.service_visits!.rows).toBeGreaterThanOrEqual(3);

    const client = await db.admin.connect();
    let applied: string[];
    try { applied = (await migrate(client)).applied.map((x) => x.slice(0, 4)); } finally { client.release(); }
    expect(applied).toEqual(["0050", "0051", "0052", "0053", "0054", "0055", "0056", "0057", "0058", "0059", "0060", "0061", "0062", "0063", "0064", "0065", "0066", "0067", "0068", "0069", "0070", "0071", "0072"]);

    // No stored row changed or disappeared, in any table that holds visit or authorization data.
    expect(await fingerprints()).toEqual(before);
    expect(Object.fromEntries((await db.admin.query("select id, status::text s, billable_minutes b from ogevia.service_visits where id = any($1)", [[signed, noSigner, unscheduled]])).rows.map((r) => [r.id, [r.s, r.b]]))).toEqual(statusBefore);
    // The authorization position of the client does not move (no visit here is a review visit with billable minutes).
    expect(await position(lineage, day)).toEqual(positionBefore);

    // Old visits are readable through the new outcome function with correct, derived reasons; nothing is invented for them.
    const outcome = async (v: string) => (await asActor(db, cg.sub, async (c) => (await c.query("select * from ogevia_api.get_visit_outcome($1)", [v])).rows))[0];
    expect(await outcome(signed)).toMatchObject({ status: "signed", review_reasons: [], unscheduled_reason: null, attestation_version: null, rule_outcome: null });
    expect(await outcome(noSigner)).toMatchObject({ status: "administrator_review", billable_minutes: 0, review_reasons: ["no_client_signature"], attestation_version: null });
    expect(await outcome(unscheduled)).toMatchObject({ status: "signed", review_reasons: [], unscheduled_reason: null });
    // The office list still reads them.
    const listed = await asActor(db, w.managerA.sub, async (c) => (await c.query("select id, status::text s from ogevia_api.list_service_visits($1)", [w.orgA])).rows);
    expect(listed.filter((r) => [signed, noSigner, unscheduled].includes(r.id)).length).toBe(3);
    // Re-running changes nothing, and the fingerprint is not vacuous.
    const again = await db.admin.connect();
    try { expect((await migrate(again)).applied).toEqual([]); } finally { again.release(); }
    expect(await fingerprints()).toEqual(before);
    await db.admin.query("set session_replication_role = replica"); // a submitted visit is locked by a trigger; bypass it for this probe only
    await db.admin.query("update ogevia.service_visits set worked_minutes = worked_minutes + 1 where id = $1", [signed]);
    await db.admin.query("set session_replication_role = origin");
    expect((await fingerprints()).service_visits!.hash).not.toBe(before.service_visits!.hash);
  });
});
