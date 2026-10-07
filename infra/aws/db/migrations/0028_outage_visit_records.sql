-- 0028 Outage visit records and reconciliation (outage continuity, blocker 7).
--
-- During an outage, visits are recorded on numbered outage visit records (the
-- numbers come from the agency's continuity pack, 0027). Afterwards a visit
-- manager enters each record ONCE:
--
--   * record_outage_visit (visits.manage):
--       - the number must have been issued to THIS agency, and must not have
--         been entered or marked unused before: a record is never counted twice;
--       - refused when it overlaps an existing visit, or another outage record,
--         for the same caregiver, or for the same client and service. This
--         catches a visit already captured in Ogevia before the outage began;
--       - stored as a normal visit, through the existing exception path:
--         status administrator_review, LOCKED, verified and billable minutes 0,
--         reported times marked as entered by the manager (time_out_entered_by,
--         time_out_reason "Outage record OUT-...") and an electronic
--         confirmation of "unable to confirm" whose reason states what the
--         paper form shows. It counts as review time against the authorization
--         and is NEVER Billing Ready by itself: the usual review (correction)
--         and the separate human billing approval still apply;
--       - an overlapping scheduled shift for the same caregiver, client and
--         service is linked and marked completed, as for a closed missed visit.
--   * mark_outage_number_unused (visits.manage): a spoiled or unused form is
--     closed with a reason, so the number can never be used later.
--   * list_outage_reconciliation: every issued number with its state
--     (entered / not used / MISSING), so a lost form is visible.
-- Times are agency-local date + clock times converted with the agency's time
-- zone; they are reported times, not server times, and are labelled so.
-- Every entry is audited and idempotent.

create table ogevia.outage_visit_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  outage_number integer not null check (outage_number >= 1),
  state text not null check (state in ('entered', 'not_used')),
  visit_id uuid unique references ogevia.service_visits(id),
  paper_confirmation text check (paper_confirmation in ('signature_on_form', 'verbal', 'unable_to_confirm', 'declined')),
  signer_name text,
  notes text,
  reason_not_used text,
  entered_by uuid not null references ogevia.app_users(id),
  entered_at timestamptz not null default now(),
  unique (organization_id, outage_number),
  check ((state = 'entered' and visit_id is not null and paper_confirmation is not null)
      or (state = 'not_used' and visit_id is null and length(btrim(coalesce(reason_not_used, ''))) > 0))
);
alter table ogevia.outage_visit_records enable row level security;
create trigger outage_visit_records_no_update before update on ogevia.outage_visit_records
for each row execute function ogevia.forbid_update();
create trigger outage_visit_records_no_delete before delete on ogevia.outage_visit_records
for each row execute function ogevia.forbid_delete();
create policy readonly_select on ogevia.outage_visit_records for select to ogevia_readonly using (true);
grant select on ogevia.outage_visit_records to ogevia_readonly;

create function ogevia.outage_guard(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'visits.manage') then
    raise exception 'Only a visit manager can enter outage visit records' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

-- Number issued to this agency, and not yet used. Caller holds the agency lock.
create function ogevia.outage_number_check(p_organization_id uuid, p_number integer)
returns void
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_prior ogevia.outage_visit_records%rowtype;
begin
  if p_number is null or not exists (
    select 1 from ogevia.continuity_exports e
    where e.organization_id = p_organization_id and p_number between e.outage_number_first and e.outage_number_last
  ) then
    raise exception 'Outage number OUT-% was not issued to this agency', lpad(coalesce(p_number, 0)::text, 6, '0') using errcode = 'OGV22';
  end if;
  select * into v_prior from ogevia.outage_visit_records r where r.organization_id = p_organization_id and r.outage_number = p_number;
  if v_prior.id is not null then
    raise exception 'Outage record OUT-% was already %', lpad(p_number::text, 6, '0'),
      case when v_prior.state = 'entered' then 'entered (visit ' || coalesce((select v.visit_number_snapshot from ogevia.service_visits v where v.id = v_prior.visit_id), '?') || ')'
           else 'marked not used' end
      using errcode = 'OGC09';
  end if;
end;
$$;

