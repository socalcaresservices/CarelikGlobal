// Local, synthetic browser check at 390 px of caregiver invitations and
// planned assignments (0025) and the schedule with call-outs (0026): a
// manager adds a caregiver, plans an assignment, invites them (in-memory
// identity service: no Cognito call, no password anywhere) and sees the
// status; schedules a shift, the caregiver calls out from My shifts, the
// manager assigns a replacement and reads the history; too many hours are
// refused. Same harness as clients-e2e.ts. Database: ogevia_sched_e2e.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
const SHOTS = join(S, "shots26");
mkdirSync(SHOTS, { recursive: true });
const WEB = "http://127.0.0.1:4173";
const API = "https://api.pilot-e2e.test";
const IDP = "https://pilot-e2e.auth.us-west-2.amazoncognito.com";
const CLIENT = "pilote2eclient000000000000";
const ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_PILOTE2E1";
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? "postgres://ogevia_admin@127.0.0.1:5432/ogevia_sched_e2e";
const APP_URL = process.env.E2E_APP_URL ?? "postgres://e2e_app_login:e2e-local-only@127.0.0.1:5432/ogevia_sched_e2e";
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
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
  const m = await persona(browser, MG);

  // A client with 10 authorized hours a month.
  await signIn(m.page, "/clients");
  await m.page.getByRole("button", { name: "Add client" }).click();
  await m.page.getByLabel("First name").fill("Synthetic");
  await m.page.getByLabel("Last name").fill("Client Vega");
  await m.page.getByRole("button", { name: "Add client" }).click();
  await m.page.getByRole("link", { name: "Open it to add authorized hours" }).click();
  await m.page.getByRole("heading", { name: "Synthetic Client Vega" }).waitFor();
  await m.page.getByRole("button", { name: "Add authorization" }).click();
  const svc = m.page.getByLabel("Service");
  await svc.locator("option").nth(1).waitFor({ state: "attached" });
  await svc.selectOption({ index: 1 });
  await m.page.getByLabel("Payer").fill("Synthetic Regional Center");
  await m.page.getByLabel("Authorized hours per month").fill("10");
  await m.page.getByLabel("Start date").fill(monthStart());
  await m.page.getByLabel("End date").fill(laDate(60));
  await m.page.getByRole("button", { name: "Add authorization" }).last().click();
  await m.page.getByText(/10 hr per month/).first().waitFor();
  const clientUrl = m.page.url();

  // A new caregiver (Ready to work, no sign-in): plan an assignment, then invite.
  await m.page.goto(WEB + "/care-team");
  await m.page.getByRole("button", { name: "Add caregiver" }).click();
  await m.page.getByLabel("First name").fill("Synthetic");
  await m.page.getByLabel("Last name").fill("Newcomer");
  await m.page.getByLabel("Starting status").selectOption("ready");
  await m.page.getByRole("button", { name: "Add caregiver" }).click();
  await m.page.getByText(/Caregiver added/).waitFor();
  await m.page.getByRole("link", { name: /Synthetic Newcomer/ }).click();
  await m.page.getByRole("heading", { name: "Synthetic Newcomer" }).waitFor();
  check("caregiver page: 'No sign-in yet.' with an invite form", await visible(m.page, "No sign-in yet.") && await m.page.getByLabel("Caregiver's email").isVisible());
  await m.page.getByRole("button", { name: "Assign", exact: true }).first().click();
  const cl = m.page.getByLabel("Client", { exact: true });
  await cl.locator("option", { hasText: "Client Vega" }).waitFor({ state: "attached" });
  await cl.selectOption({ label: (await cl.locator("option", { hasText: "Client Vega" }).innerText()).trim() });
  const svc2 = m.page.getByLabel("Service");
  await svc2.locator("option").nth(1).waitFor({ state: "attached" });
  await svc2.selectOption({ index: 1 });
  await m.page.getByRole("button", { name: "Assign", exact: true }).last().click();
  check("planned assignment: the screen says no access yet", await m.page.getByText(/Planned\. Access starts once the caregiver has signed in/).first().waitFor({ timeout: 8000 }).then(() => true, () => false));
  await m.page.getByLabel("Caregiver's email").fill("newcomer.synthetic@example.test");
  await m.page.getByRole("button", { name: "Send invitation" }).click();
  check("invite: success message, Cognito emails the temporary password", await m.page.getByText(/Invitation sent\. The caregiver gets an email with a temporary password/).waitFor({ timeout: 8000 }).then(() => true, () => false));
  check("invite: status 'Invited — has not signed in yet'", await m.page.getByText("Invited — has not signed in yet.").waitFor({ timeout: 8000 }).then(() => true, () => false));
  check("invite: the identity service received only the email, no password", JSON.stringify(identity.calls) === JSON.stringify([{ action: "invite", email: "newcomer.synthetic@example.test" }]));
  check("planned assignment now grants access (record Ready + sign-in linked)", !(await visible(m.page, /Planned — no access yet/)));
  await m.page.getByRole("button", { name: "Resend invitation" }).click();
  check("resend: confirmed and counted", await m.page.getByText(/Sent 2 times/).waitFor({ timeout: 8000 }).then(() => true, () => false));
  await noHScroll(m.page, "caregiver page with invitation");
  await m.page.screenshot({ path: join(SHOTS, "01-invitation.png"), fullPage: true });
  const dbInv = (await admin.query("select count(*)::int n from ogevia.audit_events where action in ('caregiver.invited','caregiver.invitation_resent') and after_state::text not like '%@%'")).rows[0].n;
  check("audit: invite and resend recorded without the email address", dbInv === 2, `${dbInv} rows`);
  check("API logs carry no email address", !logLines.join("\n").includes("newcomer.synthetic"));

  // Schedule: a 3-hour shift tomorrow for caregiver B.
  await m.page.goto(WEB + "/schedule");
  await m.page.getByRole("heading", { name: "Schedule" }).waitFor();
  await m.page.getByRole("button", { name: "Add shift" }).click();
  const sc = m.page.getByLabel("Client");
  await sc.locator("option", { hasText: "Client Vega" }).waitFor({ state: "attached" });
  await sc.selectOption({ label: (await sc.locator("option", { hasText: "Client Vega" }).innerText()).trim() });
  const ss = m.page.getByLabel("Service");
  await ss.locator("option").nth(1).waitFor({ state: "attached" });
  await ss.selectOption({ index: 1 });
  const scg = m.page.getByLabel("Caregiver (optional)");
  await scg.locator("option", { hasText: "Caregiver B" }).waitFor({ state: "attached" });
  await scg.selectOption({ label: (await scg.locator("option", { hasText: "Caregiver B" }).innerText()).trim() });
  await m.page.getByLabel("Date").fill(laDate(1));
  await m.page.getByLabel("Start time").fill("09:00");
  await m.page.getByLabel("End time").fill("12:00");
  await m.page.getByRole("button", { name: "Schedule shift" }).click();
  check("schedule: 3 h reserved, 7 h left this month", await m.page.getByText(/Shift scheduled\. 3 h reserved; 7 h of authorized time left this month\./).waitFor({ timeout: 8000 }).then(() => true, () => false));

  // Too many hours: an 8-hour shift the day after is refused with the minutes left.
  await m.page.getByRole("button", { name: "Add shift" }).click();
  await sc.selectOption({ label: (await sc.locator("option", { hasText: "Client Vega" }).innerText()).trim() });
  await ss.locator("option").nth(1).waitFor({ state: "attached" });
  await ss.selectOption({ index: 1 });
  await m.page.getByLabel("Date").fill(laDate(2));
  await m.page.getByLabel("Start time").fill("08:00");
  await m.page.getByLabel("End time").fill("16:00");
  await m.page.getByRole("button", { name: "Schedule shift" }).click();
  check("schedule: more hours than authorized are refused, with the minutes left", await m.page.getByText(/Not enough authorized time remains this month for this shift: 7 hr available, this shift needs 8 hr/).waitFor({ timeout: 8000 }).then(() => true, () => false));
  await m.page.getByRole("button", { name: "Close" }).first().click();

  // Caregiver B calls out from My shifts.
  const b = await persona(browser, CB);
  await signIn(b.page, "/my-shifts");
  await b.page.getByRole("heading", { name: "My shifts" }).waitFor();
  check("caregiver B: My shifts shows the client by code only", await b.page.getByText(/Client CL-/).first().waitFor({ timeout: 8000 }).then(() => true, () => false) && !(await visible(b.page, "Client Vega")));
  await b.page.getByRole("button", { name: "I can't make it" }).click();
  await b.page.getByLabel("Why can't you come?").fill("Sick (synthetic)");
  await b.page.getByRole("button", { name: "Tell the office" }).click();
  check("caregiver B: call-out sent", await b.page.getByText(/The office has been told/).waitFor({ timeout: 8000 }).then(() => true, () => false));
  await noHScroll(b.page, "My shifts");
  await b.page.screenshot({ path: join(SHOTS, "02-my-shifts.png"), fullPage: true });

  // Manager: NEEDS COVERAGE, assign caregiver A, history.
  await m.page.reload();
  check("schedule: NEEDS COVERAGE count shown", await m.page.getByText(/1 shift needs coverage this week/i).waitFor({ timeout: 8000 }).then(() => true, () => false));
  const row = m.page.locator("li").filter({ hasText: "Client Vega" }).first();
  check("schedule: the call-out reason is shown", await row.getByText("Reason: Sick (synthetic)").isVisible());
  await row.getByRole("button", { name: "Assign caregiver" }).click();
  const pick = row.getByLabel("Caregiver");
  await pick.locator("option", { hasText: "Caregiver A" }).waitFor({ state: "attached" });
  await pick.selectOption({ label: (await pick.locator("option", { hasText: "Caregiver A" }).innerText()).trim() });
  await row.getByRole("button", { name: "Assign caregiver" }).last().click();
  check("schedule: replacement covers the shift", await m.page.getByText("Caregiver assigned. The shift is covered.").waitFor({ timeout: 8000 }).then(() => true, () => false));
  const row2 = m.page.locator("li").filter({ hasText: "Client Vega" }).first();
  await row2.getByRole("button", { name: "History" }).click();
  check("history: call-out by the caregiver, then the replacement", await row2.getByText(/called out \(caregiver\) — Sick \(synthetic\)/).waitFor({ timeout: 8000 }).then(() => true, () => false)
    && await row2.getByText(/Caregiver A assigned in place of .*Caregiver B/).isVisible());
  await noHScroll(m.page, "Schedule");
  await m.page.screenshot({ path: join(SHOTS, "03-schedule.png"), fullPage: true });
  const ev = (await admin.query("select event_type::text from ogevia.shift_coverage_events order by created_at")).rows.map((r: { event_type: string }) => r.event_type).join(",");
  check("database: coverage events called_out,reassigned", ev === "called_out,reassigned", ev);
  check("no page errors", !m.errors.length && !b.errors.length, [...m.errors, ...b.errors].join("; "));
  void clientUrl;

  await browser.close(); await admin.end(); await pool.end();
  writeFileSync(join(S, "sched-e2e-results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
