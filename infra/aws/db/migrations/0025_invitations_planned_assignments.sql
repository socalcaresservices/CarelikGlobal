-- 0025 Caregiver invitations and planned assignments.
--
-- Planning is separated from access:
--   * An assignment now belongs to a Care Team RECORD (caregiver_record_id).
--     It can be prepared before the caregiver has a sign-in ("planned"). A
--     planned assignment grants nothing: every access check (visit start, the
--     caregiver's client list, care-request matching) still compares
--     caregiver_assignments.caregiver_user_id with the signed-in person, and a
--     planned assignment has none.
--   * Access is granted automatically, and only, when the record has a linked
--     sign-in AND is ready or active: caregiver_user_id is then filled for the
--     record's assignments that have not ended. If the record goes back to
--     onboarding, access is withdrawn again (caregiver_user_id cleared on
--     assignments that have not ended; ended history is never rewritten).
--     Making a caregiver inactive ends planned assignments too.
--   * Visit start is unchanged: it still needs the authenticated caregiver's
--     own assignment or scheduled shift, and authorization checks still apply.
--   * Existing assignments keep their sign-in and gain their record id
--     (backfill); none loses access.
--
-- Invitations (caregivers.manage: Administrator, manager):
--   * The API creates the Cognito user (email only; Cognito emails the
--     temporary password; it is never returned, stored or logged) and then
--     calls complete_caregiver_invitation, which can ONLY create a caregiver
--     membership in the caller's own agency. It refuses a sign-in that already
--     has any other role in this agency, a disabled account, or one already
--     linked to another Care Team record. No role can be raised here.
--   * Resend is allowed only until the first sign-in. Invite and resend are
--     audited (no email address in the audit row; it is kept on the
--     invitation for staff to see and for resend).
--   * First sign-in is recorded the first time the person loads the app
--     (note_my_sign_in from GET /v1/me): Cognito issues no token before the
--     temporary password has been changed, so any API call proves setup done.

-- ---------------------------------------------------------------------------
-- Assignments keyed by Care Team record
-- ---------------------------------------------------------------------------
alter table ogevia.caregiver_assignments add column caregiver_record_id uuid;
alter table ogevia.caregiver_assignments
  add constraint caregiver_assignments_record_fk
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id);
alter table ogevia.caregiver_assignments alter column caregiver_user_id drop not null;

update ogevia.caregiver_assignments a
   set caregiver_record_id = cr.id
  from ogevia.caregiver_records cr
 where cr.organization_id = a.organization_id and cr.linked_user_id = a.caregiver_user_id
   and cr.deleted_at is null and a.caregiver_record_id is null;

alter table ogevia.caregiver_assignments
  add constraint caregiver_assignments_has_caregiver
  check (caregiver_user_id is not null or caregiver_record_id is not null);
create index caregiver_assignments_record_idx
  on ogevia.caregiver_assignments (organization_id, caregiver_record_id) where is_active;

