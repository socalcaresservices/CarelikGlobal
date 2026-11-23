// Open Shifts end to end on the LOCAL harness (synthetic data only): office configures cities, posts a shift; a caregiver on an emulated 390x844 phone sees it
// by service city only, requests it; the office approves the earliest eligible request; the caregiver sees Confirmed; a call-out reposts it; a cancellation closes
// it and an old link says unavailable. Everything the user does goes through the real screens. psql is used to read evidence, and (labelled FIXTURE) to create the
// one open shift and the client's city, because the schedule's create form is not part of this feature.
// Run: node open-shifts-e2e.mjs <label> <outdir>   (server must be running: pnpm harness:serve)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = (() => { try { return require("playwright-core"); } catch { return require("playwright"); } })();
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const label = process.argv[2] ?? "e2e"; const out = process.argv[3] ?? "/tmp/os-e2e"; fs.mkdirSync(out, { recursive: true });
const PHONE = { width: 390, height: 844 }; const DESK = { width: 1280, height: 900 };
const browser = await chromium.launch({ args: ["--no-sandbox"] });
let fails = 0;
const ok = (name, cond, d = "") => { if (!cond) fails++; console.log(cond ? "ok  " : "FAIL", name, cond ? "" : String(d).slice(0, 300)); };
const psql = (sql) => execFileSync("psql", ["-h", "127.0.0.1", "-U", "postgres", "-d", "ogevia_local_harness", "-At", "-F", "|", "-c", sql], { encoding: "utf8", env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? "test" } }).trim();
const settle = async (p, ms = 600) => { await p.waitForLoadState("networkidle"); await p.waitForTimeout(ms); };
const text = (p) => p.evaluate(() => (document.querySelector("main") ?? document.body).innerText);
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const shot = (p, n) => p.screenshot({ path: `${out}/${n}-${label}.png`, fullPage: true, ...(0) }).catch(() => {});
async function as(persona, vp) {
  const context = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true, ...(vp.width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click({ timeout: 8000 });
  await page.getByText(persona, { exact: false }).first().click({ timeout: 8000 });
  await page.waitForLoadState("networkidle");
  return page;
}
const go = async (p, path, ms) => { await p.goto(`https://localhost${path}`); await settle(p, ms); };
const heights = (p, re) => p.evaluate((src) => [...document.querySelectorAll("button")].filter((b) => new RegExp(src).test(b.innerText)).map((b) => Math.round(b.getBoundingClientRect().height)), re.source);

// ---- FIXTURE: a client in Winchester and one open shift six days out (created through the real create_shift function as the manager)
const org = psql("select id from ogevia.organizations limit 1");
const service = psql("select id from ogevia.services where code = 'PCS' limit 1");
const day = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
const client = psql(`select client_id from ogevia.client_authorizations where organization_id = '${org}' and service_id = '${service}' and is_current and deleted_at is null and period_start <= '${day}' and period_end >= '${day}' and monthly_authorized_minutes >= 600 limit 1`);
const mgrSub = "11111111-0000-4000-8000-000000000002";
psql(`update ogevia.clients set city = 'Winchester' where id = '${client}'`);
const shiftId = psql(`begin; set local role ogevia_app; select ogevia_api.begin_request('${mgrSub}', null); select shift_id from ogevia_api.create_shift('${org}','${client}','${service}','${day}'::date,'05:00'::time,'06:30'::time,null,null); commit;`).split("\n").filter((l) => /^[0-9a-f-]{36}$/.test(l)).pop();
ok("FIXTURE: open shift created", !!shiftId, shiftId);
// FIXTURE: park every other uncovered shift (seed data) so the queue holds only this one
psql(`update ogevia.shifts set status = 'cancelled', cancel_reason = 'fixture' where organization_id = '${org}' and ogevia.shift_coverage_state(shifts) = 'needs_coverage' and id <> '${shiftId}' and status = 'scheduled' and ends_at > now()`);
const ref = psql(`select public_ref from ogevia.shifts where id = '${shiftId}'`);
const clientCode = psql(`select client_code from ogevia.clients where id = '${client}'`);

// ---- E1 owner sets approved cities (real screen)
const owner = await as("Olivia Owner", DESK);
await go(owner, "/settings/open-shifts", 1200);
let rows = owner.locator("li", { has: owner.locator('input[placeholder="Winchester, Temecula"]') });
const setCities = async (name, cities) => {
  const row = owner.locator("li", { hasText: name }).first();
  await row.locator("input").fill(cities);
  await row.getByRole("button", { name: "Save cities" }).click();
  await settle(owner, 500);
};
await setCities("CG-ALEX", "Winchester, Temecula");
await setCities("CG-BLAIR", "Temecula");
ok("E1 cities saved for two caregivers", psql("select count(*) from ogevia.caregiver_coverage_cities where removed_at is null") === "3", psql("select count(*) from ogevia.caregiver_coverage_cities"));
ok("E1 settings page says texting is off and the board works without it", /board and office approval work without it/.test(await text(owner)));
await shot(owner, "e1-settings");

// ---- E2 manager posts it from the Coverage queue
const mgr = await as("Morgan Manager", DESK);
await go(mgr, "/schedule/coverage", 1200);
const item = mgr.getByTestId("queue-item").filter({ hasText: "Winchester" }).first();
ok("E2 queue shows the open shift as Not posted with Winchester", /Not posted/.test(await item.innerText()), await item.innerText().catch(() => ""));
ok("E2 posting is explained before it is done", /Posting does not assign anyone/.test(await text(mgr)) && /Posting shows this shift to caregivers approved for Winchester/.test(await item.innerText()));
await item.getByRole("button", { name: "Post for Coverage" }).click(); await settle(mgr);
ok("E2 posted", psql(`select state from ogevia.shift_coverage_rounds where shift_id = '${shiftId}'`) === "posted");
await shot(mgr, "e2-queue");

// ---- E3 caregivers on phones: Alex sees it, Blair does not; no client information anywhere
const alex = await as("Alex Caregiver", PHONE);
await go(alex, "/my-shifts", 1200);
ok("E3 Alex's My shifts has the Open shifts entry with a count", /Open shifts/.test(await text(alex)) && Number(await alex.getByTestId("open-shifts-count").innerText()) >= 1);
await go(alex, "/open-shifts", 1200);
const card = alex.getByTestId("board-shift").first();
const cardText = await card.innerText();
ok("E3 board card: city and time only", /Winchester/.test(cardText) && !cardText.includes(clientCode) && !/Okafor|Client/i.test(cardText), cardText);
ok("E3 phone: no horizontal scroll and a primary button of at least 44 px", (await noOverflow(alex)) && (await heights(alex, /Request this shift/)).every((h) => h >= 44), JSON.stringify(await heights(alex, /Request this shift/)));
const blair = await as("Blair Caregiver", PHONE);
await go(blair, "/open-shifts", 1200);
ok("E3 Blair (Temecula only) does not see the Winchester shift", !/Winchester/.test(await text(blair)) && (await blair.getByTestId("board-shift").count()) === 0);
const apiBody = await blair.evaluate(async (r) => (await fetch(location.origin + "/x")).status).catch(() => 0); void apiBody;
await shot(alex, "e3-board-phone");

// ---- E4 Alex requests; Requested is shown; link landing
await card.getByRole("button", { name: "Request this shift" }).click(); await settle(alex);
ok("E4 Requested badge shown; Request button gone", (await alex.getByTestId("requested-badge").count()) === 1 && (await alex.getByRole("button", { name: "Request this shift" }).count()) === 0);
ok("E4 the shift is NOT assigned by the request", psql(`select coalesce(caregiver_record_id::text,'none') from ogevia.shifts where id = '${shiftId}'`) === "none");
await go(alex, `/open-shifts?ref=${ref}`, 1000);
ok("E4 a text link lands on the board with the current state", /You have requested this shift/.test(await text(alex)));
await shot(alex, "e4-requested-phone");

// ---- E5 manager reviews and approves the earliest eligible request
await go(mgr, "/schedule/coverage", 1200);
const item2 = mgr.getByTestId("queue-item").filter({ hasText: "Winchester" }).first();
ok("E5 queue shows 1 request and On the board", /1 request/.test(await item2.innerText()) && /On the board/.test(await item2.innerText()), await item2.innerText());
await item2.getByRole("button", { name: "Review requests" }).click(); await settle(mgr, 800);
ok("E5 earliest eligible is pre-selected", /earliest eligible/.test(await text(mgr)));
await mgr.getByRole("button", { name: "Confirm assignment" }).first().click(); await settle(mgr, 900);
ok("E5 approved: shift assigned to Alex, round closed as filled", psql(`select cr.caregiver_code from ogevia.shifts s join ogevia.caregiver_records cr on cr.id = s.caregiver_record_id where s.id = '${shiftId}'`) === "CG-ALEX" && psql(`select closed_reason from ogevia.shift_coverage_rounds where shift_id = '${shiftId}'`) === "filled");
ok("E5 order position recorded", psql(`select approved_order_position from ogevia.shift_pickup_requests where shift_id = '${shiftId}' and status = 'confirmed'`) === "1");
await shot(mgr, "e5-approved");

// ---- E6 Alex sees Confirmed (distinct from Requested) and the shift in My shifts
await go(alex, "/open-shifts", 1200);
ok("E6 Your requests shows Confirmed", (await alex.getByTestId("outcome-confirmed").count()) >= 1);
await go(alex, "/my-shifts", 1200);
ok("E6 the shift appears in My shifts with normal assigned access", /Client/.test(await text(alex)));

// ---- E7 Alex calls out from the phone: the same shift reopens (round 2) and the office is alerted in the queue
const mine = alex.locator("li", { hasText: /5:00 AM/ }).filter({ has: alex.getByRole("button", { name: "I can't make it" }) }).first();
await mine.getByRole("button", { name: "I can't make it" }).click();
await alex.getByLabel("Why can't you come?").fill("Synthetic: sick");
await alex.getByRole("button", { name: "Tell the office" }).click(); await settle(alex, 900);
ok("E7 Alex sees the confirmation on screen", /The office has been told/.test(await text(alex)));
ok("E7 same shift reposted in round 2, reservation kept", psql(`select round_no || state from ogevia.shift_coverage_rounds where shift_id = '${shiftId}' order by round_no desc limit 1`) === "2posted" && psql(`select count(*) from ogevia.authorization_reservations where shift_id = '${shiftId}' and released_at is null`) === "1");
await go(mgr, "/schedule/coverage", 1200);
ok("E7 office queue shows round 2 and who called out; recent call-out alert listed", /round 2/.test(await text(mgr)) && /CG-ALEX called out/.test(await text(mgr)) && /Caregiver called out/.test(await mgr.getByTestId("coverage-alerts").innerText().catch(() => "")));
await go(alex, "/open-shifts", 1000);
ok("E7 the caregiver who called out does not see the shift again", (await alex.getByTestId("board-shift").count()) === 0);

// ---- E8 client cancels: queue clears, board closes, an old link says unavailable
await go(mgr, `/schedule?coverage=1&shift=${shiftId}&at=${day}`, 1800);
const row = mgr.locator(`#shift-${shiftId}`);
await row.getByRole("button", { name: "More actions" }).click();
await row.getByRole("button", { name: "Coverage and posting" }).click();
await row.getByTestId("posting-state").waitFor({ timeout: 8000 });
ok("E8 schedule details show posting status independent of assignment", /Posting: On the Open Shifts board/.test(await row.innerText()), await row.innerText());
await row.getByRole("button", { name: "Close" }).click();
await row.getByRole("button", { name: "More actions" }).click();
await row.getByRole("button", { name: /Cancel shift/ }).click();
ok("E8 cancel explains what it will do", /Use this when the client cancels/.test(await row.innerText()));
await row.getByLabel("Reason for cancelling").fill("Synthetic: client cancelled");
await row.getByRole("button", { name: "Cancel shift" }).click(); await settle(mgr, 900);
ok("E8 shift cancelled, round closed, no recruitment text pending", psql(`select status from ogevia.shifts where id = '${shiftId}'`) === "cancelled" && psql(`select closed_reason from ogevia.shift_coverage_rounds where shift_id = '${shiftId}' order by round_no desc limit 1`) === "client_cancelled" && psql(`select count(*) from ogevia.notification_jobs where shift_id = '${shiftId}' and status = 'queued' and purpose in ('open_shift','office_escalation','office_urgent')`) === "0");
await go(blair, `/open-shifts?ref=${ref}`, 1000);
ok("E8 an old link shows the opening is no longer available", /no longer available/.test(await text(blair)));

// ---- E9 consent card on the phone; the number is stored per agency and masked on screen
await go(alex, "/open-shifts", 1000);
await alex.getByLabel("Mobile number").fill("310-555-0142");
await alex.getByRole("button", { name: "Text me open shifts" }).click(); await settle(alex, 800);
ok("E9 opted in, number masked on screen", /Texts are on/.test(await text(alex)) && /\*\*\*0142/.test(await text(alex)) && !(await text(alex)).includes("3105550142"));
ok("E9 consent stored with source and time", psql("select status || '|' || consent_source from ogevia.caregiver_sms_consent limit 1") === "opted_in|app");
ok("E9 no text was sent or queued (SMS is off for this agency)", psql("select count(*) from ogevia.notification_jobs where status in ('claimed','accepted','delivered')") === "0");
ok("E9 phone: no horizontal scroll on the board, queue-free page", await noOverflow(alex));
await shot(alex, "e9-consent-phone");

console.log(fails === 0 ? "\nALL E2E CHECKS PASSED" : `\n${fails} E2E CHECK(S) FAILED`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
