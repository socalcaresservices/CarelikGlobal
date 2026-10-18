-- ROLLBACK 0077 | CLASS: BACKUP REQUIRED (drops the in-app notification history and the agency notification setting). Restores the 0062 attention summary.
drop function ogevia_api.set_notification_settings(uuid, boolean, text);
drop function ogevia_api.get_notification_settings(uuid);
drop function ogevia_api.mark_notifications_read(uuid, uuid[]);
drop function ogevia_api.list_my_notifications(uuid, boolean, integer);
drop trigger issue_notifications_guard on ogevia.issue_notifications;
drop function ogevia.issue_notifications_guard();
drop table ogevia.issue_notifications;
drop table ogevia.agency_notification_settings;
create or replace function ogevia_api.get_attention_summary(
  p_organization_id uuid,
  p_unscheduled_open_hours integer default 12,
  p_unconfirmed_minutes integer default 60
)
returns table (
  missing_time_out integer,
  not_confirmed integer,
  needs_review integer,
  billing_ready_unapproved integer,
  total integer,
  uncovered_shifts integer,
  documents_blocking integer,
  documents_to_review integer,
  documents_expiring integer,
  awaiting_signature integer,
  late_responses_to_review integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id)
             and ogevia.has_permission(p_organization_id, 'visits.read') as can_read,
           ogevia.has_permission(p_organization_id, 'billing.visits.read') as can_bill,
           ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage') as can_cover,
           ogevia.has_permission(p_organization_id, 'documents.read') as can_docs
  ), c as (
    select
      count(*) filter (
        where v.status = 'draft' and v.time_out is null
          and ((s.id is not null and s.ends_at < now())
               or (s.id is null and v.time_in <= now() - make_interval(hours => p_unscheduled_open_hours)))
      )::integer as missing_time_out,
      count(*) filter (
        where v.status = 'awaiting_signature' and v.time_out is not null
          and v.time_out <= now() - make_interval(mins => p_unconfirmed_minutes)
      )::integer as not_confirmed,
      -- 0036: a visit waiting for a late confirmation is a reminder, not an action;
      -- a received response is its own action item.
      count(*) filter (
        where v.status = 'administrator_review'
          and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
          and ogevia.visit_recovery_state(v.id) is null
      )::integer as needs_review,
      count(*) filter (
        where v.status = 'administrator_review'
          and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
          and ogevia.visit_recovery_state(v.id) = 'awaiting_response'
      )::integer as awaiting_signature,
      count(*) filter (
        where v.status = 'administrator_review'
          and ogevia.visit_recovery_state(v.id) = 'response_to_review'
      )::integer as late_responses,
      count(*) filter (
        where ogevia.visit_billing_state(v.id) in ('ready_for_review', 'voided')
      )::integer as ready_unapproved
    from ogevia.service_visits v
    left join ogevia.shifts s on s.id = v.scheduled_shift_id
    where v.organization_id = p_organization_id
      and v.status in ('draft', 'awaiting_signature', 'administrator_review', 'signed')
  ), cov as (
    -- Upcoming shifts with nobody to work them (open, or called out and not replaced).
    select count(*)::integer as uncovered
    from ctx, ogevia.shifts sh
    where ctx.can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled'
      and sh.ends_at > now() and ogevia.shift_coverage_state(sh) = 'needs_coverage'
  ), docs as (
    select a.* from ctx, ogevia_api.get_document_alerts(p_organization_id) a where ctx.can_docs
  )
  select c.missing_time_out, c.not_confirmed, c.needs_review,
         case when ctx.can_bill then c.ready_unapproved end,
         c.missing_time_out + c.not_confirmed + c.needs_review + c.late_responses
           + case when ctx.can_cover then cov.uncovered else 0 end
           + coalesce((select d.expired + d.overdue + d.awaiting_review from docs d), 0),
         case when ctx.can_cover then cov.uncovered end,
         (select d.expired + d.overdue from docs d),
         (select d.awaiting_review from docs d),
         (select d.expiring from docs d),
         c.awaiting_signature,
         c.late_responses
  from ctx, c, cov
  where ctx.actor is not null and ctx.can_read;
$$;
