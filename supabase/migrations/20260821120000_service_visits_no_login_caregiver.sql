-- Found running a full Candidate -> Care Team -> Client -> Authorization
-- -> Recurring Schedule -> Call-out -> Replacement -> Visit -> Report
-- scenario end to end against demo: service_visits.caregiver_user_id was
-- NOT NULL, so start_service_visit crashed the instant a scheduled
-- shift's caregiver had no login at all - meaning a no-login Care Team
-- member's visits could never be verified, billed, or reported on. This
-- predates PR #34 entirely; it's been broken since Shift Verification
-- shipped.
--
-- Mirrors the caregiver_record_id pattern already used on shifts and
-- shift_coverage_events, and the name-resolution fallback
-- create_shift_verification_link already uses.

alter table public.service_visits alter column caregiver_user_id drop not null;
alter table public.service_visits add column if not exists caregiver_record_id uuid references public.caregiver_records(id);

create or replace function public.start_service_visit(target_organization_id uuid, target_shift_id uuid, visit_task_categories text[] DEFAULT '{}'::text[], visit_service_notes text DEFAULT NULL::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  target_shift public.shifts%rowtype;
  target_client public.clients%rowtype;
  target_auth public.client_authorizations%rowtype;
  caregiver_name text;
  visit_id uuid;
  started_at timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into target_shift
  from public.shifts
  where id = target_shift_id
    and organization_id = target_organization_id
  for update;

  if target_shift.id is null then raise exception 'Scheduled shift not found'; end if;
  if target_shift.caregiver_user_id is distinct from auth.uid()
     and not public.has_permission(target_organization_id, 'visits.manage') then
    raise exception 'You cannot verify another caregiver''s shift';
  end if;
  if target_shift.status <> 'scheduled' then
    raise exception 'This visit is not currently scheduled';
  end if;
  if target_shift.starts_at::date <> current_date then
    raise exception 'This scheduled visit cannot be started on a different date';
  end if;
  if target_shift.service_id is null then
    raise exception 'The shift needs a service before it can be verified';
  end if;
  if exists (
    select 1 from public.service_visits existing
    where existing.scheduled_shift_id = target_shift.id
      and existing.status not in ('voided', 'corrected')
  ) then
    raise exception 'This scheduled visit has already been started or submitted';
  end if;

  select * into target_client
  from public.clients
  where id = target_shift.client_id
    and organization_id = target_organization_id
    and deleted_at is null
    and status = 'active';
  if target_client.id is null then raise exception 'Client not found or inactive'; end if;

  select * into target_auth
  from public.client_authorizations
  where organization_id = target_organization_id
    and client_id = target_shift.client_id
    and service_id = target_shift.service_id
    and started_at::date between period_start and period_end
    and deleted_at is null
  order by period_start desc
  limit 1
  for update;

  if target_auth.id is null then
    raise exception 'No active authorization covers this visit - an administrator needs to add one first';
  end if;

  select coalesce(
    nullif(trim(concat_ws(' ', coalesce(cr.preferred_name, cr.first_name), cr.last_name)), ''),
    nullif(trim(up.display_name), ''),
    'Caregiver'
  ) into caregiver_name
  from (select 1) anchor
  left join public.caregiver_records cr
    on cr.id = target_shift.caregiver_record_id
   and cr.organization_id = target_organization_id
   and cr.deleted_at is null
  left join public.user_profiles up on up.id = target_shift.caregiver_user_id;

  insert into public.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_record_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id,
    service_id, service_date, time_in, task_categories, service_notes,
    status, created_by, visit_number_snapshot
  ) values (
    target_organization_id, target_shift.client_id, target_client.client_code,
    target_shift.caregiver_user_id, target_shift.caregiver_record_id, coalesce(caregiver_name, 'Caregiver'),
    target_shift.id, target_auth.id, target_shift.service_id, started_at::date,
    started_at, coalesce(visit_task_categories, '{}'), nullif(trim(visit_service_notes), ''),
    'draft', auth.uid(), target_shift.visit_number
  ) returning id into visit_id;

  return visit_id;
