-- RESTORE (manual, owner-approved) | Puts the records archived by ONE recorded rollback attempt back into the live tables,
-- AFTER the release has been re-applied (db:migrate). Not a migration: the runner never executes this file.
--
-- A rollback attempt is identified by a unique ATTEMPT ID and a complete MANIFEST written by the rollback runner
-- (`pnpm --filter @carelik/infra-aws db:rollback-readiness`): one manifest row per archive slot, including slots that held ZERO records.
-- Archives are never grouped by time and never chosen "newest per table", so two rollbacks minutes or seconds apart cannot be mixed:
-- restoring attempt B can never bring back a record that only attempt A archived (e.g. an earlier service approval).
--   1. List the attempts:   psql -f infra/aws/db/restore/readiness_list_recovery_sets.sql
--   2. Restore ONE attempt: psql -v ON_ERROR_STOP=1 -c "set ogevia.recovery_attempt = '<attempt id>'" \
--                                -f infra/aws/db/restore/readiness_restore_from_archives.sql
--
-- WHAT IT REFUSES (nothing is changed; the script is one transaction)
--   * no/invalid/unknown attempt id, or no recorded rollback attempt at all;
--   * an INCOMPLETE manifest (fewer rows than the attempt recorded, or an unknown slot);
--   * an archive that is missing, whose row count differs from the manifest (changed since the rollback), or that is tagged with
--     a DIFFERENT attempt id (archives mixed across attempts), or an archive tagged with this attempt but absent from its manifest;
--   * an attempt that is not the NEWEST one, unless you also pass  set ogevia.recovery_allow_older = 'yes';
--   * a destination table that is not empty and not identical to the archive (an "already restored" rerun is accepted and changes nothing);
--     a destination table whose slot held ZERO records in this attempt but now holds rows (it is not overwritten, and nothing around it is restored);
--   * a restore whose dependencies are not satisfied (foreign keys are checked by the database; all-or-nothing).
--
-- WHAT IT DOES
--   * Copies each archive named by the manifest back with the SAME ids, parents before children, in one transaction.
--   * Restores only: experience tags/experience/reviews/client wishes, ZIPs, CPR/TB designations, validity rules and rule history, service approvals,
--     availability overrides, setting-change history, readiness skipped-date rows.
--   * NEVER changes organization_readiness_settings: enforcement stays exactly as it is (Off after a re-apply) until the owner activates it deliberately.
--   * Archives and the manifest are never changed or dropped. Audit rows are not touched.
--   * Retained but NOT restored (a person decides): availability request history and version counters, derived review flags, the enforcement setting.
begin;
set local role ogevia_owner;

do $$
declare
  v_attempt uuid;
  v_att record;
  v_older boolean := coalesce(current_setting('ogevia.recovery_allow_older', true), '') = 'yes';
  m record;
  v_arch text;
  v_live text;
  v_cols text;
  v_sel text;
  v_txt text;
  v_live_n bigint;
  v_arch_n bigint;
  v_n bigint;
  v_enf_before bigint;
  v_tag text;
  i int;
  -- restorable: (live table, archive stem). Order matters: parents before children.
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
  -- slots of a rollback attempt that are deliberately retained, not restored
  retained text[] := array['availability_requests_0039', 'caregiver_availability_state_0039', 'shift_readiness_flags_0039',
    'caregiver_availability_windows_0039', 'caregiver_unavailable_dates_0039', 'assignment_readiness_flags_0040', 'shift_service_flags_0040',
    'shift_document_flags_0041', 'assignment_document_flags_0041', 'organization_readiness_settings_0042', 'scoring_rule_versions_0043'];
