#!/usr/bin/env bash
# =============================================================================
# Ogevia release candidate: READ-ONLY pin check. Run it IMMEDIATELY BEFORE every step that builds or deploys from this checkout, in the same command line:
#   OGEVIA_EXPECT_COMMIT=<40-hex> OGEVIA_EXPECT_MIGRATIONS_SHA=<64-hex> OGEVIA_EXPECT_LOCKFILE_SHA=<64-hex> bash candidate-pin-check.sh && <the step>
# It changes nothing, calls no AWS service and checks out nothing: it only proves that what is on disk is the approved candidate and the approved toolchain.
#   * HEAD equals the approved commit and the working tree is clean (no stray or modified file, including the tracked infra/aws/cdk.out folder);
#   * every path listed in candidate-pins.txt (the application, packages, infrastructure code, migrations, rollbacks, deploy scripts and lockfile) has EXACTLY the git object id it
#     had in the CI-tested release candidate 3159e520a7b9bc7006ee82d526a907622d30d97c, so the operator commit differs from the candidate only by added tooling, tests and documents;
#   * db/migrations hashes to the approved migration-set checksum; pnpm-lock.yaml hashes to the approved lockfile checksum;
#   * Node is 22.x and pnpm is 9.15.4 (the versions the tests and CI ran on); the CDK CLI of the checkout is 2.1143.0;
#   * dependencies are installed.
# Exit 0 = PINS HOLD; 1 = a pin does not hold; 2 = usage.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA="$(cd "$HERE/.." && pwd)"
REPO="$(git -C "$INFRA" rev-parse --show-toplevel 2>/dev/null)" || { echo "FAIL: not inside a git clone"; exit 1; }
bad=0
ok()   { echo "PASS $*"; }
nope() { echo "FAIL $*"; bad=1; }
[[ "${OGEVIA_EXPECT_COMMIT:-}" =~ ^[0-9a-f]{40}$ && "${OGEVIA_EXPECT_MIGRATIONS_SHA:-}" =~ ^[0-9a-f]{64}$ && "${OGEVIA_EXPECT_LOCKFILE_SHA:-}" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "usage: set OGEVIA_EXPECT_COMMIT (40 hex), OGEVIA_EXPECT_MIGRATIONS_SHA and OGEVIA_EXPECT_LOCKFILE_SHA (64 hex) from the procedure" >&2; exit 2; }
HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)
[[ "$HEAD_SHA" == "$OGEVIA_EXPECT_COMMIT" ]] && ok "commit $HEAD_SHA" || nope "the checkout is at $HEAD_SHA, not the approved $OGEVIA_EXPECT_COMMIT"
DIRTY=$(git -C "$REPO" status --porcelain)
[[ -z "$DIRTY" ]] && ok "working tree clean" || nope "the working tree has changes: $(head -3 <<<"$DIRTY" | tr '\n' ';')"
MIG=$(cd "$INFRA/db/migrations" && LC_ALL=C sha256sum -- *.sql | sha256sum | cut -d' ' -f1)
[[ "$MIG" == "$OGEVIA_EXPECT_MIGRATIONS_SHA" ]] && ok "migration set sha256 ${MIG:0:16}..." || nope "db/migrations hashes to $MIG, not the approved value"
LOCK=$(sha256sum "$REPO/pnpm-lock.yaml" | cut -d' ' -f1)
[[ "$LOCK" == "$OGEVIA_EXPECT_LOCKFILE_SHA" ]] && ok "pnpm-lock.yaml sha256 ${LOCK:0:16}..." || nope "pnpm-lock.yaml hashes to $LOCK, not the approved value"
PINS="$HERE/candidate-pins.txt"
if [[ -s "$PINS" ]]; then
  n=0; wrong=0
  while read -r oid path; do
    [[ -n "$oid" ]] || continue
    n=$((n + 1)); live=$(git -C "$REPO" rev-parse "HEAD:$path" 2>/dev/null || echo missing)
    [[ "$live" == "$oid" ]] || { nope "$path is $live, the candidate has $oid"; wrong=1; }
  done < "$PINS"
  [[ $wrong == 0 ]] && ok "$n content pins equal the CI-tested candidate (application, packages, infrastructure, migrations, rollbacks, deploy scripts, lockfile)"
else
  nope "candidate-pins.txt is missing or empty"
fi
NODE_V=$(node --version 2>/dev/null || echo none)
[[ "$NODE_V" == v22.* ]] && ok "node $NODE_V" || nope "node is $NODE_V; the approved toolchain is Node 22.x (install it yourself; this script installs nothing)"
PNPM_V=$(pnpm --version 2>/dev/null || echo none)
[[ "$PNPM_V" == 9.15.4 ]] && ok "pnpm $PNPM_V" || nope "pnpm is $PNPM_V, not 9.15.4"
[[ -d "$INFRA/node_modules" && -d "$REPO/node_modules" ]] && ok "dependencies installed" || nope "dependencies are not installed: run 'pnpm install --frozen-lockfile' in $REPO"
CDK_V=$(cd "$INFRA" && timeout 60 npx --no-install cdk --version 2>/dev/null | head -1)
[[ "$CDK_V" == 2.1143.0* ]] && ok "cdk $CDK_V" || nope "the checkout's CDK CLI reports '${CDK_V:-nothing}', not 2.1143.0"
if [[ $bad == 0 ]]; then echo "PINS HOLD"; exit 0; else echo "STOP: a pin does not hold. Nothing was changed."; exit 1; fi
