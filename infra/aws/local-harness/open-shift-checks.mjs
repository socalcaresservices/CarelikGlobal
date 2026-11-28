// Browser checks of the open-shift workflow and the (mock) texting on the LOCAL harness, SYNTHETIC data only. The owner turns on / reviews texting, two caregivers opt in, the alert run offers the
// Winchester shift (coordinated by Temecula), both request it on a phone-sized screen, the manager sees the earliest eligible request preselected and confirms one, the other sees "Filled",
// only the chosen caregiver gets the confirmation text. Needs: harness:setup, seed-open-shift.ts, harness:build, harness:serve. node open-shift-checks.mjs <outdir>
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const fails = []; const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); if (!ok) fails.push(name + (detail ? ": " + detail : "")); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + String(detail).slice(0, 160) : "")); };
// the shift this scenario created: Winchester service city, 5:00 AM to 5:50 AM (the demo agency has other open shifts for the same client)
const MINE = /5:00 AM.{1,3}5:50 AM/;
const PHONE = { width: 390, height: 844 }, DESKTOP = { width: 1360, height: 900 };
async function login(persona, viewport) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true, hasTouch: viewport.width < 600, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText(persona, { exact: false }).first().click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  return { ctx, page };
}
const settle = (page, ms = 900) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(ms));
const noHScroll = async (page) => (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
const inView = async (loc) => { const b = await loc.boundingBox(); const vp = loc.page().viewportSize(); return !!b && b.y >= 0 && b.y + b.height <= vp.height + 400 && b.x >= 0 && b.x + b.width <= vp.width + 1; };
const sweep = () => JSON.parse(execFileSync("pnpm", ["exec", "tsx", "local-harness/run-open-shift-sweep.ts"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, HARNESS_ADMIN_URL: process.env.HARNESS_ADMIN_URL }, encoding: "utf8" }).trim().split("\n").pop());

// ---- 1. the owner sees the texting settings (test sender) and adds an on-call number ----------------------------------------------------------------------------
const owner = await login("Olivia Owner", DESKTOP); const op = owner.page;
await op.goto("https://localhost/notifications"); await settle(op);
check("owner: texting panel says the test sender sends nothing to a phone", (await op.getByTestId("sms-mock-note").innerText()).includes("Nothing is sent to a phone yet"));
check("owner: this agency's own limits are shown", (await op.getByTestId("sms-dailyLimit").inputValue()) === "200" && (await op.getByTestId("sms-recruitmentDays").inputValue()) === "14" && (await op.getByTestId("sms-escalationHours").inputValue()) === "24");
await op.getByTestId("oncall-label").fill("On-call Temecula"); await op.getByTestId("oncall-phone").fill("951-555-0199"); await op.getByTestId("oncall-add").click(); await settle(op);
const oncallText = await op.getByTestId("sms-oncall").innerText();
check("owner: an on-call number is added and shown by its last four digits only", oncallText.includes("ends 0199") && !oncallText.includes("5550199"), oncallText.replace(/\s+/g, " "));
await op.screenshot({ path: `${out}/01-owner-texting-settings.png`, fullPage: true });

// ---- 2. two caregivers opt in on a phone ---------------------------------------------------------------------------------------------------------------------
const alex = await login("Alex Caregiver", PHONE); const ap = alex.page;
const blair = await login("Blair Caregiver", PHONE); const bp = blair.page;
for (const [p, num, who] of [[ap, "(951) 555-0101", "Alex"], [bp, "(951) 555-0102", "Blair"]]) {
  await p.goto("https://localhost/notifications"); await settle(p);
  const save = p.getByTestId("my-sms-save");
  check(`${who}: the Turn on texts button is off until there is a number AND an explicit yes`, await save.isDisabled());
  await p.getByTestId("my-sms-phone").fill(num); check(`${who}: a number alone is not consent`, await save.isDisabled());
  await p.getByTestId("my-sms-agree").check(); check(`${who}: the button is on after the yes`, await save.isEnabled());
  check(`${who}: the consent text is visible (rates, STOP, no client names)`, /Reply STOP/.test(await p.getByTestId("my-sms-form").innerText()) && /No client names/.test(await p.getByTestId("my-sms-form").innerText()));
  check(`${who}: primary button reachable on the phone, no sideways scroll`, (await inView(save)) && (await noHScroll(p)));
  await save.click(); await settle(p);
  const on = await p.getByTestId("my-sms-on").innerText().catch(() => "");
  check(`${who}: opted in, shows only the last four digits`, /ending 0(101|102)/.test(on) && !/555-?010[12]/.test(on), on.replace(/\s+/g, " "));
}
await ap.screenshot({ path: `${out}/02-alex-optin-phone.png` });

// ---- 3. the alert run offers the shift (mock sender) ---------------------------------------------------------------------------------------------------------
const r1 = sweep();
check("alert run: two recruitment texts went through the MOCK sender, both opted-in caregivers", r1.mockSent.filter((m) => /Open shift in Winchester/.test(m.body) && MINE.test(m.body)).length === 2, JSON.stringify(r1.mockSent.map((m) => m.to)));
check("alert run: the text has the service city, STOP line, and no client name, code, street or ZIP", r1.mockSent.every((m) => /Winchester/.test(m.body) && /Reply STOP to opt out\./.test(m.body) && !/92596|Demo (Vega|Okafor|Tanaka|Rivera|Lindqvist|Brightwater|Nakamura)|CL-|Street/.test(m.body)), r1.mockSent[0]?.body);

