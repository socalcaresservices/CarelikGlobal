// The TEST baseline is migration 0052. This rehearses the whole path from it on a POPULATED database: data written while the schema was at 0052 (an assigned and an open shift, a
// signed and approved visit, an authorization amendment), then the real runner applies every later migration (0053 through the final one); nothing stored changes; the old data
// reads correctly through the new functions (issue list, readiness, shift states, full chain, exports); then every supported rollback runs in reverse order, the stored data is
// still there, and the upgrade applies again. SYNTHETIC data only.
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrations.js";
import { asActor, createTestDb, freshClient, orgToday, seedWorld, signedVisit, type TestDb, type World } from "./harness.js";

const DOWN = new URL("../rollback/", import.meta.url);
const UP = new URL("../migrations/", import.meta.url);
const BASELINE = "0052";
const LATER = readdirSync(UP).filter((f) => f.endsWith(".sql") && f.slice(0, 4) > BASELINE).map((f) => f.replace(/\.sql$/, "")).sort();
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
const TABLES = ["shifts", "authorization_reservations", "service_visits", "visit_confirmations", "billing_approvals", "client_authorizations", "clients", "caregiver_assignments", "audit_events"];
/** The columns each table had on the baseline. Later migrations may ADD nullable columns; the values of the baseline columns must not change. */
const BASELINE_COLUMNS: Record<string, string[]> = {};
async function captureBaselineColumns() {
  for (const t of TABLES) {
    BASELINE_COLUMNS[t] = (await db.admin.query("select column_name c from information_schema.columns where table_schema = 'ogevia' and table_name = $1 order by ordinal_position", [t])).rows.map((r) => r.c as string);
  }
}
async function fingerprints() {
  const out: Record<string, string> = {};
  for (const t of TABLES) {
    const r = await db.admin.query(
      `select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from (select (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(t)) e(k, v) where k = any($1::text[])) x from ogevia.${t} t) s`, [BASELINE_COLUMNS[t]]);
    out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}
const version = async () => (await db.admin.query("select max(version) v from ogevia_meta.schema_migrations")).rows[0].v as string;

describe(`${BASELINE} -> final and back, on a populated database`, () => {
  it("has a rollback for every later migration, applies them all without changing a stored row, reads the old data through the new functions, rolls back keeping the data and applies again", async () => {
    expect(LATER.length).toBeGreaterThanOrEqual(24);
    for (const n of LATER) expect(() => readFileSync(new URL(`${n}.down.sql`, DOWN), "utf8"), `rollback for ${n}`).not.toThrow();
    const today = await orgToday(db);
    const iso = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
    const rec = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id as string;
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    for (const n of [...LATER].reverse()) await runDown(n);
    expect(await version()).toBe(BASELINE);
    await captureBaselineColumns();

    // data as it exists on the TEST baseline
    const assigned = await asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'11:00'::time,$5,null)", [w.orgA, f.client, f.service, iso(5), rec])).rows[0]);
    const open = await asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'13:00'::time,'15:00'::time,null,null)", [w.orgA, f.client, f.service, iso(6)])).rows[0]);
    const { visit } = await signedVisit(db, w.caregiverA1, w, 30, w.orgA, f.client, f.service);
    const approval = await asActor(db, w.managerA.sub, async (c) => (await c.query("select ogevia_api.approve_visit_for_billing($1, 30, null, null) as id", [visit])).rows[0].id as string);
    await asActor(db, w.ownerA.sub, (c) => c.query("select * from ogevia_api.amend_client_authorization($1,$2,$3::date,$4::date,'SYNTHETIC-PAYER','Synthetic amendment at 0052')", [f.auth, 25000, iso(-40), iso(200)]));
    const before = await fingerprints();

    const c = await db.admin.connect();
    let applied: string[];
    try { applied = (await migrate(c)).applied.map((x) => x.slice(0, 4)); } finally { c.release(); }
    expect(applied).toEqual(LATER.map((n) => n.slice(0, 4)));
    expect(await version()).toBe(LATER[LATER.length - 1]!.slice(0, 4));
    expect(await fingerprints()).toEqual(before); // nothing stored changed

    // the old data reads correctly through the new functions
    expect((await db.admin.query("select ogevia.visit_billing_state($1) s", [visit])).rows[0].s).toBe("approved_for_billing");
    const bucket = (await db.admin.query("select ogevia.reservation_bucket(r.id) b from ogevia.authorization_reservations r where r.shift_id = $1", [open.shift_id])).rows[0].b;
    expect(bucket).toBe("ahead");
    const issues = await asActor(db, w.managerA.sub, async (c2) => (await c2.query("select ogevia_api.list_action_issues($1,null,null,null,null,null,null,200,0) as r", [w.orgA])).rows[0].r);
    expect(issues.counts.total).toBeGreaterThanOrEqual(0);
    expect(issues.issues.every((i: any) => typeof i.issueKey === "string")).toBe(true);
    const ready = await asActor(db, w.managerA.sub, async (c2) => (await c2.query("select ogevia_api.get_client_readiness($1,$2) as r", [w.orgA, f.client])).rows[0].r);
    expect(ready).toMatchObject({ stage: "active", canSchedule: true });
    const shifts = await asActor(db, w.managerA.sub, async (c2) => (await c2.query("select * from ogevia_api.list_shifts($1,$2::date - 1,$2::date + 14,$3)", [w.orgA, today, f.client])).rows);
    expect(shifts.find((s) => s.shift_id === open.shift_id)).toMatchObject({ display_state: "needs_coverage" });
    expect(shifts.find((s) => s.shift_id === assigned.shift_id)).toMatchObject({ display_state: "covered" });
    const chain = await asActor(db, w.managerA.sub, async (c2) => (await c2.query("select * from ogevia_api.get_monthly_chain_report($1, date_trunc('month', $2::date)::date, $3)", [w.orgA, today, f.client])).rows);
    expect(chain.length).toBeGreaterThan(0);
    const exp = await asActor(db, w.managerA.sub, async (c2) => (await c2.query("select ogevia_api.request_report_export($1,'billing_review','{}'::jsonb) as r", [w.orgA])).rows[0].r);
    expect(exp.exportId).toBeTruthy();
    expect(approval).toBeTruthy();
    // reading changed no stored row of the baseline tables; requesting an export is audited, so the audit log gains exactly that one event
    const mid = await fingerprints();
    const { audit_events: auditBefore, ...restBefore } = before;
    const { audit_events: auditMid, ...restMid } = mid;
    expect(restMid).toEqual(restBefore);
    expect(Number(auditMid!.split(":")[0])).toBe(Number(auditBefore!.split(":")[0]) + 1);

    // roll back in reverse order: the stored data is still there, only the new objects go
    for (const n of [...LATER].reverse()) await runDown(n);
    expect(await version()).toBe(BASELINE);
    expect(await fingerprints()).toEqual(mid);
    const gone = (await db.admin.query(`select to_regclass('ogevia.action_issue_state') a, to_regclass('ogevia.client_documents') b, to_regclass('ogevia.shift_reconciliations') c,
      to_regprocedure('ogevia.visit_billing_state(uuid)') d, to_regprocedure('ogevia_api.list_action_issues(uuid,text,text,text,uuid,uuid,uuid,integer,integer)') e`)).rows[0];
    expect(gone).toEqual({ a: null, b: null, c: null, d: null, e: null });
    // the baseline behaviour is back, and the upgrade can be applied again
    const again = await asActor(db, w.managerA.sub, async (c2) => (await c2.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'16:00'::time,'18:00'::time,null,null)", [w.orgA, f.client, f.service, iso(7)])).rows[0]);
    expect(again.shift_id).toBeTruthy();
    const c3 = await db.admin.connect();
    try { expect((await migrate(c3)).applied.map((x) => x.slice(0, 4))).toEqual(LATER.map((n) => n.slice(0, 4))); } finally { c3.release(); }
    expect((await db.admin.query("select ogevia.visit_billing_state($1) s", [visit])).rows[0].s).toBe("approved_for_billing");
    void randomUUID;
  }, 240000);
});
