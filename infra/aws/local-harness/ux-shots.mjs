// Confirmation screenshots on the LOCAL harness (synthetic data), Olivia Owner (administrator): every main screen at desktop 1360 px and EMULATED phone
// 390 px (viewport, touch, mobile user agent; not a real device). Full-page and the first screen ("fold" = 1360x900 / 390x844). node ux-shots.mjs <outdir>
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright-core");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
for (const [vName, vOpts, phone] of [["desktop-1360", { viewport: { width: 1360, height: 900 } }, false], ["phone-390-emulated", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, true]]) {
  const ctx = await browser.newContext({ ...vOpts, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText("Olivia Owner", { exact: false }).first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  await page.goto("https://localhost/clients"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(500);
  const client = await page.locator("a[href^='/clients/']").first().getAttribute("href");
  await page.goto("https://localhost/care-team"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(500);
  const cg = await page.locator("a[href^='/care-team/']").evaluateAll((as) => as.map((a) => a.getAttribute("href")).find((h) => h && !/recruiting|services-review/.test(h)) ?? null);
  const routes = [["home", "/"], ["action-needed", "/action-needed"], ["schedule", "/schedule"], ["clients", "/clients"], ["client-detail", client], ["care-team", "/care-team"], ["caregiver-detail", cg], ["recruiting", "/care-team/recruiting"], ["documents", "/documents"], ["compliance", "/compliance"], ["reports", "/service-verification/reports"], ["reporting", "/reporting"], ["settings-appearance", "/settings/appearance"], ["settings-branding", "/settings/branding"], ["billing-review", "/billing-review"], ["authorization-impacts", "/authorization-impacts"]];
  for (const [name, href] of routes) {
    if (!href) continue;
    await page.goto("https://localhost" + href); await page.mouse.move(vOpts.viewport.width - 2, vOpts.viewport.height - 2); await page.waitForLoadState("networkidle"); await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/${vName}-${name}-full.png`, fullPage: true });
    await page.screenshot({ path: `${out}/${vName}-${name}-fold.png`, fullPage: false });
  }
  if (phone) { await page.goto("https://localhost/"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(600); const m = page.locator("button[aria-controls='aws-sidebar']").first(); if (await m.count()) { await m.click(); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/${vName}-menu-drawer.png` }); } }
  await ctx.close();
}
await browser.close(); console.log("done");
