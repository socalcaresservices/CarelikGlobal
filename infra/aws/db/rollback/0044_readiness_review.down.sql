-- ROLLBACK 0044 | CLASS: SAFE AUTOMATED (no tables or records removed).
-- Removes only 0044's additional checks/read API. Restores the setter body.
drop trigger new_live_visit_readiness on ogevia.service_visits;
drop trigger assignments_client_requirements on ogevia.caregiver_assignments;
drop trigger shifts_client_requirements on ogevia.shifts;
drop function ogevia.new_live_visit_readiness_guard();
drop function ogevia.client_requirements_commit_guard();
drop function ogevia.assert_client_requirements(uuid, uuid, uuid);
drop function ogevia_api.get_matching_zip(uuid, uuid, text);
do $$
declare v_old text; v_new text;
begin
  select pg_get_functiondef('ogevia_api.review_document_version(uuid,text,text,uuid)'::regprocedure) into v_old;
  v_new := replace(v_old, '  if v_requirement is not null then
    if not ogevia.has_permission(v.organization_id, ''documents.requirements.manage'') then
      raise exception ''Only an administrator may verify required CPR and TB records.'' using errcode = ''OGA03'';
    end if;
    perform ogevia.lock_caregiver(v_rec);
  end if;', '  if v_requirement is not null then perform ogevia.lock_caregiver(v_rec); end if;');
  if v_new = v_old then raise exception '0044 rollback document verifier patch did not match'; end if;
  execute v_new;
end $$;
do $$
declare v_old text; v_new text;
begin
  select pg_get_functiondef('ogevia_api.set_client_experience_requirements(uuid,uuid,jsonb,text)'::regprocedure) into v_old;
  v_new := replace(v_old, '  perform pg_advisory_xact_lock(hashtextextended(''ogevia.client-requirements:'' || p_client_id::text, 0));
  delete from ogevia.client_experience_requirements where client_id = p_client_id;',
    '  delete from ogevia.client_experience_requirements where client_id = p_client_id;');
  if v_new = v_old then raise exception '0044 rollback setter patch did not match'; end if;
  execute v_new;
end $$;
