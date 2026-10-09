-- ROLLBACK 0039_availability_approval | CLASS: SAFE AUTOMATED (keeps approved hours; archives request history)
-- Nothing is dropped while it holds data. The approved hours in force today (and approved
-- future-dated exceptions) are rewritten as plain availability rows, exactly the shape 0011/0037
-- read, so matching keeps working. Every request, version counter, flag and original window row is
-- first copied to tables named ogevia.archived_<table>_0039_<timestamp> (a count-checked copy) and only then recopied from ogevia.
-- Re-applying 0039 afterwards starts a fresh history; the archive tables are kept for audit.
create temp table _og0039_weekly on commit drop as
  select c.organization_id, c.caregiver_record_id, (e ->> 'weekday')::smallint as weekday,
         (e ->> 'start_local')::time as start_local, (e ->> 'end_local')::time as end_local
  from (select distinct organization_id, caregiver_record_id from ogevia.caregiver_availability_windows) c
  cross join lateral jsonb_array_elements(ogevia.availability_pattern(c.organization_id, c.caregiver_record_id,
        ogevia.organization_local_date(c.organization_id, now()))) e;

create temp table _og0039_dates on commit drop as
  select d.organization_id, d.caregiver_record_id, d.on_date,
         ogevia.availability_day(d.organization_id, d.caregiver_record_id, d.on_date) as hours
  from (select organization_id, caregiver_record_id, specific_date as on_date from ogevia.caregiver_availability_windows
         where specific_date >= ogevia.organization_local_date(organization_id, now())
        union
        select organization_id, caregiver_record_id, unavailable_date from ogevia.caregiver_unavailable_dates
         where unavailable_date >= ogevia.organization_local_date(organization_id, now())) d;

do $$
declare
  v_ts text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');
  t text;
  n_src bigint;
  n_dst bigint;
begin
  foreach t in array array['availability_requests', 'caregiver_availability_state', 'shift_readiness_flags',
                           'caregiver_availability_windows', 'caregiver_unavailable_dates'] loop
    execute format('select count(*) from ogevia.%I', t) into n_src;
    if n_src > 0 then
      execute format('create table ogevia.%I as table ogevia.%I', 'archived_' || t || '_0039_' || v_ts, t);
      execute format('select count(*) from ogevia.%I', 'archived_' || t || '_0039_' || v_ts) into n_dst;
      if n_dst <> n_src then raise exception 'ROLLBACK REFUSED: archive copy of % is incomplete', t; end if;
      if t = 'availability_requests' then
        -- The archive must not depend on the enum type that this rollback drops.
        execute format('alter table ogevia.%I alter column status type text using status::text', 'archived_' || t || '_0039_' || v_ts);
      end if;
    end if;
  end loop;
end $$;

delete from ogevia.caregiver_availability_windows;
delete from ogevia.caregiver_unavailable_dates;
alter table ogevia.caregiver_availability_windows drop column request_id;
alter table ogevia.caregiver_unavailable_dates drop column request_id;
alter table ogevia.caregiver_unavailable_dates drop constraint caregiver_unavailable_dates_pkey;
alter table ogevia.caregiver_unavailable_dates drop column id;
alter table ogevia.caregiver_unavailable_dates add primary key (organization_id, caregiver_record_id, unavailable_date);

insert into ogevia.caregiver_availability_windows (organization_id, caregiver_record_id, weekday, specific_date, start_local, end_local)
  select organization_id, caregiver_record_id, weekday, null, start_local, end_local from _og0039_weekly;
insert into ogevia.caregiver_availability_windows (organization_id, caregiver_record_id, weekday, specific_date, start_local, end_local)
  select d.organization_id, d.caregiver_record_id, null, d.on_date, (h ->> 'start_local')::time, (h ->> 'end_local')::time
  from _og0039_dates d cross join lateral jsonb_array_elements(d.hours -> 'windows') h
  where not (d.hours ->> 'unavailable')::boolean;
insert into ogevia.caregiver_unavailable_dates (organization_id, caregiver_record_id, unavailable_date)
  select organization_id, caregiver_record_id, on_date from _og0039_dates where (hours ->> 'unavailable')::boolean;


-- Restore the 0011/0037 definitions exactly.
create or replace function ogevia_api.replace_my_availability(p_organization_id uuid,p_windows jsonb,p_unavailable_dates jsonb default '[]'::jsonb)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_cr uuid;
begin
 if not ogevia.has_permission(p_organization_id,'availability.manage_own') then raise exception 'Forbidden' using errcode='OGA03'; end if;
 select id into v_cr from ogevia.caregiver_records where organization_id=p_organization_id and linked_user_id=ogevia.require_actor() and status in('ready','active') and deleted_at is null;
 if v_cr is null then raise exception 'Caregiver record not found' using errcode='OGN04'; end if;
 delete from ogevia.caregiver_availability_windows where organization_id=p_organization_id and caregiver_record_id=v_cr;
 insert into ogevia.caregiver_availability_windows(organization_id,caregiver_record_id,weekday,specific_date,start_local,end_local)
 select p_organization_id,v_cr,x.weekday,x.specific_date,x.start_local,x.end_local from jsonb_to_recordset(coalesce(p_windows,'[]'::jsonb)) as x(weekday smallint,specific_date date,start_local time,end_local time);
 delete from ogevia.caregiver_unavailable_dates where organization_id=p_organization_id and caregiver_record_id=v_cr;
 insert into ogevia.caregiver_unavailable_dates(organization_id,caregiver_record_id,unavailable_date)
 select p_organization_id,v_cr,(jsonb_array_elements_text(coalesce(p_unavailable_dates,'[]'::jsonb)))::date;
