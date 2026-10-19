// Rehearsal of rehearsal-migrate-test.sh (TEST rehearsal f6dd9b7: migrations 0078-0085 on a ledger of exactly 77 / 0077) against a FAKE aws, psql and npx and a synthetic extracted PACKAGE
// (BUILD_INFO.json + PACKAGE_MANIFEST.sha256, no git): no AWS, no network, synthetic. Adapted from candidate-migrate-test.test.ts of the 2026-10-18 operation.
// Proves the control flow the owner is asked to approve: the pins (package commit, manifest, no stray file, migration-set hash, host IP) are checked before any change; the single /32 rule is
// added and removed on success, on a migration failure, on interruption mid-migration and on a failed verification; the ledger precondition stops before any migration;
// a failed revoke exits 3 with a marker and rule-id recovery text and blocks the next run until --restore-only succeeds; ogevia_prd is never named; no credential is printed.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync as writeTranscript } from "node:fs";
import { INITIAL_SG, installMocks } from "./ledger-window-mocks.js";
import { PKG_REL } from "./rehearsal-fixtures.js";

vi.setConfig({ testTimeout: 90000 });
const SCRIPTS_DIR = fileURLToPath(new URL("../../../docs/releases/2026-10-19-test-rehearsal/scripts/", import.meta.url));
const SCRIPT_SRC = join(SCRIPTS_DIR, "rehearsal-migrate-test.sh");
const source = readFileSync(SCRIPT_SRC, "utf8");
const code = source.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
let transcriptCount = 0;
const HOST_IP = "10.20.132.179";
const CIDR = `${HOST_IP}/32`;
const PHRASE = "OPEN-5432-WINDOW-MIGRATE-TEST\n";
const RPHRASE = "OPEN-5432-WINDOW-ROLLBACK-TEST\n";

// the ledger-reading psql: replaces the ledger-check mock's, same behaviour plus the new ledger query
const PSQL = `#!/usr/bin/env bash
D="$MOCK_DIR"
[[ "\${PGOPTIONS:-}" == *"default_transaction_read_only=on"* || "$*" == *" -f "* ]] || echo "psql without the read-only option" >> "$D/psql-violations.log"
echo "$*" >> "$D/psql-calls.log"
[[ -n "\${MOCK_PSQL_FAIL:-}" ]] && { echo "psql: connection failed" >&2; exit 2; }
read -r n latest < <(tr '|' ' ' < "$D/ledger")
if [[ "$*" == *" -f "* ]]; then
  # a rollback session: psql ... -1 -d DB -c "set local role ..." -f FILE -c "reset role" -c "delete ... version = 'NNNN'"
  [[ "$*" == *"-1"* && "$*" == *"ON_ERROR_STOP=1"* && "$*" == *"-d ogevia_sv_test"* ]] || echo "write session without -1 / ON_ERROR_STOP / the TEST database: $*" >> "$D/psql-violations.log"
  ver=$(grep -oE "version = '[0-9]{4}'" <<<"$*" | grep -oE '[0-9]{4}')
  echo "down $ver $(grep -o ' -f [^ ]*' <<<"$*" | tr -d ' ' )" >> "$D/down-calls.log"
  if [[ -n "$ver" && "\${MOCK_DOWN_SLEEP_AT:-}" == "$ver" ]]; then touch "$D/down-sleeping"; exec sleep 60; fi
  if [[ -n "$ver" && "\${MOCK_DOWN_FAIL_AT:-}" == "$ver" ]]; then echo "ERROR: cannot drop table x because other objects depend on it" >&2; exit 3; fi
  v=$((10#$ver - 1)); echo "$v|$(printf '%04d' $v)" > "$D/ledger"; exit 0
fi
case "$*" in
  *current_database*) echo "\${MOCK_CURRENT_DB:-ogevia_sv_test} | read_only=on" ;;
  *organization_readiness_settings*) c=$(cat "$D/act-count" 2>/dev/null || echo 0); echo "$c|2" ;;
  *"migrations applied, latest"*) echo "$n migrations applied, latest $latest" ;;
  *schema_migrations*) echo "$n|$latest" ;;
  *) echo "mock psql: unexpected: $*" >&2; exit 98 ;;
esac
`;
// npx tsx db/scripts/migrate.ts | verify.ts
const NPX = `#!/usr/bin/env bash
D="$MOCK_DIR"
echo "$*" >> "$D/npx-calls.log"
url_db="\${OGEVIA_DATABASE_URL##*/}"; url_db="\${url_db%%\\?*}"
echo "$url_db" >> "$D/npx-db.log"
case "$*" in
  *migrate.ts)
    read -r n latest < <(tr '|' ' ' < "$D/ledger")
    start=$((10#$latest + 1))
    for v in $(seq "$start" 85); do
      ver=$(printf '%04d' "$v")
      if [[ "\${MOCK_MIGRATE_SLEEP_AT:-}" == "$ver" ]]; then touch "$D/migrate-sleeping"; echo "applying \${ver}_x.sql"; exec sleep 60; fi
      if [[ "\${MOCK_MIGRATE_FAIL_AT:-}" == "$ver" ]]; then echo "applying \${ver}_x.sql"; echo "error: syntax error in \${ver}_x.sql" >&2; exit 1; fi
      echo "applying \${ver}_x.sql"; echo "$v|$ver" > "$D/ledger"
    done
    echo "applied $((85 - start + 1)), already applied $n" ;;
  *verify.ts)
    if [[ -n "\${MOCK_VERIFY_FAIL:-}" ]]; then echo "FAIL 08_release_objects.sql release_table_x"; echo "PASS 01_schema_version.sql latest_migration_is_0085"; exit 1; fi
    echo "PASS 01_schema_version.sql latest_migration_is_0085"; for i in $(seq 1 120); do echo "PASS 0$((i % 7 + 2))_x.sql check_$i"; done ;;
  *) echo "mock npx: unexpected: $*" >&2; exit 97 ;;
esac
`;

