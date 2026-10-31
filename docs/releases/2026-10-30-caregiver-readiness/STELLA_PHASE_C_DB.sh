#!/usr/bin/env bash
# Phase C database script for migration 0086, TEST/pilot only. Operator: Stella Okereke only. DRAFT rev 1. NOT RUN.
# Authority: GO_DRAFT.md + DECISION_RECORD.md A11/A12, AND the owner's explicit G1 authorization (temporary AppSG attach and the TEST
# admin credential in memory only). If G1 is not in writing, do NOT run any mode except selftest.
#
#   bash STELLA_PHASE_C_DB.sh selftest                       local only: pin and logic checks, no AWS, no database
#   REPO=<checkout at the pinned SHA, deps installed> bash STELLA_PHASE_C_DB.sh probe      S2: read-only baseline (window only)
#   bash STELLA_PHASE_C_DB.sh snapshot                       S5: one manual RDS snapshot (window only); prints the snapshot id
#   REPO=... SNAPSHOT_ID=<id> bash STELLA_PHASE_C_DB.sh migrate    S6+S7: apply 0086 only, verify, post-probe (window only)
#   bash STELLA_PHASE_C_DB.sh final                          S11: read-only closing read
#   REPO=... SNAPSHOT_ID=<id> bash STELLA_PHASE_C_DB.sh rollback   only after a stop condition; allowed after the window to restore known-good
# Never touches ogevia_prd. Never starts or stops a host. Never prints a secret. Connects to ogevia_sv_test only (hard-coded, checked).
set +x +H
umask 077
export AWS_PAGER="" AWS_DEFAULT_REGION=us-west-2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"
SQL="$HERE/STELLA_READONLY_VERIFICATION.sql"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$HOME/phaseC_${MODE}_${TS}.txt"

SHA=54894411f0e69ac29bec762006e47f7d943b94f2
MIG_SHA=d9c8cc372011e68221868767e83922da641457535e796b9de23b836881c568ee
DOWN_SHA=fe47381cb9c888e8cb541936dbd8402a550aac83b5926a64d736a1463f520e29
SET85_SHA=de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef
SET86_SHA=af15f5bb47d333b740375e0dbc3a9131fe416cc0ccb9f76d26e28759c8c33461
ROLLSET_SHA=be131bf6778c2331151290c5b126d134fa363e10c4f652f2a68e2e9da8db3c87
IID_EXPECT=i-0ce8db2d7e5839dd5; ADMIN_SG=sg-00e01e2ca80442c1f; APP_SG=sg-064ffce3bcbe8eb3b; RDS_SG=sg-00530a1f4f7648e65
RDS_ID=ogevia-prod-postgres; DB=ogevia_sv_test; ACCOUNT=300094796789; TAG=ogevia-db-admin-temp; LOCAL_PORT=15432
WIN_START=$(date -u -d "2026-10-31 16:00:00" +%s 2>/dev/null); WIN_END=$(date -u -d "2026-10-31 19:00:00" +%s 2>/dev/null)
EXPECT_BEFORE="85/0085"; EXPECT_AFTER="86/0086"; EXPECT_RA=5; EXPECT_CG=6
ATTACHED=0; TUNNEL=""; CLEANED=0; RDS_SRC_BEFORE=""

host_groups() { aws ec2 describe-instances --instance-ids "$IID_EXPECT" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text 2>/dev/null | tr '\t' '\n' | sort | tr '\n' ' ' | sed 's/ $//'; }
rds_sources() { aws ec2 describe-security-groups --group-ids "$RDS_SG" --query 'SecurityGroups[0].IpPermissions[].UserIdGroupPairs[].GroupId' --output text 2>/dev/null | tr '\t' '\n' | sort | tr '\n' ' ' | sed 's/ $//'; }
stop() { echo "STOP: $*"; exit 2; }
uri() { printf '%s' "$1" | jq -sRr @uri; }