create function ogevia_api.record_outage_visit(
  p_organization_id uuid, p_outage_number integer, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid,
  p_local_date date, p_time_in time, p_time_out time, p_paper_confirmation text, p_signer_name text default null,
  p_notes text default null, p_idempotency_key uuid default null
)
returns table (visit_id uuid, visit_number text, worked_minutes integer, authorization_status text, outage_number integer)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.outage_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_outage_number, p_client_id, p_service_id, p_caregiver_record_id, p_local_date,
                         p_time_in, p_time_out, p_paper_confirmation, btrim(coalesce(p_signer_name, '')), btrim(coalesce(p_notes, '')));
  v_prior jsonb;
  v_tz text;
  v_in timestamptz;
  v_out timestamptz;
  v_minutes integer;
  v_client ogevia.clients%rowtype;
  v_service ogevia.services%rowtype;
  v_rec ogevia.caregiver_records%rowtype;
  v_auth ogevia.client_authorizations%rowtype;
  v_used bigint;
  v_status ogevia.visit_authorization_status;
  v_conf text := lower(btrim(coalesce(p_paper_confirmation, '')));
  v_signer text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_label text := 'OUT-' || lpad(coalesce(p_outage_number, 0)::text, 6, '0');
  v_reason text;
  v_shift uuid;
  v_conflict text;
  v_id uuid := gen_random_uuid();
  v_number text;
