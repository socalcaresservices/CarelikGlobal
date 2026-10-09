-- 0040 Availability approval workflow.
--
-- Before: a caregiver replaced their own availability directly (replace_my_availability, 0011), so
-- any change was live at once, the save erased date exceptions the page did not send, and nothing
-- recorded who changed what or when. Matching read it as it stood.
--
-- After:
--   * The CURRENT APPROVED availability is what is in caregiver_availability_windows and
--     caregiver_unavailable_dates (unchanged tables, so matching and the readiness check keep reading
--     exactly what they read before). It changes only when an administrator approves a request or
--     edits it directly with a reason.
--   * A caregiver submits a REQUEST (weekly windows and/or specific-date exceptions) with a required
--     reason. The request keeps the submitted values, status, requester, reviewer and timestamps. A
--     pending request never contributes to matching or readiness.
--   * Each caregiver has a version number. A request records the version it was written against
--     (its baseline); approving it after the approved availability changed is refused as stale, so a
--     stale save cannot overwrite a newer change.
--   * Omitting windows or exceptions in a request means "keep what is approved"; clearing them must
--     be explicit ([]). A save can therefore no longer erase date exceptions by leaving them out.
--   * Administrator direct edits need a reason, check the version the administrator saw, and are
--     audited with before and after.
--   * "Not provided" is distinct from "unavailable": a caregiver with no profile and no windows has
--     provided nothing; one whose exceptions block a date is unavailable on that date.
--   * Approving availability never assigns work and never changes a shift or visit. Shifts that fall
--     outside new availability are listed for review (list_availability_conflicts); nothing is moved.
--   * Windows are agency-local times; the agency time zone is returned with every read. A window whose
--     end is earlier than its start runs past midnight (0037).
--
-- The old direct-write function now refuses, with a plain message, so no client can bypass approval.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table ogevia.caregiver_availability_profiles (
  caregiver_record_id uuid primary key,
  organization_id uuid not null references ogevia.organizations(id),
  version integer not null default 0 check (version >= 0),
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  update_source text check (update_source in ('request', 'admin')),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);

create table ogevia.caregiver_availability_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  requested_by uuid not null references ogevia.app_users(id),
  requested_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  baseline_version integer not null check (baseline_version >= 0),
  proposed_windows jsonb not null,
  proposed_unavailable jsonb not null,
  reviewed_by uuid references ogevia.app_users(id),
  reviewed_at timestamptz,
  review_note text,
  unique (id, organization_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  constraint availability_request_review_shape check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null)
    or (status <> 'pending' and reviewed_by is not null and reviewed_at is not null)),
  constraint availability_request_decline_note check (
    status <> 'declined' or length(btrim(coalesce(review_note, ''))) between 3 and 500)
);
create unique index availability_requests_one_pending on ogevia.caregiver_availability_requests (caregiver_record_id) where status = 'pending';
create index availability_requests_org_idx on ogevia.caregiver_availability_requests (organization_id, status, requested_at desc);

-- A request is immutable apart from its one-time review.
create function ogevia.availability_requests_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.status <> 'pending' then
    raise exception 'This request was already reviewed' using errcode = 'OGC09';
  end if;
  if (to_jsonb(new) - array['status', 'reviewed_by', 'reviewed_at', 'review_note'])
     is distinct from (to_jsonb(old) - array['status', 'reviewed_by', 'reviewed_at', 'review_note']) then
    raise exception 'Availability requests cannot be edited; submit a new one' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
create trigger availability_requests_guard before update on ogevia.caregiver_availability_requests
for each row execute function ogevia.availability_requests_guard_update();
create trigger availability_requests_no_delete before delete on ogevia.caregiver_availability_requests
for each row execute function ogevia.forbid_delete();

