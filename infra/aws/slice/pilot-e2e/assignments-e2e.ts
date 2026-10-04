// Local, synthetic browser check of assignment administration (0024) at 390 px:
// a manager adds a client with an authorization, assigns a signed-in caregiver
// (who then sees the client on Verify visit), sees an uncovered assignment
// flagged, cannot pick a caregiver without a sign-in, cancels an upcoming
// assignment and ends a current one. Same harness as clients-e2e.ts.
// Database: ogevia_assign_e2e (setup in README.md).
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
const SHOTS = join(S, "shots24");
mkdirSync(SHOTS, { recursive: true });
const WEB = "http://127.0.0.1:4173";
const API = "https://api.pilot-e2e.test";
const IDP = "https://pilot-e2e.auth.us-west-2.amazoncognito.com";
const CLIENT = "pilote2eclient000000000000";
const ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_PILOTE2E1";
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? "postgres://ogevia_admin@127.0.0.1:5432/ogevia_assign_e2e";
const APP_URL = process.env.E2E_APP_URL ?? "postgres://e2e_app_login:e2e-local-only@127.0.0.1:5432/ogevia_assign_e2e";
const MG = process.env.PILOT_MG!, CB = process.env.PILOT_CB!;
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
  // One Care Team record without a sign-in, so the "cannot be chosen" check is meaningful.
  await admin.query(`insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status)
    select id, 'CG-NOLOGIN', 'Synthetic', 'No Login', 'ready' from ogevia.organizations where slug = 'scs-pilot-synthetic'`);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
  const today = laDate();
  const m = await persona(browser, MG);

  // A new client with a current authorization for the first service.
  await signIn(m.page, "/clients");
  await m.page.getByRole("button", { name: "Add client" }).click();
  await m.page.getByLabel("First name").fill("Synthetic");
  await m.page.getByLabel("Last name").fill("Client Orion");
  await m.page.getByRole("button", { name: "Add client" }).click();
  await m.page.getByRole("link", { name: "Open it to add authorized hours" }).click();
  await m.page.getByRole("heading", { name: "Synthetic Client Orion" }).waitFor();
  const code = (await m.page.locator("h1 + span").innerText()).trim();
  await m.page.getByRole("button", { name: "Add authorization" }).click();
  const svc = m.page.getByLabel("Service");
  await svc.locator("option").nth(1).waitFor({ state: "attached" });
  await svc.selectOption({ index: 1 });
  const serviceLabel = (await svc.locator("option").nth(1).innerText()).trim();
  await m.page.getByLabel("Payer").fill("Synthetic Regional Center");
  await m.page.getByLabel("Authorized hours per month").fill("20");
  await m.page.getByLabel("Start date").fill(monthStart());
  await m.page.getByLabel("End date").fill(laDate(60));
  await m.page.getByRole("button", { name: "Add authorization" }).last().click();
  await m.page.getByText(/20 hr per month/).first().waitFor();

  // Caregiver B cannot see the new client yet.
  const b = await persona(browser, CB);
  await signIn(b.page, "/service-verification");
  await b.page.waitForTimeout(1500);
  check("caregiver B (before): the new client is not offered", !(await visible(b.page, `Client ${code}`)), code);

  // Assign caregiver B from the client page.
  const card = m.page.locator("section, div").filter({ has: m.page.getByRole("heading", { name: "Caregivers assigned" }) }).last();
  await m.page.getByRole("heading", { name: "Caregivers assigned" }).waitFor();
  check("manager: client page shows 'Caregivers assigned' with none yet", await visible(m.page, "No current or upcoming assignments."));
  await m.page.getByRole("button", { name: "Assign", exact: true }).first().click();
  const cg = m.page.getByLabel("Caregiver", { exact: true });
  await cg.locator("option").nth(1).waitFor({ state: "attached" });
  const bValue = await cg.locator("option", { hasText: "Caregiver B" }).getAttribute("value");
  await cg.selectOption(bValue!);
  await m.page.getByLabel("Service", { exact: true }).last().selectOption({ label: serviceLabel });
  check("manager: first day defaults to the agency's today", (await m.page.getByLabel("First day").inputValue()) === today);
  await m.page.getByRole("button", { name: "Assign", exact: true }).last().click();
  await m.page.getByText("Assigned.", { exact: true }).waitFor();
  check("manager: assignment covered by the authorization ('Assigned.')", true);
  check("manager: assignment shows as Current", await visible(m.page, /^Current$/));
  await noHScroll(m.page, "manager client page with assignments");

  await b.page.reload();
  await b.page.getByRole("button", { name: `Client ${code}` }).waitFor({ timeout: 10000 }).catch(() => {});
  check("caregiver B (after): the new client is offered on Verify visit", await visible(b.page, `Client ${code}`), code);

  // Uncovered: the second service has no authorization for this client.
  await m.page.getByRole("button", { name: "Assign", exact: true }).first().click();
  await cg.selectOption(bValue!);
  const svcB = m.page.getByLabel("Service", { exact: true }).last();
  await svcB.selectOption({ index: 2 });
  await m.page.getByLabel("First day").fill(laDate(3));
  await m.page.getByRole("button", { name: "Assign", exact: true }).last().click();
  await m.page.getByText(/no current authorization covers it/).waitFor();
  check("manager: an assignment without authorization is added but flagged in red", await visible(m.page, /Visits will be refused until one is added/));
  check("manager: the future assignment shows 'Starts later'", await visible(m.page, /^Starts later$/));
  await m.page.screenshot({ path: join(SHOTS, "01-client-assignments.png"), fullPage: true });

  // Cancel the upcoming one.
  const upcoming = m.page.getByRole("listitem").filter({ hasText: "Starts later" });
  await upcoming.getByRole("button", { name: "Cancel" }).click();
  await upcoming.getByLabel("Reason for ending").fill("Not needed (synthetic)");
  await upcoming.getByRole("button", { name: "Cancel assignment" }).click();
  await m.page.getByText("Assignment cancelled.").waitFor();
  check("manager: upcoming assignment cancelled", true);

  // A caregiver without a sign-in cannot be chosen.
  await m.page.getByRole("button", { name: "Assign", exact: true }).first().click();
  const noLogin = await cg.locator("option", { hasText: "no sign-in yet" }).count();
  const disabledAll = noLogin === 0 || (await cg.locator("option", { hasText: "no sign-in yet" }).evaluateAll((os) => os.every((o) => (o as HTMLOptionElement).disabled)));
  check("manager: caregivers without a sign-in are listed but cannot be chosen", noLogin >= 1 && disabledAll, `${noLogin} such option(s)`);
  await m.page.getByRole("button", { name: "Close" }).last().click();

  // Caregiver page: end the current assignment (last day today: access continues through today).
  await m.page.goto(WEB + "/care-team");
  await m.page.getByRole("link", { name: /Caregiver B/ }).first().click();
  await m.page.getByRole("heading", { name: "Clients assigned" }).waitFor();
  const row = m.page.getByRole("listitem").filter({ hasText: code });
  await row.waitFor();
  check("manager: caregiver page lists the client assignment", true);
  await noHScroll(m.page, "manager caregiver page with assignments");
  await row.getByRole("button", { name: "End" }).click();
  await row.getByRole("button", { name: "End assignment" }).click();
  check("manager: ending without a reason is refused", await visible(m.page, "Give a reason."));
  await row.getByLabel("Reason for ending").fill("Schedule change (synthetic)");
  await row.getByRole("button", { name: "End assignment" }).click();
  await m.page.getByText(/Assignment ends after/).waitFor();
  check("manager: last day today keeps access through today", await visible(m.page, /Assignment ends after/));
  await m.page.screenshot({ path: join(SHOTS, "02-caregiver-assignments.png"), fullPage: true });
  check("manager: no browser errors", m.errors.length === 0, m.errors.join(" | "));
  check("caregiver B: no browser errors", b.errors.length === 0, b.errors.join(" | "));

  const ev = Object.fromEntries((await admin.query(`select action, count(*)::int n from ogevia.audit_events where action like 'assignment.%' group by 1`)).rows
    .map((r: { action: string; n: number }) => [r.action, r.n]));
  check("audit: 2 assignments created, 2 ended (one cancelled, one ending today)", ev["assignment.created"] === 2 && ev["assignment.ended"] === 2, JSON.stringify(ev));
  const st = (await admin.query(`select a.effective_end::text e, a.is_active from ogevia.caregiver_assignments a join ogevia.clients c on c.id = a.client_id
    where c.client_code = $1 order by a.created_at`, [code])).rows;
  check("database: the first ends today and is still active today; the second is cancelled",
    st.length === 2 && st[0].e === today && st[0].is_active === true && st[1].is_active === false, JSON.stringify(st));

  await browser.close(); await admin.end(); await pool.end();
  writeFileSync(join(S, "assign-e2e-results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
