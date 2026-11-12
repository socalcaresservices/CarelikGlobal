// PREVIEW ONLY. Records the API responses of the LOCAL HARNESS (synthetic data) while a browser walks the screens, for preview/replay.ts.
//   (harness running: pnpm --filter @carelik/infra-aws harness:setup, harness:seed-today, harness:build, harness:serve)
//   NODE_PATH=$(npm root -g) node preview/record.cjs preview-dist/recording.json
// Add the screens of a milestone to SCENARIOS. It never touches a real environment: it refuses any address other than https://localhost.
const { chromium } = require("playwright");
const fs = require("node:fs");
const BASE = process.env.HARNESS_URL || "https://localhost";
if (new URL(BASE).hostname !== "localhost") { console.error("Refusing: the recorder only talks to the local harness."); process.exit(1); }
const out = process.argv[2] || "preview-dist/recording.json";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const canon = (u) => { const q = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&"); return u.pathname.replace(/^\/api/, "") + (q ? `?${q}` : ""); };

const ADMIN_ROUTES = ["/", "/action-needed", "/attention", "/clients", "/care-team", "/care-team/recruiting", "/care-team/services-review", "/staff", "/settings/staff-types", "/settings/roles", "/accounts",
  "/schedule", "/schedule?view=calendar", "/schedule/shift-requests", "/staffing", "/continuity", "/outage-visits", "/visit-review", "/service-verification/reports", "/service-verification/reports?view=overview",
  "/service-verification/reports?view=exceptions", "/reporting", "/billing-review", "/authorization-impacts", "/authorizations/rates", "/compliance", "/settings/services", "/settings/appearance",
  "/settings/branding", "/settings/billing-rounding", "/settings/visit-rules", "/profile", "/documents"];
const CAREGIVER_ROUTES = ["/", "/my-shifts", "/service-verification", "/availability", "/documents", "/profile"];

async function record(browser, name, viewport, routes, flow) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport, hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
  const page = await ctx.newPage();
  const rec = { me: null, exact: {}, byPath: {}, runningVisit: null, awaitingVisit: null };
  page.on("response", async (r) => {
    const u = new URL(r.url()); if (!u.pathname.startsWith("/api/v1")) return;
    const method = r.request().method(); let body = null; try { body = await r.json(); } catch { /* not JSON */ }
    const entry = { status: r.status(), body };
    const path = u.pathname.replace(/^\/api/, "");
    if (path === "/v1/me") rec.me = body;
    if (path === "/v1/visits/active" && body && body.visit) { if (body.visit.timeOut == null) rec.runningVisit = body; else rec.awaitingVisit = body; }
    rec.exact[`${method} ${canon(u)}`] = entry;
    rec.byPath[`${method} ${path.replace(UUID, ":id")}`] = entry;
  });
  await page.goto(BASE + "/"); await page.getByRole("button", { name: "Sign in" }).click(); await page.getByText(name, { exact: true }).click(); await page.waitForTimeout(2500);
  for (const route of routes) { await page.goto(BASE + route); await page.waitForTimeout(1700); }
  // The first client and caregiver pages (their ids differ per run).
  if (name === "Olivia Owner") for (const base of ["/clients", "/care-team"]) {
    await page.goto(BASE + base); await page.waitForTimeout(1500);
    const href = await page.locator(`a[href^="${base}/"]`).first().getAttribute("href").catch(() => null);
    if (href) { await page.goto(BASE + href); await page.waitForTimeout(1700); }
  }
  if (name === "Olivia Owner") {
    // A caregiver approved by override (Casey), her profile, and the Add shift panel (loads what the form needs).
    await page.goto(BASE + "/care-team"); await page.waitForTimeout(1500);
    const casey = await page.locator('a[href^="/care-team/"]', { hasText: "Casey" }).first().getAttribute("href").catch(() => null);
    if (casey) { await page.goto(BASE + casey); await page.waitForTimeout(2200); }
    await page.goto(BASE + "/schedule"); await page.waitForTimeout(2200);
    await page.getByRole("button", { name: "Add shift" }).click().catch(() => {}); await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Repeating" }).click().catch(() => {}); await page.waitForTimeout(1200);
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
  }
  if (flow) await flow(page, rec);
  await ctx.close();
  return rec;
}

// Caregiver: today's visit, Start, End, sign, Confirm (the steps of infra/aws/local-harness/workflows.mjs W5).
async function caregiverFlow(page) {
  await page.goto(BASE + "/service-verification"); await page.waitForTimeout(2200);
  await page.getByRole("button", { name: /Start visit/ }).click(); await page.waitForTimeout(2000);
  await page.reload(); await page.waitForTimeout(2200);                       // records GET /v1/visits/active while the visit runs
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(61000);                                            // the server requires at least one minute before End
  await page.getByRole("button", { name: /End visit/ }).first().click(); await page.waitForTimeout(2500);
  const canvas = page.locator("canvas").first(); await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + 80, box.y + 70, { steps: 6 }); await page.mouse.move(box.x + 140, box.y + 30, { steps: 6 }); await page.mouse.up();
  await page.getByRole("checkbox", { name: /I attest/ }).check();
  await page.getByRole("button", { name: /Confirm visit/ }).click(); await page.waitForTimeout(2500);
}

(async () => {
  const browser = await chromium.launch();
  const owner = await record(browser, "Olivia Owner", { width: 1360, height: 900 }, ADMIN_ROUTES, null);
  const caregiver = await record(browser, "Alex Caregiver", { width: 390, height: 844 }, CAREGIVER_ROUTES, caregiverFlow);
  await browser.close();
  fs.mkdirSync(require("node:path").dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ recordedAt: new Date().toISOString(), personas: { owner, caregiver } }));
  console.log(`recorded ${Object.keys(owner.exact).length} owner and ${Object.keys(caregiver.exact).length} caregiver responses -> ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
