#!/usr/bin/env bash
# Phase C DATABASE script for the UX redesign release: pending migrations 0090 to 0094 on the TEST database ONLY. Derived from STELLA_PHASE_C_DB.sh (2026-11-01) with the same access, TLS, cleanup
# and guard mechanics. DRAFT. NOT RUN. NOT AUTHORIZED. Operator: whoever the owner names in the written Phase C statement.
# Authority needed BEFORE any mode except selftest: the owner's written Phase C statement (commit f4316c5..., TEST only, operator, window) AND the owner's explicit G1-style authorization for the temporary
# security-group attach and the TEST admin credential held in memory only (this script does exactly that, as the 0088 script did; that earlier approval does NOT carry over).
#
#   bash OPERATOR_TEST_DB.sh selftest                          local only: pin and logic checks, no AWS, no database
#   export OGEVIA_WINDOW_START="YYYY-MM-DD HH:MM:SS" OGEVIA_WINDOW_END="YYYY-MM-DD HH:MM:SS"   (UTC, from the owner's statement; no default: nothing runs without it)
#   REPO=<checkout at the pinned SHA> bash OPERATOR_TEST_DB.sh probe        S2: read-only baseline: ledger 88/0088 and NONE of the new objects (VERIFY_0090_0094.sql expect=absent)
#   bash OPERATOR_TEST_DB.sh backup                          S4: TEST-only logical dump; prints its path
#   REPO=... OGEVIA_TEST_BACKUP=<path> bash OPERATOR_TEST_DB.sh apply   S5: apply 0090, 0091, 0092, 0093, 0094 in that order, each in its own transaction, then VERIFY expect=present
#   bash OPERATOR_TEST_DB.sh final                             S10: read-only closing read
#   REPO=... OGEVIA_TEST_BACKUP=<path> bash OPERATOR_TEST_DB.sh rollback   only after a stop condition: down scripts 0094 -> 0090 (web and API rolled back first)
# Never touches ogevia_prd. Never starts or stops a host. Never prints a secret. Connects to ogevia_sv_test only (hard-coded, checked). Records each migration checksum in the ledger in the same transaction.
set +x +H
umask 077
export AWS_PAGER="" AWS_DEFAULT_REGION=us-west-2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"
VSQL="$HERE/VERIFY_0090_0094.sql"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$HOME/phaseC_ux_${MODE}_${TS}.txt"

