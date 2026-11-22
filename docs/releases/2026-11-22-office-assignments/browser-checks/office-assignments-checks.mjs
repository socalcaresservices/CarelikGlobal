// Browser checks of offices, service counties and Caregiver Color on the LOCAL harness (synthetic data only).
// Needs harness:setup + migrations 0109, 0110, 0111 applied + harness:build + harness:serve.   node office-assignments-checks.mjs <outdir>
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const fails = [];
const check = (name, ok, detail = "") => { if (!ok) fails.push(name); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : "")); };
async function login(persona, viewport = { width: 1360, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText(persona, { exact: false }).first().click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  return { ctx, page };
}
const settle = (page, ms = 800) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(ms));
const rowsOf = async (page) => (await page.getByRole("table", { name: "Caregivers" }).locator("tbody tr").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));

const owner = await login("Olivia Owner"); const op = owner.page;
// ---- 1. Settings > Offices: add with address + county, edit (move) one, retire one --------------------------------------------------------------------------
await op.goto("https://localhost/settings/offices"); await settle(op);
const add = async (name, address, city, zip, county) => {
  if ((await op.getByRole("list", { name: "Offices" }).count()) && (await op.getByRole("list", { name: "Offices" }).innerText()).includes(name)) return;   // re-runnable
  await op.getByLabel("New office").fill(name); await op.getByLabel("Address (optional)").fill(address); await op.getByLabel("City").first().fill(city); await op.getByLabel("ZIP").first().fill(zip);
  await op.getByLabel("County").first().selectOption(county); await op.getByRole("button", { name: "Add office" }).click(); await settle(op);
};
await add("Temecula Office", "1 Test Way", "Temecula", "92590", "Riverside");
await add("Moreno Valley Office", "2 Test Way", "Moreno Valley", "92553", "Riverside");
await add("Corona Office", "3 Test Way", "Corona", "92879", "Riverside");
const list = op.getByRole("list", { name: "Offices" });
const t0 = (await list.innerText()).replace(/\s+/g, " ");
check("owner: three offices with address and county", /Temecula Office/.test(t0) && /Moreno Valley Office/.test(t0) && /Riverside County/.test(t0), t0);
await op.screenshot({ path: `${out}/01-offices-settings.png` });

// ---- 2. a client: assign Temecula (primary), then Moreno Valley (additional), service county ---------------------------------------------------------------
await op.goto("https://localhost/clients"); await settle(op);
const firstClientLink = op.locator("table[aria-label='Clients as a list'] tbody tr").first().getByRole("link").first();
await firstClientLink.click(); await settle(op);
await op.locator("details", { has: op.locator("summary", { hasText: /^Details.+/ }) }).locator("summary").first().click(); await op.waitForTimeout(400);
check("client: starts Unassigned", (await op.getByTestId("office-assignments").innerText()).includes("Unassigned"));
await op.getByLabel("Assign an office").selectOption({ label: "Temecula Office" }); await settle(op, 1200);
await op.getByLabel("Add an office").selectOption({ label: "Moreno Valley Office" }); await settle(op, 1200);
const ca = (await op.getByTestId("office-assignments").innerText()).replace(/\s+/g, " ");
check("client: Temecula primary, Moreno Valley additional", /Temecula Office Primary/.test(ca) && /Moreno Valley Office Additional/.test(ca), ca);
await op.getByLabel("Service County").selectOption("Riverside"); await settle(op, 1200);
await op.reload(); await settle(op); await op.locator("details", { has: op.locator("summary", { hasText: /^Details.+/ }) }).locator("summary").first().click(); await op.waitForTimeout(400);
check("client: office and county persist after refresh", (await op.getByTestId("office-assignments").innerText()).includes("Temecula Office") && (await op.getByLabel("Service County").inputValue()) === "Riverside");
await op.getByRole("button", { name: "Make primary" }).click(); await settle(op, 1200);
check("client: primary changes to Moreno Valley", /Moreno Valley Office\s+Primary/.test(await op.getByTestId("office-assignments").innerText()));
await op.screenshot({ path: `${out}/02-client-profile.png`, fullPage: true });
const clientUrl = op.url();

