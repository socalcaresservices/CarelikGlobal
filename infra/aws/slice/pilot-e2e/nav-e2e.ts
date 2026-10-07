// Local, synthetic browser check of the main menu: on desktop (1280 px) and on
// a phone (390 px), with direct page loads, clicks and back/forward, exactly one
// menu item is current (aria-current="page", highlighted) and it is the right
// one. Same harness as schedule-e2e.ts. Database: ogevia_cont_e2e.
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
const SHOTS = join(S, "shots-nav");
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

async function current(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('nav[aria-label="Main"] a'))
    .filter((a) => a.getAttribute("aria-current") === "page").map((a) => (a.textContent ?? "").trim()));
}
async function highlighted(page: Page) {
  // The highlight itself: links with a background colour other than transparent.
  return page.evaluate(() => Array.from(document.querySelectorAll('nav[aria-label="Main"] a'))
    .filter((a) => { const c = getComputedStyle(a).backgroundColor; return c !== "rgba(0, 0, 0, 0)" && c !== "transparent"; })
    .map((a) => (a.textContent ?? "").trim()));
}
async function expectOne(page: Page, label: string, what: string) {
  await page.waitForFunction((l) => Array.from(document.querySelectorAll('nav[aria-label="Main"] a')).some((a) => a.getAttribute("aria-current") === "page" && (a.textContent ?? "").trim() === l), label, { timeout: 8000 }).catch(() => {});
  await page.mouse.move(5, 880); // no hover on a menu item, so only the current-item highlight remains
  const c = await current(page), h = await highlighted(page);
  check(`${what}: only "${label}" current and highlighted`, JSON.stringify(c) === JSON.stringify([label]) && JSON.stringify(h) === JSON.stringify([label]), `aria-current ${JSON.stringify(c)}, highlighted ${JSON.stringify(h)}`);
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
  for (const mode of ["desktop", "phone"] as const) {
    const m = await persona(browser, MG);
    if (mode === "desktop") await m.page.setViewportSize({ width: 1280, height: 900 });
    await signIn(m.page, "/service-verification/reports");
    await m.page.goto(WEB + "/service-verification/reports");
    await expectOne(m.page, "Visit records", `${mode}, direct load of Visit records`);
    if (mode === "phone") {
      check("phone: the Menu button names the current section", await m.page.getByRole("button", { name: /Menu · Visit records/ }).isVisible());
      await m.page.getByRole("button", { name: /Menu/ }).click();
      await m.page.screenshot({ path: join(SHOTS, "phone-visit-records-menu.png") });
      await m.page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Verify visit" }).click();
    } else {
      await m.page.screenshot({ path: join(SHOTS, "desktop-visit-records.png") });
      await m.page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Verify visit" }).click();
    }
    await m.page.waitForURL((u) => u.pathname === "/service-verification");
    await expectOne(m.page, "Verify visit", `${mode}, after clicking Verify visit`);
    await m.page.goBack(); await m.page.waitForURL((u) => u.pathname === "/service-verification/reports");
    await expectOne(m.page, "Visit records", `${mode}, Back to Visit records`);
    await m.page.goForward(); await m.page.waitForURL((u) => u.pathname === "/service-verification");
    await expectOne(m.page, "Verify visit", `${mode}, Forward to Verify visit`);
    await m.page.goto(WEB + "/service-verification/reports?view=exceptions");
    await expectOne(m.page, "Visit records", `${mode}, direct load of the exceptions view`);
    await m.page.goto(WEB + "/");
    await expectOne(m.page, "Home", `${mode}, direct load of Home`);
    await m.page.goto(WEB + "/schedule");
    await expectOne(m.page, "Schedule", `${mode}, direct load of Schedule`);
    await m.page.reload();
    await expectOne(m.page, "Schedule", `${mode}, reload of Schedule`);
    if (mode === "phone") await noHScroll(m.page, "phone Schedule");
    check(`${mode}: no page errors`, m.errors.length === 0, m.errors.join("; "));
    await m.ctx.close();
  }
  const b = await persona(browser, CB);
  await signIn(b.page, "/service-verification");
  await b.page.goto(WEB + "/service-verification");
  await expectOne(b.page, "Verify visit", "caregiver (phone), Verify visit");
  await b.page.goto(WEB + "/my-shifts");
  await expectOne(b.page, "My shifts", "caregiver (phone), My shifts");
  await b.page.goBack(); await b.page.waitForURL((u) => u.pathname === "/service-verification");
  await expectOne(b.page, "Verify visit", "caregiver (phone), Back to Verify visit");

  await browser.close(); await pool.end();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(S, "e2e-results-nav.json"), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
