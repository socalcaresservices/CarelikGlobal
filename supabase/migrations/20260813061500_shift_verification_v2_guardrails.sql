begin;

-- Ogevia Shift Verification v2
-- Caregivers start only administrator-scheduled visits. Time In/Out remain
-- database NOW() values. Submitted visits are locked; corrections/voids are
-- administrator actions. Client confirmation supports accessible alternatives.

alter table public.visit_signatures
  add column if not exists confirmation_method text not null default 'draw',
  add column if not exists typed_signer_name text,
  add column if not exists signer_relationship text,
  add column if not exists confirmation_reason text;

alter table public.visit_signatures alter column storage_path drop not null;

alter table public.visit_signatures
  drop constraint if exists visit_signatures_confirmation_method_check;
alter table public.visit_signatures
  add constraint visit_signatures_confirmation_method_check
  check (confirmation_method in ('draw', 'typed', 'verbal', 'assisted_mark', 'unable_to_confirm'));

-- A retry may replace an image only while the caller still owns the unlocked
-- awaiting-confirmation visit. Locked signature objects remain immutable.
drop policy if exists "caregivers_update_own_visit_signature" on storage.objects;
create policy "caregivers_update_own_visit_signature"
on storage.objects for update to authenticated
using (
  bucket_id = 'visit-signatures'
  and exists (
    select 1 from public.service_visits v
    where v.id::text = (storage.foldername(name))[2]
      and v.organization_id::text = (storage.foldername(name))[1]
      and v.caregiver_user_id = auth.uid()
      and v.status = 'awaiting_signature'
  )
)
with check (
  bucket_id = 'visit-signatures'
  and exists (
    select 1 from public.service_visits v
    where v.id::text = (storage.foldername(name))[2]
      and v.organization_id::text = (storage.foldername(name))[1]
      and v.caregiver_user_id = auth.uid()
      and v.status = 'awaiting_signature'
  )
);

