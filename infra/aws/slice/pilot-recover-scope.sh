#!/usr/bin/env bash
# =============================================================================
# Resume the SCS pilot run after the phase-7 stop, with the STRICT scope gate.
# Keeps: saved pilot details, the quality-gate pass for 87a9be2, the rollback
# capture, and the DEPLOY prompt. Stops if an approval marker already exists.
# The recovery itself is logged to ~/ogevia-pilot-run/recover-<UTC>.log, and
# any exit (normal, STOP, or killed) prints its step and exit code.
# Nothing changes in AWS before DEPLOY. Steps:
#   1. checks the saved run (details, passed checks, rollback capture, no approval);
#   2. checks the checkout at 87a9be2; CloudShell clears /tmp between sessions,
#      so a missing checkout is downloaded again (GitHub device sign-in, then
#      signed out again);
#   3. installs the strict gate (verified by sha256) and patches ONE line of
#      pilot-deploy.sh so synth uses the LIVE ogevia:deployment-status value;
#   4. derives that value from the captured live templates (one value, valid);
#   5. checks, read-only, that the 5 live templates still equal the capture;
#   6. prints live-route evidence, re-synthesizes, runs the gate;
#   7. resumes pilot-deploy.sh, which asks for DEPLOY.
# =============================================================================
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
export PYTHONDONTWRITEBYTECODE=1   # 87a9be2 tracks a .pyc; do not rewrite it
REPO="${OGEVIA_PILOT_REPO:-/tmp/ogevia-pilot}"
RUN="${OGEVIA_PILOT_RUN_DIR:-$HOME/ogevia-pilot-run}"
EXPECT="${PILOT_COMMIT:-87a9be2bf87e83750d235bfe943b18d5e702cac2}"
GATE_SHA=484b7dfcf74ad2d2e9e3a77d3d4eceaf27fc6a1733c4041c41996138aae0203c
REPO_SLUG=socalcaresservices/CarelikGlobal
BRANCH=claude/ogevia-socal-pilot-prep-vfu5tf
API=Ogevia-prod-ServiceVerificationApi
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
stop() { STOPPED=1; say "STOP in recovery step \"$STEP\": $*"; say "Nothing was changed in AWS. Recovery log: $LOG"; exit 1; }
on_exit() {
  local rc=$?
  [[ -n "${STOPPED:-}" || -n "${HANDED_OVER:-}" ]] && return 0
  local hint=""; [[ $rc == 137 ]] && hint=", killed: likely out of memory"
  say "RECOVERY EXITED in step \"$STEP\" (exit $rc$hint). Recovery log: $LOG"
}
trap on_exit EXIT
echo "Recovery started $(date -u +%FT%TZ); log: $LOG"

step "1/7 saved run"
for f in inputs.env "state/tests-${EXPECT:0:12}" state/rollback-captured rollback/routes.json; do
  [[ -e "$RUN/$f" ]] || stop "$RUN/$f is missing"
done
for s in "${STACKS[@]}"; do [[ -s "$RUN/rollback/templates/$s.json" ]] || stop "rollback template $s.json is missing"; done
[[ ! -e "$RUN/state/approved" ]] || stop "an approval marker already exists ($RUN/state/approved: $(tr '\n' ' ' < "$RUN/APPROVAL.txt" 2>/dev/null)). A previous DEPLOY must not carry over to a new scope; send this to Claude."
for m in snapshot db-window api-deployed web-deployed complete; do
  [[ ! -e "$RUN/state/$m" ]] || stop "state/$m exists without an approval marker; send this to Claude"
done
echo "Kept: pilot details ($(grep -c '_EMAIL=' "$RUN/inputs.env") sign-ins), quality-gate pass for ${EXPECT:0:12}, rollback capture (5 templates, $(jq length "$RUN/rollback/routes.json") routes). No approval marker: DEPLOY will be asked."

step "2/7 code checkout at ${EXPECT:0:12}"
if [[ ! -e "$REPO/.git" ]]; then
  echo "$REPO is gone (CloudShell clears /tmp between sessions); downloading ${EXPECT:0:12} again."
  if ! command -v gh >/dev/null; then
    echo "Installing the GitHub CLI from GitHub's official package repository..."
    { sudo dnf install -y -q 'dnf-command(config-manager)' && sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo \
      && sudo dnf install -y -q gh --repo gh-cli; } >/dev/null || stop "could not install the GitHub CLI"
  fi
  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "GitHub sign-in: open https://github.com/login/device, enter the code below and authorize GitHub CLI."
    echo "It is signed out again right after the download."
    gh auth login --hostname github.com --git-protocol https --web --scopes repo || stop "GitHub sign-in failed"
  fi
  gh auth setup-git --hostname github.com || stop "gh auth setup-git failed"
  git clone -q --branch "$BRANCH" --single-branch "https://github.com/$REPO_SLUG.git" "$REPO" || stop "git clone failed"
  git -C "$REPO" -c advice.detachedHead=false checkout -q "$EXPECT" || stop "commit ${EXPECT:0:12} not found"
  gh auth logout --hostname github.com </dev/null >/dev/null 2>&1 || true
