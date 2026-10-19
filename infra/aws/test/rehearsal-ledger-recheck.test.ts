// ledger-recheck.sh (TEST rehearsal copy of ledger-check-temp-access.sh v3): the ledger VERDICT. Fake aws/psql from ledger-window-mocks.ts. No AWS, synthetic.
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
const SCRIPT = fileURLToPath(new URL("../../../docs/releases/2026-10-19-test-rehearsal/scripts/ledger-recheck.sh", import.meta.url));
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
  *enforcement_active_from*) echo "\${MOCK_ACT:-0}|2" ;;
  *"migrations applied, latest"*) echo "\${MOCK_SUMMARY:-77 migrations applied, latest 0077}" ;;
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
    const e = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_DIR: dir, HOME: dir, OGEVIA_LEDGER_STATE_DIR: join(dir, "state"), OGEVIA_LEDGER_DIR: join(dir, `out-${Math.random().toString(36).slice(2)}`), OGEVIA_LEDGER_PORT: String(port), OGEVIA_TUNNEL_WAIT: "10", OGEVIA_EXPECT_HOST_IP: HOST_IP, OGEVIA_EXPECT_LEDGER_COUNT: "77", OGEVIA_EXPECT_LEDGER_LATEST: "0077", ...env };
    const p = spawn("bash", [SCRIPT, ...args], { env: e, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.stdin.on("error", () => undefined); p.stdin.end(input);
    p.on("close", (c) => resolve({ code: c, out }));
  });
}
const sg = () => JSON.parse(readFileSync(join(dir, "sg.json"), "utf8"));
const calls = () => (existsSync(join(dir, "aws-calls.log")) ? readFileSync(join(dir, "aws-calls.log"), "utf8") : "");
const marker = () => existsSync(join(dir, "state", "OPEN"));

describe("the ledger verdict", () => {
  it("77 rows, latest 0077, none above it, enforcement OFF: exit 0, the /32 rule added once and removed, rule set restored", async () => {
    const r = await run(["test", "--host-ip"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("connected: ogevia_sv_test | read_only=on");
    expect(r.out).toContain("NO ROW is above 0077: the TEST ledger is exactly the expected 77 / 0077, and enforcement is activated for 0 of 2 agencies as expected.");
    expect(r.out).toContain("RESTORED (verified)");
    expect(r.out).toContain("SECURITY GROUP: restored and verified identical to the original");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
    expect(calls().split("\n").filter((c) => c.startsWith("ec2 authorize-security-group-ingress"))).toHaveLength(1);
    expect(calls()).toContain(`CidrIp=${HOST_IP}/32`);
    expect(existsSync(join(dir, "psql-violations.log"))).toBe(false);
  });
  it.each([
    ["76 rows, latest 0076", { MOCK_SUMMARY: "76 migrations applied, latest 0076" }, "requires exactly '77 migrations applied, latest 0077'"],
    ["the old ledger 52 / 0052", { MOCK_SUMMARY: "52 migrations applied, latest 0052" }, "requires exactly"],
    ["78 rows, latest 0078 (one of the new migrations is already there)", { MOCK_SUMMARY: "78 migrations applied, latest 0078", MOCK_ROWS: "0078  abc  assignment_outcome  applied 2026-10-19T01:00:00Z" }, "ARE ALREADY APPLIED"],
    ["84 rows, latest 0084 (already migrated)", { MOCK_SUMMARY: "84 migrations applied, latest 0084", MOCK_ROWS: "0078  a  x  applied t\n0084  b  y  applied t" }, "do not continue"],
    ["77 rows but a row above 0077 (a gap in the ledger)", { MOCK_ROWS: "0081  abc  x  applied 2026-10-19T01:00:00Z" }, "ARE ALREADY APPLIED"],
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
  it("the expected values are required and checked for consistency before anything is opened (usage exit 2)", async () => {
    for (const env of <Array<Record<string, string>>>[{ OGEVIA_EXPECT_LEDGER_COUNT: "" }, { OGEVIA_EXPECT_LEDGER_LATEST: "" }, { OGEVIA_EXPECT_LEDGER_COUNT: "77", OGEVIA_EXPECT_LEDGER_LATEST: "0084" }, { OGEVIA_EXPECT_LEDGER_COUNT: "x7", OGEVIA_EXPECT_LEDGER_LATEST: "0077" }]) {
      const r = await run(["test", "--host-ip"], env);
      expect(r.code, r.out).toBe(2);
    }
    expect(calls()).not.toContain("authorize");
  });
  it("84 / 0084 is accepted as the AFTER state with the same script", async () => {
    const r = await run(["test", "--host-ip"], { OGEVIA_EXPECT_LEDGER_COUNT: "84", OGEVIA_EXPECT_LEDGER_LATEST: "0084", MOCK_SUMMARY: "84 migrations applied, latest 0084" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("exactly the expected 84 / 0084");
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

describe("what the copy changed from v3 is only what the header says", () => {
  it("names no production stack or database as a target, selects only ledger and readiness rows, and has no write statement", () => {
    expect(code).not.toMatch(/DB_EXPECT=ogevia_prd|Ogevia-prd-|ogevia_prd'/);
    const sql = [...code.matchAll(/-c "([^"]*)"/g)].map((m) => m[1]!);
    for (const q of sql) expect(q).not.toMatch(/\b(insert|update|delete|drop|truncate|alter|create)\b/i);
    expect(code).toContain("select count(*) filter (where enforcement_active_from is not null)");
    expect(code).not.toMatch(/(^|[\s(;&|])git\s/m);
  });
});