cleanup() {                      # one time, on every exit: success, error, INT, TERM, HUP
  local rc=$?
  [[ "$CLEANED" == 1 ]] && exit "$rc"; CLEANED=1
  trap '' INT TERM HUP
  if [[ -n "$TUNNEL" ]]; then pkill -P "$TUNNEL" 2>/dev/null; kill "$TUNNEL" 2>/dev/null; wait "$TUNNEL" 2>/dev/null; fi
  unset PGPASSWORD PGUSER PGHOST PGPORT PGSSLMODE PGOPTIONS OGEVIA_DATABASE_URL OGEVIA_ALLOW_REMOTE_MIGRATION MASTER U P
  local bad=0
  if [[ "$ATTACHED" == 1 ]]; then
    echo "RESTORE: setting admin host groups back to $ADMIN_SG"
    aws ec2 modify-instance-attribute --instance-id "$IID_EXPECT" --groups "$ADMIN_SG" || { echo "!!! RESTORE COMMAND FAILED. Run by hand NOW: aws ec2 modify-instance-attribute --instance-id $IID_EXPECT --groups $ADMIN_SG"; bad=1; }
    sleep 3
    local g s; g="$(host_groups)"; s="$(rds_sources)"
    echo "RE-CHECK admin host groups: '$g' (expected '$ADMIN_SG')"; echo "RE-CHECK RDS SG sources: '$s' (expected '$RDS_SRC_BEFORE')"
    [[ "$g" == "$ADMIN_SG" ]] || { echo "!!! ADMIN HOST GROUPS NOT RESTORED/VERIFIED. Fix by hand NOW and tell the owner."; bad=1; }
    [[ -z "$RDS_SRC_BEFORE" || "$s" == "$RDS_SRC_BEFORE" ]] || { echo "!!! RDS SG SOURCES DIFFER FROM BEFORE. Change nothing; tell the owner."; bad=1; }
    [[ "$bad" == 0 ]] && echo "RESTORE VERIFIED: admin host back to baseline, RDS SG unchanged." || { echo "RESTORE NOT VERIFIED (see !!! lines)"; [[ "$rc" == 0 ]] && rc=1; }
  fi
  echo "END (UTC): $(date -u +%FT%TZ)  mode=$MODE  exit=$rc  log=$LOG"
  exit "$rc"
}
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP

in_window() { local n; n=$(date -u +%s); [[ -n "$WIN_START" && -n "$WIN_END" && "$n" -ge "$WIN_START" && "$n" -lt "$WIN_END" ]]; }
need_window() { in_window || stop "outside the authorized window (2026-10-31 09:00-12:00 PDT = 16:00-19:00 UTC). No new activity may begin. (rollback to known-good is the only exception)"; }
confirm() { local want="$1"; local got; echo; echo "$2"; printf 'Type exactly  %s  to continue: ' "$want" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$want" ]] || stop "confirmation not given"; }

check_repo() {
  [[ -n "${REPO:-}" && -d "$REPO/infra/aws/db/migrations" ]] || stop "set REPO to the checkout at $SHA with dependencies installed"
  [[ "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" == "$SHA" ]] || stop "REPO HEAD is not $SHA (the only approved commit)"
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "REPO has local changes"
  local m="$REPO/infra/aws/db/migrations" r="$REPO/infra/aws/db/rollback"
  [[ "$(sha256sum "$m/0086_caregiver_readiness_approve_for_work.sql" | cut -c1-64)" == "$MIG_SHA" ]] || stop "migration 0086 hash differs"
  [[ "$(sha256sum "$r/0086_caregiver_readiness_approve_for_work.down.sql" | cut -c1-64)" == "$DOWN_SHA" ]] || stop "rollback 0086 hash differs"
  [[ "$(cd "$m" && LC_ALL=C sha256sum -- $(ls *.sql | LC_ALL=C sort | head -85) | sha256sum | cut -c1-64)" == "$SET85_SHA" ]] || stop "0001-0085 set hash differs"
  [[ "$(cd "$m" && LC_ALL=C sha256sum -- *.sql | sha256sum | cut -c1-64)" == "$SET86_SHA" ]] || stop "all-86 set hash differs"
  [[ "$(cd "$r" && LC_ALL=C sha256sum -- 0086_caregiver_readiness_approve_for_work.down.sql | sha256sum | cut -c1-64)" == "$ROLLSET_SHA" ]] || stop "rollback set hash differs"
  [[ "$(ls "$m"/*.sql | wc -l)" == 86 ]] || stop "expected 86 migration files"
  echo "pins ok: commit $SHA, migration/rollback/set hashes match"
}

if [[ "$MODE" == selftest ]]; then
  echo "selftest (local only; no AWS, no database)"
  [[ -n "$WIN_START" && "$WIN_END" -gt "$WIN_START" && $((WIN_END-WIN_START)) == 10800 ]] && echo "window math ok: $(date -u -d @$WIN_START +%FT%TZ) to $(date -u -d @$WIN_END +%FT%TZ) (3 h)" || stop "window math"
  [[ "$(uri 'a b/c@d:e')" == "a%20b%2Fc%40d%3Ae" ]] && echo "uri-encoding ok" || stop "uri-encoding"
  in_window && echo "now: inside the window" || echo "now: outside the window (expected before 09:00 PDT)"
  [[ -n "${REPO:-}" ]] && check_repo || echo "REPO not set: pin check skipped (set REPO to test it)"
  echo "selftest done"; exit 0
fi
case "$MODE" in probe|snapshot|migrate|final|rollback) ;; *) stop "usage: selftest | probe | snapshot | migrate | final | rollback (see header)";; esac
exec > >(tee -a "$LOG") 2>&1
echo "START (UTC): $(date -u +%FT%TZ)  mode=$MODE  log=$LOG"
case "$MODE" in probe|snapshot|migrate) need_window;; esac
for c in aws jq; do command -v "$c" >/dev/null 2>&1 || stop "missing tool: $c"; done
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || stop "wrong AWS account"