-- Today's assigned, scheduled, unverified shifts for a validated client.
-- Service name and service code are returned as one paired organization-owned
-- record so a caregiver cannot create an invalid code/service combination.
create or replace function public.list_startable_shifts_for_client(
  target_organization_id uuid,
  target_client_id uuid
)
returns table (
  shift_id uuid,
  visit_number text,
  client_id uuid,
  client_code text,
  client_name text,
  service_id uuid,
  service_code text,
  service_name text,
  service_color text,
  authorization_id uuid,
  max_monthly_hours numeric,
  hours_used_this_month numeric,
  hours_scheduled_this_month numeric,
  starts_at timestamptz,
  ends_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    s.visit_number,
    c.id,
    c.client_code,
    trim(c.first_name || ' ' || c.last_name),
    sv.id,
    sv.code,
    sv.name,
    sv.color,
    a.id,
    a.max_monthly_hours,
    coalesce(used.hours, 0),
    coalesce(scheduled.hours, 0),
    s.starts_at,
    s.ends_at
  from public.shifts s
  join public.clients c
    on c.id = s.client_id
   and c.organization_id = s.organization_id
   and c.deleted_at is null
   and c.status = 'active'
  join public.services sv
    on sv.id = s.service_id
   and sv.organization_id = s.organization_id
   and sv.deleted_at is null
   and sv.is_active = true
  join public.client_authorizations a
    on a.organization_id = s.organization_id
   and a.client_id = s.client_id
   and a.service_id = s.service_id
   and a.deleted_at is null
   and s.starts_at::date between a.period_start and a.period_end
  left join lateral (
    select coalesce(sum(v.billable_minutes), 0)::numeric / 60.0 as hours
    from public.service_visits v
    where v.service_authorization_id = a.id
      and v.service_date >= date_trunc('month', s.starts_at)::date
      and v.service_date < (date_trunc('month', s.starts_at) + interval '1 month')::date
      and v.status in ('signed', 'administrator_review')
  ) used on true
  left join lateral (
    select coalesce(sum(extract(epoch from (
      least(s2.ends_at, date_trunc('month', s.starts_at) + interval '1 month')
      - greatest(s2.starts_at, date_trunc('month', s.starts_at))
    )) / 3600.0), 0) as hours
    from public.shifts s2
    where s2.organization_id = s.organization_id
      and s2.client_id = s.client_id
      and s2.service_id = s.service_id
      and s2.status = 'scheduled'
      and s2.starts_at < date_trunc('month', s.starts_at) + interval '1 month'
      and s2.ends_at > date_trunc('month', s.starts_at)
  ) scheduled on true
  where s.organization_id = target_organization_id
    and s.client_id = target_client_id
    and s.caregiver_user_id = auth.uid()
    and s.status = 'scheduled'
    and s.starts_at::date = current_date
    and public.is_organization_member(target_organization_id)
    and not exists (
      select 1 from public.service_visits existing
      where existing.scheduled_shift_id = s.id
        and existing.status not in ('voided', 'corrected')
    )
  order by s.starts_at, sv.name;
$$;

revoke all on function public.list_startable_shifts_for_client(uuid, uuid) from public, anon;
grant execute on function public.list_startable_shifts_for_client(uuid, uuid) to authenticated;

-- Rich active-visit data for the mobile flow. Client name is exposed only for
-- the calling caregiver's own active assigned visit; this does not restore broad
-- caregiver access to the clients table.
create or replace function public.get_active_service_visit_v2(target_organization_id uuid)
returns table (
  visit_id uuid,
  visit_number text,
  client_code text,
  client_name text,
  service_code text,
  service_name text,
  scheduled_starts_at timestamptz,
  scheduled_ends_at timestamptz,
  time_in timestamptz,
  max_monthly_hours numeric,
  signed_minutes_this_month bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id,
    v.visit_number_snapshot,
    v.client_code_snapshot,
    trim(c.first_name || ' ' || c.last_name),
    sv.code,
    sv.name,
    s.starts_at,
    s.ends_at,
    v.time_in,
    a.max_monthly_hours,
    coalesce((
      select sum(v2.billable_minutes)::bigint
      from public.service_visits v2
      where v2.service_authorization_id = a.id
        and v2.id <> v.id
        and v2.service_date >= date_trunc('month', v.time_in)::date
        and v2.service_date < (date_trunc('month', v.time_in) + interval '1 month')::date
        and v2.status in ('signed', 'administrator_review')
    ), 0)
  from public.service_visits v
  join public.clients c on c.id = v.client_id
  join public.services sv on sv.id = v.service_id
  join public.client_authorizations a on a.id = v.service_authorization_id
  left join public.shifts s on s.id = v.scheduled_shift_id
  where v.organization_id = target_organization_id
    and v.caregiver_user_id = auth.uid()
    and v.status = 'draft'
  limit 1;
$$;

revoke all on function public.get_active_service_visit_v2(uuid) from public, anon;
grant execute on function public.get_active_service_visit_v2(uuid) to authenticated;

-- Caregiver self-scheduling is disabled. Admins create normal/extra shifts from
-- Schedule. Keeping the RPC produces a clear message for stale clients.
create or replace function public.schedule_caregiver_visit(
  target_organization_id uuid,
  target_client_id uuid,
  target_service_id uuid,
  visit_starts_at timestamptz,
  visit_ends_at timestamptz,
  visit_notes text default null
)
returns table (shift_id uuid, visit_number text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  raise exception 'SELF_SCHEDULING_DISABLED: Visits must be scheduled by an agency administrator.';
end;
$$;

revoke all on function public.schedule_caregiver_visit(uuid, uuid, uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.schedule_caregiver_visit(uuid, uuid, uuid, timestamptz, timestamptz, text) to authenticated;

-- Caregivers cannot cancel/void a visit. An administrator must document the
-- reason, preserving the original timestamp trail.
create or replace function public.void_service_visit(
  target_visit_id uuid,
  reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_visit public.service_visits%rowtype;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if length(btrim(coalesce(reason, ''))) = 0 then raise exception 'A reason is required to void a visit'; end if;

  select * into target_visit from public.service_visits where id = target_visit_id for update;
  if target_visit.id is null then raise exception 'Visit not found'; end if;
  if not public.has_permission(target_visit.organization_id, 'visits.manage') then
    raise exception 'Only an administrator can void a visit';
  end if;
  if target_visit.status not in ('draft', 'awaiting_signature') then
    raise exception 'A signed visit cannot be voided - use a correction instead';
  end if;

  update public.service_visits set
    status = 'voided',
    voided_at = now(),
    voided_by = auth.uid(),
    void_reason = btrim(reason)
  where id = target_visit.id;
end;
$$;

revoke all on function public.void_service_visit(uuid, text) from public, anon;
grant execute on function public.void_service_visit(uuid, text) to authenticated;

-- Flexible client/representative confirmation. Caregiver attestation is saved at
-- final submission. Draw/assisted mark require the private image; typed/verbal
-- require the confirmer's name; unable-to-confirm requires a reason and routes
-- the visit to administrator review.
create or replace function public.confirm_service_visit(
  target_visit_id uuid,
  signer_role public.visit_signer_role,
  confirmation_method text,
  signature_storage_path text default null,
  typed_signer_name text default null,
  signer_relationship text default null,
  confirmation_reason text default null
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
  if target_visit.caregiver_user_id <> auth.uid()
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
$$;

revoke all on function public.confirm_service_visit(uuid, public.visit_signer_role, text, text, text, text, text) from public, anon;
grant execute on function public.confirm_service_visit(uuid, public.visit_signer_role, text, text, text, text, text) to authenticated;

commit;
