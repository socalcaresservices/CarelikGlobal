#!/usr/bin/env bash
# =============================================================================
# Ogevia Phase 7 remediation (AWS TEST account 300094796789, us-west-2).
# Closes the gaps from phase7_evidence.py 2026-10-03 (GAP C6 D2 D4 G1 G3,
# MANUAL E3). Nothing changes until you type the approval word for each part.
#
#   APPLY  (one approval, all reversible, $0 or near-$0):
#     R1  subscribe your inbox to the alarm topic (G1); you confirm the email
#     R8  account-wide S3 public access block (D2). Pre-checks every bucket's
#         policy status and ACL in its own region; any public or unreadable
#         result blocks R8. Saves the current account setting first and writes
#         an exact rollback script; rolls back by itself if verification fails.
#     R9  GuardDuty in us-west-2 (G3); 30-day free trial, then usage-based
#   DRILL  (separate approval: it creates, then deletes, a temporary database):
#     R7  restore ogevia-prod-postgres to a NEW instance ogevia-restore-drill-<time>,
#         check it read-only through the admin host, record the timings, delete
#         ONLY that drill instance. The production instance is never modified.
#   Then: re-runs ~/phase7_evidence.py (if present) for the updated summary.
#
# Not here: C6 flow logs (a CDK change, recommended), D4 secret rotation
# (owner decision: manual 90-day rotation for the pilot).
# Log: ~/ogevia-phase7/remediate-<UTC>.log. Results: ~/ogevia-phase7/restore-drill-<UTC>.txt
# =============================================================================
set -uo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
ACCOUNT=300094796789
RDS_ID=ogevia-prod-postgres
APP_SG=sg-064ffce3bcbe8eb3b
ADMIN_TAG=ogevia-db-admin-temp
OBS_STACK=Ogevia-prod-Observability
WEB_STACK=Ogevia-prod-WebHosting
LOCAL_PORT=${OGEVIA_DRILL_LOCAL_PORT:-15433}
OUT="$HOME/ogevia-phase7"; mkdir -p "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$OUT/remediate-$STAMP.log"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap '' PIPE
STEP=start
say() { { printf '%s\n' "$*" >&3; } 2>/dev/null; printf '%s\n' "$*" >> "$LOG"; }
stop() { STOPPED=1; say "STOP in \"$STEP\": $*"; say "Log: $LOG"; exit 1; }
step() { STEP="$1"; echo; echo "== $1"; }
RESULTS=()
result() { RESULTS+=("$1"); echo "-> $1"; }

# Always-run cleanup for the drill: close the tunnel, restore the admin host's
# security groups. The drill instance itself is deleted explicitly (step D4).
TUNNEL=""; IID=""; ORIG_SGS=""
cleanup() {
  local rc=$?
  [[ -n "$TUNNEL" ]] && kill "$TUNNEL" 2>/dev/null
  pkill -f "session-manager-plugin.*${IID:-none}" 2>/dev/null
  unset PGPASSWORD
  if [[ -n "$IID" && -n "$ORIG_SGS" ]]; then
    local now
    now=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text 2>/dev/null | tr -s ' \t' '\n' | sort | xargs)
    if [[ "$now" != "$(tr -s ' \t' '\n' <<<"$ORIG_SGS" | sort | xargs)" ]]; then
      # shellcheck disable=SC2086
      aws ec2 modify-instance-attribute --instance-id "$IID" --groups $ORIG_SGS \
        && say "Admin host security groups restored: $ORIG_SGS" \
        || say "WARNING: restore the admin host's security groups to: $ORIG_SGS (EC2 console)"
    fi
  fi
  if [[ -n "${DRILL_ID:-}" && -z "${DRILL_DELETED:-}" ]]; then
    say "NOTE: drill instance $DRILL_ID still exists. It is a throwaway copy; delete it in the RDS console (no final snapshot) or paste this block again."
  fi
  [[ $rc != 0 && -z "${STOPPED:-}" && -z "${FINISHED:-}" ]] && say "EXITED UNEXPECTEDLY in \"$STEP\" (exit $rc). Log: $LOG"
}
trap cleanup EXIT

step "0 Identity"
ARN=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null) || stop "AWS credentials are not valid: sign in again and reopen CloudShell (us-west-2)"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || stop "wrong AWS account (expected $ACCOUNT)"
[[ "$ARN" == *AdministratorAccess* ]] || stop "this needs the AdministratorAccess role (current: $ARN)"
echo "Account $ACCOUNT, us-west-2, AdministratorAccess: OK"
[[ -t 0 ]] || stop "run this from an interactive CloudShell terminal"

