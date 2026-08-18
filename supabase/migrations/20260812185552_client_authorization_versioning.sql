alter table public.client_authorizations
  add column version_number integer not null default 1,
  add column is_current boolean not null default true,
  add column supersedes_id uuid references public.client_authorizations(id),
  add column superseded_by_id uuid references public.client_authorizations(id),
  add column received_date date,
  add column source_reference text,
  add column change_reason text,
  add constraint client_authorizations_version_check check (version_number >= 1);

create unique index client_authorizations_current_unique
  on public.client_authorizations (organization_id, client_id, service_id, period_start, period_end)
  where is_current = true and deleted_at is null;

create index client_authorizations_supersedes_idx on public.client_authorizations (supersedes_id);

create or replace function public.amend_client_authorization(
  target_authorization_id uuid,
  new_max_monthly_hours numeric,
  new_period_start date,
  new_period_end date,
  new_payer text,
  new_authorization_number text default null,
  new_notes text default null,
  reason text default null,
  received_date date default null,
  source_reference text default null
)
returns table (
  new_authorization_id uuid,
  new_version_number integer,
  affected_visit_id uuid,
  affected_visit_status public.service_visit_status,
  affected_service_date date,
  affected_worked_minutes integer,
  affected_billable_minutes integer,
  affected_old_cap_minutes integer,
  affected_new_cap_minutes integer,
  impact_kind text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  old_auth public.client_authorizations%rowtype;
  new_id uuid;
  new_version integer;
  old_cap_minutes integer;
  new_cap_minutes integer;
  moved_up boolean;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if new_period_end <= new_period_start then
    raise exception 'Period end must be after period start';
  end if;
  if new_max_monthly_hours < 0 then
    raise exception 'Max monthly hours cannot be negative';
  end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to amend an authorization';
  end if;

  select * into old_auth from public.client_authorizations
  where id = target_authorization_id for update;

  if old_auth.id is null then
    raise exception 'Authorization not found';
  end if;
  if not public.has_permission(old_auth.organization_id, 'authorizations.update') then
    raise exception 'You do not have permission to amend authorizations for this organization';
  end if;
  if not old_auth.is_current then
    raise exception 'This authorization has already been superseded by a later amendment';
  end if;
  if old_auth.deleted_at is not null then
    raise exception 'This authorization has been removed';
  end if;

  new_version := old_auth.version_number + 1;
  old_cap_minutes := round(old_auth.max_monthly_hours * 60)::integer;
  new_cap_minutes := round(new_max_monthly_hours * 60)::integer;
  moved_up := new_cap_minutes > old_cap_minutes;

  insert into public.client_authorizations (
    organization_id, client_id, service_id, payer, authorization_number,
    max_monthly_hours, period_start, period_end, notes,
    version_number, is_current, supersedes_id,
    received_date, source_reference, change_reason,
    created_by, updated_by
  ) values (
    old_auth.organization_id, old_auth.client_id, old_auth.service_id, new_payer, new_authorization_number,
    new_max_monthly_hours, new_period_start, new_period_end, new_notes,
    new_version, true, old_auth.id,
    received_date, source_reference, btrim(reason),
    auth.uid(), auth.uid()
  ) returning id into new_id;

  update public.client_authorizations set
    is_current = false,
    superseded_by_id = new_id,
    updated_by = auth.uid()
  where id = old_auth.id;

  return query
  select
    new_id,
    new_version,
    v.id,
    v.status,
    v.service_date,
    v.worked_minutes,
    v.billable_minutes,
    old_cap_minutes,
    new_cap_minutes,
    case
      when moved_up and v.authorization_status in ('exceeds_authorization', 'limit_reached')
        then 'increase_may_allow_more'
      when not moved_up and v.status in ('signed', 'administrator_review')
        then 'decrease_now_exceeds'
      else null
    end
  from public.service_visits v
  where v.service_authorization_id = old_auth.id
    and v.status not in ('voided', 'corrected')
    and (
      (moved_up and v.authorization_status in ('exceeds_authorization', 'limit_reached'))
      or (not moved_up and v.status in ('signed', 'administrator_review'))
    )
  order by v.service_date desc;
end;
$$;

revoke all on function public.amend_client_authorization(uuid, numeric, date, date, text, text, text, text, date, text) from public, anon;
grant execute on function public.amend_client_authorization(uuid, numeric, date, date, text, text, text, text, date, text) to authenticated;

create or replace function public.list_authorization_versions(target_authorization_id uuid)
returns table (
  id uuid,
  version_number integer,
  is_current boolean,
  payer text,
  authorization_number text,
  max_monthly_hours numeric,
  period_start date,
  period_end date,
  notes text,
  received_date date,
  source_reference text,
  change_reason text,
  changed_by_name text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with recursive lineage as (
    select a.* from public.client_authorizations a where a.id = target_authorization_id
    union all
    select a.* from public.client_authorizations a
    join lineage l on a.id = l.supersedes_id
  )
  select
    l.id, l.version_number, l.is_current, l.payer, l.authorization_number,
    l.max_monthly_hours, l.period_start, l.period_end, l.notes,
    l.received_date, l.source_reference, l.change_reason,
    coalesce(p.display_name, 'Administrator'),
    l.created_at
  from lineage l
  left join public.user_profiles p on p.id = l.created_by
  where public.has_permission(l.organization_id, 'authorizations.read')
  order by l.version_number asc;
$$;

revoke all on function public.list_authorization_versions(uuid) from public, anon;
grant execute on function public.list_authorization_versions(uuid) to authenticated;
