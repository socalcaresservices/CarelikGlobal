// 0086 (PENDING: infra/aws/db/pending): staff management. Staff types (labels, no authority), staff profiles, supported system roles, staff invitations, history. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";
import { applyPendingMigrations, createTestDbWithPending, rollBackPendingMigrations } from "./pending.js";

let db: TestDb;
let w: World;
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const types = (a: Actor, org = () => w.orgA) => call(a, "select * from ogevia_api.list_staff_types($1)", [org()]);
const typeId = async (name: string, org = () => w.orgA) => (await db.admin.query("select id from ogevia.staff_types where organization_id = $1 and lower(name) = lower($2)", [org(), name])).rows[0].id as string;
const createType = (a: Actor, name: string, org = () => w.orgA) => call<{ create_staff_type: string }>(a, "select ogevia_api.create_staff_type($1,$2)", [org(), name]).then((r) => r[0]!.create_staff_type);
const staff = (a: Actor, org = () => w.orgA) => call(a, "select * from ogevia_api.list_staff($1)", [org()]);
const createStaff = (a: Actor, name: string, type: string, email: string | null = null, phone: string | null = null, org = () => w.orgA) =>
  call<{ create_staff: string }>(a, "select ogevia_api.create_staff($1,$2,$3,$4,$5)", [org(), name, type, email, phone]).then((r) => r[0]!.create_staff);
const invite = async (a: Actor, profile: string, email: string, role: string, sub = randomUUID(), existing = false) => {
  const normalized = (await call<{ e: string }>(a, "select ogevia_api.begin_staff_invitation($1,$2,$3,$4) as e", [w.orgA, profile, email, role]))[0]!.e;
  await call(a, "select * from ogevia_api.complete_staff_invitation($1,$2,$3,$4,$5,$6)", [w.orgA, profile, normalized, sub, existing, role]);
  return sub;
};
const setRole = (a: Actor, user: string, role: string, reason = "Moved to the front office") => call(a, "select ogevia_api.set_staff_role($1,$2,$3,$4) as r", [w.orgA, user, role, reason]);
const audit = (action: string) => db.admin.query("select organization_id, entity_id, reason, before_state, after_state from ogevia.audit_events where action = $1 order by id", [action]).then((r) => r.rows);
// What the person's role grants right now (the same tables ogevia.has_permission reads; the function itself is not callable by the application role).
const can = async (userSub: string, permission: string) =>
  (await db.admin.query(`select exists (select 1 from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id join ogevia.role_permissions rp on rp.role = m.role
     where m.organization_id = $1 and u.cognito_sub = $2 and m.status = 'active' and u.status = 'active' and rp.permission_key = $3) as ok`, [w.orgA, userSub, permission])).rows[0].ok as boolean;
const userOf = async (sub: string) => (await db.admin.query("select id from ogevia.app_users where cognito_sub = $1", [sub])).rows[0].id as string;
const READS = ["select * from ogevia_api.list_staff_types($1)", "select * from ogevia_api.list_staff($1)", "select * from ogevia_api.list_role_permissions($1)", "select * from ogevia_api.list_staff_audit($1)"];

beforeAll(async () => {
  db = await createTestDbWithPending();
  w = await seedWorld(db);
});
afterAll(async () => db.drop());

describe("who may see and manage staff", () => {
  it("only the organization owner holds staff.read and staff.manage", async () => {
    const rows = (await db.admin.query("select role::text r, permission_key k from ogevia.role_permissions where permission_key like 'staff.%' order by 1, 2")).rows;
    expect(rows).toEqual([{ r: "organization_owner", k: "staff.manage" }, { r: "organization_owner", k: "staff.read" }]);
  });

  it("managers, schedulers and caregivers are refused by the database on every staff function", async () => {
    const type = await typeId("Manager");
    for (const who of [w.managerA, w.schedulerA, w.caregiverA1]) {
      for (const sql of READS) await expectPgError(call(who, sql, [w.orgA]), "OGA03", /administrator/);
      await expectPgError(call(who, "select ogevia_api.create_staff_type($1,'Nope')", [w.orgA]), "OGA03");
      await expectPgError(call(who, "select ogevia_api.create_staff($1,'Nope',$2,null,null)", [w.orgA, type]), "OGA03");
      await expectPgError(setRole(who, w.caregiverA2.userId, "staff"), "OGA03");
      await expectPgError(call(who, "select ogevia_api.begin_staff_invitation($1,$2,'x@example.test','staff')", [w.orgA, randomUUID()]), "OGA03");
    }
  });

  it("another agency's people and an outsider get 'not found'; this owner cannot read or change another agency", async () => {
    await expectPgError(types(w.managerB), "OGN04");
    await expectPgError(types(w.outsider), "OGN04");
    await expectPgError(types(w.ownerA, () => w.orgB), "OGN04");
    await expectPgError(setRole(w.ownerA, w.managerB.userId, "staff"), "OGN04");
  });
});

