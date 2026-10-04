#!/usr/bin/env bash
# Concurrent approval/correction attempts, with the proposed fix loaded, using
# two real database sessions on the production function bodies. Session 1
# starts, does its work and HOLDS its transaction open for 3 s; session 2
# starts 1 s later on the same visit. Sourced by run.sh (needs $DB and q()).
# SYNTHETIC data only. Each case ends with an exact check of the final state.
set -euo pipefail
MANAGER=00000000-0000-4000-8000-000000000a00
TI="date_trunc('minute', now()) - interval '3 hours'"
TO="date_trunc('minute', now()) - interval '90 minutes'"

q -c "create or replace function public.test_signed_visit(v uuid, k integer) returns void language sql as \$\$
  insert into public.service_visits (id, organization_id, client_id, caregiver_user_id, caregiver_record_id,
    service_authorization_id, service_id, service_date, time_in, time_out, worked_minutes, verified_minutes,
    billable_minutes, status, authorization_status, signed_at, locked_at, client_code_snapshot, caregiver_name_snapshot)
  select v, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
         ('00000000-0000-4000-8000-00000000010' || k)::uuid, ('00000000-0000-4000-8000-00000000020' || k)::uuid, a.id,
         '00000000-0000-4000-8000-0000000000e1', (now() - interval '3 hours')::date,
         date_trunc('minute', now()) - interval '3 hours', date_trunc('minute', now()) - interval '1 hour', 120, 120, 120,
         'signed', 'within_authorization', now() - interval '1 hour', now() - interval '1 hour', 'TEST-C01', 'Synthetic Caregiver ' || k
  from public.client_authorizations a where a.service_id = '00000000-0000-4000-8000-0000000000e1';
  insert into public.visit_signatures (organization_id, visit_id, confirmation_method, signed_visit_snapshot)
  values ('00000000-0000-4000-8000-000000000001', v, 'draw', '{}');
\$\$"

session() {  # session <sql>: runs as the manager in one transaction; prints output, never fails the script
  psql -X -q -At -v ON_ERROR_STOP=1 -d "$DB" -c "begin" -c "select set_config('test.uid', '$MANAGER', true)" -c "$1" -c "commit" 2>&1 || true
}
correct_sql() { echo "select count(*) from public.correct_service_visit('$1', $TI, $TO, 'synthetic'); select pg_sleep(${2:-0});"; }
approve_sql() { echo "select public.approve_visit_for_billing('$1', 120, 'synthetic') is not null; select pg_sleep(${2:-0});"; }
void_sql() { echo "select public.void_billing_approval((select id from public.billing_approvals where visit_id = '$1' and voided_at is null), 'synthetic'); select pg_sleep(${2:-0});"; }

FAILS=0
run_case() {  # run_case <name> <visit> <first sql> <second sql> <expected second-session message> <final-state SQL returning t> [min wait s]
  local name=$1 v=$2 first=$3 second=$4 expect=$5 final=$6 min_wait=${7:-1.5} out1 out2 t0 t1 waited
  session "$first" > "$TMPD/1" & local p1=$!
  sleep 1
  t0=$(date +%s.%N); out2=$(session "$second"); t1=$(date +%s.%N)
  wait $p1; out1=$(cat "$TMPD/1")
  waited=$(python3 -c "print(round($t1 - $t0, 1))")
  local ok=1
  grep -q "ERROR" <<<"$out1" && ok=0
  grep -q "$expect" <<<"$out2" || ok=0
  [[ "$(q -At -c "$final")" == t ]] || ok=0
  python3 -c "import sys; sys.exit(0 if $waited >= $min_wait else 1)" || ok=0   # session 2 really waited for session 1's lock
  if [[ $ok == 1 ]]; then echo "PASS $name (session 2 waited ${waited}s, then refused: $expect)"
  else FAILS=$((FAILS + 1)); echo "FAIL $name"; echo "  session 1: $out1"; echo "  session 2 (${waited}s): $out2"; fi
}
TMPD=$(mktemp -d)

V=00000000-0000-4000-8000-0000000c0001; q -c "select public.test_signed_visit('$V', 3)"
run_case "C1 correction first, approval concurrently" "$V" "$(correct_sql $V 3)" "$(approve_sql $V)" \
  "Only a signed visit can be approved for billing" \
  "select (select status from public.service_visits where id = '$V') = 'corrected'
      and (select count(*) from public.billing_approvals where visit_id = '$V') = 0
      and (select count(*) from public.service_visits where original_visit_id = '$V' and status = 'signed') = 1"

V=00000000-0000-4000-8000-0000000c0002; q -c "select public.test_signed_visit('$V', 4)"
run_case "C2 approval first, correction concurrently" "$V" "$(approve_sql $V 3)" "$(correct_sql $V)" \
  "This visit is approved for billing" \
  "select (select status from public.service_visits where id = '$V') = 'signed'
      and (select count(*) from public.billing_approvals where visit_id = '$V' and voided_at is null) = 1
      and not exists (select 1 from public.service_visits where original_visit_id = '$V')"

V=00000000-0000-4000-8000-0000000c0003; q -c "select public.test_signed_visit('$V', 5)"
run_case "C3 two approvals concurrently" "$V" "$(approve_sql $V 3)" "$(approve_sql $V)" \
  "This visit already has an active billing approval" \
  "select (select count(*) from public.billing_approvals where visit_id = '$V') = 1"

V=00000000-0000-4000-8000-0000000c0004; q -c "select public.test_signed_visit('$V', 6)"
q -c "select set_config('test.uid', '$MANAGER', false); select public.approve_visit_for_billing('$V', 120, 'synthetic')" >/dev/null
# The void has not committed when the correction runs (no shared row lock, so
# no wait): the correction still sees the active approval and is refused (the
# safe direction). Once the void commits, a retry applies (checked below).
run_case "C4 void of the approval in progress, correction concurrently" "$V" "$(void_sql $V 3)" "$(correct_sql $V)" \
  "This visit is approved for billing" \
  "select (select status from public.service_visits where id = '$V') = 'signed'
      and (select count(*) from public.billing_approvals where visit_id = '$V' and voided_at is null) = 0" 0
retry=$(session "$(correct_sql $V)")
if grep -q ERROR <<<"$retry" || [[ "$(q -At -c "select status from public.service_visits where id = '$V'")" != corrected ]]; then
  FAILS=$((FAILS + 1)); echo "FAIL C4 retry after the void committed: $retry"
else
  echo "PASS C4 retry after the void committed: the correction applies"
fi

V=00000000-0000-4000-8000-0000000c0005; q -c "select public.test_signed_visit('$V', 7)"
run_case "C5 two corrections concurrently" "$V" "$(correct_sql $V 3)" "$(correct_sql $V)" \
  "Only a submitted visit can be corrected" \
  "select (select count(*) from public.service_visits where original_visit_id = '$V') = 1
      and (select count(*) from public.visit_corrections where original_visit_id = '$V') = 1"
rm -rf "$TMPD"
[[ $FAILS == 0 ]] && echo "CONCURRENCY VERIFIED: 5 cases" || { echo "CONCURRENCY FAILED: $FAILS"; exit 1; }
