#!/usr/bin/env bash
# =============================================================================
# Ogevia SCS PILOT: CloudShell bootstrap. Paste this whole file into AWS
# CloudShell (us-west-2, signed in through IAM Identity Center with
# AdministratorAccess). It:
#   1. installs the GitHub CLI. CloudShell's git is already configured to use
#      /usr/bin/gh as its credential helper, and gh is missing; that is why
#      `git clone` failed;
#   2. signs you in to GitHub in your browser with a one-time code
#      (CHECKPOINT 1; no password or token is typed into CloudShell),
#      and signs out again once the code is downloaded;
#   3. checks out the exact reviewed commit into /tmp/ogevia-pilot;
#   4. runs infra/aws/slice/pilot-deploy.sh. That asks once for the 3 pilot
#      emails and names, and once for DEPLOY (CHECKPOINT 2), then finishes.
# Re-pasting it is safe: completed steps are skipped.
# =============================================================================
set -euo pipefail
PILOT_COMMIT="${PILOT_COMMIT:?set PILOT_COMMIT to the commit Claude gave you}"
REPO_SLUG=socalcaresservices/CarelikGlobal
BRANCH=claude/ogevia-socal-pilot-prep-vfu5tf
DEST=/tmp/ogevia-pilot

if ! command -v gh >/dev/null; then
  echo "Installing the GitHub CLI from GitHub's official package repository..."
  sudo dnf install -y -q 'dnf-command(config-manager)' >/dev/null
  sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null
  sudo dnf install -y -q gh --repo gh-cli >/dev/null
fi
gh --version | head -1

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo
  echo "CHECKPOINT 1 - GitHub sign-in: open https://github.com/login/device on your computer,"
  echo "enter the code shown below, and authorize GitHub CLI. It is signed out again right"
  echo "after the code is downloaded."
  gh auth login --hostname github.com --git-protocol https --web --scopes repo
fi
gh auth setup-git --hostname github.com

if [[ ! -d "$DEST/.git" ]]; then
  git clone --branch "$BRANCH" --single-branch "https://github.com/$REPO_SLUG.git" "$DEST"
fi
git -C "$DEST" fetch -q origin "$BRANCH"
git -C "$DEST" -c advice.detachedHead=false checkout -q "$PILOT_COMMIT"
[[ "$(git -C "$DEST" rev-parse HEAD)" == "$PILOT_COMMIT"* ]] || { echo "checked-out commit does not match $PILOT_COMMIT"; exit 1; }
echo "Code: $(git -C "$DEST" log --oneline -1)"
# The deployment does not need GitHub: drop the token from CloudShell now.
gh auth logout --hostname github.com </dev/null >/dev/null 2>&1 || true

cd "$DEST"
exec bash infra/aws/slice/pilot-deploy.sh
