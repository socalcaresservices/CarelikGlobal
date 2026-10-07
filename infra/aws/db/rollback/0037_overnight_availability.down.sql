-- ROLLBACK 0037_overnight_availability | CLASS: SAFE AUTOMATED (refuses if overnight data exists)
-- Restores the 0011 constraint (start before end) and the 0011 list_available_caregivers exactly,
-- and drops the helper. Refuses while any overnight window (end earlier than start) is stored,
-- because the restored constraint would reject it and the old matcher cannot read it: delete or
-- export those windows first (Care Team availability), then run this again. No row is changed.
do $$ begin
  if exists (select 1 from ogevia.caregiver_availability_windows where end_local < start_local) then
    raise exception 'ROLLBACK REFUSED: overnight availability windows exist; export or remove them first';
  end if;
end $$;

create or replace function ogevia_api.list_available_caregivers(p_organization_id uuid,p_request_id uuid)
returns table(caregiver_record_id uuid,caregiver_name text,current_client_match boolean,availability_source text)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  with req as(
    select r.*,o.timezone,(r.starts_at at time zone o.timezone)::date local_date,
      (r.starts_at at time zone o.timezone)::time local_start,
      (r.ends_at at time zone o.timezone)::time local_end,
      extract(dow from r.starts_at at time zone o.timezone)::smallint dow
    from ogevia.care_requests r join ogevia.organizations o on o.id=r.organization_id
    where r.id=p_request_id and r.organization_id=p_organization_id
  ), candidates as(
    select cr.id caregiver_record_id,cr.linked_user_id,cr.first_name,cr.last_name,cr.preferred_name,
      q.client_id,q.service_id,q.local_date,q.dow
    from req q join ogevia.caregiver_records cr on cr.organization_id=q.organization_id and cr.status in('ready','active') and cr.deleted_at is null
    where not exists(select 1 from ogevia.caregiver_unavailable_dates u where u.organization_id=q.organization_id and u.caregiver_record_id=cr.id and u.unavailable_date=q.local_date)
      and exists(select 1 from ogevia.caregiver_availability_windows w where w.organization_id=q.organization_id and w.caregiver_record_id=cr.id and (w.specific_date=q.local_date or (w.specific_date is null and w.weekday=q.dow)) and w.start_local<=q.local_start and w.end_local>=q.local_end)
      and not exists(select 1 from ogevia.shifts sh where sh.organization_id=q.organization_id and sh.caregiver_record_id=cr.id and sh.id is distinct from q.assigned_shift_id and sh.status in('scheduled','completed') and sh.starts_at<q.ends_at and sh.ends_at>q.starts_at)
      and not exists(select 1 from ogevia.care_request_offers oo where oo.care_request_id=q.id and oo.caregiver_record_id=cr.id and oo.status in('not_available','cancelled'))
  )
  select c.caregiver_record_id,coalesce(c.preferred_name,c.first_name)||' '||c.last_name,
    exists(select 1 from ogevia.caregiver_assignments a where a.organization_id=p_organization_id and a.caregiver_user_id=c.linked_user_id and a.client_id=c.client_id and a.service_id=c.service_id and a.is_active),
    case when exists(select 1 from ogevia.caregiver_availability_windows w where w.caregiver_record_id=c.caregiver_record_id and w.specific_date=c.local_date) then 'date-specific' else 'recurring' end
  from candidates c where ogevia.has_permission(p_organization_id,'care_requests.manage')
  order by 3 desc,2;
$$;

drop function ogevia.availability_covers(uuid, uuid, text, timestamptz, timestamptz, date, date);

alter table ogevia.caregiver_availability_windows drop constraint availability_time;
alter table ogevia.caregiver_availability_windows
  add constraint availability_time check (start_local < end_local);
comment on constraint availability_time on ogevia.caregiver_availability_windows is null;
