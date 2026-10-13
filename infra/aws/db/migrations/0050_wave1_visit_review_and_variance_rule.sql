-- 0050 Wave 1, part 1: visits that need a person's review, and the agency's schedule-variance rule.
--
-- Owner decisions (2026-10-13): D-U unscheduled visits go to review for every caregiver; D-S the schedule-variance
-- threshold is a per-agency, effective-dated, versioned setting (default: a conservative system value, no Off option);
-- O-2 a visit held for review keeps its normal capped billable minutes and cannot be approved until it is reviewed;
-- O-3 "Declined" needs no new schema value (it is sent as unable_to_confirm with a reason, no change here).
--
-- Before (verified in the repository, 2026-10-13):
--   * A confirmed visit with no scheduled shift was 'signed' (Billing Ready) like any other (0030 header).
--   * start_ad_hoc_service_visit (0042) took no reason; confirm_service_visit (0006) recorded no attestation wording version.
--   * No schedule-variance rule existed. ogevia.visit_review_reasons (0031) knew only no_client_signature and over_authorization.
--
-- Changes:
--   * service_visits.unscheduled_reason (additive, nullable): why a visit started without a shift (required, 3 to 500 chars).
--   * visit_confirmations.attestation_version (additive, nullable): the wording version the caregiver attested to; set by the
--     API, never by the browser. Existing rows stay NULL ("Not recorded").
--   * agency_visit_rules (append-only): versioned rule per agency with an effective date, who changed it, when and why.
--     visit_rule_evaluations (append-only): the rule version and minutes each visit was evaluated under.
--   * ogevia.effective_visit_variance_rule: the agency's latest version effective on a date, else system default version 0.
--     The default (ogevia.default_visit_variance_minutes) is an UNVERIFIED placeholder, not a payer rule.
--   * ogevia_api.list_visit_rules / set_visit_rule: read (visits.read) and change (organization.update) the rule. A change
--     never takes effect before today and never changes a visit that was already evaluated.
--   * start_ad_hoc_service_visit: new trailing parameter p_unscheduled_reason; the old six-argument form is dropped so the
--     reason cannot be bypassed. No shift match and no reason: refused.
--   * confirm_service_visit: new trailing parameter p_attestation_version; an unscheduled visit, or a scheduled visit whose
--     length differs from its shift by more than the rule, goes to administrator_review even when signed (billable minutes
--     kept, capped by the authorization). The evaluation is recorded.
--   * visit_review_reasons: adds 'unscheduled' and 'schedule_variance'.
--   * ogevia_api.get_visit_outcome: read-only result for the caregiver's last screen and the review page.
-- Not changed: correct_service_visit (a manager correction is already a recorded human act), authorization arithmetic,
-- reservations, billing approval, and every stored row.

alter table ogevia.service_visits
  add column unscheduled_reason text
  check (unscheduled_reason is null or length(btrim(unscheduled_reason)) between 3 and 500);
alter table ogevia.visit_confirmations
  add column attestation_version text
  check (attestation_version is null or length(attestation_version) between 1 and 40);

create function ogevia.default_visit_variance_minutes()
returns integer
language sql
immutable
set search_path = ogevia, pg_temp
as $$ select 15 $$;

create table ogevia.agency_visit_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  version integer not null check (version >= 1),
  minutes integer not null check (minutes between 1 and 240),
  effective_from date not null,
  changed_by uuid not null references ogevia.app_users(id),
  changed_at timestamptz not null default now(),
  reason text check (reason is null or length(reason) <= 500),
  request_id uuid,
  unique (organization_id, version)
);
create index agency_visit_rules_org_idx on ogevia.agency_visit_rules (organization_id, effective_from desc, version desc);
create trigger agency_visit_rules_no_update before update on ogevia.agency_visit_rules
for each row execute function ogevia.forbid_update();
create trigger agency_visit_rules_no_delete before delete on ogevia.agency_visit_rules
for each row execute function ogevia.forbid_delete();
alter table ogevia.agency_visit_rules enable row level security;
create policy readonly_select on ogevia.agency_visit_rules for select to ogevia_readonly using (true);
grant select on ogevia.agency_visit_rules to ogevia_readonly;

