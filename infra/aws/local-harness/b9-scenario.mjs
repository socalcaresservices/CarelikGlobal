// B9 regression spot-check (release 2026-10-30-caregiver-readiness): executes docs/releases/2026-10-30-caregiver-readiness/B9_REGRESSION_WORKSHEET.md step by step
// on the LOCAL harness (real production bundle, real API handler, local PostgreSQL, stand-in sign-in). SYNTHETIC data only.
// Run after `harness:setup`, `harness:seed-extra`, `harness:seed-scenario`, `harness:build`, `harness:serve`:  node b9-scenario.mjs <outdir>
// Data is changed through the screens only; psql is used only to READ evidence. Writes <outdir>/b9-results.json and screenshots <step>-<persona>.png.
// Rule from the worksheet: any product FAIL stops the run; later steps are recorded NOT RUN. A script error is reported separately and is NOT a product result.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const out = process.argv[2] ?? "./b9"; fs.mkdirSync(out, { recursive: true });
const DESKTOP = { width: 1280, height: 900 }, PHONE = { width: 390, height: 844 };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] }).catch(() => chromium.launch({ args: ["--no-sandbox"] }));
const PSQL = process.env.B9_PSQL_URL ?? "postgres://postgres@127.0.0.1:55432/ogevia_local_harness";
const psql = (sql) => execFileSync("psql", [PSQL, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", `set default_transaction_read_only = on; ${sql}`], { encoding: "utf8" }).split("\n").filter(Boolean).pop() ?? "";

const VEGA_CODE = psql("select c.client_code from ogevia.clients c join ogevia.client_private_names n on n.client_id = c.id where n.legal_last_name = 'Vega'");
const VEGA_BY_CODE = new RegExp(VEGA_CODE.replace(/[-]/g, "\\-"));
const results = []; let stopped = false; let scriptErrors = []; let firstFail = null;
const CONTINUE = process.env.B9_CONTINUE === "1"; // information run: keep going after a product FAIL (results after it are marked `afterStop`); the worksheet's rule is to stop
const problems = []; // unexpected console / page errors and 4xx/5xx, per session
let current = null;
const ERROR_SCREEN = /Something went wrong|Unexpected (application )?error|Page not found|Application error|Unable to check|could not be loaded|Cannot read prop/i;
const settle = async (page, ms = 700) => { await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(ms); };
const mainText = (page) => page.evaluate(() => (document.querySelector("main") ?? document.body).innerText);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const go = async (page, path, ms = 900) => { await page.goto(`https://localhost${path}`); await settle(page, ms); };
async function pick(select, re) {
  let labels = [];
  for (let i = 0; i < 12; i++) { labels = (await select.locator("option").allTextContents()).map((x) => x.trim()); if (labels.some((x) => re.test(x))) break; await select.page().waitForTimeout(500); }
  const l = labels.find((x) => re.test(x)); if (!l) throw new Error(`no option ${re} in ${labels.join("|")}`); await select.selectOption({ label: l });
}
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const TODAY = (() => { const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const g = (t) => f.find((x) => x.type === t).value; return `${g("year")}-${g("month")}-${g("day")}`; })();

async function login(persona, vp) {
  const ctx = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  page.__persona = persona; page.__expect = [];
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const path = new URL(r.url()).pathname;
    if (page.__expect.some((re) => re.test(`${r.request().method()} ${path} ${r.status()}`))) return;
    problems.push(`${current ?? "?"} ${persona}: ${r.status()} ${r.request().method()} ${path}`);
  });
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`${current ?? "?"} ${persona}: console error ${m.text().slice(0, 140)}`); });
  page.on("pageerror", (e) => problems.push(`${current ?? "?"} ${persona}: page error ${String(e).slice(0, 140)}`));
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click({ timeout: 10000 });
  await page.getByText(persona, { exact: false }).first().click({ timeout: 10000 });
  await settle(page, 1200);
  return page;
}
// A step: fn(page) returns { ok, note } for a PRODUCT result. Throwing = SCRIPT ERROR (not a product result).
async function step(id, catalog, page, fn, { expect = [] } = {}) {
  if (stopped) { results.push({ id, catalog, result: "NOT RUN", note: "stopped after an earlier FAIL (worksheet rule)", shot: "" }); return; }
  current = id; const before = problems.length; page.__expect = expect;
  let r;
  try { r = await fn(page); }
  catch (e) { const msg = String(e).split("\n").filter((l) => l.trim()).slice(0, 4).join(" / ").slice(0, 400); scriptErrors.push(`${id}: ${msg}`); results.push({ id, catalog, result: "SCRIPT ERROR", note: msg, shot: "" }); await page.screenshot({ path: `${out}/${id}-scripterror.png`, fullPage: true }).catch(() => {}); stopped = true; return; }
  const unexpected = problems.slice(before);
  const shotName = `${id}-${page.__persona.split(" ")[0]}.png`;
  await page.screenshot({ path: `${out}/${shotName}`, fullPage: true }).catch(() => {});
  let ok = r.ok; let note = r.note ?? "";
  if (unexpected.length) { ok = false; note += ` | UNEXPECTED: ${unexpected.join("; ")}`; }
  results.push({ id, catalog, result: ok ? "PASS" : "FAIL", note: note.trim(), shot: shotName, afterStop: !!firstFail && id !== firstFail });
  console.log(ok ? "PASS" : "FAIL", id, catalog, note.slice(0, 200));
  if (!ok) { firstFail ??= id; if (!CONTINUE) stopped = true; }
  page.__expect = [];
}

