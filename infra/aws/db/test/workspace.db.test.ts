// 0020: signed-in identity, agency branding, NEEDS ATTENTION counts and the
// monthly utilisation overview. SYNTHETIC data only. Every call runs as the
// application role through begin_request, like the API Lambda.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  asActor,
  createTestDb,
  endedVisit,
  expectPgError,
  freshClient,
  orgToday,
  seedWorld,
  signedVisit,
  type Actor,
  type TestDb,
  type World,
} from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 6000);
});
afterAll(async () => db?.drop());

const one = async <T = any>(a: Actor, sql: string, params: unknown[] = []) =>
  asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);

/** TEST-ONLY: shift a visit's server times into the past (triggers off, one connection). */
async function shiftVisit(visit: string, minutes: number) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    await c.query(
      "update ogevia.service_visits set time_in = time_in - make_interval(mins => $2), time_out = time_out - make_interval(mins => $2) where id = $1",
      [visit, minutes],
    );
  } finally {
    await c.query("reset session_replication_role");
    c.release();
  }
}

/** A new synthetic caregiver in org A (keeps one-open-visit rules independent per test). */
async function newCaregiver(): Promise<Actor> {
  const sub = crypto.randomUUID();
  const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Caregiver') returning id", [sub])).rows[0].id;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1, $2, 'caregiver', 'active')", [w.orgA, userId]);
  await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1, $2, $3, 'Synthetic', $3)",
    [w.orgA, userId, "UT-" + sub.slice(0, 8)]);
  return { userId, sub };
}

describe("identity (profile)", () => {
  it("returns the caller's own name and lets them complete it; audited; validated", async () => {
    const [before] = await one(w.managerA, "select * from ogevia_api.get_my_profile()");
    expect(before.user_id).toBe(w.managerA.userId);
    await expectPgError(one(w.managerA, "select ogevia_api.set_my_display_name($1)", [" x "]), "OGV22");
    const [r] = await one(w.managerA, "select ogevia_api.set_my_display_name($1) as name", ["  Synthetic Manager A  "]);
    expect(r.name).toBe("Synthetic Manager A");
    const [after] = await one(w.managerA, "select * from ogevia_api.get_my_profile()");
    expect(after.display_name).toBe("Synthetic Manager A");
    const audit = await db.admin.query(
      "select organization_id from ogevia.audit_events where action = 'user.display_name_set' and entity_id = $1", [w.managerA.userId]);
    expect(audit.rows.map((x) => x.organization_id)).toEqual([w.orgA]);
  });

  it("returns nothing for an unknown sign-in", async () => {
    await expect(asActor(db, "99999999-9999-4999-8999-999999999999", (c) => c.query("select * from ogevia_api.get_my_profile()"))).rejects.toMatchObject({ code: "OGA01" });
  });
});

