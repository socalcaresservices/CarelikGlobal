-- With the proposed fix loaded: EVERY production path that can change a visit
-- is tried on a billing-approved visit, as the role that may normally use it.
-- Each must be refused, and afterwards the visit row, its approval and the
-- visit count must be exactly as before. SYNTHETIC data only.
--
-- Paths (all production functions whose body updates service_visits, read
-- live 2026-10-04, plus direct table writes):
--   correct_service_visit, void_service_visit, approve_visit_billing (legacy),
--   end_service_visit, confirm_service_visit, sign_service_visit,
--   close_missed_service_visit, a second approve_visit_for_billing, and direct
--   UPDATE/DELETE by the authenticated role (production grants these table
--   privileges; RLS with SELECT-only policies must stop them).
insert into public.service_visits (id, organization_id, client_id, caregiver_user_id, caregiver_record_id,
  service_authorization_id, service_id, service_date, time_in, time_out, worked_minutes, verified_minutes,
  billable_minutes, status, authorization_status, signed_at, locked_at, client_code_snapshot, caregiver_name_snapshot)
select '00000000-0000-4000-8000-0000000b0003', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
       '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000202', a.id,
       '00000000-0000-4000-8000-0000000000e1', (now() - interval '3 hours')::date,
       date_trunc('minute', now()) - interval '3 hours', date_trunc('minute', now()) - interval '1 hour', 120, 120, 120,
       'signed', 'within_authorization', now() - interval '1 hour', now() - interval '1 hour', 'TEST-C01', 'Synthetic Caregiver 2'
from public.client_authorizations a where a.service_id = '00000000-0000-4000-8000-0000000000e1';
insert into public.visit_signatures (organization_id, visit_id, confirmation_method, signed_visit_snapshot)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000b0003', 'draw', '{}');

-- Production's table privileges and RLS policies for these tables (read live 2026-10-04).
alter table public.service_visits enable row level security;
alter table public.billing_approvals enable row level security;
alter table public.visit_corrections enable row level security;
create policy members_read_service_visits on public.service_visits for select to authenticated
  using (public.has_permission(organization_id, 'visits.read') or caregiver_user_id = (select auth.uid()));
create policy owners_read_billing_approvals on public.billing_approvals for select to authenticated
  using (public.has_permission(organization_id, 'billing.read'));
create policy members_read_visit_corrections on public.visit_corrections for select to authenticated
  using (public.has_permission(organization_id, 'visits.read'));
grant usage on schema public, auth to authenticated;
grant select, insert, update, delete on public.service_visits, public.billing_approvals, public.visit_corrections to authenticated;
grant execute on all functions in schema public, auth to authenticated;

create temporary table path_results (path text, refused boolean, detail text);
grant all on path_results to authenticated;

do $$
declare
  v constant uuid := '00000000-0000-4000-8000-0000000b0003';
  manager constant text := '00000000-0000-4000-8000-000000000a00';
  caregiver constant text := '00000000-0000-4000-8000-000000000102';
  approval uuid;
begin
  perform set_config('test.uid', manager, false);
  approval := public.approve_visit_for_billing(v, 120, 'synthetic');
  create temporary table before_state as
    select to_jsonb(s) - 'updated_at' as visit, (select count(*) from public.service_visits) as visits,
           (select to_jsonb(b) from public.billing_approvals b where b.id = approval) as approval
    from public.service_visits s where s.id = v;
end $$;

-- Each attempt runs in its own subtransaction; "refused" means it raised the
-- expected, specific message (not some unrelated error).
create function pg_temp.attempt(label text, uid text, call text, expected text) returns void language plpgsql as $$
begin
  perform set_config('test.uid', uid, false);
  begin
    execute call;
    insert into path_results values (label, false, 'NOT REFUSED');
  exception when others then
    insert into path_results values (label, sqlerrm like expected, sqlerrm);
  end;
end $$;

select pg_temp.attempt('correct_service_visit (manager)', '00000000-0000-4000-8000-000000000a00',
  $q$select * from public.correct_service_visit('00000000-0000-4000-8000-0000000b0003', date_trunc('minute', now()) - interval '3 hours', date_trunc('minute', now()) - interval '90 minutes', 'synthetic')$q$,
  'This visit is approved for billing%');
select pg_temp.attempt('void_service_visit (manager)', '00000000-0000-4000-8000-000000000a00',
  $q$select public.void_service_visit('00000000-0000-4000-8000-0000000b0003', 'synthetic')$q$,
  'A signed visit cannot be voided%');
