// Option 1 cleanup (db/maintenance/test_data_clear_linked.sql): the retained INACTIVE test clients keep their rows and authorizations; their shifts,
// reservations, assignments, portals, preparation, ZIPs and NAMES go. Real psql, real PostgreSQL, the repository's real protections. SYNTHETIC data only.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_URL, asActor, createTestDb, type Actor, type TestDb } from "./harness.js";

const CLEAR = join(__dirname, "../maintenance/test_data_clear_linked.sql");
const DASH = join(__dirname, "../preview/dashboard_totals.sql");
const SNAP = "ogevia-prod-postgres-pre-testdata-202610230000";
let db: TestDb;
let owner: Actor, ownerD: Actor;
let org = "", orgD = "", slug = "", svc = "", svcD = "";
let clients: string[] = [];
let seriesKept = "", seriesGone = "";
let authIdsBefore = "";

const url = () => { const u = new URL(ADMIN_URL); u.pathname = `/${db.name}`; return u.toString(); };
const psql = (file: string, vars: Record<string, string>) =>
  spawnSync("psql", [url(), "-X", "-q", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", file], { encoding: "utf8" });
const A = (sql: string, p: unknown[] = []) => db.admin.query(sql, p);
const n = async (sql: string, p: unknown[] = []) => Number((await A(sql, p)).rows[0].n);
const as = (a: Actor, sql: string, p: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, p)).rows as any[]);
/** Parse "== heading" sections of psql -A output into { heading: [rowObject...] }. */
const sections = (out: string) => {
  const res: Record<string, Array<Record<string, string>>> = {};
  let cur = "", header: string[] | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("== ")) { cur = line; header = null; res[cur] = []; continue; }
    if (!cur || !line || /^\(\d+ rows?\)$/.test(line) || line === "ROLLBACK" || line === "BEGIN") continue;
    if (!header) { header = line.split("|"); continue; }
    const cells = line.split("|");
    res[cur]!.push(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
  }
  return res;
};
const dash = () => {
  const r = psql(DASH, { org_slug: slug });
  expect(r.status, r.stderr + r.stdout).toBe(0);
  const s = sections(r.stdout);
  const pick = (k: string) => Object.entries(s).find(([h]) => h.includes(k))![1][0]!;
  return { hours: pick("Hours this month"), reconcile: pick("ended with no visit record"), schedule: pick("shifts in the next 120 days"), tiles: pick("numbers on the dashboard cards"), overview: pick("Needs attention now, Upcoming staffing"), raw: r.stdout };
};
const counts = async () => ({
  clients: await n("select count(*) n from ogevia.clients where organization_id = $1", [org]),
  auths: await n("select count(*) n from ogevia.client_authorizations where organization_id = $1", [org]),
  shifts: await n("select count(*) n from ogevia.shifts where organization_id = $1", [org]),
  reservations: await n("select count(*) n from ogevia.authorization_reservations where organization_id = $1", [org]),
  names: await n("select count(*) n from ogevia.client_private_names where organization_id = $1", [org]),
  assignments: await n("select count(*) n from ogevia.caregiver_assignments where organization_id = $1", [org]),
  series: await n("select count(*) n from ogevia.shift_series where organization_id = $1", [org]),
  skipped: await n("select count(*) n from ogevia.shift_series_skipped_dates where organization_id = $1", [org]),
  caregivers: await n("select count(*) n from ogevia.caregiver_records where organization_id = $1", [org]),
  signins: await n("select count(*) n from ogevia.caregiver_records where organization_id = $1 and linked_user_id is not null", [org]),
  members: await n("select count(*) n from ogevia.organization_memberships where organization_id = $1", [org]),
  audit: await n("select count(*) n from ogevia.audit_events where organization_id = $1", [org]),
  otherShifts: await n("select count(*) n from ogevia.shifts where organization_id = $1", [orgD]),
  otherNames: await n("select count(*) n from ogevia.client_private_names where organization_id = $1", [orgD]),
  triggers: await n("select count(*) n from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'forbid_delete' and not t.tgisinternal and t.tgenabled = 'O'"),
});

