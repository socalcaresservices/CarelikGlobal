#!/usr/bin/env bash
# PRODUCTION database script for the release of migrations 0086, 0087 and 0088 on ogevia_prd (ledger 85/0085 -> 88/0088). DRAFT. NOT APPROVED. NOT RUN.
# Operator: Stella Okereke only. Authority: the owner's written GO for ONE commit and ONE window, named in the pins below, AND the owner's explicit approval of the
# temporary database-access rule and of reading the RDS master secret for each mutating or database step. Without them run only 'selftest' and '--restore-only'.
# Every mutating mode refuses to run while a pin placeholder remains (they are filled by fill_pins_prd.py from the owner's GO).
#
#   bash STELLA_PRD_DB.sh selftest                                local only: pins, helper logic, security-group hash filter; no AWS, no database
#   bash STELLA_PRD_DB.sh probe                                   P2: read-only database read (ledger 85/0085, staff and readiness objects absent, counts recorded)
#   bash STELLA_PRD_DB.sh snapshot                                P3: ONE manual RDS snapshot; prints SNAPSHOT_ID (no database access, no security-group change)
#   REPO=<checkout at the pinned SHA, deps installed> SNAPSHOT_ID=<id> bash STELLA_PRD_DB.sh migrate    P4: 0086+0087+0088, verify, fingerprint, marker
#   bash STELLA_PRD_DB.sh final                                   P8: read-only closing read (ledger 88/0088)
#   REPO=... SNAPSHOT_ID=<id> bash STELLA_PRD_DB.sh rollback-db   only after a stop condition; drops tables WITH their rows; two typed phrases
#   bash STELLA_PRD_DB.sh --restore-only                          after an interrupted run: remove the temporary rule and verify (idempotent)
# Database access: ONE temporary inbound rule on the RDS security group (tcp 5432 from the admin host's own /32), removed and proven identical by hash on every exit path.
# The admin host's security groups are never modified. Connects to ogevia_prd only (hard-coded, checked: the production Lambda must serve it with OGEVIA_ENV=prd).
# Never prints a secret. Exit codes: 0 done; 1 stopped (cleanup verified if a window opened); 2 expectation not met before any write; 3 the rule could NOT be verified removed,
# or a post-migration check failed; 130 interrupted. The window-handling block below is copied verbatim from ledger-recheck-prd.sh (sha256 133ab6af0aeb4a4e0e17cc007046a57d7712b3f8ee166727be5dc25a3afa8c2c),
# which the owner approved for one run against production on 2026-11-01 and which restored the security group identically.
set +x +H
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"
SQL="$HERE/STELLA_PRD_READONLY.sql"
ACCOUNT=300094796789; REGION=us-west-2
RDS_ID=ogevia-prod-postgres; ADMIN_TAG=ogevia-db-admin-temp
EXPECT_RDS_SG=sg-00530a1f4f7648e65      # ogevia-prod-data-layer-RDSSecurityGroup
ADMIN_SG=sg-00e01e2ca80442c1f           # ogevia-db-admin-sg
IID_EXPECT=i-0ce8db2d7e5839dd5
API_STACK=Ogevia-prd-ServiceVerificationApi; DB=ogevia_prd
STATE_DIR="${OGEVIA_LEDGER_STATE_DIR:-$HOME/.ogevia-ledger-window}"   # the same marker location as ledger-recheck-prd.sh: one window at a time, restorable by either script
OPEN="$STATE_DIR/OPEN"
MARK_DIR="$HOME/.prd0088"; MARKER="$MARK_DIR/db-at-0088.ok"             # written only after migrate passed every check; the API deploy script requires it
LOCAL_PORT=${OGEVIA_PRD_DB_PORT:-15440}
AWS_TMO="${OGEVIA_AWS_TIMEOUT:-30}"; PSQL_TMO="${OGEVIA_PSQL_TIMEOUT:-45}"; CLEAN_TMO="${OGEVIA_CLEANUP_AWS_TIMEOUT:-20}"; KILL_AFTER=5
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
if [[ "$MODE" =~ ^(migrate|rollback-db)$ ]]; then MAX_SECONDS="${OGEVIA_WINDOW_MAX_SECONDS:-900}"; else MAX_SECONDS="${OGEVIA_WINDOW_MAX_SECONDS:-300}"; fi
# ---- pins: placeholders until the owner's GO (fill_pins_prd.py); the known values are the bytes already on TEST ----
SHA=fb8b7aa4eb73c0cfe4dd6f718930ea54e318cfd7                                                                                # the one approved release commit
GO_REF=GO-PRD-0088-R2-20261101                                                                          # the owner's approval reference
WIN_START_TXT="2026-11-01 19:30:00"; WIN_END_TXT="2026-11-01 22:30:00"                           # UTC, "YYYY-MM-DD HH:MM:SS"
MIG86_SHA=8eb7b4a353300ba78156bd58a0df6cbc9857b677cec0e8ec51233fcda5a16a4f                 # 0086_staff_management.sql (the bytes applied to TEST)
MIG87_SHA=f9d75d8c776005873b6019ca2d76353d182772144b9946cadd3291cdbad4cf88                 # 0087_staff_invitation_acceptance.sql (the bytes applied to TEST)
MIG88_SHA=dc20f327794a6f9b6e4f79d201550f1d0a9970e2e4b800c27b598213c82cf34f                                                                    # 0088_caregiver_readiness_approve_for_work.sql
SET85_SHA=de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef                 # migrations 0001-0085 (what production already holds)
SET88_SHA=049c52cb3cbc0c90efad7003967d8bfe8297cd771d2d471d5b42506a889e372c                                                                    # all 88 migration files
ROLLSET3_SHA=4b53cb1908a5939bb3aac47ca0725b16d264690d2d83f78e4cca7cae4d035d05                                                              # the three down files 0086, 0087, 0088 (for rollback-db)
WIN_START=$(date -u -d "$WIN_START_TXT" +%s 2>/dev/null); WIN_END=$(date -u -d "$WIN_END_TXT" +%s 2>/dev/null)
need_window() { in_window || stop "outside the authorized window ($WIN_START_TXT to $WIN_END_TXT UTC). No new activity may begin."; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="${OGEVIA_PRD_DB_DIR:-$HOME/prd0088-${MODE#--}-$STAMP}"; mkdir -p "$OUT"; chmod 700 "$OUT"
RESULT="$OUT/RESULT.txt"; : > "$RESULT"
TUN=""; IID=""; CLOSED=0; OWNS=0; RC=0; START_EPOCH=$(date +%s); TLSDIR=""
say() { printf '%s\n' "$*" | tee -a "$RESULT"; }


# ---- bounded commands ---------------------------------------------------------------------------------------------------------
# Every aws call runs under `timeout --foreground` (so Ctrl+C still reaches the command and the trap runs promptly); exit 124 (or 137 after the kill grace) means it hung. Cleanup switches to the shorter bound.
AWS_T="$AWS_TMO"
aws() { timeout --foreground -k "$KILL_AFTER" "$AWS_T" "$(type -P aws)" "$@"; }
tm() { if [[ "$1" == 124 || "$1" == 137 ]]; then printf ' [TIMED OUT]'; elif [[ "$1" == 99 ]]; then printf ' [time limit reached]'; fi; return 0; }
valid_private_ipv4() {
  local ip="$1" a b c d
  [[ "$ip" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || return 1
  a=${BASH_REMATCH[1]}; b=${BASH_REMATCH[2]}; c=${BASH_REMATCH[3]}; d=${BASH_REMATCH[4]}
  (( a <= 255 && b <= 255 && c <= 255 && d <= 255 )) || return 1
  (( a == 10 )) && return 0
  (( a == 172 && b >= 16 && b <= 31 )) && return 0
  (( a == 192 && b == 168 )) && return 0
  return 1
}
# ---- helpers -----------------------------------------------------------------------------------------------------------------
# Canonical snapshot of ALL inbound and outbound rules of the RDS group (order-independent), optionally without the temporary rule.
sg_canonical() {
  aws ec2 describe-security-groups --group-ids "$1" --query 'SecurityGroups[0].{i:IpPermissions,e:IpPermissionsEgress}' --output json 2>/dev/null \
  | jq -cS --arg drop "${2:-}" --arg dropc "${3:-}" '
      def norm: map(.UserIdGroupPairs |= (map({GroupId, UserId}) | sort_by(.GroupId)) | .IpRanges |= (map({CidrIp}) | sort_by(.CidrIp)) | .Ipv6Ranges |= (map({CidrIpv6}) | sort_by(.CidrIpv6)) | .PrefixListIds |= (map({PrefixListId}) | sort_by(.PrefixListId))) | sort_by(.IpProtocol, (.FromPort // -1), (.ToPort // -1));
      (.i | norm) as $i
      | { i: (if ($drop == "" and $dropc == "") then $i else ($i | map(if (.IpProtocol=="tcp" and .FromPort==5432 and .ToPort==5432) then (.UserIdGroupPairs |= map(select(.GroupId != $drop))) | (.IpRanges |= map(select(.CidrIp != $dropc))) else . end) | map(select((.UserIdGroupPairs|length) > 0 or (.IpRanges|length) > 0 or (.Ipv6Ranges|length) > 0 or (.PrefixListIds|length) > 0))) end),
          e: (.e | norm) }'
}
sg_hash() { sg_canonical "$@" | sha256sum | cut -d' ' -f1; }
# 0 = rule present, 1 = rule absent (the describe succeeded), 2 = unknown (the describe failed or timed out: never treated as absent).
rule_present() {
  local out
  out=$(aws ec2 describe-security-groups --group-ids "$1" --query 'SecurityGroups[0].IpPermissions[?FromPort==`5432` && ToPort==`5432`].UserIdGroupPairs[].GroupId' --output text 2>/dev/null) || return 2
  tr '\t' '\n' <<<"$out" | grep -qx "$2"
}
revoke_rule() {
  aws ec2 revoke-security-group-ingress --group-id "$1" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=$2}]" >/dev/null 2>&1
}
# The /32 variant. Same tri-state: 0 present, 1 absent, 2 unknown.
cidr_present() {
  local out
  out=$(aws ec2 describe-security-groups --group-ids "$1" --query 'SecurityGroups[0].IpPermissions[?FromPort==`5432` && ToPort==`5432`].IpRanges[].CidrIp' --output text 2>/dev/null) || return 2
  tr '\t' '\n' <<<"$out" | grep -qx "$2"
}
revoke_cidr() {
  aws ec2 revoke-security-group-ingress --group-id "$1" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$2}]" >/dev/null 2>&1
}
src_present() { if [[ "$2" == cidr ]]; then cidr_present "$1" "$3"; else rule_present "$1" "$3"; fi; }
src_revoke() { if [[ "$2" == cidr ]]; then revoke_cidr "$1" "$3"; else revoke_rule "$1" "$3"; fi; }
# Runs on EVERY exit path. Re-entrant guarded. Restores, then VERIFIES; prints exact manual commands if it cannot.
close_window() {
  [[ "$CLOSED" == 1 ]] && return 0
  CLOSED=1
  # $TUN is the background subshell; its child is the timeout/aws tunnel. End the child first, then the subshell.
  [[ -n "$TUN" ]] && { pkill -P "$TUN" 2>/dev/null; kill "$TUN" 2>/dev/null; }
  [[ -n "$IID" ]] && pkill -f "session-manager-plugin.*$IID" 2>/dev/null
  unset PGPASSWORD PGUSER SEC
  # Only the run that opened the window (or --restore-only, on purpose) may remove its rule: a refused or concurrent run must not touch it.
  [[ -f "$OPEN" && "$OWNS" == 1 ]] || return 0
  local rds_sg admin_sg before i ok=0 rp kind val
  AWS_T="$CLEAN_TMO"
  rds_sg=$(jq -r .rds_sg "$OPEN"); admin_sg=$(jq -r .admin_sg "$OPEN"); before=$(jq -r .before_sha "$OPEN")
  kind=$(jq -r '.kind // "sg"' "$OPEN"); val=$(jq -r 'if (.kind // "sg") == "cidr" then .cidr else .admin_sg end' "$OPEN")
  say ""; say "== CLEANUP: removing the temporary rule (tcp 5432 from $val on $rds_sg) and verifying"
  for i in 1 2 3 4; do
    src_present "$rds_sg" "$kind" "$val"; rp=$?
    if [[ "$rp" != 1 ]]; then src_revoke "$rds_sg" "$kind" "$val"; sleep 2; fi   # present, or UNKNOWN: try the revoke (idempotent)
    src_present "$rds_sg" "$kind" "$val"; [[ $? == 1 ]] && { ok=1; break; }
  done
  local after; after=$(sg_hash "$rds_sg")
  if [[ "$ok" == 1 && "$after" == "$before" ]]; then
    say "RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 ${after:0:16}...)."
    rm -f "$OPEN"
  else
    RC=3
    src_present "$rds_sg" "$kind" "$val"; rp=$?
    say "NOT RESTORED (exit 3; access may still be open). Rule still present: $([[ $rp == 0 ]] && echo YES || { [[ $rp == 1 ]] && echo no || echo 'UNKNOWN (the check failed or timed out)'; }). Rule-set hash now ${after:0:16}... vs original ${before:0:16}..."
    if [[ "$kind" == cidr ]]; then
      say "DO THIS NOW in a SEPARATE session. First identify (read-only); the temporary rule is the ONE row with cidr $val, tcp, 5432:"
      say "  aws ec2 describe-security-group-rules --region $REGION --filters Name=group-id,Values=$rds_sg --query 'SecurityGroupRules[?IsEgress==\`false\`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,cidr:CidrIpv4,sourceSg:ReferencedGroupInfo.GroupId,desc:Description}' --output table"
      say "Then remove ONLY that rule by id (never the row whose sourceSg is the application group):"
    else
      say "DO THIS NOW in a SEPARATE session. First identify (read-only); the temporary rule is the ONE row with source $admin_sg, tcp, 5432:"
      say "  aws ec2 describe-security-group-rules --region $REGION --filters Name=group-id,Values=$rds_sg --query 'SecurityGroupRules[?IsEgress==\`false\`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,source:ReferencedGroupInfo.GroupId,desc:Description}' --output table"
      say "Then remove ONLY that rule by id (never the row whose source is the application group):"
    fi
    say "  aws ec2 revoke-security-group-ingress --region $REGION --group-id $rds_sg --security-group-rule-ids sgr-<id of that one row>"
    say "Then re-run: bash STELLA_PRD_DB.sh --restore-only   (verifies against the recorded original)"
    say "  The marker $OPEN stays in place until restoration is verified."
  fi
}
on_exit() { local rc=$?; close_window; [[ $RC != 0 ]] && exit "$RC"; exit "$rc"; }
trap on_exit EXIT
trap 'say "Interrupted: cleaning up."; exit 130' INT TERM HUP
stop() { say ""; say "STOPPED: $*"; say "Before any change was made nothing is different; after the window opened, the cleanup above has restored and verified it."; exit 1; }
over_time() { (( $(date +%s) - START_EPOCH > MAX_SECONDS )); }

# ---- the main flow (written for this release; the stitched block above is copied verbatim from ledger-recheck-prd.sh) ----
extra_cleanup() { [[ -n "${TLSDIR:-}" ]] && rm -rf "$TLSDIR"; unset PGPASSWORD PGUSER PGHOST PGHOSTADDR PGPORT PGSSLMODE PGSSLROOTCERT PGOPTIONS OGEVIA_DATABASE_URL OGEVIA_ALLOW_REMOTE_MIGRATION MASTER U P 2>/dev/null; return 0; }
on_exit() { local rc=$?; extra_cleanup; close_window; if [[ "${STARTED:-0}" == 1 ]] && ! in_window; then say "NOTE: this step ended after the authorized window end; it was allowed to finish. Start NO further step; report."; fi; say "END (UTC): $(date -u +%FT%TZ)  mode=$MODE  exit=$([[ $RC != 0 ]] && echo $RC || echo $rc)  output=$OUT"; [[ $RC != 0 ]] && exit "$RC"; exit "$rc"; }
trap on_exit EXIT
confirm() { local want="$1" got; say ""; say "$2"; printf 'Type exactly  %s  to continue: ' "$want" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$want" ]] || stop "confirmation not given. Nothing was changed by this step."; }
uri() { printf '%s' "$1" | jq -sRr @uri; }
left_placeholders() { local pat='__[A-Z0-9_]{3,}'; pat+='__'; grep -o -E "$pat" "${BASH_SOURCE[0]}" | sort -u | tr '\n' ' '; }
in_window() { local n; n=$(date -u +%s); [[ -n "$WIN_START" && -n "$WIN_END" && "$n" -ge "$WIN_START" && "$n" -lt "$WIN_END" ]]; }

check_repo() {
  [[ -n "${REPO:-}" && -d "$REPO/infra/aws/db/migrations" ]] || stop "set REPO to the checkout at $SHA with dependencies installed"
  [[ "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" == "$SHA" ]] || stop "REPO HEAD is not $SHA (the only approved commit)"
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "REPO has local changes"
  local m="$REPO/infra/aws/db/migrations" r="$REPO/infra/aws/db/rollback"
  [[ "$(ls "$m"/*.sql | wc -l)" == 88 ]] || stop "expected 88 migration files"
  [[ "$(sha256sum "$m/0086_staff_management.sql" | cut -c1-64)" == "$MIG86_SHA" ]] || stop "migration 0086 hash differs from the pinned bytes"
  [[ "$(sha256sum "$m/0087_staff_invitation_acceptance.sql" | cut -c1-64)" == "$MIG87_SHA" ]] || stop "migration 0087 hash differs from the pinned bytes"
  [[ "$(sha256sum "$m/0088_caregiver_readiness_approve_for_work.sql" | cut -c1-64)" == "$MIG88_SHA" ]] || stop "migration 0088 hash differs from the pinned bytes"
  [[ "$(cd "$m" && LC_ALL=C sha256sum -- $(ls *.sql | LC_ALL=C sort | head -85) | sha256sum | cut -c1-64)" == "$SET85_SHA" ]] || stop "the 0001-0085 set hash differs"
  [[ "$(cd "$m" && LC_ALL=C sha256sum -- *.sql | sha256sum | cut -c1-64)" == "$SET88_SHA" ]] || stop "the all-88 set hash differs"
  [[ "$(cd "$r" && LC_ALL=C sha256sum -- 0086_staff_management.down.sql 0087_staff_invitation_acceptance.down.sql 0088_caregiver_readiness_approve_for_work.down.sql | sha256sum | cut -c1-64)" == "$ROLLSET3_SHA" ]] || stop "the 0086-0088 rollback set hash differs"
  for f in verify-0086.sql verify-0087.sql; do [[ -f "$REPO/docs/releases/2026-10-26-redesign-operator/scripts/$f" ]] || stop "$f is missing from REPO"; done
  say "pins ok: commit $SHA; migrations 0086, 0087, 0088, the 0001-0085 set, the all-88 set and the 0086-0088 rollback set match"
}

snapshot_check() {   # read-only. "fresh" (migrate) also requires: created inside the window and not older than 4 hours.
  local want="${1:-}" d t
  [[ "${SNAPSHOT_ID:-}" == "$RDS_ID-pre-0088-prd-"* ]] || stop "set SNAPSHOT_ID to the id printed by the snapshot mode ($RDS_ID-pre-0088-prd-...)"
  d=$(aws rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT_ID" --query 'DBSnapshots[0].[Status,Encrypted,DBInstanceIdentifier,SnapshotType,SnapshotCreateTime]' --output text) || stop "snapshot not found"
  say "snapshot: $SNAPSHOT_ID  $d"
  set -- $d
  [[ "$1" == available && "$2" == True && "$3" == "$RDS_ID" && "$4" == manual ]] || stop "the snapshot is not available, encrypted, manual and of $RDS_ID"
  if [[ "$want" == fresh ]]; then
    t=$(date -u -d "$5" +%s 2>/dev/null) || stop "cannot read the snapshot time"
    [[ $(( $(date -u +%s) - t )) -lt 14400 ]] || stop "the snapshot is older than 4 hours"
    [[ -n "$WIN_START" && "$t" -ge "$WIN_START" ]] || stop "the snapshot was created before the window start"
  fi
}

# ---------------------------------------------------------------- selftest: local only, no AWS, no database
if [[ "$MODE" == selftest ]]; then
  echo "selftest (local only; no AWS, no database)"
  L="$(left_placeholders)"; if [[ -n "$L" ]]; then echo "placeholders still present (expected until the owner's GO): $L"; else echo "no placeholders remain"; fi
  if [[ -n "$WIN_START" && -n "$WIN_END" ]]; then [[ "$WIN_END" -gt "$WIN_START" ]] && echo "window math ok: $(date -u -d @$WIN_START +%FT%TZ) to $(date -u -d @$WIN_END +%FT%TZ)" || stop "window end is not after the start"; else echo "window not filled in (expected before the GO)"; fi
  [[ "$(uri 'a b/c@d:e')" == "a%20b%2Fc%40d%3Ae" ]] && echo "uri-encoding ok" || stop "uri-encoding"
  for ip in 10.0.0.1 10.20.132.179 172.16.5.5 172.31.255.255 192.168.1.9; do valid_private_ipv4 "$ip" || stop "valid_private_ipv4 rejected $ip"; done
  for ip in 8.8.8.8 172.32.0.1 172.15.0.1 192.169.0.1 10.0.0.256 10.0.0 010.0.0.1 "" "10.0.0.1/32" 0.0.0.0; do valid_private_ipv4 "$ip" && stop "valid_private_ipv4 accepted '$ip'"; done
  echo "private-address checks ok (5 accepted, 10 refused)"
  SAMPLE='{"i":[{"IpProtocol":"tcp","FromPort":5432,"ToPort":5432,"UserIdGroupPairs":[{"GroupId":"sg-app","UserId":"1"}],"IpRanges":[],"Ipv6Ranges":[],"PrefixListIds":[]},{"IpProtocol":"tcp","FromPort":5432,"ToPort":5432,"UserIdGroupPairs":[],"IpRanges":[{"CidrIp":"10.1.2.3/32"}],"Ipv6Ranges":[],"PrefixListIds":[]}],"e":[{"IpProtocol":"-1","UserIdGroupPairs":[],"IpRanges":[{"CidrIp":"0.0.0.0/0"}],"Ipv6Ranges":[],"PrefixListIds":[]}]}'
  SAMPLE_NO_RULE='{"i":[{"IpProtocol":"tcp","FromPort":5432,"ToPort":5432,"UserIdGroupPairs":[{"GroupId":"sg-app","UserId":"1"}],"IpRanges":[],"Ipv6Ranges":[],"PrefixListIds":[]}],"e":[{"IpProtocol":"-1","UserIdGroupPairs":[],"IpRanges":[{"CidrIp":"0.0.0.0/0"}],"Ipv6Ranges":[],"PrefixListIds":[]}]}'
  aws() { cat; }   # the selftest feeds sample JSON to the real filter through this stub; the stub is never used for AWS
  h_with="$(sg_hash sg-x "" 10.1.2.3/32 <<<"$SAMPLE")"; h_without="$(sg_hash sg-x "" "" <<<"$SAMPLE_NO_RULE")"; h_full="$(sg_hash sg-x "" "" <<<"$SAMPLE")"
  [[ -n "$h_with" && "$h_with" == "$h_without" ]] && echo "security-group canonical hash: the group minus the temporary /32 equals the original" || stop "security-group hash filter: group minus the rule differs from the original"
  [[ "$h_full" != "$h_without" ]] && echo "security-group canonical hash: the group WITH the rule differs from the original (a lingering rule is detectable)" || stop "security-group hash filter cannot tell a lingering rule"
  unset -f aws
  if [[ -n "${REPO:-}" ]]; then [[ -z "$L" ]] && check_repo || echo "REPO given but placeholders remain: the pin check is skipped (it needs the filled pins)"; else echo "REPO not set: pin check skipped"; fi
  echo "selftest done"; exit 0
fi

# ---------------------------------------------------------------- every other mode
case "$MODE" in probe|snapshot|migrate|final|rollback-db|--restore-only) ;; *) stop "usage: selftest | probe | snapshot | migrate | final | rollback-db | --restore-only (see the header)";; esac
# FIRST, before any tool check or AWS call: a draft script cannot touch AWS. (--restore-only is exempt: it only removes a rule this tooling added.)
if [[ "$MODE" != --restore-only ]]; then
  P="$(left_placeholders)"; [[ -z "$P" ]] || stop "placeholders remain ($P): the owner's GO has not been filled in. Only 'selftest' and '--restore-only' may run. Nothing was touched."
  need_window; STARTED=1
fi
need_tools=(aws jq sha256sum timeout curl); [[ "$MODE" != snapshot && "$MODE" != --restore-only ]] && need_tools+=(psql session-manager-plugin); [[ "$MODE" =~ ^(migrate|rollback-db)$ ]] && need_tools+=(pnpm git)
for t in "${need_tools[@]}"; do command -v "$t" >/dev/null 2>&1 || stop "missing tool '$t'. This script installs nothing."; done
say "================================================================"
say "MODE: $MODE  =  PRODUCTION ($DB)   UTC: $(date -u +%FT%TZ)   output: $OUT"
say "================================================================"
IDENT=$(aws sts get-caller-identity --output json 2>/dev/null) || stop "no valid AWS credentials: sign in again and reopen CloudShell in $REGION"
[[ "$(jq -r .Account <<<"$IDENT")" == "$ACCOUNT" ]] || stop "wrong AWS account $(jq -r .Account <<<"$IDENT") (expected $ACCOUNT)"
say "account $ACCOUNT, region $REGION: OK"
if [[ "$MODE" == --restore-only ]]; then
  if [[ -f "$OPEN" ]]; then CLOSED=0; say "An open-window marker exists ($(jq -r .stamp "$OPEN")). Restoring."; OWNS=1; close_window; else say "No open-window marker: nothing to restore. (Nothing was changed.)"; fi
  exit "$RC"
fi
[[ ! -f "$OPEN" ]] || stop "an earlier window is marked OPEN ($OPEN, started $(jq -r .stamp "$OPEN")). Run: bash STELLA_PRD_DB.sh --restore-only"

say ""; say "== 1. Environment (read-only): PRODUCTION; expected database $DB; approval reference $GO_REF"
STATUS=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null) || stop "stack $API_STACK not found"
[[ "$STATUS" == CREATE_COMPLETE || "$STATUS" == UPDATE_COMPLETE ]] || stop "stack $API_STACK is '$STATUS', not a settled status"
FN=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))][0].PhysicalResourceId // empty')
[[ -n "$FN" ]] || stop "API handler Lambda not found in $API_STACK"
CFG=$(aws lambda get-function-configuration --function-name "$FN" --output json 2>/dev/null) || stop "cannot read Lambda $FN"
L_DB=$(jq -r '.Environment.Variables.DB_NAME // empty' <<<"$CFG"); L_ENV=$(jq -r '.Environment.Variables.OGEVIA_ENV // empty' <<<"$CFG")
say "stack $API_STACK: $STATUS; Lambda $FN: DB_NAME=${L_DB:-unset} OGEVIA_ENV=${L_ENV:-unset}"
[[ "$L_DB" == "$DB" && "$L_ENV" == prd ]] || stop "the production Lambda must serve $DB with OGEVIA_ENV=prd; it reports '${L_DB:-unset}' / '${L_ENV:-unset}'. Not the production environment."
RDS=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0]' --output json 2>/dev/null) || stop "cannot describe RDS $RDS_ID"
[[ "$(jq -r .DBInstanceStatus <<<"$RDS")" == available && "$(jq -r .PubliclyAccessible <<<"$RDS")" == false ]] || stop "RDS is not available and private"
RDS_HOST=$(jq -r .Endpoint.Address <<<"$RDS"); MASTER_ARN=$(jq -r '.MasterUserSecret.SecretArn // empty' <<<"$RDS")
[[ -n "$RDS_HOST" && "$MASTER_ARN" == arn:* ]] || stop "could not resolve the RDS endpoint or the master secret ARN"

