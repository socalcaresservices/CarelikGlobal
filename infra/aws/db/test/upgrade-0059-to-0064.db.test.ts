// Upgrade and rollback rehearsal for 0060-0072 on a POPULATED database at 0059: shifts, a recurring series with reservations, a signed and approved visit,
// a compliance hold and a background check already exist. The real runner applies 0060-0072; nothing stored changes; the old data reads correctly through the
// new functions; then the rollbacks run in reverse order and the same data is still there. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrations.js";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, signedVisit, type TestDb, type World } from "./harness.js";

const DOWN = new URL("../rollback/", import.meta.url);
const NEW = ["0060_agency_work_hour_limits", "0061_recurring_save_valid_report_rejected", "0062_billing_states", "0063_open_shift_pickup_requires_confirmation", "0064_compliance_hold_history_and_alerts", "0065_office_assignment_authorization_recheck", "0066_compliance_shift_document_risks", "0067_reservation_buckets_and_reconciliation", "0068_authorization_amendment_impacts", "0069_report_export_permission_and_audit", "0070_monthly_chain_report", "0071_authorization_decrease_review_and_delivered_unverified", "0072_export_request_and_generation"];
let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 100000);
});
afterAll(async () => db?.drop());

async function runDown(name: string) {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role ogevia_owner");
    await c.query(readFileSync(new URL(`${name}.down.sql`, DOWN), "utf8"));
    await c.query("reset role");
    await c.query("delete from ogevia_meta.schema_migrations where version = $1", [name.slice(0, 4)]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
const TABLES: Record<string, string> = {
  shifts: "to_jsonb(t)", authorization_reservations: "to_jsonb(t)", shift_series: "to_jsonb(t)", shift_series_skipped_dates: "to_jsonb(t)", service_visits: "to_jsonb(t)",
  billing_approvals: "to_jsonb(t)", caregiver_compliance_holds: "to_jsonb(t)", caregiver_background_checks: "to_jsonb(t)", client_authorizations: "to_jsonb(t)", caregiver_hour_limits: "to_jsonb(t)",
};
async function fingerprints() {
  const out: Record<string, string> = {};
  for (const [t, expr] of Object.entries(TABLES)) {
    const r = await db.admin.query(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from (select ${expr} x from ogevia.${t} t) s`);
    out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}

describe("0059 -> 0072 and back, on a populated database", () => {
  it("applies 0060-0072 without changing a stored row, reads the old data through the new functions, and rolls back in reverse order keeping the data", async () => {
    const today = await orgToday(db);
    const iso = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
    const iso0 = iso;
    void iso0;
    const rec = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id as string;
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    // data as it exists at 0059
    const rollbackTo0059 = [...NEW].reverse();
    for (const n of rollbackTo0059) await runDown(n);
    expect((await db.admin.query("select max(version) v from ogevia_meta.schema_migrations")).rows[0].v).toBe("0059");
    await asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'11:00'::time,$5,null)", [w.orgA, f.client, f.service, iso(5), rec]));
    const series = await asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.create_shift_series($1,$2,$3,null,$4::smallint[],'13:00'::time,'15:00'::time,$5::date,$6::date,'refuse',$7,null)",
      [w.orgA, f.client, f.service, [1, 3], iso(10), iso(24), randomUUID()])).rows[0]);
    expect(series.created).toBeGreaterThan(0);
    const { visit } = await signedVisit(db, w.caregiverA1, w, 30, w.orgA, f.client, f.service);
    const approval = await asActor(db, w.managerA.sub, async (c) => (await c.query("select ogevia_api.approve_visit_for_billing($1, 30, null, null) as id", [visit])).rows[0].id as string);
    await db.admin.query("insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at) values ($1,$2,'completed','approved','Synthetic fixture clearance',$3,now()) on conflict (caregiver_record_id) do update set status = 'completed', result = 'approved', evidence_note = 'Synthetic fixture clearance', verified_by = excluded.verified_by, verified_at = excluded.verified_at", [rec, w.orgA, w.ownerA.userId]);
    await db.admin.query("insert into ogevia.caregiver_compliance_holds (organization_id, caregiver_record_id, reasons, grace_closed) values ($1,$2,'[{\"requirement\":\"cpr\",\"code\":\"missing_after_deadline\",\"message\":\"CPR missing\",\"dueDate\":null}]'::jsonb, true)", [w.orgA, rec]);
    const before = await fingerprints();

    const c = await db.admin.connect();
    let applied: string[];
    try { applied = (await migrate(c)).applied.map((x) => x.slice(0, 4)); } finally { c.release(); }
    expect(applied).toEqual(["0060", "0061", "0062", "0063", "0064", "0065", "0066", "0067", "0068", "0069", "0070", "0071", "0072"]);
    expect(await fingerprints()).toEqual(before); // nothing stored changed

    // old data reads correctly through the new functions
    const state = (await db.admin.query("select ogevia.visit_billing_state($1) s", [visit])).rows[0].s;
    expect(state).toBe("approved_for_billing");
    const row = (await asActor(db, w.managerA.sub, async (c2) => (await c2.query("select * from ogevia_api.list_billing_review_visits($1, $2::date - 3, $2::date + 3)", [w.orgA, today])).rows)).find((r) => r.visit_id === visit);
    expect(row).toMatchObject({ billing_state: "approved_for_billing", active_approval_id: approval });
    const hold = (await db.admin.query("select count(*)::int n from ogevia.caregiver_compliance_holds where released_at is null")).rows[0].n;
    expect(hold).toBe(1);
    expect((await asActor(db, w.managerA.sub, async (c2) => (await c2.query("select * from ogevia_api.get_work_hour_policy($1)", [w.orgA])).rows))[0]).toMatchObject({ applies: false }); // slug is 'org-a': no policy
    // the new history starts empty and is kept from now on
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_background_check_events")).rows[0].n).toBe(0);
    await db.admin.query("update ogevia.caregiver_background_checks set status = 'needs_attention', result = null, verified_by = null, verified_at = null where caregiver_record_id = $1", [rec]);
    expect((await db.admin.query("select event from ogevia.caregiver_background_check_events where caregiver_record_id = $1", [rec])).rows.map((r) => r.event)).toEqual(["changed"]);
    await db.admin.query("update ogevia.caregiver_background_checks set status = 'completed', result = 'approved', verified_by = $2, verified_at = now() where caregiver_record_id = $1", [rec, w.ownerA.userId]);
    await expect(db.admin.query("delete from ogevia.caregiver_background_check_events")).rejects.toThrow(); // append-only
    const mid = await fingerprints();

    // roll back in reverse order: the stored data is still there, only the new objects go
    for (const n of [...NEW].reverse()) await runDown(n);
    expect((await db.admin.query("select max(version) v from ogevia_meta.schema_migrations")).rows[0].v).toBe("0059");
    expect(await fingerprints()).toEqual(mid);
    const gone = (await db.admin.query(`select to_regclass('ogevia.shift_pickup_requests') a, to_regclass('ogevia.agency_work_hour_policies') b, to_regclass('ogevia.caregiver_background_check_events') c,
      to_regprocedure('ogevia.visit_billing_state(uuid)') d`)).rows[0];
    expect(gone).toEqual({ a: null, b: null, c: null, d: null });
    // the 0059 behaviour is back: the caregiver self-assigns again, series default to refuse
    const open = await asActor(db, w.managerA.sub, async (c2) => (await c2.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'16:00'::time,'18:00'::time,null,null)",
      [w.orgA, (await db.admin.query("select client_id from ogevia.shifts limit 1")).rows[0].client_id, (await db.admin.query("select service_id from ogevia.shifts limit 1")).rows[0].service_id, iso(6)])).rows[0]);
    expect(open.shift_id).toBeTruthy();
    // and the upgrade can be applied again
    const c3 = await db.admin.connect();
    try { expect((await migrate(c3)).applied.map((x) => x.slice(0, 4))).toEqual(["0060", "0061", "0062", "0063", "0064", "0065", "0066", "0067", "0068", "0069", "0070", "0071", "0072"]); } finally { c3.release(); }
    expect((await db.admin.query("select ogevia.visit_billing_state($1) s", [visit])).rows[0].s).toBe("approved_for_billing");
  });
});
