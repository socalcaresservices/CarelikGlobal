#!/usr/bin/env bash
# =============================================================================
# SCS pilot -> AWS TEST: recover, approve once, deploy, verify live, report.
# Resumes the saved run in ~/ogevia-pilot-run (pilot details, the passed
# quality checks for 87a9be2, the rollback capture) with the STRICT scope gate.
# Everything is logged to ~/ogevia-pilot-run/recover-<UTC>.log; any exit
# prints the step and exit code. Nothing changes in AWS before DEPLOY.
#   1. saved run; an existing approval is reused ONLY if it was given for this
#      commit and this exact scope-gate result (re-pasting resumes, no 2nd DEPLOY)
#   2. checkout at 87a9be2 (downloaded again if CloudShell cleared /tmp)
#   3. strict gate (sha256-verified) + checksum-locked 2-line patch of
#      pilot-deploy.sh: synth with the live tag value, and print the exact
#      change set (read-only) immediately before the DEPLOY prompt
#   4. live ogevia:deployment-status value
#   5. live templates still equal the rollback capture (until the API deploys)
#   6. re-synthesis and the strict scope gate
#   7. pilot-deploy.sh: asks for DEPLOY once, then snapshot, DB window
#      (migrations: whatever is missing up to 0018; live baseline 0012), API,
#      web, smoke suites, REPORT.md
#   8. read-only live verification of API, web, snapshot, sign-ins, admin host
#   9. prints the URL, smoke results, report and verification
# =============================================================================
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
export PYTHONDONTWRITEBYTECODE=1   # 87a9be2 tracks a .pyc; do not rewrite it
REPO="${OGEVIA_PILOT_REPO:-/tmp/ogevia-pilot}"
RUN="${OGEVIA_PILOT_RUN_DIR:-$HOME/ogevia-pilot-run}"
EXPECT="${PILOT_COMMIT:-87a9be2bf87e83750d235bfe943b18d5e702cac2}"
GATE_SHA=484b7dfcf74ad2d2e9e3a77d3d4eceaf27fc6a1733c4041c41996138aae0203c
DEPLOY_SH_PATCHED_SHA=3057bc9ff458fa07defb5adb1a78a921af66f7593c4fe7387ae44989ee125b81
REPO_SLUG=socalcaresservices/CarelikGlobal
BRANCH=claude/ogevia-socal-pilot-prep-vfu5tf
ACCOUNT=300094796789
API=Ogevia-prod-ServiceVerificationApi
APP_SG=sg-064ffce3bcbe8eb3b
STACKS=(Ogevia-prod-EvidenceStorage Ogevia-prod-NetworkEgress Ogevia-prod-WebHosting Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability)
PNPM=(npx -y pnpm@9.15.4)

