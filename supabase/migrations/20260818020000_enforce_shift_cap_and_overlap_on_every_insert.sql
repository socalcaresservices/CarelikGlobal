begin;

-- schedule_caregiver_visit() (20260809150000_service_routing.sql, and its
-- authorization-versioning-aware successor in
-- 20260812185651_client_authorization_versioning_resolution_sites.sql) has
-- real, DB-level authorized-hours-cap and overlap enforcement - but only
-- for the caregiver self-service path, since it's the only writer that
-- runs those checks before its own insert. The admin/manager scheduling
-- screen (apps/web/src/pages/schedule-page.tsx) does a raw
-- supabase.from("shifts").insert(...) instead, which only ever went
-- through shifts_validate_authorization - a trigger that checks an
-- authorization *exists* for the client/service/date, but never checks
-- the monthly cap or whether the new shift overlaps one already
-- scheduled. A manager scheduling through the primary Schedule UI could
-- double-book a caregiver or push a client past their authorized hours,
-- with nothing server-side to stop it.
--
-- Fixing this at the trigger level, not by switching the frontend to
-- call schedule_caregiver_visit(), because that RPC hardcodes auth.uid()
-- as the caregiver and checks the *caller's own* caregiver_assignments -
-- it has no way to schedule a specific caregiver_record chosen by an
-- admin, and specifically can't schedule caregivers with no linked login
-- account at all, which the admin scheduling screen explicitly supports.
-- A trigger enforces the same rule regardless of which of the (at least
-- two, likely more over time) code paths inserts or updates a shift.
--
-- The cap/overlap math below is copied from schedule_caregiver_visit()'s
-- own logic, not reinvented - same authorization lookup, same
-- month-window overlap computation, same conflict check. Running it here
-- too is deliberately redundant for that RPC's own inserts (it already
-- checked before inserting); it's the *only* check for every other
-- writer, present and future.
drop trigger if exists shifts_validate_authorization on public.shifts;

create or replace function public.validate_shift_authorization()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_auth public.client_authorizations%rowtype;
  cap_minutes integer;
  committed_minutes bigint;
  requested_minutes integer;
begin
  if new.status <> 'scheduled' then
    return new;
  end if;

  select * into target_auth
  from public.client_authorizations a
  where a.organization_id = new.organization_id
    and a.client_id = new.client_id
    and a.service_id = new.service_id
    and new.starts_at::date between a.period_start and a.period_end
    and a.deleted_at is null
  order by a.period_start desc
  limit 1
  for update;

  if target_auth.id is null then
    raise exception 'An active client authorization is required for the selected service and shift date';
  end if;

  requested_minutes := ceil(extract(epoch from (new.ends_at - new.starts_at)) / 60)::integer;
  cap_minutes := round(target_auth.max_monthly_hours * 60)::integer;

  select coalesce(sum(
    extract(epoch from (
      least(s.ends_at, date_trunc('month', new.starts_at) + interval '1 month')
      - greatest(s.starts_at, date_trunc('month', new.starts_at))
    )) / 60.0
  ), 0)::bigint
  into committed_minutes
  from public.shifts s
  where s.organization_id = new.organization_id
    and s.client_id = new.client_id
    and s.service_id = new.service_id
    and s.status in ('scheduled', 'completed')
    and s.id is distinct from new.id
    and s.starts_at < date_trunc('month', new.starts_at) + interval '1 month'
    and s.ends_at > date_trunc('month', new.starts_at);

  if committed_minutes + requested_minutes > cap_minutes then
    raise exception 'Maximum authorized hours reached for this client and service this month.';
  end if;

  if exists (
    select 1 from public.shifts s
    where s.organization_id = new.organization_id
      and s.client_id = new.client_id
      and s.service_id = new.service_id
      and s.status in ('scheduled', 'completed')
      and s.id is distinct from new.id
      and s.starts_at < new.ends_at
      and s.ends_at > new.starts_at
  ) then
    raise exception 'This overlaps a visit already scheduled for this client and service.';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_shift_authorization() from public, anon, authenticated;

-- ends_at is now load-bearing for this check (it wasn't before, when the
-- function only confirmed an authorization existed for the date), so it
-- has to be in the trigger's watched-column list or an update that only
-- changes ends_at would silently skip re-validation.
create trigger shifts_validate_authorization
before insert or update of organization_id, client_id, service_id, starts_at, ends_at, status
on public.shifts
for each row execute function public.validate_shift_authorization();

commit;
