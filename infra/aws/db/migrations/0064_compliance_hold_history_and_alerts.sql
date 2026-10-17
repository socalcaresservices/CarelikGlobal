-- 0064 Compliance: holds that only verification can release, history that cannot be erased, and a live alert for a visit in progress (owner directive 2026-10-17,
-- requirement 10). Everything else asked for was already in 0055 and is verified by tests (README section 14): approved background clearance before any assignment,
-- the 14-calendar-day CPR/TB deadline from the hire date, automatic holds, blocked visit starts (OGR30), the list of affected shifts and standing assignments, and
-- a visit in progress is never ended by the system. Those rules still follow the agency's enforcement switch (activate_readiness_enforcement): a report-only agency
-- is not stranded. Activating it is an owner action and is not done here.
--
-- WHAT THIS CHANGES
--   1. A hold opened because the hire date was MISSING is now as sticky as one opened because the 14 days ended. Before, a manager entering a recent hire date
--      moved CPR/TB back into a fresh 14-day period and the hold released with no verification. Now the hold is released only when every blocking requirement is
--      verified by someone authorized (an administrator for background clearance; the document reviewer for CPR/TB). This reverses decision D8 of the 0055 design note.
--   2. History. caregiver_compliance_holds can no longer be deleted, a released hold cannot change, and a hold cannot be reopened or re-attributed. Background
--      clearance (one current row per caregiver) now writes an append-only event for every change, including a withdrawal and a delete, with the actor, so an earlier
--      approval is never lost by a later edit (caregiver_background_check_events).
--   3. Alert for a visit in progress. caregiver_blocked_now() is true for an open hold or, when enforcement is active, any blocking requirement right now. The
--      Needs-attention item 'in_progress_on_hold' (Critical) and the Action-needed count use it, so the office is told at once, not at the next 15-minute sweep.
--      Nothing ends, voids or reassigns the visit. The caregiver can still end it.
--   4. "Check now" (run_compliance_sweep) writes holds, flags and audit, so it now needs caregivers.manage or caregivers.compliance.manage (it used readiness.read).
-- Not changed: CPR/TB that expire DURING a shift block that shift at the gate, but the hold list is computed without a time window, so such a caregiver is not listed
-- as held (documented gap). Rollback restores the 0055/0063 definitions and removes the triggers and the event table (BACKUP REQUIRED for the events).