if [[ "$MODE" == snapshot ]]; then
  SNAP="$RDS_ID-pre-0088-prd-$(date -u +%Y%m%dt%H%Mz)"
  say "creating ONE manual snapshot $SNAP (the instance also holds the TEST database)"
  aws rds create-db-snapshot --db-instance-identifier "$RDS_ID" --db-snapshot-identifier "$SNAP" --query 'DBSnapshot.[DBSnapshotIdentifier,Status]' --output text || stop "create-db-snapshot failed"
  say "waiting until available (this can take several minutes)..."
  AWS_T=3000 aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAP" || stop "the snapshot did not become available: do NOT migrate"
  SNAPSHOT_ID="$SNAP"; snapshot_check fresh; say "SNAPSHOT_ID=$SNAP   <-- use this for migrate and rollback-db"; exit 0
fi

if [[ "$MODE" =~ ^(migrate|rollback-db)$ ]]; then check_repo; fi
if [[ "$MODE" == migrate ]]; then snapshot_check fresh; elif [[ "$MODE" == rollback-db ]]; then snapshot_check; fi

say ""; say "== 2. ORIGINAL CONFIGURATION (recorded before any change)"
HOST=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].[InstanceId,SecurityGroups[].GroupId]' --output json 2>/dev/null)
[[ -n "$HOST" && "$HOST" != null && "$HOST" != "[null,null]" ]] || stop "admin host '$ADMIN_TAG' is not running (starting it is a change this script will not make)"
IID=$(jq -r '.[0]' <<<"$HOST"); HOST_SGS=$(jq -r '.[1] | join(" ")' <<<"$HOST")
[[ "$IID" == "$IID_EXPECT" ]] || stop "the admin host is '$IID', expected $IID_EXPECT"
[[ "$HOST_SGS" == "$ADMIN_SG" ]] || stop "the admin host's groups are '$HOST_SGS', expected exactly '$ADMIN_SG'. Review before changing anything."
say "admin host $IID: security groups [$HOST_SGS]  (NOT modified by this script)"
RDS_SGS=$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$RDS"); [[ "$RDS_SGS" == "$EXPECT_RDS_SG" ]] || stop "the RDS security groups are '$RDS_SGS', expected exactly '$EXPECT_RDS_SG'"
ENIS=$(aws ec2 describe-network-interfaces --filters "Name=group-id,Values=$ADMIN_SG" --query 'NetworkInterfaces[].[NetworkInterfaceId,Attachment.InstanceId]' --output json 2>/dev/null) || stop "cannot list network interfaces"
[[ "$(jq --arg i "$IID" '[.[] | select(.[1] == $i)] | length' <<<"$ENIS")" == 1 ]] || stop "the admin host must appear exactly once among the group's interfaces ($ENIS)"
HOST_ENI=$(jq -r --arg i "$IID" '[.[] | select(.[1] == $i)][0][0]' <<<"$ENIS")
HD=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].{state:State.Name,ip:PrivateIpAddress,vpc:VpcId,enis:NetworkInterfaces[].{eni:NetworkInterfaceId,ips:PrivateIpAddresses[].PrivateIpAddress}}' --output json 2>/dev/null) || stop "cannot read the admin host's network details"
[[ "$(jq -r .state <<<"$HD")" == running ]] || stop "the admin host is not running"
jq -e '(.enis | length) == 1 and (.enis[0].ips | length) == 1 and .enis[0].ips[0] == .ip' <<<"$HD" >/dev/null 2>&1 || stop "the admin host must have exactly ONE network interface with exactly ONE private IPv4 address; refusing ($(jq -c '.enis' <<<"$HD"))"
HOST_IP=$(jq -r .ip <<<"$HD"); VPC_ID=$(jq -r .vpc <<<"$HD")
valid_private_ipv4 "$HOST_IP" || stop "the admin host's address '$HOST_IP' is not a valid private (RFC 1918) IPv4 address"
[[ -z "${OGEVIA_EXPECT_HOST_IP:-}" || "$HOST_IP" == "$OGEVIA_EXPECT_HOST_IP" ]] || stop "the admin host's live IP is $HOST_IP but OGEVIA_EXPECT_HOST_IP is $OGEVIA_EXPECT_HOST_IP"
[[ "$(jq -r '.enis[0].eni' <<<"$HD")" == "$HOST_ENI" ]] || stop "the host's interface does not match the interface in the admin group"
IPMAP=$(aws ec2 describe-network-interfaces --filters "Name=addresses.private-ip-address,Values=$HOST_IP" "Name=vpc-id,Values=$VPC_ID" --query 'NetworkInterfaces[].[NetworkInterfaceId,Attachment.InstanceId]' --output json 2>/dev/null) || stop "cannot map the IP to interfaces"
[[ "$(jq 'length' <<<"$IPMAP")" == 1 && "$(jq -r '.[0][0]' <<<"$IPMAP")" == "$HOST_ENI" && "$(jq -r '.[0][1]' <<<"$IPMAP")" == "$IID" ]] || stop "the IP $HOST_IP does not map to exactly one interface, the admin host's own ($IPMAP)"
HOST_CIDR="$HOST_IP/32"
say "admin host IP (live): $HOST_IP on $HOST_ENI, its only interface and only address; it maps to no other interface in $VPC_ID"
BEFORE_JSON=$(sg_canonical "$EXPECT_RDS_SG"); [[ -n "$BEFORE_JSON" && "$BEFORE_JSON" != null ]] || stop "cannot read the RDS security group rules"
BEFORE_SHA=$(sha256sum <<<"$BEFORE_JSON" | cut -d' ' -f1)
printf '%s\n' "$BEFORE_JSON" > "$OUT/rds-sg-before.json"; chmod 600 "$OUT/rds-sg-before.json"
say "RDS security group $EXPECT_RDS_SG, ORIGINAL inbound rules:"
jq -r '.i[] | "   " + .IpProtocol + " " + ((.FromPort // "all")|tostring) + "-" + ((.ToPort // "all")|tostring) + "  from " + (([.UserIdGroupPairs[].GroupId] + [.IpRanges[].CidrIp] + [.Ipv6Ranges[].CidrIpv6] + [.PrefixListIds[].PrefixListId]) | join(", "))' <<<"$BEFORE_JSON" | tee -a "$RESULT"
say "ORIGINAL rule-set sha256: $BEFORE_SHA   (full copy: $OUT/rds-sg-before.json)"
cidr_present "$EXPECT_RDS_SG" "$HOST_CIDR"; case $? in 0) stop "a rule allowing $HOST_CIDR on 5432 ALREADY exists on $EXPECT_RDS_SG: investigate instead of changing anything." ;; 2) stop "cannot read the RDS security group rules (failed or timed out). Nothing was changed." ;; esac

