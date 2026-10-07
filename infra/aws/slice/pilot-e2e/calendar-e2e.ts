// Local, synthetic check of the one-page client monthly calendar (item 8):
// the manager opens the calendar for a client with two services and two
// caregivers; the page shows the caregiver summary with names, service totals
// and a to-the-minute cross-check, lists unfinished work separately, leaves out
// a replaced original; the printout is rendered to a real US Letter landscape
// PDF, which must be exactly one page (two with the optional detail page).
// Same harness as rounding-e2e.ts. Database: ogevia_cal_e2e.
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
const SHOTS = join(S, "shots-cal");
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
  const auths = (await admin.query(`select a.*, c.client_code from ogevia.client_authorizations a join ogevia.clients c on c.id = a.client_id
    where a.organization_id = $1 and a.is_current and a.deleted_at is null and c.client_code = 'P-AHXN7'
      and (now() at time zone $2)::date between a.period_start and a.period_end order by a.service_id`, [org.id, org.timezone])).rows;
  check("seed: client with two current authorizations", auths.length === 2, String(auths.length));
  const client = auths[0].client_id, code = auths[0].client_code;
  await admin.query("insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by) select $1, $2, 'Synthetic', 'Calendarperson', m.user_id from ogevia.organization_memberships m where m.organization_id = $2 and m.role = 'manager' limit 1 on conflict do nothing", [client, org.id]);
  const cgs = (await admin.query("select m.user_id, p.display_name from ogevia.organization_memberships m join ogevia.app_users p on p.id = m.user_id where m.organization_id = $1 and m.role = 'caregiver' order by m.user_id limit 2", [org.id])).rows;
  const month = laDate().slice(0, 7);
  const today = Number(laDate().slice(8, 10));
  await admin.query("set session_replication_role = replica");
  let n = 0;
  const add = async (day: number, start: string, minutes: number, cg: number, auth: number, status = "signed", billable = minutes, inMonth = month) => {
    n += 1;
    const date = `${inMonth}-${String(day).padStart(2, "0")}`;
    const done = status !== "draft";
    return (await admin.query(`insert into ogevia.service_visits (organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_name_snapshot,
        service_authorization_id, service_id, service_date, time_in, time_out, worked_minutes, verified_minutes, billable_minutes, caregiver_attested_at,
        status, signed_at, locked_at, authorization_status, visit_number_snapshot, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8::date, ($8::date + $9::time) at time zone $10::text,
        case when $11::boolean then ($8::date + $9::time) at time zone $10 + make_interval(mins => $12::int) end,
        case when $11::boolean then $12::int end, case when $11::boolean then $12::int end, case when $11::boolean then $13::int end, case when $11::boolean then now() end,
        $14::ogevia.service_visit_status, case when $14 in ('signed','administrator_review','corrected') then now() end,
        case when $14 in ('signed','administrator_review','corrected') then now() end,
        (case when $14 = 'administrator_review' then 'exceeds_authorization' when $11::boolean then 'within_authorization' end)::ogevia.visit_authorization_status,
        $15, $4) returning id`,
      [org.id, client, code, cgs[cg].user_id, cgs[cg].display_name, auths[auth].id, auths[auth].service_id, date, start, org.timezone, done, minutes, billable, status, `V-CAL-${n}`])).rows[0].id;
  };
  // Ordinary month: a few visits a day, two services, two caregivers.
  const days = Array.from({ length: Math.max(1, today - 1) }, (_, i) => i + 1);
  let counted = 0;
  for (const d of days) {
    await add(d, "09:00", 121, 0, 0); counted += 121;
    await add(d, "13:30", 47, 1, 1); counted += 47;
  }
  await add(days[0]!, "17:00", 1, 1, 0); counted += 1; // a 1-minute visit must still reconcile
  await add(days[days.length - 1]!, "18:00", 30, 0, 1, "administrator_review", 15); counted += 30;
  await add(days[0]!, "06:00", 999, 0, 0, "corrected"); // replaced original: never counted
  await add(today, "08:00", 0, 1, 0, "draft"); // still open: listed, not counted
  // Stress month: August 2026 needs six calendar rows; every day has both services.
  // (Local synthetic DB only: the authorizations are widened to start 08/01/2026.)
  await admin.query("update ogevia.client_authorizations set period_start = '2026-08-01' where client_id = $1", [client]);
  let august = 0;
  for (let d = 1; d <= 31; d++) {
    await add(d, "09:00", 61, 0, 0, "signed", 61, "2026-08"); august += 61;
    await add(d, "14:00", 59, 1, 1, "signed", 59, "2026-08"); august += 59;
  }
  await admin.query("reset session_replication_role");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });

  const m = await persona(browser, MG);
  await signIn(m.page, "/service-verification/reports?view=calendar");
  await m.page.goto(WEB + "/service-verification/reports?view=calendar");
  const pick = m.page.getByLabel("Calendar client");
  await pick.locator("option", { hasText: "Synthetic Calendarperson" }).waitFor({ state: "attached", timeout: 15000 });
  await pick.selectOption({ label: "Synthetic Calendarperson" });
  check("calendar: client name with code", await m.page.getByText(`(${code})`, { exact: true }).first().waitFor({ timeout: 15000 }).then(() => true, () => false));
  const agree = await m.page.getByText("✓ Daily, caregiver and service totals agree to the minute.").waitFor({ timeout: 15000 }).then(() => true, () => false);
  check("totals agree to the minute (daily = caregiver = server service totals)", agree);
  const totalText = await m.page.getByText(/^Total worked this month:/).innerText();
  const hours = Math.floor(counted / 60), mins = counted % 60;
  check("overall worked total excludes the replaced original and the open visit", totalText.includes(mins ? `${hours} hr ${mins} min` : `${hours} hr`), `${totalText} vs ${counted} min`);
  const cgTable = m.page.getByRole("table", { name: "Caregiver summary" });
  const cgText = await cgTable.innerText();
  check("caregiver summary names both caregivers", cgs.every((c: { display_name: string }) => cgText.includes(c.display_name)), cgText.replace(/\s+/g, " ").slice(0, 160));
  check("not-yet-complete work listed separately", await m.page.getByRole("heading", { name: "Not yet complete (not counted above)" }).isVisible()
    && (await m.page.getByRole("region", { name: "Not yet complete (not counted above)" }).innerText()).includes("In progress"), "");
  await noHScroll(m.page, "calendar");
  await m.page.screenshot({ path: join(SHOTS, "01-calendar-phone.png"), fullPage: true });

  // Real printout: desktop page, print media, US Letter landscape (the page's own @page rule).
  await m.page.setViewportSize({ width: 1280, height: 900 });
  await m.page.emulateMedia({ media: "print" });
  const pdf1 = join(SHOTS, "calendar.pdf");
  await m.page.pdf({ path: pdf1, preferCSSPageSize: true, printBackground: true });
  const info = execFileSync("pdfinfo", [pdf1]).toString();
  const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1]);
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(info);
  check("PDF is exactly one page", pages === 1, `pages ${pages}`);
  check("PDF page is US Letter landscape (792 x 612 pt)", !!size && Math.round(Number(size[1])) === 792 && Math.round(Number(size[2])) === 612, size?.[0] ?? info);
  execFileSync("pdftoppm", ["-png", "-r", "110", pdf1, join(SHOTS, "calendar")]);
  const text = execFileSync("pdftotext", ["-layout", pdf1, "-"]).toString();
  writeFileSync(join(SHOTS, "calendar.txt"), text);
  check("PDF text: client name and code, month, caregiver and service totals", text.includes("Synthetic Calendarperson") && text.includes(code) && /Caregiver summary/.test(text) && /Service totals/.test(text) && /agree to the minute/.test(text));
  check("PDF text: no app chrome or filters", !/Calendar client|Print calendar|Needs attention/i.test(text));
  await m.page.emulateMedia({ media: "screen" });
  await m.page.getByLabel("Add a visit detail page").check();
  await m.page.emulateMedia({ media: "print" });
  const pdf2 = join(SHOTS, "calendar-detail.pdf");
  await m.page.pdf({ path: pdf2, preferCSSPageSize: true, printBackground: true });
  const pages2 = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [pdf2]).toString())?.[1]);
  check("with the detail page: calendar page + detail page(s)", pages2 >= 2, `pages ${pages2}`);
  execFileSync("pdftoppm", ["-png", "-r", "80", pdf2, join(SHOTS, "calendar-detail")]);
  // Stress month on one page.
  await m.page.emulateMedia({ media: "screen" });
  await m.page.getByLabel("Add a visit detail page").uncheck();
  await m.page.getByLabel("Calendar month").fill("2026-08");
  check("August (6 rows, 2 services daily): totals agree", await m.page.getByText("✓ Daily, caregiver and service totals agree to the minute.").waitFor({ timeout: 15000 }).then(() => true, () => false));
  const augText = await m.page.getByText(/^Total worked this month:/).innerText();
  check("August total = 31 x (61 + 59) min = 62 hr", augText.includes("62 hr") && august === 3720, augText);
  await m.page.emulateMedia({ media: "print" });
  const pdf3 = join(SHOTS, "calendar-august.pdf");
  await m.page.pdf({ path: pdf3, preferCSSPageSize: true, printBackground: true });
  const pages3 = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [pdf3]).toString())?.[1]);
  check("August PDF is exactly one page", pages3 === 1, `pages ${pages3}`);
  execFileSync("pdftoppm", ["-png", "-r", "110", pdf3, join(SHOTS, "calendar-august")]);
  check("no page errors", m.errors.length === 0, m.errors.join("; "));

  await browser.close(); await admin.end(); await pool.end();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(S, "e2e-results-cal.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
