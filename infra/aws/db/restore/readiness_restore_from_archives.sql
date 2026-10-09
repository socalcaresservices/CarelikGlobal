-- RESTORE (manual, owner-approved) | Puts the records archived by rolling back 0039-0043 back into the live tables
-- AFTER the release has been re-applied (db:migrate). Not a migration: the runner never executes this file.
--
-- WHAT IT DOES
--   * For each table below it finds the NEWEST archive (ogevia.archived_<table>_<NNNN>_<timestamp>), and copies the rows back with the
--     SAME ids, in dependency order (parents first). The live constraints and foreign keys check every row; if any row cannot be
--     restored the whole script fails and NOTHING is restored (single transaction).
--   * It restores only into an EMPTY live table, so running it twice cannot duplicate records (the second run restores nothing).
--   * Archives are never changed or dropped. Audit rows are not touched.
--
-- WHAT IT DELIBERATELY DOES NOT RESTORE (a person decides)
--   * organization_readiness_settings: enforcement is NOT switched back on. Re-activate it from the Readiness screen (reason + reviewed count).
--   * availability_requests / caregiver_availability_state / availability windows: the approved hours in force at rollback were kept as plain rows
--     and may have been edited since; the archived request history stays in its archive tables for audit and for manual review.
--   * shift_readiness_flags / assignment_readiness_flags: derived "needs review" markers, re-created when the work is next evaluated or changed.
--
-- HOW TO RUN (after backup, in a maintenance window):  psql -v ON_ERROR_STOP=1 -1 -f readiness_restore_from_archives.sql
set local role ogevia_owner;

do $$
declare
  v_live text;
  v_archive text;
  v_cols text;
  v_sel text;
  v_live_n bigint;
  v_arch_n bigint;
  v_done bigint;
  -- (live table, archive stem). Order matters: parents before children.
  plan text[][] := array[
    array['experience_tags',                      'experience_tags_0043'],
    array['caregiver_experience',                 'caregiver_experience_0043'],
    array['caregiver_experience_reviews',         'caregiver_experience_reviews_0043'],
    array['client_experience_requirements',       'client_experience_requirements_0043'],
    array['caregiver_zip',                        'caregiver_zip_0043'],
    array['client_service_zip',                   'client_service_zip_0043'],
    array['zip_centroids',                        'zip_centroids_0043'],
    array['document_requirement_policies',        'document_requirement_policies_0041'],
    array['document_requirement_policy_history',  'document_requirement_policy_history_0041'],
    array['caregiver_service_approvals',          'caregiver_service_approvals_0040'],
    array['availability_overrides',               'availability_overrides_0042'],
    array['readiness_setting_events',             'readiness_setting_events_0042'],
    array['shift_series_skipped_dates',           'shift_series_skipped_dates_0042']
  ];
  i int;
begin
  -- Document-type designations (CPR / TB): put the label back on the same document types, only where none is set now.
  select table_name into v_archive from information_schema.tables
   where table_schema = 'ogevia' and table_name ~ '^archived_document_work_requirements_0041_[0-9]{14}$' order by table_name desc limit 1;
  if v_archive is not null then
    execute format('update ogevia.document_types t set work_requirement = a.work_requirement from ogevia.%I a
                     where a.id = t.id and a.organization_id = t.organization_id and t.work_requirement is null', v_archive);
    get diagnostics v_done = row_count;
    raise notice 'document_types.work_requirement: % designation(s) restored from %', v_done, v_archive;
  end if;

  for i in 1 .. array_length(plan, 1) loop
    v_live := plan[i][1];
    select table_name into v_archive from information_schema.tables
     where table_schema = 'ogevia' and table_name ~ ('^archived_' || plan[i][2] || '_[0-9]{14}$')
     order by table_name desc limit 1;
    if v_archive is null then
      raise notice '% : no archive, nothing to restore', v_live;
      continue;
    end if;
    execute format('select count(*) from ogevia.%I', v_live) into v_live_n;
    execute format('select count(*) from ogevia.%I', v_archive) into v_arch_n;
    if v_live_n > 0 and v_live <> 'shift_series_skipped_dates' then
      raise notice '% : live table already holds % row(s); not restored (archive % holds %)', v_live, v_live_n, v_archive, v_arch_n;
      continue;
    end if;
    -- Columns present in BOTH tables and not generated; each value is cast to the live column's type (the archive turned enums into text).
    select string_agg(format('%I', l.attname), ', ' order by l.attnum),
           string_agg(format('a.%I::text::%s', l.attname, format_type(l.atttypid, l.atttypmod)), ', ' order by l.attnum)
      into v_cols, v_sel
      from pg_attribute l
      join pg_attribute a on a.attrelid = format('ogevia.%I', v_archive)::regclass and a.attname = l.attname and a.attnum > 0 and not a.attisdropped
     where l.attrelid = format('ogevia.%I', v_live)::regclass and l.attnum > 0 and not l.attisdropped and l.attgenerated = '';
    if v_live = 'shift_series_skipped_dates' then
      -- Only the rows this release added (readiness reasons); rows already present are skipped by the primary key.
      execute format('insert into ogevia.%I (%s) overriding system value select %s from ogevia.%I a on conflict do nothing', v_live, v_cols, v_sel, v_archive);
    else
      execute format('insert into ogevia.%I (%s) overriding system value select %s from ogevia.%I a', v_live, v_cols, v_sel, v_archive);
    end if;
    get diagnostics v_done = row_count;
    raise notice '% : restored % of % archived row(s) from %', v_live, v_done, v_arch_n, v_archive;
  end loop;
end $$;
