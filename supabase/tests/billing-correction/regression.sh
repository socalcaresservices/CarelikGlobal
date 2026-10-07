#!/usr/bin/env bash
# REGRESSION for the proposed production fix (the proposed migration): the existing
# Service Verification harness (../service-verification/run.sh: visit<->shift
# link, shift-based access, manager close-out) runs unchanged with the fix
# loaded, so the new status guard changes nothing except approved visits.
# Same stub schema and real production migrations as run.sh there.
# PGHOST/PGPORT/PGUSER must point at a disposable server (superuser).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MIG="$HERE/../../migrations"; SV="$HERE/../service-verification"
DB="sv_regression_with_fix_$$"
createdb "$DB"; trap 'dropdb --if-exists "$DB"' EXIT
q() { PGOPTIONS='-c check_function_bodies=off' psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
q -f "$SV/stub_schema.sql"
q -f "$HERE/stub_billing.sql"
q -f "$MIG/20260824010000_service_verification_v3.sql"
q -f "$HERE/../../proposed/20261004120000_block_correction_of_billing_approved_visits.sql"
echo "proposed fix loaded"
q -f "$SV/fixtures.sql"
q -f "$MIG/20260826070000_link_visits_to_scheduled_shifts.sql"
q -f "$SV/visit_shift_link.test.sql"
q -f "$SV/fixtures_shift_access.sql"
q -f "$MIG/20260826080000_visit_access_from_scheduled_shift.sql"
q -f "$SV/shift_access.test.sql"
q -f "$MIG/20260826090000_manager_close_missed_visit.sql"
q -f "$SV/close_out.test.sql"
echo "REGRESSION PASSED: existing Service Verification assertions all pass with the fix loaded"
