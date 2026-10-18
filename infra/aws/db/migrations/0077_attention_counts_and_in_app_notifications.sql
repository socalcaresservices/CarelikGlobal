-- 0077 | Sidebar and Action-needed counts agree with the issue list; approved in-app notifications (Board 4 decision 11, in-app part only)
--
-- 1. get_attention_summary: (a) total now includes Ready for approval for people who may see billing, so the server total equals the sum the web displays (was F2);
--    (b) unfilled shifts count only when they start within 48 hours or are under way, matching the Needs attention now queue (was F4).
-- 2. In-app notifications. Critical issues always notify the staff member who can see them; Urgent issues notify according to the agency setting (default on); Routine
--    issues never notify. One notification per person, issue and severity step (and per reopening), so an unchanged issue never repeats. A notification stops being
--    pending when the issue is no longer in that person's list. Rows are never deleted. Content carries the random client code, never a name. No outbound channel
--    (email/SMS/push) exists: those need a channel and PHI decision that has not been made.

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
    -- 0077: only shifts that start within 48 hours (or are under way) with nobody to work them count as Action needed; later ones are Upcoming staffing, as in the issue list.
    select count(*)::integer as uncovered
    from ctx, ogevia.shifts sh
    where ctx.can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled'
      and sh.ends_at > now() and sh.starts_at <= now() + interval '48 hours' and ogevia.shift_coverage_state(sh) = 'needs_coverage'
  ), docs as (
    select a.* from ctx, ogevia_api.get_document_alerts(p_organization_id) a where ctx.can_docs
  )
  select c.missing_time_out, c.not_confirmed, c.needs_review,
         case when ctx.can_bill then c.ready_unapproved end,
         c.missing_time_out + c.not_confirmed + c.needs_review + c.late_responses
           + case when ctx.can_bill then c.ready_unapproved else 0 end
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

create table ogevia.agency_notification_settings (
  organization_id uuid primary key references ogevia.organizations(id),
  urgent_in_app boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table ogevia.agency_notification_settings enable row level security;
revoke all on ogevia.agency_notification_settings from public;

create table ogevia.issue_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  recipient_user_id uuid not null,
  issue_key text not null,
  severity text not null check (severity in ('critical', 'urgent')),
  reopen_count integer not null default 0, -- how many earlier notifications for the same issue and severity were already resolved (a returning issue notifies again)
  kind text not null,
  reason text not null,
  queue text not null,
  client_code text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  resolved_at timestamptz,
  unique (organization_id, recipient_user_id, issue_key, severity, reopen_count)
);
create index issue_notifications_recipient_idx on ogevia.issue_notifications (organization_id, recipient_user_id, created_at desc);
alter table ogevia.issue_notifications enable row level security;
revoke all on ogevia.issue_notifications from public;

create function ogevia.issue_notifications_guard() returns trigger language plpgsql set search_path = ogevia, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'Notifications are kept as history' using errcode = 'OGC09'; end if;
  if new.id <> old.id or new.organization_id <> old.organization_id or new.recipient_user_id <> old.recipient_user_id or new.issue_key <> old.issue_key
     or new.severity <> old.severity or new.reopen_count <> old.reopen_count or new.kind <> old.kind or new.reason <> old.reason or new.queue <> old.queue
     or new.client_code is distinct from old.client_code or new.created_at <> old.created_at then
    raise exception 'A notification can only be marked read or resolved' using errcode = 'OGC09';
  end if;
  if old.read_at is not null and new.read_at is distinct from old.read_at then raise exception 'Already read' using errcode = 'OGC09'; end if;
  if old.resolved_at is not null and new.resolved_at is distinct from old.resolved_at then raise exception 'Already resolved' using errcode = 'OGC09'; end if;
  return new;
end;
$$;
create trigger issue_notifications_guard before update or delete on ogevia.issue_notifications for each row execute function ogevia.issue_notifications_guard();

