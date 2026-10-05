-- 0029 Billing rounding policies (per payer and service), versioned, with
-- separately approved rounding adjustments.
--
-- Principles (owner direction 2026-10-05):
--   * Default: NO rounding. Without a policy, nothing changes anywhere.
--   * A policy is per payer (the authorization's payer) and service:
--     none | nearest | up | down, an increment in minutes (e.g. 15) and ONE
--     basis: per visit OR the client's daily total for that authorization and
--     service. Never both: a day can carry either per-visit adjustments or one
--     daily adjustment, not a mix.
--   * The subscriber's choice configures the software; it does not override the
--     payer's rules. Rounding can be enabled only by the Administrator
--     (billing.rounding.manage) after recording the payer rule it implements
--     (reference and date). Every change is a new dated version; versions are
--     never edited or deleted.
--   * Records: clock times, worked minutes, confirmed billable minutes and the
--     visit billing approvals are NEVER changed. Rounding is a separate line:
--     actual duration, billing adjustment and proposed billable units are kept
--     and shown separately. An adjustment is computed by the server from the
--     approved visit minutes and the policy in effect on the service date, and
--     takes effect only when a person with billing.approve approves it.
--   * Authorization: an adjustment may never take the month's billed time past
--     the authorized minutes (a round-up that would is reduced to the largest
--     increment that fits, and flagged). Approved adjustments count against the
--     authorization everywhere (usage and remaining).
--   * No silent recalculation: an approved adjustment keeps the policy version,
--     minutes and rate it was approved with. A later policy change shows it as
--     "approved under an earlier policy"; only a person voids and re-approves.
--     A visit approval covered by an active adjustment cannot be voided, and a
--     visit cannot be newly approved into a day with an active daily
--     adjustment, until that adjustment is voided.
--   * Payroll: untouched. Ogevia has no payroll feature; worked minutes (the
--     only payroll-relevant quantity) are never read or written by rounding.

insert into ogevia.permissions (key, description) values
  ('billing.rounding.manage', 'Set billing rounding policies per payer and service (records the payer rule)');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'billing.rounding.manage');

create table ogevia.billing_rounding_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  payer_key text not null check (length(payer_key) > 0 and payer_key = lower(btrim(payer_key))),
  payer_label text not null check (length(btrim(payer_label)) > 0),
  service_id uuid not null,
  version integer not null check (version >= 1),
  method text not null check (method in ('none', 'nearest', 'up', 'down')),
  increment_minutes integer,
  basis text,
  payer_rule_reference text,
  payer_rule_date date,
  effective_from date not null,
  reason text not null check (length(btrim(reason)) > 0),
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id),
  unique (organization_id, payer_key, service_id, version),
  constraint billing_rounding_policies_shape check (
    (method = 'none' and increment_minutes is null and basis is null)
    or (method <> 'none' and coalesce(increment_minutes, 0) between 1 and 240 and coalesce(basis, '') in ('per_visit', 'daily_total')
        and length(btrim(coalesce(payer_rule_reference, ''))) >= 5 and payer_rule_date is not null)
  )
);
create index billing_rounding_policies_lookup on ogevia.billing_rounding_policies (organization_id, payer_key, service_id, effective_from);
create trigger billing_rounding_policies_no_update before update on ogevia.billing_rounding_policies
for each row execute function ogevia.forbid_update();
create trigger billing_rounding_policies_no_delete before delete on ogevia.billing_rounding_policies
for each row execute function ogevia.forbid_delete();
alter table ogevia.billing_rounding_policies enable row level security;
create policy readonly_select on ogevia.billing_rounding_policies for select to ogevia_readonly using (true);
grant select on ogevia.billing_rounding_policies to ogevia_readonly;

create table ogevia.billing_rounding_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  unit_kind text not null check (unit_kind in ('visit', 'day')),
  visit_id uuid references ogevia.service_visits(id),
  authorization_lineage_id uuid not null,
  client_id uuid not null references ogevia.clients(id),
  service_id uuid not null references ogevia.services(id),
  service_date date not null,
  policy_id uuid not null references ogevia.billing_rounding_policies(id),
  covered_visit_ids uuid[] not null check (cardinality(covered_visit_ids) >= 1),
  base_minutes integer not null check (base_minutes >= 0),
  proposed_minutes integer not null check (proposed_minutes >= 0),
  adjustment_minutes integer not null check (adjustment_minutes <> 0),
  capped_by_authorization boolean not null,
  rate_cents integer check (rate_cents is null or rate_cents >= 0),
  amount_cents integer,
  notes text,
  approved_by uuid not null references ogevia.app_users(id),
  approved_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references ogevia.app_users(id),
  void_reason text,
  check (adjustment_minutes = proposed_minutes - base_minutes),
  check ((unit_kind = 'visit') = (visit_id is not null)),
  check ((voided_at is null and voided_by is null and void_reason is null)
      or (voided_at is not null and voided_by is not null and length(btrim(coalesce(void_reason, ''))) > 0))
);
create unique index billing_rounding_adjustments_active_visit on ogevia.billing_rounding_adjustments (visit_id)
  where voided_at is null and unit_kind = 'visit';
