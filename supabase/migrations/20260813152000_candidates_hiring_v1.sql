begin;

-- Candidate Hiring V1 is an administrative workflow only. Every pipeline
-- change, onboarding action, credential verification, import, and transfer is
-- initiated by an authorized organization user. Nothing in this migration
-- scores, ranks, recommends, selects, or rejects candidates automatically.

alter table public.job_applicants
  add column if not exists pipeline_stage text not null default 'application_received',
  add column if not exists source text not null default 'agency_website',
  add column if not exists source_record_id text,
  add column if not exists position_applied_for text,
  add column if not exists applied_at timestamptz,
  add column if not exists imported_at timestamptz,
  add column if not exists application_completed_at timestamptz,
  add column if not exists portal_completed_at timestamptz;

alter table public.job_applicants
  drop constraint if exists job_applicants_pipeline_stage_check;

alter table public.job_applicants
  add constraint job_applicants_pipeline_stage_check check (
    pipeline_stage in (
      'imported',
      'application_needed',
      'application_received',
      'screening',
      'interview',
      'conditional_offer',
      'hired_onboarding_required',
      'onboarding_scheduled',
      'onboarding',
      'compliance_pending',
      'ready_to_work',
      'care_team',
      'on_hold',
      'rejected',
      'withdrawn'
    )
  );

create index if not exists job_applicants_stage_idx
  on public.job_applicants (organization_id, pipeline_stage);
create index if not exists job_applicants_source_idx
  on public.job_applicants (organization_id, source);
create index if not exists job_applicants_source_record_idx
  on public.job_applicants (organization_id, source, source_record_id)
  where source_record_id is not null;
create index if not exists job_applicants_applied_at_idx
  on public.job_applicants (organization_id, applied_at);

update public.job_applicants
set applied_at = coalesce(applied_at, created_at),
    application_completed_at = coalesce(application_completed_at, created_at)
where applied_at is null or application_completed_at is null;

-- Stage history is separate from the generic audit log so the hiring timeline
-- is easy to render and report without parsing JSON audit payloads.
create table if not exists public.candidate_stage_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  applicant_id uuid not null references public.job_applicants(id) on delete cascade,
  from_stage text,
  to_stage text not null,
  note text,
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now()
);

create index if not exists candidate_stage_history_applicant_idx
  on public.candidate_stage_history (applicant_id, changed_at desc);

alter table public.candidate_stage_history enable row level security;

drop policy if exists "authorized_read_candidate_stage_history" on public.candidate_stage_history;
create policy "authorized_read_candidate_stage_history"
on public.candidate_stage_history for select
to authenticated
using (public.has_permission(organization_id, 'applicants.read'));

drop policy if exists "authorized_manage_candidate_stage_history" on public.candidate_stage_history;
create policy "authorized_manage_candidate_stage_history"
on public.candidate_stage_history for all
to authenticated
using (public.has_permission(organization_id, 'applicants.update'))
with check (public.has_permission(organization_id, 'applicants.update'));

-- Revocable, expiring candidate portal links. The raw token is returned once
-- by create_candidate_portal_link(); only its SHA-256 hash is stored.
create table if not exists public.candidate_portal_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  applicant_id uuid not null references public.job_applicants(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists candidate_portal_tokens_applicant_idx
  on public.candidate_portal_tokens (applicant_id, created_at desc);

alter table public.candidate_portal_tokens enable row level security;

drop policy if exists "authorized_read_candidate_portal_tokens" on public.candidate_portal_tokens;
create policy "authorized_read_candidate_portal_tokens"
on public.candidate_portal_tokens for select
to authenticated
using (public.has_permission(organization_id, 'applicants.read'));

drop policy if exists "authorized_manage_candidate_portal_tokens" on public.candidate_portal_tokens;
create policy "authorized_manage_candidate_portal_tokens"
on public.candidate_portal_tokens for all
to authenticated
using (public.has_permission(organization_id, 'applicants.update'))
with check (public.has_permission(organization_id, 'applicants.update'));

-- Generic candidate credentials. Candidate submission and staff verification
-- are deliberately separate fields.
create table if not exists public.candidate_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  applicant_id uuid not null references public.job_applicants(id) on delete cascade,
  credential_type text not null,
  issue_date date,
  expiration_date date,
  does_not_expire boolean not null default false,
  issuing_organization text,
  credential_number text,
  submission_status text not null default 'self_reported',
  verification_status text not null default 'unverified',
  verified_by uuid references auth.users(id),
  verified_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint candidate_credentials_expiration_check check (
    not does_not_expire or expiration_date is null
  ),
  constraint candidate_credentials_submission_status_check check (
    submission_status in ('self_reported', 'uploaded', 'pending_review', 'missing')
  ),
  constraint candidate_credentials_verification_status_check check (
    verification_status in ('unverified', 'verified', 'rejected')
  )
);

create index if not exists candidate_credentials_applicant_idx
  on public.candidate_credentials (applicant_id) where deleted_at is null;
create index if not exists candidate_credentials_expiration_idx
  on public.candidate_credentials (organization_id, expiration_date) where deleted_at is null;

alter table public.candidate_credentials enable row level security;

