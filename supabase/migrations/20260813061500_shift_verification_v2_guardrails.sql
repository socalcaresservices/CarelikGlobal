begin;

-- Ogevia Shift Verification v2
--
-- Product rules locked by this migration:
--   1. Caregivers cannot create extra/unscheduled shifts.
--   2. Time in and time out remain database-server timestamps only.
--   3. Caregivers cannot void or correct visits; administrators manage corrections.
--   4. A caregiver may start only an administrator-scheduled shift assigned to them.
--   5. Client confirmation supports drawn, typed, verbal, assisted-mark, and
--      unable-to-confirm methods without weakening the immutable audit trail.

-- -----------------------------------------------------------------------------
-- Confirmation metadata. Existing drawn signatures remain valid and are
-- backfilled as method=draw. storage_path becomes nullable because typed/verbal
-- confirmations do not create an image object.
-- -----------------------------------------------------------------------------
alter table public.visit_signatures
  add column if not exists confirmation_method text not null default 'draw',
  add column if not exists typed_signer_name text,
  add column if not exists signer_relationship text,
  add column if not exists confirmation_reason text;

alter table public.visit_signatures
  alter column storage_path drop not null;

alter table public.visit_signatures
  drop constraint if exists visit_signatures_confirmation_method_check;

alter table public.visit_signatures
  add constraint visit_signatures_confirmation_method_check
  check (confirmation_method in ('draw', 'typed', 'verbal', 'assisted_mark', 'unable_to_confirm'));

-- -----------------------------------------------------------------------------
-- A caregiver may only see today's unverified scheduled shifts for the client
-- code they already validated. Service name + service code are returned as one
-- paired record so the UI cannot accidentally combine a service with the wrong
-- code. The organization owns the services catalog and may add its own codes.
-- -----------------------------------------------------------------------------
create or replace function public.list_startable_shifts_for_client(
  target_organization_id uuid,
  target_client_id uuid
)
returns table (
  shift_id uuid,
  visit_number text,
  client_id uuid,
  client_code text,
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
    sv.id,
    sv.code,
    sv.name,
    sv.color,
    a.id,
    a.max_monthly_hours,
    coalesce(usage.hours_used_this_month, 0),
    coalesce(usage.hours_scheduled_this_month, 0),
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
    select
      coalesce(sum(v.billable_minutes) filter (
        where v.status in ('signed', 'administrator_review')
          and v.service_date >= date_trunc('month', s.starts_at)::date
          and v.service_date < (date_trunc('month', s.starts_at) + interval '1 month')::date
      ), 0)::numeric / 60.0 as hours_used_this_month,
      coalesce(sum(extract(epoch from (
        least(s2.ends_at, date_trunc('month', s.starts_at) + interval '1 month')
        - greatest(s2.starts_at, date_trunc('month', s.starts_at))
      )) / 3600.0) filter (
        where s2.status = 'scheduled'
          and s2.starts_at < date_trunc('month', s.starts_at) + interval '1 month'
          and s2.ends_at > date_trunc('month', s.starts_at)
      ), 0) as hours_scheduled_this_month
    from public.service_visits v
    full join public.shifts s2
      on false
    where (v.service_authorization_id = a.id or v.id is null)
  ) usage on true
  where s.organization_id = target_organization_id
    and s.client_id = target_client_id
    and s.caregiver_user_id = auth.uid()
    and s.status = 'scheduled'
    and s.starts_at::date = current_date
    and public.is_organization_member(target_organization_id)
    and not exists (
      select 1
      from public.service_visits existing
      where existing.scheduled_shift_id = s.id
        and existing.status not in ('voided', 'corrected')
    )
  order by s.starts_at, sv.name;
$$;

-- The full-join trick above is unnecessarily clever for the two independent
-- aggregates and can be hard for future maintainers to reason about. Replace it
-- immediately with a plpgsql-free SQL definition using two scalar laterals.
create or replace function public.list_startable_shifts_for_client(
  target_organization_id uuid,
  target_client_id uuid
)
returns table (
  shift_id uuid,
  visit_number text,
  client_id uuid,
  client_code text,
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
      select 1
      from public.service_visits existing
      where existing.scheduled_shift_id = s.id
        and existing.status not in ('voided', 'corrected')
    )
  order by s.starts_at, sv.name;
$$;

