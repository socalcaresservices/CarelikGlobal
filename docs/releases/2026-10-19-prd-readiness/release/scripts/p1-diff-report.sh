#!/usr/bin/env bash
# P1 DIFF REPORT (READ-ONLY, local files only; no AWS call). Compares each captured LIVE template ($B/live/<stack>.json from p0) with the release template bundled in this package
# (release-templates/<stack>.json, synthesized from the pinned commit), and writes $B/diff-<stack>.txt. It is a REPORT: it decides nothing. The gate that allows only expected
# differences is written after this report has been read.
#   bash p1-diff-report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need python3 jq
STACKS=(Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-WebHosting Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability Ogevia-prod-NetworkEgress)
say "== P1 diff report $(date -u +%FT%TZ): live ($B/live) vs release templates ($PKG_ROOT/release-templates) =="
[[ -d "$B/live" ]] || stop "run p0-baseline-capture.sh first ($B/live is missing)"
TOTAL=0
for S in "${STACKS[@]}"; do
  L="$B/live/$S.json"; N="$PKG_ROOT/release-templates/$S.json"
  [[ -s "$L" ]] || { nope "no captured live template for $S"; continue; }
  [[ -s "$N" ]] || { nope "the package has no release template for $S"; continue; }
  python3 -I -B "$PKG_ROOT/scripts/tpl_diff.py" "$L" "$N" > "$B/diff-$S.txt"; rc=$?
  case $rc in 0|1) ;; *) nope "$S: the comparison could not run: $(head -1 "$B/diff-$S.txt")"; continue ;; esac
  say "-- $S: $(tail -1 "$B/diff-$S.txt")"
  [[ $rc == 0 ]] && ok "$S equals the release template" || info "$S differs from the release template (full list: diff-$S.txt)"
  TOTAL=$((TOTAL + $(grep -c -E '^(RESOURCE|CHANGED|SECTION)' "$B/diff-$S.txt")))
  grep -E '^(RESOURCE|CHANGED|SECTION)' "$B/diff-$S.txt" | head -"${OGEVIA_DIFF_LINES:-25}" | sed 's/^/     /' | tee -a "$LOG"
done
say "difference lines in total: $TOTAL"
[[ $bad == 0 ]] && say "DIFF REPORT DONE: $B/diff-*.txt. Nothing was changed. Paste the SUMMARY lines." || stop "a comparison could not run (see FAIL lines)"
