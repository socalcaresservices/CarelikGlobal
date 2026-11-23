#!/usr/bin/env bash
# LOCAL REHEARSAL of the production database change (no AWS): a throwaway PostgreSQL database taken to the production starting state (ledger 85/0085) with SYNTHETIC rows,
# then the repository runner applies 0086, 0087, 0088, and the production script's own functions (ro, state, assert_before, assert_after, vrun, fp, fp_compare, run_sql_record)
# are extracted from STELLA_PRD_DB.sh and run against it; finally the three-file rollback. Needs a LOCAL PostgreSQL 16 superuser (see docs/TESTING_AND_RELEASE_PROCESS.md 3.1) and installed dependencies.
#   OGEVIA_TEST_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres bash rehearse_local.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
: "${OGEVIA_TEST_DATABASE_URL:?set OGEVIA_TEST_DATABASE_URL to a LOCAL superuser URL}"
[[ "$OGEVIA_TEST_DATABASE_URL" == *127.0.0.1* || "$OGEVIA_TEST_DATABASE_URL" == *localhost* ]] || { echo "refusing: the URL is not local"; exit 2; }
U=$(node -e 'const u=new URL(process.argv[1]);console.log(u.username)' "$OGEVIA_TEST_DATABASE_URL"); PW=$(node -e 'const u=new URL(process.argv[1]);console.log(decodeURIComponent(u.password))' "$OGEVIA_TEST_DATABASE_URL")
H=127.0.0.1; PT=$(node -e 'const u=new URL(process.argv[1]);console.log(u.port||5432)' "$OGEVIA_TEST_DATABASE_URL")
export PGHOST=$H PGPORT=$PT PGUSER=$U PGPASSWORD=$PW; DB=prd_rehearsal; export DB
export OGEVIA_DATABASE_URL="postgres://$U:$PW@$H:$PT/$DB"
fail=0; ck() { if [[ "$2" == "$3" ]]; then echo "PASS $1"; else echo "FAIL $1: got '$2', expected '$3'"; fail=1; fi; }
stop() { echo "STOP: $*"; fail=1; exit 1; }; say() { printf '%s\n' "$*"; }; RESULT=/dev/null; SQL="$HERE/STELLA_PRD_READONLY.sql"; OUT="$(mktemp -d)"
ROLLSET3=$(cd "$REPO/infra/aws/db/rollback" && LC_ALL=C sha256sum -- 0086_staff_management.down.sql 0087_staff_invitation_acceptance.down.sql 0088_caregiver_readiness_approve_for_work.down.sql | sha256sum | cut -c1-64)
psql -X -At -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB" >/dev/null
run() { ( cd "$REPO" && pnpm --filter @carelik/infra-aws "$@" 2>&1 ); }
# 1. the production starting state: 88 applied, then rolled back to 85 (the same ledger and schema production holds)
run db:migrate | tail -1 >/dev/null; run db:rollback-to 0086 --expect-set-sha "$ROLLSET3" | tail -1 >/dev/null
ck "start: ledger 85/0085" "$(psql -X -At -d $DB -c "select count(*)||'/'||max(version) from ogevia_meta.schema_migrations")" "85/0085"
# 2. SYNTHETIC rows: two agencies, caregivers in every stored status (one deleted), default onboarding requirements
psql -X -q -v ON_ERROR_STOP=1 -d $DB <<'SQL'
insert into ogevia.organizations (slug, display_name) values ('syn-a','Synthetic A'), ('syn-b','Synthetic B');
insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status)
select o.id, 'SYN-' || s.k, 'Syn', s.k, s.k from ogevia.organizations o, (values ('ready'),('active'),('onboarding'),('applicant'),('inactive')) s(k) where o.slug = 'syn-a';
insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) select id, 'SYN-B1', 'Syn', 'B1', 'ready' from ogevia.organizations where slug = 'syn-b';
insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status, deleted_at) select id, 'SYN-DEL', 'Syn', 'Del', 'ready', now() from ogevia.organizations where slug = 'syn-a';
select ogevia.ensure_onboarding_defaults(id) from ogevia.organizations;
SQL
# 3. the production script's own functions, extracted from the script
S="$HERE/STELLA_PRD_DB.sh"
python3 - "$S" > "$OUT/fns.sh" <<'PY'
import sys
t = open(sys.argv[1]).read().split("\n")
a = next(i for i, l in enumerate(t) if l.startswith("ro() {")); b = next(i for i, l in enumerate(t) if l.startswith("dburl() {"))
print("\n".join(t[a:b]))
PY
source "$OUT/fns.sh"
# 4. before
state; ck "before: ledger" "$LEDGER" "85/0085"; ck "before: readiness table" "$HAS_RD" "absent"; ck "before: staff objects" "$STAFFOBJ" "0|0|0"; ck "before: enforcement" "$ENF" "0"; ck "before: caregivers ready-or-active/total (deleted excluded)" "$RA" "3/6"
RA_BEFORE="$RA"
OBEF=$(psql -X -At -d $DB -c "select count(*) filter (where is_active) || '/' || count(*) from ogevia.onboarding_requirements")
fp > "$OUT/fp-before.tsv"; ck "fingerprint takes counts of existing tables" "$(grep -c '^ogevia' "$OUT/fp-before.tsv" | awk '{print ($1>40)?"many":"few"}')" "many"
run_sql_record > "$OUT/sql-before.txt" 2>&1; ck "read-only SQL runs at 85 (no error)" "$(grep -c -i 'error' "$OUT/sql-before.txt")" "0"
# 5. migrate with the runner
O=$(run db:migrate); echo "$O" | tail -2
ck "runner output" "$(grep -c 'applied 3, already applied 85' <<<"$O")" "1"
O=$(run db:verify); ck "db:verify exit code" "$?" "0"; ck "db:verify printed PASS lines and no FAIL line" "$(grep -c '^FAIL' <<<"$O")/$(grep -c '^PASS' <<<"$O" | awk '{print ($1>100)?"many":"few"}')" "0/many"
# 6. after
state; LEG=$(ro "select count(*) from ogevia.caregiver_work_approvals where source='legacy_status'"); echo "legacy approvals=$LEG"
assert_after && ck "assert_after" ok ok || ck "assert_after" failed ok
vrun "$REPO/docs/releases/2026-10-26-redesign-operator/scripts/verify-0086.sql" 110
vrun "$REPO/docs/releases/2026-10-26-redesign-operator/scripts/verify-0087.sql" 22
fp > "$OUT/fp-after.tsv"; fp_compare "$OUT/fp-before.tsv" "$OUT/fp-after.tsv" && ck "fingerprint: existing data counts unchanged (ledger +3, permission seed rows only)" ok ok || ck "fingerprint" changed ok
OAFT=$(psql -X -At -d $DB -c "select count(*) filter (where is_active) || '/' || count(*) from ogevia.onboarding_requirements")
echo "INFO onboarding requirements active/total before $OBEF, after $OAFT (0088 retires categories background_check, document, clearance)"
run_sql_record > "$OUT/sql-after.txt" 2>&1; ck "read-only SQL runs at 88 (no error)" "$(grep -c -i 'error' "$OUT/sql-after.txt")" "0"; grep -E "legacy_status_approvals|readiness_table|caregivers_by" "$OUT/sql-after.txt" | head -6
# 7. a deliberately wrong state is refused: a second run of the same migrate changes nothing
O=$(run db:migrate); ck "rerun applies nothing" "$(grep -c 'applied 0, already applied 88' <<<"$O")" "1"
# 8. a rollback with a WRONG set hash is refused and changes nothing; then the real rollback to 85
O=$(run db:rollback-to 0086 --expect-set-sha 0000000000000000000000000000000000000000000000000000000000000000); ck "wrong-hash rollback is refused (non-zero exit)" "$([[ $? != 0 ]] && echo refused || echo ran)" "refused"
state; ck "after the refused rollback: ledger still 88/0088" "$LEDGER" "88/0088"
O=$(run db:rollback-to 0086 --expect-set-sha "$ROLLSET3"); ck "rollback output" "$(grep -c 'rolled back 3 migrations: 0088, 0087, 0086' <<<"$O")" "1"
state; ck "after rollback: ledger" "$LEDGER" "85/0085"; ck "after rollback: readiness table" "$HAS_RD" "absent"; ck "after rollback: staff objects" "$STAFFOBJ" "0|0|0"
ONAFT=$(psql -X -At -d $DB -c "select count(*) filter (where is_active) || '/' || count(*) from ogevia.onboarding_requirements"); echo "INFO onboarding requirements active/total after rollback: $ONAFT (before the migration: $OBEF)"
psql -X -At -d postgres -c "drop database if exists $DB with (force)" >/dev/null
[[ $fail == 0 ]] && echo "REHEARSAL PASSED" || { echo "REHEARSAL FAILED"; exit 1; }