create unique index billing_rounding_adjustments_active_day on ogevia.billing_rounding_adjustments (authorization_lineage_id, service_date)
  where voided_at is null and unit_kind = 'day';
create index billing_rounding_adjustments_month on ogevia.billing_rounding_adjustments (authorization_lineage_id, service_date) where voided_at is null;

create function ogevia.billing_rounding_adjustments_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.voided_at is not null then
    raise exception 'A voided rounding adjustment cannot be changed' using errcode = 'OGC09';
  end if;
  if (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason'])
     is distinct from (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason']) then
    raise exception 'Rounding adjustments are append-only; void and approve again' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
create trigger billing_rounding_adjustments_guard_update before update on ogevia.billing_rounding_adjustments
for each row execute function ogevia.billing_rounding_adjustments_guard_update();
create trigger billing_rounding_adjustments_no_delete before delete on ogevia.billing_rounding_adjustments
for each row execute function ogevia.forbid_delete();
alter table ogevia.billing_rounding_adjustments enable row level security;
create policy readonly_select on ogevia.billing_rounding_adjustments for select to ogevia_readonly using (true);
grant select on ogevia.billing_rounding_adjustments to ogevia_readonly;

-- Visit approvals under an active adjustment stay as they are until the adjustment is voided.
create function ogevia.billing_approvals_rounding_guard()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare v_lineage uuid; v_date date;
begin
  if tg_op = 'UPDATE' and old.voided_at is null and new.voided_at is not null then
    if exists (select 1 from ogevia.billing_rounding_adjustments r
               where r.voided_at is null and old.visit_id = any (r.covered_visit_ids)) then
      raise exception 'A billing rounding adjustment includes this visit; void the rounding adjustment first' using errcode = 'OGC09';
    end if;
  elsif tg_op = 'INSERT' then
    select a.lineage_id, v.service_date into v_lineage, v_date
    from ogevia.service_visits v join ogevia.client_authorizations a on a.id = v.service_authorization_id where v.id = new.visit_id;
    if exists (select 1 from ogevia.billing_rounding_adjustments r
               where r.voided_at is null and r.unit_kind = 'day' and r.authorization_lineage_id = v_lineage and r.service_date = v_date) then
      raise exception 'This day already has an approved daily rounding adjustment; void it first, then approve this visit and the day again' using errcode = 'OGC09';
    end if;
  end if;
  return new;
end;
$$;
create trigger billing_approvals_rounding_guard before insert or update on ogevia.billing_approvals
for each row execute function ogevia.billing_approvals_rounding_guard();

-- Rounding arithmetic. Nearest rounds a half increment up.
create function ogevia.round_minutes(p_minutes integer, p_method text, p_increment integer)
returns integer
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select case
    when p_minutes is null then null
    when p_method = 'none' or p_increment is null or p_increment < 1 then p_minutes
    when p_method = 'up' then ((p_minutes + p_increment - 1) / p_increment) * p_increment
    when p_method = 'down' then (p_minutes / p_increment) * p_increment
    when p_method = 'nearest' then ((2 * p_minutes + p_increment) / (2 * p_increment)) * p_increment
  end;
$$;

-- The policy version in effect for a payer and service on a date: the highest
-- version whose effective date is on or before it. No row = no rounding.
create function ogevia.rounding_policy_for(p_organization_id uuid, p_payer text, p_service_id uuid, p_date date)
returns ogevia.billing_rounding_policies
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select p.* from ogevia.billing_rounding_policies p
  where p.organization_id = p_organization_id and p.payer_key = lower(btrim(p_payer)) and p.service_id = p_service_id
    and p.effective_from <= p_date
  order by p.version desc limit 1;
$$;

-- Authorization usage now includes approved rounding adjustments (net).
create or replace function ogevia.authorization_month_usage(
  p_lineage_id uuid,
  p_service_date date,
  p_exclude_visit_id uuid default null
)
returns bigint
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select (
    select coalesce(sum(v.billable_minutes), 0)
    from ogevia.service_visits v
    join ogevia.client_authorizations a on a.id = v.service_authorization_id
    where a.lineage_id = p_lineage_id
      and v.service_date >= date_trunc('month', p_service_date::timestamp)::date
      and v.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date
      and v.status in ('signed', 'administrator_review')
      and v.id is distinct from p_exclude_visit_id
  ) + (
    select coalesce(sum(r.adjustment_minutes), 0)
    from ogevia.billing_rounding_adjustments r
    where r.authorization_lineage_id = p_lineage_id and r.voided_at is null
      and r.service_date >= date_trunc('month', p_service_date::timestamp)::date
      and r.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date
  )::bigint;
$$;

create function ogevia_api.set_billing_rounding_policy(
  p_organization_id uuid, p_payer text, p_service_id uuid, p_method text, p_increment_minutes integer, p_basis text,
  p_payer_rule_reference text, p_payer_rule_date date, p_effective_from date, p_reason text, p_idempotency_key uuid default null
)
returns table (policy_id uuid, version integer)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_key text := lower(btrim(coalesce(p_payer, '')));
  v_method text := lower(btrim(coalesce(p_method, '')));
  v_fp text := concat_ws('|', p_organization_id, v_key, p_service_id, v_method, p_increment_minutes, p_basis,
                         btrim(coalesce(p_payer_rule_reference, '')), p_payer_rule_date, p_effective_from, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_label text;
  v_prev ogevia.billing_rounding_policies%rowtype;
  v_row ogevia.billing_rounding_policies%rowtype;
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'billing.rounding.manage') then
    raise exception 'Only the Administrator can set billing rounding policies' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_billing_rounding_policy', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'policy_id')::uuid, (v_prior ->> 'version')::integer;
    return;
  end if;
  if v_method not in ('none', 'nearest', 'up', 'down') then
    raise exception 'Choose no rounding, nearest, round up or round down' using errcode = 'OGV22';
  end if;
  select a.payer into v_label from ogevia.client_authorizations a
  where a.organization_id = p_organization_id and lower(btrim(a.payer)) = v_key and a.deleted_at is null
  order by a.created_at desc limit 1;
  if v_label is null then
    raise exception 'No authorization in this agency names that payer; enter the payer exactly as on the authorizations' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id and s.deleted_at is null) then
    raise exception 'The service must belong to this agency' using errcode = 'OGV22';
  end if;
  if p_effective_from is null then
    raise exception 'Enter the date the policy takes effect' using errcode = 'OGV22';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason for the change is required' using errcode = 'OGV22';
  end if;
  if v_method <> 'none' then
    if p_increment_minutes is null or p_increment_minutes < 1 or p_increment_minutes > 240 then
      raise exception 'The increment must be between 1 and 240 minutes' using errcode = 'OGV22';
    end if;
    if coalesce(p_basis, '') not in ('per_visit', 'daily_total') then
      raise exception 'Choose whether rounding applies per visit or to the daily total' using errcode = 'OGV22';
    end if;
    if length(btrim(coalesce(p_payer_rule_reference, ''))) < 5 or p_payer_rule_date is null then
      raise exception 'Record the payer rule that allows this rounding (document reference and its date) before enabling it' using errcode = 'OGV22';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ogevia.rounding:' || p_organization_id::text || ':' || v_key || ':' || p_service_id::text, 0));
  select * into v_prev from ogevia.billing_rounding_policies p
  where p.organization_id = p_organization_id and p.payer_key = v_key and p.service_id = p_service_id order by p.version desc limit 1;

  insert into ogevia.billing_rounding_policies (organization_id, payer_key, payer_label, service_id, version, method, increment_minutes,
    basis, payer_rule_reference, payer_rule_date, effective_from, reason, created_by)
  values (p_organization_id, v_key, btrim(v_label), p_service_id, coalesce(v_prev.version, 0) + 1, v_method,
    case when v_method = 'none' then null else p_increment_minutes end,
    case when v_method = 'none' then null else p_basis end,
    nullif(btrim(coalesce(p_payer_rule_reference, '')), ''), p_payer_rule_date, p_effective_from, btrim(p_reason), v_actor)
  returning * into v_row;

  perform ogevia.write_audit(p_organization_id, 'billing.rounding_policy_set', 'billing_rounding_policies', v_row.id,
    case when v_prev.id is not null then jsonb_build_object('version', v_prev.version, 'method', v_prev.method,
      'increment_minutes', v_prev.increment_minutes, 'basis', v_prev.basis, 'effective_from', v_prev.effective_from) end,
    jsonb_build_object('payer', v_row.payer_label, 'service_id', p_service_id, 'version', v_row.version, 'method', v_row.method,
      'increment_minutes', v_row.increment_minutes, 'basis', v_row.basis, 'payer_rule_reference', v_row.payer_rule_reference,
      'payer_rule_date', v_row.payer_rule_date, 'effective_from', v_row.effective_from),
    btrim(p_reason));
  perform ogevia.idempotency_finish('set_billing_rounding_policy', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('policy_id', v_row.id, 'version', v_row.version));
  return query select v_row.id, v_row.version;
end;
$$;

create function ogevia_api.list_billing_rounding_policies(p_organization_id uuid)
returns table (
  policy_id uuid, payer text, service_id uuid, service_name text, version integer, method text, increment_minutes integer,
  basis text, payer_rule_reference text, payer_rule_date date, effective_from date, reason text, created_by_name text,
  created_at timestamptz, in_effect_today boolean
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select p.id, p.payer_label, p.service_id, s.name, p.version, p.method, p.increment_minutes, p.basis, p.payer_rule_reference,
         p.payer_rule_date, p.effective_from, p.reason, coalesce(u.display_name, 'Staff'), p.created_at,
         p.id = (ogevia.rounding_policy_for(p.organization_id, p.payer_key, p.service_id, (now() at time zone o.timezone)::date)).id
  from ogevia.billing_rounding_policies p
  join ogevia.organizations o on o.id = p.organization_id
  join ogevia.services s on s.id = p.service_id
  left join ogevia.app_users u on u.id = p.created_by
  where ogevia.require_actor() is not null and p.organization_id = p_organization_id
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'billing.rounding.manage') or ogevia.has_permission(p_organization_id, 'billing.visits.read'))
  order by p.payer_label, s.name, p.version desc;
