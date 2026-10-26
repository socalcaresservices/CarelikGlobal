// apply-0086-prd.sh (PRODUCTION release 2026-10-26-redesign, decision D1 option b: 0086 applied outside the ledger) against a FAKE aws, psql and npx and a package built from the REAL migrations, pending files and scripts (BUILD_INFO.json +
// PACKAGE_MANIFEST.sha256, no git): no AWS, no network, synthetic. The SQL itself is proven against real PostgreSQL in db/test/operator-0086-sql.db.test.ts; this file proves the CONTROL FLOW the
// owner is asked to approve: pins and the snapshot are checked before any change; the single /32 rule is added and removed on success and on every failure; the production ledger must be exactly
// 85 / 0085 before AND after (no ledger row is ever written); 0086 must be absent (apply) or present (rollback); people-and-access counts must be identical; ogevia_sv_test (TEST) is never named.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_SG, installMocks } from "./ledger-window-mocks.js";
import { PKG_REL, REPO_ROOT } from "./operator-prd-fixtures.js";

vi.setConfig({ testTimeout: 90000 });
const SCRIPTS_DIR = join(REPO_ROOT, PKG_REL, "scripts");
const source = readFileSync(join(SCRIPTS_DIR, "apply-0086-prd.sh"), "utf8");
const code = source.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const HOST_IP = "10.20.132.179";
const CIDR = `${HOST_IP}/32`;
const APPLY_PHRASE = "OPEN-5432-WINDOW-APPLY-0086-PRD\n";
const ROLLBACK_PHRASE = "OPEN-5432-WINDOW-ROLLBACK-0086-PRD\n";
const MIG_SET = "de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef";
const sha256 = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");

// state files: ledger "85|0085", s86 "0|0|0" | "1|1|21", people "3|4|10|2|1", act "0|2"
const PSQL = `#!/usr/bin/env bash
D="$MOCK_DIR"
echo "$*" >> "$D/psql-calls.log"
[[ -n "\${MOCK_PSQL_FAIL:-}" ]] && { echo "psql: connection failed" >&2; exit 2; }
if [[ "$*" == *" -f "* ]]; then
  if [[ "$*" == *" -1 "* ]]; then
    [[ "$*" == *"ON_ERROR_STOP=1"* && "$*" == *"-d ogevia_prd"* && "$*" == *"set local role ogevia_owner"* && "$*" == *"reset role"* ]] || echo "write session without -1 / ON_ERROR_STOP / the production database / the owner role: $*" >> "$D/psql-violations.log"
    if [[ "$*" == *".down.sql"* ]]; then kind=down; else kind=up; fi
    echo "$kind" >> "$D/write-calls.log"
    [[ -n "\${MOCK_WRITE_SLEEP:-}" ]] && { touch "$D/write-sleeping"; exec sleep 60; }
    [[ -n "\${MOCK_WRITE_FAIL:-}" ]] && { echo "ERROR: relation ogevia.staff_types already exists" >&2; exit 3; }
    if [[ $kind == up ]]; then echo "1|1|21" > "$D/s86"; else echo "0|0|0" > "$D/s86"; fi
    [[ -n "\${MOCK_WRITE_TOUCHES_LEDGER:-}" ]] && echo "86|0086" > "$D/ledger"
    [[ -n "\${MOCK_WRITE_TOUCHES_PEOPLE:-}" ]] && echo "3|3|10|2|1" > "$D/people"
    exit 0
  fi
  # verify-0086.sql (read-only)
  n=\${MOCK_VERIFY_COUNT:-110}; f=\${MOCK_VERIFY_FAILING:-0}
  for i in $(seq 1 "$n"); do if (( i <= f )); then echo "check_$i|f|detail"; else echo "check_$i|t|"; fi; done
  exit 0
fi
case "$*" in
  *pg_get_functiondef*) echo "\${MOCK_RESTORED_FN:-1|0}" ;;
  *current_database*) echo "\${MOCK_CURRENT_DB:-ogevia_prd} | read_only=\${MOCK_READ_ONLY:-on}" ;;
  *staff_types*) cat "$D/s86" ;;
  *app_users*) cat "$D/people" ;;
  *organization_readiness_settings*) cat "$D/act" ;;
  *schema_migrations*) cat "$D/ledger" ;;
  *) echo "mock psql: unexpected: $*" >&2; exit 98 ;;
esac
`;
const NPX = `#!/usr/bin/env bash
D="$MOCK_DIR"
echo "$*" >> "$D/npx-calls.log"
case "$*" in
  *verify.ts)
    if [[ -n "\${MOCK_RUNNER_VERIFY_FAIL:-}" ]]; then echo "FAIL 08_release_objects.sql release_table_x"; echo "PASS 01_schema_version.sql latest_migration_is_0085"; exit 1; fi
    echo "PASS 01_schema_version.sql latest_migration_is_0085"; for i in $(seq 1 120); do echo "PASS 0$((i % 7 + 2))_x.sql check_$i"; done ;;
  *) echo "mock npx: unexpected: $*" >&2; exit 97 ;;
esac
`;

