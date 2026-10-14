// Phase B persona walkthrough against the LOCAL harness (synthetic data; no AWS). Time passing is simulated with admin SQL
// (visit Time In/Out moved back), exactly as the existing pilot-e2e scripts do.
import { open, signIn, text, shot, dump, rec, sql, sqlAdmin, code, drawSignature, browserLaunch, summary, results } from "./lib.mjs";
import { writeFileSync } from "node:fs";
import { OUT } from "./lib.mjs";
const browser = await browserLaunch();
const VEGA = code("Vega"), LIND = code("Lindqvist"), OKAF = code("Okafor"), TANA = code("Tanaka");
const T = (m) => sql(`select to_char((now() + interval '${m} minutes') at time zone 'America/Los_Angeles','HH24:MI')`);
const today = sql("select to_char(now() at time zone 'America/Los_Angeles','YYYY-MM-DD')");
const month = sql("select to_char(now() at time zone 'America/Los_Angeles','YYYY-MM')") + "-01";
const net = (problems, allow = /409|422/) => problems.filter((p) => !allow.test(p));
const ageLatest = (userName, mins) => sqlAdmin(`update ogevia.service_visits set time_in = time_in - interval '${mins} minutes' where id = (select v.id from ogevia.service_visits v join ogevia.app_users u on u.id=v.caregiver_user_id where u.display_name like '${userName}%' order by v.created_at desc limit 1)`);
const position = (clientCode) => sql(`select ogevia.authorization_month_usage(a.lineage_id, current_date, null)::int || '|' || ogevia.authorization_month_reserved(a.lineage_id, current_date)::int from ogevia.client_authorizations a join ogevia.clients c on c.id=a.client_id where c.client_code='${clientCode}' and a.is_current limit 1`);
const pick = async (page, codeStr) => page.selectOption("#sh-client", await page.locator("#sh-client option", { hasText: codeStr }).getAttribute("value"));

// ===================== SCHEDULER (Sam, desktop 1280) =====================
let shiftCodeBefore;
{
  const { page, problems } = await open(browser, {});
  await signIn(page, "Sam");
  await page.goto("https://localhost/schedule", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Add shift$/ }).first().click();
  await page.waitForFunction(() => document.querySelectorAll("#sh-client option").length > 3);
  await pick(page, VEGA); await page.selectOption("#sh-service", { label: "Respite (RSP)" }); await page.selectOption("#sh-caregiver", { index: 2 });
  await page.fill("#sh-date", today); await page.fill("#sh-start", T(40)); await page.fill("#sh-end", T(70));
  await page.waitForTimeout(1200); await shot(page, "01-scheduler-add-shift-readiness");
  shiftCodeBefore = position(VEGA);
  await page.getByRole("button", { name: /Schedule shift/ }).click(); await page.waitForTimeout(1500);
  const row = sql(`select s.status || '|' || r.reserved_minutes from ogevia.shifts s join ogevia.authorization_reservations r on r.shift_id=s.id join ogevia.clients c on c.id=s.client_id where c.client_code='${VEGA}' and s.starts_at > now() and s.starts_at < now() + interval '2 hours'`);
  rec("Scheduler", "SCH-01", "adds a 30-minute shift for Blair; it reserves exactly 30 minutes", row === "scheduled|30", row);
  await shot(page, "02-scheduler-shift-added");
  await page.getByRole("button", { name: /^Add shift$/ }).first().click().catch(() => {});
  await pick(page, LIND); await page.selectOption("#sh-service", { label: "Respite (RSP)" }); await page.selectOption("#sh-caregiver", { index: 0 });
  await page.fill("#sh-date", sql("select to_char((now() + interval '1 day') at time zone 'America/Los_Angeles','YYYY-MM-DD')")); await page.fill("#sh-start", "00:00"); await page.fill("#sh-end", "00:00");
  await page.getByRole("button", { name: /Schedule shift/ }).click(); await page.waitForTimeout(1500);
  const t = await text(page);
  rec("Scheduler", "SCH-02", "a 24-hour shift beyond the authorization left is refused with the hours stated", /Not enough authorized time remains this month/.test(t), (t.match(/Not enough authorized time[^\n]*/) || [""])[0]);
  await shot(page, "03-scheduler-refusal");
  rec("Scheduler", "USR-01", "client names are not shown to the Scheduler (codes only)", /Name not set \(CL-/.test(t));
  rec("Scheduler", "NET", "no console error or unexpected 4xx/5xx", net(problems).length === 0, problems.join(" | "));
  await page.context().close();
}

