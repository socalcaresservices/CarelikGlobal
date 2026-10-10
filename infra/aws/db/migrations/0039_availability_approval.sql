-- 0039 Availability changes need administrator approval (caregiver-readiness release).
--
--   * A caregiver REQUESTS a change to their own availability (weekly hours, or one specific
--     date). A reason and an effective start date are required; a temporary change needs an end
--     date. A pending request never changes approved availability.
--   * Only an administrator (availability.review) approves or declines. Declining needs a note.
--     An administrator may also edit availability directly: a reason is required and the change
--     is recorded as an already-approved request with source 'administrator'. Both are audited
--     with requester, reviewer, timestamps and the approved version.
--   * Approved availability is LAYERED, never overwritten. A later approved layer wins for the
--     dates it covers; older layers and declined/withdrawn/superseded requests stay on record.
--       - A specific-date layer REPLACES that day's weekly hours (it is not a union).
--       - The weekly layer in force for a date is the latest-approved weekly request that covers
--         the date, else the hours the caregiver entered before this release (layer 0).
--   * "Not provided" (no approved hours at all) is distinct from "outside approved hours".
--   * Future scheduled shifts that fall outside the new approved hours are FLAGGED, never moved or
--     cancelled. Approving availability does not assign work or approve a visit.
--   * The old direct replace_my_availability(...) is withdrawn: it deleted every saved
--     exception whenever a caller sent none (the "exception-deletion" defect).
--
-- Table moves are additive. Rollback (rollback/0039) keeps the approved hours as plain legacy
-- rows and copies the request history to ogevia.archived_* tables instead of dropping it.

insert into ogevia.permissions (key, description) values
  ('availability.read', 'View caregivers'' approved availability and availability requests'),
  ('availability.review', 'Approve or decline availability requests and edit availability directly');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'availability.read'),
  ('manager', 'availability.read'),
  ('scheduler', 'availability.read'),
  ('organization_owner', 'availability.review');

create type ogevia.availability_request_status as enum ('pending', 'approved', 'declined', 'withdrawn', 'superseded');

-- One row per caregiver; its version number counts approved changes and is the serialisation point.
create table ogevia.caregiver_availability_state (
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  version integer not null default 0 check (version >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references ogevia.app_users(id),
  primary key (organization_id, caregiver_record_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);

create table ogevia.availability_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  kind text not null check (kind in ('weekly', 'date')),
  status ogevia.availability_request_status not null default 'pending',
  source text not null default 'caregiver' check (source in ('caregiver', 'administrator')),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  effective_from date not null,
  effective_until date,
  is_temporary boolean not null default false,
  -- weekly: [{weekday, start_local, end_local}]; date: [{start_local, end_local}] (empty = unavailable that date)
  windows jsonb not null,
  base_version integer not null check (base_version >= 0),
  requested_by uuid not null references ogevia.app_users(id),
  requested_at timestamptz not null default now(),
  reviewed_by uuid references ogevia.app_users(id),
  reviewed_at timestamptz,
  review_note text,
  self_review boolean not null default false,
  approved_version integer,
  unique (id, organization_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  constraint availability_requests_range check (effective_until is null or effective_until >= effective_from),
  constraint availability_requests_temporary check (
    (kind = 'date' and effective_until = effective_from and is_temporary)
    or (kind = 'weekly' and is_temporary = (effective_until is not null))),
  constraint availability_requests_decision check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null and approved_version is null)
    or (status = 'approved' and reviewed_by is not null and reviewed_at is not null and approved_version is not null)
    or (status = 'declined' and reviewed_by is not null and reviewed_at is not null and length(btrim(coalesce(review_note, ''))) >= 3)
    or (status in ('withdrawn', 'superseded') and reviewed_at is not null))
);
-- One pending weekly request per caregiver; one pending date request per caregiver and date.
create unique index availability_requests_one_pending
  on ogevia.availability_requests (caregiver_record_id, kind, (case when kind = 'date' then effective_from else date '0001-01-01' end))
  where status = 'pending';
create index availability_requests_org_status_idx on ogevia.availability_requests (organization_id, status, requested_at desc);
create index availability_requests_caregiver_idx on ogevia.availability_requests (caregiver_record_id, requested_at desc);

alter table ogevia.caregiver_availability_windows
  add column request_id uuid references ogevia.availability_requests(id);
create index caregiver_availability_request_idx on ogevia.caregiver_availability_windows (request_id) where request_id is not null;

-- Several layers may exist for one date, so the old (organization, caregiver, date) key is replaced.
alter table ogevia.caregiver_unavailable_dates drop constraint caregiver_unavailable_dates_pkey;
alter table ogevia.caregiver_unavailable_dates add column id uuid not null default gen_random_uuid();
alter table ogevia.caregiver_unavailable_dates add primary key (id);
alter table ogevia.caregiver_unavailable_dates add column request_id uuid references ogevia.availability_requests(id);
create unique index caregiver_unavailable_one_per_layer
  on ogevia.caregiver_unavailable_dates (organization_id, caregiver_record_id, unavailable_date,
                                          coalesce(request_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Open flags on future shifts that readiness changes put at risk (availability now; service and
-- document flags use the same table in later migrations). A flag is advice for an administrator;
-- it never moves, cancels or blocks a committed shift.
create table ogevia.shift_readiness_flags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  shift_id uuid not null references ogevia.shifts(id),
  caregiver_record_id uuid not null,
  kind text not null check (kind in ('availability', 'service', 'document')),
  reason_code text not null,
  detail jsonb not null default '{}'::jsonb,
  cause_id uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references ogevia.app_users(id),
  resolution text,
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);
create unique index shift_readiness_flags_one_open on ogevia.shift_readiness_flags (shift_id, kind) where resolved_at is null;
create index shift_readiness_flags_org_open_idx on ogevia.shift_readiness_flags (organization_id, kind) where resolved_at is null;

alter table ogevia.caregiver_availability_state enable row level security;
alter table ogevia.availability_requests enable row level security;
alter table ogevia.shift_readiness_flags enable row level security;

-- The one lock that every commit-time check and every readiness change takes first, per caregiver.
-- (check_shift_caregiver already used this key for overlap protection; it is now shared.)
create function ogevia.lock_caregiver(p_caregiver_record_id uuid)
returns void
language sql
volatile
set search_path = ogevia, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('ogevia.caregiver-schedule:' || p_caregiver_record_id::text, 0));
$$;