interface Fix { dir: string; bin: string; repo: string; script: string; sha: string; migSha: string; rollSha: string; infra: string }
const sha256 = (x: string) => createHash("sha256").update(x).digest("hex");
function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, r)); else out.push(r);
  }
  return out;
}
/** write BUILD_INFO.json and the manifest of every file (not node_modules), as build-operator-tarball.sh does */
function sealPackage(repo: string, sha: string) {
  writeFileSync(join(repo, "BUILD_INFO.json"), JSON.stringify({ code_commit: sha, approval_ref: "APPROVAL-REF-PENDING-OWNER" }));
  const files = listFiles(repo).filter((x) => x !== "PACKAGE_MANIFEST.sha256").sort();
  writeFileSync(join(repo, "PACKAGE_MANIFEST.sha256"), files.map((x) => `${sha256(readFileSync(join(repo, x), "utf8"))}  ${x}\n`).join(""));
}
function fixture(): Fix {
  const dir = mkdtempSync(join(tmpdir(), "migwin-"));
  const bin = installMocks(dir);
  writeFileSync(join(bin, "psql"), PSQL); writeFileSync(join(bin, "npx"), NPX);
  for (const f of ["psql", "npx"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(dir, "ledger"), "77|0077");
  // the fake aws gains the one extra read-only verb the rollback mode uses, then delegates to the ledger-window mock
  copyFileSync(join(bin, "aws"), join(bin, "aws-base"));
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env bash
echo "$AWS_REGION|$AWS_DEFAULT_REGION|[$AWS_PAGER]" >> "$MOCK_DIR/aws-env.log"
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
  // the extracted package: infra/aws with synthetic migrations 0001-0085 and rollbacks 0078-0085, node_modules (installed), the scripts, BUILD_INFO.json and the manifest
  const repo = join(dir, "pkg");
  const infra = join(repo, "infra", "aws");
  const scriptsDir = join(repo, PKG_REL, "scripts");
  mkdirSync(scriptsDir, { recursive: true }); mkdirSync(join(infra, "db", "migrations"), { recursive: true }); mkdirSync(join(infra, "node_modules"), { recursive: true }); mkdirSync(join(repo, "node_modules"), { recursive: true });
  mkdirSync(join(infra, "db", "rollback"), { recursive: true });
  for (let i = 78; i <= 85; i++) writeFileSync(join(infra, "db", "rollback", `${String(i).padStart(4, "0")}_m${i}.down.sql`), `-- synthetic rollback ${i}\n`);
  for (let i = 1; i <= 85; i++) writeFileSync(join(infra, "db", "migrations", `${String(i).padStart(4, "0")}_m${i}.sql`), `-- synthetic ${i}\n`);
  const script = join(scriptsDir, "rehearsal-migrate-test.sh");
  copyFileSync(SCRIPT_SRC, script); copyFileSync(join(SCRIPTS_DIR, "pkg-lib.sh"), join(scriptsDir, "pkg-lib.sh"));
  const sha = createHash("sha1").update(dir).digest("hex");
  sealPackage(repo, sha);
  const lines = Array.from({ length: 85 }, (_, i) => { const n = `${String(i + 1).padStart(4, "0")}_m${i + 1}.sql`; return `${createHash("sha256").update(`-- synthetic ${i + 1}\n`).digest("hex")}  ${n}\n`; }).join("");
  const rlines = Array.from({ length: 8 }, (_, i) => { const n = `${String(i + 78).padStart(4, "0")}_m${i + 78}.down.sql`; return `${createHash("sha256").update(`-- synthetic rollback ${i + 78}\n`).digest("hex")}  ${n}\n`; }).join("");
  return { dir, bin, repo, infra, script, sha, migSha: createHash("sha256").update(lines).digest("hex"), rollSha: createHash("sha256").update(rlines).digest("hex") };
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const s = createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
}

// The owner-approved release window and the named snapshot, relative to now: the window started an hour ago and ends in three hours; the snapshot was taken ten minutes ago.
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
const stamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60000);
const snapName = (minutesAgo = 10) => `ogevia-prod-postgres-pre-0085-${stamp(minutesFromNow(-minutesAgo))}`;
function releaseWindow(startMin = -60, endMin = 180, snapAgo = 10) {
  return { OGEVIA_RELEASE_WINDOW_START: iso(minutesFromNow(startMin)), OGEVIA_RELEASE_WINDOW_END: iso(minutesFromNow(endMin)), OGEVIA_PREDEPLOY_SNAPSHOT_ID: snapName(snapAgo), MOCK_SNAP_AGE_MIN: String(snapAgo) };
}
interface Run { code: number | null; out: string; outDir: string }
let f: Fix;
beforeEach(() => { f = fixture(); });
/** EPIPE on the child's stdin is expected when the script refuses before reading it; every other error is returned so the test fails. */
export const stdinErrorToSurface = (e: NodeJS.ErrnoException): Error | null => (e.code === "EPIPE" ? null : e);
async function run(args: string[], opts: { env?: Record<string, string>; input?: string; killWhen?: () => boolean } = {}): Promise<Run> {
  const port = await freePort();
  const outDir = join(f.dir, `out-${Math.random().toString(36).slice(2)}`);
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env, PATH: `${f.bin}:${process.env.PATH}`, MOCK_DIR: f.dir, HOME: f.dir,
      OGEVIA_MIGRATE_STATE_DIR: join(f.dir, "state"), OGEVIA_LEDGER_STATE_DIR: join(f.dir, "ledger-state"), OGEVIA_MIGRATE_DIR: outDir, OGEVIA_MIGRATE_PORT: String(port),
      OGEVIA_EXPECT_COMMIT: f.sha, OGEVIA_EXPECT_MIGRATIONS_SHA: f.migSha, OGEVIA_EXPECT_HOST_IP: HOST_IP, OGEVIA_TUNNEL_WAIT: "10", OGEVIA_EXPECT_ROLLBACK_SHA: f.rollSha, ...releaseWindow(), ...(opts.env ?? {}),
    };
    const p = spawn("bash", [f.script, ...args], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    // A script that refuses (usage error, failed pin) exits before it reads stdin, so writing the typed phrase can fail with EPIPE: that is expected and harmless.
    // Any other stdin error is unexpected and fails the test instead of being swallowed.
    let stdinError: Error | null = null;
    p.stdin.on("error", (e: NodeJS.ErrnoException) => { stdinError = stdinErrorToSurface(e) ?? stdinError; });
    p.stdin.end(opts.input ?? PHRASE);
    let killed = false;
    const timer = opts.killWhen ? setInterval(() => { if (!killed && opts.killWhen!()) { killed = true; process.kill(-p.pid!, "SIGTERM"); } }, 50) : null;
    p.on("close", (c) => { if (timer) clearInterval(timer); if (process.env.TRANSCRIPT_DIR) writeTranscript(join(process.env.TRANSCRIPT_DIR, `${expect.getState().currentTestName!.replace(/\W+/g, "_").slice(0, 60)}_${createHash("sha1").update(expect.getState().currentTestName!).digest("hex").slice(0, 6)}_${transcriptCount++}__${args.join("_")}.txt`), out.replace(new RegExp(f.dir, "g"), "<tmp>")); if (stdinError) reject(stdinError); else resolve({ code: c, out, outDir }); });
  });
}
const sg = () => JSON.parse(readFileSync(join(f.dir, "sg.json"), "utf8"));
const calls = () => (existsSync(join(f.dir, "aws-calls.log")) ? readFileSync(join(f.dir, "aws-calls.log"), "utf8").split("\n").filter(Boolean) : []);
const verbs = () => calls().map((c) => c.split(" ").slice(0, 2).join(" "));
const cidrPresent = () => sg().i.some((p: any) => p.FromPort === 5432 && p.IpRanges.some((r: any) => r.CidrIp === CIDR));
const marker = () => existsSync(join(f.dir, "state", "OPEN"));
const ledger = () => readFileSync(join(f.dir, "ledger"), "utf8").trim();
const npxCalls = () => (existsSync(join(f.dir, "npx-calls.log")) ? readFileSync(join(f.dir, "npx-calls.log"), "utf8").split("\n").filter(Boolean) : []);
const noAwsWrite = () => expect(verbs()).not.toContain("ec2 authorize-security-group-ingress");

