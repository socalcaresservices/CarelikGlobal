-- 0024 Assignment administration: which caregiver may serve which client for
-- which service, from a start date to an optional end date (agency local
-- dates, inclusive). Assignments are what visit start, the caregiver's client
-- list and care-request matching already check (caregiver_has_active_assignment,
-- 0003); this adds the screens' server side so no database commands are needed.
--
--   * assignments.manage (Administrator, manager).
--   * create_assignment: the caregiver must have a sign-in (assignments are
--     keyed by sign-in). The existing trigger still requires an active/ready
--     Care Team record, an active client and an active service. A second
--     assignment of the same caregiver to the same client and service with
--     overlapping dates is refused (no duplicate access); a transaction-level
--     advisory lock on that triple makes simultaneous attempts safe. An
--     assignment that has already ended cannot be added. The result says
--     whether a current authorization covers the client and service; the
--     office is told, the assignment is not silently refused (an authorization
--     may arrive later; visits are still checked against authorizations).
--   * end_assignment: with a reason. A future assignment is cancelled; a
--     running one gets an end date (only earlier than any existing end; to
--     extend, add a new assignment). Access stops after the end date. Refused
--     while that caregiver has a visit in progress for that client and service
--     if the end date is before today. Past visits are never changed.
--   * list_assignments: by client and/or caregiver, with state (current,
--     upcoming, ended) and authorization coverage. Client names only with
--     clients.names.read.

insert into ogevia.permissions (key, description) values
  ('assignments.manage', 'Assign caregivers to clients and services, and end assignments');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'assignments.manage'),
  ('manager', 'assignments.manage');

create function ogevia.authorization_covers(p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_from date, p_to date)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (
    select 1 from ogevia.client_authorizations a
    where a.organization_id = p_organization_id and a.client_id = p_client_id and a.service_id = p_service_id
      and a.is_current and a.deleted_at is null
      and a.period_start <= coalesce(p_to, p_from) and a.period_end >= p_from
  );
$$;

create function ogevia_api.list_assignments(p_organization_id uuid, p_client_id uuid default null, p_caregiver_record_id uuid default null)
returns table (
  assignment_id uuid, caregiver_record_id uuid, caregiver_code text, caregiver_name text,
  client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text,
  effective_start date, effective_end date, state text, has_authorization boolean, created_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id) and ogevia.has_permission(p_organization_id, 'visits.read') as can_list,
           ogevia.has_permission(p_organization_id, 'clients.names.read') as can_names,
           ogevia.organization_local_date(p_organization_id, now()) as today
  )
  select a.id, cr.id, cr.caregiver_code,
         coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name,
         c.id, c.client_code,
         case when ctx.can_names then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
         s.id, s.code, s.name, a.effective_start, a.effective_end,
         case when not a.is_active or (a.effective_end is not null and a.effective_end < ctx.today) then 'ended'
              when a.effective_start > ctx.today then 'upcoming'
              else 'current' end,
         ogevia.authorization_covers(p_organization_id, c.id, s.id, greatest(a.effective_start, ctx.today), a.effective_end),
         a.created_at
  from ctx
  join ogevia.caregiver_assignments a on a.organization_id = p_organization_id
  join ogevia.clients c on c.id = a.client_id
  join ogevia.services s on s.id = a.service_id
  left join ogevia.caregiver_records cr on cr.organization_id = a.organization_id and cr.linked_user_id = a.caregiver_user_id and cr.deleted_at is null
  left join ogevia.client_private_names n on n.client_id = c.id
  where ctx.actor is not null and ctx.can_list
    and (p_client_id is null or a.client_id = p_client_id)
    and (p_caregiver_record_id is null or cr.id = p_caregiver_record_id)
  order by case when not a.is_active or (a.effective_end is not null and a.effective_end < ctx.today) then 2
                when a.effective_start > ctx.today then 1 else 0 end,
           a.effective_start desc, c.client_code, s.code;
$$;

create function ogevia.assignment_admin_guard(p_organization_id uuid)
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
  if not ogevia.has_permission(p_organization_id, 'assignments.manage') then
    raise exception 'You do not have permission to manage assignments' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