create or replace function ogevia.assert_valid_caregiver_assignment()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
begin
  -- Rows inserted by sign-in only (older scripts) get their Care Team record.
  if new.caregiver_record_id is null and new.caregiver_user_id is not null then
    select r.id into new.caregiver_record_id from ogevia.caregiver_records r
    where r.organization_id = new.organization_id and r.linked_user_id = new.caregiver_user_id and r.deleted_at is null;
  end if;
  if not new.is_active then
    return new;
  end if;
  if new.caregiver_record_id is not null then
    select * into v_rec from ogevia.caregiver_records r
    where r.id = new.caregiver_record_id and r.organization_id = new.organization_id and r.deleted_at is null;
    if v_rec.id is null or v_rec.status = 'inactive' then
      raise exception 'Assign a Care Team record that is not inactive' using errcode = 'OGV22';
    end if;
    if new.caregiver_user_id is not null and (
         v_rec.linked_user_id is distinct from new.caregiver_user_id
         or v_rec.status not in ('active', 'ready')
         or not exists (select 1 from ogevia.organization_memberships m
                        where m.organization_id = new.organization_id and m.user_id = new.caregiver_user_id
                          and m.role = 'caregiver' and m.status in ('active', 'invited'))) then
      raise exception 'Assign an active Care Team record with a linked caregiver login' using errcode = 'OGV22';
    end if;
  elsif not exists (
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

drop trigger caregiver_assignments_assert_valid on ogevia.caregiver_assignments;
create trigger caregiver_assignments_assert_valid
before insert or update of organization_id, caregiver_user_id, caregiver_record_id, client_id, service_id, is_active
on ogevia.caregiver_assignments
for each row execute function ogevia.assert_valid_caregiver_assignment();

-- The one rule that turns a planned assignment into access (and back).
create function ogevia.sync_record_assignment_access()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare
  v_today date := ogevia.organization_local_date(new.organization_id, now());
  v_user uuid := case when new.deleted_at is null and new.status in ('active', 'ready')
                       and exists (select 1 from ogevia.organization_memberships m
                                   where m.organization_id = new.organization_id and m.user_id = new.linked_user_id
                                     and m.role = 'caregiver' and m.status in ('active', 'invited'))
                      then new.linked_user_id end;
begin
  if new.status = 'inactive' then
    -- Planned assignments end with the record (linked ones are ended by set_caregiver_status).
    update ogevia.caregiver_assignments a
       set is_active = false, effective_end = greatest(a.effective_start, v_today), updated_at = now()
     where a.organization_id = new.organization_id and a.caregiver_record_id = new.id
       and a.is_active and a.caregiver_user_id is null;
    return new;
  end if;
  update ogevia.caregiver_assignments a
     set caregiver_user_id = v_user, updated_at = now()
   where a.organization_id = new.organization_id and a.caregiver_record_id = new.id and a.is_active
     and (a.effective_end is null or a.effective_end >= v_today)
     and a.caregiver_user_id is distinct from v_user;
  return new;
end;
$$;

create trigger caregiver_records_sync_assignment_access
after update of linked_user_id, status, deleted_at on ogevia.caregiver_records
for each row
when (old.linked_user_id is distinct from new.linked_user_id
      or old.status is distinct from new.status
      or old.deleted_at is distinct from new.deleted_at)
execute function ogevia.sync_record_assignment_access();

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------
create table ogevia.caregiver_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  user_id uuid not null references ogevia.app_users(id),
  email text not null check (length(email) <= 254),
  existing_account boolean not null,
  invited_by uuid not null references ogevia.app_users(id),
  invited_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  send_count integer not null default 1 check (send_count >= 1),
  first_signed_in_at timestamptz,
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  unique (organization_id, caregiver_record_id)
);
create index caregiver_invitations_pending_user_idx on ogevia.caregiver_invitations (user_id) where first_signed_in_at is null;
alter table ogevia.caregiver_invitations enable row level security;

create function ogevia.normalize_invitation_email(p_email text)
returns text
language plpgsql
immutable
set search_path = ogevia, pg_temp
as $$
declare v text := lower(btrim(coalesce(p_email, '')));
begin
  if length(v) > 254 or v !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$' then
    raise exception 'Enter a valid email address' using errcode = 'OGV22';
  end if;
  return v;
end;
$$;

-- Step 1 (before Cognito is called): may this caregiver be invited at this email?
create function ogevia_api.begin_caregiver_invitation(p_organization_id uuid, p_caregiver_record_id uuid, p_email text)
returns text
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_email text := ogevia.normalize_invitation_email(p_email);
  v_rec ogevia.caregiver_records%rowtype;
begin
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status = 'inactive' then
    raise exception 'This caregiver is inactive; reactivate them before inviting' using errcode = 'OGC09';
  end if;
  if v_rec.linked_user_id is not null then
    raise exception 'This caregiver already has a sign-in' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.caregiver_invitations i
             where i.organization_id = p_organization_id and i.email = v_email and i.caregiver_record_id <> v_rec.id) then
    raise exception 'That email is already used by another caregiver in this agency' using errcode = 'OGC09';
  end if;
  return v_email;
end;
$$;

