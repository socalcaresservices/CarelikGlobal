// Page heights (document scroll height, px) and the number of text characters shown without expanding, per screen, on the LOCAL harness (synthetic data), as
// Olivia Owner. Desktop 1360 px and EMULATED phone 390 px. node density-heights.mjs <out.json>
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright-core");
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const res = {};
for (const [vName, vOpts] of [["desktop-1360", { viewport: { width: 1360, height: 900 } }], ["phone-390-emulated", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }]]) {
  const ctx = await browser.newContext({ ...vOpts, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText("Olivia Owner", { exact: false }).first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  const hrefOf = async (list, sel) => { await page.goto("https://localhost" + list); await page.waitForLoadState("networkidle"); await page.waitForTimeout(600); return page.locator(sel).first().getAttribute("href"); };
  const client = await hrefOf("/clients", "a[href^='/clients/']");
  const cg = await page.evaluate(() => null) ?? null;
  await page.goto("https://localhost/care-team"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(600);
  const cgHref = await page.locator("a[href^='/care-team/CG'], a[href^='/care-team/']").evaluateAll((as) => as.map((a) => a.getAttribute("href")).find((h) => h && !/recruiting|services-review/.test(h)) ?? null);
  const routes = [["home", "/"], ["documents", "/documents"], ["action-needed", "/action-needed"], ["schedule", "/schedule"], ["clients", "/clients"], ["client-detail", client], ["care-team", "/care-team"], ["caregiver-detail", cgHref], ["recruiting", "/care-team/recruiting"], ["compliance", "/compliance"], ["reports", "/service-verification/reports"], ["reports-calendar", "/service-verification/reports?view=calendar"], ["reporting", "/reporting"], ["settings-appearance", "/settings/appearance"], ["settings-branding", "/settings/branding"], ["billing-review", "/billing-review"], ["authorization-impacts", "/authorization-impacts"], ["visit-review", "/visit-review"], ["shift-requests", "/schedule/shift-requests"], ["attention", "/attention"]];
  for (const [name, href] of routes) {
    if (!href) { res[`${vName}:${name}`] = null; continue; }
    await page.goto("https://localhost" + href); await page.waitForLoadState("networkidle"); await page.waitForTimeout(900);
    const m = await page.evaluate(() => {
      const main = document.querySelector("main") ?? document.body;
      const visibleText = [...main.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent.trim() && !e.closest("details:not([open]) > :not(summary)") && !e.closest("[role=tooltip]") && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().height > 0).map((e) => e.textContent.trim()).join(" ").length;
      return { height: document.documentElement.scrollHeight, mainHeight: Math.round(main.getBoundingClientRect().height), visibleChars: visibleText };
    });
    res[`${vName}:${name}`] = m;
  }
  await ctx.close();
}
await browser.close(); fs.writeFileSync(out, JSON.stringify(res, null, 1)); console.log("done", Object.keys(res).length);