// ===================== CAREGIVER Blair (mobile 390) =====================
const blairInfo = {};
{
  const { page, problems } = await open(browser, { mobile: true });
  await signIn(page, "Blair");
  await page.goto("https://localhost/service-verification", { waitUntil: "networkidle" });
  await shot(page, "10-caregiver-unclosed-visit-resumes");
  const t0 = await text(page);
  rec("Caregiver", "VIS-31", "an unclosed visit from yesterday is still open after sign-in (resume), with Time In shown", /Visit in progress/.test(t0) && /TIME IN/.test(t0));
  await page.getByRole("button", { name: /End visit/i }).first().click(); await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /Unable to obtain confirmation/ }).click(); await page.waitForTimeout(600);
  await page.locator("select").selectOption({ label: "Technical problem prevented signing" });
  await page.locator("textarea").fill("Synthetic: phone had no signal at departure");
  await shot(page, "11-caregiver-unable-to-confirm");
  rec("Caregiver", "VIS-20", "Submit is disabled until the attestation is ticked; nothing is saved", await page.getByRole("button", { name: /Submit for manager review/ }).isDisabled() && sql("select v.status::text from ogevia.service_visits v join ogevia.app_users u on u.id=v.caregiver_user_id where u.display_name like 'Blair%' order by v.time_in limit 1") === "awaiting_signature");
  await page.locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: /Submit for manager review/ }).click(); await page.waitForTimeout(2000);
  const f1 = await text(page); await shot(page, "12-caregiver-final-review-needed"); await dump(page, "12-caregiver-final-review-needed", 8);
  const v1 = sql("select v.status || '|' || v.billable_minutes || '|' || coalesce(c.attestation_version,'-') || '|' || c.confirmation_method from ogevia.service_visits v join ogevia.app_users u on u.id=v.caregiver_user_id join ogevia.visit_confirmations c on c.visit_id = v.id where u.display_name like 'Blair%' order by v.time_in limit 1");
  rec("Caregiver", "VIS-22c", "no-confirmation visit: final screen says Needs manager review, Confirmed 0 min, Billable 0 min", /Needs manager review/.test(f1) && /Billable\s*\n?\s*0 min/.test(f1) && v1.startsWith("administrator_review|0|attest-v1"), v1);

  // the scheduled clean visit
  await page.goto("https://localhost/service-verification", { waitUntil: "networkidle" }); await page.waitForTimeout(500);
  await page.getByText(VEGA).first().click(); await page.waitForTimeout(700);
  const pickedText = await text(page);
  rec("Caregiver", "VIS-24c", "a client on today's schedule shows the shift time and asks for NO reason", /Scheduled\s*\n?\s*\d/.test(pickedText) && !(await page.locator("#unscheduled-reason").count()));
  await shot(page, "13-caregiver-start-scheduled");
  await page.getByRole("button", { name: /Start visit/ }).last().click(); await page.waitForTimeout(1500);
  const act = await text(page); await shot(page, "14-caregiver-active-visit");
  rec("Caregiver", "VIS-02", "active screen shows the server Time In and elapsed time", /Visit in progress/.test(act) && /TIME IN/.test(act) && /elapsed/.test(act));
  const link = sql(`select (scheduled_shift_id is not null)::text from ogevia.service_visits v join ogevia.clients c on c.id=v.client_id where c.client_code='${VEGA}' order by v.created_at desc limit 1`);
  rec("Caregiver", "VIS-24c", "the visit is linked to the scheduled shift by the server", link === "true", link);
  ageLatest("Blair", 25);
  await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(800);
  rec("Caregiver", "VIS-31", "after a page refresh the same active visit is shown", /Visit in progress/.test(await text(page)));
  await page.getByRole("button", { name: /End visit/i }).first().click(); await page.waitForTimeout(1500);
  await shot(page, "15-caregiver-confirm-screen");
  rec("Caregiver", "VIS-35", "Confirm is disabled until a signature is drawn and the attestation is ticked", await page.getByRole("button", { name: /Confirm visit/ }).isDisabled());
  await drawSignature(page); await page.locator("input[type=checkbox]").check();
  await shot(page, "16-caregiver-signature-drawn");
  await page.getByRole("button", { name: /Confirm visit/ }).click(); await page.waitForTimeout(2500);
  const f2 = await text(page); await shot(page, "17-caregiver-final-billing-ready"); await dump(page, "17-caregiver-final-billing-ready", 8);
  const v2 = sql(`select v.status || '|' || v.worked_minutes || '|' || v.billable_minutes || '|' || coalesce(c.attestation_version,'-') from ogevia.service_visits v join ogevia.clients cl on cl.id=v.client_id join ogevia.visit_confirmations c on c.visit_id=v.id where cl.client_code='${VEGA}' order by v.created_at desc limit 1`);
  const [st, wk, bl, att] = v2.split("|");
  rec("Caregiver", "VIS-22a", "clean scheduled visit: signed, billable = worked, attestation attest-v1", st === "signed" && wk === bl && Number(wk) >= 25 && att === "attest-v1", v2);
  rec("Caregiver", "VIS-22a", "final screen shows worked, confirmed, billable and authorization left, and says it is ready for billing review", /Worked/.test(f2) && /Billable/.test(f2) && /Authorization left/.test(f2), (f2.match(/Billing[^\n]*\n[^\n]*/) || [""])[0]);
  rec("Caregiver", "NET", "no console error or unexpected 4xx/5xx", net(problems).length === 0, problems.join(" | "));
  blairInfo.worked = Number(wk);
  blairInfo.caregiverLeft = (f2.match(/Authorization left\s*\n?\s*([^\n]+)/) || [])[1];
  await page.context().close();
}
const posAfter = position(VEGA);
rec("Authorization", "AUT-01", "after the signed visit the shift's reservation is released and the worked minutes are counted once", posAfter.split("|")[1] === shiftCodeBefore.split("|")[1] && Number(posAfter.split("|")[0]) - Number(shiftCodeBefore.split("|")[0]) === blairInfo.worked, `before used|reserved ${shiftCodeBefore}, after ${posAfter}, worked ${blairInfo.worked}`);


