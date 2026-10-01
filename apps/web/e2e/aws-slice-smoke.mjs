// Run: build the AWS bundle (see docs/aws/PHASE_6_FRONTEND_AND_HOSTING.md), `npx vite preview --outDir <dist> --port 4173`,
// then `node apps/web/e2e/aws-slice-smoke.mjs` with Playwright available. Screenshots are written to the cwd.
// Real-Chromium smoke of the AWS build at phone width. Cognito and the API are
// faked with Playwright routes (synthetic tokens/data); the app code is the
// real production bundle.
import { chromium } from "playwright";
const BASE = "http://localhost:4173";
const COGNITO = "https://ogevia-test.auth.us-west-2.amazoncognito.com";
const API = "https://api.example.test";
const ISS = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TESTPOOL1";
const CLIENT = "testclient0000000000000000";
const SUB = "11111111-2222-4333-8444-555555555555";
const ORG = "aaaaaaaa-0000-4000-8000-000000000001", CL = "cccccccc-0000-4000-8000-000000000001", SV = "dddddddd-0000-4000-8000-000000000001", VI = "eeeeeeee-0000-4000-8000-000000000001";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (c) => `${b64({ alg: "RS256", kid: "k" })}.${b64(c)}.c2ln`;
const now = () => Math.floor(Date.now() / 1000);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const consoleLines = [];
const hosts = new Set();
page.on("request", (r) => hosts.add(new URL(r.url()).host));
page.on("console", (m) => consoleLines.push(m.text()));

let authorizeUrl = null, tokenBody = null, visit = null;
const apiCalls = [];
await page.route(`${COGNITO}/**`, async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/oauth2/authorize") {
    authorizeUrl = url;
    const cb = new URL(url.searchParams.get("redirect_uri"));
    cb.searchParams.set("code", "synthetic-code"); cb.searchParams.set("state", url.searchParams.get("state"));
    return route.fulfill({ status: 302, headers: { location: cb.toString() } });
  }
  if (url.pathname === "/oauth2/token") {
    tokenBody = new URLSearchParams(route.request().postData());
    const nonce = authorizeUrl.searchParams.get("nonce");
    return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": BASE }, body: JSON.stringify({
      access_token: jwt({ sub: SUB, iss: ISS, client_id: CLIENT, token_use: "access", scope: "openid email", exp: now() + 3600 }),
      id_token: jwt({ sub: SUB, iss: ISS, aud: CLIENT, token_use: "id", email: "caregiver.a1@example.test", email_verified: true, nonce, exp: now() + 3600 }),
      refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "Bearer" }) });
  }
  return route.fulfill({ status: 404, body: "" });
});
await page.route(`${API}/**`, async (route) => {
  const req = route.request();
  const cors = { "access-control-allow-origin": BASE, "access-control-allow-headers": "authorization,content-type,idempotency-key", "access-control-allow-methods": "GET,POST,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const url = new URL(req.url()); const key = `${req.method()} ${url.pathname}`;
  apiCalls.push({ key, headers: req.headers(), body: req.postData() });
  const j = (s, b) => route.fulfill({ status: s, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(b) });
  if (!req.headers().authorization?.startsWith("Bearer ")) return j(401, { error: { code: "unauthenticated", message: "no" } });
  switch (key) {
    case "GET /v1/me": return j(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "caregiver", permissions: [] }] });
    case "GET /v1/visits/active": return j(200, { visit });
    case "GET /v1/clients/assigned": return j(200, { clients: [{ clientId: CL, clientCode: "TEST-C01", nextScheduledStartsAt: null, nextScheduledEndsAt: null, activeServiceCount: 1 }] });
    case `GET /v1/clients/${CL}/services`: return j(200, { services: [{ serviceId: SV, serviceCode: "RSP", serviceName: "Respite (synthetic)", serviceColor: null, authorizationId: "f0000000-0000-4000-8000-000000000001", monthlyAuthorizedMinutes: 600, minutesUsedThisMonth: 0, minutesScheduledThisMonth: 0 }] });
    case "POST /v1/visits":
      visit = { visitId: VI, visitNumber: "V-1", clientCode: "TEST-C01", serviceCode: "RSP", serviceName: "Respite (synthetic)", scheduledStartsAt: null, scheduledEndsAt: null, timeIn: new Date(Date.now() - 65 * 60000).toISOString(), timeOut: null, workedMinutes: null, visitStatus: "draft", monthlyAuthorizedMinutes: 600, confirmedMinutesThisMonth: 0 };
      return j(201, { visitId: VI });
    case `POST /v1/visits/${VI}/end`:
      visit = { ...visit, timeOut: new Date().toISOString(), workedMinutes: 65, visitStatus: "awaiting_signature" };
      return j(200, { visit: { visitId: VI, workedMinutes: 65, timeIn: visit.timeIn, timeOut: visit.timeOut } });
    case `POST /v1/visits/${VI}/confirm`:
      visit = null;
      return j(200, { result: { visitId: VI, status: "signed", authorizationStatus: "within_authorization", workedMinutes: 65, billableMinutes: 65, monthToDateMinutes: 65, remainingMinutes: 535 } });
    default: return j(404, { error: { code: "not_found", message: "No such endpoint." } });
  }
});