create table ogevia.visit_rule_evaluations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  rule_key text not null check (rule_key = 'schedule_variance_minutes'),
  rule_version integer not null check (rule_version >= 0),
  rule_minutes integer not null check (rule_minutes between 1 and 240),
  rule_source text not null check (rule_source in ('agency_setting', 'system_default')),
  scheduled_minutes integer,
  worked_minutes integer not null,
  outcome text not null check (outcome in ('within', 'over', 'not_applicable')),
  evaluated_at timestamptz not null default now(),
  unique (visit_id, rule_key)
);
create index visit_rule_evaluations_org_idx on ogevia.visit_rule_evaluations (organization_id, evaluated_at desc);
create trigger visit_rule_evaluations_no_update before update on ogevia.visit_rule_evaluations
for each row execute function ogevia.forbid_update();
create trigger visit_rule_evaluations_no_delete before delete on ogevia.visit_rule_evaluations
for each row execute function ogevia.forbid_delete();
alter table ogevia.visit_rule_evaluations enable row level security;
create policy readonly_select on ogevia.visit_rule_evaluations for select to ogevia_readonly using (true);
grant select on ogevia.visit_rule_evaluations to ogevia_readonly;

create function ogevia.effective_visit_variance_rule(p_organization_id uuid, p_date date)
returns table (version integer, minutes integer, source text)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  with a as (
    select r.version, r.minutes, 'agency_setting'::text as source
    from ogevia.agency_visit_rules r
    where r.organization_id = p_organization_id and r.effective_from <= p_date
    order by r.effective_from desc, r.version desc
    limit 1
  )
  select a.version, a.minutes, a.source from a
  union all
  select 0, ogevia.default_visit_variance_minutes(), 'system_default'::text where not exists (select 1 from a);
$$;

create function ogevia_api.list_visit_rules(p_organization_id uuid)
returns table (
  version integer, minutes integer, source text, effective_from date,
  changed_by_name text, changed_at timestamptz, reason text, in_effect boolean
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.organization_local_date(p_organization_id, now()) as today
    where ogevia.require_actor() is not null
      and ogevia.is_active_member(p_organization_id)
      and ogevia.has_permission(p_organization_id, 'visits.read')
  ), cur as (
    select e.version from ctx, ogevia.effective_visit_variance_rule(p_organization_id, ctx.today) e
  )
  select 0, ogevia.default_visit_variance_minutes(), 'system_default'::text, null::date,
         null::text, null::timestamptz, null::text, (select version from cur) = 0
  from ctx
  union all
  select r.version, r.minutes, 'agency_setting'::text, r.effective_from, u.display_name, r.changed_at, r.reason,
         r.version = (select version from cur)
  from ctx
  join ogevia.agency_visit_rules r on r.organization_id = p_organization_id
  left join ogevia.app_users u on u.id = r.changed_by
  order by 1 desc;
$$;

