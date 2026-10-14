-- ROLLBACK 0050_wave1_visit_review_and_variance_rule | CLASS: SAFE AUTOMATED (refuses when records would be lost)
-- Refuses while any agency visit rule, any recorded rule evaluation, any unscheduled-visit reason or any attestation version
-- exists: those values cannot be represented before 0050. Otherwise it restores the six-argument start_ad_hoc_service_visit
-- (0042), the eight-argument confirm_service_visit (0006) and visit_review_reasons (0031), and drops the new tables, functions
-- and columns. Visits left in administrator_review by the new unscheduled or schedule-variance rules stay in review (their
-- status is a stored value); they are reviewed or closed through the existing review decisions.
do $$ begin
  if exists (select 1 from ogevia.agency_visit_rules) then
    raise exception 'ROLLBACK REFUSED: agency visit rules exist; export them first (they would be lost)';
  end if;
  if exists (select 1 from ogevia.visit_rule_evaluations) then
    raise exception 'ROLLBACK REFUSED: visit rule evaluations exist; export them first (they would be lost)';
  end if;
  if exists (select 1 from ogevia.service_visits where unscheduled_reason is not null) then
    raise exception 'ROLLBACK REFUSED: unscheduled-visit reasons exist; export them first (they would be lost)';
  end if;
  if exists (select 1 from ogevia.visit_confirmations where attestation_version is not null) then
    raise exception 'ROLLBACK REFUSED: attestation versions exist; export them first (they would be lost)';
  end if;
end $$;

drop function ogevia_api.get_visit_outcome(uuid);
drop function ogevia_api.confirm_service_visit(uuid, ogevia.visit_signer_role, text, uuid, text, text, text, uuid, text);
drop function ogevia_api.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text, uuid, text);
drop function ogevia_api.set_visit_rule(uuid, integer, date, text, uuid);
drop function ogevia_api.list_visit_rules(uuid);

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
         then 'over_authorization' end
  ], null)
  from ogevia.service_visits v
  left join ogevia.visit_confirmations c on c.visit_id = coalesce(v.original_visit_id, v.id)
  where v.id = p_visit_id and v.status = 'administrator_review';
$$;

drop function ogevia.effective_visit_variance_rule(uuid, date);
drop table ogevia.visit_rule_evaluations;
drop table ogevia.agency_visit_rules;
drop function ogevia.default_visit_variance_minutes();
alter table ogevia.visit_confirmations drop column attestation_version;
alter table ogevia.service_visits drop column unscheduled_reason;

create function ogevia_api.start_ad_hoc_service_visit(
  p_organization_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_task_categories text[] default '{}',
  p_service_notes text default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_started_at timestamptz := now();
  v_fingerprint text := concat_ws('|', p_organization_id, p_client_id, p_service_id);
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
    service_date, time_in, task_categories, service_notes, status, created_by, visit_number_snapshot
  ) values (
    p_organization_id, v_client.id,
    coalesce(nullif(btrim(v_client.caregiver_display_code), ''), v_client.client_code),
    v_actor, v_record.id, coalesce(v_name, 'Caregiver'), v_shift_id, v_auth.id, p_service_id,
    v_service_date, v_started_at, coalesce(p_task_categories, '{}'),
    nullif(btrim(p_service_notes), ''), 'draft', v_actor,
    coalesce(nullif(upper(left(regexp_replace(v_org.slug, '[^a-zA-Z0-9]', '', 'g'), 4)), ''), 'OGEV')
      || '-V-' || to_char(v_service_date, 'YYYYMMDD')
      || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4))
  ) returning id into v_visit_id;

  perform ogevia.write_audit(p_organization_id, 'service_visit.started', 'service_visits', v_visit_id,
    null, jsonb_build_object('status', 'draft', 'time_in', v_started_at,
                             'authorization_id', v_auth.id, 'service_id', p_service_id,
                             'scheduled_shift_id', v_shift_id));
  perform ogevia.idempotency_finish('start_visit', p_idempotency_key, p_organization_id, v_fingerprint,
    jsonb_build_object('visit_id', v_visit_id));
  return v_visit_id;
end;
$$;
revoke all on function ogevia_api.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text, uuid) from public;
grant execute on function ogevia_api.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text, uuid) to ogevia_app;

create function ogevia_api.confirm_service_visit(
  p_visit_id uuid,
  p_signer_role ogevia.visit_signer_role,
  p_confirmation_method text,
  p_evidence_id uuid default null,
  p_typed_signer_name text default null,
  p_signer_relationship text default null,
  p_confirmation_reason text default null,
  p_idempotency_key uuid default null
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

  if v_confirmed then
    v_allowed := v_potential;
    v_status := case when v_potential < v_visit.worked_minutes then 'administrator_review' else 'signed' end;
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
    confirmed_visit_snapshot, confirmation_version, confirmed_by, request_id
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
    4, v_actor, ogevia.current_request_id()
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
                       'billable_minutes', v_allowed, 'worked_minutes', v_visit.worked_minutes));

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
revoke all on function ogevia_api.confirm_service_visit(uuid, ogevia.visit_signer_role, text, uuid, text, text, text, uuid) from public;
grant execute on function ogevia_api.confirm_service_visit(uuid, ogevia.visit_signer_role, text, uuid, text, text, text, uuid) to ogevia_app;
