// Local, synthetic browser check at 390 px of outage continuity (0027-0028):
// the manager sees the outage-readiness warning, downloads the continuity pack
// (the file is opened offline at 390 px), enters a numbered outage visit
// record, sees reconciliation, and a duplicate number is refused; a caregiver
// is not offered either screen. Same harness as schedule-e2e.ts.
// Database: ogevia_cont_e2e.
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
const SHOTS = join(S, "shots28");
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
  check(`${label}: no horizontal scroll at 390 px`, sw <= iw, `scrollWidth ${sw}, innerWidth ${iw}`);
}
const visible = (page: Page, text: string | RegExp) => page.getByText(text).first().isVisible().catch(() => false);
const laDate = (n = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() + n * 864e5));
const monthStart = () => `${laDate().slice(0, 7)}-01`;

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
  const m = await persona(browser, MG);

  await signIn(m.page, "/");
  check("home: outage-readiness warning before any pack", await m.page.getByText("OUTAGE READINESS: No continuity pack has been downloaded yet.").waitFor({ timeout: 10000 }).then(() => true, () => false));
  await noHScroll(m.page, "home with continuity warning");
  await m.page.getByRole("link", { name: "Continuity pack" }).click();
  await m.page.getByRole("heading", { name: "Continuity pack" }).waitFor();
  const [download] = await Promise.all([m.page.waitForEvent("download"), m.page.getByRole("button", { name: "Download continuity pack" }).click()]);
  const file = join(S, "continuity-pack.html");
  await download.saveAs(file);
  check("download: file name carries only the agency-local time", /^ogevia-continuity-\d{8}-\d{4}\.html$/.test(download.suggestedFilename()), download.suggestedFilename());
  check("download: confirmation states data-as-of and numbers OUT-000001 to OUT-000025",
    await m.page.getByText(/Downloaded: data as of .*; outage numbers OUT-000001 to OUT-000025\./).waitFor({ timeout: 8000 }).then(() => true, () => false));
  check("status: last downloaded less than an hour ago", await m.page.getByText(/Continuity pack last downloaded less than an hour ago by /).first().waitFor({ timeout: 8000 }).then(() => true, () => false));
  await noHScroll(m.page, "continuity page");
  await m.page.screenshot({ path: join(SHOTS, "01-continuity.png"), fullPage: true });
  const html = readFileSync(file, "utf8");
  const clients = (await admin.query("select o.slug, c.client_code from ogevia.clients c join ogevia.organizations o on o.id = c.organization_id where c.deleted_at is null and c.status = 'active'")).rows as { slug: string; client_code: string }[];
  const own = clients.filter((c) => c.slug === "scs-pilot-synthetic").map((c) => c.client_code);
  const other = clients.filter((c) => c.slug !== "scs-pilot-synthetic").map((c) => c.client_code);
  check("pack file: every active client of this agency", own.length > 0 && own.every((c) => html.includes(c)), `${own.length} clients`);
  check("pack file: no client of the other agency", other.every((c) => !html.includes(c)), `${other.length} checked`);
  check("pack file: data-as-of banner and 25 outage numbers", html.includes("Data as of") && html.includes("OUT-000001") && html.includes("OUT-000025") && !html.includes("OUT-000026"));
  check("pack file: no money, rates or payer", !/\$|cents|payer|rate/i.test(html));
  const audit = (await admin.query("select count(*)::int n from ogevia.audit_events where action = 'continuity.pack_downloaded'")).rows[0].n;
  check("audit: the download is recorded", audit === 1, `${audit} rows`);

  // The file on its own, offline, on a phone.
  const off = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, offline: true });
  const op = await off.newPage();
  await op.goto("file://" + file);
  check("offline file opens without Ogevia or a network", await op.getByText(/Data as of/).isVisible());
  await noHScroll(op, "offline continuity file");
  await op.screenshot({ path: join(SHOTS, "02-offline-file.png"), fullPage: true });
  await off.close();

  // After the outage: enter OUT-000001 for yesterday.
  await m.page.goto(WEB + "/outage-visits");
  await m.page.getByRole("heading", { name: "Outage visit records" }).waitFor();
  check("reconciliation: 25 issued, 25 MISSING", await m.page.getByText("25 numbers issued · 0 entered · 0 not used · 25 MISSING (not yet entered or closed)").waitFor({ timeout: 8000 }).then(() => true, () => false));
  const pair = (await admin.query(`select c.client_code, s.code from ogevia.client_authorizations a join ogevia.clients c on c.id = a.client_id
     join ogevia.services s on s.id = a.service_id join ogevia.organizations o on o.id = a.organization_id
     where o.slug = 'scs-pilot-synthetic' and a.is_current and a.deleted_at is null and c.status = 'active'
       and (now() at time zone o.timezone)::date - 1 between a.period_start and a.period_end order by c.client_code limit 1`)).rows[0] as { client_code: string; code: string };
  const pick = async (label: string, code: string) => {
    const el = m.page.getByLabel(label, { exact: true }); const opt = el.locator("option", { hasText: `(${code})` });
    await opt.first().waitFor({ state: "attached" }); await el.selectOption({ label: (await opt.first().innerText()).trim() });
  };
  const fill = async (n: string, tin: string, tout: string) => {
    await m.page.getByLabel("Record number", { exact: true }).fill(n);
    await m.page.getByLabel("Date of the visit").fill(laDate(-1));
    await pick("Client", pair.client_code);
    await pick("Service", pair.code);
    const g = m.page.getByLabel("Caregiver", { exact: true }); await g.locator("option", { hasText: "Caregiver A" }).waitFor({ state: "attached" });
    await g.selectOption({ label: (await g.locator("option", { hasText: "Caregiver A" }).innerText()).trim() });
    await m.page.getByLabel("Time In (as written)").fill(tin);
    await m.page.getByLabel("Time Out (as written)").fill(tout);
    await m.page.getByLabel("Signed on the form").check();
    await m.page.getByLabel("Name of the person who signed or confirmed").fill("Synthetic Representative");
    await m.page.getByRole("button", { name: "Enter outage record" }).click();
  };
  await fill("OUT-000001", "09:00", "11:00");
  const ok1 = await m.page.getByText(/OUT-000001 entered as visit .* \(120 min\)\. It is in administrator review with 0 billable minutes/).waitFor({ timeout: 8000 }).then(() => true, () => false);
  check("outage record entered: administrator review, 0 billable", ok1, ok1 ? "" : (await m.page.getByRole("alert").first().innerText().catch(() => "no message")));
  check("reconciliation: 1 entered, 24 MISSING", await m.page.getByText("25 numbers issued · 1 entered · 0 not used · 24 MISSING (not yet entered or closed)").waitFor({ timeout: 8000 }).then(() => true, () => false));
  await fill("OUT-000001", "13:00", "14:00");
  check("duplicate number refused by the server", await m.page.getByRole("alert").filter({ hasText: /OUT-000001 was already entered/ }).waitFor({ timeout: 8000 }).then(() => true, () => false));
  await noHScroll(m.page, "outage records page");
  await m.page.screenshot({ path: join(SHOTS, "03-outage-records.png"), fullPage: true });
  const v = (await admin.query("select v.status::text, v.billable_minutes, v.worked_minutes, v.time_out_reason from ogevia.outage_visit_records r join ogevia.service_visits v on v.id = r.visit_id")).rows;
  check("database: one visit, administrator_review, 0 billable, labelled as an outage record",
    v.length === 1 && v[0].status === "administrator_review" && v[0].billable_minutes === 0 && v[0].worked_minutes === 120 && /^Outage record OUT-000001/.test(v[0].time_out_reason));

  // Caregiver: neither screen.
  const b = await persona(browser, CB);
  await signIn(b.page, "/continuity");
  await b.page.goto(WEB + "/continuity");
  check("caregiver: no Continuity or Outage records in the menu", !(await visible(b.page, "Outage records")) && !(await b.page.getByRole("link", { name: "Continuity" }).isVisible().catch(() => false)));
  check("caregiver: continuity page refuses", await b.page.getByText(/Only an Administrator or a manager can download the continuity pack/).waitFor({ timeout: 8000 }).then(() => true, () => false));
  check("no page errors", m.errors.length === 0 && b.errors.length === 0, [...m.errors, ...b.errors].join("; "));
  check("API logs carry no client names or signer names", !logLines.join("\n").includes("Synthetic Representative"));

  await browser.close(); await admin.end(); await pool.end();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(S, "e2e-results-28.json"), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