end;$$;

create or replace function ogevia_api.get_my_availability(p_organization_id uuid)
returns table(window_id uuid,weekday smallint,specific_date date,start_local time,end_local time)
language sql stable security definer set search_path = ogevia, pg_temp as $$
 select w.id,w.weekday,w.specific_date,w.start_local,w.end_local from ogevia.caregiver_availability_windows w join ogevia.caregiver_records cr on cr.id=w.caregiver_record_id and cr.organization_id=w.organization_id and cr.linked_user_id=ogevia.require_actor()
 where w.organization_id=p_organization_id and ogevia.has_permission(p_organization_id,'availability.manage_own') order by w.specific_date nulls last,w.weekday,w.start_local;
$$;

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
    (
      select range_agg(tstzrange(inst.s, inst.e, '[)'))
      from (
        select (d.day + w.start_local) at time zone p_timezone as s,
               (d.day + case when w.end_local < w.start_local then 1 else 0 end + w.end_local) at time zone p_timezone as e
        from (select g::date as day from generate_series((p_first_date - 1)::timestamp, p_last_date::timestamp, interval '1 day') g) d
        join ogevia.caregiver_availability_windows w
          on w.organization_id = p_organization_id
         and w.caregiver_record_id = p_caregiver_record_id
         and (w.specific_date = d.day or (w.specific_date is null and w.weekday = extract(dow from d.day)))
      ) inst
    ) @> tstzrange(p_starts, p_ends, '[)'),
    false);
$$;

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
    where not exists(select 1 from ogevia.caregiver_unavailable_dates u where u.organization_id=q.organization_id and u.caregiver_record_id=cr.id and u.unavailable_date between q.local_date and q.local_end_date)
      and ogevia.availability_covers(q.organization_id, cr.id, q.timezone, q.starts_at, q.ends_at, q.local_date, q.local_end_date)
      and not exists(select 1 from ogevia.shifts sh where sh.organization_id=q.organization_id and sh.caregiver_record_id=cr.id and sh.id is distinct from q.assigned_shift_id and sh.status in('scheduled','completed') and sh.starts_at<q.ends_at and sh.ends_at>q.starts_at)
      and not exists(select 1 from ogevia.care_request_offers oo where oo.care_request_id=q.id and oo.caregiver_record_id=cr.id and oo.status in('not_available','cancelled'))
  )
  select c.caregiver_record_id,coalesce(c.preferred_name,c.first_name)||' '||c.last_name,
    exists(select 1 from ogevia.caregiver_assignments a where a.organization_id=p_organization_id and a.caregiver_user_id=c.linked_user_id and a.client_id=c.client_id and a.service_id=c.service_id and a.is_active),
    case when exists(select 1 from ogevia.caregiver_availability_windows w where w.caregiver_record_id=c.caregiver_record_id and w.specific_date=c.local_date) then 'date-specific' else 'recurring' end
  from candidates c where ogevia.has_permission(p_organization_id,'care_requests.manage')
  order by 3 desc,2;
$$;

drop function ogevia_api.set_availability_direct(uuid, uuid, text, jsonb, date, date, text, uuid);
drop function ogevia_api.review_availability_request(uuid, uuid, text, text, uuid);
drop function ogevia_api.preview_availability_request(uuid, uuid);
drop function ogevia_api.list_availability_requests(uuid, text);
drop function ogevia_api.withdraw_availability_request(uuid, uuid);
drop function ogevia_api.request_availability_change(uuid, text, jsonb, date, date, text, integer, uuid);
drop function ogevia_api.get_availability(uuid, uuid);
drop function ogevia.availability_actor_record(uuid);
drop function ogevia.availability_apply(uuid, uuid, text, boolean);
drop function ogevia.availability_covered_future_shifts(uuid, uuid);
drop function ogevia.availability_is_noop(uuid, uuid, text, jsonb, date);

drop function ogevia.availability_status(uuid, uuid, timestamptz, timestamptz);
drop function ogevia.availability_day(uuid, uuid, date);
drop function ogevia.availability_pattern(uuid, uuid, date);
drop function ogevia.availability_check_windows(text, jsonb);
drop function ogevia.lock_caregiver(uuid);
drop function ogevia.availability_blocked_days(uuid, uuid, text, date, date);
drop function ogevia.availability_layer_ranges(uuid, uuid, text, date, date);
drop table ogevia.shift_readiness_flags;
drop table ogevia.availability_requests;
drop table ogevia.caregiver_availability_state;
drop type ogevia.availability_request_status;
delete from ogevia.role_permissions where permission_key in ('availability.read', 'availability.review');
delete from ogevia.permissions where key in ('availability.read', 'availability.review');
