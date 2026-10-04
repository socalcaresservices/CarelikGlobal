-- ROLLBACK 0025_invitations_planned_assignments | CLASS: SAFE AUTOMATED (refuses when records would be lost)
-- Refuses while any invitation or planned assignment (no sign-in yet) exists:
-- those records cannot be represented before 0025. Otherwise restores the
-- 0003/0023/0024 definitions. Linked sign-ins, memberships and assignments
-- made through invitations stay (they are valid pre-0025 rows).
do $$ begin
  if exists (select 1 from ogevia.caregiver_invitations) then
    raise exception 'ROLLBACK REFUSED: caregiver invitations exist; export them first (they would be lost)';
  end if;
  if exists (select 1 from ogevia.caregiver_assignments where caregiver_user_id is null) then
    raise exception 'ROLLBACK REFUSED: planned assignments without a sign-in exist; end them or export them first';
  end if;
end $$;

drop trigger if exists caregiver_records_sync_assignment_access on ogevia.caregiver_records;
drop function if exists ogevia.sync_record_assignment_access();
drop function if exists ogevia_api.note_my_sign_in();
drop function if exists ogevia_api.record_invitation_resent(uuid, uuid);
drop function if exists ogevia_api.begin_invitation_resend(uuid, uuid);
drop function if exists ogevia_api.complete_caregiver_invitation(uuid, uuid, text, text, boolean);
drop function if exists ogevia_api.begin_caregiver_invitation(uuid, uuid, text);
drop function if exists ogevia.normalize_invitation_email(text);
drop table if exists ogevia.caregiver_invitations;

drop trigger caregiver_assignments_assert_valid on ogevia.caregiver_assignments;
create or replace function ogevia.assert_valid_caregiver_assignment()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if not new.is_active then
    return new;
  end if;
  if not exists (
    select 1
    from ogevia.organization_memberships m
    join ogevia.caregiver_records cr
      on cr.organization_id = m.organization_id
     and cr.linked_user_id = m.user_id
     and cr.deleted_at is null
     and cr.status in ('active', 'ready')
    where m.organization_id = new.organization_id
      and m.user_id = new.caregiver_user_id
      and m.role = 'caregiver'
      and m.status in ('active', 'invited')
  ) then
    raise exception 'Assign an active Care Team record with a linked caregiver login' using errcode = 'OGV22';
  end if;
  if not exists (
    select 1 from ogevia.clients c
    where c.id = new.client_id and c.organization_id = new.organization_id
      and c.deleted_at is null and c.status = 'active'
  ) then
    raise exception 'The client must be active in this organization' using errcode = 'OGV22';
  end if;
  if not exists (
    select 1 from ogevia.services s
    where s.id = new.service_id and s.organization_id = new.organization_id
      and s.deleted_at is null and s.is_active
  ) then
    raise exception 'The service must be active in this organization' using errcode = 'OGV22';
  end if;
  return new;
end;
$$;
create trigger caregiver_assignments_assert_valid
before insert or update of organization_id, caregiver_user_id, client_id, service_id, is_active
on ogevia.caregiver_assignments
for each row execute function ogevia.assert_valid_caregiver_assignment();

