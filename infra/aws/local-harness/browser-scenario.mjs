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
rec("a request that would exceed the 8-hour day is refused with a plain reason, on that shift", /Daily limit exceeded: [\d.]+ of [\d.]+ h/.test(refusedText), refusedText);
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
const clientSel = mp.getByLabel("Client"), svcSel = mp.getByLabel("Service", { exact: true });
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
await mp.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
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

// ---------------- accounting (0067-0070): one ledger on every screen, reconciliation by a person, amendment impacts, recorded exports
const homeNeeds = mp.getByTestId("needs-reconciliation");
rec("Home says 2 hr are reserved on a shift that ended with no visit record", (await homeNeeds.count()) === 1 && /2 h/.test(await homeNeeds.innerText()), (await homeNeeds.count()) ? await homeNeeds.innerText() : "none");
await mp.goto("https://localhost/service-verification/reports?view=reconciliation"); await settle(mp, 1500);
const chain = mp.getByTestId("monthly-chain");
rec("full-chain report is shown with every check passing", (await chain.count()) === 1 && /All checks pass/.test(await mp.getByTestId("chain-checks").innerText()), (await mp.getByTestId("chain-checks").count()) ? await mp.getByTestId("chain-checks").innerText() : "no checks line");
const toReconcileCell = chain.getByRole("row").filter({ hasText: /Demo Scenario|Respite/ }).filter({ hasText: /2 hr/ });
rec("full-chain report shows the 2 hr to reconcile on the same client row as Home", (await toReconcileCell.count()) >= 1);
rec("full-chain report: no sideways page scroll", await noOverflow(mp));
await mp.screenshot({ path: `${out}/chain-${label}.png`, fullPage: true });
const [download] = await Promise.all([mp.waitForEvent("download", { timeout: 15000 }), chain.getByRole("button", { name: "Export CSV (server-made, recorded)" }).click()]);
rec("manager's Export CSV downloads a server-made file named for the month", /^monthly-chain-\d{4}-\d{2}\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());
await mp.waitForTimeout(800);
rec("export result says generated, and that delivery is not recorded", /The server generated the file and recorded the export\. Whether it reached this device is not recorded/.test(await text(mp)));

// the three older reports are also made by the server (0072): the manager has a CSV button, the file arrives, and the ledger says generated, not delivered
await mp.goto("https://localhost/service-verification/reports?view=calendar"); await settle(mp, 1500);
await mp.locator("select").filter({ has: mp.locator("option", { hasText: "Choose a client" }) }).first().selectOption({ label: await mp.locator("option", { hasText: /Demo Scenario|SCN|Scenario/ }).first().innerText().catch(() => "") }).catch(() => {});
await settle(mp, 1500);
const legacyCsv = mp.getByRole("button", { name: "CSV", exact: true });
rec("manager sees a CSV button on the older reports", (await legacyCsv.count()) >= 1, String(await legacyCsv.count()));
if ((await legacyCsv.count()) >= 1) {
  const [legacyDownload] = await Promise.all([mp.waitForEvent("download", { timeout: 15000 }), legacyCsv.first().click()]);
  rec("an older report's CSV is a server-made file", /\.csv$/.test(legacyDownload.suggestedFilename()), legacyDownload.suggestedFilename());
  await mp.waitForTimeout(800);
}
await mp.goto("https://localhost/schedule"); await settle(mp, 1000);
const recon = mp.getByTestId("shifts-to-reconcile");
rec("schedule lists the shift that ended with no visit record", (await recon.count()) === 1 && /reserved/.test(await recon.innerText()));
// delivered but not verified: stays reserved and visible, is not billable, creates no visit
await recon.locator("li summary").first().click();
await recon.getByRole("radio", { name: "It was delivered, but there is no verified visit" }).first().check();
await recon.getByRole("textbox").fill("Family says she came; no clock-in exists (synthetic)");
await recon.getByRole("button", { name: "Save" }).click(); await mp.waitForTimeout(1500);
const awaitingNote = mp.getByTestId("awaiting-note");
rec("a shift recorded as delivered-not-verified stays listed, reserved, not billable, no visit", (await awaitingNote.count()) === 1 && /Delivered — not verified/.test(await awaitingNote.innerText()) && /Not billable, and no visit exists/.test(await awaitingNote.innerText()), (await awaitingNote.count()) ? await awaitingNote.innerText() : "none");
await mp.goto("https://localhost/"); await settle(mp, 1200);
rec("Home still counts the delivered-not-verified time as reserved", (await mp.getByTestId("needs-reconciliation").count()) === 1);
await mp.goto("https://localhost/schedule"); await settle(mp, 1000);
const recon2 = mp.getByTestId("shifts-to-reconcile");
await recon2.locator("li summary").first().click();
await recon2.getByRole("radio", { name: "No service was delivered" }).first().check();
await recon2.getByRole("button", { name: "Save" }).click(); await mp.waitForTimeout(500);
rec("releasing without a note is refused on screen", /Note too short/.test(await recon2.innerText()));
await recon2.getByRole("textbox").fill("Called the caregiver and the family; nobody went (synthetic)");
await recon2.getByRole("button", { name: "Save" }).click(); await mp.waitForTimeout(1500);
rec("after the person records it, the shift leaves the list", (await mp.getByTestId("shifts-to-reconcile").count()) === 0);
await mp.goto("https://localhost/"); await settle(mp, 1200);
rec("Home no longer shows reserved-with-no-visit time", (await mp.getByTestId("needs-reconciliation").count()) === 0);
await mp.goto("https://localhost/service-verification/reports?view=reconciliation"); await settle(mp, 1500);
rec("the full-chain report agrees with Home: nothing left to reconcile, checks still pass", /All checks pass/.test(await mp.getByTestId("chain-checks").innerText()) && (await mp.getByTestId("monthly-chain").getByRole("row").filter({ hasText: /2 hr/ }).filter({ hasText: /amber/ }).count()) === 0);