-- ---------------------------------------------------------------------------
-- Approved hours, resolved layer by layer (internal; the API functions below are the doors)
-- ---------------------------------------------------------------------------

-- The approved available time ranges touching [p_first_date - 1, p_last_date] (the day before is
-- read because an overnight window can still be running). Per date: the latest-approved
-- specific-date layer REPLACES the weekly hours; unavailable wins a tie at the same layer.
create function ogevia.availability_layer_ranges(
  p_organization_id uuid, p_caregiver_record_id uuid, p_timezone text, p_first_date date, p_last_date date
)
returns setof tstzrange
language sql
stable
set search_path = ogevia, pg_temp
as $$
  with days as (
    select g::date as day from generate_series((p_first_date - 1)::timestamp, p_last_date::timestamp, interval '1 day') g
  ), date_layer as (
    select d.day, x.kind, x.request_id
    from days d
    cross join lateral (
      select c.kind, c.request_id from (
        select 'windows'::text as kind, w.request_id, coalesce(r.approved_version, 0) as v
        from ogevia.caregiver_availability_windows w
        left join ogevia.availability_requests r on r.id = w.request_id
        where w.organization_id = p_organization_id and w.caregiver_record_id = p_caregiver_record_id and w.specific_date = d.day
        union all
        select 'unavailable'::text, u.request_id, coalesce(r.approved_version, 0)
        from ogevia.caregiver_unavailable_dates u
        left join ogevia.availability_requests r on r.id = u.request_id
        where u.organization_id = p_organization_id and u.caregiver_record_id = p_caregiver_record_id and u.unavailable_date = d.day
      ) c
      order by c.v desc, (c.kind = 'unavailable') desc
      limit 1
    ) x
  ), weekly_layer as (
    select d.day, x.request_id
    from days d
    cross join lateral (
      select c.request_id from (
        select r.id as request_id, r.approved_version as v
        from ogevia.availability_requests r
        where r.organization_id = p_organization_id and r.caregiver_record_id = p_caregiver_record_id
          and r.kind = 'weekly' and r.status = 'approved'
          and r.effective_from <= d.day and (r.effective_until is null or d.day <= r.effective_until)
        union all
        select null::uuid, 0
      ) c
      order by c.v desc
      limit 1
    ) x
  )
  select tstzrange(
           (d.day + w.start_local) at time zone p_timezone,
           (d.day + case when w.end_local < w.start_local then 1 else 0 end + w.end_local) at time zone p_timezone,
           '[)')
  from days d
  join ogevia.caregiver_availability_windows w
    on w.organization_id = p_organization_id and w.caregiver_record_id = p_caregiver_record_id
  left join date_layer dl on dl.day = d.day
  left join weekly_layer wl on wl.day = d.day
  where (dl.kind = 'windows' and w.specific_date = d.day and w.request_id is not distinct from dl.request_id)
     or (dl.day is null and w.specific_date is null and w.weekday = extract(dow from d.day)
         and w.request_id is not distinct from wl.request_id);
$$;

-- Whole agency-local days on which the winning specific-date layer is "unavailable". Time on such a
-- day is never available, including the early hours of an overnight window that began the evening
-- before (a request that touches an unavailable date is blocked, as it was before 0039).
create function ogevia.availability_blocked_days(
  p_organization_id uuid, p_caregiver_record_id uuid, p_timezone text, p_first_date date, p_last_date date
)
returns setof tstzrange
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select tstzrange(d.day::timestamp at time zone p_timezone, (d.day + 1)::timestamp at time zone p_timezone, '[)')
  from (select g::date as day from generate_series(p_first_date::timestamp, p_last_date::timestamp, interval '1 day') g) d
  where (
    select c.kind from (
      select 'windows'::text as kind, coalesce(r.approved_version, 0) as v
      from ogevia.caregiver_availability_windows w left join ogevia.availability_requests r on r.id = w.request_id
      where w.organization_id = p_organization_id and w.caregiver_record_id = p_caregiver_record_id and w.specific_date = d.day
      union all
      select 'unavailable'::text, coalesce(r.approved_version, 0)
      from ogevia.caregiver_unavailable_dates u left join ogevia.availability_requests r on r.id = u.request_id
      where u.organization_id = p_organization_id and u.caregiver_record_id = p_caregiver_record_id and u.unavailable_date = d.day
    ) c order by c.v desc, (c.kind = 'unavailable') desc limit 1
  ) = 'unavailable';
$$;

-- Replaces the 0037 function with the same signature: callers (matching) are unchanged.
create or replace function ogevia.availability_covers(
  p_organization_id uuid, p_caregiver_record_id uuid, p_timezone text,
  p_starts timestamptz, p_ends timestamptz, p_first_date date, p_last_date date
)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(
    (coalesce((select range_agg(r) from ogevia.availability_layer_ranges(p_organization_id, p_caregiver_record_id, p_timezone, p_first_date, p_last_date) r), '{}'::tstzmultirange)
     - coalesce((select range_agg(b) from ogevia.availability_blocked_days(p_organization_id, p_caregiver_record_id, p_timezone, p_first_date, p_last_date) b), '{}'::tstzmultirange))
      @> tstzrange(p_starts, p_ends, '[)'),
    false);
$$;

-- 'covered' | 'outside' | 'not_provided' for one interval, in the agency time zone.
create function ogevia.availability_status(
  p_organization_id uuid, p_caregiver_record_id uuid, p_starts timestamptz, p_ends timestamptz
)
returns text
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_tz text;
begin
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  if not exists (select 1 from ogevia.caregiver_availability_windows w
                 where w.organization_id = p_organization_id and w.caregiver_record_id = p_caregiver_record_id) then
    return 'not_provided';
  end if;
  if ogevia.availability_covers(p_organization_id, p_caregiver_record_id, v_tz, p_starts, p_ends,
       (p_starts at time zone v_tz)::date, ((p_ends - interval '1 microsecond') at time zone v_tz)::date) then
    return 'covered';
  end if;
  return 'outside';
