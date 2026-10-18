// Walks every screen reachable from the navigation for each persona and saves full-page screenshots (LOCAL harness, synthetic data only).
//   node screens.mjs <outdir>            persona list and viewports are fixed below
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/opt/node-tools/");
const { chromium } = require("playwright-core");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const PERSONAS = [["owner", "Olivia Owner"], ["manager", "Morgan Manager"], ["scheduler", "Sam Scheduler"], ["alex", "Alex Caregiver"], ["blair", "Blair Caregiver"]];
const VIEWPORTS = [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]];
const only = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const slug = (s) => s.replace(/^\//, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "home";
const report = [];
for (const [key, name] of PERSONAS) {
  if (only && !only.has(key)) continue;
  for (const [vpName, vp] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.goto("https://localhost/");
    await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
    await page.getByText(name, { exact: false }).first().click();
    await page.waitForLoadState("networkidle"); await page.waitForTimeout(900);
    // links from the navigation (on a phone the menu may be collapsed: open it if there is a menu button)
    const menu = page.getByRole("button", { name: /menu/i }).first();
    if (vpName === "phone" && (await menu.count())) { await menu.click().catch(() => {}); await page.waitForTimeout(300); }
    const links = await page.evaluate(() => [...document.querySelectorAll("nav a[href], aside a[href]")].map((a) => a.getAttribute("href")).filter((h) => h && h.startsWith("/") && !h.startsWith("//")));
    const targets = [...new Set(["/", ...links])];
    for (const href of targets) {
      await page.goto("https://localhost" + href); await page.waitForLoadState("networkidle"); await page.waitForTimeout(700);
      const file = `${key}-${vpName}-${slug(href)}.png`;
      await page.screenshot({ path: `${out}/${file}`, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      report.push({ persona: key, viewport: vpName, href, file, overflow, height: h });
      // first detail link in the main list, once per persona/viewport/path
      const detail = await page.evaluate((cur) => { const a = [...document.querySelectorAll("main a[href]")].map((x) => x.getAttribute("href")).find((h) => h && h.startsWith(cur === "/" ? "/zzz" : cur + "/") && h.length > cur.length + 1); return a || null; }, href.split("?")[0]);
      if (detail) {
        await page.goto("https://localhost" + detail); await page.waitForLoadState("networkidle"); await page.waitForTimeout(700);
        const f2 = `${key}-${vpName}-${slug(detail)}.png`;
        await page.screenshot({ path: `${out}/${f2}`, fullPage: true });
        report.push({ persona: key, viewport: vpName, href: detail, file: f2, overflow: await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), height: await page.evaluate(() => document.documentElement.scrollHeight) });
      }
    }
    await ctx.close();
  }
}
fs.writeFileSync(`${out}/index.json`, JSON.stringify(report, null, 1));
console.log(`${report.length} screenshots; sideways overflow on: ${report.filter((r) => r.overflow).map((r) => r.persona + "/" + r.viewport + r.href).join(", ") || "none"}`);
await browser.close();
