-- 0009 - Phase 4 read functions for the AWS API.
--
-- get_my_context: the caller's ACTIVE memberships in ACTIVE organizations,
--   with role and effective permissions, derived from begin_request's actor.
--   This is what the browser uses to pick an organization; it is display
--   data only. Every other API function re-checks membership/permission.
-- get_visit_signature_evidence: S3 object reference of the signature that a
--   CONFIRMED visit was locked with, for users holding visits.read in the
--   visit's organization. The API turns it into a short-lived download URL.
--   Every read is audited.
-- get_confirmation_replay: the stored result of the CALLER'S OWN earlier
--   confirm_service_visit call with this idempotency key, so a retried
--   signature confirmation does not upload a second object. Returns no row
--   when there is none.

create function ogevia_api.get_my_context()
returns table (
  organization_id uuid,
  organization_slug text,
  organization_name text,
  organization_timezone text,
  role ogevia.system_role,
  permissions text[]
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select o.id, o.slug, o.display_name, o.timezone, m.role,
         coalesce(array(
           select rp.permission_key from ogevia.role_permissions rp
           where rp.role = m.role order by rp.permission_key
         ), '{}')
  from ogevia.organization_memberships m
  join ogevia.organizations o on o.id = m.organization_id
  where m.user_id = ogevia.require_actor()
    and m.status = 'active'
    and o.status = 'active'
  order by o.display_name, o.id;
$$;

create function ogevia_api.get_visit_signature_evidence(p_visit_id uuid)
returns table (
  evidence_id uuid,
  organization_id uuid,
  object_key text,
  object_version_id text,
  content_type text,
  byte_size integer,
  sha256_hex text
)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_evidence ogevia.visit_evidence%rowtype;
begin
  select * into v_visit from ogevia.service_visits sv where sv.id = p_visit_id;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_visit.organization_id, 'visits.read') then
    raise exception 'Not permitted to view visit evidence' using errcode = 'OGA03';
  end if;
  -- Corrections keep the original confirmation; follow back to the root visit.
  select e.* into v_evidence
  from ogevia.visit_confirmations c
  join ogevia.visit_evidence e on e.id = c.evidence_id
  where c.visit_id = coalesce(v_visit.original_visit_id, v_visit.id)
    and c.organization_id = v_visit.organization_id;
  if v_evidence.id is null then
    raise exception 'This visit has no signature evidence' using errcode = 'OGN04';
  end if;
  perform ogevia.write_audit(v_visit.organization_id, 'visit_evidence.read', 'visit_evidence',
    v_evidence.id, null, jsonb_build_object('visit_id', v_visit.id));
  return query select v_evidence.id, v_evidence.organization_id, v_evidence.object_key,
    v_evidence.object_version_id, v_evidence.content_type, v_evidence.byte_size, v_evidence.sha256_hex;
end;
$$;

create function ogevia_api.get_confirmation_replay(p_visit_id uuid, p_idempotency_key uuid)
returns table (
  visit_id uuid,
  status ogevia.service_visit_status,
  authorization_status ogevia.visit_authorization_status,
  worked_minutes integer,
  billable_minutes integer,
  month_to_date_minutes bigint,
  remaining_minutes bigint
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select (r.response ->> 'visit_id')::uuid,
         (r.response ->> 'status')::ogevia.service_visit_status,
         (r.response ->> 'authorization_status')::ogevia.visit_authorization_status,
         (r.response ->> 'worked_minutes')::integer, (r.response ->> 'billable_minutes')::integer,
         (r.response ->> 'month_to_date_minutes')::bigint, (r.response ->> 'remaining_minutes')::bigint
  from ogevia.idempotency_records r
  where r.actor_user_id = ogevia.require_actor()
    and r.operation = 'confirm_visit'
    and r.idempotency_key = p_idempotency_key
    and (r.response ->> 'visit_id')::uuid = p_visit_id
    and ogevia.is_active_member(r.organization_id);
$$;

revoke all on function ogevia_api.get_confirmation_replay(uuid, uuid) from public;
grant execute on function ogevia_api.get_confirmation_replay(uuid, uuid) to ogevia_app;
revoke all on function ogevia_api.get_my_context() from public;
revoke all on function ogevia_api.get_visit_signature_evidence(uuid) from public;
grant execute on function ogevia_api.get_my_context() to ogevia_app;
grant execute on function ogevia_api.get_visit_signature_evidence(uuid) to ogevia_app;