end;
$$;

-- The weekly pattern in force on a date, as [{weekday,start_local,end_local}].
create function ogevia.availability_pattern(p_organization_id uuid, p_caregiver_record_id uuid, p_on date)
returns jsonb
language sql
stable
set search_path = ogevia, pg_temp
as $$
  with layer as (
    select c.request_id from (
      select r.id as request_id, r.approved_version as v
      from ogevia.availability_requests r
      where r.organization_id = p_organization_id and r.caregiver_record_id = p_caregiver_record_id
        and r.kind = 'weekly' and r.status = 'approved'
        and r.effective_from <= p_on and (r.effective_until is null or p_on <= r.effective_until)
      union all
      select null::uuid, 0
    ) c order by c.v desc limit 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('weekday', w.weekday, 'start_local', to_char(w.start_local, 'HH24:MI'),
                                               'end_local', to_char(w.end_local, 'HH24:MI'))
                            order by w.weekday, w.start_local), '[]'::jsonb)
  from layer l
  join ogevia.caregiver_availability_windows w
    on w.organization_id = p_organization_id and w.caregiver_record_id = p_caregiver_record_id
   and w.specific_date is null and w.request_id is not distinct from l.request_id;
$$;

-- The hours that apply on one specific date after layering, as [{start_local,end_local}] plus 'unavailable'.
create function ogevia.availability_day(p_organization_id uuid, p_caregiver_record_id uuid, p_on date)
returns jsonb
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_kind text; v_req uuid; v_out jsonb;
begin
  select c.kind, c.request_id into v_kind, v_req from (
    select 'windows'::text as kind, w.request_id, coalesce(r.approved_version, 0) as v
    from ogevia.caregiver_availability_windows w left join ogevia.availability_requests r on r.id = w.request_id
    where w.organization_id = p_organization_id and w.caregiver_record_id = p_caregiver_record_id and w.specific_date = p_on
    union all
    select 'unavailable', u.request_id, coalesce(r.approved_version, 0)
    from ogevia.caregiver_unavailable_dates u left join ogevia.availability_requests r on r.id = u.request_id
    where u.organization_id = p_organization_id and u.caregiver_record_id = p_caregiver_record_id and u.unavailable_date = p_on
  ) c order by c.v desc, (c.kind = 'unavailable') desc limit 1;
  if v_kind = 'unavailable' then
    return jsonb_build_object('source', 'date', 'unavailable', true, 'windows', '[]'::jsonb);
  elsif v_kind = 'windows' then
    select jsonb_agg(jsonb_build_object('start_local', to_char(w.start_local, 'HH24:MI'), 'end_local', to_char(w.end_local, 'HH24:MI')) order by w.start_local)
      into v_out
    from ogevia.caregiver_availability_windows w
    where w.organization_id = p_organization_id and w.caregiver_record_id = p_caregiver_record_id
      and w.specific_date = p_on and w.request_id is not distinct from v_req;
    return jsonb_build_object('source', 'date', 'unavailable', false, 'windows', coalesce(v_out, '[]'::jsonb));
  end if;
  select jsonb_agg(jsonb_build_object('start_local', e ->> 'start_local', 'end_local', e ->> 'end_local') order by e ->> 'start_local')
    into v_out
  from jsonb_array_elements(ogevia.availability_pattern(p_organization_id, p_caregiver_record_id, p_on)) e
  where (e ->> 'weekday')::int = extract(dow from p_on);
  return jsonb_build_object('source', 'weekly', 'unavailable', false, 'windows', coalesce(v_out, '[]'::jsonb));
end;
$$;

