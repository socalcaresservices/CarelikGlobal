begin;

-- Switches Service Verification's caregiver entry point from
-- assignment-based (list_service_verification_options, which requires a
-- pre-existing shift) to client-ID entry: the caregiver types or scans
-- the client's existing non-identifying client_code, the server
-- validates it and the covering authorization, and a visit is created
-- directly - no caregiver_assignments row required for this flow.
-- caregiver_assignments itself is untouched and still gates
-- /staff/visits self-service scheduling exactly as before; this is an
-- alternate entry point for Service Verification specifically, not a
-- replacement of that table or module.

-- ---------------------------------------------------------------------
-- 1. Security fix found while inspecting for this change: the
-- 'caregiver' role (and 'staff') currently hold clients.read, which lets
-- a caregiver directly `select * from clients` and see every client's
-- full name, phone, email, and address for the org - regardless of which
-- page they're nominally using. Hiding this behind page-level UI isn't
-- real security. Revoking it from 'caregiver' specifically (not 'staff',
-- which may serve other non-caregiving roles this codebase doesn't
-- explain) closes the direct-table-read path; the client_code-only
-- lookup below is the only client information a caregiver can retrieve
-- going forward.
-- ---------------------------------------------------------------------
delete from public.role_permissions where role = 'caregiver' and permission_key = 'clients.read';

-- ---------------------------------------------------------------------
-- 2. find_client_by_code: validates a client_code within the caller's
-- org and returns only the id and the same code back - never name, UCI,
-- medical ID, or any other identifying field. Rate-limited per caregiver
-- per org (5 failures / 10 minutes) using the existing audit_logs table
-- rather than a new one - failed and rate-limited attempts are logged
-- there as their own action types, which also means they show up
-- alongside every other audit trail an admin already knows how to read.
-- ---------------------------------------------------------------------
create or replace function public.find_client_by_code(
  target_organization_id uuid,
  target_client_code text
)
returns table (client_id uuid, client_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.clients%rowtype;
  recent_failures integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_organization_member(target_organization_id) then
    raise exception 'Not a member of this organization';
  end if;

  select count(*) into recent_failures
  from public.audit_logs
  where actor_user_id = auth.uid()
    and organization_id = target_organization_id
    and action = 'client_lookup.failed'
    and occurred_at > now() - interval '10 minutes';

  if recent_failures >= 5 then
    insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, source)
    values (target_organization_id, auth.uid(), 'client_lookup.rate_limited', 'clients', 'application');
    raise exception 'RATE_LIMITED: Too many attempts. Wait a few minutes or contact your administrator.';
  end if;

  select * into target from public.clients
  where organization_id = target_organization_id
    and lower(client_code) = lower(btrim(target_client_code))
    and deleted_at is null
    and status = 'active';

  if target.id is null then
    insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, source)
    values (target_organization_id, auth.uid(), 'client_lookup.failed', 'clients', 'application');
    raise exception 'NOT_FOUND: That client ID was not found or is not active.';
  end if;

  return query select target.id, target.client_code;
end;
$$;