async function shiftForm(page, { client, caregiver = null, date, start, end }) {
  await go(page, "/schedule", 800);
  await page.getByRole("button", { name: "Add shift" }).click(); await page.waitForTimeout(400);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Schedule shift" }) });
  await pick(form.getByLabel("Client"), client); await pick(form.getByLabel("Service"), /Respite/); await page.waitForTimeout(1500);
  await pick(form.getByLabel(/Caregiver/), caregiver ?? /^Open shift/);
  await form.getByLabel("Date").fill(date); await form.getByLabel("Start time").fill(start); await form.getByLabel("End time").fill(end);
  await page.waitForTimeout(2500);
  return form;
}
const formBlocked = async (form) => !(await form.getByRole("button", { name: "Schedule shift" }).isEnabled());
const formText = async (form) => (await form.innerText()).replace(/\n+/g, " ");

// ============================================================ Olivia Owner
const op = await login("Olivia Owner", DESKTOP);
await step("O1", "SMK-01", op, async (p) => ({ ok: !/\/login/.test(p.url()) && !ERROR_SCREEN.test(await mainText(p)) && /Home/.test(await mainText(p)), note: `landed on ${new URL(p.url()).pathname}` }));
await step("O2", "SMK-02, DSH-02", op, async (p) => {
  await go(p, "/", 1500); const t = await mainText(p);
  const badge = (await p.getByTestId("notifications-button").innerText()).match(/\d+/)?.[0];
  const banner = (await p.getByTestId("top-issues").innerText()).match(/View all \((\d+)\)/)?.[1];
  const ok = /Needs attention now/.test(t) && /Hours this month/.test(t) && !/Unable to check/.test(t) && !!badge && badge === banner;
  return { ok, note: `hours cards and action items present; header badge ${badge}, Home 'View all' ${banner}` };
});
await step("O3", "RDY-09", op, async (p) => {
  await go(p, "/care-team", 900); await p.locator("#cg-status").selectOption("all"); await settle(p, 400);
  const t = await p.locator("table[aria-label='Caregivers']").innerText();
  return { ok: /Not ready/.test(t) && /Approved/.test(t) && /Active/.test(t) && !/Pending documents/.test(t) && /\d of 5 done/.test(t), note: "statuses: " + [...new Set(t.match(/Not ready|Approved|Active|Inactive/g))].join(", ") };
});
await step("O4", "RDY-09", op, async (p) => {
  await go(p, "/accounts", 900); const t = await p.getByRole("list", { name: "Sign-in accounts" }).innerText();
  const addOrSend = (await p.getByRole("link", { name: "Add email" }).count()) + (await p.getByRole("button", { name: "Send sign-in link" }).count());
  return { ok: /Not ready/.test(t) && /Sign-in account:/.test(t) && addOrSend >= 1, note: `Add email / Send sign-in link controls: ${addOrSend}` };
});
await step("O5", "USR-01", op, async (p) => {
  await go(p, "/", 800);
  const hrefs = [...new Set(await p.locator("nav a").evaluateAll((a) => a.map((x) => x.getAttribute("href")).filter(Boolean)))];
  const bad = [];
  for (const h of hrefs) { await go(p, h, 700); const t = await mainText(p); if (ERROR_SCREEN.test(t) || t.trim().length < 20) bad.push(`${h}: ${t.slice(0, 80)}`); }
  return { ok: bad.length === 0, note: `opened ${hrefs.length} menu items${bad.length ? "; problems: " + bad.join(" | ") : ", none showed an error screen"}` };
});
await step("O6", "CMP-15", op, async (p) => {
  await go(p, "/care-team", 900); await p.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
  const t = await mainText(p); const hit = t.match(/Readiness[\s\S]{0,300}/)?.[0]?.replace(/\n+/g, " ") ?? "";
  return { ok: /Readiness/.test(t) && /(would be held|on hold|held|Checks|enforcement|Report-only|report only)/i.test(t), note: `Readiness section: ${hit.slice(0, 230)}` };
});
await step("O7", "CMP-15", op, async (p) => {
  await go(p, "/compliance", 1200); const t = await mainText(p);
  return { ok: /hold/i.test(t) && !ERROR_SCREEN.test(t), note: `Caregiver Holds page: ${t.replace(/\n+/g, " ").slice(0, 220)}` };
});
let o8 = { shiftId: null };
await step("O8", "SCH-01", op, async (p) => {
  // find a day and a 4 h slot the form accepts for Alex on Demo Vega
  let saved = null, tried = [];
  for (let n = 2; n <= 9 && !saved; n++) {
    const day = addDays(TODAY, n);
    const form = await shiftForm(p, { client: /Demo Vega/, caregiver: /Alex/, date: day, start: "09:00", end: "13:00" });
    if (await formBlocked(form)) { tried.push(`${day}: ${(await formText(form)).match(/Blocked:.*?(?= Authorized| Details|$)/)?.[0]?.slice(0, 90) ?? "blocked"}`); continue; }
    const before = psql("select count(*) from ogevia.shifts");
    await form.getByRole("button", { name: "Schedule shift" }).click(); await p.waitForTimeout(2200);
    if (Number(psql("select count(*) from ogevia.shifts")) === Number(before) + 1) saved = day; else tried.push(`${day}: not saved`);
  }
  if (!saved) return { ok: false, note: `no accepted 4 h slot in 8 days. ${tried.join(" | ")}` };
  const row = psql(`select s.id || '|' || r.reserved_minutes from ogevia.shifts s join ogevia.authorization_reservations r on r.shift_id = s.id where s.starts_at::date >= current_date and s.caregiver_record_id = (select id from ogevia.caregiver_records where caregiver_code = 'CG-ALEX') order by s.created_at desc limit 1`);
  o8.shiftId = row.split("|")[0];
  return { ok: row.split("|")[1] === "240", note: `saved on ${saved}; reserved minutes ${row.split("|")[1]}${tried.length ? "; earlier days not accepted: " + tried.join(" | ") : ""}` };
}, { expect: [/POST \/(api\/)?v1\/(shifts|readiness).* 4\d\d/] });
await step("O9", "SCH-02", op, async (p) => {
  // Ask for MORE than the hours Demo Vega has left on a given day: read "Hours left: N h" from the form, then request N + 2 hours (a shift is at most 24 h)
  const seen = [];
  for (let n = 1; n <= 6; n++) {
    const day = addDays(TODAY, n);
    let form = await shiftForm(p, { client: /Demo Vega/, date: day, start: "00:00", end: "01:00" });
    const left = Number((await formText(form)).match(/Hours left: ([\d.]+) h/)?.[1]);
    if (!Number.isFinite(left) || left >= 22) { seen.push(`${day}: ${Number.isFinite(left) ? left + " h left, too much to exceed in one shift" : "no hours-left text"}`); continue; }
    const need = Math.ceil(left) + 2; const end = `${String(need).padStart(2, "0")}:00`;
    await form.getByLabel("End time").fill(end); await p.waitForTimeout(2500);
    const blocked = await formBlocked(form); let text = (await formText(form)).match(/Blocked:.*?(?= Authorized| Details|$)/)?.[0] ?? "";
    let saved = false;
    if (!blocked) { const before = psql("select count(*) from ogevia.shifts"); await form.getByRole("button", { name: "Schedule shift" }).click(); await p.waitForTimeout(2000); saved = Number(psql("select count(*) from ogevia.shifts")) > Number(before); text += " | " + (await p.locator('[role="status"],[role="alert"]').allInnerTexts()).join(" | "); }
    const wording = /available/i.test(text) && /need/i.test(text);
    return { ok: !saved && wording, note: `${day}: ${left} h left, requested ${need} h; ${blocked ? "refused in the form" : saved ? "SAVED (should have been refused)" : "refused on save"}: ${text.slice(0, 240)}` };
  }
  return { ok: false, note: `no day found where the hours left are small enough to exceed: ${seen.join(" | ")}` };
}, { expect: [/(POST|GET) \/(api\/)?v1\/(shifts|readiness).* 4\d\d/] });
await step("O10", "RDY", op, async (p) => {
  await go(p, "/care-team", 900); await p.locator("#cg-status").selectOption("all"); await settle(p, 300);
  await p.getByRole("link", { name: /Dana Overdue/ }).first().click(); await settle(p, 900);
  const t = await p.getByTestId("readiness-checklist").innerText();
  return { ok: (t.match(/overdue since/g) ?? []).length === 2 && (t.match(/Blocks new shift assignments|Flagged only/g) ?? []).length === 2, note: t.replace(/\n+/g, " ").slice(0, 260) };
});
await step("O11", "RDY", op, async (p) => {
  await go(p, "/care-team", 900); await p.locator("#cg-status").selectOption("all"); await settle(p, 300);
  await p.getByRole("link", { name: /Quinn WaitingOnSignIn/ }).first().click(); await settle(p, 900);
  const list = p.getByTestId("readiness-checklist");
  const dis = await list.getByRole("button", { name: "Approve" }).isDisabled(); const t = await list.innerText();
  return { ok: dis && /Waiting on: App sign-in/.test(t), note: `Approve disabled=${dis}; ${t.match(/Waiting on:[^\n]*/)?.[0]}` };
});

