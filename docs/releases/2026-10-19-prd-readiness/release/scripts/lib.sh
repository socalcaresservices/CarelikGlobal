#!/usr/bin/env bash
# Shared helpers for the PRODUCTION RELEASE package, stage A (discovery). Sourced; never run directly. READ-ONLY: every AWS verb used is a describe/get/list/head call, plus an
# S3 download of the production web bucket and curl GETs of the production web origin. Nothing is created, changed or deleted. Output: files, versions, hashes and counts; no secret values.
set -uo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
ACCOUNT=300094796789
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$LIB_DIR/.." && pwd)"
B="${OGEVIA_PRD_BEFORE:-$HOME/ogevia-prd-before}"
mkdir -p "$B" && chmod 700 "$B"
LOG="$B/log.txt"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-90}" aws "$@"; }
say() { printf '%s\n' "$*" | tee -a "$LOG"; }
bad=0
ok() { say "PASS $*"; }
nope() { say "FAIL $*"; bad=1; }
info() { say "INFO $*"; }
stop() { say "STOP: $*"; exit 1; }
need() { local t; for t in "$@"; do command -v "$t" >/dev/null 2>&1 || stop "missing tool: $t"; done; }
check_account() {
  local who; who=$(A sts get-caller-identity --output json 2>/dev/null) || stop "no valid AWS credentials: sign in again and reopen CloudShell in us-west-2"
  [[ "$(jq -r .Account <<<"$who")" == "$ACCOUNT" ]] || stop "wrong AWS account $(jq -r .Account <<<"$who") (expected $ACCOUNT)"
  say "account $ACCOUNT, region us-west-2: OK"
}
# The extracted TEST operator package (the code at the approved commit) must equal its PACKAGE_MANIFEST.sha256 AND hold no file outside it (installed dependencies and build output excepted).
operator_pkg_ok() {
  local pkg="$1" strays
  (cd "$pkg" && sha256sum -c --quiet PACKAGE_MANIFEST.sha256) >/dev/null 2>&1 || { echo "the operator package does not match its PACKAGE_MANIFEST.sha256"; return 1; }
  strays=$(cd "$pkg" && find . -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/dist-aws/*' -not -path '*/.turbo/*' -not -path '*/__pycache__/*' -not -name '*.tsbuildinfo' -print | sed 's|^\./||' | LC_ALL=C sort | LC_ALL=C comm -23 - <(sed 's/^[0-9a-f]\{64\}  //' "$pkg/PACKAGE_MANIFEST.sha256" | { cat; echo PACKAGE_MANIFEST.sha256; } | LC_ALL=C sort))
  [[ -z "$strays" ]] || { echo "the operator package has files that are not in its manifest: $(head -3 <<<"$strays" | tr '\n' ';')"; return 1; }
}