$$;

-- One unit = one visit (per-visit basis or no policy) or one lineage-day (daily basis).
create function ogevia.rounding_units(p_organization_id uuid, p_from date, p_to date)
returns table (
  unit_kind text, unit_key text, visit_id uuid, authorization_lineage_id uuid, client_id uuid, service_id uuid, service_date date,
  payer text, policy_id uuid, covered_visit_ids uuid[], visit_count integer, first_time_in timestamptz, last_time_out timestamptz,
  worked_minutes integer, billable_minutes integer, approved_minutes integer, all_approved boolean, open_visits integer
)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  with v as (
    select sv.*, a.lineage_id, a.payer, (ogevia.rounding_policy_for(p_organization_id, a.payer, sv.service_id, sv.service_date)) as pol,
           (select b.approved_minutes from ogevia.billing_approvals b where b.visit_id = sv.id and b.voided_at is null) as appr
    from ogevia.service_visits sv
    join ogevia.client_authorizations a on a.id = sv.service_authorization_id
    where sv.organization_id = p_organization_id and sv.service_date between p_from and p_to and sv.status = 'signed'
  ), u as (
    select case when (v.pol).basis = 'daily_total' and (v.pol).method <> 'none' then 'day' else 'visit' end as kind, v.*
    from v
  )
  select u.kind,
         case when u.kind = 'day' then u.lineage_id::text || ':' || u.service_date::text else min(u.id::text) end,
         case when u.kind = 'visit' then (array_agg(u.id))[1] end,
         u.lineage_id, (array_agg(u.client_id))[1], (array_agg(u.service_id))[1], u.service_date, (array_agg(u.payer))[1],
         (array_agg((u.pol).id))[1], array_agg(u.id order by u.time_in), count(*)::integer, min(u.time_in), max(u.time_out),
         sum(u.worked_minutes)::integer, sum(u.billable_minutes)::integer, sum(u.appr)::integer, bool_and(u.appr is not null),
         (select count(*)::integer from ogevia.service_visits o join ogevia.client_authorizations oa on oa.id = o.service_authorization_id
          where u.kind = 'day' and oa.lineage_id = u.lineage_id and o.service_date = u.service_date
            and o.status in ('draft', 'awaiting_signature', 'administrator_review'))
  from u
  group by u.kind, u.lineage_id, u.service_date, case when u.kind = 'day' then null else u.id end;