// ============================================================ Morgan Manager
const mp = await login("Morgan Manager", DESKTOP);
await step("M1", "SMK-01", mp, async (p) => ({ ok: !/\/login/.test(p.url()) && !ERROR_SCREEN.test(await mainText(p)), note: `landed on ${new URL(p.url()).pathname}` }));
await step("M2", "USR-01", mp, async (p) => {
  await go(p, "/care-team", 900); await p.locator("#cg-status").selectOption("all"); await settle(p, 300);
  await p.getByRole("link", { name: /Dana Overdue/ }).first().click(); await settle(p, 900);
  const n = await p.getByTestId("readiness-checklist").getByRole("button", { name: "Extend" }).count();
  return { ok: n === 0, note: `Extend buttons: ${n}` };
});
await step("M3", "USR-01", mp, async (p) => {
  await go(p, "/care-team", 900); await p.locator("#cg-status").selectOption("all"); await settle(p, 300);
  await p.getByRole("link", { name: /Reese ReadyToApprove/ }).first().click(); await settle(p, 900);
  const list = p.getByTestId("readiness-checklist");
  const btn = list.getByRole("button", { name: "Approve" }); const enabled = await btn.isEnabled();
  await btn.click(); await settle(p, 1200); const t = await list.innerText();
  const n = psql("select count(*) from ogevia.caregiver_work_approvals a join ogevia.caregiver_records r on r.id = a.caregiver_record_id where r.last_name = 'ReadyToApprove'");
  return { ok: enabled && /Approved/.test(t) && /by Morgan Manager/.test(t) && (await list.getByRole("button", { name: "Approve" }).count()) === 0 && n === "1", note: `enabled=${enabled}; ${t.match(/Approved[^\n]*/)?.[0]}; approval rows: ${n}` };
});
await step("M4", "USR-01", mp, async (p) => {
  await go(p, "/care-team", 900); await p.getByRole("button", { name: "Add caregiver" }).click(); await p.waitForTimeout(400);
  const opts = await p.getByLabel("Starting status").locator("option").evaluateAll((o) => o.map((x) => x.value));
  return { ok: JSON.stringify(opts) === JSON.stringify(["applicant", "onboarding"]), note: `starting statuses: ${opts.join(", ")}` };
});

