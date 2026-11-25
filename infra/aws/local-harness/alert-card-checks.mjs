// Browser checks of the open-shift ALERT on the LOCAL harness, SYNTHETIC data only: the short card (service city, date, time, service once; status; one primary action; overflow menu), View shift opens the
// exact shift, the shift page states (Request / Requested / Filled), and the office queue (shift start, request times in Pacific time, request order) on a PHONE-sized screen.
// Needs: harness:setup, seed-open-shift.ts, harness:build, harness:serve. node alert-card-checks.mjs <outdir>
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const fails = []; const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); if (!ok) fails.push(name + (detail ? ": " + detail : "")); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + String(detail).slice(0, 200) : "")); };
const MINE = /5:00 AM.{1,3}5:50 AM/;
const PHONE = { width: 390, height: 844 }, DESKTOP = { width: 1360, height: 900 };
async function login(persona, viewport, startAt = "/") {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true, hasTouch: viewport.width < 600, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto("https://localhost" + startAt);
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText(persona, { exact: false }).first().click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(900);
  return { ctx, page };
}
const settle = (page, ms = 900) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(ms));
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const big = async (loc) => { const b = await loc.boundingBox(); return !!b && b.height >= 44 && b.width >= 44; };
const sweep = () => JSON.parse(execFileSync("pnpm", ["exec", "tsx", "local-harness/run-open-shift-sweep.ts"], { cwd: new URL("..", import.meta.url).pathname, env: process.env, encoding: "utf8" }).trim().split("\n").pop());
const FORBID = /Demo (Vega|Okafor|Tanaka|Rivera|Lindqvist|Brightwater|Nakamura)|CL-\d|92596|Street|Temecula/;

sweep();   // the alert run creates the in-app alerts

// ---- 1. Alex on a phone: the card ------------------------------------------------------------------------------------------------------------------------
const alex = await login("Alex Caregiver", PHONE); const ap = alex.page;
await ap.goto("https://localhost/notifications"); await settle(ap, 1200);
const card = ap.getByTestId("center-item").filter({ hasText: "Winchester" }).filter({ hasText: MINE }).first();
const text = (await card.innerText()).replace(/\s+/g, " ");
check("card: title is 'Open shift in Winchester', date and time and service appear once", /Open shift in Winchester/.test(text) && (text.match(/5:00 AM/g) ?? []).length === 1 && (text.match(/Winchester/g) ?? []).length === 1, text);
check("card: no client name, client code, ZIP, street or office name", !FORBID.test(text), text);
check("card: status is visible before tapping", /Open — you can request it/.test(text));
check("card: one unread dot", (await card.getByTestId("unread-dot").count()) === 1);
const view = card.getByRole("link", { name: "View shift" });
check("card: View shift is the primary action and easy to tap (>=44px)", (await view.count()) === 1 && (await big(view)));
check("card: Mark read and Archive are not on the card", (await card.getByRole("button", { name: "Mark read" }).count()) === 0 && (await card.getByRole("button", { name: "Archive" }).count()) === 0);
const more = card.getByRole("button", { name: "More actions" });
check("card: the overflow button is easy to tap", await big(more));
await more.click();
check("card: the menu offers Mark read and Archive", (await ap.getByRole("menuitem", { name: "Mark read" }).count()) === 1 && (await ap.getByRole("menuitem", { name: "Archive" }).count()) === 1);
await ap.screenshot({ path: `${out}/01-card-menu-phone.png` });
await ap.keyboard.press("Escape");
check("card: no horizontal scroll and the date and time are fully on screen", (await noHScroll(ap)) && !!(await card.getByTestId("center-when").boundingBox()) );
await ap.screenshot({ path: `${out}/02-notifications-phone.png` });