$$;

create function ogevia.rounding_proposal(p_lineage_id uuid, p_date date, p_policy ogevia.billing_rounding_policies, p_base integer, p_include_own boolean)
returns table (proposed_minutes integer, capped boolean)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_cap integer;
  v_rounded integer;
  v_room bigint;
begin
  if p_policy.id is null or p_policy.method = 'none' then
    return query select p_base, false; return;
  end if;
  v_rounded := ogevia.round_minutes(p_base, p_policy.method, p_policy.increment_minutes);
  select a.monthly_authorized_minutes into v_cap from ogevia.client_authorizations a
  where a.lineage_id = p_lineage_id and a.is_current and a.deleted_at is null and p_date between a.period_start and a.period_end;
  v_cap := coalesce(v_cap, 0);
  -- Usage already holds this unit's billable time; an adjustment may add at most the room left.
  v_room := v_cap - ogevia.authorization_month_usage(p_lineage_id, p_date, null);
  if v_rounded - p_base > v_room then
    return query select greatest(0, least(v_rounded, ((p_base + greatest(v_room, -p_base))::integer / p_policy.increment_minutes) * p_policy.increment_minutes)), true;
    return;
  end if;
  return query select v_rounded, false;
end;
$$;

create function ogevia_api.list_billing_rounding_preview(p_organization_id uuid, p_from date, p_to date)
returns table (
  unit_kind text, unit_key text, visit_id uuid, visit_number text, visit_count integer, authorization_lineage_id uuid,
  client_code text, service_name text, payer text, service_date date, time_in timestamptz, time_out timestamptz,
  worked_minutes integer, billable_minutes integer, approved_minutes integer, all_approved boolean, open_visits integer,
  policy_version integer, method text, increment_minutes integer, basis text,
  proposed_minutes integer, adjustment_minutes integer, proposed_units numeric, capped_by_authorization boolean,
  adjustment_id uuid, adjusted_base_minutes integer, adjusted_proposed_minutes integer, adjusted_minutes integer,
  adjusted_policy_version integer, adjusted_at timestamptz, state text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select u.unit_kind, u.unit_key, u.visit_id,
         (select sv.visit_number_snapshot from ogevia.service_visits sv where sv.id = u.visit_id),
         u.visit_count, u.authorization_lineage_id, c.client_code, s.name, u.payer, u.service_date, u.first_time_in, u.last_time_out,
         u.worked_minutes, u.billable_minutes, u.approved_minutes, u.all_approved, u.open_visits,
         p.version, coalesce(p.method, 'none'), p.increment_minutes, p.basis,
         pr.proposed_minutes, pr.proposed_minutes - coalesce(case when u.all_approved then u.approved_minutes end, u.billable_minutes),
         case when p.increment_minutes is not null and p.method <> 'none' then round(pr.proposed_minutes::numeric / p.increment_minutes, 2) end,
         pr.capped,
         adj.id, adj.base_minutes, adj.proposed_minutes, adj.adjustment_minutes, ap.version, adj.approved_at,
         case
           when adj.id is not null and (adj.policy_id is distinct from p.id or adj.unit_kind <> u.unit_kind) then 'approved_under_earlier_policy'
           when adj.id is not null then 'approved'
           when p.id is null or p.method = 'none' then 'no_rounding'
           when u.open_visits > 0 then 'day_has_open_visits'
           when not u.all_approved then 'awaiting_visit_approval'
           when pr.proposed_minutes = u.approved_minutes then 'no_adjustment'
           else 'ready_to_approve'
         end
  from (select ogevia.require_actor() as actor) g
  cross join lateral ogevia.rounding_units(p_organization_id, p_from, p_to) u
  join ogevia.clients c on c.id = u.client_id
  join ogevia.services s on s.id = u.service_id
  left join ogevia.billing_rounding_policies p on p.id = u.policy_id
  left join lateral ogevia.rounding_proposal(u.authorization_lineage_id, u.service_date, p,
    coalesce(case when u.all_approved then u.approved_minutes end, u.billable_minutes), true) pr on true
  -- Any active adjustment over these visits, including one approved under another basis.
  left join lateral (
    select r.* from ogevia.billing_rounding_adjustments r
    where r.voided_at is null and r.organization_id = p_organization_id and r.covered_visit_ids && u.covered_visit_ids
    order by r.approved_at limit 1
  ) adj on true
  left join ogevia.billing_rounding_policies ap on ap.id = adj.policy_id
  where g.actor is not null and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'billing.visits.read')
    and p_from is not null and p_to is not null and p_to >= p_from and p_to - p_from <= 62
  order by u.service_date, c.client_code, u.first_time_in;