describe("staff types are labels, never authority", () => {
  it("every agency starts with a default list (existing agencies by the migration, new ones by the trigger) and can add its own without a developer", async () => {
    const a = await types(w.ownerA);
    expect(a.map((t) => t.name)).toEqual(["Administrator", "Manager", "Scheduler", "Coordinator", "Supervisor", "Office Assistant", "Caregiver"]);
    const id = await createType(w.ownerA, "  Billing   Specialist ");
    expect((await types(w.ownerA)).find((t) => t.id === id)).toMatchObject({ name: "Billing Specialist", is_active: true, staff_count: "0" });
    expect((await audit("staff_type.created")).at(-1)).toMatchObject({ organization_id: w.orgA, entity_id: id, after_state: { name: "Billing Specialist", grants_access: false } });
  });

  it("names are unique per agency ignoring case; empty and over-long names are refused", async () => {
    await expectPgError(createType(w.ownerA, "billing specialist"), "OGC09", /already exists/);
    await expectPgError(createType(w.ownerA, "   "), "OGV22");
    await expectPgError(createType(w.ownerA, "x".repeat(61)), "OGV22");
    // the same name in another agency is fine
    const other = await db.admin.query("insert into ogevia.organizations (slug, display_name, timezone) values ('staff-types-b','B','America/Los_Angeles') returning id");
    expect((await db.admin.query("select count(*)::int n from ogevia.staff_types where organization_id = $1", [other.rows[0].id])).rows[0].n).toBe(7);
  });

  it("rename and deactivate are audited; an inactive type cannot be given to anyone new but keeps its current people", async () => {
    const id = await createType(w.ownerA, "Intake Clerk");
    await call(w.ownerA, "select ogevia_api.rename_staff_type($1,$2,'Intake Coordinator')", [w.orgA, id]);
    expect((await audit("staff_type.renamed")).at(-1)).toMatchObject({ before_state: { name: "Intake Clerk" }, after_state: { name: "Intake Coordinator" } });
    await expectPgError(call(w.ownerA, "select ogevia_api.rename_staff_type($1,$2,'manager')", [w.orgA, id]), "OGC09");
    const profile = await createStaff(w.ownerA, "Dana Intake", id);
    await call(w.ownerA, "select ogevia_api.set_staff_type_active($1,$2,false)", [w.orgA, id]);
    expect((await audit("staff_type.deactivated")).at(-1)).toMatchObject({ entity_id: id });
    await expectPgError(createStaff(w.ownerA, "New Person", id), "OGC09", /inactive/);
    expect((await staff(w.ownerA)).find((s) => s.profile_id === profile)).toMatchObject({ staff_type_name: "Intake Coordinator" });   // still theirs
    await call(w.ownerA, "select ogevia_api.set_staff_type_active($1,$2,true)", [w.orgA, id]);
    expect(await createStaff(w.ownerA, "New Person", id)).toBeTruthy();
  });

  it("a type named like a powerful role grants NOTHING: no column, role or permission is tied to it, and the person's access is whatever role they were given", async () => {
    const cols = (await db.admin.query("select column_name from information_schema.columns where table_schema = 'ogevia' and table_name in ('staff_types','staff_profiles')")).rows.map((r) => r.column_name as string);
    expect(cols.filter((c) => /role|permission|grant/i.test(c))).toEqual([]);
    const fks = (await db.admin.query(`select confrelid::regclass::text t from pg_constraint where contype = 'f' and conrelid in ('ogevia.staff_types'::regclass, 'ogevia.staff_profiles'::regclass)`)).rows.map((r) => r.t as string);
    expect(fks.filter((t) => /role|permission|membership/.test(t))).toEqual([]);
    const boss = await createType(w.ownerA, "Organization Owner");
    const profile = await createStaff(w.ownerA, "Titles Only", boss);
    const sub = await invite(w.ownerA, profile, "titles.only@example.test", "read_only");
    expect((await db.admin.query("select role::text r from ogevia.organization_memberships where organization_id = $1 and user_id = $2", [w.orgA, await userOf(sub)])).rows[0].r).toBe("read_only");
    for (const p of ["staff.manage", "staff.read", "accounts.manage", "organization.update", "shifts.manage", "billing.visits.read"]) expect(await can(sub, p), p).toBe(false);
  });
});