revoke all on function public.list_startable_shifts_for_client(uuid, uuid) from public, anon;
grant execute on function public.list_startable_shifts_for_client(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Disable the old caregiver self-scheduling RPC. Administrators schedule shifts
-- from the organization Schedule surface. Keeping the function in place avoids
-- a missing-function failure for a stale client while still enforcing the new
-- rule server-side.
-- -----------------------------------------------------------------------------
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
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  raise exception 'SELF_SCHEDULING_DISABLED: Visits must be scheduled by an agency administrator.';
end;
$$;

revoke all on function public.schedule_caregiver_visit(uuid, uuid, uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.schedule_caregiver_visit(uuid, uuid, uuid, timestamptz, timestamptz, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Backward-compatible hardening of the client-code start RPC. It no longer
-- creates an unscheduled service_visit. It must resolve exactly one scheduled,
-- unverified shift for the calling caregiver, client, service, and today, then
-- delegates to the same server-controlled visit row shape.
-- -----------------------------------------------------------------------------
create or replace function public.start_service_visit_by_client_code(
  target_organization_id uuid,
  target_client_code text,
  target_service_id uuid,
  visit_task_categories text[] default '{}',
  visit_service_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_client public.clients%rowtype;
  candidate public.shifts%rowtype;
  candidate_count integer;
  target_auth public.client_authorizations%rowtype;
  caregiver_name text;
  visit_id uuid;
  started_at timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_organization_member(target_organization_id) then
    raise exception 'Not a member of this organization';
  end if;

  select * into target_client
  from public.clients
  where organization_id = target_organization_id
    and lower(client_code) = lower(btrim(target_client_code))
    and deleted_at is null
    and status = 'active';

  if target_client.id is null then
    raise exception 'NOT_FOUND: That client ID was not found or is not active.';
  end if;

  select count(*) into candidate_count
  from public.shifts s
  where s.organization_id = target_organization_id
    and s.client_id = target_client.id
    and s.caregiver_user_id = auth.uid()
    and s.service_id = target_service_id
    and s.status = 'scheduled'
    and s.starts_at::date = current_date
    and not exists (
      select 1 from public.service_visits existing
      where existing.scheduled_shift_id = s.id
        and existing.status not in ('voided', 'corrected')
    );

  if candidate_count = 0 then
    raise exception 'NO_SCHEDULED_VISIT: No administrator-scheduled visit is available for this client and service today.';
  end if;
  if candidate_count > 1 then
    raise exception 'MULTIPLE_SCHEDULED_VISITS: Select the scheduled visit from your visit list.';
  end if;

  select * into candidate
  from public.shifts s
  where s.organization_id = target_organization_id
    and s.client_id = target_client.id
    and s.caregiver_user_id = auth.uid()
    and s.service_id = target_service_id
    and s.status = 'scheduled'
    and s.starts_at::date = current_date
    and not exists (
      select 1 from public.service_visits existing
      where existing.scheduled_shift_id = s.id
        and existing.status not in ('voided', 'corrected')
    )
  limit 1;

  select * into target_auth
  from public.client_authorizations
  where organization_id = target_organization_id
    and client_id = target_client.id
    and service_id = target_service_id
    and deleted_at is null
    and started_at::date between period_start and period_end
  order by period_start desc
  limit 1;

  if target_auth.id is null then
    raise exception 'No active authorization covers this scheduled visit - contact your agency administrator';
  end if;

  select coalesce(display_name, 'Caregiver') into caregiver_name
  from public.user_profiles where id = auth.uid();

  insert into public.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id,
    service_id, service_date, time_in, task_categories, service_notes,
    status, created_by, visit_number_snapshot
  ) values (
    target_organization_id, target_client.id, target_client.client_code,
    auth.uid(), coalesce(caregiver_name, 'Caregiver'),
    candidate.id, target_auth.id, target_service_id, started_at::date,
    started_at, coalesce(visit_task_categories, '{}'), nullif(trim(visit_service_notes), ''),
    'draft', auth.uid(), candidate.visit_number
  ) returning id into visit_id;

  return visit_id;
end;
$$;

revoke all on function public.start_service_visit_by_client_code(uuid, text, uuid, text[], text) from public, anon;
grant execute on function public.start_service_visit_by_client_code(uuid, text, uuid, text[], text) to authenticated;

-- -----------------------------------------------------------------------------
-- A caregiver cannot cancel/void a visit. A mistake becomes an administrator
-- action so the original server timestamp and the reason remain reviewable.
-- -----------------------------------------------------------------------------
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
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to void a visit';
  end if;

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

-- -----------------------------------------------------------------------------
-- Flexible confirmation. The visit remains immutable after submission. The
-- caregiver's attestation timestamp is recorded here, at the moment the final
-- confirmation is submitted (not merely when Time Out is pressed).
-- -----------------------------------------------------------------------------
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
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
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
  elsif method in ('typed', 'verbal') then
    if signer_name is null then
      raise exception 'Enter the name of the person confirming the visit';
    end if;
  elsif method = 'unable_to_confirm' and reason_text is null then
    raise exception 'Explain why confirmation could not be obtained';
  end if;

  select * into target_auth
  from public.client_authorizations
  where id = target_visit.service_authorization_id
  for update;

  select * into target_service
  from public.services
  where id = target_visit.service_id;

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

  if method = 'unable_to_confirm' then
    resulting_visit_status := 'administrator_review';
  end if;

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
    'confirmationText', 'I confirm that the services and hours shown above were provided on the date stated.',
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
