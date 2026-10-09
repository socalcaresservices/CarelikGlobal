-- ROLLBACK 0043_explainable_matching | CLASS: SAFE AUTOMATED (archives experience, ZIP and tag data; drops nothing that holds data)
-- list_available_caregivers returns to its 0039 form and the client-requirement hook returns to the empty 0042 form.
-- Every table that holds data is first copied to ogevia.archived_<table>_0043_<timestamp> (count-checked).
do $$
declare
  v_ts text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');
  t text;
  n_src bigint;
  n_dst bigint;
begin
  foreach t in array array['experience_tags', 'caregiver_experience', 'caregiver_experience_reviews', 'client_experience_requirements',
                           'caregiver_zip', 'client_service_zip', 'zip_centroids'] loop
    execute format('select count(*) from ogevia.%I', t) into n_src;
    if n_src > 0 then
      execute format('create table ogevia.%I as table ogevia.%I', 'archived_' || t || '_0043_' || v_ts, t);
      execute format('select count(*) from ogevia.%I', 'archived_' || t || '_0043_' || v_ts) into n_dst;
      if n_dst <> n_src then raise exception 'ROLLBACK REFUSED: archive copy of % is incomplete', t; end if;
    end if;
  end loop;
  select count(*) into n_src from ogevia.scoring_rule_versions where version <> 'v0-provisional-50-25-25';
  if n_src > 0 then
    execute format('create table ogevia.%I as table ogevia.scoring_rule_versions', 'archived_scoring_rule_versions_0043_' || v_ts);
  end if;
end $$;

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

create or replace function ogevia.client_requirement_issues(p_organization_id uuid, p_client_id uuid, p_caregiver_record_id uuid)
returns table (code text, message text)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select null::text, null::text where false;
$$;

drop function ogevia_api.match_caregivers(uuid, uuid, uuid, jsonb, uuid, text);
drop function ogevia_api.location_data_status(uuid);
drop function ogevia_api.set_client_service_zip(uuid, uuid, text);
drop function ogevia_api.set_caregiver_zip(uuid, uuid, text);
drop function ogevia_api.get_client_experience_requirements(uuid, uuid);
drop function ogevia_api.set_client_experience_requirements(uuid, uuid, jsonb, text);
drop function ogevia_api.get_caregiver_experience(uuid, uuid);
drop function ogevia_api.review_caregiver_experience(uuid, uuid, uuid[], text);
drop function ogevia_api.report_my_experience(uuid, uuid[]);
drop function ogevia_api.list_experience_tags(uuid);
drop function ogevia_api.create_experience_tag(uuid, text);
drop function ogevia.zip_distance_miles(text, text);
drop function ogevia.matching_manage_guard(uuid);
drop table ogevia.zip_centroids;
drop table ogevia.client_service_zip;
drop table ogevia.caregiver_zip;
drop table ogevia.client_experience_requirements;
drop table ogevia.caregiver_experience_reviews;
drop table ogevia.caregiver_experience;
drop table ogevia.experience_tags;
drop table ogevia.scoring_rule_versions;
delete from ogevia.role_permissions where permission_key in ('matching.read', 'matching.manage', 'experience.report_own');
delete from ogevia.permissions where key in ('matching.read', 'matching.manage', 'experience.report_own');