begin
  v_prior := ogevia.idempotency_begin('record_outage_visit', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'visit_id')::uuid, v_prior ->> 'visit_number', (v_prior ->> 'worked_minutes')::integer,
                        v_prior ->> 'authorization_status', (v_prior ->> 'outage_number')::integer;
    return;
  end if;
  if v_conf not in ('signature_on_form', 'verbal', 'unable_to_confirm', 'declined') then
    raise exception 'Choose what the outage record shows for the client''s confirmation' using errcode = 'OGV22';
  end if;
  if v_conf in ('signature_on_form', 'verbal') and v_signer is null then
    raise exception 'Enter the name of the person who signed or confirmed' using errcode = 'OGV22';
  end if;
  if p_local_date is null or p_time_in is null or p_time_out is null then
    raise exception 'Enter the date, Time In and Time Out from the outage record' using errcode = 'OGV22';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ogevia.continuity:' || p_organization_id::text, 0));
  perform ogevia.outage_number_check(p_organization_id, p_outage_number);

  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  v_in := (p_local_date + p_time_in) at time zone v_tz;
  v_out := (case when p_time_out <= p_time_in then p_local_date + 1 else p_local_date end + p_time_out) at time zone v_tz;
  v_minutes := floor(extract(epoch from (v_out - v_in)) / 60)::integer;
  if v_minutes < 1 or v_minutes > 1440 then
    raise exception 'A visit must be between 1 minute and 24 hours' using errcode = 'OGV22';
  end if;
  if v_out > now() then
    raise exception 'The Time Out cannot be in the future' using errcode = 'OGV22';
  end if;

  select * into v_client from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null;
  select * into v_service from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id and s.deleted_at is null;
  select * into v_rec from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_client.id is null or v_service.id is null or v_rec.id is null then
    raise exception 'The client, service and caregiver must belong to this agency' using errcode = 'OGV22';
  end if;
  select * into v_auth from ogevia.client_authorizations a
  where a.organization_id = p_organization_id and a.client_id = p_client_id and a.service_id = p_service_id
    and a.is_current and a.deleted_at is null and p_local_date between a.period_start and a.period_end;
  if v_auth.id is null then
    raise exception 'No current authorization covers this client and service on that date; keep the outage record for the office' using errcode = 'OGV22';
  end if;

  -- Duplicate and overlap protection against every visit (outage or not).
  select v.visit_number_snapshot into v_conflict from ogevia.service_visits v
  where v.organization_id = p_organization_id and v.status not in ('voided', 'corrected')
    and v.time_in < v_out and coalesce(v.time_out, now()) > v_in
    and ((v.caregiver_record_id = v_rec.id) or (v_rec.linked_user_id is not null and v.caregiver_user_id = v_rec.linked_user_id)
         or (v.client_id = p_client_id and v.service_id = p_service_id))
  order by v.time_in limit 1;
  if v_conflict is not null then
    raise exception 'This outage record overlaps visit % for the same caregiver or the same client and service. If it is the same visit, mark the number not used', v_conflict
      using errcode = 'OGC09';
  end if;

  perform ogevia.lock_authorization_lineage(v_auth.lineage_id);
  v_used := ogevia.authorization_month_usage(v_auth.lineage_id, p_local_date, null);
  v_status := case when v_used + v_minutes > v_auth.monthly_authorized_minutes then 'exceeds_authorization'
                   when v_used + v_minutes = v_auth.monthly_authorized_minutes then 'limit_reached'
                   else 'within_authorization' end;

  select s.id into v_shift from ogevia.shifts s
  where s.organization_id = p_organization_id and s.status = 'scheduled' and s.client_id = p_client_id and s.service_id = p_service_id
    and (s.caregiver_record_id = v_rec.id or (s.caregiver_record_id is null and s.caregiver_user_id = v_rec.linked_user_id))
    and s.starts_at < v_out and s.ends_at > v_in
    and not exists (select 1 from ogevia.service_visits x where x.scheduled_shift_id = s.id and x.status not in ('voided', 'corrected'))
  order by s.starts_at limit 1;

  v_reason := 'Outage record ' || v_label || ': times as written on the paper record, entered by the office after the outage';
  insert into ogevia.service_visits (
    id, organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_record_id, caregiver_name_snapshot,
    scheduled_shift_id, service_authorization_id, service_id, service_date, time_in, time_out, worked_minutes,
    verified_minutes, billable_minutes, service_notes, status, authorization_status, signed_at, locked_at,
    visit_number_snapshot, created_by, time_out_entered_by, time_out_reason
  ) values (
    v_id, p_organization_id, p_client_id, v_client.client_code, v_rec.linked_user_id, v_rec.id,
    coalesce(v_rec.preferred_name, v_rec.first_name) || ' ' || v_rec.last_name,
    v_shift, v_auth.id, p_service_id, p_local_date, v_in, v_out, v_minutes,
    0, 0, nullif(btrim(coalesce(p_notes, '')), ''), 'administrator_review', v_status, now(), now(),
    'pending', v_actor, v_actor, v_reason
  ) returning visit_number_snapshot into v_number;

  insert into ogevia.visit_confirmations (
    organization_id, visit_id, signer_role, confirmation_method, typed_signer_name, confirmation_reason,
    confirmed_visit_snapshot, confirmation_version, confirmed_by, request_id
  ) values (
    p_organization_id, v_id, 'client', 'unable_to_confirm', v_signer,
    'Ogevia was unavailable. ' || v_label || ' shows: ' ||
      case v_conf when 'signature_on_form' then 'signature on the paper form by ' || v_signer
                  when 'verbal' then 'verbal confirmation by ' || v_signer
                  when 'declined' then 'the client declined to confirm'
                  else 'no confirmation' end || '. Review the paper record before any billing.',
    jsonb_build_object('clientCode', v_client.client_code, 'caregiverName', coalesce(v_rec.preferred_name, v_rec.first_name) || ' ' || v_rec.last_name,
      'serviceName', v_service.name, 'serviceCode', v_service.code, 'serviceDate', p_local_date, 'timeIn', v_in, 'timeOut', v_out,
      'workedMinutes', v_minutes, 'verifiedMinutes', 0, 'billableMinutes', 0, 'timeZone', v_tz, 'confirmationVersion', 4,
      'outageRecord', v_label, 'paperConfirmation', v_conf, 'authorizationId', v_auth.id, 'authorizationLineageId', v_auth.lineage_id,
      'monthToDateBeforeMinutes', v_used, 'authorizedMinutes', v_auth.monthly_authorized_minutes),
    4, v_actor, ogevia.current_request_id()
  );

  if v_shift is not null then
    update ogevia.shifts sh set status = 'completed', updated_at = now() where sh.id = v_shift and sh.status = 'scheduled';
  end if;

  insert into ogevia.outage_visit_records (organization_id, outage_number, state, visit_id, paper_confirmation, signer_name, notes, entered_by)
  values (p_organization_id, p_outage_number, 'entered', v_id, v_conf, v_signer, nullif(btrim(coalesce(p_notes, '')), ''), v_actor);

  perform ogevia.write_audit(p_organization_id, 'service_visit.outage_recorded', 'service_visits', v_id, null,
    jsonb_build_object('outage_record', v_label, 'time_in', v_in, 'time_out', v_out, 'worked_minutes', v_minutes,
                       'status', 'administrator_review', 'authorization_status', v_status, 'paper_confirmation', v_conf,
                       'scheduled_shift_id', v_shift), v_reason);
  perform ogevia.idempotency_finish('record_outage_visit', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('visit_id', v_id, 'visit_number', v_number, 'worked_minutes', v_minutes,
                       'authorization_status', v_status, 'outage_number', p_outage_number));
  return query select v_id, v_number, v_minutes, v_status::text, p_outage_number;