mkdir -p "$RUN"
LOG="$RUN/recover-$(date -u +%Y%m%dT%H%M%SZ).log"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap '' PIPE
STEP="start"
say() { { printf '%s\n' "$*" >&3; } 2>/dev/null; printf '%s\n' "$*" >> "$LOG"; }
step() { STEP="$1"; echo; echo "== RECOVERY $1"; }
stop() { STOPPED=1; say "STOP in recovery step \"$STEP\": $*"; say "Recovery log: $LOG"; exit 1; }
on_exit() {
  local rc=$?
  [[ -n "${STOPPED:-}" || -n "${FINISHED:-}" ]] && return 0
  local hint=""; [[ $rc == 137 ]] && hint=", killed: likely out of memory"
  say "RECOVERY EXITED in step \"$STEP\" (exit $rc$hint). Paste the same block again to resume. Recovery log: $LOG"
}
trap on_exit EXIT
mask() { sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g'; }
plain() { sed -E 's/\x1b\[[0-9;]*m//g'; }
done_() { [[ -e "$RUN/state/$1" ]]; }
echo "Recovery started $(date -u +%FT%TZ); log: $LOG"
exec 9>"$RUN/.recover.lock"
flock -n 9 || stop "another recovery is already running in this CloudShell; wait for it or close that tab"

step "1/9 saved run"
for f in inputs.env "state/tests-${EXPECT:0:12}" state/rollback-captured rollback/routes.json rollback/lambda.json; do
  [[ -e "$RUN/$f" ]] || stop "$RUN/$f is missing"
done
for s in "${STACKS[@]}"; do [[ -s "$RUN/rollback/templates/$s.json" ]] || stop "rollback template $s.json is missing"; done
APPROVED=""
if done_ approved; then
  grep -q "^commit=${EXPECT:0:12}$" "$RUN/APPROVAL.txt" 2>/dev/null \
    || stop "an approval exists for a different commit ($(grep '^commit=' "$RUN/APPROVAL.txt" 2>/dev/null)); send this to Claude"
  APPROVED=$(grep '^scope_gate=' "$RUN/APPROVAL.txt" | cut -d= -f2)
  [[ -n "$APPROVED" ]] || stop "APPROVAL.txt has no scope_gate fingerprint; send this to Claude"
  echo "DEPLOY was already given at $(grep '^approved_at=' "$RUN/APPROVAL.txt" | cut -d= -f2) for scope fingerprint $APPROVED."
  echo "It is reused only if this run's strict scope gate produces exactly that result (checked in step 6)."
else
  for m in snapshot db-window api-deployed web-deployed complete; do
    ! done_ "$m" || stop "state/$m exists without an approval marker; send this to Claude"
  done
fi
echo "Kept: pilot details ($(grep -c '_EMAIL=' "$RUN/inputs.env") sign-ins), quality-gate pass for ${EXPECT:0:12}, rollback capture (5 templates, $(jq length "$RUN/rollback/routes.json") routes)."
echo "Completed steps: $(ls "$RUN/state" | tr '\n' ' ')"

step "2/9 code checkout at ${EXPECT:0:12}"
if [[ ! -e "$REPO/.git" ]]; then
  echo "$REPO is gone (CloudShell clears /tmp between sessions); downloading ${EXPECT:0:12} again."
  if ! command -v gh >/dev/null; then
    echo "Installing the GitHub CLI from GitHub's official package repository..."
    { sudo dnf install -y -q 'dnf-command(config-manager)' && sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo \
      && sudo dnf install -y -q gh --repo gh-cli; } >/dev/null || stop "could not install the GitHub CLI"
  fi
  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "ACTION: GitHub sign-in. Open https://github.com/login/device, enter the code below and authorize GitHub CLI."
    echo "It is signed out again right after the download."
    gh auth login --hostname github.com --git-protocol https --web --scopes repo || stop "GitHub sign-in did not complete; paste the block again to retry"
  fi
  gh auth setup-git --hostname github.com || stop "gh auth setup-git failed"
  rm -rf "$REPO"
  git clone -q --branch "$BRANCH" --single-branch "https://github.com/$REPO_SLUG.git" "$REPO" || stop "git clone failed (network or GitHub access)"
  git -C "$REPO" -c advice.detachedHead=false checkout -q "$EXPECT" || stop "commit ${EXPECT:0:12} not found on $BRANCH"
  gh auth logout --hostname github.com </dev/null >/dev/null 2>&1 || true
fi
[[ "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" == "$EXPECT"* ]] || stop "$REPO is not at ${EXPECT:0:12} (it is at $(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null)); delete $REPO and paste the block again"
OTHER=$(git -C "$REPO" status --porcelain --untracked-files=no | grep -vE ' infra/aws/slice/(pilot_diff_gate\.py|pilot-deploy\.sh|__pycache__/[A-Za-z0-9_.-]+\.pyc)$' || true)
[[ -z "$OTHER" ]] || stop "the checkout has other local changes ($OTHER); delete $REPO and paste the block again"
echo "Code: $(git -C "$REPO" log --oneline -1)"

step "3/9 strict gate and the checksum-locked pilot-deploy.sh patch"
GATE="$RUN/tools/pilot_diff_gate.py"
[[ "$(sha256sum "$GATE" 2>/dev/null | cut -d' ' -f1)" == "$GATE_SHA" ]] || stop "strict gate file checksum mismatch (paste the whole block again)"
cp "$GATE" "$REPO/infra/aws/slice/pilot_diff_gate.py"
DEPLOY_SH="$REPO/infra/aws/slice/pilot-deploy.sh"
# Start from the exact 87a9be2 file, apply exactly two edits, then require the
# known checksum: (1) synth with the live approval tag value; (2) run the
# read-only exact-change report right before the DEPLOY prompt.
git -C "$REPO" checkout -q -- infra/aws/slice/pilot-deploy.sh || stop "could not reset pilot-deploy.sh in the checkout"
python3 - "$DEPLOY_SH" <<'PYEDIT' || stop "could not apply the pilot-deploy.sh patch"
import sys
p = sys.argv[1]; s = open(p).read()
a = 'export OGEVIA_DEPLOY_APPROVAL="pilot-test-$COMMIT"\n'
b = 'export OGEVIA_DEPLOY_APPROVAL="${OGEVIA_PILOT_TAG_REF:-pilot-test-$COMMIT}"\n'
c = '  read -r -p "Type DEPLOY to approve exactly this scope (anything else cancels): " answer\n'
d = '  [[ -f "$RUN/tools/exact-changes.sh" ]] && bash "$RUN/tools/exact-changes.sh"\n' + c
assert s.count(a) == 1 and s.count(c) == 1
open(p, "w").write(s.replace(a, b).replace(c, d))
PYEDIT
[[ "$(sha256sum "$DEPLOY_SH" | cut -d' ' -f1)" == "$DEPLOY_SH_PATCHED_SHA" ]] \
  || stop "patched pilot-deploy.sh does not match the reviewed version"
echo "Installed: strict scope gate (sha256 ${GATE_SHA:0:12}...); pilot-deploy.sh = 87a9be2 + 2 reviewed lines (sha256 ${DEPLOY_SH_PATCHED_SHA:0:12}...)."

step "4/9 live approval tag"
TAGS=$(python3 - "$RUN/rollback/templates" <<'PY'
import json, glob, sys
vals = set()
for f in glob.glob(sys.argv[1] + "/*.json"):
    for r in json.load(open(f)).get("Resources", {}).values():
        for t in (r.get("Properties", {}).get("Tags") or []):
            if isinstance(t, dict) and t.get("Key") == "ogevia:deployment-status":
                vals.add(t.get("Value"))
print("\n".join(sorted(vals)))
PY
)
[[ "$(wc -l <<<"$TAGS")" == 1 && "$TAGS" == approved-* ]] || stop "live ogevia:deployment-status values are not one consistent value: $(tr '\n' ' ' <<<"$TAGS")"
export OGEVIA_PILOT_TAG_REF="${TAGS#approved-}"
[[ "$OGEVIA_PILOT_TAG_REF" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "live approval tag value is not a valid reference: $TAGS"
echo "Live ogevia:deployment-status: $TAGS (kept unchanged)"

step "5/9 AWS session and live templates (read-only)"
ARN=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null) || stop "AWS credentials are not valid: sign in to the console again, reopen CloudShell (us-west-2) and paste the block again"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || stop "signed in to the wrong AWS account (expected $ACCOUNT)"
[[ "$ARN" == *AdministratorAccess* ]] || stop "this needs the AdministratorAccess role (current: $ARN)"
IID=$(aws ec2 describe-instances --filters Name=tag:Name,Values=ogevia-db-admin-temp Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null)
if [[ -n "$APPROVED" ]] && ! done_ db-window && [[ "$IID" == i-* && -s "$RUN/rollback/admin-host-sgs.txt" ]]; then
  NOW_SGS=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
  if grep -qw "$APP_SG" <<<"$NOW_SGS"; then
    WANT=$(tr -s ' \t' '\n' < "$RUN/rollback/admin-host-sgs.txt" | grep -v "^$APP_SG$" | sort | xargs)
    echo "An interrupted DB window left $APP_SG on the admin host; restoring its original groups ($WANT)."
    # shellcheck disable=SC2086
    aws ec2 modify-instance-attribute --instance-id "$IID" --groups $WANT || stop "could not restore the admin host's security groups ($WANT); restore them in the EC2 console"
  fi
fi
if done_ api-deployed; then
  echo "The API stack was already deployed by this run; the pre-deploy template check is not repeated."
else
  for s in "${STACKS[@]}"; do
    live=$(aws cloudformation get-template --stack-name "$s" --template-stage Original --query TemplateBody --output json) || stop "could not read the live template of $s"
    [[ "$(jq -S . <<<"$live")" == "$(jq -S . "$RUN/rollback/templates/$s.json")" ]] \
      || stop "the live template of $s changed since the rollback capture (someone deployed in between); send this to Claude"
  done
  echo "All 5 live templates equal the rollback capture."
fi

step "6/9 live routes, re-synthesis, strict scope gate"
echo "Routes before this deployment: $(jq length "$RUN/rollback/routes.json") ($(jq '[.[] | select(.[1]=="NONE")] | length' "$RUN/rollback/routes.json") public)"
for r in "GET /v1/public/care-portals/{token}/requests" "POST /v1/visits/{visitId}/close" "POST /v1/visits/{visitId}/end"; do
  echo "  $r: $(jq -r --arg r "$r" 'if any(.[]; .[0]==$r) then "LIVE" else "not live" end' "$RUN/rollback/routes.json")"
done
export NODE_OPTIONS=--max-old-space-size=1536
if [[ ! -d "$REPO/node_modules" ]]; then
  echo "Installing dependencies (lockfile only; the passed checks for ${EXPECT:0:12} are kept)..."
  (cd "$REPO" && "${PNPM[@]}" install --frozen-lockfile) || stop "pnpm install failed"
fi
(cd "$REPO/infra/aws" && OGEVIA_DEPLOY_APPROVAL="$OGEVIA_PILOT_TAG_REF" npx cdk synth --quiet --no-notices -c env=prod -c mode=deploy >/dev/null) \
  || stop "cdk synth failed"
python3 "$REPO/infra/aws/slice/pilot_diff_gate.py" --cdk-out "$REPO/infra/aws/cdk.out" --deployed "$RUN/rollback/templates" \
  --summary "$RUN/scope-gate.recover.txt" || stop "the strict scope gate does not pass (output above). Send this output to Claude."
if [[ -n "$APPROVED" ]]; then
  [[ "$(sha256sum "$RUN/scope-gate.recover.txt" | cut -c1-16)" == "$APPROVED" ]] \
    || stop "this scope differs from the one approved earlier ($APPROVED); send this to Claude"
  echo "Scope is identical to the one approved earlier: resuming without a second DEPLOY."
fi

# Read-only report that pilot-deploy.sh runs immediately before its DEPLOY
# prompt (patched line). Always exits 0 so it can never stop the deployment.
export OGEVIA_PILOT_RUN_DIR="$RUN" OGEVIA_PILOT_REPO="$REPO"
cat > "$RUN/tools/exact-changes.sh" <<'EXACT'
#!/usr/bin/env bash
# READ-ONLY. Prints the exact change set right before the DEPLOY prompt.
RUN="${OGEVIA_PILOT_RUN_DIR:-$HOME/ogevia-pilot-run}"; REPO="${OGEVIA_PILOT_REPO:-/tmp/ogevia-pilot}"; R=us-west-2
API_STACK=Ogevia-prod-ServiceVerificationApi
item() { printf '     %s\n' "$*"; }
entry() { grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1; }
echo
echo "=================== EXACT CHANGES IF YOU TYPE DEPLOY ==================="
echo " 1. Backup: manual snapshot ogevia-prod-postgres-pre-pilot-$(date -u +%Y%m%d) of ogevia-prod-postgres (kept until you delete it)."
echo " 2. Database ogevia_sv_test only. Live ledger 0001-0012 (restore drill, 2026-10-03). Migrations to apply, in order:"
for f in "$REPO"/infra/aws/db/migrations/001[3-8]_*.sql; do item "$(basename "$f")  sha256 $(sha256sum "$f" | cut -c1-12)"; done
item "one transaction each; the DB step re-reads the ledger first and applies only what is missing;"
item "then verify.ts must PASS latest_migration_is_0018 and migration_count_is_18, and every existing"
item "visit's time_in/time_out/signed_at fingerprint must be unchanged, or the deployment stops."
echo " 3. Synthetic pilot seed, org scs-pilot-synthetic: 3 clients, 2 services, 4 authorizations, 4 assignments (idempotent)."
echo " 4. Cognito pool us-west-2_849AYz5J7, individual pilot sign-ins:"
(
  # shellcheck disable=SC1091
  source "$RUN/inputs.env" 2>/dev/null
  for pair in "manager|${M_EMAIL:-}" "caregiver A|${A_EMAIL:-}" "caregiver B|${B_EMAIL:-}"; do
    role=${pair%%|*}; e=${pair#*|}
    if st=$(aws cognito-idp admin-get-user --region $R --user-pool-id us-west-2_849AYz5J7 --username "$e" --query UserStatus --output text 2>/dev/null); then
      item "$role ($e): already exists ($st), kept"
    else
      item "$role ($e): create, invitation emailed"
    fi
  done
)
echo " 5. Admin host ogevia-db-admin-temp: app security group attached only during the DB step; original groups restored and re-checked."
echo " 6. $API_STACK (strict scope gate, compared with the captured live templates):"
sed 's/^/   /' "$RUN/scope-gate.txt" 2>/dev/null || item "scope-gate.txt unread"
OLD=$(jq -r .CodeSha256 "$RUN/rollback/lambda.json" 2>/dev/null)
NEW=$(jq -r '[.Resources[] | select(.Type == "AWS::Lambda::Function") | .Properties.Code.S3Key] | join(", ")' "$REPO/infra/aws/cdk.out/$API_STACK.template.json" 2>/dev/null)
item "Lambda code: live CodeSha256 ${OLD:0:16}... -> new package $NEW"
BUCKET=$(aws cloudformation describe-stacks --region $R --stack-name Ogevia-prod-WebHosting --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text 2>/dev/null)
LIVE=$(aws s3 cp --region $R "s3://$BUCKET/index.html" - 2>/dev/null | entry)
NEWW=$(entry < "$RUN/web-build/index.html" 2>/dev/null)
echo " 7. Web: bucket $BUCKET: entry ${LIVE:-unread} -> ${NEWW:-unread} ($(find "$RUN/web-build" -type f 2>/dev/null | wc -l) files), config.json rewritten, CloudFront invalidation /*."
echo " 8. Then: smoke suites (test slice + pilot) and the read-only live verification."
echo " Not touched: other 4 stacks (CDK Analytics metadata only; not deployed), production users and clients,"
echo "              Netlify, Supabase, DNS, the ogevia-web client, RDS security-group rules."
echo "========================================================================="
exit 0
EXACT
chmod +x "$RUN/tools/exact-changes.sh"

step "7/9 deployment (asks for DEPLOY once; resumes after completed steps)"
echo "Deployment log: $RUN/deploy-<UTC>.log"
DEPLOY_RC=0
if done_ complete; then
  echo "The deployment already completed in this run; going straight to live verification."
else
  (cd "$REPO" && bash infra/aws/slice/pilot-deploy.sh)
  DEPLOY_RC=$?
fi
DLOG=$(ls -t "$RUN"/deploy-*.log 2>/dev/null | head -1)
echo "pilot-deploy.sh exit code: $DEPLOY_RC (log: $DLOG)"
if ! done_ approved; then
  STOPPED=1; say "Not deployed: DEPLOY was not given or the run stopped before it (see the STOPPED line above). Nothing was changed in AWS. Recovery log: $LOG"; exit 1
fi
if ! done_ api-deployed; then
  STOPPED=1; say "STOP: the deployment stopped before the API was deployed (STOPPED line above). Fix the stated cause, or if it was a timeout, paste the same block again: it resumes without a new DEPLOY. Recovery log: $LOG"; exit 1
fi

step "8/9 live verification (read-only)"
VERIFY="$RUN/VERIFY.txt"
python3 - "$RUN" "$API" "$APP_SG" "$IID" > "$VERIFY" 2>&1 <<'PY'
import json, os, re, subprocess, sys, urllib.request, urllib.error
run, api_stack, app_sg, iid = sys.argv[1:5]
def aws(*a, region="us-west-2"):
    r = subprocess.run(["aws", *a, "--region", region, "--output", "json"], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "aws %s failed" % a[0])
    return json.loads(r.stdout) if r.stdout.strip() else None
def http(url, method="GET"):
    req = urllib.request.Request(url, method=method, data=b"{}" if method == "POST" else None,
                                 headers={"content-type": "application/json", "cache-control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
results = []
def check(name, fn):
    try:
        ok, detail = fn()
    except Exception as e:  # report, never hide
        ok, detail = False, "error: %s" % e
    results.append(ok)
    print("%s  %s: %s" % ("PASS" if ok else "FAIL", name, detail), flush=True)
def out(stack, key):
    s = aws("cloudformation", "describe-stacks", "--stack-name", stack)["Stacks"][0]
    return next(o["OutputValue"] for o in s.get("Outputs", []) if o["OutputKey"] == key), s
approved_at = dict(l.strip().split("=", 1) for l in open(os.path.join(run, "APPROVAL.txt")) if "=" in l)["approved_at"]
api_url, api_s = out(api_stack, "ApiUrl")
web, _ = out("Ogevia-prod-WebHosting", "WebOrigin")
client, _ = out("Ogevia-prod-WebHosting", "TestAppClientId")
bucket, _ = out("Ogevia-prod-WebHosting", "SiteBucketName")
api_url = api_url.rstrip("/")
before = json.load(open(os.path.join(run, "rollback", "lambda.json")))
routes_before = json.load(open(os.path.join(run, "rollback", "routes.json")))
iso = lambda t: re.sub(r"\.\d+", "", str(t)).replace("+0000", "Z").replace("+00:00", "Z")

def stack():
    st, upd = api_s["StackStatus"], iso(api_s.get("LastUpdatedTime", ""))
    return st == "UPDATE_COMPLETE" and upd >= approved_at, "%s, last updated %s (approved %s)" % (st, upd, approved_at)
check("API stack updated after approval", stack)

def lam():
    res = aws("cloudformation", "describe-stack-resources", "--stack-name", api_stack)["StackResources"]
    fn = next(r["PhysicalResourceId"] for r in res if r["ResourceType"] == "AWS::Lambda::Function")
    c = aws("lambda", "get-function-configuration", "--function-name", fn)
    db = c.get("Environment", {}).get("Variables", {}).get("DB_NAME")
    ok = c["CodeSha256"] != before["CodeSha256"] and db == "ogevia_sv_test" and iso(c["LastModified"]) >= approved_at
    return ok, "CodeSha256 %s... (before %s...), modified %s, DB_NAME %s" % (c["CodeSha256"][:12], before["CodeSha256"][:12], iso(c["LastModified"]), db)
check("Lambda runs the new code on ogevia_sv_test", lam)

def routes():
    res = aws("cloudformation", "describe-stack-resources", "--stack-name", api_stack)["StackResources"]
    api_id = next(r["PhysicalResourceId"] for r in res if r["ResourceType"] == "AWS::ApiGatewayV2::Api")
    items = aws("apigatewayv2", "get-routes", "--api-id", api_id)["Items"]
    keys = {i["RouteKey"]: i.get("AuthorizationType", "NONE") for i in items}
    pub = sum(1 for v in keys.values() if v == "NONE")
    close = keys.get("POST /v1/visits/{visitId}/close")
    ok = close == "JWT" and len(keys) == len(routes_before) + 1 and pub == 8
    return ok, "%d routes (before %d), %d public, close route %s" % (len(keys), len(routes_before), pub, close or "ABSENT")
check("API routes: close added (sign-in required), nothing else", routes)

def probe():
    code, _ = http(api_url + "/v1/visits/00000000-0000-4000-8000-000000000000/close", "POST")
    return code == 401, "POST .../close without sign-in -> HTTP %d (401 = route live, sign-in enforced)" % code
check("Live API answers on the close route", probe)

entry = lambda html: (re.search(r'assets/index-[A-Za-z0-9_-]+\.js', html or "") or [None])[0]
built = entry(open(os.path.join(run, "web-build", "index.html")).read())
def web_s3():
    body = subprocess.run(["aws", "s3", "cp", "s3://%s/index.html" % bucket, "-", "--region", "us-west-2"], capture_output=True, text=True).stdout
    return entry(body) == built, "bucket index.html -> %s (this build: %s)" % (entry(body), built)
check("Web bucket holds this build", web_s3)
def web_live():
    code, body = http(web + "/")
    return code == 200 and entry(body) == built and 'id="root"' in body, "%s -> HTTP %d, %s" % (web, code, entry(body))
check("Web URL serves this build", web_live)
def cfg():
    code, body = http(web + "/config.json")
    c = json.loads(body) if code == 200 else {}
    ok = c.get("VITE_SV_API_BASE_URL", "").rstrip("/") == api_url and c.get("VITE_COGNITO_CLIENT_ID") == client
    return ok, "config.json -> API %s, client %s" % (c.get("VITE_SV_API_BASE_URL"), c.get("VITE_COGNITO_CLIENT_ID"))
check("Web config points at the TEST API and app client", cfg)

def snap():
    s = aws("rds", "describe-db-snapshots", "--db-instance-identifier", "ogevia-prod-postgres", "--snapshot-type", "manual")["DBSnapshots"]
    p = [x for x in s if x["DBSnapshotIdentifier"].startswith("ogevia-prod-postgres-pre-pilot-") and x["Status"] == "available"]
    return bool(p), ", ".join(x["DBSnapshotIdentifier"] for x in p) or "none available"
check("Pre-deployment snapshot", snap)

def users():
    emails = subprocess.run(["bash", "-c", 'source "$1"; printf "%s\\n" "$M_EMAIL" "$A_EMAIL" "$B_EMAIL"', "_",
                             os.path.join(run, "inputs.env")], capture_output=True, text=True).stdout.split()
    if len(emails) != 3:
        return False, "inputs.env does not hold 3 sign-in emails"
    st = []
    for e in emails:
        u = aws("cognito-idp", "admin-get-user", "--user-pool-id", "us-west-2_849AYz5J7", "--username", e)
        st.append("%s %s" % (u["UserStatus"], "enabled" if u["Enabled"] else "DISABLED"))
    return all(s.endswith("enabled") for s in st), "manager, caregiver A, caregiver B: " + "; ".join(st)
check("3 individual pilot sign-ins exist", users)

def host():
    if not iid.startswith("i-"):
        return True, "admin host not running (no security group attached)"
    g = aws("ec2", "describe-instances", "--instance-ids", iid)["Reservations"][0]["Instances"][0]["SecurityGroups"]
    ids = [x["GroupId"] for x in g]
    return app_sg not in ids, "admin host groups: %s" % ", ".join(ids)
check("DB access window closed (app security group removed)", host)

def migrations():
    import glob
    txt = ""
    for f in sorted(glob.glob(os.path.join(run, "deploy-*.log"))):
        txt += re.sub(r"\x1b\[[0-9;]*m", "", open(f, errors="replace").read())
    a = "PASS 01_schema_version.sql latest_migration_is_0018" in txt
    b = "PASS 01_schema_version.sql migration_count_is_18" in txt
    fp = "Existing visit timestamps unchanged" in txt
    applied = sorted(set(re.findall(r"^applying (\d{4})_", txt, re.M)))
    return a and b and fp, "deployment log: applied %s; latest_migration_is_0018 %s; migration_count_is_18 %s; visit timestamps unchanged %s" % (
        ",".join(applied) or "none", a, b, fp)
check("Database migrated to 0018 (from the DB step's own verify.ts output)", migrations)

def smoke():
    rep = open(os.path.join(run, "REPORT.md")).read() if os.path.exists(os.path.join(run, "REPORT.md")) else ""
    s = re.search(r"Smoke \(test slice\): (\w+)", rep); p = re.search(r"Pilot checks: (\w+)", rep)
    s, p = (s.group(1) if s else "missing"), (p.group(1) if p else "missing")
    return s == "PASS" and p == "PASS", "test-slice smoke %s, pilot checks %s" % (s, p)
check("Smoke suites", smoke)

print("\nLive verification: %d/%d PASS" % (sum(results), len(results)))
print("WEB_URL=%s" % web)
sys.exit(0 if all(results) else 1)
PY
VERIFY_RC=$?
echo "Written to $VERIFY (printed below)."

step "9/9 summary"
WEB_URL=$(grep '^WEB_URL=' "$VERIFY" | cut -d= -f2-)
echo "---------------- smoke results ----------------"
for f in smoke.log pilot-smoke.log; do
  if [[ -f "$RUN/$f" ]]; then plain < "$RUN/$f" | grep -E 'checks, [0-9]+ passed|FAILED|FAIL ' | mask | tail -n 12; else echo "$f: not produced"; fi
done
echo "---------------- deployment evidence (from $DLOG) ----------------"
cat "$RUN"/deploy-*.log 2>/dev/null | plain | grep -E 'Snapshot .*available|Migration ledger before|^applying 00|^applied [0-9]+, already|01_schema_version|Existing visit|Pilot seed|DB window closed|API and web deployed' | mask | awk '!seen[$0]++'
echo "---------------- REPORT.md ----------------"
if [[ -f "$RUN/REPORT.md" ]]; then mask < "$RUN/REPORT.md"; else echo "REPORT.md was not produced"; fi
echo "---------------- live verification ($VERIFY) ----------------"
grep -E '^(PASS|FAIL)|Live verification' "$VERIFY"
echo
FINISHED=1
if [[ $DEPLOY_RC == 0 && $VERIFY_RC == 0 ]]; then
  say "PILOT DEPLOYED AND VERIFIED ON AWS TEST. Web URL (open on the phone): $WEB_URL"
  say "Next: the real-phone acceptance test (docs/aws/PILOT_PHONE_ACCEPTANCE.md). Synthetic data only."
  exit 0
fi
say "NOT VERIFIED: deployment exit $DEPLOY_RC, live verification exit $VERIFY_RC. The FAIL lines above name what is wrong."
say "The deployment stays in place for diagnosis; rollback: cd $REPO && bash infra/aws/slice/pilot-rollback.sh status. Recovery log: $LOG"
exit 1
