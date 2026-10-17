-- 0054 Attention streams, appearance preferences, and the authorizations-missing-a-rate list (interface simplification).
--
-- URGENT WINDOW = 48 HOURS: owner decision D10 (docs/product/SCHEDULING_DASHBOARD_REVIEW_PACKAGE_2026-10-12.md, section 15.3): an unfilled shift starting
-- within the next 48 hours is an urgent coverage gap. It is a parameter (get_attention_overview, p_urgent_hours, default 48); no later owner decision changing it was found.
-- A shift or visit that starts, or is already running, inside the window is "Needs attention now"; later is "Upcoming staffing".
--
-- WHAT THIS CHANGES, AND WHAT IT REUSES (verified in the repository at 07bc55b):
--   * get_attention_summary (0020/0031/0033/0036) stays as it is. Its total adds up unlike things (visits, shifts, documents), so it is
--     not a count of visits. This migration adds ONE read-only function that classifies the same records into four purposes:
--       Needs attention now | Upcoming staffing | Documents & compliance | Visit review
--     UNCOVERED SHIFT  = a shifts row, status scheduled, not ended, with no caregiver or a call-out nobody replaced (shift_coverage_state).
--     UNSCHEDULED VISIT = a service_visits row with no scheduled_shift_id. It is a visit to review, never a staffing gap: it is counted
--                         only in Visit review, and an uncovered shift is counted only in the staffing streams.
--   * Visit review counts are UNIQUE visits (count(distinct id)); the review issues behind them are counted separately and labelled Issues.
--   * Compliance reuses the 0053 hold and the 0039-0041 shift flags (kinds 'compliance' and 'document'): a shift inside the window whose
--     caregiver is blocked appears in Needs attention now, linked to the compliance record. Enforcement is not touched.
--   * Appearance: organization defaults (organization.update, the same permission as branding) and per-person overrides, both tenant-scoped.
--   * Money: the authorizations a month's values cannot use (no hourly rate) are listed from the SAME summary the Home totals use.
-- Nothing here changes a visit, a shift, an authorization, billing, or any compliance rule.

-- ---------------------------------------------------------------------------
-- Appearance
-- ---------------------------------------------------------------------------

create table ogevia.organization_appearance (
  organization_id uuid primary key references ogevia.organizations(id),
  background text check (background is null or background in ('light', 'white', 'gray', 'dark')),
  accent text check (accent is null or accent in ('teal', 'blue', 'indigo', 'plum', 'rust')),
  density text check (density is null or density in ('comfortable', 'compact')),
  text_size text check (text_size is null or text_size in ('standard', 'large')),
  chart_type text check (chart_type is null or chart_type in ('bar', 'line', 'donut')),
  layout text check (layout is null or layout in ('standard', 'minimal')),
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now()
);
alter table ogevia.organization_appearance enable row level security;