# ---------------------------------------------------------------------------
step "1 Plan (read-only checks first)"
TOPIC=$(aws cloudformation list-stack-resources --stack-name "$OBS_STACK" --output json | jq -r '[.StackResourceSummaries[] | select(.ResourceType == "AWS::SNS::Topic" and (.LogicalResourceId | startswith("")))] | if length == 1 then .[0].PhysicalResourceId else "" end') || stop "cannot read the alarm topic"
[[ "$TOPIC" == arn:aws:sns:* ]] || stop "alarm topic not found in $OBS_STACK"
echo "Alarm topic: $TOPIC"
# R8 pre-check (read-only). Every bucket's policy status and ACL are read in
# the bucket's own region. A public result skips R8; an unreadable result also
# skips R8 (never treated as "not public"). The current account-level setting
# is saved first, with a rollback script that restores it exactly.
R8_STATE=ready; R8_PUBLIC=""; R8_UNREADABLE=""; R8_OBJACL=""
s3err() { grep -oE '\([A-Za-z]+\)' <<<"$1" | head -1 | tr -d '()'; }
if ! BUCKETS=$(aws s3api list-buckets --query 'Buckets[].Name' --output text 2>&1); then
  R8_UNREADABLE="list-buckets($(s3err "$BUCKETS")) "; BUCKETS=""
fi
for b in $BUCKETS; do
  if ! loc=$(aws s3api get-bucket-location --bucket "$b" --query LocationConstraint --output text 2>&1); then
    R8_UNREADABLE+="$b(location:$(s3err "$loc")) "; continue
  fi
  case "$loc" in None|null|"") br=us-east-1 ;; EU) br=eu-west-1 ;; *) br=$loc ;; esac
  if ! ps=$(aws s3api get-bucket-policy-status --bucket "$b" --region "$br" --query PolicyStatus.IsPublic --output text 2>&1); then
    if [[ "$(s3err "$ps")" == NoSuchBucketPolicy ]]; then ps=False; else R8_UNREADABLE+="$b(policy:$(s3err "$ps")) "; continue; fi
  fi
  if ! acl=$(aws s3api get-bucket-acl --bucket "$b" --region "$br" --query 'Grants[].Grantee.URI' --output text 2>&1); then
    R8_UNREADABLE+="$b(acl:$(s3err "$acl")) "; continue
  fi
  own=$(aws s3api get-bucket-ownership-controls --bucket "$b" --region "$br" --query 'OwnershipControls.Rules[0].ObjectOwnership' --output text 2>/dev/null) || own=none
  why=""
  [[ "$ps" == True ]] && why+="policy,"
  grep -qE 'global/(AllUsers|AuthenticatedUsers)' <<<"$acl" && why+="acl,"
  [[ -n "$why" ]] && R8_PUBLIC+="$b(${why%,}) "
  [[ "$own" != BucketOwnerEnforced ]] && R8_OBJACL+="$b "
done
PAB_FILE="$OUT/account-public-access-block-before-$STAMP.json"
PAB_ROLLBACK="$OUT/account-public-access-block-rollback-$STAMP.sh"
if pab=$(aws s3control get-public-access-block --account-id "$ACCOUNT" --output json 2>&1); then
  if jq -ce .PublicAccessBlockConfiguration <<<"$pab" > "$PAB_FILE"; then
    printf '#!/bin/bash\n# Restores the account public access block exactly as saved at %s\naws s3control put-public-access-block --region us-west-2 --account-id %s --public-access-block-configuration %q\n' \
      "$STAMP" "$ACCOUNT" "$(cat "$PAB_FILE")" > "$PAB_ROLLBACK"
  else
    R8_UNREADABLE+="account-setting(unparseable) "
  fi
elif [[ "$(s3err "$pab")" == NoSuchPublicAccessBlockConfiguration ]]; then
  echo none > "$PAB_FILE"
  printf '#!/bin/bash\n# At %s the account had NO public access block; this removes it again\naws s3control delete-public-access-block --region us-west-2 --account-id %s\n' \
    "$STAMP" "$ACCOUNT" > "$PAB_ROLLBACK"
else
  R8_UNREADABLE+="account-setting($(s3err "$pab")) "