describe("agency branding", () => {
  const set = (a: Actor, name: string, color: string | null) =>
    one(a, "select * from ogevia_api.set_organization_branding($1,$2,$3,null)", [w.orgA, name, color]);

  it("the owner sets the agency name and a readable accent colour; audited", async () => {
    const [r] = await set(w.ownerA, "Synthetic Agency A", "#1F5F8B");
    expect(r).toMatchObject({ display_name: "Synthetic Agency A", accent_color: "#1f5f8b" });
    const [m] = await one(w.caregiverA1, "select * from ogevia_api.get_organization_branding($1)", [w.orgA]);
    expect(m).toMatchObject({ display_name: "Synthetic Agency A", accent_color: "#1f5f8b" });
    const audit = await db.admin.query("select count(*)::int as n from ogevia.audit_events where action = 'organization.branding_updated'");
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it("refuses a colour too light for white text, with the measured contrast", async () => {
    await expectPgError(set(w.ownerA, "Synthetic Agency A", "#ffd966"), "OGV22", /contrast .*needs 4\.5:1/);
    await expectPgError(set(w.ownerA, "Synthetic Agency A", "blue"), "OGV22");
  });

  it("managers, caregivers and other agencies cannot change it; other agencies cannot read it", async () => {
    await expectPgError(set(w.managerA, "X Agency", null), "OGA03");
    await expectPgError(set(w.caregiverA1, "X Agency", null), "OGA03");
    await expectPgError(set(w.managerB, "X Agency", null), "OGN04");
    await expectPgError(set(w.outsider, "X Agency", null), "OGN04");
    expect(await one(w.managerB, "select * from ogevia_api.get_organization_branding($1)", [w.orgA])).toEqual([]);
  });

  it("only the owner holds organization.update", async () => {
    const r = await db.admin.query("select role::text from ogevia.role_permissions where permission_key = 'organization.update'");
    expect(r.rows.map((x) => x.role)).toEqual(["organization_owner"]);
  });
});

describe("NEEDS ATTENTION counts", () => {
  const summary = (a: Actor, org = w.orgA) =>
    one(a, "select * from ogevia_api.get_attention_summary($1)", [org]);

  it("counts missing Time Out, not confirmed and needs review exactly like the Visit records rules", async () => {
    const [base] = await summary(w.managerA);

    // Unscheduled visit open 13 h: Missing Time Out.
    const f2 = await freshClient(db, w, w.caregiverA2, 6000);
    const open = await api.start(db, w.caregiverA2, w.orgA, f2.client, f2.service, null, "Synthetic unscheduled test visit");
    await shiftVisit(open, 13 * 60);
    // Ended 61 min ago, not confirmed.
    const f3 = await freshClient(db, w, w.caregiverA3, 6000);
    const ended = await endedVisit(db, w.caregiverA3, w, 30, w.orgA, f3.client, f3.service);
    await shiftVisit(ended, 61);
    // Unable to confirm: administrator review.
    const f1 = await freshClient(db, w, w.caregiverA1, 6000);
    const review = await endedVisit(db, w.caregiverA1, w, 20, w.orgA, f1.client, f1.service);
    await api.confirm(db, w.caregiverA1, review, { method: "unable_to_confirm", reason: "Client asleep (synthetic)" });

    const [after] = await summary(w.managerA);
    expect(after.missing_time_out - base.missing_time_out).toBe(1);
    expect(after.not_confirmed - base.not_confirmed).toBe(1);
    expect(after.needs_review - base.needs_review).toBe(1);
    expect(after.total).toBe(after.missing_time_out + after.not_confirmed + after.needs_review);
  });

  it("an open visit inside 12 h without a schedule is not counted", async () => {
    const [base] = await summary(w.managerA);
    const fb = await freshClient(db, w, w.caregiverA1, 6000);
    const v = await signedVisit(db, w.caregiverA1, w, 10, w.orgA, fb.client);
    expect(v.result.status).toBe("signed");
    const [after] = await summary(w.managerA);
    expect(after.missing_time_out).toBe(base.missing_time_out);
    expect(after.billing_ready_unapproved - base.billing_ready_unapproved).toBe(1);
  });

  it("scheduler sees counts but not the billing count; caregivers and other agencies get nothing", async () => {
    const [s] = await summary(w.schedulerA);
    expect(s.needs_review).toBeGreaterThanOrEqual(1);
    expect(s.billing_ready_unapproved).toBeNull();
    expect(await summary(w.caregiverA1)).toEqual([]);
    expect(await summary(w.managerB)).toEqual([]);
    expect(await summary(w.outsider)).toEqual([]);
  });
});

describe("utilisation overview", () => {
  let service: string;
  let month: string;
  beforeAll(async () => {
    month = (await orgToday(db)).slice(0, 7) + "-01";
    // A dedicated synthetic service so the totals are exact.
    service = (await db.admin.query("insert into ogevia.services (organization_id, code, name) values ($1, 'UTL', 'Utilisation test (synthetic)') returning id", [w.orgA])).rows[0].id;
  });

  async function clientWithAuth(caregiver: Actor, minutes: number, rateCents: number | null) {
    const today = await orgToday(db);
    const client = (await db.admin.query("insert into ogevia.clients (organization_id) values ($1) returning id", [w.orgA])).rows[0].id;
    await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)",
      [w.orgA, caregiver.userId, client, service, today]);
    const auth = (await db.admin.query(
      `insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end, hourly_rate_cents)
       values ($1,$2,$3,'SYNTHETIC-PAYER',$4, date_trunc('month', $5::date)::date, (date_trunc('month', $5::date) + interval '1 month - 1 day')::date, $6) returning id`,
      [w.orgA, client, service, minutes, today, rateCents])).rows[0].id;
    return { client, auth };
  }
  const overview = (a: Actor) =>
    one(a, "select * from ogevia_api.get_utilisation_overview($1, $2::date)", [w.orgA, month]).then((r) => r.find((x) => x.service_id === service));

  it("totals per service; the owner sees values; managers see hours only; missing rates are reported, not $0", async () => {
    const [cg1, cg2] = [await newCaregiver(), await newCaregiver()];
    const rated = await clientWithAuth(cg1, 600, 3000);
    const unrated = await clientWithAuth(cg2, 300, null);
    // Worked/billable 60 min on the rated lineage, 30 on the unrated one.
    const v1 = (await signedVisit(db, cg1, w, 60, w.orgA, rated.client, service)).visit;
    await signedVisit(db, cg2, w, 30, w.orgA, unrated.client, service);
    await asActor(db, w.managerA.sub, (c) => c.query("select ogevia_api.approve_visit_for_billing($1, 60, null, null)", [v1]));

    const o = await overview(w.ownerA);
    expect(o).toMatchObject({
      client_count: 2, authorized_minutes: 900, worked_minutes: 90, billable_minutes: 90,
      approved_minutes: 60, remaining_minutes: 810, lineages_without_rate: 1,
    });
    expect(Number(o!.billable_value_cents)).toBe(3000);   // 60 min x $30/h; the unrated 30 min is excluded, not $0
    expect(Number(o!.approved_value_cents)).toBe(3000);
    expect(Number(o!.unused_value_cents)).toBe(27000);   // 540 unused rated min x $30/h

    const m = await overview(w.managerA);
    expect(m).toMatchObject({ authorized_minutes: 900, worked_minutes: 90, approved_minutes: 60 });
    expect(m!.billable_value_cents).toBeNull();
    expect(m!.approved_value_cents).toBeNull();
    expect(m!.unused_value_cents).toBeNull();
  });

  it("an amendment replaces the monthly limit; versions are never added together", async () => {
    const c = await clientWithAuth(await newCaregiver(), 120, 2000);
    const before = (await overview(w.ownerA))!.authorized_minutes;
    await api.amend(db, w.managerA, c.auth, 240, "Increase (synthetic)");
    const after = (await overview(w.ownerA))!.authorized_minutes;
    expect(after - before).toBe(120);   // 120 -> 240, not 120 + 240
  });

  it("caregivers and other agencies get nothing", async () => {
    expect(await one(w.caregiverA1, "select * from ogevia_api.get_utilisation_overview($1, $2::date)", [w.orgA, month])).toEqual([]);
    expect(await one(w.managerB, "select * from ogevia_api.get_utilisation_overview($1, $2::date)", [w.orgA, month])).toEqual([]);
  });
});