// ---- 3. caregivers: offices, counties, colours ---------------------------------------------------------------------------------------------------------------
await op.goto("https://localhost/care-team"); await settle(op);
const cgLinks = op.getByRole("table", { name: "Caregivers" }).locator("tbody tr th a");
const cgCount = await cgLinks.count();
const cgUrls = []; for (let i = 0; i < Math.min(cgCount, 3); i++) cgUrls.push(await cgLinks.nth(i).getAttribute("href"));
check("care team: at least 3 caregivers to work with", cgUrls.length === 3, String(cgCount));
const colors = ["Yellow", "Red", "Blue"];
for (let i = 0; i < cgUrls.length; i++) {
  await op.goto("https://localhost" + cgUrls[i]); await settle(op);
  await op.getByRole("group", { name: "Offices, service area and color" }).count();
  if (i === 0) {   // Temecula primary + Moreno Valley secondary; Riverside + San Bernardino
    await op.getByLabel("Assign an office").selectOption({ label: "Temecula Office" }); await settle(op, 1200);
    await op.getByLabel("Add an office").selectOption({ label: "Moreno Valley Office" }); await settle(op, 1200);
    await op.getByLabel("Add a county").selectOption("Riverside"); await settle(op, 1200);
    await op.getByLabel("Add a county").selectOption("San Bernardino"); await settle(op, 1200);
  } else if (i === 1) {   // Moreno Valley only; Riverside
    await op.getByLabel("Assign an office").selectOption({ label: "Moreno Valley Office" }); await settle(op, 1200);
    await op.getByLabel("Add a county").selectOption("Riverside"); await settle(op, 1200);
  }
  await op.getByRole("radiogroup", { name: "Caregiver Color" }).getByText(colors[i], { exact: true }).click(); await settle(op, 1200);
  if (i === 0) await op.screenshot({ path: `${out}/03-caregiver-profile.png`, fullPage: true });
}
await op.goto("https://localhost" + cgUrls[0]); await settle(op);
const prof = (await op.locator("main").innerText()).replace(/\s+/g, " ");
check("caregiver profile: offices, counties and colour persist after refresh", /Temecula Office Primary/.test(prof) && /Moreno Valley Office Additional/.test(prof) && /Service Counties Riverside . San Bernardino/.test(prof), prof.match(/Offices, service area.{0,400}/)?.[0] ?? prof.slice(0,300));
check("caregiver profile: Yellow swatch beside the name", (await op.locator("h1 [data-testid='caregiver-swatch']").getAttribute("data-color")) === "yellow");
const yellowStyle = await op.locator("h1 [data-testid='caregiver-swatch']").evaluate((el) => getComputedStyle(el).borderTopColor + " / " + getComputedStyle(el).backgroundColor);
check("caregiver profile: yellow swatch is outlined (dark border on yellow fill)", yellowStyle.startsWith("rgb(133, 77, 14)") && yellowStyle.includes("rgb(250, 204, 21)"), yellowStyle);

// ---- 4. Care Team list: filters ----------------------------------------------------------------------------------------------------------------------------
await op.goto("https://localhost/care-team"); await settle(op);
const all = await rowsOf(op);
const swatchColors = await op.getByRole("table", { name: "Caregivers" }).locator("[data-testid='caregiver-swatch']").evaluateAll((els) => els.map((e) => e.getAttribute("data-color")));
check("list: three colour swatches (yellow, red, blue)", ["yellow", "red", "blue"].every((c) => swatchColors.includes(c)), swatchColors.join(","));
await op.screenshot({ path: `${out}/04-care-team-list.png`, fullPage: true });
await op.getByLabel("Office", { exact: true }).selectOption({ label: "Temecula Office" }); await settle(op, 400);
const tem = await rowsOf(op);
await op.getByLabel("Office", { exact: true }).selectOption({ label: "Moreno Valley Office" }); await settle(op, 400);
const mov = await rowsOf(op);
check("list: Temecula filter shows 1 caregiver (primary), Moreno Valley filter shows 2 (secondary + primary)", tem.length === 1 && mov.length === 2, `${tem.length}/${mov.length}`);
await op.getByLabel("Office", { exact: true }).selectOption({ label: "All Offices" }); await settle(op, 400);
const allAgain = await rowsOf(op);
check("list: All Offices shows each caregiver once", allAgain.length === all.length && new Set(allAgain).size === allAgain.length, `${allAgain.length}`);
await op.getByLabel("Office", { exact: true }).selectOption({ label: "Unassigned" }); await settle(op, 400);
const un = await rowsOf(op);
check("list: Unassigned shows caregivers with no office", un.length === all.length - 2 && un.every((t) => t.includes("Unassigned")), `${un.length}`);
await op.getByLabel("Office", { exact: true }).selectOption({ label: "All Offices" });
await op.getByLabel("County", { exact: true }).selectOption("San Bernardino"); await settle(op, 400);
check("list: County filter San Bernardino shows the caregiver covering it", (await rowsOf(op)).length === 1);
await op.getByLabel("County", { exact: true }).selectOption("Riverside"); await settle(op, 400);
check("list: County Riverside shows two caregivers", (await rowsOf(op)).length === 2);
await op.getByLabel("Office", { exact: true }).selectOption({ label: "Temecula Office" }); await settle(op, 400);
check("list: Office + County combine", (await rowsOf(op)).length === 1);
await op.getByLabel("Status", { exact: true }).selectOption("all"); await settle(op, 400);
await op.getByLabel("Search").fill("zzzz-no-match"); await settle(op, 400);
check("list: filters combine with status and search (no match)", (await op.getByText("No caregivers match.").count()) === 1);
await op.getByLabel("Search").fill(""); await op.getByLabel("Office", { exact: true }).selectOption({ label: "All Offices" }); await op.getByLabel("County", { exact: true }).selectOption({ label: "All Counties" });