create table ogevia.user_appearance (
  organization_id uuid not null references ogevia.organizations(id),
  user_id uuid not null references ogevia.app_users(id),
  background text check (background is null or background in ('light', 'white', 'gray', 'dark')),
  accent text check (accent is null or accent in ('teal', 'blue', 'indigo', 'plum', 'rust')),
  density text check (density is null or density in ('comfortable', 'compact')),
  text_size text check (text_size is null or text_size in ('standard', 'large')),
  chart_type text check (chart_type is null or chart_type in ('bar', 'line', 'donut')),
  layout text check (layout is null or layout in ('standard', 'minimal')),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
alter table ogevia.user_appearance enable row level security;

-- The built-in defaults (a column left empty means "follow the next level": person, then agency, then these).
create function ogevia.appearance_system_defaults()
returns jsonb
language sql
immutable
set search_path = ogevia, pg_temp
as $$ select jsonb_build_object('background', 'light', 'accent', 'teal', 'density', 'comfortable', 'textSize', 'standard', 'chartType', 'bar', 'layout', 'standard'); $$;

create function ogevia.appearance_json(p_background text, p_accent text, p_density text, p_text_size text, p_chart_type text, p_layout text)
returns jsonb
language sql
immutable
set search_path = ogevia, pg_temp
as $$ select jsonb_build_object('background', p_background, 'accent', p_accent, 'density', p_density, 'textSize', p_text_size, 'chartType', p_chart_type, 'layout', p_layout); $$;

-- Any active member: the three levels and the effective result. Reads only.
create function ogevia_api.get_appearance(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  o ogevia.organization_appearance%rowtype;
  u ogevia.user_appearance%rowtype;
  v_sys jsonb := ogevia.appearance_system_defaults();
  v_org jsonb;
  v_me jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  select * into o from ogevia.organization_appearance x where x.organization_id = p_organization_id;
  select * into u from ogevia.user_appearance x where x.organization_id = p_organization_id and x.user_id = v_actor;
  v_org := ogevia.appearance_json(o.background, o.accent, o.density, o.text_size, o.chart_type, o.layout);
  v_me := ogevia.appearance_json(u.background, u.accent, u.density, u.text_size, u.chart_type, u.layout);
  return jsonb_build_object(
    'system', v_sys, 'organization', v_org, 'mine', v_me,
    'effective', jsonb_build_object(
      'background', coalesce(u.background, o.background, v_sys ->> 'background'),
      'accent', coalesce(u.accent, o.accent, v_sys ->> 'accent'),
      'density', coalesce(u.density, o.density, v_sys ->> 'density'),
      'textSize', coalesce(u.text_size, o.text_size, v_sys ->> 'textSize'),
      'chartType', coalesce(u.chart_type, o.chart_type, v_sys ->> 'chartType'),
      'layout', coalesce(u.layout, o.layout, v_sys ->> 'layout')),
    'canSetOrganizationDefaults', ogevia.has_permission(p_organization_id, 'organization.update'));
end;
$$;

-- Agency administrator: the organization defaults. A null value clears that choice (the built-in default applies). Audited.
create function ogevia_api.set_organization_appearance(
  p_organization_id uuid, p_background text, p_accent text, p_density text, p_text_size text, p_chart_type text, p_layout text
)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  old ogevia.organization_appearance%rowtype;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then
    raise exception 'Only an administrator can set the agency appearance' using errcode = 'OGA03';
  end if;
  if (p_background is not null and p_background not in ('light', 'white', 'gray', 'dark'))
     or (p_accent is not null and p_accent not in ('teal', 'blue', 'indigo', 'plum', 'rust'))
     or (p_density is not null and p_density not in ('comfortable', 'compact'))
     or (p_text_size is not null and p_text_size not in ('standard', 'large'))
     or (p_chart_type is not null and p_chart_type not in ('bar', 'line', 'donut'))
     or (p_layout is not null and p_layout not in ('standard', 'minimal')) then
    raise exception 'That appearance choice is not available' using errcode = 'OGV22';
  end if;
  select * into old from ogevia.organization_appearance x where x.organization_id = p_organization_id for update;
  insert into ogevia.organization_appearance (organization_id, background, accent, density, text_size, chart_type, layout, updated_by)
  values (p_organization_id, p_background, p_accent, p_density, p_text_size, p_chart_type, p_layout, v_actor)
  on conflict (organization_id) do update
    set background = excluded.background, accent = excluded.accent, density = excluded.density, text_size = excluded.text_size,
        chart_type = excluded.chart_type, layout = excluded.layout, updated_by = excluded.updated_by, updated_at = now();
  perform ogevia.write_audit(p_organization_id, 'organization.appearance_set', 'organization_appearance', p_organization_id,
    ogevia.appearance_json(old.background, old.accent, old.density, old.text_size, old.chart_type, old.layout),
    ogevia.appearance_json(p_background, p_accent, p_density, p_text_size, p_chart_type, p_layout), null);
  return ogevia_api.get_appearance(p_organization_id);
end;
$$;

-- Any active member: their OWN viewing choices only. A null value follows the agency default. Never affects anyone else.
create function ogevia_api.set_my_appearance(
  p_organization_id uuid, p_background text, p_accent text, p_density text, p_text_size text, p_chart_type text, p_layout text
)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if (p_background is not null and p_background not in ('light', 'white', 'gray', 'dark'))
     or (p_accent is not null and p_accent not in ('teal', 'blue', 'indigo', 'plum', 'rust'))
     or (p_density is not null and p_density not in ('comfortable', 'compact'))
     or (p_text_size is not null and p_text_size not in ('standard', 'large'))
     or (p_chart_type is not null and p_chart_type not in ('bar', 'line', 'donut'))
     or (p_layout is not null and p_layout not in ('standard', 'minimal')) then
    raise exception 'That appearance choice is not available' using errcode = 'OGV22';
  end if;
  insert into ogevia.user_appearance (organization_id, user_id, background, accent, density, text_size, chart_type, layout)
  values (p_organization_id, v_actor, p_background, p_accent, p_density, p_text_size, p_chart_type, p_layout)
  on conflict (organization_id, user_id) do update
    set background = excluded.background, accent = excluded.accent, density = excluded.density, text_size = excluded.text_size,
        chart_type = excluded.chart_type, layout = excluded.layout, updated_at = now();
  return ogevia_api.get_appearance(p_organization_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Attention streams
-- ---------------------------------------------------------------------------

-- One classified, read-only picture of what needs a person, by purpose. Every section is null (never zero) when the viewer may not see it.
--   urgent    : items that are red or amber RIGHT NOW (uncovered shift inside the window; a shift inside the window whose caregiver is
--               blocked by a compliance hold or a document problem; a visit still open past its shift end; a visit in progress for a
--               caregiver on hold). One item per shift or visit, with every reason; issues = reasons added up.
--   upcoming  : uncovered shifts that start after the window, soonest first.
--   documents : counts of overdue, due soon, awaiting review, rejected, requirements pending inside the 14 days, and caregivers on hold.
--   visitReview: UNIQUE visits waiting for confirmation or for a person's review/approval, and the review issues behind them.
create function ogevia_api.get_attention_overview(p_organization_id uuid, p_urgent_hours integer default 48)
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
  v_alerts record;
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
             'red'::text as severity, null::uuid as caregiver_id, sh.client_id as client_id, sh.service_id as service_id
      from ogevia.shifts sh
      where v_can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.ends_at > now() and sh.starts_at < now() + v_win
        and ogevia.shift_coverage_state(sh) = 'needs_coverage'
      union all
      -- a shift inside the window whose caregiver is blocked (0053 hold, or a required-document problem flagged by 0041)
      select 'shift', sh.id, sh.starts_at, sh.ends_at,
             case f.kind when 'compliance' then 'compliance_hold' else 'documents_not_current' end, 'red', f.caregiver_record_id, sh.client_id, sh.service_id
      from ogevia.shift_readiness_flags f
      join ogevia.shifts sh on sh.id = f.shift_id
      where (v_can_comp or v_can_cover) and f.organization_id = p_organization_id and f.kind in ('compliance', 'document') and f.resolved_at is null
        and sh.status = 'scheduled' and sh.ends_at > now() and sh.starts_at < now() + v_win and not ogevia.shift_is_called_out(sh.id)
      union all
      -- a visit still open past its shift end (or 12 h without a schedule): the worked time is unknown
      select 'visit', v.id, v.time_in, null::timestamptz, 'missing_clock_out', 'amber', v.caregiver_record_id, v.client_id, v.service_id
      from ogevia.service_visits v
      left join ogevia.shifts s on s.id = v.scheduled_shift_id
      where v_can_visits and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
        and ((s.id is not null and s.ends_at < now()) or (s.id is null and v.time_in <= now() - interval '12 hours'))
      union all
      -- a visit in progress for a caregiver who is on a compliance hold: the office must arrange safe coverage
      select 'visit', v.id, v.time_in, null::timestamptz, 'in_progress_on_hold', 'red', v.caregiver_record_id, v.client_id, v.service_id
      from ogevia.service_visits v
      join ogevia.caregiver_compliance_holds h on h.organization_id = v.organization_id and h.released_at is null
       and (h.caregiver_record_id = v.caregiver_record_id
            or (v.caregiver_record_id is null and v.caregiver_user_id = (select r.linked_user_id from ogevia.caregiver_records r where r.id = h.caregiver_record_id)))
      where (v_can_comp or v_can_visits) and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
    ), items as (
      select r.kind, r.id, min(r.at) as at, max(r.ends_at) as ends_at,
             (array_agg(distinct r.reason order by r.reason)) as reasons,
             case when bool_or(r.severity = 'red') then 'red' else 'amber' end as severity,
             max(r.caregiver_id::text)::uuid as caregiver_id, max(r.client_id::text)::uuid as client_id, max(r.service_id::text)::uuid as service_id
      from reasons r group by r.kind, r.id
    )
    select jsonb_build_object(
             'items', coalesce(jsonb_agg(jsonb_build_object(
                'kind', i.kind, 'id', i.id, 'startsAt', i.at, 'endsAt', i.ends_at, 'reasons', to_jsonb(i.reasons), 'severity', i.severity,
                'inProgress', i.at <= now() and (i.ends_at is null or i.ends_at > now()),
                'caregiverRecordId', i.caregiver_id, 'caregiverCode', (select r2.caregiver_code from ogevia.caregiver_records r2 where r2.id = i.caregiver_id),
                'clientCode', (select c.client_code from ogevia.clients c where c.id = i.client_id),
                'serviceCode', (select s2.code from ogevia.services s2 where s2.id = i.service_id)) order by (i.severity = 'red') desc, i.at), '[]'::jsonb),
             'itemCount', count(*),
             'issueCount', coalesce(sum(cardinality(i.reasons)), 0),
             'shifts', count(*) filter (where i.kind = 'shift'),
             'visits', count(*) filter (where i.kind = 'visit'))
      into v_urgent
    from items i;
  end if;

  -- UPCOMING STAFFING: uncovered shifts after the window, soonest first -------------------------------------------------
  if v_can_cover then
    select jsonb_build_object(
             'count', count(*),
             'nextStartsAt', min(x.starts_at),
             'shifts', coalesce(jsonb_agg(jsonb_build_object(
                'shiftId', x.id, 'startsAt', x.starts_at, 'endsAt', x.ends_at,
                'reason', case when ogevia.shift_is_called_out(x.id) then 'called_out' else 'open' end,
                'clientCode', (select c.client_code from ogevia.clients c where c.id = x.client_id),
                'serviceCode', (select s2.code from ogevia.services s2 where s2.id = x.service_id),
                'serviceName', (select s2.name from ogevia.services s2 where s2.id = x.service_id)) order by x.starts_at) filter (where x.rn <= 200), '[]'::jsonb))
      into v_upcoming
    from (
      select sh.*, row_number() over (order by sh.starts_at) as rn
      from ogevia.shifts sh
      where sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.starts_at >= now() + v_win
        and ogevia.shift_coverage_state(sh) = 'needs_coverage'
    ) x;
  end if;

  -- DOCUMENTS & COMPLIANCE -----------------------------------------------------------------------------------------------
  if v_can_docs then
    select * into v_alerts from ogevia_api.get_document_alerts(p_organization_id);
    v_docs := jsonb_build_object('overdue', v_alerts.expired + v_alerts.overdue, 'dueSoon', v_alerts.expiring,
                                 'awaitingReview', v_alerts.awaiting_review, 'rejected', v_alerts.rejected);
  end if;
  if v_can_comp then
    select count(*)::int into v_holds from ogevia.caregiver_compliance_holds h where h.organization_id = p_organization_id and h.released_at is null;
    select count(*)::int into v_pending from ogevia.caregiver_records r
    where r.organization_id = p_organization_id and r.deleted_at is null and r.status in ('ready', 'active')
      and exists (select 1 from ogevia.compliance_blockers(p_organization_id, r.id) b where not b.blocking);
    v_docs := coalesce(v_docs, '{}'::jsonb) || jsonb_build_object('caregiversOnHold', v_holds, 'caregiversWithPendingRequirements', v_pending);
  end if;

  -- VISIT REVIEW: unique visits ------------------------------------------------------------------------------------------
  if v_can_visits then
    with u as (
      select v.id, 'awaiting_confirmation'::text as kind from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null and v.time_out <= now() - interval '60 minutes'
      union all
      select v.id, 'needs_review' from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'administrator_review'
         and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
         and ogevia.visit_recovery_state(v.id) is null
      union all
      select v.id, 'late_response' from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'administrator_review' and ogevia.visit_recovery_state(v.id) = 'response_to_review'
      union all
      select v.id, 'ready_for_approval' from ogevia.service_visits v
       where v_can_bill and v.organization_id = p_organization_id and v.status = 'signed'
         and not exists (select 1 from ogevia.billing_approvals b where b.visit_id = v.id and b.voided_at is null)
    )
    select jsonb_build_object(
             'visitsNeedingAttention', count(distinct u.id),
             'awaitingConfirmation', count(distinct u.id) filter (where u.kind = 'awaiting_confirmation'),
             'needsReview', count(distinct u.id) filter (where u.kind = 'needs_review'),
             'lateResponses', count(distinct u.id) filter (where u.kind = 'late_response'),
             'readyForApproval', case when v_can_bill then count(distinct u.id) filter (where u.kind = 'ready_for_approval') end,
             'reviewIssues', coalesce(sum(cardinality(coalesce(ogevia.visit_review_reasons(u.id), array[]::text[]))) filter (where u.kind = 'needs_review'), 0),
             'awaitingResponse', (select count(*) from ogevia.service_visits v where v.organization_id = p_organization_id and v.status = 'administrator_review'
                                   and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
                                   and ogevia.visit_recovery_state(v.id) = 'awaiting_response'))
      into v_review
    from u;
  end if;

  return jsonb_build_object(
    'asOf', now(), 'urgentWindowHours', p_urgent_hours,
    'urgent', v_urgent, 'upcoming', v_upcoming, 'documents', v_docs, 'visitReview', v_review);
end;
$$;

-- ---------------------------------------------------------------------------
-- Authorizations a month's money figures cannot use
-- ---------------------------------------------------------------------------

-- The lineages (latest version) that overlap the month and have no hourly rate: the SAME rows the Home totals leave out
-- (get_utilisation_overview counts them as lineages_without_rate). Administrator only (rates are owner-only).
create function ogevia_api.list_authorizations_missing_rate(p_organization_id uuid, p_month_start date)
returns table (
  authorization_id uuid, authorization_lineage_id uuid, client_id uuid, client_code text, client_name text,
  service_id uuid, service_code text, service_name text, payer text, period_start date, period_end date, monthly_authorized_minutes integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id) and ogevia.has_permission(p_organization_id, 'billing.read') as ok,
           date_trunc('month', p_month_start::timestamp)::date as m0
  ), s as (
    select distinct su.authorization_lineage_id
    from ctx, ogevia_api.list_monthly_service_summary(p_organization_id, ctx.m0, null) su
    where ctx.ok
  ), latest as (
    select distinct on (a.lineage_id) a.*
    from ogevia.client_authorizations a join s on s.authorization_lineage_id = a.lineage_id
    order by a.lineage_id, a.version_number desc
  )
  select l.id, l.lineage_id, l.client_id, c.client_code,
         case when ogevia.has_permission(p_organization_id, 'clients.names.read') then nullif(btrim(concat_ws(' ', n.legal_first_name, n.legal_last_name)), '') end,
         l.service_id, sv.code, sv.name, l.payer, l.period_start, l.period_end, l.monthly_authorized_minutes
  from ctx, latest l
  join ogevia.clients c on c.id = l.client_id
  join ogevia.services sv on sv.id = l.service_id
  left join ogevia.client_private_names n on n.client_id = l.client_id
  where ctx.ok and ctx.actor is not null and l.hourly_rate_cents is null
  order by c.client_code, sv.code;
$$;

revoke all on function ogevia.appearance_system_defaults() from public;
revoke all on function ogevia.appearance_json(text, text, text, text, text, text) from public;
revoke all on function ogevia_api.get_appearance(uuid) from public;
revoke all on function ogevia_api.set_organization_appearance(uuid, text, text, text, text, text, text) from public;
revoke all on function ogevia_api.set_my_appearance(uuid, text, text, text, text, text, text) from public;
revoke all on function ogevia_api.get_attention_overview(uuid, integer) from public;
revoke all on function ogevia_api.list_authorizations_missing_rate(uuid, date) from public;
grant execute on function ogevia_api.get_appearance(uuid) to ogevia_app;
grant execute on function ogevia_api.set_organization_appearance(uuid, text, text, text, text, text, text) to ogevia_app;
grant execute on function ogevia_api.set_my_appearance(uuid, text, text, text, text, text, text) to ogevia_app;
grant execute on function ogevia_api.get_attention_overview(uuid, integer) to ogevia_app;
grant execute on function ogevia_api.list_authorizations_missing_rate(uuid, date) to ogevia_app;

grant select on table ogevia.organization_appearance, ogevia.user_appearance to ogevia_readonly;
create policy readonly_select on ogevia.organization_appearance for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.user_appearance for select to ogevia_readonly using (true);
