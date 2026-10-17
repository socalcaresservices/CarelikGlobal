-- ROLLBACK 0061 | CLASS: SAFE AUTOMATED (no table or row is touched). Restores the 0034/0053 series functions (no `rejected` result, default 'refuse') and removes the index.
drop index ogevia.shifts_series_start_unique;
drop function ogevia_api.create_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, text, uuid, jsonb);
drop function ogevia_api.change_shift_series_from(uuid, uuid, date, uuid, smallint[], time, time, date, text, text, uuid, jsonb, boolean);
drop function ogevia_api.extend_shift_series(uuid, uuid, date, text, uuid);
drop function ogevia.series_materialize(ogevia.shift_series, date, date, text, uuid, date, uuid);
create function ogevia.series_materialize(p_series ogevia.shift_series, p_from date, p_through date, p_on_conflict text, p_exclude_series uuid, p_exclude_from date, p_actor uuid)
 RETURNS TABLE(created integer, skipped integer, reserved_minutes integer)
 LANGUAGE plpgsql
 set search_path = ogevia, pg_temp
AS $$
declare
  e record;
  v_rec ogevia.caregiver_records%rowtype;
  v_created integer := 0;
  v_skipped integer := 0;
  v_minutes integer := 0;
  v_flagged text;
  v_id uuid;
begin
  if p_series.caregiver_record_id is not null then
    select * into v_rec from ogevia.caregiver_records r where r.id = p_series.caregiver_record_id;
  end if;
  select string_agg(to_char(x.local_date, 'MM/DD/YYYY') || ' (' || replace(x.outcome, '_', ' ') || ')', ', ' order by x.local_date)
    into v_flagged
  from (select * from ogevia.series_evaluate(p_series.organization_id, p_series.client_id, p_series.service_id,
          p_series.caregiver_record_id, p_series.weekdays, p_series.start_time, p_series.end_time, p_from, p_through,
          p_exclude_series, p_exclude_from, p_series.pattern) where outcome <> 'ok' limit 12) x;
  if v_flagged is not null and p_on_conflict <> 'skip_flagged' then
    raise exception 'Some dates cannot be scheduled: %. Nothing was saved. Change the series, or choose to skip these dates.', v_flagged
      using errcode = 'OGC09';
  end if;
  for e in select * from ogevia.series_evaluate(p_series.organization_id, p_series.client_id, p_series.service_id,
             p_series.caregiver_record_id, p_series.weekdays, p_series.start_time, p_series.end_time, p_from, p_through,
             p_exclude_series, p_exclude_from, p_series.pattern) loop
    if e.outcome = 'ok' then
      v_id := gen_random_uuid();
      insert into ogevia.shifts (id, organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id,
                                 starts_at, ends_at, status, authorization_lineage_id, created_by, series_id)
      values (v_id, p_series.organization_id, p_series.client_id, p_series.service_id, v_rec.linked_user_id, v_rec.id,
              e.starts_at, e.ends_at, 'scheduled', e.authorization_lineage_id, p_actor, p_series.id);
      insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
      values (p_series.organization_id, e.authorization_lineage_id, null, v_id, e.local_date, e.minutes);
      v_created := v_created + 1;
      v_minutes := v_minutes + e.minutes;
    else
      insert into ogevia.shift_series_skipped_dates (series_id, organization_id, local_date, reason, minutes, recorded_by)
      values (p_series.id, p_series.organization_id, e.local_date, e.outcome, e.minutes, p_actor);
      v_skipped := v_skipped + 1;
    end if;
  end loop;
  return query select v_created, v_skipped, v_minutes;