describe("agency logo (metadata; the file itself is covered by the API test)", () => {
  const sha = "b".repeat(64);
  const setLogo = (a: Actor, key?: string, size = 1000) => {
    const id = crypto.randomUUID();
    return one(a, "select ogevia_api.set_organization_logo($1,$2,$3,'v1','image/png',$4,$5,null) as s", [w.orgA, id, key ?? `${w.orgA}/branding/logo/${id}`, size, sha]);
  };
  it("only the owner sets it, with the server-built key and size limit; members read it; audited", async () => {
    await expectPgError(setLogo(w.managerA), "OGA03");
    await expectPgError(setLogo(w.managerB), "OGN04");
    await expectPgError(setLogo(w.ownerA, "elsewhere/logo"), "OGV22");
    await expectPgError(setLogo(w.ownerA, undefined, 600000), "OGV22");
    await setLogo(w.ownerA);
    const [b] = await one(w.caregiverA1, "select * from ogevia_api.get_organization_branding($1)", [w.orgA]);
    expect(b.logo_sha256).toBe(sha);
    expect(await one(w.caregiverA1, "select * from ogevia_api.get_organization_logo($1)", [w.orgA])).toHaveLength(1);
    expect(await one(w.managerB, "select * from ogevia_api.get_organization_logo($1)", [w.orgA])).toEqual([]);
    await expectPgError(one(w.managerA, "select ogevia_api.clear_organization_logo($1)", [w.orgA]), "OGA03");
    await one(w.ownerA, "select ogevia_api.clear_organization_logo($1)", [w.orgA]);
    expect(await one(w.caregiverA1, "select * from ogevia_api.get_organization_logo($1)", [w.orgA])).toEqual([]);
    const audit = await db.admin.query("select action from ogevia.audit_events where action like 'organization.logo%' order by id");
    expect(audit.rows.map((r) => r.action)).toEqual(["organization.logo_updated", "organization.logo_removed"]);
  });
});

describe("restricted client names", () => {
  const dir = (a: Actor) => one(a, "select * from ogevia_api.list_client_directory($1)", [w.orgA]);
  const setName = (a: Actor, client: string, first: string, last: string, org = w.orgA) =>
    one(a, "select ogevia_api.set_client_legal_name($1,$2,$3,$4,null)", [org, client, first, last]);

  it("owners and managers set and see names; schedulers see codes only; caregivers and other agencies see nothing; audited", async () => {
    await setName(w.managerA, w.clientA1, "Synthetic", "Client One");
    await expectPgError(setName(w.schedulerA, w.clientA1, "X", "Y"), "OGA03");
    await expectPgError(setName(w.caregiverA1, w.clientA1, "X", "Y"), "OGA03");
    await expectPgError(setName(w.managerB, w.clientA1, "X", "Y"), "OGN04");
    await expectPgError(setName(w.managerB, w.clientA1, "X", "Y", w.orgB), "OGN04");
    await expectPgError(setName(w.managerA, w.clientA1, " ", "Y"), "OGV22");
    const m = (await dir(w.managerA)).find((r) => r.client_id === w.clientA1);
    expect(m).toMatchObject({ legal_first_name: "Synthetic", legal_last_name: "Client One" });
    const o = (await dir(w.ownerA)).find((r) => r.client_id === w.clientA1);
    expect(o.legal_last_name).toBe("Client One");
    const sch = (await dir(w.schedulerA)).find((r) => r.client_id === w.clientA1);
    expect(sch).toMatchObject({ legal_first_name: null, legal_last_name: null });
    expect(await dir(w.caregiverA1)).toEqual([]);
    expect(await dir(w.managerB)).toEqual([]);
    const audit = await db.admin.query("select count(*)::int as n from ogevia.audit_events where action = 'client.legal_name_set' and entity_id = $1", [w.clientA1]);
    expect(audit.rows[0].n).toBe(1);
  });

  it("caregiver-facing functions never carry names", async () => {
    const r = await one(w.caregiverA1, "select * from ogevia_api.list_assigned_visit_clients($1)", [w.orgA]);
    expect(JSON.stringify(r)).not.toContain("Client One");
  });
});