revoke all on function public.find_client_by_code(uuid, text) from public, anon;
grant execute on function public.find_client_by_code(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. list_authorized_services_for_client: services + this-month usage
-- for a client the caller has already validated via find_client_by_code
-- - same usage math as list_client_authorizations/
-- list_my_schedulable_assignments, gated on org membership only (not an
-- admin permission), since knowing the client_code is what stands in
-- for authorization in this model.
-- ---------------------------------------------------------------------
create or replace function public.list_authorized_services_for_client(
  target_organization_id uuid,
  target_client_id uuid
)
returns table (
  service_id uuid,
  service_code text,
  service_name text,
  service_color text,
  authorization_id uuid,
  max_monthly_hours numeric,
  hours_used_this_month numeric,
  hours_scheduled_this_month numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sv.id, sv.code, sv.name, sv.color,
    a.id, a.max_monthly_hours,
    coalesce(usage.hours_used_this_month, 0),
    coalesce(usage.hours_scheduled_this_month, 0)
  from public.client_authorizations a
  join public.services sv on sv.id = a.service_id and sv.deleted_at is null
  left join lateral (
    select
      coalesce(sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
        filter (where s.status = 'completed'), 0) as hours_used_this_month,
      coalesce(sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
        filter (where s.status = 'scheduled'), 0) as hours_scheduled_this_month
    from (
      select
        greatest(date_trunc('month', now()), a.period_start::timestamptz) as window_start,
        least(date_trunc('month', now()) + interval '1 month', a.period_end::timestamptz + interval '1 day') as window_end
    ) w
    left join public.shifts s
      on s.client_id = a.client_id
     and s.service_id = a.service_id
     and s.organization_id = a.organization_id
     and s.status in ('completed', 'scheduled')
     and s.starts_at < w.window_end
     and s.ends_at > w.window_start
  ) usage on true
  where a.organization_id = target_organization_id
    and a.client_id = target_client_id
    and a.deleted_at is null
    and current_date between a.period_start and a.period_end
    and public.is_organization_member(target_organization_id)
  order by sv.name;
$$;

revoke all on function public.list_authorized_services_for_client(uuid, uuid) from public, anon;
grant execute on function public.list_authorized_services_for_client(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. start_service_visit_by_client_code: the new visit-start entry
-- point. Re-validates the client code and rate limit independently
-- (never trusts that a prior find_client_by_code call actually happened
-- client-side), resolves the covering authorization, and inserts
-- directly into service_visits with scheduled_shift_id left null -
-- everything downstream (end_service_visit, sign_service_visit,
-- correct_service_visit, void_service_visit, reports, printing) already
-- operates on service_visits.id alone and never assumed a shift exists,
-- so none of that needed to change.
-- ---------------------------------------------------------------------
create or replace function public.start_service_visit_by_client_code(
  target_organization_id uuid,
  target_client_code text,
  target_service_id uuid,
  visit_task_categories text[] default '{}',
  visit_service_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_client public.clients%rowtype;
  target_auth public.client_authorizations%rowtype;
  caregiver_name text;
  visit_id uuid;
  started_at timestamptz := now();
  recent_failures integer;
  org_slug text;
  new_visit_number text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_organization_member(target_organization_id) then
    raise exception 'Not a member of this organization';
  end if;

  select count(*) into recent_failures
  from public.audit_logs
  where actor_user_id = auth.uid()
    and organization_id = target_organization_id
    and action = 'client_lookup.failed'
    and occurred_at > now() - interval '10 minutes';
  if recent_failures >= 5 then
    raise exception 'RATE_LIMITED: Too many attempts. Wait a few minutes or contact your administrator.';
  end if;

  select * into target_client from public.clients
  where organization_id = target_organization_id
    and lower(client_code) = lower(btrim(target_client_code))
    and deleted_at is null
    and status = 'active';

  if target_client.id is null then
    insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, source)
    values (target_organization_id, auth.uid(), 'client_lookup.failed', 'clients', 'application');
    raise exception 'NOT_FOUND: That client ID was not found or is not active.';
  end if;

  select * into target_auth from public.client_authorizations
  where organization_id = target_organization_id
    and client_id = target_client.id
    and service_id = target_service_id
    and deleted_at is null
    and started_at::date between period_start and period_end
  order by period_start desc limit 1;

  if target_auth.id is null then
    raise exception 'No active authorization covers this client and service - contact your agency administrator';
  end if;

  select coalesce(display_name, 'Caregiver') into caregiver_name
  from public.user_profiles where id = auth.uid();

  select upper(left(regexp_replace(slug, '[^a-zA-Z0-9]', '', 'g'), 4)) into org_slug
  from public.organizations where id = target_organization_id;
  new_visit_number := coalesce(nullif(org_slug, ''), 'CLK') || '-V-' || to_char(started_at, 'YYYYMMDD')
    || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4));

  -- service_visits_billing_gate (before-insert trigger) independently
  -- enforces trial_expired/suspended below - not duplicated here.
  insert into public.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id,
    service_id, service_date, time_in, task_categories, service_notes,
    status, created_by, visit_number_snapshot
  ) values (
    target_organization_id, target_client.id, target_client.client_code,
    auth.uid(), coalesce(caregiver_name, 'Caregiver'),
    null, target_auth.id, target_service_id, started_at::date,
    started_at, coalesce(visit_task_categories, '{}'), nullif(trim(visit_service_notes), ''),
    'draft', auth.uid(), new_visit_number
  ) returning id into visit_id;

  return visit_id;
end;
$$;

revoke all on function public.start_service_visit_by_client_code(uuid, text, uuid, text[], text) from public, anon;
grant execute on function public.start_service_visit_by_client_code(uuid, text, uuid, text[], text) to authenticated;

commit;
