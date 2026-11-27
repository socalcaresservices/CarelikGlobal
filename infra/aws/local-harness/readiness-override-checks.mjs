// Browser checks of the admin override of a CPR readiness block (0123) on the LOCAL harness: production web bundle, real API handler, local PostgreSQL, readiness enforcement ON, SYNTHETIC data only.
// Needs: harness:setup, seed-readiness-override.ts, harness:build, harness:serve. node readiness-override-checks.mjs <outdir>
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const fails = [];
const check = (name, ok, detail = "") => { if (!ok) fails.push(name + (detail ? ": " + detail : "")); console.log((ok ? "PASS " : "FAIL ") + name + (ok || !detail ? "" : " -> " + String(detail).slice(0, 220))); };
const VIEWS = { desktop: { width: 1360, height: 1000 }, phone: { width: 390, height: 844 } };
const probe = (first, last, ahead) => JSON.parse(execFileSync("pnpm", ["exec", "tsx", "local-harness/schedule-probe.ts", first, last, String(ahead)], { cwd: new URL("..", import.meta.url).pathname, env: process.env, encoding: "utf8" }).trim().split("\n").pop());
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
async function open(page, name) {
  await page.goto("https://localhost/care-team"); await settle(page);
  await page.locator("#cg-status").selectOption("all").catch(() => {}); await settle(page, 300);
  await page.getByRole("link", { name: new RegExp(name) }).first().click(); await settle(page);
  await page.getByRole("tab", { name: "Readiness" }).click(); await settle(page, 700);
}
const cpr = (page) => page.locator('li[data-requirement="cpr"]');
const rowText = async (page) => (await cpr(page).innerText()).replace(/\s+/g, " ");
const small = (page, scope) => scope.locator("button, a").evaluateAll((els) => els.filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.height < 44; }).map((e) => (e.textContent || "").trim().slice(0, 30)));
async function approveViaDialog(page, reason) {
  await cpr(page).getByRole("button", { name: "Approve" }).click();
  const dlg = page.getByRole("dialog", { name: "Approve override" });
  await dlg.waitFor();
  return { dlg, text: (await dlg.innerText()).replace(/\s+/g, " "), submit: async (r) => { await dlg.getByLabel(/Reason/).fill(r); await dlg.getByRole("button", { name: "Approve override" }).click(); } };
}

