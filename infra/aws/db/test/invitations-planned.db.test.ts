// 0025 Caregiver invitations and planned assignments. SYNTHETIC data only.
// Every call runs as the application role through begin_request.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 700);
  today = await orgToday(db);
});
afterAll(async () => db?.drop());

const q = async <T = any>(a: Actor, sql: string, params: unknown[] = []) =>
  asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
// Since 0085 the API refuses to create an Approved/Active caregiver around the onboarding gate, so a fixture that needs an already-approved record (as records that existed
// before the gate do) creates it through the API as onboarding and then sets the status directly.
const newRecord = async (a: Actor, last: string, status = "ready") => {
  const id = (await q<{ caregiver_record_id: string }>(a, "select * from ogevia_api.create_caregiver($1, 'Synthetic', $2, null, $3)", [w.orgA, last, status === "ready" || status === "active" ? "onboarding" : status]))[0]!.caregiver_record_id;
  if (status === "ready" || status === "active") await db.admin.query("update ogevia.caregiver_records set status = $2, onboarding_required = false where id = $1", [id, status]);
  return id;
};
const begin = (a: Actor, record: string, email: string, org = w.orgA) =>
  q<{ begin_caregiver_invitation: string }>(a, "select ogevia_api.begin_caregiver_invitation($1, $2, $3)", [org, record, email]).then((r) => r[0]!.begin_caregiver_invitation);
const complete = (a: Actor, record: string, email: string, sub: string, existing = false, org = w.orgA) =>
  q<{ invitation_id: string; existing_account: boolean }>(a, "select * from ogevia_api.complete_caregiver_invitation($1, $2, $3, $4, $5)", [org, record, email, sub, existing]).then((r) => r[0]!);
const assign = (a: Actor, record: string, client = w.clientA1) =>
  q<{ assignment_id: string; has_authorization: boolean; grants_access: boolean }>(a,
    "select * from ogevia_api.create_assignment($1, $2, $3, $4, $5::date, null, null)", [w.orgA, record, client, w.serviceA, today]).then((r) => r[0]!);
const myClients = (sub: string) => asActor(db, sub, async (c) =>
  (await c.query("select * from ogevia_api.list_assigned_visit_clients($1)", [w.orgA])).rows.map((x: any) => x.client_id as string));
const caregiverRow = async (record: string) =>
  (await q(w.managerA, "select * from ogevia_api.list_caregivers($1)", [w.orgA])).find((r) => r.caregiver_record_id === record);

describe("planned assignments", () => {
  it("an assignment can be prepared before sign-in; it grants nothing until the caregiver is invited AND ready", async () => {
    const record = await newRecord(w.managerA, "Planned One", "onboarding");
    const a = await assign(w.managerA, record);
    expect(a).toMatchObject({ grants_access: false, has_authorization: true });
    const listed = (await q(w.managerA, "select * from ogevia_api.list_assignments($1, null, $2)", [w.orgA, record]))[0];
    expect(listed).toMatchObject({ assignment_id: a.assignment_id, state: "current", grants_access: false });
    expect((await caregiverRow(record))).toMatchObject({ has_sign_in: false, planned_assignments: 1, active_assignments: 1 });

    // Invited while still onboarding: signed in, but still no access to the client.
    const sub = crypto.randomUUID();
    await complete(w.managerA, record, "planned.one@example.test", sub);
    expect(await myClients(sub)).not.toContain(w.clientA1);
    expect((await q(w.managerA, "select * from ogevia_api.list_assignments($1, null, $2)", [w.orgA, record]))[0].grants_access).toBe(false);

    // Ready: access starts automatically; a visit can start.
    // 0086: Approved/Active are no longer set by the picker (Approve for work needs the hard requirements); the fixture sets the stored stage directly
    await db.admin.query("update ogevia.caregiver_records set status = 'ready' where id = $1", [record]);
    expect(await myClients(sub)).toContain(w.clientA1);
    const userId = (await db.admin.query("select id from ogevia.app_users where cognito_sub = $1", [sub])).rows[0].id;
    expect(await api.start(db, { sub, userId }, w.orgA, w.clientA1, w.serviceA)).toBeTruthy();
  });

  it("back to onboarding withdraws access from current assignments; ended history is untouched", async () => {
    const record = await newRecord(w.managerA, "Planned Two", "ready");
    const sub = crypto.randomUUID();
    await complete(w.managerA, record, "planned.two@example.test", sub);
    const a = await assign(w.managerA, record);
    expect(a.grants_access).toBe(true);
    expect(await myClients(sub)).toContain(w.clientA1);
    await q(w.managerA, "select * from ogevia_api.set_caregiver_status($1, $2, 'onboarding', 'Paperwork lapsed (synthetic)')", [w.orgA, record]);
    expect(await myClients(sub)).not.toContain(w.clientA1);
    await db.admin.query("update ogevia.caregiver_records set status = 'active' where id = $1", [record]);
    expect(await myClients(sub)).toContain(w.clientA1);
  });

  it("making a caregiver inactive ends planned assignments too, and they are counted", async () => {
    const record = await newRecord(w.managerA, "Planned Three", "onboarding");
    await assign(w.managerA, record);
    await assign(w.managerA, record, w.clientA2);
    const [r] = await q(w.managerA, "select * from ogevia_api.set_caregiver_status($1, $2, 'inactive', 'Did not join (synthetic)')", [w.orgA, record]);
    expect(r.ended_assignments).toBe(2);
    expect(await caregiverRow(record)).toMatchObject({ active_assignments: 0, planned_assignments: 0 });
    await expectPgError(assign(w.managerA, record), "OGV22", /inactive/);
  });

  it("duplicates are refused for planned assignments too", async () => {
    const record = await newRecord(w.managerA, "Planned Four", "onboarding");
    await assign(w.managerA, record);
    await expectPgError(assign(w.managerA, record), "OGC09", /already assigned/);
  });

  it("a scheduler or caregiver cannot plan assignments; another agency cannot see them", async () => {
    const record = await newRecord(w.managerA, "Planned Five", "onboarding");
    await expectPgError(assign(w.schedulerA, record), "OGA03");
    await expectPgError(assign(w.caregiverA1, record), "OGA03");
    expect(await q(w.managerB, "select * from ogevia_api.list_assignments($1, null, $2)", [w.orgA, record])).toEqual([]);
  });
});

