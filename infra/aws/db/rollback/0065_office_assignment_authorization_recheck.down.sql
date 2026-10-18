-- ROLLBACK 0065 | CLASS: SAFE AUTOMATED (no table or row is touched). Restores the 0042 office assignment (no authorization re-check) and removes the trigger.
drop trigger shifts_authorization on ogevia.shifts;
drop function ogevia.shifts_authorization_guard();
create or replace function ogevia_api.assign_shift_caregiver(
  p_organization_id uuid, p_shift_id uuid, p_caregiver_record_id uuid, p_reason text default null, p_idempotency_key uuid default null
)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_shift_id, p_caregiver_record_id);
  v_prior jsonb;
  v_s ogevia.shifts%rowtype;
  v_rec ogevia.caregiver_records%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  v_prior := ogevia.idempotency_begin('assign_shift_caregiver', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'state'; end if;
  v_s := ogevia.lock_staff_shift(p_organization_id, p_shift_id);
  if v_s.ends_at <= now() then raise exception 'This shift is already over' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit has already started for this shift' using errcode = 'OGC09';
  end if;
  if v_s.caregiver_record_id = p_caregiver_record_id and not ogevia.shift_is_called_out(v_s.id) then
    raise exception 'This caregiver is already on this shift' using errcode = 'OGC09';
  end if;
  if v_s.caregiver_record_id is not null and not ogevia.shift_is_called_out(v_s.id) and v_reason is null then
    raise exception 'Give a reason for changing the caregiver' using errcode = 'OGV22';
  end if;
  if v_s.caregiver_record_id = p_caregiver_record_id then
    raise exception 'This caregiver called out of this shift; choose someone else' using errcode = 'OGC09';
  end if;
  v_rec := ogevia.check_shift_caregiver(p_organization_id, p_caregiver_record_id, v_s.starts_at, v_s.ends_at, v_s.id, v_s.service_id);
  insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type, actor_user_id, original_caregiver_record_id,
                                            replacement_caregiver_record_id, reason, before_snapshot, after_snapshot)
  values (p_organization_id, v_s.id, 'reassigned', v_actor, v_s.caregiver_record_id, v_rec.id,
          coalesce(v_reason, case when v_s.caregiver_record_id is null then 'Open shift filled' else 'Replacement after call-out' end),
          jsonb_build_object('caregiver_record_id', v_s.caregiver_record_id), jsonb_build_object('caregiver_record_id', v_rec.id));
  update ogevia.shifts set caregiver_record_id = v_rec.id, caregiver_user_id = v_rec.linked_user_id, updated_at = now() where id = v_s.id;
  perform ogevia.write_audit(p_organization_id, 'shift.caregiver_assigned', 'shifts', v_s.id,
    jsonb_build_object('caregiver_record_id', v_s.caregiver_record_id), jsonb_build_object('caregiver_record_id', v_rec.id), v_reason);
  perform ogevia.idempotency_finish('assign_shift_caregiver', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'covered'));
  return 'covered';
end;
$$;
