// ACCEPTANCE on the LOCAL harness (synthetic data, all routes present): successful retirement of a duplicate document type.
// Add a synthetic duplicate, request it for a caregiver, cancel the request (history), retire the type with a reason; then: gone from the active list at once, still gone after reload,
// not offered on new requests, and the record, the cancelled request and the audit event are all preserved (checked in the database).   node retire-acceptance.mjs <outdir>
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const { chromium } = createRequire("/opt/node-tools/")("playwright");
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const NAME = "Synthetic CPR duplicate";
const sql = (q) => spawnSync("psql", ["-h", "127.0.0.1", "-U", "postgres", "-d", "ogevia_local_harness", "-X", "-At", "-F", "|", "-c", q], { encoding: "utf8", env: { ...process.env, PGPASSWORD: "postgres" } }).stdout.trim();
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 1100 }, ignoreHTTPSErrors: true })).newPage();
await page.goto("https://localhost/");
await page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in/i })).first().click();
await page.getByText("Olivia Owner").first().click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
const res = []; const fails = [];
const check = (n, ok, d = "") => { res.push({ n, ok, d }); if (!ok) fails.push(n + ": " + d); console.log((ok ? "PASS " : "FAIL ") + n + (d ? "  " + d : "")); };
const settle = (ms = 900) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(ms));
const openTypes = async () => { if (!(await page.getByPlaceholder("e.g. CPR card").isVisible())) await page.locator("summary", { hasText: "Document types and reminder days" }).click(); await page.waitForTimeout(300); };
const typesText = async () => { const t = (await page.locator("main").innerText()).replace(/\s+/g, " "); const i = t.indexOf("Document types and reminder days"); return t.slice(i, i + 700); };
const chips = async () => { const t = await typesText(); const ends = ["Retired (cannot", "New type"].map((m) => t.indexOf(m)).filter((i) => i >= 0); return t.slice(0, Math.min(...ends)).includes(NAME); };

await page.goto("https://localhost/documents"); await settle(); await openTypes();
await page.getByPlaceholder("e.g. CPR card").fill(NAME); await page.getByRole("button", { name: "Add type" }).click(); await page.waitForTimeout(900);
check("the synthetic duplicate type exists and is active", await chips());
// a request for it, then cancelled (so the type has history and no open request)
await page.locator("summary", { hasText: "Request a document" }).click();
await page.locator("#doc-request-person").selectOption({ index: 1 });
await page.locator("#doc-request-type").selectOption({ label: NAME });
await page.getByRole("button", { name: "Request document" }).click(); await page.waitForTimeout(1200);
check("a request for the duplicate type was created", sql(`select count(*) from ogevia.staff_documents d join ogevia.document_types t on t.id=d.document_type_id where t.name='${NAME}'`) === "1");
// retiring while a request is open must be refused with the business-rule message
await openTypes(); await page.evaluate((n) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Retire" && b.parentElement.textContent.includes(n) && b.parentElement.textContent.length < n.length + 60).click(), NAME);
await page.getByLabel("Reason (required)").fill("duplicate"); await page.getByRole("button", { name: "Retire type" }).click(); await page.waitForTimeout(1200);
const refused = (await page.getByRole("alert").allInnerTexts()).join(" | ");
check("retiring with an open request is refused with the business-rule message", /open request/i.test(refused), JSON.stringify(refused.slice(0, 120)));
check("... and the type is still active", sql(`select is_active from ogevia.document_types where name='${NAME}'`) === "t");
await page.screenshot({ path: `${out}/01-refused-open-request.png` });
// cancel the request
await page.goto("https://localhost/documents"); await settle();
const cancel = page.getByRole("button", { name: /^Cancel request$/ }).first();
if (!(await cancel.isVisible())) await page.locator("summary", { hasText: "Details" }).first().click().catch(() => {});
await page.getByRole("button", { name: /^Cancel request$/ }).first().click();
await page.getByLabel("Reason for cancelling (required)").fill("duplicate request (synthetic)"); await page.getByRole("button", { name: "Cancel request" }).last().click(); await page.waitForTimeout(1400);
check("the request was cancelled and kept for the record", sql(`select count(*) from ogevia.staff_documents d join ogevia.document_types t on t.id=d.document_type_id where t.name='${NAME}' and d.closed_at is not null`) === "1");
// retire
await openTypes();
await page.evaluate((n) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Retire" && b.parentElement.textContent.includes(n) && b.parentElement.textContent.length < n.length + 60).click(), NAME);
await page.getByLabel("Reason (required)").fill("duplicate"); await page.getByRole("button", { name: "Retire type" }).click();
await page.waitForTimeout(1500);
const done = (await page.getByRole("status").allInnerTexts()).join(" | ");
check("success message shown", /is retired and can no longer be requested/.test(done), JSON.stringify(done.slice(0, 140)));
check("gone from the active list immediately (no reload)", !(await chips()) );
check("listed as retired (cannot be requested)", (await typesText()).includes("Retired (cannot be requested): " + NAME));
await page.screenshot({ path: `${out}/02-retired-immediately.png` });
await page.reload(); await settle(); await openTypes();
check("still gone from the active list after reload", !(await chips()));
check("still listed as retired after reload", (await typesText()).includes("Retired (cannot be requested): " + NAME));
await page.locator("summary", { hasText: "Request a document" }).click();
const offered = await page.locator("#doc-request-type").evaluate((e) => [...e.options].map((o) => o.textContent));
check("not offered on a new request", !offered.includes(NAME), JSON.stringify(offered));
await page.screenshot({ path: `${out}/03-after-reload.png` });
// history and audit, in the database
check("the type record is kept, inactive, with who and when", /^f\|[0-9a-f-]{36}\|t$/.test(sql(`select is_active, retired_by, retired_at is not null from ogevia.document_types where name='${NAME}'`)), sql(`select is_active, (retired_by is not null), retired_at is not null from ogevia.document_types where name='${NAME}'`));
check("the cancelled request is kept and still points at the type", sql(`select count(*) from ogevia.staff_documents d join ogevia.document_types t on t.id=d.document_type_id where t.name='${NAME}'`) === "1");
check("the cancel reason is recorded", sql(`select cancel_reason from ogevia.staff_documents d join ogevia.document_types t on t.id=d.document_type_id where t.name='${NAME}'`) === "duplicate request (synthetic)");
const audit = sql(`select action||'|'||reason||'|'||(before_state->>'is_active')||'->'||(after_state->>'is_active') from ogevia.audit_events where action='document_type.retired' order by occurred_at desc limit 1`);
check("the audit event is recorded with the reason and the before/after state", audit === "document_type.retired|duplicate|true->false", audit);
check("the cancel is audited too", Number(sql(`select count(*) from ogevia.audit_events where action like 'staff_document%cancel%' or action like '%cancel%'`)) >= 1);
await browser.close(); fs.writeFileSync(`${out}/results.json`, JSON.stringify(res, null, 1));
console.log(fails.length ? `\n${fails.length} FAILED:\n- ` + fails.join("\n- ") : "\nALL CHECKS PASSED"); process.exit(fails.length ? 1 : 0);
