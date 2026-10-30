// Caregiver readiness (0086) on the REAL local stack: the production web bundle, the real API handler and a local PostgreSQL (stand-in sign-in).
// Run after `harness:setup`, `harness:build` and `harness:serve`:  node readiness-scenario.mjs <desktop|phone> <outdir>
// Synthetic data only. Screenshots go to <outdir>. Exit code 1 if any check fails.
import { chromium } from "playwright-core";
import fs from "node:fs";
const label = process.argv[2] ?? "desktop"; const out = process.argv[3] ?? "."; fs.mkdirSync(out, { recursive: true });
const vp = label === "phone" ? { width: 390, height: 844 } : { width: 1280, height: 900 };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] }).catch(() => chromium.launch({ args: ["--no-sandbox"] }));
let fail = 0;
const rec = (name, ok, d = "") => { if (!ok) fail++; console.log(ok ? "ok  " : "FAIL", `[${label}]`, name, ok ? "" : d); };
async function login(persona) {
  const ctx = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText(persona, { exact: false }).first().click();
  await page.waitForLoadState("networkidle");
  return { ctx, page };
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const settle = async (page, ms = 600) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(ms); };
const shot = (page, name) => page.screenshot({ path: `${out}/${label}-${name}.png`, fullPage: true });
const openPerson = async (page, name) => {
  await page.goto("https://localhost/care-team"); await settle(page);
  await page.getByRole("link", { name: new RegExp(name) }).first().click(); await settle(page);
  return page.getByTestId("readiness-checklist");
};
const smallControls = (list) => list.locator("button, a").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent?.trim()));

// ------------------------------------------------------------ Olivia (administrator)
const { ctx: octx, page: op } = await login("Olivia Owner");
await op.goto("https://localhost/care-team"); await settle(op);
await op.locator("#cg-status").selectOption("all"); await settle(op, 300);
const listText = await op.locator("table[aria-label='Caregivers']").innerText();
rec("Caregivers list uses the calculated vocabulary (Not ready / Approved / Active) and never 'Pending documents'", /Not ready/.test(listText) && /Active/.test(listText) && /Approved/.test(listText) && !/Pending documents/.test(listText), listText);
rec("Caregivers list: 'n of 5 done' for people who are not ready", /\d of 5 done/.test(listText));
rec("Caregivers list: Add email offered to people with no email who have not signed in", (await op.getByRole("link", { name: "Add email" }).count()) >= 1);
rec("Caregivers page: no sideways scroll", await noOverflow(op));
await shot(op, "01-caregivers-list");

// Staff list says the same about the same people
await op.goto("https://localhost/accounts"); await settle(op);
const staff = await op.getByRole("list", { name: "Sign-in accounts" }).innerText();
rec("Staff list shows the calculated status for caregivers (same words), the sign-in account state second", /Not ready/.test(staff) && /Sign-in account:/.test(staff) && /Account Setup Required|Invitation Pending|Active/.test(staff), staff.slice(0, 300));
rec("Staff list: Add email / Send sign-in link for people who have not signed in", (await op.getByRole("link", { name: "Add email" }).count()) + (await op.getByRole("button", { name: "Send sign-in link" }).count()) >= 1);
await shot(op, "02-staff-list");

// Reese: every hard requirement met, CPR/TB pending with a due date -> Approve enabled -> ONE approval on a double click
let list = await openPerson(op, "Reese ReadyToApprove");
let t = await list.innerText();
rec("Reese: Not ready, 3 of 5 done, CPR/TB pending with a due date, Approve for work enabled", /Not ready/.test(t) && /3 of 5 done/.test(t) && /Not uploaded · due/.test(t));
const approve = list.getByRole("button", { name: "Approve" });
rec("Reese: Approve is enabled (every hard requirement is met)", await approve.isEnabled());
rec("Reese: none of the removed sections is on the page", (await op.getByText("Not eligible under the rules").count()) === 0 && (await op.getByRole("heading", { name: "Compliance" }).count()) === 0 && (await op.getByRole("heading", { name: "Onboarding" }).count()) === 0 && (await op.getByText("Compliance clearance").count()) === 0);
rec(`Reese: every control is at least 44px high (${label})`, label !== "phone" || (await smallControls(list)).length === 0, (await smallControls(list)).join(","));
await shot(op, "03-reese-before-approve");
await approve.dblclick(); await settle(op, 900);
t = await list.innerText();
rec("Reese: after a double-click the page says Approved by Olivia, with no Approve button", /Approved/.test(t) && /by Olivia Owner/.test(t) && (await list.getByRole("button", { name: "Approve" }).count()) === 0, t);
await shot(op, "04-reese-approved");