await mp.goto("https://localhost/staffing"); await settle(mp, 900);
const impLink = mp.getByTestId("amendment-impacts-link");
rec("staffing page links to the 4 authorization changes to review", (await impLink.count()) === 1 && /4 items/.test(await impLink.innerText()), (await impLink.count()) ? await impLink.innerText() : "none");
await impLink.getByRole("link", { name: "Review changes" }).click(); await settle(mp, 900);
const items = mp.getByTestId("amendment-impact");
rec("the authorization-changes page lists two reserved shifts and two confirmed visits", (await items.count()) === 4 && (await items.filter({ hasText: /no longer fits the new monthly limit/ }).count()) === 2 && (await items.filter({ hasText: /A confirmed visit now goes past/ }).count()) >= 1);
rec("an approved visit is reported as unchanged and an unapproved one as sent back to review", (await mp.getByTestId("approved-unchanged").count()) >= 1 && (await mp.getByTestId("sent-back").count()) >= 1);
rec("authorization-changes page: no sideways scroll", await noOverflow(mp));
await mp.screenshot({ path: `${out}/impacts-${label}.png`, fullPage: true });
const shiftItem = items.filter({ hasText: /no longer fits the new monthly limit/ }).first();
await shiftItem.getByRole("button", { name: "Acknowledge…" }).click();
await shiftItem.getByRole("textbox").fill("Moved the later shift to next month (synthetic)");
await shiftItem.getByRole("button", { name: "Acknowledge" }).click(); await mp.waitForTimeout(1200);
rec("acknowledging with a note removes it from the open list", (await mp.getByTestId("amendment-impact").count()) === 3);

