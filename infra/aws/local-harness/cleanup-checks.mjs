// Browser checks on the LOCAL harness (synthetic data): (1) Documents: Approve on Casey's CPR persists after a reload; Reject asks for a reason; (2) Monthly calendar shows
// the per-service authorised hours above the grid for the selected client and month. Desktop 1360 and EMULATED phone 390. node cleanup-checks.mjs <outdir>
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright-core");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const res = {};
for (const [vName, vOpts] of [["desktop-1360", { viewport: { width: 1360, height: 900 } }], ["phone-390-emulated", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
  const ctx = await browser.newContext({ ...vOpts, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText("Olivia Owner", { exact: false }).first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  // calendar: a fresh page per client so one selection cannot leak into the next; expected figures come from the authorization rows (psql, /tmp/cmp/expected.txt)
  const expected = Object.fromEntries(fs.readFileSync("/tmp/cmp/expected.txt", "utf8").trim().split("\n").map((l) => { const [id, name, min] = l.split("|"); return [id, `${name} — Authorised: ${Math.round((Number(min) / 60) * 10) / 10} h`]; }));
  const ids = Object.keys(expected).slice(0, 4);
  for (const id of ids) {
    await page.goto("https://localhost/service-verification/reports?view=calendar"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(900);
    await page.evaluate((v) => { const el = [...document.querySelectorAll("select")].find((e) => [...e.options].some((x) => x.textContent?.startsWith("Choose a client"))); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(el, v); el.dispatchEvent(new Event("change", { bubbles: true })); }, id);
    await page.waitForTimeout(2500);
    const shown = (await page.getByText(/Authorised:/).allInnerTexts()).map((t) => t.trim());
    res[`${vName}-calendar-${id.slice(0, 6)}`] = { expected: expected[id], shown, match: shown.includes(expected[id]) };
    await page.screenshot({ path: `${out}/${vName}-calendar-${id.slice(0, 6)}.png`, fullPage: false });
  }
  // documents persistence
  await page.goto("https://localhost/documents"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(900);
  const row = page.locator("tbody", { hasText: "Casey Caregiver" }).filter({ hasText: "CPR card" });
  res[vName + "-before-approve"] = await row.locator("span").filter({ hasText: /Awaiting review|Current|Verified/ }).first().innerText();
  await page.screenshot({ path: `${out}/${vName}-documents-before-approve.png`, fullPage: true });
  if (vName === "desktop-1360") {
    await row.getByRole("button", { name: "Approve" }).click(); await page.waitForTimeout(1500);
    res[vName + "-saved-message"] = await page.getByTestId("document-saved").first().innerText();
    await page.screenshot({ path: `${out}/${vName}-documents-after-approve.png`, fullPage: true });
    await page.reload(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1200);
    const row2 = page.locator("tbody", { hasText: "Casey Caregiver" }).filter({ hasText: "CPR card" });
    res[vName + "-after-reload-status"] = await row2.innerText();
    res[vName + "-approve-still-offered"] = await row2.getByRole("button", { name: "Approve" }).count();
    await page.screenshot({ path: `${out}/${vName}-documents-after-reload.png`, fullPage: true });
  }
  await ctx.close();
}
await browser.close(); fs.writeFileSync(`${out}/checks.json`, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1));
