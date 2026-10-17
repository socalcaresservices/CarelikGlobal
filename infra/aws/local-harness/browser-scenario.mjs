// One browser pass on freshly reset fixtures: node scenario.mjs <desktop|phone> <outdir>
import { chromium } from "playwright-core";
import fs from "node:fs";
const label = process.argv[2]; const out = process.argv[3]; fs.mkdirSync(out, { recursive: true });
const vp = label === "phone" ? { width: 390, height: 844 } : { width: 1280, height: 900 };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
let fail = 0, n = 0;
const rec = (name, ok, d = "") => { n++; if (!ok) { fail++; console.log("FAIL", `[${label}]`, name, d); } else console.log("ok  ", `[${label}]`, name); };
async function login(page, persona) {
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText(persona, { exact: false }).first().click();
  await page.waitForLoadState("networkidle");
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const settle = async (page, ms = 700) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(ms); };
const text = (page) => page.evaluate(() => document.body.innerText);

// ---------------- caregiver: request shifts (refused by the 8-hour day; allowed in a clean week)
const cctx = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true }); const cp = await cctx.newPage();
await login(cp, "Alex Caregiver");
await cp.goto("https://localhost/my-shifts"); await settle(cp, 900);
rec("caregiver sees 'Open shifts you can ask for'", (await cp.getByRole("heading", { name: /Open shifts you can ask for/ }).count()) === 1);
const buttons = cp.getByRole("button", { name: "Request this shift" });
const nb = await buttons.count();
rec("caregiver has open shifts to request", nb >= 2, String(nb));
// find the 9-hour shift: its card text contains 7:00 AM and 4:00 PM
// the 9-hour shift (7:00 AM to 4:00 PM) is refused by the daily limit; the 2-hour shift (10:00 AM to 12:00 PM) is allowed
const cardFor = (re) => cp.locator("li").filter({ hasText: re }).filter({ has: cp.getByRole("button", { name: "Request this shift" }) }).first();
const long = cardFor(/7:00 AM.*4:00 PM|7:00 AM to 4:00 PM/s);
rec("the 9-hour open shift is listed", (await long.count()) === 1);
await long.getByRole("button", { name: "Request this shift" }).click(); await cp.waitForTimeout(1200);
const refusedText = await long.innerText().catch(() => "");
const short = cardFor(/10:00 AM.*12:00 PM|10:00 AM to 12:00 PM/s);
rec("the 2-hour open shift is listed", (await short.count()) === 1);
await short.getByRole("button", { name: "Request this shift" }).click(); await cp.waitForTimeout(1200);
rec("a request that would exceed the 8-hour day is refused with a plain reason, on that shift", /Over the daily hour limit/.test(refusedText), refusedText);
rec("a request the policy allows shows 'Requested' and says the shift is not theirs yet", (await cp.getByTestId("requested-badge").count()) >= 1 && /not yours until they do/.test(await text(cp)));
rec("caregiver page: no sideways scroll", await noOverflow(cp));
const b0 = await cp.getByRole("button").first().boundingBox().catch(() => null);
await cp.screenshot({ path: `${out}/caregiver-${label}.png`, fullPage: true });
await cctx.close();

// ---------------- manager
const mctx = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true }); const mp = await mctx.newPage();
await login(mp, "Morgan Manager");
await mp.goto("https://localhost/schedule"); await settle(mp, 900);
const panel = mp.getByTestId("pickup-requests");
rec("office sees the caregiver request panel", (await panel.count()) === 1);
if (await panel.count()) {
  const t = await panel.innerText();
  rec("panel: nobody assigned until confirmed; names the caregiver", /Nobody is assigned until you confirm/.test(t) && /Alex Caregiver/.test(t), t.slice(0, 160));
  await panel.getByRole("button", { name: "Confirm assignment" }).first().click(); await mp.waitForTimeout(1300);
  rec("confirming shows who is now assigned", (await mp.getByText(/is now assigned to the shift/).count()) >= 1);
}
rec("schedule: no sideways scroll", await noOverflow(mp));
await mp.getByRole("button", { name: "Hours and limits" }).click(); await mp.waitForTimeout(800);
const banner = mp.getByTestId("work-hour-policy");
rec("agency work-hour banner shows 8 hr a day and 40 hr a week", (await banner.count()) === 1 && /8 hr a day and 40 hr a week/.test(await banner.innerText()));
// repeat form: Tanaka's authorization ends in 10 days, so a 21-day daily series saves the dates that fit and lists the rest
await mp.getByRole("button", { name: "Repeat visits" }).click(); await mp.waitForTimeout(700);
const clientSel = mp.getByLabel("Client"), svcSel = mp.getByLabel("Service");
await clientSel.selectOption({ label: (await clientSel.locator("option").allInnerTexts()).find((o) => /Tanaka/.test(o)) });
await svcSel.selectOption({ label: "Respite (RSP)" });
for (const d of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) await mp.getByLabel(d, { exact: true }).check().catch(() => {});
const fmt = (k) => new Date(Date.now() + k * 864e5).toISOString().slice(0, 10);
await mp.getByLabel("Start time").fill("09:00"); await mp.getByLabel("End time").fill("10:00");
await mp.getByLabel("First date").fill(fmt(2)); await mp.getByLabel("Last date (optional)").fill(fmt(24));
await mp.getByRole("button", { name: "Preview dates and hours" }).click(); await mp.waitForTimeout(1800);
const flagged = await mp.getByText(/dates? (do|does) not fit/).count();
rec("repeat preview lists dates that do not fit", flagged >= 1, (await text(mp)).slice(0, 200));
const create = mp.getByRole("button", { name: /Create series/ });
rec("Create series stays available (it saves the dates that fit)", (await create.count()) >= 1 && await create.first().isEnabled());
if (await create.count()) {
  await create.first().click(); await mp.waitForTimeout(2000);
  const rej = mp.getByTestId("rejected-dates"); const rt = (await rej.count()) ? await rej.innerText() : "";
  rec("every rejected date is listed with a reason and not saved", /not saved/.test(rt), rt.slice(0, 200));
  rec("the dates that fit were saved", /saved|created/i.test(await text(mp)));
}
rec("schedule after series: no sideways scroll", await noOverflow(mp));
await mp.screenshot({ path: `${out}/schedule-${label}.png`, fullPage: true });