-- Step 2 (after Cognito returned the person's sub): link them, as a caregiver only.
create function ogevia_api.complete_caregiver_invitation(
  p_organization_id uuid, p_caregiver_record_id uuid, p_email text, p_cognito_sub text, p_existing_account boolean
)
returns table (invitation_id uuid, existing_account boolean)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_email text := ogevia.normalize_invitation_email(p_email);
  v_rec ogevia.caregiver_records%rowtype;
  v_user ogevia.app_users%rowtype;
  v_member ogevia.organization_memberships%rowtype;
  v_inv uuid;
begin
  if p_cognito_sub is null or p_cognito_sub !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Invalid sign-in identifier' using errcode = 'OGV22';
  end if;
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status = 'inactive' then
    raise exception 'This caregiver is inactive; reactivate them before inviting' using errcode = 'OGC09';
  end if;
  if v_rec.linked_user_id is not null then
    raise exception 'This caregiver already has a sign-in' using errcode = 'OGC09';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cognito_sub|' || p_cognito_sub, 0));
  select * into v_user from ogevia.app_users u where u.cognito_sub = p_cognito_sub;
  if v_user.id is null then
    insert into ogevia.app_users (cognito_sub) values (p_cognito_sub) returning * into v_user;
  elsif v_user.status <> 'active' then
    raise exception 'That sign-in is disabled' using errcode = 'OGC09';
  end if;

  select * into v_member from ogevia.organization_memberships m
  where m.organization_id = p_organization_id and m.user_id = v_user.id for update;
  if v_member.id is not null and v_member.role <> 'caregiver' then
    -- Never turn a staff sign-in into (or alongside) a caregiver one.
    raise exception 'That email already signs in to this agency with a staff role; caregivers need their own sign-in' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.caregiver_records r
             where r.organization_id = p_organization_id and r.linked_user_id = v_user.id and r.deleted_at is null) then
    raise exception 'That sign-in is already linked to another caregiver in this agency' using errcode = 'OGC09';
  end if;
  if v_member.id is null then
    insert into ogevia.organization_memberships (organization_id, user_id, role, status)
    values (p_organization_id, v_user.id, 'caregiver', 'active');
  elsif v_member.status in ('revoked', 'suspended') then
    raise exception 'That sign-in was removed from this agency; ask the Administrator to review it' using errcode = 'OGC09';
  elsif v_member.status = 'invited' then
    update ogevia.organization_memberships set status = 'active', updated_at = now() where id = v_member.id;
  end if;

  update ogevia.caregiver_records set linked_user_id = v_user.id, updated_at = now() where id = v_rec.id;

  insert into ogevia.caregiver_invitations (organization_id, caregiver_record_id, user_id, email, existing_account, invited_by)
  values (p_organization_id, v_rec.id, v_user.id, v_email, coalesce(p_existing_account, false), v_actor)
  on conflict (organization_id, caregiver_record_id) do update
    set user_id = excluded.user_id, email = excluded.email, existing_account = excluded.existing_account,
        invited_by = excluded.invited_by, invited_at = now(), last_sent_at = now(), send_count = 1, first_signed_in_at = null
  returning id into v_inv;

  perform ogevia.write_audit(p_organization_id, 'caregiver.invited', 'caregiver_records', v_rec.id, null,
    jsonb_build_object('invitation_id', v_inv, 'existing_account', coalesce(p_existing_account, false), 'role', 'caregiver'), null);
  return query select v_inv, coalesce(p_existing_account, false);
end;
$$;