// ============================================================ Sam Scheduler
const sp = await login("Sam Scheduler", DESKTOP);
await step("S1", "SMK-01, SMK-03", sp, async (p) => {
  await go(p, "/schedule", 1200); const t = await mainText(p);
  const add = await p.getByRole("button", { name: "Add shift" }).count();
  return { ok: !/\/login/.test(p.url()) && !ERROR_SCREEN.test(t) && /Schedul/.test(t) && add >= 1, note: `Schedule loaded; Add shift buttons: ${add}; first text: ${t.replace(/\n+/g, " ").slice(0, 120)}` };
});
await step("S2", "SCH-01", sp, async (p) => {
  let saved = null, tried = [];
  for (let n = 10; n <= 17 && !saved; n++) {
    const day = addDays(TODAY, n);
    const form = await shiftForm(p, { client: VEGA_BY_CODE, caregiver: /Alex/, date: day, start: "09:00", end: "13:00" });
    if (await formBlocked(form)) { tried.push(`${day}: blocked`); continue; }
    const before = psql("select count(*) from ogevia.shifts");
    await form.getByRole("button", { name: "Schedule shift" }).click(); await p.waitForTimeout(2200);
    if (Number(psql("select count(*) from ogevia.shifts")) === Number(before) + 1) saved = day;
  }
  const row = saved ? psql(`select r.reserved_minutes from ogevia.shifts s join ogevia.authorization_reservations r on r.shift_id = s.id order by s.created_at desc limit 1`) : "";
  return { ok: !!saved && row === "240", note: saved ? `saved on ${saved}; reserved minutes ${row}` : `no accepted slot: ${tried.join(" | ")}` };
});
await step("S3", "REC-01", sp, async (p) => {
  await go(p, "/schedule", 800); await p.getByRole("button", { name: "Repeat visits" }).click(); await p.waitForTimeout(500);
  await pick(p.getByLabel("Client"), VEGA_BY_CODE); await pick(p.getByLabel("Service", { exact: true }), /Respite/);
  for (const d of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) await p.getByLabel(d, { exact: true }).uncheck().catch(() => {});
  for (const d of ["Mon", "Tue", "Wed", "Thu"]) await p.getByLabel(d, { exact: true }).check();
  await p.getByLabel("Start time").fill("14:00"); await p.getByLabel("End time").fill("16:00");
  await p.getByLabel("First date").fill(addDays(TODAY, 20)); await p.getByLabel("Last date (optional)").fill(addDays(TODAY, 33));
  const before = psql("select count(*) from ogevia.shifts");
  await p.getByRole("button", { name: "Preview dates and hours" }).click(); await p.waitForTimeout(2200);
  const t = await mainText(p); const after = psql("select count(*) from ogevia.shifts");
  return { ok: after === before && /(ok|Ok|OK|available|reserved)/.test(t) && /(already reserved|Already reserved)/i.test(t) && /(this series|This series)/i.test(t) && /available after/i.test(t), note: `preview shown; shifts before ${before}, after ${after} (nothing saved)` };
});
await step("S4", "USR-01", sp, async (p) => {
  await go(p, "/care-team", 900); const t0 = await mainText(p);
  let controls = 0;
  if (!/do not have access/i.test(t0)) {
    await p.locator("#cg-status").selectOption("all").catch(() => {}); await settle(p, 300);
    await p.getByRole("link", { name: /Dana Overdue/ }).first().click().catch(() => {}); await settle(p, 900);
    for (const n of ["Approve", "Extend", "Add email", "Verify", "Save and send sign-in link", "Send sign-in link", "Deactivate", "Mark done"]) controls += await p.getByRole("button", { name: n }).count();
  }
  return { ok: controls === 0, note: /do not have access/i.test(t0) ? "Care Team refused for the scheduler" : `scheduler sees the page read-only; action controls visible: ${controls}` };
}, { expect: [/GET \/(api\/)?v1\/.* 403/] });

