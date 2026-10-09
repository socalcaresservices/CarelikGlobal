-- ROLLBACK 0040_availability_approval | CLASS: SAFE AUTOMATED (refuses while any availability request or profile exists)
-- Restores direct caregiver availability writes exactly as 0011 defined them and drops the approval workflow.
-- Refuses while any request or availability profile (version, who and when) is stored: those are records.
-- The approved windows and exceptions themselves are NOT touched by this rollback (they live in the 0011 tables).
do $$ begin
  if exists (select 1 from ogevia.caregiver_availability_requests) or exists (select 1 from ogevia.caregiver_availability_profiles) then
    raise exception 'ROLLBACK REFUSED: availability requests or profiles exist; they are kept';
  end if;
end $$;
drop function ogevia_api.list_availability_conflicts(uuid, uuid, integer);
drop function ogevia_api.set_caregiver_availability(uuid, uuid, jsonb, jsonb, text, integer, uuid);
drop function ogevia_api.review_availability_request(uuid, text, text, uuid);
drop function ogevia_api.list_availability_requests(uuid, text);
drop function ogevia_api.get_caregiver_availability(uuid, uuid);
drop function ogevia_api.cancel_my_availability_request(uuid, uuid);
drop function ogevia_api.submit_availability_request(uuid, text, jsonb, jsonb, integer, uuid);
drop function ogevia_api.get_my_availability_state(uuid);
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
drop function ogevia.availability_version(uuid, uuid);
drop function ogevia.apply_availability(uuid, uuid, jsonb, uuid, text);
drop function ogevia.normalize_availability(jsonb, jsonb);
drop function ogevia.availability_snapshot(uuid, uuid);
drop table ogevia.caregiver_availability_requests;
drop function ogevia.availability_requests_guard_update();
drop table ogevia.caregiver_availability_profiles;
