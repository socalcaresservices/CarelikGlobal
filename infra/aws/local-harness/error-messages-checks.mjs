// Local harness (synthetic data). The "Retire document type" action under each kind of failure, in a real browser. A route that does not exist behind a release switch is
// reproduced the way the browser sees it from API Gateway: a failed request with no readable response (route.abort), not a 404.   node error-messages-checks.mjs <outdir>
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto("https://localhost/");
await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
await page.getByText("Olivia Owner").first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
const res = []; const fails = [];
const check = (n, ok, d = "") => { res.push({ n, ok, d }); if (!ok) fails.push(n + ": " + d); console.log((ok ? "PASS " : "FAIL ") + n + (d ? "  " + d : "")); };
const settle = (ms = 900) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(ms));
const clickRetire = async (name) => { const h = await page.evaluateHandle((n) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Retire" && b.parentElement && b.parentElement.textContent.includes(n) && !/^Retire /.test(b.parentElement.textContent.trim()) && b.parentElement.textContent.length < n.length + 60), name); await h.asElement().click(); };
const openTypes = async () => { const sm = page.locator("summary", { hasText: "Document types and reminder days" }); if (!(await page.getByPlaceholder("e.g. CPR card").isVisible())) await sm.click(); await page.waitForTimeout(300); };
await page.goto("https://localhost/documents"); await settle(); await openTypes();
for (const name of ["synthetic cpp", "synthetic cpr", "synthetic tb", "synthetic dbl", "synthetic perm", "synthetic srv"]) {
  await page.getByPlaceholder("e.g. CPR card").fill(name); await page.getByRole("button", { name: "Add type" }).click(); await page.waitForTimeout(700);
}
async function attempt(label, name, route, expected, expectNot = "Could not reach Ogevia") {
  await page.unroute("**/v1/document-types/*/retire").catch(() => {});
  if (route) await page.route("**/v1/document-types/*/retire", route);
  await page.goto("https://localhost/documents"); await settle(); await openTypes();
  await clickRetire(name);
  await page.getByLabel("Reason (required)").fill("duplicate");
  await page.getByRole("button", { name: /^Retire type|Retire$/ }).last().click().catch(async () => { await page.keyboard.press("Enter"); });
  await page.waitForTimeout(1500);
  const alert = (await page.getByRole("alert").allInnerTexts()).join(" | ") || (await page.getByRole("status").allInnerTexts()).join(" | ");
  const okMsg = expected instanceof RegExp ? expected.test(alert) : alert.includes(expected);
  check(label, okMsg && !(expectNot && alert.includes(expectNot) && expected !== "Could not reach Ogevia"), JSON.stringify(alert.slice(0, 140)));
  await page.screenshot({ path: `${out}/${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png` });
}
const json = (status, body) => (r) => r.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
await attempt("route works: type is retired", "synthetic cpp", null, "is retired");
await attempt("switch off (route missing, browser sees a failed request)", "synthetic cpr", (r) => r.abort("failed"), "This is not available in this environment yet.");
await attempt("expired sign-in (401 from the gateway)", "synthetic tb", json(401, { message: "Unauthorized" }), "Your session has ended. Please sign in again.");
await attempt("no permission (403)", "synthetic perm", json(403, { message: "Forbidden" }), "You do not have permission to do this.");
await attempt("business rule (409 with the server's own message)", "synthetic dbl", json(409, { error: { code: "conflict", message: "Cancel its open requests first." } }), "Cancel its open requests first.");
await attempt("server failure (500)", "synthetic srv", json(500, { message: "Internal server error" }), "Ogevia had a problem completing that");
// a genuine connection problem: every API request fails, including the check
await page.unroute("**/v1/document-types/*/retire").catch(() => {});
await page.goto("https://localhost/documents"); await settle(); await openTypes();
await clickRetire("synthetic srv");
await page.getByLabel("Reason (required)").fill("duplicate");
await page.route("**/v1/**", (r) => r.abort("internetdisconnected"));
await page.getByRole("button", { name: /^Retire type|Retire$/ }).last().click(); await page.waitForTimeout(1500);
const t = (await page.getByRole("alert").allInnerTexts()).join(" | ");
check("genuine connection problem keeps 'Could not reach Ogevia'", t.includes("Could not reach Ogevia"), JSON.stringify(t.slice(0, 120)));
await page.screenshot({ path: `${out}/connection-problem.png` });
await browser.close(); fs.writeFileSync(`${out}/results.json`, JSON.stringify(res, null, 1));
console.log(fails.length ? `\n${fails.length} FAILED:\n- ` + fails.join("\n- ") : "\nALL CHECKS PASSED"); process.exit(fails.length ? 1 : 0);
