-- 0068 Authorization amendments report and keep the reserved shifts they affect (owner request 2026-10-17, blocker 3; gap list G10, directive section 8).
--
-- BEFORE: amend_client_authorization created the new version and returned affected VISITS once; reserved shifts that a lowered cap or a shortened period left
-- over the new terms were not reported at all, and nothing was stored, so the report vanished when the page closed.
-- NOW: every amendment records its impacts (append-only, organization-scoped, who and when):
--   reserved_shift_over_cap        a reserved shift that no longer fits: within each agency month, reservations are taken in time order and those whose running total
--                                  exceeds (new cap - minutes already used) are listed (used includes approved rounding adjustments and accepted late confirmations)
--   reserved_shift_outside_period  a reserved shift whose date is outside the new period
--   decrease_now_exceeds / increase_may_allow_more   the visit impacts that were already returned, now stored
-- NOTHING IS CHANGED OR RELEASED BY AN AMENDMENT: no shift is cancelled, no reservation released, no visit status changed, nothing re-billed, no hours auto-billed.
-- Since 0063/0065 the system already refuses to assign or confirm a caregiver on a shift whose authorization no longer covers it; the office now also SEES which shifts.
-- Each impact stays open until a person acknowledges it with a note (acknowledged impacts are kept). An impact is "still applicable" while its shift still holds a
-- reservation (or its visit is still signed / in review). Needs-attention overview gains amendmentImpacts. The retroactive-decrease rule "move an unapproved Billing
-- Ready visit back to review" (gap list decision D-A) is NOT implemented: it is an open owner decision.
-- amend_client_authorization gains three return columns (affected_shift_id, impact_id, impact_minutes), so it is dropped and recreated; a retried request now returns the
-- recorded impacts. Rollback (BACKUP REQUIRED: impact and acknowledgement history dropped) restores the 0006 function and the 0067 overview.


create table ogevia.authorization_amendment_impacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  lineage_id uuid not null,
  from_authorization_id uuid not null,
  to_authorization_id uuid not null,
  impact_kind text not null check (impact_kind in ('reserved_shift_over_cap', 'reserved_shift_outside_period', 'decrease_now_exceeds', 'increase_may_allow_more')),
  shift_id uuid,
  visit_id uuid,
  reservation_id uuid,
  service_date date not null,
  minutes integer,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid not null references ogevia.app_users(id),
  check ((shift_id is not null) <> (visit_id is not null))
);
create index authorization_amendment_impacts_org on ogevia.authorization_amendment_impacts (organization_id, created_at desc);
create index authorization_amendment_impacts_to on ogevia.authorization_amendment_impacts (to_authorization_id);
create trigger authorization_amendment_impacts_no_update before update on ogevia.authorization_amendment_impacts for each row execute function ogevia.forbid_update();
create trigger authorization_amendment_impacts_no_delete before delete on ogevia.authorization_amendment_impacts for each row execute function ogevia.forbid_delete();
alter table ogevia.authorization_amendment_impacts enable row level security;
create policy readonly_select on ogevia.authorization_amendment_impacts for select to ogevia_readonly using (true);
grant select on ogevia.authorization_amendment_impacts to ogevia_readonly;

create table ogevia.authorization_amendment_impact_acks (
  impact_id uuid primary key references ogevia.authorization_amendment_impacts(id),
  organization_id uuid not null references ogevia.organizations(id),
  note text not null check (length(btrim(note)) between 5 and 1000),
  acknowledged_by uuid not null references ogevia.app_users(id),
  acknowledged_at timestamptz not null default now()
);
create trigger authorization_amendment_impact_acks_no_update before update on ogevia.authorization_amendment_impact_acks for each row execute function ogevia.forbid_update();
create trigger authorization_amendment_impact_acks_no_delete before delete on ogevia.authorization_amendment_impact_acks for each row execute function ogevia.forbid_delete();
alter table ogevia.authorization_amendment_impact_acks enable row level security;
create policy readonly_select on ogevia.authorization_amendment_impact_acks for select to ogevia_readonly using (true);
grant select on ogevia.authorization_amendment_impact_acks to ogevia_readonly;