fi
if [[ -n "$R8_UNREADABLE" ]]; then R8_STATE=unreadable; elif [[ -n "$R8_PUBLIC" ]]; then R8_STATE=public; fi
echo "R8 pre-check: $R8_STATE | public: ${R8_PUBLIC:-none} | unreadable: ${R8_UNREADABLE:-none}"
echo "  Object ACLs still enabled (individual objects not scanned): ${R8_OBJACL:-none}"
echo "  Account setting before: $(cat "$PAB_FILE" 2>/dev/null || echo unread) | rollback script: $( [[ -f "$PAB_ROLLBACK" ]] && echo "$PAB_ROLLBACK" || echo none)"
GD=$(aws guardduty list-detectors --query 'DetectorIds[0]' --output text 2>/dev/null)
echo "GuardDuty detector: ${GD:-none}"
WEB=$(aws cloudformation describe-stacks --stack-name "$WEB_STACK" --query "Stacks[0].Outputs[?OutputKey=='WebOrigin'].OutputValue" --output text)
WEB_BEFORE=$(curl -s -o /dev/null -w '%{http_code}' "$WEB/" || echo 000)
echo "Web origin $WEB answers HTTP $WEB_BEFORE (re-checked after R8)"

EMAIL_FILE="$OUT/alert-email"
SAVED_EMAIL=$(cat "$EMAIL_FILE" 2>/dev/null || true)
read -r -p "Email address for alarm notifications (R1)${SAVED_EMAIL:+ [Enter = $SAVED_EMAIL]}: " ALERT_EMAIL
ALERT_EMAIL=${ALERT_EMAIL:-$SAVED_EMAIL}
[[ "$ALERT_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || stop "not an email address"
( umask 077; printf '%s\n' "$ALERT_EMAIL" > "$EMAIL_FILE" )

cat <<EOF

APPLY makes exactly these changes (all reversible):
  R1  SNS: subscribe <your email> to $TOPIC (protocol email). AWS emails a
      confirmation link; alarms reach you only after you click it.
  R8  S3: account-wide public access block (all four settings) on $ACCOUNT.
      $(case "$R8_STATE" in
          ready) echo "Pre-check passed: no public bucket policy or ACL. Saved: $PAB_FILE" ;;
          public) echo "WILL BE SKIPPED: public access found: $R8_PUBLIC" ;;
          *) echo "WILL BE SKIPPED: could not read: $R8_UNREADABLE" ;;
        esac)
  R9  GuardDuty: $( [[ -n "$GD" && "$GD" != None ]] && echo "already enabled; no change" || echo "create a detector in us-west-2 (30-day free trial, then usage-based)" )
Undo: R1 unsubscribe in SNS; R8 bash $PAB_ROLLBACK (restores the saved setting exactly); R9 GuardDuty > Settings > Suspend/Disable.
EOF
read -r -p "Type APPLY to make these changes (anything else skips them): " ans
if [[ "$ans" == APPLY ]]; then
  step "2 R1 alarm subscription"
  existing=$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" --query "Subscriptions[?Endpoint=='$ALERT_EMAIL'].SubscriptionArn | [0]" --output text)
  if [[ -n "$existing" && "$existing" != None ]]; then
    result "R1 subscription already exists ($( [[ "$existing" == arn:* ]] && echo confirmed || echo "pending confirmation: check the inbox" ))"
  else
    aws sns subscribe --topic-arn "$TOPIC" --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null \
      && result "R1 subscribed; ACTION: click the confirmation link AWS just emailed" \
      || result "R1 FAILED (see the error above)"
  fi

  step "3 R8 account S3 public access block"
  if [[ "$R8_STATE" == public ]]; then
    result "R8 SKIPPED: public access found ($R8_PUBLIC); nothing changed; send this to Claude"
  elif [[ "$R8_STATE" != ready ]]; then
    result "R8 SKIPPED: could not read ${R8_UNREADABLE}; nothing changed; send this to Claude"
  elif aws s3control put-public-access-block --account-id "$ACCOUNT" \
      --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true; then
    sleep 5
    ALLON=$(aws s3control get-public-access-block --account-id "$ACCOUNT" --output json 2>/dev/null \
      | jq -r '[.PublicAccessBlockConfiguration[]] | (length == 4 and all)' 2>/dev/null)
    WEB_AFTER=$(curl -s -o /dev/null -w '%{http_code}' "$WEB/" || echo 000)
    if [[ "$ALLON" == true && "$WEB_AFTER" == "$WEB_BEFORE" ]]; then
      result "R8 applied and read back (all four on); web origin still HTTP $WEB_AFTER; rollback: bash $PAB_ROLLBACK"
    elif bash "$PAB_ROLLBACK"; then
      result "R8 ROLLED BACK automatically (read-back all-on: ${ALLON:-unread}; web HTTP $WEB_BEFORE -> $WEB_AFTER); saved setting restored; send this to Claude"
    else
      result "R8 verification failed AND automatic rollback FAILED: run bash $PAB_ROLLBACK, then send this to Claude"
    fi
  else
    result "R8 FAILED (see the error above); nothing changed"
  fi

  step "4 R9 GuardDuty"
  if [[ -n "$GD" && "$GD" != None ]]; then
    result "R9 GuardDuty already enabled"
  elif aws guardduty create-detector --enable --finding-publishing-frequency SIX_HOURS >/dev/null; then
    result "R9 GuardDuty enabled in us-west-2 (check its free-trial cost estimate before day 30)"
  else
    result "R9 FAILED (see the error above)"
  fi
