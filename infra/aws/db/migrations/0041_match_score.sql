-- 0041 Explainable caregiver matching: structured experience, client support preferences,
-- approximate distance, the match score and the assignment decision record.
--
-- Product rule: ELIGIBILITY first, SCORE second. Eligibility is the readiness check of 0039/0040
-- (status, documents, service approval, availability, authorization, conflicts) plus any client
-- requirement an administrator marked mandatory. The score answers only how closely an eligible
-- caregiver fits the client's confirmed support needs. It is not a rating of care quality, a
-- clinical judgement, a certification or a guarantee, and it can never rescue a failed check.
--
-- Formula "match-v1" (a product hypothesis, not validated; every component and weight is shown):
--   score = round(100 x (0.50 A + 0.25 L + 0.25 E))
--   A availability fit = approved covered requested minutes / requested minutes (exceptions applied)
--   L location fit     = max(0, 1 - d / R), d = approximate ZIP-to-ZIP straight-line miles, R = the
--                        agency's reference radius (administrator-set, default 15 miles, a SCORING
--                        reference, not a travel boundary)
--   E experience fit   = weight of the client's confirmed optional tags that the caregiver holds as
--                        VERIFIED experience / weight of all those tags. Not applicable when the client
--                        has no optional tags.
-- A not-applicable component's weight is redistributed in proportion and the adjusted weights are
-- shown. An applicable component that is UNKNOWN (no location data; experience not reviewed) makes the
-- score "incomplete": no comparable total is published and unknown is never silently treated as zero.
-- Ties are ordered by: eligibility group, score, known approximate distance (nearest first), number of
-- verified matching tags, then caregiver code. Never random.
--
-- Experience is structured and agency-managed (tags), submitted by caregivers or administrators and
-- VERIFIED only by an administrator. "Not recorded" is not evidence of no experience: a missing tag
-- counts as zero only once an administrator has marked the caregiver's experience reviewed.
-- Experience is separate from certification and from approved services; ABA-related experience, where
-- an agency adds such a tag, is an optional preference only and never proof of clinical competence or
-- authority to deliver ABA treatment. Diagnosis is never used; only administrator-confirmed support
-- needs are.
--
-- Location is a ZIP code only (never a street address), restricted to administrators, and shown to
-- schedulers only as "Approx. distance". The ZIP-to-coordinates reference table (zip_centroids) is
-- EMPTY here: loading it is a separate, reviewed step (dataset source, licence and vintage must be
-- confirmed). With no data the distance is "unknown" and the score "incomplete", never a guess.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
alter table ogevia.agency_readiness_settings
  add column match_radius_miles numeric(6, 1) not null default 15 check (match_radius_miles > 0 and match_radius_miles <= 500),
  add column match_location_enabled boolean not null default true;

create function ogevia.match_settings(p_organization_id uuid)
returns table (match_radius_miles numeric, match_location_enabled boolean)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(s.match_radius_miles, 15), coalesce(s.match_location_enabled, true)
  from (select 1) x left join ogevia.agency_readiness_settings s on s.organization_id = p_organization_id;
$$;

-- ---------------------------------------------------------------------------
-- Experience tags and entries
-- ---------------------------------------------------------------------------
create table ogevia.experience_tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  name text not null check (length(btrim(name)) between 2 and 80),
  is_active boolean not null default true,
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index experience_tags_org_name on ogevia.experience_tags (organization_id, lower(btrim(name)));

create table ogevia.caregiver_experience (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  tag_id uuid not null,
  context text check (context is null or length(btrim(context)) between 1 and 300),
  source text not null check (source in ('caregiver', 'administrator')),
  submitted_by uuid not null references ogevia.app_users(id),
  submitted_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'verified', 'declined', 'removed')),
  reviewed_by uuid references ogevia.app_users(id),
  reviewed_at timestamptz,
  review_note text,
  unique (id, organization_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  foreign key (tag_id, organization_id) references ogevia.experience_tags (id, organization_id),
  constraint caregiver_experience_review_shape check ((status = 'pending') = (reviewed_by is null and reviewed_at is null)),
  constraint caregiver_experience_note check (status not in ('declined', 'removed') or length(btrim(coalesce(review_note, ''))) between 3 and 500)
);
create unique index caregiver_experience_one_active on ogevia.caregiver_experience (caregiver_record_id, tag_id) where status in ('pending', 'verified');
create index caregiver_experience_lookup on ogevia.caregiver_experience (organization_id, caregiver_record_id, status);

create function ogevia.caregiver_experience_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.status in ('declined', 'removed') then
    raise exception 'This experience entry is closed; submit a new one' using errcode = 'OGC09';
  end if;
  if (to_jsonb(new) - array['status', 'reviewed_by', 'reviewed_at', 'review_note'])
     is distinct from (to_jsonb(old) - array['status', 'reviewed_by', 'reviewed_at', 'review_note']) then
    raise exception 'Experience entries cannot be edited; submit a new one' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
create trigger caregiver_experience_guard before update on ogevia.caregiver_experience
for each row execute function ogevia.caregiver_experience_guard_update();
create trigger caregiver_experience_no_delete before delete on ogevia.caregiver_experience
for each row execute function ogevia.forbid_delete();

create table ogevia.caregiver_experience_reviews (
  caregiver_record_id uuid primary key,
  organization_id uuid not null references ogevia.organizations(id),
  reviewed_by uuid not null references ogevia.app_users(id),
  reviewed_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);

-- ---------------------------------------------------------------------------
-- Administrator-confirmed client support needs (optional preferences, or mandatory requirements)
-- ---------------------------------------------------------------------------
create table ogevia.client_support_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  tag_id uuid not null,
  weight smallint not null default 1 check (weight between 1 and 10),
  mandatory boolean not null default false,
  confirmed_by uuid not null references ogevia.app_users(id),
  confirmed_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references ogevia.app_users(id),
  unique (id, organization_id),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  foreign key (tag_id, organization_id) references ogevia.experience_tags (id, organization_id),
  constraint client_support_removed_shape check ((removed_at is null) = (removed_by is null))
);
create unique index client_support_one_active on ogevia.client_support_preferences (client_id, tag_id) where removed_at is null;

create function ogevia.client_support_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.removed_at is not null then
    raise exception 'This support need was already removed' using errcode = 'OGC09';
  end if;
  if (to_jsonb(new) - array['removed_at', 'removed_by']) is distinct from (to_jsonb(old) - array['removed_at', 'removed_by']) then
    raise exception 'Support needs cannot be edited; remove and confirm again' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
create trigger client_support_guard before update on ogevia.client_support_preferences
for each row execute function ogevia.client_support_guard_update();
create trigger client_support_no_delete before delete on ogevia.client_support_preferences
for each row execute function ogevia.forbid_delete();

-- ---------------------------------------------------------------------------
-- Location: ZIP only. The coordinates table is reference data and is EMPTY until a reviewed load.
-- ---------------------------------------------------------------------------
create table ogevia.zip_centroids (
  zip text primary key check (zip ~ '^[0-9]{5}$'),
  lat numeric(8, 5) not null check (lat between -90 and 90),
  lng numeric(8, 5) not null check (lng between -180 and 180),
  source text not null check (length(btrim(source)) > 0),
  vintage text not null check (length(btrim(vintage)) > 0),
  loaded_at timestamptz not null default now()
);
create table ogevia.client_locations (
  client_id uuid primary key,
  organization_id uuid not null references ogevia.organizations(id),
  zip text not null check (zip ~ '^[0-9]{5}$'),
  updated_by uuid not null references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id)
);
create table ogevia.caregiver_locations (
  caregiver_record_id uuid primary key,
  organization_id uuid not null references ogevia.organizations(id),
  zip text not null check (zip ~ '^[0-9]{5}$'),
  travel_limit_miles integer check (travel_limit_miles is null or travel_limit_miles between 1 and 500),
  updated_by uuid not null references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);

