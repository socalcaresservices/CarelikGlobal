// Browser checks of the client SERVICE LOCATION section on the LOCAL harness, SYNTHETIC data only. Needs: harness:setup, seed-service-location.ts (ids in .local/service-location-ids.json), harness:build,
// harness:serve with SERVICE_LOCATION=on and COVER_ALERT_ADDRESS_RULES=on.   node service-location-checks.mjs <outdir>
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const ids = JSON.parse(fs.readFileSync(new URL("./.local/service-location-ids.json", import.meta.url), "utf8"));
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = []; const fails = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); if (!ok) fails.push(name + (detail ? ": " + detail : "")); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + String(detail).slice(0, 170) : "")); };
async function login(persona, viewport) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true, hasTouch: viewport.width < 600 });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText(persona, { exact: false }).first().click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  return { ctx, page };
}
const settle = (page, ms = 900) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(ms));
const sweep = () => JSON.parse(execFileSync("pnpm", ["exec", "tsx", "local-harness/run-open-shift-sweep.ts"], { cwd: new URL("..", import.meta.url).pathname, env: process.env, encoding: "utf8" }).trim().split("\n").pop());

// ---- 1. Demo Today A as the Administrator: the confusing state, then the fix ----------------------------------------------------------------------------------
const owner = await login("Olivia Owner", { width: 1360, height: 900 }); const op = owner.page;
await op.goto(`https://localhost/clients/${ids.todayA}`); await settle(op, 1500);
const card = op.getByTestId("service-location");
check("Today A: one Service location section with the address, county and office together", (await card.count()) === 1);
check("Today A (before): Winchester, CA 92596 · County not set · No coordinating office", /Winchester, CA 92596 · County not set · No coordinating office/.test(await card.getByTestId("location-summary").innerText()));
const details = op.getByTestId("details-readonly");
const dt = await details.innerText();
check("Today A: Details no longer says 'No city' and has no separate City field", !/No city/.test(dt) && !/^City$/m.test(dt), dt.replace(/\s+/g, " "));
await op.screenshot({ path: `${out}/01-today-a-before.png`, fullPage: true });
await card.getByTestId("location-edit").click(); await settle(op, 500);
const form = op.getByTestId("location-form");
check("Today A: the form starts from the saved Winchester / 92596", (await form.getByLabel("City of the service address").inputValue()) === "Winchester" && (await form.getByLabel("ZIP code").inputValue()) === "92596");
const sug = await form.getByTestId("county-suggestion").innerText().catch(() => "");
check("Today A: Riverside County is SUGGESTED from the agency's other client with this ZIP, and the office is not preselected", /Suggested: Riverside County \(from other clients with this ZIP\)/.test(sug) && (await form.getByLabel("Coordinating office").inputValue()) === "", sug);
await form.getByRole("button", { name: "Use this" }).click();
await form.getByLabel("Coordinating office").selectOption({ label: "Temecula" });
await form.getByRole("button", { name: "Save service location" }).click(); await settle(op, 1500);
const after = await op.getByTestId("location-summary").innerText();
check("Today A (after): Winchester, CA 92596 · Riverside County · Temecula office", /Winchester, CA 92596 · Riverside County · Temecula office/.test(after), after);
await op.screenshot({ path: `${out}/02-today-a-after.png`, fullPage: true });
await op.reload(); await settle(op, 1500);
check("Today A: the saved values persist after a reload and Details still has no 'No city'", /Riverside County · Temecula office/.test(await op.getByTestId("location-summary").innerText()) && !/No city/.test(await op.getByTestId("details-readonly").innerText()));
// the Details edit has no City or ZIP field and saves without asking for them
const editBtn = op.getByRole("button", { name: /Edit details/ }); if (!(await editBtn.isVisible())) await op.locator("details#details > summary").click();
await editBtn.click(); await settle(op, 500);
check("Today A: the Details edit form has no City or ZIP field", (await op.getByLabel(/City/).count()) === 0 && (await op.getByLabel(/ZIP code/).count()) === 0);
await op.getByRole("button", { name: "Save details" }).click(); await settle(op, 1200);
check("Today A: saving Details does not ask for a city and keeps the service address", !(await op.getByRole("alert").count()) && /Winchester, CA 92596/.test(await op.getByTestId("location-summary").innerText()));

// ---- 2. matching uses Winchester while Temecula handles the request ---------------------------------------------------------------------------------------------
const r1 = sweep();
const alex = await login("Alex Caregiver", { width: 390, height: 844 }); const ap = alex.page;
await ap.goto("https://localhost/notifications"); await settle(ap, 1200);
const items = (await ap.getByTestId("center-item").allInnerTexts()).join(" / ").replace(/\s+/g, " ");
check("open-shift alert: the subject says Winchester and the body names Temecula as the coordinating office (the shift itself had no office set)", /Open shift in Winchester \|/.test(items) && /Coordinating office: Temecula/.test(items), items);
await ap.goto("https://localhost/my-shifts"); await settle(ap, 1500);
const board = (await ap.getByRole("heading", { name: "Open shifts you can ask for" }).locator("xpath=ancestor::section[1]").innerText()).replace(/\s+/g, " ");
check("caregiver board: the Today A shift shows Winchester and 'Coordinated by Temecula'", /Winchester/.test(board) && /Coordinated by Temecula/.test(board), board);
check("no horizontal scroll on the phone", await ap.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await ap.screenshot({ path: `${out}/03-alex-board-phone.png` });

// ---- 3. an incomplete address says what is missing and the link opens the edit form --------------------------------------------------------------------------------
await op.goto(`https://localhost/clients/${ids.todayB}`); await settle(op, 1500);
const miss = await op.getByTestId("location-missing").innerText().catch(() => "");
check("Today B (city, no ZIP): says exactly what is missing", /missing the ZIP code\./.test(miss) && !/city/.test(miss), miss);
check("Today B: the summary names the gaps", /Hemet/.test(await op.getByTestId("location-summary").innerText()) && /County not set · No coordinating office/.test(await op.getByTestId("location-summary").innerText()));
await op.goto(`https://localhost/clients/${ids.todayB}?edit=location#service-location`); await settle(op, 1500);
check("Today B: the link opens the edit form directly, with the ZIP empty", (await op.getByTestId("location-form").count()) === 1 && (await op.getByLabel("ZIP code").inputValue()) === "");
await op.getByRole("button", { name: "Save service location" }).click(); await settle(op, 500);
check("Today B: saving without a ZIP is refused with the exact message", /Enter the 5-digit ZIP code of the service address\./.test(await op.getByRole("alert").innerText()));
await op.getByLabel("ZIP code").fill("92596"); await op.getByLabel("Service county").selectOption({ label: "Riverside County" });
await op.getByLabel("Coordinating office").selectOption({ label: "Murrieta" });
await op.getByRole("button", { name: "Save service location" }).click(); await settle(op, 1500);
await op.screenshot({ path: `${out}/dbg-today-b.png`, fullPage: true });
const alertText = await op.getByRole("alert").first().innerText().catch(() => "");
const summaryB = await op.getByTestId("location-summary").innerText({ timeout: 5000 }).catch(() => "(no summary) alert: " + alertText);
check("Today B: after completing it, the summary is Hemet, CA 92596 · Riverside County · Murrieta office", /Hemet, CA 92596 · Riverside County · Murrieta office/.test(summaryB), summaryB);
await op.screenshot({ path: `${out}/04-today-b-complete.png`, fullPage: true });

fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED:\n- ` + fails.join("\n- ") : `\nALL ${results.length} CHECKS PASSED`);
process.exit(fails.length ? 1 : 0);
