-- 0073 Agency-configurable shorter deadlines; one stable issue identity with history, filters and paging (Board 4 decisions 1, 3, 6, 7, 9, 10, 12, 13).
--
-- Agency deadlines (Board 4 decisions 3 and 6): the defaults stay 48 h (client confirmation), 24 h (administrator review) and 48 h (routine document review). An agency may set
-- a SHORTER number for each, never a longer one; a stricter payer or regulatory rule is not modelled (owner rule needed). Every change is an append-only event with who, when,
-- why, and before/after. The deadlines only decide when an item moves to the urgent view; none of them approves, signs or bills anything.
--
-- Issue identity (decision 10): every actionable item has a stable key, "<kind>:<reason>:<entity id>", so two problems on one visit stay two issues and the same problem is
-- the same issue on Home, Scheduling and Action Needed. ogevia_api.list_action_issues is the one server list (decisions 1, 7, 9, 12): filters by queue, category, severity,
-- client, caregiver and service, ordered Critical, Urgent, Routine then deadline then key, paged, with counts that equal the lists. Ready for Approval, Pending
-- Confirmation, routine document review, pickups, reconciliation and amendment impacts are separate queues and are never added to the urgent total.
-- Issue state is DERIVED from the underlying records (a resolved problem simply stops appearing). The history (opened, severity changed, resolved, reopened) is recorded when the
-- list is read or the scheduled run runs, so the time of a transition is when it was OBSERVED, not necessarily the instant it happened. Nothing in this migration assigns, signs,
-- approves, bills or notifies anyone.
-- Rollback: BACKUP REQUIRED (the settings and issue history are dropped; the 0071 overview is restored).

create table ogevia.agency_attention_settings (
  organization_id uuid primary key references ogevia.organizations(id),
  confirmation_overdue_hours integer check (confirmation_overdue_hours between 1 and 48),
  review_overdue_hours integer check (review_overdue_hours between 1 and 24),
  document_review_overdue_hours integer check (document_review_overdue_hours between 1 and 48),
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now()
);
create table ogevia.agency_attention_setting_events (
  id bigserial primary key,
  organization_id uuid not null references ogevia.organizations(id),
  changed_by uuid not null references ogevia.app_users(id),
  changed_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  before_state jsonb not null,
  after_state jsonb not null
);
create index agency_attention_setting_events_org on ogevia.agency_attention_setting_events (organization_id, changed_at desc);
create trigger agency_attention_setting_events_no_update before update on ogevia.agency_attention_setting_events for each row execute function ogevia.forbid_update();
create trigger agency_attention_setting_events_no_delete before delete on ogevia.agency_attention_setting_events for each row execute function ogevia.forbid_delete();
alter table ogevia.agency_attention_settings enable row level security;
alter table ogevia.agency_attention_setting_events enable row level security;
create policy readonly_select on ogevia.agency_attention_settings for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.agency_attention_setting_events for select to ogevia_readonly using (true);
grant select on ogevia.agency_attention_settings, ogevia.agency_attention_setting_events to ogevia_readonly;

create function ogevia.attention_rule_hours(p_organization_id uuid, p_rule text)
returns integer
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(
    (select case p_rule when 'confirmation_overdue' then s.confirmation_overdue_hours when 'review_overdue' then s.review_overdue_hours
                        when 'document_review_overdue' then s.document_review_overdue_hours end
       from ogevia.agency_attention_settings s where s.organization_id = p_organization_id),
    ogevia.attention_rule_hours(p_rule));
$$;
revoke all on function ogevia.attention_rule_hours(uuid, text) from public;

