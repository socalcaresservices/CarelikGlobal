#!/usr/bin/env bash
# REPRODUCTION (production Supabase build, plain PostgreSQL, SYNTHETIC data):
# correcting a visit that is already approved for billing leaves the approval
# on the replaced row, and the corrected row can then be approved and
# submitted again. Uses the stub schema of ../service-verification and the
# REAL production function bodies, extracted verbatim from the migrations:
#   correct_service_visit         20260824010000_service_verification_v3.sql (whole file)
#   approve_visit_for_billing     20260822020000_billing_pipeline_amounts.sql
#   submit_billing_approvals      20260822020000_billing_pipeline_amounts.sql
#   list_billing_ready_visits     20260825012407_separate_manager_operational_access_from_financial_data.sql
#   void_billing_approval         20260812193042_billing_approval_pipeline_functions.sql
# Live production function bodies were compared by md5 on 2026-10-04 (read-only): all identical.
# PGHOST/PGPORT/PGUSER must point at a disposable server (superuser).
# Exit 0 = the defect reproduced exactly as described. Changes nothing in production.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MIG="$HERE/../../migrations"; SV="$HERE/../service-verification"
DB="billing_correction_repro_$$"
createdb "$DB"; trap 'dropdb --if-exists "$DB"' EXIT
q() { PGOPTIONS='-c check_function_bodies=off' psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
q -f "$SV/stub_schema.sql"
q -f "$HERE/stub_billing.sql"
q -f "$MIG/20260824010000_service_verification_v3.sql"
for spec in "20260822020000_billing_pipeline_amounts.sql approve_visit_for_billing" \
            "20260822020000_billing_pipeline_amounts.sql submit_billing_approvals" \
            "20260825012407_separate_manager_operational_access_from_financial_data.sql list_billing_ready_visits" \
            "20260812193042_billing_approval_pipeline_functions.sql void_billing_approval"; do
  set -- $spec; python3 "$HERE/extract.py" "$MIG/$1" "$2" | q
done
# The other production paths that update service_visits (latest definitions).
for spec in "20260826070000_link_visits_to_scheduled_shifts.sql end_service_visit" \
            "20260821120000_service_visits_no_login_caregiver.sql sign_service_visit" \
            "20260826090000_manager_close_missed_visit.sql close_missed_service_visit" \
            "20260813061500_shift_verification_v2_guardrails.sql void_service_visit" \
            "20260809042943_service_verification.sql approve_visit_billing"; do
  set -- $spec; python3 "$HERE/extract.py" "$MIG/$1" "$2" | q
done
# Every function body under test must be identical to live production: md5 of
# prosrc with CRLF line endings normalised to LF (read-only, 2026-10-04). Only
# close_missed_service_visit has CRLF endings in production (it was applied
# outside this repository's migration history); its text is otherwise identical.
while read -r fn want; do
  got=$(q -At -c "select md5(replace(prosrc, E'\\r\\n', E'\\n')) from pg_proc where proname = '$fn' and pronamespace = 'public'::regnamespace")
  [[ "$got" == "$want" ]] || { echo "BODY MISMATCH: $fn is not the production body ($got vs $want)"; exit 1; }
done < "$HERE/prod_function_md5_2026-10-04.txt"
echo "Function bodies identical to production: $(wc -l < "$HERE/prod_function_md5_2026-10-04.txt") of $(wc -l < "$HERE/prod_function_md5_2026-10-04.txt")"
q -f "$SV/fixtures.sql"
q -f "$HERE/scenario.sql"

# The proposed fix (not applied anywhere): load it, then the same path is refused.
echo "--- proposed fix ---"
q -f "$HERE/../../proposed/20261004120000_block_correction_of_billing_approved_visits.sql"
q -f "$HERE/../../proposed/20261004120000_block_correction_of_billing_approved_visits.sql"   # re-runnable
q -f "$HERE/verify_fix.sql"
echo "--- every write path on an approved visit ---"
q -f "$HERE/all_paths.sql"
echo "--- concurrent sessions ---"
source "$HERE/concurrency.sh"
