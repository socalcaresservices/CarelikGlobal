-- ROLLBACK 0045 | CLASS: SAFE AUTOMATED (no tables or records removed). Restores send_care_offer to its 0011 form.
create or replace function ogevia_api.send_care_offer(p_organization_id uuid,p_request_id uuid,p_caregiver_record_id uuid,p_token_hash text)
returns uuid
language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_offer uuid;
begin
  if not ogevia.has_permission(p_organization_id,'care_requests.manage') then raise exception 'Forbidden' using errcode='OGA03'; end if;
  if not exists(select 1 from ogevia_api.list_available_caregivers(p_organization_id,p_request_id) x where x.caregiver_record_id=p_caregiver_record_id) then raise exception 'Caregiver is not currently available for this request' using errcode='OGV22'; end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid token hash' using errcode='OGV22'; end if;
  insert into ogevia.care_request_offers(organization_id,care_request_id,caregiver_record_id,token_hash)
  values(p_organization_id,p_request_id,p_caregiver_record_id,p_token_hash)
  on conflict(care_request_id,caregiver_record_id) do update set token_hash=excluded.token_hash,status='sent',responded_at=null,updated_at=now()
  returning id into v_offer;
  update ogevia.care_requests set status='offering',updated_at=now() where id=p_request_id and status in('requested','coverage_needed');
  return v_offer;
end;$$;