create function ogevia_api.get_attention_settings(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'organization.update') or ogevia.has_permission(p_organization_id, 'visits.manage')) then
    raise exception 'You do not have permission to see these settings' using errcode = 'OGA03';
  end if;
  return jsonb_build_object(
    'confirmationOverdueHours', ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue'),
    'reviewOverdueHours', ogevia.attention_rule_hours(p_organization_id, 'review_overdue'),
    'documentReviewOverdueHours', ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue'),
    'defaults', jsonb_build_object('confirmationOverdueHours', ogevia.attention_rule_hours('confirmation_overdue'),
      'reviewOverdueHours', ogevia.attention_rule_hours('review_overdue'), 'documentReviewOverdueHours', ogevia.attention_rule_hours('document_review_overdue')),
    'history', coalesce((select jsonb_agg(jsonb_build_object('changedAt', e.changed_at, 'changedByName', u.display_name, 'reason', e.reason, 'before', e.before_state, 'after', e.after_state) order by e.changed_at desc, e.id desc)
                           from (select * from ogevia.agency_attention_setting_events x where x.organization_id = p_organization_id order by x.changed_at desc, x.id desc limit 20) e
                           left join ogevia.app_users u on u.id = e.changed_by), '[]'::jsonb));
end;
$$;

create function ogevia_api.set_attention_settings(p_organization_id uuid, p_confirmation_hours integer, p_review_hours integer, p_document_hours integer, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_before jsonb;
  v_after jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'You do not have permission to change these deadlines' using errcode = 'OGA03'; end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then raise exception 'Write the reason for the change (at least 10 characters)' using errcode = 'OGV22'; end if;
  if p_confirmation_hours is not null and (p_confirmation_hours < 1 or p_confirmation_hours > ogevia.attention_rule_hours('confirmation_overdue')) then
    raise exception 'A client-confirmation deadline can be shorter than % hours, never longer', ogevia.attention_rule_hours('confirmation_overdue') using errcode = 'OGV22';
  end if;
  if p_review_hours is not null and (p_review_hours < 1 or p_review_hours > ogevia.attention_rule_hours('review_overdue')) then
    raise exception 'An administrator-review deadline can be shorter than % hours, never longer', ogevia.attention_rule_hours('review_overdue') using errcode = 'OGV22';
  end if;
  if p_document_hours is not null and (p_document_hours < 1 or p_document_hours > ogevia.attention_rule_hours('document_review_overdue')) then
    raise exception 'A document-review deadline can be shorter than % hours, never longer', ogevia.attention_rule_hours('document_review_overdue') using errcode = 'OGV22';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('attention_settings:' || p_organization_id::text, 0));
  v_before := jsonb_build_object('confirmationOverdueHours', ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue'),
    'reviewOverdueHours', ogevia.attention_rule_hours(p_organization_id, 'review_overdue'), 'documentReviewOverdueHours', ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue'));
  insert into ogevia.agency_attention_settings (organization_id, confirmation_overdue_hours, review_overdue_hours, document_review_overdue_hours, updated_by, updated_at)
  values (p_organization_id, p_confirmation_hours, p_review_hours, p_document_hours, v_actor, now())
  on conflict (organization_id) do update set confirmation_overdue_hours = excluded.confirmation_overdue_hours, review_overdue_hours = excluded.review_overdue_hours,
    document_review_overdue_hours = excluded.document_review_overdue_hours, updated_by = v_actor, updated_at = now();
  v_after := jsonb_build_object('confirmationOverdueHours', ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue'),
    'reviewOverdueHours', ogevia.attention_rule_hours(p_organization_id, 'review_overdue'), 'documentReviewOverdueHours', ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue'));
  insert into ogevia.agency_attention_setting_events (organization_id, changed_by, reason, before_state, after_state) values (p_organization_id, v_actor, btrim(p_reason), v_before, v_after);
  perform ogevia.write_audit(p_organization_id, 'attention.deadlines_changed', 'agency_attention_settings', p_organization_id, v_before, v_after, btrim(p_reason));
  return v_after;
end;
$$;
revoke all on function ogevia_api.get_attention_settings(uuid) from public;
revoke all on function ogevia_api.set_attention_settings(uuid, integer, integer, integer, text) from public;
grant execute on function ogevia_api.get_attention_settings(uuid) to ogevia_app;
grant execute on function ogevia_api.set_attention_settings(uuid, integer, integer, integer, text) to ogevia_app;

-- the overview now reads the agency's deadlines
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
  v_authrev integer := 0;
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
              and (x.latest_uploaded_at <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue'))
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
         and v.time_out > now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue'))
      union all
      select v.id, 'confirmation_overdue', v.time_out from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
         and v.time_out <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue'))
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
             'reviewOverdue', count(distinct u.id) filter (where u.kind in ('needs_review', 'late_response') and u.at <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue'))),
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

  -- 0071: unapproved Billing Ready visits sent back to review because an authorization was lowered
  if v_review is not null then
    select count(*)::int into v_authrev from ogevia.visit_authorization_reviews h
    join ogevia.service_visits sv on sv.id = h.visit_id and sv.status in ('signed', 'administrator_review')
    where h.organization_id = p_organization_id and h.resolved_at is null;
    v_review := v_review || jsonb_build_object('authorizationReview', v_authrev);
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
revoke all on function ogevia_api.get_attention_overview(uuid, integer) from public;
grant execute on function ogevia_api.get_attention_overview(uuid, integer) to ogevia_app;

-- ISSUE IDENTITY AND THE ONE LIST ---------------------------------------------------------------------------------------------------------------------------------
create table ogevia.action_issue_state (
  organization_id uuid not null references ogevia.organizations(id),
  issue_key text not null check (length(issue_key) between 10 and 200),
  kind text not null,
  reason text not null,
  queue text not null,
  category text not null,
  entity_id uuid not null,
  client_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null check (status in ('open', 'resolved')),
  resolved_at timestamptz,
  reopen_count integer not null default 0,
  last_severity text not null check (last_severity in ('critical', 'urgent', 'routine')),
  primary key (organization_id, issue_key)
);
create table ogevia.action_issue_events (
  id bigserial primary key,
  organization_id uuid not null references ogevia.organizations(id),
  issue_key text not null,
  event text not null check (event in ('opened', 'severity_changed', 'resolved', 'reopened')),
  severity text check (severity in ('critical', 'urgent', 'routine')),
  occurred_at timestamptz not null default now(),
  observed_by uuid references ogevia.app_users(id)
);
create index action_issue_events_key on ogevia.action_issue_events (organization_id, issue_key, id);
create trigger action_issue_events_no_update before update on ogevia.action_issue_events for each row execute function ogevia.forbid_update();
create trigger action_issue_events_no_delete before delete on ogevia.action_issue_events for each row execute function ogevia.forbid_delete();
alter table ogevia.action_issue_state enable row level security;
alter table ogevia.action_issue_events enable row level security;
create policy readonly_select on ogevia.action_issue_state for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.action_issue_events for select to ogevia_readonly using (true);
grant select on ogevia.action_issue_state, ogevia.action_issue_events to ogevia_readonly;

-- The computed set. The inclusion rules mirror get_attention_overview (the tests compare the two). The caller passes what the actor may see.
create function ogevia.action_issue_rows(p_organization_id uuid, p_can_cover boolean, p_can_visits boolean, p_can_docs boolean, p_can_comp boolean, p_can_bill boolean, p_urgent_hours integer default 48)
returns table (issue_key text, kind text, reason text, queue text, category text, severity text, deadline timestamptz, since timestamptz,
               client_id uuid, caregiver_record_id uuid, service_id uuid, shift_id uuid, visit_id uuid, entity_id uuid)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_win interval := make_interval(hours => p_urgent_hours);
begin
  return query
  with raw as (
    -- uncovered shifts: now / inside the window / beyond it
    select 'shift'::text k, case when ogevia.shift_is_called_out(sh.id) then 'uncovered_called_out' else 'uncovered_open' end r,
           case when sh.starts_at > now() + v_win then 'upcoming_staffing' else 'needs_attention_now' end q, 'coverage'::text cat,
           case when sh.starts_at > now() + v_win then 'routine' else ogevia.attention_shift_tier(sh.starts_at, now()) end sev,
           sh.starts_at dl, sh.starts_at sn, sh.client_id cl, null::uuid cg, sh.service_id sv, sh.id sf, null::uuid vs, sh.id en
    from ogevia.shifts sh
    where p_can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.ends_at > now()
      and ogevia.shift_coverage_state(sh) = 'needs_coverage'
    union all
    -- shifts whose caregiver is blocked (compliance hold or a required document)
    select 'shift', case f.kind when 'compliance' then 'compliance_hold' else 'documents_not_current' end,
           case when sh.starts_at > now() + v_win then 'upcoming_staffing' else 'needs_attention_now' end, 'compliance',
           case when sh.starts_at > now() + v_win then 'routine' else ogevia.attention_shift_tier(sh.starts_at, now()) end,
           sh.starts_at, sh.starts_at, sh.client_id, f.caregiver_record_id, sh.service_id, sh.id, null::uuid, sh.id
    from ogevia.shift_readiness_flags f join ogevia.shifts sh on sh.id = f.shift_id
    where (p_can_comp or p_can_cover) and f.organization_id = p_organization_id and f.kind in ('compliance', 'document') and f.resolved_at is null
      and sh.status = 'scheduled' and sh.ends_at > now() and not ogevia.shift_is_called_out(sh.id)
    union all
    select 'visit', 'missing_clock_out', 'needs_attention_now', 'visits', 'urgent', coalesce(s.ends_at, v.time_in + interval '12 hours'), v.time_in, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v left join ogevia.shifts s on s.id = v.scheduled_shift_id
    where p_can_visits and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
      and ((s.id is not null and s.ends_at < now()) or (s.id is null and v.time_in <= now() - interval '12 hours'))
    union all
    select 'visit', 'in_progress_on_hold', 'needs_attention_now', 'compliance', 'critical', v.time_in, v.time_in, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v
    join ogevia.caregiver_records cr on cr.organization_id = v.organization_id and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id))
    where (p_can_comp or p_can_visits) and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null and ogevia.caregiver_blocked_now(v.organization_id, cr.id)
    union all
    -- visit review stream
    select 'visit', 'pending_confirmation', 'visit_review', 'visits', 'routine', v.time_out + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue')), v.time_out, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
      and v.time_out > now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue'))
    union all
    select 'visit', 'confirmation_overdue', 'visit_review', 'visits', 'urgent', v.time_out + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue')), v.time_out, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
      and v.time_out <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue'))
    union all
    select 'visit', 'needs_review', 'visit_review', 'visits',
           case when ogevia.visit_review_entered_at(v.id) <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')) then 'urgent' else 'routine' end,
           ogevia.visit_review_entered_at(v.id) + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')), ogevia.visit_review_entered_at(v.id), v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'administrator_review'
      and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null) and ogevia.visit_recovery_state(v.id) is null
    union all
    select 'visit', 'late_response', 'visit_review', 'visits',
           case when ogevia.visit_late_response_at(v.id) <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')) then 'urgent' else 'routine' end,
           ogevia.visit_late_response_at(v.id) + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')), ogevia.visit_late_response_at(v.id), v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'administrator_review' and ogevia.visit_recovery_state(v.id) = 'response_to_review'
    union all
    select 'visit', 'ready_for_approval', 'ready_for_approval', 'visits', 'routine', null::timestamptz, v.signed_at, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_bill and v.organization_id = p_organization_id and v.status in ('signed', 'administrator_review') and ogevia.visit_billing_state(v.id) in ('ready_for_review', 'voided')
    union all
    select 'visit', 'authorization_decreased', 'visit_review', 'authorization', 'routine', null::timestamptz, h.created_at, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.visit_authorization_reviews h join ogevia.service_visits v on v.id = h.visit_id and v.status in ('signed', 'administrator_review')
    where p_can_visits and h.organization_id = p_organization_id and h.resolved_at is null
    union all
    -- pickup requests, reconciliation, amendment impacts
    select 'pickup_request', 'pending_pickup', 'pickup_requests', 'staffing', 'routine', null::timestamptz, r.requested_at, sh.client_id, null::uuid, sh.service_id, sh.id, null::uuid, r.id
    from ogevia.shift_pickup_requests r join ogevia.shifts sh on sh.id = r.shift_id
    where p_can_cover and r.organization_id = p_organization_id and r.status = 'pending' and sh.status = 'scheduled' and sh.ends_at > now()
    union all
    select 'shift', 'reconcile_' || ogevia.reservation_bucket(r.id)::text, 'reconciliation', 'authorization', 'routine', null::timestamptz, sh.ends_at, sh.client_id, null::uuid, sh.service_id, sh.id, null::uuid, sh.id
    from ogevia.authorization_reservations r join ogevia.shifts sh on sh.id = r.shift_id
    where p_can_cover and r.organization_id = p_organization_id and r.released_at is null and ogevia.reservation_bucket(r.id) in ('unreconciled', 'awaiting_record')
    union all
    select 'impact', i.impact_kind::text, 'authorization_changes', 'authorization', 'routine', null::timestamptz, i.created_at,
           coalesce(sh.client_id, v.client_id), null::uuid, coalesce(sh.service_id, v.service_id), i.shift_id, i.visit_id, i.id
    from ogevia.authorization_amendment_impacts i
    left join ogevia.shifts sh on sh.id = i.shift_id left join ogevia.service_visits v on v.id = i.visit_id
    where p_can_cover and i.organization_id = p_organization_id
      and not exists (select 1 from ogevia.authorization_amendment_impact_acks k where k.impact_id = i.id)
      and case when i.shift_id is not null then ogevia.reservation_bucket(i.reservation_id) is not null
               else exists (select 1 from ogevia.service_visits v2 where v2.id = i.visit_id and v2.status in ('signed', 'administrator_review')) end
  ), docs as (
    select d.document_id, d.caregiver_record_id, d.display_status, d.latest_uploaded_at, d.due_on, d.expires_on, d.currency_status
    from ogevia_api.list_staff_documents(p_organization_id, null) d where p_can_docs
  )
  select ('' || x.k || ':' || x.r || ':' || x.en::text)::text, x.k, x.r, x.q, x.cat, x.sev, x.dl, x.sn, x.cl, x.cg, x.sv, x.sf, x.vs, x.en
  from raw x
  union all
  select 'document:' || (case when d.display_status in ('expired', 'overdue') then d.display_status
                               when d.display_status = 'awaiting_review' then (case when esc.escalated then 'review_overdue' else 'awaiting_review' end)
                               when d.display_status = 'expiring' then 'expiring' else 'rejected' end) || ':' || d.document_id::text,
         'document', case when d.display_status in ('expired', 'overdue') then d.display_status
                          when d.display_status = 'awaiting_review' then (case when esc.escalated then 'review_overdue' else 'awaiting_review' end)
                          when d.display_status = 'expiring' then 'expiring' else 'rejected' end,
         'documents_compliance', 'documents',
         case when d.display_status in ('expired', 'overdue') or (d.display_status = 'awaiting_review' and esc.escalated) then 'urgent' else 'routine' end,
         case when d.display_status = 'awaiting_review' then d.latest_uploaded_at + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue'))
              else coalesce(d.expires_on::timestamptz, d.due_on::timestamptz) end,
         coalesce(d.latest_uploaded_at, now()), null::uuid, d.caregiver_record_id, null::uuid, null::uuid, null::uuid, d.document_id
  from docs d
  cross join lateral (select (d.display_status = 'awaiting_review'
              and (d.latest_uploaded_at <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue'))
                   or d.currency_status = 'expired'
                   or exists (select 1 from ogevia.shift_readiness_flags f join ogevia.shifts sh on sh.id = f.shift_id
                               where f.organization_id = p_organization_id and f.caregiver_record_id = d.caregiver_record_id and f.kind = 'document' and f.resolved_at is null
                                 and sh.status = 'scheduled' and sh.ends_at > now() and not ogevia.shift_is_called_out(sh.id)))) as escalated) esc
  where d.display_status in ('expired', 'overdue', 'expiring', 'awaiting_review', 'rejected')
  union all
  select 'caregiver:compliance_hold:' || h.caregiver_record_id::text, 'caregiver', 'compliance_hold', 'documents_compliance', 'compliance', 'routine', null::timestamptz, h.opened_at,
         null::uuid, h.caregiver_record_id, null::uuid, null::uuid, null::uuid, h.caregiver_record_id
  from ogevia.caregiver_compliance_holds h where p_can_comp and h.organization_id = p_organization_id and h.released_at is null;
end;
$$;
revoke all on function ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer) from public;