-- Validates and normalises a window list; raises OGV22 with a message the caregiver can act on.
create function ogevia.availability_check_windows(p_kind text, p_windows jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ogevia, pg_temp
as $$
declare
  v_out jsonb;
  v_count integer;
  v_max integer;
  r record;
  v_prev_day smallint := -1;
  v_prev_end integer := 0;
begin
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' then
    raise exception 'Hours must be a list of times' using errcode = 'OGV22';
  end if;
  v_count := jsonb_array_length(p_windows);
  v_max := case when p_kind = 'weekly' then 42 else 6 end;
  if v_count > v_max then
    raise exception 'Too many time ranges in one request' using errcode = 'OGV22';
  end if;
  if p_kind = 'weekly' and v_count = 0 then
    raise exception 'Add at least one day and time. To be unavailable on a date, use Specific date.' using errcode = 'OGV22';
  end if;
  for r in
    select x.weekday, x.start_local, x.end_local,
           (extract(hour from x.start_local) * 60 + extract(minute from x.start_local))::int as s,
           (extract(hour from x.end_local) * 60 + extract(minute from x.end_local))::int as e
    from jsonb_to_recordset(p_windows) as x(weekday smallint, start_local time, end_local time)
    order by x.weekday nulls first, x.start_local
  loop
    if r.start_local is null or r.end_local is null then
      raise exception 'Enter a start and end time for every range' using errcode = 'OGV22';
    end if;
    if r.start_local = r.end_local then
      raise exception 'A range cannot start and end at the same time' using errcode = 'OGV22';
    end if;
    if p_kind = 'weekly' and (r.weekday is null or r.weekday not between 0 and 6) then
      raise exception 'Choose a day of the week for every range' using errcode = 'OGV22';
    end if;
    if p_kind = 'date' and r.weekday is not null then
      raise exception 'A specific date takes times only, not a weekday' using errcode = 'OGV22';
    end if;
    if coalesce(r.weekday, -2) = v_prev_day and r.s < v_prev_end then
      raise exception 'Two time ranges on the same day overlap' using errcode = 'OGV22';
    end if;
    v_prev_day := coalesce(r.weekday, -2);
    v_prev_end := case when r.e <= r.s then r.e + 1440 else r.e end;
  end loop;
  select coalesce(jsonb_agg(
           case when p_kind = 'weekly'
             then jsonb_build_object('weekday', x.weekday, 'start_local', to_char(x.start_local, 'HH24:MI'), 'end_local', to_char(x.end_local, 'HH24:MI'))
             else jsonb_build_object('start_local', to_char(x.start_local, 'HH24:MI'), 'end_local', to_char(x.end_local, 'HH24:MI')) end
           order by x.weekday nulls first, x.start_local), '[]'::jsonb)
    into v_out
  from jsonb_to_recordset(p_windows) as x(weekday smallint, start_local time, end_local time);
  return v_out;
end;
$$;

-- True when the proposed hours are exactly the hours already approved for that date (weekly) or day (specific date),
-- so a request or edit would change nothing.
create function ogevia.availability_is_noop(p_organization_id uuid, p_caregiver_record_id uuid, p_kind text, p_windows jsonb, p_from date)
returns boolean
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_day jsonb;
begin
  if p_kind = 'weekly' then
    return ogevia.availability_pattern(p_organization_id, p_caregiver_record_id, p_from) = p_windows;
  end if;
  v_day := ogevia.availability_day(p_organization_id, p_caregiver_record_id, p_from);
  return (jsonb_array_length(p_windows) = 0 and (v_day ->> 'unavailable')::boolean and (v_day ->> 'source') = 'date')
      or ((v_day -> 'windows') = p_windows and jsonb_array_length(p_windows) > 0);
end;
$$;

-- Future scheduled shifts of one caregiver that the CURRENT approved hours fully cover.
create function ogevia.availability_covered_future_shifts(p_organization_id uuid, p_caregiver_record_id uuid)
returns uuid[]
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(array_agg(s.id), '{}'::uuid[])
  from ogevia.shifts s
  where s.organization_id = p_organization_id and s.caregiver_record_id = p_caregiver_record_id
    and s.status = 'scheduled' and s.starts_at > now() and not ogevia.shift_is_called_out(s.id)
    and ogevia.availability_status(p_organization_id, p_caregiver_record_id, s.starts_at, s.ends_at) = 'covered';
$$;

-- Applies an APPROVED request to the layered hours (shared by approval, direct edit and preview).
-- Bumps the caregiver's availability version, supersedes overlapping pending requests, flags
-- future shifts that lost coverage and clears flags on shifts that are covered again.
create function ogevia.availability_apply(
  p_request_id uuid, p_reviewer uuid, p_note text, p_self_review boolean
)
returns jsonb
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  r ogevia.availability_requests%rowtype;
  v_ver integer;
  v_before uuid[];
  v_affected jsonb;
  w record;
begin
  select * into r from ogevia.availability_requests where id = p_request_id;
  perform ogevia.lock_caregiver(r.caregiver_record_id);
  insert into ogevia.caregiver_availability_state (organization_id, caregiver_record_id)
  values (r.organization_id, r.caregiver_record_id) on conflict do nothing;
  select s.version + 1 into v_ver from ogevia.caregiver_availability_state s
  where s.organization_id = r.organization_id and s.caregiver_record_id = r.caregiver_record_id for update;
  v_before := ogevia.availability_covered_future_shifts(r.organization_id, r.caregiver_record_id);

  if r.kind = 'weekly' then
    insert into ogevia.caregiver_availability_windows (organization_id, caregiver_record_id, weekday, specific_date, start_local, end_local, request_id)
    select r.organization_id, r.caregiver_record_id, x.weekday, null, x.start_local, x.end_local, r.id
    from jsonb_to_recordset(r.windows) as x(weekday smallint, start_local time, end_local time);
  elsif jsonb_array_length(r.windows) = 0 then
    insert into ogevia.caregiver_unavailable_dates (organization_id, caregiver_record_id, unavailable_date, request_id)
    values (r.organization_id, r.caregiver_record_id, r.effective_from, r.id);
  else
    insert into ogevia.caregiver_availability_windows (organization_id, caregiver_record_id, weekday, specific_date, start_local, end_local, request_id)
    select r.organization_id, r.caregiver_record_id, null, r.effective_from, x.start_local, x.end_local, r.id
    from jsonb_to_recordset(r.windows) as x(start_local time, end_local time);
  end if;

  update ogevia.availability_requests
     set status = 'approved', reviewed_by = p_reviewer, reviewed_at = now(), review_note = nullif(btrim(p_note), ''),
         approved_version = v_ver, self_review = p_self_review
   where id = r.id;
  update ogevia.caregiver_availability_state set version = v_ver, updated_at = now(), updated_by = p_reviewer
   where organization_id = r.organization_id and caregiver_record_id = r.caregiver_record_id;

  -- Older pending requests were written against hours that have now changed.
  update ogevia.availability_requests o
     set status = 'superseded', reviewed_at = now(), review_note = 'Replaced by a newer approved change to the same hours.'
   where o.caregiver_record_id = r.caregiver_record_id and o.id <> r.id and o.status = 'pending' and o.kind = r.kind
     and daterange(o.effective_from, o.effective_until, '[]') && daterange(r.effective_from, r.effective_until, '[]');

  -- Flag future shifts that were covered and are not any more; clear flags that no longer apply.
  for w in
    select s.id, s.starts_at, s.ends_at
    from ogevia.shifts s
    where s.id = any (v_before)
      and ogevia.availability_status(r.organization_id, r.caregiver_record_id, s.starts_at, s.ends_at) <> 'covered'
  loop
    insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail, cause_id)
    values (r.organization_id, w.id, r.caregiver_record_id, 'availability', 'outside_approved_hours',
            jsonb_build_object('starts_at', w.starts_at, 'ends_at', w.ends_at), r.id)
    on conflict (shift_id, kind) where resolved_at is null do nothing;
  end loop;
  update ogevia.shift_readiness_flags f
     set resolved_at = now(), resolved_by = p_reviewer, resolution = 'Covered by approved availability again'
   where f.organization_id = r.organization_id and f.caregiver_record_id = r.caregiver_record_id
     and f.kind = 'availability' and f.resolved_at is null
     and exists (select 1 from ogevia.shifts s where s.id = f.shift_id
                 and ogevia.availability_status(r.organization_id, r.caregiver_record_id, s.starts_at, s.ends_at) = 'covered');

  select coalesce(jsonb_agg(jsonb_build_object('shiftId', f.shift_id, 'startsAt', s.starts_at, 'endsAt', s.ends_at) order by s.starts_at), '[]'::jsonb)
    into v_affected
  from ogevia.shift_readiness_flags f join ogevia.shifts s on s.id = f.shift_id
  where f.cause_id = r.id and f.kind = 'availability' and f.resolved_at is null;
  return jsonb_build_object('approvedVersion', v_ver, 'affectedShifts', v_affected);