SHA=f4316c5f1a9a844dc7749152243271cee003e94c
MIGS=(0090_caregiver_signin_override 0091_caregiver_client_labels 0092_bulk_import 0093_staff_duplicates 0094_standard_document_types)
declare -A UP_SHA=( [0090_caregiver_signin_override]=963d8cf4e7c8bdfa7da38d2719d4a4be2f7dafd7ab50e371c4e2ae1a567dfe54 [0091_caregiver_client_labels]=673dea984d97433cad1df663a890233acb2d240eb87abb8434db655d9a7596f3 [0092_bulk_import]=2dc18c125b459750431981dad2dd257630c6864e5ed41102770e6d9d1f992121 [0093_staff_duplicates]=952e1c9176ecee8b9475fd45f923fdff175bf78de14341a61b46e49d9f28affa [0094_standard_document_types]=b0a28f483462a826aac0c9bb1e8e7b4ad8d26bfea80156668ab80874508f8d91 )
declare -A DOWN_SHA=( [0090_caregiver_signin_override]=75cc1db8b9af4f4d61e909f8eb5e8245b88c5c71032ad35bcf41f49b9779a56e [0091_caregiver_client_labels]=843580f116fb7a682da1c1313c605aa7db507e1186ce60b8176d9b68d03f385d [0092_bulk_import]=b6e96f069b28a7e790869ef5e02f1a9ae7da6dd72cb5eb71661e66f0dd2ff09a [0093_staff_duplicates]=24fe53618b70ab48b519813021fd06ce8f8671d9fa0aa32b16449b61caf839ff [0094_standard_document_types]=1d0cbfe10b6b20baf2af221e3812949603332029a1343cc214238b7ddca67d44 )
PEND_UP_SET=dc971a797a07aa4b2d1bfe9b6a5aa60f987d19380983aec126ceefefb4faca06
PEND_DOWN_SET=b0bb79933c75defa1a680ccafe73ad088a4f45418024a9c5b6dd40e633660b44
SET88_SHA=049c52cb3cbc0c90efad7003967d8bfe8297cd771d2d471d5b42506a889e372c         # all 88 released migration files (unchanged since the 0088 release)
VSQL_SHA=f8d574c4f5f9025315383f40b6bb1e2c117dc829d314cba1c9490e863557d66c
IID_EXPECT=i-0ce8db2d7e5839dd5; ADMIN_SG=sg-00e01e2ca80442c1f; APP_SG=sg-064ffce3bcbe8eb3b; RDS_SG=sg-00530a1f4f7648e65     # last recorded values: the read-only checks U1/U2 must confirm them; the script stops if live state differs
RDS_ID=ogevia-prod-postgres; DB=ogevia_sv_test; ACCOUNT=300094796789; TAG=ogevia-db-admin-temp; LOCAL_PORT=15432
WIN_START_TXT="${OGEVIA_WINDOW_START:-}"; WIN_END_TXT="${OGEVIA_WINDOW_END:-}"
WIN_START=$(date -u -d "$WIN_START_TXT" +%s 2>/dev/null); WIN_END=$(date -u -d "$WIN_END_TXT" +%s 2>/dev/null)
EXPECT_LEDGER="88/0088"

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
  unset PGPASSWORD PGUSER PGHOST PGHOSTADDR PGPORT PGSSLMODE PGSSLROOTCERT PGOPTIONS OGEVIA_DATABASE_URL OGEVIA_ALLOW_REMOTE_MIGRATION MASTER U P
  [[ -n "$TLSDIR" ]] && rm -rf "$TLSDIR"
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
  if [[ "$MODE" =~ ^(probe|backup|apply)$ && -n "$WIN_END" ]] && ! in_window; then echo "NOTE: this step finished after the window end (at the end of the authorized window). It was allowed to complete (A12 forbids BEGINNING new activity). Start NO further step; report. Rollback to known-good only."; fi
  echo "END (UTC): $(date -u +%FT%TZ)  mode=$MODE  exit=$rc  log=$LOG"
  exit "$rc"
}
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP


