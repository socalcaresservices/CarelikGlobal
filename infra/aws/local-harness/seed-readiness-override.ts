// LOCAL DEVELOPMENT HARNESS: SYNTHETIC data for the admin-override checks (0123). Never used by deployed code. Refuses any non-local database.
//   after `harness:setup`:  tsx local-harness/seed-readiness-override.ts
// Applies the pending migrations 0122 and 0123 (and 0103 if the harness database lacks it), makes sure CPR and TB are configured, ACTIVATES readiness enforcement, then creates:
//   Elena Expired: admin-approved for work, TB current, CPR was current and has now EXPIRED (the calendar moved)          -> Expired Doc, Blocked
//   Nora Neverapproved: every hard requirement met, hired 90 days ago, TB current, NO CPR on file, NOT approved for work -> Missing Doc, Blocked, no work approval yet
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { ADMIN_URL, PERSONAS, assertLocalDatabase, databaseUrl } from "./common.js";

const PENDING = new URL("../db/pending/migrations/", import.meta.url);
async function main() {
  assertLocalDatabase(ADMIN_URL);
  const c = new pg.Client({ connectionString: databaseUrl() }); await c.connect();
  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows as Record<string, any>[];
  const persona = (k: string) => PERSONAS.find((p) => p.key === k)!;
  async function as<T>(sub: string, fn: () => Promise<T>): Promise<T> {
    await c.query("begin");
    try { await c.query("set local role ogevia_app"); await c.query("select ogevia_api.begin_request($1,$2)", [sub, randomUUID()]); const r = await fn(); await c.query("commit"); return r; }
    catch (e) { await c.query("rollback"); throw e; }
  }
  const apply = async (f: string) => { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(new URL(f, PENDING), "utf8")); await c.query("reset role"); await c.query("commit"); console.log("applied", f); };
  if (!(await q("select to_regclass('ogevia.caregiver_signin_overrides') as t"))[0]!.t) await apply("0103_caregiver_signin_override.sql");
  if (!(await q("select to_regprocedure('ogevia.caregiver_has_work_approval(uuid,uuid)') as t"))[0]!.t) await apply("0122_unset_cpr_tb_type_not_a_block.sql");
  if (!(await q("select to_regclass('ogevia.caregiver_readiness_overrides') as t"))[0]!.t) await apply("0123_readiness_override.sql");
  const org = (await q("select id from ogevia.organizations limit 1"))[0]!.id as string;
  const owner = persona("owner").sub, manager = persona("manager").sub;

  // CPR and TB configured, then enforcement ON (the app refuses to activate it until both are set up)
  const typeFor = async (req: string) => (await q("select id from ogevia.document_types where organization_id = $1 and work_requirement = $2 and is_active", [org, req]))[0]?.id as string | undefined;
  let cpr = await typeFor("cpr"), tb = await typeFor("tb");
  if (!cpr) { cpr = (await as(owner, () => q("select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [org])))[0]!.id as string; await as(owner, () => q("select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [org, cpr])); }
  if (!tb) { tb = (await as(owner, () => q("select ogevia_api.create_document_type($1,'TB result',false,null) as id", [org])))[0]!.id as string; await as(owner, () => q("select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [org, tb])); }
  if (!(await q("select 1 from ogevia.document_requirement_policies where organization_id = $1 and requirement = 'cpr'", [org])).length) await as(owner, () => q("select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [org]));
  if (!(await q("select 1 from ogevia.document_requirement_policies where organization_id = $1 and requirement = 'tb'", [org])).length) await as(owner, () => q("select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [org]));
  const st = (await as(owner, () => q("select ogevia_api.get_readiness_status($1) as s", [org])))[0]!.s as { enforcementActive: boolean; affectedShiftsCount: number };
  if (!st.enforcementActive) await as(owner, () => q("select ogevia_api.activate_readiness_enforcement($1,'Local harness: enforcement on for the override checks',$2)", [org, st.affectedShiftsCount]));

  const day = (n: number) => `(current_date + ${n})`;
  async function readyCaregiver(first: string, last: string, hireDaysAgo: number) {
    const rec = (await as(manager, () => q("select * from ogevia_api.create_caregiver($1,$2,$3,null,'onboarding',null)", [org, first, last])))[0]!.caregiver_record_id as string;
    await as(owner, () => q("select ogevia_api.verify_background_check($1,$2,'approved','Synthetic clearance on file',null)", [org, rec]));
    await as(manager, () => q("select ogevia_api.record_onboarding_item($1,$2,'training','complete',current_date,null,null,null)", [org, rec]));
    await q(`update ogevia.caregiver_records set hire_date = current_date - ${hireDaysAgo} where id = $1`, [rec]);
    for (const d of [0, 1, 2, 3, 4, 5, 6]) await q("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'00:00','23:59')", [org, rec, d]);
    await as(owner, () => q("select ogevia_api.approve_signin_override($1,$2,'Local harness: not invited, scheduled for the override checks')", [org, rec]));
    return rec;
  }
  async function document(rec: string, type: string, issued: number, expires: number | null) {
    const doc = (await as(manager, () => q("select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [org, rec, type])))[0]!.id as string;
    const version = randomUUID();
    const row = (await as(owner, () => q("select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,($5)::date,($6)::date,null)",
      [doc, version, `${org}/documents/${doc}/${version}`, "c".repeat(64), `${new Date(Date.now() + issued * 864e5).toISOString().slice(0, 10)}`, expires === null ? null : `${new Date(Date.now() + expires * 864e5).toISOString().slice(0, 10)}`])))[0]!;
    await as(owner, () => q("select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]));
    return row.document_version_id as string;
  }
  const elena = await readyCaregiver("Elena", "Expired", 60);
  await document(elena, tb, -10, 300);   // the harness TB policy measures validity from the document's own expiry date
  const cprVersion = await document(elena, cpr, -30, 10);
  await as(owner, () => q("select ogevia_api.approve_caregiver_for_work($1,$2,$3)", [org, elena, randomUUID()]));
  await c.query("begin"); await c.query("set local session_replication_role = replica");            // the calendar moves: the approved caregiver's card has now expired
  await c.query("update ogevia.document_versions set expires_on = current_date - 1 where id = $1", [cprVersion]); await c.query("commit");
  const nora = await readyCaregiver("Nora", "Neverapproved", 90);
  await document(nora, tb, -10, 300);
  void day;
  console.log("seeded: Elena Expired (approved, CPR expired), Nora Neverapproved (not approved, no CPR); enforcement on");
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