drop policy if exists "authorized_read_candidate_credentials" on public.candidate_credentials;
create policy "authorized_read_candidate_credentials"
on public.candidate_credentials for select
to authenticated
using (deleted_at is null and public.has_permission(organization_id, 'applicants.read'));

drop policy if exists "authorized_manage_candidate_credentials" on public.candidate_credentials;
create policy "authorized_manage_candidate_credentials"
on public.candidate_credentials for all
to authenticated
using (public.has_permission(organization_id, 'applicants.update'))
with check (public.has_permission(organization_id, 'applicants.update'));

create trigger candidate_credentials_set_updated_at
before update on public.candidate_credentials
for each row execute function public.set_updated_at();

create trigger candidate_credentials_audit
after insert or update or delete on public.candidate_credentials
for each row execute function public.write_audit_log();

-- One onboarding record per candidate. Organization staff control all values.
create table if not exists public.candidate_onboarding (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  applicant_id uuid not null unique references public.job_applicants(id) on delete cascade,
  status text not null default 'not_scheduled',
  scheduled_at timestamptz,
  method text,
  location text,
  instructions text,
  notes text,
  background_check_status text not null default 'not_started',
  compliance_status text not null default 'pending',
  completed_at timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidate_onboarding_status_check check (
    status in ('not_scheduled', 'scheduled', 'in_progress', 'completed', 'cancelled')
  ),
  constraint candidate_onboarding_background_check_check check (
    background_check_status in ('not_started', 'requested', 'submitted', 'pending', 'complete', 'needs_attention')
  ),
  constraint candidate_onboarding_compliance_check check (
    compliance_status in ('pending', 'needs_attention', 'complete')
  )
);

alter table public.candidate_onboarding enable row level security;

drop policy if exists "authorized_read_candidate_onboarding" on public.candidate_onboarding;
create policy "authorized_read_candidate_onboarding"
on public.candidate_onboarding for select
to authenticated
using (public.has_permission(organization_id, 'applicants.read'));

drop policy if exists "authorized_manage_candidate_onboarding" on public.candidate_onboarding;
create policy "authorized_manage_candidate_onboarding"
on public.candidate_onboarding for all
to authenticated
using (public.has_permission(organization_id, 'applicants.update'))
with check (public.has_permission(organization_id, 'applicants.update'));

create trigger candidate_onboarding_set_updated_at
before update on public.candidate_onboarding
for each row execute function public.set_updated_at();

create trigger candidate_onboarding_audit
after insert or update or delete on public.candidate_onboarding
for each row execute function public.write_audit_log();

-- Workforce records are independent from login accounts. linked_user_id may
-- remain null until Access is granted later.
create table if not exists public.caregiver_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  applicant_id uuid references public.job_applicants(id) on delete set null,
  linked_user_id uuid references auth.users(id),
  first_name text not null,
  middle_name text,
  last_name text not null,
  preferred_name text,
  email citext,
  phone text,
  alternate_phone text,
  address_street text,
  address_line2 text,
  address_city text,
  address_state text,
  address_zip text,
  address_country text not null default 'US',
  employment_type text,
  available_start_date date,
  desired_weekly_hours numeric,
  min_weekly_hours numeric,
  max_weekly_hours numeric,
  min_shift_hours numeric,
  max_shift_hours numeric,
  max_travel_minutes integer,
  transportation_method text,
  reliable_transportation boolean,
  willing_to_transport_clients boolean,
  valid_drivers_license boolean,
  vehicle_available boolean,
  auto_insurance boolean,
  languages text[] not null default '{}',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint caregiver_records_status_check check (status in ('onboarding', 'ready', 'active', 'inactive'))
);

create unique index if not exists caregiver_records_org_applicant_unique
  on public.caregiver_records (organization_id, applicant_id)
  where applicant_id is not null and deleted_at is null;
create unique index if not exists caregiver_records_org_user_unique
  on public.caregiver_records (organization_id, linked_user_id)
  where linked_user_id is not null and deleted_at is null;
create index if not exists caregiver_records_org_idx
  on public.caregiver_records (organization_id) where deleted_at is null;

alter table public.caregiver_records enable row level security;

drop policy if exists "authorized_read_caregiver_records" on public.caregiver_records;
create policy "authorized_read_caregiver_records"
on public.caregiver_records for select
to authenticated
using (
  deleted_at is null
  and (
    public.has_permission(organization_id, 'membership.read')
    or linked_user_id = auth.uid()
  )
);

drop policy if exists "authorized_manage_caregiver_records" on public.caregiver_records;
create policy "authorized_manage_caregiver_records"
on public.caregiver_records for all
to authenticated
using (public.has_permission(organization_id, 'membership.update'))
with check (public.has_permission(organization_id, 'membership.update'));

create trigger caregiver_records_set_updated_at
before update on public.caregiver_records
for each row execute function public.set_updated_at();

create trigger caregiver_records_audit
after insert or update or delete on public.caregiver_records
for each row execute function public.write_audit_log();

