#!/usr/bin/env bash
# =============================================================================
# Ogevia TEST release 2026-10-26-redesign (code 7870a04): READ-ONLY pin check for the uploaded operator tarball (no git, no AWS, writes nothing). Run it from the extracted package:
#   OGEVIA_EXPECT_COMMIT=<40-hex> OGEVIA_EXPECT_MIGRATIONS_SHA=<64-hex> OGEVIA_EXPECT_0086_SHA=<64-hex> OGEVIA_EXPECT_0086_DOWN_SHA=<64-hex> OGEVIA_EXPECT_LOCKFILE_SHA=<64-hex> bash tarball-pin-check.sh
# Checks (every failure exits non-zero; a check that cannot run is a failure, never a pass):
#   * BUILD_INFO.json names exactly the approved code commit;
#   * PACKAGE_MANIFEST.sha256 verifies for EVERY file and no file outside the manifest sits in the tree (dependencies and build output excepted);
#   * infra/aws/db/migrations holds exactly 85 files and hashes to the approved migration-set value, which is the set the owner applied to TEST on 2026-10-19 (so no applied
#     migration was edited) and has no 0086 in it; infra/aws/db/pending holds exactly the two 0086 files, whose hashes equal the approved values;
#   * pnpm-lock.yaml hashes to the approved value;
#   * Node 22.x, pnpm 9.15.4, CDK CLI 2.1143.0 (from the package's own node_modules), dependencies installed.
# The tarball's OWN sha256 cannot be checked here (it is a hash of the file this script came in): the procedure checks it with sha256sum -c BEFORE extracting.
# Exit: 0 = PINS HOLD; 1 = a pin does not hold; 2 = usage.
# =============================================================================
set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pkg-lib.sh"
bad=0
ok()   { echo "PASS $*"; }
nope() { echo "FAIL $*"; bad=1; }
[[ "${OGEVIA_EXPECT_COMMIT:-}" =~ ^[0-9a-f]{40}$ && "${OGEVIA_EXPECT_MIGRATIONS_SHA:-}" =~ ^[0-9a-f]{64}$ && "${OGEVIA_EXPECT_0086_SHA:-}" =~ ^[0-9a-f]{64}$ && "${OGEVIA_EXPECT_0086_DOWN_SHA:-}" =~ ^[0-9a-f]{64}$ && "${OGEVIA_EXPECT_0087_SHA:-}" =~ ^[0-9a-f]{64}$ && "${OGEVIA_EXPECT_0087_DOWN_SHA:-}" =~ ^[0-9a-f]{64}$ && "${OGEVIA_EXPECT_LOCKFILE_SHA:-}" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "usage: set OGEVIA_EXPECT_COMMIT (40 hex), OGEVIA_EXPECT_MIGRATIONS_SHA, OGEVIA_EXPECT_0086_SHA, OGEVIA_EXPECT_0086_DOWN_SHA, OGEVIA_EXPECT_0087_SHA, OGEVIA_EXPECT_0087_DOWN_SHA and OGEVIA_EXPECT_LOCKFILE_SHA (64 hex) from the procedure" >&2; exit 2; }
BI=$(pkg_code_commit) || BI=""
[[ -n "$BI" && "$BI" == "$OGEVIA_EXPECT_COMMIT" ]] && ok "BUILD_INFO code commit $BI" || nope "BUILD_INFO.json code commit is '${BI:-unreadable}', not the approved $OGEVIA_EXPECT_COMMIT"
REF=$(jq -r '.approval_ref // empty' "$PKG_ROOT/BUILD_INFO.json" 2>/dev/null)
if [[ -z "$REF" ]]; then nope "BUILD_INFO.json has no approval_ref"
elif [[ "$REF" == APPROVAL-REF-PENDING-OWNER ]]; then echo "NOTE BUILD_INFO approval_ref is the placeholder; the approval reference exported from the GO message is used"
elif [[ -n "${OGEVIA_DEPLOY_APPROVAL:-}" && "$REF" != "$OGEVIA_DEPLOY_APPROVAL" ]]; then nope "BUILD_INFO approval_ref '$REF' differs from OGEVIA_DEPLOY_APPROVAL '$OGEVIA_DEPLOY_APPROVAL'"
else ok "BUILD_INFO approval_ref $REF"; fi
if MSG=$(pkg_manifest_ok); then ok "PACKAGE_MANIFEST verifies: $MSG"; else nope "package manifest: $MSG"; fi
if STR=$(pkg_strays); then [[ -z "$STR" ]] && ok "no file outside the manifest" || nope "files not in the manifest: $(head -3 <<<"$STR" | tr '\n' ';')"; else nope "cannot list the package files"; fi
MIG=$(pkg_migration_set_sha 2>/dev/null) || MIG=""
[[ -n "$MIG" && "$MIG" == "$OGEVIA_EXPECT_MIGRATIONS_SHA" ]] && ok "migration set (0001-0085) sha256 ${MIG:0:16}..." || nope "db/migrations hashes to '${MIG:-nothing}', not the approved value"
[[ -n "$MIG" && "$MIG" == "$PKG_APPLIED_0085_SHA" ]] && ok "migrations 0001-0085 equal the set applied to TEST on 2026-10-19 (${MIG:0:16}...): no applied migration was edited" || nope "migrations 0001-0085 hash to '${MIG:-nothing}', not the set applied to TEST ($PKG_APPLIED_0085_SHA): an applied migration was edited or added"
CNT=$(pkg_migration_count 2>/dev/null) || CNT=""
[[ "$CNT" == 85 && ! -e "$PKG_INFRA/db/migrations/0086_staff_management.sql" ]] && ok "db/migrations holds exactly the 85 released files and no 0086" || nope "db/migrations holds '${CNT:-?}' files or contains 0086: this package applies 0086 from db/pending only"
UP=$(pkg_pending_up_sha); DOWN=$(pkg_pending_down_sha)
[[ -n "$UP" && "$UP" == "$OGEVIA_EXPECT_0086_SHA" ]] && ok "0086 up file sha256 ${UP:0:16}..." || nope "db/pending/migrations/0086_staff_management.sql hashes to '${UP:-nothing}', not the approved value"
[[ -n "$DOWN" && "$DOWN" == "$OGEVIA_EXPECT_0086_DOWN_SHA" ]] && ok "0086 down file sha256 ${DOWN:0:16}..." || nope "db/pending/rollback/0086_staff_management.down.sql hashes to '${DOWN:-nothing}', not the approved value"
UP7=$(pkg_pending_up87_sha); DOWN7=$(pkg_pending_down87_sha)
[[ -n "$UP7" && "$UP7" == "$OGEVIA_EXPECT_0087_SHA" ]] && ok "0087 up file sha256 ${UP7:0:16}..." || nope "db/pending/migrations/0087_staff_invitation_acceptance.sql hashes to '${UP7:-nothing}', not the approved value"
[[ -n "$DOWN7" && "$DOWN7" == "$OGEVIA_EXPECT_0087_DOWN_SHA" ]] && ok "0087 down file sha256 ${DOWN7:0:16}..." || nope "db/pending/rollback/0087_staff_invitation_acceptance.down.sql hashes to '${DOWN7:-nothing}', not the approved value"
if PS=$(pkg_pending_strays); then [[ -z "$PS" ]] && ok "db/pending holds only the four 0086 and 0087 files" || nope "db/pending holds other files: $(head -3 <<<"$PS" | tr '\n' ';')"; else nope "cannot list db/pending"; fi
LOCK=$(sha256sum "$PKG_ROOT/pnpm-lock.yaml" 2>/dev/null | cut -d' ' -f1) || LOCK=""
[[ -n "$LOCK" && "$LOCK" == "$OGEVIA_EXPECT_LOCKFILE_SHA" ]] && ok "pnpm-lock.yaml sha256 ${LOCK:0:16}..." || nope "pnpm-lock.yaml hashes to '${LOCK:-nothing}', not the approved value"
NODE_V=$(node --version 2>/dev/null || echo none)
[[ "$NODE_V" == v22.* ]] && ok "node $NODE_V" || nope "node is $NODE_V; the approved toolchain is Node 22.x (install it yourself; this script installs nothing)"
PNPM_V=$(pnpm --version 2>/dev/null || echo none)
[[ "$PNPM_V" == 9.15.4 ]] && ok "pnpm $PNPM_V" || nope "pnpm is $PNPM_V, not 9.15.4"
[[ -d "$PKG_INFRA/node_modules" && -d "$PKG_ROOT/node_modules" ]] && ok "dependencies installed" || nope "dependencies are not installed: run 'pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store' in $PKG_ROOT"
CDK_V=$(cd "$PKG_INFRA" && timeout 60 npx --no-install cdk --version 2>/dev/null | head -1)
[[ "$CDK_V" == 2.1143.0* ]] && ok "cdk $CDK_V" || nope "the package's CDK CLI reports '${CDK_V:-nothing}', not 2.1143.0"
if [[ $bad == 0 ]]; then echo "PINS HOLD"; exit 0; else echo "STOP: a pin does not hold. Nothing was changed."; exit 1; fi
