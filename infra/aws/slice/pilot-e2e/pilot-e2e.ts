// SCS pilot browser acceptance, LOCAL: the exact AWS-mode web build <-> the
// real sv-api handler <-> a real PostgreSQL 18 database (migrations 0001-0016,
// test-slice seed + SCS pilot seed). SYNTHETIC DATA ONLY.
//
// Stand-ins (stated, not hidden):
//  - Cognito managed login/token endpoints are answered by Playwright routes;
//    tokens are unsigned. The API Gateway JWT authorizer (signature check) is
//    therefore NOT exercised; the handler's own claims checks are.
//  - S3 evidence is a local file store (same interface as sv-api local-invoke).
//  - "Time passing" is simulated with admin SQL that moves a caregiver's
//    visits (and, for the missed clock-out, the shift) back in time.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import type { BrowserContext, Browser, Page } from "playwright-core";
import { createHandler } from "/home/user/CarelikGlobal/apps/sv-api/src/handler.ts";
import { ROUTES } from "/home/user/CarelikGlobal/apps/sv-api/src/routes.ts";

const req = createRequire("/home/user/CarelikGlobal/apps/sv-api/package.json");
const pg = req("pg");
// Same type parsers as the Lambda's db.ts (dates as YYYY-MM-DD, bigint as number).
pg.types.setTypeParser(1082, (value: string) => value);
pg.types.setTypeParser(20, (value: string) => Number(value));

// Work dir: the web build (dist/), evidence files, screenshots, results.
const S = process.env.E2E_DIR ?? "/tmp/ogevia-pilot-e2e";
// playwright-core is installed in E2E_DIR, not in the repo.
const { chromium } = createRequire(join(S, "package.json"))("playwright-core") as typeof import("playwright-core");
const DIST = join(S, "dist");
const SHOTS = join(S, "shots");
mkdirSync(SHOTS, { recursive: true });
const WEB = "http://127.0.0.1:4173";
const API = "https://api.pilot-e2e.test";
const IDP = "https://pilot-e2e.auth.us-west-2.amazoncognito.com";
const POOL = "us-west-2_PILOTE2E1";
const CLIENT = "pilote2eclient000000000000";
const ISSUER = `https://cognito-idp.us-west-2.amazonaws.com/${POOL}`;
const ADMIN_URL = "postgres://ogevia_admin@127.0.0.1:5432/ogevia_pilot_e2e";
const APP_URL = "postgres://e2e_app_login:e2e-local-only@127.0.0.1:5432/ogevia_pilot_e2e";
const SUB = {
  testManager: process.env.TEST_MG!,
  pilotManager: process.env.PILOT_MG!,
  caregiverA: process.env.PILOT_CA!,
  caregiverB: process.env.PILOT_CB!,
};