end;
$$;

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

create function ogevia.availability_actor_record(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v uuid;
begin
  select r.id into v from ogevia.caregiver_records r
  where r.organization_id = p_organization_id and r.linked_user_id = ogevia.require_actor()
    and r.status in ('ready', 'active') and r.deleted_at is null;
  return v;
end;
$$;

-- The approved state (as of today in the agency time zone), pending requests and recent decisions.
-- A caregiver reads their own; staff with availability.read pass a caregiver record id.
create function ogevia_api.get_availability(p_organization_id uuid, p_caregiver_record_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_rec uuid;
  v_tz text;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_version integer;
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if p_caregiver_record_id is null then
    if not ogevia.has_permission(p_organization_id, 'availability.manage_own') then
      raise exception 'Forbidden' using errcode = 'OGA03';
    end if;
    v_rec := ogevia.availability_actor_record(p_organization_id);
    if v_rec is null then raise exception 'Caregiver record not found' using errcode = 'OGN04'; end if;
  else
    if not ogevia.has_permission(p_organization_id, 'availability.read') then
      raise exception 'Forbidden' using errcode = 'OGA03';
    end if;
    select r.id into v_rec from ogevia.caregiver_records r
    where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
    if v_rec is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  select coalesce(s.version, 0) into v_version
  from (select 1) x left join ogevia.caregiver_availability_state s
    on s.organization_id = p_organization_id and s.caregiver_record_id = v_rec;
  return jsonb_build_object(
    'caregiverRecordId', v_rec,
    'timezone', v_tz,
    'version', coalesce(v_version, 0),
    'provided', exists (select 1 from ogevia.caregiver_availability_windows w where w.organization_id = p_organization_id and w.caregiver_record_id = v_rec),
    'asOf', v_today,
    'weekly', ogevia.availability_pattern(p_organization_id, v_rec, v_today),
    'upcomingWeekly', coalesce((
      select jsonb_agg(jsonb_build_object('requestId', r.id, 'effectiveFrom', r.effective_from, 'effectiveUntil', r.effective_until,
                                           'approvedVersion', r.approved_version, 'windows', r.windows) order by r.effective_from)
      from ogevia.availability_requests r
      where r.caregiver_record_id = v_rec and r.kind = 'weekly' and r.status = 'approved'
        and r.effective_from > v_today), '[]'::jsonb),
    'exceptions', coalesce((
      select jsonb_agg(jsonb_build_object('date', e.d, 'hours', ogevia.availability_day(p_organization_id, v_rec, e.d)) order by e.d)
      from (select w.specific_date as d from ogevia.caregiver_availability_windows w
            where w.caregiver_record_id = v_rec and w.specific_date >= v_today
            union
            select u.unavailable_date from ogevia.caregiver_unavailable_dates u
            where u.caregiver_record_id = v_rec and u.unavailable_date >= v_today) e), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object('requestId', r.id, 'kind', r.kind, 'status', r.status, 'reason', r.reason,
                                           'effectiveFrom', r.effective_from, 'effectiveUntil', r.effective_until,
                                           'windows', r.windows, 'requestedAt', r.requested_at) order by r.requested_at)
      from ogevia.availability_requests r where r.caregiver_record_id = v_rec and r.status = 'pending'), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(x order by x ->> 'reviewedAt' desc)
      from (select jsonb_build_object('requestId', r.id, 'kind', r.kind, 'status', r.status, 'source', r.source, 'reason', r.reason,
                                       'effectiveFrom', r.effective_from, 'effectiveUntil', r.effective_until,
                                       'reviewNote', r.review_note, 'reviewedAt', r.reviewed_at, 'approvedVersion', r.approved_version) as x
            from ogevia.availability_requests r
            where r.caregiver_record_id = v_rec and r.status <> 'pending'
            order by r.reviewed_at desc nulls last limit 10) q), '[]'::jsonb));
end;
$$;