create table if not exists public.caregiver_record_availability (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  caregiver_record_id uuid not null references public.caregiver_records(id) on delete cascade,
  day_of_week public.weekday not null,
  start_time time not null,
  end_time time not null,
  preference public.availability_preference not null default 'available',
  created_at timestamptz not null default now(),
  constraint caregiver_record_availability_order check (end_time > start_time)
);

create index if not exists caregiver_record_availability_record_idx
  on public.caregiver_record_availability (caregiver_record_id, day_of_week, start_time);

alter table public.caregiver_record_availability enable row level security;

drop policy if exists "authorized_read_caregiver_record_availability" on public.caregiver_record_availability;
create policy "authorized_read_caregiver_record_availability"
on public.caregiver_record_availability for select
to authenticated
using (
  public.has_permission(organization_id, 'membership.read')
  or exists (
    select 1 from public.caregiver_records cr
    where cr.id = caregiver_record_id and cr.linked_user_id = auth.uid()
  )
);

drop policy if exists "authorized_manage_caregiver_record_availability" on public.caregiver_record_availability;
create policy "authorized_manage_caregiver_record_availability"
on public.caregiver_record_availability for all
to authenticated
using (public.has_permission(organization_id, 'membership.update'))
with check (public.has_permission(organization_id, 'membership.update'));

create table if not exists public.caregiver_record_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  caregiver_record_id uuid not null references public.caregiver_records(id) on delete cascade,
  source_candidate_credential_id uuid references public.candidate_credentials(id) on delete set null,
  credential_type text not null,
  issue_date date,
  expiration_date date,
  does_not_expire boolean not null default false,
  issuing_organization text,
  credential_number text,
  verification_status text not null default 'unverified',
  verified_by uuid references auth.users(id),
  verified_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists caregiver_record_credentials_record_idx
  on public.caregiver_record_credentials (caregiver_record_id) where deleted_at is null;

alter table public.caregiver_record_credentials enable row level security;

drop policy if exists "authorized_read_caregiver_record_credentials" on public.caregiver_record_credentials;
create policy "authorized_read_caregiver_record_credentials"
on public.caregiver_record_credentials for select
to authenticated
using (
  deleted_at is null
  and (
    public.has_permission(organization_id, 'credentials.read')
    or exists (
      select 1 from public.caregiver_records cr
      where cr.id = caregiver_record_id and cr.linked_user_id = auth.uid()
    )
  )
);

drop policy if exists "authorized_manage_caregiver_record_credentials" on public.caregiver_record_credentials;
create policy "authorized_manage_caregiver_record_credentials"
on public.caregiver_record_credentials for all
to authenticated
using (public.has_permission(organization_id, 'credentials.update'))
with check (public.has_permission(organization_id, 'credentials.update'));

create trigger caregiver_record_credentials_set_updated_at
before update on public.caregiver_record_credentials
for each row execute function public.set_updated_at();

create trigger caregiver_record_credentials_audit
after insert or update or delete on public.caregiver_record_credentials
for each row execute function public.write_audit_log();

-- Backfill existing caregiver memberships so current caregivers remain visible
-- when the Care Team screen switches to workforce records.
insert into public.caregiver_records (
  organization_id,
  linked_user_id,
  first_name,
  last_name,
  email,
  status
)
select
  om.organization_id,
  om.user_id,
  coalesce(nullif(split_part(up.display_name, ' ', 1), ''), 'Caregiver'),
  coalesce(nullif(substr(up.display_name, length(split_part(up.display_name, ' ', 1)) + 2), ''), 'Team'),
  au.email,
  case when om.status = 'active' then 'active' else 'inactive' end
from public.organization_memberships om
join public.user_profiles up on up.id = om.user_id
join auth.users au on au.id = om.user_id
where om.role::text = 'caregiver'
  and not exists (
    select 1 from public.caregiver_records cr
    where cr.organization_id = om.organization_id and cr.linked_user_id = om.user_id and cr.deleted_at is null
  );