in_window() { local n; n=$(date -u +%s); [[ -n "$WIN_START" && -n "$WIN_END" && "$n" -ge "$WIN_START" && "$n" -lt "$WIN_END" ]]; }
need_window() { in_window || stop "outside the authorized window ('${WIN_START_TXT:-unset}' to '${WIN_END_TXT:-unset}' UTC). Set OGEVIA_WINDOW_START and OGEVIA_WINDOW_END from the owner's written statement. No new activity may begin outside it (rollback to known-good is the only exception)"; }
confirm() { local want="$1"; local got; echo; echo "$2"; printf 'Type exactly  %s  to continue: ' "$want" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$want" ]] || stop "confirmation not given"; }

check_repo() {
  [[ -n "${REPO:-}" && -d "$REPO/infra/aws/db/pending/migrations" ]] || stop "set REPO to the checkout at $SHA with dependencies installed"
  [[ "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" == "$SHA" ]] || stop "REPO HEAD is not $SHA (the only approved commit)"
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "REPO has local changes"
  local p="$REPO/infra/aws/db/pending" m="$REPO/infra/aws/db/migrations" n
  for n in "${MIGS[@]}"; do
    [[ "$(sha256sum "$p/migrations/$n.sql" | cut -c1-64)" == "${UP_SHA[$n]}" ]] || stop "migration $n differs from the pinned bytes"
    [[ "$(sha256sum "$p/rollback/$n.down.sql" | cut -c1-64)" == "${DOWN_SHA[$n]}" ]] || stop "rollback $n differs from the pinned bytes"
  done
  [[ "$(ls "$p/migrations"/*.sql | wc -l)" == 5 && "$(ls "$p/rollback"/*.sql | wc -l)" == 5 ]] || stop "expected exactly 5 pending migrations and 5 rollbacks"
  [[ "$(cd "$p/migrations" && LC_ALL=C sha256sum -- *.sql | sha256sum | cut -c1-64)" == "$PEND_UP_SET" ]] || stop "pending migration set hash differs"
  [[ "$(cd "$p/rollback" && LC_ALL=C sha256sum -- *.sql | sha256sum | cut -c1-64)" == "$PEND_DOWN_SET" ]] || stop "pending rollback set hash differs"
  [[ "$(cd "$m" && LC_ALL=C sha256sum -- *.sql | sha256sum | cut -c1-64)" == "$SET88_SHA" ]] || stop "the 88 released migrations differ from the pinned set"
  [[ "$(ls "$m"/*.sql | wc -l)" == 88 ]] || stop "expected 88 released migration files"
  [[ "$(sha256sum "$VSQL" | cut -c1-64)" == "$VSQL_SHA" ]] || stop "VERIFY_0090_0094.sql differs from the pinned bytes"
  echo "pins ok: commit $SHA, 5 migrations + 5 rollbacks + sets + 88 released + verify SQL"
}

if [[ "$MODE" == selftest ]]; then
  echo "selftest (local only; no AWS, no database)"
  [[ -f "$VSQL" ]] || stop "VERIFY_0090_0094.sql is missing next to this script"
  [[ "$(sha256sum "$VSQL" | cut -c1-64)" == "$VSQL_SHA" ]] && echo "verify SQL pin ok" || stop "VERIFY_0090_0094.sql differs from the pinned bytes"
  [[ "$(uri 'a b/c@d:e')" == "a%20b%2Fc%40d%3Ae" ]] && echo "uri-encoding ok" || stop "uri-encoding"
  if [[ -n "$WIN_START" && -n "$WIN_END" && "$WIN_END" -gt "$WIN_START" ]]; then echo "window math ok: $(date -u -d @$WIN_START +%FT%TZ) to $(date -u -d @$WIN_END +%FT%TZ)"; in_window && echo "now: inside the window" || echo "now: outside the window"; else echo "window not set (expected before the owner's statement): every other mode will refuse to run"; fi
  [[ -n "${REPO:-}" ]] && check_repo || echo "REPO not set: pin check skipped (set REPO to test it)"
  echo "selftest done"; exit 0
fi
case "$MODE" in probe|backup|snapshot|apply|final|rollback) ;; *) stop "usage: selftest | probe | backup | apply | final | rollback (see header)";; esac
exec > >(tee -a "$LOG") 2>&1
echo "START (UTC): $(date -u +%FT%TZ)  mode=$MODE  log=$LOG"
case "$MODE" in probe|backup|apply|final) need_window;; esac
for c in aws jq; do command -v "$c" >/dev/null 2>&1 || stop "missing tool: $c"; done
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || stop "wrong AWS account"