end;
$function$;

create or replace function public.end_service_visit(target_visit_id uuid, visit_task_categories text[] DEFAULT NULL::text[], visit_service_notes text DEFAULT NULL::text)
 returns table(visit_id uuid, worked_minutes integer, time_in timestamp with time zone, time_out timestamp with time zone)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  target_visit public.service_visits%rowtype;
  ended_at timestamptz := now();
  minutes integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into target_visit from public.service_visits where id = target_visit_id for update;
  if target_visit.id is null then raise exception 'Visit not found'; end if;
  if target_visit.caregiver_user_id is distinct from auth.uid()
     and not public.has_permission(target_visit.organization_id, 'visits.manage') then
    raise exception 'You cannot end another caregiver''s visit';
  end if;
  if target_visit.status <> 'draft' then
    raise exception 'Visit has already been ended';
  end if;

  minutes := floor(extract(epoch from (ended_at - target_visit.time_in)) / 60)::integer;
  if minutes < 1 then
    raise exception 'A visit must last at least one minute before it can be ended';
  end if;
  if minutes > 1440 then
    raise exception 'This visit has been open for over 24 hours - contact an administrator to resolve it';
  end if;

  update public.service_visits set
    time_out = ended_at,
    worked_minutes = minutes,
    caregiver_attested_at = ended_at,
    status = 'awaiting_signature',
    task_categories = coalesce(visit_task_categories, task_categories),
    service_notes = coalesce(nullif(trim(visit_service_notes), ''), service_notes)
  where id = target_visit.id;

  return query select target_visit.id, minutes, target_visit.time_in, ended_at;
end;
$function$;

create or replace function public.sign_service_visit(target_visit_id uuid, signer_role visit_signer_role, signature_storage_path text)
 returns table(visit_id uuid, status service_visit_status, authorization_status visit_authorization_status, worked_minutes integer, billable_minutes integer, month_to_date_minutes bigint, remaining_minutes bigint)
 language plpgsql
 security definer
 set search_path to 'public', 'storage'
as $function$
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
  if target_visit.caregiver_user_id is distinct from auth.uid()
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
$function$;

create or replace function public.confirm_service_visit(target_visit_id uuid, signer_role visit_signer_role, confirmation_method text, signature_storage_path text default null, typed_signer_name text default null, signer_relationship text default null, confirmation_reason text default null)
 returns table(visit_id uuid, status service_visit_status, authorization_status visit_authorization_status, worked_minutes integer, billable_minutes integer, month_to_date_minutes bigint, remaining_minutes bigint)
 language plpgsql
 security definer
 set search_path to 'public', 'storage'