// ---- 5. clients list filters --------------------------------------------------------------------------------------------------------------------------------
await op.goto("https://localhost/clients"); await settle(op);
await op.getByLabel("Office", { exact: true }).selectOption({ label: "Moreno Valley Office" }); await settle(op, 400);
check("clients list: Moreno Valley office filter shows the assigned client once", (await op.locator("table[aria-label='Clients as a list'] tbody tr").count()) === 1);
await op.getByLabel("Office", { exact: true }).selectOption({ label: "Temecula Office" }); await settle(op, 400);
check("clients list: secondary-office match works (Temecula is additional)", (await op.locator("table[aria-label='Clients as a list'] tbody tr").count()) === 1);
await op.getByLabel("County", { exact: true }).selectOption("Riverside"); await settle(op, 400);
await op.screenshot({ path: `${out}/05-clients-list-filtered.png`, fullPage: true });
check("clients list: County Riverside keeps the client", (await op.locator("table[aria-label='Clients as a list'] tbody tr").count()) === 1);

// ---- 6. move an office: assignments are preserved ------------------------------------------------------------------------------------------------------------
await op.goto("https://localhost/settings/offices"); await settle(op);
const L = op.getByRole("list", { name: "Offices" });
await L.locator("li", { hasText: "Temecula Office" }).getByRole("button", { name: "Edit" }).click();
await L.getByLabel("Address").fill("9 New Address"); await L.getByLabel("City").fill("Murrieta"); await L.getByLabel("ZIP").fill("92562");
await op.getByRole("button", { name: "Save office" }).click(); await settle(op, 1200);
const moved = (await L.innerText()).replace(/\s+/g, " ");
check("office move: new address shown, caregiver count unchanged", /9 New Address, Murrieta, 92562/.test(moved) && /Temecula Office[^A-Z]*1 client · 1 caregiver/.test(moved), moved);
await op.goto("https://localhost/care-team"); await settle(op);
await op.getByLabel("Office", { exact: true }).selectOption({ label: "Temecula Office" }); await settle(op, 400);
check("office move: caregiver still found under the same office, county untouched", (await rowsOf(op)).length === 1 && (await rowsOf(op))[0].includes("San Bernardino"));

// ---- 7. retire an office: links stay, no new assignments, reactivate ----------------------------------------------------------------------------------------
await op.goto("https://localhost/settings/offices"); await settle(op);
await L.locator("li", { hasText: "Moreno Valley Office" }).getByRole("button", { name: "Retire" }).click();
await op.getByLabel("Reason for retiring (required)").fill("Synthetic test retirement"); await op.getByRole("button", { name: "Retire office" }).click(); await settle(op, 1200);
check("retire: office shows Retired", (await L.locator("li", { hasText: "Moreno Valley Office" }).innerText()).includes("Retired"));
await op.goto("https://localhost" + cgUrls[0]); await settle(op);
const retiredText = (await op.getByTestId("office-assignments").innerText()).replace(/\s+/g, " ");
check("retire: the caregiver keeps the retired office on the profile", /Moreno Valley Office \(retired\)/.test(retiredText), retiredText);
check("retire: a retired office is not offered for new assignments", (await op.getByLabel("Add an office").count()) === 0 || (await op.getByLabel("Add an office").locator("option", { hasText: "Moreno" }).count()) === 0);
await op.screenshot({ path: `${out}/06-retired-office-on-profile.png`, fullPage: true });
await op.goto("https://localhost/settings/offices"); await settle(op);
await L.locator("li", { hasText: "Moreno Valley Office" }).getByRole("button", { name: "Reactivate" }).click(); await settle(op, 1200);
check("retire: reactivate works", !(await L.locator("li", { hasText: "Moreno Valley Office" }).innerText()).includes("Retired"));

