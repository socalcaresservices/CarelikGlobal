cat > ~/ogevia-increment-resume.sh <<'EOF'
#!/usr/bin/env bash
# Ogevia AWS TEST increment 0019-0021: verify, then deploy or resume, then
# post-check, then the separate manager sign-in.
#
# Status before this run: the increment is NOT VERIFIED. The absence of
# ~/ogevia-increment-run and the 38 live routes show it was not completed
# through this workflow; they do not prove that the database, Lambda or web
# were left untouched. The preflight establishes that from live evidence.
#
# Two pinned commits:
#   PIN        1a39dd5, the code that is deployed (unchanged, reviewed);
#   TOOLS_PIN  the reviewed preflight / post-check tools (increment-preflight.sh,
#              increment_preflight.py and the expected database fingerprints).
#
# 1. PREFLIGHT (no deployment): routes and their authorisation, API Lambda code
#    and settings, web build, TEST database, migration ledger and checksums,
#    every function and column, and (fresh run) a value fingerprint of every
#    existing record. Anything UNKNOWN, unexpected or partial STOPS. An existing
#    run resumes only in a supported recovery state that matches live evidence.
# 2. DEPLOY: the pinned increment-deploy.sh (its own DEPLOY prompt; resumable).
# 3. POST-CHECK: ledger and objects at 0021, the 1a39dd5 routes, Lambda and web,
#    and every existing record unchanged by value.
# 4. MANAGER: pilot-manager-account.sh (its own MANAGER prompt).
# Paste again to resume. Never prints secrets.
set -uo pipefail
PIN=1a39dd59fddd48d5c4e57a815331487a979e4b0b
TOOLS_PIN=d315668e76c387f6e3066c735dcd9908185a887c
BR=claude/ogevia-socal-pilot-prep-vfu5tf
SRC=${OGEVIA_INCREMENT_SRC:-/tmp/ogevia-increment}
TOOLS=${OGEVIA_PREFLIGHT_TOOLS:-/tmp/ogevia-increment-tools}
if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" != "$PIN" ] || ! git -C "$SRC" cat-file -e "$TOOLS_PIN^{commit}" 2>/dev/null; then
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
git -C "$SRC" cat-file -e "$TOOLS_PIN^{commit}" 2>/dev/null || { echo "STOP: tools commit ${TOOLS_PIN:0:7} not found on $BR. Nothing ran."; exit 1; }
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || { echo "STOP: the checkout in $SRC has local changes. Nothing ran."; exit 1; }
if [ -z "${OGEVIA_PREFLIGHT_TOOLS:-}" ]; then
  rm -rf "$TOOLS" && mkdir -p "$TOOLS"
  git -C "$SRC" archive "$TOOLS_PIN" infra/aws/slice/increment-preflight.sh infra/aws/slice/increment_preflight.py \
    infra/aws/slice/increment-preflight-expected | tar -x -C "$TOOLS" --strip-components=3 \
    || { echo "STOP: could not extract the preflight tools. Nothing ran."; exit 1; }
fi
echo "Code: $(git -C "$SRC" log --oneline -1); tools: ${TOOLS_PIN:0:7}"

bash "$TOOLS/increment-preflight.sh" pre "$SRC" "$TOOLS"; rc=$?
if [ "$rc" = 3 ]; then
  echo "The increment run is already complete; running the post-check."
elif [ "$rc" = 0 ]; then
  (cd "$SRC" && OGEVIA_INCREMENT_PIN="$PIN" bash infra/aws/slice/increment-deploy.sh) || exit $?
else
  exit "$rc"
fi
if [ -f "$HOME/ogevia-increment-preflight/state/postcheck" ]; then
  echo "Post-check already passed ($(cat "$HOME/ogevia-increment-preflight/state/postcheck"))."
else
  bash "$TOOLS/increment-preflight.sh" post "$SRC" "$TOOLS" || exit $?
fi
(cd "$SRC" && bash infra/aws/slice/pilot-manager-account.sh)
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