else
  result "R1 R8 R9 not applied (APPLY not typed)"
fi

# ---------------------------------------------------------------------------
step "5 R7 restore drill (plan)"
SRC=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0]' --output json) || stop "cannot read $RDS_ID"
SUBNET_GROUP=$(jq -r .DBSubnetGroup.DBSubnetGroupName <<<"$SRC")
SRC_SGS=$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$SRC")
SRC_KMS=$(jq -r .KmsKeyId <<<"$SRC")
MASTER_SECRET=$(jq -r '.MasterUserSecret.SecretArn // empty' <<<"$SRC")
LATEST=$(jq -r .LatestRestorableTime <<<"$SRC")
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
DRILL_NAME="ogevia-restore-drill-$(date -u +%Y%m%d%H%M)"
cat <<EOF

DRILL does exactly this:
  1. Restore $RDS_ID to the latest restorable time ($LATEST) as a NEW
     instance $DRILL_NAME: db.t4g.micro, single-AZ, not public, same
     subnet group ($SUBNET_GROUP) and security groups ($SRC_SGS), encrypted
     with the same KMS key. $RDS_ID itself is only read, never modified.
  2. Time how long it takes to become available (this is the recovery time).
  3. Attach $APP_SG to the admin host ${IID} for the check only, open an SSM
     tunnel, and run read-only queries (migration ledger, row counts).
     The admin host's groups are restored afterwards, even on failure.
  4. Delete ONLY $DRILL_NAME (no final snapshot, no retained backups).
