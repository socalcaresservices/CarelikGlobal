-- With the proposed migration loaded: the correction of an approved visit is refused
-- and nothing changes; after voiding the approval the correction succeeds.
insert into public.service_visits (id, organization_id, client_id, caregiver_user_id, caregiver_record_id,
  service_authorization_id, service_id, service_date, time_in, time_out, worked_minutes, verified_minutes,
  billable_minutes, status, authorization_status, signed_at, locked_at, client_code_snapshot, caregiver_name_snapshot)
select '00000000-0000-4000-8000-0000000b0002', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
       '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201', a.id,
       '00000000-0000-4000-8000-0000000000e1', (now() - interval '3 hours')::date,
       date_trunc('minute', now()) - interval '3 hours', date_trunc('minute', now()) - interval '1 hour', 120, 120, 120,
       'signed', 'within_authorization', now() - interval '1 hour', now() - interval '1 hour', 'TEST-C01', 'Synthetic Caregiver 1'
from public.client_authorizations a where a.service_id = '00000000-0000-4000-8000-0000000000e1';
insert into public.visit_signatures (organization_id, visit_id, confirmation_method, signed_visit_snapshot)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000b0002', 'draw', '{}');
do $$
declare
  v constant uuid := '00000000-0000-4000-8000-0000000b0002';
  a uuid; refused boolean := false;
begin
  perform set_config('test.uid', '00000000-0000-4000-8000-000000000a00', false);
  a := public.approve_visit_for_billing(v, 120, 'synthetic');
  begin
    perform public.correct_service_visit(v, date_trunc('minute', now()) - interval '3 hours',
                                         date_trunc('minute', now()) - interval '90 minutes', 'Left early (synthetic)');
  exception when others then
    refused := sqlerrm like 'This visit is approved for billing%';
  end;
  if not refused then raise exception 'FIX FAILED: correction of an approved visit was not refused'; end if;
  if (select status from public.service_visits where id = v) <> 'signed'
     or exists (select 1 from public.service_visits where original_visit_id = v) then
    raise exception 'FIX FAILED: the refused correction left changes behind';
  end if;
  raise notice 'FIX STEP 1 correction of an approved visit refused; visit unchanged';
  perform public.void_billing_approval(a, 'Correction needed (synthetic)');
  perform public.correct_service_visit(v, date_trunc('minute', now()) - interval '3 hours',
                                       date_trunc('minute', now()) - interval '90 minutes', 'Left early (synthetic)');
  if (select status from public.service_visits where id = v) <> 'corrected' then raise exception 'FIX FAILED: correction after void did not apply'; end if;
  raise notice 'FIX STEP 2 after voiding the approval, the correction applies';
  raise notice 'FIX VERIFIED';
end $$;