create function ogevia.caregiver_blocked_now(p_organization_id uuid, p_caregiver_record_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (select 1 from ogevia.caregiver_compliance_holds h where h.caregiver_record_id = p_caregiver_record_id and h.released_at is null)
      or (ogevia.readiness_enforced(p_organization_id, 'background', 'visit_start')
          and exists (select 1 from ogevia.compliance_blockers(p_organization_id, p_caregiver_record_id) b where b.blocking));
$$;
revoke all on function ogevia.caregiver_blocked_now(uuid, uuid) from public;

create table ogevia.caregiver_background_check_events (
  id bigserial primary key,
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  event text not null check (event in ('recorded', 'changed', 'removed')),
  actor_user_id uuid,
  before_state jsonb,
  after_state jsonb,
  occurred_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);
create index caregiver_background_check_events_cg on ogevia.caregiver_background_check_events (caregiver_record_id, occurred_at);
create trigger caregiver_background_check_events_no_update before update on ogevia.caregiver_background_check_events for each row execute function ogevia.forbid_update();
create trigger caregiver_background_check_events_no_delete before delete on ogevia.caregiver_background_check_events for each row execute function ogevia.forbid_delete();
alter table ogevia.caregiver_background_check_events enable row level security;
create policy readonly_select on ogevia.caregiver_background_check_events for select to ogevia_readonly using (true);
grant select on ogevia.caregiver_background_check_events to ogevia_readonly;

create function ogevia.caregiver_background_checks_history()
returns trigger
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    insert into ogevia.caregiver_background_check_events (organization_id, caregiver_record_id, event, actor_user_id, before_state)
    values (old.organization_id, old.caregiver_record_id, 'removed', ogevia.current_user_id(), to_jsonb(old));
  elsif tg_op = 'INSERT' then
    insert into ogevia.caregiver_background_check_events (organization_id, caregiver_record_id, event, actor_user_id, after_state)
    values (new.organization_id, new.caregiver_record_id, 'recorded', ogevia.current_user_id(), to_jsonb(new));
  elsif to_jsonb(old) - 'updated_at' is distinct from to_jsonb(new) - 'updated_at' then
    insert into ogevia.caregiver_background_check_events (organization_id, caregiver_record_id, event, actor_user_id, before_state, after_state)
    values (new.organization_id, new.caregiver_record_id, 'changed', ogevia.current_user_id(), to_jsonb(old), to_jsonb(new));
  end if;
  return null;
end;
$$;
revoke all on function ogevia.caregiver_background_checks_history() from public;
create trigger caregiver_background_checks_history after insert or update or delete on ogevia.caregiver_background_checks
for each row execute function ogevia.caregiver_background_checks_history();

create function ogevia_api.get_background_check_history(p_organization_id uuid, p_caregiver_record_id uuid)
returns table (event text, occurred_at timestamptz, actor_name text, before_state jsonb, after_state jsonb)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.compliance_read_guard(p_organization_id);
  return query
    select e.event, e.occurred_at, u.display_name, e.before_state, e.after_state
    from ogevia.caregiver_background_check_events e left join ogevia.app_users u on u.id = e.actor_user_id
    where e.organization_id = p_organization_id and e.caregiver_record_id = p_caregiver_record_id
    order by e.occurred_at, e.id;
end;
$$;
revoke all on function ogevia_api.get_background_check_history(uuid, uuid) from public;
grant execute on function ogevia_api.get_background_check_history(uuid, uuid) to ogevia_app;

create trigger caregiver_compliance_holds_no_delete before delete on ogevia.caregiver_compliance_holds for each row execute function ogevia.forbid_delete();
create function ogevia.caregiver_compliance_holds_guard()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.released_at is not null then raise exception 'A released compliance hold is history and cannot change' using errcode = 'OGC09'; end if;
  if new.id <> old.id or new.organization_id <> old.organization_id or new.caregiver_record_id <> old.caregiver_record_id
     or new.opened_at <> old.opened_at or new.opened_by is distinct from old.opened_by then
    raise exception 'A compliance hold keeps who and when it was opened' using errcode = 'OGC09';
  end if;
  if old.grace_closed and not new.grace_closed then raise exception 'A hold cannot be made less strict' using errcode = 'OGC09'; end if;
  return new;
end;
$$;
revoke all on function ogevia.caregiver_compliance_holds_guard() from public;
create trigger caregiver_compliance_holds_guard_update before update on ogevia.caregiver_compliance_holds for each row execute function ogevia.caregiver_compliance_holds_guard();

create or replace function ogevia.compliance_evaluate(p_organization_id uuid, p_caregiver_record_id uuid, p_actor uuid default null, p_now timestamptz default now())
returns text
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_hold ogevia.caregiver_compliance_holds%rowtype;
  v_reasons jsonb;
  v_closed boolean;
  v_impact jsonb;
begin
  if not ogevia.readiness_enforced(p_organization_id, 'background', 'visit_start') then return 'not_enforced'; end if;
  perform ogevia.lock_caregiver(p_caregiver_record_id);
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null or v_rec.status not in ('ready', 'active') then return 'not_applicable'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('requirement', b.requirement, 'code', b.code, 'message', b.message, 'dueDate', b.due_date)
                            order by b.requirement), '[]'::jsonb),
         coalesce(bool_or(b.code like '%\_after\_deadline' or b.code like '%\_no\_hire\_date'), false)
    into v_reasons, v_closed
  from ogevia.compliance_blockers(p_organization_id, p_caregiver_record_id, p_now) b where b.blocking;

  select * into v_hold from ogevia.caregiver_compliance_holds h where h.caregiver_record_id = p_caregiver_record_id and h.released_at is null for update;

  if jsonb_array_length(v_reasons) > 0 then
    if v_hold.id is null then
      insert into ogevia.caregiver_compliance_holds (organization_id, caregiver_record_id, reasons, grace_closed, opened_at, opened_by)
      values (p_organization_id, p_caregiver_record_id, v_reasons, v_closed, p_now, p_actor)
      returning * into v_hold;
      v_impact := ogevia.compliance_flag_impact(p_organization_id, p_caregiver_record_id, v_hold.id, v_reasons, p_actor);
      perform ogevia.write_audit(p_organization_id, 'caregiver.compliance_hold_opened', 'caregiver_compliance_holds', v_hold.id, null,
        jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'reasons', v_reasons, 'automatic', p_actor is null) || v_impact, null);
      return 'opened';
    end if;
    -- A hold that was opened because the period ended, OR because no hire date was recorded, stays that way: a later hire date does not release it. It is
    -- released only when every blocking requirement is VERIFIED (0064; the owner's rule: eligibility returns only after an authorized verification).
    update ogevia.caregiver_compliance_holds h
       set reasons = v_reasons, grace_closed = h.grace_closed or v_closed, updated_at = now()
     where h.id = v_hold.id and (h.reasons is distinct from v_reasons or (v_closed and not h.grace_closed));
    if found then
      perform ogevia.write_audit(p_organization_id, 'caregiver.compliance_hold_updated', 'caregiver_compliance_holds', v_hold.id,
        jsonb_build_object('reasons', v_hold.reasons), jsonb_build_object('reasons', v_reasons), null);
    end if;
    perform ogevia.compliance_flag_impact(p_organization_id, p_caregiver_record_id, v_hold.id, v_reasons, p_actor);
    return 'updated';
  end if;

  if v_hold.id is not null then
    update ogevia.caregiver_compliance_holds h
       set released_at = p_now, released_by = p_actor, updated_at = now(),
           release_note = 'Every blocking requirement is resolved. Shifts that were cancelled or reassigned while the hold was open were not restored.'
     where h.id = v_hold.id;
    update ogevia.shift_readiness_flags f
       set resolved_at = now(), resolved_by = p_actor,
           resolution = 'Compliance hold released: every blocking requirement is resolved. This shift was not changed.'
     where f.caregiver_record_id = p_caregiver_record_id and f.kind = 'compliance' and f.resolved_at is null;
    update ogevia.assignment_readiness_flags f
       set resolved_at = now(), resolved_by = p_actor,
           resolution = 'Compliance hold released: every blocking requirement is resolved.'
     where f.caregiver_record_id = p_caregiver_record_id and f.kind = 'compliance' and f.resolved_at is null;
    perform ogevia.write_audit(p_organization_id, 'caregiver.compliance_hold_released', 'caregiver_compliance_holds', v_hold.id,
      jsonb_build_object('reasons', v_hold.reasons), jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'automatic', p_actor is null), null);
    return 'released';
  end if;
  return 'none';