snapshot_check() {   # read-only: the pre-0086 snapshot must exist, be available, encrypted, belong to this instance; "fresh" (migrate/snapshot) also requires age < 4 h
  [[ "${SNAPSHOT_ID:-}" == "$RDS_ID-pre-0086-"* ]] || stop "set SNAPSHOT_ID to the id printed by the snapshot mode ($RDS_ID-pre-0086-...)"
  local d; d=$(aws rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT_ID" --query 'DBSnapshots[0].[Status,Encrypted,DBInstanceIdentifier,SnapshotCreateTime]' --output text) || stop "snapshot not found"
  echo "snapshot: $SNAPSHOT_ID  $d"
  set -- $d; [[ "$1" == available && "$2" == True && "$3" == "$RDS_ID" ]] || stop "snapshot is not available/encrypted/for $RDS_ID"
  if [[ "${1:-}" == fresh ]]; then local t; t=$(date -u -d "$4" +%s 2>/dev/null) || stop "cannot read the snapshot time"; [[ $(( $(date -u +%s) - t )) -lt 14400 ]] || stop "snapshot is older than 4 hours"; fi
}

if [[ "$MODE" == snapshot ]]; then
  [[ "$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].DBInstanceStatus' --output text)" == available ]] || stop "RDS instance is not available"
  SNAP="$RDS_ID-pre-0086-$(date -u +%Y%m%dT%H%MZ | tr 'A-Z' 'a-z')"
  echo "creating snapshot $SNAP (GO step 3; one snapshot)"
  aws rds create-db-snapshot --db-instance-identifier "$RDS_ID" --db-snapshot-identifier "$SNAP" --query 'DBSnapshot.[DBSnapshotIdentifier,Status]' --output text || stop "create-db-snapshot failed"
  echo "waiting until available (this can take several minutes)..."
  aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAP" || stop "snapshot did not become available; do NOT migrate"
  SNAPSHOT_ID="$SNAP"; snapshot_check fresh; echo "SNAPSHOT_ID=$SNAP   <-- use this for migrate and rollback"; exit 0
fi

# ----- modes that touch the database: need the owner's G1 authorization, the host, the tunnel and the credential -----
for c in psql session-manager-plugin; do command -v "$c" >/dev/null 2>&1 || stop "missing tool: $c"; done
[[ -f "$SQL" ]] || stop "cannot find $SQL"
if [[ "$MODE" == migrate || "$MODE" == rollback ]]; then command -v pnpm >/dev/null 2>&1 || stop "missing tool: pnpm"; check_repo; if [[ "$MODE" == migrate ]]; then snapshot_check fresh; else snapshot_check; fi; fi
confirm "G1 AUTHORIZED" "This mode temporarily attaches AppSG $APP_SG to the admin host and uses the TEST database admin credential in memory only, on $DB. That needs the owner's WRITTEN G1 authorization (PHASE_C_RUN_SHEET.md). Do you have it?"
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$TAG" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].InstanceId' --output text)
[[ "$IID" == "$IID_EXPECT" ]] || stop "admin host is not the expected running instance ('$IID'). Do not start it."
[[ "$(host_groups)" == "$ADMIN_SG" ]] || stop "admin host groups are '$(host_groups)', expected only $ADMIN_SG"
RDS_SRC_BEFORE="$(rds_sources)"; [[ "$RDS_SRC_BEFORE" == "$APP_SG" ]] || stop "RDS SG sources are '$RDS_SRC_BEFORE', expected only $APP_SG"
RDS_HOST=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].Endpoint.Address' --output text)
MASTER_ARN=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
[[ -n "$RDS_HOST" && "$RDS_HOST" != None && "$MASTER_ARN" == arn:* ]] || stop "could not resolve RDS endpoint or secret ARN"
[[ "$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].PubliclyAccessible' --output text)" == False ]] || stop "RDS is publicly accessible: unexpected"

