// Browser checks of the Offices feature on the LOCAL harness (synthetic data only): an Administrator creates, renames and retires an office; a manager assigns a client; a caregiver sees no
// office controls; the Office filter on Clients, Billing review and Reports (including a client with no office and a retired office that still has historical records).
// Needs harness:setup + migrations 0109 and 0110 applied + harness:serve. node offices-checks.mjs <outdir>
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const res = {}; const fails = [];
const check = (name, ok, detail = "") => { res[name] = { ok, detail }; if (!ok) fails.push(name + (detail ? ": " + detail : "")); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : "")); };

async function login(persona) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("https://localhost/");
  await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
  await page.getByText(persona, { exact: false }).first().click();
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
  return { ctx, page };
}
const settle = (page, ms = 900) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(ms));
const names = ["Vega", "Okafor", "Lindqvist", "Tanaka", "Rivera", "Brightwater", "Nakamura"];
const shownClients = async (page) => { const t = await page.locator("main").innerText(); return names.filter((n) => t.includes(n)); };

// ---- 1. the Administrator manages offices -------------------------------------------------------------------------------------------------------------------
const owner = await login("Olivia Owner"); const op = owner.page;
await op.goto("https://localhost/settings/offices"); await settle(op);
check("owner: Offices link in the menu", await op.getByRole("link", { name: "Offices" }).count() > 0);
for (const name of ["North Office", "South Office", "Temporary Office"]) {
  await op.getByLabel("New office").fill(name); await op.getByRole("button", { name: "Add office" }).click(); await op.waitForTimeout(900);
}
const list = op.getByRole("list", { name: "Offices" });
check("owner: three offices created", (await list.locator("li").count()) === 3, (await list.innerText()).replace(/\s+/g, " "));
await op.getByLabel("New office").fill("north office"); await op.getByRole("button", { name: "Add office" }).click(); await op.waitForTimeout(900);
check("owner: a duplicate name (any case) is refused", (await op.getByRole("alert").innerText()).includes("already exists"));
await list.locator("li", { hasText: "South Office" }).getByRole("button", { name: "Rename" }).click();
await op.getByLabel("New name").fill("South County Office"); await op.getByRole("button", { name: "Save name" }).click(); await op.waitForTimeout(900);
check("owner: rename works", (await list.innerText()).includes("South County Office") && !(await list.innerText()).includes("South Office\n"));
await op.screenshot({ path: `${out}/01-owner-offices.png` });

// ---- 2. a manager assigns clients ---------------------------------------------------------------------------------------------------------------------
const mgr = await login("Morgan Manager"); const mp = mgr.page;
check("manager: no Offices link in the menu", await mp.getByRole("link", { name: "Offices" }).count() === 0);
await mp.goto("https://localhost/settings/offices"); await settle(mp);
check("manager: Offices page refuses (Administrator only)", await mp.getByText("Only the agency Administrator can manage offices.").count() > 0);
async function assign(page, clientName, officeLabel) {
  await page.goto("https://localhost/clients"); await settle(page);
  await page.getByRole("link", { name: new RegExp(clientName) }).first().click(); await settle(page);
  const sel = page.getByLabel("Responsible office");
  if (!(await sel.isVisible())) await page.locator("#details > summary").click();
  await sel.selectOption({ label: officeLabel }); await page.waitForTimeout(1200);
  return await sel.evaluate((e) => e.options[e.selectedIndex].textContent);
}
check("manager: assigns Demo Vega to North Office", (await assign(mp, "Vega", "North Office")) === "North Office");
check("manager: assigns Demo Okafor to Temporary Office", (await assign(mp, "Okafor", "Temporary Office")) === "Temporary Office");
await mp.screenshot({ path: `${out}/02-manager-client-office.png` });
await mp.reload(); await settle(mp); if (!(await mp.getByLabel("Responsible office").isVisible())) await mp.locator("#details > summary").click();
check("manager: the choice survives a reload", (await mp.getByLabel("Responsible office").evaluate((e) => e.options[e.selectedIndex].textContent)) === "Temporary Office");