end;
$$;
create or replace function ogevia.compliance_blockers(p_organization_id uuid, p_caregiver_record_id uuid, p_as_of timestamptz default now())
returns table (requirement text, code text, message text, blocking boolean, due_date date)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  g record;
  c record;
  r text;
  v_bg text;
  v_base text;
  v_days text := ogevia.compliance_grace_days()::text || '-day';
begin
  select * into g from ogevia.compliance_grace(p_organization_id, p_caregiver_record_id, p_as_of);
  v_bg := ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id);
  if v_bg <> 'approved' then
    return query select 'background'::text, 'background_' || v_bg, ogevia.readiness_message('background', 'background_' || v_bg), true, null::date;
  end if;
  for r in select x from unnest(array['cpr', 'tb']) as x loop
    select * into c from ogevia.document_requirement_check(p_organization_id, p_caregiver_record_id, r, null, null);
    if c.status = 'ok' then continue; end if;
    if c.status in ('missing', 'awaiting_review') then
      v_base := ogevia.readiness_message(r, c.status);
      if g.in_grace then
        return query select r, c.status || '_pending', v_base || ' Due ' || to_char(g.due_date, 'YYYY-MM-DD') || '.', false, g.due_date;
      elsif g.hire_date is null then
        return query select r, c.status || '_no_hire_date',
          v_base || ' Hire date is not recorded, so the ' || v_days || ' period cannot be applied.', true, null::date;
      elsif g.sticky then
        return query select r, c.status || '_after_deadline',
          v_base || ' A compliance hold is open for this caregiver. It is released only when this requirement is verified; entering or changing the hire date does not release it.', true, g.due_date;
      else
        return query select r, c.status || '_after_deadline',
          v_base || ' The ' || v_days || ' period ended ' || to_char(g.due_date, 'YYYY-MM-DD') || '.', true, g.due_date;
      end if;
    else
      -- rejected, expired, expires_during, expiry_missing, type_not_set, policy_not_set: unchanged strict behaviour
      return query select r, c.status, ogevia.readiness_message(r, c.status), true, null::date;
    end if;
  end loop;
