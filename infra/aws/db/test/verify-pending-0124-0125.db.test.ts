// The TEST toolchain's read-only verification (VERIFY_PENDING.sql) for 0124, 0125 and 0126: "absent" before they are applied, every check true when "present", "absent" again after the rollback scripts.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_URL, createTestDb, type TestDb } from "./harness.js";

const PENDING = new URL("../pending/migrations/", import.meta.url);
const ROLLBACK = new URL("../pending/rollback/", import.meta.url);
const VERIFY = new URL("../../../../docs/releases/2026-11-20-test-plan/toolchain/VERIFY_PENDING.sql", import.meta.url).pathname;
let db: TestDb;
const run = async (sql: string) => { const c = await db.admin.connect(); try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(sql); await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
const verify = (mig: string, expect: "present" | "absent") => {
  const u = new URL(ADMIN_URL); u.pathname = `/${db.name}`;
  const r = spawnSync("psql", ["-X", "-At", "-F", "|", "-v", `mig=${mig}`, "-v", `expect=${expect}`, "-f", VERIFY, u.toString()], { encoding: "utf8" });
  const lines = r.stdout.split("\n").filter((l) => l.includes("|"));
  return { stderr: r.stderr, rows: lines.length, failing: lines.filter((l) => l.includes("|f|")) };
};

beforeAll(async () => { db = await createTestDb({ includeLiveTest: true }); }, 180_000);
afterAll(async () => db?.drop());

describe("VERIFY_PENDING.sql for 0124, 0125 and 0126", () => {
  it("is 'absent' before, 'present' after applying, and 'absent' again after the rollback scripts", async () => {
    for (const m of ["0124", "0125", "0126"]) { const a = verify(m, "absent"); expect(a.stderr).toBe(""); expect(a.failing, m).toEqual([]); expect(a.rows).toBeGreaterThanOrEqual(3); }
    for (const f of readdirSync(PENDING).filter((x) => x.endsWith(".sql")).sort()) await run(readFileSync(new URL(f, PENDING), "utf8"));
    const p4 = verify("0124", "present"); expect(p4.stderr).toBe(""); expect(p4.failing).toEqual(["ledger row 0124 present|f|"]); expect(p4.rows).toBe(13 + 34 * 4 + 1);   // only the ledger row fails (a test database has none); 13 tables; per function: exists, definer+search_path, no PUBLIC execute, app role execute
    const p5 = verify("0125", "present"); expect(p5.stderr).toBe(""); expect(p5.failing).toEqual(["ledger row 0125 present|f|"]); expect(p5.rows).toBe(5);
    const p6 = verify("0126", "present"); expect(p6.stderr).toBe(""); expect(p6.failing).toEqual(["ledger row 0126 present|f|"]); expect(p6.rows).toBe(21);
    await run(readFileSync(new URL("0126_service_address_history.down.sql", ROLLBACK), "utf8"));        // 0126 goes first: it depends on 0124
    expect(verify("0126", "absent").failing).toEqual([]);
    expect(verify("0126", "present").failing.length).toBeGreaterThan(1);
    // a half-applied state is caught: without the worklist function "present" fails
    await run(readFileSync(new URL("0125_authorization_worklist.down.sql", ROLLBACK), "utf8"));
    expect(verify("0125", "present").failing.length).toBeGreaterThan(1);
    expect(verify("0125", "absent").failing).toEqual([]);
    await run(readFileSync(new URL("0124_nfc_qr_visit_verification.down.sql", ROLLBACK), "utf8"));
    expect(verify("0124", "absent").failing).toEqual([]);
    expect(verify("0124", "present").failing.length).toBeGreaterThan(1);
  });
});