ATTACHED=1
aws ec2 modify-instance-attribute --instance-id "$IID" --groups "$ADMIN_SG" "$APP_SG" || stop "attach failed"
sleep 5
aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null 2>&1 &
TUNNEL=$!; UP=0
for _ in $(seq 1 30); do kill -0 "$TUNNEL" 2>/dev/null || stop "tunnel process exited"; if (exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then UP=1; break; fi; sleep 1; done
[[ "$UP" == 1 ]] || stop "tunnel did not accept connections within 30 seconds"
unset PGSERVICE PGSERVICEFILE PGDATABASE PGPASSFILE PGUSER PGPASSWORD
MASTER=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" --query SecretString --output text 2>/dev/null) || stop "could not read the secret"
U="$(printf '%s' "$MASTER" | jq -r .username)"; P="$(printf '%s' "$MASTER" | jq -r .password)"; unset MASTER
[[ -n "$U" && "$U" != null && -n "$P" && "$P" != null ]] || stop "secret lacks username/password"
export PGHOST=127.0.0.1 PGPORT="$LOCAL_PORT" PGSSLMODE=require PGUSER="$U" PGPASSWORD="$P" PGOPTIONS="-c statement_timeout=120000"
echo "LOGIN ROLE USED (name only): $U"
GOT=$(psql -X -At -d "$DB" -c "select current_database()") || stop "connection to $DB failed"; [[ "$GOT" == "$DB" ]] || stop "connected database is '$GOT', not $DB"
echo "guard ok: $GOT"

ro() { PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000" psql -X -At -d "$DB" -c "begin read only;" -c "set local role ogevia_readonly;" -c "$1" -c "rollback;" 2>&1 | grep -v -E '^(BEGIN|SET|ROLLBACK)$'; }
state() {
  LEDGER=$(ro "select count(*)||'/'||max(version) from ogevia_meta.schema_migrations")
  HAS86=$(ro "select coalesce(to_regclass('ogevia.caregiver_work_approvals')::text,'absent')")
  RA=$(ro "select count(*) filter (where status in ('ready','active'))||'/'||count(*) from ogevia.caregiver_records where deleted_at is null")
  ENF=$(ro "select count(*) from ogevia.organization_readiness_settings where enforcement_active_from is not null")
  echo "state: ledger=$LEDGER  0086table=$HAS86  ready_or_active/caregivers=$RA  orgs_enforcing=$ENF"
}
assert_before() { state; [[ "$LEDGER" == "$EXPECT_BEFORE" && "$HAS86" == absent && "$RA" == "$EXPECT_RA/$EXPECT_CG" && "$ENF" == 0 ]] || stop "state differs from the Part 2 baseline ($EXPECT_BEFORE, absent, $EXPECT_RA/$EXPECT_CG, 0). Nothing was changed."; echo "BASELINE MATCHES"; }
assert_after() {
  state; LEG=$(ro "select count(*) from ogevia.caregiver_work_approvals where source='legacy_status'"); echo "legacy_status approvals=$LEG"
  [[ "$LEDGER" == "$EXPECT_AFTER" && "$HAS86" != absent && "$RA" == "$EXPECT_RA/$EXPECT_CG" && "$ENF" == 0 && "$LEG" == "$EXPECT_RA" ]] || { echo "!!! POST-STATE DOES NOT MATCH ($EXPECT_AFTER, table present, $EXPECT_RA/$EXPECT_CG, enforcement 0, legacy $EXPECT_RA). STOP; do not deploy. Roll back only on a stop condition."; return 1; }
  echo "POST-STATE MATCHES"
}
run_sql_record() { echo "--- STELLA_READONLY_VERIFICATION.sql output"; PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000" psql -X -v ON_ERROR_STOP=1 -d "$DB" -f "$SQL"; }
dburl() { printf 'postgres://%s:%s@127.0.0.1:%s/%s?sslmode=no-verify' "$(uri "$U")" "$(uri "$P")" "$LOCAL_PORT" "$DB"; }   # tunnel to RDS: TLS on, certificate name check off (host is 127.0.0.1)

case "$MODE" in
  probe)   assert_before && run_sql_record ;;
  final)   state; run_sql_record ;;
  migrate)
    assert_before || exit 2
    confirm "MIGRATE 0086" "About to apply migration 0086 (only) to $DB. Snapshot $SNAPSHOT_ID is verified. Window ends 12:00 PDT."
    OUTF="$(mktemp)"
    ( cd "$REPO" && env -u PGOPTIONS -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGSSLMODE OGEVIA_DATABASE_URL="$(dburl)" OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner pnpm --filter @carelik/infra-aws db:migrate ) > "$OUTF" 2>&1; RC=$?
    sed -E 's#postgres://[^ ]*#postgres://<redacted>#g' "$OUTF"
    [[ "$RC" == 0 ]] && grep -q "applied 1, already applied 85" "$OUTF" || { rm -f "$OUTF"; stop "migrate exit=$RC or output is not 'applied 1, already applied 85'. Check the log; roll back only on a stop condition."; }
    ( cd "$REPO" && env -u PGOPTIONS -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGSSLMODE OGEVIA_DATABASE_URL="$(dburl)" pnpm --filter @carelik/infra-aws db:verify ) > "$OUTF" 2>&1; RC=$?
    sed -E 's#postgres://[^ ]*#postgres://<redacted>#g' "$OUTF"; rm -f "$OUTF"
    [[ "$RC" == 0 ]] || stop "db:verify failed (exit $RC)"
    assert_after || exit 3
    run_sql_record ;;
  rollback)
    echo "ROLLBACK drops caregiver_work_approvals, caregiver_cpr_tb_extensions, caregiver_contacts, organization_compliance_settings WITH their rows. Snapshot $SNAPSHOT_ID exists. Allowed after the window only to restore known-good (A12). Restoring the snapshot itself is NOT authorized."
    confirm "ROLLBACK 0086" "Only after a stop condition, and web and API have been rolled back first (run sheet)."
    OUTF="$(mktemp)"
    ( cd "$REPO" && env -u PGOPTIONS -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGSSLMODE OGEVIA_DATABASE_URL="$(dburl)" OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner pnpm --filter @carelik/infra-aws db:rollback-to 0086 --expect-set-sha "$ROLLSET_SHA" ) > "$OUTF" 2>&1; RC=$?
    sed -E 's#postgres://[^ ]*#postgres://<redacted>#g' "$OUTF"; rm -f "$OUTF"
    [[ "$RC" == 0 ]] || stop "rollback exit=$RC; do not retry; report"
    assert_before ;;
esac
