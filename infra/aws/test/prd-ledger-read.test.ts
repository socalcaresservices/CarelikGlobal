// ledger-prd-read.sh (PRODUCTION read, report only; copy of ledger-recheck.sh). Fake aws/psql from ledger-window-mocks.ts. No AWS, synthetic.
// The production ledger is unknown, so the script REPORTS: it never asserts an expected version. Every path removes and verifies the temporary rule.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_SG, installMocks } from "./ledger-window-mocks.js";

vi.setConfig({ testTimeout: 60000 });
const SCRIPT = fileURLToPath(new URL("../../../docs/releases/2026-10-19-prd-readiness/scripts/ledger-prd-read.sh", import.meta.url));
const source = readFileSync(SCRIPT, "utf8");
const code = source.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const HOST_IP = "10.20.132.179";
const PSQL = `#!/usr/bin/env bash
D="$MOCK_DIR"
[[ "\${PGOPTIONS:-}" == *"default_transaction_read_only=on"* ]] || echo "psql without the read-only option" >> "$D/psql-violations.log"
echo "$*" >> "$D/psql-calls.log"
[[ -n "\${MOCK_PSQL_FAIL:-}" ]] && { echo "psql: connection failed" >&2; exit 2; }
case "$*" in
  *pg_database*) echo "\${MOCK_DBS-ogevia_sv_test,ogevia_prd}" ;;
  *current_database*) echo "\${MOCK_CURRENT_DB:-ogevia_prd} | read_only=on" ;;
  *"to_regclass('ogevia_meta"*) echo "\${MOCK_HAS_LEDGER:-true}" ;;
  *"to_regclass('ogevia.organization"*) echo "\${MOCK_HAS_ENF:-true}" ;;
  *enforcement_active_from*) echo "\${MOCK_ACT:-0}|2" ;;
  *"migrations applied, latest"*) echo "\${MOCK_SUMMARY:-38 migrations applied, latest 0038}" ;;
  *"select count(*) as c from ogevia"*) printf '%s\\n' "organizations: \${MOCK_N_ORGS:-2}" "app_users: 5" "organization_memberships: 5" "audit_events: 41" "caregiver_records: 3" "clients: 4" "shifts: 9" "service_visits: 6" ;;
  *"min(occurred_at)"*) echo "\${MOCK_AUDIT_SPAN:-2026-10-01 10:00:00+00 to 2026-10-10 05:00:00+00}" ;;
  *"limit 5"*) printf '%s\\n' "\${MOCK_ROWS:-0038  last_migration  applied 2026-10-10T05:00:00Z}" ;;
  *) echo "mock psql: unexpected: $*" >&2; exit 98 ;;
esac
`;
let dir: string, bin: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "prdread-")); bin = installMocks(dir); writeFileSync(join(bin, "psql"), PSQL); chmodSync(join(bin, "psql"), 0o755); });
const freePort = () => new Promise<number>((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => res(port)); }); });
async function run(args: string[], env: Record<string, string> = {}, input = "OPEN-5432-WINDOW\n"): Promise<{ code: number | null; out: string }> {
  const port = await freePort();
  return new Promise((resolve) => {
    const e = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_DIR: dir, HOME: dir, OGEVIA_LEDGER_STATE_DIR: join(dir, "state"), OGEVIA_LEDGER_DIR: join(dir, `out-${Math.random().toString(36).slice(2)}`), OGEVIA_LEDGER_PORT: String(port), MOCK_LAMBDA_DB: "ogevia_prd", MOCK_LAMBDA_ENV: "prd", OGEVIA_TUNNEL_WAIT: "10", OGEVIA_EXPECT_HOST_IP: HOST_IP, OGEVIA_EXPECT_LEDGER_COUNT: "77", OGEVIA_EXPECT_LEDGER_LATEST: "0077", ...env };
    const p = spawn("bash", [SCRIPT, ...args], { env: e, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.stdin.on("error", () => undefined); p.stdin.end(input);
    p.on("close", (c) => resolve({ code: c, out }));
  });
}
const sg = () => JSON.parse(readFileSync(join(dir, "sg.json"), "utf8"));
const calls = () => (existsSync(join(dir, "aws-calls.log")) ? readFileSync(join(dir, "aws-calls.log"), "utf8") : "");
const marker = () => existsSync(join(dir, "state", "OPEN"));


const PRD = ["prd", "--host-ip"];
describe("the production report", () => {
  it("reports the ledger as found (38 / 0038 here), exits 0, adds the /32 rule once, removes it, restores the rule set", async () => {
    const r = await run(PRD);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("connected: ogevia_prd | read_only=on");
    expect(r.out).toContain("ledger summary: 38 migrations applied, latest 0038");
    expect(r.out).toContain("Five newest ledger rows");
    expect(r.out).toContain("enforcement activated for 0 of 2 agencies");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
    expect(calls().split("\n").filter((c) => c.startsWith("ec2 authorize-security-group-ingress"))).toHaveLength(1);
    expect(calls()).toContain(`CidrIp=${HOST_IP}/32`);
    expect(existsSync(join(dir, "psql-violations.log"))).toBe(false);
  });
  it.each([
    ["any other ledger (85 / 0085)", { MOCK_SUMMARY: "85 migrations applied, latest 0085" }, "85 migrations applied, latest 0085"],
    ["46 / 0046", { MOCK_SUMMARY: "46 migrations applied, latest 0046" }, "46 migrations applied, latest 0046"],
    ["no ledger table", { MOCK_HAS_LEDGER: "false" }, "NO ledger table"],
    ["the database missing", { MOCK_DBS: "ogevia_sv_test" }, "DOES NOT EXIST"],
    ["no enforcement table (old schema)", { MOCK_HAS_ENF: "false" }, "enforcement table not present"],
  ])("reports %s without a verdict (exit 0) and still restores the rule", async (_n, env, text) => {
    const r = await run(PRD, env as Record<string, string>);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(text);
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("needs no expected-version variables", async () => {
    const r = await run(PRD, { OGEVIA_EXPECT_LEDGER_COUNT: "", OGEVIA_EXPECT_LEDGER_LATEST: "" });
    expect(r.code, r.out).toBe(0);
  });
  it("a wrong host IP, the TEST environment, the plain prd mode on a shared group, a TEST Lambda and a wrong database stop; nothing is changed", async () => {
    expect((await run(PRD, { OGEVIA_EXPECT_HOST_IP: "10.20.132.180" })).code).toBe(1);
    expect((await run(["test", "--host-ip"])).code).toBe(2);
    expect((await run(["test"])).code).toBe(2);
    const sh = await run(["prd"], { MOCK_SHARED_ENI: "endpoints" });
    expect(sh.code, sh.out).toBe(1); expect(sh.out).toContain("used by more than the admin host");
    const t = await run(PRD, { MOCK_LAMBDA_DB: "ogevia_sv_test", MOCK_LAMBDA_ENV: "test" });
    expect(t.code, t.out).toBe(1); expect(t.out).toContain("not 'ogevia_prd'");
    const w = await run(PRD, { MOCK_CURRENT_DB: "ogevia_sv_test" });
    expect(w.code, w.out).toBe(1); expect(w.out).toContain("connected to 'ogevia_sv_test', not 'ogevia_prd'");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("a declined phrase changes nothing", async () => {
    const r = await run(PRD, {}, "no\n");
    expect(r.out).toMatch(/Declined|Nothing was changed/);
    expect(calls()).not.toContain("authorize-security-group-ingress");
  });
});

describe("the script is read-only toward the database and targets only production", () => {
  it("names the production stack and database, has no write statement, and runs git nowhere", () => {
    expect(code).toContain("API_STACK=Ogevia-prd-ServiceVerificationApi");
    expect(code).toContain("DB_EXPECT=ogevia_prd");
    expect(code).not.toMatch(/API_STACK=Ogevia-prod-/);
    const sql = [...code.matchAll(/-c "([^"]*)"/g)].map((m) => m[1]!);
    expect(sql.length).toBeGreaterThan(5);
    for (const q of sql) expect(q).not.toMatch(/\b(insert|update|delete|drop|truncate|alter|create)\b/i);
    expect(code).not.toMatch(/(^|[\s(;&|])git\s/m);
  });
});

describe("the opt-in counts read (OGEVIA_PRD_READ_COUNTS=1): counts only, read-only", () => {
  it("is OFF by default: no counts query is issued and nothing about row counts is printed", async () => {
    const r = await run(PRD);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("table row counts");
    expect(readFileSync(join(dir, "psql-calls.log"), "utf8")).not.toContain("query_to_xml");
  });
  it("when set, prints each table's row count and the audit span, still read-only, and still restores the rule set", async () => {
    const r = await run(PRD, { OGEVIA_PRD_READ_COUNTS: "1", MOCK_N_ORGS: "7" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("table row counts (counts only):");
    for (const line of ["organizations: 7", "app_users: 5", "organization_memberships: 5", "audit_events: 41", "caregiver_records: 3", "clients: 4", "shifts: 9", "service_visits: 6"]) expect(r.out).toContain(line);
    expect(r.out).toContain("audit events span: 2026-10-01 10:00:00+00 to 2026-10-10 05:00:00+00");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(existsSync(join(dir, "psql-violations.log"))).toBe(false);
  });
  it("the counts block selects only counts and a date range: no names, no identifiers, no write", () => {
    const start = source.indexOf("OGEVIA_PRD_READ_COUNTS"); const block = source.slice(start, source.indexOf("LEDGER_TEXT=\"RESULT for $ARG", start));
    expect(block.length).toBeGreaterThan(200);
    expect(block).toMatch(/count\(\*\)/);
    expect(block).not.toMatch(/\b(insert|update|delete|drop|truncate|alter|create)\b/i);
    expect(block).not.toMatch(/display_name|first_name|last_name|email|preferred_name|cognito_sub/i);
  });
});