as $function$
declare
  target_visit public.service_visits%rowtype;
  target_auth public.client_authorizations%rowtype;
  target_service public.services%rowtype;
  prior_minutes bigint;
  allowed_minutes integer;
  resulting_auth_status public.visit_authorization_status;
  resulting_visit_status public.service_visit_status;
  snapshot jsonb;
  cap_minutes integer;
  method text := lower(btrim(coalesce(confirmation_method, '')));
  signer_name text := nullif(btrim(coalesce(typed_signer_name, '')), '');
  relationship text := nullif(btrim(coalesce(signer_relationship, '')), '');
  reason_text text := nullif(btrim(coalesce(confirmation_reason, '')), '');
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if method not in ('draw', 'typed', 'verbal', 'assisted_mark', 'unable_to_confirm') then
    raise exception 'Choose a valid confirmation method';
  end if;

  select * into target_visit from public.service_visits where id = target_visit_id for update;
  if target_visit.id is null then raise exception 'Visit not found'; end if;
  if target_visit.caregiver_user_id is distinct from auth.uid()
     and not public.has_permission(target_visit.organization_id, 'visits.manage') then
    raise exception 'You cannot confirm this visit';
  end if;
  if target_visit.status <> 'awaiting_signature' then
    raise exception 'Visit is already locked or is not ready for confirmation';
  end if;

  if method in ('draw', 'assisted_mark') then
    if signature_storage_path is null
       or signature_storage_path <> target_visit.organization_id::text || '/' || target_visit.id::text || '/client-signature.png' then
      raise exception 'A signature or mark is required';
    end if;
    if not exists (
      select 1 from storage.objects
      where bucket_id = 'visit-signatures' and name = signature_storage_path
    ) then
      raise exception 'Signature upload was not found';
    end if;
  elsif method in ('typed', 'verbal') and signer_name is null then
    raise exception 'Enter the name of the person confirming the visit';
  elsif method = 'unable_to_confirm' and reason_text is null then
    raise exception 'Explain why confirmation could not be obtained';
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
    resulting_auth_status := 'exceeds_authorization';
    resulting_visit_status := 'administrator_review';
  elsif prior_minutes + allowed_minutes >= cap_minutes then
    resulting_auth_status := 'limit_reached';
    resulting_visit_status := 'signed';
  else
    resulting_auth_status := 'within_authorization';
    resulting_visit_status := 'signed';
  end if;

  if method = 'unable_to_confirm' then resulting_visit_status := 'administrator_review'; end if;

  snapshot := jsonb_build_object(
    'clientCode', target_visit.client_code_snapshot,
    'caregiverName', target_visit.caregiver_name_snapshot,
    'serviceName', target_service.name,
    'serviceCode', target_service.code,
    'serviceDate', target_visit.service_date,
    'timeIn', target_visit.time_in,
    'timeOut', target_visit.time_out,
    'workedMinutes', target_visit.worked_minutes,
    'signerRole', signer_role,
    'confirmationMethod', method,
    'typedSignerName', signer_name,
    'signerRelationship', relationship,
    'confirmationReason', reason_text,
    'caregiverAttestedAt', now(),
    'timeZone', 'America/Los_Angeles',
    'confirmationVersion', 2,
    'monthToDateBeforeMinutes', prior_minutes,
    'monthToDateAfterMinutes', prior_minutes + allowed_minutes,
    'authorizedMinutes', cap_minutes,
    'remainingMinutes', greatest(0, cap_minutes - prior_minutes - allowed_minutes)
  );

  insert into public.visit_signatures (
    organization_id, visit_id, signer_role, storage_path, signed_visit_snapshot,
    confirmation_method, typed_signer_name, signer_relationship, confirmation_reason
  ) values (
    target_visit.organization_id, target_visit.id, signer_role, signature_storage_path, snapshot,
    method, signer_name, relationship, reason_text
  );

  update public.service_visits set
    caregiver_attested_at = now(),
    verified_minutes = target_visit.worked_minutes,
    billable_minutes = allowed_minutes,
    status = resulting_visit_status,
    authorization_status = resulting_auth_status,
    signed_at = now(),
    locked_at = now()
  where id = target_visit.id;

  return query select
    target_visit.id,
    resulting_visit_status,
    resulting_auth_status,
    target_visit.worked_minutes,
    allowed_minutes,
    prior_minutes + allowed_minutes,
    greatest(0, cap_minutes::bigint - prior_minutes - allowed_minutes);
end;
$function$;

-- Was unconditionally blocking caregiver_attested_at from ever being set
-- unless auth.uid() exactly equalled caregiver_user_id - with no
-- visits.manage override, so even after the fixes above, staff could
-- never actually finish verifying a no-login caregiver's visit (the
-- attestation update would always be rejected here). Already used the
-- null-safe IS DISTINCT FROM; it just needed the same staff-override
-- every other visit RPC already has.
create or replace function public.enforce_caregiver_attestation_actor()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if new.caregiver_attested_at is distinct from old.caregiver_attested_at
     and new.caregiver_attested_at is not null
     and auth.uid() is distinct from new.caregiver_user_id
     and not public.has_permission(new.organization_id, 'visits.manage') then
    raise exception 'Only the assigned caregiver can attest to this visit';
  end if;
  return new;
end;
$function$;