create function ogevia_api.set_visit_rule(
  p_organization_id uuid,
  p_minutes integer,
  p_effective_from date default null,
  p_reason text default null,
  p_idempotency_key uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_today date;
  v_from date;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_fingerprint text;
  v_prior jsonb;
  v_version integer;
  v_cur record;
  v_id uuid;
begin
  if not ogevia.is_active_member(p_organization_id)
     or not ogevia.has_permission(p_organization_id, 'organization.update') then
    raise exception 'Only an administrator can change visit rules' using errcode = 'OGA03';
  end if;
  v_today := ogevia.organization_local_date(p_organization_id, now());
  v_from := coalesce(p_effective_from, v_today);
  v_fingerprint := concat_ws('|', p_organization_id, p_minutes, v_from, v_reason);
  perform pg_advisory_xact_lock(hashtextextended('ogevia.visit_rules:' || p_organization_id::text, 0));
  v_prior := ogevia.idempotency_begin('set_visit_rule', p_idempotency_key, p_organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'version')::integer;
  end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 240 then
    raise exception 'Enter minutes between 1 and 240' using errcode = 'OGV22';
  end if;
  if v_from < v_today then
    raise exception 'A change takes effect today or later. It never changes visits already evaluated.' using errcode = 'OGV22';
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'The reason is too long (500 characters at most)' using errcode = 'OGV22';
  end if;
  select * into v_cur from ogevia.effective_visit_variance_rule(p_organization_id, v_from);
  if v_cur.source = 'agency_setting' and v_cur.minutes = p_minutes then
    raise exception 'That is already the rule in effect' using errcode = 'OGC09';
  end if;
  select coalesce(max(r.version), 0) + 1 into v_version from ogevia.agency_visit_rules r where r.organization_id = p_organization_id;
  insert into ogevia.agency_visit_rules (organization_id, version, minutes, effective_from, changed_by, reason, request_id)
  values (p_organization_id, v_version, p_minutes, v_from, v_actor, v_reason, ogevia.current_request_id())
  returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'visit_rule.changed', 'agency_visit_rules', v_id,
    jsonb_build_object('version', v_cur.version, 'minutes', v_cur.minutes, 'source', v_cur.source),
    jsonb_build_object('version', v_version, 'minutes', p_minutes, 'effective_from', v_from), v_reason);
  perform ogevia.idempotency_finish('set_visit_rule', p_idempotency_key, p_organization_id, v_fingerprint,
    jsonb_build_object('version', v_version));
  return v_version;
end;
$$;
revoke all on function ogevia_api.list_visit_rules(uuid) from public;
grant execute on function ogevia_api.list_visit_rules(uuid) to ogevia_app;
revoke all on function ogevia_api.set_visit_rule(uuid, integer, date, text, uuid) from public;
grant execute on function ogevia_api.set_visit_rule(uuid, integer, date, text, uuid) to ogevia_app;

-- Why a visit is in review, from its own record (never from the browser). Adds unscheduled and schedule_variance.
create or replace function ogevia.visit_review_reasons(p_visit_id uuid)
returns text[]
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select array_remove(array[
    case when coalesce(c.confirmation_method, '') not in ('draw', 'assisted_mark') then 'no_client_signature' end,
    case when v.authorization_status = 'exceeds_authorization'
           or (v.billable_minutes < v.worked_minutes and c.confirmation_method in ('draw', 'assisted_mark'))
         then 'over_authorization' end,
    case when v.scheduled_shift_id is null then 'unscheduled' end,
    case when e.outcome = 'over' then 'schedule_variance' end
  ], null)
  from ogevia.service_visits v
  left join ogevia.visit_confirmations c on c.visit_id = coalesce(v.original_visit_id, v.id)
  left join ogevia.visit_rule_evaluations e on e.visit_id = v.id and e.rule_key = 'schedule_variance_minutes'
  where v.id = p_visit_id and v.status = 'administrator_review';
$$;