end;
$$;
create or replace function ogevia_api.run_compliance_sweep(p_organization_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  -- "Check now" writes holds, flags and audit, so it is not a read permission (0064; before, readiness.read could run it).
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'caregivers.manage') or ogevia.has_permission(p_organization_id, 'caregivers.compliance.manage')) then
    raise exception 'You do not have permission to re-check caregiver compliance' using errcode = 'OGA03';
  end if;
  return ogevia.compliance_sweep(p_organization_id, v_actor);
end;
$$;
create or replace function ogevia_api.get_compliance_attention(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) or not ogevia.has_permission(p_organization_id, 'readiness.read') then
    return null;
  end if;
  return jsonb_build_object(
    'holds', (select count(*) from ogevia.caregiver_compliance_holds h where h.organization_id = p_organization_id and h.released_at is null),
    'affectedShifts', (select count(*) from ogevia.shift_readiness_flags f
                       where f.organization_id = p_organization_id and f.kind = 'compliance' and f.resolved_at is null),
    -- live (0064): a visit in progress for a caregiver who is blocked NOW is counted without waiting for the next sweep to open the hold row
    'inProgressVisits', (select count(*) from ogevia.service_visits v
                         join ogevia.caregiver_records cr on cr.organization_id = v.organization_id
                          and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id))
                         where v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
                           and ogevia.caregiver_blocked_now(p_organization_id, cr.id)));
end;
$$;
create or replace function ogevia_api.get_attention_overview(p_organization_id uuid, p_urgent_hours integer default 48)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_win interval;
  v_can_visits boolean;
  v_can_cover boolean;
  v_can_docs boolean;
  v_can_comp boolean;
  v_can_bill boolean;
  v_urgent jsonb := null;
  v_upcoming jsonb := null;
  v_docs jsonb := null;
  v_review jsonb := null;
  v_pick jsonb := null;
  v_holds integer;
  v_pending integer;
