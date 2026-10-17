// Rehearsal of slice/ledger-check-temp-access.sh against a FAKE aws/psql (test/ledger-window-mocks.ts): no AWS, no network, synthetic.
// Proves the control flow the owner is asked to approve: preconditions change nothing, the single rule is added and removed on success,
// failure, interruption and revoke errors, restoration is verified by a hash of every rule, a failed restore leaves a marker that blocks
// the next run until --restore-only succeeds, queries are read-only, and no credential reaches the output.
// It cannot prove what real AWS does; it proves the script's own logic.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60000 });
import { INITIAL_SG, installMocks } from "./ledger-window-mocks.js";

const SCRIPT = fileURLToPath(new URL("../slice/ledger-check-temp-access.sh", import.meta.url));
const source = readFileSync(SCRIPT, "utf8");
const code = source.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const ADMIN = "sg-00e01e2ca80442c1f";

let dir: string;
let bin: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-window-"));
  bin = installMocks(dir);
});

interface Run { code: number | null; out: string; dir: string }
function run(args: string[], opts: { env?: Record<string, string>; input?: string; killWhen?: () => boolean } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_DIR: dir, OGEVIA_LEDGER_STATE_DIR: join(dir, "state"), OGEVIA_LEDGER_DIR: join(dir, `out-${Math.random().toString(36).slice(2)}`), OGEVIA_LEDGER_PORT: String(20000 + Math.floor(Math.random() * 20000)), HOME: dir, ...(opts.env ?? {}) };
    const p = spawn("bash", [SCRIPT, ...args], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.stdin.end(opts.input ?? "OPEN-5432-WINDOW\n");
    let killed = false;
    const timer = opts.killWhen ? setInterval(() => { if (!killed && opts.killWhen!()) { killed = true; process.kill(-p.pid!, "SIGTERM"); /* the whole foreground group, as Ctrl+C or a closed terminal does */ } }, 50) : null;
    p.on("close", (c) => { if (timer) clearInterval(timer); resolve({ code: c, out, dir: env.OGEVIA_LEDGER_DIR }); });
  });
}
const sg = () => JSON.parse(readFileSync(join(dir, "sg.json"), "utf8"));
const calls = () => (existsSync(join(dir, "aws-calls.log")) ? readFileSync(join(dir, "aws-calls.log"), "utf8").split("\n").filter(Boolean) : []);
const rulePresent = () => sg().i.some((p: any) => p.FromPort === 5432 && p.UserIdGroupPairs.some((g: any) => g.GroupId === ADMIN));
const marker = () => existsSync(join(dir, "state", "OPEN"));
const verbs = () => calls().map((c) => c.split(" ").slice(0, 2).join(" "));