# full TLS verification through the tunnel (verify-full): the certificate is checked against the RDS host NAME, the bytes go to 127.0.0.1. Prepared BEFORE any change.
TLSDIR="$(mktemp -d)"; chmod 700 "$TLSDIR"
curl -fsS --max-time 60 -o "$TLSDIR/rds-global-bundle.pem" https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem || stop "cannot download the RDS CA bundle (no fallback to unverified TLS)"
[[ "$(grep -c 'BEGIN CERTIFICATE' "$TLSDIR/rds-global-bundle.pem")" -ge 20 ]] || stop "the RDS CA bundle looks wrong"
say "RDS CA bundle sha256: $(sha256sum "$TLSDIR/rds-global-bundle.pem" | cut -c1-64) (record it)"
cat > "$TLSDIR/resolve-rds.cjs" <<'JS'
// Node preload: resolve ONLY the RDS host name to 127.0.0.1 (the SSM tunnel end); every other name resolves normally.
const dns = require("node:dns"); const HOST = process.env.OGEVIA_TUNNEL_HOST, orig = dns.lookup;
if (HOST) dns.lookup = function (h, o, cb) { if (typeof o === "function") { cb = o; o = {}; }
  if (h === HOST) { return (o && o.all) ? process.nextTick(cb, null, [{ address: "127.0.0.1", family: 4 }]) : process.nextTick(cb, null, "127.0.0.1", 4); }
  return orig.call(dns, h, o, cb); };
