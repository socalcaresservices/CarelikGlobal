cat > ~/ogevia-release-0036-verify.sh <<'EOF'
#!/usr/bin/env bash
# Ogevia release 0027-0036: VERIFY-ONLY rerun of the 14 live checks with the
# corrected check 6 and a truthful REPORT.md. READ-ONLY in AWS: no deploy,
# migration, rollback or configuration change. Keeps the earlier VERIFY.txt and
# REPORT.md as copies. If CloudShell lost the pinned build in /tmp, it rebuilds
# it locally (install + synth, no AWS change); the verify script refuses any
# build that does not reproduce the approved scope-gate result.
set -uo pipefail
PIN=7b1236d86294c4dacee155d7d3fa06c0af55d9c1   # the approved, deployed commit
FIX=95087eb8cdb3f7984efd146c09f42921d77c9965   # corrected live checks + verify-only script
BR=claude/ogevia-socal-pilot-prep-vfu5tf
SRC=/tmp/ogevia-release-0036
FIXSRC=/tmp/ogevia-release-0036-verify
API_T=Ogevia-prod-ServiceVerificationApi.template.json
NEED_FIX=0; NEED_PIN=0; NEED_BUILD=0
[ "$(git -C "$FIXSRC" rev-parse HEAD 2>/dev/null)" = "$FIX" ] || NEED_FIX=1
[ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" = "$PIN" ] || NEED_PIN=1
[ "$NEED_PIN" = 0 ] && [ -f "$SRC/infra/aws/cdk.out/$API_T" ] || NEED_BUILD=1
if [ "$NEED_FIX$NEED_PIN" != 00 ]; then
  if ! command -v gh >/dev/null; then
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
  fetch() {  # fetch <dir> <commit>
    rm -rf "$1"
    for i in 1 2 3; do git clone -q --branch "$BR" --single-branch https://github.com/socalcaresservices/CarelikGlobal.git "$1" && break; sleep $((i * 5)); done
    git -C "$1" -c advice.detachedHead=false checkout -q "$2" || { echo "STOP: commit ${2:0:7} not found on $BR. Nothing ran."; exit 1; }
  }
  [ "$NEED_FIX" = 1 ] && fetch "$FIXSRC" "$FIX"
  [ "$NEED_PIN" = 1 ] && fetch "$SRC" "$PIN"
  [ "$SIGNED_IN" = 1 ] && gh auth logout --hostname github.com </dev/null >/dev/null 2>&1
fi
if [ "$NEED_BUILD" = 1 ]; then
  echo "Rebuilding the approved commit ${PIN:0:7} locally (install + synth; no AWS change)..."
  export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true NODE_OPTIONS=--max-old-space-size=1536
  (cd "$SRC" && npx -y pnpm@9.15.4 install --frozen-lockfile >/dev/null) || { echo "STOP: install failed. Nothing changed."; exit 1; }
  TAGS=$(for s in Ogevia-prod-EvidenceStorage Ogevia-prod-NetworkEgress Ogevia-prod-WebHosting Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability; do
      aws cloudformation get-template --stack-name "$s" --template-stage Original --query TemplateBody --output json; done \
    | python3 -c 'import sys, json
d = json.JSONDecoder(); s = sys.stdin.read(); i = 0; vals = set()
while i < len(s):
    while i < len(s) and s[i].isspace(): i += 1
    if i >= len(s): break
    t, i = d.raw_decode(s, i)
    for r in t.get("Resources", {}).values():
        for g in (r.get("Properties", {}).get("Tags") or []):
            if isinstance(g, dict) and g.get("Key") == "ogevia:deployment-status": vals.add(g.get("Value"))
print("\n".join(sorted(vals)))')
  [ "$(printf '%s\n' "$TAGS" | wc -l)" = 1 ] && [ "${TAGS#approved-}" != "$TAGS" ] || { echo "STOP: live approval tag is not one consistent value: $TAGS"; exit 1; }
  (cd "$SRC/infra/aws" && OGEVIA_DEPLOY_APPROVAL="${TAGS#approved-}" npx cdk synth --quiet --no-notices -c env=prod -c mode=deploy >/dev/null) \
    || { echo "STOP: synth failed. Nothing changed."; exit 1; }
fi
echo "Verify code: $(git -C "$FIXSRC" log --oneline -1)"
echo "Approved build: $(git -C "$SRC" log --oneline -1)"
cd "$FIXSRC" && OGEVIA_PINNED_REPO="$SRC" bash infra/aws/slice/release-0036-verify.sh
EOF
bash ~/ogevia-release-0036-verify.sh