create function ogevia_api.request_availability_change(
  p_organization_id uuid, p_kind text, p_windows jsonb, p_effective_from date, p_effective_until date,
  p_reason text, p_base_version integer, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_rec uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_fp text := concat_ws('|', p_organization_id, p_kind, p_windows::text, p_effective_from, p_effective_until, v_reason, p_base_version);
  v_prior jsonb;
  v_windows jsonb;
  v_state integer;
  v_id uuid := gen_random_uuid();
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'availability.manage_own') then
    raise exception 'Forbidden' using errcode = 'OGA03';
  end if;
  v_rec := ogevia.availability_actor_record(p_organization_id);
  if v_rec is null then raise exception 'Caregiver record not found' using errcode = 'OGN04'; end if;
  v_prior := ogevia.idempotency_begin('request_availability_change', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'request_id')::uuid; end if;

  if p_kind not in ('weekly', 'date') then raise exception 'Choose Weekly hours or Specific date' using errcode = 'OGV22'; end if;
  if length(v_reason) < 3 then raise exception 'Enter a reason for the change' using errcode = 'OGV22'; end if;
  if length(v_reason) > 500 then raise exception 'The reason is too long (500 characters at most)' using errcode = 'OGV22'; end if;
  if p_effective_from is null then raise exception 'Enter the date the change starts' using errcode = 'OGV22'; end if;
  if p_effective_from < v_today then raise exception 'The start date cannot be in the past' using errcode = 'OGV22'; end if;
  if p_kind = 'date' and p_effective_until is not null and p_effective_until <> p_effective_from then
    raise exception 'A specific date is a single day' using errcode = 'OGV22';
  end if;
  if p_kind = 'weekly' and p_effective_until is not null and p_effective_until < p_effective_from then
    raise exception 'The end date cannot be before the start date' using errcode = 'OGV22';
  end if;
  v_windows := ogevia.availability_check_windows(p_kind, p_windows);
  if ogevia.availability_is_noop(p_organization_id, v_rec, p_kind, v_windows, p_effective_from) then
    raise exception 'These are already your approved hours. Change something before sending the request.' using errcode = 'OGV22';
  end if;

  -- Serialise with approvals so a stale form is refused instead of silently winning.
  insert into ogevia.caregiver_availability_state (organization_id, caregiver_record_id)
  values (p_organization_id, v_rec) on conflict do nothing;
  select s.version into v_state from ogevia.caregiver_availability_state s
  where s.organization_id = p_organization_id and s.caregiver_record_id = v_rec for share;
  if p_base_version is distinct from v_state then
    raise exception 'Your availability changed since you opened this form. Reload and try again.' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.availability_requests q
             where q.caregiver_record_id = v_rec and q.kind = p_kind and q.status = 'pending'
               and (p_kind = 'weekly' or q.effective_from = p_effective_from)) then
    raise exception 'You already have a pending request for this. Withdraw it or wait for the decision.' using errcode = 'OGC09';
  end if;

  insert into ogevia.availability_requests
    (id, organization_id, caregiver_record_id, kind, status, source, reason, effective_from, effective_until, is_temporary,
     windows, base_version, requested_by)
  values
    (v_id, p_organization_id, v_rec, p_kind, 'pending', 'caregiver', v_reason, p_effective_from,
     case when p_kind = 'date' then p_effective_from else p_effective_until end,
     p_kind = 'date' or p_effective_until is not null, v_windows, v_state, v_actor);
  perform ogevia.write_audit(p_organization_id, 'availability.requested', 'availability_requests', v_id, null,
    jsonb_build_object('kind', p_kind, 'effective_from', p_effective_from, 'effective_until', p_effective_until,
                       'base_version', v_state, 'caregiver_record_id', v_rec), v_reason);
  perform ogevia.idempotency_finish('request_availability_change', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('request_id', v_id));
  return v_id;
end;
$$;

create function ogevia_api.withdraw_availability_request(p_organization_id uuid, p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare r ogevia.availability_requests%rowtype;
begin
  select * into r from ogevia.availability_requests q
  where q.id = p_request_id and q.organization_id = p_organization_id for update;
  if r.id is null or r.requested_by <> ogevia.require_actor() or not ogevia.has_permission(p_organization_id, 'availability.manage_own') then
    raise exception 'Request not found' using errcode = 'OGN04';
  end if;
  if r.status <> 'pending' then
    raise exception 'This request is already % and cannot be withdrawn', r.status using errcode = 'OGC09';
  end if;
  update ogevia.availability_requests set status = 'withdrawn', reviewed_at = now() where id = r.id;
  perform ogevia.write_audit(p_organization_id, 'availability.withdrawn', 'availability_requests', r.id,
    jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'withdrawn'), null);
end;
$$;

create function ogevia_api.list_availability_requests(p_organization_id uuid, p_status text default 'pending')
returns table (
  request_id uuid, caregiver_record_id uuid, caregiver_code text, caregiver_name text, kind text, status text, source text,
  reason text, effective_from date, effective_until date, windows jsonb, requested_at timestamp with time zone,
  reviewed_at timestamp with time zone, review_note text, approved_version integer, base_version integer
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'availability.read') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  return query
  select r.id, r.caregiver_record_id, c.caregiver_code, concat_ws(' ', coalesce(c.preferred_name, c.first_name), c.last_name),
         r.kind, r.status::text, r.source, r.reason, r.effective_from, r.effective_until, r.windows, r.requested_at,
         r.reviewed_at, r.review_note, r.approved_version, r.base_version
  from ogevia.availability_requests r
  join ogevia.caregiver_records c on c.id = r.caregiver_record_id and c.organization_id = r.organization_id
  where r.organization_id = p_organization_id and (p_status is null or r.status::text = p_status)
  order by r.requested_at desc
  limit 200;
end;
$$;

-- Current versus proposed hours and the future shifts that would lose coverage, computed with the
-- real approval code inside a sub-transaction that is rolled back (so preview and result cannot differ).
create function ogevia_api.preview_availability_request(p_organization_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  r ogevia.availability_requests%rowtype;
  v_current jsonb;
  v_result jsonb;
  v_detail text;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'availability.read') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  select * into r from ogevia.availability_requests q where q.id = p_request_id and q.organization_id = p_organization_id;
  if r.id is null then raise exception 'Request not found' using errcode = 'OGN04'; end if;
  v_current := case when r.kind = 'weekly'
                    then ogevia.availability_pattern(p_organization_id, r.caregiver_record_id, r.effective_from)
                    else ogevia.availability_day(p_organization_id, r.caregiver_record_id, r.effective_from) end;
  if r.status = 'pending' then
    begin
      v_result := ogevia.availability_apply(r.id, ogevia.require_actor(), null, false);
      raise exception 'preview' using errcode = 'OGZ00', detail = v_result::text;
    exception when sqlstate 'OGZ00' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_result := v_detail::jsonb;
    end;
  end if;
  return jsonb_build_object('requestId', r.id, 'kind', r.kind, 'status', r.status, 'current', v_current, 'proposed', r.windows,
                            'effectiveFrom', r.effective_from, 'effectiveUntil', r.effective_until,
                            'affectedShifts', coalesce(v_result -> 'affectedShifts', '[]'::jsonb),
                            'note', 'Approving availability does not assign work or change booked shifts.');
end;
$$;