drop function ogevia_api.list_caregivers(uuid);
create function ogevia_api.list_caregivers(p_organization_id uuid)
returns table (
  caregiver_record_id uuid, caregiver_code text, first_name text, last_name text, preferred_name text, status text,
  has_sign_in boolean, sign_in_status text, active_assignments integer, open_visits integer, updated_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select cr.id, cr.caregiver_code, cr.first_name, cr.last_name, cr.preferred_name, cr.status,
         cr.linked_user_id is not null,
         m.status::text,
         (select count(*)::integer from ogevia.caregiver_assignments a
           where a.organization_id = cr.organization_id and a.caregiver_user_id = cr.linked_user_id and a.is_active
             and (a.effective_end is null or a.effective_end >= ogevia.organization_local_date(cr.organization_id, now()))),
         (select count(*)::integer from ogevia.service_visits v
           where v.organization_id = cr.organization_id and v.status = 'draft'
             and (v.caregiver_record_id = cr.id or (cr.linked_user_id is not null and v.caregiver_user_id = cr.linked_user_id))),
         cr.updated_at
  from ogevia.caregiver_records cr
  left join ogevia.organization_memberships m on m.organization_id = cr.organization_id and m.user_id = cr.linked_user_id and m.role = 'caregiver'
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
    and cr.organization_id = p_organization_id and cr.deleted_at is null
  order by case cr.status when 'active' then 0 when 'ready' then 1 when 'onboarding' then 2 else 3 end, lower(cr.last_name), lower(cr.first_name);
$$;

drop function ogevia_api.list_assignments(uuid, uuid, uuid);
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

drop function ogevia_api.create_assignment(uuid, uuid, uuid, uuid, date, date, uuid);
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

create or replace function ogevia_api.set_caregiver_status(
  p_organization_id uuid, p_caregiver_record_id uuid, p_status text, p_reason text, p_idempotency_key uuid default null
)
returns table (ended_assignments integer, sign_in_status text)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_status);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_ended integer := 0;
  v_sign_in text;
begin
  v_prior := ogevia.idempotency_begin('set_caregiver_status', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'ended_assignments')::integer, v_prior ->> 'sign_in_status';
    return;
  end if;
  if p_status is null or p_status not in ('onboarding', 'ready', 'active', 'inactive') then
    raise exception 'Choose a status' using errcode = 'OGV22';
  end if;
  if length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason for the status change' using errcode = 'OGV22';
  end if;
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status = p_status then raise exception 'The caregiver already has this status' using errcode = 'OGC09'; end if;

  if p_status = 'inactive' then
    if exists (select 1 from ogevia.service_visits v where v.organization_id = p_organization_id and v.status = 'draft'
               and (v.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and v.caregiver_user_id = v_rec.linked_user_id))) then
      raise exception 'This caregiver has a visit in progress; end or close it first' using errcode = 'OGC09';
    end if;
    if v_rec.linked_user_id is not null then
      update ogevia.caregiver_assignments a
         set is_active = false, effective_end = greatest(a.effective_start, v_today), updated_at = now()
       where a.organization_id = p_organization_id and a.caregiver_user_id = v_rec.linked_user_id and a.is_active;
      get diagnostics v_ended = row_count;
      update ogevia.organization_memberships m set status = 'suspended', updated_at = now()
       where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver' and m.status = 'active';
    end if;
  elsif v_rec.status = 'inactive' and v_rec.linked_user_id is not null then
    update ogevia.organization_memberships m set status = 'active', updated_at = now()
     where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver' and m.status = 'suspended';
  end if;
  update ogevia.caregiver_records set status = p_status, updated_at = now() where id = v_rec.id;
  select m.status::text into v_sign_in from ogevia.organization_memberships m
   where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver';
  perform ogevia.write_audit(p_organization_id, 'caregiver.status_changed', 'caregiver_records', v_rec.id,
    jsonb_build_object('status', v_rec.status),
    jsonb_build_object('status', p_status, 'ended_assignments', v_ended, 'sign_in_status', v_sign_in), v_reason);
  perform ogevia.idempotency_finish('set_caregiver_status', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('ended_assignments', v_ended, 'sign_in_status', v_sign_in));
  return query select v_ended, v_sign_in;
end;
$$;

alter table ogevia.caregiver_assignments drop constraint caregiver_assignments_has_caregiver;
alter table ogevia.caregiver_assignments alter column caregiver_user_id set not null;
drop index if exists ogevia.caregiver_assignments_record_idx;
alter table ogevia.caregiver_assignments drop constraint caregiver_assignments_record_fk;
alter table ogevia.caregiver_assignments drop column caregiver_record_id;

revoke all on function ogevia_api.list_caregivers(uuid) from public;
revoke all on function ogevia_api.list_assignments(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.create_assignment(uuid, uuid, uuid, uuid, date, date, uuid) from public;
grant execute on function ogevia_api.list_caregivers(uuid) to ogevia_app;
grant execute on function ogevia_api.list_assignments(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.create_assignment(uuid, uuid, uuid, uuid, date, date, uuid) to ogevia_app;
