-- 0051 Wave 1, part 2: a caregiver picks up an open or called-out shift (gap G09, decision D-P).
--
-- Owner decisions (2026-10-13): exactly one caregiver wins a claim; a retry or double tap never makes a second claim;
-- authorization is re-checked on the server when the claim is made; the reservation created at scheduling is kept (Q-R) and
-- is not redesigned; a caregiver who called out of a shift may not pick it up again, the office reassigns it (O-1).
--
-- Before (verified in the repository, 2026-10-13): there was no caregiver route to take a shift. The office assigns through
-- ogevia_api.assign_shift_caregiver (0042), which already refuses the caregiver who called out.
--
-- Changes (new functions only; no table, column, trigger or stored row changes):
--   * ogevia_api.list_open_shifts(org): upcoming shifts that need coverage (open, or called out and not replaced) for a client
--     and service the signed-in caregiver is assigned to, excluding shifts the caregiver called out of and shifts that came
--     from a Care Request (those are managed on the Care Requests page, as in lock_staff_shift). Client code only; no names.
--   * ogevia_api.pickup_open_shift(org, shift, idempotency_key): serializes on the shift row (FOR UPDATE), so two claims
--     cannot both win; then checks, in one transaction: the caregiver's Care Team record is active, the shift is still open
--     or called out, no visit has started, the caregiver did not call out of it, the client and service are assigned to the
--     caregiver, the caregiver is free and ready (check_shift_caregiver, which includes the readiness gate), and the
--     authorization still covers the shift: the shift's own reservation must exist and used plus reserved minutes for the
--     authorization month must not exceed the current cap (after any amendment). The reservation row is not changed, so no
--     minute is reserved twice. Writes the same coverage event and audit as an office assignment, marked as a pickup.
--     A second tap by the same caregiver returns the first result and writes nothing.

create function ogevia_api.list_open_shifts(p_organization_id uuid)
returns table (
  shift_id uuid, starts_at timestamptz, ends_at timestamptz, minutes integer,
  client_code text, service_name text, coverage_state text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select s.id, s.starts_at, s.ends_at, floor(extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer,
         coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code), sv.name,
         ogevia.shift_coverage_state(s)
  from ogevia.shifts s
  join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  where s.organization_id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.is_active_caregiver(p_organization_id)
    and s.status = 'scheduled' and s.ends_at > now() and s.starts_at < now() + interval '14 days'
    and ogevia.shift_coverage_state(s) = 'needs_coverage'
    and not ogevia.shift_is_care_request(s.id)
    and ogevia.caregiver_has_active_assignment(p_organization_id, s.client_id, s.service_id)
    and not exists (
      select 1 from ogevia.shift_coverage_events e
      join ogevia.caregiver_records cr on cr.id = e.original_caregiver_record_id
      where e.shift_id = s.id and e.event_type = 'called_out' and cr.linked_user_id = ogevia.require_actor()
    )
    and not exists (
      select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected')
    )
  order by s.starts_at;
$$;

create function ogevia_api.pickup_open_shift(
  p_organization_id uuid, p_shift_id uuid, p_idempotency_key uuid default null
)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_shift_id);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_s ogevia.shifts%rowtype;
  v_res ogevia.authorization_reservations%rowtype;
  v_cap ogevia.client_authorizations%rowtype;
  v_used bigint;
  v_reserved bigint;
  v_kind text;
