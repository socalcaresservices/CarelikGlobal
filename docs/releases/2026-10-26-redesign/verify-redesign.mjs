// Real-browser checks of the redesign on the LOCAL harness (synthetic data). Prints PASS/FAIL lines; exit 1 if any FAIL.
import { createRequire } from "node:module";
const { chromium } = createRequire("/opt/node-tools/")("playwright");
const browser = await chromium.launch({ args: ["--no-sandbox", "--ignore-certificate-errors"] });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`); if (!ok) failed++; };
async function signIn(ctx, person) {
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText(person, { exact: false }).first().click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  return page;
}
const go = async (page, path) => { await page.goto("https://localhost" + path); await page.waitForLoadState("networkidle"); await page.waitForTimeout(700); };
const sidebar = (page) => page.getByRole("navigation", { name: "Main" });
const openAll = async (page) => { for (let i = 0; i < 8; i++) { const c = page.locator("[data-nav-level='section'][aria-expanded='false']").first(); if (!(await c.count())) break; await c.click(); } };
const linkTexts = async (page) => (await sidebar(page).getByRole("link").allTextContents()).map((s) => s.replace(/\d+$/, "").replace("•", "").trim());

const desktop = await browser.newContext({ viewport: { width: 1360, height: 900 }, ignoreHTTPSErrors: true });
const owner = await signIn(desktop, "Olivia Owner");
await openAll(owner);
check("owner sidebar", JSON.stringify(await linkTexts(owner)) === JSON.stringify(["Dashboard", "Clients", "Authorization changes", "Caregivers", "Staff", "Staff Types", "Schedule", "Reports", "Billing", "Roles & Permissions", "Agency Settings"]), (await linkTexts(owner)).join(" | "));

// every sidebar link and every tab opens a page that is not the fallback error, and exactly one sidebar item is current
const hrefs = new Set();
for (const start of ["/", "/clients", "/staff", "/schedule", "/service-verification/reports?view=overview", "/settings/roles"]) {
  await go(owner, start);
  for (const a of await owner.locator("nav[aria-label='Main'] a, nav[aria-label='Section tabs'] a").all()) hrefs.add(await a.getAttribute("href"));
}
let reachable = 0, broken = [];
for (const h of hrefs) {
  await go(owner, h);
  const h1 = await owner.locator("h1").first().textContent().catch(() => null);
  const err = await owner.getByText(/could not be loaded|Something went wrong/i).count();
  const current = await owner.locator("nav[aria-label='Main'] a[aria-current='page']").count();
  if (h1 && !err && current <= 1) reachable++; else broken.push(`${h} h1=${h1} err=${err} current=${current}`);
}
check(`every destination (${hrefs.size}) opens a page with a title, no error, at most one current sidebar item`, broken.length === 0, broken.join("; "));

// active group opens by itself and keeps manual state
await go(owner, "/clients");
const expanded = async (name) => owner.getByRole("button", { name: new RegExp("^" + name) }).getAttribute("aria-expanded");
check("current group (Clients) is open on its page", (await expanded("Clients")) === "true");
await owner.getByRole("button", { name: /^Scheduling/ }).click();
await sidebar(owner).getByRole("link", { name: "Authorization changes" }).click(); await owner.waitForTimeout(600);
check("a group opened by hand stays open while moving between pages", (await expanded("Scheduling")) === "true" && (await expanded("Clients")) === "true");

// help: mouse hover, keyboard, Escape, touch
await go(owner, "/clients");
const tipButton = owner.getByRole("button", { name: "About Clients" });
await tipButton.hover(); await owner.waitForTimeout(250);
check("help opens on hover", await owner.getByRole("tooltip").filter({ hasText: "Manage client profiles and care information." }).isVisible());
await owner.mouse.move(700, 600); await owner.waitForTimeout(250);
check("help closes when the pointer leaves", !(await owner.getByRole("tooltip").filter({ hasText: "Manage client profiles and care information." }).isVisible()));
await tipButton.focus(); await owner.waitForTimeout(250);
check("help opens on keyboard focus", await owner.getByRole("tooltip").filter({ hasText: "Manage client profiles and care information." }).isVisible());
await owner.keyboard.press("Enter"); await owner.keyboard.press("Escape"); await owner.mouse.move(700, 600); await owner.waitForTimeout(250);
check("Escape dismisses help", (await tipButton.getAttribute("aria-expanded")) === "false");

// Staff: search, filters, numbering
await go(owner, "/staff");
const rows = async () => owner.locator("table[aria-label='Staff'] tbody tr th[scope='row']").allTextContents();
const total = (await rows()).length;
await owner.getByLabel("Search").fill("sam"); await owner.waitForTimeout(300);
const found = await rows();
check("staff search narrows the list", found.length === 1 && /Sam Scheduler/.test(found[0]), found.join(","));
check("numbering follows the filter", (await owner.locator("[data-testid='row-no']").allTextContents()).join() === "1");
await owner.getByRole("button", { name: "Clear Filters" }).click(); await owner.waitForTimeout(300);
check("Clear Filters restores everyone", (await rows()).length === total && total > 3, String(total));
await owner.getByRole("search", { name: "Find staff" }).getByRole("combobox").nth(1).selectOption({ label: "Manager" }); await owner.waitForTimeout(300);
check("role filter", (await rows()).length >= 1 && (await rows()).every((r) => /Manager/.test(r)), (await rows()).join(","));
await owner.getByRole("button", { name: "Clear Filters" }).click();
const actions = await owner.locator("table[aria-label='Staff'] tbody tr", { hasText: "Sam Scheduler" }).first().getByRole("button").allTextContents();
check("staff row actions are accurate (Disable for an active account, never Enable)", actions.includes("Disable") && !actions.includes("Enable"), actions.join(","));

// Roles & Permissions
await go(owner, "/settings/roles");
const roleRows = await owner.locator("table[aria-label='Roles'] tbody tr").allTextContents();
check("roles table lists every role with a count", roleRows.length === 8 && roleRows.every((r) => /\d$/.test(r.trim())), roleRows.join(" | ").slice(0, 200));
check("no permission keys shown", !/\b[a-z_]+\.(read|manage|update|export)\b/.test(await owner.locator("main").innerText()));
const ownerCol = await owner.locator("table[aria-label='Permissions by role'] tbody tr").first().evaluate((tr) => tr.textContent);
check("matrix marks granted and not granted", /Granted/.test(await owner.locator("table[aria-label='Permissions by role']").innerText()) && /Not granted/.test(await owner.locator("table[aria-label='Permissions by role']").innerText()));

// permissions: other people see less
for (const [who, mustNot] of [["Morgan Manager", ["Staff Types", "Roles & Permissions"]], ["Sam Scheduler", ["Billing", "Staff Types", "Roles & Permissions"]]]) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, ignoreHTTPSErrors: true });
  const p = await signIn(ctx, who); await openAll(p);
  const names = await linkTexts(p);
  check(`${who}: menu hides ${mustNot.join(", ")}`, mustNot.every((n) => !names.includes(n)), names.join(" | "));
  await go(p, "/settings/roles");
  check(`${who}: Roles & Permissions page is refused`, (await p.getByText("Only an administrator can manage staff.").count()) === 1);
  await ctx.close();
}
const cg = await browser.newContext({ viewport: { width: 1360, height: 900 }, ignoreHTTPSErrors: true });
const c = await signIn(cg, "Alex Caregiver"); await openAll(c);
check("caregiver menu is only My Work", JSON.stringify(await linkTexts(c)) === JSON.stringify(["My Schedule", "Verify Visit"]), (await linkTexts(c)).join(" | "));
check("caregiver can still reach Appearance from the footer", (await c.getByRole("link", { name: "Appearance" }).count()) === 1);
await cg.close();

// mobile: drawer, selection closes it, touch help, no sideways scroll
const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
const m = await signIn(mob, "Olivia Owner");
await m.locator("button[aria-controls='aws-sidebar']").first().click(); await m.waitForTimeout(400);
check("drawer opens", await m.getByRole("navigation", { name: "Main" }).isVisible());
await m.getByRole("button", { name: /^Scheduling/ }).tap();
await m.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Schedule" }).tap(); await m.waitForLoadState("networkidle"); await m.waitForTimeout(600);
check("choosing a page closes the drawer and opens the page", (await m.getByRole("navigation", { name: "Main" }).isVisible()) === false && m.url().endsWith("/schedule"), m.url());
await go(m, "/clients");
await m.getByRole("button", { name: "About Clients" }).tap(); await m.waitForTimeout(250);
check("help opens on touch", await m.getByRole("tooltip").filter({ hasText: "Manage client profiles and care information." }).isVisible());
await m.getByRole("button", { name: "Close help" }).tap(); await m.waitForTimeout(250);
check("help is dismissed by its close button", !(await m.getByRole("tooltip").filter({ hasText: "Manage client profiles and care information." }).isVisible()));
for (const path of ["/staff", "/settings/roles", "/service-verification/reports?view=overview", "/"]) {
  await go(m, path);
  const over = await m.evaluate(() => { const roles = document.querySelector("table[aria-label='Permissions by role']"); const w = document.documentElement.scrollWidth; return { w, vw: window.innerWidth, matrixScrolls: roles ? roles.parentElement.scrollWidth > roles.parentElement.clientWidth : null }; });
  check(`phone ${path}: page itself does not scroll sideways`, over.w <= over.vw + 1, JSON.stringify(over));
}
await browser.close();
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`); process.exit(failed ? 1 : 0);