// ---- 7b. offices when creating a record, and who/when history ---------------------------------------------------------------------------------------------
await op.goto("https://localhost/care-team"); await settle(op);
await op.getByRole("button", { name: "Add caregiver" }).click(); await op.waitForTimeout(500);
await op.getByLabel("First name").fill("Created"); await op.getByLabel("Last name").fill("WithOffice");
const newCgOffices = await op.getByLabel("Primary office (optional)").locator("option").allInnerTexts();
check("create caregiver: the form offers active offices only", newCgOffices.includes("Temecula Office") && newCgOffices.includes("Unassigned"), newCgOffices.join(","));
await op.getByLabel("Primary office (optional)").selectOption({ label: "Temecula Office" });
await op.getByRole("button", { name: "Add caregiver", exact: true }).last().click(); await settle(op, 1500);
await op.getByRole("link", { name: "Open the record" }).click(); await settle(op);
check("create caregiver: the new caregiver already has Temecula as primary", /Temecula Office Primary/.test((await op.getByTestId("office-assignments").innerText()).replace(/\s+/g, " ")));
await op.getByTestId("assignment-history").locator("summary").click(); await op.waitForTimeout(300);
const hist = (await op.getByRole("list", { name: "Assignment history" }).innerText()).replace(/\s+/g, " ");
check("history: shows who and when, and the new and previous offices", /Olivia Owner/.test(hist) && /Offices: Temecula Office \(was: Unassigned\)/.test(hist), hist);
await op.getByLabel("Add an office").selectOption({ label: "Moreno Valley Office" }); await settle(op, 1200);
await op.getByRole("button", { name: "Make primary" }).click(); await settle(op, 1200);
const hist2 = (await op.getByRole("list", { name: "Assignment history" }).innerText()).replace(/\s+/g, " ");
check("history: a primary change is listed newest first with before and after", /Offices: Moreno Valley Office \(primary\), Temecula Office \(was: Temecula Office, Moreno Valley Office\)/.test(hist2) && hist2.indexOf("Moreno Valley Office (primary)") < hist2.indexOf("(was: Unassigned)"), hist2);
await op.screenshot({ path: `${out}/09-history-and-create.png`, fullPage: true });
await op.goto("https://localhost/clients"); await settle(op);
await op.getByRole("button", { name: "Add client" }).click(); await op.waitForTimeout(500);
await op.getByLabel("First name").fill("Created"); await op.getByLabel("Last name").fill("ClientWithOffice");
await op.getByLabel("Primary office (optional)").selectOption({ label: "Corona Office" });
await op.getByRole("button", { name: "Add client", exact: true }).last().click(); await settle(op, 1500);
check("create client: no error after saving with an office", (await op.getByText("The office was not saved").count()) === 0 && (await op.getByText(/Client added/).count()) === 1);
await op.getByLabel("Office", { exact: true }).selectOption({ label: "Corona Office" }); await settle(op, 500);
check("create client: the new client is under Corona Office", (await op.locator("table[aria-label='Clients as a list'] tbody tr").count()) === 1);
await op.getByLabel("Office", { exact: true }).selectOption({ label: "All Offices" });