describe("staff profiles", () => {
  it("contact email and phone are separate from the sign-in email; validated; and never written to the audit trail", async () => {
    const type = await typeId("Scheduler");
    const id = await createStaff(w.ownerA, "Sam Scheduler", type, "Sam.Contact@Example.test", "(555) 010-1234");
    const row = (await staff(w.ownerA)).find((s) => s.profile_id === id);
    expect(row).toMatchObject({ staff_key: `profile:${id}`, display_name: "Sam Scheduler", contact_email: "sam.contact@example.test", phone: "(555) 010-1234", status: "active", access_status: "none", user_id: null, system_role: null });
    await expectPgError(createStaff(w.ownerA, "Bad Mail", type, "not-an-email"), "OGV22");
    await expectPgError(createStaff(w.ownerA, "Bad Phone", type, null, "call me"), "OGV22", /phone/);
    await expectPgError(createStaff(w.ownerA, "Dup Mail", type, "sam.contact@example.test"), "OGC09");
    await expectPgError(createStaff(w.ownerA, " ", type), "OGV22");
    await expectPgError(call(w.ownerA, "select ogevia_api.create_staff($1,'Wrong Agency',$2,null,null)", [w.orgA, await typeId("Manager", () => w.orgB)]), "OGN04");
    const entry = (await audit("staff.created")).find((e) => e.entity_id === id);
    expect(JSON.stringify(entry)).not.toMatch(/example\.test|010-1234|Sam/);
  });

  it("update changes the profile, can set it inactive, records what changed (not the values), and a no-op writes nothing", async () => {
    const id = await createStaff(w.ownerA, "Uma Update", await typeId("Coordinator"), "uma@example.test");
    const before = (await audit("staff.updated")).length;
    await call(w.ownerA, "select ogevia_api.update_staff($1,$2,'Uma Update',$3,'uma@example.test',null,'active')", [w.orgA, id, await typeId("Coordinator")]);
    expect((await audit("staff.updated")).length).toBe(before);
    await call(w.ownerA, "select ogevia_api.update_staff($1,$2,'Uma Updated',$3,'uma.new@example.test','555 0100','inactive')", [w.orgA, id, await typeId("Supervisor")]);
    const entry = (await audit("staff.updated")).at(-1)!;
    expect(entry.after_state).toMatchObject({ staff_type: "Supervisor", status: "inactive", changed: expect.arrayContaining(["name", "staff_type", "contact_email", "phone", "status"]) });
    expect(JSON.stringify(entry)).not.toMatch(/uma|0100/i);
    expect((await staff(w.ownerA)).find((s) => s.profile_id === id)).toMatchObject({ display_name: "Uma Updated", status: "inactive", staff_type_name: "Supervisor" });
    await expectPgError(call(w.ownerA, "select ogevia_api.update_staff($1,$2,'X',$3,null,null,'gone')", [w.orgA, id, await typeId("Supervisor")]), "OGV22");
    await expectPgError(call(w.ownerA, "select ogevia_api.update_staff($1,$2,'X',$3,null,null,'active')", [w.orgA, randomUUID(), await typeId("Supervisor")]), "OGN04");
  });
});

