// R13 evidence on the LOCAL harness (synthetic data): at EMULATED 390 px with touch, for the office screens, (1) horizontal overflow and (2) visible controls shorter than 44 px.
// Inline links inside a sentence are exempt (WCAG 2.5.8). node touch-targets.mjs <out.json> [persona]   (harness running at https://localhost)
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright-core");
const out = process.argv[2];
const persona = process.argv[3] || "Olivia Owner";
const ROUTES = ["/", "/action-needed", "/clients", "/care-team", "/care-team/recruiting", "/staff", "/settings/staff-types", "/settings/roles", "/documents", "/schedule", "/schedule/shift-requests",
  "/service-verification/reports?view=overview", "/service-verification/reports?view=exceptions", "/reporting", "/billing-review", "/accounts", "/settings/branding", "/settings/services", "/continuity", "/profile"];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto("https://localhost/");
await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
await page.getByText(persona, { exact: false }).first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
const res = {};
for (const href of ROUTES) {
  await page.goto("https://localhost" + href); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1200);
  res[href] = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !e.closest("[aria-hidden=true]") && !e.closest(".sr-only") && !e.closest("details:not([open]) > :not(summary)"); };
    const sel = "button, a[href], select, summary, [role=button], input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea";
    const small = [...document.querySelectorAll(sel)].filter(vis).filter((e) => {
      const r = e.getBoundingClientRect();
      if (e.tagName === "A" && getComputedStyle(e).display === "inline") return false;   // inline link inside a sentence
      return r.height < 43.5;
    }).map((e) => `${e.tagName.toLowerCase()}|${Math.round(e.getBoundingClientRect().height)}|${(e.getAttribute("aria-label") || e.textContent || e.getAttribute("type") || "").trim().replace(/\s+/g, " ").slice(0, 28)}`);
    return { overflow: document.documentElement.scrollWidth > window.innerWidth + 1, scrollWidth: document.documentElement.scrollWidth, smallCount: small.length, small: small.slice(0, 12) };
  });
}
fs.writeFileSync(out, JSON.stringify(res, null, 1));
const bad = Object.entries(res).filter(([, v]) => v.overflow || v.smallCount > 0);
console.log(`screens: ${ROUTES.length}  with overflow: ${Object.values(res).filter((v) => v.overflow).length}  with small targets: ${bad.filter(([, v]) => v.smallCount).length}  total small: ${Object.values(res).reduce((n, v) => n + v.smallCount, 0)}`);
for (const [h, v] of bad) console.log(h, v.overflow ? "OVERFLOW" : "", v.smallCount, v.small.slice(0, 4).join("  ;  "));
await browser.close();
