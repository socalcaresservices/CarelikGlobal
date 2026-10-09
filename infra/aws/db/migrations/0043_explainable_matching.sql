-- 0043 Explainable caregiver matching (caregiver-readiness release).
--
-- ELIGIBILITY FIRST, THEN RANK. The candidate list is built from the same checks as the commit-time gate
-- (0042): caregiver status, Approved services, CPR, TB, approved availability, double-booking and recorded
-- mandatory client requirements. A caregiver who fails a required check is NOT eligible and no score can
-- change that. Eligibility and score are returned separately.
--
-- The score is advisory, explained component by component, and PROVISIONAL (rule version recorded):
--     availability 50 | location 25 | experience 25      (scoring_rule_versions, status 'provisional')
--   * availability = share of the requested occurrences the caregiver is eligible for. For a fully covered
--     single shift every eligible caregiver gets the same value, so it does not rank anyone (see the
--     worked examples in docs/releases/caregiver-readiness/MATCHING_WORKED_EXAMPLES.md).
--   * location = "Approx. distance" between ZIP centroids, only when a centroid dataset with a recorded
--     source, licence and vintage has been loaded AND both ZIPs are recorded. No dataset ships with Ogevia and no
--     external geocoding is used. The 25-mile figure only shapes points; it is not a travel limit.
--   * experience = share of the client's wanted experience tags that an ADMINISTRATOR has confirmed on the
--     caregiver. A tag the caregiver reported but nobody reviewed earns no points. A tag is never treated as
--     a certification or clinical qualification. "Not reviewed" (missing) is different from "reviewed, no match" (0).
--   * A missing input is never zero and never perfect: the component is 'missing', the candidate shows
--     "Score incomplete", and when any eligible candidate is incomplete the list is ordered without the score.
--   * Ties break the same way every time: higher score, then already assigned to this client, then fewer
--     minutes already scheduled that week, then caregiver code.
--   * A client's MANDATORY experience is a gate (through ogevia.client_requirement_issues), never bonus points.
--
-- Addresses: only a 5-digit ZIP may be recorded (administrators only), never an address. It is never returned by
-- the matching API; screens show only "Approx. distance: N mi".

insert into ogevia.permissions (key, description) values
  ('matching.read', 'See ranked caregiver candidates for a client, service and time'),
  ('matching.manage', 'Manage experience tags, review caregiver experience, set client experience wishes and ZIPs'),
  ('experience.report_own', 'Report your own experience tags');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'matching.read'),
  ('manager', 'matching.read'),
  ('scheduler', 'matching.read'),
  ('organization_owner', 'matching.manage'),
  ('manager', 'matching.manage'),
  ('caregiver', 'experience.report_own');

create table ogevia.scoring_rule_versions (
  version text primary key,
  status text not null check (status in ('provisional', 'approved', 'retired')),
  weights jsonb not null,
  parameters jsonb not null,
  description text not null,
  created_at timestamptz not null default now()
);
insert into ogevia.scoring_rule_versions (version, status, weights, parameters, description) values
  ('v0-provisional-50-25-25', 'provisional',
   '{"availability": 50, "location": 25, "experience": 25}',
   '{"location_soft_radius_miles": 25, "location_radius_is_travel_limit": false}',
   'Provisional weights for review. Not an approved ranking policy.');
alter table ogevia.scoring_rule_versions enable row level security;

create table ogevia.experience_tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  label text not null check (length(btrim(label)) between 2 and 60),
  is_active boolean not null default true,
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index experience_tags_org_label on ogevia.experience_tags (organization_id, lower(btrim(label)));