revoke all on table ogevia.caregiver_availability_profiles, ogevia.caregiver_availability_requests from public, ogevia_app;
alter table ogevia.caregiver_availability_profiles enable row level security;
alter table ogevia.caregiver_availability_requests enable row level security;
create policy readonly_select on ogevia.caregiver_availability_profiles for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.caregiver_availability_requests for select to ogevia_readonly using (true);
grant select on ogevia.caregiver_availability_profiles, ogevia.caregiver_availability_requests to ogevia_readonly;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The caregiver's current approved availability as one document (stable order).
create function ogevia.availability_snapshot(p_organization_id uuid, p_caregiver_record_id uuid)
returns jsonb
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select jsonb_build_object(
    'windows', coalesce((select jsonb_agg(jsonb_build_object('weekday', w.weekday, 'specific_date', w.specific_date,
                                                              'start_local', to_char(w.start_local, 'HH24:MI'),
                                                              'end_local', to_char(w.end_local, 'HH24:MI'))
                                          order by w.specific_date nulls first, w.weekday, w.start_local, w.end_local)
                           from ogevia.caregiver_availability_windows w
                          where w.organization_id = p_organization_id and w.caregiver_record_id = p_caregiver_record_id), '[]'::jsonb),
    'unavailable', coalesce((select jsonb_agg(jsonb_build_object('date', u.unavailable_date, 'reason', u.reason) order by u.unavailable_date)
                               from ogevia.caregiver_unavailable_dates u
                              where u.organization_id = p_organization_id and u.caregiver_record_id = p_caregiver_record_id), '[]'::jsonb));
$$;