-- ---------------------------------------------------------------------------
-- The decision record: who chose whom, with the score and its inputs at that moment (ids and
-- numbers only; no names, addresses or ZIP codes).
-- ---------------------------------------------------------------------------
create table ogevia.assignment_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  decided_by uuid not null references ogevia.app_users(id),
  decided_at timestamptz not null default now(),
  caregiver_record_id uuid not null,
  client_id uuid not null,
  service_id uuid not null,
  context text not null check (context in ('shift', 'care_request', 'series')),
  reference_id uuid,
  score_version text not null,
  eligibility text not null,
  score integer check (score is null or score between 0 and 100),
  score_status text not null check (score_status in ('complete', 'incomplete')),
  components jsonb not null,
  approx_distance_miles numeric(6, 1),
  input_refs jsonb not null,
  rationale text check (rationale is null or length(btrim(rationale)) between 1 and 500),
  override_reason text check (override_reason is null or length(btrim(override_reason)) between 3 and 500),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id)
);
create index assignment_decisions_ref on ogevia.assignment_decisions (organization_id, reference_id);
create trigger assignment_decisions_no_update before update on ogevia.assignment_decisions for each row execute function ogevia.forbid_update();
create trigger assignment_decisions_no_delete before delete on ogevia.assignment_decisions for each row execute function ogevia.forbid_delete();

revoke all on table ogevia.experience_tags, ogevia.caregiver_experience, ogevia.caregiver_experience_reviews,
  ogevia.client_support_preferences, ogevia.zip_centroids, ogevia.client_locations, ogevia.caregiver_locations,
  ogevia.assignment_decisions from public, ogevia_app;
alter table ogevia.experience_tags enable row level security;
alter table ogevia.caregiver_experience enable row level security;
alter table ogevia.caregiver_experience_reviews enable row level security;
alter table ogevia.client_support_preferences enable row level security;
alter table ogevia.zip_centroids enable row level security;
alter table ogevia.client_locations enable row level security;
alter table ogevia.caregiver_locations enable row level security;
alter table ogevia.assignment_decisions enable row level security;
create policy readonly_select on ogevia.experience_tags for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.caregiver_experience for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.caregiver_experience_reviews for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.client_support_preferences for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.zip_centroids for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.client_locations for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.caregiver_locations for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.assignment_decisions for select to ogevia_readonly using (true);
grant select on ogevia.experience_tags, ogevia.caregiver_experience, ogevia.caregiver_experience_reviews,
  ogevia.client_support_preferences, ogevia.zip_centroids, ogevia.client_locations, ogevia.caregiver_locations,
  ogevia.assignment_decisions to ogevia_readonly;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
-- Approximate straight-line miles between two ZIP centroids. Null when either ZIP is unknown.
create function ogevia.approx_distance_miles(p_zip_a text, p_zip_b text)
returns numeric
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case when a.zip is null or b.zip is null then null
         else round((3958.8 * 2 * asin(least(1.0, sqrt(
                power(sin(radians((b.lat - a.lat)::float8) / 2), 2)
              + cos(radians(a.lat::float8)) * cos(radians(b.lat::float8)) * power(sin(radians((b.lng - a.lng)::float8) / 2), 2)))))::numeric, 2) end
  from (select 1) x
  left join ogevia.zip_centroids a on a.zip = p_zip_a
  left join ogevia.zip_centroids b on b.zip = p_zip_b;
$$;

-- Minutes of [p_starts, p_ends) covered by the caregiver's approved availability, with date exceptions removed.
create function ogevia.availability_covered_minutes(
  p_organization_id uuid, p_caregiver_record_id uuid, p_timezone text,
  p_starts timestamptz, p_ends timestamptz, p_first_date date, p_last_date date
)
returns numeric
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(sum(extract(epoch from (upper(r) - lower(r)))) / 60, 0)
  from unnest(
    (coalesce((
      select range_agg(tstzrange(inst.s, inst.e, '[)'))
      from (
        select (d.day + w.start_local) at time zone p_timezone as s,
               (d.day + case when w.end_local < w.start_local then 1 else 0 end + w.end_local) at time zone p_timezone as e
        from (select g::date as day from generate_series((p_first_date - 1)::timestamp, p_last_date::timestamp, interval '1 day') g) d
        join ogevia.caregiver_availability_windows w
          on w.organization_id = p_organization_id and w.caregiver_record_id = p_caregiver_record_id
         and (w.specific_date = d.day or (w.specific_date is null and w.weekday = extract(dow from d.day)))
      ) inst), '{}'::tstzmultirange)
     * tstzmultirange(tstzrange(p_starts, p_ends, '[)')))
    - coalesce((
      select range_agg(tstzrange(u.unavailable_date::timestamp at time zone p_timezone, (u.unavailable_date + 1)::timestamp at time zone p_timezone, '[)'))
        from ogevia.caregiver_unavailable_dates u
       where u.organization_id = p_organization_id and u.caregiver_record_id = p_caregiver_record_id
         and u.unavailable_date between p_first_date and p_last_date), '{}'::tstzmultirange)
  ) r;
$$;

-- Verified experience tag ids the caregiver holds.
create function ogevia.caregiver_verified_tags(p_organization_id uuid, p_caregiver_record_id uuid)
returns table (tag_id uuid)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select e.tag_id from ogevia.caregiver_experience e
   where e.organization_id = p_organization_id and e.caregiver_record_id = p_caregiver_record_id and e.status = 'verified';
$$;

-- ---------------------------------------------------------------------------
-- Readiness, extended: (a) a caregiver who has provided no availability at all is labelled
-- "Availability not provided" (still overridable, still outside availability); (b) a client requirement an
-- administrator marked mandatory is a hard check. Everything else is exactly as in 0039.
-- ---------------------------------------------------------------------------
create or replace function ogevia.assignment_readiness(
  p_organization_id uuid,
  p_caregiver_record_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_starts timestamptz,
  p_ends timestamptz default null,
  p_exclude_shift uuid default null,
  p_availability text default 'setting',
  p_check_conflicts boolean default true,
  p_check_authorization boolean default true
)
returns jsonb
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_set record;
  v_tz text;
  v_end timestamptz;
  v_first date;
  v_last date;
  v_rec ogevia.caregiver_records%rowtype;
  v_checks jsonb := '[]'::jsonb;
  v_reasons jsonb := '[]'::jsonb;
  v_blocked boolean := false;
  v_override boolean := false;
  v_unchecked jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_state text;
  v_dt record;
  v_req record;
  v_avail_on boolean;
  v_ok boolean;
  v_provided boolean;