describe("the directory never duplicates people", () => {
  it("lists caregivers from their Care Team records (no copy, no second profile), staff profiles, and members without a profile once each", async () => {
    const before = (await db.admin.query("select (select count(*) from ogevia.caregiver_records)::int c, (select count(*) from ogevia.app_users)::int u, (select count(*) from ogevia.staff_profiles)::int s")).rows[0];
    const rows = await staff(w.ownerA);
    const caregivers = rows.filter((r) => r.staff_key.startsWith("caregiver:"));
    expect(caregivers.length).toBe((await db.admin.query("select count(*)::int n from ogevia.caregiver_records where organization_id = $1 and deleted_at is null", [w.orgA])).rows[0].n);
    for (const c of caregivers) expect(c).toMatchObject({ staff_type_name: "Caregiver", profile_id: null });
    expect(rows.find((r) => r.user_id === w.ownerA.userId)).toMatchObject({ staff_key: `member:${w.ownerA.userId}`, system_role: "organization_owner", is_self: true, staff_type_name: null });
    expect(rows.find((r) => r.user_id === w.managerA.userId)).toMatchObject({ staff_key: `member:${w.managerA.userId}`, system_role: "manager" });
    const withUser = rows.map((r) => r.user_id).filter(Boolean);
    expect(new Set(withUser).size).toBe(withUser.length);   // a person appears once
    expect(rows.find((r) => r.user_id === w.managerB.userId || r.user_id === w.caregiverB1.userId)).toBeUndefined();   // another agency
    expect((await db.admin.query("select (select count(*) from ogevia.caregiver_records)::int c, (select count(*) from ogevia.app_users)::int u, (select count(*) from ogevia.staff_profiles)::int s")).rows[0]).toEqual(before);   // listing creates nothing
  });

  it("a member without a profile can be given one (no sign-in is created or changed); a person cannot have two", async () => {
    const before = (await db.admin.query("select count(*)::int n from ogevia.app_users")).rows[0].n;
    const id = (await call<{ r: string }>(w.ownerA, "select ogevia_api.add_member_to_staff($1,$2,$3) as r", [w.orgA, w.managerA.userId, await typeId("Manager")]))[0]!.r;
    expect((await staff(w.ownerA)).filter((r) => r.user_id === w.managerA.userId)).toHaveLength(1);
    expect((await staff(w.ownerA)).find((r) => r.user_id === w.managerA.userId)).toMatchObject({ profile_id: id, staff_type_name: "Manager", system_role: "manager" });
    await expectPgError(call(w.ownerA, "select ogevia_api.add_member_to_staff($1,$2,$3)", [w.orgA, w.managerA.userId, await typeId("Manager")]), "OGC09");
    await expectPgError(call(w.ownerA, "select ogevia_api.add_member_to_staff($1,$2,$3)", [w.orgA, w.caregiverA1.userId, await typeId("Manager")]), "OGC09", /not agency staff/);
    expect((await db.admin.query("select count(*)::int n from ogevia.app_users")).rows[0].n).toBe(before);
  });
});