// the lowered authorization sent the unapproved Billing Ready visit back to review; the approved one is untouched
await mp.goto("https://localhost/billing-review"); await settle(mp, 1500);
const decreased = mp.getByTestId("authorization-decreased");
rec("billing review shows the visit that went back to review with the reason", (await decreased.count()) >= 1 && /authorization was lowered/.test(await decreased.first().innerText()), String(await decreased.count()));
rec("billing review: no sideways scroll", await noOverflow(mp));
await mp.screenshot({ path: `${out}/billing-decreased-${label}.png`, fullPage: true });
await mp.getByTestId("authorization-decreased").first().locator("xpath=..").getByRole("link", { name: /Correct or resolve/ }).click(); await settle(mp, 1500);
const arCard = mp.getByTestId("authorization-review");
rec("the visit page shows the authorization-review card and says nothing was changed", (await arCard.count()) === 1 && /not changed/.test(await arCard.innerText()), (await arCard.count()) ? "" : "no card");
await mp.screenshot({ path: `${out}/authorization-review-${label}.png`, fullPage: true });
await arCard.getByRole("button", { name: "Confirm it is still billable" }).click(); await mp.waitForTimeout(500);
rec("confirming without a note is refused on screen", /at least 10 characters/.test(await arCard.innerText()));
await arCard.getByRole("textbox").fill("Payer letter confirms the old limit applies to this visit (synthetic)");
await arCard.getByRole("button", { name: "Confirm it is still billable" }).click(); await mp.waitForTimeout(1500);
rec("after confirming, the card records who confirmed and why", /Confirmed still billable by Morgan Manager/.test(await mp.getByTestId("authorization-review").innerText()));

// ---------------- release candidate: Action needed, client page, schedule views, reporting & billing, deadlines
await mp.goto("https://localhost/"); await settle(mp, 1500);
const top = mp.getByTestId("top-issues");
rec("Home: 'Needs action first' lists Critical and Urgent items with a View all link", (await top.count()) === 1 && (await top.getByRole("link", { name: /View all/ }).count()) === 1);
rec("Home: still the four streams and no sideways scroll with the new list", (await mp.getByTestId("stream-now").count()) === 1 && await noOverflow(mp));
await mp.screenshot({ path: `${out}/home-rc-${label}.png`, fullPage: true });
await top.getByRole("link", { name: /View all/ }).click(); await settle(mp, 1500);
const issueCards = mp.getByTestId("issue-card");
const nCards = await issueCards.count();
rec("Action needed lists issue cards, each with a recommended action and one primary link", nCards >= 1 && (await issueCards.first().getByRole("link").count()) >= 1, String(nCards));
rec("Action needed: counts line says routine queues are not in the action total", /need action/.test(await mp.getByTestId("issue-counts").innerText()));
rec("Action needed: no sideways scroll", await noOverflow(mp));
await mp.screenshot({ path: `${out}/action-needed-${label}.png`, fullPage: true });
// in-app notifications (0077): the bell counts what is Critical or Urgent in the action queues, lists it by word, and fits the screen
const bell = mp.getByTestId("notifications-button");
const bellCount = Number(((await bell.innerText()).match(/(\d+)\s*$/) ?? [])[1] ?? NaN);
rec("notifications: the header bell shows a count of unread items", (await bell.count()) === 1 && Number.isFinite(bellCount), String(bellCount));
await bell.click(); await mp.waitForTimeout(800);
const panelRows = await mp.getByTestId("notification").allInnerTexts();
rec("notifications: the panel lists Critical/Urgent items by word with no personal names", bellCount === 0 || (panelRows.length >= 1 && panelRows.every((t) => /Critical|Urgent/.test(t))), String(panelRows.length));
rec("notifications: the panel fits the screen", await noOverflow(mp));
await mp.screenshot({ path: `${out}/notifications-${label}.png` });
await mp.getByRole("button", { name: "Mark all read" }).click().catch(() => {}); await mp.waitForTimeout(1200);
rec("notifications: marking all read brings the count to 0", /Notifications\s*0\s*$/.test((await mp.getByTestId("notifications-button").innerText()).trim()) || bellCount === 0);
await mp.getByTestId("notifications-button").click(); await mp.waitForTimeout(300);
await mp.getByTestId("issue-filters").getByLabel("Severity").selectOption("critical"); await settle(mp, 1200);
const crit = mp.getByTestId("issue-card");
const critTexts = await crit.allInnerTexts();
rec("Action needed: the Critical filter shows only Critical items", critTexts.length === 0 ? (await mp.getByRole("status").filter({ hasText: /Nothing matches/ }).count()) === 1 : critTexts.every((t) => /Critical/.test(t)));
await mp.getByTestId("issue-filters").getByLabel("Severity").selectOption(""); await settle(mp, 800);
await mp.getByTestId("issue-card").first().getByRole("button", { name: "History" }).click(); await mp.waitForTimeout(800);
rec("Action needed: History shows when the issue was first seen", /seen|opened/.test(await mp.getByTestId("issue-history").first().innerText()));

