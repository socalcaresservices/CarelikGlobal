// LOCAL DEVELOPMENT HARNESS: creates (or recreates) a database on THIS computer, applies every migration with
// the real runner, and seeds clearly synthetic demo data through the real API functions.
//   pnpm --filter @carelik/infra-aws harness:setup
// It DROPS and recreates the database "ogevia_local_harness". It refuses any non-local database.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../db/scripts/migrations.js";
import { ADMIN_URL, DB_NAME, ORG_SLUG, PERSONAS, assertLocalDatabase, databaseUrl } from "./common.js";

pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));

type Row = Record<string, unknown>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const persona = (key: string) => {
  const p = PERSONAS.find((x) => x.key === key);
  if (!p) throw new Error(`unknown persona ${key}`);
  return p;
};

async function main() {
  assertLocalDatabase(ADMIN_URL);
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect().catch((error: Error) => {
    throw new Error(
      `Cannot connect to PostgreSQL at ${ADMIN_URL}\n  ${error.message}\n` +
        "Start a local PostgreSQL (see local-harness/README.md) or set HARNESS_ADMIN_URL to a superuser URL on this computer.",
    );
  });
  await root.query(`drop database if exists ${DB_NAME} with (force)`);
  await root.query(`create database ${DB_NAME}`);
  await root.end();

  const c = new pg.Client({ connectionString: databaseUrl() });
  await c.connect();
  const applied = await migrate(c, () => {}, { includePendingUx: true });
  console.log(`migrations applied: ${applied.applied.length}`);

  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await c.query(sql, params)).rows as Row[];
  const id = async (sql: string, params: unknown[] = []): Promise<string> => String((await q(sql, params))[0]?.id);

  /** Runs fn as an application user: one transaction, role ogevia_app, the person's identity (as the API does). */
  async function asActor<T>(sub: string, fn: () => Promise<T>): Promise<T> {
    await c.query("begin");
    try {
      await c.query("set local role ogevia_app");
      await c.query("select ogevia_api.begin_request($1, $2)", [sub, randomUUID()]);
      const result = await fn();
      await c.query("commit");
      return result;
    } catch (error) {
      await c.query("rollback");
      throw error;
    }
  }

  // ---- organization, people ------------------------------------------------------------------------------------
  const org = await id("insert into ogevia.organizations (slug, display_name) values ($1, 'Local Demo Agency (synthetic)') returning id", [ORG_SLUG]);
  const users = new Map<string, string>();
  for (const p of PERSONAS) {
    const userId = await id("insert into ogevia.app_users (cognito_sub, display_name) values ($1, $2) returning id", [p.sub, p.name]);
    users.set(p.key, userId);
    await q("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,$3,'active')", [org, userId, p.role]);
    if (p.caregiverCode) {
      const [first = p.name, last = ""] = p.name.split(" ");
      await q(
        "insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name, status) values ($1,$2,$3,$4,$5,'active')",
        [org, userId, p.caregiverCode, first, last],
      );
    }
  }
  // Two caregivers without a sign-in (the product supports them).
  const casey = await id("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1,'CG-CASEY','Casey','Caregiver','active') returning id", [org]);
  await q("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1,'CG-DREW','Drew','Caregiver','active')", [org]);
  const recordOf = async (key: string) => id("select id from ogevia.caregiver_records where linked_user_id = $1", [users.get(key)]);
  const alexRec = await recordOf("alex");
  const blairRec = await recordOf("blair");

  const respite = await id("insert into ogevia.services (organization_id, code, name) values ($1,'RSP','Respite') returning id", [org]);
  const personal = await id("insert into ogevia.services (organization_id, code, name) values ($1,'PCS','Personal care') returning id", [org]);

  // ---- clients and authorizations ------------------------------------------------------------------------------
  const owner = persona("owner");
  const alex = persona("alex");
  const blair = persona("blair");
  const manager = persona("manager");

  interface ClientSpec { first: string; last: string; service: string; hours: number | null; period: "current" | "expiring" | "expired" | "none"; rateCents: number | null }
  const specs: ClientSpec[] = [
    { first: "Demo", last: "Vega", service: respite, hours: 50, period: "current", rateCents: 3200 },
    { first: "Demo", last: "Okafor", service: personal, hours: 40, period: "current", rateCents: 3400 },
    { first: "Demo", last: "Lindqvist", service: respite, hours: 30, period: "current", rateCents: null },
    { first: "Demo", last: "Tanaka", service: respite, hours: 25, period: "expiring", rateCents: 3200 },
    { first: "Demo", last: "Brightwater", service: personal, hours: 20, period: "expired", rateCents: 3400 },
    { first: "Demo", last: "Nakamura", service: respite, hours: null, period: "none", rateCents: null },
    { first: "Demo", last: "Rivera (late confirmation)", service: respite, hours: 10, period: "current", rateCents: 3200 },
  ];
  const clients: string[] = [];
  for (const s of specs) {
    const client = await id("insert into ogevia.clients (organization_id) values ($1) returning id", [org]);
    clients.push(client);
    await asActor(owner.sub, () => c.query("select ogevia_api.set_client_legal_name($1,$2,$3,$4,null)", [org, client, s.first, s.last]));
    if (s.hours !== null) {
      const period =
        s.period === "expiring" ? ["(date_trunc('month', now()) - interval '2 months')::date", "(now() + interval '10 days')::date"]
        : s.period === "expired" ? ["(now() - interval '120 days')::date", "(now() - interval '20 days')::date"]
        : ["(date_trunc('month', now()) - interval '1 month')::date", "(date_trunc('month', now()) + interval '3 months')::date"];
      await q(
        `insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end, hourly_rate_cents)
         values ($1,$2,$3,'Synthetic Regional Center',$4,${period[0]},${period[1]},$5)`,
        [org, client, s.service, s.hours * 60, s.rateCents],
      );
    }
    for (const who of [alex, blair]) {
      await q(
        "insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,(now() - interval '60 days')::date)",
        [org, users.get(who.key), client, s.service],
      );
    }
  }
  const [vega, okafor, lindqvist, tanaka, , , rivera] = clients as [string, string, string, string, string, string, string];

  // ---- visits (through the real API functions) -----------------------------------------------------------------
  /** `shift`: true = a scheduled shift exactly as long as the visit; a number = a shift of that many minutes; false = unscheduled (reason required). */
  async function visit(who: { sub: string; key?: string }, client: string, service: string, minutes: number, mode: "signed" | "no_signer" | "awaiting" | "open", shift: boolean | number = true) {
    const rec = who.key ? await recordOf(who.key) : null;
    if (shift !== false && rec) {
      const length = typeof shift === "number" ? shift : minutes;
      await q(
        `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
         select $1,$2,$3,u.id,$4, now() - interval '1 minute', now() - interval '1 minute' + make_interval(mins => $5) from ogevia.app_users u where u.cognito_sub = $6`,
        [org, client, service, rec, Math.max(length, 2), who.sub],
      );
    }
    const reason = shift === false || !rec ? "Client asked for extra help today (synthetic)" : null;
    const v = String((await asActor(who.sub, () => c.query("select ogevia_api.start_ad_hoc_service_visit($1,$2,$3,'{}',null,null,$4) as id", [org, client, service, reason]))).rows[0]?.id);
    await c.query("set session_replication_role = replica"); // seed-only: make the visit start earlier than now
    await c.query("update ogevia.service_visits set time_in = time_in - make_interval(mins => $2) where id = $1", [v, minutes]);
    await c.query("update ogevia.shifts sh set starts_at = v.time_in, ends_at = v.time_in + make_interval(mins => $2) from ogevia.service_visits v where v.id = $1 and sh.id = v.scheduled_shift_id and $3::boolean", [v, typeof shift === "number" ? shift : minutes, shift !== false]);
    await c.query("reset session_replication_role");
    if (mode === "open") return v;
    await asActor(who.sub, () => c.query("select * from ogevia_api.end_service_visit($1)", [v]));
    if (mode === "awaiting") return v;
    if (mode === "signed") {
      const ev = String((await asActor(who.sub, () => c.query("select ogevia_api.register_visit_evidence($1,$2,'v1','image/png',2048,$3,null) as id", [v, `${org}/${v}/client-signature.png`, "a".repeat(64)]))).rows[0]?.id);
      await asActor(who.sub, () => c.query("select * from ogevia_api.confirm_service_visit($1,'client','draw',$2,null,null,null,null,'attest-v1')", [v, ev]));
    } else {
      await asActor(who.sub, () => c.query("select * from ogevia_api.confirm_service_visit($1,'client','unable_to_confirm',null,null,null,'Client asleep; parent not home (synthetic)',null,'attest-v1')", [v]));
    }
    return v;
  }
  // Used hours: Vega 80% (4 x 10 h), Okafor 20%, Lindqvist and Tanaka a little.
  for (let i = 0; i < 4; i++) await visit(alex, vega, respite, 600, "signed");
  await visit(alex, okafor, personal, 480, "signed");
  await visit(alex, lindqvist, respite, 240, "signed");
  await visit(alex, tanaka, respite, 180, "signed");
  // Wave 1: an unscheduled visit with a drawn signature (goes to review), and a visit 30 minutes longer than its shift (default rule: 15).
  await visit(alex, vega, respite, 90, "signed", false);
  await visit(alex, lindqvist, respite, 150, "signed", 120);
  // Action Needed: an unsigned visit in review, and one never closed (Blair). A caregiver cannot start a new visit while
  // another is still open or awaiting a signature, so Alex stays free to try the caregiver flow.
  await visit(alex, okafor, personal, 60, "no_signer");
  await visit(blair, tanaka, respite, 20 * 60, "open");

  // ---- late-confirmation example: balance counts the accepted 45 minutes once --------------------------------
  const shiftNow = await id(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3,$4,$5, now() - interval '5 minutes', now() + interval '115 minutes', 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.client_id = $2 returning id`,
    [org, rivera, respite, users.get("alex"), alexRec],
  );
  await q(
    `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
     select $1, a.lineage_id, null, $2, (now() at time zone 'America/Los_Angeles')::date, 120 from ogevia.client_authorizations a where a.client_id = $3`,
    [org, shiftNow, rivera],
  );
  const lateVisit = await visit(alex, rivera, respite, 45, "no_signer", false); // links to the shift above
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const tokenHash = sha(token);
  const codeHash = sha(`${tokenHash}:123456`);
  await asActor(manager.sub, () => c.query("select * from ogevia_api.create_visit_confirmation_request($1,'link',$2,'parent',$3,$4,$5,7,null)", [lateVisit, "Synthetic Parent Rivera", "Called the number on file and confirmed the parent's name", tokenHash, codeHash]));
  await c.query("begin");
  await c.query("set local role ogevia_app");
  const response = (await c.query("select * from ogevia_api.public_respond_visit_confirmation($1,$2,$3,'confirmed','typed',$4,null,true,null,null,null,null,$5)", [tokenHash, codeHash, randomUUID(), "Synthetic Parent Rivera", randomUUID()])).rows[0] as Row;
  await c.query("commit");
  await asActor(manager.sub, () => c.query("select * from ogevia_api.review_late_visit_confirmation($1,'accepted','Checked against the schedule (synthetic)',null)", [response.late_confirmation_id]));

  // ---- upcoming shifts (daytime hours only, so daylight-saving nights never matter) ----------------------------
  const day = async (n: number) => String((await q("select to_char((now() at time zone 'America/Los_Angeles')::date + $1::int, 'YYYY-MM-DD') as d", [n]))[0]?.d);
  async function shift(client: string, service: string, dayOffset: number, start: string, end: string, record: string | null) {
    const rows = await asActor(manager.sub, async () => (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,null)", [org, client, service, await day(dayOffset), start, end, record])).rows as Row[]);
    return String(rows[0]?.shift_id);
  }
  await shift(vega, respite, 1, "09:00", "13:00", alexRec);
  await shift(vega, respite, 2, "09:00", "13:00", blairRec);
  await shift(okafor, personal, 1, "14:00", "17:00", null); // open, starts within 48 h: urgent
  await shift(lindqvist, respite, 3, "10:00", "14:00", null); // open, beyond 48 h
  await shift(tanaka, respite, 2, "09:00", "12:00", casey);
  const calledOut = await shift(okafor, personal, 4, "09:00", "12:00", alexRec);
  await asActor(manager.sub, () => c.query("select ogevia_api.record_shift_callout($1,$2,'Caregiver unwell (synthetic)',null)", [org, calledOut]));

  // ---- Scheduling patterns, hour limits and a make-up (0053) ---------------------------------------------------
  const firstOn = async (dow: number, from: number) => { for (let n = from; n < from + 7; n++) { const d = await day(n); if (new Date(`${d}T12:00:00Z`).getUTCDay() === dow) return d; } throw new Error("no such weekday"); };
  const series = async (client: string, service: string, record: string | null, weekdays: number[], start: string, end: string, from: string, to: string, pattern: object | null) =>
    asActor(manager.sub, () => c.query("select * from ogevia_api.create_shift_series($1,$2,$3,$4,$5::smallint[],$6::time,$7::time,$8::date,$9::date,'skip_flagged',null,$10::jsonb)",
      [org, client, service, record, weekdays, start, end, from, to, pattern ? JSON.stringify(pattern) : null]));
  // "Every Saturday except the first Saturday of the month" (Vega, Casey).
  await series(vega, respite, casey, [6], "09:00", "13:00", await day(1), await day(60), { except_nth: [1] });
  // Week A / week B for one client with two caregivers (Okafor): Alex Mon+Wed on odd weeks, Blair Tue+Thu on even weeks.
  const monday = await firstOn(1, 7);
  await series(okafor, personal, alexRec, [1, 3], "14:00", "16:00", monday, await day(60), { every_weeks: 2, anchor: monday });
  await series(okafor, personal, blairRec, [2, 4], "14:00", "16:00", await day(Math.round((Date.parse(`${monday}T12:00:00Z`) - Date.parse(`${await day(0)}T12:00:00Z`)) / 864e5) + 1), await day(60),
    { every_weeks: 2, anchor: await day(Math.round((Date.parse(`${monday}T12:00:00Z`) - Date.parse(`${await day(0)}T12:00:00Z`)) / 864e5) + 7) });
  // Two caregivers for one client at the same time (Lindqvist, Fridays).
  const friday = await firstOn(5, 7);
  await series(lindqvist, respite, alexRec, [5], "10:00", "12:00", friday, await day(45), null);
  await series(lindqvist, respite, casey, [5], "10:00", "12:00", friday, await day(45), null);
  // Hour limits: an agency default that warns, and a stricter limit for Blair that stops the assignment.
  await asActor(manager.sub, () => c.query("select ogevia_api.set_hour_limit($1,null,480,2400,'report','Agency default (synthetic)')", [org]));
  await asActor(manager.sub, () => c.query("select ogevia_api.set_hour_limit($1,$2,300,null,'block','Part-time agreement (synthetic)')", [org, blairRec]));
  // A cancelled shift with time still owed: the make-up button appears on it.
  const missed = await shift(tanaka, respite, 5, "09:00", "12:00", casey);
  await asActor(manager.sub, () => c.query("select * from ogevia_api.cancel_shift($1,$2,'Client in hospital (synthetic)',null)", [org, missed]));

  // ---- Recruiting and onboarding (0054) -----------------------------------------------------------------------------
  const cprType = String((await asActor(owner.sub, () => c.query("select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [org]))).rows[0]?.id);
  const tbType = String((await asActor(owner.sub, () => c.query("select ogevia_api.create_document_type($1,'TB result',false,null) as id", [org]))).rows[0]?.id);
  for (const [req, type] of [["cpr", cprType], ["tb", tbType]] as const) {
    await asActor(owner.sub, () => c.query("select ogevia_api.set_document_work_requirement($1,$2,$3,'Agency policy (synthetic)')", [org, req, type]));
    await asActor(owner.sub, () => c.query("select ogevia_api.set_requirement_policy($1,$2,'document_expiry',null,'Per agency policy (synthetic)')", [org, req]));
  }
  const person = async (first: string, last: string) =>
    String((await asActor(owner.sub, () => c.query("select * from ogevia_api.create_caregiver($1,$2,$3,null,'applicant',null)", [org, first, last]))).rows[0]?.caregiver_record_id);
  const stage = (rec: string, status: string) => asActor(owner.sub, () => c.query("select * from ogevia_api.set_caregiver_status($1,$2,$3,'Moved on the Recruiting board (synthetic)',null)", [org, rec, status]));
  const item = (rec: string, key: string, expiresInDays: number | null = null) =>
    asActor(owner.sub, () => c.query("select ogevia_api.record_onboarding_item($1,$2,$3,'complete',null,(now() + make_interval(days => $4::int))::date,null,null)", [org, rec, key, expiresInDays]));
  // 0086: the background check is verified through its own record (administrator only); onboarding keeps only the training item.
  const verifyBackground = (rec: string) =>
    asActor(owner.sub, () => c.query("select ogevia_api.verify_background_check($1,$2,'approved','Agency clearance record (synthetic)',null)", [org, rec]));
  async function document(rec: string, type: string) {
    const doc = String((await asActor(owner.sub, () => c.query("select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [org, rec, type]))).rows[0]?.id);
    const version = randomUUID();
    const v = (await asActor(owner.sub, () => c.query("select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,null,(now() + interval '300 days')::date,null)", [doc, version, `${org}/documents/${doc}/${version}`, "d".repeat(64)]))).rows[0] as Row;
    await asActor(owner.sub, () => c.query("select ogevia_api.review_document_version($1,'verified',null)", [v.document_version_id]));
  }
  await person("Jordan", "Applicant");
  const riley = await person("Riley", "Interviewee"); await stage(riley, "interview");
  const taylor = await person("Taylor", "Onboarding"); await stage(taylor, "interview"); await stage(taylor, "offer"); await stage(taylor, "onboarding");
  await verifyBackground(taylor); await item(taylor, "training", 20);
  const avery = await person("Avery", "Paperwork"); for (const s of ["interview", "offer", "onboarding", "pending_documents"]) await stage(avery, s);
  await verifyBackground(avery); await item(avery, "training", 300); await document(avery, cprType); await document(avery, tbType);

  // ---- Readiness (0086) -------------------------------------------------------------------------------------------
  // The four caregivers inserted above as Active predate Approve for work: back-fill them exactly as migration 0086 does for existing Ready/Active records.
  await q(`insert into ogevia.caregiver_work_approvals (organization_id, caregiver_record_id, approved_by, approved_at, source, snapshot)
           select organization_id, id, null, updated_at, 'legacy_status', '[]'::jsonb from ogevia.caregiver_records where status in ('ready','active') and organization_id = $1
           on conflict do nothing`, [org]);
  // Three records that show the page's states. A linked account with no invitation counts as signed in (a person who signs in through other means).
  const linked = async (rec: string, name: string) => {
    const userId = await id("insert into ogevia.app_users (cognito_sub, display_name) values ($1,$2) returning id", [randomUUID(), name]);
    await q("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [org, userId]);
    await q("update ogevia.caregiver_records set linked_user_id = $2 where id = $1", [rec, userId]);
  };
  const reese = await person("Reese", "ReadyToApprove"); await linked(reese, "Reese ReadyToApprove"); await verifyBackground(reese); await item(reese, "training", 300);
  await q("update ogevia.caregiver_records set hire_date = current_date - 3 where id = $1", [reese]);                      // CPR/TB pending, due in 27 days: approval allowed
  const quinn = await person("Quinn", "WaitingOnSignIn"); await verifyBackground(quinn); await item(quinn, "training", 300);
  await q("update ogevia.caregiver_records set hire_date = current_date - 10 where id = $1", [quinn]);                     // no email on file: Approve disabled, "Add email"
  const dana = await person("Dana", "Overdue"); await linked(dana, "Dana Overdue"); await verifyBackground(dana); await item(dana, "training", 300);
  await q("update ogevia.caregiver_records set hire_date = current_date - 40 where id = $1", [dana]);                      // CPR/TB overdue (30-day rule): Extend

  const [summary] = await q("select count(*)::int as clients, (select count(*)::int from ogevia.shifts) as shifts, (select count(*)::int from ogevia.service_visits) as visits from ogevia.clients");
  console.log(`seeded: ${summary?.clients} clients, ${summary?.shifts} shifts, ${summary?.visits} visits`);
  await c.end();
  console.log(`\nDatabase "${DB_NAME}" is ready.\nNext: pnpm --filter @carelik/infra-aws harness:build   (once)\n      pnpm --filter @carelik/infra-aws harness:serve`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