end;
$$;

create function ogevia_api.mark_outage_number_unused(p_organization_id uuid, p_outage_number integer, p_reason text, p_idempotency_key uuid default null)
returns table (outage_number integer, state text)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.outage_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_outage_number, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_id uuid;
begin
  v_prior := ogevia.idempotency_begin('mark_outage_number_unused', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'outage_number')::integer, v_prior ->> 'state';
    return;
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required (for example: form spoiled, number skipped)' using errcode = 'OGV22';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ogevia.continuity:' || p_organization_id::text, 0));
  perform ogevia.outage_number_check(p_organization_id, p_outage_number);
  insert into ogevia.outage_visit_records (organization_id, outage_number, state, reason_not_used, entered_by)
  values (p_organization_id, p_outage_number, 'not_used', btrim(p_reason), v_actor) returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'outage_number.not_used', 'outage_visit_records', v_id, null,
    jsonb_build_object('outage_record', 'OUT-' || lpad(p_outage_number::text, 6, '0')), btrim(p_reason));
  perform ogevia.idempotency_finish('mark_outage_number_unused', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('outage_number', p_outage_number, 'state', 'not_used'));
  return query select p_outage_number, 'not_used'::text;
end;
$$;

create function ogevia_api.list_outage_reconciliation(p_organization_id uuid, p_open_only boolean default false)
returns table (
  outage_number integer, issued_at timestamptz, state text, visit_id uuid, visit_number text, client_code text,
  caregiver_name text, service_date date, time_in timestamptz, time_out timestamptz, worked_minutes integer,
  visit_status text, authorization_status text, paper_confirmation text, reason_not_used text, entered_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select n.num, e.created_at, coalesce(r.state, 'missing'), v.id, v.visit_number_snapshot, v.client_code_snapshot,
         v.caregiver_name_snapshot, v.service_date, v.time_in, v.time_out, v.worked_minutes, v.status::text,
         v.authorization_status::text, r.paper_confirmation, r.reason_not_used, r.entered_at
  from (select ogevia.outage_guard(p_organization_id) as actor) g
  join ogevia.continuity_exports e on e.organization_id = p_organization_id
  cross join lateral generate_series(e.outage_number_first, e.outage_number_last) as n(num)
  left join ogevia.outage_visit_records r on r.organization_id = p_organization_id and r.outage_number = n.num
  left join ogevia.service_visits v on v.id = r.visit_id
  where g.actor is not null and (not coalesce(p_open_only, false) or r.id is null)
  order by n.num;
$$;

revoke all on function ogevia.outage_guard(uuid) from public;
revoke all on function ogevia.outage_number_check(uuid, integer) from public;
revoke all on function ogevia_api.record_outage_visit(uuid, integer, uuid, uuid, uuid, date, time, time, text, text, text, uuid) from public;
revoke all on function ogevia_api.mark_outage_number_unused(uuid, integer, text, uuid) from public;
revoke all on function ogevia_api.list_outage_reconciliation(uuid, boolean) from public;
grant execute on function ogevia_api.record_outage_visit(uuid, integer, uuid, uuid, uuid, date, time, time, text, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.mark_outage_number_unused(uuid, integer, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_outage_reconciliation(uuid, boolean) to ogevia_app;
