// Local, synthetic browser check of Care Team and service administration (0023)
// at 390 px: manager adds and renames a caregiver; making a signed-in caregiver
// inactive ends their assignments and they lose access at their next request;
// reactivation restores the sign-in; services are read-only for managers and
// managed by the Administrator (in-use deactivation refused). Same harness as
// clients-e2e.ts. Database: ogevia_careteam_e2e (setup in README.md).
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
const SHOTS = join(S, "shots23");
mkdirSync(SHOTS, { recursive: true });
const WEB = "http://127.0.0.1:4173";
const API = "https://api.pilot-e2e.test";
const IDP = "https://pilot-e2e.auth.us-west-2.amazoncognito.com";
const CLIENT = "pilote2eclient000000000000";
const ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_PILOTE2E1";
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? "postgres://ogevia_admin@127.0.0.1:5432/ogevia_careteam_e2e";
const APP_URL = process.env.E2E_APP_URL ?? "postgres://e2e_app_login:e2e-local-only@127.0.0.1:5432/ogevia_careteam_e2e";
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
  check(`${label}: no horizontal scroll at 390 px`, sw <= iw && iw <= 390, `scrollWidth ${sw}, innerWidth ${iw}`);
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

  // ---- Caregiver B can work before the change ----
  const b = await persona(browser, CB);
  await signIn(b.page, "/service-verification");
  await b.page.waitForTimeout(1500);
  check("caregiver B (before): sees an assigned client to start a visit", await visible(b.page, /Client P-/));

  // ---- Manager: Care Team ----
  const m = await persona(browser, MG);
  await signIn(m.page, "/care-team");
  await m.page.getByRole("heading", { name: "Care Team" }).waitFor({ timeout: 10000 }).catch(async () => {
    await m.page.screenshot({ path: join(SHOTS, "00-debug-manager.png"), fullPage: true });
    console.log("DEBUG url", m.page.url(), "errors", m.errors.join(" | "), "text", (await m.page.locator("main").innerText().catch(() => "")).slice(0, 400));
    throw new Error("Care Team page did not render");
  });
  check("manager: Care Team lists the pilot caregivers with sign-in state", await visible(m.page, /Sign-in active/));
  await noHScroll(m.page, "manager Care Team list");
  await m.page.getByRole("button", { name: "Add caregiver" }).click();
  await m.page.getByLabel("First name").fill("Synthetic");
  await m.page.getByLabel("Last name").fill("Caregiver Nova");
  await m.page.getByLabel("Starting status").selectOption("ready");
  await m.page.getByRole("button", { name: "Add caregiver" }).click();
  await m.page.getByText("Caregiver added.").waitFor();
  await m.page.getByRole("link", { name: "Open the record" }).click();
  await m.page.getByRole("heading", { name: "Synthetic Caregiver Nova" }).waitFor();
  check("manager: new record shows 'No sign-in yet' and Ready to work", (await visible(m.page, /No sign-in yet/)) && (await visible(m.page, /^Ready to work$/)));
  await m.page.getByLabel("Preferred name (optional)").fill("Nova");
  await m.page.getByRole("button", { name: "Save name" }).click();
  await m.page.getByText(/Saved\. The change is in the record's history/).waitFor();
  check("manager: preferred name saved", await visible(m.page, /Synthetic Caregiver Nova \("Nova"\)/));
  await noHScroll(m.page, "manager caregiver record");

  // Make pilot caregiver B inactive.
  await m.page.goto(WEB + "/care-team");
  await m.page.getByRole("link", { name: /Caregiver B/ }).first().click();
  await m.page.getByRole("heading", { name: /Caregiver B/ }).waitFor();
  await m.page.getByLabel("Change to").selectOption("inactive");
  await m.page.getByRole("button", { name: "Change status" }).click();
  check("manager: inactive without a reason is refused", await visible(m.page, "Give a reason for the change."));
  await m.page.getByLabel("Reason").fill("Left the agency (synthetic)");
  await m.page.getByRole("button", { name: "Change status" }).click();
  await m.page.getByText(/Status changed to Inactive/).waitFor();
  const msg = await m.page.getByText(/Status changed to Inactive/).innerText();
  check("manager: assignments ended and sign-in suspended, stated on screen", /assignments? ended/.test(msg) && /sign-in is suspended/.test(msg), msg);
  await m.page.screenshot({ path: join(SHOTS, "01-manager-caregiver-inactive.png"), fullPage: true });

  // ---- Caregiver B loses access at the next request ----
  await b.page.reload();
  await b.page.waitForTimeout(2000);
  check("caregiver B (after): no client to start a visit any more", !(await visible(b.page, /Client P-/)));
  await b.page.screenshot({ path: join(SHOTS, "02-caregiver-b-after.png"), fullPage: true });

  // Reactivate: sign-in works again, assignments are not silently restored.
  await m.page.getByLabel("Change to").selectOption("active");
  await m.page.getByLabel("Reason").fill("Rehired (synthetic)");
  await m.page.getByRole("button", { name: "Change status" }).click();
  await m.page.getByText(/Status changed to Active/).waitFor();
  check("manager: reactivation restores the sign-in only", await visible(m.page, /sign-in works again\. Re-add assignments/));
  check("manager: record shows 0 active assignments after reactivation", await visible(m.page, /^0 active assignments/));
  check("manager: no browser errors", m.errors.length === 0, m.errors.join(" | "));

  // ---- Services ----
  await m.page.goto(WEB + "/services");
  await m.page.getByRole("heading", { name: "Services" }).waitFor();
  check("manager: services are read-only", (await visible(m.page, /Only the agency Administrator can change this list/)) && (await m.page.getByRole("button", { name: "Add service" }).count()) === 0);
  const o = await persona(browser, OWNER);
  await signIn(o.page, "/services");
  await o.page.getByRole("heading", { name: "Services" }).waitFor();
  await o.page.getByLabel("Code").fill("rsp-2");
  await o.page.getByLabel("Name").fill("Synthetic Respite Two");
  await o.page.getByRole("button", { name: "Add service" }).click();
  await o.page.getByText("Service added.").waitFor();
  check("Administrator: service added with the code normalised", await visible(o.page, "(RSP-2)"));
  await o.page.getByRole("listitem").filter({ hasText: "(PCS)" }).getByRole("button", { name: "Deactivate" }).click();
  await o.page.getByLabel(/Reason to deactivate PCS/).fill("Testing (synthetic)");
  await o.page.getByRole("listitem").filter({ hasText: "(PCS)" }).getByRole("button", { name: "Deactivate" }).click();
  await o.page.getByText(/still have current authorizations/).waitFor({ timeout: 8000 }).catch(() => {});
  check("Administrator: deactivating a service in use is refused with the reason", await visible(o.page, /still have current authorizations/));
  const row = o.page.getByRole("listitem").filter({ hasText: "(RSP-2)" });
  await row.getByRole("button", { name: "Deactivate" }).click();
  await o.page.getByLabel(/Reason to deactivate RSP-2/).fill("Not offered yet (synthetic)");
  await row.getByRole("button", { name: "Deactivate" }).click();
  await row.getByText("Inactive").waitFor();
  check("Administrator: unused service deactivated", true);
  await noHScroll(o.page, "Administrator services");
  await o.page.screenshot({ path: join(SHOTS, "03-administrator-services.png"), fullPage: true });
  check("Administrator: no browser errors", o.errors.length === 0, o.errors.join(" | "));

  // ---- Database evidence ----
  const ev = Object.fromEntries((await admin.query(`select action, count(*)::int n from ogevia.audit_events
    where action in ('caregiver.created','caregiver.updated','caregiver.status_changed','service.created','service.deactivated') group by 1`)).rows.map((r: { action: string; n: number }) => [r.action, r.n]));
  check("audit: caregiver created, renamed, 2 status changes; service created and deactivated",
    ev["caregiver.created"] === 1 && ev["caregiver.updated"] === 1 && ev["caregiver.status_changed"] === 2 && ev["service.created"] === 1 && ev["service.deactivated"] === 1, JSON.stringify(ev));
  const st = (await admin.query(`select m.status, (select count(*)::int from ogevia.caregiver_assignments a where a.caregiver_user_id = u.id and a.is_active) active
    from ogevia.app_users u join ogevia.organization_memberships m on m.user_id = u.id where u.cognito_sub = $1`, [CB])).rows[0];
  check("database: caregiver B membership active again, 0 active assignments", st.status === "active" && st.active === 0, JSON.stringify(st));

  await browser.close(); await admin.end(); await pool.end();
  writeFileSync(join(S, "careteam-e2e-results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
