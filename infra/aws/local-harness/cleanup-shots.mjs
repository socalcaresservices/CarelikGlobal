// Before/after screenshots for the TEST-findings cleanup on the LOCAL harness (synthetic data, real clock), Olivia Owner (administrator),
// the account's default appearance (Light, Standard, Comfortable). Desktop 1360 px and EMULATED phone 390 px (viewport, touch and mobile user agent; not a real device).
//   node cleanup-shots.mjs <outdir>
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright-core");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const FIXED = new Date("2026-10-19T15:00:00Z");
const SCREENS = [["home", "/"], ["documents", "/documents"], ["action-needed", "/action-needed"], ["schedule", "/schedule"], ["clients", "/clients"], ["care-team", "/care-team"]];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
for (const [vName, vOpts, phone] of [["desktop-1360", { viewport: { width: 1360, height: 900 } }, false], ["phone-390-emulated", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, true]]) {
  const ctx = await browser.newContext({ ...vOpts, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText("Olivia Owner", { exact: false }).first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  for (const [name, href] of SCREENS) {
    await page.goto("https://localhost" + href); await page.waitForLoadState("networkidle"); await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/${vName}-${name}.png`, fullPage: true });
  }
  // a client page (first client in the list)
  await page.goto("https://localhost/clients"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(600);
  const href = await page.locator("a[href^='/clients/']").first().getAttribute("href");
  if (href) { await page.goto("https://localhost" + href); await page.waitForLoadState("networkidle"); await page.waitForTimeout(900); await page.screenshot({ path: `${out}/${vName}-client-detail.png`, fullPage: true }); }
  if (phone) {
    await page.goto("https://localhost/"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(600);
    const menu = page.locator("button[aria-controls='aws-sidebar']").first();
    if (await menu.count()) { await menu.click(); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/${vName}-menu-drawer.png`, fullPage: false }); }
  }
  await ctx.close();
}
await browser.close(); console.log("done");
