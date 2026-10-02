-- 0012 - A reusable client/family care link lists its own upcoming requests.
-- Without this a family member who reopens the link (another device, a reload,
-- a second family member) cannot see status or cancel. Scope is identical to
-- public_get_care_request / public_cancel_care_request: only requests created
-- through THIS link (portal_id), resolved through ogevia.care_portal_by_token,
-- so revocation, expiry and active organization/client rules apply unchanged.

create function ogevia_api.public_list_care_requests(p_token_hash text)
returns table(request_id uuid,status ogevia.care_request_status,service_code text,service_name text,starts_at timestamptz,ends_at timestamptz,short_notice boolean,caregiver_name text)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v_portal ogevia.client_care_portals%rowtype;
begin
  v_portal := ogevia.care_portal_by_token(p_token_hash);
  if v_portal.id is null then raise exception 'This link is not valid or is no longer active' using errcode='OGN04'; end if;
  return query
    select r.id,r.status,s.code,s.name,r.starts_at,r.ends_at,r.short_notice,
      case when r.status='assigned' then coalesce(cr.preferred_name,cr.first_name) else null end
    from ogevia.care_requests r
    join ogevia.services s on s.id=r.service_id
    left join ogevia.caregiver_records cr on cr.id=r.assigned_caregiver_record_id
    where r.portal_id=v_portal.id and r.organization_id=v_portal.organization_id and r.ends_at>now()
    order by r.starts_at
    limit 50;
end;$$;

revoke all on function ogevia_api.public_list_care_requests(text) from public;
grant execute on function ogevia_api.public_list_care_requests(text) to ogevia_app;
