// ledger-recheck.sh (TEST release 7870a04 copy): the ledger VERDICT. Fake aws/psql from ledger-window-mocks.ts. No AWS, synthetic.
// Required by the owner's approval: TEST must show exactly 77 rows, latest 0077, no row above it, enforcement OFF; anything else STOPS (exit 1) and the rule is still removed and verified.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_SG, installMocks } from "./ledger-window-mocks.js";

vi.setConfig({ testTimeout: 60000 });
const SCRIPT = fileURLToPath(new URL("../../../docs/releases/2026-10-26-redesign-operator/scripts/ledger-recheck.sh", import.meta.url));
const source = readFileSync(SCRIPT, "utf8");
const code = source.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const HOST_IP = "10.20.132.179";
const PSQL = `#!/usr/bin/env bash
D="$MOCK_DIR"
[[ "\${PGOPTIONS:-}" == *"default_transaction_read_only=on"* ]] || echo "psql without the read-only option" >> "$D/psql-violations.log"
echo "$*" >> "$D/psql-calls.log"
[[ -n "\${MOCK_PSQL_FAIL:-}" ]] && { echo "psql: connection failed" >&2; exit 2; }
case "$*" in
  *pg_database*) echo "\${MOCK_DBS-ogevia_sv_test}" ;;
  *current_database*) echo "\${MOCK_CURRENT_DB:-ogevia_sv_test} | read_only=on" ;;
  *staff_types*) echo "\${MOCK_S86:-0|0|0}" ;;
  *enforcement_active_from*) echo "\${MOCK_ACT:-0}|2" ;;
  *"migrations applied, latest"*) echo "\${MOCK_SUMMARY:-85 migrations applied, latest 0085}" ;;
  *"version > '"*) if [[ -n "\${MOCK_ROWS:-}" ]]; then printf '%s\\n' "$MOCK_ROWS"; fi ;;
  *) echo "mock psql: unexpected: $*" >&2; exit 98 ;;
esac
`;
let dir: string, bin: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "recheck-")); bin = installMocks(dir); writeFileSync(join(bin, "psql"), PSQL); chmodSync(join(bin, "psql"), 0o755); });
const freePort = () => new Promise<number>((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => res(port)); }); });
async function run(args: string[], env: Record<string, string> = {}, input = "OPEN-5432-WINDOW\n"): Promise<{ code: number | null; out: string }> {
  const port = await freePort();
  return new Promise((resolve) => {
    const e = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_DIR: dir, HOME: dir, OGEVIA_LEDGER_STATE_DIR: join(dir, "state"), OGEVIA_LEDGER_DIR: join(dir, `out-${Math.random().toString(36).slice(2)}`), OGEVIA_LEDGER_PORT: String(port), OGEVIA_TUNNEL_WAIT: "10", OGEVIA_EXPECT_HOST_IP: HOST_IP, OGEVIA_EXPECT_LEDGER_COUNT: "85", OGEVIA_EXPECT_LEDGER_LATEST: "0085", ...env };
    const p = spawn("bash", [SCRIPT, ...args], { env: e, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.stdin.on("error", () => undefined); p.stdin.end(input);
    p.on("close", (c) => resolve({ code: c, out }));
  });
}
const sg = () => JSON.parse(readFileSync(join(dir, "sg.json"), "utf8"));
const calls = () => (existsSync(join(dir, "aws-calls.log")) ? readFileSync(join(dir, "aws-calls.log"), "utf8") : "");
const marker = () => existsSync(join(dir, "state", "OPEN"));

describe("the ledger verdict (85 / 0085 before AND after: 0086 is applied outside the ledger)", () => {
  it("85 rows, latest 0085, none above it, enforcement OFF, no 0086 expectation: exit 0, the /32 rule added once and removed, rule set restored", async () => {
    const r = await run(["test", "--host-ip"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("connected: ogevia_sv_test | read_only=on");
    expect(r.out).toContain("NO ROW is above 0085: the TEST ledger is exactly the expected 85 / 0085, and enforcement is activated for 0 of 2 agencies as expected.");
    expect(r.out).toContain("RESTORED (verified)");
    expect(r.out).toContain("SECURITY GROUP: restored and verified identical to the original");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
    expect(calls().split("\n").filter((c) => c.startsWith("ec2 authorize-security-group-ingress"))).toHaveLength(1);
    expect(calls()).toContain(`CidrIp=${HOST_IP}/32`);
    expect(existsSync(join(dir, "psql-violations.log"))).toBe(false);
  });
  it.each([
    ["84 rows, latest 0084", { MOCK_SUMMARY: "84 migrations applied, latest 0084" }, "requires exactly '85 migrations applied, latest 0085'"],
    ["86 rows, latest 0086 (0086 was applied by the RUNNER, which this release does not do)", { MOCK_SUMMARY: "86 migrations applied, latest 0086", MOCK_ROWS: "0086  abc  staff_management  applied 2026-10-27T01:00:00Z" }, "ARE ALREADY APPLIED"],
    ["85 rows but a row above 0085", { MOCK_ROWS: "0086  abc  x  applied 2026-10-27T01:00:00Z" }, "ARE ALREADY APPLIED"],
    ["enforcement ACTIVE for one agency", { MOCK_ACT: "1" }, "0 activated agencies"],
    ["the TEST database missing", { MOCK_DBS: "" }, "DOES NOT EXIST"],
  ])("exits 1 with STOP for %s, after removing and verifying the rule", async (_n, env, text) => {
    const r = await run(["test", "--host-ip"], env as Record<string, string>);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("STOP");
    expect(r.out).toContain(text);
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("OGEVIA_EXPECT_0086=absent: passes while the staff objects are 0|0|0 (before the apply)", async () => {
    const r = await run(["test", "--host-ip"], { OGEVIA_EXPECT_0086: "absent", MOCK_S86: "0|0|0" });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("staff-management objects (staff_types|staff_profiles|functions of 21): 0|0|0"); expect(r.out).toContain("0086 is ABSENT as expected.");
  });
  it("OGEVIA_EXPECT_0086=present: passes while the staff objects are 1|1|21 (after the apply) with the ledger still 85 / 0085", async () => {
    const r = await run(["test", "--host-ip"], { OGEVIA_EXPECT_0086: "present", MOCK_S86: "1|1|21" });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("0086 is PRESENT as expected (2 tables, 21 functions)."); expect(r.out).toContain("exactly the expected 85 / 0085");
  });
  it.each([
    ["absent expected, all present", "absent", "1|1|21"],
    ["absent expected, partial", "absent", "1|1|0"],
    ["present expected, all absent", "present", "0|0|0"],
    ["present expected, 20 of 21 functions", "present", "1|1|20"],
    ["present expected, one table", "present", "1|0|21"],
  ])("a 0086 state that is not what the plan expects stops (exit 1, rule restored): %s", async (_n, expect0086, s86) => {
    const r = await run(["test", "--host-ip"], { OGEVIA_EXPECT_0086: expect0086, MOCK_S86: s86 });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("BUT the staff-management objects are"); expect(r.out).toContain("STOP"); expect(r.out).toContain("RESTORED (verified)"); expect(sg()).toEqual(INITIAL_SG);
  });
  it("an invalid OGEVIA_EXPECT_0086 is a usage error before anything is opened; the 0086 check is skipped when the variable is unset", async () => {
    const r = await run(["test", "--host-ip"], { OGEVIA_EXPECT_0086: "maybe" });
    expect(r.code, r.out).toBe(2); expect(calls()).not.toContain("authorize");
    const ok = await run(["test", "--host-ip"], { MOCK_S86: "1|1|3" });
    expect(ok.code, ok.out).toBe(0); expect(ok.out).not.toContain("staff-management objects");
  });
  it("the expected values are required and checked for consistency before anything is opened (usage exit 2)", async () => {
    for (const env of <Array<Record<string, string>>>[{ OGEVIA_EXPECT_LEDGER_COUNT: "" }, { OGEVIA_EXPECT_LEDGER_LATEST: "" }, { OGEVIA_EXPECT_LEDGER_COUNT: "85", OGEVIA_EXPECT_LEDGER_LATEST: "0086" }, { OGEVIA_EXPECT_LEDGER_COUNT: "x5", OGEVIA_EXPECT_LEDGER_LATEST: "0085" }]) {
      const r = await run(["test", "--host-ip"], env);
      expect(r.code, r.out).toBe(2);
    }
    expect(calls()).not.toContain("authorize");
  });
  it("a wrong host IP, the production mode, and a wrong database stop; nothing is changed", async () => {
    expect((await run(["test", "--host-ip"], { OGEVIA_EXPECT_HOST_IP: "10.20.132.180" })).code).toBe(1);
    expect((await run(["prod"])).code).toBe(2);
    expect((await run(["prod", "--host-ip"])).code).toBe(2);
    const w = await run(["test", "--host-ip"], { MOCK_CURRENT_DB: "ogevia_prd" });
    expect(w.code, w.out).toBe(1); expect(w.out).toContain("connected to 'ogevia_prd', not 'ogevia_sv_test'");
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("a declined phrase changes nothing", async () => {
    const r = await run(["test", "--host-ip"], {}, "no\n");
    expect(r.out).toMatch(/Declined|Nothing was changed/);
    expect(calls()).not.toContain("authorize-security-group-ingress");
  });
});

describe("what the copy changed is only what the header says", () => {
  it("names no production stack or database as a target, selects only ledger, readiness and catalog rows, and has no write statement", () => {
    expect(code).not.toMatch(/DB_EXPECT=ogevia_prd|Ogevia-prd-|ogevia_prd'/);
    const sql = [...code.matchAll(/-c "([^"]*)"/g)].map((m) => m[1]!);
    for (const q of sql) expect(q).not.toMatch(/\b(insert|update|delete|drop|truncate|alter|create)\b/i);
    expect(code).toContain("select count(*) filter (where enforcement_active_from is not null)");
    expect(code).not.toMatch(/(^|[\s(;&|])git\s/m);
  });
});