-- Records what an amendment affects. Reserved shifts are taken in time order within each agency month; those that no longer fit (used + reserved above the new cap)
-- or that fall outside the new period are the impacted ones. Reservations that are already counted as used are not reserved and are not listed.
create function ogevia.record_amendment_impacts(p_old ogevia.client_authorizations, p_new_id uuid, p_actor uuid)
returns void
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_new ogevia.client_authorizations%rowtype;
  v_up boolean;
begin
  select * into v_new from ogevia.client_authorizations a where a.id = p_new_id;
  v_up := v_new.monthly_authorized_minutes > p_old.monthly_authorized_minutes;
  insert into ogevia.authorization_amendment_impacts (organization_id, lineage_id, from_authorization_id, to_authorization_id, impact_kind, visit_id, service_date, minutes, detail, created_by)
  select p_old.organization_id, p_old.lineage_id, p_old.id, p_new_id,
         case when v_up then 'increase_may_allow_more' else 'decrease_now_exceeds' end, v.id, v.service_date, v.billable_minutes,
         jsonb_build_object('visit_status', v.status, 'worked_minutes', v.worked_minutes), p_actor
  from ogevia.service_visits v
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  where a.lineage_id = p_old.lineage_id and v.status not in ('voided', 'corrected')
    and ((v_up and v.authorization_status in ('exceeds_authorization', 'limit_reached')) or (not v_up and v.status in ('signed', 'administrator_review')));

  if v_new.monthly_authorized_minutes < p_old.monthly_authorized_minutes or v_new.period_start > p_old.period_start or v_new.period_end < p_old.period_end then
    insert into ogevia.authorization_amendment_impacts (organization_id, lineage_id, from_authorization_id, to_authorization_id, impact_kind, shift_id, reservation_id, service_date, minutes, detail, created_by)
    select p_old.organization_id, p_old.lineage_id, p_old.id, p_new_id,
           case when x.outside then 'reserved_shift_outside_period' else 'reserved_shift_over_cap' end,
           x.shift_id, x.reservation_id, x.service_date, x.reserved_minutes,
           jsonb_build_object('bucket', x.bucket, 'new_monthly_minutes', v_new.monthly_authorized_minutes, 'used_minutes', x.used, 'cumulative_reserved_minutes', x.cum,
                              'new_period_start', v_new.period_start, 'new_period_end', v_new.period_end), p_actor
    from (
      select y.*, sum(case when y.outside then 0 else y.reserved_minutes end) over (partition by y.m order by y.starts_at, y.reservation_id) as cum
      from (
        select r.id as reservation_id, r.shift_id, r.service_date, r.reserved_minutes, s.starts_at, ogevia.reservation_bucket(r.id) as bucket,
               date_trunc('month', r.service_date::timestamp)::date as m,
               (r.service_date < v_new.period_start or r.service_date > v_new.period_end) as outside,
               ogevia.authorization_month_usage(p_old.lineage_id, r.service_date) as used
        from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id
        where r.authorization_lineage_id = p_old.lineage_id and r.released_at is null and not ogevia.reservation_counted_as_used(r.shift_id)
      ) y
    ) x
    where x.outside or x.cum > v_new.monthly_authorized_minutes - x.used;
  end if;
end;
$$;
revoke all on function ogevia.record_amendment_impacts(ogevia.client_authorizations, uuid, uuid) from public;