Cost: about 10 cents (db.t4g.micro for roughly an hour). Typical duration 15-40 minutes.
EOF
[[ "$IID" == i-* ]] || { result "R7 NOT RUN: admin host $ADMIN_TAG is not running (start it in EC2, then paste again)"; IID=""; }
ans=""
[[ -n "$IID" ]] && read -r -p "Type DRILL to run the restore drill (anything else skips it): " ans
if [[ "$ans" == DRILL ]]; then
  for t in jq psql session-manager-plugin; do
    command -v "$t" >/dev/null && continue
    case "$t" in
      psql) sudo dnf install -y -q postgresql15 >/dev/null || stop "could not install psql" ;;
      session-manager-plugin) sudo dnf install -y -q https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm >/dev/null || stop "could not install session-manager-plugin" ;;
      jq) stop "jq is missing" ;;
    esac
  done
  DRILL_ID="$DRILL_NAME"
  REPORT="$OUT/restore-drill-$STAMP.txt"
  step "6 R7 restore $DRILL_ID"
  T0=$(date +%s)
  # shellcheck disable=SC2086
  aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "$RDS_ID" \
    --target-db-instance-identifier "$DRILL_ID" --use-latest-restorable-time \
    --db-instance-class db.t4g.micro --db-subnet-group-name "$SUBNET_GROUP" --vpc-security-group-ids $SRC_SGS \
    --no-publicly-accessible --no-multi-az --no-deletion-protection \
    --tags Key=purpose,Value=restore-drill Key=created-by,Value=phase7-remediate >/dev/null \
    || { DRILL_ID=""; stop "the restore request failed (error above); nothing was created"; }
  echo "Waiting for $DRILL_ID to become available..."
  aws rds wait db-instance-available --db-instance-identifier "$DRILL_ID" \
    || aws rds wait db-instance-available --db-instance-identifier "$DRILL_ID" || stop "$DRILL_ID did not become available"
  T1=$(date +%s)
  D=$(aws rds describe-db-instances --db-instance-identifier "$DRILL_ID" --query 'DBInstances[0]' --output json)
  ENDPOINT=$(jq -r .Endpoint.Address <<<"$D")
  ENC_OK=$([[ "$(jq -r .StorageEncrypted <<<"$D")" == true && "$(jq -r .KmsKeyId <<<"$D")" == "$SRC_KMS" ]] && echo yes || echo NO)
  PUB=$(jq -r .PubliclyAccessible <<<"$D")
  result "R7 restored in $(( (T1 - T0) / 60 )) min $(( (T1 - T0) % 60 )) s; encrypted with the source key: $ENC_OK; public: $PUB"

  step "7 R7 read-only check through the admin host"
  ORIG_SGS=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
  # shellcheck disable=SC2086
  grep -qw "$APP_SG" <<<"$ORIG_SGS" || aws ec2 modify-instance-attribute --instance-id "$IID" --groups $ORIG_SGS "$APP_SG" || stop "could not attach $APP_SG to the admin host"
  aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "host=$ENDPOINT,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null &
  TUNNEL=$!
  for _ in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null && break; sleep 2; done
  CHECK="login FAILED"
  if [[ -n "$MASTER_SECRET" ]]; then
    S=$(aws secretsmanager get-secret-value --secret-id "$MASTER_SECRET" --query SecretString --output text)
    export PGHOST=127.0.0.1 PGPORT=$LOCAL_PORT PGSSLMODE=require PGCONNECT_TIMEOUT=15
    export PGUSER; PGUSER=$(jq -r .username <<<"$S")
    export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$S")
    unset S
    DBS=$(psql -X -At -d postgres -c "select string_agg(datname, ',' order by datname) from pg_database where not datistemplate" 2>&1)
    if [[ "$DBS" == *ogevia_sv_test* ]]; then
      Q=$(psql -X -At -d ogevia_sv_test -c "select (select count(*) || ' (' || min(version) || '-' || max(version) || ')' from ogevia_meta.schema_migrations) || ' | visits ' || (select count(*) from ogevia.service_visits) || ' | corrections ' || (select count(*) from ogevia.visit_corrections)" 2>&1)
      CHECK="databases: $DBS | migrations $Q"
    else
      CHECK="login or listing failed: $(head -c 160 <<<"$DBS")"
    fi
    unset PGPASSWORD
  fi
  result "R7 restored data: $CHECK"
  kill "$TUNNEL" 2>/dev/null; TUNNEL=""
  # shellcheck disable=SC2086
  aws ec2 modify-instance-attribute --instance-id "$IID" --groups $ORIG_SGS && echo "Admin host groups restored: $ORIG_SGS" && ORIG_SGS=""

  step "8 R7 delete the drill instance"
  [[ "$DRILL_ID" =~ ^ogevia-restore-drill-[0-9]{12}$ ]] || stop "refusing to delete unexpected identifier $DRILL_ID"
  TAG=$(aws rds list-tags-for-resource --resource-name "$(jq -r .DBInstanceArn <<<"$D")" --query "TagList[?Key=='purpose'].Value | [0]" --output text)
  [[ "$TAG" == restore-drill ]] || stop "refusing to delete $DRILL_ID: it is not tagged purpose=restore-drill"
  aws rds delete-db-instance --db-instance-identifier "$DRILL_ID" --skip-final-snapshot --delete-automated-backups >/dev/null \
    || stop "delete request failed; delete $DRILL_ID in the RDS console (no final snapshot)"
  aws rds wait db-instance-deleted --db-instance-identifier "$DRILL_ID" || aws rds wait db-instance-deleted --db-instance-identifier "$DRILL_ID"
  DRILL_DELETED=1
  result "R7 drill instance deleted"
  {
    echo "Ogevia restore drill $STAMP"
    echo "source: $RDS_ID, restore point: latest restorable ($LATEST)"
    echo "restored instance: $DRILL_ID (deleted after the check)"
    echo "time to available: $(( (T1 - T0) / 60 )) min $(( (T1 - T0) % 60 )) s"
    echo "encrypted with the source KMS key: $ENC_OK; publicly accessible: $PUB"
    echo "read-only check: $CHECK"
  } > "$REPORT"
  echo "Drill record: $REPORT"
else
  result "R7 restore drill not run"
fi

# ---------------------------------------------------------------------------
step "9 Updated evidence"
if [[ -f "$HOME/phase7_evidence.py" ]]; then
  python3 "$HOME/phase7_evidence.py" | tail -n 6
else
  echo "$HOME/phase7_evidence.py not found; skipped"
fi
FINISHED=1
echo
echo "================ Phase 7 remediation summary ================"
printf '%s\n' "${RESULTS[@]}"
echo "Log: $LOG"
