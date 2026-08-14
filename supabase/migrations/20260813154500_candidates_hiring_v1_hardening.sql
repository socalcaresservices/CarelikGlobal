begin;

-- Candidate Hiring V1 hardening and organization configuration.
-- These tables configure administrative requirements only. They do not score,
-- rank, recommend, select, or reject candidates.

create table if not exists public.credential_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  name text not null,
  category text,
  requires_expiration boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists credential_types_org_name_unique
  on public.credential_types (organization_id, lower(name))
  where organization_id is not null and deleted_at is null;

create index if not exists credential_types_org_idx
  on public.credential_types (organization_id) where deleted_at is null;

alter table public.credential_types enable row level security;

drop policy if exists "read_credential_types" on public.credential_types;
create policy "read_credential_types"
on public.credential_types for select
to authenticated
using (
  deleted_at is null
  and (
    organization_id is null
    or public.has_permission(organization_id, 'credentials.read')
    or public.has_permission(organization_id, 'applicants.read')
  )
);

drop policy if exists "manage_credential_types" on public.credential_types;
create policy "manage_credential_types"
on public.credential_types for all
to authenticated
using (
  organization_id is not null
  and (
    public.has_permission(organization_id, 'credentials.update')
    or public.has_permission(organization_id, 'settings.update')
  )
)
with check (
  organization_id is not null
  and (
    public.has_permission(organization_id, 'credentials.update')
    or public.has_permission(organization_id, 'settings.update')
  )
);

create trigger credential_types_set_updated_at
before update on public.credential_types
for each row execute function public.set_updated_at();

create trigger credential_types_audit
after insert or update or delete on public.credential_types
for each row execute function public.write_audit_log();

insert into public.credential_types (organization_id, name, category, requires_expiration)
select null, seed.name, seed.category, seed.requires_expiration
from (values
  ('CPR Certification', 'Clinical & Safety', true),
  ('First Aid', 'Clinical & Safety', true),
  ('BLS', 'Clinical & Safety', true),
  ('TB Clearance', 'Health Clearance', true),
  ('Background Check', 'Screening', false),
  ('Live Scan', 'Screening', false),
  ('DOJ Clearance', 'Screening', false),
  ('FBI Clearance', 'Screening', false),
  ('Driver License', 'Transportation', true),
  ('Auto Insurance', 'Transportation', true),
  ('Vehicle Registration', 'Transportation', true),
  ('Physical / Health Screening', 'Health Clearance', true),
  ('Hepatitis Documentation', 'Health Clearance', true),
  ('Other', 'Other', false)
) as seed(name, category, requires_expiration)
where not exists (
  select 1 from public.credential_types existing
  where existing.organization_id is null
    and lower(existing.name) = lower(seed.name)
    and existing.deleted_at is null
);

create table if not exists public.organization_credential_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  credential_type_id uuid not null references public.credential_types(id),
  applies_to text not null default 'care_team',
  is_required boolean not null default true,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_credential_requirements_applies_to_check
    check (applies_to in ('candidate', 'care_team', 'both')),
  unique (organization_id, credential_type_id, applies_to)
);

alter table public.organization_credential_requirements enable row level security;

drop policy if exists "read_credential_requirements" on public.organization_credential_requirements;
create policy "read_credential_requirements"
on public.organization_credential_requirements for select
to authenticated
using (
  public.has_permission(organization_id, 'credentials.read')
  or public.has_permission(organization_id, 'applicants.read')
  or public.has_permission(organization_id, 'settings.read')
);

drop policy if exists "manage_credential_requirements" on public.organization_credential_requirements;
create policy "manage_credential_requirements"
on public.organization_credential_requirements for all
to authenticated
using (
  public.has_permission(organization_id, 'credentials.update')
  or public.has_permission(organization_id, 'settings.update')
)
with check (
  public.has_permission(organization_id, 'credentials.update')
  or public.has_permission(organization_id, 'settings.update')
);

create trigger organization_credential_requirements_set_updated_at
before update on public.organization_credential_requirements
for each row execute function public.set_updated_at();

create trigger organization_credential_requirements_audit
after insert or update or delete on public.organization_credential_requirements
for each row execute function public.write_audit_log();

-- Stable internal stage keys with optional organization-specific labels/order.
-- Organizations can customize how the pipeline reads without changing the
-- audit meaning of the underlying stage key.
create table if not exists public.organization_candidate_stage_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  stage_key text not null,
  display_label text not null,
  sort_order integer not null,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, stage_key),
  constraint organization_candidate_stage_settings_key_check check (
    stage_key in (
      'imported','application_needed','application_received','screening','interview','conditional_offer',
      'hired_onboarding_required','onboarding_scheduled','onboarding','compliance_pending','ready_to_work',
      'care_team','on_hold','rejected','withdrawn'
    )
  )
);

alter table public.organization_candidate_stage_settings enable row level security;

