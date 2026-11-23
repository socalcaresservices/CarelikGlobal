// LOCAL DEVELOPMENT HARNESS: one more SYNTHETIC client with a visit SCHEDULED FOR TODAY for Alex Caregiver, for looking at the caregiver phone screens
// and for the per-milestone previews. Not part of the default seed (the smoke test counts exactly 7 clients).
//   pnpm --filter @carelik/infra-aws harness:setup && pnpm --filter @carelik/infra-aws harness:seed-today [-- --startable]
// The shift starts about two hours from now (after Alex's other seeded shifts) and is skipped when it would not end on the same local day.
// Created through the real application function (create_shift), so every scheduling rule applies. Refuses any non-local database.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ADMIN_URL, PERSONAS, assertLocalDatabase, databaseUrl } from "./common.js";

pg.types.setTypeParser(1082, (v: string) => v);

async function main() {
  assertLocalDatabase(ADMIN_URL);
  const c = new pg.Client({ connectionString: databaseUrl() });
  await c.connect();
  const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows as Record<string, any>[];
  const persona = (k: string) => PERSONAS.find((p) => p.key === k)!;
  const as = async <T>(sub: string, fn: () => Promise<T>): Promise<T> => {
    await c.query("begin");
    try { await c.query("set local role ogevia_app"); await c.query("select ogevia_api.begin_request($1,$2)", [sub, randomUUID()]); const r = await fn(); await c.query("commit"); return r; }
    catch (e) { await c.query("rollback"); throw e; }
  };
  const org = String((await q("select id from ogevia.organizations limit 1"))[0]!.id);
  const [exists] = await q("select 1 as x from ogevia.client_private_names where legal_first_name = 'Demo' and legal_last_name = 'Today'");
  if (exists) { console.log("Demo Today already exists; nothing to do."); await c.end(); return; }
  const [t] = await q(`select to_char((now() at time zone 'America/Los_Angeles') + interval '125 minutes', 'HH24:MI') as s, to_char((now() at time zone 'America/Los_Angeles') + interval '245 minutes', 'HH24:MI') as e,
    to_char((now() at time zone 'America/Los_Angeles')::date, 'YYYY-MM-DD') as d,
    ((now() at time zone 'America/Los_Angeles')::date = ((now() at time zone 'America/Los_Angeles') + interval '245 minutes')::date) as same_day`);
  if (!t!.same_day) { console.log("It is too late in the day for a shift that ends today; run this earlier."); await c.end(); return; }
  const service = String((await q("select id from ogevia.services where organization_id = $1 and code = 'RSP'", [org]))[0]!.id);
  const owner = persona("owner"), manager = persona("manager"), alex = persona("alex"), blair = persona("blair");
  const client = String((await q("insert into ogevia.clients (organization_id) values ($1) returning id", [org]))[0]!.id);
  await as(owner.sub, () => c.query("select ogevia_api.set_client_legal_name($1,$2,'Demo','Today',null)", [org, client]));
  await q(`insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end, hourly_rate_cents)
           values ($1,$2,$3,'Synthetic Regional Center',2400,(date_trunc('month', now()) - interval '1 month')::date,(date_trunc('month', now()) + interval '3 months')::date,3200)`, [org, client, service]);
  for (const who of [alex, blair]) {
    await q("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) select $1, u.id, $2, $3, (now() - interval '30 days')::date from ogevia.app_users u where u.cognito_sub = $4", [org, client, service, who.sub]);
  }
  const rec = String((await q("select r.id from ogevia.caregiver_records r join ogevia.app_users u on u.id = r.linked_user_id where u.cognito_sub = $1", [alex.sub]))[0]!.id);
  await as(manager.sub, () => c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,null)", [org, client, service, t!.d, t!.s, t!.e, rec]));
  // --startable: move the shift to start in 20 minutes so Start works right now (the server accepts a start up to 60 minutes before a shift). Harness only; it may overlap
  // another seeded shift, which the real scheduling function would refuse. Used for recording previews.
  if (process.argv.includes("--startable")) await c.query("update ogevia.shifts set starts_at = now() + interval '20 minutes', ends_at = now() + interval '140 minutes' where client_id = $1", [client]);
  console.log(`Demo Today: a shift for Alex Caregiver today ${t!.s} to ${t!.e} (Pacific).`);
  await c.end();
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
