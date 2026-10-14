import { createRequire } from "node:module";
const require = createRequire("/opt/node-tools/package.json");
export const { chromium } = require("playwright");
import { mkdirSync } from "node:fs";
export const OUT = process.env.WK_OUT ?? "/home/user/CarelikGlobal/docs/releases/2026-10-14-pilot-readiness/evidence/phase-b";
mkdirSync(OUT, { recursive: true });
export const results = [];
export function rec(persona, id, name, ok, detail = "") { results.push({ persona, id, name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  [${persona}] ${id} ${name}${detail ? "  (" + detail + ")" : ""}`); }
export async function open(browser, opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: !!opts.mobile, isMobile: !!opts.mobile, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push(`http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  page.on("pageerror", (e) => problems.push("pageerror: " + String(e).slice(0, 200)));
  return { ctx, page, problems };
}
export async function signIn(page, name) {
  await page.goto("https://localhost/", { waitUntil: "networkidle" });
  const btn = page.getByRole("button", { name: /sign in/i }).first();
  if (await btn.count()) await btn.click();
  await page.waitForLoadState("networkidle");
  const pick = page.getByText(name, { exact: false }).first();
  await pick.click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
}
export async function shot(page, file) { await page.screenshot({ path: `${OUT}/${file}.png`, fullPage: false }); }
export async function text(page) { return (await page.locator("body").innerText()).replace(/\n{2,}/g, "\n"); }
export function summary() { const f = results.filter((r) => !r.ok); console.log(`\n${results.length} checks, ${results.length - f.length} passed, ${f.length} failed`); return f.length; }
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
export const DBURL = "postgres://postgres@127.0.0.1:5432/ogevia_local_harness";
export const sql = (q) => execFileSync("psql", ["-X", "-At", DBURL, "-c", q]).toString().trim();
export const code = (n) => sql(`select c.client_code from ogevia.clients c join ogevia.client_private_names p on p.client_id=c.id where p.legal_last_name like '${n}%'`);
export const sqlAdmin = (q) => execFileSync("psql", ["-X", "-At", DBURL, "-c", "set session_replication_role = replica", "-c", q]).toString().trim();
export async function dump(page, label, from = 0) { writeFileSync(`${OUT}/${label}.txt`, (await text(page)).split("\n").slice(from).join("\n")); }
export async function drawSignature(page) {
  const box = await page.locator("canvas").first().boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 20 + i * ((box.width - 40) / 12), box.y + box.height / 2 + (i % 2 ? -18 : 18), { steps: 3 });
  await page.mouse.up();
}
export async function browserLaunch() { return chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] }); }
