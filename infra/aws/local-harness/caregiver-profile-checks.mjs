// Browser checks of the redesigned caregiver profile on the LOCAL harness (production web bundle, real API handler, local PostgreSQL), SYNTHETIC data only.
// Needs: harness:setup, harness:build, harness:serve. node caregiver-profile-checks.mjs <outdir>
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const fails = [];
const check = (name, ok, detail = "") => { if (!ok) fails.push(name + (detail ? ": " + detail : "")); console.log((ok ? "PASS " : "FAIL ") + name + (ok || !detail ? "" : " -> " + detail)); };
const VIEWS = { desktop: { width: 1360, height: 1000 }, phone: { width: 390, height: 844 } };
async function login(persona, viewport) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true, hasTouch: viewport.width < 600, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText(persona, { exact: false }).first().click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  return { ctx, page };
}
const settle = (page, ms = 800) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(ms));
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const small = (page) => page.locator("[role=tabpanel] button, [role=tabpanel] a, [role=tab]").evaluateAll((els) => els.filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.height < 44; }).map((e) => (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 40)));
// the label, value, status and action of one row sit on one line on a desktop
const sameLine = (page, testid) => page.getByTestId(testid).evaluate((li) => {
  const g = li.firstElementChild; const kids = [...g.querySelectorAll(":scope > div, :scope > div > span")].map((e) => e.getBoundingClientRect()).filter((b) => b.height > 0);
  const centers = kids.map((b) => b.top + b.height / 2); return Math.max(...centers) - Math.min(...centers);
});
async function open(page, name) {
  await page.goto("https://localhost/care-team"); await settle(page);
  await page.locator("#cg-status").selectOption("all").catch(() => {}); await settle(page, 300);
  await page.getByRole("link", { name: new RegExp(name) }).first().click(); await settle(page);
}
for (const [label, vp] of Object.entries(VIEWS)) {
  const { ctx, page } = await login("Olivia Owner", vp);
  await open(page, "Reese");
  const tabs = await page.getByRole("tab").allInnerTexts();
  check(`[${label}] four tabs`, tabs.join("|") === "Overview|Readiness|Assignments & availability|Documents", tabs.join("|"));
  check(`[${label}] overview: no horizontal scroll`, await noHScroll(page));
  await page.screenshot({ path: `${out}/${label}-1-overview.png`, fullPage: true });
  if (label === "desktop") for (const id of ["row-contact-email", "row-app-signin", "row-hire-date", "row-hire-type", "row-offices"]) {
    if (await page.getByTestId(id).count()) { const d = await sameLine(page, id); check(`[desktop] row ${id}: label, value, status and action on one line`, d < 24, `spread ${Math.round(d)}px`); }
  }
  const edit = page.getByTestId("row-contact-email").locator("button[aria-expanded]").first();   // the row's own Edit/Close button
  if (await edit.count()) { await edit.click(); await settle(page, 300); check(`[${label}] Edit opens the contact editor only on request`, (await page.getByLabel(/Caregiver contact email/).count()) === 1); await page.screenshot({ path: `${out}/${label}-1b-overview-editing.png`, fullPage: true }); await edit.click(); }
  await page.getByRole("tab", { name: "Readiness" }).click(); await settle(page, 500);
  check(`[${label}] readiness: no horizontal scroll`, await noHScroll(page));
  const body = await page.getByTestId("readiness-checklist").innerText();
  check(`[${label}] readiness shows the seven requirements wording without an eligibility claim`, /Background check/.test(body) && /Required training/.test(body) && /App sign-in/.test(body) && /CPR certificate/.test(body) && /TB clearance/.test(body) && /Work approval/.test(body) && !/Eligible to schedule/i.test(body));
  await page.screenshot({ path: `${out}/${label}-2-readiness.png`, fullPage: true });
  await page.getByRole("tab", { name: "Assignments & availability" }).click(); await settle(page, 600);
  check(`[${label}] assignments: no horizontal scroll`, await noHScroll(page));
  await page.screenshot({ path: `${out}/${label}-3-assignments.png`, fullPage: true });
  await page.getByRole("tab", { name: "Documents" }).click(); await settle(page, 500);
  check(`[${label}] documents: no horizontal scroll`, await noHScroll(page));
  await page.screenshot({ path: `${out}/${label}-4-documents.png`, fullPage: true });
  if (label === "phone") for (const t of ["Overview", "Readiness", "Assignments & availability", "Documents"]) { await page.getByRole("tab", { name: t }).click(); await settle(page, 400); const s = await small(page); check(`[phone] ${t}: every button and link is at least 44px high`, s.length === 0, s.join(", ")); }
  await ctx.close();
}
// The two states that depend on the agency's setup, shown on the real bundle by answering the readiness read with a SYNTHETIC approved caregiver (label: stubbed response).
for (const [label, vp] of Object.entries(VIEWS)) {
  const { ctx, page } = await login("Olivia Owner", vp);
  await open(page, "Reese");
  const id = page.url().split("/care-team/")[1].split(/[?#]/)[0];
  const item = (requirement, lbl, kind, state, detail, over = {}) => ({ requirement, label: lbl, kind, state, detail, dueDate: null, metOn: null, actorName: null, blocksShifts: false, nextAction: "none", extra: {}, ...over });
  const mk = (cpr, tb) => ({ caregiverRecordId: id, caregiverCode: "CG-X", status: "approved", approved: true, approvedAt: "2026-11-25T18:00:00Z", approvedByName: "TEST OWNER (synthetic)", approvalSource: "approval", met: 3, total: 5, waitingOn: [], canApprove: false, hireDate: "2026-11-01", graceDays: 30, cprTbDueDate: "2026-12-01", enforcementActive: true,
    items: [item("background", "Background check", "hard", "met", "Verified", { metOn: "2026-11-25", actorName: "TEST OWNER (synthetic)", nextAction: "view" }), item("training", "Required training", "hard", "met", "Done", { metOn: "2026-11-25", nextAction: "reopen", extra: { requirementId: "r" } }), item("signin", "App sign-in", "hard", "met", "Signed in", { nextAction: "view" }), cpr, tb] });
  const setup = mk(item("cpr", "CPR certificate", "flexible", "problem", "Document type not set up", { dueDate: "2026-12-01", nextAction: "upload" }), item("tb", "TB clearance", "flexible", "problem", "Document type not set up", { dueDate: "2026-12-01", nextAction: "upload" }));
  const hold = mk(item("cpr", "CPR certificate", "flexible", "problem", "Expired", { blocksShifts: true, dueDate: "2026-12-01", nextAction: "upload" }), item("tb", "TB clearance", "flexible", "met", "Verified", { metOn: "2026-11-20" }));
  for (const [name, state] of [["setup-gap", setup], ["real-hold", hold]]) {
    await page.route(`**/v1/caregivers/${id}/readiness*`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ readiness: state }) }));
    await page.goto(`https://localhost/care-team/${id}?tab=readiness`); await settle(page, 700);
    const t = await page.getByTestId("readiness-checklist").innerText();
    if (name === "setup-gap") check(`[${label}] stubbed: approved with CPR and TB not set up stays Approved, rows say Document type not set up, no scheduling hold`, /Work approval: Approved/.test(t) && (t.match(/Document type not set up/g) ?? []).length >= 2 && (await page.getByTestId("scheduling-hold").count()) === 0);
    else check(`[${label}] stubbed: a real hold shows its reason next to Approved`, /Work approval: Approved/.test(t) && (await page.getByTestId("scheduling-hold").innerText()).includes("Expired"));
    check(`[${label}] stubbed ${name}: no horizontal scroll`, await noHScroll(page));
    await page.screenshot({ path: `${out}/${label}-5-readiness-${name}-stubbed.png`, fullPage: true });
    await page.unroute(`**/v1/caregivers/${id}/readiness*`);
  }
  await ctx.close();
}
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED:\n- ` + fails.join("\n- ") : "\nALL CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
