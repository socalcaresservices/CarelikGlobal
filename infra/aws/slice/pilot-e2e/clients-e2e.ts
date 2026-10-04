// Local, synthetic browser check of client and authorization administration
// (0022) at 390 px: manager adds a client, adds and amends an authorization,
// sees balances from the shared calculation, changes status; the Administrator
// sets and sees a rate that the manager never sees; a caregiver has no access.
// Real AWS-mode web build + real sv-api handler + local PostgreSQL (0001-0022,
// test-slice and SCS pilot seeds). Cognito is faked with unsigned tokens, as in
// workspace-e2e.ts. Database: ogevia_clients_e2e (setup in README.md).
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { createHandler } from "/home/user/CarelikGlobal/apps/sv-api/src/handler.ts";
import { ROUTES } from "/home/user/CarelikGlobal/apps/sv-api/src/routes.ts";
import { MemoryEvidenceStore } from "/home/user/CarelikGlobal/apps/sv-api/src/evidence.ts";

const req = createRequire("/home/user/CarelikGlobal/apps/sv-api/package.json");
const pg = req("pg");
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));
const S = process.env.E2E_DIR ?? "/tmp/ogevia-pilot-e2e";
const { chromium } = createRequire(join(S, "package.json"))("playwright-core") as typeof import("playwright-core");
const SHOTS = join(S, "shots22");
mkdirSync(SHOTS, { recursive: true });
const WEB = "http://127.0.0.1:4173";
const API = "https://api.pilot-e2e.test";
const IDP = "https://pilot-e2e.auth.us-west-2.amazoncognito.com";
const CLIENT = "pilote2eclient000000000000";
const ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_PILOTE2E1";
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? "postgres://ogevia_admin@127.0.0.1:5432/ogevia_clients_e2e";
const APP_URL = process.env.E2E_APP_URL ?? "postgres://e2e_app_login:e2e-local-only@127.0.0.1:5432/ogevia_clients_e2e";
const MG = process.env.PILOT_MG!, CA = process.env.PILOT_CA!;
const OWNER = "c0000000-0000-4000-8000-0000000000f1";

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const pool = new pg.Pool({ connectionString: APP_URL, max: 4 });
const handler = createHandler({ config: { issuer: ISSUER, appClientIds: [CLIENT], dbSetRole: "ogevia_app" }, db: { connect: () => pool.connect() }, evidence: new MemoryEvidenceStore(), log: () => {} });
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
  check(`${label}: no horizontal scroll at 390 px`, sw <= iw, `scrollWidth ${sw}, innerWidth ${iw}`);
}
const visible = (page: Page, text: string | RegExp) => page.getByText(text).first().isVisible().catch(() => false);
const laDate = (n = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() + n * 864e5));
const monthStart = () => `${laDate().slice(0, 7)}-01`;

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
  await admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Administrator') on conflict do nothing", [OWNER]);
  await admin.query(`insert into ogevia.organization_memberships (organization_id, user_id, role, status)
    select o.id, u.id, 'organization_owner', 'active' from ogevia.organizations o, ogevia.app_users u
    where o.slug = 'scs-pilot-synthetic' and u.cognito_sub = $1 on conflict do nothing`, [OWNER]);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
  const start = monthStart();
  const end = laDate(60);

  // ---- Manager ----
  const m = await persona(browser, MG);
  await signIn(m.page, "/clients");
  await m.page.getByRole("heading", { name: "Clients" }).waitFor();
  check("manager: Clients page lists the seeded synthetic clients", await visible(m.page, /\(P-/));
  await noHScroll(m.page, "manager clients list");
  await m.page.getByRole("button", { name: "Add client" }).click();
  await m.page.getByRole("button", { name: "Add client" }).click();
  check("manager: empty form is refused with a clear message", await visible(m.page, "Enter the client's first and last name."));
  await m.page.getByLabel("First name").fill("Synthetic");
  await m.page.getByLabel("Last name").fill("Client Echo");
  await m.page.getByLabel("City (optional)").fill("Riverside");
  await m.page.getByRole("button", { name: "Add a type" }).click();
  await m.page.getByLabel("New type name").fill("Respite");
  await m.page.getByRole("button", { name: "Save type" }).click();
  await m.page.waitForTimeout(500);
  await m.page.getByRole("button", { name: "Add client" }).click();
  await m.page.getByText("Client added.").waitFor();
  check("manager: client added", true);
  await m.page.screenshot({ path: join(SHOTS, "01-manager-client-added.png"), fullPage: true });
  await m.page.getByRole("link", { name: "Open it to add authorized hours" }).click();
  await m.page.getByRole("heading", { name: "Synthetic Client Echo" }).waitFor();
  const noAuth = m.page.getByText(/No authorization yet/);
  await noAuth.waitFor({ timeout: 8000 }).catch(() => {});
  check("manager: new client shows no authorization yet, in red",
    (await noAuth.isVisible().catch(() => false)) && (await noAuth.evaluate((el) => getComputedStyle(el).color)) === "rgb(185, 28, 28)");
  check("manager: client type saved", (await m.page.getByLabel("Client type (optional)").inputValue()) !== "");
  await m.page.getByRole("button", { name: "Add authorization" }).click();
  check("manager: no billing-rate field", (await m.page.getByLabel(/Billing rate/).count()) === 0);
  const svc = m.page.getByLabel("Service");
  await svc.locator("option").nth(1).waitFor({ state: "attached" });
  await svc.selectOption({ index: 1 });
  await m.page.getByLabel("Payer").fill("Synthetic Regional Center");
  await m.page.getByLabel("Authorized hours per month").fill("20");
  check("manager: hours are converted and shown back", await visible(m.page, "= 20 hr each month"));
  await m.page.getByLabel("Start date").fill(start);
  await m.page.getByLabel("End date").fill(end);
  await m.page.getByRole("button", { name: "Add authorization" }).last().click();
  await m.page.getByText(/20 hr per month/).first().waitFor();
  check("manager: authorization added (version 1)", await visible(m.page, /version 1/));
  const balanceList = m.page.getByRole("list", { name: /Authorized, used and remaining/ });
  await balanceList.waitFor();
  const firstRow = (await balanceList.locator("li").first().innerText()).replace(/\s+/g, " ");
  check("manager: this month's balance comes from the shared calculation (authorized 20 hr, remaining 20 hr)", /Authorized 20 hr.*Remaining 20 hr/.test(firstRow), firstRow);
  const rem = await balanceList.getByText("Remaining").first().boundingBox();
  check("manager: Remaining is fully on screen at 390 px", !!rem && rem.x >= 0 && rem.x + rem.width <= 390, JSON.stringify(rem));
  await noHScroll(m.page, "manager client detail");
  // Overlap refused
  await m.page.getByRole("button", { name: "Add authorization" }).click();
  await svc.selectOption({ index: 1 });
  await m.page.getByLabel("Payer").fill("Synthetic Regional Center");
  await m.page.getByLabel("Authorized hours per month").fill("10");
  await m.page.getByLabel("Start date").fill(start);
  await m.page.getByLabel("End date").fill(end);
  await m.page.getByRole("button", { name: "Add authorization" }).last().click();
  await m.page.getByText(/amend that one instead/).waitFor({ timeout: 5000 }).catch(() => {});
  check("manager: overlapping authorization for the same service is refused ('amend instead')", await visible(m.page, /amend that one instead/));
  await m.page.getByRole("button", { name: "Close" }).click();
  // Amend
  await m.page.getByRole("button", { name: "Amend" }).click();
  await m.page.getByLabel("Authorized hours per month").fill("25:30");
  await m.page.getByLabel("Reason for the amendment").fill("Amendment received from the payer (synthetic)");
  await m.page.getByRole("button", { name: "Save version 2" }).click();
  await m.page.getByText(/Saved as version 2/).waitFor();
  check("manager: amendment saved as version 2 with the impact report", await visible(m.page, /No existing visits need review/));
  check("manager: version 1 kept in the history", await visible(m.page, /History \(1 earlier version\)/));
  await m.page.waitForTimeout(500);
  const amendedRow = (await balanceList.locator("li").first().innerText()).replace(/\s+/g, " ");
  check("manager: balance uses the amended cap (25 hr 30 min)", /25 hr 30 min/.test(amendedRow), amendedRow);
  check("manager: no dollar amounts anywhere on the page", !(await m.page.content()).includes("/hr<"));
  await m.page.screenshot({ path: join(SHOTS, "02-manager-authorization-amended.png"), fullPage: true });
  // Status
  await m.page.getByLabel("Change to").selectOption("inactive");
  await m.page.getByRole("button", { name: "Change status" }).click();
  check("manager: status change without a reason is refused", await visible(m.page, "Give a reason for the change."));
  await m.page.getByLabel("Reason").fill("Services paused (synthetic)");
  await m.page.getByRole("button", { name: "Change status" }).click();
  await m.page.getByText("Status changed.").waitFor();
  check("manager: client set to Inactive", await visible(m.page, /^Inactive$/));
  check("manager: no browser errors", m.errors.length === 0, m.errors.join(" | "));

  // ---- Administrator ----
  const o = await persona(browser, OWNER);
  await signIn(o.page, "/clients");
  await o.page.getByLabel("Status").selectOption("all");
  await o.page.getByRole("link", { name: /Synthetic Client Echo/ }).click();
  await o.page.getByRole("heading", { name: "Synthetic Client Echo" }).waitFor();
  check("Administrator: header says ADMINISTRATOR VIEW", await visible(o.page, "ADMINISTRATOR VIEW"));
  await o.page.getByRole("button", { name: "Add authorization" }).click();
  const osvc = o.page.getByLabel("Service");
  await osvc.locator("option").nth(2).waitFor({ state: "attached" });
  await osvc.selectOption({ index: 2 });
  await o.page.getByLabel("Payer").fill("Synthetic Regional Center");
  await o.page.getByLabel("Authorized hours per month").fill("12");
  await o.page.getByLabel("Start date").fill(start);
  await o.page.getByLabel("End date").fill(end);
  await o.page.getByLabel(/Billing rate/).fill("30");
  await o.page.getByRole("button", { name: "Add authorization" }).last().click();
  await o.page.getByText("$30.00/hr").first().waitFor({ timeout: 8000 }).catch(() => {});
  check("Administrator: rate set and shown ($30.00/hr)", await visible(o.page, "$30.00/hr"));
  await o.page.screenshot({ path: join(SHOTS, "03-administrator-rate.png"), fullPage: true });
  check("Administrator: no browser errors", o.errors.length === 0, o.errors.join(" | "));

  await m.page.reload();
  await m.page.getByRole("heading", { name: "Synthetic Client Echo" }).waitFor();
  await m.page.getByText(/12 hr per month/).waitFor();
  check("manager: sees the Administrator's authorization but never its rate", !(await visible(m.page, "$30.00/hr")));

  // ---- Caregiver ----
  const c = await persona(browser, CA);
  await signIn(c.page, "/clients");
  check("caregiver: no Clients menu entry", (await c.page.getByRole("link", { name: "Clients" }).count()) === 0);
  await c.page.goto(WEB + "/clients");
  await c.page.getByText("You do not have access to client records.").waitFor({ timeout: 8000 }).catch(() => {});
  check("caregiver: Clients page refuses", await visible(c.page, "You do not have access to client records."));

  // ---- Database evidence ----
  const ev = (await admin.query(`select a.action, count(*)::int n from ogevia.audit_events a
    where a.action in ('client.created','client_type.created','client_authorization.created','client_authorization.amended','client.status_changed') group by 1 order by 1`)).rows;
  const n = Object.fromEntries(ev.map((r: { action: string; n: number }) => [r.action, r.n]));
  check("audit: client, type, 2 authorizations, amendment and status change recorded",
    n["client.created"] === 1 && n["client_type.created"] === 1 && n["client_authorization.created"] === 2 && n["client_authorization.amended"] === 1 && n["client.status_changed"] === 1, JSON.stringify(n));
  const versions = (await admin.query(`select a.version_number, a.is_current, a.monthly_authorized_minutes from ogevia.client_authorizations a
    join ogevia.client_private_names p on p.client_id = a.client_id where p.legal_last_name = 'Client Echo' and a.hourly_rate_cents is null order by 1`)).rows;
  check("database: version 1 (1200 min) kept and superseded; version 2 (1530 min) current",
    JSON.stringify(versions) === JSON.stringify([{ version_number: 1, is_current: false, monthly_authorized_minutes: 1200 }, { version_number: 2, is_current: true, monthly_authorized_minutes: 1530 }]), JSON.stringify(versions));

  await browser.close(); await admin.end(); await pool.end();
  writeFileSync(join(S, "clients-e2e-results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