create function ogevia_api.review_availability_request(
  p_organization_id uuid, p_request_id uuid, p_decision text, p_note text, p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_note text := btrim(coalesce(p_note, ''));
  v_fp text := concat_ws('|', p_organization_id, p_request_id, p_decision);
  v_prior jsonb;
  r ogevia.availability_requests%rowtype;
  v_self boolean;
  v_result jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'availability.review') then
    raise exception 'Only an administrator can approve or decline availability' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('review_availability_request', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;
  if p_decision not in ('approve', 'decline') then raise exception 'Choose Approve or Decline' using errcode = 'OGV22'; end if;
  if p_decision = 'decline' and length(v_note) < 3 then raise exception 'Enter a note explaining why this is declined' using errcode = 'OGV22'; end if;
  select * into r from ogevia.availability_requests q where q.id = p_request_id and q.organization_id = p_organization_id for update;
  if r.id is null then raise exception 'Request not found' using errcode = 'OGN04'; end if;
  if r.status <> 'pending' then
    raise exception 'This request was already %.', r.status using errcode = 'OGC09';
  end if;
  if p_decision = 'decline' then
    update ogevia.availability_requests set status = 'declined', reviewed_by = v_actor, reviewed_at = now(), review_note = v_note where id = r.id;
    perform ogevia.write_audit(p_organization_id, 'availability.declined', 'availability_requests', r.id,
      jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'declined', 'caregiver_record_id', r.caregiver_record_id), v_note);
    v_result := jsonb_build_object('status', 'declined', 'affectedShifts', '[]'::jsonb);
  else
    v_self := exists (select 1 from ogevia.caregiver_records c where c.id = r.caregiver_record_id and c.linked_user_id = v_actor);
    v_result := ogevia.availability_apply(r.id, v_actor, v_note, v_self) || jsonb_build_object('status', 'approved');
    perform ogevia.write_audit(p_organization_id, 'availability.approved', 'availability_requests', r.id,
      jsonb_build_object('status', 'pending'),
      jsonb_build_object('status', 'approved', 'approved_version', v_result -> 'approvedVersion', 'self_review', v_self,
                         'caregiver_record_id', r.caregiver_record_id, 'affected_shift_count', jsonb_array_length(v_result -> 'affectedShifts')), v_note);
  end if;
  perform ogevia.idempotency_finish('review_availability_request', p_idempotency_key, p_organization_id, v_fp, v_result);
  return v_result;
end;
$$;