describe("invitations (the same two steps as caregivers)", () => {
  it("creates the sign-in link and membership with the chosen supported role, marks first sign-in, and shows each state in plain words", async () => {
    const id = await createStaff(w.ownerA, "Ivy Invited", await typeId("Office Assistant"));
    const sub = await invite(w.ownerA, id, "  Ivy.Invited@Example.TEST ", "scheduler");
    const user = await userOf(sub);
    expect((await db.admin.query("select role::text r, status::text s from ogevia.organization_memberships where organization_id = $1 and user_id = $2", [w.orgA, user])).rows[0]).toEqual({ r: "scheduler", s: "active" });
    expect((await db.admin.query("select login_email from ogevia.staff_profiles where id = $1", [id])).rows[0].login_email).toBe("ivy.invited@example.test");
    expect((await staff(w.ownerA)).find((r) => r.profile_id === id)).toMatchObject({ user_id: user, system_role: "scheduler", access_status: "invitation_pending", is_self: false });
    expect((await audit("staff.invited")).at(-1)).toMatchObject({ entity_id: id, after_state: { role: "scheduler", existing_account: false } });
    expect(JSON.stringify((await audit("staff.invited")).at(-1))).not.toMatch(/ivy|example/i);
    await call({ userId: user, sub }, "select ogevia_api.note_my_sign_in()");   // the first sign-in
    expect((await staff(w.ownerA)).find((r) => r.profile_id === id)).toMatchObject({ access_status: "active" });
    // the invited person now acts with the role they were given (scheduler: shifts, not billing or staff)
    expect(await can(sub, "shifts.manage")).toBe(true);
    expect(await can(sub, "staff.manage")).toBe(false);
  });

  it("refuses: a second invitation, an inactive person, an email already used, a sign-in that already has access, a caregiver's sign-in, and a disabled sign-in", async () => {
    const type = await typeId("Coordinator");
    const a = await createStaff(w.ownerA, "Pat Pending", type);
    await invite(w.ownerA, a, "pat@example.test", "coordinator");
    await expectPgError(call(w.ownerA, "select ogevia_api.begin_staff_invitation($1,$2,'pat2@example.test','staff')", [w.orgA, a]), "OGC09", /already has a sign-in/);
    const b = await createStaff(w.ownerA, "Ben Busy", type);
    await expectPgError(call(w.ownerA, "select ogevia_api.begin_staff_invitation($1,$2,'PAT@example.test','staff')", [w.orgA, b]), "OGC09", /already used/);
    await expectPgError(call(w.ownerA, "select ogevia_api.begin_staff_invitation($1,$2,'not-an-email','staff')", [w.orgA, b]), "OGV22");
    await call(w.ownerA, "select ogevia_api.update_staff($1,$2,'Ben Busy',$3,null,null,'inactive')", [w.orgA, b, type]);
    await expectPgError(call(w.ownerA, "select ogevia_api.begin_staff_invitation($1,$2,'ben@example.test','staff')", [w.orgA, b]), "OGC09", /inactive/);
    await call(w.ownerA, "select ogevia_api.update_staff($1,$2,'Ben Busy',$3,null,null,'active')", [w.orgA, b, type]);
    // a sign-in that already has access to this agency (the manager) cannot be re-issued as new staff, and a role is never changed this way
    await expectPgError(call(w.ownerA, "select * from ogevia_api.complete_staff_invitation($1,$2,'ben@example.test',$3,true,'staff')", [w.orgA, b, w.managerA.sub]), "OGC09", /already has access/);
    await expectPgError(call(w.ownerA, "select * from ogevia_api.complete_staff_invitation($1,$2,'ben@example.test',$3,true,'staff')", [w.orgA, b, w.caregiverA1.sub]), "OGC09");
    expect((await db.admin.query("select role::text r from ogevia.organization_memberships where user_id = $1 and organization_id = $2", [w.managerA.userId, w.orgA])).rows[0].r).toBe("manager");
    const gone = randomUUID();
    await db.admin.query("insert into ogevia.app_users (cognito_sub, status) values ($1, 'disabled')", [gone]);
    await expectPgError(call(w.ownerA, "select * from ogevia_api.complete_staff_invitation($1,$2,'ben@example.test',$3,true,'staff')", [w.orgA, b, gone]), "OGC09", /disabled/);
    await expectPgError(call(w.ownerA, "select * from ogevia_api.complete_staff_invitation($1,$2,'ben@example.test','not-a-uuid',false,'staff')", [w.orgA, b]), "OGV22");
  });

  it("the roles that can be assigned are only the supported staff roles", async () => {
    const id = await createStaff(w.ownerA, "Rae Roles", await typeId("Manager"));
    for (const bad of ["organization_owner", "platform_owner", "caregiver", "client", "guardian", "parent", "authorized_representative", "superuser", "", "Manager"]) {
      await expectPgError(call(w.ownerA, "select ogevia_api.begin_staff_invitation($1,$2,'rae@example.test',$3)", [w.orgA, id, bad]), "OGV22", /supported role/);
    }
    for (const ok of ["organization_admin", "manager", "scheduler", "coordinator", "staff", "read_only"]) {
      expect((await call(w.ownerA, "select ogevia_api.begin_staff_invitation($1,$2,'rae@example.test',$3) as e", [w.orgA, id, ok]))[0]!.e).toBe("rae@example.test");
    }
  });

  it("resend works only for someone who has not set up their sign-in yet, is counted and capped, and is audited", async () => {
    const id = await createStaff(w.ownerA, "Rex Resend", await typeId("Scheduler"));
    await expectPgError(call(w.ownerA, "select ogevia_api.begin_staff_invitation_resend($1,$2)", [w.orgA, id]), "OGN04", /not been invited/);
    const sub = await invite(w.ownerA, id, "rex@example.test", "staff");
    expect((await call(w.ownerA, "select ogevia_api.begin_staff_invitation_resend($1,$2) as e", [w.orgA, id]))[0]!.e).toBe("rex@example.test");
    expect((await call(w.ownerA, "select ogevia_api.record_staff_invitation_resent($1,$2) as n", [w.orgA, id]))[0]!.n).toBe(2);
    expect((await audit("staff.invitation_resent")).at(-1)).toMatchObject({ entity_id: id, after_state: { send_count: 2 } });
    for (let i = 0; i < 3; i++) await call(w.ownerA, "select ogevia_api.record_staff_invitation_resent($1,$2)", [w.orgA, id]);
    await expectPgError(call(w.ownerA, "select ogevia_api.begin_staff_invitation_resend($1,$2)", [w.orgA, id]), "OGC09", /several times/);
    await db.admin.query("update ogevia.staff_profiles set send_count = 1 where id = $1", [id]);
    await call({ userId: await userOf(sub), sub }, "select ogevia_api.note_my_sign_in()");
    await expectPgError(call(w.ownerA, "select ogevia_api.begin_staff_invitation_resend($1,$2)", [w.orgA, id]), "OGC09", /already set up/);
  });

  it("the caregiver first-sign-in marker still works (note_my_sign_in is shared)", async () => {
    const sub = randomUUID();
    const user = (await db.admin.query("insert into ogevia.app_users (cognito_sub) values ($1) returning id", [sub])).rows[0].id as string;
    await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [w.orgA, user]);
    const rec = (await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,'CG-0086','Care','Giver') returning id", [w.orgA, user])).rows[0].id as string;
    await db.admin.query("insert into ogevia.caregiver_invitations (organization_id, caregiver_record_id, user_id, email, existing_account, invited_by) values ($1,$2,$3,'cg0086@example.test',false,$4)", [w.orgA, rec, user, w.ownerA.userId]);
    await call({ userId: user, sub }, "select ogevia_api.note_my_sign_in()");
    expect((await db.admin.query("select first_signed_in_at from ogevia.caregiver_invitations where caregiver_record_id = $1", [rec])).rows[0].first_signed_in_at).not.toBeNull();
  });
});