drop policy if exists "read_candidate_stage_settings" on public.organization_candidate_stage_settings;
create policy "read_candidate_stage_settings"
on public.organization_candidate_stage_settings for select
to authenticated
using (public.has_permission(organization_id, 'applicants.read'));

drop policy if exists "manage_candidate_stage_settings" on public.organization_candidate_stage_settings;
create policy "manage_candidate_stage_settings"
on public.organization_candidate_stage_settings for all
to authenticated
using (
  public.has_permission(organization_id, 'applicants.update')
  or public.has_permission(organization_id, 'settings.update')
)
with check (
  public.has_permission(organization_id, 'applicants.update')
  or public.has_permission(organization_id, 'settings.update')
);

create trigger organization_candidate_stage_settings_set_updated_at
before update on public.organization_candidate_stage_settings
for each row execute function public.set_updated_at();

create trigger organization_candidate_stage_settings_audit
after insert or update or delete on public.organization_candidate_stage_settings
for each row execute function public.write_audit_log();

create or replace function public.list_candidate_pipeline_stages(target_organization_id uuid)
returns table (stage_key text, display_label text, sort_order integer, is_active boolean)
language sql
stable
security definer
set search_path = public
as $$
  with defaults(stage_key, display_label, sort_order) as (
    values
      ('imported', 'Imported', 10),
      ('application_needed', 'Application Needed', 20),
      ('application_received', 'Application Received', 30),
      ('screening', 'Screening', 40),
      ('interview', 'Interview', 50),
      ('conditional_offer', 'Conditional Offer', 60),
      ('hired_onboarding_required', 'Hired / Onboarding Required', 70),
      ('onboarding_scheduled', 'Onboarding Scheduled', 80),
      ('onboarding', 'Onboarding', 90),
      ('compliance_pending', 'Compliance Pending', 100),
      ('ready_to_work', 'Ready to Work', 110),
      ('care_team', 'Care Team', 120),
      ('on_hold', 'On Hold', 130),
      ('rejected', 'Rejected', 140),
      ('withdrawn', 'Withdrawn', 150)
  )
  select
    d.stage_key,
    coalesce(s.display_label, d.display_label),
    coalesce(s.sort_order, d.sort_order),
    coalesce(s.is_active, true)
  from defaults d
  left join public.organization_candidate_stage_settings s
    on s.organization_id = target_organization_id and s.stage_key = d.stage_key
  where public.has_permission(target_organization_id, 'applicants.read')
  order by coalesce(s.sort_order, d.sort_order);
$$;

revoke all on function public.list_candidate_pipeline_stages(uuid) from public;
grant execute on function public.list_candidate_pipeline_stages(uuid) to authenticated;

create or replace function public.list_organization_credential_types(
  target_organization_id uuid,
  target_applies_to text default 'both'
)
returns table (
  credential_type_id uuid,
  name text,
  category text,
  requires_expiration boolean,
  is_required boolean,
  is_active boolean,
  source text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    ct.id,
    ct.name,
    ct.category,
    ct.requires_expiration,
    coalesce(req.is_required, false),
    coalesce(req.is_active, ct.is_active),
    case when ct.organization_id is null then 'platform' else 'organization' end
  from public.credential_types ct
  left join public.organization_credential_requirements req
    on req.organization_id = target_organization_id
   and req.credential_type_id = ct.id
   and (
     req.applies_to = target_applies_to
     or req.applies_to = 'both'
     or target_applies_to = 'both'
   )
  where ct.deleted_at is null
    and (ct.organization_id is null or ct.organization_id = target_organization_id)
    and (
      public.has_permission(target_organization_id, 'credentials.read')
      or public.has_permission(target_organization_id, 'applicants.read')
      or public.has_permission(target_organization_id, 'settings.read')
    )
  order by coalesce(ct.category, 'Other'), ct.name;
$$;

revoke all on function public.list_organization_credential_types(uuid, text) from public;
grant execute on function public.list_organization_credential_types(uuid, text) to authenticated;

-- Public candidate portal can see only the organization's active requirements.
create or replace function public.get_candidate_portal_requirements(target_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  token_row public.candidate_portal_tokens;
  result jsonb;
begin
  select * into token_row
  from public.candidate_portal_tokens
  where token_hash = encode(extensions.digest(target_token, 'sha256'), 'hex')
    and revoked_at is null
    and expires_at > now();

  if not found then raise exception 'Candidate link is invalid or expired'; end if;

  if exists (
    select 1 from public.job_applicants a
    where a.id = token_row.applicant_id
      and a.pipeline_stage in ('care_team', 'rejected', 'withdrawn')
  ) then
    raise exception 'Candidate link is no longer active';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ct.id,
    'name', ct.name,
    'category', ct.category,
    'requires_expiration', ct.requires_expiration,
    'is_required', req.is_required
  ) order by coalesce(ct.category, 'Other'), ct.name), '[]'::jsonb)
  into result
  from public.organization_credential_requirements req
  join public.credential_types ct on ct.id = req.credential_type_id
  where req.organization_id = token_row.organization_id
    and req.is_active
    and req.is_required
    and req.applies_to in ('candidate', 'both')
    and ct.is_active
    and ct.deleted_at is null;

  return result;