# Instance snapshots also contain production on the recorded shared server. They are deliberately not offered here.
[[ "$MODE" != snapshot ]] || stop "An RDS snapshot includes production on the shared instance. Use backup (TEST-only logical dump)."
backup_check() {
  [[ "${OGEVIA_TEST_BACKUP:-}" == /* && -f "$OGEVIA_TEST_BACKUP" && -f "$OGEVIA_TEST_BACKUP.sha256" && -f "$OGEVIA_TEST_BACKUP.meta" ]] || stop "set OGEVIA_TEST_BACKUP to the TEST backup printed by backup mode"
  sha256sum --check --status "$OGEVIA_TEST_BACKUP.sha256" || stop "TEST backup checksum mismatch"
  local dbname made; IFS='|' read -r dbname made < "$OGEVIA_TEST_BACKUP.meta"
  [[ "$dbname" == "$DB" && "$made" =~ ^[0-9]+$ ]] || stop "backup metadata is not for TEST"
  if [[ "$MODE" == apply ]]; then [[ $(( $(date -u +%s) - made )) -ge 0 && $(( $(date -u +%s) - made )) -lt 14400 ]] || stop "TEST backup is older than 4 hours"; fi
  [[ "$(pg_restore --list "$OGEVIA_TEST_BACKUP" | sed -n 's/^;[[:space:]]*dbname: //p')" == "$DB" ]] || stop "archive is not a TEST database backup"
}
for c in psql pg_dump pg_restore session-manager-plugin; do command -v "$c" >/dev/null 2>&1 || stop "missing tool: $c"; done
[[ -f "$VSQL" ]] || stop "cannot find $VSQL"
if [[ "$MODE" == apply || "$MODE" == rollback ]]; then check_repo; backup_check; fi
if [[ "$MODE" == rollback ]]; then
  confirm "OWNER AUTHORIZED DB ROLLBACK ACCESS" "A DATABASE ROLLBACK needs the temporary security-group attach and the TEST admin credential. Type the phrase only if the owner has authorized it for this release, in writing. Down scripts run newest first: 0094, 0093, 0092, 0091, 0090."
else
  confirm "G1 AUTHORIZED" "This mode temporarily attaches AppSG $APP_SG to the admin host and uses the TEST database admin credential in memory only, on $DB, WITHIN THE WINDOW. Do you have the owner's written authorization for THIS release (the 0088 approval does not carry over)?"
fi
[[ "$IID" == "$IID_EXPECT" ]] || stop "admin host is not the expected running instance ('$IID'). Do not start it."
[[ "$(host_groups)" == "$ADMIN_SG" ]] || stop "admin host groups are '$(host_groups)', expected only $ADMIN_SG"
RDS_SRC_BEFORE="$(rds_sources)"; [[ "$RDS_SRC_BEFORE" == "$APP_SG" ]] || stop "RDS SG sources are '$RDS_SRC_BEFORE', expected only $APP_SG"
RDS_HOST=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].Endpoint.Address' --output text)
MASTER_ARN=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
[[ -n "$RDS_HOST" && "$RDS_HOST" != None && "$MASTER_ARN" == arn:* ]] || stop "could not resolve RDS endpoint or secret ARN"
[[ "$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].PubliclyAccessible' --output text)" == False ]] || stop "RDS is publicly accessible: unexpected"

# ---- full TLS verification through the tunnel (verify-full): the certificate is checked against the RDS host NAME, the bytes go to 127.0.0.1 ----
TLSDIR=""
tls_setup() {
  TLSDIR="$(mktemp -d)"; chmod 700 "$TLSDIR"
  curl -fsS --max-time 60 -o "$TLSDIR/rds-global-bundle.pem" https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem || stop "cannot download the RDS CA bundle (no fallback to unverified TLS; report to the owner)"
  [[ "$(grep -c 'BEGIN CERTIFICATE' "$TLSDIR/rds-global-bundle.pem")" -ge 20 ]] || stop "the RDS CA bundle looks wrong"
  echo "RDS CA bundle sha256: $(sha256sum "$TLSDIR/rds-global-bundle.pem" | cut -c1-64) (author's download 2026-10-31 had 174560 bytes; a later AWS update may differ: record it)"
  cat > "$TLSDIR/resolve-rds.cjs" <<'JS'
// Node preload: resolve ONLY the RDS host name to 127.0.0.1 (the SSM tunnel end); every other name resolves normally.
const dns = require("node:dns"); const HOST = process.env.OGEVIA_TUNNEL_HOST, orig = dns.lookup;
if (HOST) dns.lookup = function (h, o, cb) { if (typeof o === "function") { cb = o; o = {}; }
  if (h === HOST) { return (o && o.all) ? process.nextTick(cb, null, [{ address: "127.0.0.1", family: 4 }]) : process.nextTick(cb, null, "127.0.0.1", 4); }
  return orig.call(dns, h, o, cb); };
JS
}
tls_setup   # before any change: a failed download stops here with nothing attached
ATTACHED=1
aws ec2 modify-instance-attribute --instance-id "$IID" --groups "$ADMIN_SG" "$APP_SG" || stop "attach failed"
sleep 5
aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null 2>&1 &
TUNNEL=$!; UP=0
for _ in $(seq 1 30); do kill -0 "$TUNNEL" 2>/dev/null || stop "tunnel process exited"; if (exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then UP=1; break; fi; sleep 1; done
[[ "$UP" == 1 ]] || stop "tunnel did not accept connections within 30 seconds"
unset PGSERVICE PGSERVICEFILE PGDATABASE PGPASSFILE PGUSER PGPASSWORD PGHOSTADDR PGSSLROOTCERT
MASTER=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" --query SecretString --output text 2>/dev/null) || stop "could not read the secret"
U="$(printf '%s' "$MASTER" | jq -r .username)"; P="$(printf '%s' "$MASTER" | jq -r .password)"; unset MASTER
[[ -n "$U" && "$U" != null && -n "$P" && "$P" != null ]] || stop "secret lacks username/password"
export PGHOST="$RDS_HOST" PGHOSTADDR=127.0.0.1 PGPORT="$LOCAL_PORT" PGSSLMODE=verify-full PGSSLROOTCERT="$TLSDIR/rds-global-bundle.pem" PGUSER="$U" PGPASSWORD="$P" PGOPTIONS="-c statement_timeout=120000"
echo "LOGIN ROLE USED (name only): $U"
GOT=$(psql -X -At -d "$DB" -c "select current_database()") || stop "connection to $DB failed"; [[ "$GOT" == "$DB" ]] || stop "connected database is '$GOT', not $DB"
echo "guard ok: $GOT"

ro() { PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000" psql -X -At -d "$DB" -c "begin read only;" -c "set local role ogevia_readonly;" -c "$1" -c "rollback;" 2>&1 | grep -v -E '^(BEGIN|ROLLBACK|SET)$'; }
state() { LEDGER=$(ro "select count(*)||'/'||max(version) from ogevia_meta.schema_migrations"); echo "state: ledger=$LEDGER (expected baseline $EXPECT_LEDGER; applied UX ledger 93/0094)"; }
# VERIFY_0090_0094.sql: one row per check, name|t|detail; a row containing |f| fails. expect=absent before, expect=present after.
vrun() { local want="$1" out n bad
  out=$(PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=60000" psql -X -At -F '|' -d "$DB" -v expect="$want" -c "begin read only;" -f "$VSQL" -c "rollback;" 2>&1 | grep -v -E '^(BEGIN|ROLLBACK|SET)$')
  n=$(printf '%s\n' "$out" | grep -c '|'); bad=$(printf '%s\n' "$out" | grep -c '|f|')
  echo "VERIFY_0090_0094.sql expect=$want: $n checks, $bad failing"
  if [[ "$n" -lt 40 || "$bad" != 0 ]]; then printf '%s\n' "$out" | grep '|f|' | head -8; [[ "$n" -lt 40 ]] && { echo "too few check rows; first lines:"; printf '%s\n' "$out" | head -5; }; return 1; fi
  return 0
}
before_ok() { state; [[ "$LEDGER" == "$EXPECT_LEDGER" ]] || stop "ledger is $LEDGER, expected $EXPECT_LEDGER: TEST is not the baseline this release was prepared for"; vrun absent || stop "some of the new objects already exist, or the baseline differs; do NOT apply"; }
after_ok()  { state; [[ "$LEDGER" == "93/0094" ]] || { echo "!!! ledger changed to $LEDGER"; return 1; }; vrun present || { echo "!!! POST-STATE DOES NOT MATCH"; return 1; }; echo "POST-STATE MATCHES"; }
guarded_psql() { # file, migration stem, apply|rollback; SQL and ledger change commit together
  local file="$1" stem="$2" direction="$3" version="${2:0:4}" checksum="${UP_SHA[$2]}"
  local before after
  before="select pg_advisory_xact_lock(4317001);"
  if [[ "$direction" == apply ]]; then
    before+=" do \$\$ begin if exists (select 1 from ogevia_meta.schema_migrations where version = '$version') then raise exception 'Migration already recorded; do not reapply'; end if; end \$\$;"
    after="insert into ogevia_meta.schema_migrations(version,name,checksum) values ('$version','$stem.sql','$checksum');"
  else
    before+=" do \$\$ begin if not exists (select 1 from ogevia_meta.schema_migrations where version = '$version' and checksum = '$checksum' and name = '$stem.sql') then raise exception 'Missing or changed migration ledger row'; end if; end \$\$;"
    after="delete from ogevia_meta.schema_migrations where version = '$version';"
  fi
  psql -X -v ON_ERROR_STOP=1 -1 -d "$DB" -c "$before" -c "set local role ogevia_owner" -f "$file" -c "reset role" -c "$after" 2>&1 | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'; return "${PIPESTATUS[0]}";
}

case "$MODE" in
  backup)
    before_ok
    OGEVIA_TEST_BACKUP="${OGEVIA_TEST_BACKUP:-$HOME/ogevia_sv_test-pre-ux-$TS.dump}"
    [[ ! -e "$OGEVIA_TEST_BACKUP" ]] || stop "backup file already exists; refusing to overwrite"
    pg_dump --no-password --format=custom --dbname="$DB" --file="$OGEVIA_TEST_BACKUP" || stop "TEST backup failed"
    sha256sum -- "$OGEVIA_TEST_BACKUP" > "$OGEVIA_TEST_BACKUP.sha256"
    printf '%s|%s\n' "$DB" "$(date -u +%s)" > "$OGEVIA_TEST_BACKUP.meta"
    backup_check
    echo "OGEVIA_TEST_BACKUP=$OGEVIA_TEST_BACKUP" ;;
  probe) before_ok ;;
  final) after_ok ;;
  apply)
    before_ok
    confirm "APPLY 0090-0094" "About to apply, in this order and each in its own transaction, to $DB only: ${MIGS[*]}. TEST logical backup $OGEVIA_TEST_BACKUP is verified. Each checksum is recorded atomically in the migration ledger. Window ends $WIN_END_TXT UTC."
    DONE=()
    for n in "${MIGS[@]}"; do
      echo "--- applying $n (sha256 ${UP_SHA[$n]:0:16}...)"
      if guarded_psql "$REPO/infra/aws/db/pending/migrations/$n.sql" "$n" apply; then DONE+=("$n"); else
        echo "!!! $n FAILED and its transaction was rolled back. Applied before it: ${DONE[*]:-none}."
        echo "!!! Do not continue. Report to the owner. If anything in the applied list must be undone, use the rollback mode (newest first)."; exit 3; fi
    done
    after_ok || exit 3 ;;
  rollback)
    echo "ROLLBACK drops caregiver_signin_overrides, import_batches, staff_merge_links WITH their rows (0090, 0092, 0093 are BACKUP REQUIRED: the TEST backup is $OGEVIA_TEST_BACKUP). Records created by imports and merges stay. Merged staff profiles stay inactive."
    confirm "ROLLBACK 0094-0090" "Only after a stop condition, and web and API have been rolled back first."
    for n in 0094_standard_document_types 0093_staff_duplicates 0092_bulk_import 0091_caregiver_client_labels 0090_caregiver_signin_override; do
      if [[ "$(ro "select count(*) from ogevia_meta.schema_migrations where version = '${n:0:4}'")" == 0 ]]; then
        echo "--- $n not recorded; nothing to roll back"; continue
      fi
      echo "--- rolling back $n"; guarded_psql "$REPO/infra/aws/db/pending/rollback/$n.down.sql" "$n" rollback || stop "rollback of $n failed; do not retry; report"
    done
    state; vrun absent || stop "after the rollback the verification does not show the baseline: report" ;;
esac