describe("system role assignment", () => {
  it("changes a staff member's role, needs a reason, is audited, and takes effect on the next request", async () => {
    const id = await createStaff(w.ownerA, "Wes Role", await typeId("Office Assistant"));
    const sub = await invite(w.ownerA, id, "wes@example.test", "read_only");
    const user = await userOf(sub);
    expect(await can(sub, "shifts.manage")).toBe(false);
    await expectPgError(setRole(w.ownerA, user, "scheduler", " "), "OGV22", /reason/);
    expect((await setRole(w.ownerA, user, "scheduler"))[0]!.r).toBe("scheduler");
    expect(await can(sub, "shifts.manage")).toBe(true);
    expect((await audit("staff.role_changed")).at(-1)).toMatchObject({ before_state: { role: "read_only" }, after_state: { role: "scheduler", user_id: user }, reason: "Moved to the front office" });
    expect((await setRole(w.ownerA, user, "scheduler"))[0]!.r).toBe("scheduler");   // no change, no new audit row
    expect((await audit("staff.role_changed")).filter((e) => (e.after_state as any).user_id === user)).toHaveLength(1);
  });

  it("protects the Owner role and keeps the rules: nobody changes their own role, the owner and caregivers are not changeable here, unsupported roles are refused", async () => {
    await expectPgError(setRole(w.ownerA, w.ownerA.userId, "manager"), "OGC09", /own role/);
    // a second owner is protected from this path too
    const sub2 = randomUUID();
    const o2 = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1,'Second Owner') returning id", [sub2])).rows[0].id as string;
    await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'organization_owner','active')", [w.orgA, o2]);
    await expectPgError(setRole(w.ownerA, o2, "manager"), "OGC09", /Owner role is protected/);
    await expectPgError(setRole(w.ownerA, w.caregiverA1.userId, "manager"), "OGC09", /staff roles/);
    for (const bad of ["organization_owner", "platform_owner", "caregiver", "client"]) await expectPgError(setRole(w.ownerA, w.managerA.userId, bad), "OGV22", /supported role/);
    await expectPgError(setRole(w.ownerA, randomUUID(), "staff"), "OGN04");
    expect((await db.admin.query("select role::text r from ogevia.organization_memberships where user_id = $1 and organization_id = $2", [w.ownerA.userId, w.orgA])).rows[0].r).toBe("organization_owner");
  });

  it("only the Owner may grant or remove the Admin role, even if staff.manage is given to another role", async () => {
    await db.admin.query("insert into ogevia.role_permissions (role, permission_key) values ('coordinator','staff.manage'), ('coordinator','staff.read')");
    try {
      const coordSub = randomUUID();
      const coord = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1,'Coord') returning id", [coordSub])).rows[0].id as string;
      await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'coordinator','active')", [w.orgA, coord]);
      const c: Actor = { userId: coord, sub: coordSub };
      await expectPgError(setRole(c, w.schedulerA.userId, "organization_admin"), "OGA03", /Only the Owner/);
      expect((await setRole(c, w.schedulerA.userId, "staff"))[0]!.r).toBe("staff");          // other supported roles are within staff.manage
      await setRole(w.ownerA, w.schedulerA.userId, "organization_admin");                     // the Owner may
      await expectPgError(setRole(c, w.schedulerA.userId, "manager"), "OGA03", /Only the Owner/);   // and only the Owner may take it away
      await setRole(w.ownerA, w.schedulerA.userId, "scheduler");
    } finally {
      await db.admin.query("delete from ogevia.role_permissions where role = 'coordinator' and permission_key like 'staff.%'");
    }
  });

  it("disable and enable (the existing accounts functions) still apply to staff, and the directory shows it", async () => {
    const id = await createStaff(w.ownerA, "Dee Disabled", await typeId("Supervisor"));
    const sub = await invite(w.ownerA, id, "dee@example.test", "staff");
    await call(w.ownerA, "select * from ogevia_api.disable_account($1,$2,'Left the agency')", [w.orgA, await userOf(sub)]);
    expect((await staff(w.ownerA)).find((r) => r.profile_id === id)).toMatchObject({ access_status: "disabled" });
    await call(w.ownerA, "select ogevia_api.enable_account($1,$2,'Returned')", [w.orgA, await userOf(sub)]);
    expect((await staff(w.ownerA)).find((r) => r.profile_id === id)).not.toMatchObject({ access_status: "disabled" });
  });
});

