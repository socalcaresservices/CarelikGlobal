#!/usr/bin/env bash
# RELEASE TRAIN 2, TEST STAGE 5 - SES SANDBOX FIX for the TEST email function, and nothing else. TEST ONLY (stacks Ogevia-prod-*). Never touches Ogevia-prd-* or ogevia_prd.
# Found 2026-11-26: TEST-CG-01's email reached the email function with the approved address, passed the allow-list, and SES refused it with access_denied_exception. The account is in the SES SANDBOX
# (ProductionAccessEnabled=false), where SES also checks permission on the RECIPIENT identity; the function's send permission named only the ogevia.com identity.
# This stage adds exactly ONE identity ARN (the approved inbox, admin.ogevia@gmail.com) to the function's single ses:SendEmail statement. The recipient allow-list is unchanged. No database, route, web or other change.
# Gated by diff_gate_email.py --expect identity (the managed policy Email* gains exactly one SES identity ARN; everything else identical) before anything changes, and --expect post afterwards.
#   REPO=<checkout at the release commit> OGEVIA_RELEASE_COMMIT=<full sha> WORK=<work dir> OGEVIA_DEPLOY_APPROVAL=<owner TEST authorization reference> bash TEST_RT2_N5_EMAIL_RECIPIENT_IDENTITY.sh [deploy|rollback]
#   OGEVIA_NO_CONFIRM=1 skips the typed confirmation (automated test only).
# Rollback (typed confirmation): redeploys the saved assembly WITHOUT the extra ARN (the stage-4 state) to the API stack only.
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
MODE="${1:-deploy}"
case "$MODE" in deploy|rollback) ;; *) stop "usage: deploy | rollback";; esac
: "${REPO:?set REPO to the checkout at the release commit}"
: "${OGEVIA_RELEASE_COMMIT:?set OGEVIA_RELEASE_COMMIT to the full release commit}"
: "${WORK:?set WORK to a private work directory with free space}"
: "${OGEVIA_DEPLOY_APPROVAL:?set OGEVIA_DEPLOY_APPROVAL to the owner TEST authorization reference}"
[[ "$OGEVIA_DEPLOY_APPROVAL" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "OGEVIA_DEPLOY_APPROVAL must be 6 to 64 characters of A-Za-z0-9._-"
export OGEVIA_DEPLOY_APPROVAL
COMMIT="$OGEVIA_RELEASE_COMMIT"
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$COMMIT" ]] || stop "the checkout is not at the release commit"
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "tracked files in the checkout are modified"
# the release commit may add only tooling, tests and documents on top of the audited commit: the application and infrastructure code must be byte-identical to it
APP_BASE="${OGEVIA_APP_BASE:-46fc89062e13e05791d61e590edadd2aa2e068b9}"
git -C "$REPO" cat-file -e "$APP_BASE^{commit}" 2>/dev/null || stop "the audited commit $APP_BASE is not in this checkout (git fetch --depth 1 origin $APP_BASE)"
git -C "$REPO" diff --quiet "$APP_BASE" "$COMMIT" -- apps packages infra/aws/lib infra/aws/bin infra/aws/package.json pnpm-lock.yaml infra/aws/db/pending/migrations || stop "application, infrastructure or migration files differ from the audited commit $APP_BASE"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-300}" aws --cli-connect-timeout 5 --cli-read-timeout 120 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account (expected 300094796789 in us-west-2)"
export XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state" COREPACK_HOME="$WORK/corepack"
mkdir -p "$WORK/bin" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
for d in "$WORK"/node-v22.*-linux-*/bin; do [[ -d "$d" ]] && export PATH="$d:$PATH"; done
[[ -d "$WORK/bin" ]] && export PATH="$WORK/bin:$PATH"
TC="$REPO/docs/releases/2026-11-20-test-plan/toolchain"

TC="$REPO/docs/releases/2026-11-20-test-plan/toolchain"
STACK=Ogevia-prod-ServiceVerificationApi
EGRESS=Ogevia-prod-NetworkEgress
FN_NAME=Ogevia-prod-NotificationEmail
IDENTITY=ogevia.com
RECIPIENT=admin.ogevia@gmail.com
IDENTITY_ARN="arn:aws:ses:us-west-2:300094796789:identity/$IDENTITY"
RECIPIENT_ARN="arn:aws:ses:us-west-2:300094796789:identity/$RECIPIENT"
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
handler_fn() { A cloudformation list-stack-resources --stack-name "$STACK" --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else error("expected exactly one API Handler") end'; }
CONFIG="$REPO/infra/aws/lib/config.ts"
F_OLD='features: { staffManagement: true, signInOverride: true, bulkImport: true, staffDuplicates: false },'
# edit_config <old|new>: the isolated-TEST features line only (exactly one match), synthesis only; the file is restored right after. Every switch that is ON on TEST today stays ON.
edit_config() { python3 - "$CONFIG" "$F_OLD" "$1" "$IDENTITY_ARN" "$RECIPIENT" "$RECIPIENT_ARN" <<'PY'
import sys
p, old, mode, arn, rcpt, rarn = sys.argv[1:]
s = open(p).read()
assert s.count(old) == 1, "the TEST features line was not found exactly once"
add = ", requestCleanup: true, offices: true, officeAssignments: true, assignmentHistory: true, notifications: true, openShiftSms: true, serviceLocation: true"
new = old[:-3] + add + " },"
if mode in ("old", "new"):   # old = the stage-4 state (live today); new = plus the one recipient identity ARN
    extra = (', recipientIdentityArns: ["' + rarn + '"]') if mode == "new" else ""
    new += ' notificationEmail: { from: "Ogevia <scheduling@ogevia.com>", replyTo: "' + rcpt + '", sesIdentityArn: "' + arn + '", allowedRecipients: ["' + rcpt + '"]' + extra + ' },'
open(p, "w").write(s.replace(old, new))
PY
}
restore_config() { git -C "$REPO" checkout -- infra/aws/lib/config.ts 2>/dev/null || true; }
# synth <outdir> <old|new>
synth() {
  local o="$1" on="$2" r=0
  rm -rf "$o"; trap restore_config EXIT
  edit_config "$on"
  (cd "$REPO" && pnpm --dir infra/aws exec cdk synth '*' --quiet --lookups=false -c env=prod -c mode=deploy -c liveTestBaseline=0102 \
    -c "liveQrParameterSpec=$QR_SPEC" -c "liveTestHandlerTags=$TAGS" -c testDatabase=isolated -c "testMasterSecretArn=$MASTER_ARN" --output "$o") || r=$?
  restore_config; trap - EXIT
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "the checkout was not restored to the release commit"
  [[ "$r" == 0 && -f "$o/$STACK.template.json" && -f "$o/$EGRESS.template.json" ]] || stop "synthesis failed. Nothing was changed."
}
tpl() { A cloudformation get-template --stack-name "$1" --template-stage Original --query TemplateBody --output json; }
gate() { python3 "$TC/diff_gate_email.py" --api-live "$1" --api-new "$2" --egress-live "$3" --egress-new "$4" --expect "$5"; }
CAP="${RT2N5_DIR:-$( { ls -d "$WORK"/rt2n5-2* 2>/dev/null | sort | tail -1; } || true)}"

# ================= rollback =================
if [[ "$MODE" == rollback ]]; then
  [[ -n "$CAP" && -d "$CAP" && "$(cat "$CAP/release-commit.txt" 2>/dev/null)" == "$COMMIT" ]] || stop "no RT2 stage-5 capture for this commit in $WORK"
  (cd "$CAP" && sha256sum --check --quiet SHA256SUMS) || stop "the RT2 stage-5 capture was modified or is incomplete"
  confirm "ROLLBACK-TEST-EMAIL-IDENTITY" "Redeploys the saved assembly WITHOUT the extra recipient identity to the TEST API stack: the email function's send permission goes back to the ogevia.com identity only (the stage-4 state). The function, its allow-list and the SES identities stay."
  (cd "$REPO" && pnpm --dir infra/aws exec cdk deploy --app "$CAP/off" --exclusively "$STACK" --require-approval broadening --no-notices) || stop "cdk deploy of the API stack failed"
  tpl "$STACK" > "$CAP/rollback-api-live.json"; tpl "$EGRESS" > "$CAP/rollback-egress-live.json"
  gate "$CAP/rollback-api-live.json" "$CAP/off/$STACK.template.json" "$CAP/rollback-egress-live.json" "$CAP/off/$EGRESS.template.json" post || stop "the rolled-back stacks differ from the saved assemblies"
  echo "ROLLBACK-EMAIL-IDENTITY OK: the function's send permission is back to the ogevia.com identity only"; exit 0
fi

# ================= deploy =================
ensure_tools() {   # Node 22, pnpm 9.15.4 and the installed dependencies, all under $WORK
  if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]]; then
    case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) stop "unsupported CPU";; esac
    archive="node-v22.23.5-linux-$arch.tar.xz"
    curl -fsS --connect-timeout 10 --max-time 180 "https://nodejs.org/dist/v22.23.5/$archive" -o "$WORK/$archive"
    curl -fsS --connect-timeout 10 --max-time 60 https://nodejs.org/dist/v22.23.5/SHASUMS256.txt -o "$WORK/node-sums"
    awk -v f="$archive" '$2==f' "$WORK/node-sums" > "$WORK/node-check"; [[ -s "$WORK/node-check" ]] || stop "no checksum for $archive"
    (cd "$WORK" && sha256sum --check node-check) || stop "the Node download does not match its published checksum"
    tar -xJf "$WORK/$archive" -C "$WORK"; export PATH="$WORK/${archive%.tar.xz}/bin:$PATH"
  fi
  corepack enable --install-directory "$WORK/bin"; export PATH="$WORK/bin:$PATH"
  [[ "$(cd "$REPO" && pnpm --version)" == 9.15.4 ]] || stop "pnpm 9.15.4 is required"
  if [[ ! -x "$REPO/infra/aws/node_modules/.bin/cdk" ]]; then
    echo "--- installing dependencies under $WORK (a few minutes)"
    (cd "$REPO" && pnpm install --frozen-lockfile --store-dir "$WORK/store" --prefer-offline) || stop "pnpm install failed"
  fi
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "the install modified tracked files"
}
ensure_tools
ensure_tools
for f in diff_gate_email.py diff_gate_rt2.py; do [[ -f "$TC/$f" ]] || stop "the toolchain is missing $f"; done
B="${RT2N5_DIR:-$WORK/rt2n5-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$B" == /* && ! -L "$B" ]] || stop "the capture directory must be an absolute path"
mkdir -p "$B"; [[ -z "$(find "$B" -mindepth 1 -maxdepth 1 -print -quit)" ]] || stop "use a new empty capture directory"
chmod 700 "$B"; echo "CAPTURE: $B"; echo "$COMMIT" > "$B/release-commit.txt"

echo "=== 1. read-only checks: Amazon SES (us-west-2) ==="
ID="$(A sesv2 get-email-identity --email-identity "$IDENTITY" --output json 2>/dev/null)" || stop "the SES identity $IDENTITY does not exist in us-west-2. Create it first (domain identity, Easy DKIM) and add the DNS records. Nothing was changed."
[[ "$(jq -r '.IdentityType' <<<"$ID")" == DOMAIN ]] || stop "the SES identity $IDENTITY is not a domain identity"
[[ "$(jq -r '.VerifiedForSendingStatus' <<<"$ID")" == true ]] || stop "the SES identity $IDENTITY is not verified for sending yet (DNS records still propagating?). Nothing was changed."
[[ "$(jq -r '.DkimAttributes.Status' <<<"$ID")" == SUCCESS ]] || stop "DKIM for $IDENTITY is not SUCCESS ($(jq -r '.DkimAttributes.Status' <<<"$ID")). Nothing was changed."
echo "PASS the SES domain identity $IDENTITY is verified and DKIM is SUCCESS"
ACCT="$(A sesv2 get-account --output json)" || stop "cannot read the SES account"
if [[ "$(jq -r '.ProductionAccessEnabled' <<<"$ACCT")" == true ]]; then echo "NOTE the SES account is OUT of the sandbox; the function's allow-list still restricts recipients to $RECIPIENT"
else
  echo "the SES account is in the SANDBOX: the recipient must be a verified identity"
  R="$(A sesv2 get-email-identity --email-identity "$RECIPIENT" --output json 2>/dev/null)" || stop "the recipient $RECIPIENT is not an SES identity. Create it (Identities, Create identity, Email address) and click the link in its inbox. Nothing was changed."
  [[ "$(jq -r '.VerifiedForSendingStatus' <<<"$R")" == true ]] && echo "PASS the recipient is verified" || stop "the recipient $RECIPIENT is not verified yet (click the SES link in its inbox). Nothing was changed."
fi
A lambda get-function --function-name "$FN_NAME" >/dev/null 2>&1 || stop "$FN_NAME does not exist: stage 4 must be deployed first. Nothing was changed."
echo "PASS the email function exists (stage 4 is deployed)"

echo; echo "=== 2. read-only capture of the live TEST stacks ==="
MASTER_ARN="$(A rds describe-db-instances --db-instance-identifier ogevia-postgres --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)"
[[ "$MASTER_ARN" == arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-* ]] || stop "the managed master-secret ARN was not found"
tpl "$STACK" > "$B/live-api.template.json"; tpl "$EGRESS" > "$B/live-egress.template.json"
FN="$(handler_fn)"
A lambda get-function-configuration --function-name "$FN" --query '{FunctionName:FunctionName,CodeSha256:CodeSha256,Database:{name:Environment.Variables.DB_NAME}}' --output json > "$B/handler-before.json"
jq -e '.Database.name=="ogevia_sv_test"' "$B/handler-before.json" >/dev/null || stop "the live TEST Handler does not target the isolated TEST database"
python3 - "$B" <<'PY'
import json, pathlib, sys
b = pathlib.Path(sys.argv[1]); t = json.loads((b / 'live-api.template.json').read_text())
qr = t['Parameters']['ClientQrEncryptionKey']
assert qr.get('Type') == 'String' and qr.get('NoEcho') is True and qr.get('Default', '') == '', 'STOP: the QR parameter metadata is not safe to preserve'
(b / 'qr-parameter-spec.json').write_text(json.dumps(qr))
(b / 'handler-tags.json').write_text(json.dumps(t['Resources']['Handler886CB40B']['Properties'].get('Tags', [])))
PY
QR_SPEC="$(cat "$B/qr-parameter-spec.json")"; TAGS="$(cat "$B/handler-tags.json")"
jq -e '[.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.FunctionName // ""] | map(select(endswith("-NotificationEmail"))) | length == 1' "$B/live-api.template.json" >/dev/null || stop "the live API stack does not contain exactly one email function"
jq -e --arg r "$RECIPIENT_ARN" '[.Resources[] | select(.Type=="AWS::IAM::ManagedPolicy") | .Properties.PolicyDocument.Statement[] | select(.Sid=="SendFromOneIdentity") | .Resource] | map(if type=="array" then . else [.] end) | flatten | index($r) == null' "$B/live-api.template.json" >/dev/null || stop "the live send permission already names the recipient identity. Nothing was changed."
ENVS="$(A lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json)"
[[ "$(jq -r '.SMS_MODE' <<<"$ENVS")" == mock && "$(jq -r '.SERVICE_LOCATION' <<<"$ENVS")" == on && "$(jq -r '.EMAIL_FUNCTION_NAME // "none"' <<<"$ENVS")" == "$FN_NAME" ]] || stop "the live Handler is not at the expected stage-4 state"
echo "PASS the live API is the stage-4 state (texting mock, service location on, email function wired)"

echo; echo "=== 3. two assemblies, checked before anything is changed ==="
synth "$B/off" old
gate "$B/live-api.template.json" "$B/off/$STACK.template.json" "$B/live-egress.template.json" "$B/off/$EGRESS.template.json" same | tee "$B/gate-off.txt" || stop "the rollback assembly differs from live in more than Handler code. Nothing was changed."
synth "$B/on" new
gate "$B/live-api.template.json" "$B/on/$STACK.template.json" "$B/live-egress.template.json" "$B/on/$EGRESS.template.json" identity | tee "$B/gate-on.txt" || stop "the new assembly is not exactly one added identity ARN. Nothing was changed."
find "$B" -type f -not -name SHA256SUMS -exec sha256sum {} + > "$B/SHA256SUMS"

confirm "DEPLOY-TEST-EMAIL-IDENTITY" "ABOUT TO CHANGE TEST ONLY (owner authorization $OGEVIA_DEPLOY_APPROVAL): add ONE SES identity (the approved inbox) to the email function's send permission so SES (in its sandbox) accepts a send to it. The recipient allow-list stays $RECIPIENT only. No database, route, web or other change. Production is not touched."

echo; echo "=== 4. deploy: the API stack (NetworkEgress is unchanged) ==="
(cd "$REPO" && pnpm --dir infra/aws exec cdk deploy --app "$B/on" --exclusively "$STACK" --require-approval broadening --no-notices) || stop "cdk deploy of the API stack failed or was declined. Send the output; decide on rollback with me."
for s in "$STACK" "$EGRESS"; do st="$(A cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text)"; echo "$s: $st"; [[ "$st" == UPDATE_COMPLETE ]] || stop "stack $s status is $st"; done
A lambda wait function-updated --function-name "$FN"
tpl "$STACK" > "$B/after-api.json"; tpl "$EGRESS" > "$B/after-egress.json"
gate "$B/after-api.json" "$B/on/$STACK.template.json" "$B/after-egress.json" "$B/on/$EGRESS.template.json" post || stop "the deployed stacks differ from the assembly"
EF="$(A lambda get-function-configuration --function-name "$FN_NAME" --output json)" || stop "the email function was not created"
[[ "$(jq -r '.Environment.Variables.SES_FROM' <<<"$EF")" == "Ogevia <scheduling@ogevia.com>" && "$(jq -r '.Environment.Variables.SES_REPLY_TO' <<<"$EF")" == "$RECIPIENT" && "$(jq -r '.Environment.Variables.SES_ALLOWED_RECIPIENTS' <<<"$EF")" == "$RECIPIENT" ]] && echo "PASS the email function has exactly the approved From, Reply-To and allow-list" || stop "the email function variables are not as approved"
[[ "$(jq -r '.VpcConfig.VpcId // ""' <<<"$EF")" == "" ]] && echo "PASS the email function is outside the VPC" || stop "the email function is inside a VPC"
# harmless invocations: neither sends anything (an invalid request is refused before SES; a non-allowed address is refused before SES)
inv() { printf '%s' "$1" > "$B/payload.json"; A lambda invoke --function-name "$FN_NAME" --cli-binary-format raw-in-base64-out --payload "file://$B/payload.json" "$B/invoke-out.json" --query StatusCode --output text >/dev/null; cat "$B/invoke-out.json"; }
[[ "$(inv '{}' | jq -r '.error')" == invalid_request ]] && echo "PASS an empty request is refused (nothing sent)" || stop "unexpected answer to an empty request"
[[ "$(inv '{"to":"someone.else@example.com","subject":"x","text":"x"}' | jq -r '.error')" == recipient_not_allowed ]] && echo "PASS another address is refused by the allow-list (nothing sent)" || stop "the allow-list did not refuse another address: STOP and roll back"
HE="$(A lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json)"
[[ "$(jq -r .EMAIL_FUNCTION_NAME <<<"$HE")" == "$FN_NAME" && "$(jq -r .APP_ORIGIN <<<"$HE")" == https://demo.ogevia.com && "$(jq -r .SMS_MODE <<<"$HE")" == mock ]] && echo "PASS the API Handler points at the email function; links use https://demo.ogevia.com; texting is still mock" || stop "the API Handler variables are not as expected"
echo
echo "RT2 STAGE 5 COMPLETE (TEST): the email function may now send to the approved inbox through the SES sandbox (permission on $IDENTITY and $RECIPIENT only; allow-list unchanged). Nothing was sent. Create ONE new open shift inside the 48-hour window to get a fresh email. Production was not touched."
echo "Rollback reference kept in $B (rollback: bash TEST_RT2_N5_EMAIL_RECIPIENT_IDENTITY.sh rollback). Next: docs/release-train-2/test-email-acceptance.md"
