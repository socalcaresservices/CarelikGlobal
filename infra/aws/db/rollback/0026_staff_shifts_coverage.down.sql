-- ROLLBACK 0026_staff_shifts_coverage | CLASS: SAFE AUTOMATED (refuses when records would be lost)
-- Refuses while any staff-scheduled shift exists (a shift with an authorization
-- lineage, or a reservation without a Care Request): those rows cannot be
-- represented before 0026. Otherwise removes the schedule functions, the
-- permission and the added columns. Coverage events written by Care Requests
-- predate 0026 and stay.
do $$ begin
  if exists (select 1 from ogevia.shifts where authorization_lineage_id is not null or created_by is not null)
     or exists (select 1 from ogevia.authorization_reservations where care_request_id is null) then
    raise exception 'ROLLBACK REFUSED: staff-scheduled shifts exist; export them first (they would be lost)';
  end if;
end $$;
drop function if exists ogevia_api.list_my_shifts(uuid);
drop function if exists ogevia_api.list_shift_coverage(uuid, uuid);
drop function if exists ogevia_api.list_shifts(uuid, date, date, uuid);
drop function if exists ogevia_api.cancel_shift(uuid, uuid, text, uuid);
drop function if exists ogevia_api.assign_shift_caregiver(uuid, uuid, uuid, text, uuid);
drop function if exists ogevia_api.call_out_my_shift(uuid, uuid, text, uuid);
drop function if exists ogevia_api.record_shift_callout(uuid, uuid, text, uuid);
drop function if exists ogevia_api.create_shift(uuid, uuid, uuid, date, time, time, uuid, uuid);
drop function if exists ogevia.callout_shift(uuid, ogevia.shifts, uuid, text, text);
drop function if exists ogevia.lock_staff_shift(uuid, uuid);
drop function if exists ogevia.check_shift_caregiver(uuid, uuid, timestamptz, timestamptz, uuid);
drop function if exists ogevia.shift_is_care_request(uuid);
drop function if exists ogevia.shift_coverage_state(ogevia.shifts);
drop function if exists ogevia.shift_admin_guard(uuid);
drop function if exists ogevia.authorization_month_reserved(uuid, date);
drop index if exists ogevia.shifts_caregiver_record_idx;
drop index if exists ogevia.shifts_org_start_idx;
alter table ogevia.shifts drop column if exists cancel_reason, drop column if exists created_by, drop column if exists authorization_lineage_id;
alter table ogevia.authorization_reservations alter column care_request_id set not null;
delete from ogevia.role_permissions where permission_key = 'shifts.manage';
delete from ogevia.permissions where key = 'shifts.manage';