begin
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  if v_tz is null then
    return jsonb_build_object('ready', false, 'blocked', true, 'needs_override', false,
      'reasons', jsonb_build_array(jsonb_build_object('code', 'NO_AGENCY', 'label', 'Agency not found')), 'checks', '[]'::jsonb);
  end if;
  v_end := coalesce(p_ends, p_starts + interval '1 minute');
  v_first := (p_starts at time zone v_tz)::date;
  v_last := ((v_end - interval '1 microsecond') at time zone v_tz)::date;
  select * into v_set from ogevia.readiness_settings(p_organization_id);

  -- 1. Caregiver status
  select * into v_rec from ogevia.caregiver_records r
   where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  v_ok := v_rec.id is not null and v_rec.status in ('ready', 'active');
  v_checks := v_checks || jsonb_build_object('key', 'status', 'status', case when v_ok then 'pass' else 'fail' end,
    'code', case when v_ok then null else 'CAREGIVER_STATUS' end, 'label', case when v_ok then 'Active' else 'Not ready to work' end);
  if not v_ok then
    v_blocked := true;
    v_reasons := v_reasons || jsonb_build_object('code', 'CAREGIVER_STATUS', 'label', 'Not ready to work');
  end if;

  -- 2. Required documents, over the whole interval in agency local dates
  for v_dt in
    select dt.id, dt.name from ogevia.document_types dt
     where dt.organization_id = p_organization_id and dt.is_active and dt.required_for_work
     order by lower(dt.name)
  loop
    v_state := ogevia.document_requirement_state(p_organization_id, p_caregiver_record_id, v_dt.id, v_first, v_last);
    if v_state <> 'ok' then
      v_items := v_items || jsonb_build_object('document_type_id', v_dt.id, 'name', v_dt.name,
        'code', 'DOC_' || upper(v_state), 'label', ogevia.document_state_label(v_dt.name, v_state),
        'pending_replacement', v_state <> 'pending' and ogevia.document_has_pending(p_organization_id, p_caregiver_record_id, v_dt.id));
      v_reasons := v_reasons || jsonb_build_object('code', 'DOC_' || upper(v_state), 'label', ogevia.document_state_label(v_dt.name, v_state));
      v_blocked := true;
    end if;
  end loop;
  v_checks := v_checks || jsonb_build_object('key', 'documents',
    'status', case when jsonb_array_length(v_items) > 0 then 'fail'
                   when exists (select 1 from ogevia.document_types dt where dt.organization_id = p_organization_id and dt.is_active and dt.required_for_work) then 'pass'
                   else 'not_required' end,
    'label', case when jsonb_array_length(v_items) > 0 then 'Documents blocked'
                  when exists (select 1 from ogevia.document_types dt where dt.organization_id = p_organization_id and dt.is_active and dt.required_for_work) then 'Documents current'
                  else 'No documents required' end,
    'items', v_items);

  -- 3. Service approval (separate from the client's authorization)
  if v_set.service_checks_enabled then
    v_ok := exists (
      select 1 from ogevia.caregiver_service_approvals a
       where a.organization_id = p_organization_id and a.caregiver_record_id = p_caregiver_record_id
         and a.service_id = p_service_id and a.revoked_at is null
         and a.effective_from <= v_first and (a.effective_to is null or a.effective_to >= v_last));
    v_checks := v_checks || jsonb_build_object('key', 'service', 'status', case when v_ok then 'pass' else 'fail' end,
      'code', case when v_ok then null else 'SERVICE_NOT_APPROVED' end, 'label', case when v_ok then 'Service approved' else 'Service not approved' end);
    if not v_ok then
      v_blocked := true;
      v_reasons := v_reasons || jsonb_build_object('code', 'SERVICE_NOT_APPROVED', 'label', 'Service not approved');
    end if;
  else
    v_checks := v_checks || jsonb_build_object('key', 'service', 'status', 'unchecked', 'label', 'Approval unchecked');
    v_unchecked := v_unchecked || to_jsonb('service'::text);
  end if;

  -- 4. Approved availability (current approved windows and exceptions only; pending requests never count)
  v_avail_on := p_availability = 'force' or (p_availability = 'setting' and v_set.availability_required);
  if p_availability = 'skip' then
    v_checks := v_checks || jsonb_build_object('key', 'availability', 'status', 'not_applicable', 'label', 'Not checked here');
  elsif v_avail_on then
    v_ok := ogevia.availability_covers(p_organization_id, p_caregiver_record_id, v_tz, p_starts, v_end, v_first, v_last)
      and not exists (select 1 from ogevia.caregiver_unavailable_dates u
                       where u.organization_id = p_organization_id and u.caregiver_record_id = p_caregiver_record_id
                         and u.unavailable_date between v_first and v_last);
    v_provided := exists (select 1 from ogevia.caregiver_availability_windows w where w.organization_id = p_organization_id and w.caregiver_record_id = p_caregiver_record_id)
               or exists (select 1 from ogevia.caregiver_unavailable_dates u where u.organization_id = p_organization_id and u.caregiver_record_id = p_caregiver_record_id)
               or exists (select 1 from ogevia.caregiver_availability_profiles p where p.caregiver_record_id = p_caregiver_record_id);
    v_checks := v_checks || jsonb_build_object('key', 'availability', 'status', case when v_ok then 'pass' else 'fail' end,
      'code', case when v_ok then null when v_provided then 'AVAILABILITY' else 'AVAILABILITY_NOT_PROVIDED' end,
      'label', case when v_ok then 'Available' when v_provided then 'Outside availability' else 'Availability not provided' end,
      'overridable', not v_ok);
    if not v_ok then
      v_override := true;
      v_reasons := v_reasons || jsonb_build_object('code', 'AVAILABILITY',
        'label', case when v_provided then 'Outside availability' else 'Availability not provided' end);
    end if;
  else
    v_checks := v_checks || jsonb_build_object('key', 'availability', 'status', 'unchecked', 'label', 'Availability unchecked');
    v_unchecked := v_unchecked || to_jsonb('availability'::text);
  end if;

  -- 5. Client authorization exists on the service dates (hours stay with the booking rules)
  if p_check_authorization then
    v_ok := exists (select 1 from ogevia.resolve_current_authorization(p_organization_id, p_client_id, p_service_id, v_first) a where a.id is not null)
        and exists (select 1 from ogevia.resolve_current_authorization(p_organization_id, p_client_id, p_service_id, v_last) a where a.id is not null);
    v_checks := v_checks || jsonb_build_object('key', 'authorization', 'status', case when v_ok then 'pass' else 'fail' end,
      'code', case when v_ok then null else 'AUTH_MISSING' end, 'label', case when v_ok then 'Authorized' else 'No authorization' end);
    if not v_ok then
      v_blocked := true;
      v_reasons := v_reasons || jsonb_build_object('code', 'AUTH_MISSING', 'label', 'No authorization');
    end if;
  else
    v_checks := v_checks || jsonb_build_object('key', 'authorization', 'status', 'not_applicable', 'label', 'Not checked here');
  end if;

  -- 6. Conflicts with the caregiver's other shifts
  if p_check_conflicts then
    v_ok := not exists (
      select 1 from ogevia.shifts s
       where s.organization_id = p_organization_id and s.id is distinct from p_exclude_shift
         and (s.caregiver_record_id = p_caregiver_record_id
              or (v_rec.linked_user_id is not null and s.caregiver_user_id = v_rec.linked_user_id))
         and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
         and s.starts_at < v_end and s.ends_at > p_starts);
    v_checks := v_checks || jsonb_build_object('key', 'conflicts', 'status', case when v_ok then 'pass' else 'fail' end,
      'code', case when v_ok then null else 'TIME_CONFLICT' end, 'label', case when v_ok then 'No conflict' else 'Already booked' end);
    if not v_ok then
      v_blocked := true;
      v_reasons := v_reasons || jsonb_build_object('code', 'TIME_CONFLICT', 'label', 'Already booked');
    end if;
  else
    v_checks := v_checks || jsonb_build_object('key', 'conflicts', 'status', 'not_applicable', 'label', 'Not checked here');
  end if;

  -- 7. Client requirements an administrator marked mandatory (verified experience required; no override)
  v_items := '[]'::jsonb;
  for v_req in
    select t.name from ogevia.client_support_preferences p
      join ogevia.experience_tags t on t.id = p.tag_id and t.organization_id = p.organization_id
     where p.organization_id = p_organization_id and p.client_id = p_client_id and p.removed_at is null and p.mandatory
       and not exists (select 1 from ogevia.caregiver_verified_tags(p_organization_id, p_caregiver_record_id) vt where vt.tag_id = p.tag_id)
     order by lower(t.name)
  loop
    v_items := v_items || jsonb_build_object('name', v_req.name, 'code', 'CLIENT_REQUIREMENT', 'label', v_req.name || ' required');
    v_reasons := v_reasons || jsonb_build_object('code', 'CLIENT_REQUIREMENT', 'label', v_req.name || ' required');
    v_blocked := true;
  end loop;
  v_checks := v_checks || jsonb_build_object('key', 'requirements',
    'status', case when jsonb_array_length(v_items) > 0 then 'fail'
                   when exists (select 1 from ogevia.client_support_preferences p where p.organization_id = p_organization_id and p.client_id = p_client_id and p.removed_at is null and p.mandatory) then 'pass'
                   else 'not_required' end,
    'label', case when jsonb_array_length(v_items) > 0 then 'Client requirement not met' else 'Client requirements met' end,
    'items', v_items);

  return jsonb_build_object(
    'ready', not v_blocked and not v_override,
    'blocked', v_blocked,
    'needs_override', v_override and not v_blocked,
    'service_checks', case when v_set.service_checks_enabled then 'on' else 'off' end,
    'availability_checks', case when v_avail_on then 'on' else 'off' end,
    'unchecked', v_unchecked,
    'interval', jsonb_build_object('starts_at', p_starts, 'ends_at', v_end, 'first_date', v_first, 'last_date', v_last, 'timezone', v_tz),
    'checks', v_checks,
    'reasons', v_reasons);
end;
$$;

-- ---------------------------------------------------------------------------
-- The match for ONE caregiver over one or more occurrences (single shift = one occurrence).
-- ---------------------------------------------------------------------------
create function ogevia.match_candidate(
  p_organization_id uuid, p_caregiver_record_id uuid, p_client_id uuid, p_service_id uuid,
  p_occurrences jsonb, p_exclude_shift uuid default null, p_check_conflicts boolean default true
)
returns jsonb
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_tz text;
  v_ms record;
  v_rec ogevia.caregiver_records%rowtype;
  v_occ jsonb;
  v_starts timestamptz;
  v_ends timestamptz;
  v_first date;
  v_last date;
  v_r jsonb;
  v_total_min numeric := 0;
  v_cov_min numeric := 0;
  v_ready int := 0;
  v_override int := 0;
  v_blocked int := 0;
  v_n int := 0;
  v_reasons jsonb := '[]'::jsonb;
  v_unchecked jsonb := '[]'::jsonb;
  v_covered jsonb := '[]'::jsonb;
  v_uncovered jsonb := '[]'::jsonb;
  v_elig text;
  v_checks jsonb := null;
  -- location
  v_cz text; v_gz text; v_limit integer; v_dist numeric; v_cl_updated timestamptz; v_cg_updated timestamptz;
  v_vintage text;
  -- experience
  v_total_w numeric := 0; v_match_w numeric := 0; v_matched_tags int := 0; v_reviewed_at timestamptz; v_n_tags int := 0;
  v_matched jsonb := '[]'::jsonb;
  -- components
  v_a numeric; v_l numeric; v_e numeric;
  v_a_status text := 'known'; v_l_status text; v_e_status text;
  v_wa numeric; v_wl numeric; v_we numeric; v_wsum numeric;
  v_score integer; v_score_status text;
  v_avail_updated timestamptz; v_avail_version integer;
  v_limit_exceeded boolean := false;
  v_tag record;
begin
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  select * into v_ms from ogevia.match_settings(p_organization_id);
  select * into v_rec from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id;

  for v_occ in select * from jsonb_array_elements(p_occurrences) loop
    v_starts := (v_occ ->> 'starts_at')::timestamptz;
    v_ends := (v_occ ->> 'ends_at')::timestamptz;
    v_first := (v_starts at time zone v_tz)::date;
    v_last := ((v_ends - interval '1 microsecond') at time zone v_tz)::date;
    v_r := ogevia.assignment_readiness(p_organization_id, p_caregiver_record_id, p_client_id, p_service_id, v_starts, v_ends, p_exclude_shift, 'force', p_check_conflicts, true);
    v_n := v_n + 1;
    v_total_min := v_total_min + extract(epoch from (v_ends - v_starts)) / 60;
    v_cov_min := v_cov_min + ogevia.availability_covered_minutes(p_organization_id, p_caregiver_record_id, v_tz, v_starts, v_ends, v_first, v_last);
    if v_checks is null then v_checks := v_r -> 'checks'; end if;
    if (v_r ->> 'ready')::boolean then
      v_ready := v_ready + 1;
      v_covered := v_covered || jsonb_build_object('starts_at', v_starts, 'ends_at', v_ends);
    else
      if (v_r ->> 'blocked')::boolean then v_blocked := v_blocked + 1; else v_override := v_override + 1; end if;
      v_uncovered := v_uncovered || jsonb_build_object('starts_at', v_starts, 'ends_at', v_ends,
        'status', case when (v_r ->> 'blocked')::boolean then 'blocked' else 'needs_override' end,
        'reasons', v_r -> 'reasons');
    end if;
    v_reasons := v_reasons || (v_r -> 'reasons');
    v_unchecked := v_unchecked || (v_r -> 'unchecked');
    if (v_r ->> 'blocked')::boolean and v_checks is not null and (v_r -> 'checks') is not null and v_blocked = 1 then
      v_checks := v_r -> 'checks'; -- show the checks of the first blocked occurrence
    end if;
  end loop;

  v_elig := case
    when v_blocked = 0 and v_override = 0 then 'eligible'
    when v_blocked = 0 then 'needs_override'
    when v_ready > 0 then 'partial'
    else 'not_eligible' end;

  -- Location (ZIP only): approximate straight-line distance
  select cl.zip, cl.updated_at into v_cz, v_cl_updated from ogevia.client_locations cl where cl.client_id = p_client_id and cl.organization_id = p_organization_id;
  select gl.zip, gl.travel_limit_miles, gl.updated_at into v_gz, v_limit, v_cg_updated from ogevia.caregiver_locations gl where gl.caregiver_record_id = p_caregiver_record_id and gl.organization_id = p_organization_id;
  v_dist := ogevia.approx_distance_miles(v_cz, v_gz);
  select max(zc.vintage) into v_vintage from ogevia.zip_centroids zc where zc.zip in (v_cz, v_gz);
  if v_dist is not null and v_limit is not null and v_dist > v_limit then
    v_limit_exceeded := true;
    v_elig := 'not_eligible';
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('code', 'TRAVEL_LIMIT', 'label', 'Beyond stated travel limit (approx.)'));
  end if;

  -- A: availability fit
  v_a := case when v_total_min > 0 then least(1, v_cov_min / v_total_min) else 0 end;
  select p.updated_at, p.version into v_avail_updated, v_avail_version from ogevia.caregiver_availability_profiles p where p.caregiver_record_id = p_caregiver_record_id;

  -- L: location fit
  if not v_ms.match_location_enabled then
    v_l_status := 'not_applicable'; v_l := null;
  elsif v_dist is null then
    v_l_status := 'unknown'; v_l := null;
  else
    v_l_status := 'known'; v_l := greatest(0, 1 - v_dist / v_ms.match_radius_miles);
  end if;

  -- E: experience preference fit (optional tags only; mandatory ones are eligibility, not score)
  select coalesce(sum(p.weight), 0), count(*) into v_total_w, v_n_tags
    from ogevia.client_support_preferences p
   where p.organization_id = p_organization_id and p.client_id = p_client_id and p.removed_at is null and not p.mandatory;
  select r.reviewed_at into v_reviewed_at from ogevia.caregiver_experience_reviews r where r.caregiver_record_id = p_caregiver_record_id;
  for v_tag in
    select p.weight, t.id as tag_id, t.name,
           exists (select 1 from ogevia.caregiver_verified_tags(p_organization_id, p_caregiver_record_id) vt where vt.tag_id = p.tag_id) as held
      from ogevia.client_support_preferences p join ogevia.experience_tags t on t.id = p.tag_id and t.organization_id = p.organization_id
     where p.organization_id = p_organization_id and p.client_id = p_client_id and p.removed_at is null and not p.mandatory
     order by lower(t.name)
  loop
    if v_tag.held then
      v_match_w := v_match_w + v_tag.weight;
      v_matched_tags := v_matched_tags + 1;
      v_matched := v_matched || jsonb_build_object('tag_id', v_tag.tag_id, 'name', v_tag.name, 'weight', v_tag.weight);
    end if;
  end loop;
  if v_n_tags = 0 then
    v_e_status := 'not_applicable'; v_e := null;
  elsif v_match_w >= v_total_w or v_reviewed_at is not null then
    v_e_status := 'known'; v_e := v_match_w / v_total_w;
  else
    v_e_status := 'unknown'; v_e := null; -- not recorded is not evidence of no experience
  end if;

  -- Weights: base .50 / .25 / .25, redistributed over the applicable components
  v_wsum := 0.50 + case when v_l_status = 'not_applicable' then 0 else 0.25 end + case when v_e_status = 'not_applicable' then 0 else 0.25 end;
  v_wa := 0.50 / v_wsum;
  v_wl := case when v_l_status = 'not_applicable' then 0 else 0.25 / v_wsum end;
  v_we := case when v_e_status = 'not_applicable' then 0 else 0.25 / v_wsum end;
  if v_l_status = 'unknown' or v_e_status = 'unknown' then
    v_score := null; v_score_status := 'incomplete';
  else
    v_score := round(100 * (v_wa * v_a + v_wl * coalesce(v_l, 0) + v_we * coalesce(v_e, 0)))::integer;
    v_score_status := 'complete';
  end if;

  return jsonb_build_object(
    'caregiver_record_id', p_caregiver_record_id,
    'caregiver_code', v_rec.caregiver_code,
    'caregiver_name', coalesce(v_rec.preferred_name, v_rec.first_name) || ' ' || v_rec.last_name,
    'eligibility', v_elig,
    'travel_limit_exceeded', v_limit_exceeded,
    'checks', v_checks,
    'reasons', (select coalesce(jsonb_agg(x order by x ->> 'code', x ->> 'label'), '[]'::jsonb) from (select distinct x from jsonb_array_elements(v_reasons) x) q),
    'unchecked', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements(v_unchecked) x),
    'cover', jsonb_build_object('occurrences', v_n, 'ready', v_ready, 'needs_override', v_override, 'blocked', v_blocked,
                                'covered', v_covered, 'not_covered', v_uncovered, 'partial', v_elig = 'partial'),
    'approx_distance_miles', v_dist,
    'score', v_score,
    'score_status', v_score_status,
    'score_version', 'match-v1',
    'verified_matches', v_matched_tags,
    'matched_tags', v_matched,
    'components', jsonb_build_array(
      jsonb_build_object('key', 'availability', 'status', v_a_status, 'value', round(v_a, 4), 'weight', round(v_wa, 4),
        'points', round(100 * v_wa * v_a, 1), 'detail', jsonb_build_object('covered_minutes', round(v_cov_min), 'requested_minutes', round(v_total_min)),
        'source', jsonb_build_object('updated_at', v_avail_updated, 'version', coalesce(v_avail_version, 0))),
      jsonb_build_object('key', 'location', 'status', v_l_status, 'value', round(v_l, 4), 'weight', round(v_wl, 4),
        'points', case when v_l is null then null else round(100 * v_wl * v_l, 1) end,
        'detail', jsonb_build_object('approx_distance_miles', v_dist, 'reference_radius_miles', v_ms.match_radius_miles,
                                      'caregiver_location', case when v_gz is null then 'not recorded' else 'recorded' end,
                                      'client_location', case when v_cz is null then 'not recorded' else 'recorded' end,
                                      'coordinates', case when v_dist is null and v_gz is not null and v_cz is not null then 'not available for this ZIP' else null end),
        'source', jsonb_build_object('client_updated_at', v_cl_updated, 'caregiver_updated_at', v_cg_updated, 'dataset_vintage', v_vintage)),
      jsonb_build_object('key', 'experience', 'status', v_e_status, 'value', round(v_e, 4), 'weight', round(v_we, 4),
        'points', case when v_e is null then null else round(100 * v_we * v_e, 1) end,
        'detail', jsonb_build_object('requested_tags', v_n_tags, 'verified_matches', v_matched_tags,
                                      'experience_reviewed', v_reviewed_at is not null),
        'source', jsonb_build_object('reviewed_at', v_reviewed_at))));