// ============================================================ Alex Caregiver (phone)
const ap = await login("Alex Caregiver", PHONE);
await step("A1", "SMK-01", ap, async (p) => ({ ok: !/\/login/.test(p.url()) && !ERROR_SCREEN.test(await mainText(p)), note: `landed on ${new URL(p.url()).pathname}` }));
await step("A2", "SMK-04", ap, async (p) => {
  await go(p, "/service-verification", 1200); const t = await mainText(p);
  const names = psql("select string_agg(legal_last_name, '|') from ogevia.client_private_names where legal_last_name is not null");
  const leaked = names ? t.match(new RegExp(names, "g")) : null;
  return { ok: /CL-[0-9A-F]+/.test(t) && !leaked && !/payer|Medicaid|UCI|date of birth/i.test(t), note: `client codes: ${(t.match(/CL-[0-9A-F]+/g) ?? []).slice(0, 3).join(", ")}; checked against ${names.split("|").length} client surnames from the database: ${leaked ? "FOUND " + leaked.join(",") : "none shown"}; no payer or identifier text` };
});
await step("A3", "SMK-05, VIS-01", ap, async (p) => {
  await go(p, "/service-verification", 1200);
  const picker = p.getByRole("button", { name: /CL-/ }).first();
  await picker.click(); await p.waitForTimeout(1500);
  // A shift that is already over today makes this an unscheduled visit: the first Start is refused (422) and the app then asks for a reason; that is the product's rule.
  const startBtn = () => p.getByRole("button", { name: /Start visit/ }).first();
  await startBtn().click(); await p.waitForTimeout(2200);
  const why = p.getByLabel(/Why is this visit not on your schedule/);
  if (await why.count()) { await why.fill("Client asked for extra help today (synthetic)"); await startBtn().click(); await p.waitForTimeout(2500); }
  const started = /Visit in progress/.test(await mainText(p));
  const tin = psql("select time_in is not null from ogevia.service_visits where caregiver_user_id = (select linked_user_id from ogevia.caregiver_records where caregiver_code = 'CG-ALEX') and status = 'draft' order by time_in desc limit 1");
  await p.waitForTimeout(65000); // a real minute of work: Time In and Time Out are server times, nothing is aged by hand
  await p.getByRole("button", { name: /End visit/ }).first().click(); await p.waitForTimeout(2800);
  const row = psql("select (time_out is not null) || '|' || (time_out > time_in) || '|' || worked_minutes from ogevia.service_visits where caregiver_user_id = (select linked_user_id from ogevia.caregiver_records where caregiver_code = 'CG-ALEX') order by time_in desc limit 1");
  await p.getByLabel("Person confirming").selectOption({ label: "Client" }).catch(() => {});
  await p.locator("label").filter({ hasText: /Sign name/ }).first().click();
  const canvas = p.locator("canvas").first(); await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox();
  await p.mouse.move(box.x + 20, box.y + 40); await p.mouse.down(); await p.mouse.move(box.x + 80, box.y + 70, { steps: 6 }); await p.mouse.move(box.x + 140, box.y + 30, { steps: 6 }); await p.mouse.up();
  await p.getByRole("checkbox", { name: /I attest/ }).check();
  await p.getByRole("button", { name: /Confirm visit/ }).click(); await p.waitForTimeout(2800);
  const st = psql("select status from ogevia.service_visits where caregiver_user_id = (select linked_user_id from ogevia.caregiver_records where caregiver_code = 'CG-ALEX') order by time_in desc limit 1");
  const ev = psql("select count(*) from ogevia.visit_confirmations c join ogevia.service_visits v on v.id = c.visit_id where v.caregiver_user_id = (select linked_user_id from ogevia.caregiver_records where caregiver_code = 'CG-ALEX') and c.signer_role = 'client'");
  return { ok: started && tin === "t" && row.startsWith("true|true|") && st !== "draft" && st !== "awaiting_signature" && Number(ev) >= 1, note: `started=${started}; server Time In set=${tin}; ended: ${row}; status after confirm: ${st}; client confirmations: ${ev}` };
}, { expect: [/POST \/(api\/)?v1\/visits 422/] });
await step("A4", "RDY-14", ap, async (p) => {
  await go(p, "/care-team", 800);
  return { ok: /do not have access to the Care Team/i.test(await mainText(p)), note: (await mainText(p)).slice(0, 80) };
}, { expect: [/GET \/(api\/)?v1\/.* 403/] });
await step("A5", "-", ap, async (p) => {
  const bad = [];
  for (const path of ["/", "/service-verification", "/my-shifts", "/care-team"]) { await go(p, path, 700); if (!(await noOverflow(p))) bad.push(path); }
  return { ok: bad.length === 0, note: bad.length ? `sideways scroll on ${bad.join(", ")}` : "no sideways scroll on /, /service-verification, /my-shifts, /care-team (390 px)" };
}, { expect: [/GET \/(api\/)?v1\/.* 403/] });

