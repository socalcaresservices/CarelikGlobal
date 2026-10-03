#!/usr/bin/env bash
# =============================================================================
# Ogevia SCS PILOT: resume a deployment that died silently in phase 5.
#
# The quality gate ran turbo with its default parallelism. Typecheck peaks at
# about 2.0 GB and tests at about 2.8 GB of Node memory that way, versus about
# 1.15 GB one task at a time. On a small CloudShell that can exhaust memory;
# when the kill reaches the script or its logging pipe, the run ends with no
# STOPPED line. This script re-runs the SAME checks (typecheck, lint, test,
# build) one task at a time with a capped Node heap, records the pass for this
# commit, and resumes pilot-deploy.sh. That keeps the saved pilot details in
# ~/ogevia-pilot-run and still asks for DEPLOY. It changes nothing in AWS.
# =============================================================================
set -uo pipefail
REPO="${OGEVIA_PILOT_REPO:-/tmp/ogevia-pilot}"
RUN="${OGEVIA_PILOT_RUN_DIR:-$HOME/ogevia-pilot-run}"
EXPECT="${PILOT_COMMIT:-87a9be2bf87e83750d235bfe943b18d5e702cac2}"
mkdir -p "$RUN/state"
LOG="$RUN/recovery-$(date -u +%Y%m%dT%H%M%SZ).log"
say() { echo "$*" | tee -a "$LOG"; }

[[ -d "$REPO/.git" && "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" == "$EXPECT"* ]] || {
  echo "STOP: $REPO is missing or not at ${EXPECT:0:12} (CloudShell was restarted). Run ~/ogevia-bootstrap.sh instead."; exit 1; }
[[ -f "$RUN/inputs.env" ]] || { echo "STOP: no saved pilot details in $RUN"; exit 1; }

say "== Diagnosis"
say "CPUs: $(nproc)"
free -m | tee -a "$LOG"
df -h /tmp "$HOME" | tee -a "$LOG"
LAST=$(ls -t "$RUN"/deploy-*.log 2>/dev/null | head -1)
[[ -n "$LAST" ]] && { say "Previous deployment log ($LAST) ends with:"; tail -3 "$LAST" | tee -a "$LOG"; }
say "Saved pilot details: kept ($(grep -c '_EMAIL=' "$RUN/inputs.env") sign-ins). DEPLOY approval already given: $([[ -f "$RUN/state/approved" ]] && echo yes || echo no)"

cd "$REPO" || { echo "STOP: cannot enter $REPO"; exit 1; }
export NODE_OPTIONS=--max-old-space-size=1536
P=(npx -y pnpm@9.15.4)
C=$(git rev-parse --short=12 HEAD)
if [[ ! -f "$RUN/state/tests-$C" ]]; then
  say "== Quality gate on ${C}, one task at a time (typecheck, lint, test, build)"
  "${P[@]}" install --frozen-lockfile >>"$LOG" 2>&1 || { say "STOP: pnpm install failed. Last lines:"; tail -20 "$LOG"; exit 1; }
  for t in typecheck lint test build; do
    extra=()
    [[ "$t" == test ]] && extra=(-- --pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1)
    say "-- $t (detail in $LOG)"
    "${P[@]}" exec turbo run "$t" --concurrency=1 --force "${extra[@]}" >>"$LOG" 2>&1
    rc=$?
    if [[ $rc != 0 ]]; then
      say "STOP: $t failed with exit code $rc$([[ $rc == 137 ]] && echo ' (killed: out of memory)'). Last lines:"
      tail -25 "$LOG"; exit 1
    fi
    say "   $t: PASS ($(grep -Eo 'Tasks: +[0-9]+ successful, [0-9]+ total' "$LOG" | tail -1 | tr -s ' '))"
  done
  grep -E ':test: +Tests ' "$LOG" | sed 's/^/   /'
  touch "$RUN/state/tests-$C"
else
  say "Quality gate already passed for $C."
fi

say "== Resuming the deployment (details kept; the DEPLOY approval is still required)"
bash infra/aws/slice/pilot-deploy.sh
rc=$?
case $rc in
  0) say "pilot-deploy.sh finished (exit 0)." ;;
  137) say "pilot-deploy.sh was KILLED (exit 137): out of memory. Send $LOG and the newest ~/ogevia-pilot-run/deploy-*.log." ;;
  141) say "pilot-deploy.sh lost its output pipe (exit 141). Send $LOG and the newest ~/ogevia-pilot-run/deploy-*.log." ;;
  *) say "pilot-deploy.sh stopped (exit $rc): see the STOPPED line above." ;;
esac
exit "$rc"