$$;

create function ogevia_api.approve_billing_rounding_adjustment(
  p_organization_id uuid, p_visit_id uuid, p_lineage_id uuid, p_service_date date, p_notes text default null, p_idempotency_key uuid default null
)
returns table (adjustment_id uuid, base_minutes integer, proposed_minutes integer, adjustment_minutes integer, proposed_units numeric, capped_by_authorization boolean)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_visit_id, p_lineage_id, p_service_date, btrim(coalesce(p_notes, '')));
  v_prior jsonb;
  v_unit record;
  v_pol ogevia.billing_rounding_policies%rowtype;
  v_prop record;
  v_rate integer;
  v_id uuid;
  v_kind text := case when p_visit_id is not null then 'visit' else 'day' end;
  v_lineage uuid;
  v_date date;
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'billing.approve') then
    raise exception 'You do not have permission to approve billing for this organization' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('approve_rounding_adjustment', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'adjustment_id')::uuid, (v_prior ->> 'base_minutes')::integer, (v_prior ->> 'proposed_minutes')::integer,
      (v_prior ->> 'adjustment_minutes')::integer, (v_prior ->> 'proposed_units')::numeric, (v_prior ->> 'capped')::boolean;
    return;
  end if;

  if v_kind = 'visit' then
    select a.lineage_id, v.service_date into v_lineage, v_date
    from ogevia.service_visits v join ogevia.client_authorizations a on a.id = v.service_authorization_id
    where v.id = p_visit_id and v.organization_id = p_organization_id;
  else
    v_lineage := p_lineage_id; v_date := p_service_date;
  end if;
  if v_lineage is null or v_date is null then
    raise exception 'Visit or day not found' using errcode = 'OGN04';
  end if;
  perform ogevia.lock_authorization_lineage(v_lineage);

  select * into v_unit from ogevia.rounding_units(p_organization_id, v_date, v_date) u
  where u.authorization_lineage_id = v_lineage and u.unit_kind = v_kind and (v_kind = 'day' or u.visit_id = p_visit_id);
  if v_unit.unit_key is null then
    raise exception 'Only Billing Ready visits can be rounded, under the policy basis in effect (% expected)',
      case when v_kind = 'visit' then 'a daily-total adjustment' else 'per-visit adjustments' end using errcode = 'OGC09';
  end if;
  select * into v_pol from ogevia.billing_rounding_policies p where p.id = v_unit.policy_id;
  if v_pol.id is null or v_pol.method = 'none' then
    raise exception 'No rounding policy is in effect for this payer and service on that date' using errcode = 'OGC09';
  end if;
  if v_unit.open_visits > 0 then
    raise exception 'This day still has visits that are open or in review; finish them before rounding the daily total' using errcode = 'OGC09';
  end if;
  if not v_unit.all_approved then
    raise exception 'Approve the visit minutes first; rounding is applied to approved minutes' using errcode = 'OGC09';
  end if;
  -- Never both bases on the same visits.
  if exists (select 1 from ogevia.billing_rounding_adjustments r where r.voided_at is null and r.covered_visit_ids && v_unit.covered_visit_ids) then
    raise exception 'A rounding adjustment already covers these visits; void it first' using errcode = 'OGC09';
  end if;

  select * into v_prop from ogevia.rounding_proposal(v_lineage, v_date, v_pol, v_unit.approved_minutes, true);
  if v_prop.proposed_minutes = v_unit.approved_minutes then
    raise exception 'No rounding adjustment: % approved minutes already fit the policy%', v_unit.approved_minutes,
      case when v_prop.capped then ' (the authorization leaves no room to round up)' else '' end using errcode = 'OGC09';
  end if;

  select a.hourly_rate_cents into v_rate from ogevia.service_visits v join ogevia.client_authorizations a on a.id = v.service_authorization_id
  where v.id = v_unit.covered_visit_ids[1];

  insert into ogevia.billing_rounding_adjustments (organization_id, unit_kind, visit_id, authorization_lineage_id, client_id, service_id,
    service_date, policy_id, covered_visit_ids, base_minutes, proposed_minutes, adjustment_minutes, capped_by_authorization,
    rate_cents, amount_cents, notes, approved_by)
  values (p_organization_id, v_kind, p_visit_id, v_lineage, v_unit.client_id, v_unit.service_id, v_date, v_pol.id, v_unit.covered_visit_ids,
    v_unit.approved_minutes, v_prop.proposed_minutes, v_prop.proposed_minutes - v_unit.approved_minutes, v_prop.capped,
    v_rate, case when v_rate is not null then round((v_prop.proposed_minutes - v_unit.approved_minutes) / 60.0 * v_rate)::integer end,
    nullif(btrim(coalesce(p_notes, '')), ''), v_actor)
  returning id into v_id;

  perform ogevia.write_audit(p_organization_id, 'billing.rounding_adjustment_approved', 'billing_rounding_adjustments', v_id, null,
    jsonb_build_object('unit', v_kind, 'service_date', v_date, 'covered_visits', v_unit.covered_visit_ids, 'policy_version', v_pol.version,
      'method', v_pol.method, 'increment_minutes', v_pol.increment_minutes, 'basis', v_pol.basis, 'base_minutes', v_unit.approved_minutes,
      'proposed_minutes', v_prop.proposed_minutes, 'adjustment_minutes', v_prop.proposed_minutes - v_unit.approved_minutes, 'capped', v_prop.capped),
    nullif(btrim(coalesce(p_notes, '')), ''));
  perform ogevia.idempotency_finish('approve_rounding_adjustment', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('adjustment_id', v_id, 'base_minutes', v_unit.approved_minutes, 'proposed_minutes', v_prop.proposed_minutes,
      'adjustment_minutes', v_prop.proposed_minutes - v_unit.approved_minutes,
      'proposed_units', round(v_prop.proposed_minutes::numeric / v_pol.increment_minutes, 2), 'capped', v_prop.capped));
  return query select v_id, v_unit.approved_minutes, v_prop.proposed_minutes, v_prop.proposed_minutes - v_unit.approved_minutes,
    round(v_prop.proposed_minutes::numeric / v_pol.increment_minutes, 2), v_prop.capped;
