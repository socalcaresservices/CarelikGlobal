// 0048: plain-language sign-in account status and Admin enable/disable. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const disable = (a: Actor, target: Actor | string, reason = "Left the agency", org = () => w.orgA) =>
  call(a, "select * from ogevia_api.disable_account($1,$2,$3)", [org(), typeof target === "string" ? target : target.userId, reason]);
const enable = (a: Actor, target: Actor | string, reason = "Returned to work") =>
  call(a, "select ogevia_api.enable_account($1,$2,$3) as s", [w.orgA, typeof target === "string" ? target : target.userId, reason]);
const list = (a: Actor, org = () => w.orgA) => call(a, "select * from ogevia_api.list_accounts($1)", [org()]);
const row = (rows: any[], a: Actor) => rows.find((r) => r.user_id === a.userId);
const audit = (action: string) => db.admin.query("select organization_id, entity_id, reason, before_state, after_state from ogevia.audit_events where action = $1 order by id", [action]).then((r) => r.rows);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db);
});
afterAll(async () => db.drop());

describe("who may manage sign-in accounts", () => {
  it("only the organization owner: managers, schedulers and caregivers are refused by the database, on every function", async () => {
    for (const who of [w.managerA, w.schedulerA, w.caregiverA1]) {
      await expectPgError(list(who), "OGA03", /administrator/);
      await expectPgError(disable(who, w.caregiverA2), "OGA03");
      await expectPgError(call(who, "select * from ogevia_api.prepare_account_enable($1,$2)", [w.orgA, w.caregiverA2.userId]), "OGA03");
      await expectPgError(enable(who, w.caregiverA2), "OGA03");
    }
    expect((await db.admin.query("select role::text r from ogevia.role_permissions where permission_key = 'accounts.manage'")).rows).toEqual([{ r: "organization_owner" }]);
  });

  it("another agency's owner and an outsider cannot see or touch this agency's people", async () => {
    await expectPgError(list(w.managerB), "OGN04"); // not a member of org A
    await expectPgError(disable(w.outsider, w.caregiverA1), "OGN04");
    await expectPgError(disable(w.ownerA, w.caregiverB1), "OGN04"); // a person of another agency is "not found" for this owner
    await expectPgError(call(w.ownerA, "select * from ogevia_api.prepare_account_enable($1,$2)", [w.orgA, w.caregiverB1.userId]), "OGN04");
  });
});

describe("account status in plain words", () => {
  it("lists active people, invited people, disabled people and Care Team records with no sign-in", async () => {
    // An invited caregiver (never signed in) and a Care Team record with no sign-in at all.
    const invitedSub = randomUUID();
    const invited = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1,'INVITED') returning id", [invitedSub])).rows[0].id as string;
    await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [w.orgA, invited]);
    const rec = (await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,'CG-INV','Invited','Person') returning id", [w.orgA, invited])).rows[0].id as string;
    await db.admin.query("insert into ogevia.caregiver_invitations (organization_id, caregiver_record_id, user_id, email, existing_account, invited_by) values ($1,$2,$3,'invited@example.test',false,$4)", [w.orgA, rec, invited, w.ownerA.userId]);
    await db.admin.query("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name) values ($1,'CG-NONE','No','Signin')", [w.orgA]);
    const rows = await list(w.ownerA);
    expect(row(rows, w.ownerA)).toMatchObject({ account_status: "active", role: "organization_owner", is_self: true });
    expect(row(rows, w.managerA)).toMatchObject({ account_status: "active", role: "manager", is_self: false });
    expect(row(rows, w.caregiverA1)).toMatchObject({ account_status: "active" });
    expect(rows.find((r) => r.user_id === invited)).toMatchObject({ account_status: "invitation_pending", caregiver_code: "CG-INV", first_signed_in_at: null });
    expect(rows.find((r) => r.caregiver_code === "CG-NONE")).toMatchObject({ user_id: null, account_status: "setup_required", role: "caregiver" });
    // Another agency's people never appear.
    expect(rows.find((r) => r.user_id === w.managerB.userId || r.user_id === w.caregiverB1.userId)).toBeUndefined();
    // No email address, password or Cognito detail is returned.
    expect(Object.keys(rows[0])).not.toEqual(expect.arrayContaining(["email", "cognito_sub", "password"]));
    // Once the person signs in the status becomes Active.
    await db.admin.query("update ogevia.caregiver_invitations set first_signed_in_at = now() where user_id = $1", [invited]);
    expect((await list(w.ownerA)).find((r) => r.user_id === invited).account_status).toBe("active");
  });
});