-- Administrator direct edit: same layering and audit as an approved request; a reason is required.
create function ogevia_api.set_availability_direct(
  p_organization_id uuid, p_caregiver_record_id uuid, p_kind text, p_windows jsonb, p_effective_from date, p_effective_until date,
  p_reason text, p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_kind, p_windows::text, p_effective_from, p_effective_until, v_reason);
  v_prior jsonb;
  v_windows jsonb;
  v_state integer;
  v_id uuid := gen_random_uuid();
  v_self boolean;
  v_result jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'availability.review') then
    raise exception 'Only an administrator can edit availability directly' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_availability_direct', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;
  if not exists (select 1 from ogevia.caregiver_records c where c.id = p_caregiver_record_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Caregiver not found' using errcode = 'OGN04';
  end if;
  if p_kind not in ('weekly', 'date') then raise exception 'Choose Weekly hours or Specific date' using errcode = 'OGV22'; end if;
  if length(v_reason) < 3 then raise exception 'Enter a reason for the change' using errcode = 'OGV22'; end if;
  if length(v_reason) > 500 then raise exception 'The reason is too long (500 characters at most)' using errcode = 'OGV22'; end if;
  if p_effective_from is null or p_effective_from < v_today then raise exception 'Enter a start date that is today or later' using errcode = 'OGV22'; end if;
  if p_kind = 'date' and p_effective_until is not null and p_effective_until <> p_effective_from then
    raise exception 'A specific date is a single day' using errcode = 'OGV22';
  end if;
  if p_kind = 'weekly' and p_effective_until is not null and p_effective_until < p_effective_from then
    raise exception 'The end date cannot be before the start date' using errcode = 'OGV22';
  end if;
  v_windows := ogevia.availability_check_windows(p_kind, p_windows);
  if ogevia.availability_is_noop(p_organization_id, p_caregiver_record_id, p_kind, v_windows, p_effective_from) then
    raise exception 'These are already the approved hours. Change something before saving.' using errcode = 'OGV22';
  end if;
  insert into ogevia.caregiver_availability_state (organization_id, caregiver_record_id)
  values (p_organization_id, p_caregiver_record_id) on conflict do nothing;
  select s.version into v_state from ogevia.caregiver_availability_state s
  where s.organization_id = p_organization_id and s.caregiver_record_id = p_caregiver_record_id for update;
  -- A direct edit replaces any overlapping pending request, exactly as an approval would.
  update ogevia.availability_requests o
     set status = 'superseded', reviewed_at = now(), review_note = 'Replaced by an administrator edit of the same hours.'
   where o.caregiver_record_id = p_caregiver_record_id and o.status = 'pending' and o.kind = p_kind
     and daterange(o.effective_from, o.effective_until, '[]') && daterange(p_effective_from, case when p_kind = 'date' then p_effective_from else p_effective_until end, '[]');
  insert into ogevia.availability_requests
    (id, organization_id, caregiver_record_id, kind, status, source, reason, effective_from, effective_until, is_temporary,
     windows, base_version, requested_by)
  values
    (v_id, p_organization_id, p_caregiver_record_id, p_kind, 'pending', 'administrator', v_reason, p_effective_from,
     case when p_kind = 'date' then p_effective_from else p_effective_until end,
     p_kind = 'date' or p_effective_until is not null, v_windows, v_state, v_actor);
  v_self := exists (select 1 from ogevia.caregiver_records c where c.id = p_caregiver_record_id and c.linked_user_id = v_actor);
  v_result := ogevia.availability_apply(v_id, v_actor, v_reason, v_self) || jsonb_build_object('status', 'approved', 'requestId', v_id);
  perform ogevia.write_audit(p_organization_id, 'availability.edited_directly', 'availability_requests', v_id, null,
    jsonb_build_object('kind', p_kind, 'effective_from', p_effective_from, 'effective_until', p_effective_until,
                       'approved_version', v_result -> 'approvedVersion', 'self_review', v_self,
                       'caregiver_record_id', p_caregiver_record_id), v_reason);
  perform ogevia.idempotency_finish('set_availability_direct', p_idempotency_key, p_organization_id, v_fp, v_result);
  return v_result;
end;
$$;

-- Withdrawn: a direct replace deleted every exception whenever a caller sent none.
create or replace function ogevia_api.replace_my_availability(p_organization_id uuid, p_windows jsonb, p_unavailable_dates jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
begin
  raise exception 'Availability changes need administrator approval. Use Request change.' using errcode = 'OGV22';
end;
$$;

-- get_my_availability keeps its shape but shows APPROVED hours only (the layer in force today
-- plus approved dates), so the old screen cannot show pending or superseded rows as current.
create or replace function ogevia_api.get_my_availability(p_organization_id uuid)
returns table(window_id uuid, weekday smallint, specific_date date, start_local time, end_local time)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with me as (
    select cr.id, cr.organization_id from ogevia.caregiver_records cr
    where cr.organization_id = p_organization_id and cr.linked_user_id = ogevia.require_actor()
      and ogevia.has_permission(p_organization_id, 'availability.manage_own')
  ), today as (select ogevia.organization_local_date(p_organization_id, now()) as d)
  select w.id, w.weekday, w.specific_date, w.start_local, w.end_local
  from me join ogevia.caregiver_availability_windows w on w.caregiver_record_id = me.id and w.organization_id = me.organization_id
  cross join today t
  where (w.specific_date is not null and w.specific_date >= t.d)
     or (w.specific_date is null and exists (
           select 1 from jsonb_array_elements(ogevia.availability_pattern(me.organization_id, me.id, t.d)) e
           where (e ->> 'weekday')::smallint = w.weekday and (e ->> 'start_local') = to_char(w.start_local, 'HH24:MI')
             and (e ->> 'end_local') = to_char(w.end_local, 'HH24:MI')))
  order by w.specific_date nulls last, w.weekday, w.start_local;
$$;

-- Matching now reads layered approved hours only; the date-exception table is part of the layers.
create or replace function ogevia_api.list_available_caregivers(p_organization_id uuid, p_request_id uuid)
returns table(caregiver_record_id uuid, caregiver_name text, current_client_match boolean, availability_source text)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  with req as(
    select r.*, o.timezone,
      (r.starts_at at time zone o.timezone)::date local_date,
      ((r.ends_at - interval '1 microsecond') at time zone o.timezone)::date local_end_date
    from ogevia.care_requests r join ogevia.organizations o on o.id=r.organization_id
    where r.id=p_request_id and r.organization_id=p_organization_id
  ), candidates as(
    select cr.id caregiver_record_id,cr.linked_user_id,cr.first_name,cr.last_name,cr.preferred_name,
      q.client_id,q.service_id,q.local_date
    from req q join ogevia.caregiver_records cr on cr.organization_id=q.organization_id and cr.status in('ready','active') and cr.deleted_at is null
    where ogevia.availability_covers(q.organization_id, cr.id, q.timezone, q.starts_at, q.ends_at, q.local_date, q.local_end_date)
      and not exists(select 1 from ogevia.shifts sh where sh.organization_id=q.organization_id and sh.caregiver_record_id=cr.id and sh.id is distinct from q.assigned_shift_id and sh.status in('scheduled','completed') and sh.starts_at<q.ends_at and sh.ends_at>q.starts_at)
      and not exists(select 1 from ogevia.care_request_offers oo where oo.care_request_id=q.id and oo.caregiver_record_id=cr.id and oo.status in('not_available','cancelled'))
  )
  select c.caregiver_record_id,coalesce(c.preferred_name,c.first_name)||' '||c.last_name,
    exists(select 1 from ogevia.caregiver_assignments a where a.organization_id=p_organization_id and a.caregiver_user_id=c.linked_user_id and a.client_id=c.client_id and a.service_id=c.service_id and a.is_active),
    case when exists(select 1 from ogevia.caregiver_availability_windows w where w.caregiver_record_id=c.caregiver_record_id and w.specific_date=c.local_date) then 'date-specific' else 'recurring' end
  from candidates c where ogevia.has_permission(p_organization_id,'care_requests.manage')
  order by 3 desc,2;
$$;

revoke all on function ogevia.lock_caregiver(uuid) from public;
revoke all on function ogevia.availability_layer_ranges(uuid, uuid, text, date, date) from public;
revoke all on function ogevia.availability_blocked_days(uuid, uuid, text, date, date) from public;
revoke all on function ogevia.availability_status(uuid, uuid, timestamptz, timestamptz) from public;
revoke all on function ogevia.availability_pattern(uuid, uuid, date) from public;
revoke all on function ogevia.availability_day(uuid, uuid, date) from public;
revoke all on function ogevia.availability_check_windows(text, jsonb) from public;
revoke all on function ogevia.availability_covered_future_shifts(uuid, uuid) from public;
revoke all on function ogevia.availability_is_noop(uuid, uuid, text, jsonb, date) from public;
revoke all on function ogevia.availability_apply(uuid, uuid, text, boolean) from public;
revoke all on function ogevia.availability_actor_record(uuid) from public;
revoke all on function ogevia_api.get_availability(uuid, uuid) from public;
revoke all on function ogevia_api.request_availability_change(uuid, text, jsonb, date, date, text, integer, uuid) from public;
revoke all on function ogevia_api.withdraw_availability_request(uuid, uuid) from public;
revoke all on function ogevia_api.list_availability_requests(uuid, text) from public;
revoke all on function ogevia_api.preview_availability_request(uuid, uuid) from public;
revoke all on function ogevia_api.review_availability_request(uuid, uuid, text, text, uuid) from public;
revoke all on function ogevia_api.set_availability_direct(uuid, uuid, text, jsonb, date, date, text, uuid) from public;
grant execute on function ogevia_api.get_availability(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.request_availability_change(uuid, text, jsonb, date, date, text, integer, uuid) to ogevia_app;
grant execute on function ogevia_api.withdraw_availability_request(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_availability_requests(uuid, text) to ogevia_app;
grant execute on function ogevia_api.preview_availability_request(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.review_availability_request(uuid, uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.set_availability_direct(uuid, uuid, text, jsonb, date, date, text, uuid) to ogevia_app;

-- Read-only verification/support role: SELECT through explicit policies, like every other table.
grant select on table ogevia.caregiver_availability_state, ogevia.availability_requests, ogevia.shift_readiness_flags to ogevia_readonly;
create policy readonly_select on ogevia.caregiver_availability_state for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.availability_requests for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.shift_readiness_flags for select to ogevia_readonly using (true);
