create or replace function public.check_shift_authorization_and_overlap()
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
  if NEW.service_id is null then
    return NEW;
  end if;

  select * into target_auth from public.client_authorizations
  where organization_id = NEW.organization_id
    and client_id = NEW.client_id
    and service_id = NEW.service_id
    and deleted_at is null
    and NEW.starts_at::date between period_start and period_end
  order by period_start desc
  limit 1
  for update;

  if target_auth.id is null then
    raise exception 'No active authorization covers this client and service for this date - an administrator needs to add one first';
  end if;

  requested_minutes := ceil(extract(epoch from (NEW.ends_at - NEW.starts_at)) / 60)::integer;
  cap_minutes := round(target_auth.max_monthly_hours * 60)::integer;

  select coalesce(sum(
    extract(epoch from (
      least(s.ends_at, date_trunc('month', NEW.starts_at) + interval '1 month')
      - greatest(s.starts_at, date_trunc('month', NEW.starts_at))
    )) / 60.0
  ), 0)::bigint
  into committed_minutes
  from public.shifts s
  where s.organization_id = NEW.organization_id
    and s.client_id = NEW.client_id
    and s.service_id = NEW.service_id
    and s.id is distinct from NEW.id
    and s.status in ('scheduled', 'completed')
    and s.starts_at < date_trunc('month', NEW.starts_at) + interval '1 month'
    and s.ends_at > date_trunc('month', NEW.starts_at);

  if committed_minutes + requested_minutes > cap_minutes then
    raise exception 'Maximum authorized hours reached for this client and service this month.';
  end if;

  if exists (
    select 1 from public.shifts s
    where s.organization_id = NEW.organization_id
      and s.client_id = NEW.client_id
      and s.service_id = NEW.service_id
      and s.id is distinct from NEW.id
      and s.status in ('scheduled', 'completed')
      and s.starts_at < NEW.ends_at
      and s.ends_at > NEW.starts_at
  ) then
    raise exception 'This overlaps a shift already scheduled for this client and service.';
  end if;

  return NEW;
end;
$$;

revoke all on function public.check_shift_authorization_and_overlap() from public, anon, authenticated;

create trigger shifts_check_authorization_and_overlap
before insert or update of starts_at, ends_at, client_id, service_id on public.shifts
for each row
when (new.status in ('scheduled', 'completed'))
execute function public.check_shift_authorization_and_overlap();