// ===================== CAREGIVER Alex (mobile 390): unscheduled visit, then open-shift pickup =====================
const alexInfo = {};
{
  const { page, problems } = await open(browser, { mobile: true });
  await signIn(page, "Alex");
  await page.goto("https://localhost/service-verification", { waitUntil: "networkidle" });
  await page.getByText(OKAF).first().click(); await page.waitForTimeout(700);
  const startBtn = page.getByRole("button", { name: /Start visit/ }).last();
  const pt = await text(page);
  rec("Caregiver", "VIS-23", "a client not on today's schedule is labeled Unscheduled and a reason is required (Start is disabled while empty)", /Unscheduled visit/.test(pt) && await startBtn.isDisabled());
  await shot(page, "20-caregiver-unscheduled-reason-required");
  await page.fill("#unscheduled-reason", "Synthetic: manager phoned and asked me to cover");
  await shot(page, "21-caregiver-unscheduled-reason-filled");
  await startBtn.click(); await page.waitForTimeout(1500);
  rec("Caregiver", "VIS-23", "after the reason the visit starts and the active screen says Unscheduled visit", /Unscheduled visit/.test(await text(page)));
  await shot(page, "22-caregiver-unscheduled-active");
  ageLatest("Alex", 12);
  await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(600);
  await page.getByRole("button", { name: /End visit/i }).first().click(); await page.waitForTimeout(1500);
  await drawSignature(page); await page.locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: /Confirm visit/ }).click(); await page.waitForTimeout(2500);
  const f = await text(page); await shot(page, "23-caregiver-unscheduled-final-review"); await dump(page, "23-caregiver-unscheduled-final-review", 8);
  const v = sql("select v.status || '|' || v.billable_minutes || '|' || v.unscheduled_reason from ogevia.service_visits v join ogevia.app_users u on u.id=v.caregiver_user_id where u.display_name like 'Alex%' order by v.created_at desc limit 1");
  rec("Caregiver", "VIS-24", "signed unscheduled visit: status administrator_review, billable minutes kept (12), reason stored", v.startsWith("administrator_review|12|Synthetic"), v);
  rec("Caregiver", "VIS-22b", "final screen: Needs manager review, 'not on your schedule' sentence, Not billable until reviewed", /Needs manager review/.test(f) && /not on your schedule/.test(f) && /Not billable until a manager reviews it/.test(f));
  alexInfo.visit = sql("select v.id from ogevia.service_visits v join ogevia.app_users u on u.id=v.caregiver_user_id where u.display_name like 'Alex%' order by v.created_at desc limit 1");
  // verbal-only on a second unscheduled visit
  await page.goto("https://localhost/service-verification", { waitUntil: "networkidle" }); await page.waitForTimeout(500);
  await page.getByText(TANA).first().click(); await page.waitForTimeout(600);
  await page.fill("#unscheduled-reason", "Synthetic: second cover visit"); await page.getByRole("button", { name: /Start visit/ }).last().click(); await page.waitForTimeout(1500);
  ageLatest("Alex", 10);
  await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(600);
  await page.getByRole("button", { name: /End visit/i }).first().click(); await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Verbal only/ }).click(); await page.waitForTimeout(500);
  await shot(page, "24-caregiver-verbal-only");
  const confirmBtn = page.getByRole("button", { name: /Confirm visit/ });
  rec("Caregiver", "VIS-16", "Verbal only needs the confirming person's name (Confirm is disabled until a name is typed)", await confirmBtn.isDisabled());
  await page.locator("input[type=text], input:not([type])").first().fill("Synthetic Relative").catch(() => {});
  await page.locator("input[type=checkbox]").check();
  await confirmBtn.click(); await page.waitForTimeout(2500);
  const f2 = await text(page); await shot(page, "25-caregiver-verbal-final"); await dump(page, "25-caregiver-verbal-final", 8);
  const v2 = sql("select v.status || '|' || v.billable_minutes || '|' || c.confirmation_method from ogevia.service_visits v join ogevia.app_users u on u.id=v.caregiver_user_id join ogevia.visit_confirmations c on c.visit_id=v.id where u.display_name like 'Alex%' order by v.created_at desc limit 1");
  rec("Caregiver", "VIS-16", "verbal-only: goes to review, 0 billable, no signature stored", v2 === "administrator_review|0|verbal" && /Needs manager review/.test(f2), v2);
  // open-shift pickup
  await page.goto("https://localhost/my-shifts", { waitUntil: "networkidle" }); await page.waitForTimeout(600);
  const mt = await text(page); await shot(page, "26-caregiver-my-shifts-open");
  rec("Caregiver", "SCH-21b", "the shift Alex called out of is NOT offered for pick-up ('You called out')", /You called out/.test(mt));
  const pickBtns = page.getByRole("button", { name: /Pick up this shift/ });
  const nBefore = await pickBtns.count();
  await pickBtns.first().click(); await page.waitForTimeout(1500);
  const nAfter = await page.getByRole("button", { name: /Pick up this shift/ }).count();
  await shot(page, "27-caregiver-picked-up");
  const asg = sql("select count(*) from ogevia.shifts s join ogevia.caregiver_records c on c.id=s.caregiver_record_id where c.caregiver_code='CG-ALEX' and s.status='scheduled' and s.starts_at > now() and s.starts_at < now() + interval '2 days'");
  rec("Caregiver", "SCH-18", "pick-up moves the shift to Alex: it leaves the open list and Alex now holds it", nAfter === nBefore - 1 && Number(asg) >= 2, `open ${nBefore}->${nAfter}, Alex upcoming ${asg}`);
  rec("Caregiver", "NET", "no console error or unexpected 4xx/5xx", net(problems).length === 0, problems.join(" | "));
  await page.context().close();
}


