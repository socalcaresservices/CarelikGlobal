begin;

-- The demo was created without this earlier additive client-profile change.
-- Keep these idempotent so established projects are not rewritten.
alter table public.clients add column if not exists address_line2 text;
alter table public.clients add column if not exists requested_service_notes text;

-- Requested care windows may apply to one service or to every requested
-- service when service_id is null.
alter table public.client_requested_schedule
  add column if not exists service_id uuid references public.services(id),
  add column if not exists created_by uuid references auth.users(id);

create index if not exists client_requested_schedule_service_idx
  on public.client_requested_schedule (service_id);

create table if not exists public.client_service_gap_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  month_start date not null,
  reason text not null,
  notes text,
  resolved boolean not null default false,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_service_gap_reviews_month_start_check
    check (month_start = date_trunc('month', month_start)::date),
  constraint client_service_gap_reviews_reason_check
    check (reason in (
      'caregiver_unavailable',
      'client_unavailable',
      'family_requested_change',
      'staffing_not_filled',
      'authorization_delay',
      'service_started_late',
      'other'
    )),
  constraint client_service_gap_reviews_unique_month
    unique (organization_id, client_id, service_id, month_start)
);

create index if not exists client_service_gap_reviews_org_month_idx
  on public.client_service_gap_reviews (organization_id, month_start);
create index if not exists client_service_gap_reviews_client_idx
  on public.client_service_gap_reviews (client_id, service_id, month_start);

drop trigger if exists client_service_gap_reviews_set_updated_at
  on public.client_service_gap_reviews;
create trigger client_service_gap_reviews_set_updated_at
before update on public.client_service_gap_reviews
for each row execute function public.set_updated_at();

drop trigger if exists client_service_gap_reviews_audit
  on public.client_service_gap_reviews;
create trigger client_service_gap_reviews_audit
after insert or update or delete on public.client_service_gap_reviews
for each row execute function public.write_audit_log();

alter table public.client_service_gap_reviews enable row level security;

drop policy if exists "members_read_client_service_gap_reviews"
  on public.client_service_gap_reviews;
create policy "members_read_client_service_gap_reviews"
on public.client_service_gap_reviews for select to authenticated
using (public.has_permission(organization_id, 'clients.read'));

drop policy if exists "authorized_insert_client_service_gap_reviews"
  on public.client_service_gap_reviews;
create policy "authorized_insert_client_service_gap_reviews"
on public.client_service_gap_reviews for insert to authenticated
with check (public.has_permission(organization_id, 'clients.update'));

drop policy if exists "authorized_update_client_service_gap_reviews"
  on public.client_service_gap_reviews;
create policy "authorized_update_client_service_gap_reviews"
on public.client_service_gap_reviews for update to authenticated
using (public.has_permission(organization_id, 'clients.update'))
with check (public.has_permission(organization_id, 'clients.update'));

drop policy if exists "authorized_delete_client_service_gap_reviews"
  on public.client_service_gap_reviews;
create policy "authorized_delete_client_service_gap_reviews"
on public.client_service_gap_reviews for delete to authenticated
using (public.has_permission(organization_id, 'clients.update'));

revoke all on table public.client_service_gap_reviews from public, anon;
grant select, insert, update, delete on table public.client_service_gap_reviews
  to authenticated;

create or replace function public.replace_client_requested_schedule(
  target_organization_id uuid,
  target_client_id uuid,
  requested_slots jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_permission(target_organization_id, 'clients.update') then
    raise exception 'You do not have permission to update this client';
  end if;

  if not exists (
    select 1 from public.clients
    where id = target_client_id
      and organization_id = target_organization_id
      and deleted_at is null
  ) then
    raise exception 'Client not found';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(requested_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time,
           service_id uuid, notes text)
    group by day_of_week having count(*) > 2
  ) then
    raise exception 'A client may request at most two shifts per day';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(requested_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time,
           service_id uuid, notes text)
    where start_time is null or end_time is null or end_time <= start_time
  ) then
    raise exception 'Every requested shift must have a valid start and end time';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(requested_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time,
           service_id uuid, notes text)
    where service_id is not null and not exists (
      select 1 from public.services s
      where s.id = x.service_id
        and s.organization_id = target_organization_id
        and s.deleted_at is null
    )
  ) then
    raise exception 'A requested shift contains an invalid service';
  end if;

  delete from public.client_requested_schedule
  where organization_id = target_organization_id
    and client_id = target_client_id;

  insert into public.client_requested_schedule
    (organization_id, client_id, day_of_week, start_time, end_time,
     service_id, notes, created_by)
  select target_organization_id, target_client_id, day_of_week, start_time,
    end_time, service_id, nullif(trim(notes), ''), (select auth.uid())
  from jsonb_to_recordset(coalesce(requested_slots, '[]'::jsonb))
    as x(day_of_week public.weekday, start_time time, end_time time,
         service_id uuid, notes text);
end;
$$;

