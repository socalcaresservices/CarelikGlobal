begin;

-- Stage 2, item 1: retire the legacy login-based caregiver_credentials
-- table in favor of caregiver_record_credentials, the workforce-record
-- model introduced in candidates_hiring_v1. Both have been live
-- simultaneously since then: caregiver_credentials (keyed by
-- caregiver_user_id, requires a login account to exist) is what the live
-- /credentials page and Command Center actually read and write;
-- caregiver_record_credentials (keyed by caregiver_record_id, works for
-- caregivers with no login) is what the live Care Team detail page reads
-- and writes. A credential entered on one screen has never shown up on
-- the other. This migration makes caregiver_record_credentials the only
-- credentials table, moves every reader/writer onto it, and drops the
-- old one.

-- 1. Ensure every caregiver who has a legacy credential also has a
-- workforce record to attach it to. Name fields fall back through
-- user_profiles' first/last name, then a split of display_name, then a
-- placeholder - caregiver_records.first_name/last_name are not null, and
-- a placeholder name on a handful of backfilled rows is far preferable
-- to silently dropping someone's credential history.
insert into public.caregiver_records (organization_id, linked_user_id, first_name, last_name)
select distinct
  cc.organization_id,
  cc.caregiver_user_id,
  coalesce(
    nullif(trim(up.first_name), ''),
    nullif(split_part(coalesce(up.display_name, ''), ' ', 1), ''),
    'Unknown'
  ),
  coalesce(
    nullif(trim(up.last_name), ''),
    nullif(trim(substr(coalesce(up.display_name, ''), length(split_part(coalesce(up.display_name, ''), ' ', 1)) + 2)), ''),
    'Caregiver'
  )
from public.caregiver_credentials cc
join public.user_profiles up on up.id = cc.caregiver_user_id
where not exists (
  select 1 from public.caregiver_records cr
  where cr.organization_id = cc.organization_id and cr.linked_user_id = cc.caregiver_user_id
);

-- 2. Copy every credential row across. does_not_expire is derived
-- (expires_at was never null-but-expiring in the old model - a null
-- expires_at always meant "does not expire").
insert into public.caregiver_record_credentials (
  organization_id, caregiver_record_id, credential_type, issue_date, expiration_date,
  does_not_expire, notes, created_at, updated_at, deleted_at
)
select
  cc.organization_id,
  cr.id,
  cc.credential_type,
  cc.issued_date,
  cc.expires_at,
  (cc.expires_at is null),
  cc.notes,
  cc.created_at,
  cc.updated_at,
  cc.deleted_at
from public.caregiver_credentials cc
join public.caregiver_records cr
  on cr.organization_id = cc.organization_id and cr.linked_user_id = cc.caregiver_user_id;

