// Run: build the AWS bundle with VITE_AUTH_PROVIDER=cognito (see aws-slice-smoke.mjs), `npx vite preview --outDir <dist> --port 4173`,
// then `node apps/web/e2e/readiness-mobile.mjs` with Playwright available. Screenshots are written to the cwd.
// Real-Chromium check of the caregiver readiness page (0086) at phone widths. Cognito and the API are faked with Playwright routes
// (synthetic tokens and data); the app code is the real production bundle. Checks: single column, no horizontal scroll, every
// control in the checklist at least 44px high, the disabled Approve button's reason visible, long names and values wrapping.
import { chromium } from "playwright";
const BASE = "http://localhost:4173";
const COGNITO = "https://ogevia-test.auth.us-west-2.amazoncognito.com";
const API = "https://api.example.test";
const ISS = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TESTPOOL1";
const CLIENT = "testclient0000000000000000";
const SUB = "11111111-2222-4333-8444-555555555555";
const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CG = "abababab-0000-4000-8000-000000000009";
const LONG_NAME = "Synthetic Maximiliano-Alexander Bartholomew-Featherstonehaugh";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (c) => `${b64({ alg: "RS256", kid: "k" })}.${b64(c)}.c2ln`;
const now = () => Math.floor(Date.now() / 1000);
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

const item = (requirement, label, kind, state, detail, more = {}) => ({ requirement, label, kind, state, detail, dueDate: null, metOn: null, actorName: null, blocksShifts: false, nextAction: "none", extra: {}, ...more });
const readiness = {
  caregiverRecordId: CG, caregiverCode: "CG-86D99C21", status: "not_ready", approved: false, approvedAt: null, approvedByName: null, approvalSource: null, met: 2, total: 5,
  waitingOn: ["App sign-in"], canApprove: false, hireDate: "2026-10-01", graceDays: 30, cprTbDueDate: "2026-10-31", enforcementActive: false,
  items: [
    item("background", "Background check", "hard", "met", "Verified", { metOn: "2026-10-30", actorName: "ogeviamanager", nextAction: "view" }),
    item("training", "Required training", "hard", "met", "Done", { metOn: "2026-10-18", nextAction: "reopen", extra: { requirementId: "r1" } }),
    item("signin", "App sign-in", "hard", "unmet", "No email on file", { nextAction: "add_contact" }),
    item("cpr", "CPR certificate", "flexible", "pending", "Not uploaded", { dueDate: "2026-10-31", nextAction: "upload" }),
    item("tb", "TB clearance", "flexible", "overdue", "Not uploaded", { dueDate: "2026-10-20", nextAction: "upload", blocksShifts: true }),
  ],
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
for (const [width, role] of [[390, "organization_owner"], [320, "manager"]]) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  let authorizeUrl = null;
  await page.route(`${COGNITO}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/oauth2/authorize") {
      authorizeUrl = url;
      const cb = new URL(url.searchParams.get("redirect_uri"));
      cb.searchParams.set("code", "synthetic-code"); cb.searchParams.set("state", url.searchParams.get("state"));
      return route.fulfill({ status: 302, headers: { location: cb.toString() } });
    }
    if (url.pathname === "/oauth2/token") {
      const nonce = authorizeUrl.searchParams.get("nonce");
      return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": BASE }, body: JSON.stringify({
        access_token: jwt({ sub: SUB, iss: ISS, client_id: CLIENT, token_use: "access", scope: "openid email", exp: now() + 3600 }),
        id_token: jwt({ sub: SUB, iss: ISS, aud: CLIENT, token_use: "id", email: "manager@example.test", email_verified: true, nonce, exp: now() + 3600 }),
        refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "Bearer" }) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  const permissions = ["caregivers.manage", "visits.read", "visits.manage", "documents.read", "readiness.read", ...(role === "organization_owner" ? ["caregivers.compliance.manage"] : [])];
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": BASE, "access-control-allow-headers": "authorization,content-type,idempotency-key", "access-control-allow-methods": "GET,POST,OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url()); const key = `${req.method()} ${url.pathname}`;
    const j = (s, b) => route.fulfill({ status: s, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(b) });
    switch (key) {
      case "GET /v1/me": return j(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions }], profile: { displayName: "Synthetic Manager" } });
      case "GET /v1/branding": return j(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention": return j(200, { summary: null });
      case "GET /v1/caregivers": return j(200, { caregivers: [{ caregiverRecordId: CG, caregiverCode: "CG-86D99C21", firstName: "Synthetic", lastName: LONG_NAME, preferredName: null, status: "onboarding", workStatus: "not_ready", readinessMet: 2, readinessTotal: 5, signedIn: false, hasContact: false, hasSignIn: false, signInStatus: null, activeAssignments: 0, openVisits: 0 }] });
      case `GET /v1/caregivers/${CG}/readiness`: return j(200, { readiness });
      case "GET /v1/assignments": return j(200, { assignments: [] });
      case "GET /v1/documents": return j(200, { documents: [] });
      default: return j(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  await page.goto(`${BASE}/care-team/${CG}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  const list = page.getByTestId("readiness-checklist");
  await list.waitFor({ timeout: 20000 });
  check(`${width}px ${role}: checklist renders ("2 of 5 done", Not ready)`, /2 of 5 done/.test(await list.innerText()) && /Not ready/.test(await list.innerText()));
  check(`${width}px ${role}: no horizontal scroll`, await noHScroll());
  const rows = await list.locator("li[data-requirement]").evaluateAll((els) => els.map((e) => e.getAttribute("data-requirement")));
  check(`${width}px ${role}: five requirements then Approve for work, one column`, JSON.stringify(rows) === JSON.stringify(["background", "training", "signin", "cpr", "tb", "approve"]));
  const boxes = await list.locator("ul li").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; }));
  check(`${width}px ${role}: rows stack in one column (same left edge and width)`, boxes.every((b) => b.x === boxes[0].x && Math.abs(b.w - boxes[0].w) <= 1));
  const small = await list.locator("button, a").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => `${e.textContent?.trim()} (${Math.round(e.getBoundingClientRect().height)}px)`));
  check(`${width}px ${role}: every checklist control is at least 44px high`, small.length === 0, small.join("; "));
  const approve = list.getByRole("button", { name: "Approve" });
  check(`${width}px ${role}: Approve is disabled and the reason is on screen`, (await approve.isDisabled()) && (await list.getByText("Waiting on: App sign-in").isVisible()));
  const heading = page.getByRole("heading", { level: 1 });
  const hb = await heading.boundingBox();
  check(`${width}px ${role}: a very long name wraps inside the screen`, !!hb && hb.x >= 0 && hb.x + hb.width <= width + 1, JSON.stringify(hb));
  await list.getByRole("button", { name: "Add email" }).click();
  check(`${width}px ${role}: Add email opens an inline form with a labelled field`, await list.getByLabel("Caregiver's own email").isVisible());
  check(`${width}px ${role}: still no horizontal scroll with the form open`, await noHScroll());
  if (role === "organization_owner") {
    await list.locator('li[data-requirement="tb"]').getByRole("button", { name: "Extend" }).click();
    check(`${width}px ${role}: Extend form is visible and fits`, (await list.getByLabel("New due date").isVisible()) && (await noHScroll()));
    check(`${width}px ${role}: overdue TB states what it blocks`, await list.getByText("Blocks new shift assignments").isVisible());
  } else {
    check(`${width}px ${role}: Extend is not offered to a manager`, (await list.getByRole("button", { name: "Extend" }).count()) === 0);
  }
  await page.screenshot({ path: `readiness-${width}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