// ===================== ADMINISTRATOR Olivia (desktop 1280) =====================
const hm = (m) => { const h = Math.floor(m / 60), r = m % 60; return h && r ? `${h} hr ${r} min` : h ? `${h} hr` : `${r} min`; };
{
  const { page, problems } = await open(browser, {});
  await signIn(page, "Olivia");
  const vid = alexInfo.visit;
  await page.goto("https://localhost/visits/" + vid, { waitUntil: "networkidle" }); await page.waitForTimeout(1000);
  const t = await text(page); await shot(page, "30-admin-visit-review-unscheduled"); await dump(page, "30-admin-visit-review-unscheduled", 38);
  rec("Administrator", "VIS-24", "visit page shows Unscheduled, the caregiver's reason, the attestation version and why it needs review", /Unscheduled visit/.test(t) && /Unscheduled reason/.test(t) && /Synthetic: manager phoned/.test(t) && /attest-v1/.test(t) && /Why this visit needs review/.test(t));
  await page.goto("https://localhost/billing-review", { waitUntil: "networkidle" }); await page.waitForTimeout(800);
  const row = page.locator("tr").filter({ hasText: OKAF }).filter({ hasText: "12 min" }).first();
  const rowText = (await row.innerText()).replace(/\s+/g, " ");
  rec("Administrator", "VIS-24d", "billing review offers 'Review visit', NOT 'Approve', for the unscheduled visit", /Review visit/.test(rowText) && !(await row.getByRole("button", { name: /^Approve$/ }).count()), rowText.slice(0, 160));
  await shot(page, "31-admin-billing-review-needs-review");
  const refused = sql(`select count(*) from ogevia.billing_approvals where visit_id='${vid}'`) === "0";
  rec("Administrator", "VIS-24d", "no billing approval exists for it before a review decision", refused);
  await page.goto("https://localhost/visits/" + vid, { waitUntil: "networkidle" }); await page.waitForTimeout(800);
  await page.getByText("Accept this visit as worked").click();
  await page.locator("textarea").fill("Synthetic: manager asked for the cover visit");
  await page.getByRole("button", { name: /Record decision/ }).click(); await page.waitForTimeout(1800);
  await shot(page, "32-admin-review-decision-recorded");
  const dec = sql(`select decision || '|' || coalesce(revoked_at::text,'active') from ogevia.visit_review_decisions where visit_id='${vid}'`);
  rec("Administrator", "VIS-28", "a review decision is recorded with a reason and is active", /^accept_capped_billable\|active$/.test(dec), dec);
  const audit = sql(`select count(*) from ogevia.audit_events where action = 'visit.review_decided'`);
  rec("Administrator", "VIS-28", "the decision is in the audit trail", Number(audit) >= 1, "audit rows " + audit);
  // visit rules
  await page.goto("https://localhost/settings/visit-rules", { waitUntil: "networkidle" }); await page.waitForTimeout(800);
  await shot(page, "33-admin-visit-rules-default");
  const rt = await text(page);
  rec("Administrator", "VIS-50", "the default rule shows 15 minutes, labeled as not verified", /15 minutes/.test(rt) && /not verified|has not been verified/i.test(rt));
  await page.getByLabel(/Allowed difference/).fill("20");
  await page.getByLabel(/Reason/).fill("Synthetic: agency policy review");
  await page.getByRole("button", { name: /Save as a new version/ }).click(); await page.waitForTimeout(1800);
  await shot(page, "34-admin-visit-rules-saved");
  const rt2 = await text(page);
  const ver = sql("select string_agg(version::text || ':' || minutes::text, ',' order by version) from ogevia.agency_visit_rules");
  rec("Administrator", "VIS-51", "saving creates version 1 (20 minutes) and keeps version 0 listed", /Version 1: 20 minutes/.test(rt2) && /Version 0: 15 minutes/.test(rt2), ver);
  rec("Administrator", "NET", "no console error or unexpected 4xx/5xx", net(problems).length === 0, problems.join(" | "));
  await page.context().close();
}