interface Fix { dir: string; bin: string; repo: string; script: string; sha: string; up: string; down: string; infra: string }
function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, r)); else out.push(r);
  }
  return out;
}
function sealPackage(repo: string, sha: string) {
  writeFileSync(join(repo, "BUILD_INFO.json"), JSON.stringify({ code_commit: sha, approval_ref: "APPROVAL-REF-PENDING-OWNER" }));
  const files = listFiles(repo).filter((x) => x !== "PACKAGE_MANIFEST.sha256").sort();
  writeFileSync(join(repo, "PACKAGE_MANIFEST.sha256"), files.map((x) => `${sha256(readFileSync(join(repo, x)))}  ${x}\n`).join(""));
}
function fixture(): Fix {
  const dir = mkdtempSync(join(tmpdir(), "ap0086-"));
  const bin = installMocks(dir);
  writeFileSync(join(bin, "psql"), PSQL); writeFileSync(join(bin, "npx"), NPX);
  for (const f of ["psql", "npx"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(dir, "ledger"), "85|0085\n"); writeFileSync(join(dir, "s86"), "0|0|0\n"); writeFileSync(join(dir, "people"), "3|4|10|2|1\n"); writeFileSync(join(dir, "act"), "0|2\n");
  copyFileSync(join(bin, "aws"), join(bin, "aws-base"));
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env bash
if [[ "$1 $2" == "rds describe-db-snapshots" ]]; then
  echo "$1 $2" >> "$MOCK_DIR/aws-calls.log"
  [[ -n "\${MOCK_SNAP_MISSING:-}" ]] && { echo "An error occurred (DBSnapshotNotFound)" >&2; exit 254; }
  created=$(date -u -d "@$(( $(date +%s) - \${MOCK_SNAP_AGE_MIN:-10} * 60 ))" +%Y-%m-%dT%H:%M:%S.123000+00:00)
  printf '%s\\t%s\\t%s\\t%s\\n' "\${MOCK_SNAP_STATUS:-available}" "\${MOCK_SNAP_INSTANCE:-ogevia-prod-postgres}" "\${MOCK_SNAP_TYPE:-manual}" "\${MOCK_SNAP_CREATED:-$created}"
  exit 0
fi
exec "$(dirname "$0")/aws-base" "$@"
`);
  chmodSync(join(bin, "aws"), 0o755);
  // the extracted package: REAL migrations (the script pins their set hash), REAL pending files, REAL scripts and verify-0086.sql; synthetic code elsewhere
  const repo = join(dir, "pkg");
  const infra = join(repo, "infra", "aws");
  const scriptsDir = join(repo, PKG_REL, "scripts");
  mkdirSync(scriptsDir, { recursive: true }); mkdirSync(join(infra, "node_modules"), { recursive: true }); mkdirSync(join(repo, "node_modules"), { recursive: true });
  cpSync(join(REPO_ROOT, "infra/aws/db/migrations"), join(infra, "db/migrations"), { recursive: true });
  cpSync(join(REPO_ROOT, "infra/aws/db/pending"), join(infra, "db/pending"), { recursive: true });
  for (const f of ["apply-0086-prd.sh", "pkg-lib.sh", "verify-0086.sql"]) copyFileSync(join(SCRIPTS_DIR, f), join(scriptsDir, f));
  const sha = createHash("sha1").update(dir).digest("hex");
  sealPackage(repo, sha);
  return { dir, bin, repo, infra, script: join(scriptsDir, "apply-0086-prd.sh"), sha, up: sha256(readFileSync(join(infra, "db/pending/migrations/0086_staff_management.sql"))), down: sha256(readFileSync(join(infra, "db/pending/rollback/0086_staff_management.down.sql"))) };
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const s = createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
}
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
const stamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60000);
const snapName = (minutesAgo = 10) => `ogevia-prod-postgres-pre-0086-prd-${stamp(minutesFromNow(-minutesAgo))}`;
function releaseWindow(startMin = -60, endMin = 180, snapAgo = 10) {
  return { OGEVIA_RELEASE_WINDOW_START: iso(minutesFromNow(startMin)), OGEVIA_RELEASE_WINDOW_END: iso(minutesFromNow(endMin)), OGEVIA_PREDEPLOY_SNAPSHOT_ID: snapName(snapAgo), MOCK_SNAP_AGE_MIN: String(snapAgo) };
}
interface Run { code: number | null; out: string; outDir: string }
let f: Fix;
beforeEach(() => { f = fixture(); });
async function run(args: string[], opts: { env?: Record<string, string>; input?: string; killWhen?: () => boolean } = {}): Promise<Run> {
  const port = await freePort();
  const outDir = join(f.dir, `out-${Math.random().toString(36).slice(2)}`);
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env, PATH: `${f.bin}:${process.env.PATH}`, MOCK_DIR: f.dir, HOME: f.dir,
      OGEVIA_MIGRATE_STATE_DIR: join(f.dir, "state"), OGEVIA_LEDGER_STATE_DIR: join(f.dir, "ledger-state"), OGEVIA_MIGRATE_DIR: outDir, OGEVIA_MIGRATE_PORT: String(port),
      OGEVIA_EXPECT_COMMIT: f.sha, OGEVIA_EXPECT_MIGRATIONS_SHA: MIG_SET, OGEVIA_EXPECT_0086_SHA: f.up, OGEVIA_EXPECT_0086_DOWN_SHA: f.down, OGEVIA_EXPECT_HOST_IP: HOST_IP,
      OGEVIA_TUNNEL_WAIT: "10", OGEVIA_PRD_BEFORE: join(f.dir, "prd-before"), MOCK_LAMBDA_DB: "ogevia_prd", MOCK_LAMBDA_ENV: "prd", ...releaseWindow(), ...(opts.env ?? {}),
    };
    const p = spawn("bash", [f.script, ...args], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    let stdinError: Error | null = null;
    p.stdin.on("error", (e: NodeJS.ErrnoException) => { if (e.code !== "EPIPE") stdinError = e; });
    p.stdin.end(opts.input ?? APPLY_PHRASE);
    let killed = false;
    const timer = opts.killWhen ? setInterval(() => { if (!killed && opts.killWhen!()) { killed = true; process.kill(-p.pid!, "SIGTERM"); } }, 50) : null;
    p.on("close", (c) => { if (timer) clearInterval(timer); if (stdinError) reject(stdinError); else resolve({ code: c, out, outDir }); });
  });
}
const sg = () => JSON.parse(readFileSync(join(f.dir, "sg.json"), "utf8"));
const read = (n: string) => readFileSync(join(f.dir, n), "utf8").trim();
const lines = (n: string) => (existsSync(join(f.dir, n)) ? readFileSync(join(f.dir, n), "utf8").split("\n").filter(Boolean) : []);
const verbs = () => lines("aws-calls.log").map((c) => c.split(" ").slice(0, 2).join(" "));
const cidrPresent = () => sg().i.some((p: any) => p.FromPort === 5432 && p.IpRanges.some((r: any) => r.CidrIp === CIDR));
const marker = () => existsSync(join(f.dir, "state", "OPEN"));
const writes = () => lines("write-calls.log");
const noWindow = () => { expect(verbs()).not.toContain("ec2 authorize-security-group-ingress"); expect(sg()).toEqual(INITIAL_SG); expect(marker()).toBe(false); expect(writes()).toEqual([]); };
const restored = () => { expect(sg()).toEqual(INITIAL_SG); expect(marker()).toBe(false); expect(lines("psql-violations.log")).toEqual([]); };

describe("static scope of the script", () => {
  it("uses only the reviewed AWS verbs, never names the TEST database, never prints the credential, writes only through the two pinned files, has no ledger write", () => {
    const used = new Set([...code.matchAll(/(?:^|[\s(;|&$])aws\s+(sts|cloudformation|lambda|rds|ec2|ssm|secretsmanager|s3|iam|events|cdk)\s+([a-z0-9-]+)/gm)].map((m) => `${m[1]} ${m[2]}`));
    for (const v of used) expect(["sts get-caller-identity", "cloudformation describe-stacks", "cloudformation list-stack-resources", "lambda get-function-configuration", "rds describe-db-instances", "rds describe-db-snapshots", "ec2 describe-instances", "ec2 describe-network-interfaces", "ec2 describe-security-groups", "ec2 describe-security-group-rules", "ec2 authorize-security-group-ingress", "ec2 revoke-security-group-ingress", "ssm start-session", "secretsmanager get-secret-value"]).toContain(v);
    expect(code).not.toMatch(/DB_EXPECT=ogevia_sv_test|Ogevia-prod-/);
    for (const l of code.split("\n").filter((x) => /ogevia_sv_test|Ogevia-prod/.test(x))) expect(l).toMatch(/never names, connects to or queries it|ogevia_sv_test: this script/);
    // the SQL the script itself issues is read-only; the only writes are the two pinned files run in one transaction as ogevia_owner
    for (const q of [...code.matchAll(/-c "([^"]*)"/g)].map((m) => m[1]!)) if (!/^(set local role ogevia_owner|reset role)$/.test(q)) expect(q).not.toMatch(/\b(drop|truncate|alter|insert|update|delete|create|grant|revoke)\b/i);
    expect(code).not.toMatch(/schema_migrations\s*\(|insert into ogevia_meta|delete from ogevia_meta/i); // no ledger row is ever written
    expect(code).toContain('-1 -d "$DB_EXPECT" -c "set local role ogevia_owner" -f "$PKG_PENDING_UP" -c "reset role"');
    expect(code).toContain('-1 -d "$DB_EXPECT" -c "set local role ogevia_owner" -f "$PKG_PENDING_DOWN" -c "reset role"');
    expect(code).not.toMatch(/--delete|rm -rf/);
    expect(code).not.toMatch(/(^|[^A-Za-z_-])git([^A-Za-z_-]|$)/m);
    expect(code).not.toMatch(/echo[^\n]*PGPASSWORD|echo[^\n]*DBURL|say[^\n]*\$DBURL|say[^\n]*\$PGPASSWORD/);
    expect(code).toContain("IpRanges=[{CidrIp=$HOST_CIDR");
    expect(code).not.toContain("UserIdGroupPairs=[{GroupId=$ADMIN_SG");
    expect(code).toContain("LEDGER_COUNT=85; LEDGER_LATEST=0085");
  });
});

describe("pins and preconditions change nothing", () => {
  it.each([
    ["no commit pin", { OGEVIA_EXPECT_COMMIT: "" }, "OGEVIA_EXPECT_COMMIT"],
    ["another commit", { OGEVIA_EXPECT_COMMIT: "0".repeat(40) }, "not the approved"],
    ["no migration-set pin", { OGEVIA_EXPECT_MIGRATIONS_SHA: "" }, "OGEVIA_EXPECT_MIGRATIONS_SHA"],
    ["a different migration set", { OGEVIA_EXPECT_MIGRATIONS_SHA: "f".repeat(64) }, "not the approved 0001-0085 set"],
    ["no 0086 pin", { OGEVIA_EXPECT_0086_SHA: "" }, "OGEVIA_EXPECT_0086_SHA"],
    ["a different 0086 pin", { OGEVIA_EXPECT_0086_SHA: "e".repeat(64) }, "not the approved"],
    ["no host IP pin", { OGEVIA_EXPECT_HOST_IP: "" }, "OGEVIA_EXPECT_HOST_IP"],
    ["a public host IP pin", { OGEVIA_EXPECT_HOST_IP: "8.8.8.8" }, "OGEVIA_EXPECT_HOST_IP"],
    ["another live host IP", { OGEVIA_EXPECT_HOST_IP: "10.20.132.180" }, "live IP"],
    ["the Lambda serving the TEST database", { MOCK_LAMBDA_DB: "ogevia_sv_test", MOCK_LAMBDA_ENV: "test" }, "Not the production environment"],
    ["the Lambda serving production but not marked prd", { MOCK_LAMBDA_ENV: "test" }, "not prd"],
    ["an admin host in another group", { MOCK_HOST_SG: "sg-0123456789abcdef0" }, "expected exactly"],
    ["an admin host that is not running", { MOCK_HOST_STATE: "stopped" }, "not running"],
    ["an IP that maps to two interfaces", { MOCK_IP_MAPS_TWO: "1" }, "exactly one interface"],
    ["no snapshot", { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "" }, "OGEVIA_PREDEPLOY_SNAPSHOT_ID"],
    ["the snapshot of the 2026-10-19 pattern", { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-0085-202610250100" }, "pattern ogevia-prod-postgres-pre-0086-prd"],
    ["a snapshot that does not exist", { MOCK_SNAP_MISSING: "1" }, "cannot read snapshot"],
    ["a snapshot that is still creating", { MOCK_SNAP_STATUS: "creating" }, "not available"],
    ["a snapshot of another instance", { MOCK_SNAP_INSTANCE: "other-db" }, "belongs to"],
    ["an automated snapshot", { MOCK_SNAP_TYPE: "automated" }, "not a manual"],
    ["a snapshot created before the window", { MOCK_SNAP_CREATED: "2020-01-01T00:00:00.000000+00:00" }, "outside the release window"],
    ["a window that has not started", releaseWindow(30, 240), "release window has not started"],
    ["a window longer than 12 hours", releaseWindow(-60, 800), "12 hours"],
  ])("refuses %s", async (_n, env, text) => {
    const r = await run(["apply"], { env: env as Record<string, string> });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(text);
    noWindow();
    expect(lines("psql-calls.log")).toEqual([]);
  });
  it("refuses a package that is not exactly the approved one; nothing is opened", async () => {
    const cases: Array<[string, () => void, string]> = [
      ["a changed migration", () => writeFileSync(join(f.infra, "db/migrations/0001_roles_schemas_extensions.sql"), "-- edited\n"), "does not match its manifest"],
      ["a changed 0086 file", () => writeFileSync(join(f.infra, "db/pending/migrations/0086_staff_management.sql"), "-- edited\n"), "does not match its manifest"],
      ["a stray file in db/pending", () => writeFileSync(join(f.infra, "db/pending/migrations/0087_x.sql"), "x"), "not in the manifest"],
      ["no BUILD_INFO.json", () => rmSync(join(f.repo, "BUILD_INFO.json")), "BUILD_INFO.json is missing"],
      ["an empty manifest", () => writeFileSync(join(f.repo, "PACKAGE_MANIFEST.sha256"), ""), "does not match its manifest"],
      ["a missing verify-0086.sql", () => rmSync(join(f.repo, PKG_REL, "scripts/verify-0086.sql")), "does not match its manifest"],
    ];
    for (const [label, mutate, text] of cases) {
      f = fixture(); mutate();
      const r = await run(["apply"]);
      expect(r.code, `${label}: ${r.out}`).toBe(1); expect(r.out, label).toContain(text); noWindow();
    }
  });
  it("0086 inside db/migrations is refused even with a valid manifest (the production release pins 0001-0085)", async () => {
    writeFileSync(join(f.infra, "db/migrations/0086_staff_management.sql"), "-- smuggled\n"); sealPackage(f.repo, f.sha);
    const r = await run(["apply"]);
    expect(r.code, r.out).toBe(1); expect(r.out).toMatch(/not the approved 0001-0085 set|does not hold exactly the 85/); noWindow();
  });
  it("usage: unknown arguments exit 2", async () => {
    for (const a of [[], ["migrate"], ["apply", "--force"], ["--restore-only", "x"], ["rollback", "--resume"]]) expect((await run(a as string[])).code).toBe(2);
  });
  it("rollback needs the rollback-file pin and refuses a wrong one before any window", async () => {
    let r = await run(["rollback"], { env: { OGEVIA_EXPECT_0086_DOWN_SHA: "" }, input: ROLLBACK_PHRASE });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("OGEVIA_EXPECT_0086_DOWN_SHA"); noWindow();
    r = await run(["rollback"], { env: { OGEVIA_EXPECT_0086_DOWN_SHA: "d".repeat(64) }, input: ROLLBACK_PHRASE });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("not the approved"); noWindow();
  });
});

describe("apply", () => {
  it("applies 0086 in ONE transaction as ogevia_owner: ledger stays 85 / 0085, people unchanged, 110 checks pass, window closed, group identical, no ledger row", async () => {
    const r = await run(["apply"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("RESULT: 0086 applied (2 tables, 21 functions); ledger 85 / 0085 unchanged; people and access unchanged; verify-0086.sql 110 PASS");
    expect(r.out).toContain("RESTORED (verified)");
    expect(read("ledger")).toBe("85|0085"); expect(read("s86")).toBe("1|1|21");
    expect(writes()).toEqual(["up"]);
    const writeCall = lines("psql-calls.log").filter((l) => l.includes(" -1 "));
    expect(writeCall).toHaveLength(1);
    expect(writeCall[0]).toContain("-v ON_ERROR_STOP=1 -1 -d ogevia_prd -c set local role ogevia_owner -f ");
    expect(writeCall[0]).toContain("db/pending/migrations/0086_staff_management.sql -c reset role");
    expect(lines("npx-calls.log")).toEqual(["tsx db/scripts/verify.ts"]);
    restored();
    expect(verbs().filter((v) => v === "ec2 authorize-security-group-ingress")).toHaveLength(1);
    expect(verbs().filter((v) => v === "ec2 revoke-security-group-ingress")).toHaveLength(1);
    expect(r.out).not.toContain("ogevia_sv_test'"); expect(r.out).not.toMatch(/PGPASSWORD|postgres:\/\//);
  });
  it("a wrong typed phrase (including the ROLLBACK phrase) declines with nothing changed", async () => {
    for (const phrase of ["yes\n", "", ROLLBACK_PHRASE, "OPEN-5432-WINDOW-APPLY-0086-PRODUCTION\n"]) {
      f = fixture();
      const r = await run(["apply"], { input: phrase });
      expect(r.code, r.out).toBe(0); expect(r.out).toContain("Declined. Nothing was changed."); noWindow();
    }
  });
  it.each([
    ["a ledger of 84", "84|0084\n", "not exactly 85 / 0085"],
    ["a ledger already at 86 (a runner-applied 0086)", "86|0086\n", "not exactly 85 / 0085"],
    ["an empty ledger", "0|none\n", "not exactly 85 / 0085"],
  ])("%s stops after the window opened: no write, security group restored", async (_n, ledger, text) => {
    writeFileSync(join(f.dir, "ledger"), ledger);
    const r = await run(["apply"]);
    expect(r.code, r.out).toBe(1); expect(r.out).toContain(text); expect(r.out).toContain("RESTORED (verified)"); expect(writes()).toEqual([]); restored();
  });
  it.each([["0086 fully present", "1|1|21"], ["a partial 0086 (tables only)", "1|1|0"], ["one table only", "1|0|0"]])("%s stops: apply needs the objects absent; nothing is written", async (_n, s86) => {
    writeFileSync(join(f.dir, "s86"), s86 + "\n");
    const r = await run(["apply"]);
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("not absent"); expect(writes()).toEqual([]); expect(read("s86")).toBe(s86); restored();
  });
  it("connected to the wrong database or to a read-write session stops before any write", async () => {
    for (const env of [{ MOCK_CURRENT_DB: "ogevia_sv_test" }, { MOCK_READ_ONLY: "off" }] as Array<Record<string, string>>) {
      f = fixture();
      const r = await run(["apply"], { env });
      expect(r.code, r.out).toBe(1); expect(r.out).toMatch(/not 'ogevia_prd'|not read-only/); expect(writes()).toEqual([]); restored();
    }
  });
  it("a failing transaction keeps nothing, says so, restores the group and exits 1; the objects remain absent", async () => {
    const r = await run(["apply"], { env: { MOCK_WRITE_FAIL: "1" } });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("APPLY FAILED"); expect(r.out).toContain("nothing of 0086 was kept"); expect(r.out).toContain("RESTORED (verified)");
    expect(read("s86")).toBe("0|0|0"); expect(read("ledger")).toBe("85|0085"); expect(lines("npx-calls.log")).toEqual([]); restored();
  });
  it("a run that touches the ledger is a failure even though the SQL succeeded", async () => {
    const r = await run(["apply"], { env: { MOCK_WRITE_TOUCHES_LEDGER: "1" } });
    expect(r.code, r.out).toBe(1); expect(r.out).toMatch(/ledger/i); expect(r.out).not.toContain("RESULT: 0086 applied"); restored();
  });
  it("a change to people and access counts is a failure", async () => {
    const r = await run(["apply"], { env: { MOCK_WRITE_TOUCHES_PEOPLE: "1" } });
    expect(r.code, r.out).toBe(1); expect(r.out).toMatch(/people|access/i); expect(r.out).not.toContain("RESULT: 0086 applied"); restored();
  });
  it.each([
    ["one failing check", { MOCK_VERIFY_FAILING: "1" }],
    ["109 checks instead of 110", { MOCK_VERIFY_COUNT: "109" }],
    ["111 checks instead of 110", { MOCK_VERIFY_COUNT: "111" }],
  ])("verify-0086.sql with %s: stops, says 0086 IS applied and not to deploy, window closed", async (_n, env) => {
    const r = await run(["apply"], { env });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("verify-0086.sql did not report 110 passing checks"); expect(r.out).toContain("0086 IS applied"); expect(r.out).not.toContain("RESULT: 0086 applied"); restored();
  });
  it("a runner verification set that fails stops with 0086 IS applied", async () => {
    const r = await run(["apply"], { env: { MOCK_RUNNER_VERIFY_FAIL: "1" } });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("verification set did not pass"); expect(r.out).toContain("0086 IS applied"); restored();
  });
  it("an interrupted transaction (SIGTERM mid-apply) restores the group and exits 130", async () => {
    const r = await run(["apply"], { env: { MOCK_WRITE_SLEEP: "1" }, killWhen: () => existsSync(join(f.dir, "write-sleeping")) });
    expect(r.out).toContain("Interrupted: cleaning up."); expect(r.out).toContain("RESTORED (verified)"); expect(r.code).toBe(130); restored();
  });
});

describe("rollback (BACKUP REQUIRED)", () => {
  beforeEach(() => { writeFileSync(join(f.dir, "s86"), "1|1|21\n"); });
  it("needs the objects present, runs the pinned down file once as ogevia_owner, ledger unchanged, people unchanged, window closed", async () => {
    const r = await run(["rollback"], { input: ROLLBACK_PHRASE });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("BACKUP REQUIRED");
    expect(read("s86")).toBe("0|0|0"); expect(read("ledger")).toBe("85|0085"); expect(writes()).toEqual(["down"]);
    expect(lines("psql-calls.log").filter((l) => l.includes(" -1 "))[0]).toContain("db/pending/rollback/0086_staff_management.down.sql");
    restored();
  });
  it("the APPLY phrase does not authorise a rollback, and a rollback of an absent 0086 stops", async () => {
    let r = await run(["rollback"], { input: APPLY_PHRASE });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("Declined. Nothing was changed."); noWindow(); expect(read("s86")).toBe("1|1|21");
    f = fixture();
    r = await run(["rollback"], { input: ROLLBACK_PHRASE });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("rollback needs all 0086 objects present"); expect(writes()).toEqual([]); restored();
  });
  it("a failing rollback transaction leaves 0086 present, restores the group and exits 1", async () => {
    const r = await run(["rollback"], { input: ROLLBACK_PHRASE, env: { MOCK_WRITE_FAIL: "1" } });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("ROLLBACK FAILED"); expect(r.out).toContain("0086 is still present"); expect(read("s86")).toBe("1|1|21"); restored();
  });
});

describe("the window itself", () => {
  it("the revoke fails every time: exit 3, the marker stays, the exact recovery commands are printed, the next run is refused, and --restore-only restores once revoke works", async () => {
    const r = await run(["apply"], { env: { MOCK_REVOKE_ALWAYS_FAILS: "1", OGEVIA_CLEANUP_AWS_TIMEOUT: "5" } });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain("NOT RESTORED (exit 3; access may still be open)");
    expect(r.out).toContain("describe-security-group-rules"); expect(r.out).toContain("--security-group-rule-ids sgr-<id of that one row>");
    expect(r.out).toContain("bash apply-0086-prd.sh --restore-only");
    expect(cidrPresent()).toBe(true); expect(marker()).toBe(true);
    const next = await run(["apply"]);
    expect(next.code).toBe(1); expect(next.out).toContain("marked OPEN");
    const fixed = await run(["--restore-only"]);
    expect(fixed.code, fixed.out).toBe(0); expect(fixed.out).toContain("RESTORED (verified)"); restored();
  });
  it("a revoke that fails twice then works is retried to success; --restore-only with no marker changes nothing", async () => {
    const r = await run(["apply"], { env: { MOCK_REVOKE_FAILS: "2" } });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("RESTORED (verified)");
    const n = await run(["--restore-only"]);
    expect(n.code, n.out).toBe(0); expect(n.out).toContain("nothing to restore");
  });
  it("an earlier ledger-check window that is still open blocks the run", async () => {
    mkdirSync(join(f.dir, "ledger-state"), { recursive: true }); writeFileSync(join(f.dir, "ledger-state", "OPEN"), "{}");
    const r = await run(["apply"]);
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("ledger-check window is marked OPEN"); noWindow();
  });
  it("the elapsed-time limit stops a hung database session and closes the window", async () => {
    const r = await run(["apply"], { env: { MOCK_WRITE_SLEEP: "1", OGEVIA_APPLY_TIMEOUT: "2" } });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("APPLY FAILED"); expect(r.out).toContain("RESTORED (verified)"); restored();
  });
});

describe("rollback post-check", () => {
  it("a rollback that leaves note_my_sign_in on the staff version (or a staff permission) is a failure", async () => {
    writeFileSync(join(f.dir, "s86"), "1|1|21\n");
    const r = await run(["rollback"], { input: ROLLBACK_PHRASE, env: { MOCK_RESTORED_FN: "0|2" } });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("note_my_sign_in was not restored"); restored();
  });
});

describe("the release marker that gates the stack deployments", () => {
  const mk = () => join(f.dir, "prd-before", "db-0086.ok");
  it("a successful apply writes db-0086.ok (85|0085|0086) and the snapshot id; a failed or unverified apply writes nothing", async () => {
    let r = await run(["apply"]);
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(mk(), "utf8")).toBe("85|0085|0086\n");
    expect(readFileSync(join(f.dir, "prd-before", "db-0086.snapshot"), "utf8").trim()).toMatch(/^ogevia-prod-postgres-pre-0086-prd-\d{12}$/);
    for (const env of [{ MOCK_WRITE_FAIL: "1" }, { MOCK_VERIFY_FAILING: "1" }, { MOCK_RUNNER_VERIFY_FAIL: "1" }, { MOCK_WRITE_TOUCHES_LEDGER: "1" }] as Array<Record<string, string>>) {
      f = fixture();
      r = await run(["apply"], { env }); expect(r.code, r.out).toBe(1); expect(existsSync(mk()), JSON.stringify(env)).toBe(false);
    }
  });
  it("a rollback removes the marker; the TEST phrase does not authorise anything", async () => {
    writeFileSync(join(f.dir, "s86"), "1|1|21\n"); mkdirSync(join(f.dir, "prd-before"), { recursive: true }); writeFileSync(mk(), "85|0085|0086\n");
    let r = await run(["rollback"], { input: "OPEN-5432-WINDOW-ROLLBACK-0086-TEST\n" });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("Declined. Nothing was changed."); expect(existsSync(mk())).toBe(true);
    r = await run(["rollback"], { input: ROLLBACK_PHRASE });
    expect(r.code, r.out).toBe(0); expect(existsSync(mk())).toBe(false);
    f = fixture();
    r = await run(["apply"], { input: "OPEN-5432-WINDOW-APPLY-0086-TEST\n" });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("Declined. Nothing was changed."); noWindow();
  });
});
