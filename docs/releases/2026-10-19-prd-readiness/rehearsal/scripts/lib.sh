#!/usr/bin/env bash
# Shared helpers for the production-upgrade REHEARSAL package (sourced; never run directly). Read-only unless a script that sources it says otherwise.
# The rehearsal works on a RESTORED COPY of ogevia-prod-postgres under a NEW identifier ogevia-prd-rehearsal-YYYYMMDD. It never writes to ogevia-prod-postgres,
# never changes the shared RDS security group sg-00530a1f4f7648e65, and never names a production stack. Output is counts, hashes, timings and object names only.
set -uo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
ACCOUNT=300094796789
PROD_RDS=ogevia-prod-postgres
PROD_RDS_SG=sg-00530a1f4f7648e65
ADMIN_TAG=ogevia-db-admin-temp
PRD_DB=ogevia_prd
TEST_DB=ogevia_sv_test
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$LIB_DIR/.." && pwd)"
OUT="${OGEVIA_REHEARSAL_DIR:-$HOME/ogevia-prd-rehearsal}"
mkdir -p "$OUT" && chmod 700 "$OUT"
STATE="$OUT/state.env"; LOG="$OUT/log.txt"
AWS_TMO="${OGEVIA_AWS_TIMEOUT:-60}"
A() { timeout --foreground -k 5 "$AWS_TMO" aws "$@"; }
say() { printf '%s\n' "$*" | tee -a "$LOG"; }
stop() { say "STOP: $*"; exit 1; }
need() { local t; for t in "$@"; do command -v "$t" >/dev/null 2>&1 || stop "missing tool: $t"; done; }
state_get() { [[ -f "$STATE" ]] && sed -n "s/^$1=//p" "$STATE" | tail -1; return 0; }
state_set() {
  [[ "$2" =~ ^[A-Za-z0-9._:/@=-]+$ ]] || stop "refusing to store '$2' for $1"
  touch "$STATE"; { grep -v "^$1=" "$STATE" || true; echo "$1=$2"; } > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}
check_account() {
  local who; who=$(A sts get-caller-identity --output json 2>/dev/null) || stop "no valid AWS credentials: sign in again and reopen CloudShell in us-west-2"
  [[ "$(jq -r .Account <<<"$who")" == "$ACCOUNT" ]] || stop "wrong AWS account $(jq -r .Account <<<"$who") (expected $ACCOUNT)"
  say "account $ACCOUNT, region us-west-2: OK"
}
valid_reh_id() { [[ "$1" =~ ^ogevia-prd-rehearsal-[0-9]{8}$ && "$1" != "$PROD_RDS" ]]; }
confirm() {
  local phrase="$1" ans
  read -r -p "Type $phrase to continue (anything else stops, nothing is changed): " ans || ans=""
  [[ "$ans" == "$phrase" ]] || stop "the confirmation phrase was not typed; nothing was changed"
}
# JSON of the production instance (read-only describe)
prod_instance() { A rds describe-db-instances --db-instance-identifier "$PROD_RDS" --output json 2>/dev/null | jq -c '.DBInstances[0]' ; }
