#!/usr/bin/env bash
# Shared, read-only helpers for the tarball-based PRODUCTION operator package of release 2026-10-26-redesign (sourced by tarball-pin-check.sh, apply-0086-prd.sh and record-deployed-prd.sh).
# The package root is the directory that holds BUILD_INFO.json and PACKAGE_MANIFEST.sha256; these scripts live at
# <root>/docs/releases/2026-10-26-redesign-prd-operator/scripts. There is no git in CloudShell: identity comes from BUILD_INFO.json and the manifest.
# Every function FAILS CLOSED: a command that cannot run, prints nothing or exits non-zero is a failure, never a pass.
TB_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TB_ROOT="$(cd "$TB_HERE/../../../.." && pwd)"
TB_INFRA="$TB_ROOT/infra/aws"
# Migrations 0001-0085 are what TEST (2026-10-19) and production (ledger 85 / 0085, read 2026-10-26) already hold: this set hash is the one the earlier
# release packages pinned, and no file in db/migrations changed since (git diff e80b770 7870a04 -- infra/aws/db/migrations is empty).
PKG_APPLIED_0085_SHA=de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef
# the pending migration (not part of db/migrations, not in the ledger): the two files this package applies to production and rolls back
PKG_PENDING_UP="$TB_INFRA/db/pending/migrations/0086_staff_management.sql"
PKG_PENDING_DOWN="$TB_INFRA/db/pending/rollback/0086_staff_management.down.sql"
# 0087 (staff invitation acceptance: M-1, L-1, L-2, L-3) is applied in the SAME transaction, straight after 0086, and rolled back first
PKG_PENDING_UP87="$TB_INFRA/db/pending/migrations/0087_staff_invitation_acceptance.sql"
PKG_PENDING_DOWN87="$TB_INFRA/db/pending/rollback/0087_staff_invitation_acceptance.down.sql"

# prints the code commit recorded in BUILD_INFO.json (40 hex) or nothing
pkg_code_commit() { jq -er '.code_commit' "$TB_ROOT/BUILD_INFO.json" 2>/dev/null | grep -E '^[0-9a-f]{40}$'; }

# 0 = every manifest line verified (and the manifest is non-empty); anything else = failure with the reason on stdout
pkg_manifest_ok() {
  local m="$TB_ROOT/PACKAGE_MANIFEST.sha256" out rc n
  [[ -s "$m" ]] || { echo "PACKAGE_MANIFEST.sha256 is missing or empty"; return 1; }
  n=$(wc -l < "$m") || { echo "cannot read the manifest"; return 1; }
  (( n > 0 )) || { echo "the manifest lists no file"; return 1; }
  out=$(cd "$TB_ROOT" && sha256sum -c --quiet "$m" 2>&1); rc=$?
  if (( rc != 0 )); then echo "sha256sum -c exited $rc: $(printf '%s' "$out" | head -3 | tr '\n' ';')"; return 1; fi
  [[ -z "$out" ]] || { echo "sha256sum -c printed unexpected output: $(printf '%s' "$out" | head -3 | tr '\n' ';')"; return 1; }
  echo "$n files"
}

# lists files under the package root that are NOT in the manifest (installed dependencies and build outputs are ignored). Empty output = none.
# Fails (non-zero) if the listing itself cannot be produced.
pkg_strays() {
  local m="$TB_ROOT/PACKAGE_MANIFEST.sha256" found known
  found=$(cd "$TB_ROOT" && find . -type f -not -path '*/node_modules/*' -not -path '*/dist-aws/*' -not -path '*/dist/*' -not -path '*/.turbo/*' -not -path '*/__pycache__/*' -not -name '*.tsbuildinfo' -print | sed 's|^\./||' | LC_ALL=C sort) || return 1
  [[ -n "$found" ]] || return 1
  known=$(sed 's/^[0-9a-f]\{64\}  //' "$m" | LC_ALL=C sort) || return 1
  LC_ALL=C comm -23 <(printf '%s\n' "$found") <(printf '%s\nPACKAGE_MANIFEST.sha256\n' "$known" | LC_ALL=C sort)
}

# the hash of the 0001-0085 migration set: sha256 of the sorted `sha256sum` lines of every file in db/migrations
pkg_migration_set_sha() { (cd "$TB_INFRA/db/migrations" && LC_ALL=C sha256sum -- *.sql | sha256sum | cut -d' ' -f1); }
pkg_migration_count() { (cd "$TB_INFRA/db/migrations" && ls -- *.sql | wc -l); }
pkg_pending_up_sha() { sha256sum "$PKG_PENDING_UP" 2>/dev/null | cut -d' ' -f1; }
pkg_pending_down_sha() { sha256sum "$PKG_PENDING_DOWN" 2>/dev/null | cut -d' ' -f1; }
pkg_pending_up87_sha() { sha256sum "$PKG_PENDING_UP87" 2>/dev/null | cut -d' ' -f1; }
pkg_pending_down87_sha() { sha256sum "$PKG_PENDING_DOWN87" 2>/dev/null | cut -d' ' -f1; }
# the only files allowed in db/pending (besides its README): exactly the four 0086 and 0087 files. Prints stray names, empty = none.
pkg_pending_strays() { (cd "$TB_INFRA/db/pending" && find . -type f ! -name README.md ! -path './migrations/0086_staff_management.sql' ! -path './rollback/0086_staff_management.down.sql' ! -path './migrations/0087_staff_invitation_acceptance.sql' ! -path './rollback/0087_staff_invitation_acceptance.down.sql' -print | sort); }