// ---- 2. View shift opens the exact shift --------------------------------------------------------------------------------------------------------------------
await view.click(); await settle(ap, 1500);
check("View shift: the address carries the shift", /\/my-shifts\?shift=[0-9a-f-]{36}/.test(ap.url()), ap.url());
const first = ap.getByTestId("alert-shift");
check("shift page: the shift from the alert is shown first with Request this shift", (await first.count()) === 1 && /the shift from your alert/i.test(await first.innerText()) && (await first.getByRole("button", { name: "Request this shift" }).count()) === 1);
check("shift page: the coordinating office is on this page", /Coordinated by Temecula Office/.test(await first.innerText()));
await first.getByRole("button", { name: "Request this shift" }).click(); await settle(ap, 1200);
check("shift page: after requesting it says Requested — waiting for the office", /Requested — waiting for the office/.test(await ap.getByTestId("alert-shift").innerText()));
await ap.screenshot({ path: `${out}/03-shift-page-requested-phone.png` });
await ap.goto("https://localhost/notifications"); await settle(ap, 1200);
check("card: now shows Requested — waiting for the office", /Requested — waiting for the office/.test(await ap.getByTestId("center-item").filter({ hasText: MINE }).first().innerText()));

// ---- 3. a signed-out visitor following a link lands on that shift --------------------------------------------------------------------------------------------
const shiftUrl = (await (async () => { await ap.goto("https://localhost/notifications"); await settle(ap, 800); const href = await ap.getByTestId("center-item").filter({ hasText: MINE }).first().getByRole("link", { name: "View shift" }).getAttribute("href"); return href; })());
const blair = await login("Blair Caregiver", PHONE, shiftUrl); const bp = blair.page;
check("link after sign-in: the exact shift opens (not the home page)", /\/my-shifts\?shift=/.test(bp.url()) && (await bp.getByTestId("alert-shift").count()) === 1, bp.url());
await bp.getByTestId("alert-shift").getByRole("button", { name: "Request this shift" }).click(); await settle(bp, 1200);

// ---- 4. the office queue ---------------------------------------------------------------------------------------------------------------------------------------
const mgr = await login("Morgan Manager", DESKTOP); const mp = mgr.page;
await mp.goto("https://localhost/schedule"); await settle(mp, 1500);
const panel = mp.getByTestId("pickup-requests");
const qtext = (await panel.innerText()).replace(/\s+/g, " ");
check("office: one card for the shift with 'Shift starts … PT'", (await panel.getByTestId("pickup-shift").count()) === 1 && /Shift starts .+ PT/.test(qtext), qtext.slice(0, 200));
const asked = await panel.getByTestId("pickup-asked").allInnerTexts();
check("office: both requests show the date and time they were made in Pacific time, first asked first", asked.length === 2 && asked.every((t) => /^Asked .+ PT$/.test(t)), asked.join(" | "));
const order = await panel.getByTestId("pickup-choice").evaluateAll((els) => els.map((e) => e.closest("li").innerText.replace(/\s+/g, " ")));
check("office: numbered in the order they asked (Alex 1, Blair 2) with the earliest eligible marked on Alex", /^1\. Alex/.test(order[0]) && /^2\. Blair/.test(order[1]) && /Earliest eligible request/.test(order[0]) && !/Earliest eligible request/.test(order[1]), order.join(" || "));
await mp.screenshot({ path: `${out}/04-office-queue.png`, fullPage: true });
await panel.getByRole("button", { name: "Confirm assignment" }).click(); await settle(mp, 1500);

// ---- 5. after the office confirms ------------------------------------------------------------------------------------------------------------------------------
await bp.goto("https://localhost" + shiftUrl); await settle(bp, 1500);
const bs = (await bp.getByTestId("alert-shift-status").innerText()).replace(/\s+/g, " ");
check("other caregiver: the shift page says Filled, with no Request button", /^Filled\./.test(bs) && (await bp.getByTestId("alert-shift").count()) === 0 && (await bp.getByRole("listitem").filter({ hasText: MINE }).getByRole("button", { name: "Request this shift" }).count()) === 0, bs);
await bp.goto("https://localhost/notifications"); await settle(bp, 1200);
const bc = (await bp.getByTestId("center-item").filter({ hasText: MINE }).first().getByTestId("center-status").innerText()).trim();
check("other caregiver: the card status reads Filled", bc === "Filled", bc);
await bp.screenshot({ path: `${out}/05-filled-card-phone.png` });
await ap.goto("https://localhost" + shiftUrl); await settle(ap, 1500);
check("selected caregiver: the shift page says they are confirmed", /confirmed for this shift/.test(await ap.getByTestId("alert-shift-status").innerText()));

fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED:\n- ` + fails.join("\n- ") : `\nALL ${results.length} CHECKS PASSED`);
process.exit(fails.length ? 1 : 0);