end;
$$;

-- ---------------------------------------------------------------------------
-- API: candidates for a request (single shift or a set of occurrences)
-- ---------------------------------------------------------------------------
create function ogevia_api.list_match_candidates(
  p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_occurrences jsonb, p_exclude_shift_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_ms record;
  v_set record;
  v_c jsonb;
  v_out jsonb := '[]'::jsonb;
  v_rec record;
  v_occ jsonb;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'care_requests.manage')) then
    raise exception 'You do not have permission to see matches' using errcode = 'OGA03';
  end if;
  if jsonb_typeof(p_occurrences) is distinct from 'array' or jsonb_array_length(p_occurrences) not between 1 and 100 then
    raise exception 'Send between 1 and 100 service times' using errcode = 'OGV22';
  end if;
  for v_occ in select * from jsonb_array_elements(p_occurrences) loop
    if (v_occ ->> 'starts_at') is null or (v_occ ->> 'ends_at') is null or (v_occ ->> 'starts_at')::timestamptz >= (v_occ ->> 'ends_at')::timestamptz then
      raise exception 'Each service time needs a start before its end' using errcode = 'OGV22';
    end if;
  end loop;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;
  if not exists (select 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id and s.deleted_at is null) then
    raise exception 'Service not found' using errcode = 'OGN04';
  end if;
  select * into v_ms from ogevia.match_settings(p_organization_id);
  select * into v_set from ogevia.readiness_settings(p_organization_id);
  for v_rec in
    select r.id from ogevia.caregiver_records r
     where r.organization_id = p_organization_id and r.deleted_at is null and r.status in ('ready', 'active')
     limit 300
  loop
    v_out := v_out || jsonb_build_array(ogevia.match_candidate(p_organization_id, v_rec.id, p_client_id, p_service_id, p_occurrences, p_exclude_shift_id));
  end loop;
  return jsonb_build_object(
    'version', 'match-v1',
    'settings', jsonb_build_object('reference_radius_miles', v_ms.match_radius_miles, 'location_enabled', v_ms.match_location_enabled,
                                   'service_checks', case when v_set.service_checks_enabled then 'on' else 'off' end),
    'candidates', (select coalesce(jsonb_agg(x order by
        case x ->> 'eligibility' when 'eligible' then 0 when 'partial' then 1 when 'needs_override' then 2 else 3 end,
        (x ->> 'score')::int desc nulls last,
        (x ->> 'approx_distance_miles')::numeric asc nulls last,
        (x ->> 'verified_matches')::int desc,
        x ->> 'caregiver_code'), '[]'::jsonb) from jsonb_array_elements(v_out) x));