create function ogevia_api.list_authorization_amendment_impacts(p_organization_id uuid, p_include_acknowledged boolean default false)
returns table (
  impact_id uuid, created_at timestamptz, impact_kind text, client_code text, service_code text, service_name text, new_version_number integer, new_monthly_minutes integer,
  shift_id uuid, shift_starts_at timestamptz, shift_ends_at timestamptz, visit_id uuid, service_date date, minutes integer, bucket text, still_applicable boolean,
  acknowledged_at timestamptz, acknowledged_by_name text, acknowledgement_note text, amended_by_name text
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'authorizations.update') or ogevia.has_permission(p_organization_id, 'shifts.manage')) then
    raise exception 'You do not have permission to see authorization amendment impacts' using errcode = 'OGA03';
  end if;
  return query
  select i.id, i.created_at, i.impact_kind, c.client_code, sv.code, sv.name, na.version_number, na.monthly_authorized_minutes,
         i.shift_id, sh.starts_at, sh.ends_at, i.visit_id, i.service_date, i.minutes,
         (select ogevia.reservation_bucket(i.reservation_id)) as bucket,
         case when i.shift_id is not null then coalesce(ogevia.reservation_bucket(i.reservation_id), '') <> ''
              else exists (select 1 from ogevia.service_visits v where v.id = i.visit_id and v.status in ('signed', 'administrator_review')) end,
         k.acknowledged_at, ku.display_name, k.note, cu.display_name
  from ogevia.authorization_amendment_impacts i
  join ogevia.client_authorizations na on na.id = i.to_authorization_id
  join ogevia.clients c on c.id = na.client_id
  join ogevia.services sv on sv.id = na.service_id
  left join ogevia.shifts sh on sh.id = i.shift_id
  left join ogevia.authorization_amendment_impact_acks k on k.impact_id = i.id
  left join ogevia.app_users ku on ku.id = k.acknowledged_by
  left join ogevia.app_users cu on cu.id = i.created_by
  where i.organization_id = p_organization_id and (p_include_acknowledged or k.impact_id is null)
  order by i.created_at desc, i.service_date, i.id;
end;
$$;

create function ogevia_api.acknowledge_authorization_amendment_impact(p_organization_id uuid, p_impact_id uuid, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_note text := btrim(coalesce(p_note, ''));
  v_i ogevia.authorization_amendment_impacts%rowtype;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'authorizations.update') or ogevia.has_permission(p_organization_id, 'shifts.manage')) then
    raise exception 'You do not have permission to acknowledge authorization amendment impacts' using errcode = 'OGA03';
  end if;
  if length(v_note) < 5 then raise exception 'Enter a note saying what you did or decided' using errcode = 'OGV22'; end if;
  select * into v_i from ogevia.authorization_amendment_impacts i where i.id = p_impact_id and i.organization_id = p_organization_id;
  if v_i.id is null then raise exception 'Impact not found' using errcode = 'OGN04'; end if;
  insert into ogevia.authorization_amendment_impact_acks (impact_id, organization_id, note, acknowledged_by) values (v_i.id, p_organization_id, v_note, v_actor)
  on conflict (impact_id) do nothing;
  if not found then raise exception 'This impact was already acknowledged' using errcode = 'OGC09'; end if;
  perform ogevia.write_audit(p_organization_id, 'authorization_amendment_impact.acknowledged', 'authorization_amendment_impacts', v_i.id, null,
    jsonb_build_object('impact_kind', v_i.impact_kind, 'shift_id', v_i.shift_id, 'visit_id', v_i.visit_id), v_note);
  return jsonb_build_object('impactId', v_i.id, 'acknowledged', true);
end;
$$;
revoke all on function ogevia_api.list_authorization_amendment_impacts(uuid, boolean) from public;
revoke all on function ogevia_api.acknowledge_authorization_amendment_impact(uuid, uuid, text) from public;
grant execute on function ogevia_api.list_authorization_amendment_impacts(uuid, boolean) to ogevia_app;
grant execute on function ogevia_api.acknowledge_authorization_amendment_impact(uuid, uuid, text) to ogevia_app;

