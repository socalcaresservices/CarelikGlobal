// Switching background or layout loses nothing. Run against the LOCAL harness (synthetic data); needs playwright-core and a Chromium:
//   node switch-check.mjs <outdir> <caregiverRecordId> [chromium-path]
// For each page, at desktop and phone width, it records a baseline (Light + Standard) and then applies each of the 8 background x layout
// combinations through the one mutation point the app uses (the data-og-* attributes on <html>), comparing after every switch:
//   1 text      every word on the page, including text inside closed details
//   2 controls  every link, button, field and summary, by kind and name, and its state
//   3 alerts    every alert, status, tile and badge with its words, and its status symbols
//   4 visible   everything visible in the baseline is still visible (not display:none, hidden, transparent, zero-sized)
//   5 emphasis  a red or amber element keeps its border and fill
//   6 contrast  no visible text below 4.5:1 (3:1 for large text), and no sideways scrolling
//   7 input     typed, unsaved text keeps its value, its focus and its very element (documents page)
import { chromium } from "playwright-core";
import fs from "node:fs";
const [out, cgId, exe] = process.argv.slice(2);
const PAGES = [["home", "/"], ["attention", "/attention"], ["staffing", "/staffing"], ["documents", "/documents"], ["visit-review", "/visit-review"], ["rates", "/authorizations/rates"], ["appearance", "/settings/appearance"], ["holds", "/compliance"], ["care-team", "/care-team"], ["caregiver-detail", `/care-team/${cgId}`], ["schedule", "/schedule"]];
const COMBOS = [["light", "standard"], ["white", "standard"], ["gray", "standard"], ["dark", "standard"], ["light", "minimal"], ["white", "minimal"], ["gray", "minimal"], ["dark", "minimal"]];
const browser = await chromium.launch({ executablePath: exe ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });

const probe = () => {
  const norm = (t) => (t ?? "").replace(/\s+/g, " ").trim();
  const root = document.querySelector("#root") ?? document.body;
  const controlsEls = [...root.querySelectorAll("a[href], button, input, select, textarea, summary")];
  const key = (e) => [e.tagName.toLowerCase(), e.getAttribute("type") ?? "", norm(e.getAttribute("aria-label") ?? e.textContent) || e.id || e.getAttribute("name") || "", e.getAttribute("href") ?? "", e.disabled ? "disabled" : "", e.getAttribute("aria-pressed") ?? ""].join("|");
  const vis = (e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false; const srOnly = cs.position === "absolute" && r.width <= 1 && r.height <= 1; return srOnly || (r.width > 0 && r.height > 0); };
  const textEls = [...root.querySelectorAll("*")].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && norm(n.textContent)) && !e.closest("details:not([open]) > :not(summary)") && !e.closest("script,style"));
  const alertEls = [...root.querySelectorAll('[role="alert"], [role="status"], [data-testid^="stream-"], [data-testid="attention-badge"], [data-testid="compliance-strip"], [data-testid="missing-rate-message"]')];
  const emph = [...root.querySelectorAll('[class*="border-red"], [class*="border-amber"], [class*="bg-red-"], [class*="bg-amber-"]')].filter((e) => !e.closest("details:not([open]) > :not(summary)")).map((e) => { const cs = getComputedStyle(e); return { k: norm(e.textContent).slice(0, 50), border: parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0, fill: cs.backgroundColor !== "rgba(0, 0, 0, 0)" }; });
  // contrast
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { chain.push(c); if (c.a === 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; const bb = parse(getComputedStyle(document.body).backgroundColor); if (bb && bb.a === 1) base = bb; for (const c of chain.reverse()) base = over(c, base); return base; };
  const low = [];
  for (const el of textEls) { if (el.closest(":disabled") || !vis(el)) continue; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue; const bg = bgOf(el); const fg0 = parse(cs.color); if (!fg0) continue; const fg = over(fg0, bg); const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05); const px = parseFloat(cs.fontSize); const large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight) >= 700); if (ratio < (large ? 3 : 4.5)) low.push(`${el.tagName.toLowerCase()}:${norm(el.textContent).slice(0, 30)}:${ratio.toFixed(2)}`); }
  return {
    text: norm(root.textContent),
    controls: controlsEls.map(key),
    alerts: alertEls.map((e) => `${e.getAttribute("role") ?? e.getAttribute("data-testid")}|${norm(e.textContent)}`),
    marks: [...root.querySelectorAll("[aria-hidden='true']")].map((e) => norm(e.textContent)).filter(Boolean),
    visible: Object.fromEntries([...new Set([...controlsEls.map((e) => "c:" + key(e)), ...textEls.map((e) => "t:" + norm([...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ")).slice(0, 60))])].map((k) => [k, 0])),
    visibleCount: { controls: controlsEls.filter(vis).length, text: textEls.filter(vis).length },
    hiddenKeys: [...controlsEls.filter((e) => !vis(e)).map((e) => "c:" + key(e)), ...textEls.filter((e) => !vis(e)).map((e) => "t:" + norm([...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ")).slice(0, 60))],
    emph, low, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
};
const apply = (c) => document.documentElement.setAttribute("data-og-bg", c[0]) || document.documentElement.setAttribute("data-og-layout", c[1]);

const results = []; let failures = 0;
const record = (page, width, name, ok, detail = "") => { results.push({ page, width, name, ok, detail }); if (!ok) { failures++; console.log(`FAIL ${width} ${page}: ${name} ${detail}`); } };
for (const [label, vp] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText("Owner", { exact: false }).first().click();
  await page.waitForLoadState("networkidle");
  for (const [name, path] of PAGES) {
    await page.goto(`https://localhost${path}`); await page.waitForLoadState("networkidle"); await page.waitForTimeout(400);
    await page.evaluate(() => { document.documentElement.setAttribute("data-og-bg", "light"); document.documentElement.setAttribute("data-og-layout", "standard"); });
    const base = await page.evaluate(probe);
    const baseHidden = new Set(base.hiddenKeys);
    for (const combo of COMBOS) {
      await page.evaluate((c) => { document.documentElement.setAttribute("data-og-bg", c[0]); document.documentElement.setAttribute("data-og-layout", c[1]); }, combo);
      await page.waitForTimeout(350); // buttons carry a 150 ms colour transition: measure after it settles
      const now = await page.evaluate(probe);
      const tag = combo.join("/");
      record(name, label, `${tag} text`, now.text === base.text);
      record(name, label, `${tag} controls`, JSON.stringify(now.controls) === JSON.stringify(base.controls));
      record(name, label, `${tag} alerts and symbols`, JSON.stringify(now.alerts) === JSON.stringify(base.alerts) && JSON.stringify(now.marks) === JSON.stringify(base.marks));
      const newlyHidden = now.hiddenKeys.filter((k) => !baseHidden.has(k));
      record(name, label, `${tag} nothing newly hidden`, newlyHidden.length === 0 && now.visibleCount.controls === base.visibleCount.controls && now.visibleCount.text === base.visibleCount.text, newlyHidden.slice(0, 3).join(" ; "));
      const lost = base.emph.filter((e, i) => (e.border && !now.emph[i]?.border) || (e.fill && !now.emph[i]?.fill));
      record(name, label, `${tag} alert emphasis kept`, now.emph.length === base.emph.length && lost.length === 0, lost.map((e) => e.k).slice(0, 2).join(" ; "));
      record(name, label, `${tag} contrast and no sideways scroll`, now.low.length === 0 && !now.overflow, now.low.slice(0, 3).join(" ; "));
    }
  }
  // unsaved input survives every switch, on the very same elements
  await page.goto("https://localhost/documents"); await page.waitForLoadState("networkidle"); await page.waitForSelector("li p.font-semibold");
  const reason = page.getByLabel(/Reason \(required to reject\)/).first();
  await reason.fill("The scan is cut off at the right edge"); await page.getByLabel(/Due date \(optional\)/).first().evaluate((e) => { e.value = ""; }).catch(() => {});
  await page.evaluate(() => { const r = document.querySelector('input[maxlength="1000"]'); r.__mark = "same-element"; r.focus(); const d = document.querySelector('input[type="date"]'); d.__mark = "same-date"; });
  for (const combo of COMBOS) {
    await page.evaluate((c) => { document.documentElement.setAttribute("data-og-bg", c[0]); document.documentElement.setAttribute("data-og-layout", c[1]); }, combo);
    const s = await page.evaluate(() => { const r = document.querySelector('input[maxlength="1000"]'); return { v: r.value, mark: r.__mark, focus: document.activeElement === r, dmark: document.querySelector('input[type="date"]').__mark }; });
    record("documents", label, `${combo.join("/")} unsaved input kept (value, focus, same element)`, s.v === "The scan is cut off at the right edge" && s.mark === "same-element" && s.focus && s.dmark === "same-date");
  }
  await ctx.close();
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(`${out}/switch-check.json`, JSON.stringify({ total: results.length, failures, results }, null, 1));
console.log(`${results.length - failures}/${results.length} checks pass, ${failures} fail`);
await browser.close();