describe("disable and enable", () => {
  it("disabling needs a reason, blocks the person at once, is audited without email or password, and keeps every record", async () => {
    await expectPgError(disable(w.ownerA, w.caregiverA2, " "), "OGV22", /reason/);
    const shiftsBefore = (await db.admin.query("select count(*)::int n from ogevia.shifts")).rows[0].n;
    const [res] = await disable(w.ownerA, w.caregiverA2, "Left the agency");
    expect(res).toEqual({ cognito_sub: w.caregiverA2.sub, disable_sign_in: true }); // last active access: the sign-in is switched off too
    expect(row(await list(w.ownerA), w.caregiverA2)).toMatchObject({ account_status: "disabled", membership_status: "suspended" });
    // Refused immediately by the database for the disabled person.
    await expectPgError(call(w.caregiverA2, "select 1"), "OGA01"); // begin_request: not an active user
    expect((await db.admin.query("select status from ogevia.app_users where id = $1", [w.caregiverA2.userId])).rows[0].status).toBe("disabled");
    const [event] = await audit("account.disabled");
    expect(event).toMatchObject({ organization_id: w.orgA, reason: "Left the agency" });
    expect(JSON.stringify(event)).not.toMatch(/@|password|cognito/i);
    expect((await db.admin.query("select count(*)::int n from ogevia.shifts")).rows[0].n).toBe(shiftsBefore);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA2.userId])).rows[0].n).toBe(1);
  });

  it("a retry after a failed sign-in call is safe: it reports the same instruction and adds no second audit event", async () => {
    const before = (await audit("account.disabled")).length;
    const [again] = await disable(w.ownerA, w.caregiverA2, "Retry");
    expect(again).toEqual({ cognito_sub: w.caregiverA2.sub, disable_sign_in: true });
    expect((await audit("account.disabled")).length).toBe(before);
  });

  it("refuses to disable yourself; one owner may disable another, and can bring them back", async () => {
    await expectPgError(disable(w.ownerA, w.ownerA), "OGC09", /your own/);
    const sub = randomUUID();
    const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1,'OWNER_2') returning id", [sub])).rows[0].id as string;
    const second: Actor = { userId, sub };
    await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'organization_owner','active')", [w.orgA, userId]);
    expect((await disable(second, w.ownerA, "Owner change"))[0].disable_sign_in).toBe(true);
    await expectPgError(call(w.ownerA, "select 1"), "OGA01"); // the disabled owner is out at once
    await enable(second, w.ownerA);
    expect((await call(w.ownerA, "select count(*)::int n from ogevia_api.get_my_context()"))[0].n).toBe(1);
  });

  it("enabling: prepare says whether the sign-in must be switched on; enable restores access and is audited", async () => {
    const [prep] = await call(w.ownerA, "select * from ogevia_api.prepare_account_enable($1,$2)", [w.orgA, w.caregiverA2.userId]);
    expect(prep).toEqual({ cognito_sub: w.caregiverA2.sub, sign_in_disabled: true });
    await expectPgError(enable(w.ownerA, w.caregiverA2, "no"), "OGV22");
    expect((await enable(w.ownerA, w.caregiverA2))[0].s).toBe("active");
    expect(row(await list(w.ownerA), w.caregiverA2)).toMatchObject({ account_status: "active", membership_status: "active" });
    expect((await call(w.caregiverA2, "select count(*)::int n from ogevia_api.get_my_context()"))[0].n).toBe(1); // can use the app again
    expect((await audit("account.enabled")).length).toBeGreaterThanOrEqual(1);
    // Enabling someone already active changes nothing and adds no event.
    const n = (await audit("account.enabled")).length;
    await enable(w.ownerA, w.caregiverA2);
    expect((await audit("account.enabled")).length).toBe(n);
  });

  it("a sign-in shared with another agency is NOT switched off when one agency disables its person", async () => {
    // caregiverA1 also works for agency B.
    await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [w.orgB, w.caregiverA1.userId]);
    const [res] = await disable(w.ownerA, w.caregiverA1, "No longer works for agency A");
    expect(res.disable_sign_in).toBe(false);
    expect((await db.admin.query("select status from ogevia.app_users where id = $1", [w.caregiverA1.userId])).rows[0].status).toBe("active");
    expect((await call(w.caregiverA1, "select count(*)::int n from ogevia_api.get_my_context()"))[0].n).toBe(1); // still has agency B
    await enable(w.ownerA, w.caregiverA1);
    expect((await call(w.caregiverA1, "select count(*)::int n from ogevia_api.get_my_context()"))[0].n).toBe(2);
  });

  it("is concurrency-safe: two simultaneous disables record one event", async () => {
    const before = (await audit("account.disabled")).length;
    await Promise.all([disable(w.ownerA, w.caregiverA3, "Both clicked"), disable(w.ownerA, w.caregiverA3, "Both clicked")]);
    expect((await audit("account.disabled")).length).toBe(before + 1);
  });

  it("ships with a classified rollback that removes only the functions and the permission", async () => {
    const { readFileSync } = await import("node:fs");
    const down = readFileSync(new URL("../rollback/0048_account_status_enable_disable.down.sql", import.meta.url), "utf8");
    expect(down).toMatch(/CLASS: SAFE AUTOMATED/);
    expect(down).not.toMatch(/drop table|delete from ogevia\.(app_users|organization_memberships|audit_events)/i);
  });
});