describe("preconditions change nothing", () => {
  it("refuses a wrong environment: the Lambda serves another database", async () => {
    const r = await run(["test"], { env: { MOCK_LAMBDA_DB: "ogevia_prd", MOCK_LAMBDA_ENV: "prd" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Not the requested environment");
    expect(verbs()).not.toContain("ec2 authorize-security-group-ingress");
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("refuses when the admin host's groups are not exactly the expected one", async () => {
    const r = await run(["test"], { env: { MOCK_HOST_SG: "sg-0123456789abcdef0" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("expected exactly");
    expect(verbs()).not.toContain("ec2 authorize-security-group-ingress");
  });
  it("refuses when the admin group is used by another network interface (the rule would grant others)", async () => {
    const r = await run(["test"], { env: { MOCK_SHARED_ENI: "1" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("more than the admin host");
    expect(verbs()).not.toContain("ec2 authorize-security-group-ingress");
  });
  it("refuses when the RDS group is not the expected one", async () => {
    const r = await run(["test"], { env: { MOCK_RDS_SG: "sg-0aaaaaaaaaaaaaaaa" } });
    expect(r.code).toBe(1);
    expect(verbs()).not.toContain("ec2 authorize-security-group-ingress");
  });
  it("does nothing unless the exact phrase is typed", async () => {
    const r = await run(["test"], { input: "yes\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Declined. Nothing was changed.");
    expect(verbs()).not.toContain("ec2 authorize-security-group-ingress");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("shows the original configuration and the exact change before asking", async () => {
    const r = await run(["test"], { input: "no\n" });
    expect(r.out).toContain("ORIGINAL CONFIGURATION");
    expect(r.out).toContain("security groups [sg-00e01e2ca80442c1f]  (NOT modified by this script)");
    expect(r.out).toContain("tcp 5432-5432  from sg-064ffce3bcbe8eb3b");
    expect(r.out).toContain("ORIGINAL rule-set sha256:");
    expect(r.out).toContain("ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from sg-00e01e2ca80442c1f");
  });
});

describe("the window", () => {
  it("success: the single rule is added, queried through, removed, and restoration is verified; the output holds no credential", async () => {
    const r = await run(["test"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("exactly one rule was added");
    expect(r.out).toContain("RESTORED (verified)");
    expect(r.out).toContain("connected: ogevia_sv_test | read_only=on");
    expect(r.out).toContain("NO ROW has version >= 0053");
    expect(r.out).toContain("SECURITY GROUP: restored and verified identical to the original");
    expect(sg()).toEqual(INITIAL_SG);
    expect(rulePresent()).toBe(false);
    expect(marker()).toBe(false);
    const all = r.out + readdirSync(r.dir).map((f) => readFileSync(join(r.dir, f), "utf8")).join("\n");
    expect(all).not.toContain("SECRET-PW-CANARY");
    // only the intended AWS verbs: one authorize, at least one revoke, no change to the host, no other write
    const v = verbs();
    expect(v.filter((x) => x === "ec2 authorize-security-group-ingress")).toHaveLength(1);
    expect(v.filter((x) => x === "ec2 revoke-security-group-ingress").length).toBeGreaterThanOrEqual(1);
    expect(v.join("|")).not.toMatch(/modify|attach|create|delete|update|UNEXPECTED/);
    expect(existsSync(join(dir, "psql-violations.log"))).toBe(false);
  });
  it("ledger rows 0053+: reported with a STOP, and the group is still restored", async () => {
    const r = await run(["test"], { env: { MOCK_LEDGER_ROWS: "0053  abc  0053_x.sql  applied 2026-10-17T12:00:00Z" } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("ARE APPLIED");
    expect(r.out).toContain("do not edit migration files in place");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("a database that does not exist is reported, and the group is restored", async () => {
    const r = await run(["prod"], { env: { MOCK_LAMBDA_DB: "ogevia_prd", MOCK_LAMBDA_ENV: "prd", MOCK_DBS: "ogevia_sv_test" } });
    expect(r.out).toContain("ogevia_prd DOES NOT EXIST");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("connected to the wrong database: stops, and restores", async () => {
    const r = await run(["test"], { env: { MOCK_CURRENT_DB: "ogevia_prd" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("connected to 'ogevia_prd', not 'ogevia_sv_test'");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("failure after the window opened (the database connection fails): restored and verified", async () => {
    const r = await run(["test"], { env: { MOCK_PSQL_FAIL: "1" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("the rule cannot be added: stops, nothing to restore, group unchanged", async () => {
    const r = await run(["test"], { env: { MOCK_FAIL_AUTHORIZE: "1" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not add the rule");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("interrupted mid-query (SIGTERM): the cleanup still removes the rule and verifies", async () => {
    const r = await run(["test"], { env: { MOCK_PSQL_SLEEP: "30" }, killWhen: () => existsSync(join(dir, "psql-started")) && rulePresent() });
    expect(r.out).toContain("Interrupted: cleaning up.");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  }, 30000);
  it("a revoke that fails twice is retried and succeeds", async () => {
    const r = await run(["test"], { env: { MOCK_REVOKE_FAILS: "2" } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
  });
});

describe("when restoration fails", () => {
  it("says NOT RESTORED loudly with the exact command, exits 3, leaves the marker, blocks the next run, and --restore-only fixes it", async () => {
    const r = await run(["test"], { env: { MOCK_REVOKE_ALWAYS_FAILS: "1" } });
    expect(r.code).toBe(3);
    expect(r.out).toContain("NOT RESTORED");
    expect(r.out).toContain("aws ec2 revoke-security-group-ingress --region us-west-2 --group-id sg-00530a1f4f7648e65");
    expect(r.out).toContain("SECURITY GROUP: NOT RESTORED");
    expect(rulePresent()).toBe(true);
    expect(marker()).toBe(true);
    const next = await run(["test"]);
    expect(next.code).toBe(1);
    expect(next.out).toContain("an earlier window is marked OPEN");
    expect(next.out).toContain("--restore-only");
    // the refused run must not touch the open window (it may belong to another operator)
    expect(rulePresent()).toBe(true);
    expect(marker()).toBe(true);
    expect(verbs().filter((x) => x === "ec2 revoke-security-group-ingress").length).toBe(4); // only the first run's four attempts
    const fixed = await run(["--restore-only"]);
    expect(fixed.code).toBe(0);
    expect(fixed.out).toContain("RESTORED (verified)");
    expect(rulePresent()).toBe(false);
    expect(marker()).toBe(false);
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("--restore-only with no marker changes nothing", async () => {
    const r = await run(["--restore-only"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing to restore");
    expect(verbs()).not.toContain("ec2 revoke-security-group-ingress");
  });
  it("detects a group that differs from the original even if the rule is gone", async () => {
    // simulate an unrelated change made while the window was open: the verification hash must not match
    const r = await run(["test"], { env: { MOCK_PSQL_SLEEP: "2" }, killWhen: () => { if (existsSync(join(dir, "psql-started"))) { const s = sg(); if (!s.e.some((x: any) => x.IpProtocol === "tcp")) { s.e.push({ IpProtocol: "tcp", FromPort: 1, ToPort: 1, UserIdGroupPairs: [], IpRanges: [{ CidrIp: "10.0.0.0/8" }], Ipv6Ranges: [], PrefixListIds: [] }); writeFileSync(join(dir, "sg.json"), JSON.stringify(s)); } } return false; } });
    expect(r.out).toContain("NOT RESTORED");
    expect(r.code).toBe(3);
  }, 30000);
});

describe("static properties of the script", () => {
  it("changes only the RDS group's inbound rule: no instance, host, application-group, stack, Lambda or secret write", () => {
    const calls2 = [...code.matchAll(/\baws\s+(sts|cloudformation|lambda|rds|ec2|ssm|secretsmanager)\s+([a-z0-9-]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    const writes = calls2.filter((c) => !/ (describe-|list-|get-)/.test(c));
    expect([...new Set(writes)].sort()).toEqual(["ec2 authorize-security-group-ingress", "ec2 revoke-security-group-ingress", "ssm start-session"]);
    for (const bad of [/modify-instance-attribute/, /modify-network-interface/, /attach-/, /detach-/, /create-/, /delete-/, /update-/, /\bput-/, /\binvoke\b/, /\bcdk\b/, /terminate/, /start-instances/, /stop-instances/, /sudo/, /dnf install/]) expect(code).not.toMatch(bad);
    expect(code).not.toContain("sg-064ffce3bcbe8eb3b"); // the application group is never referenced as a target
  });
  it("authorizes and revokes only tcp 5432 from the admin group on the RDS group", () => {
    expect(code).toMatch(/authorize-security-group-ingress --group-id "\$EXPECT_RDS_SG" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=\[\{GroupId=\$ADMIN_SG,/);
    expect(code).toMatch(/revoke-security-group-ingress --group-id "\$1" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=\[\{GroupId=\$2\}\]"/);
    expect(code).not.toMatch(/0\.0\.0\.0\/0|CidrIp=/);
  });
  it("cleans up on every exit path and uses read-only SQL", () => {
    expect(code).toContain("trap on_exit EXIT");
    expect(code).toMatch(/trap '[^']*' INT TERM HUP/);
    expect(code).toContain("default_transaction_read_only=on");
    for (const s of [...code.matchAll(/-c "([^"]+)"/g)].map((m) => m[1]!.trim().toLowerCase())) expect(s).toMatch(/^(select|begin transaction read only|rollback)\b/);
  });
  it("never prints or stores a credential", () => {
    expect(code).not.toMatch(/echo[^\n]*PGPASSWORD|printf[^\n]*PGPASSWORD|set -x|say[^\n]*\$SEC\b/);
    expect(code).toMatch(/unset PGPASSWORD PGUSER SEC/);
  });
});
