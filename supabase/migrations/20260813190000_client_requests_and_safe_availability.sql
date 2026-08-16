begin;

create table if not exists public.client_requested_schedule (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  day_of_week public.weekday not null,
  start_time time not null,
  end_time time not null,
  notes text,
  created_at timestamptz not null default now(),
  constraint client_requested_schedule_time_order check (end_time > start_time)
);

create index if not exists client_requested_schedule_client_idx
  on public.client_requested_schedule (client_id, day_of_week, start_time);

alter table public.client_requested_schedule enable row level security;

alter table public.shifts add column if not exists caregiver_record_id uuid references public.caregiver_records(id);
update public.shifts s set caregiver_record_id = cr.id from public.caregiver_records cr
where cr.organization_id = s.organization_id and cr.linked_user_id = s.caregiver_user_id and cr.deleted_at is null;
alter table public.shifts alter column caregiver_user_id drop not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.shifts'::regclass and conname = 'shifts_caregiver_required'
  ) then
    alter table public.shifts add constraint shifts_caregiver_required
      check (caregiver_record_id is not null or caregiver_user_id is not null);
  end if;
end;
$$;
create index if not exists shifts_caregiver_record_starts_at_idx on public.shifts (caregiver_record_id, starts_at);

drop policy if exists "members_read_shifts" on public.shifts;
create policy "members_read_shifts" on public.shifts for select to authenticated
using (public.has_permission(organization_id, 'shifts.read') or caregiver_user_id = auth.uid() or exists (
  select 1 from public.caregiver_records cr where cr.id = caregiver_record_id and cr.organization_id = shifts.organization_id and cr.linked_user_id = auth.uid()
));

drop policy if exists "authorized_manage_shifts" on public.shifts;
create policy "authorized_manage_shifts" on public.shifts for all to authenticated
using (public.has_permission(organization_id, 'shifts.update'))
with check (
  public.has_permission(organization_id, 'shifts.update')
  and (caregiver_record_id is null or exists (
    select 1 from public.caregiver_records cr
    where cr.id = caregiver_record_id and cr.organization_id = shifts.organization_id and cr.deleted_at is null
  ))
);

create or replace function public.list_shifts(target_organization_id uuid, from_time timestamptz default null, to_time timestamptz default null)
returns table (id uuid, client_id uuid, client_name text, caregiver_user_id uuid, caregiver_name text, starts_at timestamptz, ends_at timestamptz, status public.shift_status, notes text)
language sql stable security definer set search_path = public as $$
  select s.id, s.client_id, coalesce(c.first_name || ' ' || c.last_name, 'Unknown client'), s.caregiver_user_id,
    coalesce(cr.preferred_name || ' ' || cr.last_name, cr.first_name || ' ' || cr.last_name, p.display_name, 'Unknown caregiver'),
    s.starts_at, s.ends_at, s.status, s.notes
  from public.shifts s join public.clients c on c.id = s.client_id
  left join public.caregiver_records cr on cr.id = s.caregiver_record_id and cr.organization_id = s.organization_id
  left join public.user_profiles p on p.id = s.caregiver_user_id
  where s.organization_id = target_organization_id
    and (public.has_permission(target_organization_id, 'shifts.read') or s.caregiver_user_id = auth.uid() or cr.linked_user_id = auth.uid())
    and (from_time is null or s.ends_at >= from_time) and (to_time is null or s.starts_at <= to_time)
  order by s.starts_at;
$$;
revoke all on function public.list_shifts(uuid, timestamptz, timestamptz) from public;
revoke all on function public.list_shifts(uuid, timestamptz, timestamptz) from anon;
grant execute on function public.list_shifts(uuid, timestamptz, timestamptz) to authenticated;

drop policy if exists "authorized_read_client_requested_schedule" on public.client_requested_schedule;
create policy "authorized_read_client_requested_schedule"
on public.client_requested_schedule for select to authenticated
using (public.has_permission(organization_id, 'clients.read'));

drop policy if exists "authorized_manage_client_requested_schedule" on public.client_requested_schedule;
create policy "authorized_manage_client_requested_schedule"
on public.client_requested_schedule for all to authenticated
using (public.has_permission(organization_id, 'clients.update'))
with check (public.has_permission(organization_id, 'clients.update'));

drop trigger if exists client_requested_schedule_audit on public.client_requested_schedule;
create trigger client_requested_schedule_audit
after insert or update or delete on public.client_requested_schedule
for each row execute function public.write_audit_log();

create or replace function public.replace_client_requested_schedule(
  target_organization_id uuid,
  target_client_id uuid,
  requested_slots jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'clients.update') then
    raise exception 'You do not have permission to update this client';
  end if;
  if not exists (
    select 1 from public.clients
    where id = target_client_id and organization_id = target_organization_id and deleted_at is null
  ) then
    raise exception 'Client not found';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(requested_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time, notes text)
    group by day_of_week having count(*) > 2
  ) then
    raise exception 'A client may request at most two shifts per day';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(requested_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time, notes text)
    where start_time is null or end_time is null or end_time <= start_time
  ) then
    raise exception 'Every requested shift must have a valid start and end time';
  end if;

  delete from public.client_requested_schedule
  where organization_id = target_organization_id and client_id = target_client_id;

  insert into public.client_requested_schedule
    (organization_id, client_id, day_of_week, start_time, end_time, notes)
  select target_organization_id, target_client_id, day_of_week, start_time, end_time,
    nullif(trim(notes), '')
  from jsonb_to_recordset(coalesce(requested_slots, '[]'::jsonb))
    as x(day_of_week public.weekday, start_time time, end_time time, notes text);
end;
$$;

revoke all on function public.replace_client_requested_schedule(uuid, uuid, jsonb) from public;
revoke all on function public.replace_client_requested_schedule(uuid, uuid, jsonb) from anon;
grant execute on function public.replace_client_requested_schedule(uuid, uuid, jsonb) to authenticated;

create or replace function public.replace_caregiver_record_availability(
  target_organization_id uuid,
  target_caregiver_record_id uuid,
  availability_slots jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'membership.update') then
    raise exception 'You do not have permission to update Care Team availability';
  end if;
  if not exists (
    select 1 from public.caregiver_records
    where id = target_caregiver_record_id and organization_id = target_organization_id and deleted_at is null
  ) then
    raise exception 'Care Team record not found';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(availability_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time, preference public.availability_preference)
    group by day_of_week having count(*) > 2
  ) then
    raise exception 'Availability supports at most two time windows per day';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(availability_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time, preference public.availability_preference)
    where start_time is null or end_time is null or end_time <= start_time
  ) then
    raise exception 'Every availability window must have a valid start and end time';
  end if;

  delete from public.caregiver_record_availability
  where organization_id = target_organization_id and caregiver_record_id = target_caregiver_record_id;

  insert into public.caregiver_record_availability
    (organization_id, caregiver_record_id, day_of_week, start_time, end_time, preference)
  select target_organization_id, target_caregiver_record_id, day_of_week, start_time, end_time,
    coalesce(preference, 'available'::public.availability_preference)
  from jsonb_to_recordset(coalesce(availability_slots, '[]'::jsonb))
    as x(day_of_week public.weekday, start_time time, end_time time, preference public.availability_preference);
end;
$$;

revoke all on function public.replace_caregiver_record_availability(uuid, uuid, jsonb) from public;
revoke all on function public.replace_caregiver_record_availability(uuid, uuid, jsonb) from anon;
grant execute on function public.replace_caregiver_record_availability(uuid, uuid, jsonb) to authenticated;

commit;
