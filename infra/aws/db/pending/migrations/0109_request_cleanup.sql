-- 0109 (PENDING: infra/aws/db/pending) | CLASS: ADDITIVE (two nullable columns, three functions). Not applied to any database.
-- Owner request (2026-11-17): staff can cancel a document request, retire a duplicate document type, and clear care-request alerts.
--   * cancel_staff_document_request: closes an open request that has NO upload yet (closed_at, by whom, reason). Nothing is deleted; the
--     existing compliance trigger on closed_at re-evaluates the caregiver. A request that already has an upload is refused: review or replace it.
--   * retire_document_type: marks a type inactive so it can no longer be requested. Refused for the type used as the agency's CPR or TB
--     requirement, and while it still has open requests (cancel those first). Reversible: set is_active back to true.
--   * mark_staff_care_notifications_read: the caller's OWN unread care-request alerts (all, or the listed ids) are marked read.
-- Every change is tenant-scoped, permission-checked server-side and audited. Rollback: pending/rollback/0109_request_cleanup.down.sql.

alter table ogevia.staff_documents add column cancelled_by uuid references ogevia.app_users(id);
alter table ogevia.staff_documents add column cancel_reason text check (cancel_reason is null or length(btrim(cancel_reason)) between 3 and 500);
alter table ogevia.document_types add column retired_by uuid references ogevia.app_users(id);
alter table ogevia.document_types add column retired_at timestamptz;

create function ogevia_api.cancel_staff_document_request(p_organization_id uuid, p_document_id uuid, p_reason text, p_idempotency_key uuid default null)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_document_id, v_reason);
  v_prior jsonb;
  v_doc ogevia.staff_documents%rowtype;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'documents.manage') then
    raise exception 'You do not have permission to cancel document requests' using errcode = 'OGA03';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then raise exception 'Give a reason (3 to 500 characters)' using errcode = 'OGV22'; end if;
  v_prior := ogevia.idempotency_begin('cancel_staff_document_request', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'status'; end if;
  select * into v_doc from ogevia.staff_documents d where d.id = p_document_id and d.organization_id = p_organization_id for update;
  if v_doc.id is null then raise exception 'Document request not found' using errcode = 'OGN04'; end if;
  if v_doc.closed_at is not null then raise exception 'This request is already closed' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.document_versions v where v.document_id = v_doc.id) then
    raise exception 'This request already has an upload. Review or replace it instead of cancelling.' using errcode = 'OGC09';
  end if;
  update ogevia.staff_documents set closed_at = now(), cancelled_by = v_actor, cancel_reason = v_reason where id = v_doc.id;
  perform ogevia.write_audit(p_organization_id, 'document.request_cancelled', 'staff_documents', v_doc.id,
    jsonb_build_object('closed_at', null),
    jsonb_build_object('caregiver_record_id', v_doc.caregiver_record_id, 'document_type_id', v_doc.document_type_id), v_reason);
  perform ogevia.idempotency_finish('cancel_staff_document_request', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('status', 'cancelled'));
  return 'cancelled';
end;
$$;

create function ogevia_api.retire_document_type(p_organization_id uuid, p_document_type_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_type ogevia.document_types%rowtype;
  v_open integer;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'documents.manage') then
    raise exception 'You do not have permission to change document types' using errcode = 'OGA03';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then raise exception 'Give a reason (3 to 500 characters)' using errcode = 'OGV22'; end if;
  select * into v_type from ogevia.document_types t where t.id = p_document_type_id and t.organization_id = p_organization_id for update;
  if v_type.id is null then raise exception 'Document type not found' using errcode = 'OGN04'; end if;
  if not v_type.is_active then return 'already_retired'; end if;
  if v_type.work_requirement is not null then
    raise exception 'This type is used for the agency''s % requirement. Choose another type for it first.', upper(v_type.work_requirement) using errcode = 'OGC09';
  end if;
  select count(*) into v_open from ogevia.staff_documents d where d.document_type_id = v_type.id and d.organization_id = p_organization_id and d.closed_at is null;
  if v_open > 0 then
    raise exception 'This type still has % open request(s). Cancel or complete them first.', v_open using errcode = 'OGC09';
  end if;
  update ogevia.document_types set is_active = false, retired_by = v_actor, retired_at = now() where id = v_type.id;
  perform ogevia.write_audit(p_organization_id, 'document_type.retired', 'document_types', v_type.id,
    jsonb_build_object('is_active', true), jsonb_build_object('is_active', false, 'name', v_type.name), v_reason);
  return 'retired';
end;
$$;

create function ogevia_api.mark_staff_care_notifications_read(p_organization_id uuid, p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor(); v_count integer;
begin
  if not ogevia.has_permission(p_organization_id, 'care_requests.read') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  if p_ids is not null and cardinality(p_ids) > 100 then raise exception 'At most 100 alerts at a time' using errcode = 'OGV22'; end if;
  update ogevia.care_notifications n set read_at = now()
   where n.organization_id = p_organization_id and n.recipient_type = 'staff' and n.recipient_user_id = v_actor and n.read_at is null
     and (p_ids is null or n.id = any(p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function ogevia_api.cancel_staff_document_request(uuid, uuid, text, uuid) from public;
revoke all on function ogevia_api.retire_document_type(uuid, uuid, text) from public;
revoke all on function ogevia_api.mark_staff_care_notifications_read(uuid, uuid[]) from public;
grant execute on function ogevia_api.cancel_staff_document_request(uuid, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.retire_document_type(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.mark_staff_care_notifications_read(uuid, uuid[]) to ogevia_app;