// ================================================================= DESKTOP: the whole scenario
{
  const { ctx, page } = await login("Olivia Owner", VIEWS.desktop);
  await open(page, "Elena");
  let t = await rowText(page);
  check("1. [desktop] an approved caregiver's expired CPR reads CPR | Expired Doc | Blocked | Approve", /^CPR\b/.test(t) && /Expired Doc/.test(t) && /Blocked/.test(t) && (await cpr(page).getByRole("button", { name: "Approve" }).count()) === 1, t);
  check("1. [desktop] the work approval is still recorded (Approved) and the document is not shown as current", /Work approval: Approved/.test(await page.getByTestId("work-approval-chip").innerText()) && !/Verified/.test(t));
  await cpr(page).screenshot({ path: `${out}/desktop-row-1-before-blocked.png` });
  await page.screenshot({ path: `${out}/desktop-profile-1-before.png`, fullPage: true });
  let p = probe("Elena", "Expired", 3);
  check("1. [desktop] scheduling is blocked through the real server check, naming the CPR", p.ok === false && /CPR/i.test(p.message), JSON.stringify(p));

  const a = await approveViaDialog(page);
  check("2. [desktop] Approve opens a confirmation that names the specific block (CPR, Expired Doc, the expiry date) and says it does not make the document current", /CPR/.test(a.text) && /Expired Doc/.test(a.text) && /expired/i.test(a.text) && /not.*marked current or verified/.test(a.text), a.text);
  await page.screenshot({ path: `${out}/desktop-dialog-approve.png` });
  await a.dlg.getByRole("button", { name: "Approve override" }).click(); await page.waitForTimeout(300);
  check("2. [desktop] a reason is required (nothing is saved without one)", (await a.dlg.getByRole("alert").count()) === 1 && /Blocked/.test(await rowText(page)));
  await a.submit("Renewal appointment booked for Friday; supervised until then");
  await page.getByRole("dialog").waitFor({ state: "detached" }); await settle(page, 600);
  t = await rowText(page);
  check("2. [desktop] after approval the row reads CPR | Expired Doc | Admin Approved | Details", /Expired Doc/.test(t) && /Admin Approved/.test(t) && !/Blocked/.test(t) && (await cpr(page).getByRole("button", { name: "Details" }).count()) === 1, t);
  check("2. [desktop] the document is still Expired (never Verified or current)", /Expired/.test(t) && !/Verified/.test(t));
  await cpr(page).screenshot({ path: `${out}/desktop-row-2-after-admin-approved.png` });
  await page.screenshot({ path: `${out}/desktop-profile-2-after.png`, fullPage: true });
  p = probe("Elena", "Expired", 3);
  check("2. [desktop] scheduling now succeeds (no other block applies)", p.ok === true, JSON.stringify(p));
  p = probe("Elena", "Expired", 3);
  check("2. [desktop] normal rules still apply: an overlapping shift for the same caregiver is refused", p.ok === false && /already has a shift/i.test(p.message), JSON.stringify(p));

  await cpr(page).getByRole("button", { name: "Details" }).click(); await settle(page, 300);
  const det = (await page.getByTestId("override-details").innerText()).replace(/\s+/g, " ");
  check("3. [desktop] Details shows the expiration date, approving admin, approval time, reason and Revoke", /Expiration date/.test(det) && /Olivia Owner/.test(det) && /Approved/.test(det) && /Renewal appointment booked/.test(det) && (await page.getByTestId("override-details").getByRole("button", { name: "Revoke" }).count()) === 1, det);
  await page.getByTestId("override-details").screenshot({ path: `${out}/desktop-details.png` });
  check("5. [desktop] readiness: no horizontal scroll", await noHScroll(page));

  // reports and the follow-up queue keep the flag
  await page.goto("https://localhost/compliance"); await settle(page, 900);
  const rep = (await page.getByTestId("overrides-report").innerText()).replace(/\s+/g, " ");
  check("5. [desktop] the compliance report lists the exception: caregiver, Expired Doc, Admin Approved, who and why", /Elena Expired/.test(rep) && /Expired Doc/.test(rep) && /Admin Approved/.test(rep) && /Olivia Owner/.test(rep) && /Renewal appointment/.test(rep), rep);
  await page.screenshot({ path: `${out}/desktop-compliance-report.png`, fullPage: true });
  await page.goto("https://localhost/action-needed"); await settle(page, 1200);
  await page.locator("select").first().selectOption("documents_compliance"); await settle(page, 1200);          // the follow-up queue for documents and compliance
  const aq = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check("5. [desktop] the follow-up queue (Action needed, documents and compliance) lists the overridden Expired Doc", /Expired Doc/.test(aq) && /Admin Approved/.test(aq), aq.slice(0, 600));
  await page.screenshot({ path: `${out}/desktop-follow-up-queue.png`, fullPage: true });

  // 4. revoke restores the block
  await open(page, "Elena");
  await cpr(page).getByRole("button", { name: "Details" }).click();
  await page.getByTestId("override-details").getByRole("button", { name: "Revoke" }).click();
  const rd = page.getByRole("dialog", { name: "Revoke override" }); await rd.waitFor();
  await rd.getByRole("button", { name: "Revoke override" }).click(); await page.waitForTimeout(300);
  check("4. [desktop] revoking requires a reason", (await rd.getByRole("alert").count()) === 1);
  await rd.getByLabel(/Reason/).fill("Renewal did not happen"); await rd.getByRole("button", { name: "Revoke override" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" }); await settle(page, 600);
  t = await rowText(page);
  check("4. [desktop] after revoking the row is Blocked again with Approve", /Expired Doc/.test(t) && /Blocked/.test(t) && /Approve/.test(t) && !/Admin Approved/.test(t), t);
  p = probe("Elena", "Expired", 4);
  check("4. [desktop] revoking restores the scheduling block", p.ok === false && /CPR/i.test(p.message), JSON.stringify(p));

  // 3. a caregiver who has never been approved for work
  await open(page, "Nora");
  t = await rowText(page);
  const wa = page.locator('li[data-requirement="approve"]');
  check("3. [desktop] a never-approved caregiver: work approval is not recorded and the CPR row reads Missing Doc | Blocked | Approve", /Not approved/.test(await wa.innerText()) && /Missing Doc/.test(t) && /Blocked/.test(t), t);
  await page.screenshot({ path: `${out}/desktop-never-approved-1-before.png`, fullPage: true });
  p = probe("Nora", "Neverapproved", 3);
  check("3. [desktop] the never-approved caregiver cannot be scheduled", p.ok === false, JSON.stringify(p));
  await wa.getByRole("button", { name: "Approve" }).click(); await settle(page, 900);
  check("3. [desktop] the admin records the work approval", /Approved/.test(await wa.innerText()) && !/Not approved/.test(await wa.innerText()));
  p = probe("Nora", "Neverapproved", 3);
  check("3. [desktop] work approval alone does not lift the document block", p.ok === false && /CPR/i.test(p.message), JSON.stringify(p));
  const a2 = await approveViaDialog(page);
  check("3. [desktop] the override confirmation names the Missing Doc issue", /CPR/.test(a2.text) && /Missing Doc/.test(a2.text), a2.text);
  await a2.submit("Card is being renewed; supervised first week");
  await page.getByRole("dialog").waitFor({ state: "detached" }); await settle(page, 600);
  t = await rowText(page);
  check("3. [desktop] the row reads CPR | Missing Doc | Admin Approved | Details and both the work approval and the override are recorded", /Missing Doc/.test(t) && /Admin Approved/.test(t) && /Approved/.test(await wa.innerText()), t);
  p = probe("Nora", "Neverapproved", 3);
  check("3. [desktop] scheduling succeeds after the work approval and the explicit override", p.ok === true, JSON.stringify(p));
  await page.screenshot({ path: `${out}/desktop-never-approved-2-after.png`, fullPage: true });
  await ctx.close();
}

// ================================================================= PHONE: the row before and after, readable and tappable
{
  const { ctx, page } = await login("Olivia Owner", VIEWS.phone);
  await open(page, "Elena");
  let t = await rowText(page);
  check("5. [phone] the Blocked row is readable: CPR, Expired Doc, Blocked, Approve", /^CPR\b/.test(t) && /Expired Doc/.test(t) && /Blocked/.test(t) && /Approve/.test(t), t);
  check("5. [phone] no horizontal scroll", await noHScroll(page));
  const s1 = await small(page, cpr(page)); check("5. [phone] the row's buttons are at least 44 px high", s1.length === 0, s1.join(", "));
  await cpr(page).screenshot({ path: `${out}/phone-row-1-before-blocked.png` });
  await page.screenshot({ path: `${out}/phone-profile-1-before.png`, fullPage: true });
  const a = await approveViaDialog(page);
  await page.screenshot({ path: `${out}/phone-dialog-approve.png` });
  const dlgBox = await page.getByRole("dialog").boundingBox();
  check("5. [phone] the confirmation fits the screen", !!dlgBox && dlgBox.width <= 390 + 1 && (await noHScroll(page)));
  const sd = await small(page, page.getByRole("dialog")); check("5. [phone] the confirmation's buttons are at least 44 px high", sd.length === 0, sd.join(", "));
  await a.submit("Renewal appointment booked for Friday; supervised until then");
  await page.getByRole("dialog").waitFor({ state: "detached" }); await settle(page, 600);
  t = await rowText(page);
  check("5. [phone] after approval the row reads CPR, Expired Doc, Admin Approved, Details", /Expired Doc/.test(t) && /Admin Approved/.test(t) && /Details/.test(t), t);
  check("5. [phone] no horizontal scroll after approval", await noHScroll(page));
  await cpr(page).screenshot({ path: `${out}/phone-row-2-after-admin-approved.png` });
  await page.screenshot({ path: `${out}/phone-profile-2-after.png`, fullPage: true });
  await cpr(page).getByRole("button", { name: "Details" }).click(); await settle(page, 300);
  await page.getByTestId("override-details").screenshot({ path: `${out}/phone-details.png` });
  check("5. [phone] Details fits the screen", await noHScroll(page));
  await ctx.close();
}
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED:\n- ` + fails.join("\n- ") : "\nALL CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
