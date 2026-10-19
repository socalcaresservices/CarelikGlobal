-- ROLLBACK 0085 | CLASS: SAFE AUTOMATED (functions only). Restores the 0054 create_caregiver (no gate) and the 0082 void_service_visit. Caregivers created and visits voided meanwhile are kept.
create or replace function ogevia_api.create_caregiver(p_organization_id uuid, p_first_name text, p_last_name text, p_preferred_name text DEFAULT NULL::text, p_status text DEFAULT 'onboarding'::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS TABLE(caregiver_record_id uuid, caregiver_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_first text := btrim(coalesce(p_first_name, ''));
  v_last text := btrim(coalesce(p_last_name, ''));
  v_pref text := nullif(btrim(coalesce(p_preferred_name, '')), '');
  v_fp text := concat_ws('|', p_organization_id, v_first, v_last, v_pref, p_status);
  v_prior jsonb;
  v_id uuid := gen_random_uuid();
  v_code text;
begin
  v_prior := ogevia.idempotency_begin('create_caregiver', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'caregiver_record_id')::uuid, v_prior ->> 'caregiver_code';
    return;
  end if;
  perform ogevia.check_caregiver_names(v_first, v_last, v_pref);
  if p_status is null or p_status not in ('applicant', 'onboarding', 'ready', 'active') then
    raise exception 'A new caregiver starts as an applicant, onboarding, ready or active' using errcode = 'OGV22';
  end if;
  loop
    v_code := 'CG-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 8));
    exit when not exists (select 1 from ogevia.caregiver_records r where r.organization_id = p_organization_id and r.caregiver_code = v_code);
  end loop;
  insert into ogevia.caregiver_records (id, organization_id, caregiver_code, first_name, last_name, preferred_name, status, onboarding_required)
  values (v_id, p_organization_id, v_code, v_first, v_last, v_pref, p_status, p_status = 'applicant');
  perform ogevia.write_audit(p_organization_id, 'caregiver.created', 'caregiver_records', v_id, null,
    jsonb_build_object('caregiver_code', v_code, 'first_name', v_first, 'last_name', v_last, 'preferred_name', v_pref, 'status', p_status), null);
  perform ogevia.idempotency_finish('create_caregiver', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('caregiver_record_id', v_id, 'caregiver_code', v_code));
  return query select v_id, v_code;
end;
$$;

CREATE OR REPLACE FUNCTION ogevia_api.void_service_visit(p_visit_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $function$
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to void a visit' using errcode = 'OGV22';
  end if;
  select * into v_visit from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_visit.organization_id, 'visits.manage') then
    raise exception 'Only an administrator can void a visit' using errcode = 'OGA03';
  end if;
  if v_visit.status not in ('draft', 'awaiting_signature') then
    raise exception 'A signed visit cannot be voided - use a correction instead' using errcode = 'OGC09';
  end if;
  -- 0082: voiding releases Pending minutes; serialised with the scheduling guards by the same lineage lock.
  perform ogevia.lock_visit_lineage(v_visit.id);
  update ogevia.service_visits sv
  set status = 'voided', voided_at = now(), voided_by = v_actor, void_reason = btrim(p_reason)
  where sv.id = v_visit.id;
  perform ogevia.write_audit(v_visit.organization_id, 'service_visit.voided', 'service_visits', v_visit.id,
    jsonb_build_object('status', v_visit.status), jsonb_build_object('status', 'voided'), btrim(p_reason));
end;
$function$;