create function ogevia_api.list_action_issues(
  p_organization_id uuid, p_queue text default null, p_category text default null, p_severity text default null,
  p_client_id uuid default null, p_caregiver_record_id uuid default null, p_service_id uuid default null,
  p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_can_cover boolean; v_can_visits boolean; v_can_docs boolean; v_can_comp boolean; v_can_bill boolean;
  v_counts jsonb;
  v_items jsonb;
  v_total integer;
  v_tmp bigint;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  v_can_visits := ogevia.has_permission(p_organization_id, 'visits.read');
  v_can_cover := ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage');
  v_can_docs := ogevia.has_permission(p_organization_id, 'documents.read');
  v_can_comp := ogevia.has_permission(p_organization_id, 'readiness.read');
  v_can_bill := ogevia.has_permission(p_organization_id, 'billing.visits.read');
  if not (v_can_visits or v_can_cover or v_can_docs or v_can_comp) then raise exception 'You do not have permission to see attention items' using errcode = 'OGA03'; end if;
  if p_queue is not null and p_queue not in ('needs_attention_now', 'upcoming_staffing', 'documents_compliance', 'visit_review', 'ready_for_approval', 'pickup_requests', 'reconciliation', 'authorization_changes') then
    raise exception 'Unknown queue' using errcode = 'OGV22'; end if;
  if p_category is not null and p_category not in ('coverage', 'visits', 'documents', 'compliance', 'authorization', 'staffing') then raise exception 'Unknown category' using errcode = 'OGV22'; end if;
  if p_severity is not null and p_severity not in ('critical', 'urgent', 'routine') then raise exception 'Unknown severity' using errcode = 'OGV22'; end if;
  p_limit := greatest(1, least(coalesce(p_limit, 50), 200));
  p_offset := greatest(0, coalesce(p_offset, 0));
  perform pg_advisory_xact_lock(hashtextextended('action_issues:' || p_organization_id::text, 0));

  -- record transitions as OBSERVED now (opened, severity changed, resolved, reopened); the list below is the same snapshot
  with cur as (select * from ogevia.action_issue_rows(p_organization_id, v_can_cover, v_can_visits, v_can_docs, v_can_comp, v_can_bill)),
  prior as (select s.issue_key, s.status, s.last_severity from ogevia.action_issue_state s where s.organization_id = p_organization_id),
  ev as (
    insert into ogevia.action_issue_events (organization_id, issue_key, event, severity, observed_by)
    select p_organization_id, c.issue_key,
           case when pr.issue_key is null then 'opened' when pr.status = 'resolved' then 'reopened' else 'severity_changed' end, c.severity, v_actor
    from cur c left join prior pr on pr.issue_key = c.issue_key
    where pr.issue_key is null or pr.status = 'resolved' or pr.last_severity <> c.severity
    returning 1
  ), up as (
    insert into ogevia.action_issue_state (organization_id, issue_key, kind, reason, queue, category, entity_id, client_id, status, last_severity)
    select p_organization_id, c.issue_key, c.kind, c.reason, c.queue, c.category, c.entity_id, c.client_id, 'open', c.severity from cur c
    on conflict (organization_id, issue_key) do update
      set last_seen_at = now(), last_severity = excluded.last_severity, status = 'open', resolved_at = null, client_id = excluded.client_id,
          reopen_count = ogevia.action_issue_state.reopen_count + case when ogevia.action_issue_state.status = 'resolved' then 1 else 0 end
    returning 1
  )
  select count(*) into v_tmp from ev, up;
  -- anything this actor's view no longer contains is resolved only if the actor could see its whole queue; to keep one rule, resolution is recorded for the issues the
  -- actor's permissions cover (a person with fewer permissions never closes an issue that only another role can see)
  with cur as (select issue_key from ogevia.action_issue_rows(p_organization_id, v_can_cover, v_can_visits, v_can_docs, v_can_comp, v_can_bill)),
  gone as (
    update ogevia.action_issue_state s set status = 'resolved', resolved_at = now()
    where s.organization_id = p_organization_id and s.status = 'open' and not exists (select 1 from cur c where c.issue_key = s.issue_key)
      and case s.queue
            when 'needs_attention_now' then (v_can_cover or v_can_visits or v_can_comp) when 'upcoming_staffing' then (v_can_cover or v_can_comp)
            when 'documents_compliance' then (v_can_docs and v_can_comp) when 'visit_review' then v_can_visits when 'ready_for_approval' then v_can_bill
            else v_can_cover end
    returning s.issue_key, s.last_severity)
  insert into ogevia.action_issue_events (organization_id, issue_key, event, severity, observed_by)
  select p_organization_id, g.issue_key, 'resolved', g.last_severity, v_actor from gone g;

  with cur as (select * from ogevia.action_issue_rows(p_organization_id, v_can_cover, v_can_visits, v_can_docs, v_can_comp, v_can_bill)),
  f as (select * from cur c where (p_queue is null or c.queue = p_queue) and (p_category is null or c.category = p_category) and (p_severity is null or c.severity = p_severity)
          and (p_client_id is null or c.client_id = p_client_id) and (p_caregiver_record_id is null or c.caregiver_record_id = p_caregiver_record_id) and (p_service_id is null or c.service_id = p_service_id))
  select (select count(*) from f),
         (select jsonb_build_object(
            'total', count(*), 'critical', count(*) filter (where c.severity = 'critical'), 'urgent', count(*) filter (where c.severity = 'urgent'), 'routine', count(*) filter (where c.severity = 'routine'),
            'actionNeeded', count(*) filter (where c.severity in ('critical', 'urgent') and c.queue in ('needs_attention_now', 'documents_compliance', 'visit_review')),
            'byQueue', coalesce((select jsonb_object_agg(q.queue, q.n) from (select c2.queue, count(*) n from cur c2 group by c2.queue) q), '{}'::jsonb))
          from cur c)
    into v_total, v_counts;
  select coalesce(jsonb_agg(jsonb_build_object(
           'issueKey', t.issue_key, 'kind', t.kind, 'reason', t.reason, 'queue', t.queue, 'category', t.category, 'severity', t.severity,
           'deadline', t.deadline, 'since', t.since, 'shiftId', t.shift_id, 'visitId', t.visit_id, 'entityId', t.entity_id, 'caregiverRecordId', t.caregiver_record_id,
           'clientId', t.client_id, 'serviceId', t.service_id,
           'clientCode', (select cl.client_code from ogevia.clients cl where cl.id = t.client_id),
           'caregiverCode', (select cr.caregiver_code from ogevia.caregiver_records cr where cr.id = t.caregiver_record_id),
           'serviceCode', (select s2.code from ogevia.services s2 where s2.id = t.service_id),
           'status', 'open',
           'firstSeenAt', (select st.first_seen_at from ogevia.action_issue_state st where st.organization_id = p_organization_id and st.issue_key = t.issue_key),
           'reopenCount', (select st.reopen_count from ogevia.action_issue_state st where st.organization_id = p_organization_id and st.issue_key = t.issue_key),
           'action', case t.reason
              when 'uncovered_open' then 'assign_caregiver' when 'uncovered_called_out' then 'assign_caregiver' when 'compliance_hold' then 'review_hold' when 'documents_not_current' then 'review_documents'
              when 'missing_clock_out' then 'review_visit' when 'in_progress_on_hold' then 'arrange_coverage' when 'pending_confirmation' then 'wait_or_resend' when 'confirmation_overdue' then 'follow_up_confirmation'
              when 'needs_review' then 'review_visit' when 'late_response' then 'review_visit' when 'ready_for_approval' then 'approve_billing' when 'authorization_decreased' then 'review_authorization'
              when 'pending_pickup' then 'confirm_pickup' when 'expired' then 'renew_document' when 'overdue' then 'renew_document' when 'review_overdue' then 'review_document'
              when 'awaiting_review' then 'review_document' when 'expiring' then 'request_renewal' when 'rejected' then 'follow_up_document'
              when 'reconcile_unreconciled' then 'reconcile_shift' when 'reconcile_awaiting_record' then 'reconcile_shift' else 'review_authorization_change' end,
           'recommendedAction', case t.reason
              when 'uncovered_open' then 'Choose an eligible caregiver and confirm the assignment.' when 'uncovered_called_out' then 'The caregiver called out: choose a replacement and confirm.'
              when 'compliance_hold' then 'The assigned caregiver is on a compliance hold: review the hold or choose another caregiver.' when 'documents_not_current' then 'A required document is not current: review it or choose another caregiver.'
              when 'missing_clock_out' then 'The visit is still open: find out the real end time and correct the visit.' when 'in_progress_on_hold' then 'The caregiver on this visit is on a hold: arrange safe coverage. Nothing is ended for you.'
              when 'pending_confirmation' then 'Waiting for the client or representative. It moves up if no answer comes in time.' when 'confirmation_overdue' then 'No confirmation yet: contact the client or representative, or record why it cannot be obtained.'
              when 'needs_review' then 'Review the visit and record a decision.' when 'late_response' then 'A late response arrived: review it and decide.' when 'ready_for_approval' then 'Approve the billable minutes, or send it back.'
              when 'authorization_decreased' then 'The authorization was lowered after this visit: confirm it is still billable, or correct it.' when 'pending_pickup' then 'A caregiver asked for this shift: confirm or decline.'
              when 'expired' then 'The document is expired: get a current one.' when 'overdue' then 'The document is overdue: get it.' when 'review_overdue' then 'This upload has waited too long: approve or reject it.'
              when 'awaiting_review' then 'Review the upload.' when 'expiring' then 'Expires soon: ask for a renewal.' when 'rejected' then 'Rejected: make sure the caregiver knows what to fix.'
              when 'reconcile_unreconciled' then 'The shift ended with no visit record: decide what happened. Nothing is released automatically.' when 'reconcile_awaiting_record' then 'Still awaiting a decision about this ended shift.'
              else 'An authorization change affected this record: review it and acknowledge.' end)
         order by case t.severity when 'critical' then 0 when 'urgent' then 1 else 2 end, t.deadline nulls last, t.issue_key), '[]'::jsonb)
    into v_items
  from (select c.* from ogevia.action_issue_rows(p_organization_id, v_can_cover, v_can_visits, v_can_docs, v_can_comp, v_can_bill) c
         where (p_queue is null or c.queue = p_queue) and (p_category is null or c.category = p_category) and (p_severity is null or c.severity = p_severity)
           and (p_client_id is null or c.client_id = p_client_id) and (p_caregiver_record_id is null or c.caregiver_record_id = p_caregiver_record_id) and (p_service_id is null or c.service_id = p_service_id)
         order by case c.severity when 'critical' then 0 when 'urgent' then 1 else 2 end, c.deadline nulls last, c.issue_key
         limit p_limit offset p_offset) t;
  return jsonb_build_object('asOf', now(), 'matching', v_total, 'limit', p_limit, 'offset', p_offset, 'counts', v_counts, 'issues', v_items);
end;
$$;

create function ogevia_api.get_action_issue_history(p_organization_id uuid, p_issue_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'visits.read') or ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage')
          or ogevia.has_permission(p_organization_id, 'documents.read') or ogevia.has_permission(p_organization_id, 'readiness.read')) then
    raise exception 'You do not have permission to see attention items' using errcode = 'OGA03';
  end if;
  return jsonb_build_object('issueKey', p_issue_key,
    'state', (select jsonb_build_object('status', s.status, 'firstSeenAt', s.first_seen_at, 'lastSeenAt', s.last_seen_at, 'resolvedAt', s.resolved_at, 'reopenCount', s.reopen_count)
                from ogevia.action_issue_state s where s.organization_id = p_organization_id and s.issue_key = p_issue_key),
    'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'severity', e.severity, 'occurredAt', e.occurred_at, 'observedByName', u.display_name) order by e.id)
                          from ogevia.action_issue_events e left join ogevia.app_users u on u.id = e.observed_by
                         where e.organization_id = p_organization_id and e.issue_key = p_issue_key), '[]'::jsonb));
end;
$$;
revoke all on function ogevia_api.list_action_issues(uuid, text, text, text, uuid, uuid, uuid, integer, integer) from public;
revoke all on function ogevia_api.get_action_issue_history(uuid, text) from public;
grant execute on function ogevia_api.list_action_issues(uuid, text, text, text, uuid, uuid, uuid, integer, integer) to ogevia_app;
grant execute on function ogevia_api.get_action_issue_history(uuid, text) to ogevia_app;