// ---- 7c. secondary offices never duplicate visits or inflate totals (Visit records) ----------------------------------------------------------------------------
// The first client (section 2) is assigned to BOTH Temecula and Moreno Valley. If a secondary office duplicated rows, Temecula + Unassigned would exceed the unfiltered totals.
const mins = (t) => { const h = /(\d+)\s*hr/.exec(t); const m = /(\d+)\s*min/.exec(t); return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0); };
const readTotals = async () => { const t = (await op.locator("main").innerText()).replace(/\s+/g, " "); const v = /Visits \((\d+)\)/.exec(t); const w = /Worked: (.*?) Billable: (.*?)(?: Replaced|$| By client| Visits)/.exec(t); return { visits: v ? Number(v[1]) : -1, worked: w ? mins(w[1]) : -1, billable: w ? mins(w[2]) : -1 }; };
await op.goto("https://localhost/service-verification/reports?view=visits"); await settle(op, 1500);
const base = await readTotals();
const officeSel = op.locator("#report-office");
if (!(await officeSel.count())) { const f = op.getByText("Filters", { exact: true }); if (await f.count()) await f.first().click(); await op.waitForTimeout(400); }
check("reports: the Office filter is present", (await officeSel.count()) === 1);
const pick = async (label) => { await officeSel.selectOption({ label }); await settle(op, 600); return readTotals(); };
const rAll = await pick("All Offices"), rTem = await pick("Temecula Office"), rMov = await pick("Moreno Valley Office"), rNone = await pick("Unassigned");
console.log("INFO totals", JSON.stringify({ base, rAll, rTem, rMov, rNone }));
check("reports: All Offices equals the unfiltered totals", JSON.stringify(rAll) === JSON.stringify(base));
check("reports: a client in two offices gives identical visits and hours under either office", rTem.visits > 0 && JSON.stringify(rTem) === JSON.stringify(rMov));
check("reports: assigned + Unassigned = all (no visit duplicated, hours not inflated)", rTem.visits + rNone.visits === base.visits && rTem.worked + rNone.worked === base.worked && rTem.billable + rNone.billable === base.billable);
await op.screenshot({ path: `${out}/10-reports-office-filter.png`, fullPage: true });
// Billing review
await op.goto("https://localhost/billing-review"); await settle(op, 1500);
const billRows = async () => op.locator("table tbody tr").count();
const bOffice = op.getByLabel("Office", { exact: true });
if (await bOffice.count()) {
  const bAll = await billRows();
  await bOffice.selectOption({ label: "Temecula Office" }); await settle(op, 500); const bTem = await billRows();
  await bOffice.selectOption({ label: "Moreno Valley Office" }); await settle(op, 500); const bMov = await billRows();
  await bOffice.selectOption({ label: "Unassigned" }); await settle(op, 500); const bNone = await billRows();
  console.log("INFO billing rows", JSON.stringify({ bAll, bTem, bMov, bNone }));
  check("billing review: a client in two offices appears once under each, and assigned + Unassigned = all", bTem === bMov && bTem + bNone === bAll, JSON.stringify({ bAll, bTem, bMov, bNone }));
} else check("billing review: the Office filter is present", false);

// ---- 8. schedule + reports ----------------------------------------------------------------------------------------------------------------------------------
await op.goto("https://localhost/schedule"); await settle(op, 1500);
const sched = await op.locator("[data-testid='caregiver-swatch']").count();
await op.screenshot({ path: `${out}/07-schedule.png`, fullPage: true });
console.log("INFO schedule swatches visible:", sched);
check("schedule: coloured caregivers show a swatch beside the name", sched > 0);
// the chart's caregiver mark follows the saved colour: change Alex's colour red -> blue -> yellow and read the chart fills each time
const alexUrl = cgUrls[0];
for (const [label, hex] of [["Red", "#dc2626"], ["Blue", "#2563eb"], ["Yellow", "#facc15"]]) {
  await op.goto("https://localhost" + alexUrl); await settle(op);
  await op.getByRole("radiogroup", { name: "Caregiver Color" }).getByText(label, { exact: true }).click(); await settle(op, 1200);
  await op.goto("https://localhost/service-verification/reports?view=overview"); await settle(op, 2500);
  const fills = await op.locator("[aria-label='Filtered hours chart'] path[fill], [aria-label='Filtered hours chart'] .recharts-sector, [aria-label='Filtered hours chart'] .recharts-bar-rectangle path").evaluateAll((els) => els.map((e) => (e.getAttribute("fill") || "").toLowerCase()));
  check(`reports chart (Group by Caregiver): Alex's mark is ${label} after saving ${label}`, fills.includes(hex), [...new Set(fills)].join(","));
  if (label === "Blue") await op.screenshot({ path: `${out}/08-reports-blue.png`, fullPage: true });
}
await op.screenshot({ path: `${out}/08-reports.png`, fullPage: true });

// ---- 9. a caregiver sees no office controls ----------------------------------------------------------------------------------------------------------------
const cg = await login("Alex Caregiver", { width: 390, height: 844 });
await cg.page.goto("https://localhost/settings/offices"); await settle(cg.page);
check("caregiver: no office controls", (await cg.page.getByRole("button", { name: "Add office" }).count()) === 0);
await cg.ctx.close();
await browser.close();
console.log(fails.length ? "\nFAILED: " + fails.join(" | ") : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
