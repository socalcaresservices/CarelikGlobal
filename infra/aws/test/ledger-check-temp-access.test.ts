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
    expect(r.out).toContain("aws ec2 revoke-security-group-ingress --region us-west-2 --group-id sg-00530a1f4f7648e65 --security-group-rule-ids sgr-");
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


const FAST = { OGEVIA_AWS_TIMEOUT: "2", OGEVIA_PSQL_TIMEOUT: "2", OGEVIA_CLEANUP_AWS_TIMEOUT: "2", OGEVIA_TUNNEL_WAIT: "2" };
const hangs = () => (existsSync(join(dir, "hangs.log")) ? readFileSync(join(dir, "hangs.log"), "utf8").split("\n").filter(Boolean) : []);

describe("the tunnel does not outlive the run", () => {
  it("no Session Manager tunnel process remains after a normal run or after a stop", async () => {
    const { execSync } = await import("node:child_process");
    const left = () => { try { return execSync(`pgrep -f '${dir}/[b]in/aws ssm start-session' || true`).toString().trim(); } catch { return ""; } };
    await run(["test"]);
    if (left()) console.log("LEAK", execSync(`ps -eo pid,ppid,pgid,args | grep -F '${dir}' | grep -v grep || true`).toString());
    expect(left()).toBe("");
    await run(["test"], { env: { MOCK_PSQL_FAIL: "1" } });
    expect(left()).toBe("");
  });
});

