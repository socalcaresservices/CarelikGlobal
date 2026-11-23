// LOCAL DEVELOPMENT HARNESS: SYNTHETIC data for the open-shift workflow and texting checks (never used by deployed code).
//   HARNESS_ADMIN_URL=... pnpm --filter @carelik/infra-aws harness:setup && tsx local-harness/seed-open-shift.ts
// Applies the pending migrations 0109-0117 to the LOCAL harness database (as ogevia_owner), then: one office (Temecula), both caregivers in it and assigned to one client, that client's
// service address in Winchester, open-shift alerts and the (mock) texting turned on with quiet hours off, and one open shift two days out. Refuses any non-local database.
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
  for (const f of readdirSync(PENDING).filter((n) => /^01(09|1[0-7])_.*\.sql$/.test(n)).sort()) {
    await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(new URL(f, PENDING), "utf8")); await c.query("reset role"); await c.query("commit");
    console.log("applied", f);
  }
  const org = (await q("select id from ogevia.organizations limit 1"))[0]!.id as string;
  const rec = async (code: string) => (await q("select id from ogevia.caregiver_records where caregiver_code = $1", [code]))[0]!.id as string;
  const [alex, blair] = [await rec("CG-ALEX"), await rec("CG-BLAIR")];
  const owner = persona("owner").sub, manager = persona("manager").sub;
  const office = (await as(owner, () => q("select ogevia_api.create_office($1,'Temecula Office',null) as id", [org])))[0]!.id as string;
  for (const r of [alex, blair]) await as(manager, () => q("select ogevia_api.set_person_offices($1,'caregiver',$2,$3,'{}'::uuid[])", [org, r, office]));
  // a client both caregivers can work, with its service
  const a = (await q(`select ca.client_id, ca.service_id from ogevia.caregiver_assignments ca join ogevia.app_users u on u.id = ca.caregiver_user_id where ca.organization_id = $1 and ca.is_active
                      group by ca.client_id, ca.service_id having count(distinct u.id) >= 2 limit 1`, [org]))[0];
  let client = a?.client_id as string | undefined, service = a?.service_id as string | undefined;
  if (!client) { client = (await q("select id from ogevia.clients where organization_id = $1 order by client_code limit 1", [org]))[0]!.id; service = (await q("select id from ogevia.services where organization_id = $1 limit 1", [org]))[0]!.id; }
  for (const code of ["alex", "blair"]) {
    const uid = (await q("select u.id from ogevia.app_users u where u.cognito_sub = $1", [persona(code).sub]))[0]!.id as string;
    await q("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) select $1,$2,$3,$4,current_date - 30 where not exists (select 1 from ogevia.caregiver_assignments where organization_id=$1 and caregiver_user_id=$2 and client_id=$3 and service_id=$4 and is_active)", [org, uid, client, service]);
  }
  await q("insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values ($1,$2,'92596','Winchester',(select id from ogevia.app_users where cognito_sub = $3))", [org, client, manager]);
  await as(owner, () => q("select ogevia_api.set_cover_notification_settings($1,true,false,true,72,50,'office','Open shift in {city} | {date} | {time}','harness')", [org]));
  await as(owner, () => q("select ogevia_api.set_sms_settings($1,$2::jsonb)", [org, JSON.stringify({ enabled: true, provider: "mock", senderLabel: "Local Demo", senderId: "+19515550100", quietStart: "00:00", quietEnd: "00:00", dailyLimit: 200, hourlyLimit: 60, perRecipientDaily: 5, recruitmentDays: 14, escalationHours: 24 })]));
  const day = (await q("select to_char((now() at time zone 'America/Los_Angeles')::date + 2, 'YYYY-MM-DD') as d"))[0]!.d as string;
  const shift = (await as(manager, () => q("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'05:00'::time,'05:50'::time,null,null)", [org, client, service, day])))[0]!.shift_id as string;
  await q("update ogevia.shifts set coordinating_office_id = $2 where id = $1", [shift, office]);
  console.log("seeded: office, 2 caregivers, Winchester client, open shift", shift);
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