-- status: reported (caregiver said so; no points) | confirmed (administrator reviewed) | not_confirmed (reviewed, not accepted)
create table ogevia.caregiver_experience (
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  tag_id uuid not null,
  status text not null check (status in ('reported', 'confirmed', 'not_confirmed')),
  reported_by uuid references ogevia.app_users(id),
  reported_at timestamptz,
  reviewed_by uuid references ogevia.app_users(id),
  reviewed_at timestamptz,
  primary key (caregiver_record_id, tag_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  foreign key (tag_id, organization_id) references ogevia.experience_tags (id, organization_id),
  constraint caregiver_experience_review_shape check ((status = 'reported') = (reviewed_at is null))
);

-- The administrator has looked at this caregiver's experience (even when nothing matched).
create table ogevia.caregiver_experience_reviews (
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid primary key,
  reviewed_by uuid not null references ogevia.app_users(id),
  reviewed_at timestamptz not null default now(),
  note text,
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);

create table ogevia.client_experience_requirements (
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  tag_id uuid not null,
  mandatory boolean not null default false,
  set_by uuid not null references ogevia.app_users(id),
  set_at timestamptz not null default now(),
  primary key (client_id, tag_id),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  foreign key (tag_id, organization_id) references ogevia.experience_tags (id, organization_id)
);

create table ogevia.caregiver_zip (
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid primary key,
  zip text not null check (zip ~ '^[0-9]{5}$'),
  set_by uuid not null references ogevia.app_users(id),
  set_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);
create table ogevia.client_service_zip (
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid primary key,
  zip text not null check (zip ~ '^[0-9]{5}$'),
  set_by uuid not null references ogevia.app_users(id),
  set_at timestamptz not null default now(),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id)
);

-- Reference data shared by all agencies; EMPTY until an administrator of the platform loads a dataset whose
-- source, licence and vintage are recorded on every row. No dataset ships with Ogevia.
create table ogevia.zip_centroids (
  zip text primary key check (zip ~ '^[0-9]{5}$'),
  lat numeric(9, 6) not null check (lat between -90 and 90),
  lon numeric(9, 6) not null check (lon between -180 and 180),
  source text not null check (length(btrim(source)) >= 3),
  licence text not null check (length(btrim(licence)) >= 3),
  vintage text not null check (length(btrim(vintage)) >= 2),
  loaded_at timestamptz not null default now()
);
alter table ogevia.experience_tags enable row level security;
alter table ogevia.caregiver_experience enable row level security;
alter table ogevia.caregiver_experience_reviews enable row level security;
alter table ogevia.client_experience_requirements enable row level security;
alter table ogevia.caregiver_zip enable row level security;
alter table ogevia.client_service_zip enable row level security;
alter table ogevia.zip_centroids enable row level security;

create function ogevia.matching_manage_guard(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'matching.manage') then
    raise exception 'You do not have permission to manage matching information' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

-- ---------------------------------------------------------------------------
-- Mandatory client requirements become a GATE (replaces the empty 0042 hook)
-- ---------------------------------------------------------------------------
create or replace function ogevia.client_requirement_issues(p_organization_id uuid, p_client_id uuid, p_caregiver_record_id uuid)
returns table (code text, message text)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select 'experience_not_confirmed'::text, 'Required experience not confirmed: ' || t.label || '.'
  from ogevia.client_experience_requirements r
  join ogevia.experience_tags t on t.id = r.tag_id
  where r.organization_id = p_organization_id and r.client_id = p_client_id and r.mandatory
    and not exists (select 1 from ogevia.caregiver_experience e
                    where e.caregiver_record_id = p_caregiver_record_id and e.tag_id = r.tag_id and e.status = 'confirmed')
  order by t.label;
$$;

-- ---------------------------------------------------------------------------
-- Experience, ZIP and client wishes: small, audited administration
-- ---------------------------------------------------------------------------

create function ogevia_api.create_experience_tag(p_organization_id uuid, p_label text)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.matching_manage_guard(p_organization_id); v_id uuid := gen_random_uuid(); v_label text := btrim(coalesce(p_label, ''));
begin
  if length(v_label) < 2 or length(v_label) > 60 then raise exception 'Enter a tag name of 2 to 60 characters' using errcode = 'OGV22'; end if;
  if exists (select 1 from ogevia.experience_tags t where t.organization_id = p_organization_id and lower(btrim(t.label)) = lower(v_label)) then
    raise exception 'That tag already exists' using errcode = 'OGC09';
  end if;
  insert into ogevia.experience_tags (id, organization_id, label, created_by) values (v_id, p_organization_id, v_label, v_actor);
  perform ogevia.write_audit(p_organization_id, 'experience_tag.created', 'experience_tags', v_id, null, jsonb_build_object('label', v_label), null);
  return v_id;
end;
$$;

create function ogevia_api.list_experience_tags(p_organization_id uuid)
returns table (tag_id uuid, label text)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'matching.read') or ogevia.has_permission(p_organization_id, 'experience.report_own')) then
    raise exception 'Forbidden' using errcode = 'OGA03';
  end if;
  return query select t.id, t.label from ogevia.experience_tags t where t.organization_id = p_organization_id and t.is_active order by lower(t.label);
