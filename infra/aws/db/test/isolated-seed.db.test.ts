import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ADMIN_URL } from "./harness.js";
import { assertSafeTarget, migrate } from "../scripts/migrations.js";

let client: pg.Client;
let created = false;
const subs = { owner: randomUUID(), manager: randomUUID(), caregiver: randomUUID() };
const url = () => { const u = new URL(ADMIN_URL); u.pathname = "/ogevia_sv_test"; return u.toString(); };
const seed = () => execFileSync("psql", [url(), "-X", "-v", "ON_ERROR_STOP=1", "-v", "ux_ready=true", "-v", `owner_sub=${subs.owner}`, "-v", `manager_sub=${subs.manager}`, "-v", `caregiver_sub=${subs.caregiver}`, "-f", fileURLToPath(new URL("../deploy/02_seed_synthetic_test_slice.sql", import.meta.url))], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
beforeAll(async () => {
  assertSafeTarget(ADMIN_URL);
  const root = new pg.Client({ connectionString: ADMIN_URL }); await root.connect();
  try { await root.query("create database ogevia_sv_test"); created = true; } finally { await root.end(); }
  client = new pg.Client({ connectionString: url() }); await client.connect();
  await migrate(client, () => {}, { includePendingUx: true });
});
afterAll(async () => { await client?.end(); if (created) { const root = new pg.Client({ connectionString: ADMIN_URL }); await root.connect(); await root.query("drop database ogevia_sv_test with (force)"); await root.end(); } });
it("seeds distinct synthetic sign-ins and an approved caregiver through the existing API without automatic CPR/TB", async () => {
  seed();
  expect((await client.query("select count(*)::int n from ogevia.app_users")).rows[0].n).toBe(3);
  expect((await client.query("select count(*)::int n from ogevia.caregiver_work_approvals where source='approval'")).rows[0].n).toBe(1);
  expect((await client.query("select count(*)::int n from ogevia.document_types")).rows[0].n).toBe(0);
  expect((await client.query("select role from ogevia.organization_memberships m join ogevia.app_users u on u.id=m.user_id where u.cognito_sub=$1", [subs.owner])).rows[0].role).toBe("organization_owner");
});
it("refuses a second seed rather than changing an existing agency", async () => {
  const before = (await client.query("select count(*)::int n from ogevia.audit_events")).rows[0].n;
  expect((await client.query("select count(*)::int n from ogevia.organizations")).rows[0].n).toBe(1);
  expect(seed).toThrow(/empty ogevia_sv_test/);
  expect((await client.query("select count(*)::int n from ogevia.audit_events")).rows[0].n).toBe(before);
});
