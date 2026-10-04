cat > ~/ogevia-increment-resume.sh <<'EOF'
#!/usr/bin/env bash
# Ogevia AWS TEST increment 0019-0021 (pinned 1a39dd5): preflight, deploy or
# resume, post-check, then the separate manager sign-in.
#
# 1. PREFLIGHT, before anything is deployed: live API routes, the API Lambda,
#    the web build and (through the usual temporary DB window, always restored)
#    the migration ledger with checksums and the counts of existing accounts and
#    records. Fresh run: continues ONLY if the live state is exactly the pilot
#    base (ledger 0001-0018, the 38 pilot routes). Anything partial or unexpected
#    STOPS with a report and changes nothing.
# 2. DEPLOY: the pinned increment-deploy.sh (its own DEPLOY prompt; resumable).
# 3. POST-CHECK: ledger 0001-0021 with checksums; users, memberships, caregiver
#    records, clients, authorizations, assignments, visits, confirmations and
#    corrections have the same counts as in the preflight.
# 4. MANAGER: pilot-manager-account.sh (its own MANAGER prompt).
# Paste again to resume; completed steps are skipped. Never prints secrets.
set -uo pipefail
PIN=1a39dd59fddd48d5c4e57a815331487a979e4b0b
BR=claude/ogevia-socal-pilot-prep-vfu5tf
SRC=${OGEVIA_INCREMENT_SRC:-/tmp/ogevia-increment}
if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" != "$PIN" ]; then
  if ! command -v gh >/dev/null; then
    echo "Installing the GitHub CLI from GitHub's official package repository..."
    { sudo dnf install -y -q 'dnf-command(config-manager)' && sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo \
      && sudo dnf install -y -q gh --repo gh-cli; } >/dev/null || { echo "STOP: could not install the GitHub CLI. Nothing ran."; exit 1; }
  fi
  SIGNED_IN=0
  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "Sign in to GitHub: open https://github.com/login/device, enter the code below, authorize GitHub CLI."
    gh auth login --hostname github.com --git-protocol https --web --scopes repo || { echo "STOP: GitHub sign-in did not complete. Nothing ran."; exit 1; }
    SIGNED_IN=1
  fi
  gh auth setup-git --hostname github.com >/dev/null 2>&1
  rm -rf "$SRC"
  ok=0
  for i in 1 2 3; do
    git clone -q --branch "$BR" --single-branch https://github.com/socalcaresservices/CarelikGlobal.git "$SRC" && ok=1 && break
    echo "Download failed (attempt $i); retrying..."; sleep $((i * 5))
  done
  [ "$SIGNED_IN" = 1 ] && gh auth logout --hostname github.com </dev/null >/dev/null 2>&1
  [ "$ok" = 1 ] || { echo "STOP: could not download the code. Nothing ran."; exit 1; }
  git -C "$SRC" -c advice.detachedHead=false checkout -q "$PIN" || { echo "STOP: commit ${PIN:0:7} not found on $BR. Nothing ran."; exit 1; }
fi
echo "Code: $(git -C "$SRC" log --oneline -1)"

cat > /tmp/ogevia-increment-check.sh <<'CHECK'
#!/usr/bin/env bash
# MODE pre: read-only inventory and decision. MODE post: after the deploy.
set -Eeuo pipefail
MODE=$1; SRC=$2
export OGEVIA_PILOT_RUN_DIR="${OGEVIA_PREFLIGHT_RUN_DIR:-$HOME/ogevia-increment-preflight}"
# shellcheck disable=SC1091
source "$SRC/infra/aws/slice/pilot-lib.sh"
LOG="$RUN/$MODE-$(date -u +%Y%m%dT%H%M%SZ).log"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap 'db_window_close' EXIT
trap 'db_window_close; die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
KEEP_SQL="select (select count(*) from ogevia.app_users) || ' users, ' || (select count(*) from ogevia.organization_memberships) || ' memberships (' || (select count(*) from ogevia.organization_memberships where status = 'active') || ' active), ' || (select count(*) from ogevia.caregiver_records) || ' caregiver records, ' || (select count(*) from ogevia.clients) || ' clients, ' || (select count(*) from ogevia.client_authorizations) || ' authorizations, ' || (select count(*) from ogevia.caregiver_assignments) || ' assignments, ' || (select count(*) from ogevia.service_visits) || ' visits, ' || (select count(*) from ogevia.visit_confirmations) || ' confirmations, ' || (select count(*) from ogevia.visit_corrections) || ' corrections'"
for t in aws jq python3 curl; do command -v "$t" >/dev/null || die "missing tool: $t"; done
if ! command -v psql >/dev/null; then sudo dnf install -y -q postgresql15 >/dev/null || die "could not install psql"; fi
if ! command -v session-manager-plugin >/dev/null; then
  sudo dnf install -y -q https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm >/dev/null \
    || die "could not install session-manager-plugin"