end;
$$;

-- ---------------------------------------------------------------------------
-- API: record the administrator's selection (recomputes server-side; never trusts a client score)
-- ---------------------------------------------------------------------------
create function ogevia_api.record_assignment_decision(
  p_organization_id uuid, p_caregiver_record_id uuid, p_client_id uuid, p_service_id uuid, p_occurrences jsonb,
  p_context text, p_reference_id uuid, p_rationale text default null, p_override_reason text default null,
  p_exclude_shift_id uuid default null, p_check_conflicts boolean default true
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_c jsonb;
  v_id uuid;
  v_refs jsonb;
  v_ms record;
begin
  if v_actor is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'care_requests.manage')) then
    raise exception 'You do not have permission to record an assignment' using errcode = 'OGA03';
  end if;
  if p_context not in ('shift', 'care_request', 'series') then
    raise exception 'Unknown assignment context' using errcode = 'OGV22';
  end if;
  v_c := ogevia.match_candidate(p_organization_id, p_caregiver_record_id, p_client_id, p_service_id, p_occurrences, p_exclude_shift_id, p_check_conflicts);
  if v_c ->> 'caregiver_code' is null then
    raise exception 'Care Team member not found' using errcode = 'OGN04';
  end if;
  select * into v_ms from ogevia.match_settings(p_organization_id);
  v_refs := jsonb_build_object(
    'availability_version', (select coalesce(p.version, 0) from (select 1) x left join ogevia.caregiver_availability_profiles p on p.caregiver_record_id = p_caregiver_record_id),
    'experience_reviewed_at', (select r.reviewed_at from ogevia.caregiver_experience_reviews r where r.caregiver_record_id = p_caregiver_record_id),
    'matched_tag_ids', coalesce((select jsonb_agg(t ->> 'tag_id') from jsonb_array_elements(v_c -> 'matched_tags') t), '[]'::jsonb),
    'reference_radius_miles', v_ms.match_radius_miles,
    'location_enabled', v_ms.match_location_enabled,
    'service_checks', (select case when s.service_checks_enabled then 'on' else 'off' end from ogevia.readiness_settings(p_organization_id) s));
  insert into ogevia.assignment_decisions (organization_id, decided_by, caregiver_record_id, client_id, service_id, context, reference_id,
    score_version, eligibility, score, score_status, components, approx_distance_miles, input_refs, rationale, override_reason)
  values (p_organization_id, v_actor, p_caregiver_record_id, p_client_id, p_service_id, p_context, p_reference_id,
    v_c ->> 'score_version', v_c ->> 'eligibility', (v_c ->> 'score')::integer, v_c ->> 'score_status',
    (select jsonb_agg(jsonb_build_object('key', c ->> 'key', 'status', c ->> 'status', 'value', c -> 'value', 'weight', c -> 'weight', 'points', c -> 'points'))
       from jsonb_array_elements(v_c -> 'components') c),
    round((v_c ->> 'approx_distance_miles')::numeric, 1), v_refs,
    nullif(btrim(coalesce(p_rationale, '')), ''),
    case when v_c ->> 'eligibility' = 'needs_override' then nullif(btrim(coalesce(p_override_reason, '')), '') end)
  returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'assignment.decision_recorded', 'assignment_decisions', v_id, null,
    jsonb_build_object('context', p_context, 'reference_id', p_reference_id, 'caregiver_record_id', p_caregiver_record_id,
                       'score', v_c -> 'score', 'score_status', v_c ->> 'score_status', 'score_version', v_c ->> 'score_version',
                       'eligibility', v_c ->> 'eligibility'),
    case when v_c ->> 'eligibility' = 'needs_override' then nullif(btrim(coalesce(p_override_reason, p_rationale, '')), '') else nullif(btrim(coalesce(p_rationale, '')), '') end);
  return v_id;
end;
$$;