await page.goto(`${BASE}/service-verification`);
await page.getByRole("button", { name: "Sign in" }).waitFor();
check("signed-out deep link lands on /login", page.url().endsWith("/login"));
const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
check("login page: no horizontal scroll at 390px", await noHScroll());
await page.screenshot({ path: "01-login.png" });

await page.getByRole("button", { name: "Sign in" }).click();
await page.getByLabel("Assigned client").waitFor({ timeout: 15000 });
const p = authorizeUrl.searchParams;
check("authorize: response_type=code", p.get("response_type") === "code");
check("authorize: PKCE S256 challenge", p.get("code_challenge_method") === "S256" && /^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge")));
check("authorize: state + nonce present", (p.get("state") ?? "").length >= 32 && (p.get("nonce") ?? "").length >= 32);
check("authorize: no secret or verifier in URL", !p.has("client_secret") && !p.has("code_verifier"));
check("token exchange sent the PKCE verifier, no secret", /^[A-Za-z0-9_-]{43,128}$/.test(tokenBody.get("code_verifier") ?? "") && !tokenBody.has("client_secret"));
check("callback returned to the original deep link", page.url().endsWith("/service-verification"));
check("code/state removed from the address bar", !page.url().includes("code="));
const storage = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), sessionValues: Object.values(sessionStorage).join(" ") }));
check("no tokens in localStorage", storage.local.every((k) => !/ogevia\.auth/.test(k)) && !JSON.stringify(storage.local).includes("eyJ"));
check("PKCE transaction consumed (single use)", !storage.session.includes("ogevia.auth.tx"));
check("access/ID tokens not in sessionStorage", !storage.sessionValues.includes("eyJ"));
check("caregiver screen: no horizontal scroll", await noHScroll());
await page.screenshot({ path: "02-select.png" });

await page.getByLabel("Assigned client").selectOption(CL);
await page.getByRole("button", { name: /Sign in now/ }).click();
await page.getByRole("button", { name: /Sign out now/ }).waitFor();
check("active visit screen: no horizontal scroll", await noHScroll());
await page.screenshot({ path: "03-active.png" });
await page.getByRole("button", { name: /Sign out now/ }).click();
const canvas = page.getByLabel("Client or guardian signature");
await canvas.waitFor();
await canvas.scrollIntoViewIfNeeded();
const box = await canvas.boundingBox();
// A real finger drag (touch events -> pointer events), as on a phone.
const cdp = await ctx.newCDPSession(page);
const pt = (i) => ({ x: box.x + 20 + i * 15, y: box.y + 30 + (i % 3) * 12 });
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt(0)] });
for (let i = 1; i < 14; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [pt(i)] });
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
const confirmBtn = page.getByRole("button", { name: /Confirm visit/ });
check("touch drawing enables Confirm", await confirmBtn.isEnabled());
check("Confirm button is fully visible at phone width", await confirmBtn.evaluate((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.right <= window.innerWidth && r.height >= 44; }));
check("confirmation screen: no horizontal scroll", await noHScroll());
await page.screenshot({ path: "04-confirm.png" });
await page.getByRole("button", { name: /Confirm visit/ }).click();
await page.waitForFunction(() => !document.body.innerText.includes("Client or guardian confirmation"), null, { timeout: 15000 });
await page.screenshot({ path: "05-submitted.png", fullPage: true });

const confirm = apiCalls.find((c) => c.key.endsWith("/confirm"));
const body = JSON.parse(confirm.body);
check("confirm carries a real PNG from the canvas", body.signaturePng.startsWith("data:image/png;base64,iVBOR") && body.signaturePng.length > 500);
check("confirm has an idempotency key", /^[0-9a-f-]{36}$/.test(confirm.headers["idempotency-key"] ?? ""));
check("every API call used a bearer token", apiCalls.every((c) => c.headers.authorization?.startsWith("Bearer ")));
check("no token/PNG in console output", !consoleLines.join("\n").match(/eyJ|iVBOR|synthetic-refresh/));
check("only app, Cognito and API hosts contacted (no Supabase)", [...hosts].every((h) => ["localhost:4173", "ogevia-test.auth.us-west-2.amazoncognito.com", "api.example.test"].includes(h)), [...hosts].join(","));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