fi
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || die "wrong AWS account (expected $ACCOUNT)"

# Ledger rows vs the pinned migration files (checksums), as "version ok|CHANGED".
ledger_report() {
  Q -d "$DB_NAME" -F' ' -c "select version, checksum from ogevia_meta.schema_migrations order by version" > "$RUN/ledger-$MODE.txt"
  while read -r v sum; do
    f=$(ls "$SRC/infra/aws/db/migrations/${v}_"*.sql 2>/dev/null || true)
    if [[ -n "$f" && "$(sha256sum "$f" | cut -d' ' -f1)" == "$sum" ]]; then echo "$v ok"; else echo "$v CHANGED"; fi
  done < "$RUN/ledger-$MODE.txt"
}

if [[ "$MODE" == pre ]]; then
  phase "Preflight 1/3: API, Lambda and web (read-only)"
  API_ID=$(aws cloudformation describe-stack-resources --stack-name "$API_STACK" \
    --query "StackResources[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId | [0]" --output text)
  aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output json > "$RUN/routes-live.json"
  ROUTES=$(python3 - "$RUN/routes-live.json" "$SRC" <<'PY'
import json, re, sys
sys.path.insert(0, sys.argv[2] + "/infra/aws/slice")
from increment_diff_gate import NEW_ROUTES
live = {k for k, _ in json.load(open(sys.argv[1]))}
code = set(re.findall(r'^  "((?:GET|POST) /v1/[^"]*)": \{', open(sys.argv[2] + "/apps/sv-api/src/routes.ts").read(), re.M))
pilot = code - set(NEW_ROUTES)
state = "PILOT-BASE" if live == pilot else "INCREMENT" if live == code else "UNEXPECTED"
extra = sorted(live - code); new_live = sorted(live & set(NEW_ROUTES)); missing = sorted(pilot - live)
print("%s %d live (pilot set %d, full set %d); increment routes already live: %d; unknown: %s; pilot routes missing: %s" % (
    state, len(live), len(pilot), len(code), len(new_live), extra or "none", missing or "none"))
PY
)
  echo "API routes: $ROUTES"
  ST=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --query 'Stacks[0].[StackStatus,LastUpdatedTime]' --output text)
  FN=$(aws cloudformation describe-stack-resources --stack-name "$API_STACK" \
    --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId | [0]" --output text)
  LF=$(aws lambda get-function-configuration --function-name "$FN" \
    --query '[CodeSha256,LastModified,Environment.Variables.DB_NAME]' --output text)
  echo "API stack: $(cut -f1 <<<"$ST"), last updated $(cut -f2 <<<"$ST")"
  echo "API Lambda: CodeSha256 $(cut -f1 <<<"$LF" | cut -c1-16)…, last modified $(cut -f2 <<<"$LF"), database $(cut -f3 <<<"$LF")"
  if [[ -f "$HOME/ogevia-pilot-run/rollback/lambda.json" ]]; then
    echo "  (pre-pilot capture: CodeSha256 $(jq -r .CodeSha256 "$HOME/ogevia-pilot-run/rollback/lambda.json" | cut -c1-16)…; a different value means the pilot code is live)"
  fi
  WEB=$(out Ogevia-prod-WebHosting WebOrigin); BUCKET=$(out Ogevia-prod-WebHosting SiteBucketName)
  WEBMOD=$(aws s3api head-object --bucket "$BUCKET" --key index.html --query LastModified --output text 2>/dev/null || echo unknown)
  INDEX=$(curl -fsS "${WEB%/}/index.html" || true)
  WEBKIND="pilot (no 0019-0021 screens referenced)"
  for js in $(grep -oE 'assets/[A-Za-z0-9._-]+\.js' <<<"$INDEX" | sort -u); do
    curl -fsS "${WEB%/}/$js" | grep -q '/v1/attention' && WEBKIND="increment (0019-0021 screens referenced)" && break
  done
  echo "Web: index.html last modified $WEBMOD; build: $WEBKIND"

  phase "Preflight 2/3: migration ledger and existing records (temporary DB window, always restored)"
  load_rds_and_host
  [[ "$(jq -r .PubliclyAccessible <<<"$RDS")" == false ]] || die "RDS is publicly accessible: stop and review"
  db_window_open
  LEDGER=$(ledger_report)
  N=$(wc -l <<<"$LEDGER"); CHANGED=$(grep -c CHANGED <<<"$LEDGER" || true)
  VERS=$(cut -d' ' -f1 <<<"$LEDGER" | paste -sd,)
  echo "Ledger: $N migrations ($(head -1 <<<"$LEDGER" | cut -d' ' -f1)-$(tail -1 <<<"$LEDGER" | cut -d' ' -f1)); checksums changed: $CHANGED"
  KEEP=$(Q -d "$DB_NAME" -c "$KEEP_SQL")
  echo "Existing accounts and records: $KEEP"
  db_window_close
  admin_host_groups | grep -qw "$APP_SG" && die "$APP_SG is still attached to the admin host: remove it in the EC2 console"
  echo "DB window closed; admin host groups: $(admin_host_groups)"

  phase "Preflight 3/3: decision"
  if [[ -d "$HOME/ogevia-increment-run/state" ]]; then
    echo "An increment run already exists in ~/ogevia-increment-run (steps done: $(ls "$HOME/ogevia-increment-run/state" | xargs))."
    echo "DECISION: RESUME that run; increment-deploy.sh skips its completed steps and re-checks everything itself."
    [[ -f "$RUN/keep-before.txt" ]] || die "no preflight baseline from before the first run; send this output to Claude"
    exit 0
  fi
  [[ "$CHANGED" == 0 ]] || die "an applied migration differs from the repository (see $RUN/ledger-pre.txt). Nothing deployed; send this output to Claude"
  if [[ "$VERS" == "$(seq -f '%04g' 1 18 | paste -sd,)" && "$ROUTES" == PILOT-BASE* ]]; then
    echo "$KEEP" > "$RUN/keep-before.txt"
    echo "DECISION: clean pilot base (ledger 0001-0018, the 38 pilot routes). Nothing of 0019-0021 is live. The deployment may start."
    exit 0
  fi
  if [[ "$VERS" == "$(seq -f '%04g' 1 21 | paste -sd,)" && "$ROUTES" == INCREMENT* ]]; then
    echo "DECISION: the increment 0019-0021 already looks complete (ledger 0021, 60 routes). Nothing deployed."
    exit 3
  fi
  die "PARTIAL or unexpected state: ledger $VERS; routes $ROUTES; web $WEBKIND. Nothing deployed; send this output to Claude"
fi

phase "Post-check: ledger and existing records after the deployment"
if is_done postcheck; then echo "Post-check already passed in an earlier run ($(cat "$STATE/postcheck" 2>/dev/null))."; exit 0; fi
[[ -f "$RUN/keep-before.txt" ]] || die "no preflight baseline"
load_rds_and_host
db_window_open
LEDGER=$(ledger_report)
VERS=$(cut -d' ' -f1 <<<"$LEDGER" | paste -sd,)
CHANGED=$(grep -c CHANGED <<<"$LEDGER" || true)
KEEP=$(Q -d "$DB_NAME" -c "$KEEP_SQL")
db_window_close
admin_host_groups | grep -qw "$APP_SG" && die "$APP_SG is still attached to the admin host: remove it in the EC2 console"
r=0
[[ "$VERS" == "$(seq -f '%04g' 1 21 | paste -sd,)" && "$CHANGED" == 0 ]] && echo "PASS ledger 0001-0021, every checksum equal to the repository" || { echo "FAIL ledger: $VERS (changed: $CHANGED)"; r=1; }
[[ "$KEEP" == "$(cat "$RUN/keep-before.txt")" ]] && echo "PASS existing accounts and records unchanged: $KEEP" || { echo "FAIL counts changed: before $(cat "$RUN/keep-before.txt"); after $KEEP"; r=1; }
echo "DB window closed; admin host groups: $(admin_host_groups)"
[[ $r == 0 ]] || die "post-check failed; the deployment stays in place for diagnosis; send this output to Claude"
date -u +%FT%TZ > "$STATE/postcheck"
CHECK

bash /tmp/ogevia-increment-check.sh pre "$SRC"; rc=$?
[ "$rc" = 3 ] && exit 0
[ "$rc" = 0 ] || exit "$rc"
cd "$SRC" && OGEVIA_INCREMENT_PIN="$PIN" bash infra/aws/slice/increment-deploy.sh || exit $?
bash /tmp/ogevia-increment-check.sh post "$SRC" || exit $?
bash infra/aws/slice/pilot-manager-account.sh
rc=$?
# Read-only: first-sign-in status of the corrected caregiver and the new manager.
for e in pinkpopsllc@gmail.com ogemails+ogevia-pilot-manager@gmail.com; do
  aws cognito-idp admin-get-user --region us-west-2 --user-pool-id us-west-2_849AYz5J7 --username "$e" \
    --query '[UserStatus, join(`","`, UserMFASettingList || [`"none"`])]' --output text 2>/dev/null \
    | awk -v e="$e" '{ printf "Sign-in %-42s %s, MFA %s%s\n", e, $1, $2, ($1 == "CONFIRMED" && $2 != "none") ? " (first sign-in done)" : " (first sign-in NOT done yet)" }' \
    || echo "Sign-in $e: not found"
done
exit $rc
EOF
bash ~/ogevia-increment-resume.sh