-- Human-controlled stage change. This function never chooses a stage itself.
create or replace function public.set_candidate_stage(
  target_organization_id uuid,
  target_applicant_id uuid,
  target_stage text,
  stage_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_stage text;
begin
  if not public.has_permission(target_organization_id, 'applicants.update') then
    raise exception 'You do not have permission to update candidates for this organization';
  end if;

  if target_stage not in (
    'imported','application_needed','application_received','screening','interview','conditional_offer',
    'hired_onboarding_required','onboarding_scheduled','onboarding','compliance_pending','ready_to_work',
    'care_team','on_hold','rejected','withdrawn'
  ) then
    raise exception 'Unknown candidate stage';
  end if;

  select pipeline_stage into current_stage
  from public.job_applicants
  where id = target_applicant_id and organization_id = target_organization_id;

  if not found then raise exception 'Candidate not found'; end if;
  if current_stage = target_stage then return; end if;

  update public.job_applicants
  set pipeline_stage = target_stage,
      status = case
        when target_stage = 'rejected' then 'rejected'::public.applicant_status
        when target_stage = 'withdrawn' then 'withdrawn'::public.applicant_status
        when target_stage = 'care_team' then 'hired'::public.applicant_status
        else status
      end,
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = target_applicant_id and organization_id = target_organization_id;

  insert into public.candidate_stage_history (
    organization_id, applicant_id, from_stage, to_stage, note, changed_by
  ) values (
    target_organization_id, target_applicant_id, current_stage, target_stage, nullif(trim(stage_note), ''), auth.uid()
  );
end;
$$;

revoke all on function public.set_candidate_stage(uuid, uuid, text, text) from public;
grant execute on function public.set_candidate_stage(uuid, uuid, text, text) to authenticated;

-- Duplicate-safe import preview. It reports potential duplicates but never
-- decides what staff should do with them.
create or replace function public.preview_candidate_import(
  target_organization_id uuid,
  import_rows jsonb
)
returns table (
  row_number integer,
  disposition text,
  reason text,
  candidate jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  item jsonb;
  idx integer := 0;
  normalized_email text;
  normalized_phone text;
  source_value text;
  source_id_value text;
begin
  if not public.has_permission(target_organization_id, 'applicants.update') then
    raise exception 'You do not have permission to import candidates for this organization';
  end if;

  for item in select value from jsonb_array_elements(coalesce(import_rows, '[]'::jsonb)) loop
    idx := idx + 1;
    normalized_email := lower(trim(coalesce(item->>'email', '')));
    normalized_phone := regexp_replace(coalesce(item->>'phone', ''), '[^0-9]', '', 'g');
    source_value := lower(trim(coalesce(item->>'source', 'other')));
    source_id_value := nullif(trim(coalesce(item->>'source_record_id', '')), '');

    if trim(coalesce(item->>'first_name', '')) = ''
       or trim(coalesce(item->>'last_name', '')) = ''
       or normalized_email = '' then
      row_number := idx;
      disposition := 'invalid';
      reason := 'First name, last name, and email are required.';
      candidate := item;
      return next;
    elsif exists (
      select 1 from public.job_applicants a
      where a.organization_id = target_organization_id
        and (
          lower(a.email::text) = normalized_email
          or (normalized_phone <> '' and regexp_replace(coalesce(a.phone, ''), '[^0-9]', '', 'g') = normalized_phone)
          or (source_id_value is not null and lower(a.source) = source_value and a.source_record_id = source_id_value)
        )
    ) then
      row_number := idx;
      disposition := 'possible_duplicate';
      reason := 'A candidate with the same email, phone, or source record already exists.';
      candidate := item;
      return next;
    else
      row_number := idx;
      disposition := 'new';
      reason := null;
      candidate := item;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.preview_candidate_import(uuid, jsonb) from public;
grant execute on function public.preview_candidate_import(uuid, jsonb) to authenticated;

-- Inserts only rows that are still non-duplicates at execution time. The UI
-- previews first; this second duplicate check prevents race-condition copies.
create or replace function public.import_candidates_v1(
  target_organization_id uuid,
  import_rows jsonb
)
returns table (inserted_count integer, skipped_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  inserted_total integer := 0;
  skipped_total integer := 0;
  normalized_email text;
  normalized_phone text;
  source_value text;
  source_id_value text;
begin
  if not public.has_permission(target_organization_id, 'applicants.update') then
    raise exception 'You do not have permission to import candidates for this organization';
  end if;

  for item in select value from jsonb_array_elements(coalesce(import_rows, '[]'::jsonb)) loop
    normalized_email := lower(trim(coalesce(item->>'email', '')));
    normalized_phone := regexp_replace(coalesce(item->>'phone', ''), '[^0-9]', '', 'g');
    source_value := lower(trim(coalesce(item->>'source', 'other')));
    source_id_value := nullif(trim(coalesce(item->>'source_record_id', '')), '');

    if trim(coalesce(item->>'first_name', '')) = ''
       or trim(coalesce(item->>'last_name', '')) = ''
       or normalized_email = ''
       or exists (
         select 1 from public.job_applicants a
         where a.organization_id = target_organization_id
           and (
             lower(a.email::text) = normalized_email
             or (normalized_phone <> '' and regexp_replace(coalesce(a.phone, ''), '[^0-9]', '', 'g') = normalized_phone)
             or (source_id_value is not null and lower(a.source) = source_value and a.source_record_id = source_id_value)
           )
       ) then
      skipped_total := skipped_total + 1;
    else
      insert into public.job_applicants (
        organization_id,
        first_name,
        last_name,
        email,
        phone,
        pipeline_stage,
        source,
        source_record_id,
        position_applied_for,
        applied_at,
        imported_at,
        status
      ) values (
        target_organization_id,
        trim(item->>'first_name'),
        trim(item->>'last_name'),
        normalized_email,
        nullif(trim(coalesce(item->>'phone', '')), ''),
        'imported',
        source_value,
        source_id_value,
        nullif(trim(coalesce(item->>'position_applied_for', '')), ''),
        coalesce(nullif(item->>'applied_at', '')::timestamptz, now()),
        now(),
        'new'::public.applicant_status
      );
      inserted_total := inserted_total + 1;
    end if;
  end loop;

  inserted_count := inserted_total;
  skipped_count := skipped_total;
  return next;
end;
$$;

revoke all on function public.import_candidates_v1(uuid, jsonb) from public;
grant execute on function public.import_candidates_v1(uuid, jsonb) to authenticated;

create or replace function public.create_candidate_portal_link(
  target_organization_id uuid,
  target_applicant_id uuid,
  ttl_hours integer default 168
)
returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_token text;
  expiry timestamptz;
begin
  if not public.has_permission(target_organization_id, 'applicants.update') then
    raise exception 'You do not have permission to create candidate links for this organization';
  end if;
  if ttl_hours < 1 or ttl_hours > 720 then
    raise exception 'Candidate link lifetime must be between 1 and 720 hours';
  end if;
  if not exists (
    select 1 from public.job_applicants
    where id = target_applicant_id and organization_id = target_organization_id
  ) then
    raise exception 'Candidate not found';
  end if;

  raw_token := encode(gen_random_bytes(32), 'hex');
  expiry := now() + make_interval(hours => ttl_hours);

  insert into public.candidate_portal_tokens (
    organization_id, applicant_id, token_hash, expires_at, created_by
  ) values (
    target_organization_id,
    target_applicant_id,
    encode(digest(raw_token, 'sha256'), 'hex'),
    expiry,
    auth.uid()
  );

  token := raw_token;
  expires_at := expiry;
  return next;
end;
$$;

revoke all on function public.create_candidate_portal_link(uuid, uuid, integer) from public;
grant execute on function public.create_candidate_portal_link(uuid, uuid, integer) to authenticated;

create or replace function public.revoke_candidate_portal_link(
  target_organization_id uuid,
  target_token_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'applicants.update') then
    raise exception 'You do not have permission to revoke candidate links for this organization';
  end if;
  update public.candidate_portal_tokens
  set revoked_at = now()
  where id = target_token_id and organization_id = target_organization_id;
end;
$$;

revoke all on function public.revoke_candidate_portal_link(uuid, uuid) from public;
grant execute on function public.revoke_candidate_portal_link(uuid, uuid) to authenticated;

-- Candidate portal resolver. Only the candidate represented by the valid token
-- is returned; no organization-wide data is exposed.
create or replace function public.get_candidate_portal(target_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  token_row public.candidate_portal_tokens;
  applicant_row public.job_applicants;
  org_row public.organizations;
  result jsonb;
begin
  select * into token_row
  from public.candidate_portal_tokens
  where token_hash = encode(digest(target_token, 'sha256'), 'hex')
    and revoked_at is null
    and expires_at > now();

  if not found then raise exception 'Candidate link is invalid or expired'; end if;

  update public.candidate_portal_tokens set last_used_at = now() where id = token_row.id;
  select * into applicant_row from public.job_applicants where id = token_row.applicant_id;
  select * into org_row from public.organizations where id = token_row.organization_id;

  select jsonb_build_object(
    'organization', jsonb_build_object(
      'display_name', org_row.display_name,
      'logo_url', org_row.logo_url,
      'accent_color', org_row.accent_color,
      'show_powered_by', org_row.show_powered_by
    ),
    'candidate', jsonb_build_object(
      'id', applicant_row.id,
      'first_name', applicant_row.first_name,
      'middle_name', applicant_row.middle_name,
      'last_name', applicant_row.last_name,
      'preferred_name', applicant_row.preferred_name,
      'email', applicant_row.email,
      'phone', applicant_row.phone,
      'alternate_phone', applicant_row.alternate_phone,
      'address_street', applicant_row.address_street,
      'address_line2', applicant_row.address_line2,
      'address_city', applicant_row.address_city,
      'address_state', applicant_row.address_state,
      'address_zip', applicant_row.address_zip,
      'employment_type', applicant_row.employment_type,
      'available_start_date', applicant_row.available_start_date,
      'desired_weekly_hours', applicant_row.desired_weekly_hours,
      'min_weekly_hours', applicant_row.min_weekly_hours,
      'max_weekly_hours', applicant_row.max_weekly_hours,
      'min_shift_hours', applicant_row.min_shift_hours,
      'max_shift_hours', applicant_row.max_shift_hours,
      'max_travel_minutes', applicant_row.max_travel_minutes,
      'transportation_method', applicant_row.transportation_method,
      'reliable_transportation', applicant_row.reliable_transportation,
      'willing_to_transport_clients', applicant_row.willing_to_transport_clients,
      'valid_drivers_license', applicant_row.valid_drivers_license,
      'vehicle_available', applicant_row.vehicle_available,
      'auto_insurance', applicant_row.auto_insurance,
      'languages', applicant_row.languages,
      'position_applied_for', applicant_row.position_applied_for
    ),
    'availability', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', av.id,
        'day_of_week', av.day_of_week,
        'start_time', av.start_time,
        'end_time', av.end_time,
        'preference', av.preference
      ) order by av.day_of_week, av.start_time)
      from public.job_applicant_availability av where av.applicant_id = applicant_row.id
    ), '[]'::jsonb),
    'credentials', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', cc.id,
        'credential_type', cc.credential_type,
        'issue_date', cc.issue_date,
        'expiration_date', cc.expiration_date,
        'does_not_expire', cc.does_not_expire,
        'issuing_organization', cc.issuing_organization,
        'credential_number', cc.credential_number,
        'submission_status', cc.submission_status,
        'verification_status', cc.verification_status,
        'notes', cc.notes
      ) order by cc.credential_type)
      from public.candidate_credentials cc
      where cc.applicant_id = applicant_row.id and cc.deleted_at is null
    ), '[]'::jsonb),
    'onboarding', (
      select to_jsonb(co) - 'organization_id' - 'created_by' - 'updated_by'
      from public.candidate_onboarding co where co.applicant_id = applicant_row.id
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_candidate_portal(text) from public;
grant execute on function public.get_candidate_portal(text) to anon, authenticated;

create or replace function public.save_candidate_portal_profile(
  target_token text,
  profile jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  token_row public.candidate_portal_tokens;
begin
  select * into token_row
  from public.candidate_portal_tokens
  where token_hash = encode(digest(target_token, 'sha256'), 'hex')
    and revoked_at is null
    and expires_at > now();
  if not found then raise exception 'Candidate link is invalid or expired'; end if;

  update public.job_applicants
  set
    preferred_name = nullif(trim(coalesce(profile->>'preferred_name', preferred_name)), ''),
    phone = nullif(trim(coalesce(profile->>'phone', phone)), ''),
    alternate_phone = nullif(trim(coalesce(profile->>'alternate_phone', alternate_phone)), ''),
    address_street = nullif(trim(coalesce(profile->>'address_street', address_street)), ''),
    address_line2 = nullif(trim(coalesce(profile->>'address_line2', address_line2)), ''),
    address_city = nullif(trim(coalesce(profile->>'address_city', address_city)), ''),
    address_state = nullif(trim(coalesce(profile->>'address_state', address_state)), ''),
    address_zip = nullif(trim(coalesce(profile->>'address_zip', address_zip)), ''),
    employment_type = coalesce(nullif(profile->>'employment_type', ''), employment_type),
    available_start_date = coalesce(nullif(profile->>'available_start_date', '')::date, available_start_date),
    desired_weekly_hours = coalesce(nullif(profile->>'desired_weekly_hours', '')::numeric, desired_weekly_hours),
    min_weekly_hours = coalesce(nullif(profile->>'min_weekly_hours', '')::numeric, min_weekly_hours),
    max_weekly_hours = coalesce(nullif(profile->>'max_weekly_hours', '')::numeric, max_weekly_hours),
    min_shift_hours = coalesce(nullif(profile->>'min_shift_hours', '')::numeric, min_shift_hours),
    max_shift_hours = coalesce(nullif(profile->>'max_shift_hours', '')::numeric, max_shift_hours),
    max_travel_minutes = coalesce(nullif(profile->>'max_travel_minutes', '')::integer, max_travel_minutes),
    transportation_method = nullif(trim(coalesce(profile->>'transportation_method', transportation_method)), ''),
    reliable_transportation = case when profile ? 'reliable_transportation' then (profile->>'reliable_transportation')::boolean else reliable_transportation end,
    willing_to_transport_clients = case when profile ? 'willing_to_transport_clients' then (profile->>'willing_to_transport_clients')::boolean else willing_to_transport_clients end,
    valid_drivers_license = case when profile ? 'valid_drivers_license' then (profile->>'valid_drivers_license')::boolean else valid_drivers_license end,
    vehicle_available = case when profile ? 'vehicle_available' then (profile->>'vehicle_available')::boolean else vehicle_available end,
    auto_insurance = case when profile ? 'auto_insurance' then (profile->>'auto_insurance')::boolean else auto_insurance end,
    languages = case when jsonb_typeof(profile->'languages') = 'array' then array(select jsonb_array_elements_text(profile->'languages')) else languages end,
    portal_completed_at = now()
  where id = token_row.applicant_id and organization_id = token_row.organization_id;
end;
$$;

revoke all on function public.save_candidate_portal_profile(text, jsonb) from public;
grant execute on function public.save_candidate_portal_profile(text, jsonb) to anon, authenticated;

create or replace function public.replace_candidate_portal_availability(
  target_token text,
  availability_rows jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  token_row public.candidate_portal_tokens;
  item jsonb;
begin
  select * into token_row
  from public.candidate_portal_tokens
  where token_hash = encode(digest(target_token, 'sha256'), 'hex')
    and revoked_at is null
    and expires_at > now();
  if not found then raise exception 'Candidate link is invalid or expired'; end if;

  delete from public.job_applicant_availability where applicant_id = token_row.applicant_id;

  for item in select value from jsonb_array_elements(coalesce(availability_rows, '[]'::jsonb)) loop
    if (item->>'start_time')::time >= (item->>'end_time')::time then
      raise exception 'Availability end time must be after start time';
    end if;
    insert into public.job_applicant_availability (
      organization_id, applicant_id, day_of_week, start_time, end_time, preference
    ) values (
      token_row.organization_id,
      token_row.applicant_id,
      (item->>'day_of_week')::public.weekday,
      (item->>'start_time')::time,
      (item->>'end_time')::time,
      coalesce((item->>'preference')::public.availability_preference, 'available'::public.availability_preference)
    );
  end loop;
end;
$$;

revoke all on function public.replace_candidate_portal_availability(text, jsonb) from public;
grant execute on function public.replace_candidate_portal_availability(text, jsonb) to anon, authenticated;

create or replace function public.replace_candidate_portal_credentials(
  target_token text,
  credential_rows jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  token_row public.candidate_portal_tokens;
  item jsonb;
begin
  select * into token_row
  from public.candidate_portal_tokens
  where token_hash = encode(digest(target_token, 'sha256'), 'hex')
    and revoked_at is null
    and expires_at > now();
  if not found then raise exception 'Candidate link is invalid or expired'; end if;

  delete from public.candidate_credentials
  where applicant_id = token_row.applicant_id and verification_status <> 'verified';

  for item in select value from jsonb_array_elements(coalesce(credential_rows, '[]'::jsonb)) loop
    if trim(coalesce(item->>'credential_type', '')) <> '' then
      insert into public.candidate_credentials (
        organization_id, applicant_id, credential_type, issue_date, expiration_date,
        does_not_expire, issuing_organization, credential_number, submission_status, verification_status, notes
      ) values (
        token_row.organization_id,
        token_row.applicant_id,
        trim(item->>'credential_type'),
        nullif(item->>'issue_date', '')::date,
        case when coalesce((item->>'does_not_expire')::boolean, false) then null else nullif(item->>'expiration_date', '')::date end,
        coalesce((item->>'does_not_expire')::boolean, false),
        nullif(trim(coalesce(item->>'issuing_organization', '')), ''),
        nullif(trim(coalesce(item->>'credential_number', '')), ''),
        'self_reported',
        'unverified',
        nullif(trim(coalesce(item->>'notes', '')), '')
      );
    end if;
  end loop;
end;
$$;

revoke all on function public.replace_candidate_portal_credentials(text, jsonb) from public;
grant execute on function public.replace_candidate_portal_credentials(text, jsonb) to anon, authenticated;

create or replace function public.upsert_candidate_onboarding(
  target_organization_id uuid,
  target_applicant_id uuid,
  onboarding_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'applicants.update') then
    raise exception 'You do not have permission to update onboarding for this organization';
  end if;

  insert into public.candidate_onboarding (
    organization_id, applicant_id, status, scheduled_at, method, location,
    instructions, notes, background_check_status, compliance_status,
    completed_at, created_by, updated_by
  ) values (
    target_organization_id,
    target_applicant_id,
    coalesce(nullif(onboarding_payload->>'status', ''), 'not_scheduled'),
    nullif(onboarding_payload->>'scheduled_at', '')::timestamptz,
    nullif(trim(coalesce(onboarding_payload->>'method', '')), ''),
    nullif(trim(coalesce(onboarding_payload->>'location', '')), ''),
    nullif(trim(coalesce(onboarding_payload->>'instructions', '')), ''),
    nullif(trim(coalesce(onboarding_payload->>'notes', '')), ''),
    coalesce(nullif(onboarding_payload->>'background_check_status', ''), 'not_started'),
    coalesce(nullif(onboarding_payload->>'compliance_status', ''), 'pending'),
    nullif(onboarding_payload->>'completed_at', '')::timestamptz,
    auth.uid(),
    auth.uid()
  )
  on conflict (applicant_id) do update set
    status = excluded.status,
    scheduled_at = excluded.scheduled_at,
    method = excluded.method,
    location = excluded.location,
    instructions = excluded.instructions,
    notes = excluded.notes,
    background_check_status = excluded.background_check_status,
    compliance_status = excluded.compliance_status,
    completed_at = excluded.completed_at,
    updated_by = auth.uid();
end;
$$;

revoke all on function public.upsert_candidate_onboarding(uuid, uuid, jsonb) from public;
grant execute on function public.upsert_candidate_onboarding(uuid, uuid, jsonb) to authenticated;

-- One administrative transfer creates a workforce record without requiring an
-- Ogevia login. No employment decision is made by this function; authorized
-- staff call it only after their own decision/process.
create or replace function public.transfer_candidate_to_care_team(
  target_organization_id uuid,
  target_applicant_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.job_applicants;
  record_id uuid;
begin
  if not public.has_permission(target_organization_id, 'applicants.update')
     or not public.has_permission(target_organization_id, 'membership.update') then
    raise exception 'You do not have permission to transfer candidates for this organization';
  end if;

  select * into a from public.job_applicants
  where id = target_applicant_id and organization_id = target_organization_id;
  if not found then raise exception 'Candidate not found'; end if;

  select id into record_id from public.caregiver_records
  where organization_id = target_organization_id and applicant_id = target_applicant_id and deleted_at is null;

  if record_id is null then
    insert into public.caregiver_records (
      organization_id, applicant_id, first_name, middle_name, last_name, preferred_name,
      email, phone, alternate_phone, address_street, address_line2, address_city,
      address_state, address_zip, address_country, employment_type, available_start_date,
      desired_weekly_hours, min_weekly_hours, max_weekly_hours, min_shift_hours,
      max_shift_hours, max_travel_minutes, transportation_method, reliable_transportation,
      willing_to_transport_clients, valid_drivers_license, vehicle_available, auto_insurance,
      languages, status
    ) values (
      target_organization_id, a.id, a.first_name, a.middle_name, a.last_name, a.preferred_name,
      a.email, a.phone, a.alternate_phone, a.address_street, a.address_line2, a.address_city,
      a.address_state, a.address_zip, a.address_country, a.employment_type::text, a.available_start_date,
      a.desired_weekly_hours, a.min_weekly_hours, a.max_weekly_hours, a.min_shift_hours,
      a.max_shift_hours, a.max_travel_minutes, a.transportation_method, a.reliable_transportation,
      a.willing_to_transport_clients, a.valid_drivers_license, a.vehicle_available, a.auto_insurance,
      a.languages, 'onboarding'
    ) returning id into record_id;
  end if;

  delete from public.caregiver_record_availability where caregiver_record_id = record_id;
  insert into public.caregiver_record_availability (
    organization_id, caregiver_record_id, day_of_week, start_time, end_time, preference
  )
  select target_organization_id, record_id, day_of_week, start_time, end_time, preference
  from public.job_applicant_availability where applicant_id = target_applicant_id;

  delete from public.caregiver_record_credentials where caregiver_record_id = record_id;
  insert into public.caregiver_record_credentials (
    organization_id, caregiver_record_id, source_candidate_credential_id, credential_type,
    issue_date, expiration_date, does_not_expire, issuing_organization, credential_number,
    verification_status, verified_by, verified_at, notes
  )
  select
    target_organization_id, record_id, id, credential_type, issue_date, expiration_date,
    does_not_expire, issuing_organization, credential_number, verification_status,
    verified_by, verified_at, notes
  from public.candidate_credentials
  where applicant_id = target_applicant_id and deleted_at is null;

  perform public.set_candidate_stage(target_organization_id, target_applicant_id, 'care_team', 'Transferred to Care Team');
  return record_id;
end;
$$;

revoke all on function public.transfer_candidate_to_care_team(uuid, uuid) from public;
grant execute on function public.transfer_candidate_to_care_team(uuid, uuid) to authenticated;

create or replace function public.link_caregiver_record_to_user(
  target_organization_id uuid,
  target_caregiver_record_id uuid,
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'membership.update') then
    raise exception 'You do not have permission to link Care Team accounts for this organization';
  end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id = target_organization_id and user_id = target_user_id and status = 'active'
  ) then
    raise exception 'The selected user must be an active organization member';
  end if;

  update public.caregiver_records
  set linked_user_id = target_user_id
  where id = target_caregiver_record_id and organization_id = target_organization_id and deleted_at is null;

  delete from public.caregiver_availability
  where organization_id = target_organization_id and caregiver_user_id = target_user_id;

  insert into public.caregiver_availability (
    organization_id, caregiver_user_id, day_of_week, start_time, end_time
  )
  select target_organization_id, target_user_id, day_of_week, start_time, end_time
  from public.caregiver_record_availability
  where caregiver_record_id = target_caregiver_record_id;

  update public.organization_memberships om
  set target_hours_per_week = cr.desired_weekly_hours
  from public.caregiver_records cr
  where cr.id = target_caregiver_record_id
    and om.organization_id = target_organization_id
    and om.user_id = target_user_id;
end;
$$;

revoke all on function public.link_caregiver_record_to_user(uuid, uuid, uuid) from public;
grant execute on function public.link_caregiver_record_to_user(uuid, uuid, uuid) to authenticated;

create or replace function public.list_candidates_v1(target_organization_id uuid)
returns table (
  id uuid,
  first_name text,
  last_name text,
  email citext,
  phone text,
  pipeline_stage text,
  source text,
  position_applied_for text,
  applied_at timestamptz,
  desired_weekly_hours numeric,
  available_start_date date,
  imported_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id, a.first_name, a.last_name, a.email, a.phone, a.pipeline_stage, a.source,
    a.position_applied_for, coalesce(a.applied_at, a.created_at), a.desired_weekly_hours,
    a.available_start_date, a.imported_at, a.created_at
  from public.job_applicants a
  where a.organization_id = target_organization_id
    and public.has_permission(target_organization_id, 'applicants.read')
  order by coalesce(a.applied_at, a.created_at) desc;
$$;

revoke all on function public.list_candidates_v1(uuid) from public;
grant execute on function public.list_candidates_v1(uuid) to authenticated;

create or replace function public.list_care_team_records(target_organization_id uuid)
returns table (
  id uuid,
  linked_user_id uuid,
  applicant_id uuid,
  display_name text,
  email citext,
  phone text,
  status text,
  desired_weekly_hours numeric,
  available_start_date date,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    cr.id,
    cr.linked_user_id,
    cr.applicant_id,
    concat_ws(' ', coalesce(cr.preferred_name, cr.first_name), cr.last_name),
    cr.email,
    cr.phone,
    cr.status,
    cr.desired_weekly_hours,
    cr.available_start_date,
    cr.created_at
  from public.caregiver_records cr
  where cr.organization_id = target_organization_id
    and cr.deleted_at is null
    and public.has_permission(target_organization_id, 'membership.read')
  order by cr.last_name, cr.first_name;
$$;

revoke all on function public.list_care_team_records(uuid) from public;
grant execute on function public.list_care_team_records(uuid) to authenticated;

commit;
