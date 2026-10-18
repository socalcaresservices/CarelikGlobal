// End-to-end healthcare-agency workflows on the LOCAL harness (synthetic data only): node workflows.mjs <label> <outdir>; office personas on desktop, the caregiver on an emulated 390x844 phone
// Run through run-browser-pass.sh <label> <outdir> workflows.mjs (resets the local database first). Needs playwright-core.
// Each check is tagged W1..W9 (workflow) or F (form-state). It prints one summary line per workflow at the end.
// Everything is created through the real screens; psql is used only to READ evidence (never to change app data) except the second
// organization, which is inserted directly because no screen can create an organization.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const label = process.argv[2] ?? "workflows"; const out = process.argv[3] ?? "/tmp/wf-out"; fs.mkdirSync(out, { recursive: true });
const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
const VP = { width: 1280, height: 900 }; // office personas: desktop. Caregiver steps always use PHONE below (emulated 390x844).
const PHONE = { width: 390, height: 844 };
const TAG = [...Array(3)].map(() => "abcdefghjkmnpqrstuvwxyz"[Math.floor(Math.random() * 23)]).join("");
const CLIENT_LAST = `Workflow${TAG}`; const CLIENT_NAME = `Wendy ${CLIENT_LAST}`;
const CG_LAST = `Onboard${TAG}`;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });

// ---------- reporting
let cur = "W?"; const tally = {}; const defects = [];
const rec = (name, ok, d = "") => { const t = (tally[cur] ??= { ok: 0, fail: 0 }); ok ? t.ok++ : t.fail++; console.log(ok ? "ok  " : "FAIL", `[${label}][${cur}]`, name, ok ? "" : String(d).slice(0, 300)); };
const note = (s) => console.log("note", `[${label}][${cur}]`, s);
const W = (id, title) => { cur = id; console.log(`\n=== ${id} ${title}`); };
const run = (id) => only.length === 0 || only.includes(id);

// ---------- helpers
const psql = (sql) => execFileSync("psql", ["-h", "127.0.0.1", "-U", "postgres", "-d", "ogevia_local_harness", "-At", "-F", "|", "-c", sql], { encoding: "utf8" }).trim();
const settle = async (page, ms = 700) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(ms); };
const text = (page) => page.evaluate(() => document.body.innerText);
const mainText = (page) => page.evaluate(() => (document.querySelector("main") ?? document.body).innerText);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const openAll = (page) => page.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
const shot = (page, name) => page.screenshot({ path: `${out}/${name}-${label}.png`, fullPage: true }).catch(() => {});
async function login(page, persona) {
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click({ timeout: 8000 });
  await page.getByText(persona, { exact: false }).first().click({ timeout: 8000 });
  await page.waitForLoadState("networkidle");
}
const ctxs = [];
async function as(persona, vp = VP) {
  const context = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true }); ctxs.push(context);
  const page = await context.newPage();
  page.on("dialog", (d) => { page.__dialogs = [...(page.__dialogs ?? []), `${d.type()}:${d.message()}`]; void d.accept(); });
  await login(page, persona);
  return page;
}
const go = async (page, path, ms = 900) => { await page.goto(`https://localhost${path}`); await settle(page, ms); };
async function pick(select, re) {
  let labels = [];
  for (let i = 0; i < 12; i++) { labels = (await select.locator("option").allTextContents()).map((x) => x.trim()); if (labels.some((x) => re.test(x))) break; await select.page().waitForTimeout(500); }
  const l = labels.find((x) => re.test(x)); if (!l) throw new Error(`no option ${re} in ${labels.join("|")}`); await select.selectOption({ label: l });
}
const laNow = () => { const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()); const g = (t) => f.find((x) => x.type === t).value; return { date: `${g("year")}-${g("month")}-${g("day")}`, h: +g("hour"), m: +g("minute") }; };
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dowOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const hhmm = (h, m = 0) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const TODAY = laNow().date;
// a day with the weekday wanted, at least `from` days ahead (default workflow dates stay inside the 14-day open-shift window)
const nextDow = (want, from = 2) => { for (let n = from; n < from + 7; n++) if (dowOf(addDays(TODAY, n)) === want) return addDays(TODAY, n); };
const MONTH_START = `${TODAY.slice(0, 7)}-01`;

async function addShift(page, { client, service = /Respite/, caregiver = null, date, start, end }) {
  await go(page, "/schedule", 800);
  await page.getByRole("button", { name: "Add shift" }).click(); await page.waitForTimeout(400);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Schedule shift" }) });
  await pick(form.getByLabel("Client"), client); await pick(form.getByLabel("Service"), service); await page.waitForTimeout(1500);
  // choosing a client pre-fills the caregiver from the client's assignment, so an open shift must be chosen explicitly
  await pick(form.getByLabel(/Caregiver/), caregiver ?? /^Open shift/);
  await form.getByLabel("Date").fill(date); await form.getByLabel("Start time").fill(start); await form.getByLabel("End time").fill(end);
  await page.waitForTimeout(2500);
  if (!(await form.getByRole("button", { name: "Schedule shift" }).isEnabled())) { const t = (await form.innerText()).replace(/\n+/g, " "); return `BLOCKED IN FORM: ${(t.match(/Blocked:.*?(?= Authorized time is confirmed| Details|$)/) ?? [t.slice(-200)])[0]}`; }
  await form.getByRole("button", { name: "Schedule shift" }).click(); await page.waitForTimeout(1800);
  const msgs = await page.locator('[role="status"],[role="alert"]').allInnerTexts();
  return msgs.join(" | ");
}
const shiftRows = (page, client) => page.getByRole("row").filter({ hasText: client });
const state = {}; // ids shared between workflows
// A real visit lasts minutes to hours. So that a test does not wait that long, the Time In of the visit that is open NOW is moved back, with triggers off,
// exactly as seed-scenario.ts does. Every other value (server clock for Start/End, confirmations, audit) is the real application behaviour.
const ageOpenVisit = (clientId, minutes) => psql(`set session_replication_role = replica; update ogevia.service_visits set time_in = time_in - interval '${minutes} minutes' where client_id = '${clientId}' and time_out is null`);

// =====================================================================================================================================
// W1 client intake, profile management, authorization entry and amendment
// =====================================================================================================================================
let mp = await as("Morgan Manager");
if (run("W1")) {
  W("W1", "client intake, profile, authorization entry and amendment");
  await go(mp, "/clients");
  await mp.getByRole("button", { name: "Add client" }).click(); await mp.waitForTimeout(400);
  const addForm = mp.locator("form").filter({ has: mp.getByLabel("First name") });
  await addForm.getByLabel("First name").fill("Wendy");
  await addForm.getByRole("button", { name: "Add client" }).click(); await mp.waitForTimeout(900);
  rec("intake: a client without a last name is refused on screen and not created", /required|last name|enter/i.test(await mainText(mp)) && !(await mainText(mp)).includes("Client added"), (await mainText(mp)).slice(0, 160));
  await addForm.getByLabel("Last name").fill(CLIENT_LAST); await addForm.getByLabel("City (optional)").fill("Fresno");
  await addForm.getByRole("button", { name: "Add client" }).click(); await mp.waitForTimeout(1800);
  rec("intake: the client is added and the screen says to add authorized hours", /Client added\. Add authorized hours/.test(await mainText(mp)));
  await mp.getByRole("link", { name: new RegExp(CLIENT_NAME) }).first().click(); await settle(mp, 1200);
  state.clientUrl = mp.url(); state.clientId = state.clientUrl.split("/").pop();
  rec("profile: the new client opens as Active with the internal code caregivers will see", /Active/.test(await mainText(mp)) && /CL-[0-9A-F]{10}/.test(await mainText(mp)));
  state.clientCode = (await mainText(mp)).match(/CL-[0-9A-F]{10}/)[0];
  await mp.getByRole("button", { name: "Add authorization" }).click(); await mp.waitForTimeout(400);
  const auth = mp.locator("form").filter({ has: mp.getByLabel("Authorized hours per month") });
  await pick(auth.getByLabel("Service"), /Respite/); await auth.getByLabel("Payer").fill("Synthetic Regional Center"); await auth.getByLabel("Authorization number (optional)").fill("WF-001");
  await auth.getByLabel("Authorized hours per month").fill("0"); await auth.getByLabel("Start date").fill(MONTH_START); await auth.getByLabel("End date").fill(addDays(MONTH_START, 170));
  await auth.getByRole("button", { name: "Add authorization" }).click(); await mp.waitForTimeout(1200);
  rec("authorization: zero hours is refused with a reason", !/10 hr per month/.test(await mainText(mp)) && /hours|greater|more than|invalid|at least/i.test(await mainText(mp)), (await mainText(mp)).slice(0, 200));
  await auth.getByLabel("Authorized hours per month").fill("10");
  await auth.getByLabel("End date").fill(addDays(MONTH_START, -3)); await auth.getByRole("button", { name: "Add authorization" }).click(); await mp.waitForTimeout(1200);
  rec("authorization: an end date before the start date is refused", !/10 hr per month/.test(await mainText(mp)));
  await auth.getByLabel("End date").fill(addDays(MONTH_START, 170)); await auth.getByRole("button", { name: "Add authorization" }).click(); await mp.waitForTimeout(2000);
  await openAll(mp); let t = await mainText(mp);
  rec("authorization: 10 hr per month, payer and number are shown, balance reads 10 hr left", /10 hr per month/.test(t) && /WF-001/.test(t) && /Hours left\s*10 hr/.test(t.replace(/\n/g, " ").replace(/\s+/g, " ")) || /Authorized\s*10 hr/.test(t.replace(/\n/g, " ")), t.slice(0, 200));
  const stale = /No service has an authorization yet/.test(t);
  rec("authorization: the readiness card updates at once (no reload needed)", !stale, "readiness card still says 'No service has an authorization yet' until the page is reloaded");
  await shot(mp, "w1-client-authorization");
  await mp.reload(); await settle(mp, 1200);
  rec("authorization: after a reload the readiness card no longer says there is no authorization", !/No service has an authorization yet/.test(await mainText(mp)));
  // amendment: raise to 14 hr with a reason; version 1 is kept
  await mp.getByRole("button", { name: "Amend", exact: true }).click(); await mp.waitForTimeout(400);
  const amend = mp.locator("form").filter({ has: mp.getByLabel("Reason for the amendment") });
  await amend.getByLabel("Authorized hours per month").fill("14");
  await amend.getByRole("button", { name: /Save version 2/ }).click(); await mp.waitForTimeout(900);
  rec("amendment: saving without a reason is refused on screen", /reason/i.test(await amend.innerText().catch(() => "")) && !/14 hr per month/.test(await mainText(mp)), (await mainText(mp)).slice(0, 100));
  await amend.getByLabel("Reason for the amendment").fill("Payer approved 4 more hours (synthetic)");
  await amend.getByRole("button", { name: /Save version 2/ }).click(); await mp.waitForTimeout(2000);
  t = await mainText(mp);
  rec("amendment: version 2 shows 14 hr per month and version 1 stays in the history", /14 hr per month/.test(t) && /version 2/i.test(t) && /Version 1/i.test(t), t.slice(0, 300));
  rec("amendment: the amendment is in the audit table with who and why", psql(`select count(*) from ogevia.client_authorizations a join ogevia.clients c on c.id=a.client_id where c.id='${state.clientId}'`) >= 2);
  // assign Alex (the caregiver who can sign in) to the client for Respite
  // two caregivers are assigned: with exactly one, the Add shift form re-selects that caregiver whenever 'Open shift' is chosen (defect D2)
  for (const who of ["Alex Caregiver", "Casey Caregiver"]) {
    await go(mp, "/care-team");
    await mp.getByRole("link", { name: new RegExp(who) }).first().click(); await settle(mp, 1200);
    if (who.startsWith("Alex")) state.alexUrl = mp.url();
    await openAll(mp);
    await mp.getByRole("button", { name: "Assign", exact: true }).first().click(); await mp.waitForTimeout(500);
    const asg = mp.locator("form").filter({ has: mp.locator("#asg-client") });
    await pick(asg.locator("#asg-client"), new RegExp(CLIENT_LAST)); await pick(asg.locator("#asg-service"), /Respite/);
    await asg.locator("#asg-start").fill(addDays(TODAY, -1));
    await asg.getByRole("button", { name: "Assign" }).click(); await mp.waitForTimeout(1800);
  }
  rec("assignment: Alex and Casey are assigned to the new client for Respite", psql(`select count(*) from ogevia.caregiver_assignments where client_id='${state.clientId}'`) === "2", (await mainText(mp)).slice(0, 200));
  // details edit and history
  await mp.goto(state.clientUrl); await settle(mp, 1200); await openAll(mp);
  await mp.getByRole("button", { name: "Edit details" }).click(); await mp.waitForTimeout(400);
  await mp.getByLabel("City (optional)").fill("Clovis"); await mp.getByRole("button", { name: "Save details" }).click(); await mp.waitForTimeout(1500);
  await openAll(mp);
  rec("profile: editing the city saves and shows Clovis", /Clovis/.test(await mainText(mp)));
  await mp.getByRole("button", { name: "History and audit trail" }).click(); await mp.waitForTimeout(1000);
  rec("profile: the history lists the change by field name, never the value", /changed:/.test(await mainText(mp)) && !/Fresno|Clovis/.test(await mp.getByTestId("client-history").innerText()));
  rec("client page: no sideways scroll", await noOverflow(mp));
  await shot(mp, "w1-client-page");
}