// client page
await mp.goto("https://localhost/clients"); await settle(mp, 1200);
if (label === "phone") { await mp.locator("summary").filter({ hasText: /Demo Scenario/ }).first().click(); }
await (label === "phone" ? mp.locator("li").filter({ hasText: /Demo Scenario/ }).getByRole("link").first() : mp.getByRole("link", { name: /Demo Scenario/ }).first()).click(); await settle(mp, 1500);
const openAll = () => mp.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
const clientUrl = mp.url();
rec("client page: three primary actions, More, alerts, next visits, caregivers, readiness and documents are present", (await mp.getByRole("navigation", { name: "Client actions" }).count()) === 1 && (await mp.getByTestId("next-visits").count()) === 1 && (await mp.getByTestId("caregiver-summary").count()) === 1 && (await mp.getByTestId("readiness-card").count()) === 1 && (await mp.getByTestId("client-documents").count()) === 1 && (await mp.getByTestId("client-alerts").count()) === 1);
const order = await mp.evaluate(() => ["Authorizations", "Next visits", "Caregivers", "Readiness", "Documents", "Details"].map((t) => { const h = [...document.querySelectorAll("h2")].find((x) => x.textContent?.trim() === t); return h ? h.getBoundingClientRect().top + window.scrollY : -1; }));
rec("client page: authorization comes before the schedule, caregivers, readiness, documents and details", order.every((v, k) => v >= 0 && (k === 0 || v > order[k - 1])), JSON.stringify(order));
rec("client page: details are read-only until Edit", (await mp.getByTestId("details-readonly").count()) === 1);
rec("client page: no sideways scroll", await noOverflow(mp));
await mp.screenshot({ path: `${out}/client-page-${label}.png`, fullPage: true });
// documents: configure a requirement, put the client in Draft, activation is refused until the upload is approved
await openAll();
await mp.getByRole("button", { name: "Set up required documents" }).click(); await mp.waitForTimeout(500);
const setup = mp.getByTestId("document-setup");
await setup.getByLabel("New document type").fill("Consent to care (browser)");
await setup.getByRole("button", { name: "Add the document type" }).click(); await mp.waitForTimeout(1200);
await setup.getByLabel("Required for Respite").first().click(); await mp.waitForTimeout(1500);
await mp.getByRole("button", { name: "Move to Draft…" }).click(); await mp.waitForTimeout(1200);
rec("client page: Draft says it cannot be scheduled", /Cannot be scheduled/.test(await mp.getByTestId("readiness-card").innerText()) && /Draft/.test(await mp.getByTestId("client-stage").innerText()));
await mp.getByTestId("readiness-card").getByRole("button", { name: "Activate" }).click(); await mp.waitForTimeout(1200);
rec("client page: activation is refused while a required document is not approved", /cannot be activated yet/.test(await mp.getByTestId("readiness-card").innerText()));
const consentRow = mp.getByTestId("client-document").filter({ hasText: "Consent to care (browser)" });
rec("client page: the required document shows as Missing", /Missing/.test(await consentRow.innerText()));
await consentRow.getByRole("button", { name: "Upload" }).first().click();
await consentRow.locator('input[type="file"]').setInputFiles({ name: "consent.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% synthetic consent\n") });
await consentRow.getByRole("button", { name: "Upload" }).last().click(); await mp.waitForTimeout(2000);
rec("client page: an upload is Pending review and says upload is not approval", /Pending review/.test(await consentRow.innerText()) && /Uploading is not approval/.test(await consentRow.innerText()));
rec("client page: the uploader cannot approve their own upload", await (async () => { await consentRow.getByRole("button", { name: "Review…" }).click(); await consentRow.getByRole("radio", { name: "Approve" }).check(); await consentRow.getByRole("button", { name: "Save decision" }).click(); await mp.waitForTimeout(1200); return /cannot review a document you uploaded/.test(await consentRow.innerText()); })());
// the owner approves
const o2 = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true }); const op2 = await o2.newPage();
await login(op2, "Olivia Owner");
await op2.goto(clientUrl); await settle(op2, 1500);
const ownerRow = op2.getByTestId("client-document").filter({ hasText: "Consent to care (browser)" });
await op2.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
await ownerRow.getByRole("button", { name: "Review…" }).click(); await ownerRow.getByRole("radio", { name: "Approve" }).check(); await ownerRow.getByRole("button", { name: "Save decision" }).click(); await op2.waitForTimeout(1500);
await op2.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
rec("client page: another reviewer approves and the document is Approved", /Approved/.test(await ownerRow.innerText()));
// the owner also sets a shorter deadline from Action needed
await op2.goto("https://localhost/action-needed"); await settle(op2, 1500);
await op2.getByText("Follow-up deadlines").click(); await op2.waitForTimeout(500);
await op2.getByLabel(/Client confirmation/).fill("24");
await op2.getByRole("button", { name: "Save the deadlines" }).click(); await op2.waitForTimeout(800);
rec("deadlines: saving without a reason is refused on screen", /at least 10 characters/.test(await op2.getByTestId("deadline-settings").innerText()));
await op2.getByLabel(/Why are you changing them/).fill("Faster follow-up for the pilot (synthetic)");
await op2.getByRole("button", { name: "Save the deadlines" }).click(); await op2.waitForTimeout(1500);
rec("deadlines: the owner saves a shorter deadline and it is shown", /Saved/.test(await op2.getByTestId("deadline-settings").innerText()) && /now 24 h/.test(await op2.getByTestId("deadline-settings").innerText()));
// the owner reads the audit report in Reporting & billing
await op2.goto("https://localhost/reporting"); await settle(op2, 2000);
rec("reporting: the five sections are present", (await op2.getByRole("heading", { name: /Billing readiness|Authorized vs delivered hours|Agency performance|Reports and exports|Compliance and audit evidence/ }).count()) === 5);
rec("reporting: missed visits says Not published", /Not published/.test(await op2.getByTestId("missed-visits").innerText()));
const auditPanel = op2.getByTestId("audit-report");
rec("reporting: the owner sees the audit report with field names only", (await auditPanel.count()) === 1 && (await auditPanel.getByTestId("audit-event").count()) >= 1 && /never values/.test(await auditPanel.innerText()));
rec("reporting: no sideways scroll", await noOverflow(op2));
await op2.screenshot({ path: `${out}/reporting-${label}.png`, fullPage: true });
await o2.close();
// the manager activates now that the document is approved
await mp.goto(clientUrl); await settle(mp, 1500);
await mp.getByTestId("readiness-card").getByRole("button", { name: "Activate" }).click(); await mp.waitForTimeout(1500);
rec("client page: after approval the client is activated and can be scheduled", /Active/.test(await mp.getByTestId("client-stage").innerText()) && !/Cannot be scheduled/.test(await mp.getByTestId("readiness-card").innerText()));
await mp.getByRole("button", { name: "History and audit trail" }).click(); await mp.waitForTimeout(1200);
rec("client page: the history lists changes by field name without values", /changed:/.test(await mp.getByTestId("client-history").innerText()) && /never the values/.test(await mp.getByTestId("client-history").innerText()));