end;
$$;
create function ogevia_api.create_shift_series(p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_starts_on date, p_ends_on date, p_on_conflict text DEFAULT 'refuse'::text, p_idempotency_key uuid DEFAULT NULL::uuid, p_pattern jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(series_id uuid, created integer, skipped integer, reserved_minutes integer, generated_through date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_client_id, p_service_id, p_caregiver_record_id, array_to_string(p_weekdays, ','),
                         p_start, p_end, p_starts_on, p_ends_on, p_on_conflict, p_pattern::text);
  v_prior jsonb;
  v_through date;
  v_series ogevia.shift_series%rowtype;
  v_r record;
begin
  v_prior := ogevia.idempotency_begin('create_shift_series', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'series_id')::uuid, (v_prior ->> 'created')::integer, (v_prior ->> 'skipped')::integer,
      (v_prior ->> 'reserved_minutes')::integer, (v_prior ->> 'generated_through')::date;
    return;
  end if;
  if p_on_conflict is null or p_on_conflict not in ('refuse', 'skip_flagged') then
    raise exception 'Choose what happens to dates that do not fit: refuse, or skip them' using errcode = 'OGV22';
  end if;
  v_through := ogevia.series_validate(p_organization_id, p_client_id, p_service_id, p_caregiver_record_id,
    p_weekdays, p_start, p_end, p_starts_on, p_ends_on, p_pattern);
  perform ogevia.series_lock(p_organization_id, p_client_id, p_service_id, p_caregiver_record_id, p_starts_on, v_through);
  insert into ogevia.shift_series (organization_id, client_id, service_id, caregiver_record_id, weekdays, start_time, end_time,
                                   starts_on, ends_on, generated_through, created_by, pattern)
  values (p_organization_id, p_client_id, p_service_id, p_caregiver_record_id,
          array(select d from unnest(p_weekdays) d order by d), p_start, p_end, p_starts_on, p_ends_on, v_through, v_actor, p_pattern)
  returning * into v_series;
  select * into v_r from ogevia.series_materialize(v_series, p_starts_on, v_through, p_on_conflict, null, null, v_actor);
  if v_r.created = 0 then
    raise exception 'No date of this series can be scheduled; nothing was saved' using errcode = 'OGC09';
  end if;
  perform ogevia.write_audit(p_organization_id, 'shift_series.created', 'shift_series', v_series.id, null,
    jsonb_build_object('client_id', p_client_id, 'service_id', p_service_id, 'caregiver_record_id', p_caregiver_record_id,
      'weekdays', v_series.weekdays, 'start_time', p_start, 'end_time', p_end, 'starts_on', p_starts_on, 'ends_on', p_ends_on,
      'generated_through', v_through, 'pattern', p_pattern, 'created', v_r.created, 'skipped', v_r.skipped, 'reserved_minutes', v_r.reserved_minutes,
      'on_conflict', p_on_conflict), null);
  perform ogevia.idempotency_finish('create_shift_series', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('series_id', v_series.id, 'created', v_r.created, 'skipped', v_r.skipped,
      'reserved_minutes', v_r.reserved_minutes, 'generated_through', v_through));
  return query select v_series.id, v_r.created, v_r.skipped, v_r.reserved_minutes, v_through;
end;
$$;
create function ogevia_api.change_shift_series_from(p_organization_id uuid, p_series_id uuid, p_from date, p_caregiver_record_id uuid, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_ends_on date, p_on_conflict text, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid, p_pattern jsonb DEFAULT NULL::jsonb, p_clear_pattern boolean DEFAULT false)
 RETURNS TABLE(series_id uuid, cancelled integer, created integer, skipped integer, kept integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_series_id, p_from, p_caregiver_record_id, array_to_string(p_weekdays, ','),
                         p_start, p_end, p_ends_on, p_on_conflict, p_pattern::text, p_clear_pattern);
  v_prior jsonb;
  v_old ogevia.shift_series%rowtype;
  v_new ogevia.shift_series%rowtype;
  v_through date;
  v_pattern jsonb;
  v_c record;
  v_m record;
begin
  v_prior := ogevia.idempotency_begin('change_shift_series', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'series_id')::uuid, (v_prior ->> 'cancelled')::integer, (v_prior ->> 'created')::integer,
      (v_prior ->> 'skipped')::integer, (v_prior ->> 'kept')::integer;
    return;
  end if;
  if length(v_reason) not between 3 and 500 then raise exception 'Give the reason for the change' using errcode = 'OGV22'; end if;
  if p_on_conflict is null or p_on_conflict not in ('refuse', 'skip_flagged') then
    raise exception 'Choose what happens to dates that do not fit: refuse, or skip them' using errcode = 'OGV22';
  end if;
  v_old := ogevia.lock_series(p_organization_id, p_series_id);
  if p_from is null or p_from < v_old.starts_on then
    raise exception 'The change must start on or after the series start date' using errcode = 'OGV22';
  end if;
  -- Omitted pattern keeps the series' own; p_clear_pattern removes it (back to every selected weekday).
  v_pattern := case when p_clear_pattern then null else coalesce(p_pattern, v_old.pattern) end;
  v_through := ogevia.series_validate(p_organization_id, v_old.client_id, v_old.service_id, p_caregiver_record_id,
    p_weekdays, p_start, p_end, p_from, p_ends_on, v_pattern);
  perform ogevia.series_lock(p_organization_id, v_old.client_id, v_old.service_id, p_caregiver_record_id, p_from,
    greatest(v_through, v_old.generated_through));
  if v_old.caregiver_record_id is not null and v_old.caregiver_record_id is distinct from p_caregiver_record_id then
    perform pg_advisory_xact_lock(hashtextextended('ogevia.caregiver-schedule:' || v_old.caregiver_record_id::text, 0));
  end if;
  insert into ogevia.shift_series (organization_id, client_id, service_id, caregiver_record_id, weekdays, start_time, end_time,
                                   starts_on, ends_on, generated_through, replaces_series_id, created_by, pattern)
  values (p_organization_id, v_old.client_id, v_old.service_id, p_caregiver_record_id,
          array(select d from unnest(p_weekdays) d order by d), p_start, p_end, p_from, p_ends_on, v_through, v_old.id, v_actor, v_pattern)
  returning * into v_new;
  -- Evaluate and create the replacement first (it ignores the old future occurrences), then cancel them.
  select * into v_m from ogevia.series_materialize(v_new, p_from, v_through, p_on_conflict, v_old.id, p_from, v_actor);
  select * into v_c from ogevia.series_cancel_from(v_old, p_from, v_reason);
  if p_from <= v_old.starts_on then
    update ogevia.shift_series set status = 'ended', ended_at = now(), ended_by = v_actor, end_reason = v_reason where id = v_old.id;
  else
    update ogevia.shift_series set ends_on = p_from - 1, generated_through = least(generated_through, p_from - 1) where id = v_old.id;
  end if;
  perform ogevia.write_audit(p_organization_id, 'shift_series.changed_from', 'shift_series', v_old.id,
    jsonb_build_object('caregiver_record_id', v_old.caregiver_record_id, 'weekdays', v_old.weekdays,
      'start_time', v_old.start_time, 'end_time', v_old.end_time, 'ends_on', v_old.ends_on),
    jsonb_build_object('replacement_series_id', v_new.id, 'from', p_from, 'caregiver_record_id', p_caregiver_record_id,
      'weekdays', v_new.weekdays, 'pattern', v_pattern, 'start_time', p_start, 'end_time', p_end, 'ends_on', p_ends_on,
      'cancelled', v_c.cancelled, 'kept', v_c.kept, 'created', v_m.created, 'skipped', v_m.skipped), v_reason);
  perform ogevia.idempotency_finish('change_shift_series', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('series_id', v_new.id, 'cancelled', v_c.cancelled, 'created', v_m.created, 'skipped', v_m.skipped, 'kept', v_c.kept));
  return query select v_new.id, v_c.cancelled, v_m.created, v_m.skipped, v_c.kept;
end;
$$;
create function ogevia_api.extend_shift_series(
  p_organization_id uuid, p_series_id uuid, p_through date, p_on_conflict text default 'refuse', p_idempotency_key uuid default null
)
returns table (created integer, skipped integer, generated_through date)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_series_id, p_through, p_on_conflict);
  v_prior jsonb;
  v_s ogevia.shift_series%rowtype;
  v_from date;
  v_to date;
  v_m record;