drop function ogevia_api.amend_client_authorization(uuid, integer, date, date, text, text, text, date, text, uuid);
create function ogevia_api.amend_client_authorization(
  p_authorization_id uuid,
  p_monthly_authorized_minutes integer,
  p_period_start date,
  p_period_end date,
  p_payer text,
  p_reason text,
  p_authorization_number text default null,
  p_received_date date default null,
  p_source_reference text default null,
  p_idempotency_key uuid default null
)
returns table (
  new_authorization_id uuid,
  new_version_number integer,
  affected_visit_id uuid,
  affected_visit_status ogevia.service_visit_status,
  affected_service_date date,
  affected_worked_minutes integer,
  affected_billable_minutes integer,
  impact_kind text,
  affected_shift_id uuid,
  impact_id uuid,
  impact_minutes integer
)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_old ogevia.client_authorizations%rowtype;
  v_new_id uuid;
  v_fingerprint text := concat_ws('|', p_authorization_id, p_monthly_authorized_minutes,
                                  p_period_start, p_period_end, p_payer);
  v_prior jsonb;
  v_moved_up boolean;
begin
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'Period end must be after period start' using errcode = 'OGV22';
  end if;
  if p_monthly_authorized_minutes is null or p_monthly_authorized_minutes < 0 then
    raise exception 'Authorized minutes cannot be negative' using errcode = 'OGV22';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to amend an authorization' using errcode = 'OGV22';
  end if;

  select * into v_old from ogevia.client_authorizations a where a.id = p_authorization_id for update;
  if v_old.id is null or not ogevia.is_active_member(v_old.organization_id) then
    raise exception 'Authorization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_old.organization_id, 'authorizations.update') then
    raise exception 'You do not have permission to amend authorizations for this organization'
      using errcode = 'OGA03';
  end if;
  perform ogevia.lock_authorization_lineage(v_old.lineage_id);

  v_prior := ogevia.idempotency_begin('amend_authorization', p_idempotency_key, v_old.organization_id, v_fingerprint);
  if v_prior is not null then
    -- a retried request returns the impacts that were recorded the first time (0068), not an empty report
    return query select (v_prior ->> 'new_authorization_id')::uuid, (v_prior ->> 'new_version_number')::integer, i.visit_id, v.status, i.service_date, v.worked_minutes,
                        v.billable_minutes, i.impact_kind, i.shift_id, i.id, i.minutes
                 from ogevia.authorization_amendment_impacts i left join ogevia.service_visits v on v.id = i.visit_id
                 where i.to_authorization_id = (v_prior ->> 'new_authorization_id')::uuid
                 order by i.service_date, i.id;
    if not found then
      return query select (v_prior ->> 'new_authorization_id')::uuid, (v_prior ->> 'new_version_number')::integer, null::uuid, null::ogevia.service_visit_status, null::date,
                          null::integer, null::integer, null::text, null::uuid, null::uuid, null::integer;
    end if;
    return;
  end if;

  if not v_old.is_current then
    raise exception 'This authorization has already been superseded by a later amendment' using errcode = 'OGC09';
  end if;
  if v_old.deleted_at is not null then
    raise exception 'This authorization has been removed' using errcode = 'OGC09';
  end if;

  v_moved_up := p_monthly_authorized_minutes > v_old.monthly_authorized_minutes;
  v_new_id := gen_random_uuid();

  -- Retire the old version first so the exclusion constraint admits the new one.
  update ogevia.client_authorizations a set is_current = false, updated_at = now() where a.id = v_old.id;
  insert into ogevia.client_authorizations (
    id, organization_id, client_id, service_id, lineage_id, version_number, is_current, supersedes_id,
    payer, authorization_number, monthly_authorized_minutes, period_start, period_end, hourly_rate_cents,
    received_date, source_reference, change_reason, created_by
  ) values (
    v_new_id, v_old.organization_id, v_old.client_id, v_old.service_id, v_old.lineage_id,
    v_old.version_number + 1, true, v_old.id, p_payer, p_authorization_number,
    p_monthly_authorized_minutes, p_period_start, p_period_end, v_old.hourly_rate_cents,
    p_received_date, p_source_reference, btrim(p_reason), v_actor
  );
  update ogevia.client_authorizations a set superseded_by_id = v_new_id, updated_at = now() where a.id = v_old.id;

  perform ogevia.write_audit(v_old.organization_id, 'client_authorization.amended', 'client_authorizations',
    v_new_id,
    jsonb_build_object('authorization_id', v_old.id, 'version', v_old.version_number,
                       'monthly_authorized_minutes', v_old.monthly_authorized_minutes,
                       'period_start', v_old.period_start, 'period_end', v_old.period_end),
    jsonb_build_object('authorization_id', v_new_id, 'version', v_old.version_number + 1,
                       'monthly_authorized_minutes', p_monthly_authorized_minutes,
                       'period_start', p_period_start, 'period_end', p_period_end),
    btrim(p_reason));
  perform ogevia.idempotency_finish('amend_authorization', p_idempotency_key, v_old.organization_id,
    v_fingerprint, jsonb_build_object('new_authorization_id', v_new_id,
                                      'new_version_number', v_old.version_number + 1));

  -- Impact report (0068): recorded, not just returned. Visits that a review may need to revisit, AND the reserved shifts that no longer fit the new terms.
  -- Nothing is changed, released, re-billed or moved: each impact stays open until a person acknowledges it.
  perform ogevia.record_amendment_impacts(v_old, v_new_id, v_actor);
  return query
  select v_new_id, v_old.version_number + 1, i.visit_id, v.status, i.service_date, v.worked_minutes, v.billable_minutes, i.impact_kind, i.shift_id, i.id, i.minutes
  from ogevia.authorization_amendment_impacts i left join ogevia.service_visits v on v.id = i.visit_id
  where i.to_authorization_id = v_new_id
  union all
  select v_new_id, v_old.version_number + 1, null, null, null, null, null, null, null, null, null
  where not exists (select 1 from ogevia.authorization_amendment_impacts i where i.to_authorization_id = v_new_id)
  order by 3 nulls last;
