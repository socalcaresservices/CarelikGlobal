// LOCAL DEVELOPMENT HARNESS: deterministic SYNTHETIC fixtures for the browser scenarios (owner request 2026-10-17, item 5).
//   pnpm --filter @carelik/infra-aws harness:setup && harness:seed-extra && harness:seed-scenario
// Run after setup and seed-extra, on a freshly reset database, so every browser pass starts from the same state. It adds, through the real API functions
// where one exists: the 8 h/day, 40 h/week policy for this LOCAL organization (never a live tenant), a client with plenty of authorization, an open 9-hour
// shift (the caregiver's request is refused by the daily limit) and an open 2-hour shift (the request is allowed), one visit in every billing state, a
// CPR that expires during a scheduled shift, and a visit in progress when its caregiver's CPR expires. It refuses any non-local database.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { ADMIN_URL, ORG_SLUG, PERSONAS, assertLocalDatabase, databaseUrl } from "./common.js";

pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

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
    } catch (e) { await c.query("rollback"); throw e; }
  }
  const org = await one("select id from ogevia.organizations where slug = $1", [ORG_SLUG]);
  const [owner, manager, alex, blair] = [persona("owner"), persona("manager"), persona("alex"), persona("blair")];
  const alexUser = await one("select id from ogevia.app_users where cognito_sub = $1", [alex.sub]);
  const alexRec = await one("select id from ogevia.caregiver_records where caregiver_code = 'CG-ALEX'");
  const blairRec = await one("select id from ogevia.caregiver_records where caregiver_code = 'CG-BLAIR'");
  const blairUser = await one("select id from ogevia.app_users where cognito_sub = $1", [blair.sub]);
  const respite = await one("select id from ogevia.services where code = 'RSP' and organization_id = $1", [org]);
  const day = async (n: number) => String((await q("select to_char((now() at time zone 'America/Los_Angeles')::date + $1::int, 'YYYY-MM-DD') as d", [n]))[0]!.d);
  const dow = async (n: number) => new Date(`${await day(n)}T12:00:00Z`).getUTCDay();
  const firstDow = async (want: number, from: number) => { for (let n = from; n < from + 7; n++) if ((await dow(n)) === want) return n; throw new Error("no day"); };

  // 2. A client with plenty of authorization, so refusals in the scenarios come from the rule being tested, not from running out of hours.
  const scenario = await one("insert into ogevia.clients (organization_id) values ($1) returning id", [org]);
  await as(owner.sub, () => c.query("select ogevia_api.set_client_legal_name($1,$2,'Demo','Scenario',null)", [org, scenario]));
  await q(`insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end, hourly_rate_cents)
           values ($1,$2,$3,'Synthetic Regional Center', 20000 * 60, (date_trunc('month', now()) - interval '1 month')::date, (date_trunc('month', now()) + interval '6 months')::date, 3200)`, [org, scenario, respite]);
  for (const u of [alexUser, blairUser]) await q("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,(now() - interval '60 days')::date)", [org, u, scenario, respite]);

  // 3. Open shifts the caregiver can ask for: a 9-hour shift (always over the 8-hour day) and a 2-hour shift in a week with no other work.
  // both inside the next 16 days: before Alex's CPR runs out (valid through today + 20), so the office can confirm the request that the policy allows
  const tue = await firstDow(2, 10); const thu = await firstDow(4, 10);
  const open = (n: number, s: string, e: string) => as(manager.sub, async () => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,null)", [org, scenario, respite, await day(n), s, e])).rows[0]);
  await open(tue, "07:00", "16:00"); // 9 h: request refused
  await open(thu, "10:00", "12:00"); // 2 h: request allowed

  // 4. One visit in every billing state. Visits are made through the real API functions; only the start time is moved back (seed-only replica role).
  async function visit(minutes: number, mode: "signed" | "no_signer", client: string = scenario) {
    await q(`insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
             values ($1,$2,$3,$4,$5, now() - interval '1 minute', now() - interval '1 minute' + make_interval(mins => $6))`, [org, client, respite, alexUser, alexRec, Math.max(minutes, 2)]);
    const v = String((await as(alex.sub, () => c.query("select ogevia_api.start_ad_hoc_service_visit($1,$2,$3,'{}',null,null,null) as id", [org, client, respite]))).rows[0]?.id);
    await c.query("set session_replication_role = replica");
    await c.query("update ogevia.service_visits set time_in = time_in - make_interval(mins => $2) where id = $1", [v, minutes]);
    await c.query("update ogevia.shifts sh set starts_at = v.time_in, ends_at = v.time_in + make_interval(mins => $2) from ogevia.service_visits v where v.id = $1 and sh.id = v.scheduled_shift_id", [v, minutes]);
    await c.query("reset session_replication_role");
    await as(alex.sub, () => c.query("select * from ogevia_api.end_service_visit($1)", [v]));
    if (mode === "signed") {
      const ev = String((await as(alex.sub, () => c.query("select ogevia_api.register_visit_evidence($1,$2,'v1','image/png',2048,$3,null) as id", [v, `${org}/${v}/client-signature.png`, "a".repeat(64)]))).rows[0]?.id);
      await as(alex.sub, () => c.query("select * from ogevia_api.confirm_service_visit($1,'client','draw',$2,null,null,null,null,'attest-v1')", [v, ev]));
    } else {
      await as(alex.sub, () => c.query("select * from ogevia_api.confirm_service_visit($1,'client','unable_to_confirm',null,null,null,'Client asleep; parent not home (synthetic)',null,'attest-v1')", [v]));
    }
    return v;
  }
  const approved = await visit(30, "signed");
  const voided = await visit(31, "signed");
  const notBillable = await visit(32, "no_signer");
  const waiting = await visit(33, "no_signer");
  const lateResponse = await visit(34, "no_signer");
  await visit(35, "no_signer"); // stays Needs Correction (the base seed has another)
  const a1 = String((await as(manager.sub, () => c.query("select ogevia_api.approve_visit_for_billing($1,30,null,null) as id", [approved]))).rows[0]?.id);
  void a1;
  const a2 = String((await as(manager.sub, () => c.query("select ogevia_api.approve_visit_for_billing($1,31,null,null) as id", [voided]))).rows[0]?.id);
  await as(manager.sub, () => c.query("select ogevia_api.void_billing_approval($1,'Approved the wrong minutes (synthetic)',null)", [a2]));
  await as(manager.sub, () => c.query("select ogevia_api.decide_visit_review($1,'close_not_billable','Parent could not be reached; not billable (synthetic)',null)", [notBillable]));
  const request = async (visitId: string, who: string) => {
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const tokenHash = sha(token); const codeHash = sha(`${tokenHash}:123456`);
    await as(manager.sub, () => c.query("select * from ogevia_api.create_visit_confirmation_request($1,'link',$2,'parent',$3,$4,$5,7,null)", [visitId, who, "Called the number on file and confirmed the parent's name", tokenHash, codeHash]));
    return { tokenHash, codeHash };
  };
  await request(waiting, "Synthetic Parent Waiting");
  const late = await request(lateResponse, "Synthetic Parent Late");
  await c.query("begin"); await c.query("set local role ogevia_app");
  await c.query("select * from ogevia_api.public_respond_visit_confirmation($1,$2,$3,'confirmed','typed',$4,null,true,null,null,null,null,$5)", [late.tokenHash, late.codeHash, randomUUID(), "Synthetic Parent Late", randomUUID()]).catch(async (e) => { await c.query("rollback"); throw e; });
  await c.query("commit");

  // 5. CPR/TB expiring during a shift (Alex's CPR is valid through today + 20): an overnight shift across the expiry midnight and a shift after it.
  await c.query("set session_replication_role = replica"); // seed-only: shifts at exact times, no reservation
  const mk = async (dayOffset: number, start: string, end: string, rec: string, user: string) => {
    const d = await day(dayOffset);
    await q(`insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
             values ($1,$2,$3,$4,$5, ($6::date + $7::time) at time zone 'America/Los_Angeles',
                     (($6::date + (case when $8::time <= $7::time then 1 else 0 end)) + $8::time) at time zone 'America/Los_Angeles', 'scheduled')`, [org, scenario, respite, user, rec, d, start, end]);
  };
  await mk(20, "22:00", "06:00", alexRec, alexUser); // expires during the shift
  await mk(25, "09:00", "11:00", alexRec, alexUser); // expired by then
  // 6. A visit already in progress when its caregiver's CPR expires: Blair's open visit (base seed), CPR valid through yesterday, then the scheduled run opens the hold.
  await q("update ogevia.shifts set ends_at = now() + interval '2 hours' where id = (select scheduled_shift_id from ogevia.service_visits where caregiver_user_id = $1 and status = 'draft' and time_out is null limit 1)", [blairUser]);
  await q(`update ogevia.document_versions set expires_on = (now() at time zone 'America/Los_Angeles')::date - 1
           where document_id in (select d.id from ogevia.staff_documents d join ogevia.document_types t on t.id = d.document_type_id where d.caregiver_record_id = $1 and t.work_requirement = 'cpr' and d.closed_at is null)`, [blairRec]);
  await c.query("reset session_replication_role");
  // 7. Accounting (0067, 0068): a shift that ended with no visit record (to reconcile), and a client whose authorization is amended below what is reserved (impacts).
  await c.query("set session_replication_role = replica");
  const endedShift = await one(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3,$4,$5, now() - interval '8 hours', now() - interval '6 hours', 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.client_id = $2 and a.is_current returning id`,
    [org, scenario, respite, alexUser, alexRec]);
  await q(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
           select $1, a.lineage_id, null, $2, (now() at time zone 'America/Los_Angeles')::date, 120 from ogevia.client_authorizations a where a.client_id = $3 and a.is_current`, [org, endedShift, scenario]);
  await c.query("reset session_replication_role");
  const amendClient = await one("insert into ogevia.clients (organization_id) values ($1) returning id", [org]);
  await as(owner.sub, () => c.query("select ogevia_api.set_client_legal_name($1,$2,'Demo','Amend',null)", [org, amendClient]));
  const amendAuth = await one(`insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end, hourly_rate_cents)
           values ($1,$2,$3,'Synthetic Regional Center', 1000, (date_trunc('month', now()) - interval '1 month')::date, (date_trunc('month', now()) + interval '6 months')::date, 3200) returning id`, [org, amendClient, respite]);
  // only Alex: Blair's CPR has expired by now and the compliance hold refuses a new assignment for Blair
  await q("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,(now() - interval '60 days')::date)", [org, alexUser, amendClient, respite]);
  const sameDay = await firstDow(3, 12); // a Wednesday 12-18 days ahead: three 4-hour open shifts in one agency month
  for (const [a, b] of [["06:00", "10:00"], ["11:00", "15:00"], ["16:00", "20:00"]] as const)
    await as(manager.sub, async () => c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,null)", [org, amendClient, respite, await day(sameDay), a, b]));
  await as(manager.sub, () => c.query("select * from ogevia_api.amend_client_authorization($1,400,(date_trunc('month', now()) - interval '1 month')::date,(date_trunc('month', now()) + interval '6 months')::date,'Synthetic Regional Center','Payer lowered the month (synthetic)')", [amendAuth]));

  // 8. Authorization lowered after confirmation (0071): one visit approved for billing, one confirmed but not approved, then the month is lowered below both.
  const lowered = await one("insert into ogevia.clients (organization_id) values ($1) returning id", [org]);
  await as(owner.sub, () => c.query("select ogevia_api.set_client_legal_name($1,$2,'Demo','Lowered',null)", [org, lowered]));
  await q(`insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end, hourly_rate_cents)
           values ($1,$2,$3,'Synthetic Regional Center', 1000, (date_trunc('month', now()) - interval '1 month')::date, (date_trunc('month', now()) + interval '6 months')::date, 3200)`, [org, lowered, respite]);
  await q("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,(now() - interval '60 days')::date)", [org, alexUser, lowered, respite]);
  const loweredApproved = await visit(60, "signed", lowered);
  const loweredOpen = await visit(90, "signed", lowered);
  await as(manager.sub, () => c.query("select ogevia_api.approve_visit_for_billing($1,60,null,null) as id", [loweredApproved]));
  const loweredAuth = await one("select id from ogevia.client_authorizations where client_id = $1 and is_current", [lowered]);
  await as(owner.sub, () => c.query("select * from ogevia_api.amend_client_authorization($1,40,(date_trunc('month', now()) - interval '1 month')::date,(date_trunc('month', now()) + interval '6 months')::date,'Synthetic Regional Center','Payer lowered the month below both visits (synthetic)')", [loweredAuth]));
  void loweredOpen;

  // LAST: the agency policy for THIS local organization, so the browser runs under the same 8 h / 40 h rule. It is written after the fixture visits because the base seed
  // already gives the caregiver more than 40 hours in one week, and the rule (correctly) refuses to put any further scheduled shift on that caregiver (append-only table: a second run adds nothing).
  await c.query(
    `insert into ogevia.agency_work_hour_policies (organization_slug, version, max_daily_minutes, max_weekly_minutes, effective_from, basis)
     values ($1, 1, 480, 2400, now(), 'LOCAL HARNESS fixture mirroring the owner-approved limits (8 hours a day, 40 hours a week, no override). Synthetic.') on conflict do nothing`, [ORG_SLUG]);

  await c.query("select ogevia.compliance_sweep($1, null)", [org]);

  const [s] = await q(`select (select count(*)::int from ogevia.caregiver_compliance_holds where released_at is null) holds,
                              (select count(*)::int from ogevia.shifts where status = 'scheduled' and caregiver_record_id is null) open_shifts`);
  console.log(`scenario seed done: ${s!.holds} open hold(s), ${s!.open_shifts} open shift(s)`);
  await c.end();
}
main().catch((e) => { console.error(e instanceof Error ? (process.env.HARNESS_TRACE ? e.stack : e.message) : e); process.exit(1); });