-- Wrappers used by the API after an assignment: they read the assignment the server just made (never a
-- client-supplied time), exclude that shift from the conflict check so it does not conflict with itself, and
-- record who chose whom with the score at that moment.
create function ogevia_api.record_decision_for_shift(p_organization_id uuid, p_shift_id uuid, p_rationale text default null, p_override_reason text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  s ogevia.shifts%rowtype;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'care_requests.manage')) then
    raise exception 'You do not have permission to record an assignment' using errcode = 'OGA03';
  end if;
  select * into s from ogevia.shifts where id = p_shift_id and organization_id = p_organization_id;
  if s.id is null or s.caregiver_record_id is null or s.service_id is null then
    raise exception 'Shift with a caregiver not found' using errcode = 'OGN04';
  end if;
  return ogevia_api.record_assignment_decision(p_organization_id, s.caregiver_record_id, s.client_id, s.service_id,
    jsonb_build_array(jsonb_build_object('starts_at', s.starts_at, 'ends_at', s.ends_at)), 'shift', s.id, p_rationale, p_override_reason, s.id, true);
end;
$$;

create function ogevia_api.record_decision_for_care_request(p_organization_id uuid, p_request_id uuid, p_rationale text default null, p_override_reason text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  r ogevia.care_requests%rowtype;
  s ogevia.shifts%rowtype;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'care_requests.manage')) then
    raise exception 'You do not have permission to record an assignment' using errcode = 'OGA03';
  end if;
  select * into r from ogevia.care_requests where id = p_request_id and organization_id = p_organization_id;
  if r.id is null or r.assigned_shift_id is null then
    raise exception 'Assigned care request not found' using errcode = 'OGN04';
  end if;
  select * into s from ogevia.shifts where id = r.assigned_shift_id and organization_id = p_organization_id;
  return ogevia_api.record_assignment_decision(p_organization_id, s.caregiver_record_id, s.client_id, s.service_id,
    jsonb_build_array(jsonb_build_object('starts_at', s.starts_at, 'ends_at', s.ends_at)), 'care_request', r.id, p_rationale, p_override_reason, s.id, true);
end;
$$;

create function ogevia_api.record_decision_for_series(p_organization_id uuid, p_series_id uuid, p_rationale text default null, p_override_reason text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  ss ogevia.shift_series%rowtype;
  v_occ jsonb;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'care_requests.manage')) then
    raise exception 'You do not have permission to record an assignment' using errcode = 'OGA03';
  end if;
  select * into ss from ogevia.shift_series where id = p_series_id and organization_id = p_organization_id;
  if ss.id is null or ss.caregiver_record_id is null then
    raise exception 'Series with a caregiver not found' using errcode = 'OGN04';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('starts_at', x.starts_at, 'ends_at', x.ends_at) order by x.starts_at), '[]'::jsonb) into v_occ
    from (select s.starts_at, s.ends_at from ogevia.shifts s
           where s.series_id = ss.id and s.organization_id = p_organization_id and s.status = 'scheduled' order by s.starts_at limit 100) x;
  if jsonb_array_length(v_occ) = 0 then
    raise exception 'The series has no scheduled shifts' using errcode = 'OGN04';
  end if;
  return ogevia_api.record_assignment_decision(p_organization_id, ss.caregiver_record_id, ss.client_id, ss.service_id, v_occ, 'series', ss.id,
    p_rationale, p_override_reason, null, false);
end;
$$;

create function ogevia_api.list_assignment_decisions(p_organization_id uuid, p_reference_id uuid)
returns table (
  decision_id uuid, decided_at timestamptz, decided_by_name text, caregiver_code text, eligibility text, score integer,
  score_status text, score_version text, components jsonb, approx_distance_miles numeric, input_refs jsonb, rationale text, override_reason text
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'care_requests.manage')) then
    raise exception 'You do not have permission to see assignment decisions' using errcode = 'OGA03';
  end if;
  return query
    select d.id, d.decided_at, u.display_name, c.caregiver_code, d.eligibility, d.score, d.score_status, d.score_version,
           d.components, d.approx_distance_miles, d.input_refs, d.rationale, d.override_reason
      from ogevia.assignment_decisions d
      join ogevia.caregiver_records c on c.id = d.caregiver_record_id and c.organization_id = d.organization_id
      left join ogevia.app_users u on u.id = d.decided_by
     where d.organization_id = p_organization_id and d.reference_id = p_reference_id
     order by d.decided_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- API: match settings, tags, experience, client support needs, locations
-- ---------------------------------------------------------------------------
create function ogevia_api.get_match_settings(p_organization_id uuid)
returns table (reference_radius_miles numeric, location_enabled boolean)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'care_requests.manage')
          or ogevia.has_permission(p_organization_id, 'readiness.manage')) then
    raise exception 'You do not have permission to see match settings' using errcode = 'OGA03';
  end if;
  return query select s.match_radius_miles, s.match_location_enabled from ogevia.match_settings(p_organization_id) s;
end;
$$;

create function ogevia_api.set_match_settings(p_organization_id uuid, p_radius_miles numeric, p_location_enabled boolean, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_before record;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'readiness.manage') then
    raise exception 'Only the Administrator can change match settings' using errcode = 'OGA03';
  end if;
  if p_radius_miles is null or p_radius_miles <= 0 or p_radius_miles > 500 then
    raise exception 'The reference radius must be more than 0 and at most 500 miles' using errcode = 'OGV22';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required' using errcode = 'OGV22';
  end if;
  select * into v_before from ogevia.match_settings(p_organization_id);
  insert into ogevia.agency_readiness_settings (organization_id, match_radius_miles, match_location_enabled, updated_by, updated_at)
  values (p_organization_id, p_radius_miles, coalesce(p_location_enabled, true), ogevia.require_actor(), now())
  on conflict (organization_id) do update set match_radius_miles = excluded.match_radius_miles,
    match_location_enabled = excluded.match_location_enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform ogevia.write_audit(p_organization_id, 'match.settings_changed', 'agency_readiness_settings', p_organization_id,
    to_jsonb(v_before), jsonb_build_object('match_radius_miles', p_radius_miles, 'match_location_enabled', coalesce(p_location_enabled, true)), btrim(p_reason));
end;
$$;

create function ogevia_api.create_experience_tag(p_organization_id uuid, p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_id uuid;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then
    raise exception 'You do not have permission to manage experience tags' using errcode = 'OGA03';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 2 and 80 then
    raise exception 'A tag name needs 2 to 80 characters' using errcode = 'OGV22';
  end if;
  if exists (select 1 from ogevia.experience_tags t where t.organization_id = p_organization_id and lower(btrim(t.name)) = lower(btrim(p_name))) then
    raise exception 'That experience tag already exists' using errcode = 'OGC09';
  end if;
  insert into ogevia.experience_tags (organization_id, name, created_by) values (p_organization_id, btrim(p_name), ogevia.require_actor()) returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'experience_tag.created', 'experience_tags', v_id, null, jsonb_build_object('name', btrim(p_name)), null);
  return v_id;
end;
$$;

