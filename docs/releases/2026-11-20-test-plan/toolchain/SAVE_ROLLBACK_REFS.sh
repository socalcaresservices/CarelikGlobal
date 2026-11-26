#!/usr/bin/env bash
# Copies every TEST rollback capture (rt2n1-, rt2n2-, rt2n3-, rt2n4- folders) from the work folders to a durable place in your HOME folder and writes an INDEX.md that says,
# for each one, which release it belongs to, its snapshot id, and the exact rollback command and typed word. Run it after every TEST deployment (it is safe to run again).
# It uses NO AWS, writes nothing outside $DEST, deletes nothing, and never prints a secret (the captures hold live web files, Lambda code, CloudFormation templates and ids; no passwords).
#   bash SAVE_ROLLBACK_REFS.sh            # DEST defaults to $HOME/ogevia-rollback-refs; WORKS defaults to /tmp/rt2n2/work /tmp/rt2/work $HOME
#   DEST=<dir> WORKS="<dir> <dir>" bash SAVE_ROLLBACK_REFS.sh
set -euo pipefail
umask 077
DEST="${DEST:-$HOME/ogevia-rollback-refs}"
WORKS="${WORKS:-/tmp/rt2n2/work /tmp/rt2/work $HOME}"
LIMIT_MB="${LIMIT_MB:-600}"
mkdir -p "$DEST"; chmod 700 "$DEST"
copied=0; kept=0
for w in $WORKS; do
  [[ -d "$w" ]] || continue
  for d in "$w"/rt2n[1-4]-2*; do
    [[ -d "$d" && ! -L "$d" ]] || continue
    name="$(basename "$d")"
    if [[ -d "$DEST/$name" ]]; then kept=$((kept + 1)); continue; fi
    size_kb="$(du -sk "$d" | cut -f1)"; used_kb="$(du -sk "$DEST" | cut -f1)"
    if (( used_kb + size_kb > LIMIT_MB * 1024 )); then echo "STOP: copying $name would take $DEST over ${LIMIT_MB} MB. Free space first (nothing was copied for it)." >&2; exit 2; fi
    cp -a "$d" "$DEST/$name"
    if [[ -f "$DEST/$name/SHA256SUMS" ]]; then (cd "$DEST/$name" && sha256sum --check --quiet SHA256SUMS) || { rm -rf "$DEST/$name"; echo "STOP: the copy of $name does not match its checksums; it was removed. The original was not touched." >&2; exit 2; }; fi
    copied=$((copied + 1)); echo "saved $name"
  done
done
{
  echo "# Ogevia TEST rollback references"; echo; echo "Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) from: $WORKS. Keep this folder; it is outside /tmp so it survives a CloudShell reset."; echo
  echo "Run a rollback from a checkout of the SAME release commit (REPO, OGEVIA_RELEASE_COMMIT, WORK, OGEVIA_DEPLOY_APPROVAL as in the deploy), after copying the folder back under \$WORK. Order within a stage is in docs/release-train-2/rollback-plan.md."; echo
  echo "| Folder | Stage | Release commit | Snapshot | Size | Rollback (script modes, typed words) |"; echo "|---|---|---|---|---|---|"
  for d in "$DEST"/rt2n[1-4]-2*; do
    [[ -d "$d" ]] || continue; name="$(basename "$d")"
    case "$name" in
      rt2n1-*) st="1 notifications (in-app)"; rb='TEST_RT2_N1_NOTIFICATIONS.sh: rollback-web (ROLLBACK-TEST-WEB), rollback-routes (ROLLBACK-TEST-ROUTES), rollback-api (ROLLBACK-TEST-API); database: TEST_PENDING_LEDGER.sh rollback, reverse order';;
      rt2n2-*) st="2 open-shift texting (mock) + service location"; rb='TEST_RT2_N2_SMS_LOCATION.sh: rollback-web, rollback-routes, rollback-api, rollback-db (ROLLBACK-TEST-0118-0117)';;
      rt2n3-*) st="3 alert card, exact-shift link, migration 0120"; rb='TEST_RT2_N3_ALERT_CARD.sh: rollback-web (ROLLBACK-TEST-WEB), rollback-api (ROLLBACK-TEST-API), rollback-db (ROLLBACK-TEST-0120)';;
      rt2n4-*) st="4 email function (SES)"; rb='TEST_RT2_N4_EMAIL.sh rollback (ROLLBACK-TEST-EMAIL). Turn email OFF in the app first';;
    esac
    echo "| $name | $st | $(cat "$d/release-commit.txt" 2>/dev/null || echo unknown) | $(cat "$d/snapshot-id.txt" 2>/dev/null || echo none) | $(du -sh "$d" | cut -f1) | $rb |"
  done
  echo; echo "Reverse order for everything on TEST: stage 4, then 3, then 2, then 1. Within a stage the order is web, routes, api, db."
} > "$DEST/INDEX.md"
echo "DONE: $copied new, $kept already saved. Index: $DEST/INDEX.md"