end;
$$;

create function ogevia_api.void_billing_rounding_adjustment(p_adjustment_id uuid, p_reason text, p_idempotency_key uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_row ogevia.billing_rounding_adjustments%rowtype;
  v_fp text := concat_ws('|', p_adjustment_id, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to void a rounding adjustment' using errcode = 'OGV22';
  end if;
  select * into v_row from ogevia.billing_rounding_adjustments r where r.id = p_adjustment_id for update;
  if v_row.id is null or not ogevia.is_active_member(v_row.organization_id) then
    raise exception 'Rounding adjustment not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_row.organization_id, 'billing.approve') then
    raise exception 'You do not have permission to void billing approvals for this organization' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('void_rounding_adjustment', p_idempotency_key, v_row.organization_id, v_fp);
  if v_prior is not null then
    return (v_prior ->> 'adjustment_id')::uuid;
  end if;
  if v_row.voided_at is not null then
    raise exception 'This rounding adjustment is already voided' using errcode = 'OGC09';
  end if;
  update ogevia.billing_rounding_adjustments set voided_at = now(), voided_by = v_actor, void_reason = btrim(p_reason) where id = v_row.id;
  perform ogevia.write_audit(v_row.organization_id, 'billing.rounding_adjustment_voided', 'billing_rounding_adjustments', v_row.id,
    jsonb_build_object('adjustment_minutes', v_row.adjustment_minutes, 'proposed_minutes', v_row.proposed_minutes),
    jsonb_build_object('voided', true), btrim(p_reason));
  perform ogevia.idempotency_finish('void_rounding_adjustment', p_idempotency_key, v_row.organization_id, v_fp,
    jsonb_build_object('adjustment_id', v_row.id));
  return v_row.id;
end;
$$;

create or replace function ogevia_api.list_monthly_service_summary(
  p_organization_id uuid,
  p_month_start date,
  p_client_id uuid default null
)
returns table (
  client_id uuid,
  client_code text,
  service_id uuid,
  service_code text,
  service_name text,
  authorization_lineage_id uuid,
  authorization_period_start date,
  authorization_period_end date,
  authorized_minutes integer,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  remaining_minutes integer,
  review_minutes integer,
  visit_count integer,
  reserved_minutes integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with bounds as (
    select
      date_trunc('month', p_month_start::timestamp)::date as month_start,
      (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as month_end
  ),
  ranked_authorizations as (
    select
      a.*,
      row_number() over (
        partition by a.lineage_id
        order by a.version_number desc
      ) as version_rank
    from ogevia.client_authorizations a
    cross join bounds b
    where a.organization_id = p_organization_id
      and (p_client_id is null or a.client_id = p_client_id)
      and a.deleted_at is null
      and a.period_start < b.month_end
      and a.period_end >= b.month_start
  ),
  authorizations as (
    select *
    from ranked_authorizations
    where version_rank = 1
  ),
  usage as (
    select
      va.lineage_id,
      coalesce(sum(v.worked_minutes), 0)::integer as worked_minutes,
      coalesce(sum(v.verified_minutes), 0)::integer as verified_minutes,
      coalesce(sum(v.billable_minutes), 0)::integer as billable_minutes,
      coalesce(sum(v.worked_minutes) filter (where v.status = 'administrator_review'), 0)::integer as review_minutes,
      count(*)::integer as visit_count
    from ogevia.service_visits v
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
    cross join bounds b
    where v.organization_id = p_organization_id
      and (p_client_id is null or v.client_id = p_client_id)
      and v.service_date >= b.month_start
      and v.service_date < b.month_end
      and v.status in ('signed', 'administrator_review')
    group by va.lineage_id
  ),
  -- Time held by assigned Care Request shifts that no signed visit has
  -- consumed yet (released when the linked visit is signed, 0013). The
  -- assignment cap counts it, so "remaining" must too.
  -- Approved billing rounding adjustments (0029) consume (or return) authorized time.
  adjusted as (
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.adjustment_minutes), 0)::integer as adjustment_minutes
    from ogevia.billing_rounding_adjustments r
    cross join bounds b
    where r.organization_id = p_organization_id and r.voided_at is null
      and r.service_date >= b.month_start and r.service_date < b.month_end
    group by r.authorization_lineage_id
  ),
  reserved as (
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.reserved_minutes), 0)::integer as reserved_minutes
    from ogevia.authorization_reservations r
    cross join bounds b
    where r.organization_id = p_organization_id
      and r.released_at is null
      and r.service_date >= b.month_start
      and r.service_date < b.month_end
    group by r.authorization_lineage_id
  )
  select
    c.id,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code),
    sv.id,
    sv.code,
    sv.name,
    a.lineage_id,
    a.period_start,
    a.period_end,
    a.monthly_authorized_minutes,
    coalesce(u.worked_minutes, 0),
    coalesce(u.verified_minutes, 0),
    coalesce(u.billable_minutes, 0),
    greatest(a.monthly_authorized_minutes - coalesce(u.billable_minutes, 0) - coalesce(ad.adjustment_minutes, 0) - coalesce(rs.reserved_minutes, 0), 0),
    coalesce(u.review_minutes, 0),
    coalesce(u.visit_count, 0),
    coalesce(rs.reserved_minutes, 0)
  from authorizations a
  join ogevia.clients c
    on c.id = a.client_id
   and c.organization_id = a.organization_id
  join ogevia.services sv
    on sv.id = a.service_id
   and sv.organization_id = a.organization_id
  left join usage u on u.lineage_id = a.lineage_id
  left join reserved rs on rs.lineage_id = a.lineage_id
  left join adjusted ad on ad.lineage_id = a.lineage_id
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
  order by sv.name, sv.code, a.period_start;