// ---- 4. the caregivers see the shift on the board and request it ------------------------------------------------------------------------------------------
const itemFor = (p) => p.getByRole("heading", { name: "Open shifts you can ask for" }).locator("xpath=ancestor::section[1]").locator("li").filter({ hasText: "Winchester" }).filter({ hasText: MINE });
for (const [p, who] of [[ap, "Alex"], [bp, "Blair"]]) {
  await p.goto("https://localhost/my-shifts"); await settle(p, 1200);
  const item = itemFor(p);
  const txt = await item.innerText().catch(() => "");
  check(`${who}: the Winchester shift shows the SERVICE city and the coordinating office`, /Winchester/.test(txt) && /Coordinated by Temecula Office/.test(txt), txt.replace(/\s+/g, " "));
  const btn = item.getByRole("button", { name: "Request this shift" });
  check(`${who}: the Request button is visible and reachable on the phone`, (await btn.count()) === 1 && (await inView(btn)) && (await noHScroll(p)));
  await btn.click(); await settle(p, 1200);
  check(`${who}: after requesting it says Requested and offers Withdraw (it is not the caregiver's shift yet)`, (await item.getByTestId("requested-badge").count()) === 1 && (await item.getByRole("button", { name: "Withdraw request" }).count()) === 1);
  if (who === "Alex") await p.screenshot({ path: `${out}/03-alex-board-requested-phone.png` });
}
// withdraw and request again: Blair asks LAST, so Alex is the earliest
await bp.goto("https://localhost/my-shifts"); await settle(bp, 1200);
const bitem = itemFor(bp);
await bitem.getByRole("button", { name: "Withdraw request" }).click(); await settle(bp, 1000);
check("Blair: withdrawing returns the shift to the Request state", (await bitem.getByRole("button", { name: "Request this shift" }).count()) === 1);
await bitem.getByRole("button", { name: "Request this shift" }).click(); await settle(bp, 1000);

// ---- 5. the office queue: earliest eligible preselected; only the office confirms ------------------------------------------------------------------------
const mgr = await login("Morgan Manager", DESKTOP); const mp = mgr.page;
await mp.goto("https://localhost/schedule"); await settle(mp, 1500);
const panel = mp.getByTestId("pickup-requests");
check("office: one card for the shift with two requests", (await panel.getByTestId("pickup-shift").count()) === 1 && (await panel.getByTestId("pickup-choice").count()) === 2);
const radios = panel.getByTestId("pickup-choice");
check("office: the EARLIEST eligible request (Alex) is preselected", (await radios.nth(0).isChecked()) && !(await radios.nth(1).isChecked()) && /Alex/.test(await radios.nth(0).locator("xpath=ancestor::li[1]").innerText()));
check("office: the earliest-eligible badge is shown once", (await panel.getByTestId("pickup-earliest").count()) === 1);
await mp.screenshot({ path: `${out}/04-manager-queue-preselected.png`, fullPage: true });
await ap.goto("https://localhost/my-shifts"); await settle(ap, 800);
check("a caregiver never sees the office queue (the server also refuses it: 403 in the API tests)", (await ap.getByTestId("pickup-requests").count()) === 0 && (await ap.getByRole("button", { name: "Confirm assignment" }).count()) === 0);
await panel.getByRole("button", { name: "Confirm assignment" }).click(); await settle(mp, 1500);
check("office: confirming assigns exactly the chosen caregiver and closes the other request", (await mp.getByText(/is now assigned to the shift\. The other requests for it were closed\./).count()) >= 1);

// ---- 6. selected gets the confirmation, the other sees Filled in-app ------------------------------------------------------------------------------------------
await ap.goto("https://localhost/notifications"); await settle(ap, 1200);
await bp.goto("https://localhost/notifications"); await settle(bp, 1200);
const aItems = await ap.getByTestId("center-item").allInnerTexts(); const bItems = await bp.getByTestId("center-item").allInnerTexts();
check("Alex: sees 'You are confirmed' for the Winchester shift", aItems.some((t) => /You are confirmed \| Winchester/.test(t)), aItems.join(" / ").replace(/\s+/g, " "));
check("Blair: sees 'Filled' in-app, and no confirmation", bItems.some((t) => /Filled \| Winchester/.test(t)) && !bItems.some((t) => /You are confirmed/.test(t)), bItems.join(" / ").replace(/\s+/g, " "));
await bp.screenshot({ path: `${out}/05-blair-filled-phone.png` });
await bp.goto("https://localhost/my-shifts"); await settle(bp, 1200);
check("Blair: the filled shift is gone from the board", (await itemFor(bp).count()) === 0);

// ---- 7. the worker: only the chosen caregiver is texted -----------------------------------------------------------------------------------------------------
const r2 = sweep();
const conf = r2.mockSent.filter((m) => /You are confirmed/.test(m.body) && MINE.test(m.body));
check("worker: exactly one confirmation text, to the chosen caregiver's number (ending 0101), none to Blair", conf.length === 1 && conf[0].to.endsWith("0101") && !r2.mockSent.some((m) => m.to.endsWith("0102") && /You are confirmed/.test(m.body)), JSON.stringify(r2.mockSent.map((m) => [m.to, m.body.slice(0, 40)])));
await op.goto("https://localhost/notifications"); await settle(op, 1200);
const hist = (await op.getByTestId("sms-history").innerText()).replace(/\s+/g, " ");
check("owner: the history lists the confirmation (ending 0101) and the two offers, as Sent (test sender); no full numbers", /Confirmation · caregiver ending 0101/.test(hist) && (hist.match(/Open-shift offer/g) ?? []).length >= 2 && /Sent \(test sender\)/.test(hist) && !/\+1951/.test(hist), hist);
await op.screenshot({ path: `${out}/06-owner-sms-history.png`, fullPage: true });

fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED:\n- ` + fails.join("\n- ") : `\nALL ${results.length} CHECKS PASSED`);
process.exit(fails.length ? 1 : 0);