create function ogevia_api.create_assignment(
  p_organization_id uuid, p_caregiver_record_id uuid, p_client_id uuid, p_service_id uuid,
  p_effective_start date, p_effective_end date default null, p_idempotency_key uuid default null
)
returns table (assignment_id uuid, has_authorization boolean)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.assignment_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_client_id, p_service_id, p_effective_start, p_effective_end);
  v_prior jsonb;
  v_user uuid;
  v_id uuid := gen_random_uuid();
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_covered boolean;
begin
  v_prior := ogevia.idempotency_begin('create_assignment', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'assignment_id')::uuid, (v_prior ->> 'has_authorization')::boolean;
    return;
  end if;
  if p_effective_start is null then raise exception 'Enter the start date' using errcode = 'OGV22'; end if;
  if p_effective_end is not null and p_effective_end < p_effective_start then
    raise exception 'The end date cannot be before the start date' using errcode = 'OGV22';
  end if;
  if p_effective_end is not null and p_effective_end < v_today then
    raise exception 'An assignment that has already ended cannot be added' using errcode = 'OGV22';
  end if;
  select r.linked_user_id into v_user from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if not found then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_user is null then
    raise exception 'This caregiver has no sign-in yet; they need one before they can be assigned' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'assignment', p_organization_id, v_user, p_client_id, p_service_id), 0));
  if exists (
    select 1 from ogevia.caregiver_assignments a
    where a.organization_id = p_organization_id and a.caregiver_user_id = v_user
      and a.client_id = p_client_id and a.service_id = p_service_id and a.is_active
      and daterange(a.effective_start, a.effective_end, '[]') && daterange(p_effective_start, p_effective_end, '[]')) then
    raise exception 'This caregiver is already assigned to this client and service for these dates' using errcode = 'OGC09';
  end if;
  insert into ogevia.caregiver_assignments (id, organization_id, caregiver_user_id, client_id, service_id, effective_start, effective_end)
  values (v_id, p_organization_id, v_user, p_client_id, p_service_id, p_effective_start, p_effective_end);
  v_covered := ogevia.authorization_covers(p_organization_id, p_client_id, p_service_id, greatest(p_effective_start, v_today), p_effective_end);
  perform ogevia.write_audit(p_organization_id, 'assignment.created', 'caregiver_assignments', v_id, null,
    jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'client_id', p_client_id, 'service_id', p_service_id,
                       'effective_start', p_effective_start, 'effective_end', p_effective_end, 'has_authorization', v_covered), null);
  perform ogevia.idempotency_finish('create_assignment', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('assignment_id', v_id, 'has_authorization', v_covered));
  return query select v_id, v_covered;
end;
$$;

create function ogevia_api.end_assignment(
  p_organization_id uuid, p_assignment_id uuid, p_end_date date, p_reason text, p_idempotency_key uuid default null
)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.assignment_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_assignment_id, p_end_date);
  v_prior jsonb;
  v_a ogevia.caregiver_assignments%rowtype;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_outcome text;
begin
  v_prior := ogevia.idempotency_begin('end_assignment', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'outcome'; end if;
  if length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason for ending the assignment' using errcode = 'OGV22';
  end if;
  select * into v_a from ogevia.caregiver_assignments a
  where a.id = p_assignment_id and a.organization_id = p_organization_id for update;
  if v_a.id is null then raise exception 'Assignment not found' using errcode = 'OGN04'; end if;
  if not v_a.is_active or (v_a.effective_end is not null and v_a.effective_end < v_today) then
    raise exception 'This assignment has already ended' using errcode = 'OGC09';
  end if;

  if v_a.effective_start > v_today then
    -- Not started yet: cancel it.
    update ogevia.caregiver_assignments set is_active = false, effective_end = effective_start, updated_at = now() where id = v_a.id;
    v_outcome := 'cancelled';
  else
    if p_end_date is null then raise exception 'Enter the last day of the assignment' using errcode = 'OGV22'; end if;
    if p_end_date < v_a.effective_start then
      raise exception 'The last day cannot be before the assignment started' using errcode = 'OGV22';
    end if;
    if v_a.effective_end is not null and p_end_date >= v_a.effective_end then
      raise exception 'The assignment already ends on or before that day; to extend it, add a new assignment' using errcode = 'OGV22';
    end if;
    if p_end_date < v_today and exists (
      select 1 from ogevia.service_visits v
      where v.organization_id = p_organization_id and v.status = 'draft' and v.caregiver_user_id = v_a.caregiver_user_id
        and v.client_id = v_a.client_id and v.service_id = v_a.service_id) then
      raise exception 'This caregiver has a visit in progress for this client and service; end or close it first' using errcode = 'OGC09';
    end if;
    update ogevia.caregiver_assignments
       set effective_end = p_end_date, is_active = (p_end_date >= v_today), updated_at = now()
     where id = v_a.id;
    v_outcome := case when p_end_date < v_today then 'ended' else 'ends_later' end;
  end if;
  perform ogevia.write_audit(p_organization_id, 'assignment.ended', 'caregiver_assignments', v_a.id,
    jsonb_build_object('effective_end', v_a.effective_end, 'is_active', v_a.is_active),
    jsonb_build_object('effective_end', case when v_outcome = 'cancelled' then v_a.effective_start else p_end_date end, 'outcome', v_outcome), v_reason);
  perform ogevia.idempotency_finish('end_assignment', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('outcome', v_outcome));
  return v_outcome;
end;
$$;

revoke all on function ogevia.authorization_covers(uuid, uuid, uuid, date, date) from public;
revoke all on function ogevia.assignment_admin_guard(uuid) from public;
revoke all on function ogevia_api.list_assignments(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.create_assignment(uuid, uuid, uuid, uuid, date, date, uuid) from public;
revoke all on function ogevia_api.end_assignment(uuid, uuid, date, text, uuid) from public;
grant execute on function ogevia_api.list_assignments(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.create_assignment(uuid, uuid, uuid, uuid, date, date, uuid) to ogevia_app;
grant execute on function ogevia_api.end_assignment(uuid, uuid, date, text, uuid) to ogevia_app;
