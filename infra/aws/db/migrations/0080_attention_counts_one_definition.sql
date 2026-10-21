-- 0080 One definition for each attention count, computed from the same rows as the issue list (owner directive 2026-10-18, items 2.4 and 2.5).
--
-- WHAT THIS ADDS (functions only; no table, column or stored value changes):
--   1. ogevia.shift_attention_class(starts_at, now): the ONE written rule for an unfilled or compliance-blocked shift.
--        starts more than 48 hours after now  -> 'upcoming'  (Upcoming staffing; never urgent)
--        starts 48 hours or less after now    -> 'urgent'    (exactly 48 hours away is Urgent)
--        starts at or before now              -> 'critical'  (exactly at the start is Critical)
--      0059/0073 already apply this rule inline (starts_at <= now() + 48 h; ogevia.attention_shift_tier). The tests compare this function with every place that applies it
--      (the issue list, the overview, the summary and the new counts) at 48 h minus/at/plus a microsecond and at the start minus/at/plus a microsecond, so the rule cannot drift.
--   2. ogevia_api.get_attention_counts(org): the six counts the screens show, each from ogevia.action_issue_rows (the rows behind list_action_issues), so a count equals the list
--      opened under the same agency, permissions and time BY CONSTRUCTION. The web shows these numbers; it does not recompute them. Definitions: docs/releases/2026-10-19-review-updates/COUNT_DEFINITIONS.md.
--        needsAttention  distinct shifts and visits in the Needs attention now queue (the header badge; equals get_attention_overview.urgent.itemCount)
--        needsAction     Critical and Urgent issues in Needs attention now, Documents & compliance and Visit review (the Action needed number; equals list_action_issues counts.actionNeeded)
--        scheduling      distinct shifts in Needs attention now that are unfilled or whose caregiver is blocked (starting within 48 hours or already started)
--        caregivers      Urgent STAFF document issues (expired, overdue, review overdue); routine document review, holds and client documents are not counted
--        approvals       exception review ONLY: missing clock-out, confirmation overdue, administrator review, late response. Ready for Approval is returned apart as readyForApproval.
--      Each entry also carries how many of its items are Critical, so a badge is red only when the server says Critical (a red status is not automatically Critical).
--      A count the viewer may not see is null (never a false zero).
--   Notifications are not here: the unread number belongs to list_my_notifications (0077), which brings the person's notifications up to date; this function is read-only.
--
-- ADMINISTRATOR-REVIEW CLOCK: no new column. Lifecycle evidence is sufficient and valid (0059): service_visits.signed_at is written in the same statement that gives a visit the
-- status administrator_review (confirmation, manager correction, outage record), so ogevia.visit_review_entered_at(visit) is the actual entry event, the latest of: that entry,
-- a revoked review decision, a lapsed or revoked confirmation request, a decided late-confirmation review. Creation time is never used. A correction creates a NEW visit whose own
-- entry starts a new 24 h clock; a revoked decision restarts it at the revocation. HISTORICAL TIMING IS NOT RECONSTRUCTED: where a record's entry time cannot be established the
-- function returns null, the item is counted and shown but never escalated, and no time is invented.
--
-- Nothing here assigns, signs, approves, bills or notifies anyone.
-- Rollback: SAFE AUTOMATED (drops the two functions).

create function ogevia.shift_attention_class(p_starts timestamptz, p_now timestamptz default now())
returns text
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select case
    when p_starts is null or p_now is null then null
    when p_starts <= p_now then 'critical'
    when p_starts <= p_now + interval '48 hours' then 'urgent'
    else 'upcoming'
  end;
$$;
revoke all on function ogevia.shift_attention_class(timestamptz, timestamptz) from public;

create function ogevia_api.get_attention_counts(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_can_visits boolean;
  v_can_cover boolean;
  v_can_docs boolean;
  v_can_comp boolean;
  v_can_bill boolean;
  v_r jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  v_can_visits := ogevia.has_permission(p_organization_id, 'visits.read');
  v_can_cover := ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage');
  v_can_docs := ogevia.has_permission(p_organization_id, 'documents.read');
  v_can_comp := ogevia.has_permission(p_organization_id, 'readiness.read');
  v_can_bill := ogevia.has_permission(p_organization_id, 'billing.visits.read');
  if not (v_can_visits or v_can_cover or v_can_docs or v_can_comp) then
    return null; -- nothing here is visible to this person: not a zero
  end if;

  with cur as (select * from ogevia.action_issue_rows(p_organization_id, v_can_cover, v_can_visits, v_can_docs, v_can_comp, v_can_bill)),
  now_items as (select distinct coalesce(c.shift_id, c.visit_id) as item, c.severity from cur c where c.queue = 'needs_attention_now'),
  sched as (select distinct c.shift_id, c.severity from cur c where c.queue = 'needs_attention_now' and c.kind = 'shift'),
  acted as (select c.severity from cur c where c.severity in ('critical', 'urgent') and c.queue in ('needs_attention_now', 'documents_compliance', 'visit_review')),
  docs as (select c.severity from cur c where c.queue = 'documents_compliance' and c.kind = 'document' and c.severity in ('critical', 'urgent')),
  exc as (select c.severity from cur c where c.kind = 'visit' and c.reason in ('missing_clock_out', 'confirmation_overdue', 'needs_review', 'late_response'))
  select jsonb_build_object(
    'asOf', now(),
    'needsAttention', case when v_can_cover or v_can_visits or v_can_comp then
        jsonb_build_object('count', (select count(distinct item) from now_items),
                           'critical', (select count(distinct item) from now_items where item in (select item from now_items where severity = 'critical'))) end,
    'needsAction', jsonb_build_object('count', (select count(*) from acted), 'critical', (select count(*) from acted where severity = 'critical')),
    'scheduling', case when v_can_cover then
        jsonb_build_object('count', (select count(distinct shift_id) from sched),
                           'critical', (select count(distinct shift_id) from sched where shift_id in (select shift_id from sched where severity = 'critical'))) end,
    'caregivers', case when v_can_docs then
        jsonb_build_object('count', (select count(*) from docs), 'critical', (select count(*) from docs where severity = 'critical')) end,
    'approvals', jsonb_build_object(
        'exceptions', case when v_can_visits then jsonb_build_object('count', (select count(*) from exc), 'critical', (select count(*) from exc where severity = 'critical')) end,
        'readyForApproval', case when v_can_bill then (select count(*) from cur c where c.reason = 'ready_for_approval') end))
    into v_r;
  return v_r;
end;
$$;
revoke all on function ogevia_api.get_attention_counts(uuid) from public;
grant execute on function ogevia_api.get_attention_counts(uuid) to ogevia_app;
