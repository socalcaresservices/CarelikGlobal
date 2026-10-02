#!/usr/bin/env bash
# Logic test for 20260826050000_incident_multiple_categories.sql on plain
# PostgreSQL (PGHOST/PGPORT/PGUSER -> a disposable server, superuser).
# global_search references many tables that this stub does not create, so it
# is loaded with check_function_bodies off (created, not executed here).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MIG="$HERE/../../migrations"
DB="incidents_test_$$"
createdb "$DB"; trap 'dropdb --if-exists "$DB"' EXIT
q() { PGOPTIONS='-c check_function_bodies=off' psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
q -f "$HERE/stub_schema.sql"
q -f "$MIG/20260826050000_incident_multiple_categories.sql"
q -f "$MIG/20260826050000_incident_multiple_categories.sql"   # re-runnable
q -f "$HERE/incident_categories.test.sql"
