-- Remaining capacity in the month an authorization ends, grouped in the UI by days to expiry.
create or replace function ogevia_api.list_expiring_authorization_hours(p_org uuid)
returns table(client_id uuid, client_code text, service_name text, ends_on date, days_left integer,
  available_minutes integer, estimated_cents bigint)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  with ctx as (
    select ogevia.organization_local_date(p_org, now()) as today,
      ogevia.has_permission(p_org, 'billing.read') as can_see_money
    where ogevia.is_active_member(p_org) and ogevia.has_permission(p_org, 'visits.read')
  ), months as (
    select d::date as month_start
    from ctx cross join lateral generate_series(date_trunc('month', ctx.today::timestamp), date_trunc('month', (ctx.today+30)::timestamp), interval '1 month') v(d)
  )
  select s.client_id, s.client_code, s.service_name, s.authorization_period_end,
    s.authorization_period_end - ctx.today, s.hours_left_minutes,
    case when ctx.can_see_money then round(s.hours_left_minutes::numeric * rate.hourly_rate_cents / 60)::bigint end
  from ctx cross join months
  cross join lateral ogevia_api.list_monthly_service_summary(p_org, months.month_start, null) s
  left join lateral (
    select a.hourly_rate_cents from ogevia.client_authorizations a
    where a.organization_id=p_org and a.lineage_id=s.authorization_lineage_id and a.is_current and a.deleted_at is null
    order by a.version_number desc limit 1
  ) rate on true
  where s.authorization_period_end between ctx.today and ctx.today + 30
    and date_trunc('month', s.authorization_period_end)::date = months.month_start
    and s.hours_left_minutes > 0
  order by s.authorization_period_end, s.client_code, s.service_name;
$$;
revoke all on function ogevia_api.list_expiring_authorization_hours(uuid) from public;
grant execute on function ogevia_api.list_expiring_authorization_hours(uuid) to ogevia_app;