create function ogevia_api.set_experience_tag_active(p_organization_id uuid, p_tag_id uuid, p_active boolean, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then
    raise exception 'You do not have permission to manage experience tags' using errcode = 'OGA03';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required' using errcode = 'OGV22';
  end if;
  update ogevia.experience_tags set is_active = coalesce(p_active, true) where id = p_tag_id and organization_id = p_organization_id;
  if not found then raise exception 'Tag not found' using errcode = 'OGN04'; end if;
  perform ogevia.write_audit(p_organization_id, 'experience_tag.active_changed', 'experience_tags', p_tag_id, null, jsonb_build_object('is_active', coalesce(p_active, true)), btrim(p_reason));
end;
$$;

create function ogevia_api.list_experience_tags(p_organization_id uuid)
returns table (tag_id uuid, name text, is_active boolean)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  return query select t.id, t.name, t.is_active from ogevia.experience_tags t
   where t.organization_id = p_organization_id and (t.is_active or ogevia.has_permission(p_organization_id, 'caregivers.manage')) order by lower(t.name);
end;
$$;

-- A caregiver submits their own experience; an administrator may add it for them (still needs verification
-- unless the administrator records it as verified, which is recorded as the administrator's review).
create function ogevia_api.record_experience(
  p_organization_id uuid, p_caregiver_record_id uuid, p_tag_id uuid, p_context text, p_verify boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_own uuid;
  v_admin boolean;
  v_id uuid;
begin
  if v_actor is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  v_admin := ogevia.has_permission(p_organization_id, 'caregivers.manage');
  v_own := ogevia.my_caregiver_record(p_organization_id);
  p_caregiver_record_id := coalesce(p_caregiver_record_id, v_own);
  if not v_admin and (v_own is null or v_own <> p_caregiver_record_id or not ogevia.has_permission(p_organization_id, 'availability.manage_own')) then
    raise exception 'You can only submit your own experience' using errcode = 'OGA03';
  end if;
  if p_verify and not v_admin then
    raise exception 'Only an administrator can verify experience' using errcode = 'OGA03';
  end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Care Team member not found' using errcode = 'OGN04';
  end if;
  if not exists (select 1 from ogevia.experience_tags t where t.id = p_tag_id and t.organization_id = p_organization_id and t.is_active) then
    raise exception 'Experience tag not found' using errcode = 'OGN04';
  end if;
  if exists (select 1 from ogevia.caregiver_experience e where e.caregiver_record_id = p_caregiver_record_id and e.tag_id = p_tag_id and e.status in ('pending', 'verified')) then
    raise exception 'This experience is already recorded or waiting for review' using errcode = 'OGC09';
  end if;
  perform ogevia.lock_caregiver_schedule(p_caregiver_record_id);
  insert into ogevia.caregiver_experience (organization_id, caregiver_record_id, tag_id, context, source, submitted_by, status, reviewed_by, reviewed_at)
  values (p_organization_id, p_caregiver_record_id, p_tag_id, nullif(btrim(coalesce(p_context, '')), ''),
          case when v_admin and (v_own is distinct from p_caregiver_record_id) then 'administrator' else 'caregiver' end, v_actor,
          case when p_verify then 'verified' else 'pending' end,
          case when p_verify then v_actor end, case when p_verify then now() end)
  returning id into v_id;
  perform ogevia.write_audit(p_organization_id, case when p_verify then 'experience.verified' else 'experience.submitted' end, 'caregiver_experience', v_id, null,
    jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'tag_id', p_tag_id), null);
  return v_id;
end;
$$;

create function ogevia_api.review_experience(p_experience_id uuid, p_decision text, p_note text)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  e ogevia.caregiver_experience%rowtype;
begin
  select * into e from ogevia.caregiver_experience where id = p_experience_id for update;
  if e.id is null or not ogevia.is_active_member(e.organization_id) then
    raise exception 'Experience entry not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(e.organization_id, 'caregivers.manage') then
    raise exception 'Only an administrator can verify experience' using errcode = 'OGA03';
  end if;
  if p_decision not in ('verify', 'decline', 'remove') then
    raise exception 'Decision must be verify, decline or remove' using errcode = 'OGV22';
  end if;
  if p_decision in ('decline', 'remove') and length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'A note is required' using errcode = 'OGV22';
  end if;
  perform ogevia.lock_caregiver_schedule(e.caregiver_record_id);
  if p_decision = 'verify' and e.status <> 'pending' then
    raise exception 'Only a pending entry can be verified' using errcode = 'OGC09';
  end if;
  if p_decision = 'decline' and e.status <> 'pending' then
    raise exception 'Only a pending entry can be declined' using errcode = 'OGC09';
  end if;
  if p_decision = 'remove' and e.status not in ('verified', 'pending') then
    raise exception 'This entry is already closed' using errcode = 'OGC09';
  end if;
  update ogevia.caregiver_experience
     set status = case p_decision when 'verify' then 'verified' when 'decline' then 'declined' else 'removed' end,
         reviewed_by = v_actor, reviewed_at = now(), review_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = e.id;
  perform ogevia.write_audit(e.organization_id, 'experience.' || case p_decision when 'verify' then 'verified' when 'decline' then 'declined' else 'removed' end,
    'caregiver_experience', e.id, jsonb_build_object('status', e.status), jsonb_build_object('status', p_decision), nullif(btrim(coalesce(p_note, '')), ''));
end;
$$;

create function ogevia_api.mark_experience_reviewed(p_organization_id uuid, p_caregiver_record_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then
    raise exception 'Only an administrator can mark experience reviewed' using errcode = 'OGA03';
  end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Care Team member not found' using errcode = 'OGN04';
  end if;
  insert into ogevia.caregiver_experience_reviews (caregiver_record_id, organization_id, reviewed_by, reviewed_at)
  values (p_caregiver_record_id, p_organization_id, ogevia.require_actor(), now())
  on conflict (caregiver_record_id) do update set reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at;
  perform ogevia.write_audit(p_organization_id, 'experience.profile_reviewed', 'caregiver_records', p_caregiver_record_id, null, null, null);
end;
$$;

-- Administrators see every entry with its source and review; a caregiver sees their own (no reviewer notes except decline).
create function ogevia_api.list_caregiver_experience(p_organization_id uuid, p_caregiver_record_id uuid)
returns table (
  experience_id uuid, tag_id uuid, tag_name text, context text, source text, status text, submitted_at timestamptz,
  reviewed_at timestamptz, reviewed_by_name text, review_note text, profile_reviewed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_admin boolean;
  v_own uuid;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  v_admin := ogevia.has_permission(p_organization_id, 'caregivers.manage');
  v_own := ogevia.my_caregiver_record(p_organization_id);
  p_caregiver_record_id := coalesce(p_caregiver_record_id, v_own);
  if not v_admin and (v_own is null or v_own <> p_caregiver_record_id) then
    raise exception 'You can only see your own experience' using errcode = 'OGA03';
  end if;
  return query
    select e.id, e.tag_id, t.name, e.context, e.source, e.status, e.submitted_at, e.reviewed_at, rv.display_name,
           case when v_admin or e.status = 'declined' then e.review_note end,
           (select r.reviewed_at from ogevia.caregiver_experience_reviews r where r.caregiver_record_id = p_caregiver_record_id)
      from ogevia.caregiver_experience e
      join ogevia.experience_tags t on t.id = e.tag_id and t.organization_id = e.organization_id
      left join ogevia.app_users rv on rv.id = e.reviewed_by
     where e.organization_id = p_organization_id and e.caregiver_record_id = p_caregiver_record_id and (v_admin or e.status <> 'removed')
     order by e.submitted_at desc;
end;
$$;

create function ogevia_api.set_client_support_preference(
  p_organization_id uuid, p_client_id uuid, p_tag_id uuid, p_weight integer, p_mandatory boolean, p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_old ogevia.client_support_preferences%rowtype;
  v_id uuid;
begin
  if v_actor is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then
    raise exception 'You do not have permission to confirm client support needs' using errcode = 'OGA03';
  end if;
  if p_weight is null or p_weight not between 1 and 10 then
    raise exception 'Priority must be between 1 and 10' using errcode = 'OGV22';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;
  if not exists (select 1 from ogevia.experience_tags t where t.id = p_tag_id and t.organization_id = p_organization_id and t.is_active) then
    raise exception 'Experience tag not found' using errcode = 'OGN04';
  end if;
  select * into v_old from ogevia.client_support_preferences p where p.client_id = p_client_id and p.tag_id = p_tag_id and p.removed_at is null for update;
  if v_old.id is not null then
    update ogevia.client_support_preferences set removed_at = now(), removed_by = v_actor where id = v_old.id;
  end if;
  insert into ogevia.client_support_preferences (organization_id, client_id, tag_id, weight, mandatory, confirmed_by)
  values (p_organization_id, p_client_id, p_tag_id, p_weight, coalesce(p_mandatory, false), v_actor) returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'client_support.confirmed', 'client_support_preferences', v_id,
    case when v_old.id is null then null else jsonb_build_object('weight', v_old.weight, 'mandatory', v_old.mandatory) end,
    jsonb_build_object('tag_id', p_tag_id, 'weight', p_weight, 'mandatory', coalesce(p_mandatory, false)), btrim(p_reason));
  return v_id;
end;
$$;

create function ogevia_api.remove_client_support_preference(p_preference_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  p ogevia.client_support_preferences%rowtype;
begin
  select * into p from ogevia.client_support_preferences where id = p_preference_id for update;
  if p.id is null or not ogevia.is_active_member(p.organization_id) then
    raise exception 'Support need not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p.organization_id, 'clients.manage') then
    raise exception 'You do not have permission to change client support needs' using errcode = 'OGA03';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required' using errcode = 'OGV22';
  end if;
  if p.removed_at is not null then
    raise exception 'This support need was already removed' using errcode = 'OGC09';
  end if;
  update ogevia.client_support_preferences set removed_at = now(), removed_by = ogevia.require_actor() where id = p.id;
  perform ogevia.write_audit(p.organization_id, 'client_support.removed', 'client_support_preferences', p.id,
    jsonb_build_object('weight', p.weight, 'mandatory', p.mandatory), null, btrim(p_reason));
end;
$$;

create function ogevia_api.list_client_support_preferences(p_organization_id uuid, p_client_id uuid)
returns table (preference_id uuid, tag_id uuid, tag_name text, weight integer, mandatory boolean, confirmed_at timestamptz, confirmed_by_name text)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'clients.manage') or ogevia.has_permission(p_organization_id, 'shifts.manage')
          or ogevia.has_permission(p_organization_id, 'care_requests.manage')) then
    raise exception 'You do not have permission to see client support needs' using errcode = 'OGA03';
  end if;
  return query
    select p.id, p.tag_id, t.name, p.weight::integer, p.mandatory, p.confirmed_at, u.display_name
      from ogevia.client_support_preferences p
      join ogevia.experience_tags t on t.id = p.tag_id and t.organization_id = p.organization_id
      left join ogevia.app_users u on u.id = p.confirmed_by
     where p.organization_id = p_organization_id and p.client_id = p_client_id and p.removed_at is null
     order by p.mandatory desc, lower(t.name);
end;
$$;

create function ogevia_api.set_client_location(p_organization_id uuid, p_client_id uuid, p_zip text)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then
    raise exception 'You do not have permission to set a client location' using errcode = 'OGA03';
  end if;
  if p_zip is null or p_zip !~ '^[0-9]{5}$' then
    raise exception 'Enter a 5-digit ZIP code' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;
  insert into ogevia.client_locations (client_id, organization_id, zip, updated_by, updated_at)
  values (p_client_id, p_organization_id, p_zip, ogevia.require_actor(), now())
  on conflict (client_id) do update set zip = excluded.zip, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform ogevia.write_audit(p_organization_id, 'client_location.set', 'clients', p_client_id, null, jsonb_build_object('changed', true), null);
end;
$$;

create function ogevia_api.set_caregiver_location(p_organization_id uuid, p_caregiver_record_id uuid, p_zip text, p_travel_limit_miles integer)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then
    raise exception 'You do not have permission to set a caregiver location' using errcode = 'OGA03';
  end if;
  if p_zip is null or p_zip !~ '^[0-9]{5}$' then
    raise exception 'Enter a 5-digit ZIP code' using errcode = 'OGV22';
  end if;
  if p_travel_limit_miles is not null and p_travel_limit_miles not between 1 and 500 then
    raise exception 'A travel limit must be between 1 and 500 miles' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Care Team member not found' using errcode = 'OGN04';
  end if;
  insert into ogevia.caregiver_locations (caregiver_record_id, organization_id, zip, travel_limit_miles, updated_by, updated_at)
  values (p_caregiver_record_id, p_organization_id, p_zip, p_travel_limit_miles, ogevia.require_actor(), now())
  on conflict (caregiver_record_id) do update set zip = excluded.zip, travel_limit_miles = excluded.travel_limit_miles,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform ogevia.write_audit(p_organization_id, 'caregiver_location.set', 'caregiver_records', p_caregiver_record_id, null,
    jsonb_build_object('changed', true, 'travel_limit_miles', p_travel_limit_miles), null);
end;
$$;

-- Administrators read a stored ZIP only to edit it; schedulers never see it.
create function ogevia_api.get_caregiver_location(p_organization_id uuid, p_caregiver_record_id uuid)
returns table (zip text, travel_limit_miles integer, updated_at timestamptz, coordinates_known boolean)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then
    raise exception 'You do not have permission to see a caregiver location' using errcode = 'OGA03';
  end if;
  return query select l.zip, l.travel_limit_miles, l.updated_at, exists (select 1 from ogevia.zip_centroids z where z.zip = l.zip)
    from ogevia.caregiver_locations l where l.caregiver_record_id = p_caregiver_record_id and l.organization_id = p_organization_id;
end;
$$;

create function ogevia_api.get_client_location(p_organization_id uuid, p_client_id uuid)
returns table (zip text, updated_at timestamptz, coordinates_known boolean)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then
    raise exception 'You do not have permission to see a client location' using errcode = 'OGA03';
  end if;
  return query select l.zip, l.updated_at, exists (select 1 from ogevia.zip_centroids z where z.zip = l.zip)
    from ogevia.client_locations l where l.client_id = p_client_id and l.organization_id = p_organization_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function ogevia.match_settings(uuid) from public;
revoke all on function ogevia.caregiver_experience_guard_update() from public;
revoke all on function ogevia.client_support_guard_update() from public;
revoke all on function ogevia.approx_distance_miles(text, text) from public;
revoke all on function ogevia.availability_covered_minutes(uuid, uuid, text, timestamptz, timestamptz, date, date) from public;
revoke all on function ogevia.caregiver_verified_tags(uuid, uuid) from public;
revoke all on function ogevia.match_candidate(uuid, uuid, uuid, uuid, jsonb, uuid, boolean) from public;
revoke all on function ogevia_api.list_match_candidates(uuid, uuid, uuid, jsonb, uuid) from public;
revoke all on function ogevia_api.record_assignment_decision(uuid, uuid, uuid, uuid, jsonb, text, uuid, text, text, uuid, boolean) from public;
revoke all on function ogevia_api.record_decision_for_shift(uuid, uuid, text, text) from public;
revoke all on function ogevia_api.record_decision_for_care_request(uuid, uuid, text, text) from public;
revoke all on function ogevia_api.record_decision_for_series(uuid, uuid, text, text) from public;
revoke all on function ogevia_api.list_assignment_decisions(uuid, uuid) from public;
revoke all on function ogevia_api.get_match_settings(uuid) from public;
revoke all on function ogevia_api.set_match_settings(uuid, numeric, boolean, text) from public;
revoke all on function ogevia_api.create_experience_tag(uuid, text) from public;
revoke all on function ogevia_api.set_experience_tag_active(uuid, uuid, boolean, text) from public;
revoke all on function ogevia_api.list_experience_tags(uuid) from public;
revoke all on function ogevia_api.record_experience(uuid, uuid, uuid, text, boolean) from public;
revoke all on function ogevia_api.review_experience(uuid, text, text) from public;
revoke all on function ogevia_api.mark_experience_reviewed(uuid, uuid) from public;
revoke all on function ogevia_api.list_caregiver_experience(uuid, uuid) from public;
revoke all on function ogevia_api.set_client_support_preference(uuid, uuid, uuid, integer, boolean, text) from public;
revoke all on function ogevia_api.remove_client_support_preference(uuid, text) from public;
revoke all on function ogevia_api.list_client_support_preferences(uuid, uuid) from public;
revoke all on function ogevia_api.set_client_location(uuid, uuid, text) from public;
revoke all on function ogevia_api.set_caregiver_location(uuid, uuid, text, integer) from public;
revoke all on function ogevia_api.get_caregiver_location(uuid, uuid) from public;
revoke all on function ogevia_api.get_client_location(uuid, uuid) from public;
grant execute on function ogevia_api.list_match_candidates(uuid, uuid, uuid, jsonb, uuid) to ogevia_app;
grant execute on function ogevia_api.record_assignment_decision(uuid, uuid, uuid, uuid, jsonb, text, uuid, text, text, uuid, boolean) to ogevia_app;
grant execute on function ogevia_api.record_decision_for_shift(uuid, uuid, text, text) to ogevia_app;
grant execute on function ogevia_api.record_decision_for_care_request(uuid, uuid, text, text) to ogevia_app;
grant execute on function ogevia_api.record_decision_for_series(uuid, uuid, text, text) to ogevia_app;
grant execute on function ogevia_api.list_assignment_decisions(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.get_match_settings(uuid) to ogevia_app;
grant execute on function ogevia_api.set_match_settings(uuid, numeric, boolean, text) to ogevia_app;
grant execute on function ogevia_api.create_experience_tag(uuid, text) to ogevia_app;
grant execute on function ogevia_api.set_experience_tag_active(uuid, uuid, boolean, text) to ogevia_app;
grant execute on function ogevia_api.list_experience_tags(uuid) to ogevia_app;
grant execute on function ogevia_api.record_experience(uuid, uuid, uuid, text, boolean) to ogevia_app;
grant execute on function ogevia_api.review_experience(uuid, text, text) to ogevia_app;
grant execute on function ogevia_api.mark_experience_reviewed(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_caregiver_experience(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.set_client_support_preference(uuid, uuid, uuid, integer, boolean, text) to ogevia_app;
grant execute on function ogevia_api.remove_client_support_preference(uuid, text) to ogevia_app;
grant execute on function ogevia_api.list_client_support_preferences(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.set_client_location(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.set_caregiver_location(uuid, uuid, text, integer) to ogevia_app;
grant execute on function ogevia_api.get_caregiver_location(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.get_client_location(uuid, uuid) to ogevia_app;