JS

say ""; say "== 3. PROPOSED CHANGE (the only one to AWS; $MODE)"
say "  ADD to $EXPECT_RDS_SG :  inbound tcp 5432 from $HOST_CIDR  (the admin host's own IP only; description 'TEMP-prd0088-$STAMP')"
say "  REMOVE it again when the step ends (maximum $MAX_SECONDS s), then verify the complete rule set equals the original hash above."
say "  Also: one SSM port-forward session; the RDS master secret read into memory only (never printed); a read-only database session on $DB$([[ "$MODE" =~ ^(migrate|rollback-db)$ ]] && echo ', then the WRITES described at the next prompt')."
say "  Reaches: RDS instance $RDS_ID on 5432 from the admin host only. That instance holds BOTH ogevia_sv_test and $DB."
confirm "OPEN-5432-WINDOW-PRD" "Keep a SEPARATE recovery tab ready (bash STELLA_PRD_DB.sh --restore-only): if this session is lost the rule is NOT removed automatically."

say ""; say "== 4. Window"
START_EPOCH=$(date +%s)
mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
( set -o noclobber; jq -n --arg rds "$EXPECT_RDS_SG" --arg adm "$ADMIN_SG" --arg stamp "$STAMP" --arg sha "$BEFORE_SHA" --arg kind cidr --arg cidr "$HOST_CIDR" '{rds_sg:$rds, admin_sg:$adm, stamp:$stamp, before_sha:$sha, kind:$kind, cidr:$cidr}' > "$OPEN" ) 2>/dev/null || stop "another window was opened a moment ago ($OPEN exists). Nothing was changed by this run."
OWNS=1; chmod 600 "$OPEN"
aws ec2 authorize-security-group-ingress --group-id "$EXPECT_RDS_SG" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$HOST_CIDR,Description=TEMP-prd0088-$STAMP}]" >/dev/null 2>"$OUT/authorize.err" || { rc=$?; stop "could not add the rule$(tm $rc): $(tail -1 "$OUT/authorize.err")"; }
cidr_present "$EXPECT_RDS_SG" "$HOST_CIDR" || stop "the rule did not appear after adding it (or the check failed or timed out)"
[[ "$(sg_hash "$EXPECT_RDS_SG" "" "$HOST_CIDR")" == "$BEFORE_SHA" ]] || stop "the group changed in a way other than the single rule: aborting"
say "window open: exactly one rule was added (verified: the group minus that rule equals the original)."
over_time && stop "time limit ($MAX_SECONDS s) reached before the tunnel"
AWS_T="$((MAX_SECONDS + 30))" aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null 2>&1 &
TUN=$!
for _ in $(seq 1 "${OGEVIA_TUNNEL_WAIT:-30}"); do (echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null && break; sleep 1; done
(echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null || stop "the Session Manager tunnel did not open in time"
over_time && stop "time limit ($MAX_SECONDS s) reached"
unset PGSERVICE PGSERVICEFILE PGDATABASE PGPASSFILE PGUSER PGPASSWORD PGHOSTADDR PGSSLROOTCERT
SEC=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" --query SecretString --output text 2>/dev/null) || { rc=$?; stop "cannot read the RDS master secret$(tm $rc)"; }
U="$(printf '%s' "$SEC" | jq -r .username)"; P="$(printf '%s' "$SEC" | jq -r .password)"; unset SEC
[[ -n "$U" && "$U" != null && -n "$P" && "$P" != null ]] || stop "the secret lacks a username or password"
export PGHOST="$RDS_HOST" PGHOSTADDR=127.0.0.1 PGPORT="$LOCAL_PORT" PGSSLMODE=verify-full PGSSLROOTCERT="$TLSDIR/rds-global-bundle.pem" PGUSER="$U" PGPASSWORD="$P" PGOPTIONS="-c statement_timeout=120000" PGCONNECT_TIMEOUT=15
say "LOGIN ROLE USED (name only): $U"
GOT=$(psql -X -At -d "$DB" -c "select current_database()") || stop "connection to $DB failed"; [[ "$GOT" == "$DB" ]] || stop "the connected database is '$GOT', not $DB"
say "guard ok: connected to $GOT"

ro() { PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000" psql -X -At -d "$DB" -c "begin read only;" -c "set local role ogevia_readonly;" -c "$1" -c "rollback;" 2>&1 | grep -v -E '^(BEGIN|SET|ROLLBACK)$'; }
state() {
  LEDGER=$(ro "select count(*)||'/'||max(version) from ogevia_meta.schema_migrations")
  HAS_RD=$(ro "select coalesce(to_regclass('ogevia.caregiver_work_approvals')::text,'absent')")
  STAFFOBJ=$(ro "select (to_regclass('ogevia.staff_types') is not null)::int || '|' || (to_regclass('ogevia.staff_profiles') is not null)::int || '|' || (exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname = 'accept_staff_invitation' and p.pronargs = 1 and p.proargtypes[0] = 'uuid'::regtype::oid))::int")
  RA=$(ro "select count(*) filter (where status in ('ready','active'))||'/'||count(*) from ogevia.caregiver_records where deleted_at is null")
  ENF=$(ro "select count(*) from ogevia.organization_readiness_settings where enforcement_active_from is not null")
  say "state: ledger=$LEDGER  readiness_table=$HAS_RD  staff_tables_and_function(staff_types|staff_profiles|accept_staff_invitation)=$STAFFOBJ  ready_or_active/caregivers=$RA  orgs_enforcing=$ENF"
}
assert_before() { state; [[ "$LEDGER" == "85/0085" && "$HAS_RD" == absent && "$STAFFOBJ" == "0|0|0" && "$ENF" == 0 ]] || stop "production is not in the expected starting state (ledger 85/0085, readiness table absent, staff objects absent 0|0|0, enforcement 0). Nothing was changed."; say "BASELINE MATCHES"; }
assert_after() {
  state; LEG=$(ro "select count(*) from ogevia.caregiver_work_approvals where source='legacy_status'"); say "legacy_status approvals=$LEG (ready-or-active before: ${RA_BEFORE%%/*})"
  [[ "$LEDGER" == "88/0088" && "$HAS_RD" != absent && "$STAFFOBJ" == "1|1|1" && "$ENF" == 0 && "$RA" == "$RA_BEFORE" && "$LEG" == "${RA_BEFORE%%/*}" ]] || { say "!!! POST-STATE DOES NOT MATCH (ledger 88/0088, readiness table present, staff objects 1|1|1, enforcement 0, caregiver counts unchanged $RA_BEFORE, legacy approvals equal to the ready-or-active count before). STOP: do not deploy the API. Roll back only on a stop condition."; return 1; }
  say "POST-STATE MATCHES"
}
vrun() { local file="$1" want="$2" out n bad
  out=$(PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=60000" psql -X -At -F '|' -d "$DB" -c "begin read only;" -f "$file" -c "rollback;" 2>&1 | grep -v -E '^(BEGIN|SET|ROLLBACK)$')
  n=$(printf '%s\n' "$out" | grep -c '|'); bad=$(printf '%s\n' "$out" | grep -c '|f|')
  say "$(basename "$file"): $n checks, $bad failing (expected $want checks, 0 failing)"
  [[ "$n" == "$want" && "$bad" == 0 ]] || { printf '%s\n' "$out" | grep '|f|' | head -5; [[ "$n" == 0 ]] && { say "no check rows returned; first lines of the psql output:"; printf '%s\n' "$out" | head -3; }; stop "$(basename "$file") did not report $want passing checks."; }
}
# Row counts of every existing table (counts only, no content): the "existing data unchanged" evidence.
fp() { PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120000" psql -X -At -F '|' -d "$DB" <<'SQL'
begin read only;
select format('select %L, count(*) from %I.%I', schemaname || '.' || tablename, schemaname, tablename) from pg_tables where schemaname in ('ogevia', 'ogevia_meta') order by 1 \gexec
rollback;
SQL
}
fp_compare() { # $1 before file, $2 after file. Allowed to change by the release itself: the ledger (+3), permissions and role_permissions (seed rows of 0086; they may only grow).
  local bad=0 t b a
  while IFS='|' read -r t b; do
    a=$(awk -F'|' -v t="$t" '$1 == t {print $2}' "$2"); [[ -n "$a" ]] || { say "FINGERPRINT: table $t is missing after the migration"; bad=1; continue; }
    case "$t" in
      ogevia_meta.schema_migrations) [[ "$a" -eq $((b + 3)) ]] || { say "FINGERPRINT: the ledger moved from $b to $a, expected +3"; bad=1; } ;;
      ogevia.permissions|ogevia.role_permissions) [[ "$a" -ge "$b" ]] || { say "FINGERPRINT: $t shrank from $b to $a"; bad=1; } ;;
      *) [[ "$a" == "$b" ]] || { say "FINGERPRINT: $t changed from $b to $a rows"; bad=1; } ;;
    esac
  done < <(grep -E '^[a-z_.]+\|[0-9]+$' "$1")
  return "$bad"
}
run_sql_record() { say "--- STELLA_PRD_READONLY.sql output (counts only)"; PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000" psql -X -v ON_ERROR_STOP=1 -d "$DB" -f "$SQL" | tee -a "$RESULT"; }
dburl() { printf 'postgres://%s:%s@%s:%s/%s?sslmode=verify-full&sslrootcert=%s' "$(uri "$U")" "$(uri "$P")" "$RDS_HOST" "$LOCAL_PORT" "$DB" "$TLSDIR/rds-global-bundle.pem"; }
nodeenv() { env -u PGOPTIONS -u PGHOST -u PGHOSTADDR -u PGPORT -u PGUSER -u PGPASSWORD -u PGSSLMODE -u PGSSLROOTCERT OGEVIA_TUNNEL_HOST="$RDS_HOST" NODE_OPTIONS="--require $TLSDIR/resolve-rds.cjs" "$@"; }
[[ -f "$SQL" ]] || stop "cannot find $SQL"

say ""; say "== 5. Work: $MODE"
case "$MODE" in
  probe)  assert_before && run_sql_record ;;
  final)  state; [[ "$LEDGER" == "88/0088" && "$HAS_RD" != absent && "$STAFFOBJ" == "1|1|1" && "$ENF" == 0 ]] || stop "the final state is not ledger 88/0088 with the readiness table and the staff objects present and enforcement 0"
          say "FINAL STATE MATCHES"; run_sql_record ;;
  migrate)
    assert_before || exit 2; RA_BEFORE="$RA"
    fp > "$OUT/fp-before.tsv" || stop "cannot take the before-fingerprint"; say "fingerprint before: $(grep -c '|' "$OUT/fp-before.tsv") tables counted"
    confirm "MIGRATE PRD 0086-0088" "About to apply migrations 0086, 0087 and 0088 (three files, in order, one transaction each) to $DB with the repository runner. Existing data is not deleted; 0088 retires existing onboarding requirements of the categories background_check, document and clearance (is_active=false) and backfills one approval per ready or active caregiver ($RA_BEFORE ready-or-active/caregivers now). Snapshot $SNAPSHOT_ID is verified. Window ends $WIN_END_TXT UTC."
    OUTF="$(mktemp)"
    ( cd "$REPO" && nodeenv OGEVIA_DATABASE_URL="$(dburl)" OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner pnpm --filter @carelik/infra-aws db:migrate ) > "$OUTF" 2>&1; RCM=$?
    sed -E 's#postgres://[^ ]*#postgres://<redacted>#g' "$OUTF" | tee -a "$RESULT"
    [[ "$RCM" == 0 ]] && grep -q "applied 3, already applied 85" "$OUTF" || { rm -f "$OUTF"; stop "migrate exit=$RCM or the output is not 'applied 3, already applied 85'. Check the output; do not retry; roll back only on a stop condition."; }
    ( cd "$REPO" && nodeenv OGEVIA_DATABASE_URL="$(dburl)" pnpm --filter @carelik/infra-aws db:verify ) > "$OUTF" 2>&1; RCM=$?
    sed -E 's#postgres://[^ ]*#postgres://<redacted>#g' "$OUTF" | tee -a "$RESULT"; rm -f "$OUTF"
    [[ "$RCM" == 0 ]] || stop "db:verify failed (exit $RCM)"
    assert_after || exit 3
    vrun "$REPO/docs/releases/2026-10-26-redesign-operator/scripts/verify-0086.sql" 110
    vrun "$REPO/docs/releases/2026-10-26-redesign-operator/scripts/verify-0087.sql" 22
    fp > "$OUT/fp-after.tsv" || stop "cannot take the after-fingerprint"
    if fp_compare "$OUT/fp-before.tsv" "$OUT/fp-after.tsv"; then say "PASS existing data counts unchanged (only the ledger +3 and the permission seed rows moved)"; else say "!!! EXISTING DATA COUNTS CHANGED (see FINGERPRINT lines). The marker is NOT written; the API deploy is blocked. Report; do not roll back without the owner."; exit 3; fi
    mkdir -p "$MARK_DIR"; chmod 700 "$MARK_DIR"; printf '88|0088|%s|%s|%s\n' "$SNAPSHOT_ID" "$(date -u +%FT%TZ)" "$SHA" > "$MARKER"; say "marker written: $MARKER (the API deploy script requires it)"
    run_sql_record ;;
  rollback-db)
    say "ROLLBACK to 85/0085 drops the staff tables (0086) and the readiness tables (0088: caregiver_work_approvals, caregiver_cpr_tb_extensions, caregiver_contacts, organization_compliance_settings) WITH THEIR ROWS, including every approval recorded after launch, and restores the functions as 0085 left them. Snapshot $SNAPSHOT_ID exists. Restoring the snapshot itself is NOT authorized here (it creates a new instance and also affects TEST). Web and API must already be rolled back."
    confirm "OWNER AUTHORIZED PRD DB ROLLBACK" "The owner must have authorized this production database rollback in writing."
    confirm "ROLLBACK PRD TO 0085" "Last chance: this is destructive for the tables listed above."
    OUTF="$(mktemp)"
    ( cd "$REPO" && nodeenv OGEVIA_DATABASE_URL="$(dburl)" OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner pnpm --filter @carelik/infra-aws db:rollback-to 0086 --expect-set-sha "$ROLLSET3_SHA" ) > "$OUTF" 2>&1; RCM=$?
    sed -E 's#postgres://[^ ]*#postgres://<redacted>#g' "$OUTF" | tee -a "$RESULT"; rm -f "$OUTF"
    [[ "$RCM" == 0 ]] || stop "rollback exit=$RCM; do not retry; report"
    rm -f "$MARKER"; state
    [[ "$LEDGER" == "85/0085" && "$HAS_RD" == absent && "$STAFFOBJ" == "0|0|0" ]] || { say "!!! AFTER THE ROLLBACK the state is not 85/0085 with the readiness and staff objects absent. Report."; exit 3; }
    say "ROLLED BACK: ledger 85/0085, readiness and staff objects absent; marker removed" ;;
esac
over_time && say "(time limit exceeded; result kept)"
close_window
say ""; say "================ SUMMARY ================"
say "mode $MODE on PRODUCTION ($DB) finished; reference $GO_REF"
[[ -f "$OPEN" ]] && say "SECURITY GROUP: NOT RESTORED, see the instructions above" || say "SECURITY GROUP: restored and verified identical to the original"
[[ "$RC" == 0 ]] && exit 0 || exit "$RC"
