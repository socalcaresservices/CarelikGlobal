-- SYNTHETIC. One signed (Billing Ready) visit by caregiver 0, 3h-1h ago, 120 min.
insert into public.service_visits (id, organization_id, client_id, caregiver_user_id, caregiver_record_id,
  service_authorization_id, service_id, service_date, time_in, time_out, worked_minutes, verified_minutes,
  billable_minutes, status, authorization_status, signed_at, locked_at, client_code_snapshot, caregiver_name_snapshot)
select '00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
       '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000200', a.id,
       '00000000-0000-4000-8000-0000000000e1', (now() - interval '3 hours')::date,
       date_trunc('minute', now()) - interval '3 hours', date_trunc('minute', now()) - interval '1 hour', 120, 120, 120,
       'signed', 'within_authorization', now() - interval '1 hour', now() - interval '1 hour', 'TEST-C01', 'Synthetic Caregiver 0'
from public.client_authorizations a where a.service_id = '00000000-0000-4000-8000-0000000000e1';
-- Production: only the owner holds billing.submit (20260825012407), so step 6 runs as an owner.
insert into public.organization_memberships (organization_id, user_id, role) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000b0f', 'organization_owner');
insert into public.visit_signatures (organization_id, visit_id, confirmation_method, signed_visit_snapshot)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000b0001', 'draw', '{}');

do $$
declare
  manager constant text := '00000000-0000-4000-8000-000000000a00';
  original constant uuid := '00000000-0000-4000-8000-0000000b0001';
  first_approval uuid; second_approval uuid; corrected uuid; submission uuid;
  r record; n integer; total integer;
begin
  perform set_config('test.uid', manager, false);

  -- 1. Manager approves the Billing Ready visit (120 min).
  first_approval := public.approve_visit_for_billing(original, 120, 'synthetic');
  raise notice 'STEP 1 approved original visit: approval %', first_approval;

  -- 2. Manager corrects the same visit (caregiver actually left 30 min earlier).
  perform public.correct_service_visit(original, date_trunc('minute', now()) - interval '3 hours',
                                       date_trunc('minute', now()) - interval '90 minutes', 'Left early (synthetic)');
  select id into corrected from public.service_visits where original_visit_id = original;
  select status into r from public.service_visits where id = original;
  raise notice 'STEP 2 corrected: original is now %, replacement % is %', r.status, corrected,
    (select status from public.service_visits where id = corrected);

  -- 3. The first approval is still active and still points at the replaced row.
  select count(*) into n from public.billing_approvals where visit_id = original and voided_at is null;
  if n <> 1 then raise exception 'NOT REPRODUCED: approval on the replaced row is not active (%)', n; end if;
  raise notice 'STEP 3 approval % is still ACTIVE on the replaced (corrected) row', first_approval;

  -- 4. The replacement shows up as Billing Ready again.
  select count(*) into n from public.list_billing_ready_visits('00000000-0000-4000-8000-000000000001') where visit_id = corrected;
  if n <> 1 then raise exception 'NOT REPRODUCED: replacement is not listed as Billing Ready'; end if;
  raise notice 'STEP 4 replacement % is listed as Billing Ready', corrected;

  -- 5. It can be approved again: two active approvals for one delivered service.
  second_approval := public.approve_visit_for_billing(corrected, 90, 'synthetic');
  raise notice 'STEP 5 second approval % accepted for the replacement', second_approval;

  -- 6. Both approvals can be submitted together (by the owner).
  perform set_config('test.uid', '00000000-0000-4000-8000-000000000b0f', false);
  submission := public.submit_billing_approvals('00000000-0000-4000-8000-000000000001', array[first_approval, second_approval]);
  select count(*), sum(submitted_minutes) into n, total from public.billing_submission_items where submission_id = submission and voided_at is null;
  raise notice 'STEP 6 submission % contains % items totalling % minutes for ONE visit actually worked for 90 minutes', submission, n, total;
  if n <> 2 or total <> 210 then raise exception 'NOT REPRODUCED: submission has % items / % minutes', n, total; end if;
  raise notice 'REPRODUCED: 210 minutes submitted for one 90-minute visit';
end $$;
