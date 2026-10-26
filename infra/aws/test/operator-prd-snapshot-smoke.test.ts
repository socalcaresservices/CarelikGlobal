// snapshot-verify-prd.sh and route-smoke-prd.sh (PRODUCTION release 2026-10-26-redesign). Fake aws and curl; no AWS, no network, synthetic.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_KEYS, SCRIPTS_SRC } from "./operator-prd-fixtures.js";

vi.setConfig({ testTimeout: 60000 });
const PRD_API = "https://zk527zk4ua.execute-api.us-west-2.amazonaws.com";
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
const stamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
const minutes = (m: number) => new Date(Date.now() + m * 60000);
const AWS = `#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/aws-calls.log"
case "$1 $2" in
  "rds create-db-snapshot") [[ -n "\${MOCK_CREATE_FAIL:-}" ]] && exit 254; echo creating ;;
  "rds wait") [[ -n "\${MOCK_WAIT_FAIL:-}" ]] && exit 255; exit 0 ;;
  "rds describe-db-snapshots")
    [[ -n "\${MOCK_SNAP_MISSING:-}" ]] && { echo "An error occurred (DBSnapshotNotFound)" >&2; exit 254; }
    created=$(date -u -d "@$(( $(date +%s) - \${MOCK_SNAP_AGE_MIN:-10} * 60 ))" +%Y-%m-%dT%H:%M:%S.123000+00:00)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${MOCK_SNAP_STATUS:-available}" "\${MOCK_SNAP_INSTANCE:-ogevia-prod-postgres}" "\${MOCK_SNAP_TYPE:-manual}" "\${MOCK_SNAP_CREATED:-$created}" "\${MOCK_SNAP_ENC:-True}" ;;
  *) echo "mock aws: unexpected call: $*" >&2; echo "UNEXPECTED $*" >> "$D/aws-calls.log"; exit 99 ;;
esac
`;
const CURL = `#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/curl-calls.log"
method=GET; url=""; wcode=""; dump=""; origin=""
while (( $# )); do case "$1" in -X) method="$2"; shift 2 ;; -w) wcode=1; shift 2 ;; -D) dump=1; shift 2 ;; -H) case "$2" in Origin:*) origin="\${2#Origin: }" ;; esac; shift 2 ;; -o|--data|--max-time) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
[[ -n "\${MOCK_CURL_FAIL:-}" ]] && exit 7
if [[ "$method" == OPTIONS ]]; then
  [[ -n "$dump" ]] && { if [[ -n "\${MOCK_CORS_BAD:-}" && "$origin" == "\${MOCK_CORS_BAD}" ]]; then printf 'HTTP/2 204\\r\\n\\r\\n'; else printf 'HTTP/2 204\\r\\naccess-control-allow-origin: %s\\r\\n\\r\\n' "$origin"; fi; }
  exit 0
fi
code=401; [[ -n "\${MOCK_BAD_PATH:-}" && "$url" == *"\${MOCK_BAD_PATH}"* ]] && code=200
[[ -n "$wcode" ]] && printf '%s' "$code"
`;
let dir: string, bin: string, before: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "snapsmoke-")); bin = join(dir, "bin"); before = join(dir, "before"); mkdirSync(bin); mkdirSync(before);
  for (const [n, body] of [["aws", AWS], ["curl", CURL]] as const) { writeFileSync(join(bin, n), body); chmodSync(join(bin, n), 0o755); }
});
function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [join(SCRIPTS_SRC, script), ...args], { encoding: "utf8", input: "", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_DIR: dir, HOME: dir, OGEVIA_PRD_BEFORE: before, ...env } });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
const lines = (n: string) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), "utf8").split("\n").filter(Boolean) : []);
const verbs = () => lines("aws-calls.log").map((c) => c.split(" ").slice(0, 2).join(" "));

