-- 0065 Office assignment re-checks authorization capacity atomically with the other eligibility checks (owner request 2026-10-17, item 1).
--
-- BEFORE: assign_shift_caregiver (office assignment, replacement after a call-out, filling an open shift) ran the readiness gate, overlap and hour-limit checks
-- but never looked at the authorization again, so an amendment that lowered the cap after the shift was scheduled could still be assigned to a caregiver. Open-shift
-- pickup (0051/0063) already re-checked it.
-- NOW:
--   * assign_shift_caregiver calls ogevia.assert_shift_authorization_covered(shift) (the 0063 function: the reservation exists and used + reserved fits the month's
--     cap) in the same transaction, after the shift row lock and the caregiver lock, taking the reservation row and the authorization-lineage lock. The lock order is
--     the same as confirm_shift_pickup, so the two cannot deadlock each other, and an amendment (which takes the lineage lock) either finishes first and refuses the
--     assignment or waits for the assignment.
--   * DATABASE BACKSTOP: a BEFORE UPDATE trigger on shifts re-runs the same check whenever a caregiver is put on a scheduled, unfinished shift (the caregiver column
--     changes to a person), so a writer that skips the API function (a script, a future function) cannot assign past the authorization either. It does not fire for
--     inserts (the reservation is created with the shift), cancellations, call-outs or time changes.
-- The reservation itself is neither moved nor created by an assignment (it belongs to the shift). Rollback restores the 0042 function and removes the trigger.

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
  -- 0065: authorization capacity is re-checked here, in the same transaction and under the same locks (shift, caregiver, then the reservation and the
  -- authorization lineage) as every other eligibility check. An amendment that lowered the cap below used + reserved since the shift was scheduled refuses the assignment.
  perform ogevia.assert_shift_authorization_covered(v_s.id);
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

create function ogevia.shifts_authorization_guard()
returns trigger
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
begin
  if new.status = 'scheduled' and new.caregiver_record_id is not null and new.ends_at > now()
     and new.caregiver_record_id is distinct from old.caregiver_record_id then
    perform ogevia.assert_shift_authorization_covered(new.id);
  end if;
  return new;
end;
$$;
revoke all on function ogevia.shifts_authorization_guard() from public;
create trigger shifts_authorization before update of caregiver_record_id on ogevia.shifts
for each row execute function ogevia.shifts_authorization_guard();