// =====================================================================================================================================
// W2 caregiver onboarding, document verification, compliance eligibility
// =====================================================================================================================================
if (run("W2")) {
  W("W2", "caregiver onboarding, documents, compliance eligibility");
  await go(mp, "/care-team/recruiting", 1000);
  await mp.getByLabel("First name").fill("Quinn"); await mp.getByLabel("Last name").fill(CG_LAST);
  await mp.getByRole("button", { name: "Add applicant" }).click(); await mp.waitForTimeout(1800);
  const col = (name) => mp.locator("section,div").filter({ has: mp.getByRole("heading", { name }) }).last();
  const card = () => mp.locator("li,article,div").filter({ hasText: `Quinn ${CG_LAST}` }).filter({ has: mp.getByRole("button", { name: /^Move to/ }) }).last();
  rec("recruiting: the applicant appears in the Applicant stage with 0/5 required items", /APPLICANT[\s\S]*Quinn/i.test(await mainText(mp)) && new RegExp(`Quinn ${CG_LAST}[\\s\\S]{0,40}0/5`).test(await mainText(mp)));
  for (const [from, to] of [["Move to Interview", /INTERVIEW[\s\S]*Quinn/i], ["Move to Offer", /OFFER[\s\S]*Quinn/i], ["Move to Onboarding", /ONBOARDING[\s\S]*Quinn/i], ["Move to Pending documents", /PENDING DOCUMENTS[\s\S]*Quinn/i]]) {
    await card().getByRole("button", { name: from }).click(); await mp.waitForTimeout(1500);
    rec(`recruiting: ${from} moves the person one stage`, to.test(await mainText(mp)), from);
  }
  await card().getByRole("button", { name: "Move to Approved" }).click(); await mp.waitForTimeout(1500);
  rec("recruiting: Approved is refused while required items are outstanding, and says which", /Outstanding|outstanding|cannot be approved/i.test(await mainText(mp)) && !/^APPROVED[\s\S]*Quinn/im.test(await mainText(mp)));
  // open the caregiver page
  await mp.getByRole("link", { name: new RegExp(`Quinn ${CG_LAST}`) }).first().click(); await settle(mp, 1200); await openAll(mp);
  state.quinnUrl = mp.url(); state.quinnId = state.quinnUrl.split("/").pop();
  rec("caregiver page: shows Not ready, with the blocked items named", /Not ready/.test(await mainText(mp)) && /CPR certificate current/.test(await mainText(mp)));
  // staff documents: manager requests and uploads CPR and TB; the owner (a second account) verifies
  await go(mp, "/documents", 1000);
  async function requestDoc(type) {
    await openAll(mp); await pick(mp.locator("#doc-request-person"), new RegExp(`Quinn ${CG_LAST}`)); await pick(mp.getByLabel("Document", { exact: true }), type);
    await mp.getByRole("button", { name: "Request document" }).click(); await mp.waitForTimeout(1500);
  }
  await requestDoc(/^CPR card$/); await requestDoc(/^TB test result$/);
  const docRow = (page, type) => page.locator("li,tr,article").filter({ hasText: `Quinn ${CG_LAST}` }).filter({ hasText: type }).last();
  rec("documents: both requests are listed for the person as missing", (await docRow(mp, "CPR card").count()) >= 1 && (await docRow(mp, "TB test result").count()) >= 1);
  await shot(mp, "w2-documents-requested");
  state.docsOk = true;
  const upload = async (page, type, expiry) => {
    const row = docRow(page, type);
    await row.getByRole("button", { name: /Upload for them/ }).first().click(); await page.waitForTimeout(500);
    await page.locator('input[type="file"]').last().setInputFiles({ name: `${type.replace(/\W+/g, "-")}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% synthetic\n") });
    await page.getByLabel(/Issue \/ completion/).last().fill(addDays(TODAY, -30));
    if (expiry) await page.getByLabel(/Expiry date/).last().fill(expiry);
    await page.getByRole("button", { name: "Upload", exact: true }).last().click(); await page.waitForTimeout(2200);
  };
  await upload(mp, "CPR card", addDays(TODAY, 300)); await upload(mp, "TB test result", null);
  const body = await mainText(mp);
  rec("documents: both uploads are 'Awaiting review' for the new person and not verified", psql(`select count(*) from ogevia.document_versions dv join ogevia.staff_documents d on d.id=dv.document_id where d.caregiver_record_id='${state.quinnId}' and dv.review_status='awaiting_review'`) === "2", body.slice(0, 200));
  // the owner verifies CPR with a rejection first (reason required), then a verification
  const op = await as("Olivia Owner");
  await go(op, "/documents", 1000);
  await op.getByRole("button", { name: /^To review/ }).click(); await op.waitForTimeout(500);
  const orow = (type) => op.locator("li,tr,article").filter({ hasText: `Quinn ${CG_LAST}` }).filter({ hasText: type }).first();
  const review = async (type, decision, reason = null) => {
    await orow(type).getByRole("button", { name: "Review", exact: true }).click(); await op.waitForTimeout(500);
    await op.getByRole("radio", { name: decision }).first().check();
    if (reason) await op.getByLabel(/Reason/).first().fill(reason);
    await op.getByRole("button", { name: "Save decision" }).first().click(); await op.waitForTimeout(1500);
  };
  await review("CPR card", "Reject");
  rec("documents: rejecting without a reason is refused on screen and nothing is recorded", psql(`select count(*) from ogevia.document_versions dv join ogevia.staff_documents d on d.id=dv.document_id where d.caregiver_record_id='${state.quinnId}' and dv.review_status='rejected'`) === "0" && /reason/i.test(await text(op)));
  await op.getByRole("button", { name: "Close", exact: true }).first().click().catch(() => {});
  await op.getByRole("button", { name: /^To review/ }).click().catch(() => {});
  await review("CPR card", "Verify");
  await op.getByRole("button", { name: /^To review/ }).click().catch(() => {});
  await review("TB test result", "Verify");
  await go(op, "/documents", 800);
  const vtxt = await mainText(op);
  rec("documents: another account verified both; the person's CPR and TB are now Current", psql(`select count(*) from ogevia.document_versions dv join ogevia.staff_documents d on d.id=dv.document_id join ogevia.caregiver_records r on r.id=d.caregiver_record_id where r.id='${state.quinnId}' and dv.review_status='verified'`) === "2", vtxt.slice(0, 200));
  await shot(op, "w2-documents-verified");
  // enforcement: before approval the person cannot be scheduled (assignment is allowed; the shift is refused)
  const assignTo = async (page, url) => {
    await page.goto(url); await settle(page, 1200); await openAll(page);
    await page.getByRole("button", { name: "Assign", exact: true }).first().click(); await page.waitForTimeout(500);
    const f = page.locator("form").filter({ has: page.locator("#asg-client") });
    await pick(f.locator("#asg-client"), new RegExp(CLIENT_LAST)); await pick(f.locator("#asg-service"), /Respite/); await f.locator("#asg-start").fill(addDays(TODAY, -1));
    await f.getByRole("button", { name: "Assign" }).click(); await page.waitForTimeout(1800);
  };
  const qd = nextDow(3, 2);
  if (state.clientId) {
    await assignTo(mp, state.quinnUrl);
    const refusal = await addShift(mp, { client: new RegExp(CLIENT_LAST), caregiver: new RegExp(`Quinn ${CG_LAST}`), date: qd, start: "13:00", end: "14:00" }).catch((e) => `NOT OFFERED: ${String(e.message).slice(0, 60)}`);
    rec("eligibility: a caregiver still in Pending documents is not offered in the shift form (or is refused with a reason), and no shift exists", psql(`select count(*) from ogevia.shifts where client_id='${state.clientId}' and caregiver_record_id='${state.quinnId}'`) === "0", refusal);
    note(`pre-approval: ${refusal}`);
  } else note("W1 not run: eligibility refusal not attempted");
  // background check: manager cannot verify; owner records the verified result; manager records training and clearance
  await mp.goto(state.quinnUrl); await settle(mp, 1200); await openAll(mp);
  rec("background check: the manager has no 'Record verified result' for the clearance (administrator only)", (await mp.getByRole("button", { name: "Record verified result" }).count()) === 0 || /Only an administrator/.test(await mainText(mp)), "");
  for (let i = 0; i < 3; i++) {
    const b = mp.getByRole("button", { name: "Mark done" }); if ((await b.count()) === 0) break;
    await b.first().click(); await mp.waitForTimeout(400); await mp.getByRole("button", { name: "Save", exact: true }).first().click(); await mp.waitForTimeout(1500);
  }
  await openAll(mp);
  rec("onboarding: required items the manager can record are done (CPR and TB came from the verified documents)", /Outstanding: .*Background check/.test((await mainText(mp)).replace(/\n/g, " ")) || /4\/5|5\/5|3\/5/.test(await mainText(mp)), (await mainText(mp)).slice(0, 300));
  await op.goto(state.quinnUrl); await settle(op, 1200); await openAll(op);
  await op.getByRole("radio", { name: "Approved", exact: true }).check().catch(() => {});
  await op.getByLabel(/Where you confirmed it/).fill("Clearance letter seen in the agency file (synthetic)").catch(() => {});
  await op.getByRole("button", { name: "Record verified result" }).click().catch(() => {}); await op.waitForTimeout(1800);
  await mp.goto("https://localhost/care-team/recruiting"); await settle(mp, 1200);
  const qcard = mp.locator("li,article,div").filter({ hasText: `Quinn ${CG_LAST}` }).filter({ has: mp.getByRole("button", { name: /^Move to/ }) }).last();
  await qcard.getByRole("button", { name: "Move to Approved" }).click(); await mp.waitForTimeout(1800);
  const approved = psql(`select status from ogevia.caregiver_records where id='${state.quinnId}'`);
  rec("approval: with every required item satisfied (documents verified by a second account) the move to Approved is accepted", approved === "approved" || approved === "active" || approved === "ready", `status=${approved}; ${(await mainText(mp)).slice(0, 200)}`);
  await mp.goto(state.quinnUrl); await settle(mp, 1200); await openAll(mp);
  const q = (await mainText(mp)).replace(/\n/g, " ");
  rec("eligibility: the caregiver page no longer says 'Not ready' once approved, and compliance is clear", !/Blocked from new work/.test(q), q.slice(0, 300));
  // the shift form also checks availability and approved services (shown as 'Blocked: ...'); the owner records both with a reason
  if (state.clientId && /approved|active|ready/.test(approved)) {
    const blocked = await (async () => {
      await go(mp, "/schedule", 800); await mp.getByRole("button", { name: "Add shift" }).click(); await mp.waitForTimeout(400);
      const f = mp.locator("form").filter({ has: mp.getByRole("button", { name: "Schedule shift" }) });
      await pick(f.getByLabel("Client"), new RegExp(CLIENT_LAST)); await pick(f.getByLabel("Service"), /Respite/); await pick(f.getByLabel(/Caregiver/), new RegExp(`Quinn ${CG_LAST}`));
      await f.getByLabel("Date").fill(qd); await f.getByLabel("Start time").fill("13:00"); await f.getByLabel("End time").fill("14:00"); await mp.waitForTimeout(3000);
      return { text: (await f.innerText()).replace(/\n+/g, " "), enabled: await f.getByRole("button", { name: "Schedule shift" }).isEnabled() };
    })();
    rec("eligibility: an approved caregiver with no availability and no approved service is Blocked in the shift form, with both reasons, before anything is saved", !blocked.enabled && /Availability not provided/.test(blocked.text) && /Service not approved/.test(blocked.text), blocked.text.slice(0, 400));
    await shot(mp, "w2-assignment-blocked");
    await op.goto(state.quinnUrl); await settle(op, 1200); await openAll(op);
    await op.getByRole("button", { name: "Edit availability" }).click(); await op.waitForTimeout(500);
    const vf = op.locator("form").filter({ has: op.getByRole("button", { name: "Save change" }) });
    for (const d of ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]) await vf.getByRole("checkbox", { name: d, exact: true }).check();
    const times = vf.locator('input[type="time"]'); const nt = await times.count();
    for (let i = 0; i < nt; i++) await times.nth(i).fill(i % 2 === 0 ? "06:00" : "22:00");
    await vf.getByLabel("Starts").fill(TODAY); await vf.getByLabel("Reason", { exact: true }).fill("Agreed weekly availability at hiring (synthetic)");
    await vf.getByRole("button", { name: "Save change" }).click(); await op.waitForTimeout(1800);
    await openAll(op); await op.getByRole("button", { name: "Approve a service" }).click(); await op.waitForTimeout(400);
    const af = op.locator("form").filter({ has: op.getByRole("button", { name: "Approve", exact: true }) });
    if ((await af.count()) !== 1) note(`approve forms: ${await af.count()}`);
    await pick(af.locator("select").first(), /Respite/); await af.locator('input[type="date"]').first().fill(addDays(TODAY, -1)); await af.locator('textarea,input[type="text"],input:not([type])').last().fill("Trained for respite care (synthetic)");
    await af.getByRole("button", { name: "Approve", exact: true }).click(); await op.waitForTimeout(1800);
    rec("eligibility: the owner records availability and approves Respite for the caregiver, each with a reason", psql(`select count(*) from ogevia.caregiver_service_approvals where caregiver_record_id='${state.quinnId}'`) >= "1");
    const ok = await addShift(mp, { client: new RegExp(CLIENT_LAST), caregiver: new RegExp(`Quinn ${CG_LAST}`), date: qd, start: "13:00", end: "14:00" });
    rec("eligibility: after approval the same shift for the new caregiver is accepted", psql(`select count(*) from ogevia.shifts where client_id='${state.clientId}' and caregiver_record_id='${state.quinnId}'`) === "1", ok);
  }
  // CPR/TB enforcement on the seeded caregiver Casey (CPR awaiting review, not verified): refused as a verified-document requirement
  const casey = await addShift(mp, { client: /Demo Scenario/, caregiver: /Casey/, date: nextDow(3, 4), start: "08:00", end: "09:00" });
  note(`Casey (CPR awaiting review) shift attempt: ${casey}`);
  rec("enforcement: the demo agency has CPR/TB enforcement on; a shift for a caregiver whose CPR is awaiting review is blocked in the form ('CPR needs review') and not saved", /CPR needs review/.test(casey) && psql(`select count(*) from ogevia.shifts s join ogevia.caregiver_records r on r.id=s.caregiver_record_id where r.caregiver_code='CG-CASEY'`) === "0", casey);
  await shot(mp, "w2-caregiver-page");
}

// =====================================================================================================================================
// W3 scheduling, recurring, cancellation, make-up, open-shift pickup
// =====================================================================================================================================
if (run("W3")) {
  W("W3", "scheduling, recurring shifts, cancellation, make-up, open-shift pickup");
  const d1 = nextDow(2, 2), d2 = nextDow(4, 2);
  // open shift
  let msg = await addShift(mp, { client: new RegExp(CLIENT_LAST), date: d1, start: "10:00", end: "12:00" });
  rec("schedule: an open shift (no caregiver) is created and listed as Unfilled", await shiftRows(mp, CLIENT_NAME).filter({ hasText: /Unfilled/ }).count() >= 1, msg);
  state.pickupDate = d1;
  // assign Alex to a second shift via Assign
  msg = await addShift(mp, { client: new RegExp(CLIENT_LAST), date: d2, start: "09:00", end: "11:00" });
  const row2 = shiftRows(mp, CLIENT_NAME).filter({ hasText: /Unfilled/ }).filter({ hasText: /9:00 AM/ }).first();
  await row2.getByRole("button", { name: "Assign" }).click(); await mp.waitForTimeout(600);
  const sel = mp.getByLabel("Caregiver", { exact: true }).last();
  await pick(sel, /Alex/); await mp.getByRole("button", { name: "Assign", exact: true }).last().click(); await mp.waitForTimeout(1800);
  rec("schedule: assigning Alex to the shift marks it covered and names the caregiver", await shiftRows(mp, CLIENT_NAME).filter({ hasText: /Alex Caregiver/ }).count() >= 1, (await mainText(mp)).slice(0, 200));
  await shot(mp, "w3-schedule");
  // refusal: a shift that overlaps Alex's own shift
  msg = await addShift(mp, { client: new RegExp(CLIENT_LAST), caregiver: /Alex/, date: d2, start: "10:00", end: "12:00" });
  rec("schedule: an overlapping shift for the same caregiver is refused with a reason", /overlap|already|conflict|another shift/i.test(msg + (await mainText(mp))), msg);
  // recurring: weekly on the same weekday, 3 occurrences
  await go(mp, "/schedule", 800);
  await mp.getByRole("button", { name: "Repeat visits" }).click(); await mp.waitForTimeout(500);
  await pick(mp.getByLabel("Client"), new RegExp(CLIENT_LAST)); await pick(mp.getByLabel("Service", { exact: true }), /Respite/);
  for (const d of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) await mp.getByLabel(d, { exact: true }).uncheck().catch(() => {});
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dowOf(addDays(TODAY, 3))];
  await mp.getByLabel(wd, { exact: true }).check();
  await mp.getByLabel("Start time").fill("15:00"); await mp.getByLabel("End time").fill("16:00");
  await mp.getByLabel("First date").fill(addDays(TODAY, 3)); await mp.getByLabel("Last date (optional)").fill(addDays(TODAY, 3 + 14));
  await mp.getByRole("button", { name: "Preview dates and hours" }).click(); await mp.waitForTimeout(1800);
  rec("recurring: the preview lists the three weekly dates before anything is saved", (await mainText(mp)).includes(addDays(TODAY, 3).slice(5).replace("-", "/")) || /3 (shifts|dates|visits)/i.test(await mainText(mp)), (await mainText(mp)).slice(0, 300));
  const before = psql(`select count(*) from ogevia.shifts where client_id='${state.clientId}'`);
  await mp.getByRole("button", { name: /Create series/ }).first().click(); await mp.waitForTimeout(2200);
  const after = psql(`select count(*) from ogevia.shifts where client_id='${state.clientId}'`);
  rec("recurring: the series creates one shift per date", Number(after) - Number(before) === 3, `${before} -> ${after}`);
  rec("recurring: the series is listed under Manage repeating shifts", /repeat|series/i.test(await mainText(mp)));
  await shot(mp, "w3-recurring");
  // cancellation of one occurrence, then a make-up
  await go(mp, "/schedule", 800);
  await mp.getByRole("button", { name: "Week", exact: true }).click().catch(() => {});
  await mp.getByLabel("Week starting").fill(d2).catch(() => {}); await settle(mp, 800);
  const cancelRow = shiftRows(mp, CLIENT_NAME).filter({ hasText: /Alex Caregiver/ }).first();
  await cancelRow.getByRole("button", { name: "More actions" }).click(); await mp.waitForTimeout(300);
  await mp.getByText("Cancel shift", { exact: true }).click(); await mp.waitForTimeout(500);
  await mp.getByRole("button", { name: "Cancel shift" }).last().click(); await mp.waitForTimeout(900);
  rec("cancellation: cancelling with no reason is refused on screen", psql(`select count(*) from ogevia.shifts where client_id='${state.clientId}' and status='cancelled'`) === "0");
  await mp.getByLabel("Reason for cancelling").fill("Client in hospital (synthetic)"); await mp.getByRole("button", { name: "Cancel shift" }).last().click(); await mp.waitForTimeout(1800);
  rec("cancellation: the shift is cancelled, the reason kept, and the reserved hours released", psql(`select count(*) from ogevia.shifts where client_id='${state.clientId}' and status='cancelled'`) === "1");
  await go(mp, "/schedule", 800);
  await mp.getByLabel("Week starting").fill(d2).catch(() => {}); await settle(mp, 800);
  const cancelled = shiftRows(mp, CLIENT_NAME).filter({ hasText: /Cancelled/i }).first();
  await cancelled.getByRole("button", { name: "More actions" }).click(); await mp.waitForTimeout(300);
  await mp.getByText("Schedule make-up", { exact: true }).click(); await mp.waitForTimeout(500);
  const mk = mp.locator("form").filter({ has: mp.getByRole("button", { name: "Schedule make-up" }) });
  await mk.getByLabel("Date").fill(addDays(d2, 1)); await mk.getByLabel("Start time").fill("09:00"); await mk.getByLabel("End time").fill("11:00");
  await mk.getByRole("button", { name: "Schedule make-up" }).click(); await mp.waitForTimeout(1800);
  rec("make-up: a make-up shift for the missed 2 hours is scheduled and says how much is still owed", /Make-up scheduled/.test(await mainText(mp)), (await mainText(mp)).slice(0, 200));
  rec("make-up: it is linked to the cancelled shift in the database", psql(`select count(*) from ogevia.shifts where client_id='${state.clientId}' and makeup_for_shift_id is not null`) === "1");
  // pickup: Alex asks for the open shift; the office confirms
  const ap = await as("Alex Caregiver", PHONE);
  await go(ap, "/my-shifts", 1000);
  const card = ap.locator("li").filter({ hasText: state.clientCode }).filter({ has: ap.getByRole("button", { name: "Request this shift" }) }).first();
  rec("pickup: the open shift appears in Alex's list for the new client", (await card.count()) === 1, (await mainText(ap)).slice(0, 200));
  await card.getByRole("button", { name: "Request this shift" }).click(); await ap.waitForTimeout(1600);
  rec("pickup: it shows Requested and that the shift is not Alex's yet", (await ap.getByTestId("requested-badge").count()) >= 1 && /not yours until they do/.test(await text(ap)));
  await go(mp, "/schedule", 1000);
  const panel = mp.getByTestId("pickup-requests");
  rec("pickup: the office sees the request, nobody is assigned yet", (await panel.count()) === 1 && /Nobody is assigned until you confirm/.test(await panel.innerText()));
  await panel.locator("li").filter({ hasText: CLIENT_LAST.length ? /./ : /./ }).filter({ hasText: /Alex/ }).first().getByRole("button", { name: "Confirm assignment" }).click().catch(async () => { await panel.getByRole("button", { name: "Confirm assignment" }).first().click(); });
  await mp.waitForTimeout(1500);
  rec("pickup: after confirmation the shift belongs to Alex", psql(`select count(*) from ogevia.shifts s join ogevia.app_users u on u.id=s.caregiver_user_id where s.client_id='${state.clientId}' and s.starts_at::date >= current_date - 1 and u.display_name='Alex Caregiver'`) >= 2);
  await go(ap, "/my-shifts", 1000);
  rec("pickup: the shift now appears among Alex's own shifts", (await ap.locator("li").filter({ hasText: state.clientCode }).filter({ hasText: /can't make it/ }).count()) >= 1);
  await shot(ap, "w3-caregiver-my-shifts");
  // a shift for Alex around the current time, for the visit workflows (W5). Alex's seeded day is already full, so the screen refuses it: that is the
  // double-booking protection. The fixture is then inserted directly with triggers off (the same way seed-scenario.ts moves times), because only a shift that is
  // under way right now can be started from the caregiver screen.
  const n = laNow(); const startMin = n.h * 60 + n.m - 5; const endMin = Math.min(startMin + 120, 23 * 60 + 59);
  msg = await addShift(mp, { client: new RegExp(CLIENT_LAST), caregiver: /Alex/, date: TODAY, start: hhmm(Math.floor(startMin / 60), startMin % 60), end: hhmm(Math.floor(endMin / 60), endMin % 60) });
  rec("schedule: a shift that overlaps the caregiver's seeded shifts today is blocked in the form ('Already booked'), not saved", /Already booked/.test(msg), msg);
  psql(`set session_replication_role = replica; insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
        select c.organization_id, c.id, s.id, u.id, r.id, now() - interval '125 minutes', now() + interval '5 minutes'
        from ogevia.clients c join ogevia.services s on s.organization_id = c.organization_id and s.code = 'RSP'
        join ogevia.caregiver_records r on r.caregiver_code = 'CG-ALEX' join ogevia.app_users u on u.id = r.linked_user_id where c.id = '${state.clientId}'`).split("\n");
  note("W5 fixture: a Respite shift for Alex under way now was inserted directly");
  await ap.context().close();
}

// =====================================================================================================================================
// W4 authorization consumption, reservation holds, capacity warnings, amendment
// =====================================================================================================================================
if (run("W4")) {
  W("W4", "authorization consumption, holds, capacity warnings, amendment");
  const bal = async () => { await mp.goto(state.clientUrl); await settle(mp, 1200); await openAll(mp); const t = (await mainText(mp)).replace(/\s+/g, " "); return { t, left: (t.match(/Hours left ([\d.]+ ?hr ?[\d]* ?(?:min)?|[\d]+ min)/) ?? [])[1] ?? "?" }; };
  let b = await bal();
  note(`balance before: ${b.t.match(/Authorized .{0,120}/)?.[0]}`);
  rec("consumption: scheduled shifts appear as Reserved and reduce Hours left (authorized = billable + pending + reserved + left)", /Reserved\s*[1-9]/.test(b.t) || /Reserved [1-9]/.test(b.t), b.t.slice(0, 300));
  await shot(mp, "w4-balance-before");
  const day = nextDow(5, 3); let refused = null, created = 0, warned = false;
  for (let i = 0; i < 8 && !refused; i++) {
    const msg = await addShift(mp, { client: new RegExp(CLIENT_LAST), date: addDays(day, i % 5), start: hhmm(8 + (i % 3) * 3), end: hhmm(11 + (i % 3) * 3) });
    if (/not enough|exceed|over|limit|no hours|authorization/i.test(msg)) { refused = msg; break; }
    created++; if (/near|critical|low|left/i.test(msg)) warned = true;
  }
  note(`created ${created} open 3-hour shifts before the refusal; warning shown while creating: ${warned}`);
  b = await bal();
  rec("capacity: the client page shows Near Limit or Critical once the authorization is nearly used", /Near Limit|Critical|Over limit/.test(b.t), b.t.slice(0, 300));
  rec("capacity: a shift that no longer fits is refused with the hours left in the message", !!refused && /hr|hour|min/.test(refused), refused ?? "no refusal in 8 attempts");
  rec("capacity: the refused shift was not saved", psql(`select count(*) from ogevia.shifts where client_id='${state.clientId}' and status='scheduled'`) !== "");
  await shot(mp, "w4-balance-near-limit");
  // amend up so the same shift fits
  await mp.getByRole("button", { name: "Amend", exact: true }).first().click(); await mp.waitForTimeout(400);
  let amend = mp.locator("form").filter({ has: mp.getByLabel("Reason for the amendment") });
  await amend.getByLabel("Authorized hours per month").fill("60"); await amend.getByLabel("Reason for the amendment").fill("Payer approved a larger monthly amount (synthetic)");
  await amend.getByRole("button", { name: /Save version/ }).click(); await mp.waitForTimeout(2000);
  const msg2 = await addShift(mp, { client: new RegExp(CLIENT_LAST), date: addDays(day, 5), start: "08:00", end: "11:00" });
  rec("amendment up: after raising the monthly hours the same kind of shift is accepted", await shiftRows(mp, CLIENT_NAME).filter({ hasText: /Unfilled/ }).count() >= created, msg2);
  // amend down below what is reserved: impacts are listed, nothing is deleted
  const shiftsBefore = psql(`select count(*) from ogevia.shifts where client_id='${state.clientId}' and status='scheduled'`);
  await mp.goto(state.clientUrl); await settle(mp, 1200); await openAll(mp);
  await mp.getByRole("button", { name: "Amend", exact: true }).first().click(); await mp.waitForTimeout(400);
  amend = mp.locator("form").filter({ has: mp.getByLabel("Reason for the amendment") });
  await amend.getByLabel("Authorized hours per month").fill("5"); await amend.getByLabel("Reason for the amendment").fill("Payer reduced the monthly amount (synthetic)");
  await amend.getByRole("button", { name: /Save version/ }).click(); await mp.waitForTimeout(2200);
  rec("amendment down: shifts already scheduled are kept, not deleted", psql(`select count(*) from ogevia.shifts where client_id='${state.clientId}' and status='scheduled'`) === shiftsBefore);
  await go(mp, "/authorization-impacts", 1200);
  const impacts = await mp.getByTestId("amendment-impact").allInnerTexts();
  rec("amendment down: the authorization-changes page lists the shifts that no longer fit", impacts.some((t) => new RegExp(CLIENT_LAST).test(t) || /no longer fits/.test(t)), impacts.join(" || ").slice(0, 300));
  await shot(mp, "w4-impacts");
}

// =====================================================================================================================================
// W5 visit start, completion, verification, signatures (caregiver on a phone viewport)
// =====================================================================================================================================
let ap = null;
if (run("W5")) {
  W("W5", "visit start, end, confirmation methods and evidence (caregiver, phone viewport 390x844, emulated)");
  ap = await as("Alex Caregiver", PHONE);
  await go(ap, "/service-verification", 1200);
  rec("phone: the caregiver sees only client codes, never client names", !new RegExp(CLIENT_LAST).test(await text(ap)) && /CL-/.test(await text(ap)));
  const clientBtn = ap.getByRole("button", { name: new RegExp(state.clientCode) });
  rec("phone: the new client is listed as scheduled today", (await clientBtn.count()) === 1 && !/Not scheduled today/.test(await clientBtn.innerText()), await clientBtn.innerText().catch(() => "missing"));
  await clientBtn.click(); await ap.waitForTimeout(600);
  const startBtn = ap.getByRole("button", { name: /Start visit/ });
  rec("phone: Start is a tap target of at least 44 px", (await startBtn.boundingBox())?.height >= 44);
  // double click Start: one visit only
  await startBtn.dblclick({ delay: 20 }).catch(() => startBtn.click()); await ap.waitForTimeout(2200);
  rec("start: a double tap makes exactly one visit", psql(`select count(*) from ogevia.service_visits where client_id='${state.clientId}'`) === "1", psql(`select count(*) from ogevia.service_visits where client_id='${state.clientId}'`));
  rec("start: the server recorded Time In and the screen says Visit in progress", /Visit in progress/.test(await text(ap)) && /TIME IN/i.test(await text(ap)));
  rec("start: the visit is linked to the scheduled shift (not marked Unscheduled)", !/Unscheduled visit/.test(await text(ap)), (await text(ap)).slice(0, 200));
  await shot(ap, "w5-in-progress");
  ageOpenVisit(state.clientId, 118);
  await ap.reload(); await settle(ap, 1200);
  rec("reload mid-visit: the visit is still in progress after a reload (elapsed time kept by the server)", /Visit in progress/.test(await text(ap)) && /elapsed/.test(await text(ap)), (await text(ap)).slice(0, 300));
  // End visit offline, retry online: one record
  await ap.context().setOffline(true);
  await ap.getByRole("button", { name: /End visit/ }).first().click(); await ap.waitForTimeout(2500);
  const offlineText = await text(ap);
  rec("offline: End visit with no connection shows an error and does not pretend it ended", /not sent|check your connection|try again|offline|could not/i.test(offlineText) && !/Verify visit details/.test(offlineText), offlineText.slice(0, 300));
  await shot(ap, "w9-offline-end");
  rec("offline: nothing was recorded on the server while offline", psql(`select count(*) from ogevia.service_visits where client_id='${state.clientId}' and time_out is not null`) === "0");
  await ap.context().setOffline(false);
  const endBtn = ap.getByRole("button", { name: /End visit/ }).first();
  await endBtn.dblclick({ delay: 20 }).catch(() => endBtn.click()); await ap.waitForTimeout(2500);
  rec("offline retry: after reconnecting, ending (even with a double tap) records Time Out once", psql(`select count(*) from ogevia.service_visits where client_id='${state.clientId}' and time_out is not null`) === "1" && /Verify visit details/.test(await text(ap)), (await text(ap)).slice(0, 200));
  state.visitA = psql(`select id from ogevia.service_visits where client_id='${state.clientId}' order by time_in limit 1`);
  rec("end: the worked minutes shown are server-made, at least one minute", Number(psql(`select worked_minutes from ogevia.service_visits where id='${state.visitA}'`)) >= 1);
  // confirm: client signs by drawing
  await ap.getByLabel("Person confirming").selectOption({ label: "Client" }).catch(() => {});
  await ap.locator("label").filter({ hasText: /Sign name/ }).first().click();
  const canvas = ap.locator("canvas").first(); await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox();
  rec("phone: the signature box fits the screen width", box && box.x >= 0 && box.x + box.width <= 391 && box.height >= 100, JSON.stringify(box));
  await ap.mouse.move(box.x + 20, box.y + 40); await ap.mouse.down(); await ap.mouse.move(box.x + 80, box.y + 70, { steps: 6 }); await ap.mouse.move(box.x + 140, box.y + 30, { steps: 6 }); await ap.mouse.up();
  await ap.getByRole("checkbox", { name: /I attest/ }).check();
  await shot(ap, "w5-sign");
  await ap.getByRole("button", { name: /Confirm visit/ }).click(); await ap.waitForTimeout(2500);
  rec("confirm: signature confirmation is accepted and the visit leaves 'awaiting confirmation'", psql(`select status from ogevia.service_visits where id='${state.visitA}'`) !== "awaiting_signature", psql(`select status from ogevia.service_visits where id='${state.visitA}'`));
  rec("evidence: a signature record exists with role, method and a stored-object reference, not image data", psql(`select count(*) from ogevia.visit_confirmations c join ogevia.visit_evidence e on e.id=c.evidence_id where c.visit_id='${state.visitA}' and c.signer_role='client' and c.confirmation_method='draw' and e.object_key not like 'data:%' and e.byte_size>0`) === "1", psql(`select signer_role||'/'||confirmation_method from ogevia.visit_confirmations where visit_id='${state.visitA}'`));
  await shot(ap, "w5-confirmed");
  rec("phone: caregiver visit screens have no sideways scroll", await noOverflow(ap));
  // visit B: unscheduled visit confirmed with a mark by a parent; visit C: unable to obtain confirmation (for W6); visit D: for a dispute
  async function adHoc(reason) {
    await go(ap, "/service-verification", 1000);
    await ap.getByRole("button", { name: new RegExp(state.clientCode) }).click(); await ap.waitForTimeout(500);
    await ap.getByLabel(/Why is this visit not on your schedule/).fill(reason);
    await ap.getByRole("button", { name: /Start visit/ }).click(); await ap.waitForTimeout(1800);
    ageOpenVisit(state.clientId, 5);
    await ap.getByRole("button", { name: /End visit/ }).first().click(); await ap.waitForTimeout(2200);
  }
  await adHoc("Manager asked me to cover (synthetic)");
  rec("unscheduled visit: it is recorded and marked Unscheduled for the manager to review", /Verify visit details/.test(await text(ap)));
  await ap.getByLabel("Person confirming").selectOption({ label: "Parent" }).catch(() => {});
  await ap.locator("label").filter({ hasText: /Make a mark/ }).first().click();
  const c2 = ap.locator("canvas").first(); const b2 = await c2.boundingBox(); await ap.mouse.move(b2.x + 30, b2.y + 30); await ap.mouse.down(); await ap.mouse.move(b2.x + 60, b2.y + 60, { steps: 4 }); await ap.mouse.up();
  await ap.getByRole("checkbox", { name: /I attest/ }).check(); await ap.getByRole("button", { name: /Confirm visit/ }).click(); await ap.waitForTimeout(2500);
  state.visitB = psql(`select id from ogevia.service_visits where client_id='${state.clientId}' order by time_in offset 1 limit 1`);
  rec("confirm: a mark by a parent is accepted as its own method (recorded as parent/assisted_mark)", psql(`select signer_role||'/'||confirmation_method from ogevia.visit_confirmations where visit_id='${state.visitB}'`) .startsWith("parent/"), psql(`select signer_role||'/'||confirmation_method from ogevia.visit_confirmations where visit_id='${state.visitB}'`));
  await adHoc("Family asked for extra time (synthetic)");
  await ap.getByLabel("Person confirming").selectOption({ label: "Guardian" }).catch(() => {});
  await ap.locator("label").filter({ hasText: /Verbal only/ }).first().click();
  await ap.getByLabel("Name of the person who confirmed").fill("Gina Guardian (synthetic)");
  await ap.getByRole("checkbox", { name: /I attest/ }).check(); await ap.getByRole("button", { name: /Confirm visit/ }).click(); await ap.waitForTimeout(2500);
  state.visitC = psql(`select id from ogevia.service_visits where client_id='${state.clientId}' order by time_in offset 2 limit 1`);
  note(`verbal-only result: ${psql(`select v.status||'/'||c.signer_role||'/'||c.confirmation_method||'/evidence='||coalesce(c.evidence_id::text,'none') from ogevia.service_visits v join ogevia.visit_confirmations c on c.visit_id=v.id where v.id='${state.visitC}'`)}`);
  rec("confirm: a verbal-only confirmation is recorded as such, for a guardian, with no signature image", /guardian\/verbal/.test(psql(`select c.signer_role||'/'||c.confirmation_method from ogevia.visit_confirmations c where c.visit_id='${state.visitC}'`)));
  await adHoc("Cover for a colleague (synthetic)");
  await ap.getByRole("button", { name: /Unable to obtain confirmation/ }).click(); await ap.waitForTimeout(800);
  await ap.getByLabel("Why is manager review needed?").selectOption({ label: "Client declined to sign" });
  rec("no-signer: submitting without an explanation is not possible (button disabled)", await ap.getByRole("button", { name: /Submit for manager review/ }).isDisabled());
  await ap.getByLabel("Brief explanation").fill("Client declined to sign; family not present (synthetic)");
  await ap.getByRole("checkbox").last().check();
  await shot(ap, "w6-unable-to-confirm");
  await ap.getByRole("button", { name: /Submit for manager review/ }).click(); await ap.waitForTimeout(2500);
  state.visitD = psql(`select id from ogevia.service_visits where client_id='${state.clientId}' order by time_in offset 3 limit 1`);
  rec("no-signer: the visit goes to administrator review and is not billable", psql(`select status||'/'||coalesce(billable_minutes::text,'null') from ogevia.service_visits where id='${state.visitD}'`) === "administrator_review/0", psql(`select status||'/'||coalesce(billable_minutes::text,'null') from ogevia.service_visits where id='${state.visitD}'`));
  await adHoc("Cover for a colleague, second family member present (synthetic)");
  await ap.getByRole("button", { name: /Unable to obtain confirmation/ }).click(); await ap.waitForTimeout(500);
  await ap.getByLabel("Why is manager review needed?").selectOption({ label: "Technical problem prevented signing" });
  await ap.getByLabel("Brief explanation").fill("Screen would not register the signature (synthetic)");
  await ap.getByRole("checkbox").last().check();
  await ap.getByRole("button", { name: /Submit for manager review/ }).click(); await ap.waitForTimeout(2500);
  state.visitE = psql(`select id from ogevia.service_visits where client_id='${state.clientId}' order by time_in offset 4 limit 1`);
}

// =====================================================================================================================================
// W6 missed visit, disputed visit, review closure (not billable), correction
// =====================================================================================================================================
// Pacific wall-clock parts of "time_in + minutes" for the Time Out controls
const pacificParts = (visitId, plusMinutes) => {
  const [d, h, m] = psql(`select to_char((time_in at time zone 'America/Los_Angeles') + interval '${plusMinutes} minutes', 'YYYY-MM-DD|HH24|MI') from ogevia.service_visits where id='${visitId}'`).split("|");
  return { date: d, h24: Number(h), minute: Number(m) };
};
async function setPacific(scope, label, t) {
  await scope.getByLabel(`${label} date`).fill(t.date);
  const h12 = t.h24 % 12 === 0 ? 12 : t.h24 % 12;
  await scope.getByLabel(`${label} hour`).selectOption(String(h12)); await scope.getByLabel(`${label} minute`).selectOption(String(t.minute));
  await scope.getByRole("radiogroup", { name: `${label} AM or PM` }).getByRole("radio", { name: t.h24 >= 12 ? "PM" : "AM" }).click();
}
if (run("W6")) {
  W("W6", "missed visit, disputed visit, review closure (not billable), correction");
  if (!ap) ap = await as("Alex Caregiver", PHONE);
  // missed clock-out: an unscheduled visit that is never ended and is 13 hours old
  await go(ap, "/service-verification", 1000);
  await ap.getByRole("button", { name: new RegExp(state.clientCode) }).click(); await ap.waitForTimeout(500);
  await ap.getByLabel(/Why is this visit not on your schedule/).fill("Overnight cover requested by the family (synthetic)");
  await ap.getByRole("button", { name: /Start visit/ }).click(); await ap.waitForTimeout(1800);
  ageOpenVisit(state.clientId, 13 * 60);
  state.visitF = psql(`select id from ogevia.service_visits where client_id='${state.clientId}' and time_out is null`);
  await go(mp, "/service-verification/reports?view=exceptions", 1500);
  const inc = mp.locator("li").filter({ hasText: /Missing Time Out/ }).filter({ hasText: state.clientCode.slice(0, 0) + "Wendy" }).first();
  rec("missed visit: a visit open for 13 hours with no schedule is listed as 'Missing Time Out' with how long it has been open", (await inc.count()) === 1 && /Open \d+/.test(await inc.innerText()), (await inc.count()) ? await inc.innerText() : (await mainText(mp)).slice(0, 300));
  await shot(mp, "w6-missing-time-out");
  await inc.getByRole("button", { name: "Close visit" }).click(); await mp.waitForTimeout(600);
  const closeBox = mp.locator("li").filter({ hasText: /Save Time Out/ }).first();
  await closeBox.getByRole("button", { name: "Save Time Out" }).click(); await mp.waitForTimeout(800);
  rec("missed visit: saving without a Time Out or a reason is refused on screen", /required|reason|Time Out/i.test(await closeBox.innerText()) && psql(`select time_out is null from ogevia.service_visits where id='${state.visitF}'`) === "t", (await closeBox.innerText()).slice(0, 200));
  await setPacific(closeBox, "Time Out", pacificParts(state.visitF, 60));
  await closeBox.getByLabel("Reason").fill("Caregiver forgot to end the visit; family confirmed she left after one hour (synthetic)");
  await closeBox.getByRole("button", { name: "Save Time Out" }).click(); await mp.waitForTimeout(2200);
  rec("missed visit: the manager's Time Out is saved, flagged as entered by the manager, and the visit now waits for the client's confirmation", /awaiting_signature\/t/.test(psql(`select status||'/'||(time_out_entered_by is not null)::text from ogevia.service_visits where id='${state.visitF}'`)), psql(`select status||'/'||(time_out_entered_by is not null)::text||'/'||coalesce(worked_minutes::text,'') from ogevia.service_visits where id='${state.visitF}'`));
  rec("missed visit: the entered Time Out keeps the reason and is not billable until the client confirms", psql(`select coalesce(billable_minutes,0) from ogevia.service_visits where id='${state.visitF}'`) === "0" && psql(`select length(time_out_reason)>10 from ogevia.service_visits where id='${state.visitF}'`) === "t");
  // Alex's phone then asks for the confirmation: finish it as "unable" so the caregiver is free again
  await go(ap, "/service-verification", 1200);
  const needs = await ap.getByRole("button", { name: /Unable to obtain confirmation/ }).count();
  rec("missed visit: the caregiver's phone now shows the confirmation step for the closed visit", needs === 1, (await text(ap)).slice(0, 200));
  if (needs) {
    await ap.getByRole("button", { name: /Unable to obtain confirmation/ }).click(); await ap.waitForTimeout(400);
    await ap.getByLabel("Why is manager review needed?").selectOption({ label: "Signature was accidentally missed before departure" });
    await ap.getByLabel("Brief explanation").fill("Visit closed by the manager after the fact (synthetic)"); await ap.getByRole("checkbox").last().check();
    await ap.getByRole("button", { name: /Submit for manager review/ }).click(); await ap.waitForTimeout(2200);
  }
  // review closure: visit D (client declined) is closed as not billable
  await go(mp, `/visits/${state.visitD}`, 1200);
  await mp.getByRole("radio", { name: /Close the review: not billable/ }).check();
  await mp.getByRole("button", { name: "Record decision" }).click(); await mp.waitForTimeout(800);
  rec("closure: recording a decision without a reason is refused on screen", /reason/i.test(await mainText(mp)) && psql(`select count(*) from ogevia.visit_review_decisions where visit_id='${state.visitD}'`) === "0");
  await mp.getByLabel(/Reason \(required/).fill("Client declined to sign and no representative could be reached; not billable (synthetic)");
  await mp.getByRole("button", { name: "Record decision" }).click(); await mp.waitForTimeout(1800);
  rec("closure: the visit shows 'Reviewed — not billable' with who decided and why; billable minutes stay 0", /Reviewed — not billable/.test(await mainText(mp)) && /Morgan Manager/.test(await mainText(mp)) && psql(`select coalesce(billable_minutes,0) from ogevia.service_visits where id='${state.visitD}'`) === "0");
  await shot(mp, "w6-closed-not-billable");
  // disputed visit: visit E gets a secure link; the family says something is wrong
  await go(mp, `/visits/${state.visitE}`, 1200);
  await openAll(mp);
  await mp.getByLabel("Person who will confirm").fill("Gina Guardian");
  await mp.getByLabel(/How you will verify them by phone/).fill("I will call the number on file (synthetic)");
  await mp.getByRole("button", { name: "Create secure link" }).click(); await mp.waitForTimeout(1800);
  const link = (await mp.locator(".break-all.font-mono").first().innerText()).trim(); const code = (await mp.getByLabel("One-time code").innerText()).trim();
  rec("dispute: the office creates a secure link and a separate 6-digit code, shown once", /^https:\/\/localhost\/.*confirm-visit/.test(link) && /^\d{6}$/.test(code), `${link.slice(0, 60)} / ${code}`);
  const pub = await browser.newContext({ viewport: PHONE, ignoreHTTPSErrors: true }); ctxs.push(pub); const pp = await pub.newPage();
  await pp.goto(link); await settle(pp, 800);
  await pp.getByLabel("Code").fill("000000"); await pp.getByRole("button", { name: "Continue" }).click(); await pp.waitForTimeout(1200);
  rec("dispute: a wrong code does not open the visit", !/No, something is wrong/.test(await text(pp)));
  await pp.getByLabel("Code").fill(code); await pp.getByRole("button", { name: "Continue" }).click(); await pp.waitForTimeout(1500);
  rec("dispute: with the right code the family sees the visit and can say it is wrong (no sign-in needed)", /No, something is wrong/.test(await text(pp)), (await text(pp)).slice(0, 200));
  await pp.getByText("No, something is wrong").click(); await pp.getByLabel("What is wrong?").fill("The caregiver left at 3:00 PM, not 3:20 PM (synthetic)");
  await pp.getByRole("button", { name: "Send report" }).click(); await pp.waitForTimeout(2000);
  await shot(pp, "w6-public-dispute");
  await go(mp, `/visits/${state.visitE}`, 1500); await openAll(mp);
  rec("dispute: the office sees the family's reason on the visit; the visit is not billable and not closed for them", /left at 3:00 PM/.test(await mainText(mp)) && psql(`select status from ogevia.service_visits where id='${state.visitE}'`) === "administrator_review", (await mainText(mp)).slice(0, 300));
  // correction: visit A is corrected by the manager; the original is kept
  await go(mp, `/service-verification/reports?view=visits&correct=${state.visitA}`, 1500);
  const curMin = Number(await mp.getByLabel("Corrected Time Out minute").inputValue());
  await mp.getByLabel("Corrected Time Out minute").selectOption(String(curMin === 0 ? 1 : curMin - 1));
  await mp.getByRole("button", { name: "Save correction" }).click(); await mp.waitForTimeout(800);
  rec("correction: saving without a reason is refused on screen and nothing changes", /reason/i.test(await mainText(mp)) && psql(`select count(*) from ogevia.service_visits where original_visit_id='${state.visitA}'`) === "0");
  await mp.getByLabel("Reason (required)").fill("Caregiver started one minute earlier per the family (synthetic)");
  await mp.getByRole("button", { name: "Save correction" }).click(); await mp.waitForTimeout(2200);
  note(`correction alert: ${(await mp.locator('[role="alert"]').allInnerTexts()).join(" / ")}`);
  rec("correction: a linked revision exists, the original is kept as Corrected, and a correction record names who and why", psql(`select count(*) from ogevia.service_visits where original_visit_id='${state.visitA}'`) === "1" && psql(`select status from ogevia.service_visits where id='${state.visitA}'`) === "corrected" && psql(`select count(*) from ogevia.visit_corrections where original_visit_id='${state.visitA}'`) === "1", psql(`select status from ogevia.service_visits where id='${state.visitA}'`));
  state.visitA2 = psql(`select id from ogevia.service_visits where original_visit_id='${state.visitA}'`) || state.visitA;
  await go(mp, "/service-verification/reports?view=corrections", 1500);
  rec("correction: the Correction history report lists it", /Wendy/.test(await mainText(mp)) && /one minute earlier|Morgan Manager/.test(await mainText(mp)));
  await shot(mp, "w6-correction-history");
}

// =====================================================================================================================================
// W7 role permissions and organization isolation
// =====================================================================================================================================
if (run("W7")) {
  W("W7", "role permissions and organization isolation");
  const ALL = ["/schedule", "/clients", "/care-team", "/documents", "/billing-review", "/reporting", "/accounts", "/authorization-impacts", "/service-verification/reports", "/settings/branding", "/settings/billing-rounding", "/settings/visit-rules", "/attention", "/compliance", "/continuity"];
  async function reach(page, path) { await go(page, path, 700); const u = new URL(page.url()); const t = await mainText(page); return { final: u.pathname, denied: /not allowed|do not have|not authorized|no access|permission|Only (the )?(agency )?administrator|Only an administrator|Your role does not include/i.test(t), snippet: t.slice(0, 60).replace(/\n/g, " ") }; }
  // caregiver on a phone
  const cg = ap ?? (await as("Alex Caregiver", PHONE));
  const cgResults = {};
  for (const path of ALL) cgResults[path] = await reach(cg, path);
  const cgBlocked = Object.entries(cgResults).filter(([path, r]) => r.final !== path || r.denied);
  rec("caregiver: every admin route is redirected or shows a refusal (shell pages with 'Your role does not include' count as refused; the staff documents page is the caregiver's own)", cgBlocked.length >= ALL.length - 1, JSON.stringify(Object.entries(cgResults).filter(([p, r]) => r.final === p && !r.denied)));
  note(`caregiver /attention shows: ${JSON.stringify(cgResults["/attention"])}`);
  note(`caregiver route results: ${Object.entries(cgResults).map(([p, r]) => `${p}->${r.final}${r.denied ? "(denied)" : ""}`).join(" ")}`);
  await go(cg, "/", 700);
  const cgNav = (await cg.locator("aside, nav").first().innerText().catch(() => "")) + (await text(cg));
  rec("caregiver: the menu has no administration links (Schedule, Clients, Billing, Reports, Accounts)", !/Billing|Accounts|Clients\n|Reports/.test(await cg.locator("aside").first().innerText().catch(() => "")) || (await cg.locator("aside").count()) === 0, cgNav.slice(0, 200));
  // scheduler, manager, owner
  const sp = await as("Sam Scheduler"); const op7 = await as("Olivia Owner"); const mp7 = mp;
  const sRes = {}, mRes = {}, oRes = {};
  for (const path of ALL) { sRes[path] = await reach(sp, path); mRes[path] = await reach(mp7, path); oRes[path] = await reach(op7, path); }
  const ok = (r, path) => r.final === path && !r.denied;
  note(`scheduler reaches: ${ALL.filter((p) => ok(sRes[p], p)).join(" ")}`);
  note(`manager reaches: ${ALL.filter((p) => ok(mRes[p], p)).join(" ")}`);
  note(`owner reaches: ${ALL.filter((p) => ok(oRes[p], p)).join(" ")}`);
  rec("scheduler: can use the schedule; cannot reach Billing review, Reporting or Accounts", ok(sRes["/schedule"], "/schedule") && !ok(sRes["/billing-review"], "/billing-review") && !ok(sRes["/accounts"], "/accounts"), JSON.stringify([sRes["/schedule"], sRes["/billing-review"], sRes["/accounts"]]));
  rec("manager: operations yes (schedule, clients, billing review), but not Accounts", ok(mRes["/schedule"], "/schedule") && ok(mRes["/clients"], "/clients") && !ok(mRes["/accounts"], "/accounts"), JSON.stringify([mRes["/accounts"]]));
  rec("owner: reaches Accounts and the settings pages the manager cannot", ok(oRes["/accounts"], "/accounts"), JSON.stringify(oRes["/accounts"]));
  // dollar values: owner yes, manager no
  await go(op7, "/billing-review", 1200); await go(mp7, "/billing-review", 1200);
  const dollars = async (page) => /\$\s?\d/.test(await mainText(page));
  note(`dollar values on Billing review: owner=${await dollars(op7)} manager=${await dollars(mp7)}`);
  await go(op7, "/", 1200); await go(mp7, "/", 1200);
  rec("manager sees no dollar values on Home or Billing review; the owner does", !(await dollars(mp7)) && (await dollars(op7)), `home manager=${await dollars(mp7)} owner=${await dollars(op7)}`);
  // second organization (inserted directly: no screen creates an organization)
  const orgA = psql("select id from ogevia.organizations where slug = 'local-demo'");
  const orgB = psql("insert into ogevia.organizations (slug, display_name) values ('other-agency-" + TAG + "', 'Other Agency (synthetic)') returning id").split("\n")[0];
  const clientB = psql(`insert into ogevia.clients (organization_id, client_code) values ('${orgB}', 'CL-OTHER${TAG.toUpperCase()}') returning id`).split("\n")[0];
  let bearer = null; let apiBase = null;
  mp7.on("request", (r) => { const h = r.headers()["authorization"]; if (h && r.url().includes("/api/")) { bearer = h; apiBase = r.url().split("/v1/")[0]; } });
  await go(mp7, "/clients", 1500);
  rec("isolation: the manager's own client list does not include the other agency's client", !/Other Agency|OTHER/.test(await mainText(mp7)));
  const bodies = {};
  const call = async (path) => { const r = await mp7.request.get(`${apiBase}${path}`, { headers: { authorization: bearer } }); bodies[path] = (await r.text()).slice(0, 400); return `${r.status()}`; };
  if (bearer) {
    const own = await call(`/v1/clients/${state.clientId ?? clientB}?organizationId=${orgA}`);
    const wrongOrgPath = await call(`/v1/clients/${clientB}?organizationId=${orgA}`);
    const otherOrg = await call(`/v1/clients/${clientB}?organizationId=${orgB}`);
    const listOther = await call(`/v1/clients?organizationId=${orgB}`);
    const shiftsOther = await call(`/v1/shifts?organizationId=${orgB}&from=2026-01-01&to=2027-01-01`);
    note(`API as Morgan: own client=${own}; other org's client id under own org=${wrongOrgPath}; other org's client under other org id=${otherOrg}; list other org=${listOther}; shifts other org=${shiftsOther}`);
    rec("isolation (API): another agency's client id is not found under the manager's organization", wrongOrgPath === "404" || wrongOrgPath === "403", wrongOrgPath);
    note(`bodies for other org: list=${bodies[`/v1/clients?organizationId=${orgB}`]} shifts=${bodies[`/v1/shifts?organizationId=${orgB}&from=2026-01-01&to=2027-01-01`]}`);
    rec("isolation (API): naming the other organization returns an error, or at least none of its data", [otherOrg, listOther, shiftsOther].every((c) => c === "403" || c === "404") || (!Object.values(bodies).some((b) => b.includes(clientB) || b.includes("CL-OTHER")) ), `${otherOrg}/${listOther}/${shiftsOther}`);
  } else rec("isolation (API): token captured from the page", false, "no Authorization header seen");
  await go(mp7, `/clients/${clientB}`, 1500);
  rec("isolation (UI): opening the other agency's client page by address shows no client data", !/CL-OTHER/.test(await mainText(mp7)), (await mainText(mp7)).slice(0, 150));
  await shot(mp7, "w7-isolation-ui");
  await sp.context().close(); await op7.context().close();
}

// =====================================================================================================================================
// W8 reporting, reconciliation, billing readiness and approval separation
// =====================================================================================================================================
if (run("W8")) {
  W("W8", "reporting, reconciliation, billing readiness and approval separation");
  await go(mp, "/billing-review", 1500);
  const a2 = state.visitA2;
  const vnum = psql(`select visit_number_snapshot from ogevia.service_visits where id='${a2}'`);
  const rowFor = (page, v) => page.locator("tr, li").filter({ hasText: v }).first();
  rec("billing readiness: the corrected, signed visit that is within the rule is Ready for Review", /Ready for Review/.test(await rowFor(mp, vnum).innerText().catch(() => "")), (await rowFor(mp, vnum).innerText().catch(() => "not listed")).slice(0, 200));
  const dstat = psql(`select visit_number_snapshot from ogevia.service_visits where id='${state.visitD}'`);
  rec("billing readiness: the no-signer visit closed as not billable shows 'Reviewed — not billable' and has no Approve button", /Reviewed — not billable/.test(await rowFor(mp, dstat).innerText().catch(() => "")) && (await rowFor(mp, dstat).getByRole("button", { name: "Approve" }).count()) === 0, (await rowFor(mp, dstat).innerText().catch(() => "")).slice(0, 200));
  const bnum = psql(`select visit_number_snapshot from ogevia.service_visits where id='${state.visitB}'`);
  const bt = await rowFor(mp, bnum).innerText().catch(() => "");
  rec("billing readiness: the unscheduled parent-mark visit is not Ready for Review until a manager has looked at it", !/Ready for Review/.test(bt), bt.slice(0, 200));
  const canApproveMorgan = (await rowFor(mp, vnum).getByRole("button", { name: "Approve" }).count()) > 0;
  note(`manager has an Approve button on the ready visit: ${canApproveMorgan}`);
  const owner = await as("Olivia Owner"); await go(owner, "/billing-review", 1500);
  const canApproveOwner = (await rowFor(owner, vnum).getByRole("button", { name: "Approve" }).count()) > 0;
  const ap8 = canApproveMorgan ? mp : owner;
  rec("approval separation: only roles with billing.approve see Approve (the caregiver and scheduler pages were refused in W7)", canApproveMorgan || canApproveOwner, `manager=${canApproveMorgan} owner=${canApproveOwner}`);
  const before = psql(`select count(*) from ogevia.billing_approvals where visit_id='${a2}'`);
  await rowFor(ap8, vnum).getByRole("button", { name: "Approve" }).click(); await ap8.waitForTimeout(600);
  await ap8.getByLabel("Approved minutes").fill("999999"); await ap8.getByRole("button", { name: "Approve for billing" }).click(); await ap8.waitForTimeout(1200);
  rec("approval: approving more minutes than the visit has is refused", psql(`select count(*) from ogevia.billing_approvals where visit_id='${a2}'`) === before, (await mainText(ap8)).slice(0, 200));
  const billable = psql(`select billable_minutes from ogevia.service_visits where id='${a2}'`);
  await ap8.getByLabel("Approved minutes").fill(String(billable)); await ap8.getByLabel(/Note/).fill("Checked against the signed record (synthetic)");
  await ap8.getByRole("button", { name: "Approve for billing" }).click(); await ap8.waitForTimeout(2000);
  rec("approval: a person approves; the page says it is not submitted or paid; the approval records who", /has not been submitted or paid/.test(await mainText(ap8)) && psql(`select count(*) from ogevia.billing_approvals where visit_id='${a2}'`) === "1");
  rec("approval: approval did not happen by itself (no approval row existed before the click)", before === "0");
  await shot(ap8, "w8-approved");
  // reports: the monthly chain and reporting page reflect the same client
  await go(mp, "/service-verification/reports?view=reconciliation", 2000);
  const chain = (await mp.getByTestId("monthly-chain").innerText().catch(() => "")).replace(/\s+/g, " ");
  rec("reconciliation: the full-chain report passes every check and shows the new client's authorized, confirmed and reserved time", /All checks pass/.test(await mp.getByTestId("chain-checks").innerText().catch(() => "")) && new RegExp(CLIENT_LAST).test(chain), chain.slice(0, 300));
  await shot(mp, "w8-chain");
  await go(mp, "/reporting", 2000);
  rec("reporting: the five sections load and the manager has an export but no audit report", (await mp.getByRole("heading", { name: /Billing readiness|Authorized vs delivered hours|Agency performance|Reports and exports|Compliance and audit evidence/ }).count()) === 5 && (await mp.getByTestId("audit-report").count()) === 0);
  await owner.context().close();
}

// =====================================================================================================================================
// W9 error handling, interrupted operations and recovery (the offline End visit, double tap and reload mid-visit are in W5)
// =====================================================================================================================================
if (run("W9")) {
  W("W9", "interrupted operations and recovery");
  if (!ap) ap = await as("Alex Caregiver", PHONE);
  await go(ap, "/service-verification", 1000);
  await ap.getByRole("button", { name: new RegExp(state.clientCode) }).click(); await ap.waitForTimeout(500);
  await ap.getByLabel(/Why is this visit not on your schedule/).fill("Extra visit asked by the family (synthetic)");
  await ap.getByRole("button", { name: /Start visit/ }).click(); await ap.waitForTimeout(1800);
  ageOpenVisit(state.clientId, 6);
  await ap.getByRole("button", { name: /End visit/ }).first().click(); await ap.waitForTimeout(2200);
  // reload mid-confirmation: the server state returns, what was typed does not
  await ap.getByRole("button", { name: /Unable to obtain confirmation/ }).click(); await ap.waitForTimeout(400);
  await ap.getByLabel("Brief explanation").fill("Typed before the reload (synthetic)");
  await ap.reload(); await settle(ap, 1200);
  rec("reload mid-confirmation: the visit is still waiting for its confirmation after a reload (nothing lost on the server)", /Verify visit details|Person confirming/.test(await text(ap)));
  note(`reload mid-confirmation: typed explanation survives = ${(await ap.getByLabel("Brief explanation").count()) ? await ap.getByLabel("Brief explanation").inputValue() : "(form closed)"}`);
  // sign out in another tab, then try to confirm in the first
  const tab2 = await ap.context().newPage(); await tab2.goto("https://localhost/"); await settle(tab2, 800);
  await tab2.getByRole("button", { name: /Sign out/ }).first().click().catch(async () => { await tab2.getByText("Sign out").first().click(); }); await tab2.waitForTimeout(1500);
  await ap.getByRole("button", { name: /Unable to obtain confirmation/ }).click().catch(() => {});
  await ap.getByLabel("Why is manager review needed?").selectOption({ label: "Technical problem prevented signing" }).catch(() => {});
  await ap.getByLabel("Brief explanation").fill("Typed after the other tab signed out (synthetic)").catch(() => {});
  await ap.getByRole("checkbox").last().check().catch(() => {});
  await ap.getByRole("button", { name: /Submit for manager review/ }).click().catch(() => {}); await ap.waitForTimeout(2500);
  const afterSignOut = await text(ap);
  note(`first tab after the other tab signed out and Submit pressed: url=${new URL(ap.url()).pathname} text=${afterSignOut.slice(0, 160).replace(/\n/g, " ")}`);
  const stillSaved = psql(`select count(*) from ogevia.visit_confirmations c join ogevia.service_visits v on v.id=c.visit_id where v.client_id='${state.clientId}' and c.confirmation_reason like 'Typed after%'`);
  rec("session ended elsewhere: a submit with no session is refused or sent to sign-in and records nothing", stillSaved === "0", `saved=${stillSaved}`);
  rec("session ended elsewhere: the person is told they are signed out / sent to sign in (not a silent failure)", /sign in|signed out|session|log in/i.test(afterSignOut) || new URL(ap.url()).pathname.includes("login"), afterSignOut.slice(0, 200));
  await shot(ap, "w9-signed-out");
  await login(ap, "Alex Caregiver"); await go(ap, "/service-verification", 1200);
  rec("sign back in: the unfinished visit is still there to confirm; the typed text is gone (no draft is kept)", /Verify visit details|Person confirming/.test(await text(ap)) && !/Typed after/.test(await text(ap)) && !(await ap.getByLabel("Brief explanation").count()), (await text(ap)).slice(0, 200));
  // finish properly
  await ap.getByRole("button", { name: /Unable to obtain confirmation/ }).click();
  await ap.getByLabel("Why is manager review needed?").selectOption({ label: "Technical problem prevented signing" }); await ap.getByLabel("Brief explanation").fill("Finished after signing in again (synthetic)"); await ap.getByRole("checkbox").last().check();
  await ap.getByRole("button", { name: /Submit for manager review/ }).click(); await ap.waitForTimeout(2200);
  rec("recovery: after signing in again the confirmation is accepted once (one confirmation record for that visit)", psql(`select count(*) from ogevia.visit_confirmations c where c.confirmation_reason like 'Finished after signing%'`) === "1");
  // an expired/invalid token (cleared storage) while on a page
  await go(ap, "/my-shifts", 800);
  await ap.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }); await ap.context().clearCookies();
  await ap.reload(); await settle(ap, 1500);
  rec("token cleared (as if expired): the app asks for sign-in instead of showing data or an error page", /sign in/i.test(await text(ap)) && !/Open shifts|My shifts/.test((await text(ap)).slice(0, 200)), (await text(ap)).slice(0, 200));
}

// =====================================================================================================================================
// Form-state tests (F) are added below
// =====================================================================================================================================
// =====================================================================================================================================
// F form-state preservation in a real browser: what survives, and is the person warned before losing input
// =====================================================================================================================================
if (run("F")) {
  W("F", "form state: tab switch, other-tab change, reload, navigate and back, session ended");
  const selText = (loc) => loc.evaluate((x) => x.selectedOptions[0]?.textContent?.trim() ?? "");
  const FORMS = [
    { id: "Add shift", persona: "Morgan Manager",
      open: async (p) => { await go(p, "/schedule", 800); await p.getByRole("button", { name: "Add shift" }).click(); await p.waitForTimeout(400); },
      form: (p) => p.locator("form").filter({ has: p.getByRole("button", { name: "Schedule shift" }) }),
      fill: async (p, f) => { await pick(f.getByLabel("Client"), /Demo Okafor/); await pick(f.getByLabel("Service"), /Personal/); await p.waitForTimeout(1200); await f.getByLabel("Date").fill(addDays(TODAY, 9)); await f.getByLabel("Start time").fill("11:15"); await f.getByLabel("End time").fill("12:45"); },
      read: async (p, f) => [await selText(f.getByLabel("Client")), await selText(f.getByLabel("Service")), await f.getByLabel("Date").inputValue(), await f.getByLabel("Start time").inputValue(), await f.getByLabel("End time").inputValue()].join("|"),
      typed: "Demo Okafor|Personal care (PCS)|" + addDays(TODAY, 9) + "|11:15|12:45" },
    { id: "Document review reason", persona: "Olivia Owner",
      open: async (p) => { await go(p, "/documents", 1000); await p.getByRole("button", { name: /^To review/ }).click(); await p.waitForTimeout(400); await p.getByRole("button", { name: "Review", exact: true }).first().click(); await p.waitForTimeout(500); },
      form: (p) => p.locator("main"),
      fill: async (p) => { await p.getByRole("radio", { name: "Reject" }).first().check(); await p.getByLabel(/Reason/).first().fill("Photo is cut off at the bottom, please send a full page (synthetic)"); },
      read: async (p) => `${await p.getByRole("radio", { name: "Reject" }).first().isChecked().catch(() => "n/a")}|${await p.getByLabel(/Reason/).first().inputValue().catch(() => "n/a")}`,
      typed: "true|Photo is cut off at the bottom, please send a full page (synthetic)" },
    { id: "Client details edit", persona: "Morgan Manager",
      open: async (p) => { await go(p, "/clients", 900); await p.getByRole("link", { name: /Demo Amend/ }).first().click(); await settle(p, 1000); await openAll(p); await p.getByRole("button", { name: "Edit details" }).click(); await p.waitForTimeout(400); },
      form: (p) => p.locator("main"),
      fill: async (p) => { await p.getByLabel("City (optional)").fill("Typedville"); await p.getByLabel(/Label caregivers see/).fill("Typed label (synthetic)"); },
      read: async (p) => `${await p.getByLabel("City (optional)").inputValue().catch(() => "n/a")}|${await p.getByLabel(/Label caregivers see/).inputValue().catch(() => "n/a")}`,
      typed: "Typedville|Typed label (synthetic)" },
    { id: "Appearance form", persona: "Olivia Owner",
      open: async (p) => { await go(p, "/settings/appearance", 900); },
      form: (p) => p.getByRole("form", { name: "My view" }),
      fill: async (p, f) => { await f.locator("fieldset").filter({ hasText: "Text size" }).locator("label").filter({ hasText: "Large" }).click(); await f.locator("fieldset").filter({ hasText: "Density" }).locator("label").filter({ hasText: "Compact" }).click(); },
      read: async (p, f) => `${await f.locator("fieldset").filter({ hasText: "Text size" }).locator("input:checked").evaluate((x) => x.parentElement.innerText.replace("✓", "").trim()).catch(() => "n/a")}|${await f.locator("fieldset").filter({ hasText: "Density" }).locator("input:checked").evaluate((x) => x.parentElement.innerText.replace("✓", "").trim()).catch(() => "n/a")}`,
      typed: "Large|Compact" },
  ];
  const results = [];
  const log = (form, kase, survived, warned, extra = "") => { results.push({ form, kase, survived, warned }); note(`${form} / ${kase}: input ${survived ? "KEPT" : "LOST"}; warned before loss: ${warned ? "YES" : "no"}${extra ? "; " + extra : ""}`); };
  for (const F of FORMS) {
    // (a) switch to a second tab, wait, come back, and fire visibilitychange and focus
    let pg = await as(F.persona); await F.open(pg); let f = F.form(pg); await F.fill(pg, f);
    const second = await pg.context().newPage(); await second.goto("https://localhost/"); await settle(second, 800); await second.bringToFront(); await new Promise((r) => setTimeout(r, 4000));
    await pg.bringToFront(); await pg.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); }); await pg.waitForTimeout(1500);
    let now = await F.read(pg, F.form(pg)); const keptA = now === F.typed;
    log(F.id, "(a) other tab 4 s then back + visibilitychange/focus", keptA, false, keptA ? "" : `now=${now}`); rec(`${F.id}: typed input survives a tab switch with visibilitychange and focus events`, keptA, now);
    // (c) reload
    pg.__dialogs = []; await pg.reload(); await settle(pg, 1200);
    const dlgC = (pg.__dialogs ?? []).length > 0;
    let afterC = ""; try { afterC = await F.read(pg, F.form(pg)); } catch { afterC = "(form not shown)"; }
    const keptC = afterC === F.typed; log(F.id, "(c) reload", keptC, dlgC, keptC ? "" : `after=${afterC.slice(0, 60)}`);
    rec(`${F.id}: reload — input kept or the person is warned first`, keptC || dlgC, `after reload: ${afterC.slice(0, 80)}; dialogs=${JSON.stringify(pg.__dialogs)}`);
    await pg.context().close();
    // (d) navigate to another route inside the app and press back
    pg = await as(F.persona); await F.open(pg); f = F.form(pg); await F.fill(pg, f);
    pg.__dialogs = [];
    await pg.getByRole("link", { name: "Home", exact: true }).first().click().catch(() => {}); await settle(pg, 1000);
    const moved = new URL(pg.url()).pathname === "/";
    await pg.goBack(); await settle(pg, 1500);
    const dlgD = (pg.__dialogs ?? []).length > 0;
    let afterD = ""; try { afterD = await F.read(pg, F.form(pg)); } catch { afterD = "(form not shown)"; }
    const keptD = afterD === F.typed; log(F.id, "(d) go to Home, then browser Back", keptD, dlgD, `${moved ? "" : "(did not leave the page) "}after=${afterD.slice(0, 60)}`);
    rec(`${F.id}: navigating away and Back — input kept, or the person is warned first`, keptD || dlgD, `after Back: ${afterD.slice(0, 80)}; formOpen=${afterD !== "(form not shown)"}`);
    await pg.context().close();
    // (e) the session ends in another tab, then the person comes back
    pg = await as(F.persona); await F.open(pg); f = F.form(pg); await F.fill(pg, f);
    const t2 = await pg.context().newPage(); await t2.goto("https://localhost/"); await settle(t2, 800);
    await t2.getByRole("button", { name: /Sign out/ }).first().click().catch(() => {}); await t2.waitForTimeout(1500);
    await pg.bringToFront(); await pg.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); }); await pg.waitForTimeout(1200);
    let whileOut = ""; try { whileOut = await F.read(pg, F.form(pg)); } catch { whileOut = "(form not shown)"; }
    const keptWhileOut = whileOut === F.typed;
    const submit = pg.locator("form button[type=submit], main button").filter({ hasText: /Schedule shift|Save decision|Save details|^Save$/ }).first();
    await submit.click({ timeout: 3000 }).catch(() => {}); await pg.waitForTimeout(2000);
    const afterSubmit = (await text(pg)).slice(0, 200).replace(/\n/g, " ");
    note(`${F.id} (e) signed out elsewhere: form still shows typed values=${keptWhileOut}; after pressing save: ${afterSubmit.slice(0, 120)}; url=${new URL(pg.url()).pathname}`);
    let signedOutNow = true;
    await login(pg, F.persona).catch(() => { signedOutNow = false; });
    if (!signedOutNow) { await pg.goto("https://localhost/"); await settle(pg, 800); }
    note(`${F.id} (e) the first tab was actually signed out by the other tab: ${signedOutNow}`);
    await F.open(pg);
    let afterSignIn = ""; try { afterSignIn = await F.read(pg, F.form(pg)); } catch { afterSignIn = "(form not shown)"; }
    const keptE = afterSignIn === F.typed; log(F.id, "(e) signed out in another tab, signed in again", keptE, false, `typed values on a sign-in-again page: ${afterSignIn.slice(0, 60)}`);
    rec(`${F.id}: signed out elsewhere — a save is not silently accepted`, !/Saved|scheduled|added/i.test(afterSubmit) || /sign in|signed out/i.test(afterSubmit), afterSubmit);
    await pg.context().close();
  }
  // (b) a preference changed from a second tab or context while the first shows the form
  const a1 = await as("Olivia Owner"); await go(a1, "/settings/appearance", 900);
  const myForm = (pg) => pg.getByRole("form", { name: "My view" });
  const checkedOf = async (pg, legend) => myForm(pg).locator("fieldset").filter({ hasText: legend }).locator("input:checked").evaluate((x) => x.parentElement.innerText.replace("✓", "").trim()).catch(() => "n/a");
  const htmlAttrs = (pg) => pg.evaluate(() => Object.fromEntries([...document.documentElement.attributes].map((a) => [a.name, a.value.slice(0, 40)])));
  const before = await htmlAttrs(a1);
  await myForm(a1).locator("fieldset").filter({ hasText: "Text size" }).locator("label").filter({ hasText: "Large" }).click(); // unsaved draft in tab 1
  const tab2 = await a1.context().newPage(); await go(tab2, "/settings/appearance", 900);
  await myForm(tab2).locator("fieldset").filter({ hasText: "Density" }).locator("label").filter({ hasText: "Compact" }).click(); await myForm(tab2).getByRole("button", { name: "Save" }).click(); await tab2.waitForTimeout(1500);
  await a1.bringToFront(); await a1.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); }); await a1.waitForTimeout(1500);
  const dens1 = await checkedOf(a1, "Density"), size1 = await checkedOf(a1, "Text size"); const mid = await htmlAttrs(a1);
  note(`appearance (b) same browser, other tab saved Density=Compact: tab 1 draft Text size=${size1} (draft kept=${size1 === "Large"}); tab 1 Density shows ${dens1}; page attributes changed live=${JSON.stringify(before) !== JSON.stringify(mid)}`);
  rec("appearance: another tab's save does not wipe the unsaved choice in the first tab", size1 === "Large", size1);
  rec("appearance: a change saved in another tab reaches the first tab without a reload (live)", dens1 === "Compact" || JSON.stringify(before) !== JSON.stringify(mid), `density in tab 1 = ${dens1}`);
  await a1.getByRole("form", { name: "My view" }).getByRole("button", { name: "Save" }).click(); await a1.waitForTimeout(1500);
  await a1.reload(); await settle(a1, 1000);
  const final = `${await checkedOf(a1, "Text size")}|${await checkedOf(a1, "Density")}`;
  rec("appearance: saving from the first tab afterwards keeps the person's last save for each group", final === "Large|Compact", final);
  note(`appearance (b) after tab 1 saved its draft: ${final} (tab 1's older Density 'Agency default' draft ${final.endsWith("Compact") ? "did not overwrite" : "OVERWROTE"} the other tab's save)`);
  // a second browser context (a different device) for the same person
  const dev2 = await as("Olivia Owner"); await go(dev2, "/settings/appearance", 900);
  rec("appearance: a second device sees the saved choices after loading the page", (await checkedOf(dev2, "Text size")) === "Large" && (await checkedOf(dev2, "Density")) === "Compact", `${await checkedOf(dev2, "Text size")}|${await checkedOf(dev2, "Density")}`);
  // restore defaults so nothing lingers
  for (const [pg, legend] of [[dev2, "Text size"], [dev2, "Density"]]) await myForm(pg).locator("fieldset").filter({ hasText: legend }).locator("label").filter({ hasText: "Agency default" }).click();
  await myForm(dev2).getByRole("button", { name: "Save" }).click(); await dev2.waitForTimeout(1200);
  console.log("\nFORM-STATE TABLE");
  for (const r of results) console.log(`${r.form.padEnd(24)} ${r.kase.padEnd(58)} input ${r.survived ? "KEPT" : "LOST"}  warned:${r.warned ? "YES" : "no"}`);
}

console.log("\n=== SUMMARY");
let bad = 0;
for (const [k, v] of Object.entries(tally)) { console.log(`${k}: ${v.ok} ok, ${v.fail} fail`); bad += v.fail; }
for (const c of ctxs) await c.close().catch(() => {});
await browser.close();
process.exit(bad ? 1 : 0);
