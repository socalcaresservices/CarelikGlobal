// 0038 Agency letterhead details. SYNTHETIC data only (made-up agency, street and phone).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

const one = (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows);
const FULL = { legal: "Synthetic Home Care LLC", street: "100 Example Way", city: "Exampleville", state: "ca", zip: "90001", phone: "(555) 010-0100", email: "Office@Example.Test" };
const save = (a: Actor, f: Partial<typeof FULL> = FULL, org = w.orgA, key: string | null = null) =>
  one(a, "select * from ogevia_api.set_organization_letterhead($1,$2,$3,$4,$5,$6,$7,$8,$9)", [org, f.legal ?? null, f.street ?? null, f.city ?? null, f.state ?? null, f.zip ?? null, f.phone ?? null, f.email ?? null, key]);
const read = (a: Actor, org = w.orgA) => one(a, "select * from ogevia_api.get_organization_branding($1)", [org]);

describe("who can save and who can read", () => {
  it("only the agency Administrator (organization.update) can save; managers, schedulers, caregivers and other agencies cannot", async () => {
    await expectPgError(save(w.managerA), "OGA03", /Only the agency Administrator/);
    await expectPgError(save(w.schedulerA), "OGA03");
    await expectPgError(save(w.caregiverA1), "OGA03");
    await expectPgError(save(w.managerB), "OGN04"); // not a member of agency A
    await expectPgError(save(w.outsider), "OGN04");
    // The administrator of agency B cannot write agency A's letterhead either.
    await expectPgError(save(w.managerB, FULL, w.orgA), "OGN04");
    expect((await db.admin.query("select count(*)::int n from ogevia.organizations where legal_name is not null")).rows[0].n).toBe(0);
  });

  it("the same single role holds both letterhead and branding edit rights (no new permission)", async () => {
    const r = await db.admin.query("select role::text from ogevia.role_permissions where permission_key = 'organization.update'");
    expect(r.rows.map((x) => x.role)).toEqual(["organization_owner"]);
  });

  it("the Administrator saves; values are normalized; every active member of that agency can read them; other agencies cannot", async () => {
    const [saved] = await save(w.ownerA);
    expect(saved).toMatchObject({ legal_name: FULL.legal, address_state: "CA", contact_email: "office@example.test", address_zip: "90001" });
    for (const member of [w.ownerA, w.managerA, w.caregiverA1]) {
      const [b] = await read(member);
      expect(b).toMatchObject({ legal_name: FULL.legal, address_street: FULL.street, address_city: FULL.city, address_state: "CA", contact_phone: FULL.phone });
    }
    expect(await read(w.managerB, w.orgA)).toEqual([]);
    expect(await read(w.outsider, w.orgA)).toEqual([]);
    // Agency B never received agency A's details.
    expect((await db.admin.query("select legal_name from ogevia.organizations where id = $1", [w.orgB])).rows[0].legal_name).toBeNull();
  });

  it("every change is audited with the before and after values, and nothing hard-coded is stored for a new agency", async () => {
    const a = await db.admin.query("select action, before_state, after_state from ogevia.audit_events where action = 'organization.letterhead_updated' order by id desc limit 1");
    expect(a.rows[0].action).toBe("organization.letterhead_updated");
    expect(a.rows[0].after_state).toMatchObject({ legal_name: FULL.legal, address_state: "CA" });
    const fresh = await db.admin.query("insert into ogevia.organizations(slug, display_name) values ('fresh-agency','Fresh Agency') returning legal_name, address_street, contact_phone, contact_email");
    expect(fresh.rows[0]).toEqual({ legal_name: null, address_street: null, contact_phone: null, contact_email: null });
  });
});