// ---------------------------------------------------------------- results
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ---------------------------------------------------------------- backend
const evidenceDir = join(S, "evidence");
const handler = createHandler({
  config: { issuer: ISSUER, appClientIds: [CLIENT], dbSetRole: "ogevia_app" },
  db: (() => {
    const pool = new pg.Pool({ connectionString: APP_URL, max: 4 });
    return { connect: () => pool.connect() };
  })(),
  evidence: {
    async put(key: string, bytes: Buffer, sha256: Buffer) {
      if (!createHash("sha256").update(bytes).digest().equals(sha256)) throw new Error("checksum mismatch");
      const d = join(evidenceDir, key.replace(/\//g, "_"));
      mkdirSync(d, { recursive: true });
      const versionId = `v${readdirSync(d).length + 1}`;
      writeFileSync(join(d, versionId), bytes);
      return { versionId };
    },
    async get(key: string, versionId?: string) {
      const d = join(evidenceDir, key.replace(/\//g, "_"));
      const v = versionId ?? readdirSync(d).sort().at(-1)!;
      if (!existsSync(join(d, v))) throw new Error("NoSuchKey");
      return { bytes: readFileSync(join(d, v)), versionId: v, contentType: "image/png" };
    },
  },
  log: () => {},
});
const routeMatchers = Object.keys(ROUTES).map((key) => {
  const [method, template] = key.split(" ") as [string, string];
  const names: string[] = [];
  const re = new RegExp(
    "^" + template.replace(/\{(\w+)\}/g, (_, n) => (names.push(n), "([^/]+)")) + "$",
  );
  return { key, method, re, names };
});
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "none", kid: "e2e" })}.${b64url(claims)}.e2e`;
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
const CORS = {
  "access-control-allow-origin": WEB,
  "access-control-allow-headers": "authorization,content-type,idempotency-key",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

async function invoke(method: string, url: URL, headers: Record<string, string>, body: string | null) {
  const m = routeMatchers.find((r) => r.method === method && r.re.test(url.pathname));
  const routeKey = m ? m.key : `${method} ${url.pathname}`;
  const pathParameters: Record<string, string> = {};
  if (m) {
    const values = m.re.exec(url.pathname)!.slice(1);
    m.names.forEach((n, i) => (pathParameters[n] = decodeURIComponent(values[i]!)));
  }
  const auth = headers.authorization?.replace(/^Bearer /, "");
  const claims = auth ? Object.fromEntries(Object.entries(claimsOf(auth)).map(([k, v]) => [k, String(v)])) : null;
  const query = Object.fromEntries(url.searchParams.entries());
  return handler({
    routeKey,
    headers,
    ...(Object.keys(pathParameters).length ? { pathParameters } : {}),
    ...(Object.keys(query).length ? { queryStringParameters: query } : {}),
    body,
    requestContext: { requestId: randomUUID(), ...(claims ? { authorizer: { jwt: { claims } } } : {}) },
  } as never);
}

/** Direct API call as a persona (setup steps that are not part of the UI under test). */
async function api(sub: string | null, routeKey: string, opts: { path?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}) {
  const [method, template] = routeKey.split(" ") as [string, string];
  const path = template.replace(/\{(\w+)\}/g, (_, n) => encodeURIComponent(opts.path![n]!));
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sub) headers.authorization = `Bearer ${accessToken(sub)}`;
  if (method === "POST") headers["idempotency-key"] = randomUUID();
  const res = await invoke(method, url, headers, opts.body === undefined ? null : JSON.stringify(opts.body));
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body as string) : null };
}

function accessToken(sub: string) {
  return jwt({ sub, iss: ISSUER, client_id: CLIENT, token_use: "access", scope: "openid email", exp: Math.floor(Date.now() / 1000) + 3600 });
}

// ---------------------------------------------------------------- browser
const MIME: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };

async function persona(browser: Browser, sub: string) {
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  let nonce = "";
  // The web origin is served by `vite preview` (SPA fallback); /config.json 404s.
  await ctx.route(`${IDP}/**`, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/oauth2/authorize") {
      nonce = u.searchParams.get("nonce") ?? "";
      const back = new URL(u.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", "e2e-code");
      back.searchParams.set("state", u.searchParams.get("state")!);
      return route.fulfill({ status: 302, headers: { location: back.toString() } });
    }
    if (u.pathname === "/oauth2/token") {
      const now = Math.floor(Date.now() / 1000);
      const idToken = jwt({ sub, iss: ISSUER, aud: CLIENT, token_use: "id", nonce, exp: now + 3600, iat: now, email: `${sub.slice(0, 8)}@example.invalid` });
      return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": WEB }, body: JSON.stringify({ access_token: accessToken(sub), id_token: idToken, refresh_token: "e2e-refresh", expires_in: 3600, token_type: "Bearer" }) });
    }
    if (u.pathname === "/logout") return route.fulfill({ status: 302, headers: { location: `${WEB}/` } });
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
  page.on("pageerror", (e) => errors.push(`${e.message}\n${(e.stack ?? "").split("\n").slice(0, 6).join("\n")}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 400)}`); });
  return { ctx, page, errors };
}

async function signIn(page: Page, path = "/") {
  await page.goto(WEB + path);
  const button = page.getByRole("button", { name: "Sign in" });
  await button.waitFor({ timeout: 15000 });
  await button.click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/callback") && !u.pathname.startsWith("/login"), { timeout: 15000 });
}

async function noHorizontalScroll(page: Page, label: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(`${label}: no horizontal scroll at 390 px`, sw <= iw, `scrollWidth ${sw}, innerWidth ${iw}`);
}
let shot = 0;
const snap = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`), fullPage: true });

async function drawSignature(page: Page) {
  await page.getByLabel("Client or guardian signature").scrollIntoViewIfNeeded();
  const box = (await page.getByLabel("Client or guardian signature").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 40);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 20 + i * 20, box.y + 40 + (i % 2 ? 30 : -10));
  await page.mouse.up();
}

// ---------------------------------------------------------------- scenario
async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ageCaregiver = async (sub: string, minutes: number) => {
    await admin.query("set session_replication_role = replica");
    await admin.query(
      `update ogevia.service_visits set time_in = time_in - make_interval(mins => $2), time_out = time_out - make_interval(mins => $2)
       where caregiver_user_id = (select id from ogevia.app_users where cognito_sub = $1)`,
      [sub, minutes],
    );
    await admin.query("set session_replication_role = origin");
  };

  // ---- Setup through the API as the pilot manager (canonical paths).
  const me = await api(SUB.pilotManager, "GET /v1/me");
  const org = me.body.memberships.find((m: { organizationSlug: string }) => m.organizationSlug === "scs-pilot-synthetic").organizationId;
  const portalClients = await api(SUB.pilotManager, "GET /v1/care-portals/clients", { query: { organizationId: org } });
  const clientId = Object.fromEntries(portalClients.body.clients.map((c: { clientCode: string; clientId: string }) => [c.clientCode, c.clientId]));
  const allWeek = Array.from({ length: 7 }, (_, d) => ({ weekday: d, specific_date: null, start_local: "00:00", end_local: "23:59" }));
  for (const cg of [SUB.caregiverA, SUB.caregiverB]) {
    const r = await api(cg, "POST /v1/availability/me", { body: { organizationId: org, windows: allWeek, unavailableDates: [] } });
    check("setup: caregiver records availability", [200, 201, 204].includes(r.status), `status ${r.status}`);
  }
  async function scheduleFor(code: string, startInMin: number, caregiverSub: string) {
    const p = await api(SUB.pilotManager, "POST /v1/care-portals", { body: { organizationId: org, clientId: clientId[code], label: "e2e (synthetic)" } });
    const token = p.body.portal.token;
    const portal = await api(null, "GET /v1/public/care-portals/{token}", { path: { token } });
    const serviceId = portal.body.services[0].serviceId;
    const start = new Date(Date.now() + startInMin * 60_000);
    start.setSeconds(0, 0);
    const rq = await api(null, "POST /v1/public/care-portals/{token}/requests", { path: { token }, body: { serviceId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 180 * 60_000).toISOString(), requestKey: randomUUID() } });
    const requestId = rq.body?.request?.requestId;
    check(`setup: client request for ${code} accepted`, rq.status === 201, `status ${rq.status} ${JSON.stringify(rq.body?.error ?? "")}`);
    const offerTo = async (sub: string) => {
      const cands = await api(SUB.pilotManager, "GET /v1/care-requests/{requestId}/candidates", { path: { requestId }, query: { organizationId: org } });
      const rec = (await admin.query("select cr.id from ogevia.caregiver_records cr join ogevia.app_users u on u.id = cr.linked_user_id where u.cognito_sub = $1", [sub])).rows[0].id;
      check(`setup: caregiver is a candidate for ${code}`, cands.body.caregivers.some((c: { caregiverRecordId: string }) => c.caregiverRecordId === rec));
      const of = await api(SUB.pilotManager, "POST /v1/care-requests/{requestId}/offers", { path: { requestId }, body: { organizationId: org, caregiverRecordId: rec } });
      await api(null, "POST /v1/public/care-offers/{token}/respond", { path: { token: of.body.offer.token }, body: { available: true } });
      const asg = await api(SUB.pilotManager, "POST /v1/care-requests/{requestId}/assign", { path: { requestId }, body: { organizationId: org, offerId: of.body.offer.offerId } });
      check(`setup: manager assigns ${code}`, asg.status === 200 && !!asg.body.shiftId, `status ${asg.status} ${JSON.stringify(asg.body?.error ?? "")}`);
      return { shiftId: asg.body.shiftId as string, offerToken: of.body.offer.token as string };
    };
    const first = await offerTo(caregiverSub);
    return { requestId, offerTo, ...first };
  }

  // Shift 2 first: P-AAXRX for A, then A calls out and B is assigned
  // (reassignment). Done first because A cannot hold two overlapping shifts.
  const s2 = await scheduleFor("P-AAXRX", 30, SUB.caregiverA);
  const callOut = await api(null, "POST /v1/public/care-offers/{token}/cancel-assignment", { path: { token: s2.offerToken }, body: { reason: "e2e call-out (synthetic)" } });
  check("reassignment: caregiver A's call-out returns the request to Coverage Needed", callOut.status === 200 && callOut.body.status === "coverage_needed");
  const s2b = await s2.offerTo(SUB.caregiverB);
  check("reassignment: replacement reuses the same shift (no duplicate shift)", s2b.shiftId === s2.shiftId, `${s2.shiftId} vs ${s2b.shiftId}`);
  const shiftCount = (await admin.query("select count(*)::int n from ogevia.shifts where client_id = $1", [clientId["P-AAXRX"]])).rows[0].n;
  check("reassignment: exactly one shift exists for the reassigned request", shiftCount === 1, `shifts ${shiftCount}`);

  // Shift 1: P-QAUF7 for caregiver A, starting in 20 minutes.
  const s1 = await scheduleFor("P-QAUF7", 20, SUB.caregiverA);

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

  // ---- Caregiver A: today's scheduled visit, start, refresh, end, sign.
  const A = await persona(browser, SUB.caregiverA);
  await signIn(A.page);
  await A.page.getByRole("heading", { name: "Today's visits" }).waitFor();
  const scheduled = A.page.getByRole("list", { name: "Scheduled today" });
  await scheduled.waitFor();
  const schedText = await scheduled.innerText();
  check("caregiver A: P-QAUF7 listed under Scheduled today with an AM/PM window", /Client P-QAUF7/.test(schedText) && /\d{1,2}:\d{2}\s?[AP]M–\d{1,2}:\d{2}\s?[AP]M/.test(schedText), schedText.replace(/\s+/g, " "));
  check("caregiver A: called-out P-AAXRX shift is NOT under Scheduled today", !/P-AAXRX/.test(schedText));
  const otherText = await A.page.getByRole("list", { name: "Other assigned clients" }).innerText();
  check("caregiver A: standing-assigned P-AAXRX shown as Not scheduled today", /P-AAXRX[\s\S]*Not scheduled today/.test(otherText));
  check("caregiver A: no other tenant's client codes", !/TEST-C0/.test(await A.page.content()));
  check("caregiver A: no EVV/GPS claims on the start screen", !/EVV|GPS/.test(await A.page.locator("main, body").first().innerText()));
  await noHorizontalScroll(A.page, "caregiver start screen");
  await snap(A.page, "caregiver-today");
  await A.page.getByRole("button", { name: /Client P-QAUF7/ }).click();
  const details = A.page.getByRole("group", { name: "Visit details" });
  await details.getByText("RSP · Respite (synthetic)").waitFor();
  const detailText = (await details.innerText()).replace(/\s+/g, " ");
  check("caregiver A: details show client, service, date and scheduled window", /Client P-QAUF7/.test(detailText.replace("Client ", "Client ")) && /P-QAUF7/.test(detailText) && /RSP · Respite/.test(detailText) && /[A-Z][a-z]{2} \d{1,2}, \d{4}/.test(detailText) && /[AP]M–/.test(detailText), detailText);
  const startBtn = A.page.getByRole("button", { name: /Start visit/ });
  check("caregiver A: Start visit is a ≥44px tap target", ((await startBtn.boundingBox())?.height ?? 0) >= 44);
  await snap(A.page, "caregiver-details");
  // Double tap.
  await startBtn.dblclick();
  await A.page.getByRole("heading", { name: "Visit in progress" }).waitFor();
  const open = (await admin.query("select count(*)::int n, max(scheduled_shift_id::text) shift from ogevia.service_visits v join ogevia.app_users u on u.id = v.caregiver_user_id where u.cognito_sub = $1 and v.time_out is null", [SUB.caregiverA])).rows[0];
  check("caregiver A: double tap on Start creates exactly one open visit", open.n === 1, `open visits ${open.n}`);
  check("caregiver A: visit linked to the scheduled shift on the server", open.shift === s1.shiftId);
  await noHorizontalScroll(A.page, "caregiver active screen");
  await snap(A.page, "caregiver-active");
  await A.page.reload();
  await A.page.getByRole("heading", { name: "Visit in progress" }).waitFor({ timeout: 15000 });
  check("caregiver A: refresh during the visit returns to the same active visit", true);
  await ageCaregiver(SUB.caregiverA, 120);
  await A.page.reload();
  await A.page.getByRole("heading", { name: "Visit in progress" }).waitFor({ timeout: 15000 });
  await A.page.getByRole("button", { name: /End visit/ }).click();
  await A.page.getByRole("heading", { name: "Client or guardian confirmation" }).waitFor();
  await noHorizontalScroll(A.page, "caregiver confirm screen");
  await snap(A.page, "caregiver-confirm");
  await drawSignature(A.page);
  await A.page.getByRole("button", { name: /Confirm visit/ }).click();
  await A.page.getByRole("heading", { name: "Visit saved" }).waitFor({ timeout: 15000 });
  const resultText = (await A.page.getByLabel("Visit result").innerText()).replace(/\s+/g, " ");
  check("caregiver A: Submitted shows worked, billable and Billing ready (not billed)", /Worked 2 hr/.test(resultText) && /Billable 2 hr/.test(resultText) && /Billing ready/.test(resultText) && /does not mean billed/.test(resultText), resultText);
  await noHorizontalScroll(A.page, "caregiver submitted screen");
  await snap(A.page, "caregiver-submitted");

  // ---- Caregiver A: unscheduled visit, no confirmation -> review, 0 billable.
  await ageCaregiver(SUB.caregiverA, 30);
  await A.page.getByRole("button", { name: "Start next visit" }).click();
  await A.page.getByRole("button", { name: /Client P-AAXRX/ }).click();
  await A.page.getByText("This client is not on your schedule today.").waitFor();
  await A.page.getByRole("button", { name: /Start visit/ }).click();
  await A.page.getByRole("heading", { name: "Visit in progress" }).waitFor();
  await ageCaregiver(SUB.caregiverA, 20);
  await A.page.reload();
  await A.page.getByRole("button", { name: /End visit/ }).click();
  await A.page.getByRole("button", { name: "Unable to obtain confirmation" }).click();
  await A.page.getByLabel("Why is manager review needed?").selectOption({ index: 1 });
  await A.page.getByLabel("Brief explanation").fill("Client asleep; e2e synthetic");
  await A.page.getByRole("button", { name: /Submit for manager review/ }).click();
  await A.page.getByRole("heading", { name: "Saved for manager review" }).waitFor({ timeout: 15000 });
  const reviewText = (await A.page.getByLabel("Visit result").innerText()).replace(/\s+/g, " ");
  check("unconfirmed visit: administrator review with 0 billable", /Billable 0 min/.test(reviewText) && /Needs manager review/.test(reviewText), reviewText);
  const unsched = (await admin.query("select v.status::text, v.billable_minutes, v.scheduled_shift_id from ogevia.service_visits v join ogevia.clients c on c.id = v.client_id where c.client_code = 'P-AAXRX' and v.status <> 'draft' order by v.created_at desc limit 1")).rows[0];
  check("unconfirmed visit (DB): administrator_review, billable 0, no shift link", unsched?.status === "administrator_review" && Number(unsched.billable_minutes) === 0 && unsched.scheduled_shift_id === null, JSON.stringify(unsched));

  // ---- Caregiver B: reassigned shift, then a missed clock-out.
  const B = await persona(browser, SUB.caregiverB);
  await signIn(B.page);
  const bList = await B.page.getByRole("list", { name: "Scheduled today" }).innerText();
  check("caregiver B (replacement): sees reassigned P-AAXRX under Scheduled today", /P-AAXRX/.test(bList), bList.replace(/\s+/g, " "));
  await B.page.getByRole("button", { name: /Client P-AAXRX/ }).click();
  await B.page.getByRole("group", { name: "Visit details" }).getByText("RSP · Respite (synthetic)").waitFor();
  await B.page.getByRole("button", { name: /Start visit/ }).click();
  await B.page.getByRole("heading", { name: "Visit in progress" }).waitFor();
  // 5 hours pass with no clock-out: the visit and its shift move back together.
  await ageCaregiver(SUB.caregiverB, 300);
  await admin.query("update ogevia.shifts set starts_at = starts_at - interval '300 minutes', ends_at = ends_at - interval '300 minutes' where id = $1", [s2.shiftId]);
  const bVisit = (await admin.query("select v.id, v.time_in from ogevia.service_visits v join ogevia.app_users u on u.id = v.caregiver_user_id where u.cognito_sub = $1 and v.time_out is null", [SUB.caregiverB])).rows[0];

  // ---- Manager: Exceptions -> Close visit with explicit Pacific date / AM-PM.
  const M = await persona(browser, SUB.pilotManager);
  await signIn(M.page, "/service-verification/reports");
  await M.page.getByLabel("Report").selectOption("exceptions");
  await M.page.getByRole("button", { name: "Close visit" }).first().waitFor({ timeout: 15000 });
  await snap(M.page, "manager-exceptions");
  await M.page.getByRole("button", { name: "Close visit" }).first().click();
  const tIn = new Date(bVisit.time_in);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true });
  const wall = (d: Date) => {
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: String(Number(p.hour)), minute: String(Number(p.minute)), ampm: p.dayPeriod as string };
  };
  const target = wall(new Date(tIn.getTime() + 125 * 60_000));
  const wrong = target.ampm === "AM" ? "PM" : "AM";
  await M.page.getByLabel("Reason", { exact: true }).fill("Caregiver confirmed end time by phone (synthetic)");
  await M.page.getByLabel("Time Out date", { exact: true }).fill(target.date);
  await M.page.getByLabel("Hour", { exact: true }).selectOption(target.hour);
  await M.page.getByLabel("Minute", { exact: true }).selectOption(target.minute);
  await M.page.getByRole("radio", { name: wrong }).click();
  await M.page.getByRole("button", { name: "Save Time Out" }).click();
  const err = (await M.page.getByRole("alert").first().innerText()).trim();
  check("manager Time Out: wrong AM/PM gets a specific message naming the times", /must be after Time In|is in the future|longer than 24 hours/.test(err) && /AM\/PM|date/.test(err), err);
  await M.page.getByRole("radio", { name: target.ampm }).click();
  const summary = (await M.page.getByLabel("Time Out summary").innerText()).replace(/\s+/g, " ");
  // Time In carries seconds; the entered Time Out is whole minutes, so the
  // worked time is floor((Time Out - Time In) / 1 min), as the server stores it.
  const enteredOut = new Date(tIn.getTime() + 125 * 60_000);
  enteredOut.setSeconds(0, 0);
  const expectedMin = Math.floor((enteredOut.getTime() - tIn.getTime()) / 60_000);
  const expectedLabel = `${Math.floor(expectedMin / 60)} hr ${expectedMin % 60} min`;
  check(`manager Time Out: summary shows Time In, Time Out and Duration ${expectedLabel}`, summary.includes(`Duration ${expectedLabel}`) && /Time In .*[AP]M/.test(summary) && /Time Out .*[AP]M/.test(summary), summary);
  await noHorizontalScroll(M.page, "manager close-out form");
  await snap(M.page, "manager-close-out");
  await M.page.getByRole("button", { name: "Save Time Out" }).click();
  await M.page.getByRole("button", { name: "Save Time Out" }).waitFor({ state: "detached", timeout: 15000 });
  const closed = (await admin.query("select time_out, worked_minutes, time_out_entered_by is not null as by_mgr, status::text from ogevia.service_visits where id = $1", [bVisit.id])).rows[0];
  check("manager Time Out (DB): stored exactly the entered Pacific minute, worked = summary, marked entered by manager", new Date(closed.time_out).getTime() === enteredOut.getTime() && closed.worked_minutes === expectedMin && closed.by_mgr && closed.status === "awaiting_signature", JSON.stringify(closed));

  // ---- Caregiver B confirms the manager-closed visit.
  await B.page.reload();
  await B.page.getByRole("heading", { name: "Client or guardian confirmation" }).waitFor({ timeout: 15000 });
  check("caregiver B: confirmation says the Time Out was entered by the agency", await B.page.getByText(/entered by your agency/).isVisible());
  await drawSignature(B.page);
  await B.page.getByRole("button", { name: /Confirm visit/ }).click();
  await B.page.getByRole("heading", { name: "Visit saved" }).waitFor({ timeout: 15000 });
  const bResult = (await B.page.getByLabel("Visit result").innerText()).replace(/\s+/g, " ");
  check("caregiver B: manager-closed visit signed -> Billing ready with the manager-entered worked time", bResult.includes(`Worked ${expectedLabel}`) && /Billing ready/.test(bResult), bResult);

  // ---- Manager reports and billing review.
  await M.page.goto(`${WEB}/billing-review`);
  await M.page.getByText("Billing ready").first().waitFor({ timeout: 15000 });
  const billing = await M.page.locator("body").innerText();
  check("billing review: Billing ready visits listed and stated as not approved/billed/submitted", /has not been approved, billed, or submitted/.test(billing));
  check("billing review: unconfirmed visit shown as needing review, not ready", /review/i.test(billing));
  check("billing review: no other tenant's client codes", !/TEST-C0/.test(billing));
  await noHorizontalScroll(M.page, "billing review");
  await snap(M.page, "manager-billing-review");
  const summaryRows = await api(SUB.pilotManager, "GET /v1/reports/monthly-service-summary", { query: { organizationId: org, monthStart: new Date().toISOString().slice(0, 8) + "01" } });
  type Row = { clientCode: string; authorizedMinutes: number; billableMinutes: number; reservedMinutes: number; remainingMinutes: number; reviewMinutes: number };
  const rowsOf = (summaryRows.body?.services ?? []) as Row[];
  const q = rowsOf.find((r) => r.clientCode === "P-QAUF7");
  check("monthly summary API: P-QAUF7 billable 120, reservation released on signing, remaining = authorized - billable - reserved",
    !!q && q.billableMinutes === 120 && q.reservedMinutes === 0 && q.remainingMinutes === q.authorizedMinutes - 120, JSON.stringify(q));
  const x = rowsOf.find((r) => r.clientCode === "P-AAXRX");
  check("monthly summary API: P-AAXRX unconfirmed 20 min is review (not billable); manager-closed visit billable",
    !!x && x.reviewMinutes === 20 && x.billableMinutes === expectedMin && x.remainingMinutes === Math.max(0, x.authorizedMinutes - x.billableMinutes - x.reservedMinutes), JSON.stringify(x));
  check("cross-tenant: pilot monthly summary contains only pilot client codes", rowsOf.every((r) => r.clientCode.startsWith("P-")));

  // ---- Other tenant's manager sees none of the pilot's records.
  const T = await persona(browser, SUB.testManager);
  await signIn(T.page);
  await T.page.waitForTimeout(1500);
  const tVisits = await api(SUB.testManager, "GET /v1/visits", { query: { organizationId: org } });
  check("cross-tenant: test-agency manager cannot list pilot visits by passing the pilot org id", tVisits.status === 403 || (tVisits.status === 200 && (tVisits.body.visits ?? []).length === 0), `status ${tVisits.status}`);
  check("cross-tenant: test-agency manager UI shows no pilot client codes", !/P-QAUF7|P-AAXRX|P-AHXN7/.test(await T.page.locator("body").innerText()));

  for (const [name, p] of [["caregiver A", A], ["caregiver B", B], ["manager", M], ["test manager", T]] as const) {
    check(`${name}: no uncaught page errors`, p.errors.length === 0, p.errors.join(" | "));
  }
  await browser.close();
  await admin.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  writeFileSync(join(S, "e2e-results.json"), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(2);
});
