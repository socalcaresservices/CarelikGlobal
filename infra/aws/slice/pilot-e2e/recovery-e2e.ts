// Local, synthetic check at 390 px of missing-signature recovery (0036): the
// manager asks for the signature instead of closing the visit; the visit
// leaves Needs attention; the recipient (no account) opens the link, enters
// the phone code, draws a signature; the manager views and accepts it; the
// visit becomes eligible and is approved by a person for at most the worked
// minutes. The visit record itself never changes. Same harness as review-e2e.ts.
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
const SHOTS = join(S, "shots-recovery");
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
const evidence = new MemoryEvidenceStore();
const OWNER = "c0000000-0000-4000-8000-0000000000f1";

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const logLines: string[] = [];
const pool = new pg.Pool({ connectionString: APP_URL, max: 4 });
const handler = createHandler({ config: { issuer: ISSUER, appClientIds: [CLIENT], dbSetRole: "ogevia_app" }, db: { connect: () => pool.connect() }, evidence, identity, log: (r) => logLines.push(JSON.stringify(r)) });
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


/** A context with no sign-in: only the API is routed (the recipient's phone). */
async function anonymous(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "America/Los_Angeles" });
  await ctx.route(`${API}/**`, async (route) => {
    const r = route.request();
    if (r.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const res = await invoke(r.method(), new URL(r.url()), r.headers(), r.postData());
    return route.fulfill({ status: res.statusCode, headers: { ...(res.headers as Record<string, string>), ...CORS }, body: (res.body as string) ?? "" });
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

/** The header badge's count: "Needs attention: N items" or "All clear: 0 items need attention". */
async function badgeCount(page: Page): Promise<number> {
  const b = page.getByRole("link", { name: /^(Needs attention: \d+ items?|All clear: 0 items need attention)$/ });
  await b.waitFor({ timeout: 15000 });
  return Number(/\d+/.exec((await b.getAttribute("aria-label")) ?? "")?.[0]);
}

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
      3, 0, 0, now() - interval '2 hours', 'administrator_review', now() - interval '1 hour', now() - interval '1 hour', 'within_authorization', 'V-RECOVERY-E2E', $4) returning id`,
    [org.id, a.client_id, a.client_code, cg.user_id, cg.display_name, a.id, a.service_id, org.timezone])).rows[0].id;
  await admin.query("insert into ogevia.visit_confirmations (organization_id, visit_id, signer_role, confirmation_method, confirmation_reason, confirmed_visit_snapshot, confirmation_version, confirmed_by) values ($1, $2, 'client', 'unable_to_confirm', 'Client asleep; parent not home (synthetic)', '{}'::jsonb, 4, $3)", [org.id, visit, cg.user_id]);
  await admin.query("reset session_replication_role");
  const before = (await admin.query("select status, time_in, time_out, worked_minutes, verified_minutes, billable_minutes from ogevia.service_visits where id = $1", [visit])).rows[0];
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });

  // 1. Manager: ask for the signature instead of closing the visit.
  const m = await persona(browser, MG);
  await signIn(m.page, `/visits/${visit}`);
  await m.page.goto(WEB + `/visits/${visit}`);
  const countBefore = await badgeCount(m.page);
  check("visit page: 'Get the missing signature' offered on a no-signer visit", await m.page.getByRole("heading", { name: "Get the missing signature" }).waitFor({ timeout: 15000 }).then(() => true, () => false));
  await m.page.getByLabel("Person who will confirm").fill("Synthetic Parent Rivera");
  await m.page.getByLabel("They are the").selectOption("parent");
  await m.page.getByLabel("How you will verify them by phone").fill("Call the number on file and confirm the name");
  await m.page.getByRole("button", { name: "Create secure link" }).click();
  await m.page.getByText("Shown only once. Copy them now.").waitFor({ timeout: 15000 });
  const link = (await m.page.getByText(/\/confirm-visit#[0-9a-f]{64}$/).innerText()).trim();
  const code = (await m.page.getByLabel("One-time code").innerText()).trim();
  check("link: token in the URL fragment, code shown separately", /^http:\/\/127\.0\.0\.1:4173\/confirm-visit#[0-9a-f]{64}$/.test(link) && /^\d{6}$/.test(code));
  await noHScroll(m.page, "visit page with the new link");
  await m.page.screenshot({ path: join(SHOTS, "01-link-created.png"), fullPage: true });
  const stored = (await admin.query("select token_hash, code_hash from ogevia.visit_confirmation_requests where visit_id = $1", [visit])).rows[0];
  check("database keeps only hashes (no token or code)", !!stored && stored.token_hash !== link.split("#")[1] && !JSON.stringify(stored).includes(code));
  await m.page.getByRole("button", { name: "I have copied the link and noted the code" }).click();
  await m.page.reload();
  await m.page.getByText("Waiting for the confirmation.").waitFor({ timeout: 15000 });
  const countWaiting = await badgeCount(m.page);
  check("Needs attention drops by one while waiting (no forced closure)", countWaiting === countBefore - 1, `${countBefore} -> ${countWaiting}`);
  check("no review decision was recorded", (await admin.query("select count(*)::int n from ogevia.visit_review_decisions where visit_id = $1", [visit])).rows[0].n === 0);

  // 2. Recipient on a phone, no account.
  const r = await anonymous(browser);
  await r.page.goto(link);
  await r.page.getByLabel("Code").fill(code === "000000" ? "111111" : "000000");
  await r.page.getByRole("button", { name: "Continue" }).click();
  check("recipient: wrong code explained with attempts left", await r.page.getByText(/That code is not correct\. 4 attempts left\./).waitFor({ timeout: 15000 }).then(() => true, () => false));
  await r.page.getByLabel("Code").fill(code);
  await r.page.getByRole("button", { name: "Continue" }).click();
  await r.page.getByText("Please check this visit").waitFor({ timeout: 15000 });
  const shown = await r.page.locator("main").innerText();
  check("recipient: date MM/DD/YYYY and times AM/PM", /\d{2}\/\d{2}\/\d{4}/.test(shown) && /\d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M/.test(shown));
  check("recipient: no client code, client name or visit number shown", !shown.includes(a.client_code) && !shown.includes("Bravo") && !shown.includes("V-RECOVERY-E2E"));
  await r.page.getByLabel("Yes, it happened as shown").check();
  const box = (await r.page.getByLabel("Your signature").boundingBox())!;
  await r.page.mouse.move(box.x + 20, box.y + 40); await r.page.mouse.down();
  for (let i = 1; i <= 12; i++) await r.page.mouse.move(box.x + 20 + i * 20, box.y + 40 + (i % 2 ? 30 : -10));
  await r.page.mouse.up();
  await r.page.getByLabel(/I confirm that/).check();
  await noHScroll(r.page, "recipient page");
  await r.page.screenshot({ path: join(SHOTS, "02-recipient.png"), fullPage: true });
  await r.page.getByRole("button", { name: "Send confirmation" }).click();
  check("recipient: confirmation sent", await r.page.getByText("Thank you. Your confirmation was sent.").waitFor({ timeout: 15000 }).then(() => true, () => false));
  await r.page.screenshot({ path: join(SHOTS, "03-recipient-done.png"), fullPage: true });
  const again = await r.ctx.newPage();
  await again.goto(link);
  await again.getByLabel("Code").fill(code);
  await again.getByRole("button", { name: "Continue" }).click();
  check("recipient: the link no longer works after answering", await again.getByText(/This link is not valid any more/).waitFor({ timeout: 15000 }).then(() => true, () => false));

  // 3. Manager reviews and accepts; a person approves billing.
  await m.page.reload();
  await m.page.getByText("A response came in. Review it below.").first().waitFor({ timeout: 15000 });
  const countResponse = await badgeCount(m.page);
  check("Needs attention counts the response to review", countResponse === countBefore, `${countResponse}`);
  await m.page.getByRole("button", { name: "View signature" }).click();
  check("manager: the drawn signature is shown", await m.page.getByRole("img", { name: "Signature" }).waitFor({ timeout: 15000 }).then(() => true, () => false));
  await m.page.getByLabel("Reason (required)").fill("Parent confirmed by phone; signature matches (synthetic)");
  await m.page.getByRole("button", { name: "Accept confirmation" }).click();
  check("manager: accepted with eligible minutes shown", await m.page.getByText(/Accepted — 3 min eligible for billing approval/).waitFor({ timeout: 15000 }).then(() => true, () => false));
  await noHScroll(m.page, "visit page after acceptance");
  await m.page.screenshot({ path: join(SHOTS, "04-accepted.png"), fullPage: true });
  check("visit status: eligible for billing approval, not approved", (await m.page.locator("main").innerText()).includes("Late confirmation accepted — eligible for billing approval")
    && (await admin.query("select count(*)::int n from ogevia.billing_approvals where visit_id = $1", [visit])).rows[0].n === 0);

  await m.page.goto(WEB + "/billing-review");
  const approve = m.page.getByRole("button", { name: "Approve" }).first();
  check("billing review: the visit can now be approved by a person", await approve.waitFor({ timeout: 15000 }).then(() => true, () => false));
  const ok = (await admin.query("select count(*)::int n from ogevia.service_visits where id = $1", [visit])).rows[0].n === 1;
  check("visit row still present", ok);
  const after = (await admin.query("select status, time_in, time_out, worked_minutes, verified_minutes, billable_minutes from ogevia.service_visits where id = $1", [visit])).rows[0];
  check("the visit record itself is unchanged (status, times, 0 billable)", JSON.stringify(after) === JSON.stringify(before));
  const lc = (await admin.query("select outcome, method, evidence_object_key from ogevia.visit_late_confirmations where visit_id = $1", [visit])).rows[0];
  check("late confirmation stored separately with the drawn signature in private storage", lc?.outcome === "confirmed" && lc.method === "draw" && /\/client-signature\.png$/.test(lc.evidence_object_key));
  check("no token or code in any API log line", !logLines.join("\n").includes(link.split("#")[1]!) && !logLines.some((l) => l.includes(`"${code}"`)));

  await browser.close(); await admin.end(); await pool.end();
  writeFileSync(join(S, "e2e-results-recovery.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