end;
$$;

revoke all on function public.get_candidate_portal_requirements(text) from public;
grant execute on function public.get_candidate_portal_requirements(text) to anon, authenticated;

-- Candidate portal writes are disabled after the record reaches Care Team or a
-- terminal non-hire stage. This prevents an old still-unexpired link from
-- silently changing a completed workforce record.
create or replace function public.assert_candidate_portal_writable(target_token text)
returns public.candidate_portal_tokens
language plpgsql
security definer
set search_path = public
as $$
declare
  token_row public.candidate_portal_tokens;
  current_stage text;
begin
  select * into token_row
  from public.candidate_portal_tokens
  where token_hash = encode(extensions.digest(target_token, 'sha256'), 'hex')
    and revoked_at is null
    and expires_at > now();

  if not found then raise exception 'Candidate link is invalid or expired'; end if;

  select pipeline_stage into current_stage
  from public.job_applicants
  where id = token_row.applicant_id and organization_id = token_row.organization_id;

  if current_stage in ('care_team', 'rejected', 'withdrawn') then
    raise exception 'Candidate link is no longer active';
  end if;

  return token_row;
end;
$$;

revoke all on function public.assert_candidate_portal_writable(text) from public;
grant execute on function public.assert_candidate_portal_writable(text) to anon, authenticated;

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
  token_row := public.assert_candidate_portal_writable(target_token);

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
    employment_type = coalesce(nullif(profile->>'employment_type', ''), employment_type::text)::public.employment_type,
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
  token_row := public.assert_candidate_portal_writable(target_token);
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
  item_type text;
  item_number text;
begin
  token_row := public.assert_candidate_portal_writable(target_token);

  -- Candidate-owned, unverified rows can be replaced. Staff-verified rows are
  -- immutable from the public portal and remain in place.
  delete from public.candidate_credentials
  where applicant_id = token_row.applicant_id
    and verification_status <> 'verified';

  for item in select value from jsonb_array_elements(coalesce(credential_rows, '[]'::jsonb)) loop
    item_type := trim(coalesce(item->>'credential_type', ''));
    item_number := nullif(trim(coalesce(item->>'credential_number', '')), '');

    if item_type <> '' and not exists (
      select 1 from public.candidate_credentials verified
      where verified.applicant_id = token_row.applicant_id
        and verified.deleted_at is null
        and verified.verification_status = 'verified'
        and lower(verified.credential_type) = lower(item_type)
        and coalesce(verified.credential_number, '') = coalesce(item_number, '')
    ) then
      insert into public.candidate_credentials (
        organization_id, applicant_id, credential_type, issue_date, expiration_date,
        does_not_expire, issuing_organization, credential_number, submission_status,
        verification_status, notes
      ) values (
        token_row.organization_id,
        token_row.applicant_id,
        item_type,
        nullif(item->>'issue_date', '')::date,
        case when coalesce((item->>'does_not_expire')::boolean, false)
          then null else nullif(item->>'expiration_date', '')::date end,
        coalesce((item->>'does_not_expire')::boolean, false),
        nullif(trim(coalesce(item->>'issuing_organization', '')), ''),
        item_number,
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

-- Revoke outstanding self-service tokens as soon as the administrative
-- transfer is completed, so the candidate record and Care Team record cannot
-- diverge afterward.
create or replace function public.revoke_candidate_portal_links_for_applicant(
  target_organization_id uuid,
  target_applicant_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.candidate_portal_tokens
  set revoked_at = coalesce(revoked_at, now())
  where organization_id = target_organization_id
    and applicant_id = target_applicant_id
    and revoked_at is null;
$$;

revoke all on function public.revoke_candidate_portal_links_for_applicant(uuid, uuid) from public;
grant execute on function public.revoke_candidate_portal_links_for_applicant(uuid, uuid) to authenticated;

-- Wrap the existing transfer function to revoke portal links after a successful
-- transfer while preserving the original function's explicit staff action.
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
  where organization_id = target_organization_id
    and applicant_id = target_applicant_id
    and deleted_at is null;

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

  perform public.set_candidate_stage(
    target_organization_id,
    target_applicant_id,
    'care_team',
    'Transferred to Care Team'
  );

  perform public.revoke_candidate_portal_links_for_applicant(
    target_organization_id,
    target_applicant_id
  );

  return record_id;
end;
$$;

revoke all on function public.transfer_candidate_to_care_team(uuid, uuid) from public;
grant execute on function public.transfer_candidate_to_care_team(uuid, uuid) to authenticated;

commit;