-- 3. Internal helper, not directly grantable - only called from the
-- credential-writing RPCs below. Finds the caller's workforce record for
-- a given login, creating a minimal one if this is the first time
-- they've had anything recorded against them.
create or replace function public.find_or_create_caregiver_record_for_user(
  target_organization_id uuid,
  target_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_first_name text;
  v_last_name text;
begin
  select id into v_id
  from public.caregiver_records
  where organization_id = target_organization_id and linked_user_id = target_user_id
  limit 1;

  if v_id is not null then
    return v_id;
  end if;

  select
    coalesce(nullif(trim(up.first_name), ''), nullif(split_part(coalesce(up.display_name, ''), ' ', 1), ''), 'Unknown'),
    coalesce(nullif(trim(up.last_name), ''), nullif(trim(substr(coalesce(up.display_name, ''), length(split_part(coalesce(up.display_name, ''), ' ', 1)) + 2)), ''), 'Caregiver')
  into v_first_name, v_last_name
  from public.user_profiles up
  where up.id = target_user_id;

  insert into public.caregiver_records (organization_id, linked_user_id, first_name, last_name)
  values (target_organization_id, target_user_id, coalesce(v_first_name, 'Unknown'), coalesce(v_last_name, 'Caregiver'))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.find_or_create_caregiver_record_for_user(uuid, uuid) from public, anon, authenticated;

-- 4. Replace the three raw supabase.from("caregiver_credentials") calls
-- credentials-page.tsx makes today with permission-checked RPCs, same
-- shape as the table writes they replace (credentials.update required
-- for all three, matching the table's existing authorized_manage_credentials
-- policy exactly).
create or replace function public.add_caregiver_credential(
  target_organization_id uuid,
  target_user_id uuid,
  new_credential_type text,
  new_issued_date date,
  new_expires_at date,
  new_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caregiver_record_id uuid;
  v_new_id uuid;
begin
  if not public.has_permission(target_organization_id, 'credentials.update') then
    raise exception 'You do not have permission to manage credentials for this organization';
  end if;

  if nullif(trim(new_credential_type), '') is null then
    raise exception 'Credential type is required';
  end if;

  v_caregiver_record_id := public.find_or_create_caregiver_record_for_user(target_organization_id, target_user_id);

  insert into public.caregiver_record_credentials (
    organization_id, caregiver_record_id, credential_type, issue_date, expiration_date, does_not_expire, notes
  ) values (
    target_organization_id, v_caregiver_record_id, trim(new_credential_type), new_issued_date, new_expires_at,
    new_expires_at is null, nullif(trim(new_notes), '')
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function public.add_caregiver_credential(uuid, uuid, text, date, date, text) from public, anon;
grant execute on function public.add_caregiver_credential(uuid, uuid, text, date, date, text) to authenticated;

create or replace function public.update_caregiver_credential(
  target_credential_id uuid,
  new_credential_type text,
  new_issued_date date,
  new_expires_at date,
  new_notes text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id
  from public.caregiver_record_credentials
  where id = target_credential_id and deleted_at is null;

  if v_org_id is null then
    raise exception 'Credential not found';
  end if;

  if not public.has_permission(v_org_id, 'credentials.update') then
    raise exception 'You do not have permission to manage credentials for this organization';
  end if;

  if nullif(trim(new_credential_type), '') is null then
    raise exception 'Credential type is required';
  end if;

  update public.caregiver_record_credentials
  set credential_type = trim(new_credential_type),
      issue_date = new_issued_date,
      expiration_date = new_expires_at,
      does_not_expire = (new_expires_at is null),
      notes = nullif(trim(new_notes), '')
  where id = target_credential_id;
end;
$$;

revoke all on function public.update_caregiver_credential(uuid, text, date, date, text) from public, anon;
grant execute on function public.update_caregiver_credential(uuid, text, date, date, text) to authenticated;

create or replace function public.delete_caregiver_credential(target_credential_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id
  from public.caregiver_record_credentials
  where id = target_credential_id and deleted_at is null;

  if v_org_id is null then
    raise exception 'Credential not found';
  end if;

  if not public.has_permission(v_org_id, 'credentials.update') then
    raise exception 'You do not have permission to manage credentials for this organization';
  end if;

  update public.caregiver_record_credentials
  set deleted_at = now()
  where id = target_credential_id;
end;
$$;

revoke all on function public.delete_caregiver_credential(uuid) from public, anon;
grant execute on function public.delete_caregiver_credential(uuid) to authenticated;

-- 5. Repoint every reader. Same return shape and RPC name for
-- list_caregiver_credentials so credentials-page.tsx, owner-dashboard-page.tsx,
-- and action-center.tsx need no frontend changes at all - only the SQL
-- underneath moves. Scoped to cr.linked_user_id is not null throughout,
-- matching current behavior exactly (every caregiver_credentials row
-- always had a caregiver_user_id) rather than silently starting to
-- surface workforce-only caregivers' credentials into a picker built
-- entirely around login accounts - that's a real, separate UX
-- improvement for later, not a side effect of a data-model cleanup.
-- Also closes the same residual organizations.status bypass fixed
-- elsewhere for caregiver_records/caregiver_availability: the self-read
-- branch now requires organization_is_active() too.
create or replace function public.list_caregiver_credentials(target_organization_id uuid, result_limit integer default 200)
returns table (id uuid, caregiver_user_id uuid, caregiver_name text, credential_type text, issued_date date, expires_at date, notes text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    cr.linked_user_id,
    coalesce(nullif(trim(cr.preferred_name), ''), cr.first_name || ' ' || cr.last_name),
    c.credential_type,
    c.issue_date,
    c.expiration_date,
    c.notes,
    c.created_at
  from public.caregiver_record_credentials c
  join public.caregiver_records cr on cr.id = c.caregiver_record_id
  where c.organization_id = target_organization_id
    and c.deleted_at is null
    and cr.linked_user_id is not null
    and (
      public.has_permission(target_organization_id, 'credentials.read')
      or (cr.linked_user_id = auth.uid() and public.organization_is_active(target_organization_id))
    )
  order by c.expiration_date nulls last, c.credential_type
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_caregiver_credentials(uuid, integer) from public;
grant execute on function public.list_caregiver_credentials(uuid, integer) to authenticated;
revoke execute on function public.list_caregiver_credentials(uuid, integer) from anon;

create or replace function public.global_search(target_organization_id uuid, search_query text)
returns table (result_type text, entity_id uuid, title text, subtitle text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text;
begin
  if trim(coalesce(search_query, '')) = '' then
    return;
  end if;
  q := '%' || trim(search_query) || '%';

  return query
  (
    select 'client'::text, c.id, c.first_name || ' ' || c.last_name, coalesce(c.phone, c.email, initcap(c.status::text))
    from public.clients c
    where c.organization_id = target_organization_id
      and c.deleted_at is null
      and public.has_permission(target_organization_id, 'clients.read')
      and (c.first_name ilike q or c.last_name ilike q or c.phone ilike q or c.email ilike q)
    order by c.last_name
    limit 8
  )
  union all
  (
    select 'caregiver'::text, m.user_id, coalesce(p.display_name, 'Unknown member'), initcap(replace(m.role::text, '_', ' '))
    from public.organization_memberships m
    join public.user_profiles p on p.id = m.user_id
    where m.organization_id = target_organization_id
      and public.has_permission(target_organization_id, 'membership.read')
      and p.display_name ilike q
    order by p.display_name
    limit 8
  )
  union all
  (
    select 'credential'::text, crc.id, crc.credential_type, coalesce(nullif(trim(cr.preferred_name), ''), cr.first_name || ' ' || cr.last_name)
    from public.caregiver_record_credentials crc
    join public.caregiver_records cr on cr.id = crc.caregiver_record_id
    where crc.organization_id = target_organization_id
      and crc.deleted_at is null
      and cr.linked_user_id is not null
      and (
        public.has_permission(target_organization_id, 'credentials.read')
        or (cr.linked_user_id = auth.uid() and public.organization_is_active(target_organization_id))
      )
      and (crc.credential_type ilike q or (cr.first_name || ' ' || cr.last_name) ilike q)
    order by crc.credential_type
    limit 8
  )
  union all
  (
    select 'authorization'::text, a.id, a.payer, cl.first_name || ' ' || cl.last_name
    from public.client_authorizations a
    join public.clients cl on cl.id = a.client_id
    where a.organization_id = target_organization_id
      and a.deleted_at is null
      and public.has_permission(target_organization_id, 'authorizations.read')
      and (a.payer ilike q or cl.first_name ilike q or cl.last_name ilike q)
    order by a.payer
    limit 8
  )
  union all
  (
    select 'incident'::text, i.id, i.category, coalesce(cl.first_name || ' ' || cl.last_name, 'No client on file')
    from public.incidents i
    left join public.clients cl on cl.id = i.client_id
    where i.organization_id = target_organization_id
      and i.deleted_at is null
      and (
        public.has_permission(target_organization_id, 'incidents.read')
        or i.reported_by = auth.uid()
      )
      and (i.category ilike q or i.description ilike q)
    order by i.occurred_at desc
    limit 8
  )
  union all
  (
    select 'service'::text, s.id, s.name, case when s.is_active then 'Active service' else 'Inactive service' end
    from public.services s
    where s.organization_id = target_organization_id
      and s.deleted_at is null
      and public.has_permission(target_organization_id, 'services.read')
      and s.name ilike q
    order by s.name
    limit 8
  )
  union all
  (
    select 'applicant'::text, ja.id, ja.first_name || ' ' || ja.last_name, initcap(replace(ja.status::text, '_', ' '))
    from public.job_applicants ja
    where ja.organization_id = target_organization_id
      and public.has_permission(target_organization_id, 'applicants.read')
      and (ja.first_name ilike q or ja.last_name ilike q or ja.email::text ilike q or ja.phone ilike q)
    order by ja.created_at desc
    limit 8
  );
end;
$$;

create or replace function public.get_agency_dashboard(target_organization_id uuid)
returns table (active_clients integer, active_caregivers integer, fill_rate_pct integer, compliance_score_pct integer, available_capacity_hours numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  week_start timestamptz := date_trunc('week', now());
  week_end timestamptz := date_trunc('week', now()) + interval '7 days';
  today date := current_date;
  v_active_clients integer;
  v_active_caregivers integer;
  v_scheduled_hours numeric;
  v_authorized_weekly_hours numeric;
  v_fill_rate integer;
  v_compliant_count integer;
  v_credentialed_count integer;
  v_compliance_score integer;
  v_capacity numeric;
begin
  if not public.has_permission(target_organization_id, 'membership.read') then
    raise exception 'You do not have permission to view the agency dashboard for this organization';
  end if;

  select count(*) into v_active_clients
  from public.clients
  where organization_id = target_organization_id and status = 'active' and deleted_at is null;

  select count(*) into v_active_caregivers
  from public.organization_memberships
  where organization_id = target_organization_id and status = 'active';

  select coalesce(sum(
    extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0
  ), 0)
  into v_scheduled_hours
  from public.shifts s
  where s.organization_id = target_organization_id
    and s.status in ('scheduled', 'completed')
    and s.starts_at < week_end
    and s.ends_at > week_start;

  select sum(a.max_monthly_hours * 7 / 30.4375)
  into v_authorized_weekly_hours
  from public.client_authorizations a
  where a.organization_id = target_organization_id
    and a.deleted_at is null
    and a.period_start <= today
    and a.period_end >= today;

  if v_authorized_weekly_hours is null or v_authorized_weekly_hours <= 0 then
    v_fill_rate := null;
  else
    v_fill_rate := least(100, greatest(0, round(100.0 * v_scheduled_hours / v_authorized_weekly_hours)));
  end if;

  select
    count(*) filter (
      where not exists (
        select 1 from public.caregiver_record_credentials cc
        join public.caregiver_records cr on cr.id = cc.caregiver_record_id
        where cr.linked_user_id = m.user_id
          and cr.organization_id = target_organization_id
          and cc.organization_id = target_organization_id
          and cc.deleted_at is null
          and cc.expiration_date is not null
          and cc.expiration_date < today
      )
    ),
    count(*)
  into v_compliant_count, v_credentialed_count
  from public.organization_memberships m
  where m.organization_id = target_organization_id
    and m.status = 'active'
    and exists (
      select 1 from public.caregiver_record_credentials cc
      join public.caregiver_records cr on cr.id = cc.caregiver_record_id
      where cr.linked_user_id = m.user_id
        and cr.organization_id = target_organization_id
        and cc.organization_id = target_organization_id
        and cc.deleted_at is null
    );

  if v_credentialed_count = 0 then
    v_compliance_score := null;
  else
    v_compliance_score := round(100.0 * v_compliant_count / v_credentialed_count);
  end if;

  select sum(greatest(0, m.target_hours_per_week - coalesce(hrs.scheduled, 0)))
  into v_capacity
  from public.organization_memberships m
  left join lateral (
    select sum(
      extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0
    ) as scheduled
    from public.shifts s
    where s.caregiver_user_id = m.user_id
      and s.organization_id = target_organization_id
      and s.status in ('scheduled', 'completed')
      and s.starts_at < week_end
      and s.ends_at > week_start
  ) hrs on true
  where m.organization_id = target_organization_id
    and m.status = 'active'
    and m.target_hours_per_week is not null;

  return query select
    v_active_clients,
    v_active_caregivers,
    v_fill_rate,
    v_compliance_score,
    v_capacity;
end;
$$;

create or replace function public.get_actionable_counts(target_organization_id uuid)
returns table (clients_uncovered integer, schedule_issues integer, access_pending integer, credentials_issues integer, authorizations_issues integer, incidents_open integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  now_ts timestamptz := now();
  week_start timestamptz := date_trunc('week', now_ts);
  week_end timestamptz := week_start + interval '7 days';
  upcoming_end timestamptz := now_ts + interval '7 days';
  v_clients_uncovered integer;
  v_overdue_shifts integer;
  v_over_target_caregivers integer;
  v_schedule_issues integer;
  v_access_pending integer;
  v_credentials_issues integer;
  v_authorizations_issues integer;
  v_incidents_open integer;
begin
  if not public.has_permission(target_organization_id, 'membership.read') then
    raise exception 'You do not have permission to view actionable counts for this organization';
  end if;

  if public.has_permission(target_organization_id, 'clients.read')
     and public.has_permission(target_organization_id, 'shifts.read') then
    select count(*) into v_clients_uncovered
    from public.clients c
    where c.organization_id = target_organization_id
      and c.status = 'active'
      and c.deleted_at is null
      and not exists (
        select 1 from public.shifts s
        where s.client_id = c.id
          and s.organization_id = target_organization_id
          and s.status = 'scheduled'
          and s.starts_at >= now_ts
          and s.starts_at < upcoming_end
      );
  else
    v_clients_uncovered := null;
  end if;

  select count(*) into v_overdue_shifts
  from public.shifts s
  where s.organization_id = target_organization_id
    and s.status = 'scheduled'
    and s.ends_at < now_ts;

  select count(*) into v_over_target_caregivers
  from public.organization_memberships m
  left join lateral (
    select sum(
      extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0
    ) as scheduled
    from public.shifts s
    where s.caregiver_user_id = m.user_id
      and s.organization_id = target_organization_id
      and s.status in ('scheduled', 'completed')
      and s.starts_at < week_end
      and s.ends_at > week_start
  ) hrs on true
  where m.organization_id = target_organization_id
    and m.status = 'active'
    and m.target_hours_per_week is not null
    and coalesce(hrs.scheduled, 0) > m.target_hours_per_week;

  v_schedule_issues := v_overdue_shifts + v_over_target_caregivers;

  select count(*) into v_access_pending
  from public.organization_memberships m
  where m.organization_id = target_organization_id
    and m.status = 'invited';

  select count(*) into v_credentials_issues
  from public.caregiver_record_credentials cc
  where cc.organization_id = target_organization_id
    and cc.deleted_at is null
    and cc.expiration_date is not null
    and cc.expiration_date < (now_ts + interval '30 days')::date;

  if public.has_permission(target_organization_id, 'authorizations.read') then
    with usage as (
      select
        a.id,
        a.max_monthly_hours,
        a.period_start,
        a.period_end,
        coalesce(
          sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
            filter (where s.status = 'completed'),
          0
        ) as hours_used_this_month,
        coalesce(
          sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
            filter (where s.status = 'scheduled'),
          0
        ) as hours_scheduled_this_month
      from public.client_authorizations a
      cross join lateral (
        select
          greatest(date_trunc('month', now_ts), a.period_start::timestamptz) as window_start,
          least(date_trunc('month', now_ts) + interval '1 month', a.period_end::timestamptz + interval '1 day') as window_end
      ) w
      left join public.shifts s
        on s.client_id = a.client_id
       and s.service_id = a.service_id
       and s.organization_id = a.organization_id
       and s.status in ('completed', 'scheduled')
       and s.starts_at < w.window_end
       and s.ends_at > w.window_start
      where a.organization_id = target_organization_id
        and a.deleted_at is null
      group by a.id, a.max_monthly_hours, a.period_start, a.period_end
    )
    select count(*) into v_authorizations_issues
    from usage u
    where u.period_end < (now_ts + interval '30 days')::date
       or (
         u.period_start <= now_ts::date
         and u.period_end >= now_ts::date
         and (
           (u.max_monthly_hours > 0
             and (u.hours_used_this_month + u.hours_scheduled_this_month) > u.max_monthly_hours + 0.1)
           or (u.max_monthly_hours <= 0 and (u.hours_used_this_month + u.hours_scheduled_this_month) > 0)
         )
       );
  else
    v_authorizations_issues := null;
  end if;

  select count(*) into v_incidents_open
  from public.incidents i
  where i.organization_id = target_organization_id
    and i.deleted_at is null
    and i.status <> 'resolved';

  return query select
    v_clients_uncovered,
    v_schedule_issues,
    v_access_pending,
    v_credentials_issues,
    v_authorizations_issues,
    v_incidents_open;
end;
$$;

-- 6. Every reader and writer has moved. Drop the legacy table - this
-- also drops its own RLS policies, triggers, and indexes.
drop table public.caregiver_credentials;

commit;
