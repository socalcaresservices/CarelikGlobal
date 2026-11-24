// LOCAL DEVELOPMENT HARNESS: SYNTHETIC data for the client service-location checks (never used by deployed code). Applies the pending migrations 0109-0118 to the LOCAL harness database, then:
//   two offices (Temecula, Murrieta); client "Demo Today A" whose Details city is EMPTY while its service address is Winchester 92596 (the confusing state), no county, no office;
//   another client in the same ZIP already in Riverside County (so a county can be suggested); client "Demo Today B" with a city but NO ZIP; both caregivers in Temecula and assigned to Today A.
// It refuses any non-local database.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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
  for (const f of readdirSync(PENDING).filter((n) => /^01(09|1[0-8])_.*\.sql$/.test(n)).sort()) {
    await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(new URL(f, PENDING), "utf8")); await c.query("reset role"); await c.query("commit");
  }
  const org = (await q("select id from ogevia.organizations limit 1"))[0]!.id as string;
  const owner = persona("owner").sub, manager = persona("manager").sub;
  const rec = async (code: string) => (await q("select id from ogevia.caregiver_records where caregiver_code = $1", [code]))[0]!.id as string;
  const tem = (await as(owner, () => q("select ogevia_api.create_office($1,'Temecula',null) as id", [org])))[0]!.id as string;
  await as(owner, () => q("select ogevia_api.create_office($1,'Murrieta',null) as id", [org]));
  for (const code of ["CG-ALEX", "CG-BLAIR"]) { const r = await rec(code); await as(manager, () => q("select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [org, r, tem])); }
  const byName = async (last: string) => (await q("select client_id as id from ogevia.client_private_names where organization_id = $1 and legal_last_name ilike $2 limit 1", [org, `${last}%`]))[0]!.id as string;
  const mgrId = (await q("select id from ogevia.app_users where cognito_sub = $1", [manager]))[0]!.id as string;
  // fixed demo clients (not random ones): Okafor has room in its authorization for a 50-minute shift
  const [a, b, other] = [await byName("Okafor"), await byName("Tanaka"), await byName("Lindqvist")];
  const name = async (id: string, last: string) => { await q("update ogevia.client_private_names set legal_first_name = 'Demo', legal_last_name = $2 where client_id = $1", [id, last]); };
  await name(a, "Today A"); await name(b, "Today B");
  await q("update ogevia.clients set city = null, service_county = null, responsible_office_id = null where id = $1", [a]);
  await q("delete from ogevia.office_assignments where client_id = any($1::uuid[])", [[a, b]]);
  await q("delete from ogevia.client_service_zip where client_id = any($1::uuid[])", [[a, b, other]]);
  await q("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596','Winchester',$3),($1,$4,'92596','Winchester',$3)", [org, a, mgrId, other]);
  await q("update ogevia.clients set service_county = 'Riverside' where id = $1", [other]);
  await q("update ogevia.clients set city = 'Hemet', responsible_office_id = null, service_county = null where id = $1", [b]);
  // a service the caregivers can work on Today A, assigned to both caregivers
  const service = (await q("select ca.service_id as id from ogevia.caregiver_assignments ca join ogevia.client_authorizations x on x.client_id = ca.client_id and x.service_id = ca.service_id where ca.client_id = $1 and ca.is_active limit 1", [a]))[0]?.id as string
    ?? (await q("select service_id as id from ogevia.client_authorizations where client_id = $1 limit 1", [a]))[0]!.id as string;   // a service this client really has an authorization for
  for (const code of ["alex", "blair"]) {
    const uid = (await q("select u.id from ogevia.app_users u where u.cognito_sub = $1", [persona(code).sub]))[0]!.id as string;
    await q("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) select $1,$2,$3,$4,current_date - 30 where not exists (select 1 from ogevia.caregiver_assignments where organization_id=$1 and caregiver_user_id=$2 and client_id=$3 and service_id=$4 and is_active)", [org, uid, a, service]);
  }
  await as(owner, () => q("select ogevia_api.set_cover_notification_settings($1,true,false,true,72,50,'office','Open shift in {city} | {date} | {time}','harness')", [org]));
  const day = (await q("select to_char((now() at time zone 'America/Los_Angeles')::date + 2, 'YYYY-MM-DD') as d"))[0]!.d as string;
  const shift = (await as(manager, () => q("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'05:00'::time,'05:50'::time,null,null)", [org, a, service, day])))[0]!.shift_id as string;
  console.log(JSON.stringify({ todayA: a, todayB: b, service, shift }));
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