// ============================================================ Blair Caregiver (phone)
const bp = await login("Blair Caregiver", PHONE);
await step("B1", "SMK-01", bp, async (p) => ({ ok: !/\/login/.test(p.url()) && !ERROR_SCREEN.test(await mainText(p)), note: `landed on ${new URL(p.url()).pathname}` }));
await step("B2", "VIS", bp, async (p) => {
  await go(p, "/service-verification", 1400); const t = await mainText(p);
  const shows = /Visit in progress|in progress|Time In|End visit/i.test(t);
  const endBtn = p.getByRole("button", { name: /End visit/ }).first();
  if (!(await endBtn.count())) return { ok: false, note: `no End visit control. Page: ${t.replace(/\n+/g, " ").slice(0, 200)}` };
  await endBtn.click(); await p.waitForTimeout(2800);
  const after = await mainText(p);
  return { ok: shows && /Verify visit details|confirm|Confirm/i.test(after), note: `open visit shown=${shows}; after ending: ${after.replace(/\n+/g, " ").slice(0, 160)}` };
});

// ============================================================ Legacy people (Olivia)
await step("L1", "-", op, async (p) => {
  await go(p, "/care-team", 900); await p.locator("#cg-status").selectOption("all"); await settle(p, 300);
  const rows = {}; for (const n of ["CG-ALEX", "CG-BLAIR"]) { const r = p.locator("tr").filter({ hasText: n }).first(); rows[n] = (await r.count()) ? /Active|Approved/.exec(await r.innerText())?.[0] : null; }
  // the list shows names with codes: fall back to the person's name
  for (const [n, name] of [["CG-ALEX", "Alex Caregiver"], ["CG-BLAIR", "Blair Caregiver"]]) { if (!rows[n]) { const r = p.locator("tr").filter({ hasText: name }).first(); rows[n] = (await r.count()) ? /Active|Approved/.exec(await r.innerText())?.[0] : null; } }
  const assigned = psql("select count(*) from ogevia.caregiver_assignments a join ogevia.caregiver_records r on r.id = a.caregiver_record_id or r.linked_user_id = a.caregiver_user_id where r.caregiver_code in ('CG-ALEX','CG-BLAIR') and a.is_active");
  return { ok: rows["CG-ALEX"] === "Active" && rows["CG-BLAIR"] === "Active" && Number(assigned) > 0, note: `Alex: ${rows["CG-ALEX"]}; Blair: ${rows["CG-BLAIR"]}; active assignments kept: ${assigned}` };
});
await step("L2", "-", op, async (p) => {
  await go(p, "/schedule", 1200); await p.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
  const t = await mainText(p); const n = psql("select count(*) from ogevia.shifts s join ogevia.caregiver_records r on r.id = s.caregiver_record_id where r.caregiver_code = 'CG-ALEX' and s.status = 'scheduled'");
  return { ok: /Alex/.test(t) && Number(n) > 0, note: `Alex appears on the schedule; scheduled shifts held by Alex: ${n}` };
});

// ============================================================ Session-wide
const sessionOk = problems.length === 0;
results.push({ id: "SW1", catalog: "B7", result: stopped ? "NOT RUN" : sessionOk ? "PASS" : "FAIL", note: sessionOk ? "no unexpected console errors, page errors or 4xx/5xx" : problems.join(" | ").slice(0, 500), shot: "" });
const banner = await op.getByTestId("environment-banner").innerText().catch(() => "");
results.push({ id: "SW2", catalog: "-", result: stopped ? "NOT RUN" : /synthetic data only/i.test(banner) ? "PASS" : "FAIL", note: `banner: ${banner.replace(/\n/g, " ")}; seeded names are all Demo/Synthetic`, shot: "" });
fs.writeFileSync(`${out}/b9-results.json`, JSON.stringify({ today: TODAY, scriptErrors, problems, results }, null, 1));
await browser.close();
const fails = results.filter((r) => r.result === "FAIL").length, errs = scriptErrors.length;
console.log(`\nSTEPS ${results.length}: PASS ${results.filter((r) => r.result === "PASS").length}, FAIL ${fails}, SCRIPT ERROR ${errs}, NOT RUN ${results.filter((r) => r.result === "NOT RUN").length}`);
process.exit(fails || errs ? 1 : 0);
