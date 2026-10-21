#!/usr/bin/env bash
# Shared, read-only helpers for the tarball-based operator package (sourced by tarball-pin-check.sh and rehearsal-migrate-test.sh).
# The package root is the directory that holds BUILD_INFO.json and PACKAGE_MANIFEST.sha256; these scripts live at
# <root>/docs/releases/2026-10-19-test-rehearsal/scripts. There is no git in CloudShell: identity comes from BUILD_INFO.json and the manifest.
# Every function FAILS CLOSED: a command that cannot run, prints nothing or exits non-zero is a failure, never a pass.
PKG_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$PKG_HERE/../../../.." && pwd)"
PKG_INFRA="$PKG_ROOT/infra/aws"
# the 0001-0077 migration files are exactly what the owner applied to TEST on 2026-10-18 (set hash recorded in the earlier operator procedure)
PKG_APPLIED_0077_SHA=90785eaa779a0be2fc46aa7c251294c102b83d0d240b693ea9fb0d5fffc9a335

# prints the code commit recorded in BUILD_INFO.json (40 hex) or nothing
pkg_code_commit() { jq -er '.code_commit' "$PKG_ROOT/BUILD_INFO.json" 2>/dev/null | grep -E '^[0-9a-f]{40}$'; }

# 0 = every manifest line verified (and the manifest is non-empty); anything else = failure with the reason on stdout
pkg_manifest_ok() {
  local m="$PKG_ROOT/PACKAGE_MANIFEST.sha256" out rc n
  [[ -s "$m" ]] || { echo "PACKAGE_MANIFEST.sha256 is missing or empty"; return 1; }
  n=$(wc -l < "$m") || { echo "cannot read the manifest"; return 1; }
  (( n > 0 )) || { echo "the manifest lists no file"; return 1; }
  out=$(cd "$PKG_ROOT" && sha256sum -c --quiet "$m" 2>&1); rc=$?
  if (( rc != 0 )); then echo "sha256sum -c exited $rc: $(printf '%s' "$out" | head -3 | tr '\n' ';')"; return 1; fi
  [[ -z "$out" ]] || { echo "sha256sum -c printed unexpected output: $(printf '%s' "$out" | head -3 | tr '\n' ';')"; return 1; }
  echo "$n files"
}

# lists files under the package root that are NOT in the manifest (installed dependencies and build outputs are ignored). Empty output = none.
# Fails (non-zero) if the listing itself cannot be produced.
pkg_strays() {
  local m="$PKG_ROOT/PACKAGE_MANIFEST.sha256" found known
  found=$(cd "$PKG_ROOT" && find . -type f -not -path '*/node_modules/*' -not -path '*/dist-aws/*' -not -path '*/dist/*' -not -path '*/.turbo/*' -not -path '*/__pycache__/*' -not -name '*.tsbuildinfo' -print | sed 's|^\./||' | LC_ALL=C sort) || return 1
  [[ -n "$found" ]] || return 1
  known=$(sed 's/^[0-9a-f]\{64\}  //' "$m" | LC_ALL=C sort) || return 1
  LC_ALL=C comm -23 <(printf '%s\n' "$found") <(printf '%s\nPACKAGE_MANIFEST.sha256\n' "$known" | LC_ALL=C sort)
}

pkg_migration_set_sha() { (cd "$PKG_INFRA/db/migrations" && LC_ALL=C sha256sum -- *.sql | sha256sum | cut -d' ' -f1); }
pkg_migration_first77_sha() { (cd "$PKG_INFRA/db/migrations" && LC_ALL=C sha256sum -- $(ls *.sql | LC_ALL=C sort | head -77) | sha256sum | cut -d' ' -f1); }
pkg_rollback_set_sha() { (cd "$PKG_INFRA/db/rollback" && LC_ALL=C sha256sum -- 00[7-8][0-9]_*.down.sql | awk '$2 >= "0078"' | sha256sum | cut -d' ' -f1); }
