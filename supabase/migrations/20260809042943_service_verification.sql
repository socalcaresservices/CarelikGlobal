begin;

-- Service Verification: turns a scheduled shift into a client-signed source
-- record for payroll and billing. Minutes are exact server-computed values;
-- hours are presentation only. worked_minutes/verified_minutes/billable_minutes
-- stay separate so an authorization cap is never allowed to erase time that
-- was actually worked - a caregiver's payroll time and a client's billable
-- time can differ, and both must remain auditable.
--
-- Time in/out are never accepted as parameters from the caller - every
-- timestamp on a visit is set by the database from now(), not from the
-- caregiver's device clock. A visit has to be started and ended as two
-- separate, server-timestamped calls (see start_service_visit/
-- end_service_visit below) specifically so "Time In: Now" / "Time Out: Now"
-- can never be spoofed or backdated by the client.

alter table public.clients add column client_code text;

update public.clients
set client_code = 'CL-' || upper(substr(replace(id::text, '-', ''), 1, 6))
where client_code is null;

alter table public.clients alter column client_code set not null;

create function public.set_default_client_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.client_code is null or trim(new.client_code) = '' then
    new.client_code := 'CL-' || upper(substr(replace(new.id::text, '-', ''), 1, 6));
  end if;
  return new;
end;
$$;

create trigger clients_set_default_client_code
before insert on public.clients
for each row execute function public.set_default_client_code();

create unique index clients_org_client_code_unique
  on public.clients (organization_id, lower(client_code))
  where deleted_at is null;

create type public.service_visit_status as enum (
  'draft',
  'awaiting_signature',
  'signed',
  'administrator_review',
  'corrected',
  'voided'
);

create type public.visit_authorization_status as enum (
  'within_authorization',
  'limit_reached',
  'exceeds_authorization',
  'administrator_override'
);

create type public.visit_signer_role as enum (
  'client',
  'parent',
  'guardian',
  'authorized_representative'
);

create table public.service_visits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id),
  client_code_snapshot text not null,
  caregiver_user_id uuid not null references auth.users(id),
  caregiver_name_snapshot text not null,
  scheduled_shift_id uuid references public.shifts(id),
  service_authorization_id uuid not null references public.client_authorizations(id),
  service_id uuid not null references public.services(id),
  service_date date not null,
  -- time_in is set (server now()) when the visit is started; time_out is
  -- null until end_service_visit() sets it (also server now()) - a visit
  -- sits in 'draft' for exactly that window, which is also what powers the
  -- caregiver's live elapsed-time display.
  time_in timestamptz not null,
  time_out timestamptz,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  task_categories text[] not null default '{}',
  service_notes text,
  caregiver_attested_at timestamptz,
  status public.service_visit_status not null default 'draft',
  authorization_status public.visit_authorization_status,
  signed_at timestamptz,
  locked_at timestamptz,
  original_visit_id uuid references public.service_visits(id),
  correction_reason text,
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  void_reason text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_visits_time_check check (time_out is null or time_out > time_in),
  constraint service_visits_worked_check check (worked_minutes is null or worked_minutes > 0),
  constraint service_visits_worked_max_check check (worked_minutes is null or worked_minutes <= 1440),
  constraint service_visits_signed_values_check check (
    (status not in ('signed', 'administrator_review'))
    or (verified_minutes is not null and billable_minutes is not null and signed_at is not null and locked_at is not null)
  ),
  constraint service_visits_draft_shape_check check (
    (status <> 'draft') or (time_out is null and worked_minutes is null)
  )
);

-- One active (draft/awaiting_signature/signed/administrator_review) visit
-- per scheduled shift at a time - voiding or correcting frees the shift up
-- for a fresh start. Prevents duplicate visits for the same shift outright.
create unique index service_visits_shift_unique
  on public.service_visits (scheduled_shift_id)
  where scheduled_shift_id is not null and status not in ('voided', 'corrected');
-- A caregiver can only have one visit "in progress" at a time, org-wide -
-- prevents starting a second visit before finishing/voiding the first.
create unique index service_visits_one_draft_per_caregiver
  on public.service_visits (caregiver_user_id)
  where status = 'draft';