begin
  -- ---------- 1. the attempt
  if to_regclass('ogevia.readiness_rollback_attempts') is null then
    raise exception 'RESTORE REFUSED: no rollback attempt has been recorded in this database (rollbacks are recorded by db:rollback-readiness)';
  end if;
  begin
    v_attempt := nullif(btrim(coalesce(current_setting('ogevia.recovery_attempt', true), '')), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'RESTORE REFUSED: ogevia.recovery_attempt is not a valid attempt id';
  end;
  if v_attempt is null then
    raise exception 'RESTORE REFUSED: no rollback attempt selected. Run readiness_list_recovery_sets.sql and pass the attempt id in ogevia.recovery_attempt.';
  end if;
  select * into v_att from ogevia.readiness_rollback_attempts a where a.attempt_id = v_attempt;
  if v_att.attempt_id is null then raise exception 'RESTORE REFUSED: unknown rollback attempt %', v_attempt; end if;
  if exists (select 1 from ogevia.readiness_rollback_attempts a where a.started_at > v_att.started_at) and not v_older then
    raise exception 'RESTORE REFUSED: attempt % is not the newest rollback attempt. Restore the newest, or pass ogevia.recovery_allow_older = ''yes'' if restoring older records is intended', v_attempt;
  end if;

  -- ---------- 2. the manifest must be complete and every archive must be exactly what the rollback recorded
  select count(*) into v_n from ogevia.readiness_rollback_manifest x where x.attempt_id = v_attempt;
  if v_n <> v_att.slot_count then
    raise exception 'RESTORE REFUSED: the manifest of attempt % is incomplete (% of % slots recorded)', v_attempt, v_n, v_att.slot_count;
  end if;
  v_tag := 'readiness rollback attempt ' || v_attempt::text;
  for m in select * from ogevia.readiness_rollback_manifest x where x.attempt_id = v_attempt order by x.stem loop
    if not (m.stem = any (retained) or m.stem = 'document_work_requirements_0041'
            or exists (select 1 from generate_subscripts(plan, 1) g where plan[g][2] = m.stem)) then
      raise exception 'RESTORE REFUSED: the manifest names an unknown slot %', m.stem;
    end if;
    if m.archive_table is null then
      if m.source_rows <> 0 then raise exception 'RESTORE REFUSED: slot % held % row(s) but has no archive', m.stem, m.source_rows; end if;
      continue;
    end if;
    if not exists (select 1 from pg_catalog.pg_tables t where t.schemaname = 'ogevia' and t.tablename = m.archive_table) then
      raise exception 'RESTORE REFUSED: archive table % of attempt % is missing', m.archive_table, v_attempt;
    end if;
    if coalesce(obj_description(format('ogevia.%I', m.archive_table)::regclass, 'pg_class'), '') <> v_tag then
      raise exception 'RESTORE REFUSED: archive % is tagged for a different rollback attempt (archives mixed across attempts)', m.archive_table;
    end if;
    execute format('select count(*) from ogevia.%I', m.archive_table) into v_arch_n;
    if v_arch_n <> m.archive_rows then
      raise exception 'RESTORE REFUSED: archive % holds % row(s) but the rollback recorded %: it changed after the rollback', m.archive_table, v_arch_n, m.archive_rows;
    end if;
  end loop;
  -- an archive tagged for this attempt but not in its manifest
  select c.relname into v_arch
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ogevia' and c.relkind = 'r' and c.relname ~ '^archived_' and obj_description(c.oid, 'pg_class') = v_tag
     and not exists (select 1 from ogevia.readiness_rollback_manifest x where x.attempt_id = v_attempt and x.archive_table = c.relname)
   limit 1;
  if v_arch is not null then raise exception 'RESTORE REFUSED: archive % is tagged for attempt % but is not in its manifest', v_arch, v_attempt; end if;

  select count(*) into v_enf_before from ogevia.organization_readiness_settings where enforcement_active_from is not null;

  -- ---------- 3. destinations: empty, or already identical; a zero-record slot must still be empty
  for i in 1 .. array_length(plan, 1) loop
    v_live := plan[i][1];
    select * into m from ogevia.readiness_rollback_manifest x where x.attempt_id = v_attempt and x.stem = plan[i][2];
    if m.stem is null then
      -- a slot that was not part of this attempt (rolled back to a later target): leave it alone
      continue;
    end if;
    execute format('select count(*) from ogevia.%I', v_live) into v_live_n;
    if m.archive_table is null then
      if v_live_n > 0 and v_live <> 'shift_series_skipped_dates' then
        raise exception 'RESTORE REFUSED: % held no records in attempt % but now holds % row(s); records from another attempt or new work are never mixed in', v_live, v_attempt, v_live_n;
      end if;
      continue;
    end if;
    if v_live_n > 0 and v_live <> 'shift_series_skipped_dates' then
      select string_agg(format('%I::text', l.attname), ', ' order by l.attnum) into v_txt
        from pg_attribute l join pg_attribute a on a.attrelid = format('ogevia.%I', m.archive_table)::regclass and a.attname = l.attname and a.attnum > 0 and not a.attisdropped
       where l.attrelid = format('ogevia.%I', v_live)::regclass and l.attnum > 0 and not l.attisdropped and l.attgenerated = '';
      execute format('select count(*) from (select row(%s) from ogevia.%I except select row(%s) from ogevia.%I) x', v_txt, m.archive_table, v_txt, v_live) into v_n;
      if v_n > 0 or m.archive_rows <> v_live_n then
        raise exception 'RESTORE REFUSED: % already holds % row(s) that differ from the archive %; nothing is overwritten', v_live, v_live_n, m.archive_table;
      end if;
    end if;
  end loop;

  -- ---------- 4. restore (same ids, parents first)
  select * into m from ogevia.readiness_rollback_manifest x where x.attempt_id = v_attempt and x.stem = 'document_work_requirements_0041';
  if m.archive_table is not null then
    execute format('select count(*) from ogevia.%I a join ogevia.document_types t on t.id = a.id and t.organization_id = a.organization_id
                     where t.work_requirement is not null and t.work_requirement is distinct from a.work_requirement', m.archive_table) into v_n;
    if v_n > 0 then raise exception 'RESTORE REFUSED: % document type(s) are already designated differently from the archive', v_n; end if;
    execute format('update ogevia.document_types t set work_requirement = a.work_requirement from ogevia.%I a
                     where a.id = t.id and a.organization_id = t.organization_id and t.work_requirement is null', m.archive_table);
    get diagnostics v_n = row_count;
    raise notice 'document_types.work_requirement : restored % designation(s) from %', v_n, m.archive_table;
  end if;

  for i in 1 .. array_length(plan, 1) loop
    v_live := plan[i][1];
    select * into m from ogevia.readiness_rollback_manifest x where x.attempt_id = v_attempt and x.stem = plan[i][2];
    if m.stem is null or m.archive_table is null then continue; end if;
    execute format('select count(*) from ogevia.%I', v_live) into v_live_n;
    if v_live_n > 0 and v_live <> 'shift_series_skipped_dates' then
      raise notice '% : already restored (% row(s)); nothing to do', v_live, v_live_n;
      continue;
    end if;
    select string_agg(format('%I', l.attname), ', ' order by l.attnum),
           string_agg(format('a.%I::text::%s', l.attname, format_type(l.atttypid, l.atttypmod)), ', ' order by l.attnum)
      into v_cols, v_sel
      from pg_attribute l
      join pg_attribute a on a.attrelid = format('ogevia.%I', m.archive_table)::regclass and a.attname = l.attname and a.attnum > 0 and not a.attisdropped
     where l.attrelid = format('ogevia.%I', v_live)::regclass and l.attnum > 0 and not l.attisdropped and l.attgenerated = '';
    if v_live = 'shift_series_skipped_dates' then
      execute format('insert into ogevia.%I (%s) overriding system value select %s from ogevia.%I a on conflict do nothing', v_live, v_cols, v_sel, m.archive_table);
    else
      execute format('insert into ogevia.%I (%s) overriding system value select %s from ogevia.%I a', v_live, v_cols, v_sel, m.archive_table);
    end if;
    get diagnostics v_n = row_count;
    raise notice '% : restored % of % archived row(s) from %', v_live, v_n, m.archive_rows, m.archive_table;
  end loop;

  -- ---------- 5. enforcement is never touched
  select count(*) into v_n from ogevia.organization_readiness_settings where enforcement_active_from is not null;
  if v_n <> v_enf_before then raise exception 'RESTORE REFUSED: enforcement settings changed unexpectedly'; end if;
end $$;

commit;
