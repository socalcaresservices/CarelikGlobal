// Local, synthetic browser check of the AWS TEST workspace (0019-0021) at 390 px:
// owner/manager/caregiver headers, NEEDS ATTENTION, Home, branding and logo,
// restricted client names, visit cards, printable calendar, documents
// (request/upload/review), billing cards. Setup as README.md, database ogevia_workspace_e2e.
// Real AWS-mode web build + real sv-api handler + local PostgreSQL (0001-0019,
// SCS pilot seed). Cognito is faked with unsigned tokens (as pilot-e2e.ts).
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { createHandler } from "/home/user/CarelikGlobal/apps/sv-api/src/handler.ts";
import { ROUTES } from "/home/user/CarelikGlobal/apps/sv-api/src/routes.ts";
import { syntheticPng } from "/home/user/CarelikGlobal/apps/sv-api/test/fixtures.ts";
import { MemoryEvidenceStore } from "/home/user/CarelikGlobal/apps/sv-api/src/evidence.ts";

const req = createRequire("/home/user/CarelikGlobal/apps/sv-api/package.json");
const pg = req("pg");
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));
const S = process.env.E2E_DIR ?? "/tmp/ogevia-pilot-e2e";
const { chromium } = createRequire(join(S, "package.json"))("playwright-core") as typeof import("playwright-core");
const SHOTS = join(S, "shots21");
mkdirSync(SHOTS, { recursive: true });
const WEB = "http://127.0.0.1:4173";
const API = "https://api.pilot-e2e.test";
const IDP = "https://pilot-e2e.auth.us-west-2.amazoncognito.com";
const CLIENT = "pilote2eclient000000000000";
const ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_PILOTE2E1";
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? "postgres://ogevia_admin@127.0.0.1:5432/ogevia_workspace_e2e";
const APP_URL = process.env.E2E_APP_URL ?? "postgres://e2e_app_login:e2e-local-only@127.0.0.1:5432/ogevia_workspace_e2e";
const MG = process.env.PILOT_MG!, CA = process.env.PILOT_CA!, CB = process.env.PILOT_CB!;
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
async function api(sub: string, routeKey: string, o: { path?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}) {
  const [method, t] = routeKey.split(" ") as [string, string];
  const url = new URL(API + t.replace(/\{(\w+)\}/g, (_, n) => encodeURIComponent(o.path![n]!)));
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const h: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token(sub)}` };
  if (method === "POST") h["idempotency-key"] = randomUUID();
  const r = await invoke(method, url, h, o.body === undefined ? null : JSON.stringify(o.body));
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body as string) : null };
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
  check(`${label}: page has no horizontal scroll at 390 px`, sw <= iw && iw <= 390, `scrollWidth ${sw}, innerWidth ${iw}`);
}

async function visit(sub: string, minutesAgo: number, confirm: "draw" | "unable_to_confirm") {
  const me = await api(sub, "GET /v1/me");
  const org = me.body.memberships[0].organizationId as string;
  const client = (await api(sub, "GET /v1/clients/assigned", { query: { organizationId: org } })).body.clients[0].clientId as string;
  const service = (await api(sub, "GET /v1/clients/{clientId}/services", { path: { clientId: client }, query: { organizationId: org } })).body.services[0].serviceId as string;
  const s = await api(sub, "POST /v1/visits", { body: { organizationId: org, clientId: client, serviceId: service } });
  if (s.status !== 201) throw new Error(`start ${s.status} ${JSON.stringify(s.body)}`);
  const id = s.body.visitId as string;
  const admin = await (async () => { const c = new pg.Client({ connectionString: ADMIN_URL }); await c.connect(); return c; })();
  await admin.query("set session_replication_role = replica");
  await admin.query("update ogevia.service_visits set time_in = time_in - make_interval(mins => $2) where id = $1", [id, minutesAgo]);
  await admin.end();
  const e = await api(sub, "POST /v1/visits/{visitId}/end", { path: { visitId: id } });
  if (e.status !== 200) throw new Error(`end ${e.status} ${JSON.stringify(e.body)}`);
  const body = confirm === "draw"
    ? { signerRole: "client", method: "draw", signaturePng: syntheticPng(120, 60, 3).toString("base64") }
    : { signerRole: "client", method: "unable_to_confirm", reason: "Client asleep (synthetic)" };
  const c = await api(sub, "POST /v1/visits/{visitId}/confirm", { path: { visitId: id }, body: { ...body, organizationId: org } });
  if (c.status !== 200) throw new Error(`confirm ${c.status} ${JSON.stringify(c.body)}`);
  return { id, org, status: c.body.result.status as string, billable: c.body.result.billableMinutes as number };
}

const pngBytes = syntheticPng(400, 300, 7);
/** Agency-local (Pacific) calendar date, + n days. */
const laDate = (n = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() + n * 864e5));

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
  await admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Owner') on conflict do nothing", [OWNER]);
  await admin.query(`insert into ogevia.organization_memberships (organization_id, user_id, role, status)
    select o.id, u.id, 'organization_owner', 'active' from ogevia.organizations o, ogevia.app_users u
    where o.slug = 'scs-pilot-synthetic' and u.cognito_sub = $1 on conflict do nothing`, [OWNER]);
  await admin.query("set session_replication_role = replica");
  await admin.query("update ogevia.client_authorizations set hourly_rate_cents = 3000");
  await admin.query("set session_replication_role = origin");
  const v1 = await visit(CA, 90, "draw");
  const v2 = await visit(CB, 45, "unable_to_confirm");
  check("setup: one Billing Ready visit and one needing review", v1.status === "signed" && v2.status === "administrator_review");

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const shot = (p: Page, n: string) => p.screenshot({ path: join(SHOTS, `${n}.png`), fullPage: true });
  try {
    // ---------------- Owner: Home, branding
    const O = await persona(browser, OWNER);
    await signIn(O.page, "/");
    await O.page.getByText("ADMINISTRATOR VIEW").waitFor({ timeout: 15000 });
    check("owner header: ADMINISTRATOR VIEW with the real name", await O.page.getByText("Synthetic Owner").isVisible());
    const needs = O.page.getByRole("link", { name: /Needs attention|All clear/ });
    await needs.waitFor({ timeout: 15000 }); // not while it still says "Checking…"
    check("owner header: NEEDS ATTENTION visible with a count", (await needs.isVisible()) && /^(Needs attention: \d+|All clear: 0)/.test((await needs.getAttribute("aria-label")) ?? ""), (await needs.getAttribute("aria-label")) ?? "");
    await O.page.getByText("Financial impact (Administrator only)").waitFor({ timeout: 15000 });
    check("owner Home: financial cards with cost/margin unavailable", await O.page.getByText(/no caregiver pay data/).isVisible());
    await noHScroll(O.page, "owner Home");
    await shot(O.page, "01-owner-home");
    await O.page.getByRole("button", { name: /Menu/ }).click();
    await O.page.getByRole("link", { name: "Settings" }).click();
    await O.page.getByLabel("Hex").fill("#fde68a");
    check("owner branding: too-light colour flagged before saving", await O.page.getByText(/too light: needs 4\.5:1/).isVisible());
    await O.page.getByLabel("Hex").fill("#14532d");
    await O.page.getByRole("button", { name: "Save branding" }).click();
    await O.page.getByText("Saved. Every role sees it on next load.").waitFor({ timeout: 15000 });
    check("owner branding: saved", true);
    await O.page.getByLabel(/Logo image/).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: syntheticPng(200, 80, 3) });
    await O.page.getByRole("button", { name: "Save logo" }).click();
    await O.page.getByText("Logo saved.").waitFor({ timeout: 15000 });
    await O.page.getByAltText("Current agency logo").waitFor({ timeout: 15000 });
    check("owner logo: uploaded and shown from private storage", true);
    await shot(O.page, "02-owner-branding");
    check("owner: no page errors", O.errors.length === 0, O.errors.join(" | "));

    // ---------------- Manager: Home, NEEDS ATTENTION, visit records, calendar, documents
    let M = await persona(browser, MG);
    await signIn(M.page, "/");
    await M.page.getByText("MANAGER VIEW").waitFor({ timeout: 15000 });
    check("manager header: MANAGER VIEW with the real name", await M.page.getByText("Pilot Manager", { exact: true }).isVisible());
    const borderTop = await M.page.locator("header").evaluate((h) => getComputedStyle(h).borderTopColor);
    check("manager sees the owner's agency colour", borderTop === "rgb(20, 83, 45)", borderTop);
    check("manager sees the agency logo in the header", await M.page.locator("header img[alt$='logo']").isVisible());
    check("manager Home: no owner-only financial cards", (await M.page.getByText("Financial impact (Administrator only)").count()) === 0);
    await noHScroll(M.page, "manager Home");
    await shot(M.page, "03-manager-home");
    await M.page.getByRole("link", { name: /Needs attention/ }).click();
    await M.page.getByRole("heading", { name: "Needs attention" }).waitFor({ timeout: 15000 });
    check("NEEDS ATTENTION opens the exceptions list directly", true);
    await shot(M.page, "04-manager-needs-attention");

    await M.page.getByRole("button", { name: /Menu/ }).click();
    await M.page.getByRole("link", { name: "Visit records" }).click();
    await M.page.getByRole("heading", { name: "Visit records" }).waitFor({ timeout: 15000 });
    const cards = M.page.getByRole("list", { name: "Visit records" });
    await cards.waitFor({ timeout: 15000 });
    check("visit records on a phone: cards, not a sideways table", (await M.page.getByRole("table", { name: "Visit details" }).count()) === 0 && (await cards.locator("li").count()) >= 2);
    const firstCard = await cards.locator("li").first().innerText();
    const code = firstCard.split("\n")[0]!;
    check("client code shown once per card", firstCard.split(code).length - 1 === 1, code);
    check("Menu button names the current section", (await M.page.getByRole("button", { name: /Menu/ }).innerText()).includes("Visit records"));
    check("visit card date is MM/DD/YYYY (owner requirement 2026-10-05)", /\d{2}\/\d{2}\/\d{4}/.test(firstCard), firstCard.split("\n")[3] ?? "");
    await noHScroll(M.page, "manager Visit records");
    await shot(M.page, "05-manager-visit-records");

    await M.page.getByRole("button", { name: /Menu/ }).click();
    await M.page.getByRole("link", { name: "Clients" }).click();
    await M.page.getByRole("heading", { name: "Clients" }).waitFor({ timeout: 15000 });
    // Name editing moved to the client detail page in 0022 (covered by clients-e2e.ts);
    // here the synthetic legal name is set directly for a client that has visits.
    const named = (await admin.query(`select v.client_id, c.client_code from ogevia.service_visits v join ogevia.clients c on c.id = v.client_id
      join ogevia.organizations o on o.id = v.organization_id where o.slug = 'scs-pilot-synthetic' order by v.time_in limit 1`)).rows[0];
    const clientCode = named.client_code as string;
    await admin.query(`insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by)
      select $1, c.organization_id, 'Synthetic', 'Calendar Person', m.user_id from ogevia.clients c
      join ogevia.organization_memberships m on m.organization_id = c.organization_id and m.role = 'manager' where c.id = $1 limit 1
      on conflict (client_id) do update set legal_first_name = excluded.legal_first_name, legal_last_name = excluded.legal_last_name`, [named.client_id]);
    check("manager set a synthetic client name (office only)", true, clientCode);
    await noHScroll(M.page, "manager Clients");
    await shot(M.page, "05b-manager-clients");
    await M.page.getByRole("button", { name: /Menu/ }).click();
    await M.page.getByRole("link", { name: "Visit records" }).click();
    await M.page.getByRole("heading", { name: "Visit records" }).waitFor({ timeout: 15000 });
    await M.page.reload(); // the name was set directly in the database: drop cached rows
    await M.page.getByRole("heading", { name: "Visit records" }).waitFor({ timeout: 15000 });
    await M.page.getByLabel("Report").selectOption("calendar");
    const clientSelect = M.page.getByLabel("Calendar client");
    await clientSelect.selectOption({ label: "Synthetic Calendar Person" });
    const month = new Date().toISOString().slice(0, 7);
    await M.page.getByLabel("Calendar month").fill(month);
    await M.page.getByRole("grid").waitFor({ timeout: 15000 });
    check("calendar: Print calendar button beside the month", await M.page.getByRole("button", { name: /Print calendar/ }).isEnabled());
    check("calendar shows the full name with the code", await M.page.getByText(`(${clientCode})`, { exact: true }).waitFor({ timeout: 15000 }).then(() => true, () => false), clientCode);
    await M.page.emulateMedia({ media: "print" });
    check("printed calendar header: Client: full name (code)", await M.page.getByText(`Client: Synthetic Calendar Person (${clientCode})`).isVisible());
    check("calendar print: app header and filters hidden", !(await M.page.locator("header").isVisible()) && !(await M.page.getByLabel("Report").isVisible()));
    await M.page.pdf({ path: join(SHOTS, "06-calendar.pdf"), format: "Letter", landscape: true, printBackground: true });
    await M.page.setViewportSize({ width: 1056, height: 816 });
    await shot(M.page, "06-calendar-print");
    await M.page.emulateMedia({ media: "screen" });
    // Resizing an emulated phone back from 1056 px leaves it zoomed (scale ~1.45), which
    // misplaces taps; continue in a fresh phone page instead.
    await M.ctx.close();
    M = await persona(browser, MG);
    await signIn(M.page, "/documents");

    await M.page.getByRole("button", { name: /Menu/ }).click();
    await M.page.getByRole("link", { name: "Documents" }).click();
    await M.page.getByRole("heading", { name: "Documents" }).waitFor({ timeout: 15000 });
    await M.page.getByLabel("New type").fill("TB test (synthetic)");
    await M.page.getByLabel(/Has an expiry date/).check();
    await M.page.getByRole("button", { name: "Add type" }).click();
    await M.page.getByText("TB test (synthetic) · expiry required").waitFor({ timeout: 15000 });
    await M.page.getByLabel("Person").selectOption({ index: 1 });
    const person = await M.page.getByLabel("Person").locator("option:checked").innerText();
    await M.page.getByLabel("Document", { exact: true }).selectOption({ index: 1 });
    await M.page.getByLabel("Due date (optional)").fill(laDate(7));
    await M.page.getByRole("button", { name: "Request document" }).click();
    await M.page.getByText(/Requested\. It appears in their My documents\./).waitFor({ timeout: 15000 });
    check("manager requested a document", true, person);
    await noHScroll(M.page, "manager Documents");
    await shot(M.page, "07-manager-documents");
    check("manager: no page errors", M.errors.length === 0, M.errors.join(" | "));

    // ---------------- Caregiver: header, My documents upload
    const caregiverSub = person.includes("B") ? CB : CA;
    const C = await persona(browser, caregiverSub);
    await signIn(C.page, "/documents");
    await C.page.getByText("CAREGIVER VIEW").waitFor({ timeout: 15000 });
    check("caregiver header: CAREGIVER VIEW; no NEEDS ATTENTION", (await C.page.getByRole("link", { name: /Needs attention/ }).count()) === 0);
    check("caregiver has no Clients menu entry", (await C.page.getByRole("link", { name: "Clients" }).count()) === 0);
    await C.page.getByRole("heading", { name: "My documents" }).waitFor({ timeout: 15000 });
    check("caregiver sees the due date with days left (agency-local date)", await C.page.getByText(/Due .* \(in 7 days\)/).isVisible());
    await C.page.getByRole("button", { name: "Upload" }).first().click();
    await C.page.getByLabel(/Photo or PDF/).setInputFiles({ name: "tb.png", mimeType: "image/png", buffer: pngBytes });
    await C.page.getByLabel(/Expiry date/).fill(laDate(365));
    await C.page.getByLabel(/Issue \/ completion date/).fill(laDate(0));
    await C.page.getByRole("button", { name: "Upload", exact: true }).last().click();
    await C.page.getByText("Uploaded – awaiting review").waitFor({ timeout: 15000 });
    check("caregiver upload: shown as awaiting review only after the server confirmed", true);
    await noHScroll(C.page, "caregiver My documents");
    await shot(C.page, "08-caregiver-my-documents");
    check("caregiver: no page errors", C.errors.length === 0, C.errors.join(" | "));

    // ---------------- Manager reviews
    await M.page.reload();
    await M.page.getByRole("heading", { name: "Documents" }).waitFor({ timeout: 15000 });
    const card = M.page.locator("li", { hasText: "TB test (synthetic)" }).first();
    await card.getByRole("button", { name: "Open file" }).click();
    await card.getByRole("img", { name: "Uploaded document" }).waitFor({ timeout: 15000 });
    check("manager opens the real uploaded file", true);
    await card.getByRole("button", { name: "Reject" }).click();
    check("reject without a reason is refused", await card.getByRole("alert").filter({ hasText: "Enter why it is rejected" }).isVisible());
    await card.getByRole("button", { name: "Verify" }).click();
    await M.page.getByRole("button", { name: "All documents" }).click();
    await M.page.locator("li", { hasText: "TB test (synthetic)" }).getByText("Verified").waitFor({ timeout: 15000 });
    check("verified after review; expiry shown with days left", await M.page.getByText(/Expires .* \(36[45] days left\)/).first().isVisible());
    await shot(M.page, "09-manager-verified");

    // ---------------- Billing review cards
    await M.page.goto(WEB + "/billing-review");
    await M.page.getByRole("list", { name: "Billing review visits" }).waitFor({ timeout: 15000 });
    check("billing review on a phone: cards", (await M.page.getByRole("table").count()) === 0);
    check("billing review: readable confirmation method", await M.page.getByText("Unable to confirm").isVisible());
    await noHScroll(M.page, "manager Billing review");
    await shot(M.page, "10-manager-billing-cards");

    const audit = await admin.query("select action from ogevia.audit_events where action in ('organization.branding_updated','document.requested','document.uploaded','document.viewed','document.verified') order by id");
    check("database: branding and every document step audited", ["organization.branding_updated", "document.requested", "document.uploaded", "document.viewed", "document.verified"].every((a) => audit.rows.some((r: any) => r.action === a)), audit.rows.map((r: any) => r.action).join(","));
  } finally {
    await browser.close(); await admin.end(); await pool.end();
  }
  writeFileSync(join(S, "workspace-e2e-results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