create index service_visits_org_date_idx on public.service_visits (organization_id, service_date desc);
create index service_visits_caregiver_date_idx on public.service_visits (caregiver_user_id, service_date desc);
create index service_visits_authorization_idx on public.service_visits (service_authorization_id, service_date);
create index service_visits_client_idx on public.service_visits (client_id);

create table public.visit_signatures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  visit_id uuid not null unique references public.service_visits(id) on delete cascade,
  signer_role public.visit_signer_role not null,
  storage_path text not null,
  signed_visit_snapshot jsonb not null,
  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Dedicated correction audit trail (separate from the generic
-- write_audit_log() trigger, which only captures raw row diffs) so a
-- report can show "who corrected this, when, why, before -> after" without
-- reconstructing it from audit_logs. The original visit is marked
-- 'corrected' (never deleted, never mutated beyond its status) and a new
-- linked service_visits row (original_visit_id set) carries the corrected
-- values - see correct_service_visit() below.
create table public.visit_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  original_visit_id uuid not null references public.service_visits(id),
  corrected_visit_id uuid not null references public.service_visits(id),
  corrected_by uuid not null references auth.users(id),
  reason text not null,
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index visit_corrections_original_idx on public.visit_corrections (original_visit_id);
create index visit_corrections_org_idx on public.visit_corrections (organization_id);

create trigger service_visits_set_updated_at
before update on public.service_visits
for each row execute function public.set_updated_at();

create trigger service_visits_audit
after insert or update or delete on public.service_visits
for each row execute function public.write_audit_log();

create trigger visit_signatures_audit
after insert or update or delete on public.visit_signatures
for each row execute function public.write_audit_log();

create trigger visit_corrections_audit
after insert or update or delete on public.visit_corrections
for each row execute function public.write_audit_log();

alter table public.service_visits enable row level security;
alter table public.visit_signatures enable row level security;
alter table public.visit_corrections enable row level security;

insert into public.permissions (key, description) values
  ('visits.read', 'View service verification records'),
  ('visits.manage', 'Review, correct, and manage service verification records');

insert into public.role_permissions (role, permission_key)
select role_value, permission_key
from (
  values
    ('organization_owner'::public.system_role, 'visits.read'),
    ('organization_owner'::public.system_role, 'visits.manage'),
    ('organization_admin'::public.system_role, 'visits.read'),
    ('organization_admin'::public.system_role, 'visits.manage'),
    ('manager'::public.system_role, 'visits.read'),
    ('manager'::public.system_role, 'visits.manage'),
    ('coordinator'::public.system_role, 'visits.read'),
    ('coordinator'::public.system_role, 'visits.manage'),
    ('read_only'::public.system_role, 'visits.read')
) grants(role_value, permission_key);

-- No insert/update/delete policy on any of the three tables below, on
-- purpose - every mutation happens through a security-definer function
-- (start/end/sign/void/correct below) that validates ownership,
-- recomputes minutes server-side, and enforces the authorization cap.
-- Direct table writes from the browser are impossible; only reads are
-- policy-gated here.
create policy "members_read_service_visits"
on public.service_visits for select to authenticated
using (
  public.has_permission(organization_id, 'visits.read')
  or caregiver_user_id = auth.uid()
);

create policy "members_read_visit_signatures"
on public.visit_signatures for select to authenticated
using (
  public.has_permission(organization_id, 'visits.read')
  or exists (
    select 1 from public.service_visits v
    where v.id = visit_id and v.caregiver_user_id = auth.uid()
  )
);

create policy "members_read_visit_corrections"
on public.visit_corrections for select to authenticated
using (public.has_permission(organization_id, 'visits.read'));

-- Signature objects are private. The path is always
-- {organization_id}/{visit_id}/client-signature.png - never the client's
-- name or code, so it can't leak identity through a Storage URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('visit-signatures', 'visit-signatures', false, 1048576, array['image/png'])
on conflict (id) do update set public = false;