end;
$$;

-- A caregiver reports their own experience. Reports never earn points and never touch a reviewed row.
create function ogevia_api.report_my_experience(p_organization_id uuid, p_tag_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare v_rec uuid; v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'experience.report_own') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  v_rec := ogevia.my_caregiver_record(p_organization_id);
  if v_rec is null then raise exception 'Caregiver record not found' using errcode = 'OGN04'; end if;
  if cardinality(coalesce(p_tag_ids, '{}')) > 40 then raise exception 'Choose at most 40 tags' using errcode = 'OGV22'; end if;
  if exists (select 1 from unnest(coalesce(p_tag_ids, '{}')) x where not exists
             (select 1 from ogevia.experience_tags t where t.id = x and t.organization_id = p_organization_id and t.is_active)) then
    raise exception 'A selected tag was not found' using errcode = 'OGN04';
  end if;
  delete from ogevia.caregiver_experience e where e.caregiver_record_id = v_rec and e.status = 'reported'
    and e.tag_id <> all (coalesce(p_tag_ids, '{}'));
  insert into ogevia.caregiver_experience (organization_id, caregiver_record_id, tag_id, status, reported_by, reported_at)
  select p_organization_id, v_rec, x, 'reported', v_actor, now() from unnest(coalesce(p_tag_ids, '{}')) x
  on conflict (caregiver_record_id, tag_id) do nothing;
  perform ogevia.write_audit(p_organization_id, 'caregiver_experience.reported', 'caregiver_records', v_rec, null,
    jsonb_build_object('tag_count', cardinality(coalesce(p_tag_ids, '{}'))), null);
end;
$$;