-- Start a visit. The six-argument form is dropped so a start cannot skip the reason.
drop function ogevia_api.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text, uuid);
create function ogevia_api.start_ad_hoc_service_visit(
  p_organization_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_task_categories text[] default '{}',
  p_service_notes text default null,
  p_idempotency_key uuid default null,
  p_unscheduled_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_started_at timestamptz := now();
  v_fingerprint text := concat_ws('|', p_organization_id, p_client_id, p_service_id, nullif(btrim(coalesce(p_unscheduled_reason, '')), ''));
  v_reason text := nullif(btrim(coalesce(p_unscheduled_reason, '')), '');
  v_prior jsonb;
  v_client ogevia.clients%rowtype;
  v_auth ogevia.client_authorizations%rowtype;
  v_record ogevia.caregiver_records%rowtype;
  v_org ogevia.organizations%rowtype;
  v_is_caregiver boolean;
  v_can_manage boolean;
  v_service_date date;
  v_name text;
  v_visit_id uuid;
  v_shift_id uuid;
begin
  select * into v_org from ogevia.organizations o where o.id = p_organization_id and o.status = 'active';
  if v_org.id is null then
    raise exception 'Organization is not active' using errcode = 'OGA03';
  end if;
  v_is_caregiver := ogevia.is_active_caregiver(p_organization_id);
  v_can_manage := ogevia.has_permission(p_organization_id, 'visits.manage');
  if not v_is_caregiver and not v_can_manage then
    raise exception 'Only an active caregiver or visit manager can start a visit' using errcode = 'OGA03';
  end if;

  -- Serialize starts per caller; with the partial unique indexes this makes
  -- double taps and concurrent starts safe.
  perform pg_advisory_xact_lock(hashtextextended('ogevia.start:' || v_actor::text, 0));

  v_prior := ogevia.idempotency_begin('start_visit', p_idempotency_key, p_organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'visit_id')::uuid;
  end if;

  if exists (
    select 1 from ogevia.service_visits v
    where v.caregiver_user_id = v_actor and v.status in ('draft', 'awaiting_signature')
  ) then
    raise exception 'Finish your current visit before starting another client' using errcode = 'OGC09';
  end if;

  if not v_can_manage
     and not ogevia.caregiver_has_active_assignment(p_organization_id, p_client_id, p_service_id)
     and not ogevia.caregiver_has_current_shift(p_organization_id, p_client_id, p_service_id) then
    raise exception 'This client and service are not assigned to you' using errcode = 'OGA03';
  end if;

  select * into v_client from ogevia.clients c
  where c.id = p_client_id and c.organization_id = p_organization_id
    and c.deleted_at is null and c.status = 'active';
  if v_client.id is null then
    raise exception 'Client not found or inactive' using errcode = 'OGN04';
  end if;
  if not exists (
    select 1 from ogevia.services sv
    where sv.id = p_service_id and sv.organization_id = p_organization_id
      and sv.deleted_at is null and sv.is_active
  ) then
    raise exception 'Service not found or inactive' using errcode = 'OGN04';
  end if;

  v_service_date := ogevia.organization_local_date(p_organization_id, v_started_at);
  -- M-1 fix: CURRENT version only.
  select * into v_auth
  from ogevia.resolve_current_authorization(p_organization_id, p_client_id, p_service_id, v_service_date);
  if v_auth.id is null then
    raise exception 'No active authorization covers this client and service' using errcode = 'OGC09';
  end if;

  select cr.* into v_record
  from ogevia.caregiver_records cr
  where cr.organization_id = p_organization_id and cr.linked_user_id = v_actor and cr.deleted_at is null
  order by case when cr.status in ('active', 'ready') then 0 else 1 end, cr.updated_at desc
  limit 1;
  if v_is_caregiver and (v_record.id is null or v_record.status not in ('active', 'ready')) then
    raise exception 'Your Care Team profile is not active. Contact your agency manager before starting a visit.'
      using errcode = 'OGA03';
  end if;

  select coalesce(
    nullif(btrim(concat_ws(' ', coalesce(v_record.preferred_name, v_record.first_name), v_record.last_name)), ''),
    nullif(btrim(u.display_name), ''),
    'Caregiver'
  ) into v_name
  from ogevia.app_users u where u.id = v_actor;

  -- Link the visit to the caregiver's own scheduled shift for this client and
  -- service when one is in progress or about to start (server-side only).
  v_shift_id := ogevia.match_scheduled_shift_for_visit(
    p_organization_id, v_record.id, v_actor, p_client_id, p_service_id, v_started_at);

  -- 0050 (D-U): without a scheduled shift the visit is provisional and a reason is required (for every caregiver).
  -- The shift is never invented; the visit stays unlinked and is reviewed.
  if v_shift_id is null and (v_reason is null or length(v_reason) < 3) then
    raise exception 'A reason is required to start a visit without a scheduled shift' using errcode = 'OGV22';
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'The reason is too long (500 characters at most)' using errcode = 'OGV22';
  end if;

  -- A new visit by a caregiver needs verified, current CPR/TB (and service approval when Service checks are On), also when it starts
  -- through a standing assignment. Visits already in progress and manager-started visits are not touched.
  if v_is_caregiver and v_record.id is not null then
    perform ogevia.lock_caregiver(v_record.id);
    perform ogevia.assert_ready_for_work(p_organization_id, v_record.id, p_service_id, v_started_at,
      greatest(coalesce((select sh.ends_at from ogevia.shifts sh where sh.id = v_shift_id), v_started_at), v_started_at) + interval '1 minute',
      'visit_start', p_client_id);
  end if;

  insert into ogevia.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_record_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id, service_id,
    service_date, time_in, task_categories, service_notes, status, created_by, visit_number_snapshot, unscheduled_reason
  ) values (
    p_organization_id, v_client.id,
    coalesce(nullif(btrim(v_client.caregiver_display_code), ''), v_client.client_code),
    v_actor, v_record.id, coalesce(v_name, 'Caregiver'), v_shift_id, v_auth.id, p_service_id,
    v_service_date, v_started_at, coalesce(p_task_categories, '{}'),
    nullif(btrim(p_service_notes), ''), 'draft', v_actor,
    coalesce(nullif(upper(left(regexp_replace(v_org.slug, '[^a-zA-Z0-9]', '', 'g'), 4)), ''), 'OGEV')
      || '-V-' || to_char(v_service_date, 'YYYYMMDD')
      || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4)),
    case when v_shift_id is null then v_reason end
  ) returning id into v_visit_id;

  perform ogevia.write_audit(p_organization_id, 'service_visit.started', 'service_visits', v_visit_id,
    null, jsonb_build_object('status', 'draft', 'time_in', v_started_at,
                             'authorization_id', v_auth.id, 'service_id', p_service_id,
                             'scheduled_shift_id', v_shift_id, 'unscheduled', v_shift_id is null),
    case when v_shift_id is null then v_reason end);
  perform ogevia.idempotency_finish('start_visit', p_idempotency_key, p_organization_id, v_fingerprint,
    jsonb_build_object('visit_id', v_visit_id));
  return v_visit_id;
