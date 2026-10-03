#!/usr/bin/env bash
# Builds the self-contained TEST-slice bundle run from AWS CloudShell:
#   cdk.out (deploy-mode assembly, Lambda bundled) + web/ (AWS build; runtime
#   config written at deploy time) + finish.sh + smoke.py
# No AWS calls. Output: <repo>/deploy-bundle/ogevia-slice-<gitsha>.tgz (+ .sha256)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
SHA=$(git -C "$REPO" rev-parse --short=12 HEAD)
STAGE="$REPO/deploy-bundle/ogevia-slice"; OUT="$REPO/deploy-bundle/ogevia-slice-$SHA.tgz"
rm -rf "$STAGE" && mkdir -p "$STAGE"
(cd "$HERE" && rm -rf cdk.out && env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
  OGEVIA_DEPLOY_APPROVAL=owner-approved-2026-10-01-test-slice CDK_DISABLE_CLI_TELEMETRY=true \
  npx cdk synth --quiet --no-notices -c env=prod -c mode=deploy >/dev/null)
(cd "$HERE" && npx tsx scripts/synth-inventory.ts | grep -q "Scanner violations: \*\*0\*\*") || { echo "template scanner found violations"; exit 1; }
cp -r "$HERE/cdk.out" "$STAGE/cdk.out"
(cd "$REPO/apps/web" && VITE_APP_ENV=production VITE_AUTH_PROVIDER=cognito npx vite build --outDir "$STAGE/web" --emptyOutDir >/dev/null)
cp "$HERE/slice/finish.sh" "$HERE/slice/smoke.py" "$STAGE/"
mkdir -p "$STAGE/db"
cp "$HERE/db/migrations/0010_reporting_acceptance_improvements.sql" "$STAGE/db/"
cp "$HERE/db/migrations/0011_care_requests_availability.sql" "$STAGE/db/"
cp "$HERE/db/migrations/0012_care_portal_request_list.sql" "$STAGE/db/"
cp "$HERE/db/migrations/0013_link_visits_to_shifts.sql" "$STAGE/db/"
cp "$HERE/db/migrations/0014_visit_access_from_scheduled_shift.sql" "$STAGE/db/"
cp "$HERE/db/migrations/0015_manager_close_missed_visit.sql" "$STAGE/db/"
cp "$HERE/db/migrations/0016_remaining_minutes_count_reservations.sql" "$STAGE/db/"
cp "$HERE/db/migrations/0017_next_scheduled_service.sql" "$STAGE/db/"
cp "$HERE/db/verification/01_schema_version.sql" "$HERE/db/verification/02_required_objects.sql" "$STAGE/db/"
printf 'commit %s\nbuilt %s\napproval owner-approved-2026-10-01-test-slice\n' "$(git -C "$REPO" rev-parse HEAD)" "$(date -u +%FT%TZ)" > "$STAGE/BUILD_INFO"
tar -czf "$OUT" -C "$REPO/deploy-bundle" ogevia-slice
sha256sum "$OUT" | awk '{print $1}' > "$OUT.sha256"
echo "$OUT"; cat "$OUT.sha256"
