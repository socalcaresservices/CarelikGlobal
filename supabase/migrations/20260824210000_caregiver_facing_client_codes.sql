begin;

-- A manager-selected, privacy-safe label for the mobile sign-in sheet.
-- Legal names, UCI numbers, dates of birth, phone numbers, and addresses are
-- never returned by the caregiver picker RPC.
alter table public.clients
  add column if not exists caregiver_display_code text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clients_caregiver_display_code_length'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients
      add constraint clients_caregiver_display_code_length
      check (
        caregiver_display_code is null
        or length(btrim(caregiver_display_code)) between 3 and 40
      );
  end if;
end;
$$;

create unique index if not exists clients_org_caregiver_display_code_unique
  on public.clients (organization_id, lower(btrim(caregiver_display_code)))
  where caregiver_display_code is not null and deleted_at is null;

create or replace function public.list_assigned_visit_clients(target_organization_id uuid)
returns table (
  client_id uuid,
  client_code text,
  next_scheduled_starts_at timestamptz,
  next_scheduled_ends_at timestamptz,
  active_service_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code),
    next_shift.starts_at,
    next_shift.ends_at,
    (
      select count(distinct a.service_id)::integer
      from public.client_authorizations a
      join public.services sv
        on sv.id = a.service_id
       and sv.organization_id = a.organization_id
       and sv.deleted_at is null
       and sv.is_active
      where a.organization_id = c.organization_id
        and a.client_id = c.id
        and a.deleted_at is null
        and (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date
          between a.period_start and a.period_end
        and (
          public.has_permission(target_organization_id, 'visits.manage')
          or public.caregiver_has_active_assignment(target_organization_id, c.id, a.service_id)
        )
    ) as active_service_count
  from public.clients c
  join public.organizations o on o.id = c.organization_id
  left join lateral (
    select s.starts_at, s.ends_at
    from public.shifts s
    left join public.caregiver_records cr
      on cr.id = s.caregiver_record_id
     and cr.organization_id = s.organization_id
     and cr.deleted_at is null
    where s.organization_id = c.organization_id
      and s.client_id = c.id
      and s.status = 'scheduled'
      and (s.starts_at at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date
        = (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date
      and (
        public.has_permission(target_organization_id, 'visits.manage')
        or s.caregiver_user_id = auth.uid()
        or cr.linked_user_id = auth.uid()
      )
      and (
        select e.event_type
        from public.shift_coverage_events e
        where e.shift_id = s.id
        order by e.created_at desc
        limit 1
      ) is distinct from 'called_out'
    order by s.starts_at
    limit 1
  ) next_shift on true
  where c.organization_id = target_organization_id
    and c.deleted_at is null
    and c.status = 'active'
    and auth.uid() is not null
    and public.organization_is_active(target_organization_id)
    and public.is_organization_member(target_organization_id)
    and (
      public.has_permission(target_organization_id, 'visits.manage')
      or public.caregiver_has_active_assignment(target_organization_id, c.id, null)
    )
  order by next_shift.starts_at nulls last,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code);
$$;

revoke all on function public.list_assigned_visit_clients(uuid) from public, anon;
grant execute on function public.list_assigned_visit_clients(uuid) to authenticated;

create or replace function public.find_client_for_visit(
  target_organization_id uuid,
  search_term text
)
returns table (client_id uuid, client_code text, client_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_term text := lower(btrim(search_term));
  recent_failures integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.organization_is_active(target_organization_id)
     or not public.is_organization_member(target_organization_id) then
    raise exception 'Not an active member of this organization';
  end if;
  if normalized_term = '' then raise exception 'Enter a client code'; end if;

  select count(*) into recent_failures
  from public.audit_logs
  where actor_user_id = auth.uid()
    and organization_id = target_organization_id
    and action = 'client_lookup.failed'
    and occurred_at > now() - interval '10 minutes';
  if recent_failures >= 5 then
    raise exception 'RATE_LIMITED: Too many attempts. Wait a few minutes or contact your administrator.';
  end if;

  return query
  select
    c.id,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code),
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code)
  from public.clients c
  where c.organization_id = target_organization_id
    and c.deleted_at is null
    and c.status = 'active'
    and (
      lower(c.client_code) = normalized_term
      or lower(btrim(c.caregiver_display_code)) = normalized_term
    )
    and (
      public.has_permission(target_organization_id, 'visits.manage')
      or public.caregiver_has_active_assignment(target_organization_id, c.id, null)
    )
  limit 1;

  if not found then
    insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, source)
    values (target_organization_id, auth.uid(), 'client_lookup.failed', 'clients', 'application');
  end if;
end;
$$;

revoke all on function public.find_client_for_visit(uuid, text) from public, anon;
grant execute on function public.find_client_for_visit(uuid, text) to authenticated;

-- Snapshot the safe label at the moment a visit is created so reports retain
-- what the caregiver saw even if a manager changes the label later.
create or replace function public.set_service_visit_client_display_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code)
    into new.client_code_snapshot
  from public.clients c
  where c.id = new.client_id
    and c.organization_id = new.organization_id
    and c.deleted_at is null;

  if new.client_code_snapshot is null then
    raise exception 'Client is not available in this organization';
  end if;

  return new;
end;
$$;

revoke all on function public.set_service_visit_client_display_code() from public, anon, authenticated;

drop trigger if exists set_service_visit_client_display_code on public.service_visits;
create trigger set_service_visit_client_display_code
before insert on public.service_visits
for each row execute function public.set_service_visit_client_display_code();

commit;