select pg_temp.attempt('approve_visit_billing, legacy (manager)', '00000000-0000-4000-8000-000000000a00',
  $q$select public.approve_visit_billing('00000000-0000-4000-8000-0000000b0003', 60, 'synthetic')$q$,
  'This visit is not awaiting administrator review%');
select pg_temp.attempt('approve_visit_for_billing again (manager)', '00000000-0000-4000-8000-000000000a00',
  $q$select public.approve_visit_for_billing('00000000-0000-4000-8000-0000000b0003', 60, 'synthetic')$q$,
  'This visit already has an active billing approval%');
select pg_temp.attempt('close_missed_service_visit (manager)', '00000000-0000-4000-8000-000000000a00',
  $q$select * from public.close_missed_service_visit('00000000-0000-4000-8000-0000000b0003', now() - interval '2 hours', 'synthetic')$q$,
  'Only an open visit (no Time Out) can be closed this way%');
select pg_temp.attempt('end_service_visit (its caregiver)', '00000000-0000-4000-8000-000000000102',
  $q$select * from public.end_service_visit('00000000-0000-4000-8000-0000000b0003')$q$,
  'Visit has already been ended%');
select pg_temp.attempt('confirm_service_visit (its caregiver)', '00000000-0000-4000-8000-000000000102',
  $q$select * from public.confirm_service_visit('00000000-0000-4000-8000-0000000b0003', 'client', 'verbal', null, 'Synthetic Signer')$q$,
  'Visit is already locked or is not ready for confirmation%');
select pg_temp.attempt('sign_service_visit (its caregiver)', '00000000-0000-4000-8000-000000000102',
  $q$select * from public.sign_service_visit('00000000-0000-4000-8000-0000000b0003', 'client', 'synthetic/path.png')$q$,
  'Visit is already locked%');
-- Defence in depth: even a privileged direct status change (RLS bypassed) is refused by the guard.
select pg_temp.attempt('direct status UPDATE as table owner (bypasses RLS)', '00000000-0000-4000-8000-000000000a00',
  $q$update public.service_visits set status = 'corrected' where id = '00000000-0000-4000-8000-0000000b0003'$q$,
  'This visit is approved for billing%');

-- Direct writes as the authenticated role: RLS must make each affect 0 rows.
set role authenticated;
do $$
declare
  n integer;
  stmts text[] := array[
    $s$update public.service_visits set status = 'corrected' where id = '00000000-0000-4000-8000-0000000b0003'$s$,
    $s$update public.service_visits set billable_minutes = 999, worked_minutes = 999 where id = '00000000-0000-4000-8000-0000000b0003'$s$,
    $s$delete from public.service_visits where id = '00000000-0000-4000-8000-0000000b0003'$s$,
    $s$update public.billing_approvals set voided_at = now(), void_reason = 'x' where visit_id = '00000000-0000-4000-8000-0000000b0003'$s$,
    $s$delete from public.billing_approvals where visit_id = '00000000-0000-4000-8000-0000000b0003'$s$];
  s text;
begin
  perform set_config('test.uid', '00000000-0000-4000-8000-000000000a00', false);
  foreach s in array stmts loop
    begin
      execute s;
      get diagnostics n = row_count;
      insert into path_results values ('direct as authenticated manager: ' || left(s, 48), n = 0, n || ' rows');
    exception when others then
      insert into path_results values ('direct as authenticated manager: ' || left(s, 48), true, sqlerrm);
    end;
  end loop;
end $$;
reset role;

select format('%s %-62s %s', case when refused then 'REFUSED' else 'FAIL   ' end, path, detail) from path_results order by path;

do $$
declare b record; bad integer;
begin
  select * into b from before_state;
  select count(*) into bad from path_results where not refused;
  if bad > 0 then raise exception 'ALL-PATHS FAILED: % path(s) not refused as expected', bad; end if;
  if (select to_jsonb(s) - 'updated_at' from public.service_visits s where s.id = '00000000-0000-4000-8000-0000000b0003') <> b.visit then
    raise exception 'ALL-PATHS FAILED: the approved visit row changed';
  end if;
  if (select count(*) from public.service_visits) <> b.visits then raise exception 'ALL-PATHS FAILED: a visit row was added or removed'; end if;
  if (select to_jsonb(a) from public.billing_approvals a where a.visit_id = '00000000-0000-4000-8000-0000000b0003') <> b.approval then
    raise exception 'ALL-PATHS FAILED: the approval changed';
  end if;
  raise notice 'ALL PATHS VERIFIED: % write paths refused; visit, approval and visit count unchanged', (select count(*) from path_results);
end $$;