describe("validation", () => {
  it.each([
    ["state of three letters", { ...FULL, state: "CAL" }, /State must be two letters/],
    ["state with a digit", { ...FULL, state: "C1" }, /State must be two letters/],
    ["ZIP of four digits", { ...FULL, zip: "9000" }, /ZIP code must be 5 digits/],
    ["ZIP with letters", { ...FULL, zip: "9000A" }, /ZIP code must be 5 digits/],
    ["phone with letters", { ...FULL, phone: "call us" }, /Phone may contain digits/],
    ["phone too short", { ...FULL, phone: "12345" }, /Phone may contain digits/],
    ["email without an @", { ...FULL, email: "office.example.test" }, /valid email/],
    ["email with a space", { ...FULL, email: "of fice@example.test" }, /valid email/],
    ["legal name of one character", { ...FULL, legal: "A" }, /Legal name must be between 2 and 120/],
    ["street over 120 characters", { ...FULL, street: "x".repeat(121) }, /Street address must be between 2 and 120/],
    ["city over 80 characters", { ...FULL, city: "y".repeat(81) }, /City must be between 2 and 80/],
  ])("refuses %s", async (_label, values, message) => {
    await expectPgError(save(w.ownerA, values), "OGV22", message);
  });

  it("accepts ZIP+4, a plus-sign phone, and leaves the stored values untouched after a refusal", async () => {
    await save(w.ownerA, { ...FULL, zip: "90001-1234", phone: "+1 555 010 0100" });
    await expectPgError(save(w.ownerA, { ...FULL, zip: "bad" }), "OGV22");
    const [b] = await read(w.ownerA);
    expect(b).toMatchObject({ address_zip: "90001-1234", contact_phone: "+1 555 010 0100" });
  });

  it("a blank value clears that field; blank everything clears all", async () => {
    await save(w.ownerA, { ...FULL, phone: "  ", email: "" });
    expect(await read(w.ownerA)).toMatchObject([{ contact_phone: null, contact_email: null, address_city: FULL.city }]);
    await save(w.ownerA, {});
    expect(await read(w.ownerA)).toMatchObject([{ legal_name: null, address_street: null, address_state: null }]);
  });
});

describe("idempotency", () => {
  it("a retried save with the same key and values changes and audits nothing more; the same key with different values is refused", async () => {
    const key = randomUUID();
    await save(w.ownerA, FULL, w.orgA, key);
    const before = (await db.admin.query("select count(*)::int n from ogevia.audit_events where action = 'organization.letterhead_updated'")).rows[0].n;
    await save(w.ownerA, FULL, w.orgA, key);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where action = 'organization.letterhead_updated'")).rows[0].n).toBe(before);
    await expect(save(w.ownerA, { ...FULL, city: "Elsewhere" }, w.orgA, key)).rejects.toThrow();
  });
});

describe("existing branding is unchanged", () => {
  it("set_organization_branding still works with its original signature and keeps the letterhead", async () => {
    await save(w.ownerA);
    const r = await one(w.ownerA, "select * from ogevia_api.set_organization_branding($1,$2,$3,null)", [w.orgA, "Synthetic Agency A", "#1F5F8B"]);
    expect(r[0]).toMatchObject({ display_name: "Synthetic Agency A", accent_color: "#1f5f8b" });
    expect(await read(w.caregiverA1)).toMatchObject([{ display_name: "Synthetic Agency A", legal_name: FULL.legal }]);
  });
});

describe("rollback", () => {
  const down = readFileSync(new URL("../rollback/0038_org_letterhead_contact.down.sql", import.meta.url), "utf8");
  const run = async (commit: boolean) => {
    const c = await db.admin.connect();
    try {
      await c.query("begin");
      await c.query("set local role ogevia_owner");
      await c.query(down);
      await c.query(commit ? "commit" : "rollback");
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  };
  it("refuses while any agency has letterhead details, and changes nothing", async () => {
    await save(w.ownerA);
    await expect(run(false)).rejects.toThrow(/ROLLBACK REFUSED: agency letterhead details are stored/);
    expect((await read(w.ownerA))[0]).toMatchObject({ legal_name: FULL.legal });
  });
  it("with no details stored it restores the 0020 four-column branding function", async () => {
    await save(w.ownerA, {});
    await run(true);
    const [b] = await read(w.ownerA);
    expect(Object.keys(b)).toEqual(["organization_id", "display_name", "accent_color", "logo_sha256"]);
    expect((await db.admin.query("select to_regprocedure('ogevia_api.set_organization_letterhead(uuid,text,text,text,text,text,text,text,uuid)') p")).rows[0].p).toBeNull();
  });
});