describe("static scope of the script", () => {
  it("uses only the reviewed AWS verbs, never names the production database, never prints the credential, and has no destructive command", () => {
    const used = new Set([...code.matchAll(/(?:^|[\s(;|&$])aws\s+(sts|cloudformation|lambda|rds|ec2|ssm|secretsmanager|s3|iam|events|cdk)\s+([a-z0-9-]+)/gm)].map((m) => `${m[1]} ${m[2]}`));
    for (const v of used) expect(["sts get-caller-identity", "cloudformation describe-stacks", "cloudformation list-stack-resources", "lambda get-function-configuration", "rds describe-db-instances", "ec2 describe-instances", "ec2 describe-network-interfaces", "ec2 describe-security-groups", "ec2 authorize-security-group-ingress", "ec2 revoke-security-group-ingress", "ssm start-session", "secretsmanager get-secret-value", "ec2 describe-security-group-rules", "rds describe-db-snapshots"]).toContain(v);
    // the production database is named in exactly the notices that say it is never touched, and nowhere else
    const prdLines = code.split("\n").filter((l) => /ogevia_prd|Ogevia-prd/.test(l));
    expect(prdLines.length).toBeGreaterThan(0);
    for (const l of prdLines) expect(l).toMatch(/never names, connects to or queries it|ogevia_prd: this script/);
    expect(code).not.toMatch(/DB_EXPECT=ogevia_prd|Ogevia-prd-/);
    // SQL in -c strings: the only write the script itself issues is the ledger row delete inside the rollback transaction; no drop, truncate or other update
    const sqlStrings = [...code.matchAll(/-c "([^"]*)"/g)].map((m) => m[1]!);
    for (const q of sqlStrings) expect(q).not.toMatch(/\b(drop|truncate|alter|insert|update)\b/i);
    for (const q of sqlStrings.filter((x) => /\bdelete\b/i.test(x))) expect(q).toMatch(/^delete from ogevia_meta\.schema_migrations where version = /);
    expect(code).not.toMatch(/--delete|rm -rf/);
    expect(code).not.toMatch(/(?:^|[\s(;|&$])git\s+(?:-C\s+\S+\s+)?(?:checkout|fetch|pull|reset|clean|merge|rebase|switch)\b/m);
    expect(code).not.toMatch(/echo[^\n]*PGPASSWORD|echo[^\n]*DBURL|say[^\n]*\$DBURL|say[^\n]*\$PGPASSWORD/);
    expect(code).not.toMatch(/(^|[^A-Za-z_-])git([^A-Za-z_-]|$)/m); // no git in CloudShell: identity comes from BUILD_INFO.json and the manifest
    expect(code).toContain("IpRanges=[{CidrIp=$HOST_CIDR");
    expect(code).not.toContain("UserIdGroupPairs=[{GroupId=$ADMIN_SG");
  });
});

describe("pins and preconditions change nothing", () => {
  it.each([
    ["no commit pin", { OGEVIA_EXPECT_COMMIT: "" }, "OGEVIA_EXPECT_COMMIT"],
    ["a short commit pin", { OGEVIA_EXPECT_COMMIT: "abc1234" }, "OGEVIA_EXPECT_COMMIT"],
    ["another commit", { OGEVIA_EXPECT_COMMIT: "0".repeat(40) }, "not the approved"],
    ["no migration-set pin", { OGEVIA_EXPECT_MIGRATIONS_SHA: "" }, "OGEVIA_EXPECT_MIGRATIONS_SHA"],
    ["a different migration set", { OGEVIA_EXPECT_MIGRATIONS_SHA: "f".repeat(64) }, "not the approved"],
    ["no host IP pin", { OGEVIA_EXPECT_HOST_IP: "" }, "OGEVIA_EXPECT_HOST_IP"],
    ["a public host IP pin", { OGEVIA_EXPECT_HOST_IP: "8.8.8.8" }, "OGEVIA_EXPECT_HOST_IP"],
    ["another live host IP", { OGEVIA_EXPECT_HOST_IP: "10.20.132.180" }, "live IP"],
    ["the Lambda serving the production database", { MOCK_LAMBDA_DB: "ogevia_prd", MOCK_LAMBDA_ENV: "prd" }, "Not the TEST environment"],
    ["the Lambda with OGEVIA_ENV=prd", { MOCK_LAMBDA_ENV: "prd" }, "OGEVIA_ENV=prd"],
    ["an admin host in another group", { MOCK_HOST_SG: "sg-0123456789abcdef0" }, "expected exactly"],
    ["an RDS group that is not the expected one", { MOCK_RDS_SG: "sg-0aaaaaaaaaaaaaaaa" }, "expected exactly"],
    ["an admin host with a second address", { MOCK_HOST_SECOND_IP: "10.20.132.201" }, "ONE private IPv4"],
    ["an admin host that is not running", { MOCK_HOST_STATE: "stopped" }, "not running"],
    ["an IP that maps to two interfaces", { MOCK_IP_MAPS_TWO: "1" }, "exactly one interface"],
  ])("refuses %s", async (_n, env, text) => {
    const r = await run(["migrate"], { env: env as Record<string, string> });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(text);
    noAwsWrite();
    expect(sg()).toEqual(INITIAL_SG);
    expect(npxCalls()).toEqual([]);
    expect(marker()).toBe(false);
  });
  it("refuses a package that is not exactly the approved one: a changed file, a missing file, a stray file, no BUILD_INFO, another commit; nothing is opened", async () => {
    const cases: Array<[string, () => void, string]> = [
      ["a changed packaged file", () => writeFileSync(join(f.infra, "db", "migrations", "0001_m1.sql"), "-- edited\n"), "does not match its manifest"],
      ["a missing packaged file", () => rmSync(join(f.infra, "db", "rollback", "0080_m80.down.sql")), "does not match its manifest"],
      ["a stray file", () => writeFileSync(join(f.infra, "stray.txt"), "x"), "not in the manifest"],
      ["no BUILD_INFO.json", () => rmSync(join(f.repo, "BUILD_INFO.json")), "BUILD_INFO.json is missing"],
      ["an empty manifest", () => writeFileSync(join(f.repo, "PACKAGE_MANIFEST.sha256"), ""), "does not match its manifest"],
    ];
    for (const [label, mutate, text] of cases) {
      f = fixture(); mutate();
      const r = await run(["migrate"]);
      expect(r.code, `${label}: ${r.out}`).toBe(1);
      expect(r.out, label).toContain(text);
      noAwsWrite(); expect(sg()).toEqual(INITIAL_SG); expect(npxCalls()).toEqual([]);
    }
  });
  it("refuses when an earlier ledger-check window or migration window is marked open", async () => {
    mkdirSync(join(f.dir, "ledger-state"), { recursive: true }); writeFileSync(join(f.dir, "ledger-state", "OPEN"), "{}");
    const r = await run(["migrate"]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("ledger-check window is marked OPEN");
    noAwsWrite();
  });
  it("shows the exact changes, then does nothing unless the exact phrase is typed", async () => {
    const r = await run(["migrate"], { input: "yes\n" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from ${CIDR}`);
    expect(r.out).toContain("ALSO holds ogevia_prd: this script never names, connects to or queries it");
    expect(r.out).toContain("Declined. Nothing was changed.");
    noAwsWrite();
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("the ledger precondition: anything but exactly 77 / 0077 stops before any migration, and the group is restored", async () => {
    for (const bad of ["76|0076", "78|0078", "80|0080", "77|0078", "52|0052", "85|0085"]) {
      f = fixture(); writeFileSync(join(f.dir, "ledger"), bad);
      const r = await run(["migrate"]);
      expect(r.code, `${bad}: ${r.out}`).toBe(1);
      expect(r.out).toContain("not exactly 77 / 0077");
      expect(r.out).toContain("RESTORED (verified)");
      expect(npxCalls()).toEqual([]);
      expect(sg()).toEqual(INITIAL_SG);
      expect(ledger()).toBe(bad);
    }
  });
  it("connected to the wrong database: stops, migrates nothing, restores", async () => {
    const r = await run(["migrate"], { env: { MOCK_CURRENT_DB: "ogevia_prd" } });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("connected to 'ogevia_prd', not 'ogevia_sv_test'");
    expect(npxCalls()).toEqual([]);
    expect(sg()).toEqual(INITIAL_SG);
  });
});

describe("success", () => {
  it("one /32 rule added and removed; the runner is pointed at ogevia_sv_test only; ledger 85 / 0085; verification passes; nothing secret printed; ogevia_prd never touched", async () => {
    const r = await run(["migrate"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("window open: exactly one rule was added");
    expect(r.out).toContain("connected: ogevia_sv_test | read_only=on");
    expect(r.out).toContain("ledger before: 77 migrations applied, latest 0077");
    expect(r.out).toContain("ledger after: 85 migrations applied, latest 0085");
    expect(r.out).toContain("verification: 121 PASS, 0 FAIL");
    expect(r.out).toContain("enforcement activated for 0 of 2 agencies before (this run never changes it)");
    expect(r.out).toContain("enforcement state unchanged: 0 of 2 agencies activated");
    expect(r.out).toContain("RESTORED (verified)");
    expect(r.out).toContain("SECURITY GROUP: restored and verified identical to the original");
    expect(sg()).toEqual(INITIAL_SG);
    expect(cidrPresent()).toBe(false);
    expect(marker()).toBe(false);
    expect(ledger()).toBe("85|0085");
    const v = verbs();
    expect(v.filter((x) => x === "ec2 authorize-security-group-ingress")).toHaveLength(1);
    expect(v.join("|")).not.toMatch(/modify|attach|create|delete|update|UNEXPECTED/);
    // the rule is only ever the admin host's /32, never a group
    expect(calls().filter((c) => c.startsWith("ec2 authorize")).join(" ")).toContain(`CidrIp=${CIDR}`);
    expect(calls().filter((c) => c.startsWith("ec2 authorize")).join(" ")).not.toContain("UserIdGroupPairs");
    // the runner and the verifier ran once each against the TEST database only
    expect(npxCalls().map((c) => c.split(" ").pop())).toEqual(["db/scripts/migrate.ts", "db/scripts/verify.ts"]);
    expect(new Set(readFileSync(join(f.dir, "npx-db.log"), "utf8").split("\n").filter(Boolean))).toEqual(new Set(["ogevia_sv_test"]));
    const notice = "That instance ALSO holds ogevia_prd: this script never names, connects to or queries it.";
    const all = (r.out + readFileSync(join(r.outDir, "RESULT.txt"), "utf8")).split(notice).join("") + readFileSync(join(f.dir, "psql-calls.log"), "utf8") + readFileSync(join(f.dir, "npx-db.log"), "utf8");
    expect(all).not.toContain("SECRET-PW-CANARY");
    expect(all).not.toContain("ogevia_prd");
    expect(existsSync(join(f.dir, "psql-violations.log"))).toBe(false);
  });
  it("--resume continues a partly migrated TEST ledger; without --resume it stops", async () => {
    writeFileSync(join(f.dir, "ledger"), "80|0080");
    const stopped = await run(["migrate"]);
    expect(stopped.code).toBe(1);
    expect(npxCalls()).toEqual([]);
    const ok = await run(["migrate", "--resume"]);
    expect(ok.code, ok.out).toBe(0);
    expect(ledger()).toBe("85|0085");
    expect((await run(["migrate", "--resume"], { })).code).toBe(1); // 85 is not resumable
    f = fixture(); expect((await run(["migrate", "--resume"])).code).toBe(1); // 77 (nothing applied yet) is not resumable either: use plain migrate
  });
});

describe("failure and interruption (the rehearsal the owner asked for)", () => {
  it("a migration fails: the runner's failure is reported, the ledger shows where it stopped, verification is NOT run, the group is restored, exit 1", async () => {
    const r = await run(["migrate"], { env: { MOCK_MIGRATE_FAIL_AT: "0081" } });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("MIGRATION FAILED (runner exit 1)");
    expect(r.out).toContain("earlier files remain applied");
    expect(r.out).toContain("The window had been opened: the cleanup above restored and verified the security group.");
    expect(r.out).toContain("Ledger now: 80 migrations applied, latest 0080");
    expect(r.out).toContain("RESTORED (verified)");
    expect(npxCalls().map((c) => c.split(" ").pop())).toEqual(["db/scripts/migrate.ts"]);
    expect(ledger()).toBe("80|0080");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("interrupted (SIGTERM, as a closed terminal or Ctrl+C) in the middle of a migration: the runner is ended, the ledger position is printed, the group is restored, exit 130", async () => {
    const r = await run(["migrate"], { env: { MOCK_MIGRATE_SLEEP_AT: "0082" }, killWhen: () => existsSync(join(f.dir, "migrate-sleeping")) });
    expect(r.code, r.out).toBe(130);
    expect(r.out).toContain("Interrupted: cleaning up.");
    expect(r.out).toContain("LEDGER at the moment of closing (best effort): 81 migrations applied, latest 0081");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
    expect(npxCalls().map((c) => c.split(" ").pop())).toEqual(["db/scripts/migrate.ts"]);
  });
  it("the migrations succeed but the verification set fails: reported as applied-but-unverified, exit 1, group restored", async () => {
    const r = await run(["migrate"], { env: { MOCK_VERIFY_FAIL: "1" } });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("The migrations ARE applied; do not deploy the API or web");
    expect(r.out).toContain("RESTORED (verified)");
    expect(ledger()).toBe("85|0085");
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("the database connection fails: nothing is migrated and the group is restored", async () => {
    const r = await run(["migrate"], { env: { MOCK_PSQL_FAIL: "1" } });
    expect(r.code, r.out).toBe(1);
    expect(npxCalls()).toEqual([]);
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("adding the rule fails: nothing else happens and no marker is left", async () => {
    const r = await run(["migrate"], { env: { MOCK_FAIL_AUTHORIZE: "1" } });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("could not add the rule");
    expect(npxCalls()).toEqual([]);
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("the tunnel never opens: stops, restores", async () => {
    const r = await run(["migrate"], { env: { MOCK_TUNNEL_NEVER_OPENS: "1", OGEVIA_TUNNEL_WAIT: "2" } });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("tunnel did not open");
    expect(sg()).toEqual(INITIAL_SG);
  });
  it("the revoke fails every time: exit 3, the marker stays, the exact rule-id recovery commands are printed, the next run is refused, and --restore-only restores once revoke works", async () => {
    const r = await run(["migrate"], { env: { MOCK_REVOKE_ALWAYS_FAILS: "1", OGEVIA_CLEANUP_AWS_TIMEOUT: "5" } });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain("NOT RESTORED (exit 3; access may still be open)");
    expect(r.out).toContain("describe-security-group-rules");
    expect(r.out).toContain("--security-group-rule-ids sgr-<id of that one row>");
    expect(r.out).toContain("never the row whose sourceSg is the application group sg-064ffce3bcbe8eb3b");
    expect(r.out).toContain("bash rehearsal-migrate-test.sh --restore-only");
    expect(cidrPresent()).toBe(true);
    expect(marker()).toBe(true);
    const next = await run(["migrate"]);
    expect(next.code).toBe(1);
    expect(next.out).toContain("marked OPEN");
    const fixed = await run(["--restore-only"]);
    expect(fixed.code, fixed.out).toBe(0);
    expect(fixed.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("a revoke that fails twice then works is retried to success", async () => {
    const r = await run(["migrate"], { env: { MOCK_REVOKE_FAILS: "2" } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("RESTORED (verified)");
  });
  it("--restore-only with no marker changes nothing", async () => {
    const r = await run(["--restore-only"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("nothing to restore");
    noAwsWrite();
  });
  it("usage errors exit 2 before anything is read", async () => {
    for (const a of [[], ["prod"], ["migrate", "--force"], ["--restore-only", "x"], ["rollback", "--resume"]]) expect((await run(a as string[])).code).toBe(2);
  });
  it("a refusal that exits before reading stdin is not an error (EPIPE is expected), repeatedly; any other stdin error is surfaced", async () => {
    for (let i = 0; i < 40; i++) expect((await run(["prod"])).code).toBe(2);
    expect(stdinErrorToSurface(Object.assign(new Error("broken pipe"), { code: "EPIPE" }))).toBeNull();
    const other = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(stdinErrorToSurface(other)).toBe(other);
  });
});

describe("database-only recovery: rollback of the TEST database", () => {
  const downs = () => (existsSync(join(f.dir, "down-calls.log")) ? readFileSync(join(f.dir, "down-calls.log"), "utf8").split("\n").filter(Boolean) : []);
  const rollback = (env: Record<string, string> = {}, extra: Parameters<typeof run>[1] = {}) => run(["rollback"], { input: RPHRASE, ...extra, env });
  beforeEach(() => { writeFileSync(join(f.dir, "ledger"), "85|0085"); });

  it("reverts 0085 down to 0078, one transaction per file, only in ogevia_sv_test; ledger back to 77 / 0077; the single /32 rule is added and removed; no migration or verification runs", async () => {
    const r = await rollback();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("0078-0085 are FUNCTIONS ONLY");
    expect(r.out).toContain("ledger after: 77 migrations applied, latest 0077");
    expect(r.out).toContain("migrations 0085 to 0078 reverted");
    expect(r.out).toContain("RESTORED (verified)");
    expect(downs().map((d) => d.split(" ")[1])).toEqual(Array.from({ length: 8 }, (_, i) => String(85 - i).padStart(4, "0")));
    expect(ledger()).toBe("77|0077");
    expect(sg()).toEqual(INITIAL_SG);
    expect(npxCalls()).toEqual([]);
    expect(verbs().filter((x) => x === "ec2 authorize-security-group-ingress")).toHaveLength(1);
    expect(verbs()).toContain("rds describe-db-snapshots");
    expect(existsSync(join(f.dir, "psql-violations.log"))).toBe(false);
    const sqlLog = readFileSync(join(f.dir, "psql-calls.log"), "utf8");
    expect(sqlLog).not.toContain("ogevia_prd");
    expect(sqlLog).toContain("-d ogevia_sv_test");
  });
  it("refuses a rollback set that is not the approved one, before any access is opened", async () => {
    for (const [env, text] of [[{ OGEVIA_EXPECT_ROLLBACK_SHA: "e".repeat(64) }, "not the approved"], [{ OGEVIA_EXPECT_ROLLBACK_SHA: "" }, "OGEVIA_EXPECT_ROLLBACK_SHA"]] as Array<[Record<string, string>, string]>) {
      f = fixture(); writeFileSync(join(f.dir, "ledger"), "85|0085");
      const r = await rollback(env);
      expect(r.code, `${text}: ${r.out}`).toBe(1);
      expect(r.out).toContain(text);
      noAwsWrite();
      expect(downs()).toEqual([]);
      expect(sg()).toEqual(INITIAL_SG);
    }
  });
  it("stops, reverting nothing, when there is nothing to revert or the ledger is not contiguous", async () => {
    for (const bad of ["77|0077", "80|0085", "76|0076", "52|0052"]) {
      f = fixture(); writeFileSync(join(f.dir, "ledger"), bad);
      const r = await rollback();
      expect(r.code, `${bad}: ${r.out}`).toBe(1);
      expect(r.out).toContain("rollback needs a contiguous ledger between 0078 and 0085");
      expect(downs()).toEqual([]);
      expect(r.out).toContain("RESTORED (verified)");
      expect(ledger()).toBe(bad);
    }
  });
  it("a partly migrated TEST database (80 / 0080) is reverted from where it stands", async () => {
    writeFileSync(join(f.dir, "ledger"), "80|0080");
    const r = await rollback();
    expect(r.code, r.out).toBe(0);
    expect(downs().map((d) => d.split(" ")[1])).toEqual(Array.from({ length: 3 }, (_, i) => String(80 - i).padStart(4, "0")));
    expect(ledger()).toBe("77|0077");
  });
  it("a rollback file fails: that file's transaction is rolled back (ledger stays at it), the files above stay reverted, nothing below is attempted, the group is restored, exit 1", async () => {
    const r = await rollback({ MOCK_DOWN_FAIL_AT: "0081" });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("ROLLBACK FAILED at 0081");
    expect(r.out).toContain("Ledger now: 81 migrations applied, latest 0081");
    expect(r.out).toContain("RESTORED (verified)");
    expect(downs().map((d) => d.split(" ")[1]).pop()).toBe("0081");
    expect(ledger()).toBe("81|0081");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("interrupted in the middle of a rollback: the ledger position is printed, the group is restored, exit 130", async () => {
    const r = await rollback({ MOCK_DOWN_SLEEP_AT: "0080" }, { killWhen: () => existsSync(join(f.dir, "down-sleeping")) });
    expect(r.code, r.out).toBe(130);
    expect(r.out).toContain("Interrupted: cleaning up.");
    expect(r.out).toContain("LEDGER at the moment of closing (best effort): 80 migrations applied, latest 0080");
    expect(r.out).toContain("RESTORED (verified)");
    expect(sg()).toEqual(INITIAL_SG);
    expect(marker()).toBe(false);
  });
  it("the exact phrase for the rollback differs from the migration phrase, and the wrong one does nothing", async () => {
    const r = await rollback({}, { input: PHRASE });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Declined. Nothing was changed.");
    noAwsWrite();
    expect(downs()).toEqual([]);
  });
});

describe("enforcement activation is a separate approval: this script never changes it and proves it did not change", () => {
  it("reports the state before and after; a state that changes during the run stops it with the migrations reported as applied", async () => {
    // the fake npx's migrate step flips the activation count, as if something activated enforcement during the window
    writeFileSync(join(f.bin, "npx"), readFileSync(join(f.bin, "npx"), "utf8").replace("echo \"applied $((85 - start + 1)), already applied $n\" ;;", "echo 1 > \"$D/act-count\"; echo \"applied $((85 - start + 1)), already applied $n\" ;;"));
    const r = await run(["migrate"]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("the enforcement activation state changed during the migration");
    expect(r.out).toContain("RESTORED (verified)");
  });
  it("starting with an agency already activated is reported, not hidden, and does not block a run that leaves it unchanged", async () => {
    writeFileSync(join(f.dir, "act-count"), "1");
    const r = await run(["migrate"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("enforcement activated for 1 of 2 agencies before");
    expect(r.out).toContain("enforcement state unchanged: 1 of 2 agencies activated");
  });
});

describe("the named, available pre-deployment snapshot is required in BOTH modes and validated before any access is opened", () => {
  const MODES: Array<["migrate" | "rollback", string]> = [["migrate", "77|0077"], ["rollback", "85|0085"]];
  const start = (mode: string, env: Record<string, string>) => run([mode], { input: mode === "rollback" ? RPHRASE : PHRASE, env });
  const REFUSALS: Array<[string, Record<string, string> | (() => Record<string, string>), string]> = [
    ["no snapshot id", { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "" }, "OGEVIA_PREDEPLOY_SNAPSHOT_ID"],
    ["an id that is not the release naming pattern", { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "my-snapshot" }, "OGEVIA_PREDEPLOY_SNAPSHOT_ID"],
    ["an id naming another instance", { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "some-other-instance-pre-0085-202610190312" }, "OGEVIA_PREDEPLOY_SNAPSHOT_ID"],
    ["the old unnamed variable only", { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "", OGEVIA_ROLLBACK_SNAPSHOT_ID: "ogevia-prod-postgres-pre-0085-202610190312" }, "OGEVIA_PREDEPLOY_SNAPSHOT_ID"],
    ["a snapshot that does not exist", { MOCK_SNAP_MISSING: "1" }, "cannot read snapshot"],
    ["a snapshot still being created", { MOCK_SNAP_STATUS: "creating" }, "not available"],
    ["a failed snapshot", { MOCK_SNAP_STATUS: "failed" }, "not available"],
    ["a snapshot of another instance", { MOCK_SNAP_INSTANCE: "some-other-instance" }, "belongs to 'some-other-instance'"],
    ["an automated snapshot", { MOCK_SNAP_TYPE: "automated" }, "not a manual pre-deployment snapshot"],
    ["a snapshot created before the release window", { MOCK_SNAP_AGE_MIN: "300" }, "outside the release window"],
    ["a snapshot created after the release window ended or in the future", { ...releaseWindow(-60, 20), MOCK_SNAP_AGE_MIN: "-30" }, "outside the release window"],
    ["a snapshot with an unreadable creation time", { MOCK_SNAP_CREATED: "None" }, "no readable creation time"],
    ["a name stamp that is outside the release window", () => ({ OGEVIA_PREDEPLOY_SNAPSHOT_ID: snapName(400) }), "time stamp in the snapshot name"],
    ["no release window", { OGEVIA_RELEASE_WINDOW_START: "", OGEVIA_RELEASE_WINDOW_END: "" }, "OGEVIA_RELEASE_WINDOW_START"],
    ["a malformed release window", { OGEVIA_RELEASE_WINDOW_START: "yesterday" }, "OGEVIA_RELEASE_WINDOW_START"],
    ["an impossible date in the window", { OGEVIA_RELEASE_WINDOW_START: "2026-13-45T25:61:61Z" }, "not a valid date"],
    ["a window that ends before it starts", () => { const w = releaseWindow(); return { OGEVIA_RELEASE_WINDOW_START: w.OGEVIA_RELEASE_WINDOW_END, OGEVIA_RELEASE_WINDOW_END: w.OGEVIA_RELEASE_WINDOW_START }; }, "must end after it starts"],
    ["a window longer than 12 hours", () => releaseWindow(-60, 800), "at most 12 hours"],
    ["a window that has not started", () => releaseWindow(30, 200, -20), "has not started"],
  ];
  for (const [mode, ledgerValue] of MODES) {
    it.each(REFUSALS)(`${mode}: refuses %s, opens no access and changes nothing`, async (_name, envOrFn, text) => {
      writeFileSync(join(f.dir, "ledger"), ledgerValue);
      const env = typeof envOrFn === "function" ? envOrFn() : envOrFn;
      const r = await start(mode, env);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(text);
      expect(r.out).toContain("No access window was opened and nothing was changed.");
      const v = verbs();
      expect(v).not.toContain("ec2 authorize-security-group-ingress");
      expect(v).not.toContain("ec2 revoke-security-group-ingress");
      expect(v).not.toContain("ssm start-session");
      expect(v).not.toContain("secretsmanager get-secret-value");
      expect(sg()).toEqual(INITIAL_SG);
      expect(marker()).toBe(false);
      expect(npxCalls()).toEqual([]);
      expect(existsSync(join(f.dir, "psql-calls.log"))).toBe(false);
      expect(existsSync(join(f.dir, "down-calls.log"))).toBe(false);
      expect(ledger()).toBe(ledgerValue);
    });
  }
  it("migrate is also refused after the release window has ended, even with a snapshot inside it; rollback may still run (recovery after the window)", async () => {
    const ended = { ...releaseWindow(-300, -60, 120) }; // window ended an hour ago; the snapshot was taken two hours ago, inside it
    writeFileSync(join(f.dir, "ledger"), "77|0077");
    const m = await start("migrate", ended);
    expect(m.code, m.out).toBe(1);
    expect(m.out).toContain("migrating outside it is refused");
    expect(verbs()).not.toContain("ec2 authorize-security-group-ingress");
    f = fixture(); writeFileSync(join(f.dir, "ledger"), "85|0085");
    const r = await start("rollback", ended);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("ledger after: 77 migrations applied, latest 0077");
  });
  it.each(MODES)("%s: a valid snapshot is validated first, reported, and described as a prerequisite only", async (mode, ledgerValue) => {
    writeFileSync(join(f.dir, "ledger"), ledgerValue);
    const r = await start(mode, {});
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/snapshot ogevia-prod-postgres-pre-0085-\d{12}: available, manual, belongs to ogevia-prod-postgres, created \S+ inside the release window/);
    expect(r.out).toContain("A recovery PREREQUISITE only: restoring from it is not a prepared procedure");
    expect(r.out.indexOf("snapshot ogevia-prod-postgres-pre-0085-")).toBeLessThan(r.out.indexOf("== 4. Window"));
    expect(verbs()).toContain("rds describe-db-snapshots");
    // the snapshot check happens before the rule is proposed or added
    expect(calls().findIndex((c) => c.startsWith("rds describe-db-snapshots"))).toBeLessThan(calls().findIndex((c) => c.startsWith("ec2 authorize-security-group-ingress")));
  });
  it("the script never restores a snapshot or creates one", () => {
    expect(code).not.toMatch(/restore-db-instance|create-db-snapshot|delete-db-snapshot|copy-db-snapshot|modify-db-snapshot/);
  });
});

describe("the AWS region and pager are fixed by the script itself, not inherited", () => {
  it("every AWS call sees us-west-2 and an empty pager even when the caller exports other values", async () => {
    writeFileSync(join(f.dir, "ledger"), "77|0077");
    const r = await run(["migrate"], { env: { AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "eu-west-1", AWS_PAGER: "less" } });
    expect(r.code, r.out).toBe(0);
    const seen = new Set(readFileSync(join(f.dir, "aws-env.log"), "utf8").split("\n").filter(Boolean));
    expect([...seen]).toEqual(["us-west-2|us-west-2|[]"]);
  });
  it("the script sets them literally from its own constant", () => {
    expect(code).toMatch(/^REGION=us-west-2$/m);
    expect(code).toMatch(/^export AWS_REGION=\$REGION AWS_DEFAULT_REGION=\$REGION AWS_PAGER=""$/m);
  });
});
