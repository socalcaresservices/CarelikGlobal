-- sign_service_visit's RETURNS TABLE(..., worked_minutes integer, ...)
-- implicitly declares worked_minutes as a PL/pgSQL variable throughout the
-- function body, colliding with service_visits.worked_minutes the column.
-- The UPDATE's "verified_minutes = worked_minutes" was therefore ambiguous
-- (caught live: ERROR 42702, not by static review) - qualifying with
-- target_visit. resolves it to the intended column value.
create or replace function public.sign_service_visit(
  target_visit_id uuid,
  signer_role public.visit_signer_role,
  signature_storage_path text
)
returns table (
  visit_id uuid,
  status public.service_visit_status,
  authorization_status public.visit_authorization_status,
  worked_minutes integer,
  billable_minutes integer,
  month_to_date_minutes bigint,
  remaining_minutes bigint
)
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  target_visit public.service_visits%rowtype;
  target_auth public.client_authorizations%rowtype;
  target_service public.services%rowtype;
  prior_minutes bigint;
  allowed_minutes integer;
  resulting_status public.visit_authorization_status;
  resulting_visit_status public.service_visit_status;
  snapshot jsonb;
  cap_minutes integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into target_visit from public.service_visits where id = target_visit_id for update;
  if target_visit.id is null then raise exception 'Visit not found'; end if;
  if target_visit.caregiver_user_id <> auth.uid()
     and not public.has_permission(target_visit.organization_id, 'visits.manage') then
    raise exception 'You cannot sign this visit';
  end if;
  if target_visit.status <> 'awaiting_signature' then raise exception 'Visit is already locked'; end if;
  if signature_storage_path <> target_visit.organization_id::text || '/' || target_visit.id::text || '/client-signature.png' then
    raise exception 'Invalid signature path';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'visit-signatures' and name = signature_storage_path) then
    raise exception 'Signature upload was not found';
  end if;

  select * into target_auth from public.client_authorizations
  where id = target_visit.service_authorization_id for update;
  select * into target_service from public.services where id = target_visit.service_id;

  select coalesce(sum(v.billable_minutes), 0)::bigint into prior_minutes
  from public.service_visits v
  where v.service_authorization_id = target_auth.id
    and v.id <> target_visit.id
    and v.service_date >= date_trunc('month', target_visit.service_date::timestamp)::date
    and v.service_date < (date_trunc('month', target_visit.service_date::timestamp) + interval '1 month')::date
    and v.status in ('signed', 'administrator_review');

  cap_minutes := round(target_auth.max_monthly_hours * 60)::integer;
  allowed_minutes := greatest(0, least(target_visit.worked_minutes, cap_minutes - prior_minutes::integer));

  if allowed_minutes < target_visit.worked_minutes then
    resulting_status := 'exceeds_authorization';
    resulting_visit_status := 'administrator_review';
  elsif prior_minutes + allowed_minutes >= cap_minutes then
    resulting_status := 'limit_reached';
    resulting_visit_status := 'signed';
  else
    resulting_status := 'within_authorization';
    resulting_visit_status := 'signed';
  end if;

  snapshot := jsonb_build_object(
    'clientCode', target_visit.client_code_snapshot,
    'caregiverName', target_visit.caregiver_name_snapshot,
    'serviceName', target_service.name,
    'serviceDate', target_visit.service_date,
    'timeIn', target_visit.time_in,
    'timeOut', target_visit.time_out,
    'workedMinutes', target_visit.worked_minutes,
    'signerRole', signer_role,
    'timeZone', 'America/Los_Angeles',
    'confirmationText', 'I confirm that the services and hours shown above were provided on the date stated.',
    'confirmationVersion', 1,
    'monthToDateBeforeMinutes', prior_minutes,
    'monthToDateAfterMinutes', prior_minutes + allowed_minutes,
    'authorizedMinutes', cap_minutes,
    'remainingMinutes', greatest(0, cap_minutes - prior_minutes - allowed_minutes)
  );

  insert into public.visit_signatures (
    organization_id, visit_id, signer_role, storage_path, signed_visit_snapshot
  ) values (
    target_visit.organization_id, target_visit.id, signer_role, signature_storage_path, snapshot
  );

  update public.service_visits set
    verified_minutes = target_visit.worked_minutes,
    billable_minutes = allowed_minutes,
    status = resulting_visit_status,
    authorization_status = resulting_status,
    signed_at = now(),
    locked_at = now()
  where id = target_visit.id;

  return query select
    target_visit.id,
    resulting_visit_status,
    resulting_status,
    target_visit.worked_minutes,
    allowed_minutes,
    prior_minutes + allowed_minutes,
    greatest(0, cap_minutes::bigint - prior_minutes - allowed_minutes);
end;
$$;