-- Validate and normalise submitted windows and exceptions. Raises a plain message for anything unusable.
-- windows: [{weekday|specific_date, start_local, end_local}]; unavailable: ["YYYY-MM-DD"] or [{date, reason}].
create function ogevia.normalize_availability(p_windows jsonb, p_unavailable jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ogevia, pg_temp
as $$
declare
  v_w jsonb;
  v_u jsonb;
begin
  if jsonb_typeof(p_windows) is distinct from 'array' or jsonb_typeof(p_unavailable) is distinct from 'array' then
    raise exception 'Windows and unavailable dates must be lists' using errcode = 'OGV22';
  end if;
  if jsonb_array_length(p_windows) > 100 or jsonb_array_length(p_unavailable) > 400 then
    raise exception 'Too many availability entries' using errcode = 'OGV22';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_windows) as x(weekday smallint, specific_date date, start_local time, end_local time)
              where (x.weekday is null) = (x.specific_date is null)
                 or (x.weekday is not null and x.weekday not between 0 and 6)
                 or x.start_local is null or x.end_local is null or x.start_local = x.end_local) then
    raise exception 'Each window needs one day (a weekday or a date), a start and an end that are different' using errcode = 'OGV22';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('weekday', x.weekday, 'specific_date', x.specific_date,
                                               'start_local', to_char(x.start_local, 'HH24:MI'), 'end_local', to_char(x.end_local, 'HH24:MI'))
                            order by x.specific_date nulls first, x.weekday, x.start_local, x.end_local), '[]'::jsonb)
    into v_w
    from (select distinct * from jsonb_to_recordset(p_windows) as x(weekday smallint, specific_date date, start_local time, end_local time)) x;
  select coalesce(jsonb_agg(jsonb_build_object('date', d.dt, 'reason', d.reason) order by d.dt), '[]'::jsonb)
    into v_u
    from (select distinct on (dt) dt, reason from (
            select case when jsonb_typeof(e) = 'string' then (e #>> '{}')::date else (e ->> 'date')::date end as dt,
                   case when jsonb_typeof(e) = 'object' then nullif(btrim(e ->> 'reason'), '') end as reason
              from jsonb_array_elements(p_unavailable) e) z
            where dt is not null order by dt, reason nulls last) d;
  return jsonb_build_object('windows', v_w, 'unavailable', v_u);
end;
$$;

-- Replace the approved availability and bump the version. Caller holds the caregiver lock.
create function ogevia.apply_availability(
  p_organization_id uuid, p_caregiver_record_id uuid, p_normalized jsonb, p_actor uuid, p_source text
)
returns integer
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_version integer;
begin
  delete from ogevia.caregiver_availability_windows where organization_id = p_organization_id and caregiver_record_id = p_caregiver_record_id;
  insert into ogevia.caregiver_availability_windows (organization_id, caregiver_record_id, weekday, specific_date, start_local, end_local)
  select p_organization_id, p_caregiver_record_id, x.weekday, x.specific_date, x.start_local, x.end_local
    from jsonb_to_recordset(p_normalized -> 'windows') as x(weekday smallint, specific_date date, start_local time, end_local time);
  delete from ogevia.caregiver_unavailable_dates where organization_id = p_organization_id and caregiver_record_id = p_caregiver_record_id;
  insert into ogevia.caregiver_unavailable_dates (organization_id, caregiver_record_id, unavailable_date, reason)
  select p_organization_id, p_caregiver_record_id, x.date, x.reason
    from jsonb_to_recordset(p_normalized -> 'unavailable') as x(date date, reason text);
  insert into ogevia.caregiver_availability_profiles (caregiver_record_id, organization_id, version, updated_by, updated_at, update_source)
  values (p_caregiver_record_id, p_organization_id, 1, p_actor, now(), p_source)
  on conflict (caregiver_record_id) do update
    set version = ogevia.caregiver_availability_profiles.version + 1, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at, update_source = excluded.update_source
  returning version into v_version;
  return v_version;
end;
$$;

create function ogevia.availability_version(p_organization_id uuid, p_caregiver_record_id uuid)
returns integer
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce((select p.version from ogevia.caregiver_availability_profiles p
                    where p.caregiver_record_id = p_caregiver_record_id and p.organization_id = p_organization_id), 0);
$$;

-- ---------------------------------------------------------------------------
-- Old direct write: refused (nobody can bypass approval)
-- ---------------------------------------------------------------------------
create or replace function ogevia_api.replace_my_availability(p_organization_id uuid, p_windows jsonb, p_unavailable_dates jsonb default '[]'::jsonb)
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
  raise exception 'Availability changes are requested and approved by your agency. Use Request change.' using errcode = 'OGV22';
end;
$$;

-- ---------------------------------------------------------------------------
-- Caregiver: read own state, submit, cancel
-- ---------------------------------------------------------------------------
create function ogevia_api.get_my_availability_state(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_cr uuid;
  v_tz text;
  v_snap jsonb;
  v_profile ogevia.caregiver_availability_profiles%rowtype;
  v_pending ogevia.caregiver_availability_requests%rowtype;
  v_last ogevia.caregiver_availability_requests%rowtype;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'availability.manage_own') then
    raise exception 'You do not have permission to manage your availability' using errcode = 'OGA03';
  end if;
  v_cr := ogevia.my_caregiver_record(p_organization_id);
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  if v_cr is null then
    return jsonb_build_object('timezone', v_tz, 'has_record', false);
  end if;
  v_snap := ogevia.availability_snapshot(p_organization_id, v_cr);
  select * into v_profile from ogevia.caregiver_availability_profiles p where p.caregiver_record_id = v_cr;
  select * into v_pending from ogevia.caregiver_availability_requests r where r.caregiver_record_id = v_cr and r.status = 'pending';
  select * into v_last from ogevia.caregiver_availability_requests r
   where r.caregiver_record_id = v_cr and r.status in ('approved', 'declined') order by r.reviewed_at desc limit 1;
  return jsonb_build_object(
    'has_record', true,
    'timezone', v_tz,
    'version', coalesce(v_profile.version, 0),
    'provided', jsonb_array_length(v_snap -> 'windows') > 0 or jsonb_array_length(v_snap -> 'unavailable') > 0 or v_profile.caregiver_record_id is not null,
    'updated_at', v_profile.updated_at,
    'windows', v_snap -> 'windows',
    'unavailable', v_snap -> 'unavailable',
    'pending', case when v_pending.id is null then null else jsonb_build_object(
        'request_id', v_pending.id, 'requested_at', v_pending.requested_at, 'reason', v_pending.reason,
        'baseline_version', v_pending.baseline_version, 'stale', v_pending.baseline_version <> coalesce(v_profile.version, 0),
        'windows', v_pending.proposed_windows, 'unavailable', v_pending.proposed_unavailable) end,
    'last_decision', case when v_last.id is null then null else jsonb_build_object(
        'status', v_last.status, 'reviewed_at', v_last.reviewed_at,
        'note', case when v_last.status = 'declined' then v_last.review_note end) end);
end;
$$;

-- p_windows / p_unavailable: null keeps what is approved; [] clears it explicitly.
create function ogevia_api.submit_availability_request(
  p_organization_id uuid, p_reason text, p_windows jsonb, p_unavailable jsonb, p_expected_version integer, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_cr uuid;
  v_snap jsonb;
  v_norm jsonb;
  v_version integer;
  v_id uuid;
  v_fp text := concat_ws('|', p_organization_id, btrim(coalesce(p_reason, '')), p_windows::text, p_unavailable::text, p_expected_version);
  v_prior jsonb;
begin
  if v_actor is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'availability.manage_own') then
    raise exception 'You do not have permission to request availability changes' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('submit_availability_request', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'id')::uuid; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Tell your agency why you are asking for this change' using errcode = 'OGV22';
  end if;
  v_cr := ogevia.my_caregiver_record(p_organization_id);
  if v_cr is null then
    raise exception 'Your Care Team profile was not found' using errcode = 'OGN04';
  end if;
  perform ogevia.lock_caregiver_schedule(v_cr);
  v_version := ogevia.availability_version(p_organization_id, v_cr);
  if p_expected_version is not null and p_expected_version <> v_version then
    raise exception 'Your approved availability changed since you opened this page. Reload and request again.' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.caregiver_availability_requests r where r.caregiver_record_id = v_cr and r.status = 'pending') then
    raise exception 'You already have a request waiting for review. Cancel it first to send a different one.' using errcode = 'OGC09';
  end if;
  v_snap := ogevia.availability_snapshot(p_organization_id, v_cr);
  v_norm := ogevia.normalize_availability(coalesce(p_windows, v_snap -> 'windows'), coalesce(p_unavailable, v_snap -> 'unavailable'));
  if v_norm = v_snap then
    raise exception 'This is the same as your approved availability' using errcode = 'OGV22';
  end if;
  insert into ogevia.caregiver_availability_requests (organization_id, caregiver_record_id, requested_by, reason, baseline_version, proposed_windows, proposed_unavailable)
  values (p_organization_id, v_cr, v_actor, btrim(p_reason), v_version, v_norm -> 'windows', v_norm -> 'unavailable')
  returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'availability.requested', 'caregiver_availability_requests', v_id,
    v_snap, v_norm, btrim(p_reason));
  perform ogevia.idempotency_finish('submit_availability_request', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('id', v_id));
  return v_id;