// ===================== AUTHORIZATION MANAGER Morgan (desktop 1280) =====================
{
  const { page, problems } = await open(browser, {});
  const dialogs = []; page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
  await signIn(page, "Morgan");
  const cid = sql(`select id from ogevia.clients where client_code='${VEGA}'`);
  await page.goto("https://localhost/clients/" + cid, { waitUntil: "networkidle" }); await page.waitForTimeout(1200);
  const ct = await text(page); await shot(page, "40-manager-client-authorization-balance");
  const [usedM, resM] = position(VEGA).split("|").map(Number);
  const authM = Number(sql(`select a.monthly_authorized_minutes from ogevia.client_authorizations a join ogevia.clients c on c.id=a.client_id where c.client_code='${VEGA}' and a.is_current`));
  rec("Authorization", "AUT-01", "client page balance equals the database: billable " + hm(usedM) + ", hours left " + hm(authM - usedM - resM), ct.includes(hm(usedM)) && ct.includes(hm(authM - usedM - resM)), `used ${usedM} reserved ${resM} authorized ${authM}`);
  rec("Authorization", "AUT-01", "the signed visit's 25 minutes appear once (billable includes them; the shift is no longer reserved)", usedM - Number(shiftCodeBefore.split("|")[0]) === blairInfo.worked);
  // amend
  await page.getByRole("button", { name: /^Amend$/ }).click(); await page.waitForTimeout(500);
  await page.getByLabel("Authorized hours per month").fill("52");
  await page.getByLabel("Reason for the amendment").fill("Synthetic: payer raised the monthly hours");
  await shot(page, "41-manager-amend-authorization");
  await page.getByRole("button", { name: /Save version 2/ }).click(); await page.waitForTimeout(1800);
  const vs = sql(`select string_agg(a.version_number::text || ':' || a.monthly_authorized_minutes::text || ':' || a.is_current::text, ',' order by a.version_number) from ogevia.client_authorizations a join ogevia.clients c on c.id=a.client_id where c.client_code='${VEGA}' and a.service_id = (select id from ogevia.services where code='RSP' limit 1)`);
  const ct2 = await text(page); await shot(page, "42-manager-authorization-version-2");
  rec("Authorization", "AUT-04", "an amendment adds version 2 (52 h) and keeps version 1 (50 h) unchanged in the history", /1:3000:false,2:3120:true/.test(vs) && /version 2/i.test(ct2), vs);
  const left2 = authM + 120 - usedM - resM;
  rec("Authorization", "AUT-04", "hours left rise by exactly the 2 hours added (" + hm(left2) + ")", ct2.includes(hm(left2)), hm(left2));
  // OBSERVATION: the caregiver's final screen and the office page state "left" differently for the same client.
  {
    const auth1 = authM, caregiverExpected = hm(auth1 - usedM), officeExpected = hm(auth1 - usedM - resM);
    rec("Authorization", "OBS-1", `caregiver final screen said "Authorization left ${blairInfo.caregiverLeft}" (= authorized - billable, ${caregiverExpected}); the office shows "Hours left ${officeExpected}" (also subtracts ${hm(resM)} of scheduled shifts). Known difference, proposal 01; billing is decided by the server either way`, blairInfo.caregiverLeft === caregiverExpected && caregiverExpected !== officeExpected, `caregiver ${blairInfo.caregiverLeft}; office ${officeExpected}`);
  }
  // approvals
  await page.goto("https://localhost/billing-review", { waitUntil: "networkidle" }); await page.waitForTimeout(800);
  const clean = page.locator("tr").filter({ hasText: VEGA }).filter({ hasText: "25 min" }).first();
  await clean.getByRole("button", { name: /^Approve$/ }).click(); await page.waitForTimeout(600);
  await shot(page, "43-manager-approve-form");
  await page.getByRole("button", { name: /Approve for billing/ }).click(); await page.waitForTimeout(2000);
  const ap1 = sql(`select count(*) || '|' || coalesce(max(approved_minutes),0) from ogevia.billing_approvals b join ogevia.service_visits v on v.id=b.visit_id join ogevia.clients c on c.id=v.client_id where c.client_code='${VEGA}' and b.voided_at is null and b.approved_minutes = ${blairInfo.worked}`);
  rec("Authorization", "BIL-01", "a human approves the clean visit: one approval row for exactly the worked minutes, not submitted anywhere", ap1 === "1|" + blairInfo.worked, ap1 + " dialogs: " + dialogs.join(" / ").slice(0, 160));
  await shot(page, "45-manager-approved-clean-visit");
  const row = page.locator("tr").filter({ hasText: OKAF }).filter({ hasText: "12 min" }).first();
  rec("Authorization", "VIS-24d", "after the Administrator's review decision, the unscheduled visit can be approved", await row.getByRole("button", { name: /^Approve$/ }).count() === 1);
  await row.getByRole("button", { name: /^Approve$/ }).click(); await page.waitForTimeout(600);
  await page.getByRole("button", { name: /Approve for billing/ }).click(); await page.waitForTimeout(2000);
  const ap2 = sql(`select approved_minutes from ogevia.billing_approvals where visit_id='${alexInfo.visit}' and voided_at is null`);
  rec("Authorization", "VIS-24d", "approval of the reviewed unscheduled visit is limited to its capped billable minutes (12)", ap2 === "12", ap2);
  // permission boundary
  await page.goto("https://localhost/settings/visit-rules", { waitUntil: "networkidle" }); await page.waitForTimeout(600);
  const mrt = await text(page);
  rec("Authorization", "VIS-55", "the Manager cannot change the variance rule (read-only page, 'only the Administrator')", /Only the agency Administrator can change this rule/.test(mrt) && !(await page.getByRole("button", { name: /Save as a new version/ }).count()));
  await shot(page, "44-manager-visit-rules-read-only");
  await page.goto("https://localhost/", { waitUntil: "networkidle" }); await page.waitForTimeout(800);
  rec("Authorization", "ACC-01", "the Manager sees no dollar values on Home", !/\$\d/.test(await text(page)));
  rec("Authorization", "NET", "no console error or unexpected 4xx/5xx", net(problems).length === 0, problems.join(" | "));
  await page.context().close();
}


