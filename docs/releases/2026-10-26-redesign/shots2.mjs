// Redesign evidence on the LOCAL harness (synthetic data), as Olivia Owner. Desktop 1360; EMULATED phone 390 (viewport, touch, mobile UA; not a real device).
//   node shots2.mjs <outdir> [extraScreens=0]
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/opt/node-tools/");
const { chromium } = require("playwright");
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox", "--ignore-certificate-errors"] });
const D = [["dashboard", "/"], ["reports", "/service-verification/reports?view=overview"], ["staff", "/staff"], ["roles-permissions", "/settings/roles"]];
const M = [["reports", "/service-verification/reports?view=overview"], ["staff", "/staff"], ["roles-permissions", "/settings/roles"]];
for (const [vName, vOpts, phone] of [["desktop", { viewport: { width: 1360, height: 900 } }, false], ["mobile", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" }, true]]) {
  const ctx = await browser.newContext({ ...vOpts, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText("Olivia Owner", { exact: false }).first().click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(900);
  for (const [name, href] of phone ? M : D) {
    await page.goto("https://localhost" + href); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${vName}-${name}.png`, fullPage: true });
  }
  await page.goto("https://localhost/"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(700);
  if (!phone) {
    for (let i = 0; i < 8; i++) { const c = page.locator("[data-nav-level='section'][aria-expanded='false']").first(); if (!(await c.count())) break; await c.click(); await page.waitForTimeout(150); }
    await page.screenshot({ path: `${out}/${vName}-navigation-all-open.png`, fullPage: false });
  } else {
    const menu = page.locator("button[aria-controls='aws-sidebar']").first();
    await menu.click(); await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${vName}-navigation-drawer.png`, fullPage: false });
  }
  await ctx.close();
}
await browser.close(); console.log("done");