// ---- 3. the Administrator retires an office that has a client with historical visits -----------------------------------------------------------------------
await op.goto("https://localhost/settings/offices"); await settle(op);
const li = op.getByRole("list", { name: "Offices" }).locator("li", { hasText: "Temporary Office" });
check("owner: the office shows its client count", (await li.innerText()).includes("1 client"));
await li.getByRole("button", { name: "Retire" }).click();
await op.getByRole("button", { name: "Retire office" }).click(); await op.waitForTimeout(500);
check("owner: retiring needs a reason", (await op.getByRole("alert").innerText()).includes("reason is required"));
await op.getByLabel("Reason for retiring (required)").fill("Merged into North (synthetic)"); await op.getByRole("button", { name: "Retire office" }).click(); await op.waitForTimeout(1000);
const after = op.getByRole("list", { name: "Offices" }).locator("li", { hasText: "Temporary Office" });
check("owner: retired office is marked, keeps its client, offers no more edits", (await after.innerText()).includes("Retired") && (await after.innerText()).includes("1 client") && await after.getByRole("button", { name: "Rename" }).count() === 0);
await op.screenshot({ path: `${out}/03-owner-retired.png` });

// ---- 4. the Office filter: Clients -------------------------------------------------------------------------------------------------------------------
await op.goto("https://localhost/clients"); await settle(op);
const filter = op.getByLabel("Office");
const opts = await filter.evaluate((e) => [...e.options].map((o) => o.textContent));
check("clients: Office filter lists the offices, the retired one marked, and No office", JSON.stringify(opts) === JSON.stringify(["All offices", "North Office", "South County Office", "Temporary Office (retired)", "No office"]), JSON.stringify(opts));
const pick = async (label) => { await filter.selectOption({ label }); await op.waitForTimeout(600); return shownClients(op); };
check("clients: North Office shows only Vega", JSON.stringify(await pick("North Office")) === JSON.stringify(["Vega"]));
check("clients: the retired office still shows its client (Okafor)", JSON.stringify(await pick("Temporary Office (retired)")) === JSON.stringify(["Okafor"]));
check("clients: an office with no clients shows none", (await pick("South County Office")).length === 0 && (await op.getByText("No clients match.").count()) > 0);
const none = await pick("No office");
check("clients: No office shows the five unassigned clients and neither assigned one", none.length === 5 && !none.includes("Vega") && !none.includes("Okafor"), none.join(","));
check("clients: All offices shows all seven", (await pick("All offices")).length === 7);
await op.screenshot({ path: `${out}/04-clients-filter.png` });

// ---- 5. the Office filter: Billing review -------------------------------------------------------------------------------------------------------------
await op.goto("https://localhost/billing-review"); await settle(op, 1500);
const billingText = async () => { const t = await op.locator("main").innerText(); const i = t.indexOf("CLIENT\n"); return i < 0 ? t.slice(t.indexOf("Showing")) : t.slice(t.indexOf("Showing")); };
const afterShowing = (t) => t.slice(t.indexOf("\n", t.indexOf("Showing")));
const countVisits = async () => (await op.locator("main tbody tr, main li").filter({ hasText: /Demo|CL-/ }).count());
const total = await countVisits();
check("billing review: rows are listed before filtering", total > 0, String(total));
await op.locator("summary", { hasText: /^Filters/ }).first().click();
const bsel = op.getByLabel("Office");
check("billing review: an Office filter is offered", await bsel.count() === 1);
const bopts = await bsel.evaluate((e) => [...e.options].map((o) => o.textContent));
check("billing review: its choices include the retired office and No office", bopts.includes("Temporary Office (retired)") && bopts.includes("No office"), JSON.stringify(bopts));
await bsel.selectOption({ label: "North Office" }); await op.waitForTimeout(800);
let t = await billingText();
t = afterShowing(t);
check("billing review: North Office shows only Vega's visits", t.includes("Vega") && !["Okafor", "Lindqvist", "Tanaka", "Rivera"].some((n) => t.includes(n)), (await billingText()).split("\n")[0]);
await bsel.selectOption({ label: "Temporary Office (retired)" }); await op.waitForTimeout(800); t = afterShowing(await billingText());
check("billing review: the retired office still filters its historical visits (Okafor)", t.includes("Okafor") && !t.includes("Vega"));
await bsel.selectOption({ label: "No office" }); await op.waitForTimeout(800); t = afterShowing(await billingText());
check("billing review: No office excludes both assigned clients", !t.includes("Vega") && !t.includes("Okafor") && (t.includes("Lindqvist") || t.includes("Tanaka") || t.includes("Rivera")));
await op.screenshot({ path: `${out}/05-billing-filter.png` });
await bsel.selectOption({ label: "All offices" }); await op.waitForTimeout(800);

