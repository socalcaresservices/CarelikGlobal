// Appearance matrix on the LOCAL harness (synthetic data only): Large text and Compact density, every background, both layouts, desktop 1360 and
// emulated phone 390 (viewport + touch + mobile user agent; NOT a real device). Checks per screen: no sideways scroll, text contrast, visible alerts,
// usable control sizes on touch, and that typed form input survives an appearance change made elsewhere.
//   node appearance-matrix.mjs <outdir> [screensCsv]
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright-core");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const SCREENS = (process.argv[3] ?? "/,/documents,/schedule,/settings/appearance,/clients,/care-team").split(",");
const FIXED = new Date("2026-10-19T15:00:00Z");
const BACKGROUNDS = [["light", "Light"], ["white", "White"], ["gray", "Soft gray"], ["dark", "Dark"]];
const LAYOUTS = [["standard", "Standard"], ["minimal", "Minimal"]];
const PROFILES = [["large-text", { textSize: "Large", density: "Comfortable" }], ["compact-density", { textSize: "Standard", density: "Compact" }]];
const VIEWPORTS = [["desktop", { viewport: { width: 1360, height: 900 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const results = [];
const slug = (s) => s.replace(/^\//, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "home";

async function login(page) {
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText("Olivia Owner", { exact: false }).first().click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
}
async function setAppearance(page, { background, layout, textSize, density }) {
  await page.goto("https://localhost/settings/appearance"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(600);
  const form = page.locator('form[aria-label="My view"]');
  for (const [legend, label] of [["Background", background], ["Layout", layout], ["Text size", textSize], ["Density", density]]) {
    await form.locator("fieldset", { has: page.locator("legend", { hasText: new RegExp(`^${legend}$`) }) }).locator("label").filter({ hasText: new RegExp(`^\\s*✓?\\s*${label}\\s*$`) }).first().click();
  }
  const save = form.getByRole("button", { name: "Save" });
  if (await save.isEnabled()) { await save.click(); await page.waitForTimeout(900); }
}
/** Runs in the page: text contrast (WCAG), visible alerts, touch-target sizes. */
const AUDIT = () => {
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat([1]);
  const bgOf = (el) => { const stack = []; for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; } } let acc = [255, 255, 255, 1]; for (const c of stack.reverse()) acc = over(c, acc); return acc; };
  const bad = []; let checked = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement; if (!el || seen.has(el) || !t.textContent.trim()) continue; seen.add(el);
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (cs.visibility === "hidden" || cs.display === "none" || r.width < 1 || r.height < 1 || el.closest("[aria-hidden='true'], .sr-only, script, style")) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el); const f = over(fg, bg);
    const [a, b] = [lum(f), lum(bg)]; const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const px = parseFloat(cs.fontSize); const largeText = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
    checked++;
    if (ratio < (largeText ? 3 : 4.5)) bad.push({ text: t.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, size: px });
  }
  const alerts = [...document.querySelectorAll("[role='alert'], [role='status']")].filter((e) => e.textContent.trim());
  const alertsHidden = alerts.filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width < 1 || r.height < 1 || s.visibility === "hidden"; }).length;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const smallEls = [...document.querySelectorAll("button, a[href], input:not([type=hidden]), select, summary, [role=button]")].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); if (r.width < 1 || r.height < 1 || cs.visibility === "hidden" || e.closest(".sr-only")) return false; return Math.min(r.width, r.height) < (coarse ? 24 : 20) || (coarse && r.height < 32 && r.width < 44); });
  const small = smallEls.length;
  const tinySample = smallEls.slice(0, 3).map((e) => { const r = e.getBoundingClientRect(); return `${e.tagName.toLowerCase()}[${(e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 30)}] ${Math.round(r.width)}x${Math.round(r.height)}`; });
  return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, checked, lowContrast: bad.length, lowContrastSample: bad.slice(0, 3), alerts: alerts.length, alertsHidden, tinyControls: small, tinySample, coarse,
    attrs: { bg: document.documentElement.getAttribute("data-og-bg"), layout: document.documentElement.getAttribute("data-og-layout"), density: document.documentElement.getAttribute("data-og-density"), text: document.documentElement.getAttribute("data-og-text") } };
};

for (const [vName, vOpts] of VIEWPORTS) {
  const ctx = await browser.newContext({ ...vOpts, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(FIXED);
  await login(page);
  for (const [pName, prof] of PROFILES) for (const [bg, bgLabel] of BACKGROUNDS) for (const [lay, layLabel] of LAYOUTS) {
    await setAppearance(page, { background: bgLabel, layout: layLabel, ...prof });
    for (const href of SCREENS) {
      await page.goto("https://localhost" + href); await page.waitForLoadState("networkidle"); await page.waitForTimeout(500);
      const a = await page.evaluate(AUDIT);
      const want = { bg, layout: lay, density: prof.density.toLowerCase(), text: prof.textSize.toLowerCase() };
      const applied = a.attrs.bg === want.bg && a.attrs.layout === want.layout && a.attrs.density === want.density && a.attrs.text === want.text;
      results.push({ viewport: vName, profile: pName, background: bg, layout: lay, screen: href, applied, ...a });
      if (bg === "white" && href === "/" ) await page.screenshot({ path: `${out}/${vName}-${pName}-${bg}-${lay}-${slug(href)}.png`, fullPage: false });
    }
  }
  // form input survives an appearance change made in another tab
  await setAppearance(page, { background: "White", layout: "Standard", textSize: "Standard", density: "Comfortable" });
  await page.goto("https://localhost/schedule"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Add shift" }).first().click(); await page.waitForTimeout(500);
  const field = page.locator("form input[type='date'], form textarea, form input[type='text']").first();
  let preserved = null, changed = null;
  if (await field.count()) {
    const target = (await field.getAttribute("type")) === "date" ? "2026-11-02" : "keep this text";
    await field.fill(target);
    const other = await ctx.newPage(); await other.clock.setFixedTime(FIXED); await login(other);
    await setAppearance(other, { background: "Dark", layout: "Minimal", textSize: "Large", density: "Compact" });
    await page.bringToFront(); await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); }); await page.waitForTimeout(2500);
    preserved = (await field.inputValue()) === target;
    changed = await page.evaluate(() => ({ bg: document.documentElement.getAttribute("data-og-bg"), layout: document.documentElement.getAttribute("data-og-layout"), text: document.documentElement.getAttribute("data-og-text"), density: document.documentElement.getAttribute("data-og-density") }));
    await other.close();
  }
  results.push({ viewport: vName, formPreserved: preserved, afterChange: changed });
  fs.writeFileSync(`${out}/matrix.json`, JSON.stringify(results, null, 1));
  await ctx.close();
}
await browser.close();
fs.writeFileSync(`${out}/matrix.json`, JSON.stringify(results, null, 1));
const rows = results.filter((r) => r.screen);
const sum = (k) => rows.reduce((n, r) => n + (r[k] ? 1 : 0), 0);
console.log(`settings applied on ${rows.filter((r) => r.applied).length} of ${rows.length}`);
console.log(`runs ${rows.length}; overflow ${sum("overflow")}; screens with low-contrast text ${sum("lowContrast")}; alerts hidden ${rows.filter((r) => r.alertsHidden).length}; tiny controls ${sum("tinyControls")}`);
console.log(JSON.stringify(results.filter((r) => !r.screen)));