create policy "caregivers_upload_own_visit_signature"
on storage.objects for insert to authenticated
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

create policy "authorized_read_visit_signatures"
on storage.objects for select to authenticated
using (
  bucket_id = 'visit-signatures'
  and exists (
    select 1 from public.service_visits v
    where v.id::text = (storage.foldername(name))[2]
      and v.organization_id::text = (storage.foldername(name))[1]
      and (v.caregiver_user_id = auth.uid() or public.has_permission(v.organization_id, 'visits.read'))
  )
);

-- Assigned shifts a caregiver can still start a visit for (or, for
-- visits.manage holders, every open shift org-wide). Names stay out of the
-- caregiver workflow entirely - client_code is the only client identifier
-- returned. Excludes any shift that already has a non-voided/non-corrected
-- visit, so a shift can't be started twice.
create or replace function public.list_service_verification_options(target_organization_id uuid)
returns table (
  shift_id uuid,
  client_id uuid,
  client_code text,
  caregiver_user_id uuid,
  caregiver_name text,
  service_id uuid,
  service_name text,
  authorization_id uuid,
  max_monthly_hours numeric,
  starts_at timestamptz,
  ends_at timestamptz,
  signed_minutes_this_month bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    s.client_id,
    c.client_code,
    s.caregiver_user_id,
    coalesce(p.display_name, 'Caregiver'),
    s.service_id,
    sv.name,
    a.id,
    a.max_monthly_hours,
    s.starts_at,
    s.ends_at,
    coalesce(usage.signed_minutes, 0)
  from public.shifts s
  join public.clients c on c.id = s.client_id and c.deleted_at is null
  join public.services sv on sv.id = s.service_id and sv.deleted_at is null
  join public.client_authorizations a
    on a.organization_id = s.organization_id
   and a.client_id = s.client_id
   and a.service_id = s.service_id
   and a.deleted_at is null
   and s.starts_at::date between a.period_start and a.period_end
  left join public.user_profiles p on p.id = s.caregiver_user_id
  left join lateral (
    select sum(v.billable_minutes)::bigint as signed_minutes
    from public.service_visits v
    where v.service_authorization_id = a.id
      and v.service_date >= date_trunc('month', s.starts_at)::date
      and v.service_date < (date_trunc('month', s.starts_at) + interval '1 month')::date
      and v.status in ('signed', 'administrator_review')
  ) usage on true
  where s.organization_id = target_organization_id
    and auth.uid() is not null
    and s.status in ('scheduled', 'completed')
    and (
      s.caregiver_user_id = auth.uid()
      or public.has_permission(target_organization_id, 'visits.manage')
    )
    and not exists (
      select 1 from public.service_visits existing
      where existing.scheduled_shift_id = s.id
        and existing.status not in ('voided', 'corrected')
    )
  order by s.starts_at desc;
$$;

revoke all on function public.list_service_verification_options(uuid) from public, anon;
grant execute on function public.list_service_verification_options(uuid) to authenticated;

-- The caller's own in-progress (draft) visit, if any - lets the page
-- resume showing the live elapsed-time view after a reload instead of
-- losing track of an already-started visit.
create or replace function public.get_active_service_visit(target_organization_id uuid)
returns table (
  visit_id uuid,
  client_code text,
  service_name text,
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
    v.client_code_snapshot,
    sv.name,
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
  join public.services sv on sv.id = v.service_id
  join public.client_authorizations a on a.id = v.service_authorization_id
  where v.organization_id = target_organization_id
    and v.caregiver_user_id = auth.uid()
    and v.status = 'draft'
  limit 1;
$$;

revoke all on function public.get_active_service_visit(uuid) from public, anon;
grant execute on function public.get_active_service_visit(uuid) to authenticated;

-- Starts a visit: time_in is set from now() here, never from a caller-
-- supplied value, so it can't be backdated. Resolves and locks in the
-- authorization that covers today for this client+service.
create or replace function public.start_service_visit(
  target_organization_id uuid,
  target_shift_id uuid,
  visit_task_categories text[] default '{}',
  visit_service_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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

  select * into target_shift from public.shifts
  where id = target_shift_id and organization_id = target_organization_id;

  if target_shift.id is null then raise exception 'Scheduled shift not found'; end if;
  if target_shift.caregiver_user_id <> auth.uid()
     and not public.has_permission(target_organization_id, 'visits.manage') then
    raise exception 'You cannot verify another caregiver''s shift';
  end if;
  if target_shift.service_id is null then
    raise exception 'The shift needs a service before it can be verified';
  end if;

  select * into target_client from public.clients where id = target_shift.client_id and deleted_at is null;
  if target_client.id is null then raise exception 'Client not found'; end if;

  select * into target_auth from public.client_authorizations
  where organization_id = target_organization_id
    and client_id = target_shift.client_id
    and service_id = target_shift.service_id
    and started_at::date between period_start and period_end
    and deleted_at is null
  order by period_start desc limit 1;

  if target_auth.id is null then
    raise exception 'No active authorization covers this visit - an administrator needs to add one first';
  end if;

  select coalesce(display_name, 'Caregiver') into caregiver_name
  from public.user_profiles where id = target_shift.caregiver_user_id;

  insert into public.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id,
    service_id, service_date, time_in, task_categories, service_notes,
    status, created_by
  ) values (
    target_organization_id, target_shift.client_id, target_client.client_code,
    target_shift.caregiver_user_id, coalesce(caregiver_name, 'Caregiver'),
    target_shift.id, target_auth.id, target_shift.service_id, started_at::date,
    started_at, coalesce(visit_task_categories, '{}'), nullif(trim(visit_service_notes), ''),
    'draft', auth.uid()
  ) returning id into visit_id;

  return visit_id;
end;
$$;

revoke all on function public.start_service_visit(uuid, uuid, text[], text) from public, anon;
grant execute on function public.start_service_visit(uuid, uuid, text[], text) to authenticated;

-- Ends a visit: time_out is set from now() here, never from a caller-
-- supplied value. worked_minutes is computed server-side from the two
-- server timestamps, so neither end of the duration is ever trusted from
-- the browser.
create or replace function public.end_service_visit(
  target_visit_id uuid,
  visit_task_categories text[] default null,
  visit_service_notes text default null
)
returns table (
  visit_id uuid,
  worked_minutes integer,
  time_in timestamptz,
  time_out timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
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
  if target_visit.caregiver_user_id <> auth.uid()
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
$$;

revoke all on function public.end_service_visit(uuid, text[], text) from public, anon;
grant execute on function public.end_service_visit(uuid, text[], text) to authenticated;

-- Cancels a visit that should never have been recorded (started by
-- mistake, wrong client selected). Only reachable before signing - once
-- signed, correct_service_visit() is the only path, and the original is
-- never deleted or overwritten either way.
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
  if target_visit.caregiver_user_id <> auth.uid()
     and not public.has_permission(target_visit.organization_id, 'visits.manage') then
    raise exception 'You cannot void another caregiver''s visit';
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

-- Locks the visit against the client's signature. Recomputes the
-- authorization balance from already-signed visits (excluding this one),
-- under a row lock so two concurrent signings against the same monthly
-- cap can't both slip through. billable_minutes is capped at the
-- remaining balance; verified_minutes always equals the full worked time,
-- so payroll math never loses hours even when billing does.
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

revoke all on function public.sign_service_visit(uuid, public.visit_signer_role, text) from public, anon;
grant execute on function public.sign_service_visit(uuid, public.visit_signer_role, text) to authenticated;

-- Administrator-only correction of an already-signed visit. The original
-- row is never deleted or mutated beyond its status flipping to
-- 'corrected' (its worked/verified/billable minutes stay exactly as
-- signed, for history); a new linked row carries the corrected time_in/
-- time_out and is re-run through the same authorization-cap math. No new
-- client signature is required for an administrative correction - this is
-- a clerical/payroll fix, not a re-verification of the visit itself - but
-- who/when/why/before/after is captured in visit_corrections so a report
-- can always show it was corrected and by whom.
create or replace function public.correct_service_visit(
  target_visit_id uuid,
  new_time_in timestamptz,
  new_time_out timestamptz,
  reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  original public.service_visits%rowtype;
  target_auth public.client_authorizations%rowtype;
  corrected_id uuid;
  minutes integer;
  prior_minutes bigint;
  allowed_minutes integer;
  cap_minutes integer;
  resulting_status public.visit_authorization_status;
  resulting_visit_status public.service_visit_status;
  before_snap jsonb;
  after_snap jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to correct a visit';
  end if;
  if new_time_out <= new_time_in then
    raise exception 'Time out must be after time in';
  end if;

  select * into original from public.service_visits where id = target_visit_id for update;
  if original.id is null then raise exception 'Visit not found'; end if;
  if not public.has_permission(original.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to correct visits for this organization';
  end if;
  if original.status not in ('signed', 'administrator_review') then
    raise exception 'Only a signed visit can be corrected';
  end if;

  minutes := floor(extract(epoch from (new_time_out - new_time_in)) / 60)::integer;
  if minutes < 1 or minutes > 1440 then
    raise exception 'Corrected duration must be between 1 minute and 24 hours';
  end if;

  select * into target_auth from public.client_authorizations
  where id = original.service_authorization_id for update;

  select coalesce(sum(v.billable_minutes), 0)::bigint into prior_minutes
  from public.service_visits v
  where v.service_authorization_id = target_auth.id
    and v.id <> original.id
    and v.service_date >= date_trunc('month', new_time_in)::date
    and v.service_date < (date_trunc('month', new_time_in) + interval '1 month')::date
    and v.status in ('signed', 'administrator_review');

  cap_minutes := round(target_auth.max_monthly_hours * 60)::integer;
  allowed_minutes := greatest(0, least(minutes, cap_minutes - prior_minutes::integer));

  if allowed_minutes < minutes then
    resulting_status := 'exceeds_authorization';
    resulting_visit_status := 'administrator_review';
  else
    resulting_status := 'administrator_override';
    resulting_visit_status := 'signed';
  end if;

  before_snap := jsonb_build_object(
    'timeIn', original.time_in, 'timeOut', original.time_out,
    'workedMinutes', original.worked_minutes, 'billableMinutes', original.billable_minutes
  );
  after_snap := jsonb_build_object(
    'timeIn', new_time_in, 'timeOut', new_time_out,
    'workedMinutes', minutes, 'billableMinutes', allowed_minutes
  );

  update public.service_visits set status = 'corrected' where id = original.id;

  insert into public.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id,
    service_id, service_date, time_in, time_out, worked_minutes,
    verified_minutes, billable_minutes, task_categories, service_notes,
    caregiver_attested_at, status, authorization_status, signed_at, locked_at,
    original_visit_id, correction_reason, created_by
  ) values (
    original.organization_id, original.client_id, original.client_code_snapshot,
    original.caregiver_user_id, original.caregiver_name_snapshot, original.scheduled_shift_id,
    original.service_authorization_id, original.service_id, new_time_in::date,
    new_time_in, new_time_out, minutes, minutes, allowed_minutes,
    original.task_categories, original.service_notes, original.caregiver_attested_at,
    resulting_visit_status, resulting_status, now(), now(),
    original.id, btrim(reason), auth.uid()
  ) returning id into corrected_id;

  insert into public.visit_corrections (
    organization_id, original_visit_id, corrected_visit_id, corrected_by,
    reason, before_snapshot, after_snapshot
  ) values (
    original.organization_id, original.id, corrected_id, auth.uid(),
    btrim(reason), before_snap, after_snap
  );

  return corrected_id;
end;
$$;

revoke all on function public.correct_service_visit(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.correct_service_visit(uuid, timestamptz, timestamptz, text) to authenticated;

-- Resolves a visit stuck in 'administrator_review' (it exceeded the
-- authorization at signing time) without touching worked/verified minutes -
-- only billable_minutes and status change, so payroll time is untouched.
create or replace function public.approve_visit_billing(
  target_visit_id uuid,
  approved_billable_minutes integer,
  admin_notes text default null
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

  select * into target_visit from public.service_visits where id = target_visit_id for update;
  if target_visit.id is null then raise exception 'Visit not found'; end if;
  if not public.has_permission(target_visit.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to approve billing for this organization';
  end if;
  if target_visit.status <> 'administrator_review' then
    raise exception 'This visit is not awaiting administrator review';
  end if;
  if approved_billable_minutes < 0 or approved_billable_minutes > target_visit.worked_minutes then
    raise exception 'Approved billable minutes must be between 0 and the worked minutes';
  end if;

  update public.service_visits set
    billable_minutes = approved_billable_minutes,
    authorization_status = 'administrator_override',
    status = 'signed',
    service_notes = case
      when admin_notes is not null and trim(admin_notes) <> ''
        then coalesce(service_notes || E'\n\n', '') || 'Admin review: ' || trim(admin_notes)
      else service_notes
    end
  where id = target_visit.id;
end;
$$;

revoke all on function public.approve_visit_billing(uuid, integer, text) from public, anon;
grant execute on function public.approve_visit_billing(uuid, integer, text) to authenticated;

-- Reports listing: filterable by client/caregiver/service/date range/
-- status. Real client legal names are only ever included for a caller who
-- holds visits.manage for this organization - a caregiver calling this for
-- their own records still only ever sees client_code, matching the
-- caregiver-facing form. Subtotals are computed client-side from this
-- already-filtered set rather than in SQL, since the shapes needed
-- (per-caregiver, per-client, per pay-period, grand total) vary by report
-- view.
create or replace function public.list_service_visits(
  target_organization_id uuid,
  filter_client_id uuid default null,
  filter_caregiver_user_id uuid default null,
  filter_service_id uuid default null,
  filter_date_from date default null,
  filter_date_to date default null,
  filter_status public.service_visit_status default null
)
returns table (
  id uuid,
  client_id uuid,
  client_code text,
  client_legal_name text,
  caregiver_user_id uuid,
  caregiver_name text,
  service_id uuid,
  service_name text,
  service_date date,
  time_in timestamptz,
  time_out timestamptz,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  status public.service_visit_status,
  authorization_status public.visit_authorization_status,
  signed_at timestamptz,
  original_visit_id uuid,
  is_corrected boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id,
    v.client_id,
    v.client_code_snapshot,
    case when public.has_permission(target_organization_id, 'visits.read')
      then c.first_name || ' ' || c.last_name
      else null
    end,
    v.caregiver_user_id,
    v.caregiver_name_snapshot,
    v.service_id,
    sv.name,
    v.service_date,
    v.time_in,
    v.time_out,
    v.worked_minutes,
    v.verified_minutes,
    v.billable_minutes,
    v.status,
    v.authorization_status,
    v.signed_at,
    v.original_visit_id,
    (v.status = 'corrected' or v.original_visit_id is not null)
  from public.service_visits v
  join public.services sv on sv.id = v.service_id
  left join public.clients c on c.id = v.client_id
  where v.organization_id = target_organization_id
    and auth.uid() is not null
    and (public.has_permission(target_organization_id, 'visits.read') or v.caregiver_user_id = auth.uid())
    and (filter_client_id is null or v.client_id = filter_client_id)
    and (filter_caregiver_user_id is null or v.caregiver_user_id = filter_caregiver_user_id)
    and (filter_service_id is null or v.service_id = filter_service_id)
    and (filter_date_from is null or v.service_date >= filter_date_from)
    and (filter_date_to is null or v.service_date <= filter_date_to)
    and (filter_status is null or v.status = filter_status)
  order by v.service_date desc, v.time_in desc;
$$;

revoke all on function public.list_service_visits(uuid, uuid, uuid, uuid, date, date, public.service_visit_status) from public, anon;
grant execute on function public.list_service_visits(uuid, uuid, uuid, uuid, date, date, public.service_visit_status) to authenticated;

commit;