describe("snapshot-verify-prd.sh: a snapshot that is not verified stops the release", () => {
  const win = (s = -60, e = 180) => ({ OGEVIA_RELEASE_WINDOW_START: iso(minutes(s)), OGEVIA_RELEASE_WINDOW_END: iso(minutes(e)) });
  const name = (ago = 10) => `ogevia-prod-postgres-pre-0086-prd-${stamp(minutes(-ago))}`;
  it("create: takes ONE snapshot named for production, waits, verifies, records the id", () => {
    const r = run("snapshot-verify-prd.sh", ["create"], { ...win() });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("SNAPSHOT VERIFIED");
    expect(verbs().filter((v) => v === "rds create-db-snapshot")).toHaveLength(1);
    expect(readFileSync(join(before, "snapshot-id.txt"), "utf8").trim()).toMatch(/^ogevia-prod-postgres-pre-0086-prd-\d{12}$/);
    expect(lines("aws-calls.log").join("\n")).toContain("--db-instance-identifier ogevia-prod-postgres");
  });
  it("create refuses outside the window and creates nothing; a snapshot that never becomes available or cannot be created stops", () => {
    let r = run("snapshot-verify-prd.sh", ["create"], { ...win(30, 240) }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("outside the release window"); expect(verbs()).not.toContain("rds create-db-snapshot");
    r = run("snapshot-verify-prd.sh", ["create"], { ...win(), MOCK_WAIT_FAIL: "1" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("did not become available");
    r = run("snapshot-verify-prd.sh", ["create"], { ...win(), MOCK_CREATE_FAIL: "1" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("create-db-snapshot failed");
  });
  it("verify: passes for a good snapshot (id from the variable or the recorded file) and is read-only", () => {
    let r = run("snapshot-verify-prd.sh", ["verify"], { ...win(), OGEVIA_PREDEPLOY_SNAPSHOT_ID: name() }); expect(r.code, r.out).toBe(0); expect(r.out).toContain("SNAPSHOT VERIFIED");
    writeFileSync(join(before, "snapshot-id.txt"), name() + "\n"); r = run("snapshot-verify-prd.sh", ["verify"], { ...win() }); expect(r.code, r.out).toBe(0);
    expect(verbs()).not.toContain("rds create-db-snapshot");
  });
  it.each([
    ["the TEST snapshot name pattern (pre-0086-YYYYMMDDHHMM)", { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-0086-202610260451" }, "does not match"],
    ["the earlier release's pattern", { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-prdrelease-202610210100" }, "does not match"],
    ["a missing snapshot", { MOCK_SNAP_MISSING: "1" }, "cannot read snapshot"],
    ["a snapshot still creating", { MOCK_SNAP_STATUS: "creating" }, "not available"],
    ["another instance", { MOCK_SNAP_INSTANCE: "other" }, "belongs to"],
    ["an automated snapshot", { MOCK_SNAP_TYPE: "automated" }, "not manual"],
    ["an unencrypted snapshot", { MOCK_SNAP_ENC: "False" }, "not encrypted"],
    ["a snapshot created before the window", { MOCK_SNAP_CREATED: "2020-01-01T00:00:00.000000+00:00" }, "outside the release window"],
  ])("verify stops on %s", (_n, env, text) => {
    const r = run("snapshot-verify-prd.sh", ["verify"], { ...win(), OGEVIA_PREDEPLOY_SNAPSHOT_ID: name(), ...(env as Record<string, string>) });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain(text); expect(r.out).not.toContain("SNAPSHOT VERIFIED");
  });
  it("usage and window validation", () => {
    expect(run("snapshot-verify-prd.sh", []).code).toBe(2); expect(run("snapshot-verify-prd.sh", ["restore"]).code).toBe(2);
    let r = run("snapshot-verify-prd.sh", ["verify"], { OGEVIA_PREDEPLOY_SNAPSHOT_ID: name() }); expect(r.code).toBe(1); expect(r.out).toContain("OGEVIA_RELEASE_WINDOW_START");
    r = run("snapshot-verify-prd.sh", ["verify"], { ...win(-60, 800), OGEVIA_PREDEPLOY_SNAPSHOT_ID: name() }); expect(r.code).toBe(1); expect(r.out).toContain("at most 12 hours");
  });
});

describe("route-smoke-prd.sh: the 13 staff routes refuse every call without a valid token (production API only)", () => {
  it("passes: 13 routes x 2 calls (no token, forged token), all 401, plus the CORS preflight from app. and admin.; no credential is sent", () => {
    const r = run("route-smoke-prd.sh", [PRD_API]);
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("ROUTE SMOKE PASSED: 13 routes x 2 calls, all 401; CORS preflight ok for app. and admin.");
    expect(r.out).toContain("PASS CORS preflight from https://app.ogevia.com"); expect(r.out).toContain("PASS CORS preflight from https://admin.ogevia.com");
    const calls = lines("curl-calls.log"); expect(calls.length).toBe(28);
    for (const c of calls) expect(c).not.toMatch(/-X (PUT|DELETE|PATCH)/);
    for (const k of NEW_KEYS) expect(r.out).toContain(`PASS ${k} (none token): 401`);
  });
  it("a route that answers anything but 401, a curl failure and a CORS preflight that refuses either origin each fail", () => {
    let r = run("route-smoke-prd.sh", [PRD_API], { MOCK_BAD_PATH: "/v1/staff-audit" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("FAIL GET /v1/staff-audit"); expect(r.out).toContain("HTTP 200, expected 401");
    r = run("route-smoke-prd.sh", [PRD_API], { MOCK_CURL_FAIL: "1" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("curl-failed");
    r = run("route-smoke-prd.sh", [PRD_API], { MOCK_CORS_BAD: "https://admin.ogevia.com" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("FAIL CORS preflight from https://admin.ogevia.com");
    r = run("route-smoke-prd.sh", [PRD_API], { MOCK_CORS_BAD: "https://app.ogevia.com" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("FAIL CORS preflight from https://app.ogevia.com");
  });
  it("refuses the TEST API, any other API, a non-API URL and a missing argument without making a call", () => {
    for (const u of ["https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com", "https://abcdef1234.execute-api.us-west-2.amazonaws.com", "https://example.com"]) { const r = run("route-smoke-prd.sh", [u]); expect(r.code, r.out).toBe(2); expect(lines("curl-calls.log")).toEqual([]); }
    expect(run("route-smoke-prd.sh", []).code).toBe(2);
  });
  it("uses the captured API url by default, and refuses a captured TEST url", () => {
    writeFileSync(join(before, "api-url-before.txt"), PRD_API + "\n"); expect(run("route-smoke-prd.sh", []).code).toBe(0);
    writeFileSync(join(before, "api-url-before.txt"), "https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com\n"); expect(run("route-smoke-prd.sh", []).code).toBe(2);
  });
});
