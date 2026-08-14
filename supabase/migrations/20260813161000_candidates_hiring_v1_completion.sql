begin;

-- Remaining Candidate/Hiring V1 integration: manual staff intake, portal
-- document discovery, and onboarding continuity on the independent workforce
-- record. Production data is not seeded by this migration.

alter table public.caregiver_records
  add column if not exists onboarding_status text,
  add column if not exists onboarding_scheduled_at timestamptz,
  add column if not exists onboarding_method text,
  add column if not exists onboarding_location text,
  add column if not exists onboarding_instructions text,
  add column if not exists onboarding_notes text,
  add column if not exists background_check_status text,
  add column if not exists compliance_status text,
  add column if not exists onboarding_completed_at timestamptz;

create or replace function public.create_manual_candidate(
  target_organization_id uuid,
  candidate_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_id uuid;
  candidate_email citext := nullif(trim(candidate_payload->>'email'), '')::citext;
begin
  if not public.has_permission(target_organization_id, 'applicants.update') then
    raise exception 'You do not have permission to create candidates for this organization';
  end if;
  if nullif(trim(candidate_payload->>'first_name'), '') is null
     or nullif(trim(candidate_payload->>'last_name'), '') is null
     or candidate_email is null then
    raise exception 'First name, last name, and email are required';
  end if;
  if exists (
    select 1 from public.job_applicants
    where organization_id = target_organization_id
      and lower(email::text) = lower(candidate_email::text)
  ) then
    raise exception 'A candidate with this email already exists';
  end if;

  insert into public.job_applicants (
    organization_id, first_name, last_name, email, phone, pipeline_stage,
    source, position_applied_for, applied_at, imported_at, notes
  ) values (
    target_organization_id,
    trim(candidate_payload->>'first_name'),
    trim(candidate_payload->>'last_name'),
    candidate_email,
    nullif(trim(candidate_payload->>'phone'), ''),
    'application_received',
    'manual',
    nullif(trim(candidate_payload->>'position_applied_for'), ''),
    coalesce(nullif(candidate_payload->>'applied_at', '')::timestamptz, now()),
    now(),
    nullif(trim(candidate_payload->>'notes'), '')
  ) returning id into candidate_id;

  return candidate_id;
end;
$$;

revoke all on function public.create_manual_candidate(uuid, jsonb) from public;
grant execute on function public.create_manual_candidate(uuid, jsonb) to authenticated;

create or replace function public.list_candidate_portal_document_batches(target_token text)
returns table (
  batch_id uuid,
  upload_token text,
  created_at timestamptz,
  expires_at timestamptz,
  pending_count bigint,
  uploaded_count bigint,
  completed_count bigint
)
language plpgsql
stable
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
  if not found then return; end if;

  return query
  select b.id, b.token, b.created_at, b.expires_at,
    count(*) filter (where dr.status in ('requested', 'rejected')),
    count(*) filter (where dr.status in ('uploaded', 'pending_review')),
    count(*) filter (where dr.status = 'verified')
  from public.document_request_batches b
  join public.document_requests dr on dr.batch_id = b.id
  where b.organization_id = token_row.organization_id
    and b.subject_type = 'applicant'
    and b.subject_id = token_row.applicant_id
    and b.deleted_at is null
    and (b.expires_at is null or b.expires_at > now())
  group by b.id, b.token, b.created_at, b.expires_at
  order by b.created_at desc;
end;
$$;

revoke all on function public.list_candidate_portal_document_batches(text) from public;
grant execute on function public.list_candidate_portal_document_batches(text) to anon, authenticated;

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
  o public.candidate_onboarding;
  record_id uuid;
begin
  if not public.has_permission(target_organization_id, 'applicants.update')
     or not public.has_permission(target_organization_id, 'membership.update') then
    raise exception 'You do not have permission to transfer candidates for this organization';
  end if;
  select * into a from public.job_applicants
    where id = target_applicant_id and organization_id = target_organization_id;
  if not found then raise exception 'Candidate not found'; end if;
  select * into o from public.candidate_onboarding
    where applicant_id = target_applicant_id and organization_id = target_organization_id;

  insert into public.caregiver_records (
    organization_id, applicant_id, first_name, middle_name, last_name, preferred_name,
    email, phone, alternate_phone, address_street, address_line2, address_city,
    address_state, address_zip, address_country, employment_type, available_start_date,
    desired_weekly_hours, min_weekly_hours, max_weekly_hours, min_shift_hours,
    max_shift_hours, max_travel_minutes, transportation_method, reliable_transportation,
    willing_to_transport_clients, valid_drivers_license, vehicle_available, auto_insurance,
    languages, status, onboarding_status, onboarding_scheduled_at, onboarding_method,
    onboarding_location, onboarding_instructions, onboarding_notes,
    background_check_status, compliance_status, onboarding_completed_at
  ) values (
    target_organization_id, a.id, a.first_name, a.middle_name, a.last_name, a.preferred_name,
    a.email, a.phone, a.alternate_phone, a.address_street, a.address_line2, a.address_city,
    a.address_state, a.address_zip, a.address_country, a.employment_type::text, a.available_start_date,
    a.desired_weekly_hours, a.min_weekly_hours, a.max_weekly_hours, a.min_shift_hours,
    a.max_shift_hours, a.max_travel_minutes, a.transportation_method, a.reliable_transportation,
    a.willing_to_transport_clients, a.valid_drivers_license, a.vehicle_available, a.auto_insurance,
    a.languages, 'onboarding', o.status, o.scheduled_at, o.method, o.location,
    o.instructions, o.notes, o.background_check_status, o.compliance_status, o.completed_at
  )
  on conflict (organization_id, applicant_id) where applicant_id is not null and deleted_at is null
  do update set
    first_name = excluded.first_name, last_name = excluded.last_name,
    preferred_name = excluded.preferred_name, email = excluded.email, phone = excluded.phone,
    onboarding_status = excluded.onboarding_status,
    onboarding_scheduled_at = excluded.onboarding_scheduled_at,
    onboarding_method = excluded.onboarding_method,
    onboarding_location = excluded.onboarding_location,
    onboarding_instructions = excluded.onboarding_instructions,
    onboarding_notes = excluded.onboarding_notes,
    background_check_status = excluded.background_check_status,
    compliance_status = excluded.compliance_status,
    onboarding_completed_at = excluded.onboarding_completed_at
  returning id into record_id;

  delete from public.caregiver_record_availability where caregiver_record_id = record_id;
  insert into public.caregiver_record_availability
    (organization_id, caregiver_record_id, day_of_week, start_time, end_time, preference)
  select target_organization_id, record_id, day_of_week, start_time, end_time, preference
  from public.job_applicant_availability where applicant_id = target_applicant_id;

  delete from public.caregiver_record_credentials where caregiver_record_id = record_id;
  insert into public.caregiver_record_credentials (
    organization_id, caregiver_record_id, source_candidate_credential_id, credential_type,
    issue_date, expiration_date, does_not_expire, issuing_organization, credential_number,
    verification_status, verified_by, verified_at, notes
  ) select target_organization_id, record_id, id, credential_type, issue_date,
    expiration_date, does_not_expire, issuing_organization, credential_number,
    verification_status, verified_by, verified_at, notes
  from public.candidate_credentials
  where applicant_id = target_applicant_id and deleted_at is null;

  perform public.set_candidate_stage(target_organization_id, target_applicant_id, 'care_team', 'Transferred to Care Team');
  perform public.revoke_candidate_portal_links_for_applicant(target_organization_id, target_applicant_id);
  return record_id;
end;
$$;

revoke all on function public.transfer_candidate_to_care_team(uuid, uuid) from public;
grant execute on function public.transfer_candidate_to_care_team(uuid, uuid) to authenticated;

commit;