// Quinn: no email on file and not signed in -> Approve disabled with the reason; Add email -> send -> resend limited
list = await openPerson(op, "Quinn WaitingOnSignIn");
t = await list.innerText();
rec("Quinn: 'No email on file' and Approve is disabled with the reason shown", /No email on file/.test(t) && (await list.getByRole("button", { name: "Approve" }).isDisabled()) && /Waiting on: App sign-in/.test(t), t);
await list.getByRole("button", { name: "Add email" }).click();
await list.getByLabel("Caregiver's own email").fill("quinn.synthetic@example.test");
await shot(op, "05-quinn-add-email");
await list.getByRole("button", { name: "Save and send sign-in link" }).click(); await settle(op, 900);
t = await list.innerText();
rec("Quinn: after Save and send the row reads 'Invited, has not signed in yet' with 'Last sent'", /Invited, has not signed in yet/.test(t) && /Last sent/.test(t), t);
rec("Quinn: the email address is not shown anywhere on the page", !(await op.content()).includes("quinn.synthetic@example.test"));
await list.getByRole("button", { name: "Resend sign-in link" }).click(); await settle(op, 700);
rec("Quinn: an immediate resend is refused with the rate-limit message (a minute between sends)", /just sent/.test(await list.innerText()), await list.innerText());
await shot(op, "06-quinn-invited-resend-limited");

// Dana: CPR/TB overdue under the 30-day rule -> administrator extends CPR with a reason
list = await openPerson(op, "Dana Overdue");
t = await list.innerText();
rec("Dana: CPR and TB are overdue (hired 40 days ago, 30-day rule)", /overdue since/.test(t) && (t.match(/overdue since/g) ?? []).length === 2, t);
rec("Dana: each overdue row says what it does: blocks new shifts (enforcement on, as seeded) or is flagged only (enforcement off)", (t.match(/Blocks new shift assignments|Flagged only/g) ?? []).length === 2, t);
const cprRow = list.locator('li[data-requirement="cpr"]');
await cprRow.getByRole("button", { name: "Extend" }).click();
const dueDate = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
await cprRow.getByLabel("New due date").fill(dueDate);
await cprRow.getByRole("button", { name: "Extend" }).last().click(); await settle(op, 500);
rec("Dana: extending without a reason is stopped with a plain message (no form that errors on the server)", /reason/i.test(await cprRow.innerText()));
await cprRow.getByLabel("Reason (required)").fill("Clinic appointment booked (synthetic)");
await cprRow.getByRole("button", { name: "Extend" }).last().click(); await settle(op, 900);
const cprText = await cprRow.innerText();
rec("Dana: CPR now shows pending with the extended due date; TB still overdue", /due/.test(cprText) && !/overdue since/.test(cprText) && /overdue since/.test(await list.locator('li[data-requirement="tb"]').innerText()), cprText);
await shot(op, "07-dana-extended");
await octx.close();

// ------------------------------------------------------------ Morgan (manager): no Verify-as-administrator, no Extend
const { ctx: mctx, page: mp } = await login("Morgan Manager");
list = await openPerson(mp, "Dana Overdue");
rec("Morgan (manager): no Extend button (administrator only)", (await list.getByRole("button", { name: "Extend" }).count()) === 0);
rec("Morgan: no sideways scroll on the caregiver page", await noOverflow(mp));
await shot(mp, "08-manager-view");
await mctx.close();

// ------------------------------------------------------------ Alex (caregiver): no access to the Care Team
const { ctx: cctx, page: cp } = await login("Alex Caregiver");
await cp.goto("https://localhost/care-team"); await settle(cp, 400);
rec("Caregiver: refused (no Care Team access)", /do not have access/i.test(await cp.evaluate(() => document.body.innerText)));
await cctx.close();

await browser.close();
console.log(fail === 0 ? `ALL PASS [${label}]` : `${fail} FAILED [${label}]`);
process.exit(fail === 0 ? 0 : 1);