describe("a hung command is bounded, counts as a failure and goes through cleanup", () => {
  it("authorize hangs: the run stops as TIMED OUT, the group is verified unchanged, no marker is left", async () => {
    const r = await run(["test"], { env: { ...FAST, MOCK_HANG: "ec2-authorize-security-group-ingress" } });
    expect(hangs()).toEqual(["ec2-authorize-security-group-ingress hung"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("TIMED OUT");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("the Session Manager tunnel never opens: stops, removes the rule, verifies", async () => {
    const r = await run(["test"], { env: { ...FAST, MOCK_TUNNEL_NEVER_OPENS: "1" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("tunnel did not open");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("the secret read hangs: stops as TIMED OUT, removes the rule, verifies, and reads no secret", async () => {
    const r = await run(["test"], { env: { ...FAST, MOCK_HANG: "secretsmanager-get-secret-value" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("TIMED OUT");
    expect(r.out).toContain("RESTORED (verified)");
    expect(existsSync(join(dir, "psql-calls.log"))).toBe(false);
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("psql hangs: stops as TIMED OUT, removes the rule, verifies", async () => {
    const r = await run(["test"], { env: { ...FAST, MOCK_PSQL_SLEEP: "60" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("TIMED OUT");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("the window time limit is checked between steps: a slow step ends the run into cleanup", async () => {
    const r = await run(["test"], { env: { ...FAST, OGEVIA_PSQL_TIMEOUT: "6", OGEVIA_WINDOW_MAX_SECONDS: "1", MOCK_PSQL_SLEEP: "2" } });
    // the step that crosses the limit completes; the next step refuses to start and cleanup runs
    expect(r.out).toMatch(/time limit|result kept/);
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("the revoke hangs on every attempt: cleanup is bounded, says NOT RESTORED, EXITS NON-ZERO (3), keeps the marker, and a later --restore-only fixes it", async () => {
    const r = await run(["test"], { env: { ...FAST, MOCK_HANG: "ec2-revoke-security-group-ingress" } });
    expect(hangs().filter((h) => h.startsWith("ec2-revoke")).length).toBe(4);
    expect(r.code).toBe(3);
    expect(r.out).toContain("NOT RESTORED (exit 3; access may still be open)");
    expect(r.out).toContain("SECURITY GROUP: NOT RESTORED");
    expect(rulePresent()).toBe(true);
    expect(marker()).toBe(true);
    const fixed = await run(["--restore-only"], { env: FAST }); // the hang was transient: the fake is no longer told to hang
    expect(fixed.code).toBe(0);
    expect(fixed.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("the cleanup's own checks hang: the state is UNKNOWN, never assumed restored; exit 3 and the marker stays", async () => {
    const r = await run(["test"], { env: { ...FAST, MOCK_HANG_DESCRIBE_WHEN_OPEN: "1" } });
    expect(r.code).toBe(3);
    expect(r.out).toContain("NOT RESTORED");
    expect(r.out).toContain("UNKNOWN");
    expect(r.out).not.toContain("RESTORED (verified)");
    expect(marker()).toBe(true);
  });
  it("the manual recovery text identifies ONLY the temporary rule: the admin-group source, by rule id, and never the application group", async () => {
    const r = await run(["test"], { env: { ...FAST, MOCK_REVOKE_ALWAYS_FAILS: "1" } });
    expect(r.code).toBe(3);
    const lines = r.out.split("\n").filter((l) => /aws ec2 (describe-security-group-rules|revoke-security-group-ingress)/.test(l));
    expect(lines.some((l) => l.includes("describe-security-group-rules") && l.includes("--filters Name=group-id,Values=sg-00530a1f4f7648e65"))).toBe(true);
    const revoke = lines.filter((l) => l.includes("revoke-security-group-ingress"));
    expect(revoke).toHaveLength(1);
    expect(revoke[0]).toContain("--security-group-rule-ids sgr-");
    expect(revoke[0]).not.toContain("--ip-permissions");
    expect(r.out).toContain(`source ${ADMIN}`);
    expect(r.out).not.toMatch(/revoke[^\n]*sg-064ffce3bcbe8eb3b/);
  });
});


// ---- --host-ip mode (TEST only): the rule names ONLY the admin host's own live private IP as /32 ----
const IP = "10.20.132.179";
const CIDR = `${IP}/32`;
const cidrPresent = () => sg().i.some((p: any) => p.FromPort === 5432 && (p.IpRanges ?? []).some((r: any) => r.CidrIp === CIDR));
const authorizeCalls = () => calls().filter((c) => c.startsWith("ec2 authorize-security-group-ingress"));
const HOSTIP = ["test", "--host-ip"];

describe("--host-ip mode", () => {
  it("the default mode STILL refuses the shared admin group (the three interfaces from the operator's report); nothing changes", async () => {
    const r = await run(["test"], { env: { MOCK_SHARED_ENI: "endpoints" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("more than the admin host");
    expect(r.out).toContain("--host-ip");
    expect(authorizeCalls()).toHaveLength(0);
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("success with the shared group: ONE rule, source exactly <live IP>/32, never the group; removed and verified identical to the original", async () => {
    const r = await run(HOSTIP, { env: { MOCK_SHARED_ENI: "endpoints", OGEVIA_EXPECT_HOST_IP: IP } });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`admin host IP (live): ${IP} on eni-099616641dd91bcaf`);
    expect(r.out).toContain(`inbound tcp 5432 from ${CIDR}`);
    expect(r.out).toContain("RESTORED (verified)");
    expect(r.out).toContain("SECURITY GROUP: restored and verified identical to the original");
    const a = authorizeCalls();
    expect(a).toHaveLength(1);
    expect(a[0]).toContain(`IpRanges=[{CidrIp=${CIDR},`);
    expect(a[0]).not.toContain("UserIdGroupPairs");
    expect(a[0]).not.toContain("sg-00e01e2ca80442c1f");
    expect(sg()).toEqual(INITIAL_SG);
    expect(cidrPresent()).toBe(false);
    expect(marker()).toBe(false);
    expect(verbs().join("|")).not.toMatch(/modify|attach|create|delete|update|UNEXPECTED/);
  });
  it("the window really holds exactly the /32 and nothing else (checked mid-run)", async () => {
    let seen: any = null;
    await run(HOSTIP, { env: { MOCK_PSQL_SLEEP: "2" }, killWhen: () => { if (existsSync(join(dir, "psql-started")) && !seen) seen = JSON.parse(readFileSync(join(dir, "sg.json"), "utf8")); return false; } });
    const inbound5432 = seen.i.filter((p: any) => p.FromPort === 5432);
    expect(inbound5432).toHaveLength(1);
    expect(inbound5432[0].IpRanges).toEqual([{ CidrIp: CIDR }]);
    expect(inbound5432[0].UserIdGroupPairs.map((g: any) => g.GroupId)).toEqual(["sg-064ffce3bcbe8eb3b"]);
    expect(seen.e).toEqual(INITIAL_SG.e);
  }, 30000);
  it("is TEST-only: prod --host-ip, --restore-only --host-ip and unknown second arguments are refused before any AWS call", async () => {
    for (const args of [["prod", "--host-ip"], ["--restore-only", "--host-ip"], ["test", "--whatever"]]) {
      const r = await run(args);
      expect(r.code).toBe(2);
    }
    expect(calls()).toHaveLength(0);
  });
  const refusals: [string, Record<string, string>, RegExp][] = [
    ["the host has a second network interface", { MOCK_HOST_SECOND_ENI: "1" }, /exactly ONE network interface/],
    ["the host's interface has a second private IPv4 address", { MOCK_HOST_SECOND_IP: "10.20.132.180" }, /exactly ONE network interface/],
    ["the host is not running", { MOCK_HOST_STATE: "stopping" }, /not running/],
    ["the address is public", { MOCK_HOST_IP: "8.8.8.8" }, /not a valid private/],
    ["the address is malformed", { MOCK_HOST_IP: "10.20.132.999" }, /not a valid private/],
    ["the address has a leading zero", { MOCK_HOST_IP: "10.020.132.179" }, /not a valid private/],
    ["the live IP differs from the pinned expectation", { OGEVIA_EXPECT_HOST_IP: "10.20.132.180" }, /OGEVIA_EXPECT_HOST_IP/],
    ["the IP maps to more than one interface", { MOCK_IP_MAPS_TWO: "1" }, /does not map to exactly one interface/],
    ["the IP maps to an interface on another instance", { MOCK_IP_MAPS_OTHER_INSTANCE: "1" }, /does not map to exactly one interface/],
    ["the admin host's security groups are not exactly the expected one", { MOCK_HOST_SG: "sg-0123456789abcdef0" }, /expected exactly/],
    ["the RDS group is not the expected one", { MOCK_RDS_SG: "sg-0aaaaaaaaaaaaaaaa" }, /expected exactly/],
  ];
  for (const [name, env, expected] of refusals) {
    it(`refuses, changing nothing, when ${name}`, async () => {
      const r = await run(HOSTIP, { env: { MOCK_SHARED_ENI: "endpoints", ...env } });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(expected);
      expect(authorizeCalls()).toHaveLength(0);
      expect(sg()).toEqual(INITIAL_SG);
      expect(marker()).toBe(false);
    });
  }
  it("refuses when that /32 rule is already present", async () => {
    const s = sg(); s.i[0].IpRanges.push({ CidrIp: CIDR }); writeFileSync(join(dir, "sg.json"), JSON.stringify(s));
    const r = await run(HOSTIP, { env: { MOCK_SHARED_ENI: "endpoints" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("ALREADY exists");
    expect(authorizeCalls()).toHaveLength(0);
  });
  it("does nothing unless the exact phrase is typed", async () => {
    const r = await run(HOSTIP, { input: "yes\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Declined. Nothing was changed.");
    expect(authorizeCalls()).toHaveLength(0);
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("a database failure after opening: the /32 rule is removed and verified", async () => {
    const r = await run(HOSTIP, { env: { MOCK_PSQL_FAIL: "1" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("interrupted (SIGTERM) mid-query: the /32 rule is removed and verified", async () => {
    const r = await run(HOSTIP, { env: { MOCK_PSQL_SLEEP: "30" }, killWhen: () => existsSync(join(dir, "psql-started")) && cidrPresent() });
    expect(r.out).toContain("Interrupted: cleaning up.");
    expect(r.out).toContain("RESTORED (verified)");
    expect(cidrPresent()).toBe(false);
    expect(sg()).toEqual(INITIAL_SG);
  }, 40000);
  it("a hung authorize ends as TIMED OUT and the group is verified unchanged", async () => {
    const r = await run(HOSTIP, { env: { ...FAST, MOCK_HANG: "ec2-authorize-security-group-ingress" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("TIMED OUT");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("a revoke that always fails: NOT RESTORED, exit 3, marker kept (kind cidr), recovery text names ONLY the /32 row by rule id; the next run is refused", async () => {
    const r = await run(HOSTIP, { env: { ...FAST, MOCK_REVOKE_ALWAYS_FAILS: "1" } });
    expect(r.code).toBe(3);
    expect(r.out).toContain("NOT RESTORED (exit 3; access may still be open)");
    expect(r.out).toContain(`the ONE row with cidr ${CIDR}, tcp, 5432`);
    const lines = r.out.split("\n").filter((l) => /aws ec2 (describe-security-group-rules|revoke-security-group-ingress)/.test(l));
    expect(lines.some((l) => l.includes("describe-security-group-rules") && l.includes("cidr:CidrIpv4"))).toBe(true);
    const revoke = lines.filter((l) => l.includes("revoke-security-group-ingress"));
    expect(revoke).toHaveLength(1);
    expect(revoke[0]).toContain("--security-group-rule-ids sgr-");
    expect(revoke[0]).not.toContain("--ip-permissions");
    expect(r.out).not.toMatch(/revoke[^\n]*sg-064ffce3bcbe8eb3b/);
    expect(cidrPresent()).toBe(true);
    expect(marker()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "state", "OPEN"), "utf8"))).toMatchObject({ kind: "cidr", cidr: CIDR });
    const next = await run(HOSTIP);
    expect(next.code).toBe(1);
    expect(next.out).toContain("an earlier window is marked OPEN");
    expect(cidrPresent()).toBe(true); // the refused run did not touch the open window
  }, 60000);
  it("--restore-only reads the marker's kind: it removes a left-over /32 rule and verifies the original", async () => {
    const r = await run(HOSTIP, { env: { ...FAST, MOCK_REVOKE_ALWAYS_FAILS: "1" } });
    expect(r.code).toBe(3);
    expect(cidrPresent()).toBe(true);
    const fixed = await run(["--restore-only"], { env: FAST }); // no failure injection now
    expect(fixed.code).toBe(0);
    expect(fixed.out).toContain("RESTORED (verified)");
    expect(cidrPresent()).toBe(false);
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  }, 60000);
  it("a rule-set change other than the single /32 is detected and the run stops", async () => {
    const r = await run(HOSTIP, { env: { MOCK_PSQL_SLEEP: "2" }, killWhen: () => { if (existsSync(join(dir, "psql-started"))) { const s = sg(); if (!s.e.some((x: any) => x.IpProtocol === "tcp")) { s.e.push({ IpProtocol: "tcp", FromPort: 1, ToPort: 1, UserIdGroupPairs: [], IpRanges: [{ CidrIp: "10.0.0.0/8" }], Ipv6Ranges: [], PrefixListIds: [] }); writeFileSync(join(dir, "sg.json"), JSON.stringify(s)); } } return false; } });
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
    expect(code).not.toMatch(/0\.0\.0\.0\/0/);
    // the ONLY CIDR source ever written is $HOST_CIDR, which is "$HOST_IP/32" built from the live host IP; revoke takes the recorded value
    expect(code).toContain('HOST_CIDR="$HOST_IP/32"');
    const cidrUses = [...code.matchAll(/CidrIp=([^,}\]"]*)/g)].map((m) => m[1]);
    expect(new Set(cidrUses)).toEqual(new Set(["$HOST_CIDR", "$2"]));
    expect(code.match(/\/(\d+)["'\s]/g)?.filter((x) => !/\/32/.test(x) && !/\/dev\/|\/tmp|\/null/.test(x)) ?? []).toEqual([]);
    expect(code).toMatch(/--host-ip\) \[\[ "\$ARG" == test \]\]/); // prod --host-ip is refused
  });
  it("cleans up on every exit path and uses read-only SQL", () => {
    expect(code).toContain("trap on_exit EXIT");
    expect(code).toMatch(/trap '[^']*' INT TERM HUP/);
    expect(code).toContain("default_transaction_read_only=on");
    for (const s of [...code.matchAll(/-c "([^"]+)"/g)].map((m) => m[1]!.trim().toLowerCase())) expect(s).toMatch(/^(select|begin transaction read only|rollback)\b/);
  });
  it("bounds every command that can hang and no longer claims a hard limit", () => {
    expect(source).not.toMatch(/hard\s+limit\s*\(OGEVIA/i);
    expect(source).toMatch(/SIGKILL/);
    expect(code).toMatch(/aws\(\) \{ timeout --foreground -k "\$KILL_AFTER" "\$AWS_T"/);
    expect(code).toMatch(/timeout --foreground -k "\$KILL_AFTER" "\$PSQL_TMO" psql/);
    for (const l of code.split("\n").filter((x) => /\bpsql -X/.test(x))) expect(l).toContain('timeout --foreground -k "$KILL_AFTER" "$PSQL_TMO" psql'); // psql only ever starts under timeout
    expect(code).toContain("AWS_T=\"$CLEAN_TMO\""); // the cleanup uses its own, shorter bound
    expect(code).toContain("TEMP-ledger-check-$STAMP"); // the prompt text matches the description actually created
    expect(code).not.toContain("TEMP ledger check");
  });
  it("never prints or stores a credential", () => {
    expect(code).not.toMatch(/echo[^\n]*PGPASSWORD|printf[^\n]*PGPASSWORD|set -x|say[^\n]*\$SEC\b/);
    expect(code).toMatch(/unset PGPASSWORD PGUSER SEC/);
  });
});
