// Local, synthetic check at 390 px of visit review (0031), the owner's
// 2026-10-05 case: a no-signer visit (worked 3 min, billable 0, Needs review).
// Billing review links to the exact visit; the page shows client, caregiver,
// actual times and the no-signer reason; only "not billable" is offered; the
// decision is recorded with a reason; Needs attention drops by one; the visit
// record is unchanged. Same harness as calendar-e2e.ts.
import { execFileSync } from "node:child_process";
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
const SHOTS = join(S, "shots-review");
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
  // innerWidth grows past the device width when content overflows on a phone, so compare with 390 too.
  check(`${label}: no horizontal scroll at 390 px`, sw <= iw && iw <= 390, `scrollWidth ${sw}, innerWidth ${iw}`);
}
const visible = (page: Page, text: string | RegExp) => page.getByText(text).first().isVisible().catch(() => false);
const laDate = (n = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() + n * 864e5));
const monthStart = () => `${laDate().slice(0, 7)}-01`;

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
  const org = (await admin.query("select id, timezone from ogevia.organizations where slug = 'scs-pilot-synthetic'")).rows[0];
  const a = (await admin.query(`select a.*, c.client_code from ogevia.client_authorizations a join ogevia.clients c on c.id = a.client_id
    where a.organization_id = $1 and a.is_current and a.deleted_at is null and (now() at time zone $2)::date between a.period_start and a.period_end order by c.client_code limit 1`, [org.id, org.timezone])).rows[0];
  const mgr = (await admin.query("select u.id from ogevia.app_users u where u.cognito_sub = $1", [MG])).rows[0].id;
  await admin.query("insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by) values ($1, $2, 'Synthetic Client', 'Bravo', $3) on conflict (client_id) do update set legal_first_name = excluded.legal_first_name, legal_last_name = excluded.legal_last_name", [a.client_id, org.id, mgr]);
  const cg = (await admin.query("select m.user_id, p.display_name from ogevia.organization_memberships m join ogevia.app_users p on p.id = m.user_id where m.organization_id = $1 and m.role = 'caregiver' order by m.user_id limit 1", [org.id])).rows[0];
  await admin.query("set session_replication_role = replica");
  const visit = (await admin.query(`insert into ogevia.service_visits (organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_name_snapshot,
      service_authorization_id, service_id, service_date, time_in, time_out, worked_minutes, verified_minutes, billable_minutes, caregiver_attested_at,
      status, signed_at, locked_at, authorization_status, visit_number_snapshot, created_by)
    values ($1, $2, $3, $4, $5, $6, $7, ((now() - interval '2 hours') at time zone $8)::date, now() - interval '2 hours', now() - interval '2 hours' + interval '3 minutes 30 seconds',
      3, 0, 0, now() - interval '2 hours', 'administrator_review', now() - interval '1 hour', now() - interval '1 hour', 'within_authorization', 'V-REVIEW-E2E', $4) returning id`,
    [org.id, a.client_id, a.client_code, cg.user_id, cg.display_name, a.id, a.service_id, org.timezone])).rows[0].id;
  await admin.query("insert into ogevia.visit_confirmations (organization_id, visit_id, signer_role, confirmation_method, confirmation_reason, confirmed_visit_snapshot, confirmation_version, confirmed_by) values ($1, $2, 'client', 'unable_to_confirm', 'Client asleep; parent not home (synthetic)', '{}'::jsonb, 4, $3)", [org.id, visit, cg.user_id]);
  await admin.query("reset session_replication_role");
  const before = (await admin.query("select status, time_in, time_out, worked_minutes, verified_minutes, billable_minutes from ogevia.service_visits where id = $1", [visit])).rows[0];
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });

  const m = await persona(browser, MG);
  await signIn(m.page, "/billing-review");
  await m.page.goto(WEB + "/billing-review");
  const badge = m.page.getByRole("link", { name: /^Needs attention: \d+/ });
  await badge.waitFor({ timeout: 15000 });
  const countBefore = Number(/\d+/.exec((await badge.getAttribute("aria-label")) ?? "")?.[0]);
  const link = m.page.getByRole("link", { name: "Review visit" }).first();
  check("billing review: 'Review visit' (no 'Review first' text)", await link.waitFor({ timeout: 15000 }).then(() => true, () => false) && (await m.page.getByText("Review first").count()) === 0);
  check("billing review: link points at the exact visit", (await link.getAttribute("href")) === `/visits/${visit}`, (await link.getAttribute("href")) ?? "");
  await link.click();
  await m.page.getByRole("heading", { name: "Synthetic Client Bravo" }).waitFor({ timeout: 15000 });
  const page = await m.page.locator("main").innerText();
  check("visit page: client name and code, caregiver, service", page.includes(a.client_code) && page.includes(cg.display_name));
  check("visit page: actual times with AM/PM and MM/DD/YYYY", /\d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M/.test(page) && /\d{2}\/\d{2}\/\d{4}/.test(page));
  check("visit page: no-signer reason shown", page.includes("Client asleep; parent not home (synthetic)"));
  check("visit page: why it needs review", page.includes("did not confirm the visit, so it has 0 billable minutes"));
  check("visit page: only 'not billable' offered (no accept for an unsigned visit)", (await m.page.getByLabel(/Accept the billable minutes/).count()) === 0 && await m.page.getByLabel(/Close the review: not billable/).isVisible());
  check("menu: exactly one current item, Visit records", JSON.stringify(await m.page.locator("nav[aria-label=Main] a[aria-current=page]").allInnerTexts()) === JSON.stringify(["Visit records"]));
  check("opening the page recorded nothing", (await admin.query("select count(*)::int n from ogevia.visit_review_decisions where visit_id = $1", [visit])).rows[0].n === 0);
  await noHScroll(m.page, "visit review");
  await m.page.screenshot({ path: join(SHOTS, "01-visit-review.png"), fullPage: true });
  await m.page.getByLabel(/Close the review: not billable/).check();
  await m.page.getByLabel(/Reason \(required/).fill("Parent could not be reached; not billable (synthetic)");
  await m.page.getByRole("button", { name: "Record decision" }).click();
  check("decision recorded; record unchanged message", await m.page.getByText("Review decision recorded. The visit record is unchanged.").waitFor({ timeout: 10000 }).then(() => true, () => false));
  check("page shows Reviewed — not billable", await m.page.getByText("Reviewed — not billable").first().isVisible());
  const after = (await admin.query("select status, time_in, time_out, worked_minutes, verified_minutes, billable_minutes from ogevia.service_visits where id = $1", [visit])).rows[0];
  check("database: visit record unchanged (status, times, minutes)", JSON.stringify(after) === JSON.stringify(before));
  const audit = (await admin.query("select count(*)::int n from ogevia.audit_events where action = 'visit.review_decided'")).rows[0].n;
  check("database: decision audited", audit === 1);
  await m.page.screenshot({ path: join(SHOTS, "02-visit-reviewed.png"), fullPage: true });
  await m.page.goto(WEB + "/billing-review");
  await m.page.getByText("Reviewed — not billable").first().waitFor({ timeout: 15000 });
  const badge2 = m.page.getByRole("link", { name: /^(Needs attention: \d+|All clear: 0)/ });
  await badge2.waitFor({ timeout: 15000 });
  const countAfter = Number(/\d+/.exec((await badge2.getAttribute("aria-label")) ?? "")?.[0]);
  check("Needs attention count dropped by one", countAfter === countBefore - 1, `${countBefore} -> ${countAfter}`);
  await noHScroll(m.page, "billing review after review");
  check("no page errors", m.errors.length === 0, m.errors.join("; "));

  await browser.close(); await admin.end(); await pool.end();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(S, "e2e-results-review.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
