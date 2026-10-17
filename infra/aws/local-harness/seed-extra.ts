// LOCAL DEVELOPMENT HARNESS: extra SYNTHETIC data for looking at the alert pages, documents and compliance screens.
//   pnpm --filter @carelik/infra-aws harness:setup && pnpm --filter @carelik/infra-aws harness:seed-extra
// Adds, through the real API functions where one exists: CPR/TB rules, documents in every state (due soon, overdue, awaiting review),
// uncovered shifts at several distances (inside and outside 48 hours), approved background checks, hire dates, and a caregiver on a
// compliance hold. It refuses any non-local database. Never used by deployed code.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ADMIN_URL, PERSONAS, assertLocalDatabase, databaseUrl } from "./common.js";

pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));
const sha = "e".repeat(64);

async function main() {
  assertLocalDatabase(ADMIN_URL);
  const c = new pg.Client({ connectionString: databaseUrl() });
  await c.connect();
  const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows as Record<string, any>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!.id as string;
  const persona = (k: string) => PERSONAS.find((p) => p.key === k)!;
  async function as<T>(sub: string, fn: () => Promise<T>): Promise<T> {
    await c.query("begin");
    try {
      await c.query("set local role ogevia_app");
      await c.query("select ogevia_api.begin_request($1,$2)", [sub, randomUUID()]);
      const r = await fn();
      await c.query("commit");
      return r;
    } catch (e) {
      await c.query("rollback");
      throw e;
    }
  }
  const org = await one("select id from ogevia.organizations limit 1");
  const owner = persona("owner").sub;
  const manager = persona("manager").sub;
  const rec = async (code: string) => one("select id from ogevia.caregiver_records where caregiver_code = $1", [code]);
  const [alex, blair, casey, drew] = [await rec("CG-ALEX"), await rec("CG-BLAIR"), await rec("CG-CASEY"), await rec("CG-DREW")];
  const day = async (n: number) => String((await q("select to_char((now() at time zone 'America/Los_Angeles')::date + $1::int, 'YYYY-MM-DD') as d", [n]))[0]!.d);

  // Document types and the agency's CPR/TB rules.
  // The base setup may already have made these types (the recruiting release does); reuse them, create them otherwise.
  const typeId = async (name: string, requiresExpiry: boolean) =>
    (await q("select id from ogevia.document_types where organization_id = $1 and lower(name) = lower($2) limit 1", [org, name]))[0]?.id as string | undefined
    ?? ((await as(manager, () => q("select ogevia_api.create_document_type($1,$2,$3,null) as id", [org, name, requiresExpiry])))[0]!.id as string);
  const cpr = await typeId("CPR card", true);
  const tb = await typeId("TB test result", false);
  await as(owner, () => c.query("select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [org, cpr]));
  await as(owner, () => c.query("select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [org, tb]));
  await as(owner, () => c.query("select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [org]));
  await as(owner, () => c.query("select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [org]));

  async function document(recId: string, type: string, o: { issued?: number; expires?: number | null; verify?: boolean; due?: number }) {
    const doc = (await as(manager, async () => q("select ogevia_api.request_staff_document($1,$2,$3,$4::date,null) as id", [org, recId, type, o.due === undefined ? null : await day(o.due)])))[0]!.id as string;
    if (o.issued === undefined) return doc;
    const version = randomUUID();
    const row = (await as(manager, async () => q("select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [
      doc, version, `${org}/documents/${doc}/${version}`, sha, await day(o.issued!), o.expires === null || o.expires === undefined ? null : await day(o.expires)])))[0]!;
    if (o.verify) await as(owner, () => c.query("select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]));
    return doc;
  }
  await document(alex, cpr, { issued: -300, expires: 20, verify: true }); // due soon (20 days)
  await document(alex, tb, { issued: -30, verify: true });
  await document(blair, cpr, { issued: -300, expires: 60, verify: true });
  await document(blair, tb, { issued: -30, verify: true });
  await document(casey, cpr, { issued: -2, expires: 400, verify: false }); // uploaded, awaiting review (inside the 14 days)
  await document(casey, tb, { due: 6 }); // requested, due in 6 days
  await document(drew, tb, { due: -4 }); // requested and overdue

  // Compliance data: background clearance (a caregiver cannot verify their own), hire dates, availability.
  const verify = (r: string) => as(owner, () => c.query("select ogevia_api.verify_background_check($1,$2,'approved','Agency clearance record (synthetic)')", [org, r]));
  for (const r of [alex, blair, casey]) await verify(r);
  await as(owner, async () => c.query("select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,'Seed')", [org, alex, await day(-200)]));
  await as(owner, async () => c.query("select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,'Seed')", [org, blair, await day(-120)]));
  await as(owner, async () => c.query("select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,'Seed')", [org, casey, await day(-5)]));
  for (const r of [alex, blair, casey, drew]) {
    for (let d = 0; d < 7; d++) await q("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'00:00','23:59')", [org, r, d]);
  }
  // Drew: scheduled before enforcement, no hire date, no clearance, overdue TB.
  const client = await one("select id from ogevia.clients order by created_at limit 1");
  const service = await one("select id from ogevia.services where code = 'RSP'");
  await c.query("set session_replication_role = replica"); // seed-only: shifts at exact instants, no reservation
  const shiftAt = async (hoursFromNow: number, hours: number, caregiver: string | null, calledOut = false) => {
    const id = await one(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,null,$4, now() + make_interval(hours => $5), now() + make_interval(hours => $5 + $6), 'scheduled') returning id`,
      [org, client, service, caregiver, hoursFromNow, hours]);
    if (calledOut) await q("select 1");
    return id;
  };
  await shiftAt(30, 3, drew); // Drew's shift tomorrow (the hold flags it)
  await shiftAt(50, 3, drew);
  await shiftAt(4, 4, null); // uncovered, inside 48 hours
  await shiftAt(20, 3, null); // uncovered, inside 48 hours
  await shiftAt(60, 3, null); // uncovered, day 3
  await shiftAt(120, 4, null); // uncovered, day 5
  await shiftAt(300, 4, null); // uncovered, day 12
  await c.query("set session_replication_role = origin");

  // Switch enforcement on (the owner's switch) and let the run open the hold.
  await as(owner, () => c.query("select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',(select (ogevia_api.get_readiness_status($1)->>'affectedShiftsCount')::int))", [org]));
  await c.query("select ogevia.compliance_sweep($1, null)", [org]);
  const [s] = await q("select (select count(*)::int from ogevia.caregiver_compliance_holds where released_at is null) as holds, (select count(*)::int from ogevia.staff_documents) as docs");
  console.log(`extra seed done: ${s!.docs} documents, ${s!.holds} open compliance hold(s)`);
  await c.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
