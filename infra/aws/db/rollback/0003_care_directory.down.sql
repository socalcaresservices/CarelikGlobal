-- ROLLBACK 0003_care_directory  |  CLASS: BACKUP REQUIRED
do $$ begin
  if exists (select 1 from ogevia.clients) or exists (select 1 from ogevia.caregiver_records) then
    raise exception 'Refusing: directory data exists. Snapshot + owner approval required.';
  end if;
end $$;
drop function if exists ogevia.shift_is_called_out(uuid);
drop table if exists ogevia.shift_coverage_events;
drop table if exists ogevia.shifts;
drop function if exists ogevia.caregiver_has_active_assignment(uuid, uuid, uuid);
drop table if exists ogevia.caregiver_assignments;
drop function if exists ogevia.assert_valid_caregiver_assignment();
drop table if exists ogevia.services;
drop table if exists ogevia.clients;
drop function if exists ogevia.set_default_client_code();
drop table if exists ogevia.caregiver_records;
drop type if exists ogevia.shift_coverage_event_type;
drop type if exists ogevia.shift_status;
drop type if exists ogevia.client_status;
delete from ogevia_meta.schema_migrations where version = '0003';