describe("roles, permissions and history", () => {
  it("lists the supported roles with their permissions and member counts; only agency roles are marked assignable", async () => {
    const rows = await call(w.ownerA, "select * from ogevia_api.list_role_permissions($1)", [w.orgA]);
    expect(rows.map((r) => r.role)).toEqual(["organization_owner", "organization_admin", "manager", "scheduler", "coordinator", "staff", "read_only", "caregiver"]);
    expect(rows.filter((r) => r.assignable).map((r) => r.role)).toEqual(["organization_admin", "manager", "scheduler", "coordinator", "staff", "read_only"]);
    const owner = rows.find((r) => r.role === "organization_owner");
    expect(owner.permissions.map((p: any) => p.key)).toEqual(expect.arrayContaining(["staff.manage", "staff.read", "accounts.manage"]));
    expect(Number(owner.member_count)).toBeGreaterThan(0);
    expect(rows.find((r) => r.role === "manager").permissions.map((p: any) => p.key)).not.toContain("staff.manage");
  });

  it("the staff history shows staff, staff-type and account events for this agency only, newest first, with who did it", async () => {
    const id = await createStaff(w.ownerA, "Hal History", await typeId("Manager"));
    await call(w.ownerA, "select ogevia_api.update_staff($1,$2,'Hal History',$3,null,null,'inactive')", [w.orgA, id, await typeId("Manager")]);
    const one = await call(w.ownerA, "select * from ogevia_api.list_staff_audit($1,$2)", [w.orgA, id]);
    expect(one.map((r) => r.action)).toEqual(["staff.updated", "staff.created"]);
    expect(one[0]).toHaveProperty("actor_name");
    const all = await call(w.ownerA, "select * from ogevia_api.list_staff_audit($1)", [w.orgA]);
    expect(all.length).toBeGreaterThan(5);
    expect(all.every((r) => /^(staff|staff_type|account)\./.test(r.action))).toBe(true);
    expect(new Date(all[0].occurred_at).getTime()).toBeGreaterThanOrEqual(new Date(all[all.length - 1].occurred_at).getTime());
    await expectPgError(call(w.ownerA, "select * from ogevia_api.list_staff_audit($1,$2)", [w.orgA, randomUUID()]), "OGN04");
    await expectPgError(call(w.ownerA, "select * from ogevia_api.list_staff_audit($1)", [w.orgB]), "OGN04");
  });

  it("the application role has no table access to the new tables and may run only the API functions", async () => {
    await expect(asActor(db, w.ownerA.sub, (c) => c.query("select * from ogevia.staff_profiles"))).rejects.toThrow(/permission denied/);
    await expect(asActor(db, w.ownerA.sub, (c) => c.query("select * from ogevia.staff_types"))).rejects.toThrow(/permission denied/);
    await expect(asActor(db, w.ownerA.sub, (c) => c.query("select ogevia.staff_guard($1, true)", [w.orgA]))).rejects.toThrow(/permission denied/);
  });
});