end;
$$;

create function ogevia_api.cancel_my_availability_request(p_organization_id uuid, p_request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v ogevia.caregiver_availability_requests%rowtype;
begin
  if v_actor is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  select * into v from ogevia.caregiver_availability_requests r
   where r.id = p_request_id and r.organization_id = p_organization_id and r.requested_by = v_actor for update;
  if v.id is null then
    raise exception 'Request not found' using errcode = 'OGN04';
  end if;
  if v.status <> 'pending' then
    raise exception 'This request was already reviewed' using errcode = 'OGC09';
  end if;
  update ogevia.caregiver_availability_requests set status = 'cancelled', reviewed_by = v_actor, reviewed_at = now() where id = v.id;
  perform ogevia.write_audit(p_organization_id, 'availability.request_cancelled', 'caregiver_availability_requests', v.id, null, jsonb_build_object('status', 'cancelled'), null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Administrator: read, review, edit directly
-- ---------------------------------------------------------------------------
create function ogevia_api.get_caregiver_availability(p_organization_id uuid, p_caregiver_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_snap jsonb;
  v_tz text;
  v_profile ogevia.caregiver_availability_profiles%rowtype;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'caregivers.manage') or ogevia.has_permission(p_organization_id, 'shifts.manage')) then
    raise exception 'You do not have permission to see availability' using errcode = 'OGA03';
  end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Care Team member not found' using errcode = 'OGN04';
  end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  v_snap := ogevia.availability_snapshot(p_organization_id, p_caregiver_record_id);
  select * into v_profile from ogevia.caregiver_availability_profiles p where p.caregiver_record_id = p_caregiver_record_id;
  return jsonb_build_object(
    'timezone', v_tz,
    'version', coalesce(v_profile.version, 0),
    'provided', jsonb_array_length(v_snap -> 'windows') > 0 or jsonb_array_length(v_snap -> 'unavailable') > 0 or v_profile.caregiver_record_id is not null,
    'windows', v_snap -> 'windows',
    'unavailable', v_snap -> 'unavailable',
    'updated_at', v_profile.updated_at,
    'updated_by', (select u.display_name from ogevia.app_users u where u.id = v_profile.updated_by),
    'update_source', v_profile.update_source);
end;
$$;

create function ogevia_api.list_availability_requests(p_organization_id uuid, p_status text default 'pending')
returns table (
  request_id uuid, caregiver_record_id uuid, caregiver_code text, caregiver_name text, status text, reason text,
  requested_at timestamptz, requested_by_name text, baseline_version integer, current_version integer, stale boolean,
  proposed_windows jsonb, proposed_unavailable jsonb, current_windows jsonb, current_unavailable jsonb,
  reviewed_at timestamptz, reviewed_by_name text, review_note text
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
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then
    raise exception 'You do not have permission to review availability' using errcode = 'OGA03';
  end if;
  if p_status is not null and p_status not in ('pending', 'approved', 'declined', 'cancelled') then
    raise exception 'Unknown status' using errcode = 'OGV22';
  end if;
  return query
    select r.id, r.caregiver_record_id, c.caregiver_code, coalesce(c.preferred_name, c.first_name) || ' ' || c.last_name,
           r.status, r.reason, r.requested_at, ru.display_name, r.baseline_version,
           ogevia.availability_version(r.organization_id, r.caregiver_record_id),
           r.status = 'pending' and r.baseline_version <> ogevia.availability_version(r.organization_id, r.caregiver_record_id),
           r.proposed_windows, r.proposed_unavailable,
           ogevia.availability_snapshot(r.organization_id, r.caregiver_record_id) -> 'windows',
           ogevia.availability_snapshot(r.organization_id, r.caregiver_record_id) -> 'unavailable',
           r.reviewed_at, rv.display_name, r.review_note
      from ogevia.caregiver_availability_requests r
      join ogevia.caregiver_records c on c.id = r.caregiver_record_id and c.organization_id = r.organization_id
      left join ogevia.app_users ru on ru.id = r.requested_by
      left join ogevia.app_users rv on rv.id = r.reviewed_by
     where r.organization_id = p_organization_id and (p_status is null or r.status = p_status)
     order by r.requested_at desc
     limit 200;
end;
$$;

create function ogevia_api.review_availability_request(p_request_id uuid, p_decision text, p_note text, p_idempotency_key uuid default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v ogevia.caregiver_availability_requests%rowtype;
  v_fp text := concat_ws('|', p_request_id, p_decision, btrim(coalesce(p_note, '')));
  v_prior jsonb;
  v_before jsonb;
  v_version integer;
begin
  select * into v from ogevia.caregiver_availability_requests where id = p_request_id for update;
  if v.id is null or not ogevia.is_active_member(v.organization_id) then
    raise exception 'Request not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v.organization_id, 'caregivers.manage') then
    raise exception 'You do not have permission to review availability' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('review_availability_request', p_idempotency_key, v.organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'version')::integer; end if;
  if p_decision not in ('approve', 'decline') then
    raise exception 'Decision must be approve or decline' using errcode = 'OGV22';
  end if;
  if p_decision = 'decline' and length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'Tell the caregiver why you are declining' using errcode = 'OGV22';
  end if;
  perform ogevia.lock_caregiver_schedule(v.caregiver_record_id);
  if v.status <> 'pending' then
    raise exception 'This request was already reviewed' using errcode = 'OGC09';
  end if;
  if p_decision = 'decline' then
    update ogevia.caregiver_availability_requests set status = 'declined', reviewed_by = v_actor, reviewed_at = now(), review_note = btrim(p_note) where id = v.id;
    perform ogevia.write_audit(v.organization_id, 'availability.declined', 'caregiver_availability_requests', v.id, null, jsonb_build_object('status', 'declined'), btrim(p_note));
    v_version := ogevia.availability_version(v.organization_id, v.caregiver_record_id);
  else
    if v.baseline_version <> ogevia.availability_version(v.organization_id, v.caregiver_record_id) then
      raise exception 'Approved availability changed after this request was written. Review the latest and ask the caregiver to request again, or decline.' using errcode = 'OGC09';
    end if;
    v_before := ogevia.availability_snapshot(v.organization_id, v.caregiver_record_id);
    v_version := ogevia.apply_availability(v.organization_id, v.caregiver_record_id,
      jsonb_build_object('windows', v.proposed_windows, 'unavailable', v.proposed_unavailable), v_actor, 'request');
    update ogevia.caregiver_availability_requests set status = 'approved', reviewed_by = v_actor, reviewed_at = now(), review_note = nullif(btrim(coalesce(p_note, '')), '') where id = v.id;
    perform ogevia.write_audit(v.organization_id, 'availability.approved', 'caregiver_availability_requests', v.id, v_before,
      jsonb_build_object('windows', v.proposed_windows, 'unavailable', v.proposed_unavailable, 'version', v_version), nullif(btrim(coalesce(p_note, '')), ''));
  end if;
  perform ogevia.idempotency_finish('review_availability_request', p_idempotency_key, v.organization_id, v_fp, jsonb_build_object('version', v_version));
  return v_version;
end;
$$;

-- Administrator edit: reason required, the version the administrator saw is checked, audited with before and after.
create function ogevia_api.set_caregiver_availability(
  p_organization_id uuid, p_caregiver_record_id uuid, p_windows jsonb, p_unavailable jsonb,
  p_reason text, p_expected_version integer, p_idempotency_key uuid default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_snap jsonb;
  v_norm jsonb;
  v_version integer;
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_windows::text, p_unavailable::text, btrim(coalesce(p_reason, '')), p_expected_version);
  v_prior jsonb;
begin
  if v_actor is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then
    raise exception 'You do not have permission to edit availability' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_caregiver_availability', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'version')::integer; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Care Team member not found' using errcode = 'OGN04';
  end if;
  perform ogevia.lock_caregiver_schedule(p_caregiver_record_id);
  if p_expected_version is null or p_expected_version <> ogevia.availability_version(p_organization_id, p_caregiver_record_id) then
    raise exception 'Availability changed since you opened it. Reload and edit again.' using errcode = 'OGC09';
  end if;
  v_snap := ogevia.availability_snapshot(p_organization_id, p_caregiver_record_id);
  v_norm := ogevia.normalize_availability(coalesce(p_windows, v_snap -> 'windows'), coalesce(p_unavailable, v_snap -> 'unavailable'));
  v_version := ogevia.apply_availability(p_organization_id, p_caregiver_record_id, v_norm, v_actor, 'admin');
  perform ogevia.write_audit(p_organization_id, 'availability.admin_edit', 'caregiver_records', p_caregiver_record_id,
    v_snap, v_norm || jsonb_build_object('version', v_version), btrim(p_reason));
  perform ogevia.idempotency_finish('set_caregiver_availability', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('version', v_version));
  return v_version;
end;
$$;

-- Future shifts that fall outside the caregiver's CURRENT approved availability or on an unavailable date.
-- Review list only: nothing is cancelled, moved or unassigned.
create function ogevia_api.list_availability_conflicts(p_organization_id uuid, p_caregiver_record_id uuid, p_horizon_days integer default 90)
returns table (shift_id uuid, starts_at timestamptz, ends_at timestamptz, client_code text, service_name text)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_horizon integer := least(greatest(coalesce(p_horizon_days, 90), 1), 365);
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'caregivers.manage') or ogevia.has_permission(p_organization_id, 'shifts.manage')) then
    raise exception 'You do not have permission to see availability conflicts' using errcode = 'OGA03';
  end if;
  return query
    select s.id, s.starts_at, s.ends_at, c.client_code, sv.name
      from ogevia.shifts s
      join ogevia.clients c on c.id = s.client_id and c.organization_id = s.organization_id
      join ogevia.services sv on sv.id = s.service_id and sv.organization_id = s.organization_id
      cross join lateral ogevia.assignment_readiness(s.organization_id, s.caregiver_record_id, s.client_id, s.service_id,
                                                      s.starts_at, s.ends_at, s.id, 'force', false, false) rd
     where s.organization_id = p_organization_id and s.caregiver_record_id = p_caregiver_record_id and s.status = 'scheduled'
       and s.starts_at > now() and s.starts_at < now() + make_interval(days => v_horizon)
       and not ogevia.shift_is_called_out(s.id)
       and exists (select 1 from jsonb_array_elements(rd -> 'reasons') x where x ->> 'code' = 'AVAILABILITY')
     order by s.starts_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function ogevia.availability_requests_guard_update() from public;
revoke all on function ogevia.availability_snapshot(uuid, uuid) from public;
revoke all on function ogevia.normalize_availability(jsonb, jsonb) from public;
revoke all on function ogevia.apply_availability(uuid, uuid, jsonb, uuid, text) from public;
revoke all on function ogevia.availability_version(uuid, uuid) from public;
revoke all on function ogevia_api.get_my_availability_state(uuid) from public;
revoke all on function ogevia_api.submit_availability_request(uuid, text, jsonb, jsonb, integer, uuid) from public;
revoke all on function ogevia_api.cancel_my_availability_request(uuid, uuid) from public;
revoke all on function ogevia_api.get_caregiver_availability(uuid, uuid) from public;
revoke all on function ogevia_api.list_availability_requests(uuid, text) from public;
revoke all on function ogevia_api.review_availability_request(uuid, text, text, uuid) from public;
revoke all on function ogevia_api.set_caregiver_availability(uuid, uuid, jsonb, jsonb, text, integer, uuid) from public;
revoke all on function ogevia_api.list_availability_conflicts(uuid, uuid, integer) from public;
grant execute on function ogevia_api.get_my_availability_state(uuid) to ogevia_app;
grant execute on function ogevia_api.submit_availability_request(uuid, text, jsonb, jsonb, integer, uuid) to ogevia_app;
grant execute on function ogevia_api.cancel_my_availability_request(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.get_caregiver_availability(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_availability_requests(uuid, text) to ogevia_app;
grant execute on function ogevia_api.review_availability_request(uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.set_caregiver_availability(uuid, uuid, jsonb, jsonb, text, integer, uuid) to ogevia_app;
grant execute on function ogevia_api.list_availability_conflicts(uuid, uuid, integer) to ogevia_app;