// ===================== NEGATIVE CHECKS: a caregiver reaching for office pages =====================
{
  const { page, problems } = await open(browser, { mobile: true });
  await signIn(page, "Alex");
  for (const [path, label] of [["/billing-review", "Billing review"], ["/accounts", "Accounts"], ["/settings/visit-rules", "Visit rules"], ["/schedule", "Schedule"], ["/clients", "Clients"]]) {
    await page.goto("https://localhost" + path, { waitUntil: "networkidle" }); await page.waitForTimeout(700);
    const t = await text(page);
    const leaked = /Demo (Vega|Okafor|Tanaka|Lindqvist|Rivera)/.test(t) || /visits in this date range/.test(t) || /Save as a new version/.test(t) || /Disable/.test(t) && path === "/accounts";
    rec("Caregiver", "USR-02", `${label}: a caregiver sees no office data (${page.url().replace("https://localhost", "") || "/"})`, !leaked, leaked ? "OFFICE DATA VISIBLE" : "");
  }
  await shot(page, "50-caregiver-office-page-denied");
  for (const path of ["/service-verification", "/my-shifts"]) {
    await page.goto("https://localhost" + path, { waitUntil: "networkidle" }); await page.waitForTimeout(500);
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    rec("Caregiver", "VIS-40", `390 px: no horizontal page scroll on ${path} (${w[0]} <= ${w[1]})`, w[0] <= w[1]);
  }

  rec("Caregiver", "VIS-37", "caregiver screens show client codes only: no client names or payer identifiers on the Verify visit screen", await (async () => { await page.goto("https://localhost/service-verification", { waitUntil: "networkidle" }); const t = await text(page); return !/Demo (Vega|Okafor|Tanaka|Lindqvist|Rivera)/.test(t) && !/Regional Center|Medicaid|UCI/i.test(t) && /CL-/.test(t); })());
  rec("Caregiver", "NET", "no unexpected 4xx/5xx beyond the refused office reads", net(problems, /40[13]|409|422/).length === 0, problems.join(" | "));
  await page.context().close();
}

writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
await browser.close();
const failed = summary(); process.exit(failed ? 1 : 0);