end;
$$;
revoke all on function ogevia_api.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text, uuid, text) from public;
grant execute on function ogevia_api.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text, uuid, text) to ogevia_app;

-- Confirm a visit. The eight-argument form is dropped so the attestation parameter cannot be bypassed by an older call shape.
drop function ogevia_api.confirm_service_visit(uuid, ogevia.visit_signer_role, text, uuid, text, text, text, uuid);
create function ogevia_api.confirm_service_visit(
  p_visit_id uuid,
  p_signer_role ogevia.visit_signer_role,
  p_confirmation_method text,
  p_evidence_id uuid default null,
  p_typed_signer_name text default null,
  p_signer_relationship text default null,
  p_confirmation_reason text default null,
  p_idempotency_key uuid default null,
  p_attestation_version text default null
)
returns table (
  visit_id uuid,
  status ogevia.service_visit_status,
  authorization_status ogevia.visit_authorization_status,
  worked_minutes integer,
  billable_minutes integer,
  month_to_date_minutes bigint,
  remaining_minutes bigint
)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_bound ogevia.client_authorizations%rowtype;
  v_current ogevia.client_authorizations%rowtype;
  v_service ogevia.services%rowtype;
  v_method text := lower(btrim(coalesce(p_confirmation_method, '')));
  v_signer_name text := nullif(btrim(coalesce(p_typed_signer_name, '')), '');
  v_relationship text := nullif(btrim(coalesce(p_signer_relationship, '')), '');
  v_reason text := nullif(btrim(coalesce(p_confirmation_reason, '')), '');
  v_fingerprint text;
  v_prior jsonb;
  v_confirmed boolean;
  v_prior_minutes bigint;
  v_cap integer;
  v_potential integer;
  v_allowed integer;
  v_auth_status ogevia.visit_authorization_status;
  v_status ogevia.service_visit_status;
  v_timezone text;
  v_response jsonb;
  v_attest text := nullif(btrim(coalesce(p_attestation_version, '')), '');
  v_unsched boolean;
  v_shift ogevia.shifts%rowtype;
  v_rule record;
  v_sched_minutes integer;
  v_variance boolean := false;