begin
  v_prior := ogevia.idempotency_begin('extend_shift_series', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'created')::integer, (v_prior ->> 'skipped')::integer, (v_prior ->> 'generated_through')::date;
    return;
  end if;
  if p_on_conflict is null or p_on_conflict not in ('refuse', 'skip_flagged') then
    raise exception 'Choose what happens to dates that do not fit: refuse, or skip them' using errcode = 'OGV22';
  end if;
  v_s := ogevia.lock_series(p_organization_id, p_series_id);
  v_from := greatest(v_s.generated_through + 1, ogevia.organization_local_date(p_organization_id, now()));
  v_to := least(coalesce(v_s.ends_on, 'infinity'::date), p_through,
                (date_trunc('month', v_from) + interval '3 months' - interval '1 day')::date);
  if p_through is null or v_to < v_from then
    raise exception 'Nothing to add: the series is already scheduled through that date' using errcode = 'OGV22';
  end if;
  perform ogevia.series_lock(p_organization_id, v_s.client_id, v_s.service_id, v_s.caregiver_record_id, v_from, v_to);
  select * into v_m from ogevia.series_materialize(v_s, v_from, v_to, p_on_conflict, null, null, v_actor);
  update ogevia.shift_series set generated_through = v_to where id = v_s.id;
  perform ogevia.write_audit(p_organization_id, 'shift_series.extended', 'shift_series', v_s.id,
    jsonb_build_object('generated_through', v_s.generated_through),
    jsonb_build_object('generated_through', v_to, 'created', v_m.created, 'skipped', v_m.skipped), null);
  perform ogevia.idempotency_finish('extend_shift_series', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('created', v_m.created, 'skipped', v_m.skipped, 'generated_through', v_to));
  return query select v_m.created, v_m.skipped, v_to;
end;
$$;

revoke all on function ogevia.series_materialize(ogevia.shift_series, date, date, text, uuid, date, uuid) from public;
revoke all on function ogevia_api.create_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, text, uuid, jsonb) from public;
revoke all on function ogevia_api.change_shift_series_from(uuid, uuid, date, uuid, smallint[], time, time, date, text, text, uuid, jsonb, boolean) from public;
revoke all on function ogevia_api.extend_shift_series(uuid, uuid, date, text, uuid) from public;
grant execute on function ogevia_api.create_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, text, uuid, jsonb) to ogevia_app;
grant execute on function ogevia_api.change_shift_series_from(uuid, uuid, date, uuid, smallint[], time, time, date, text, text, uuid, jsonb, boolean) to ogevia_app;
grant execute on function ogevia_api.extend_shift_series(uuid, uuid, date, text, uuid) to ogevia_app;
