// LOCAL DEVELOPMENT HARNESS: tries to schedule ONE shift for a named caregiver through the real ogevia_api.create_shift (the same server checks as the app) and prints a JSON result.
//   tsx local-harness/schedule-probe.ts <first name> <last name> <days ahead>
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ADMIN_URL, PERSONAS, assertLocalDatabase, databaseUrl } from "./common.js";

async function main() {
  assertLocalDatabase(ADMIN_URL);
  const [first, last, ahead] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? 3)];
  const c = new pg.Client({ connectionString: databaseUrl() }); await c.connect();
  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows as Record<string, any>[];
  const org = (await q("select id from ogevia.organizations limit 1"))[0]!.id as string;
  const rec = (await q("select id from ogevia.caregiver_records where first_name = $1 and last_name = $2 and deleted_at is null", [first, last]))[0]!.id as string;
  const pick = (await q(`select a.client_id, a.service_id from ogevia.client_authorizations a where a.organization_id = $1 and a.period_start <= current_date and a.period_end >= current_date + 30 order by a.client_id limit 1`, [org]))[0]!;
  const manager = PERSONAS.find((p) => p.key === "manager")!.sub;
  await c.query("begin");
  try {
    await c.query("set local role ogevia_app"); await c.query("select ogevia_api.begin_request($1,$2)", [manager, randomUUID()]);
    const r = await q("select * from ogevia_api.create_shift($1,$2,$3,(current_date + $4::int)::date,'09:00'::time,'10:00'::time,$5,null)", [org, pick.client_id, pick.service_id, ahead, rec]);
    await c.query("commit");
    console.log(JSON.stringify({ ok: true, shift: r[0]!.shift_id }));
  } catch (e) { await c.query("rollback"); console.log(JSON.stringify({ ok: false, message: (e as Error).message })); }
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