$$;

revoke all on function ogevia.round_minutes(integer, text, integer) from public;
revoke all on function ogevia.rounding_policy_for(uuid, text, uuid, date) from public;
revoke all on function ogevia.rounding_units(uuid, date, date) from public;
revoke all on function ogevia.rounding_proposal(uuid, date, ogevia.billing_rounding_policies, integer, boolean) from public;
revoke all on function ogevia_api.set_billing_rounding_policy(uuid, text, uuid, text, integer, text, text, date, date, text, uuid) from public;
revoke all on function ogevia_api.list_billing_rounding_policies(uuid) from public;
revoke all on function ogevia_api.list_billing_rounding_preview(uuid, date, date) from public;
revoke all on function ogevia_api.approve_billing_rounding_adjustment(uuid, uuid, uuid, date, text, uuid) from public;
revoke all on function ogevia_api.void_billing_rounding_adjustment(uuid, text, uuid) from public;
grant execute on function ogevia_api.set_billing_rounding_policy(uuid, text, uuid, text, integer, text, text, date, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_billing_rounding_policies(uuid) to ogevia_app;
grant execute on function ogevia_api.list_billing_rounding_preview(uuid, date, date) to ogevia_app;
grant execute on function ogevia_api.approve_billing_rounding_adjustment(uuid, uuid, uuid, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.void_billing_rounding_adjustment(uuid, text, uuid) to ogevia_app;