revoke all on function public.replace_client_requested_schedule(uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.replace_client_requested_schedule(uuid, uuid, jsonb)
  to authenticated;

create or replace function public.record_client_service_gap_review(
  target_organization_id uuid,
  target_client_id uuid,
  target_service_id uuid,
  target_month_start date,
  target_reason text,
  target_notes text default null,
  target_resolved boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  review_id uuid;
begin
  if not public.has_permission(target_organization_id, 'clients.update') then
    raise exception 'You do not have permission to record a service gap review';
  end if;

  if target_month_start <> date_trunc('month', target_month_start)::date then
    raise exception 'The review month must be the first day of a month';
  end if;

  if not exists (
    select 1 from public.clients c
    where c.id = target_client_id
      and c.organization_id = target_organization_id
      and c.deleted_at is null
  ) or not exists (
    select 1 from public.services s
    where s.id = target_service_id
      and s.organization_id = target_organization_id
      and s.deleted_at is null
  ) then
    raise exception 'Client or service not found in this organization';
  end if;

  insert into public.client_service_gap_reviews (
    organization_id, client_id, service_id, month_start,
    reason, notes, resolved, updated_by
  ) values (
    target_organization_id, target_client_id, target_service_id,
    target_month_start, target_reason, nullif(trim(target_notes), ''),
    target_resolved, (select auth.uid())
  )
  on conflict (organization_id, client_id, service_id, month_start)
  do update set
    reason = excluded.reason,
    notes = excluded.notes,
    resolved = excluded.resolved,
    updated_by = excluded.updated_by
  returning id into review_id;

  return review_id;
end;
$$;

revoke all on function public.record_client_service_gap_review(
  uuid, uuid, uuid, date, text, text, boolean
) from public, anon;
grant execute on function public.record_client_service_gap_review(
  uuid, uuid, uuid, date, text, text, boolean
) to authenticated;

create or replace function public.list_client_operations(
  target_organization_id uuid,
  target_month_start date default date_trunc('month', current_date)::date
)
returns table (
  client_id uuid,
  client_name text,
  client_code text,
  caregiver_display_code text,
  client_status public.client_status,
  location text,
  service_id uuid,
  service_name text,
  max_monthly_hours numeric,
  authorization_period_end date,
  delivered_minutes bigint,
  assigned_caregivers text[],
  requested_windows jsonb,
  top_match_name text,
  top_match_score integer,
  gap_reason text,
  gap_notes text,
  gap_resolved boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_permission(target_organization_id, 'clients.read') then
    raise exception 'You do not have permission to view client operations';
  end if;

  return query
  with service_scope as (
    select a.client_id, a.service_id
    from public.client_authorizations a
    where a.organization_id = target_organization_id
      and a.deleted_at is null
      and a.is_current = true
      and a.period_start < (target_month_start + interval '1 month')::date
      and a.period_end >= target_month_start
    union
    select rs.client_id, rs.service_id
    from public.client_requested_services rs
    where rs.organization_id = target_organization_id
  ),
  active_auth as (
    select distinct on (a.client_id, a.service_id)
      a.client_id, a.service_id, a.max_monthly_hours, a.period_end
    from public.client_authorizations a
    where a.organization_id = target_organization_id
      and a.deleted_at is null
      and a.is_current = true
      and a.period_start < (target_month_start + interval '1 month')::date
      and a.period_end >= target_month_start
    order by a.client_id, a.service_id, a.period_end desc, a.version_number desc
  ),
  delivered as (
    select v.client_id, v.service_id,
      coalesce(sum(v.worked_minutes), 0)::bigint as minutes
    from public.service_visits v
    where v.organization_id = target_organization_id
      and v.service_date >= target_month_start
      and v.service_date < (target_month_start + interval '1 month')::date
      and v.status in ('signed', 'administrator_review')
    group by v.client_id, v.service_id
  )
  select
    c.id,
    concat_ws(' ', c.first_name, c.last_name),
    c.client_code,
    c.caregiver_display_code,
    c.status,
    nullif(concat_ws(', ', nullif(c.address_city, ''), nullif(c.address_state, '')), ''),
    ss.service_id,
    s.name,
    aa.max_monthly_hours,
    aa.period_end,
    coalesce(d.minutes, 0),
    coalesce(assignments.names, array[]::text[]),
    coalesce(windows.items, '[]'::jsonb),
    top_match.caregiver_name,
    top_match.match_score,
    gr.reason,
    gr.notes,
    coalesce(gr.resolved, false)
  from public.clients c
  left join service_scope ss on ss.client_id = c.id
  left join public.services s on s.id = ss.service_id
  left join active_auth aa
    on aa.client_id = c.id and aa.service_id = ss.service_id
  left join delivered d
    on d.client_id = c.id and d.service_id = ss.service_id
  left join lateral (
    select array_agg(distinct coalesce(p.display_name, 'Caregiver') order by coalesce(p.display_name, 'Caregiver')) as names
    from public.caregiver_assignments ca
    left join public.user_profiles p on p.id = ca.caregiver_user_id
    where ca.organization_id = target_organization_id
      and ca.client_id = c.id
      and ca.service_id = ss.service_id
      and ca.is_active = true
      and ca.effective_start <= (target_month_start + interval '1 month - 1 day')::date
      and (ca.effective_end is null or ca.effective_end >= target_month_start)
  ) assignments on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'day', r.day_of_week,
      'start', r.start_time,
      'end', r.end_time,
      'notes', r.notes
    ) order by r.day_of_week, r.start_time) as items
    from public.client_requested_schedule r
    where r.organization_id = target_organization_id
      and r.client_id = c.id
      and (r.service_id is null or r.service_id = ss.service_id)
  ) windows on true
  left join lateral (
    select m.caregiver_name, m.match_score
    from public.list_caregiver_matches(target_organization_id, c.id) m
    where public.has_permission(target_organization_id, 'shifts.update')
    order by m.match_score desc, m.caregiver_name
    limit 1
  ) top_match on true
  left join public.client_service_gap_reviews gr
    on gr.organization_id = target_organization_id
    and gr.client_id = c.id
    and gr.service_id = ss.service_id
    and gr.month_start = target_month_start
  where c.organization_id = target_organization_id
    and c.deleted_at is null
  order by c.last_name, c.first_name, s.name;
end;
$$;

revoke all on function public.list_client_operations(uuid, date)
  from public, anon;
grant execute on function public.list_client_operations(uuid, date)
  to authenticated;

commit;