-- Resend: only while the person has not signed in yet. Returns the email to resend to.
create function ogevia_api.begin_invitation_resend(p_organization_id uuid, p_caregiver_record_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_inv ogevia.caregiver_invitations%rowtype;
begin
  select i.* into v_inv from ogevia.caregiver_invitations i
  join ogevia.caregiver_records r on r.id = i.caregiver_record_id and r.organization_id = i.organization_id
   and r.deleted_at is null and r.linked_user_id = i.user_id
  where i.organization_id = p_organization_id and i.caregiver_record_id = p_caregiver_record_id;
  if v_inv.id is null then raise exception 'This caregiver has not been invited' using errcode = 'OGN04'; end if;
  if v_inv.first_signed_in_at is not null then
    raise exception 'This caregiver has already signed in; if they are locked out they can reset their sign-in from the sign-in page' using errcode = 'OGC09';
  end if;
  if v_inv.existing_account then
    raise exception 'This caregiver already had a sign-in; ask them to sign in with it, or reset it from the sign-in page' using errcode = 'OGC09';
  end if;
  return v_inv.email;
end;
$$;

create function ogevia_api.record_invitation_resent(p_organization_id uuid, p_caregiver_record_id uuid)
returns integer
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_inv uuid;
  v_count integer;
begin
  update ogevia.caregiver_invitations i
     set last_sent_at = now(), send_count = i.send_count + 1
   where i.organization_id = p_organization_id and i.caregiver_record_id = p_caregiver_record_id
     and i.first_signed_in_at is null
  returning i.id, i.send_count into v_inv, v_count;
  if v_inv is null then raise exception 'This caregiver has no pending invitation' using errcode = 'OGC09'; end if;
  perform ogevia.write_audit(p_organization_id, 'caregiver.invitation_resent', 'caregiver_records', p_caregiver_record_id, null,
    jsonb_build_object('invitation_id', v_inv, 'send_count', v_count), null);
  return v_count;
end;
$$;

-- Called on app load: the first call after the temporary password was changed marks first sign-in.
create function ogevia_api.note_my_sign_in()
returns void
language sql
security definer
set search_path = ogevia, pg_temp
as $$
  update ogevia.caregiver_invitations set first_signed_in_at = now()
  where user_id = ogevia.require_actor() and first_signed_in_at is null;
$$;

-- ---------------------------------------------------------------------------
-- Screens' reads and writes, now record-based
-- ---------------------------------------------------------------------------
drop function ogevia_api.list_caregivers(uuid);
create function ogevia_api.list_caregivers(p_organization_id uuid)
returns table (
  caregiver_record_id uuid, caregiver_code text, first_name text, last_name text, preferred_name text, status text,
  has_sign_in boolean, sign_in_status text, active_assignments integer, open_visits integer, updated_at timestamptz,
  invitation_email text, invited_at timestamptz, invitation_last_sent_at timestamptz, invitation_send_count integer,
  first_signed_in_at timestamptz, planned_assignments integer
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
           where a.organization_id = cr.organization_id and a.is_active
             and (a.caregiver_record_id = cr.id or (a.caregiver_record_id is null and a.caregiver_user_id = cr.linked_user_id))
             and (a.effective_end is null or a.effective_end >= ogevia.organization_local_date(cr.organization_id, now()))),
         (select count(*)::integer from ogevia.service_visits v
           where v.organization_id = cr.organization_id and v.status = 'draft'
             and (v.caregiver_record_id = cr.id or (cr.linked_user_id is not null and v.caregiver_user_id = cr.linked_user_id))),
         cr.updated_at,
         i.email, i.invited_at, i.last_sent_at, i.send_count, i.first_signed_in_at,
         (select count(*)::integer from ogevia.caregiver_assignments a
           where a.organization_id = cr.organization_id and a.is_active and a.caregiver_record_id = cr.id
             and a.caregiver_user_id is null
             and (a.effective_end is null or a.effective_end >= ogevia.organization_local_date(cr.organization_id, now())))
  from ogevia.caregiver_records cr
  left join ogevia.organization_memberships m on m.organization_id = cr.organization_id and m.user_id = cr.linked_user_id and m.role = 'caregiver'
  left join ogevia.caregiver_invitations i on i.organization_id = cr.organization_id and i.caregiver_record_id = cr.id
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
  effective_start date, effective_end date, state text, has_authorization boolean, created_at timestamptz,
  grants_access boolean
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
         a.created_at,
         a.caregiver_user_id is not null
  from ctx
  join ogevia.caregiver_assignments a on a.organization_id = p_organization_id
  join ogevia.clients c on c.id = a.client_id
  join ogevia.services s on s.id = a.service_id
  left join ogevia.caregiver_records cr on cr.organization_id = a.organization_id and cr.deleted_at is null
    and (cr.id = a.caregiver_record_id or (a.caregiver_record_id is null and cr.linked_user_id = a.caregiver_user_id))
  left join ogevia.client_private_names n on n.client_id = c.id
  where ctx.actor is not null and ctx.can_list
    and (p_client_id is null or a.client_id = p_client_id)
    and (p_caregiver_record_id is null or cr.id = p_caregiver_record_id)
  order by case when not a.is_active or (a.effective_end is not null and a.effective_end < ctx.today) then 2
                when a.effective_start > ctx.today then 1 else 0 end,
           a.effective_start desc, c.client_code, s.code;
$$;

-- create_assignment: same arguments; no longer refuses a caregiver without a
-- sign-in (the assignment is planned until they have one and are ready/active).
drop function ogevia_api.create_assignment(uuid, uuid, uuid, uuid, date, date, uuid);
create function ogevia_api.create_assignment(
  p_organization_id uuid, p_caregiver_record_id uuid, p_client_id uuid, p_service_id uuid,
  p_effective_start date, p_effective_end date default null, p_idempotency_key uuid default null
)
returns table (assignment_id uuid, has_authorization boolean, grants_access boolean)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.assignment_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_client_id, p_service_id, p_effective_start, p_effective_end);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_user uuid;
  v_id uuid := gen_random_uuid();
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_covered boolean;
begin
  v_prior := ogevia.idempotency_begin('create_assignment', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'assignment_id')::uuid, (v_prior ->> 'has_authorization')::boolean,
                        coalesce((v_prior ->> 'grants_access')::boolean, true);
    return;
  end if;
  if p_effective_start is null then raise exception 'Enter the start date' using errcode = 'OGV22'; end if;
  if p_effective_end is not null and p_effective_end < p_effective_start then
    raise exception 'The end date cannot be before the start date' using errcode = 'OGV22';
  end if;
  if p_effective_end is not null and p_effective_end < v_today then
    raise exception 'An assignment that has already ended cannot be added' using errcode = 'OGV22';
  end if;
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status = 'inactive' then
    raise exception 'This caregiver is inactive; reactivate them before assigning' using errcode = 'OGV22';
  end if;
  v_user := case when v_rec.status in ('active', 'ready') then v_rec.linked_user_id end;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'assignment-record', p_organization_id, v_rec.id, p_client_id, p_service_id), 0));
  if exists (
    select 1 from ogevia.caregiver_assignments a
    where a.organization_id = p_organization_id
      and (a.caregiver_record_id = v_rec.id or (a.caregiver_record_id is null and v_rec.linked_user_id is not null and a.caregiver_user_id = v_rec.linked_user_id))
      and a.client_id = p_client_id and a.service_id = p_service_id and a.is_active
      and daterange(a.effective_start, a.effective_end, '[]') && daterange(p_effective_start, p_effective_end, '[]')) then
    raise exception 'This caregiver is already assigned to this client and service for these dates' using errcode = 'OGC09';
  end if;
  insert into ogevia.caregiver_assignments (id, organization_id, caregiver_user_id, caregiver_record_id, client_id, service_id, effective_start, effective_end)
  values (v_id, p_organization_id, v_user, v_rec.id, p_client_id, p_service_id, p_effective_start, p_effective_end);
  v_covered := ogevia.authorization_covers(p_organization_id, p_client_id, p_service_id, greatest(p_effective_start, v_today), p_effective_end);
  perform ogevia.write_audit(p_organization_id, 'assignment.created', 'caregiver_assignments', v_id, null,
    jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'client_id', p_client_id, 'service_id', p_service_id,
                       'effective_start', p_effective_start, 'effective_end', p_effective_end, 'has_authorization', v_covered,
                       'grants_access', v_user is not null), null);
  perform ogevia.idempotency_finish('create_assignment', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('assignment_id', v_id, 'has_authorization', v_covered, 'grants_access', v_user is not null));
  return query select v_id, v_covered, v_user is not null;
