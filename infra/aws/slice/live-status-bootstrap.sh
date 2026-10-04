cat > ~/ogevia-live-status-run.sh <<'EOF'
#!/usr/bin/env bash
# Ogevia AWS TEST live status. READ-ONLY unless you type READ-DB (temporary DB
# window, restored and verified) or OWNER (shown in full first).
set -uo pipefail
PIN=f91fe68ff1ecc8419f6a8723333d8deb7977ae1b
BR=claude/ogevia-socal-pilot-prep-vfu5tf
SRC=/tmp/ogevia-pilot; [ -d "$SRC/.git" ] || SRC="$HOME/ogevia-live-status-src"
OUT="$HOME/ogevia-live-status"; mkdir -p "$OUT"
SIGNED_IN=0
github_login() {
  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "Sign in to GitHub (read access to socalcaresservices/CarelikGlobal):"
    gh auth login --hostname github.com --git-protocol https --web --scopes repo || return 1
    SIGNED_IN=1
  fi
  gh auth setup-git --hostname github.com >/dev/null 2>&1
}
if [ ! -d "$SRC/.git" ]; then
  github_login || { echo "STOP: GitHub sign-in did not complete. Nothing ran."; exit 1; }
  git clone -q --branch "$BR" --single-branch https://github.com/socalcaresservices/CarelikGlobal.git "$SRC" || { echo "STOP: could not download the code. Nothing ran."; exit 1; }
fi
if ! git -C "$SRC" fetch -q origin "$BR" 2>/dev/null; then
  github_login || { echo "STOP: GitHub sign-in did not complete. Nothing ran."; exit 1; }
  git -C "$SRC" fetch -q origin "$BR" || { echo "STOP: could not fetch $BR. Nothing ran."; exit 1; }
fi
[ "$SIGNED_IN" = 1 ] && gh auth logout --hostname github.com </dev/null >/dev/null 2>&1
for f in phase7_evidence.py owner-access-check.sh live-status-check.sh; do
  git -C "$SRC" show "$PIN:infra/aws/slice/$f" > "$OUT/$f" || { echo "STOP: $f not found at ${PIN:0:7}. Nothing ran."; exit 1; }
done
( cd "$OUT" && sha256sum -c --quiet <<SUMS
8377ecdc675b303961702964a25f4e4bbb080733fb1f07b9c823b917d7a9a926  phase7_evidence.py
ae90de8be38f8fe3fb4ff807395a3ea298f7e2414c85428413b62f8ad09e360b  owner-access-check.sh
830851f7cfad477df49770b488c787523aad9e9e0c4bfeef28444ba904e309fb  live-status-check.sh
SUMS
) || { echo "STOP: checksum mismatch. Nothing ran."; exit 1; }
echo "Scripts verified (commit ${PIN:0:7}). The pilot checkout was not changed."
bash "$OUT/live-status-check.sh"
EOF
bash ~/ogevia-live-status-run.sh
