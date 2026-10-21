// Final screenshots on the LOCAL harness (synthetic data, fixed clock 2026-10-19T15:00Z): White + Standard and White + Minimal, Home, Documents,
// Scheduling and Appearance, desktop 1360 px and EMULATED phone 390 px (viewport, touch and mobile user agent; not a real device).
//   node final-shots.mjs <outdir> [href=/settings/appearance paths csv]
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright-core");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const SCREENS = [["home", "/"], ["documents", "/documents"], ["scheduling", "/schedule"], ["appearance", "/settings/appearance"]];
const FIXED = new Date("2026-10-19T15:00:00Z");
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
for (const [vName, vOpts] of [["desktop-1360", { viewport: { width: 1360, height: 900 } }], ["phone-390-emulated", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
  const ctx = await browser.newContext({ ...vOpts, ignoreHTTPSErrors: true });
  const page = await ctx.newPage(); await page.clock.setFixedTime(FIXED);
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText("Olivia Owner", { exact: false }).first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  for (const layout of ["Standard", "Minimal"]) {
    await page.goto("https://localhost/settings/appearance"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(500);
    const form = page.locator('form[aria-label="My view"]');
    for (const [legend, label] of [["Background", "White"], ["Layout", layout], ["Text size", "Standard"], ["Density", "Comfortable"]]) {
      await form.locator("fieldset", { has: page.locator("legend", { hasText: new RegExp(`^${legend}$`) }) }).locator("label").filter({ hasText: new RegExp(`^\\s*✓?\\s*${label}\\s*$`) }).first().click();
    }
    const save = form.getByRole("button", { name: "Save" }); if (await save.isEnabled()) { await save.click(); await page.waitForTimeout(900); }
    for (const [name, href] of SCREENS) {
      await page.goto("https://localhost" + href); await page.waitForLoadState("networkidle"); await page.waitForTimeout(900);
      await page.screenshot({ path: `${out}/${vName}-white-${layout.toLowerCase()}-${name}.png`, fullPage: true });
    }
  }
  await ctx.close();
}
await browser.close();
console.log("done");