end;
$$;

-- set_caregiver_status: same contract; inactive now also ends assignments
-- kept by record (planned, or made before the sign-in was linked).
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
    update ogevia.caregiver_assignments a
       set is_active = false, effective_end = greatest(a.effective_start, v_today), updated_at = now()
     where a.organization_id = p_organization_id and a.is_active
       and (a.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and a.caregiver_user_id = v_rec.linked_user_id));
    get diagnostics v_ended = row_count;
    if v_rec.linked_user_id is not null then
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

revoke all on function ogevia.sync_record_assignment_access() from public;
revoke all on function ogevia.normalize_invitation_email(text) from public;
revoke all on function ogevia_api.begin_caregiver_invitation(uuid, uuid, text) from public;
revoke all on function ogevia_api.complete_caregiver_invitation(uuid, uuid, text, text, boolean) from public;
revoke all on function ogevia_api.begin_invitation_resend(uuid, uuid) from public;
revoke all on function ogevia_api.record_invitation_resent(uuid, uuid) from public;
revoke all on function ogevia_api.note_my_sign_in() from public;
revoke all on function ogevia_api.list_caregivers(uuid) from public;
revoke all on function ogevia_api.list_assignments(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.create_assignment(uuid, uuid, uuid, uuid, date, date, uuid) from public;
grant execute on function ogevia_api.begin_caregiver_invitation(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.complete_caregiver_invitation(uuid, uuid, text, text, boolean) to ogevia_app;
grant execute on function ogevia_api.begin_invitation_resend(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.record_invitation_resent(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.note_my_sign_in() to ogevia_app;
grant execute on function ogevia_api.list_caregivers(uuid) to ogevia_app;
grant execute on function ogevia_api.list_assignments(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.create_assignment(uuid, uuid, uuid, uuid, date, date, uuid) to ogevia_app;
