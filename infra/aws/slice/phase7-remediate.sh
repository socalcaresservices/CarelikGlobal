#!/usr/bin/env bash
# =============================================================================
# Ogevia Phase 7 remediation (AWS TEST account 300094796789, us-west-2).
# Closes the gaps from phase7_evidence.py 2026-10-03 (GAP C6 D2 D4 G1 G3,
# MANUAL E3). Nothing changes until you type the approval word for each part.
#
#   APPLY  (one approval, all reversible, $0 or near-$0):
#     R1  subscribe your inbox to the alarm topic (G1); you confirm the email
#     R8  account-wide S3 public access block (D2); refused if any bucket is public
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
TOPIC=$(aws cloudformation describe-stack-resources --stack-name "$OBS_STACK" \
  --query "StackResources[?ResourceType=='AWS::SNS::Topic'].PhysicalResourceId | [0]" --output text) || stop "cannot read the alarm topic"
[[ "$TOPIC" == arn:aws:sns:* ]] || stop "alarm topic not found in $OBS_STACK"
echo "Alarm topic: $TOPIC"
PUBLIC_BUCKETS=""
for b in $(aws s3api list-buckets --query 'Buckets[].Name' --output text); do
  pub=$(aws s3api get-bucket-policy-status --bucket "$b" --query PolicyStatus.IsPublic --output text 2>/dev/null || echo False)
  [[ "$pub" == True ]] && PUBLIC_BUCKETS+="$b "
done
echo "Buckets with a public policy: ${PUBLIC_BUCKETS:-none}"
GD=$(aws guardduty list-detectors --query 'DetectorIds[0]' --output text 2>/dev/null)
echo "GuardDuty detector: ${GD:-none}"
WEB=$(aws cloudformation describe-stacks --stack-name "$WEB_STACK" --query "Stacks[0].Outputs[?OutputKey=='WebOrigin'].OutputValue" --output text)
WEB_BEFORE=$(curl -s -o /dev/null -w '%{http_code}' "$WEB/" || echo 000)
echo "Web origin $WEB answers HTTP $WEB_BEFORE (re-checked after R8)"

read -r -p "Email address for alarm notifications (R1; kept in this shell only): " ALERT_EMAIL
[[ "$ALERT_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || stop "not an email address"

cat <<EOF

APPLY makes exactly these changes (all reversible):
  R1  SNS: subscribe <your email> to $TOPIC (protocol email). AWS emails a
      confirmation link; alarms reach you only after you click it.
  R8  S3: account-wide public access block (all four settings) on $ACCOUNT.
      $( [[ -n "$PUBLIC_BUCKETS" ]] && echo "SKIPPED: these buckets are public: $PUBLIC_BUCKETS" || echo "No bucket is public today; the site is served through CloudFront." )
  R9  GuardDuty: $( [[ -n "$GD" && "$GD" != None ]] && echo "already enabled; no change" || echo "create a detector in us-west-2 (30-day free trial, then usage-based)" )
Undo: R1 unsubscribe in SNS; R8 s3control delete-public-access-block; R9 GuardDuty > Settings > Suspend/Disable.
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
  if [[ -n "$PUBLIC_BUCKETS" ]]; then
    result "R8 SKIPPED: public buckets exist ($PUBLIC_BUCKETS); send this to Claude"
  elif aws s3control put-public-access-block --account-id "$ACCOUNT" \
      --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true; then
    sleep 5
    WEB_AFTER=$(curl -s -o /dev/null -w '%{http_code}' "$WEB/" || echo 000)
    if [[ "$WEB_AFTER" == "$WEB_BEFORE" ]]; then
      result "R8 applied; web origin still HTTP $WEB_AFTER"
    else
      result "R8 applied BUT the web origin changed HTTP $WEB_BEFORE -> $WEB_AFTER. Undo: aws s3control delete-public-access-block --account-id $ACCOUNT"
    fi
  else
    result "R8 FAILED (see the error above)"
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
