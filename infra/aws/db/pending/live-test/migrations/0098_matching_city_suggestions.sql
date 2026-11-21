-- Reuse an unambiguous city already entered for this ZIP in this agency.
create function ogevia_api.suggest_matching_city(p_org uuid, p_zip text)
returns text language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v_city text;
begin
  perform ogevia.matching_manage_guard(p_org);
  if p_zip is null or p_zip !~ '^[0-9]{5}$' then
    raise exception 'Enter a 5-digit ZIP code' using errcode = 'OGV22';
  end if;
  select case when count(distinct lower(c.city)) = 1 then min(c.city) end into v_city
  from (
    select z.city from ogevia.caregiver_zip z join ogevia.caregiver_records r
      on r.id=z.caregiver_record_id and r.organization_id=z.organization_id and r.deleted_at is null
    where z.organization_id=p_org and z.zip=p_zip
    union all
    select z.city from ogevia.client_service_zip z join ogevia.clients r
      on r.id=z.client_id and r.organization_id=z.organization_id and r.deleted_at is null
    where z.organization_id=p_org and z.zip=p_zip
  ) c;
  return v_city;
end;
$$;
revoke all on function ogevia_api.suggest_matching_city(uuid,text) from public;
grant execute on function ogevia_api.suggest_matching_city(uuid,text) to ogevia_app;
