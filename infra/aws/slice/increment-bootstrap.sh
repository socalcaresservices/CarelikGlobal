cat > ~/ogevia-increment-run.sh <<'EOF'
#!/usr/bin/env bash
# Ogevia AWS TEST increment 0019-0021. Downloads the PINNED commit into its own
# folder (/tmp/ogevia-increment; the pilot's /tmp/ogevia-pilot and
# ~/ogevia-pilot-run are not touched), runs increment-deploy.sh, then, only if
# the deployment verified, pilot-manager-account.sh (separate manager sign-in).
# Nothing changes in AWS before you type DEPLOY (and MANAGER for the sign-in).
# Paste again to resume; completed steps are skipped.
set -uo pipefail
PIN=1a39dd59fddd48d5c4e57a815331487a979e4b0b
BR=claude/ogevia-socal-pilot-prep-vfu5tf
SRC=/tmp/ogevia-increment
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
cd "$SRC" && OGEVIA_INCREMENT_PIN="$PIN" bash infra/aws/slice/increment-deploy.sh \
  && bash infra/aws/slice/pilot-manager-account.sh
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
bash ~/ogevia-increment-run.sh
