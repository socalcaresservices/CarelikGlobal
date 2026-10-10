-- RESTORE (manual, owner-approved) | Puts the records archived by ONE rollback attempt of 0039-0045 back into the live tables,
-- AFTER the release has been re-applied (db:migrate). Not a migration: the runner never executes this file.
--
-- YOU MUST SELECT THE RECOVERY SET EXPLICITLY. The script never picks "the newest archive" of each table on its own
-- (that could mix attempts: e.g. restore an outdated approval from an earlier rollback when the latest rollback had none).
--   1. List the recovery sets:   psql -f infra/aws/db/restore/readiness_list_recovery_sets.sql
--   2. Choose ONE set and pass ALL its archive table names, comma separated:
--        psql -v ON_ERROR_STOP=1 \
--          -c "set ogevia.recovery_set = 'archived_a_0040_20261010120001,archived_b_0041_20261010120002,...'" \
--          -f infra/aws/db/restore/readiness_restore_from_archives.sql
--
-- WHAT IT REFUSES (nothing is changed; the script is one transaction)
--   * no set selected, a name that is not an archive table, a missing table, an unknown archive, two archives of the same table;
--   * a MIXED set (archives more than 10 minutes apart = more than one rollback attempt);
--   * an INCOMPLETE set (another archive from the same rollback attempt exists but was not listed);
--   * a set that is not the NEWEST one (a later rollback exists), unless you also pass  set ogevia.recovery_allow_older = 'yes';
--   * a destination table that is not empty and not identical to the archive (an "already restored" rerun is accepted and changes nothing);
--     and a destination table that is not in the set but holds rows;
--   * a restore whose dependencies are not satisfied (foreign keys are checked by the database; a child archive without its parent is refused up front).
--
-- WHAT IT DOES
--   * Copies the selected archives back with the SAME ids, parents before children, in one transaction.
--   * Restores only: experience tags/experience/reviews/client wishes, ZIPs, CPR/TB designations, validity rules and rule history, service approvals,
--     availability overrides, setting-change history, readiness skipped-date rows.
--   * NEVER changes organization_readiness_settings: enforcement stays exactly as it is (Off after a re-apply) until the owner activates it deliberately.
--   * Archives are never changed or dropped. Audit rows are not touched.
--   * Retained but NOT restored (a person decides): availability request history and version counters, derived review flags, the enforcement setting.
begin;
set local role ogevia_owner;

do $$
declare
  c_window constant interval := interval '10 minutes';
  v_list text := current_setting('ogevia.recovery_set', true);
  v_older boolean := coalesce(current_setting('ogevia.recovery_allow_older', true), '') = 'yes';
  v_names text[];
  v_name text;
  v_m text[];
  v_stem text;
  v_ts timestamp;
  v_min timestamp;
  v_max timestamp;
  v_stems text[] := '{}';
  v_arch text;
  v_live text;
  v_cols text;
  v_sel text;
  v_txt_a text;
  v_txt_l text;
  v_live_n bigint;
  v_arch_n bigint;
  v_n bigint;
  v_enf_before bigint;
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
  -- archives that are part of a rollback attempt but are deliberately retained, not restored
  retained text[] := array['availability_requests_0039', 'caregiver_availability_state_0039', 'shift_readiness_flags_0039',
    'caregiver_availability_windows_0039', 'caregiver_unavailable_dates_0039', 'assignment_readiness_flags_0040', 'shift_service_flags_0040',
    'shift_document_flags_0041', 'assignment_document_flags_0041', 'organization_readiness_settings_0042'];