beforeAll(async () => {
  db = await createTestDb();
  const mkAgency = async (slugName: string) => {
    const sub = randomUUID();
    const user = (await A("insert into ogevia.app_users (cognito_sub, display_name) values ($1, $2) returning id", [sub, `Owner ${slugName} (synthetic)`])).rows[0].id;
    const id = (await A("insert into ogevia.organizations (slug, display_name, timezone) values ($1, $1, 'America/Los_Angeles') returning id", [slugName])).rows[0].id;
    await A("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1, $2, 'organization_owner', 'active')", [id, user]);
    const service = (await A("insert into ogevia.services (organization_id, code, name) values ($1, '862', 'Respite Care') returning id", [id])).rows[0].id;
    return { id: id as string, actor: { userId: user as string, sub }, service: service as string };
  };
  const a = await mkAgency("cleanup-agency"); org = a.id; owner = a.actor; svc = a.service; slug = "cleanup-agency";
  const d = await mkAgency("other-agency"); orgD = d.id; ownerD = d.actor; svcD = d.service;
  const today = (await A("select to_char((now() at time zone 'America/Los_Angeles')::date, 'YYYY-MM-DD') d")).rows[0].d as string;

  // Retained test clients: named, with an authorization, scheduled shifts (reservations), assignment, preparation, ZIP; then made inactive.
  for (const last of ["TestOne", "TestTwo", "TestThree"]) {
    const id = (await as(owner, "select * from ogevia_api.create_client($1, 'Synthetic', $2)", [org, last]))[0].client_id as string;
    await as(owner, "select ogevia_api.create_client_authorization($1,$2,$3,'Synthetic Payer',1200,(date_trunc('month',$4::date))::date,($4::date + 90),'SYN-1',null,null,null,null)", [org, id, svc, today]);
    for (const off of [2, 3]) await as(owner, "select * from ogevia_api.create_shift($1,$2,$3,($4::date + $5::int)::date,'09:00'::time,'11:00'::time,null,null)", [org, id, svc, today, off]);
    clients.push(id);
  }
  // Recurring series: one that gets protected skipped-date history (kept), one without (removable).
  const mkSeries = async (client: string, weekdays: string, from: number, to: number) =>
    (await as(owner, "select * from ogevia_api.create_shift_series($1,$2,$3,null,$4::smallint[],'13:00','14:00',($5::date + $6::int)::date,($5::date + $7::int)::date,'refuse',null,null)", [org, client, svc, weekdays, today, from, to]))[0].series_id as string;
  seriesKept = await mkSeries(clients[0]!, "{1,2,3,4,5}", 7, 21);
  seriesGone = await mkSeries(clients[1]!, "{2,4}", 7, 21);
  await A("insert into ogevia.shift_series_skipped_dates (series_id, organization_id, local_date, reason, minutes, recorded_by) select $1, $2, d, 'exceeds_authorization', 60, $3 from (select ($4::date + 8) d union all select ($4::date + 9)) x", [seriesKept, org, owner.userId, today]);
  // A shift that ended with no visit record, still holding authorization time (what 'reserved on shifts with no visit record' counts).
  const lin = (await A("select lineage_id from ogevia.client_authorizations where client_id = $1 limit 1", [clients[2]])).rows[0].lineage_id;
  const past = (await A("insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status, authorization_lineage_id) values ($1,$2,$3, now() - interval '30 hours', now() - interval '28 hours', 'scheduled', $4) returning id", [org, clients[2], svc, lin])).rows[0].id;
  await A("insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes) values ($1,$2,null,$3,(now() - interval '30 hours')::date,120)", [org, lin, past]);
  // Caregivers (kept): one with a sign-in, one pending documents without. An assignment links a caregiver to a test client.
  const cgUser = (await A("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Caregiver (synthetic)') returning id", [randomUUID()])).rows[0].id;
  const cg = (await A("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name, status) values ($1,$2,'CG-1','Synthetic','CG1','active') returning id", [org, cgUser])).rows[0].id;
  await A("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name, status) values ($1,null,'CG-2','Synthetic','CG2','pending_documents')", [org]);
  await A("insert into ogevia.caregiver_assignments (organization_id, client_id, caregiver_record_id, service_id, effective_start) values ($1,$2,$3,$4,current_date)", [org, clients[0], cg, svc]);
  await A("update ogevia.caregiver_records set status = 'inactive' where id = $1", [cg]); // as in production: inactive, with a sign-in kept
  // A draft preparation row (added after scheduling: a client in preparation cannot be scheduled) to prove they are cleared too.
  for (const id of clients) await A("insert into ogevia.client_preparation (client_id, organization_id, stage, updated_by) values ($1,$2,'draft',$3)", [id, org, owner.userId]);
  // Make the clients inactive through the application function, as production's were.
  for (const id of clients) await as(owner, "select ogevia_api.set_client_status($1, $2, 'inactive', 'Test data (synthetic)')", [org, id]);
  // Another agency with an ACTIVE client, a name and a shift: must be untouched.
  const cD = (await as(ownerD, "select * from ogevia_api.create_client($1, 'Synthetic', 'OtherAgency')", [orgD]))[0].client_id as string;
  await as(ownerD, "select ogevia_api.create_client_authorization($1,$2,$3,'Synthetic Payer',600,(date_trunc('month',$4::date))::date,($4::date + 90),'SYN-D',null,null,null,null)", [orgD, cD, svcD, today]);
  await as(ownerD, "select * from ogevia_api.create_shift($1,$2,$3,($4::date + 2)::date,'09:00'::time,'11:00'::time,null,null)", [orgD, cD, svcD, today]);
  authIdsBefore = (await A("select md5(string_agg(id::text, ',' order by id)) h from ogevia.client_authorizations where organization_id = $1", [org])).rows[0].h;
});
afterAll(async () => db?.drop());