begin
  if not ogevia.is_active_member(p_organization_id) or not ogevia.is_active_caregiver(p_organization_id) then
    raise exception 'Only an active caregiver can pick up a shift' using errcode = 'OGA03';
  end if;
  select cr.* into v_rec
  from ogevia.caregiver_records cr
  where cr.organization_id = p_organization_id and cr.linked_user_id = v_actor and cr.deleted_at is null
  order by case when cr.status in ('active', 'ready') then 0 else 1 end, cr.updated_at desc
  limit 1;
  if v_rec.id is null or v_rec.status not in ('active', 'ready') then
    raise exception 'Your Care Team profile is not active. Contact your agency manager before picking up a shift.' using errcode = 'OGA03';
  end if;

  v_prior := ogevia.idempotency_begin('pickup_open_shift', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'state'; end if;

  -- Row lock on the shift: a second claim waits here and then sees the shift filled.
  select * into v_s from ogevia.shifts s where s.id = p_shift_id and s.organization_id = p_organization_id for update;
  if v_s.id is null then raise exception 'Shift not found' using errcode = 'OGN04'; end if;
  if ogevia.shift_is_care_request(v_s.id) then
    raise exception 'This shift came from a Care Request and is handled by the office' using errcode = 'OGC09';
  end if;
  if v_s.status <> 'scheduled' then raise exception 'This shift is no longer scheduled' using errcode = 'OGC09'; end if;
  if v_s.ends_at <= now() then raise exception 'This shift is already over' using errcode = 'OGC09'; end if;

  -- A repeat by the caregiver who already holds this shift is not a second claim.
  if v_s.caregiver_record_id = v_rec.id and not ogevia.shift_is_called_out(v_s.id) then
    perform ogevia.idempotency_finish('pickup_open_shift', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'covered'));
    return 'covered';
  end if;
  if ogevia.shift_coverage_state(v_s) <> 'needs_coverage' then
    raise exception 'This shift was just filled' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit has already started for this shift' using errcode = 'OGC09';
  end if;
  -- O-1: the caregiver who called out of a shift does not take it back; the office reassigns it.
  if exists (select 1 from ogevia.shift_coverage_events e
             where e.shift_id = v_s.id and e.event_type = 'called_out' and e.original_caregiver_record_id = v_rec.id) then
    raise exception 'You called out of this shift. Ask the office to reassign it.' using errcode = 'OGC09';
  end if;
  if not ogevia.caregiver_has_active_assignment(p_organization_id, v_s.client_id, v_s.service_id) then
    raise exception 'This client and service are not assigned to you' using errcode = 'OGA03';
  end if;
  -- Free and ready (overlaps, Care Team status, the readiness gate).
  v_rec := ogevia.check_shift_caregiver(p_organization_id, v_rec.id, v_s.starts_at, v_s.ends_at, v_s.id, v_s.service_id);

  -- Q-R: the reservation made at scheduling is kept. Re-check, under the authorization lock, that it exists and that the
  -- authorization still covers it (an amendment may have lowered the cap since the shift was scheduled).
  select * into v_res from ogevia.authorization_reservations r where r.shift_id = v_s.id and r.released_at is null for update;
  if v_res.id is null then
    raise exception 'This shift has no authorization reserved. Ask the office.' using errcode = 'OGC09';
  end if;
  perform ogevia.lock_authorization_lineage(v_res.authorization_lineage_id);
  select * into v_cap from ogevia.client_authorizations a
  where a.lineage_id = v_res.authorization_lineage_id and a.is_current and a.deleted_at is null
    and v_res.service_date between a.period_start and a.period_end;
  if v_cap.id is null then
    raise exception 'Authorization no longer covers this shift. Ask the office.' using errcode = 'OGC09';
  end if;
  v_used := ogevia.authorization_month_usage(v_res.authorization_lineage_id, v_res.service_date, null);
  v_reserved := ogevia.authorization_month_reserved(v_res.authorization_lineage_id, v_res.service_date);
  if v_used + v_reserved > v_cap.monthly_authorized_minutes then
    raise exception 'Authorization no longer covers this shift (% over). Ask the office.',
      ogevia.format_duration((v_used + v_reserved - v_cap.monthly_authorized_minutes)::integer) using errcode = 'OGC09';
  end if;

  v_kind := case when v_s.caregiver_record_id is null then 'Open shift picked up by caregiver'
                 else 'Replacement picked up by caregiver after call-out' end;
  insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type, actor_user_id, original_caregiver_record_id,
                                            replacement_caregiver_record_id, reason, before_snapshot, after_snapshot)
  values (p_organization_id, v_s.id, 'reassigned', v_actor, v_s.caregiver_record_id, v_rec.id, v_kind,
          jsonb_build_object('caregiver_record_id', v_s.caregiver_record_id),
          jsonb_build_object('caregiver_record_id', v_rec.id, 'pickup', true,
                             'reservation_id', v_res.id, 'reserved_minutes', v_res.reserved_minutes,
                             'authorization_checked', true));
  update ogevia.shifts set caregiver_record_id = v_rec.id, caregiver_user_id = v_rec.linked_user_id, updated_at = now() where id = v_s.id;
  perform ogevia.write_audit(p_organization_id, 'shift.picked_up', 'shifts', v_s.id,
    jsonb_build_object('caregiver_record_id', v_s.caregiver_record_id),
    jsonb_build_object('caregiver_record_id', v_rec.id, 'reservation_id', v_res.id, 'reserved_minutes', v_res.reserved_minutes), v_kind);
  perform ogevia.idempotency_finish('pickup_open_shift', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'covered'));
  return 'covered';
end;
$$;

revoke all on function ogevia_api.list_open_shifts(uuid) from public;
grant execute on function ogevia_api.list_open_shifts(uuid) to ogevia_app;
revoke all on function ogevia_api.pickup_open_shift(uuid, uuid, uuid) from public;
grant execute on function ogevia_api.pickup_open_shift(uuid, uuid, uuid) to ogevia_app;