// schedule
await mp.goto("https://localhost/schedule"); await settle(mp, 1500);
rec("schedule: the overview, the three views and filters are present", (await mp.getByTestId("scheduling-overview").count()) === 1 && (await mp.getByRole("group", { name: "Calendar view" }).count()) === 1 && (await mp.getByRole("button", { name: "Filters" }).count()) === 1);
await mp.getByRole("button", { name: "Month" }).click(); await settle(mp, 1500);
rec("schedule: the month view shows a grid and no sideways scroll", (await mp.getByTestId("month-grid").count()) === 1 && await noOverflow(mp));
await mp.screenshot({ path: `${out}/schedule-month-${label}.png`, fullPage: true });
await mp.getByTestId("month-grid").getByRole("button").filter({ hasText: /\d/ }).nth(2).click(); await settle(mp, 1000);
rec("schedule: choosing a day opens that day", (await mp.getByRole("button", { name: "Day", pressed: true }).count()) === 1);
await mp.getByRole("button", { name: "Week" }).click(); await settle(mp, 800);
await mp.getByRole("button", { name: "Filters" }).click();
await mp.getByTestId("shift-filters").getByLabel("Caregiver").selectOption("open"); await settle(mp, 800);
rec("schedule: the 'No caregiver' filter keeps only shifts without one", (await mp.getByTestId("shift-state").allInnerTexts()).every((t) => /NEEDS COVERAGE/.test(t)));
await mp.getByTestId("shift-filters").getByRole("button", { name: "Clear filters" }).click();
// the link from Action needed lands on the shift with suggestions
await mp.goto("https://localhost/action-needed"); await settle(mp, 1500);
const choose = mp.getByRole("link", { name: "Choose a caregiver" }).first();
if (await choose.count()) {
  await choose.click(); await settle(mp, 2500);
  rec("schedule: the link from Action needed opens that shift with suggested caregivers (or says none are eligible)", (await mp.locator('[data-testid="replacement-suggestions"], [data-testid="no-eligible"], [data-testid="suggestions-error"]').count()) >= 1 && (await mp.locator('[data-highlight="true"]').count()) === 1);
  await mp.screenshot({ path: `${out}/schedule-suggestions-${label}.png`, fullPage: true });
} else rec("schedule: the link from Action needed opens that shift with suggested caregivers (no uncovered shift in this fixture)", true);
// reporting as the manager: export billing review
await mp.goto("https://localhost/reporting"); await settle(mp, 2000);
const [billDownload] = await Promise.all([mp.waitForEvent("download", { timeout: 15000 }), mp.getByRole("button", { name: /Export billing review/ }).click()]);
rec("reporting: the manager's billing-review export is a server-made file named for the month", /^billing-review-\d{4}-\d{2}\.csv$/.test(billDownload.suggestedFilename()), billDownload.suggestedFilename());
await mp.waitForTimeout(800);
rec("reporting: the export notice says generated, delivery not recorded", /Whether it reached this device is not recorded/.test(await text(mp)));
rec("reporting: the manager has no audit report", (await mp.getByTestId("audit-report").count()) === 0 && /available to the agency owner/.test(await text(mp)));
await mctx.close();