end;
$$;
revoke all on function ogevia_api.amend_client_authorization(uuid, integer, date, date, text, text, text, date, text, uuid) from public;
grant execute on function ogevia_api.amend_client_authorization(uuid, integer, date, date, text, text, text, date, text, uuid) to ogevia_app;

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
  v_recon jsonb := null;
  v_imp jsonb := null;
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

  -- RECONCILIATION (0067): shifts that ended with no visit record and still hold a reservation. Nothing is released automatically; a person decides.
  if ogevia.has_permission(p_organization_id, 'shifts.manage') then
    select jsonb_build_object('count', count(*), 'minutes', coalesce(sum(r.reserved_minutes), 0), 'oldestEndedAt', min(sh.ends_at)) into v_recon
    from ogevia.authorization_reservations r join ogevia.shifts sh on sh.id = r.shift_id
    where r.organization_id = p_organization_id and r.released_at is null and ogevia.reservation_bucket(r.id) in ('unreconciled', 'awaiting_record');
  end if;

  -- AUTHORIZATION AMENDMENT IMPACTS (0068): reserved shifts and visits an amendment affected, not yet acknowledged and still applicable.
  if ogevia.has_permission(p_organization_id, 'authorizations.update') or ogevia.has_permission(p_organization_id, 'shifts.manage') then
    select jsonb_build_object('count', count(*), 'oldestAt', min(i.created_at)) into v_imp
    from ogevia.authorization_amendment_impacts i
    where i.organization_id = p_organization_id
      and not exists (select 1 from ogevia.authorization_amendment_impact_acks k where k.impact_id = i.id)
      and case when i.shift_id is not null then ogevia.reservation_bucket(i.reservation_id) is not null
               else exists (select 1 from ogevia.service_visits v where v.id = i.visit_id and v.status in ('signed', 'administrator_review')) end;
  end if;

  return jsonb_build_object(
    'asOf', now(), 'urgentWindowHours', p_urgent_hours, 'pickups', v_pick, 'reconciliation', v_recon, 'amendmentImpacts', v_imp,
    'urgent', v_urgent, 'upcoming', v_upcoming, 'documents', v_docs, 'visitReview', v_review);
end;
$$;