// billing review: every state
await mp.goto("https://localhost/billing-review"); await settle(mp, 1000);
const body = await text(mp);
for (const s of ["Needs Correction", "Ready for Review", "Approved for Billing", "Voided", "Reviewed — not billable", "Waiting for signature", "Signature received — review it"])
  rec(`billing review shows state '${s}'`, body.includes(s));
rec("billing review never shows 'Already Billed' or 'Awaiting approval'", !/Already Billed|Awaiting approval/.test(body));
rec("billing review shows the void history (when, why, by whom)", (await mp.getByTestId("void-history").count()) >= 1 && /wrong minutes/.test(await mp.getByTestId("void-history").first().innerText()));
rec("billing review: no sideways scroll", await noOverflow(mp));
await mp.screenshot({ path: `${out}/billing-${label}.png`, fullPage: true });

// compliance: holds page
await mp.goto("https://localhost/compliance"); await settle(mp, 900);
const ct = await text(mp);
rec("holds page lists two caregivers on hold", /2 on hold/.test(ct), ct.slice(0, 160));
rec("holds page: a visit in progress is flagged and not ended", /A visit is in progress\. Arrange safe coverage now\./.test(ct) && /has not been ended and will not be/.test(ct));
rec("holds page: a hold's affected shift is marked in progress", /in progress now/.test(ct));
const risk = mp.getByRole("region", { name: "Shifts with CPR or TB expiring" });
rec("holds page: 'Shifts with CPR or TB expired or expiring' section is shown", (await risk.count()) === 1);
if (await risk.count()) {
  const rt = await risk.innerText();
  rec("risk section: CPR expires during the shift (overnight) for Alex", /Alex Caregiver/.test(rt) && /CPR expires during this shift/.test(rt));
  rec("risk section: CPR expired for a later shift", /CPR is expired for this shift/.test(rt));
  rec("risk section: the shift under way is marked In progress (visit open)", /In progress \(visit open\)/.test(rt));
}
rec("holds page: no sideways scroll", await noOverflow(mp));
await mp.screenshot({ path: `${out}/compliance-${label}.png`, fullPage: true });
// caregiver compliance card for Alex (via the risk section link) and for Blair (on hold)
await mp.getByRole("link", { name: "Alex Caregiver" }).first().click(); await settle(mp, 1000);
const open = mp.getByRole("button", { name: /Compliance/ }).first();
if (await open.count()) await open.click().catch(() => {});
await mp.waitForTimeout(500);
const at = await text(mp);
rec("Alex's compliance card lists the shifts where CPR expires", /Scheduled shifts where CPR or TB expires/.test(at) || (await mp.getByRole("region", { name: "Shifts affected by CPR or TB expiry" }).count()) >= 1, at.slice(0, 300));
rec("profile: no sideways scroll", await noOverflow(mp));
await mp.screenshot({ path: `${out}/profile-alex-${label}.png`, fullPage: true });
await mp.goto("https://localhost/compliance"); await settle(mp, 600);
await mp.getByRole("link", { name: "Blair Caregiver" }).first().click(); await settle(mp, 1000);
const open2 = mp.getByRole("button", { name: /Compliance/ }).first();
if (await open2.count()) await open2.click().catch(() => {});
await mp.waitForTimeout(500);
rec("Blair's compliance card shows the hold", /On compliance hold/.test(await text(mp)));
await mp.screenshot({ path: `${out}/profile-blair-${label}.png`, fullPage: true });
// Home
await mp.goto("https://localhost/"); await settle(mp, 1200);
const ht = await text(mp);
rec("Home keeps the four streams and Today's Visits and quick actions", /Needs attention now/.test(ht) && /Upcoming staffing/.test(ht) && /Today's visits|Today.s Visits/i.test(ht) && /Schedule Visit|Schedule visit/.test(ht));
rec("Home: no sideways scroll", await noOverflow(mp));
await mp.screenshot({ path: `${out}/home-${label}.png`, fullPage: true });
await mctx.close();
console.log(`[${label}] ${n - fail}/${n} checks pass, ${fail} fail`);
await browser.close();
process.exit(fail ? 1 : 0);