describe("caregiver invitations", () => {
  it("manager invites: a caregiver membership only, record linked, audited without the email, first sign-in recorded once", async () => {
    const record = await newRecord(w.managerA, "Invitee One");
    expect(await begin(w.managerA, record, "  Invitee.One@Example.TEST ")).toBe("invitee.one@example.test");
    const sub = crypto.randomUUID();
    const inv = await complete(w.managerA, record, "invitee.one@example.test", sub);
    expect(inv.existing_account).toBe(false);
    const m = (await db.admin.query(
      "select m.role, m.status from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = $1", [sub])).rows;
    expect(m).toEqual([{ role: "caregiver", status: "active" }]);
    expect(await caregiverRow(record)).toMatchObject({ has_sign_in: true, sign_in_status: "active", invitation_email: "invitee.one@example.test", invitation_send_count: 1, first_signed_in_at: null });
    const audit = (await db.admin.query("select action, after_state::text as after from ogevia.audit_events where entity_id = $1 and action like 'caregiver.invit%'", [record])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].after).not.toContain("@");

    // Resend before first sign-in: allowed, counted, audited.
    await expectPgError(q(w.managerA, "select ogevia_api.begin_invitation_resend($1, $2) as email", [w.orgA, record]), "OGC09", /just sent/); // 0086: a minute between sends
    await db.admin.query("update ogevia.caregiver_invitations set last_sent_at = now() - interval '2 minutes' where caregiver_record_id = $1", [record]);
    expect((await q(w.managerA, "select ogevia_api.begin_invitation_resend($1, $2) as email", [w.orgA, record]))[0].email).toBe("invitee.one@example.test");
    expect((await q(w.managerA, "select ogevia_api.record_invitation_resent($1, $2) as n", [w.orgA, record]))[0].n).toBe(2);
    expect((await db.admin.query("select count(*)::int as n from ogevia.audit_events where entity_id = $1 and action = 'caregiver.invitation_resent'", [record])).rows[0].n).toBe(1);

    // First sign-in (the app loads /v1/me) is recorded once; resend then refused.
    await asActor(db, sub, (c) => c.query("select ogevia_api.note_my_sign_in()"));
    const first = (await caregiverRow(record)).first_signed_in_at;
    expect(first).not.toBeNull();
    await asActor(db, sub, (c) => c.query("select ogevia_api.note_my_sign_in()"));
    expect((await caregiverRow(record)).first_signed_in_at).toEqual(first);
    await expectPgError(q(w.managerA, "select ogevia_api.begin_invitation_resend($1, $2)", [w.orgA, record]), "OGC09", /already signed in/);
    await expectPgError(q(w.managerA, "select ogevia_api.record_invitation_resent($1, $2)", [w.orgA, record]), "OGC09");
  });

  it("no privilege escalation: a staff sign-in in this agency cannot be attached as a caregiver; roles never change", async () => {
    const record = await newRecord(w.managerA, "Invitee Two");
    await expectPgError(complete(w.managerA, record, "staff@example.test", w.ownerA.sub, true), "OGC09", /staff role/);
    await expectPgError(complete(w.managerA, record, "staff@example.test", w.managerA.sub, true), "OGC09", /staff role/);
    const roles = (await db.admin.query("select role from ogevia.organization_memberships where organization_id = $1 and user_id = $2", [w.orgA, w.ownerA.userId])).rows;
    expect(roles).toEqual([{ role: "organization_owner" }]);
    expect(await caregiverRow(record)).toMatchObject({ has_sign_in: false });
  });

  it("an existing caregiver sign-in from another agency can be linked here as a caregiver only", async () => {
    const record = await newRecord(w.managerA, "Invitee Three");
    const inv = await complete(w.managerA, record, "shared.caregiver@example.test", w.caregiverB1.sub, true);
    expect(inv.existing_account).toBe(true);
    const r = (await db.admin.query("select role, status from ogevia.organization_memberships where organization_id = $1 and user_id = $2", [w.orgA, w.caregiverB1.userId])).rows;
    expect(r).toEqual([{ role: "caregiver", status: "active" }]);
    await expectPgError(q(w.managerA, "select ogevia_api.begin_invitation_resend($1, $2)", [w.orgA, record]), "OGC09", /already had a sign-in/);
  });

  it("refusals: already linked, duplicate email, inactive record, sign-in linked elsewhere, bad input, wrong agency and role", async () => {
    const linked = await newRecord(w.managerA, "Invitee Four");
    const sub = crypto.randomUUID();
    await complete(w.managerA, linked, "four@example.test", sub);
    await expectPgError(begin(w.managerA, linked, "other@example.test"), "OGC09", /already has a sign-in/);
    await expectPgError(complete(w.managerA, linked, "other@example.test", crypto.randomUUID()), "OGC09", /already has a sign-in/);

    const other = await newRecord(w.managerA, "Invitee Five");
    await expectPgError(begin(w.managerA, other, "four@example.test"), "OGC09", /another caregiver/);
    await expectPgError(complete(w.managerA, other, "five@example.test", sub), "OGC09", /already linked to another caregiver/);
    await expectPgError(begin(w.managerA, other, "not-an-email"), "OGV22", /valid email/);
    await expectPgError(complete(w.managerA, other, "five@example.test", "not-a-sub"), "OGV22");

    const gone = await newRecord(w.managerA, "Invitee Six");
    await q(w.managerA, "select * from ogevia_api.set_caregiver_status($1, $2, 'inactive', 'Left (synthetic)')", [w.orgA, gone]);
    await expectPgError(begin(w.managerA, gone, "six@example.test"), "OGC09", /inactive/);

    await expectPgError(begin(w.schedulerA, other, "five@example.test"), "OGA03");
    await expectPgError(begin(w.caregiverA1, other, "five@example.test"), "OGA03");
    await expectPgError(complete(w.caregiverA1, other, "five@example.test", crypto.randomUUID()), "OGA03");
    await expectPgError(begin(w.managerB, other, "five@example.test"), "OGN04");
    await expectPgError(begin(w.managerB, other, "five@example.test", w.orgB), "OGN04");
    await expectPgError(complete(w.managerB, other, "five@example.test", crypto.randomUUID(), false, w.orgB), "OGN04");
    expect(await caregiverRow(other)).toMatchObject({ has_sign_in: false, invitation_email: null });
  });

  it("an invited caregiver's planned assignment gives access on the same day they are linked when already ready", async () => {
    const record = await newRecord(w.managerA, "Invitee Seven", "ready");
    expect((await assign(w.managerA, record)).grants_access).toBe(false);
    const sub = crypto.randomUUID();
    await complete(w.managerA, record, "seven@example.test", sub);
    expect(await myClients(sub)).toContain(w.clientA1);
  });

  it("existing assignments made by sign-in before 0025 keep access and gained their record id", async () => {
    const rows = (await db.admin.query(
      "select count(*)::int as n from ogevia.caregiver_assignments where caregiver_user_id is not null and caregiver_record_id is null")).rows[0].n;
    expect(rows).toBe(0);
  });
});