describe("option 1: clear the linked test records of the retained inactive clients", () => {
  it("the fixture looks like production: inactive clients with authorizations, names, scheduled shifts, reservations, a protected series and caregivers", async () => {
    const c = await counts();
    expect(c).toMatchObject({ clients: 3, auths: 3, names: 3, signins: 1, caregivers: 2 });
    expect(c.shifts).toBeGreaterThan(20);
    expect(c.reservations).toBe(c.shifts);
    expect(c.series).toBe(2);
    expect(c.skipped).toBe(2);
    expect(await n("select count(*) n from ogevia.clients where organization_id = $1 and status <> 'inactive'", [org])).toBe(0);
  });

  it("BEFORE: the dashboard is affected by the test shifts and reservations", () => {
    const d = dash();
    expect(Number(d.overview.upcoming_staffing_shifts)).toBeGreaterThan(10);   // the "Upcoming staffing" card, even though every client is inactive
    expect(Number(d.overview.needs_attention_now_items)).toBeGreaterThan(0);   // the "Needs attention now" card
    expect(Number(d.tiles.scheduling_tile)).toBeGreaterThan(0);
    expect(Number(d.hours.reserved)).toBeGreaterThan(0);
    expect(Number(d.hours.remaining)).toBeLessThan(Number(d.hours.authorized)); // reserved hours reduce what is left
    expect(Number(d.hours.scheduled) + Number(d.hours.committed)).toBeGreaterThan(0);
    expect(Number(d.reconcile.shifts_to_reconcile)).toBe(1);
    expect(Number(d.reconcile.reserved_minutes)).toBe(120);
  });

  it("dry run: reports what would go and what stays, and changes nothing", async () => {
    const before = await counts();
    const r = psql(CLEAR, { org_slug: slug, expected_clients: "3", mode: "dry-run" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
    expect(r.stdout).toMatch(/removed\|shifts\|\d+/);
    expect(r.stdout).toMatch(/kept\|shift_series\|1\|protected history/);
    expect(await counts()).toEqual(before);
  });

  it("refuses: wrong count, no confirmation, no snapshot, a disabled protection, and an in-scope client that is not inactive", async () => {
    const before = await counts();
    const base = { org_slug: slug, expected_clients: "3" };
    expect(psql(CLEAR, { ...base, expected_clients: "4", mode: "dry-run" }).stderr).toMatch(/expected_clients/);
    expect(psql(CLEAR, { ...base, mode: "apply", snapshot_id: SNAP }).stderr).toMatch(/confirm=CLEAR/);
    expect(psql(CLEAR, { ...base, mode: "apply", confirm: `CLEAR-${slug}-3` }).stderr).toMatch(/snapshot_id/);
    await A("alter table ogevia.client_authorizations disable trigger client_authorizations_no_delete");
    try { expect(psql(CLEAR, { ...base, mode: "dry-run" }).stderr).toMatch(/delete-protection triggers are missing or disabled/); }
    finally { await A("alter table ogevia.client_authorizations enable trigger client_authorizations_no_delete"); }
    await as(owner, "select ogevia_api.set_client_status($1, $2, 'active', 'temporary (synthetic)')", [org, clients[2]]);
    try { expect(psql(CLEAR, { ...base, mode: "dry-run" }).stderr).toMatch(/not inactive/); }
    finally { await as(owner, "select ogevia_api.set_client_status($1, $2, 'inactive', 'Test data (synthetic)')", [org, clients[2]]); }
    expect((await counts()).shifts).toBe(before.shifts);
  });

  it("apply: removes the linked test records and names; keeps client rows, authorizations, caregivers and sign-ins, memberships, other agencies, protections", async () => {
    const before = await counts();
    const r = psql(CLEAR, { org_slug: slug, expected_clients: "3", mode: "apply", snapshot_id: SNAP, confirm: `CLEAR-${slug}-3` });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("APPLIED");
    const after = await counts();
    expect(after).toMatchObject({ shifts: 0, reservations: 0, names: 0, assignments: 0 });
    expect(after.series).toBe(1);   // the series without protected history is gone; the one with skipped-date history stays
    expect(after.skipped).toBe(before.skipped);
    expect(await n("select count(*) n from ogevia.shift_series where id = $1", [seriesKept])).toBe(1);
    expect(await n("select count(*) n from ogevia.shift_series where id = $1", [seriesGone])).toBe(0);
    expect(await n("select count(*) n from ogevia.client_preparation where organization_id = $1", [org])).toBe(0);
    // Kept exactly.
    expect(after.clients).toBe(3);
    expect(after.auths).toBe(before.auths);
    expect((await A("select md5(string_agg(id::text, ',' order by id)) h from ogevia.client_authorizations where organization_id = $1", [org])).rows[0].h).toBe(authIdsBefore);
    expect(after.caregivers).toBe(2);
    expect(after.signins).toBe(1);
    expect(after.members).toBe(before.members);
    expect(after.otherShifts).toBe(before.otherShifts);
    expect(after.otherNames).toBe(before.otherNames);
    expect(after.triggers).toBe(before.triggers);
    expect(after.audit).toBe(before.audit + 1);
    const ev = (await A("select after_state from ogevia.audit_events where organization_id = $1 and action = 'client.test_linked_data_removed'", [org])).rows[0].after_state;
    expect(ev.clients_in_scope).toBe(3);
    expect(JSON.stringify(ev)).not.toMatch(/Synthetic|Test(One|Two|Three)/);
  });

  it("AFTER: the test shifts and reservations no longer affect the dashboard totals; the authorized hours are untouched", () => {
    const d = dash();
    expect(Number(d.overview.upcoming_staffing_shifts)).toBe(0);
    expect(Number(d.overview.needs_attention_now_items)).toBe(0);
    expect(Number(d.overview.urgent_shifts)).toBe(0);
    expect(Number(d.overview.shifts_with_no_visit_record)).toBe(0);
    expect(Number(d.overview.reconciliation_minutes)).toBe(0);
    expect(Number(d.tiles.scheduling_tile)).toBe(0);
    expect(Number(d.tiles.needs_attention_tile)).toBe(0);
    expect(Number(d.schedule.upcoming_shifts)).toBe(0);
    expect(Number(d.schedule.open_shifts)).toBe(0);
    expect(Number(d.hours.reserved)).toBe(0);
    expect(Number(d.hours.scheduled)).toBe(0);
    expect(Number(d.hours.committed)).toBe(0);
    expect(Number(d.hours.needs_reconciliation)).toBe(0);
    expect(Number(d.reconcile.shifts_to_reconcile)).toBe(0);
    expect(Number(d.reconcile.reserved_minutes)).toBe(0);
    expect(Number(d.hours.authorized)).toBeGreaterThan(0);               // the retained authorizations still count as authorized
    expect(Number(d.hours.remaining)).toBe(Number(d.hours.authorized) - Number(d.hours.worked)); // nothing is held any more: all authorized hours are available again
  });

  it("screens: every client read the app makes still works for the retained clients, with names now empty", async () => {
    for (const id of clients) {
      const list = await as(owner, "select * from ogevia_api.list_clients($1)", [org]);
      const row = list.find((r) => r.client_id === id);
      expect(row, "client is still listed").toBeTruthy();
      expect(row.legal_first_name ?? null).toBeNull();
      expect(row.legal_last_name ?? null).toBeNull();
      expect(row.status).toBe("inactive");
      expect((await as(owner, "select * from ogevia_api.list_client_authorizations($1, $2)", [org, id])).length).toBe(1);
      for (const sql of [
        "select * from ogevia_api.get_client_readiness($1, $2)", "select * from ogevia_api.list_client_documents($1, $2)",
        "select * from ogevia_api.list_client_audit($1, $2, 100)", "select * from ogevia_api.get_client_issue_history($1, $2)",
      ]) await as(owner, sql, [org, id]); // must not throw
    }
    expect((await as(owner, "select * from ogevia_api.list_client_directory($1)", [org])).length).toBe(3);
    expect((await as(owner, "select * from ogevia_api.list_shifts($1, current_date, current_date + 120)", [org])).length).toBe(0);
    expect((await as(owner, "select * from ogevia_api.list_caregivers($1)", [org])).length).toBe(2);
  });

  it("audit history is preserved untouched: the raw events keep the names recorded at creation, but no application audit screen or report exposes a value", async () => {
    // The names live on ONLY inside the append-only client.created events (database level). Audit is never altered by this cleanup.
    expect(await n("select count(*) n from ogevia.audit_events where organization_id = $1 and action = 'client.created' and after_state ? 'legal_first_name'", [org])).toBe(3);
    const clientAudit = JSON.stringify(await as(owner, "select * from ogevia_api.list_client_audit($1, $2, 100)", [org, clients[0]]));
    const agencyAudit = JSON.stringify(await as(owner, "select ogevia_api.list_audit_report($1, current_date - 30, current_date + 1) r", [org]));
    for (const shown of [clientAudit, agencyAudit]) {
      expect(shown).toContain("legal_first_name");          // the FIELD NAME is shown (what changed) ...
      expect(shown).not.toMatch(/TestOne|TestTwo|TestThree|Synthetic/); // ... never the value
    }
  });

  it("a second run removes nothing more and keeps everything it kept", async () => {
    const before = await counts();
    const r = psql(CLEAR, { org_slug: slug, expected_clients: "3", mode: "dry-run" });
    expect(r.status, r.stderr).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it("the script names every unprotected table that hangs off a client, never deletes a client or an authorization, and never bypasses a protection", async () => {
    const { rows } = await A(`
      with recursive fk as (select c.conrelid::regclass::text child, c.confrelid::regclass::text parent from pg_constraint c where c.contype = 'f' and c.connamespace = 'ogevia'::regnamespace),
      tree as (select 'ogevia.clients'::text tbl, array['ogevia.clients']::text[] path
               union all select f.child, t.path || f.child from tree t join fk f on f.parent = t.tbl where not f.child = any(t.path)),
      prot as (select (t.tgrelid::regclass)::text tbl from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'forbid_delete' and not t.tgisinternal),
      guard as (select (t.tgrelid::regclass)::text tbl from pg_trigger t where not t.tgisinternal and t.tgname ~ 'guard|history' and (t.tgtype & 8) = 8)
      select distinct tbl from tree where tbl not in (select tbl from prot) and tbl not in (select tbl from guard) and tbl <> 'ogevia.clients' order by 1`);
    const sql = readFileSync(CLEAR, "utf8");
    expect(rows.length).toBeGreaterThan(10);
    for (const { tbl } of rows) expect(sql.includes(`delete from ${tbl} `) || sql.includes(`delete from ${tbl} where`) || sql.includes(`'${tbl.replace("ogevia.", "")}'`), `${tbl} must be handled by the script`).toBe(true);
    const code = sql.replace(/^\s*--.*$/gm, "");
    expect(code).not.toMatch(/delete\s+from\s+ogevia\.(clients|client_authorizations)\b/i);
    expect(code).not.toMatch(/disable\s+trigger|session_replication_role\s*=|set\s+session_replication_role|alter\s+table|truncate|drop\s+(table|trigger)/i);
  });
});