fi
[[ "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" == "$EXPECT"* ]] || stop "$REPO is not at ${EXPECT:0:12} (it is at $(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null))"
OTHER=$(git -C "$REPO" status --porcelain --untracked-files=no | grep -vE ' infra/aws/slice/(pilot_diff_gate\.py|pilot-deploy\.sh|__pycache__/[A-Za-z0-9_.-]+\.pyc)$' || true)
[[ -z "$OTHER" ]] || stop "the checkout has other local changes: $OTHER"
echo "Code: $(git -C "$REPO" log --oneline -1)"

step "3/7 strict gate and one-line synth patch"
GATE="$RUN/tools/pilot_diff_gate.py"
[[ "$(sha256sum "$GATE" 2>/dev/null | cut -d' ' -f1)" == "$GATE_SHA" ]] || stop "strict gate file checksum mismatch (paste the whole block again)"
cp "$GATE" "$REPO/infra/aws/slice/pilot_diff_gate.py"
DEPLOY_SH="$REPO/infra/aws/slice/pilot-deploy.sh"
OLD_LINE='export OGEVIA_DEPLOY_APPROVAL="pilot-test-$COMMIT"'
NEW_LINE='export OGEVIA_DEPLOY_APPROVAL="${OGEVIA_PILOT_TAG_REF:-pilot-test-$COMMIT}"'
if grep -qxF "$OLD_LINE" "$DEPLOY_SH"; then
  sed -i "s|^export OGEVIA_DEPLOY_APPROVAL=\"pilot-test-\$COMMIT\"\$|$NEW_LINE|" "$DEPLOY_SH"
fi
[[ "$(grep -c '^export OGEVIA_DEPLOY_APPROVAL=' "$DEPLOY_SH")" == 1 ]] && grep -qxF "$NEW_LINE" "$DEPLOY_SH" \
  || stop "could not apply the one-line synth patch to pilot-deploy.sh"
[[ "$(git -C "$REPO" diff --numstat -- infra/aws/slice/pilot-deploy.sh | awk '{print $1+$2}')" == 2 ]] \
  || stop "pilot-deploy.sh differs from ${EXPECT:0:12} by more than the one patched line"
echo "Installed: strict scope gate (sha256 ${GATE_SHA:0:12}...); pilot-deploy.sh synth uses the live tag value (1 line)."

step "4/7 live approval tag"
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
echo "Live ogevia:deployment-status: $TAGS (kept unchanged; this approval is recorded in $RUN/APPROVAL.txt)"

step "5/7 live templates still equal the rollback capture (read-only)"
aws sts get-caller-identity --query Account --output text >/dev/null 2>&1 || stop "AWS credentials are not valid: sign in again and reopen CloudShell"
for s in "${STACKS[@]}"; do
  live=$(aws cloudformation get-template --stack-name "$s" --template-stage Original --query TemplateBody --output json) || stop "could not read the live template of $s"
  [[ "$(jq -S . <<<"$live")" == "$(jq -S . "$RUN/rollback/templates/$s.json")" ]] \
    || stop "the live template of $s changed since the rollback capture; send this to Claude"
done
echo "All 5 live templates equal the capture."

step "6/7 live routes, re-synthesis, strict scope gate"
echo "Live routes: $(jq length "$RUN/rollback/routes.json") ($(jq '[.[] | select(.[1]=="NONE")] | length' "$RUN/rollback/routes.json") public)"
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
  || stop "the strict scope gate does not pass (output above). Send this output to Claude."

step "7/7 resume pilot-deploy.sh (it stops at DEPLOY for your approval)"
echo "The deployment writes its own log: $RUN/deploy-<UTC>.log"
cd "$REPO" || stop "cannot enter $REPO"
bash infra/aws/slice/pilot-deploy.sh
rc=$?
HANDED_OVER=1
say "pilot-deploy.sh exit code: $rc (recovery log: $LOG; deployment log: $(ls -t "$RUN"/deploy-*.log 2>/dev/null | head -1))"
exit "$rc"