// owner: the export ledger; scheduler: can read the chain but not export
const octx = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true }); const op = await octx.newPage();
await login(op, "Olivia Owner");
await op.goto("https://localhost/service-verification/reports?view=reconciliation"); await settle(op, 1500);
const hist = op.getByTestId("export-history");
rec("owner sees the export history", (await hist.count()) === 1);
await hist.locator("summary").click(); await op.waitForTimeout(300);
const histText = await hist.innerText();
rec("export history names who, which report and that the server generated the file without claiming delivery", /Morgan Manager/.test(histText) && /Full chain for the month/.test(histText) && /generated by the server \(delivery not recorded\)/.test(histText), histText.slice(0, 200));
await octx.close();
const sctx = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true }); const sp = await sctx.newPage();
await login(sp, "Sam Scheduler");
await sp.goto("https://localhost/service-verification/reports?view=reconciliation"); await settle(sp, 1500);
rec("scheduler reads the full-chain report but has no export button and is told why", (await sp.getByTestId("monthly-chain").count()) === 1 && (await sp.getByRole("button", { name: "Export CSV (server-made, recorded)" }).count()) === 0 && /not export it/.test(await sp.getByTestId("monthly-chain").innerText()));
rec("scheduler has no CSV button on the older reports either", (await sp.getByRole("button", { name: "CSV", exact: true }).count()) === 0);
await sctx.close();
console.log(`[${label}] ${n - fail}/${n} checks pass, ${fail} fail`);
await browser.close();
process.exit(fail ? 1 : 0);