-- An administrator confirms which of a caregiver's tags are accepted (and marks the profile as reviewed).
create function ogevia_api.review_caregiver_experience(p_organization_id uuid, p_caregiver_record_id uuid, p_confirmed_tag_ids uuid[], p_note text default null)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.matching_manage_guard(p_organization_id);
begin
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Caregiver not found' using errcode = 'OGN04';
  end if;
  if exists (select 1 from unnest(coalesce(p_confirmed_tag_ids, '{}')) x where not exists
             (select 1 from ogevia.experience_tags t where t.id = x and t.organization_id = p_organization_id and t.is_active)) then
    raise exception 'A selected tag was not found' using errcode = 'OGN04';
  end if;
  perform ogevia.lock_caregiver(p_caregiver_record_id);
  insert into ogevia.caregiver_experience (organization_id, caregiver_record_id, tag_id, status, reviewed_by, reviewed_at)
  select p_organization_id, p_caregiver_record_id, x, 'confirmed', v_actor, now() from unnest(coalesce(p_confirmed_tag_ids, '{}')) x
  on conflict (caregiver_record_id, tag_id) do update set status = 'confirmed', reviewed_by = v_actor, reviewed_at = now();
  update ogevia.caregiver_experience e set status = 'not_confirmed', reviewed_by = v_actor, reviewed_at = now()
   where e.caregiver_record_id = p_caregiver_record_id and e.tag_id <> all (coalesce(p_confirmed_tag_ids, '{}'));
  insert into ogevia.caregiver_experience_reviews (organization_id, caregiver_record_id, reviewed_by, note)
  values (p_organization_id, p_caregiver_record_id, v_actor, nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (caregiver_record_id) do update set reviewed_by = v_actor, reviewed_at = now(), note = nullif(btrim(coalesce(p_note, '')), '');
  perform ogevia.write_audit(p_organization_id, 'caregiver_experience.reviewed', 'caregiver_records', p_caregiver_record_id, null,
    jsonb_build_object('confirmed_count', cardinality(coalesce(p_confirmed_tag_ids, '{}'))), nullif(btrim(coalesce(p_note, '')), ''));
end;
$$;

create function ogevia_api.get_caregiver_experience(p_organization_id uuid, p_caregiver_record_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_rec uuid;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if p_caregiver_record_id is null then
    if not ogevia.has_permission(p_organization_id, 'experience.report_own') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
    v_rec := ogevia.my_caregiver_record(p_organization_id);
    if v_rec is null then raise exception 'Caregiver record not found' using errcode = 'OGN04'; end if;
  else
    if not ogevia.has_permission(p_organization_id, 'matching.read') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
    v_rec := p_caregiver_record_id;
    if not exists (select 1 from ogevia.caregiver_records r where r.id = v_rec and r.organization_id = p_organization_id and r.deleted_at is null) then
      raise exception 'Caregiver not found' using errcode = 'OGN04';
    end if;
  end if;
  return jsonb_build_object(
    'caregiverRecordId', v_rec,
    'reviewed', exists (select 1 from ogevia.caregiver_experience_reviews x where x.caregiver_record_id = v_rec),
    'reviewedAt', (select x.reviewed_at from ogevia.caregiver_experience_reviews x where x.caregiver_record_id = v_rec),
    'tags', coalesce((select jsonb_agg(jsonb_build_object('tagId', t.id, 'label', t.label, 'status', e.status) order by lower(t.label))
                      from ogevia.caregiver_experience e join ogevia.experience_tags t on t.id = e.tag_id where e.caregiver_record_id = v_rec), '[]'::jsonb));
end;
$$;

create function ogevia_api.set_client_experience_requirements(p_organization_id uuid, p_client_id uuid, p_requirements jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.matching_manage_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  r record;
begin
  if length(v_reason) < 3 then raise exception 'Enter a reason for the change' using errcode = 'OGV22'; end if;
  if p_requirements is null or jsonb_typeof(p_requirements) <> 'array' or jsonb_array_length(p_requirements) > 20 then
    raise exception 'Requirements must be a list of at most 20 tags' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;
  for r in select (x ->> 'tagId')::uuid as tag_id, coalesce((x ->> 'mandatory')::boolean, false) as mandatory from jsonb_array_elements(p_requirements) x loop
    if not exists (select 1 from ogevia.experience_tags t where t.id = r.tag_id and t.organization_id = p_organization_id and t.is_active) then
      raise exception 'A selected tag was not found' using errcode = 'OGN04';
    end if;
  end loop;
  delete from ogevia.client_experience_requirements where client_id = p_client_id;
  insert into ogevia.client_experience_requirements (organization_id, client_id, tag_id, mandatory, set_by)
  select p_organization_id, p_client_id, (x ->> 'tagId')::uuid, coalesce((x ->> 'mandatory')::boolean, false), v_actor from jsonb_array_elements(p_requirements) x;
  perform ogevia.write_audit(p_organization_id, 'client_experience.set', 'clients', p_client_id, null,
    jsonb_build_object('count', jsonb_array_length(p_requirements), 'mandatory', (select count(*) from jsonb_array_elements(p_requirements) x where coalesce((x ->> 'mandatory')::boolean, false))), v_reason);
end;
$$;

create function ogevia_api.get_client_experience_requirements(p_organization_id uuid, p_client_id uuid)
returns table (tag_id uuid, label text, mandatory boolean)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'matching.read') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  return query select r.tag_id, t.label, r.mandatory from ogevia.client_experience_requirements r join ogevia.experience_tags t on t.id = r.tag_id
               where r.organization_id = p_organization_id and r.client_id = p_client_id order by r.mandatory desc, lower(t.label);
end;
$$;

create function ogevia_api.set_caregiver_zip(p_organization_id uuid, p_caregiver_record_id uuid, p_zip text)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.matching_manage_guard(p_organization_id);
begin
  if p_zip !~ '^[0-9]{5}$' then raise exception 'Enter a 5-digit ZIP code' using errcode = 'OGV22'; end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Caregiver not found' using errcode = 'OGN04';
  end if;
  insert into ogevia.caregiver_zip (organization_id, caregiver_record_id, zip, set_by) values (p_organization_id, p_caregiver_record_id, p_zip, v_actor)
  on conflict (caregiver_record_id) do update set zip = excluded.zip, set_by = v_actor, set_at = now();
  perform ogevia.write_audit(p_organization_id, 'caregiver_zip.set', 'caregiver_records', p_caregiver_record_id, null, jsonb_build_object('zip_set', true), null);
end;
$$;

create function ogevia_api.set_client_service_zip(p_organization_id uuid, p_client_id uuid, p_zip text)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.matching_manage_guard(p_organization_id);
begin
  if p_zip !~ '^[0-9]{5}$' then raise exception 'Enter a 5-digit ZIP code' using errcode = 'OGV22'; end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;
  insert into ogevia.client_service_zip (organization_id, client_id, zip, set_by) values (p_organization_id, p_client_id, p_zip, v_actor)
  on conflict (client_id) do update set zip = excluded.zip, set_by = v_actor, set_at = now();
  perform ogevia.write_audit(p_organization_id, 'client_zip.set', 'clients', p_client_id, null, jsonb_build_object('zip_set', true), null);
end;
$$;

-- What distance data exists (counts and provenance only; never a ZIP).
create function ogevia_api.location_data_status(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'matching.read') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  return jsonb_build_object(
    'distanceDataLoaded', exists (select 1 from ogevia.zip_centroids),
    'sources', coalesce((select jsonb_agg(distinct jsonb_build_object('source', c.source, 'licence', c.licence, 'vintage', c.vintage)) from ogevia.zip_centroids c), '[]'::jsonb),
    'caregiversWithZip', (select count(*) from ogevia.caregiver_zip z where z.organization_id = p_organization_id),
    'clientsWithZip', (select count(*) from ogevia.client_service_zip z where z.organization_id = p_organization_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- The matching engine
-- ---------------------------------------------------------------------------

-- Straight-line miles between two ZIP centroids; null when either ZIP is not in the loaded dataset.
create function ogevia.zip_distance_miles(p_zip_a text, p_zip_b text)
returns numeric
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select 3958.8 * 2 * asin(least(1, sqrt(
           power(sin(radians(b.lat - a.lat) / 2), 2) + cos(radians(a.lat)) * cos(radians(b.lat)) * power(sin(radians(b.lon - a.lon) / 2), 2))))
  from ogevia.zip_centroids a, ogevia.zip_centroids b where a.zip = p_zip_a and b.zip = p_zip_b;
$$;

-- Ranked candidates for a client, service and one or more occurrences (a single shift is one occurrence).
-- Returns jsonb { ruleVersion, ruleStatus, rankedByScore, candidates: [...] }. Nothing is changed.
create function ogevia_api.match_caregivers(
  p_organization_id uuid, p_service_id uuid, p_client_id uuid, p_intervals jsonb, p_care_request_id uuid default null, p_rule_version text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_rule ogevia.scoring_rule_versions%rowtype;
  v_w_av numeric; v_w_loc numeric; v_w_exp numeric; v_radius numeric;
  v_ctx text;
  v_n integer;
  v_tz text;
  c record;
  iv record;
  k record;
  v_total integer;
  v_ok integer;
  v_unc jsonb;
  v_checks jsonb;
  v_warn jsonb;
  v_elig text;
  v_pts_av numeric; v_pts_loc numeric; v_pts_exp numeric;
  v_st_loc text; v_re_loc text; v_st_exp text; v_re_exp text;
  v_cz text; v_clz text; v_miles numeric;
  v_wanted integer; v_matched integer; v_reviewed boolean;
  v_complete boolean; v_sum numeric; v_applicable numeric;
  v_components jsonb;
  v_cands jsonb := '[]'::jsonb;
  v_ranked_by_score boolean;
  v_mins bigint;
  v_cont boolean;
  v_exp_applicable boolean;
  v_dataset boolean;
  v_failed jsonb;
  v_blocked_names text[];
  v_occ_ok boolean;
  v_first timestamptz;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'matching.read') or ogevia.has_permission(p_organization_id, 'care_requests.manage')
          or ogevia.has_permission(p_organization_id, 'shifts.manage')) then
    raise exception 'Forbidden' using errcode = 'OGA03';
  end if;
  if p_intervals is null or jsonb_typeof(p_intervals) <> 'array' or jsonb_array_length(p_intervals) not between 1 and 30 then
    raise exception 'Give between 1 and 30 time ranges' using errcode = 'OGV22';
  end if;
  v_n := jsonb_array_length(p_intervals);
  v_ctx := case when p_care_request_id is not null then 'care_request' when v_n > 1 then 'series' else 'shift' end;
  select * into v_rule from ogevia.scoring_rule_versions s where s.version = coalesce(p_rule_version, 'v0-provisional-50-25-25') and s.status <> 'retired';
  if v_rule.version is null then raise exception 'Unknown scoring rule' using errcode = 'OGV22'; end if;
  v_w_av := (v_rule.weights ->> 'availability')::numeric; v_w_loc := (v_rule.weights ->> 'location')::numeric; v_w_exp := (v_rule.weights ->> 'experience')::numeric;
  v_radius := (v_rule.parameters ->> 'location_soft_radius_miles')::numeric;
  if not exists (select 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id and s.deleted_at is null)
     or not exists (select 1 from ogevia.clients cl where cl.id = p_client_id and cl.organization_id = p_organization_id and cl.deleted_at is null) then
    raise exception 'Client or service not found' using errcode = 'OGN04';
  end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  v_exp_applicable := exists (select 1 from ogevia.client_experience_requirements r where r.client_id = p_client_id);
  v_dataset := exists (select 1 from ogevia.zip_centroids);
  select z.zip into v_clz from ogevia.client_service_zip z where z.client_id = p_client_id;
  select (x ->> 'starts_at')::timestamptz into v_first from jsonb_array_elements(p_intervals) x limit 1;

  for c in
    select r.id, r.caregiver_code, r.linked_user_id, concat_ws(' ', coalesce(r.preferred_name, r.first_name), r.last_name) as name
    from ogevia.caregiver_records r
    where r.organization_id = p_organization_id and r.deleted_at is null and r.status in ('ready', 'active')
      and not exists (select 1 from ogevia.care_request_offers oo where p_care_request_id is not null and oo.care_request_id = p_care_request_id
                      and oo.caregiver_record_id = r.id and oo.status in ('not_available', 'cancelled'))
  loop
    v_total := 0; v_ok := 0; v_unc := '[]'::jsonb; v_failed := '{}'::jsonb; v_warn := '[]'::jsonb;
    for iv in select (x ->> 'starts_at')::timestamptz as s, (x ->> 'ends_at')::timestamptz as e from jsonb_array_elements(p_intervals) x loop
      if iv.s is null or iv.e is null or iv.e <= iv.s then raise exception 'Every time range needs a start and a later end' using errcode = 'OGV22'; end if;
      v_total := v_total + 1;
      v_occ_ok := true;
      for k in select * from ogevia.readiness_checks(p_organization_id, c.id, p_service_id, iv.s, iv.e, v_ctx, null, p_client_id, true) loop
        if k.status = 'blocked' and (k.enforced or k.check_name in ('availability', 'conflict')) then
          v_occ_ok := false;
          if not (v_failed ? k.check_name) then
            v_failed := v_failed || jsonb_build_object(k.check_name, jsonb_build_object('status', 'blocked', 'code', k.code, 'message', k.message, 'occurrences', 1));
          else
            v_failed := jsonb_set(v_failed, array[k.check_name, 'occurrences'], to_jsonb(((v_failed -> k.check_name ->> 'occurrences')::int) + 1));
          end if;
        elsif k.status = 'blocked' and not k.enforced then
          if not (v_warn @> jsonb_build_array(jsonb_build_object('check', k.check_name, 'message', k.message))) then
            v_warn := v_warn || jsonb_build_object('check', k.check_name, 'message', k.message);
          end if;
        end if;
      end loop;
      if v_occ_ok then v_ok := v_ok + 1;
      else v_unc := v_unc || to_jsonb((iv.s at time zone v_tz)::date); end if;
    end loop;
    v_elig := case when v_ok = v_total then 'eligible' when v_ok > 0 then 'partial' else 'not_eligible' end;
    select coalesce(jsonb_agg(jsonb_build_object('check', f.key, 'status', 'blocked', 'code', f.value ->> 'code', 'message', f.value ->> 'message',
                                                 'occurrences', (f.value ->> 'occurrences')::int) order by f.key), '[]'::jsonb)
      into v_checks from jsonb_each(v_failed) f;

    -- Availability component: share of occurrences the caregiver is eligible for.
    v_pts_av := v_w_av * v_ok / v_total;

    -- Location component
    select z.zip into v_cz from ogevia.caregiver_zip z where z.caregiver_record_id = c.id;
    if not v_dataset then v_st_loc := 'missing'; v_re_loc := 'Distance data is not loaded.'; v_pts_loc := null;
    elsif v_clz is null then v_st_loc := 'missing'; v_re_loc := 'Client ZIP is not recorded.'; v_pts_loc := null;
    elsif v_cz is null then v_st_loc := 'missing'; v_re_loc := 'Caregiver ZIP is not recorded.'; v_pts_loc := null;
    else
      v_miles := ogevia.zip_distance_miles(v_cz, v_clz);
      if v_miles is null then v_st_loc := 'missing'; v_re_loc := 'A ZIP is not in the loaded distance data.'; v_pts_loc := null;
      else
        v_st_loc := 'scored'; v_pts_loc := round(v_w_loc * greatest(0, 1 - v_miles / v_radius), 2);
        v_re_loc := 'Approx. distance ' || round(v_miles)::text || ' mi';
      end if;
    end if;

    -- Experience component
    if not v_exp_applicable then
      v_st_exp := 'not_applicable'; v_re_exp := 'The client has no experience wishes recorded.'; v_pts_exp := null;
    else
      v_reviewed := exists (select 1 from ogevia.caregiver_experience_reviews x where x.caregiver_record_id = c.id);
      if not v_reviewed then v_st_exp := 'missing'; v_re_exp := 'Experience has not been reviewed.'; v_pts_exp := null;
      else
        select count(*), count(*) filter (where exists (select 1 from ogevia.caregiver_experience e where e.caregiver_record_id = c.id and e.tag_id = r.tag_id and e.status = 'confirmed'))
          into v_wanted, v_matched from ogevia.client_experience_requirements r where r.client_id = p_client_id;
        v_st_exp := 'scored'; v_pts_exp := round(v_w_exp * v_matched / v_wanted, 2);
        v_re_exp := case when v_matched = 0 then 'Reviewed: no matching experience.' else v_matched::text || ' of ' || v_wanted::text || ' wanted experience tags confirmed.' end;
      end if;
    end if;

    v_components := jsonb_build_array(
      jsonb_build_object('name', 'availability', 'weight', v_w_av, 'points', v_pts_av, 'status', 'scored',
                         'reason', v_ok::text || ' of ' || v_total::text || ' ' || case when v_total = 1 then 'time range' else 'dates' end || ' covered'),
      jsonb_build_object('name', 'location', 'weight', v_w_loc, 'points', v_pts_loc, 'status', v_st_loc, 'reason', v_re_loc),
      jsonb_build_object('name', 'experience', 'weight', v_w_exp, 'points', v_pts_exp, 'status', v_st_exp, 'reason', v_re_exp));
    v_complete := v_st_loc <> 'missing' and v_st_exp <> 'missing';
    v_applicable := v_w_av + (case when v_st_loc <> 'not_applicable' then v_w_loc else 0 end) + (case when v_st_exp <> 'not_applicable' then v_w_exp else 0 end);
    v_sum := v_pts_av + coalesce(v_pts_loc, 0) + coalesce(v_pts_exp, 0);

    select coalesce(sum(sh.minutes), 0) into v_mins from (
      select extract(epoch from (least(s.ends_at, date_trunc('week', v_first at time zone v_tz) at time zone v_tz + interval '7 days')
                                  - greatest(s.starts_at, date_trunc('week', v_first at time zone v_tz) at time zone v_tz))) / 60 as minutes
      from ogevia.shifts s
      where s.organization_id = p_organization_id and s.caregiver_record_id = c.id and s.status in ('scheduled', 'completed')
        and s.starts_at < date_trunc('week', v_first at time zone v_tz) at time zone v_tz + interval '7 days'
        and s.ends_at > date_trunc('week', v_first at time zone v_tz) at time zone v_tz) sh;
    v_cont := exists (select 1 from ogevia.caregiver_assignments a where a.organization_id = p_organization_id and a.client_id = p_client_id
                      and a.service_id = p_service_id and a.is_active and (a.caregiver_record_id = c.id or a.caregiver_user_id = c.linked_user_id));

    v_cands := v_cands || jsonb_build_object(
      'caregiverRecordId', c.id, 'caregiverCode', c.caregiver_code, 'name', c.name,
      'eligibility', v_elig,
      'coverage', jsonb_build_object('covered', v_ok, 'total', v_total, 'uncoveredDates', v_unc),
      'blockedChecks', v_checks, 'warnings', v_warn,
      'assignedToClient', v_cont, 'scheduledMinutesThatWeek', round(v_mins),
      'score', jsonb_build_object('ruleVersion', v_rule.version, 'ruleStatus', v_rule.status, 'components', v_components,
                                  'complete', v_complete, 'label', case when v_complete then null else 'Score incomplete' end,
                                  'total', case when v_complete and v_applicable > 0 then round(100 * v_sum / v_applicable, 1) end));
  end loop;

  -- Eligibility groups first; score ranking is used only when every ELIGIBLE candidate has a complete, comparable score.
  v_ranked_by_score := not exists (select 1 from jsonb_array_elements(v_cands) x where x ->> 'eligibility' = 'eligible' and not (x #>> '{score,complete}')::boolean);
  return jsonb_build_object(
    'ruleVersion', v_rule.version, 'ruleStatus', v_rule.status, 'weights', v_rule.weights,
    'rankedByScore', v_ranked_by_score,
    'note', case when v_ranked_by_score then null else 'Score incomplete for at least one eligible caregiver, so the list is not ordered by score.' end,
    'candidates', coalesce((
      select jsonb_agg(x order by
               case x ->> 'eligibility' when 'eligible' then 0 when 'partial' then 1 else 2 end,
               case when v_ranked_by_score then -((x #>> '{score,total}')::numeric) else 0 end,
               case when (x ->> 'assignedToClient')::boolean then 0 else 1 end,
               (x ->> 'scheduledMinutesThatWeek')::numeric,
               (x ->> 'caregiverCode'), (x ->> 'caregiverRecordId'))
      from jsonb_array_elements(v_cands) x), '[]'::jsonb));
end;
$$;

-- Care-request candidates are now ELIGIBLE caregivers: same columns and order as before (already assigned to this
-- client first, then name), but a caregiver who fails a required check is no longer offered the work.
create or replace function ogevia_api.list_available_caregivers(p_organization_id uuid, p_request_id uuid)
returns table(caregiver_record_id uuid, caregiver_name text, current_client_match boolean, availability_source text)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare r ogevia.care_requests%rowtype; v_res jsonb;
begin
  if not ogevia.has_permission(p_organization_id, 'care_requests.manage') then return; end if;
  select * into r from ogevia.care_requests x where x.id = p_request_id and x.organization_id = p_organization_id;
  if r.id is null then return; end if;
  v_res := ogevia_api.match_caregivers(p_organization_id, r.service_id, r.client_id,
             jsonb_build_array(jsonb_build_object('starts_at', r.starts_at, 'ends_at', r.ends_at)), r.id, null);
  return query
  select (x ->> 'caregiverRecordId')::uuid, x ->> 'name', (x ->> 'assignedToClient')::boolean,
         case when exists (select 1 from ogevia.caregiver_availability_windows w where w.caregiver_record_id = (x ->> 'caregiverRecordId')::uuid
                           and w.specific_date = ogevia.organization_local_date(p_organization_id, r.starts_at)) then 'date-specific' else 'recurring' end
  from jsonb_array_elements(v_res -> 'candidates') x
  where x ->> 'eligibility' = 'eligible'
  order by 3 desc, 2;
end;
$$;

revoke all on function ogevia.matching_manage_guard(uuid) from public;
revoke all on function ogevia.zip_distance_miles(text, text) from public;
revoke all on function ogevia_api.create_experience_tag(uuid, text) from public;
revoke all on function ogevia_api.list_experience_tags(uuid) from public;
revoke all on function ogevia_api.report_my_experience(uuid, uuid[]) from public;
revoke all on function ogevia_api.review_caregiver_experience(uuid, uuid, uuid[], text) from public;
revoke all on function ogevia_api.get_caregiver_experience(uuid, uuid) from public;
revoke all on function ogevia_api.set_client_experience_requirements(uuid, uuid, jsonb, text) from public;
revoke all on function ogevia_api.get_client_experience_requirements(uuid, uuid) from public;
revoke all on function ogevia_api.set_caregiver_zip(uuid, uuid, text) from public;
revoke all on function ogevia_api.set_client_service_zip(uuid, uuid, text) from public;
revoke all on function ogevia_api.location_data_status(uuid) from public;
revoke all on function ogevia_api.match_caregivers(uuid, uuid, uuid, jsonb, uuid, text) from public;
grant execute on function ogevia_api.create_experience_tag(uuid, text) to ogevia_app;
grant execute on function ogevia_api.list_experience_tags(uuid) to ogevia_app;
grant execute on function ogevia_api.report_my_experience(uuid, uuid[]) to ogevia_app;
grant execute on function ogevia_api.review_caregiver_experience(uuid, uuid, uuid[], text) to ogevia_app;
grant execute on function ogevia_api.get_caregiver_experience(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.set_client_experience_requirements(uuid, uuid, jsonb, text) to ogevia_app;
grant execute on function ogevia_api.get_client_experience_requirements(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.set_caregiver_zip(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.set_client_service_zip(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.location_data_status(uuid) to ogevia_app;
grant execute on function ogevia_api.match_caregivers(uuid, uuid, uuid, jsonb, uuid, text) to ogevia_app;
