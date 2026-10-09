-- Archive copies retain values, not operational constraints or automatic restoration.
-- Prefer retaining the migrated database and rolling back compatible application artifacts.
-- ROLLBACK 0040_caregiver_service_approvals | CLASS: BACKUP REQUIRED (archives approvals and flags; drops nothing that holds data)
-- Approvals, standing-assignment flags and the service flags on shifts are first copied to
-- ogevia.archived_*_0040_<timestamp> tables (count-checked), then removed from the live tables.
-- Past visits, shifts and billing approvals are not touched by 0040 and are not touched here.
do $$
declare
  v_ts text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');
  n_src bigint;
  n_dst bigint;
begin
  select count(*) into n_src from ogevia.caregiver_service_approvals;
  if n_src > 0 then
    execute format('create table ogevia.%I as table ogevia.caregiver_service_approvals', 'archived_caregiver_service_approvals_0040_' || v_ts);
    execute format('select count(*) from ogevia.%I', 'archived_caregiver_service_approvals_0040_' || v_ts) into n_dst;
    if n_dst <> n_src then raise exception 'ROLLBACK REFUSED: archive copy of caregiver_service_approvals is incomplete'; end if;
  end if;
  select count(*) into n_src from ogevia.assignment_readiness_flags;
  if n_src > 0 then
    execute format('create table ogevia.%I as table ogevia.assignment_readiness_flags', 'archived_assignment_readiness_flags_0040_' || v_ts);
    execute format('select count(*) from ogevia.%I', 'archived_assignment_readiness_flags_0040_' || v_ts) into n_dst;
    if n_dst <> n_src then raise exception 'ROLLBACK REFUSED: archive copy of assignment_readiness_flags is incomplete'; end if;
  end if;
  select count(*) into n_src from ogevia.shift_readiness_flags where kind = 'service';
  if n_src > 0 then
    execute format('create table ogevia.%I as select * from ogevia.shift_readiness_flags where kind = ''service''', 'archived_shift_service_flags_0040_' || v_ts);
    execute format('select count(*) from ogevia.%I', 'archived_shift_service_flags_0040_' || v_ts) into n_dst;
    if n_dst <> n_src then raise exception 'ROLLBACK REFUSED: archive copy of shift service flags is incomplete'; end if;
  end if;
end $$;

delete from ogevia.shift_readiness_flags where kind = 'service';

drop function ogevia_api.list_service_flags(uuid);
drop function ogevia_api.bulk_approve_reviewed_services(uuid, jsonb, integer, date, text, uuid);
drop function ogevia_api.list_service_review_pairs(uuid);
drop function ogevia_api.revoke_caregiver_service(uuid, uuid, text, date, uuid);
drop function ogevia_api.approve_caregiver_service(uuid, uuid, uuid, date, date, text, uuid);
drop function ogevia_api.list_caregiver_service_approvals(uuid, uuid);
drop function ogevia.service_approval_guard(uuid);
drop function ogevia.service_flag_impact(uuid, uuid, uuid, uuid, uuid);
drop function ogevia.service_approval_status(uuid, uuid, uuid, timestamptz, timestamptz);
drop function ogevia.service_approval_dates(ogevia.caregiver_service_approvals);
drop table ogevia.assignment_readiness_flags;
drop table ogevia.caregiver_service_approvals;
delete from ogevia.role_permissions where permission_key in ('caregiver_services.read', 'caregiver_services.read_own', 'caregiver_services.approve');
delete from ogevia.permissions where key in ('caregiver_services.read', 'caregiver_services.read_own', 'caregiver_services.approve');
