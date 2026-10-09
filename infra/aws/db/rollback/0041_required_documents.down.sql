-- Archive copies retain values, not operational constraints or automatic restoration.
-- Prefer retaining the migrated database and rolling back compatible application artifacts.
-- ROLLBACK 0041_required_documents | CLASS: BACKUP REQUIRED (archives rules and flags; document records are untouched)
-- The CPR/TB designations, validity rules, rule history and document flags are copied to
-- ogevia.archived_*_0041_<timestamp> tables (count-checked) before being removed. Staff documents,
-- versions and their reviews (0021) are not touched. review_document_version returns to its 0021 form.
do $$
declare
  v_ts text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');
  n_src bigint;
  n_dst bigint;
begin
  select count(*) into n_src from ogevia.document_requirement_policies;
  if n_src > 0 then
    execute format('create table ogevia.%I as table ogevia.document_requirement_policies', 'archived_document_requirement_policies_0041_' || v_ts);
    execute format('select count(*) from ogevia.%I', 'archived_document_requirement_policies_0041_' || v_ts) into n_dst;
    if n_dst <> n_src then raise exception 'ROLLBACK REFUSED: archive copy of document_requirement_policies is incomplete'; end if;
  end if;
  select count(*) into n_src from ogevia.document_requirement_policy_history;
  if n_src > 0 then
    execute format('create table ogevia.%I as table ogevia.document_requirement_policy_history', 'archived_document_requirement_policy_history_0041_' || v_ts);
    execute format('select count(*) from ogevia.%I', 'archived_document_requirement_policy_history_0041_' || v_ts) into n_dst;
    if n_dst <> n_src then raise exception 'ROLLBACK REFUSED: archive copy of policy history is incomplete'; end if;
  end if;
  select count(*) into n_src from ogevia.document_types where work_requirement is not null;
  if n_src > 0 then
    execute format('create table ogevia.%I as select id, organization_id, work_requirement from ogevia.document_types where work_requirement is not null', 'archived_document_work_requirements_0041_' || v_ts);
  end if;
  select count(*) into n_src from ogevia.shift_readiness_flags where kind = 'document';
  if n_src > 0 then
    execute format('create table ogevia.%I as select * from ogevia.shift_readiness_flags where kind = ''document''', 'archived_shift_document_flags_0041_' || v_ts);
    execute format('select count(*) from ogevia.%I', 'archived_shift_document_flags_0041_' || v_ts) into n_dst;
    if n_dst <> n_src then raise exception 'ROLLBACK REFUSED: archive copy of shift document flags is incomplete'; end if;
  end if;
  select count(*) into n_src from ogevia.assignment_readiness_flags where kind = 'document';
  if n_src > 0 then
    execute format('create table ogevia.%I as select * from ogevia.assignment_readiness_flags where kind = ''document''', 'archived_assignment_document_flags_0041_' || v_ts);
    execute format('select count(*) from ogevia.%I', 'archived_assignment_document_flags_0041_' || v_ts) into n_dst;
    if n_dst <> n_src then raise exception 'ROLLBACK REFUSED: archive copy of assignment document flags is incomplete'; end if;
  end if;
end $$;

delete from ogevia.shift_readiness_flags where kind = 'document';
delete from ogevia.assignment_readiness_flags where kind = 'document';

create or replace function ogevia_api.review_document_version(p_version_id uuid, p_decision text, p_reason text, p_idempotency_key uuid default null)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v ogevia.document_versions%rowtype;
  v_fp text := concat_ws('|', p_version_id, p_decision, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_self boolean;
begin
  select * into v from ogevia.document_versions where id = p_version_id for update;
  if v.id is null or not ogevia.is_active_member(v.organization_id) then
    raise exception 'Document not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v.organization_id, 'documents.manage') then
    raise exception 'You do not have permission to review documents' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('review_document_version', p_idempotency_key, v.organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'decision'; end if;
  if p_decision not in ('verified', 'rejected') then
    raise exception 'Decision must be verified or rejected' using errcode = 'OGV22';
  end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to reject a document' using errcode = 'OGV22';
  end if;
  v_self := v.uploaded_by = v_actor;
  if v_self and not ogevia.has_permission(v.organization_id, 'documents.review_own') then
    raise exception 'You cannot review a document you uploaded; ask the Administrator or another manager' using errcode = 'OGA03';
  end if;
  if v.review_status <> 'awaiting_review' then
    raise exception 'This document version has already been reviewed' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.document_versions n where n.document_id = v.document_id and n.version_number > v.version_number) then
    raise exception 'A newer version was uploaded; review that one' using errcode = 'OGC09';
  end if;
  update ogevia.document_versions set review_status = p_decision::ogevia.document_review_status, reviewed_by = v_actor,
    reviewed_at = now(), rejection_reason = case when p_decision = 'rejected' then btrim(p_reason) end
   where id = v.id;
  perform ogevia.write_audit(v.organization_id, 'document.' || p_decision, 'document_versions', v.id,
    jsonb_build_object('review_status', 'awaiting_review'),
    jsonb_build_object('review_status', p_decision, 'self_review', v_self),
    case when v_self then 'Administrator self-review' || coalesce(': ' || nullif(btrim(coalesce(p_reason, '')), ''), '')
         else nullif(btrim(coalesce(p_reason, '')), '') end);
  perform ogevia.idempotency_finish('review_document_version', p_idempotency_key, v.organization_id, v_fp,
    jsonb_build_object('decision', p_decision));
  return p_decision;
end;
$$;

drop function ogevia_api.list_document_readiness(uuid);
drop function ogevia_api.get_document_readiness(uuid, uuid, timestamptz, timestamptz);
drop function ogevia_api.set_requirement_policy(uuid, text, text, integer, text, uuid);
drop function ogevia_api.set_document_work_requirement(uuid, text, uuid, text, uuid);
drop function ogevia_api.get_work_requirement_setup(uuid);
drop function ogevia.requirement_admin_guard(uuid);
drop function ogevia.document_flag_impact(uuid, uuid, uuid, uuid);
drop function ogevia.document_readiness(uuid, uuid, timestamptz, timestamptz);
drop function ogevia.document_requirement_check(uuid, uuid, text, timestamptz, timestamptz);
drop table ogevia.document_requirement_policy_history;
drop table ogevia.document_requirement_policies;
drop index ogevia.document_types_one_work_requirement;
alter table ogevia.document_types drop column work_requirement;
delete from ogevia.role_permissions where permission_key = 'documents.requirements.manage';
delete from ogevia.permissions where key = 'documents.requirements.manage';