begin
  if v_method not in ('draw', 'typed', 'verbal', 'assisted_mark', 'unable_to_confirm') then
    raise exception 'Choose a valid confirmation method' using errcode = 'OGV22';
  end if;
  v_fingerprint := concat_ws('|', p_visit_id, p_signer_role, v_method, p_evidence_id, v_signer_name, v_reason);

  select * into v_visit from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if v_visit.caregiver_user_id is distinct from v_actor then
    raise exception 'Only the caregiver who recorded this visit can submit its client confirmation'
      using errcode = 'OGA03';
  end if;

  v_prior := ogevia.idempotency_begin('confirm_visit', p_idempotency_key, v_visit.organization_id, v_fingerprint);
  if v_prior is not null then
    return query select (v_prior ->> 'visit_id')::uuid,
      (v_prior ->> 'status')::ogevia.service_visit_status,
      (v_prior ->> 'authorization_status')::ogevia.visit_authorization_status,
      (v_prior ->> 'worked_minutes')::integer, (v_prior ->> 'billable_minutes')::integer,
      (v_prior ->> 'month_to_date_minutes')::bigint, (v_prior ->> 'remaining_minutes')::bigint;
    return;
  end if;

  if v_visit.status <> 'awaiting_signature' then
    raise exception 'Visit is already locked or is not ready for confirmation' using errcode = 'OGC09';
  end if;

  v_confirmed := v_method in ('draw', 'assisted_mark');
  if v_confirmed then
    -- The evidence must be this visit's MOST RECENT registered upload.
    if p_evidence_id is null or p_evidence_id is distinct from (
      select e.id from ogevia.visit_evidence e
      where e.visit_id = v_visit.id order by e.registered_at desc, e.id desc limit 1
    ) then
      raise exception 'A signature or mark is required' using errcode = 'OGV22';
    end if;
  elsif p_evidence_id is not null then
    raise exception 'Evidence applies only to drawn signatures and assisted marks' using errcode = 'OGV22';
  elsif v_method in ('typed', 'verbal') and v_signer_name is null then
    raise exception 'Enter the name of the person confirming the visit' using errcode = 'OGV22';
  elsif v_method = 'unable_to_confirm' and v_reason is null then
    raise exception 'Explain why confirmation could not be obtained' using errcode = 'OGV22';
  end if;

  select * into v_bound from ogevia.client_authorizations a where a.id = v_visit.service_authorization_id;
  perform ogevia.lock_authorization_lineage(v_bound.lineage_id);
  -- M-1 fix: cap from the CURRENT version of the visit's lineage that covers
  -- the service date; usage across the whole lineage.
  select * into v_current
  from ogevia.client_authorizations a
  where a.lineage_id = v_bound.lineage_id and a.is_current and a.deleted_at is null
    and v_visit.service_date between a.period_start and a.period_end;

  v_prior_minutes := ogevia.authorization_month_usage(v_bound.lineage_id, v_visit.service_date, v_visit.id);
  if v_current.id is null then
    -- An amendment removed coverage for this date: nothing is billable until
    -- an administrator reviews it.
    v_cap := 0;
  else
    v_cap := v_current.monthly_authorized_minutes;
  end if;
  v_potential := greatest(0, least(v_visit.worked_minutes::bigint, v_cap - v_prior_minutes))::integer;

  if v_potential < v_visit.worked_minutes then
    v_auth_status := 'exceeds_authorization';
  elsif v_prior_minutes + v_potential >= v_cap then
    v_auth_status := 'limit_reached';
  else
    v_auth_status := 'within_authorization';
  end if;

  -- 0050 (D-U): a visit with no scheduled shift is provisional and goes to review, whoever the caregiver is.
  -- 0050 (D-S): a scheduled visit whose length differs from the shift by more than the agency's rule (versioned,
  -- effective-dated; a conservative system default applies when the agency has set none) goes to review.
  -- Billable minutes are kept in both cases (capped by the authorization as before); approval waits for a review decision.
  v_unsched := v_visit.scheduled_shift_id is null;
  select * into v_rule from ogevia.effective_visit_variance_rule(v_visit.organization_id, v_visit.service_date);
  if not v_unsched then
    select * into v_shift from ogevia.shifts sh where sh.id = v_visit.scheduled_shift_id;
    v_sched_minutes := floor(extract(epoch from (v_shift.ends_at - v_shift.starts_at)) / 60)::integer;
    v_variance := abs(v_visit.worked_minutes - v_sched_minutes) > v_rule.minutes;
  end if;

  if v_confirmed then
    v_allowed := v_potential;
    v_status := case when v_potential < v_visit.worked_minutes or v_unsched or v_variance
                     then 'administrator_review' else 'signed' end;
  else
    -- No client signature/mark: zero billable, administrator review.
    v_allowed := 0;
    v_status := 'administrator_review';
  end if;

  select * into v_service from ogevia.services s where s.id = v_visit.service_id;
  select coalesce(o.timezone, 'America/Los_Angeles') into v_timezone
  from ogevia.organizations o where o.id = v_visit.organization_id;

  insert into ogevia.visit_confirmations (
    organization_id, visit_id, signer_role, confirmation_method, evidence_id,
    typed_signer_name, signer_relationship, confirmation_reason,
    confirmed_visit_snapshot, confirmation_version, confirmed_by, request_id, attestation_version
  ) values (
    v_visit.organization_id, v_visit.id, p_signer_role, v_method,
    case when v_confirmed then p_evidence_id end,
    v_signer_name, v_relationship, v_reason,
    jsonb_build_object(
      'clientCode', v_visit.client_code_snapshot,
      'caregiverName', v_visit.caregiver_name_snapshot,
      'serviceName', v_service.name,
      'serviceCode', v_service.code,
      'serviceDate', v_visit.service_date,
      'timeIn', v_visit.time_in,
      'timeOut', v_visit.time_out,
      'workedMinutes', v_visit.worked_minutes,
      'verifiedMinutes', case when v_confirmed then v_visit.worked_minutes else 0 end,
      'billableMinutes', v_allowed,
      'signerRole', p_signer_role,
      'confirmationMethod', v_method,
      'caregiverAttestedAt', v_visit.caregiver_attested_at,
      'timeZone', v_timezone,
      'confirmationVersion', 4,
      'authorizationId', coalesce(v_current.id, v_bound.id),
      'authorizationLineageId', v_bound.lineage_id,
      'monthToDateBeforeMinutes', v_prior_minutes,
      'monthToDateAfterMinutes', v_prior_minutes + v_allowed,
      'authorizedMinutes', v_cap,
      'remainingMinutes', greatest(0, v_cap - v_prior_minutes - v_allowed)
    ),
    4, v_actor, ogevia.current_request_id(), v_attest
  );

  insert into ogevia.visit_rule_evaluations (
    organization_id, visit_id, rule_key, rule_version, rule_minutes, rule_source, scheduled_minutes, worked_minutes, outcome
  ) values (
    v_visit.organization_id, v_visit.id, 'schedule_variance_minutes', v_rule.version, v_rule.minutes, v_rule.source,
    v_sched_minutes, v_visit.worked_minutes,
    case when v_unsched then 'not_applicable' when v_variance then 'over' else 'within' end
  );

  update ogevia.service_visits sv
  set verified_minutes = case when v_confirmed then v_visit.worked_minutes else 0 end,
      billable_minutes = v_allowed,
      status = v_status,
      authorization_status = v_auth_status,
      service_authorization_id = coalesce(v_current.id, v_bound.id),
      signed_at = now(),
      locked_at = now()
  where sv.id = v_visit.id;

  perform ogevia.write_audit(v_visit.organization_id, 'service_visit.confirmed', 'service_visits', v_visit.id,
    jsonb_build_object('status', 'awaiting_signature', 'authorization_id', v_bound.id),
    jsonb_build_object('status', v_status, 'authorization_status', v_auth_status,
                       'authorization_id', coalesce(v_current.id, v_bound.id),
                       'confirmation_method', v_method, 'evidence_id', p_evidence_id,
                       'billable_minutes', v_allowed, 'worked_minutes', v_visit.worked_minutes,
                       'unscheduled', v_unsched, 'schedule_variance', v_variance,
                       'rule_version', v_rule.version, 'attestation_version', v_attest));

  v_response := jsonb_build_object(
    'visit_id', v_visit.id, 'status', v_status, 'authorization_status', v_auth_status,
    'worked_minutes', v_visit.worked_minutes, 'billable_minutes', v_allowed,
    'month_to_date_minutes', v_prior_minutes + v_allowed,
    'remaining_minutes', greatest(0, v_cap - v_prior_minutes - v_allowed));
  perform ogevia.idempotency_finish('confirm_visit', p_idempotency_key, v_visit.organization_id,
    v_fingerprint, v_response);

  return query select v_visit.id, v_status, v_auth_status, v_visit.worked_minutes, v_allowed,
    v_prior_minutes + v_allowed, greatest(0, v_cap - v_prior_minutes - v_allowed);
