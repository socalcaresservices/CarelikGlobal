// Integration of the readiness release (0088) onto the TEST line that already carries staff management (0086, 0087): the two function sets and permission sets coexist,
// and ogevia_api.list_accounts (replaced by both 0087 and 0088) returns the union: 0087's invitation-first account_status and 0088's readiness columns. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);

beforeAll(async () => { db = await createTestDb(); w = await seedWorld(db, 700); });
afterAll(async () => db?.drop());

async function staffMember(status: "invited" | "active", userStatus: "active" | "disabled" = "active") {
  const sub = randomUUID();
  const user = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name, status) values ($1, 'Synthetic Staff', $2) returning id", [sub, userStatus])).rows[0].id as string;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1, $2, 'manager', $3)", [w.orgA, user, status]);
  return user;
}

describe("staff management (0086, 0087) and caregiver readiness (0088) on one database", () => {
  it("the ledger holds all 88 migrations, in order, with the staff and readiness objects present", async () => {
    const v = (await db.admin.query("select count(*)::int n, max(version) l from ogevia_meta.schema_migrations")).rows[0];
    expect(v).toEqual({ n: 88, l: "0088" });
    for (const t of ["staff_types", "staff_profiles", "caregiver_work_approvals", "caregiver_contacts", "organization_compliance_settings", "caregiver_cpr_tb_extensions"])
      expect((await db.admin.query("select to_regclass($1) is not null as ok", [`ogevia.${t}`])).rows[0].ok, t).toBe(true);
    for (const f of ["accept_staff_invitation(uuid)", "list_staff(uuid)", "approve_caregiver_for_work(uuid,uuid,uuid)", "get_caregiver_readiness(uuid,uuid)"])
      expect((await db.admin.query("select to_regprocedure($1) is not null as ok", [`ogevia_api.${f}`])).rows[0].ok, f).toBe(true);
  });

  it("both permission sets exist and the organization owner holds all of them", async () => {
    const keys = ["staff.read", "staff.manage", "readiness.read", "caregivers.compliance.manage", "accounts.manage"];
    const rows = (await db.admin.query("select permission_key from ogevia.role_permissions where role = 'organization_owner' and permission_key = any($1)", [keys])).rows.map((r) => r.permission_key).sort();
    expect(rows).toEqual([...keys].sort());
  });

  it("list_accounts: a pending staff invitation reads 'invitation_pending' before anything else (0087), even if the account is disabled, and carries no readiness values", async () => {
    const invited = await staffMember("invited", "disabled");
    const rows = await call(w.ownerA, "select * from ogevia_api.list_accounts($1)", [w.orgA]);
    const row = rows.find((r: any) => r.user_id === invited);
    expect(row).toMatchObject({ membership_status: "invited", account_status: "invitation_pending", work_status: null, readiness_met: null, readiness_total: null, has_contact: null });
  });

  it("list_accounts: a disabled account that is not an invitation still reads 'disabled', and an active staff member reads 'active'", async () => {
    const off = await staffMember("active", "disabled");
    const on = await staffMember("active", "active");
    const rows = await call(w.ownerA, "select * from ogevia_api.list_accounts($1)", [w.orgA]);
    expect(rows.find((r: any) => r.user_id === off)).toMatchObject({ account_status: "disabled" });
    expect(rows.find((r: any) => r.user_id === on)).toMatchObject({ account_status: "active", work_status: null });
  });

  it("list_accounts: a caregiver row carries the calculated status and the readiness counts (0088) with the same columns the 0087 version returned", async () => {
    const rows = await call(w.ownerA, "select * from ogevia_api.list_accounts($1)", [w.orgA]);
    const cg = rows.find((r: any) => r.caregiver_record_id);
    expect(cg).toBeTruthy();
    expect(Object.keys(cg).sort()).toEqual(["account_status", "caregiver_code", "caregiver_name", "caregiver_record_id", "display_name", "first_signed_in_at", "has_contact", "invited_at", "is_self", "membership_status", "readiness_met", "readiness_total", "role", "user_id", "work_status"]);
    expect(["not_ready", "approved", "active", "inactive"]).toContain(cg.work_status);
    expect(cg.readiness_total).toBe(5);
  });

  it("a manager (no accounts.manage) is still refused list_accounts, and an organization-B manager cannot read organization A's accounts", async () => {
    await expect(call(w.managerA, "select * from ogevia_api.list_accounts($1)", [w.orgA])).rejects.toThrow();
    await expect(call(w.managerB, "select * from ogevia_api.list_accounts($1)", [w.orgA])).rejects.toThrow();
  });
});
