#!/usr/bin/env bash
# Logic test for the Service Verification visit <-> scheduled shift link on
# plain PostgreSQL.
#   PGHOST/PGPORT/PGUSER must point at a disposable server (superuser).
# 1) negative control: the PREVIOUS start function (20260824010000) leaves a
#    visit unlinked even while its shift is in progress;
# 2) the fix (20260826070000), applied twice (re-runnable), passes every
#    assertion in visit_shift_link.test.sql.
# Functions are loaded with check_function_bodies off because the stub schema
# carries only the tables these functions use.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MIG="$HERE/../../migrations"
DB="sv_shift_link_test_$$"
createdb "$DB"; trap 'dropdb --if-exists "$DB"' EXIT
q() { PGOPTIONS='-c check_function_bodies=off' psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
q -f "$HERE/stub_schema.sql"
q -f "$MIG/20260824010000_service_verification_v3.sql"
q -f "$HERE/fixtures.sql"
echo "previous start function (negative control):"
visit=$(q -At -c "select set_config('test.uid','00000000-0000-4000-8000-000000000100',false)" \
  -c "select public.start_ad_hoc_service_visit('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000e1')" | tail -1)
linked=$(q -At -c "select coalesce(scheduled_shift_id::text, 'unlinked') from public.service_visits where id = '$visit'")
echo "  visit during an in-progress shift: $linked"
[ "$linked" = "unlinked" ] || { echo "negative control did not reproduce the gap"; exit 1; }
q -f "$MIG/20260826070000_link_visits_to_scheduled_shifts.sql"
q -f "$MIG/20260826070000_link_visits_to_scheduled_shifts.sql"   # re-runnable
q -f "$HERE/visit_shift_link.test.sql"
# 3) shift-based access (20260826080000): caregivers with a shift but no
#    standing assignment. Negative control on the previous start function first.
q -f "$HERE/fixtures_shift_access.sql"
refused=$(q -At -c "select set_config('test.uid','00000000-0000-4000-8000-00000000010a',false)" \
  -c "do \$\$ begin perform public.start_ad_hoc_service_visit('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000e1'); raise notice 'started'; exception when others then raise notice '%', sqlerrm; end \$\$" 2>&1 | tail -1)
echo "  scheduled caregiver without an assignment, previous function: $refused"
case "$refused" in *"not assigned to you"*) ;; *) echo "negative control did not reproduce the gap"; exit 1;; esac
q -f "$MIG/20260826080000_visit_access_from_scheduled_shift.sql"
q -f "$MIG/20260826080000_visit_access_from_scheduled_shift.sql"   # re-runnable
q -f "$HERE/shift_access.test.sql"
# 4) manager close-out of a missed clock-out (20260826090000).
q -f "$MIG/20260826090000_manager_close_missed_visit.sql"
q -f "$MIG/20260826090000_manager_close_missed_visit.sql"   # re-runnable
q -f "$HERE/close_out.test.sql"