describe("the pending migration rolls back and re-applies cleanly", () => {
  it("rollback removes only staff management (people, roles and history stay); applying it again restores it", async () => {
    const own = await createTestDbWithPending();
    try {
      const world = await seedWorld(own);
      const c = (sql: string, params: unknown[] = []) => asActor(own, world.ownerA.sub, async (x) => (await x.query(sql, params)).rows as any[]);
      const type = (await own.admin.query("select id from ogevia.staff_types where organization_id = $1 and name = 'Manager'", [world.orgA])).rows[0].id as string;
      const profile = (await c("select ogevia_api.create_staff($1,'Ro Rollback',$2,null,null) as id", [world.orgA, type]))[0].id as string;
      const sub = randomUUID();
      await c("select * from ogevia_api.complete_staff_invitation($1,$2,'ro@example.test',$3,false,'scheduler')", [world.orgA, profile, sub]);
      const before = (await own.admin.query("select (select count(*) from ogevia.app_users)::int u, (select count(*) from ogevia.organization_memberships)::int m, (select count(*) from ogevia.audit_events)::int a")).rows[0];
      const client = await own.admin.connect();
      try {
        await rollBackPendingMigrations(client);
        expect((await client.query("select to_regclass('ogevia.staff_profiles') p, to_regclass('ogevia.staff_types') t, (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname in ('list_staff_types','create_staff_type','list_staff','create_staff','update_staff','begin_staff_invitation','set_staff_role','list_role_permissions','list_staff_audit')) f, (select count(*)::int from ogevia.permissions where key like 'staff.%') k")).rows[0]).toEqual({ p: null, t: null, f: 0, k: 0 });
        expect((await client.query("select (select count(*) from ogevia.app_users)::int u, (select count(*) from ogevia.organization_memberships)::int m, (select count(*) from ogevia.audit_events)::int a")).rows[0]).toEqual(before);   // nobody loses access, no history is lost
        expect((await client.query("select role::text r from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = $1", [sub])).rows[0].r).toBe("scheduler");
        await expect(asActor(own, world.caregiverA1.sub, (x) => x.query("select ogevia_api.note_my_sign_in()"))).resolves.toBeDefined();   // the 0025 version is back and works
        await applyPendingMigrations(client);
      } finally { client.release(); }
      expect((await c("select count(*)::int n from ogevia_api.list_staff_types($1)", [world.orgA]))[0].n).toBe(7);
    } finally { await own.drop(); }
  });
});
