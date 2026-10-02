#!/usr/bin/env bash
# Logic test for CareScore missing-data scoring on plain PostgreSQL.
#   PGHOST/PGPORT/PGUSER must point at a disposable server (superuser).
# 1) negative control: the PREVIOUS scorer (20260823080000) on the same
#    fixtures ranks the incomplete profile above the documented caregiver;
# 2) the fix (20260826010000) applied on top passes every assertion and
#    can be re-applied.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MIG="$HERE/../../migrations"
DB="care_score_test_$$"
createdb "$DB"; trap 'dropdb --if-exists "$DB"' EXIT
q() { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
q -f "$HERE/stub_schema.sql"
q -f "$MIG/20260823080000_wire_real_availability_into_caregiver_matching.sql"
q -f "$HERE/fixtures.sql"
echo "previous scorer (negative control):"
q -At -c "select caregiver_name || ' total=' || match_score || ' availability=' || availability_score || ' skills=' || skills_score from public._score_caregiver_matches('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1') where caregiver_name in ('Alex Complete','Blair Incomplete') order by match_score desc"
q -f "$MIG/20260826010000_matching_no_credit_for_missing_caregiver_data.sql"
q -f "$MIG/20260826010000_matching_no_credit_for_missing_caregiver_data.sql"   # re-runnable
echo "fixed scorer:"
q -At -c "select caregiver_name || ' total=' || match_score || ' availability=' || availability_score || ' skills=' || skills_score || ' missing=' || missing_data::text from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1')"
q -f "$HERE/care_score_missing_data.test.sql"
