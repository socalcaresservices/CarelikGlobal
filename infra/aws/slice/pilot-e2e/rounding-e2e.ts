// Local, synthetic browser check at 390 px of billing rounding (0029): the
// Administrator records a payer rule and a rounding policy version; the manager
// sees actual, approved, adjustment and proposed units separately on Billing
// review and approves the adjustment; the visit record itself is unchanged.
// Same harness as schedule-e2e.ts. Database: ogevia_cont_e2e.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { createHandler } from "/home/user/CarelikGlobal/apps/sv-api/src/handler.ts";
import { ROUTES } from "/home/user/CarelikGlobal/apps/sv-api/src/routes.ts";
import { MemoryEvidenceStore } from "/home/user/CarelikGlobal/apps/sv-api/src/evidence.ts";
import { MemoryIdentityAdmin } from "/home/user/CarelikGlobal/apps/sv-api/src/identity.ts";

const req = createRequire("/home/user/CarelikGlobal/apps/sv-api/package.json");
const pg = req("pg");
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));
const S = process.env.E2E_DIR ?? "/tmp/ogevia-pilot-e2e";
const { chromium } = createRequire(join(S, "package.json"))("playwright-core") as typeof import("playwright-core");
const SHOTS = join(S, "shots29");
mkdirSync(SHOTS, { recursive: true });
const WEB = "http://127.0.0.1:4173";
const API = "https://api.pilot-e2e.test";
const IDP = "https://pilot-e2e.auth.us-west-2.amazoncognito.com";
const CLIENT = "pilote2eclient000000000000";
const ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_PILOTE2E1";
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? "postgres://ogevia_admin@127.0.0.1:5432/ogevia_cont_e2e";
const APP_URL = process.env.E2E_APP_URL ?? "postgres://e2e_app_login:e2e-local-only@127.0.0.1:5432/ogevia_cont_e2e";
const MG = process.env.PILOT_MG!, CB = process.env.PILOT_CB!;
const identity = new MemoryIdentityAdmin();
const OWNER = "c0000000-0000-4000-8000-0000000000f1";

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const logLines: string[] = [];
const pool = new pg.Pool({ connectionString: APP_URL, max: 4 });
const handler = createHandler({ config: { issuer: ISSUER, appClientIds: [CLIENT], dbSetRole: "ogevia_app" }, db: { connect: () => pool.connect() }, evidence: new MemoryEvidenceStore(), identity, log: (r) => logLines.push(JSON.stringify(r)) });
const matchers = Object.keys(ROUTES).map((key) => {
  const [method, t] = key.split(" ") as [string, string]; const names: string[] = [];
  return { key, method, names, re: new RegExp("^" + t.replace(/\{(\w+)\}/g, (_, n) => (names.push(n), "([^/]+)")) + "$") };
});
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (c: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(c)}.e2e`;
const token = (sub: string) => jwt({ sub, iss: ISSUER, client_id: CLIENT, token_use: "access", scope: "openid email", exp: Math.floor(Date.now() / 1000) + 3600 });
const CORS = { "access-control-allow-origin": WEB, "access-control-allow-headers": "authorization,content-type,idempotency-key", "access-control-allow-methods": "GET,POST,OPTIONS" };
async function invoke(method: string, url: URL, headers: Record<string, string>, body: string | null) {
  const m = matchers.find((r) => r.method === method && r.re.test(url.pathname));
  const pathParameters: Record<string, string> = {};
  if (m) m.re.exec(url.pathname)!.slice(1).forEach((v, i) => (pathParameters[m.names[i]!] = decodeURIComponent(v)));
  const auth = headers.authorization?.replace(/^Bearer /, "");
  const claims = auth ? JSON.parse(Buffer.from(auth.split(".")[1]!, "base64url").toString()) : null;
  const query = Object.fromEntries(url.searchParams.entries());
  return handler({ routeKey: m ? m.key : `${method} ${url.pathname}`, headers, ...(Object.keys(pathParameters).length ? { pathParameters } : {}), ...(Object.keys(query).length ? { queryStringParameters: query } : {}), body, requestContext: { requestId: randomUUID(), ...(claims ? { authorizer: { jwt: { claims: Object.fromEntries(Object.entries(claims).map(([k, v]) => [k, String(v)])) } } } : {}) } } as never);
}

async function persona(browser: Browser, sub: string) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "America/Los_Angeles" });
  let nonce = "";
  await ctx.route(`${IDP}/**`, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/oauth2/authorize") {
      nonce = u.searchParams.get("nonce") ?? "";
      const back = new URL(u.searchParams.get("redirect_uri")!); back.searchParams.set("code", "e2e"); back.searchParams.set("state", u.searchParams.get("state")!);
      return route.fulfill({ status: 302, headers: { location: back.toString() } });
    }
    if (u.pathname === "/oauth2/token") {
      const now = Math.floor(Date.now() / 1000);
      return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": WEB }, body: JSON.stringify({ access_token: token(sub), id_token: jwt({ sub, iss: ISSUER, aud: CLIENT, token_use: "id", nonce, exp: now + 3600, iat: now, email: `${sub.slice(0, 8)}@example.invalid` }), refresh_token: "r", expires_in: 3600, token_type: "Bearer" }) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await ctx.route(`${API}/**`, async (route) => {
    const r = route.request();
    if (r.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const res = await invoke(r.method(), new URL(r.url()), r.headers(), r.postData());
    return route.fulfill({ status: res.statusCode, headers: { ...(res.headers as Record<string, string>), ...CORS }, body: (res.body as string) ?? "" });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page, errors };
}
async function signIn(page: Page, path: string) {
  await page.goto(WEB + path);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/callback") && !u.pathname.startsWith("/login"), { timeout: 15000 });
}
async function noHScroll(page: Page, label: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(`${label}: no horizontal scroll at 390 px`, sw <= iw && iw <= 390, `scrollWidth ${sw}, innerWidth ${iw}`);
}
const visible = (page: Page, text: string | RegExp) => page.getByText(text).first().isVisible().catch(() => false);
const laDate = (n = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() + n * 864e5));
const monthStart = () => `${laDate().slice(0, 7)}-01`;

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
  const org = (await admin.query("select id, timezone from ogevia.organizations where slug = 'scs-pilot-synthetic'")).rows[0];
  // A synthetic Administrator for this agency.
  const owner = (await admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Administrator') returning id", [OWNER])).rows[0].id;
  await admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1, $2, 'organization_owner', 'active')", [org.id, owner]);
  // One signed, confirmed 50-minute visit today, inserted directly (synthetic), on a current authorization.
  const a = (await admin.query(`select a.*, c.client_code from ogevia.client_authorizations a join ogevia.clients c on c.id = a.client_id
    where a.organization_id = $1 and a.is_current and a.deleted_at is null and (now() at time zone $2)::date between a.period_start and a.period_end order by c.client_code limit 1`, [org.id, org.timezone])).rows[0];
  const cg = (await admin.query("select m.user_id from ogevia.organization_memberships m where m.organization_id = $1 and m.role = 'caregiver' order by m.user_id limit 1", [org.id])).rows[0].user_id;
  await admin.query("set session_replication_role = replica");
  const visit = (await admin.query(`insert into ogevia.service_visits (organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_name_snapshot,
      service_authorization_id, service_id, service_date, time_in, time_out, worked_minutes, verified_minutes, billable_minutes, caregiver_attested_at,
      status, signed_at, locked_at, authorization_status, visit_number_snapshot, created_by)
    values ($1, $2, $3, $4, 'Pilot Caregiver A', $5, $6, (now() at time zone $7)::date, now() - interval '3 hours', now() - interval '2 hours 10 minutes',
      50, 50, 50, now() - interval '2 hours', 'signed', now() - interval '2 hours', now() - interval '2 hours', 'within_authorization', 'V-RND-E2E', $4) returning id`,
    [org.id, a.client_id, a.client_code, cg, a.id, a.service_id, org.timezone])).rows[0].id;
  await admin.query("insert into ogevia.visit_confirmations (organization_id, visit_id, signer_role, confirmation_method, typed_signer_name, confirmed_visit_snapshot, confirmation_version, confirmed_by) values ($1, $2, 'client', 'verbal', 'Synthetic Representative', '{}'::jsonb, 4, $3)", [org.id, visit, cg]);
  await admin.query("reset session_replication_role");
  const before = (await admin.query("select time_in, time_out, worked_minutes, billable_minutes from ogevia.service_visits where id = $1", [visit])).rows[0];
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });

  const o = await persona(browser, OWNER);
  await signIn(o.page, "/settings/billing-rounding");
  await o.page.goto(WEB + "/settings/billing-rounding");
  await o.page.getByRole("heading", { name: "Billing rounding policies" }).waitFor();
  check("settings: no policy = no rounding", await o.page.getByText("No policies: no rounding anywhere.").waitFor({ timeout: 8000 }).then(() => true, () => false));
  await o.page.getByLabel("Payer (as on the authorizations)").fill(a.payer);
  const s = o.page.getByLabel("Service", { exact: true }); await s.locator("option").nth(1).waitFor({ state: "attached" });
  const svcCode = (await admin.query("select code from ogevia.services where id = $1", [a.service_id])).rows[0].code;
  await s.selectOption({ label: (await s.locator("option", { hasText: `(${svcCode})` }).innerText()).trim() });
  await o.page.getByLabel("Round up").check();
  await o.page.getByLabel("Increment (minutes)").fill("15");
  await o.page.getByLabel("Each visit").check();
  await o.page.getByLabel("Effective from (service date)").fill("2026-01-01");
  await o.page.getByLabel("Reason for the change").fill("Payer bills 15-minute units (synthetic)");
  await o.page.getByRole("button", { name: "Save new version" }).click();
  check("settings: refused without the payer rule", await o.page.getByRole("alert").filter({ hasText: "Record the payer rule" }).waitFor({ timeout: 8000 }).then(() => true, () => false));
  await o.page.getByLabel("Payer rule (document and section)").fill("Synthetic payer manual 4.2");
  await o.page.getByLabel("Date of that payer document").fill("2026-01-15");
  await o.page.getByRole("button", { name: "Save new version" }).click();
  check("settings: saved as version 1", await o.page.getByText(/Saved as version 1, effective 01\/01\/2026/).waitFor({ timeout: 8000 }).then(() => true, () => false));
  check("settings: history shows the payer rule", await o.page.getByText(/Payer rule: Synthetic payer manual 4.2 \(01\/15\/2026\)/).waitFor({ timeout: 8000 }).then(() => true, () => false));
  await noHScroll(o.page, "rounding policies");
  await o.page.screenshot({ path: join(SHOTS, "01-policies.png"), fullPage: true });

  const m = await persona(browser, MG);
  await signIn(m.page, "/billing-review");
  await m.page.goto(WEB + "/billing-review");
  await m.page.getByRole("heading", { name: "Billing rounding" }).waitFor();
  check("billing review: visit approval needed first", await m.page.getByText("Approve the visit minutes first").first().waitFor({ timeout: 10000 }).then(() => true, () => false));
  await admin.query("select 1"); // the manager approves the visit through the existing screen
  const approveBtn = m.page.getByRole("button", { name: /Approve/ }).first();
  await approveBtn.click();
  const confirm = m.page.getByRole("button", { name: /^Approve( for billing)?$/ }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  const approved = await m.page.getByText("Adjustment ready for approval").waitFor({ timeout: 10000 }).then(() => true, () => false);
  check("visit approved through Billing review; rounding is now ready for approval", approved);
  const card = m.page.getByRole("list", { name: "Rounding by visit or day" }).locator("li").first();
  const text = await card.innerText();
  check("figures separate: actual 50, approved 50, adjustment +10, proposed 60 = 4.00 units", /Actual duration\s*50 min/.test(text) && /Approved \(visit\)\s*50 min/.test(text) && /Billing adjustment\s*\+10 min/.test(text) && /60 min · 4\.00 units/.test(text), text.replace(/\s+/g, " ").slice(0, 200));
  await card.getByRole("button", { name: "Approve adjustment" }).click();
  check("adjustment approved; visit records unchanged message", await m.page.getByText(/Rounding adjustment approved: \+10 min, 60 min proposed for billing\. Visit records are unchanged\./).waitFor({ timeout: 8000 }).then(() => true, () => false));
  check("card settles to 'Adjustment approved' with a Void button", await m.page.getByText("Adjustment approved", { exact: true }).waitFor({ timeout: 8000 }).then(() => true, () => false)
    && await m.page.getByRole("button", { name: "Void adjustment" }).isVisible());
  await noHScroll(m.page, "billing review with rounding");
  await m.page.screenshot({ path: join(SHOTS, "02-billing-review.png"), fullPage: true });
  const after = (await admin.query("select time_in, time_out, worked_minutes, billable_minutes from ogevia.service_visits where id = $1", [visit])).rows[0];
  check("database: clock times, worked and billable minutes unchanged", JSON.stringify(after) === JSON.stringify(before));
  const adj = (await admin.query("select base_minutes, proposed_minutes, adjustment_minutes from ogevia.billing_rounding_adjustments where voided_at is null")).rows;
  check("database: one adjustment 50 -> 60 (+10)", adj.length === 1 && adj[0].base_minutes === 50 && adj[0].proposed_minutes === 60 && adj[0].adjustment_minutes === 10, JSON.stringify(adj));
  check("no page errors", o.errors.length === 0 && m.errors.length === 0, [...o.errors, ...m.errors].join("; "));

  await browser.close(); await admin.end(); await pool.end();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(S, "e2e-results-29.json"), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
