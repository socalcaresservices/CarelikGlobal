-- 0045 Manual care-request offers (owner clarification: a caregiver the Matches list excludes may still be assigned manually).
-- Only send_care_offer changes: it no longer requires the caregiver to be in the Matches list. Nothing is waived at assignment:
-- assign_care_request still runs the readiness gate and the client-requirement checks. Existing grants are kept by CREATE OR REPLACE.
-- Manual offers: an administrator may send an offer to any active caregiver in the organisation, including one the
-- Matches list excludes (score data, distance or optional experience missing, or availability not yet approved).
-- Nothing is waived: the readiness gate still runs when the request is assigned (CPR/TB, service approval when
-- enforced, mandatory client requirements, caregiver status, overlap, and approved hours or a recorded override).
create or replace function ogevia_api.send_care_offer(p_organization_id uuid, p_request_id uuid, p_caregiver_record_id uuid, p_token_hash text)
returns uuid
language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_offer uuid;
begin
  if not ogevia.has_permission(p_organization_id, 'care_requests.manage') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  if not exists (select 1 from ogevia.care_requests r where r.id = p_request_id and r.organization_id = p_organization_id
                   and r.status in ('requested', 'offering', 'accepted_pending_assignment', 'coverage_needed')) then
    raise exception 'Request not found or no longer open' using errcode = 'OGN04';
  end if;
  if not exists (select 1 from ogevia.caregiver_records cr where cr.id = p_caregiver_record_id and cr.organization_id = p_organization_id
                   and cr.status in ('ready', 'active') and cr.deleted_at is null) then
    raise exception 'Caregiver is not active in this organization' using errcode = 'OGV22';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid token hash' using errcode = 'OGV22'; end if;
  insert into ogevia.care_request_offers(organization_id, care_request_id, caregiver_record_id, token_hash)
  values (p_organization_id, p_request_id, p_caregiver_record_id, p_token_hash)
  on conflict (care_request_id, caregiver_record_id) do update set token_hash = excluded.token_hash, status = 'sent', responded_at = null, updated_at = now()
  returning id into v_offer;
  update ogevia.care_requests set status = 'offering', updated_at = now() where id = p_request_id and status in ('requested', 'coverage_needed');
  return v_offer;
end;$$;
