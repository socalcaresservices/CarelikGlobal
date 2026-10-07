// Local, synthetic check at 390 px of recurring shifts (0034): a 30-hour
// month and a 2-hour Monday–Thursday series. The preview shows each month's
// authorized/used/reserved/available hours and flags, by date, the
// occurrences that do not fit; "Create series" stays disabled until the
// person explicitly chooses to skip exactly those dates; one date is changed
// on its own; the series is ended from a date and the time is returned.
// Same harness as calendar-e2e.ts.
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
const SHOTS = join(S, "shots-recurring");
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
  const svc = (await admin.query("select id, code, name from ogevia.services where organization_id = $1 and is_active order by code limit 1", [org.id])).rows[0];
  const mgr = (await admin.query("select id from ogevia.app_users where cognito_sub = $1", [MG])).rows[0].id;
  const client = (await admin.query("insert into ogevia.clients (organization_id) values ($1) returning id, client_code", [org.id])).rows[0];
  await admin.query("insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by) values ($1, $2, 'Synthetic', 'Recurring', $3)", [client.id, org.id, mgr]);
  // 30 hours a month, from today for five months.
  await admin.query(`insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
    values ($1, $2, $3, 'SYNTHETIC-PAYER', 1800, (now() at time zone $4)::date, ((now() at time zone $4)::date + 150))`, [org.id, client.id, svc.id, org.timezone]);
  const today = laDate();
  // The first month after this one with at least 16 Monday–Thursday dates.
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const monthStartN = (n: number) => { const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };
  const endOf = (m: string) => { const d = new Date(`${m}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 0); return iso(d); };
  const datesOf = (from: string, to: string, days: number[]) => { const out: string[] = []; for (let d = new Date(`${from}T12:00:00Z`); iso(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) if (days.includes(d.getUTCDay())) out.push(iso(d)); return out; };
  let m = monthStartN(1);
  for (let i = 2; datesOf(m, endOf(m), [1, 2, 3, 4]).length < 16 && i < 6; i++) m = monthStartN(i);
  const dates = datesOf(m, endOf(m), [1, 2, 3, 4]);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });

  const p = await persona(browser, MG);
  await signIn(p.page, "/schedule");
  await p.page.goto(WEB + "/schedule");
  await p.page.getByRole("button", { name: "Repeat weekly" }).click();
  const form = p.page.locator("form").filter({ has: p.page.getByText("Repeats every") });
  const clientSel = form.getByLabel("Client");
  await clientSel.locator("option", { hasText: "Synthetic Recurring" }).waitFor({ state: "attached", timeout: 15000 });
  await clientSel.selectOption({ label: `Synthetic Recurring (${client.client_code})` });
  await form.getByLabel("Service").selectOption({ label: `${svc.name} (${svc.code})` });
  for (const d of ["Mon", "Tue", "Wed", "Thu"]) await form.getByLabel(d, { exact: true }).check();
  await form.getByLabel("Start time").fill("09:00");
  await form.getByLabel("End time").fill("11:00");
  await form.getByLabel("First date").fill(m);
  await form.getByLabel("Last date (optional)").fill(endOf(m));
  await form.getByRole("button", { name: "Preview dates and hours" }).click();
  const table = p.page.getByRole("list", { name: "Hours by month" });
  await table.waitFor({ timeout: 15000 });
  const row = (await table.locator("li").first().innerText()).replace(/\s+/g, " ");
  check("preview: month card shows 30 hr authorized, 15 dates · 30 hr, 0 min available after (no sideways scrolling)", /Authorized 30 hr/.test(row) && /This series 15 dates · 30 hr/.test(row) && /Available after 0 min/.test(row), row);
  const flaggedText = await p.page.getByRole("list", { name: "Dates" }).innerText();
  const flagged = dates.slice(15);
  const fmt = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
  check(`preview: the ${flagged.length} dates after the 15th are flagged by date`, flagged.every((d) => flaggedText.includes(`${fmt(d)} · 2 hr — Over the month's authorized hours`)), flagged.map(fmt).join(", "));
  check("preview: alert explains nothing is shortened or moved", await p.page.getByRole("alert").filter({ hasText: "Nothing is shortened or moved" }).isVisible());
  check("'Create series' disabled while dates are flagged", await form.getByRole("button", { name: "Create series" }).isDisabled());
  await noHScroll(p.page, "recurring preview");
  await p.page.screenshot({ path: join(SHOTS, "01-preview.png"), fullPage: true });
  check("nothing saved by previewing", (await admin.query("select count(*)::int n from ogevia.shift_series where client_id = $1", [client.id])).rows[0].n === 0);
  await form.getByRole("button", { name: new RegExp(`Create and skip the ${flagged.length} listed date`) }).click();
  check("created: 15 shifts, skipped dates stated", await p.page.getByText(new RegExp(`Series created: 15 shifts scheduled through .*30 hr reserved.*${flagged.length} dates? skipped as listed`)).waitFor({ timeout: 15000 }).then(() => true, () => false));
  const reserved = async () => Number((await admin.query(`select coalesce(sum(r.reserved_minutes), 0) n from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id
    where s.client_id = $1 and r.released_at is null`, [client.id])).rows[0].n);
  check("database: 1800 minutes reserved in that month (no overrun)", await reserved() === 1800);

  // One date only: the first occurrence moves to 1:00–2:00 PM.
  await p.page.getByLabel("Week starting").fill(dates[0]!);
  const first = p.page.locator("li").filter({ hasText: "Repeats weekly" }).first();
  await first.waitFor({ timeout: 15000 });
  await first.getByRole("button", { name: "Change this date only" }).click();
  await first.getByLabel("Start time").fill("13:00");
  await first.getByLabel("End time").fill("14:00");
  await first.getByLabel("Reason").fill("Client appointment (synthetic)");
  await first.getByRole("button", { name: "Change this date only" }).last().click();
  check("this date only changed; rest unchanged", await p.page.getByText(/This date only was changed: 1 hr reserved/).waitFor({ timeout: 15000 }).then(() => true, () => false));
  check("database: reserved 1800 - 60 = 1740", await reserved() === 1740);

  // End the series from its 5th date: the time comes back.
  await p.page.getByRole("button", { name: "Recurring series" }).click();
  const item = p.page.locator("li").filter({ hasText: "Every Mon, Tue, Wed, Thu" }).first();
  await item.waitFor({ timeout: 15000 });
  await item.getByRole("button", { name: "End from a date" }).click();
  await item.getByLabel("First date to stop").fill(dates[4]!);
  await item.getByLabel("Reason").fill("Services paused (synthetic)");
  await item.getByRole("button", { name: "End series from this date" }).click();
  check("ended: 11 shifts cancelled, 22 hr returned", await p.page.getByText(/Series ended from .*: 11 shifts cancelled, 22 hr returned to the authorization/).waitFor({ timeout: 15000 }).then(() => true, () => false));
  check("database: only the first 4 dates remain reserved (1740 - 1320 = 420)", await reserved() === 420);
  await noHScroll(p.page, "schedule after changes");
  await p.page.screenshot({ path: join(SHOTS, "02-after.png"), fullPage: true });
  check("audit: series created, one date rescheduled, series ended", (await admin.query("select array_agg(action order by id) a from ogevia.audit_events where action in ('shift_series.created', 'shift.rescheduled', 'shift_series.ended_from')")).rows[0].a.join(",") === "shift_series.created,shift.rescheduled,shift_series.ended_from");
  check("no page errors", p.errors.length === 0, p.errors.join("; "));

  await browser.close(); await admin.end(); await pool.end();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(S, "e2e-results-recurring.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
