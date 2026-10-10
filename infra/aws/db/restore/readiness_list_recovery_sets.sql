-- Read-only. Lists the recorded rollback attempts (unique attempt id + manifest) newest first. Pass ONE attempt_id to
-- readiness_restore_from_archives.sql as  set ogevia.recovery_attempt = '<attempt_id>'. Archives that exist without a manifest (a down script run by
-- hand) are listed separately: they keep their data but are NOT restorable by the script.
select a.attempt_id, a.started_at, a.performed_by, a.target_version, a.highest_version, a.slot_count,
       count(m.*) as manifest_rows,
       count(m.archive_table) as archives,
       count(*) filter (where m.archive_table is null) as zero_record_slots,
       coalesce(sum(m.source_rows) filter (where m.stem = 'caregiver_service_approvals_0040'), 0) as service_approvals_archived
  from ogevia.readiness_rollback_attempts a
  left join ogevia.readiness_rollback_manifest m on m.attempt_id = a.attempt_id
 group by a.attempt_id
 order by a.started_at desc;