-- The caller's own notifications, brought up to date with the caller's own view of the issue list, then returned.
create function ogevia_api.list_my_notifications(p_organization_id uuid, p_include_read boolean default false, p_limit integer default 30)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_can_cover boolean; v_can_visits boolean; v_can_docs boolean; v_can_comp boolean; v_can_bill boolean;
  v_urgent boolean;
  v_items jsonb; v_unread integer;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  v_can_visits := ogevia.has_permission(p_organization_id, 'visits.read');
  v_can_cover := ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage');
  v_can_docs := ogevia.has_permission(p_organization_id, 'documents.read');
  v_can_comp := ogevia.has_permission(p_organization_id, 'readiness.read');
  v_can_bill := ogevia.has_permission(p_organization_id, 'billing.visits.read');
  p_limit := greatest(1, least(coalesce(p_limit, 30), 100));
  if not (v_can_visits or v_can_cover or v_can_docs or v_can_comp) then
    return jsonb_build_object('asOf', now(), 'unread', 0, 'items', '[]'::jsonb);
  end if;
  select coalesce((select s.urgent_in_app from ogevia.agency_notification_settings s where s.organization_id = p_organization_id), true) into v_urgent;
  perform pg_advisory_xact_lock(hashtextextended('notifications:' || p_organization_id::text || ':' || v_actor::text, 0));

  insert into ogevia.issue_notifications (organization_id, recipient_user_id, issue_key, severity, reopen_count, kind, reason, queue, client_code)
  select p_organization_id, v_actor, c.issue_key, c.severity,
         (select count(*)::integer from ogevia.issue_notifications p where p.organization_id = p_organization_id and p.recipient_user_id = v_actor
             and p.issue_key = c.issue_key and p.severity = c.severity and p.resolved_at is not null),
         c.kind, c.reason, c.queue, (select cl.client_code from ogevia.clients cl where cl.id = c.client_id)
  from ogevia.action_issue_rows(p_organization_id, v_can_cover, v_can_visits, v_can_docs, v_can_comp, v_can_bill) c
  where c.queue in ('needs_attention_now', 'documents_compliance', 'visit_review')
    and (c.severity = 'critical' or (c.severity = 'urgent' and v_urgent))
  on conflict (organization_id, recipient_user_id, issue_key, severity, reopen_count) do nothing;

  -- pending notifications stop when the issue is gone from this person's list
  update ogevia.issue_notifications n set resolved_at = now()
  where n.organization_id = p_organization_id and n.recipient_user_id = v_actor and n.resolved_at is null
    and not exists (select 1 from ogevia.action_issue_rows(p_organization_id, v_can_cover, v_can_visits, v_can_docs, v_can_comp, v_can_bill) c where c.issue_key = n.issue_key);

  select count(*) into v_unread from ogevia.issue_notifications n
   where n.organization_id = p_organization_id and n.recipient_user_id = v_actor and n.read_at is null and n.resolved_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'issueKey', t.issue_key, 'severity', t.severity, 'kind', t.kind, 'reason', t.reason, 'queue', t.queue,
           'clientCode', t.client_code, 'createdAt', t.created_at, 'readAt', t.read_at, 'resolvedAt', t.resolved_at,
           'state', case when t.resolved_at is not null then 'resolved' when t.read_at is not null then 'read' else 'unread' end) order by t.created_at desc, t.id), '[]'::jsonb)
    into v_items
  from (select n.* from ogevia.issue_notifications n
         where n.organization_id = p_organization_id and n.recipient_user_id = v_actor and (p_include_read or (n.read_at is null and n.resolved_at is null))
         order by n.created_at desc, n.id limit p_limit) t;
  return jsonb_build_object('asOf', now(), 'unread', v_unread, 'items', v_items);
end;
$$;

-- Marks the caller's own pending notifications read (all, or the ones listed). Safe to repeat.
create function ogevia_api.mark_notifications_read(p_organization_id uuid, p_ids uuid[] default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_n integer;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  update ogevia.issue_notifications n set read_at = now()
  where n.organization_id = p_organization_id and n.recipient_user_id = v_actor and n.read_at is null and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create function ogevia_api.get_notification_settings(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  return jsonb_build_object('urgentInApp', coalesce((select s.urgent_in_app from ogevia.agency_notification_settings s where s.organization_id = p_organization_id), true),
                            'criticalInApp', true, 'routine', 'listed in Action needed only', 'outboundChannels', 'none');
end;
$$;

create function ogevia_api.set_notification_settings(p_organization_id uuid, p_urgent_in_app boolean, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_before boolean;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'Only the agency owner can change notification settings' using errcode = 'OGA03'; end if;
  if p_urgent_in_app is null then raise exception 'Choose on or off' using errcode = 'OGV22'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'A reason is required' using errcode = 'OGV22'; end if;
  select coalesce((select s.urgent_in_app from ogevia.agency_notification_settings s where s.organization_id = p_organization_id), true) into v_before;
  insert into ogevia.agency_notification_settings (organization_id, urgent_in_app, updated_by) values (p_organization_id, p_urgent_in_app, v_actor)
  on conflict (organization_id) do update set urgent_in_app = excluded.urgent_in_app, updated_by = v_actor, updated_at = now();
  perform ogevia.write_audit(p_organization_id, 'notification_settings.changed', 'organization', p_organization_id,
          jsonb_build_object('urgentInApp', v_before), jsonb_build_object('urgentInApp', p_urgent_in_app), btrim(p_reason));
  return jsonb_build_object('urgentInApp', p_urgent_in_app);
end;
$$;

revoke all on function ogevia.issue_notifications_guard() from public;
revoke all on function ogevia_api.list_my_notifications(uuid, boolean, integer) from public;
revoke all on function ogevia_api.mark_notifications_read(uuid, uuid[]) from public;
revoke all on function ogevia_api.get_notification_settings(uuid) from public;
revoke all on function ogevia_api.set_notification_settings(uuid, boolean, text) from public;
grant execute on function ogevia_api.list_my_notifications(uuid, boolean, integer) to ogevia_app;
grant execute on function ogevia_api.mark_notifications_read(uuid, uuid[]) to ogevia_app;
grant execute on function ogevia_api.get_notification_settings(uuid) to ogevia_app;
grant execute on function ogevia_api.set_notification_settings(uuid, boolean, text) to ogevia_app;