end;
$$;
revoke all on function ogevia_api.confirm_service_visit(uuid, ogevia.visit_signer_role, text, uuid, text, text, text, uuid, text) from public;
grant execute on function ogevia_api.confirm_service_visit(uuid, ogevia.visit_signer_role, text, uuid, text, text, text, uuid, text) to ogevia_app;

-- The result of a submitted visit, for the caregiver's last screen and the review page. Read only.
create function ogevia_api.get_visit_outcome(p_visit_id uuid)
returns table (
  visit_id uuid, status ogevia.service_visit_status, worked_minutes integer, verified_minutes integer,
  billable_minutes integer, authorization_status ogevia.visit_authorization_status, confirmation_method text,
  confirmation_reason text, review_reasons text[], unscheduled_reason text, attestation_version text,
  rule_version integer, rule_minutes integer, rule_source text, rule_outcome text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select v.id, v.status, v.worked_minutes, v.verified_minutes, v.billable_minutes, v.authorization_status,
         c.confirmation_method, c.confirmation_reason,
         coalesce(ogevia.visit_review_reasons(v.id), array[]::text[]),
         v.unscheduled_reason, c.attestation_version,
         e.rule_version, e.rule_minutes, e.rule_source, e.outcome
  from ogevia.service_visits v
  left join ogevia.visit_confirmations c on c.visit_id = coalesce(v.original_visit_id, v.id)
  left join ogevia.visit_rule_evaluations e on e.visit_id = v.id and e.rule_key = 'schedule_variance_minutes'
  where v.id = p_visit_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(v.organization_id)
    and (v.caregiver_user_id = ogevia.require_actor() or ogevia.has_permission(v.organization_id, 'visits.read'));
$$;
revoke all on function ogevia_api.get_visit_outcome(uuid) from public;
grant execute on function ogevia_api.get_visit_outcome(uuid) to ogevia_app;