// ---- 6. the Office filter: Reports (the page that has no page-level test) ---------------------------------------------------------------------------
await op.goto("https://localhost/service-verification/reports?view=visits"); await settle(op, 1500);
const rsel = op.locator("#report-office");
if (!(await rsel.isVisible())) await op.locator("summary", { hasText: /^Filters/ }).first().click();
check("reports: the Office dropdown is shown", await rsel.count() === 1);
const ropts = await rsel.evaluate((e) => [...e.options].map((o) => o.textContent));
check("reports: Office dropdown choices", JSON.stringify(ropts) === JSON.stringify(["All offices", "North Office", "South County Office", "Temporary Office (retired)", "No office"]), JSON.stringify(ropts));
const reportClients = async () => { const tb = op.locator("main table"); const t = (await tb.count()) ? (await tb.allInnerTexts()).join("\n") : await op.locator("main").innerText(); return names.filter((n) => t.includes(n)); };
const allReport = await reportClients();
check("reports: visits of several clients are listed before filtering", allReport.length >= 3, allReport.join(","));
await rsel.selectOption({ label: "North Office" }); await op.waitForTimeout(900);
check("reports: North Office shows only Vega", JSON.stringify(await reportClients()) === JSON.stringify(["Vega"]), (await reportClients()).join(","));
await rsel.selectOption({ label: "Temporary Office (retired)" }); await op.waitForTimeout(900);
check("reports: the retired office still shows its historical visits (Okafor)", JSON.stringify(await reportClients()) === JSON.stringify(["Okafor"]), (await reportClients()).join(","));
await rsel.selectOption({ label: "No office" }); await op.waitForTimeout(900);
const rnone = await reportClients();
check("reports: No office excludes both assigned clients", !rnone.includes("Vega") && !rnone.includes("Okafor") && rnone.length >= 1, rnone.join(","));
await op.screenshot({ path: `${out}/06-reports-filter.png` });
await op.getByRole("button", { name: /Clear (all )?filters/i }).first().click().catch(() => {}); await op.waitForTimeout(600);
check("reports: clearing filters resets the Office dropdown", (await rsel.inputValue().catch(() => "")) === "");

// ---- 7. a caregiver sees no office controls --------------------------------------------------------------------------------------------------------------
const cg = await login("Alex Caregiver"); const cp = cg.page;
check("caregiver: no Offices link", await cp.getByRole("link", { name: "Offices" }).count() === 0);
await cp.goto("https://localhost/settings/offices"); await settle(cp);
check("caregiver: the Offices page refuses and shows no controls", await cp.getByText("Only the agency Administrator can manage offices.").count() > 0 && await cp.getByRole("button", { name: "Add office" }).count() === 0);
for (const path of ["/clients", "/billing-review", "/service-verification/reports"]) {
  await cp.goto("https://localhost" + path); await settle(cp, 600);
  check(`caregiver: no Office filter on ${path}`, (await cp.getByLabel("Office").count()) === 0 && (await cp.locator("#report-office").count()) === 0);
}
await cp.screenshot({ path: `${out}/07-caregiver.png` });

await browser.close(); fs.writeFileSync(`${out}/checks.json`, JSON.stringify(res, null, 1));
console.log(fails.length ? `\n${fails.length} FAILED:\n- ` + fails.join("\n- ") : "\nALL CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
