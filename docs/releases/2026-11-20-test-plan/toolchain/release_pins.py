#!/usr/bin/env python3
"""Pins for the TEST release of PR #113 (request cleanup + go-live items). Replaces the old, hard-coded constants in the earlier TEST operator scripts for this release.
Local and read-only (git and file hashes only). No AWS.

  python3 release_pins.py generate --app-commit <sha> [--out PINS_0109.json]    write the pins for that application commit from the current checkout
  python3 release_pins.py check [--pins PINS_0109.json]                          verify the current checkout against the pins; exit 0 only if everything matches

What is pinned: the application commit (full SHA); that no application path changed between that commit and the checked-out one (so a later docs-only commit, which is where
this toolchain lives, is allowed; test files, which are never deployed, are not counted); the sha256 of the lockfile, each migration set and 0109 and its rollback; the sha256 of every file in this toolchain; the route counts
(switch OFF and ON) derived from the stack source. The Handler code asset hash is NOT pinned here: it is produced by the operator's own `cdk synth` in CloudShell and is
checked by diff_gate_0109.py against the live template.
"""
import argparse, hashlib, json, pathlib, re, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = pathlib.Path(subprocess.run(["git", "-C", str(HERE), "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip())
APP_PATHS = ["apps", "packages", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "infra/aws/lib", "infra/aws/bin", "infra/aws/package.json", "infra/aws/db/migrations", "infra/aws/db/pending", "infra/aws/db/scripts"]
# Test files are not part of what is deployed (the Lambda bundle and the web bundle never include them), so a change to one is not an application change. Nothing else is excluded.
APP_EXCLUDES = [":(glob,exclude)**/*.test.ts", ":(glob,exclude)**/*.test.tsx"]
TOOLCHAIN = ["TEST_0109_LEDGER.sh", "TEST_DB_SESSION.sh", "TEST_H2A_COMPARE.sh", "TEST_H2B_DEPLOY.sh", "TEST_H2C_ENABLE.sh", "PRD_0109_RELEASE.sh", "../../../../infra/aws/scripts/production-web-release.sh", "../../../../infra/aws/scripts/production-request-cleanup-routes-release.py", "../../../../infra/aws/scripts/production-request-cleanup-routes-deploy.sh", "../../../../infra/aws/scripts/production-0109-release.py", "VERIFY_0109.sql", "diff_gate_0109.py", "TEST_INVENTORY.sh", "check_inventory.py", "../TEST-requestCleanup-on.patch",
             "../../2026-11-10-ux-redesign-test/toolchain/OPERATOR_TEST_DB.sh"]   # the earlier release's isolated-verify and isolated-backup modes are reused as they are
TOOLCHAIN_0110 = ["TEST_0110_LEDGER.sh", "TEST_H3_OFFICES.sh", "TEST_WEB_FIX.sh", "VERIFY_0110.sql", "diff_gate_0110.py", "TEST_DB_SESSION.sh", "release_pins.py"]   # the Offices (0110) TEST release's own tool set (it no longer reuses the earlier release's OPERATOR_TEST_DB.sh, which hard-codes ledger 107/0107); PINS_0109.json keeps covering the earlier release
TEST_FEATURES_ON = {"staffManagement", "signInOverride", "bulkImport", "liveTestRepairs"}      # isolated TEST: infra/aws/lib/config.ts (+ liveTestRepairs from resolveTestDatabase); staffDuplicates is false


def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def set_sha(paths):
    """sha256 of the sorted `sha256sum`-style lines, so it matches `LC_ALL=C sha256sum -- *.sql | sha256sum` run inside the directory."""
    lines = sorted(f"{sha(p)}  {p.name}\n" for p in paths)
    return hashlib.sha256("".join(lines).encode()).hexdigest()


def git(*args):
    return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True)


def route_counts():
    src = (REPO / "infra/aws/lib/service-verification-api-stack.ts").read_text()
    routes = re.findall(r'\{ method: apigw\.HttpMethod\.\w+, path: "[^"]+"(?:, feature: "(\w+)")?', src)
    off = sum(1 for f in routes if not f or f in TEST_FEATURES_ON)
    on = off + sum(1 for f in routes if f == "requestCleanup")
    return {"switchOff": off, "switchOn": on}


def office_routes():
    src = (REPO / "infra/aws/lib/service-verification-api-stack.ts").read_text()
    return len(re.findall(r'\{ method: apigw\.HttpMethod\.\w+, path: "[^"]+", feature: "offices"', src))


def compute(app_commit, release="0109"):
    mig = REPO / "infra/aws/db/migrations"; pend = REPO / "infra/aws/db/pending"
    full = git("rev-parse", "--verify", app_commit + "^{commit}").stdout.strip()
    if release == "0110":
        return {
            "release": "0110",
            "applicationCommit": full,
            "pnpmLockSha256": sha(REPO / "pnpm-lock.yaml"),
            "releasedMigrations": {"count": len(list(mig.glob("*.sql"))), "setSha256": set_sha(sorted(mig.glob("*.sql")))},
            "pendingUx0103to0107": {"count": 5, "setSha256": set_sha(sorted(pend.glob("migrations/010[3-7]_*.sql")))},
            "migration0109": {"upSha256": sha(pend / "migrations/0109_request_cleanup.sql"), "downSha256": sha(pend / "rollback/0109_request_cleanup.down.sql")},
            "migration0110": {"upSha256": sha(pend / "migrations/0110_offices.sql"), "downSha256": sha(pend / "rollback/0110_offices.down.sql")},
            "toolchainSha256": {n.replace("../", ""): sha(HERE / n) for n in TOOLCHAIN_0110},
            "apiRoutes": {**route_counts(), "officesRoutes": office_routes()},
            "expectedLedger": {"before": "108/0109", "after": "109/0110"},
        }
    return {
        "applicationCommit": full,
        "pnpmLockSha256": sha(REPO / "pnpm-lock.yaml"),
        "releasedMigrations": {"count": len(list(mig.glob("*.sql"))), "setSha256": set_sha(sorted(mig.glob("*.sql")))},
        "pendingUx0103to0107": {"count": 5, "setSha256": set_sha(sorted(pend.glob("migrations/010[3-7]_*.sql")))},
        "migration0109": {"upSha256": sha(pend / "migrations/0109_request_cleanup.sql"), "downSha256": sha(pend / "rollback/0109_request_cleanup.down.sql")},
        "toolchainSha256": {n.replace("../", ""): sha(HERE / n) for n in TOOLCHAIN},
        "apiRoutes": route_counts(),
        "expectedLedger": {"before": "107/0107", "after": "108/0109"},
    }


def check(pins_path, allow_dirty=False):
    pins = json.loads(pathlib.Path(pins_path).read_text())
    bad = []
    commit = pins["applicationCommit"]
    if git("cat-file", "-e", commit + "^{commit}").returncode != 0:
        return [f"application commit {commit[:12]} is not in this checkout (fetch it)"]
    if git("merge-base", "--is-ancestor", commit, "HEAD").returncode != 0:
        bad.append(f"HEAD does not contain the pinned application commit {commit[:12]}")
    else:
        diff = git("diff", "--name-only", commit, "HEAD", "--", *APP_PATHS, *APP_EXCLUDES).stdout.split()
        if diff:
            bad.append(f"application files changed since the pinned commit {commit[:12]}: {', '.join(diff[:5])}{' ...' if len(diff) > 5 else ''}")
    now = compute(commit, pins.get("release", "0109"))
    for key in ("pnpmLockSha256", "releasedMigrations", "pendingUx0103to0107", "migration0109", "toolchainSha256", "apiRoutes", "expectedLedger") + (("migration0110",) if "migration0110" in pins else ()):
        if now[key] != pins[key]:
            bad.append(f"{key} differs from the pins")
    if not allow_dirty and git("status", "--porcelain", "--", *APP_PATHS, str(HERE.relative_to(REPO))).stdout.strip():
        bad.append("uncommitted changes in application or toolchain paths")
    return bad


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate"); g.add_argument("--app-commit", required=True); g.add_argument("--out", default=None); g.add_argument("--release", default="0109", choices=["0109", "0110"])
    c = sub.add_parser("check"); c.add_argument("--pins", default=str(HERE / "PINS_0109.json")); c.add_argument("--allow-dirty", action="store_true", help="for development only; the operator never uses it")
    a = ap.parse_args()
    if a.cmd == "generate":
        out = a.out or str(HERE / ("PINS_0110.json" if a.release == "0110" else "PINS_0109.json"))
        pathlib.Path(out).write_text(json.dumps(compute(a.app_commit, a.release), indent=2, sort_keys=True) + "\n")
        print("wrote", out)
        return 0
    bad = check(a.pins, a.allow_dirty)
    for b in bad:
        print("FAIL", b)
    print("PINS OK: the checkout matches the pins" if not bad else "STOP: the checkout does not match the pins")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