begin
  if p_urgent_hours is null or p_urgent_hours < 1 or p_urgent_hours > 168 then
    raise exception 'The urgent window must be 1 to 168 hours' using errcode = 'OGV22';
  end if;
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  v_win := make_interval(hours => p_urgent_hours);
  v_can_visits := ogevia.has_permission(p_organization_id, 'visits.read');
  v_can_cover := ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage');
  v_can_docs := ogevia.has_permission(p_organization_id, 'documents.read');
  v_can_comp := ogevia.has_permission(p_organization_id, 'readiness.read');
  v_can_bill := ogevia.has_permission(p_organization_id, 'billing.visits.read');
  if not (v_can_visits or v_can_cover or v_can_docs or v_can_comp) then
    raise exception 'You do not have permission to see attention items' using errcode = 'OGA03';
  end if;

  -- NEEDS ATTENTION NOW -------------------------------------------------------------------------------------------
  if v_can_cover or v_can_visits or v_can_comp then
    with reasons as (
      -- an uncovered shift that starts inside the window or is already running
      select 'shift'::text as kind, sh.id as id, sh.starts_at as at, sh.ends_at as ends_at,
             case when ogevia.shift_is_called_out(sh.id) then 'uncovered_called_out' else 'uncovered_open' end as reason,
             ogevia.attention_shift_tier(sh.starts_at, now()) as severity, null::uuid as caregiver_id, sh.client_id as client_id, sh.service_id as service_id
      from ogevia.shifts sh
      where v_can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.ends_at > now() and sh.starts_at <= now() + v_win
        and ogevia.shift_coverage_state(sh) = 'needs_coverage'
      union all
      -- a shift inside the window whose caregiver is blocked (0055 hold, or a required-document problem flagged by 0041)
      select 'shift', sh.id, sh.starts_at, sh.ends_at,
             case f.kind when 'compliance' then 'compliance_hold' else 'documents_not_current' end, ogevia.attention_shift_tier(sh.starts_at, now()), f.caregiver_record_id, sh.client_id, sh.service_id
      from ogevia.shift_readiness_flags f
      join ogevia.shifts sh on sh.id = f.shift_id
      where (v_can_comp or v_can_cover) and f.organization_id = p_organization_id and f.kind in ('compliance', 'document') and f.resolved_at is null
        and sh.status = 'scheduled' and sh.ends_at > now() and sh.starts_at <= now() + v_win and not ogevia.shift_is_called_out(sh.id)
      union all
      -- a visit still open past its shift end (or 12 h without a schedule): the worked time is unknown
      select 'visit', v.id, v.time_in, null::timestamptz, 'missing_clock_out', 'urgent', v.caregiver_record_id, v.client_id, v.service_id
      from ogevia.service_visits v
      left join ogevia.shifts s on s.id = v.scheduled_shift_id
      where v_can_visits and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
        and ((s.id is not null and s.ends_at < now()) or (s.id is null and v.time_in <= now() - interval '12 hours'))
      union all
      -- a visit in progress for a caregiver who is on a compliance hold (or blocked right now, before the sweep has opened the hold): the office must arrange safe coverage. The visit is never ended or reassigned by the system.
      select 'visit', v.id, v.time_in, null::timestamptz, 'in_progress_on_hold', 'critical', v.caregiver_record_id, v.client_id, v.service_id
      from ogevia.service_visits v
      join ogevia.caregiver_records cr on cr.organization_id = v.organization_id
       and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id))
      where (v_can_comp or v_can_visits) and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
        and ogevia.caregiver_blocked_now(v.organization_id, cr.id)
    ), items as (
      select r.kind, r.id, min(r.at) as at, max(r.ends_at) as ends_at,
             (array_agg(distinct r.reason order by r.reason)) as reasons,
             case when bool_or(r.severity = 'critical') then 'critical' else 'urgent' end as tier,
             max(r.caregiver_id::text)::uuid as caregiver_id, max(r.client_id::text)::uuid as client_id, max(r.service_id::text)::uuid as service_id
      from reasons r group by r.kind, r.id
    )
    select jsonb_build_object(
             'items', coalesce(jsonb_agg(jsonb_build_object(
                'kind', i.kind, 'id', i.id, 'startsAt', i.at, 'endsAt', i.ends_at, 'reasons', to_jsonb(i.reasons), 'tier', i.tier, 'severity', case when i.tier = 'critical' then 'red' else 'amber' end,
                'inProgress', i.at <= now() and (i.ends_at is null or i.ends_at > now()),
                'caregiverRecordId', i.caregiver_id, 'caregiverCode', (select r2.caregiver_code from ogevia.caregiver_records r2 where r2.id = i.caregiver_id),
                'clientCode', (select c.client_code from ogevia.clients c where c.id = i.client_id),
                'serviceCode', (select s2.code from ogevia.services s2 where s2.id = i.service_id)) order by (i.tier = 'critical') desc, i.at), '[]'::jsonb),
             'itemCount', count(*),
             'issueCount', coalesce(sum(cardinality(i.reasons)), 0),
             'shifts', count(*) filter (where i.kind = 'shift'),
             'visits', count(*) filter (where i.kind = 'visit'),
             'critical', count(*) filter (where i.tier = 'critical'),
             'urgent', count(*) filter (where i.tier = 'urgent'))
      into v_urgent
    from items i;
  end if;

  -- UPCOMING STAFFING: shifts that start after the window and still need a person's attention: uncovered, or whose caregiver is blocked
  -- (0055 hold, required document). Same timing rule as Needs attention now: Upcoming beyond the window (more than 48 h), Urgent inside it, Critical at/after start.
  -- A hold is enforced immediately whatever the display tier; this only decides where the shift is listed.
  if v_can_cover or v_can_comp then
    select jsonb_build_object(
             'count', count(*),
             'nextStartsAt', min(x.starts_at),
             'shifts', coalesce(jsonb_agg(jsonb_build_object(
                'shiftId', x.id, 'startsAt', x.starts_at, 'endsAt', x.ends_at, 'reason', x.reason,
                'clientCode', (select c.client_code from ogevia.clients c where c.id = x.client_id),
                'serviceCode', (select s2.code from ogevia.services s2 where s2.id = x.service_id),
                'serviceName', (select s2.name from ogevia.services s2 where s2.id = x.service_id)) order by x.starts_at, x.id) filter (where x.rn <= 200), '[]'::jsonb))
      into v_upcoming
    from (
      select y.*, row_number() over (order by y.starts_at, y.id) as rn
      from (
        select distinct on (u.id) u.* from (
          select sh.id, sh.starts_at, sh.ends_at, sh.client_id, sh.service_id,
                 case when ogevia.shift_is_called_out(sh.id) then 'called_out' else 'open' end as reason
          from ogevia.shifts sh
          where v_can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.starts_at > now() + v_win
            and ogevia.shift_coverage_state(sh) = 'needs_coverage'
          union all
          select sh.id, sh.starts_at, sh.ends_at, sh.client_id, sh.service_id,
                 case f.kind when 'compliance' then 'compliance_hold' else 'documents_not_current' end
          from ogevia.shift_readiness_flags f
          join ogevia.shifts sh on sh.id = f.shift_id
          where (v_can_comp or v_can_cover) and f.organization_id = p_organization_id and f.kind in ('compliance', 'document') and f.resolved_at is null
            and sh.status = 'scheduled' and sh.starts_at > now() + v_win and not ogevia.shift_is_called_out(sh.id)
        ) u order by u.id, u.reason
      ) y
    ) x;
  end if;

  -- DOCUMENTS & COMPLIANCE -----------------------------------------------------------------------------------------------
  if v_can_docs then
    -- Routine review (awaiting a person, inside the deadline) is reported apart from review that has escalated: more than 48 hours since
    -- the upload, OR the document is expired, OR its caregiver has an upcoming shift flagged for documents (it blocks care).
    with d as (
      select x.display_status,
             (x.display_status = 'awaiting_review'
              and (x.latest_uploaded_at <= now() - make_interval(hours => ogevia.attention_rule_hours('document_review_overdue'))
                   or x.currency_status = 'expired'
                   or exists (select 1 from ogevia.shift_readiness_flags f join ogevia.shifts sh on sh.id = f.shift_id
                               where f.organization_id = p_organization_id and f.caregiver_record_id = x.caregiver_record_id
                                 and f.kind = 'document' and f.resolved_at is null and sh.status = 'scheduled' and sh.ends_at > now()
                                 and not ogevia.shift_is_called_out(sh.id)))) as escalated
      from ogevia_api.list_staff_documents(p_organization_id, null) x
    )
    select jsonb_build_object(
             'overdue', count(*) filter (where d.display_status in ('expired', 'overdue')),
             'dueSoon', count(*) filter (where d.display_status = 'expiring'),
             'awaitingReview', count(*) filter (where d.display_status = 'awaiting_review'),
             'reviewOverdue', count(*) filter (where d.escalated),
             'reviewRoutine', count(*) filter (where d.display_status = 'awaiting_review' and not d.escalated),
             'rejected', count(*) filter (where d.display_status = 'rejected'))
      into v_docs
    from d;
  end if;
  if v_can_comp then
    select count(*)::int into v_holds from ogevia.caregiver_compliance_holds h where h.organization_id = p_organization_id and h.released_at is null;
    select count(*)::int into v_pending from ogevia.caregiver_records r
    where r.organization_id = p_organization_id and r.deleted_at is null and r.status in ('ready', 'active')
      and exists (select 1 from ogevia.compliance_blockers(p_organization_id, r.id) b where not b.blocking);
    v_docs := coalesce(v_docs, '{}'::jsonb) || jsonb_build_object('caregiversOnHold', v_holds, 'caregiversWithPendingRequirements', v_pending);
  end if;

  -- VISIT REVIEW: unique visits. What needs a person (administrator review from the moment it starts, a late answer, a confirmation more than 48 h
  -- overdue) is counted in visitsNeedingAttention. Pending Confirmation (inside 48 h of the visit end) and Ready for Approval are counted apart and
  -- never added to it. Administrator review is Urgent after 24 h in the queue (reviewOverdue).
  if v_can_visits then
    with u as (
      select v.id, 'pending_confirmation'::text as kind, v.time_out as at from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
         and v.time_out > now() - make_interval(hours => ogevia.attention_rule_hours('confirmation_overdue'))
      union all
      select v.id, 'confirmation_overdue', v.time_out from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
         and v.time_out <= now() - make_interval(hours => ogevia.attention_rule_hours('confirmation_overdue'))
      union all
      select v.id, 'needs_review', ogevia.visit_review_entered_at(v.id) from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'administrator_review'
         and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
         and ogevia.visit_recovery_state(v.id) is null
      union all
      select v.id, 'late_response', ogevia.visit_late_response_at(v.id) from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'administrator_review' and ogevia.visit_recovery_state(v.id) = 'response_to_review'
      union all
      select v.id, 'ready_for_approval', v.signed_at from ogevia.service_visits v
       where v_can_bill and v.organization_id = p_organization_id and v.status in ('signed', 'administrator_review')
         and ogevia.visit_billing_state(v.id) in ('ready_for_review', 'voided')
    )
    select jsonb_build_object(
             'visitsNeedingAttention', count(distinct u.id) filter (where u.kind in ('needs_review', 'late_response', 'confirmation_overdue')),
             'pendingConfirmation', count(distinct u.id) filter (where u.kind = 'pending_confirmation'),
             'confirmationOverdue', count(distinct u.id) filter (where u.kind = 'confirmation_overdue'),
             'awaitingConfirmation', count(distinct u.id) filter (where u.kind in ('pending_confirmation', 'confirmation_overdue')),
             'needsReview', count(distinct u.id) filter (where u.kind = 'needs_review'),
             'reviewOverdue', count(distinct u.id) filter (where u.kind in ('needs_review', 'late_response') and u.at <= now() - make_interval(hours => ogevia.attention_rule_hours('review_overdue'))),
             'lateResponses', count(distinct u.id) filter (where u.kind = 'late_response'),
             'readyForApproval', case when v_can_bill then count(distinct u.id) filter (where u.kind = 'ready_for_approval') end,
             'reviewIssues', coalesce(sum(cardinality(coalesce(ogevia.visit_review_reasons(u.id), array[]::text[]))) filter (where u.kind = 'needs_review'), 0),
             'awaitingResponse', (select count(*) from ogevia.service_visits v where v.organization_id = p_organization_id and v.status = 'administrator_review'
                                   and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
                                   and ogevia.visit_recovery_state(v.id) = 'awaiting_response'))
      into v_review
    from u;
  end if;

  -- PICKUP REQUESTS (0063): a caregiver asked for an open shift and no one has confirmed it yet. Routine: counted here, never added to the urgent total.
  if ogevia.has_permission(p_organization_id, 'shifts.manage') then
    select jsonb_build_object('count', count(*), 'oldestRequestedAt', min(r.requested_at)) into v_pick
    from ogevia.shift_pickup_requests r join ogevia.shifts sh on sh.id = r.shift_id
    where r.organization_id = p_organization_id and r.status = 'pending' and sh.status = 'scheduled' and sh.ends_at > now();
  end if;

  return jsonb_build_object(
    'asOf', now(), 'urgentWindowHours', p_urgent_hours, 'pickups', v_pick,
    'urgent', v_urgent, 'upcoming', v_upcoming, 'documents', v_docs, 'visitReview', v_review);
end;
$$;