begin
  -- ---------- 1. the selection
  if v_list is null or btrim(v_list) = '' then
    raise exception 'RESTORE REFUSED: no recovery set selected. Run readiness_list_recovery_sets.sql, choose one set and pass all its archive names in ogevia.recovery_set.';
  end if;
  v_names := string_to_array(regexp_replace(v_list, '\s', '', 'g'), ',');
  foreach v_name in array v_names loop
    v_m := regexp_match(v_name, '^archived_(.+_[0-9]{4})_([0-9]{14})$');
    if v_m is null then raise exception 'RESTORE REFUSED: "%" is not an archive table name', v_name; end if;
    v_stem := v_m[1];
    if not exists (select 1 from pg_catalog.pg_tables t where t.schemaname = 'ogevia' and t.tablename = v_name) then
      raise exception 'RESTORE REFUSED: archive table % does not exist', v_name;
    end if;
    if v_stem = any (v_stems) then raise exception 'RESTORE REFUSED: two archives of % were selected (mixed rollback attempts)', v_stem; end if;
    if not (v_stem = any (retained) or v_stem = 'document_work_requirements_0041'
            or exists (select 1 from generate_subscripts(plan, 1) g where plan[g][2] = v_stem)) then
      raise exception 'RESTORE REFUSED: % is not a known readiness archive', v_name;
    end if;
    v_stems := v_stems || v_stem;
    v_ts := to_timestamp(v_m[2], 'YYYYMMDDHH24MISS')::timestamp;
    v_min := least(coalesce(v_min, v_ts), v_ts);
    v_max := greatest(coalesce(v_max, v_ts), v_ts);
  end loop;
  if v_max - v_min > c_window then
    raise exception 'RESTORE REFUSED: the selected archives span % (%..%): they come from more than one rollback attempt', v_max - v_min, v_min, v_max;
  end if;
  -- any archive that is not selected but belongs to this attempt (or is newer) makes the selection incomplete / not the newest
  for v_name, v_ts in
    select t.tablename::text, to_timestamp((regexp_match(t.tablename, '_([0-9]{14})$'))[1], 'YYYYMMDDHH24MISS')::timestamp
      from pg_catalog.pg_tables t
     where t.schemaname = 'ogevia' and t.tablename ~ '^archived_.+_[0-9]{4}_[0-9]{14}$' and t.tablename <> all (v_names)
  loop
    if v_ts >= v_min - c_window and v_ts <= v_max + c_window then
      raise exception 'RESTORE REFUSED: incomplete set. % belongs to the same rollback attempt but was not selected', v_name;
    elsif v_ts > v_max and not v_older then
      raise exception 'RESTORE REFUSED: this is not the newest recovery set (% is newer). Select the newest set, or pass ogevia.recovery_allow_older = ''yes'' if restoring older records is intended', v_name;
    end if;
  end loop;
  -- children need their parents in the same set
  if ('caregiver_experience_0043' = any (v_stems) or 'client_experience_requirements_0043' = any (v_stems)) and not ('experience_tags_0043' = any (v_stems)) then
    raise exception 'RESTORE REFUSED: experience and client wishes need their experience_tags archive in the same set';
  end if;

  select count(*) into v_enf_before from ogevia.organization_readiness_settings where enforcement_active_from is not null;

  -- ---------- 2. destinations: empty, or already identical; nothing unexpected
  for i in 1 .. array_length(plan, 1) loop
    v_live := plan[i][1];
    v_arch := (select t from unnest(v_names) t where t ~ ('^archived_' || plan[i][2] || '_[0-9]{14}$'));
    execute format('select count(*) from ogevia.%I', v_live) into v_live_n;
    if v_arch is null then
      if v_live_n > 0 and v_live <> 'shift_series_skipped_dates' then
        raise exception 'RESTORE REFUSED: % is not in the selected set but already holds % row(s); restoring around it could mix old and new records', v_live, v_live_n;
      end if;
      continue;
    end if;
    if v_live_n > 0 and v_live <> 'shift_series_skipped_dates' then
      select string_agg(format('%I::text', l.attname), ', ' order by l.attnum) into v_txt_l
        from pg_attribute l join pg_attribute a on a.attrelid = format('ogevia.%I', v_arch)::regclass and a.attname = l.attname and a.attnum > 0 and not a.attisdropped
       where l.attrelid = format('ogevia.%I', v_live)::regclass and l.attnum > 0 and not l.attisdropped and l.attgenerated = '';
      execute format('select count(*) from (select row(%s) from ogevia.%I except select row(%s) from ogevia.%I) x', v_txt_l, v_arch, v_txt_l, v_live) into v_n;
      execute format('select count(*) from ogevia.%I', v_arch) into v_arch_n;
      if v_n > 0 or v_arch_n <> v_live_n then
        raise exception 'RESTORE REFUSED: % already holds % row(s) that differ from the archive %; nothing is overwritten', v_live, v_live_n, v_arch;
      end if;
    end if;
  end loop;

  -- ---------- 3. restore (same ids, parents first)
  select t into v_arch from unnest(v_names) t where t ~ '^archived_document_work_requirements_0041_[0-9]{14}$';
  if v_arch is not null then
    execute format('select count(*) from ogevia.%I a join ogevia.document_types t on t.id = a.id and t.organization_id = a.organization_id
                     where t.work_requirement is not null and t.work_requirement is distinct from a.work_requirement', v_arch) into v_n;
    if v_n > 0 then raise exception 'RESTORE REFUSED: % document type(s) are already designated differently from the archive', v_n; end if;
    execute format('update ogevia.document_types t set work_requirement = a.work_requirement from ogevia.%I a
                     where a.id = t.id and a.organization_id = t.organization_id and t.work_requirement is null', v_arch);
    get diagnostics v_n = row_count;
    raise notice 'document_types.work_requirement : restored % designation(s) from %', v_n, v_arch;
  end if;

  for i in 1 .. array_length(plan, 1) loop
    v_live := plan[i][1];
    v_arch := (select t from unnest(v_names) t where t ~ ('^archived_' || plan[i][2] || '_[0-9]{14}$'));
    if v_arch is null then continue; end if;
    execute format('select count(*) from ogevia.%I', v_live) into v_live_n;
    execute format('select count(*) from ogevia.%I', v_arch) into v_arch_n;
    if v_live_n > 0 and v_live <> 'shift_series_skipped_dates' then
      raise notice '% : already restored (% row(s)); nothing to do', v_live, v_live_n;
      continue;
    end if;
    select string_agg(format('%I', l.attname), ', ' order by l.attnum),
           string_agg(format('a.%I::text::%s', l.attname, format_type(l.atttypid, l.atttypmod)), ', ' order by l.attnum)
      into v_cols, v_sel
      from pg_attribute l
      join pg_attribute a on a.attrelid = format('ogevia.%I', v_arch)::regclass and a.attname = l.attname and a.attnum > 0 and not a.attisdropped
     where l.attrelid = format('ogevia.%I', v_live)::regclass and l.attnum > 0 and not l.attisdropped and l.attgenerated = '';
    if v_live = 'shift_series_skipped_dates' then
      execute format('insert into ogevia.%I (%s) overriding system value select %s from ogevia.%I a on conflict do nothing', v_live, v_cols, v_sel, v_arch);
    else
      execute format('insert into ogevia.%I (%s) overriding system value select %s from ogevia.%I a', v_live, v_cols, v_sel, v_arch);
    end if;
    get diagnostics v_n = row_count;
    raise notice '% : restored % of % archived row(s) from %', v_live, v_n, v_arch_n, v_arch;
  end loop;

  -- ---------- 4. enforcement is never touched
  select count(*) into v_n from ogevia.organization_readiness_settings where enforcement_active_from is not null;
  if v_n <> v_enf_before then raise exception 'RESTORE REFUSED: enforcement settings changed unexpectedly'; end if;
end $$;

commit;
