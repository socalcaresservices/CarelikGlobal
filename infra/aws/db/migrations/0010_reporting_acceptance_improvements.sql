-- 0010 - Browser-acceptance reporting improvements.
--
-- Adds:
--   * tenant-neutral, human-readable visit references for NEW visits;
--   * monthly client/service/authorization reconciliation;
--   * organization-wide correction history reporting.
--
-- Existing visit numbers are intentionally not rewritten. Corrections keep the
-- original visit number so the complete correction chain remains one audit item.

create function ogevia.set_human_visit_number()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare
  v_service_code text;
  v_timezone text;
  v_client_token text;
  v_service_token text;
begin
  -- A correction is a revision of the same visit, not a new visit identity.
  if new.original_visit_id is not null then
    return new;
  end if;

  select sv.code into v_service_code
  from ogevia.services sv
  where sv.id = new.service_id
    and sv.organization_id = new.organization_id;

  select o.timezone into v_timezone
  from ogevia.organizations o
  where o.id = new.organization_id;

  v_client_token := coalesce(
    nullif(upper(left(regexp_replace(new.client_code_snapshot, '[^a-zA-Z0-9]', '', 'g'), 12)), ''),
    'CLIENT'
  );
  v_service_token := coalesce(
    nullif(upper(left(regexp_replace(v_service_code, '[^a-zA-Z0-9]', '', 'g'), 8)), ''),
    'SVC'
  );

  new.visit_number_snapshot :=
    v_client_token || '-' ||
    v_service_token || '-' ||
    to_char(new.service_date, 'DDMMYY') || '-' ||
    to_char(new.time_in at time zone coalesce(v_timezone, 'America/Los_Angeles'), 'HH24MI') || '-' ||
    upper(substr(md5(new.id::text), 1, 2));

  return new;
end;
$$;

create trigger service_visits_human_visit_number
before insert on ogevia.service_visits
for each row execute function ogevia.set_human_visit_number();

create function ogevia_api.list_monthly_service_summary(
  p_organization_id uuid,
  p_month_start date,
  p_client_id uuid default null
)
returns table (
  client_id uuid,
  client_code text,
  service_id uuid,
  service_code text,
  service_name text,
  authorization_lineage_id uuid,
  authorization_period_start date,
  authorization_period_end date,
  authorized_minutes integer,
  worked_minutes bigint,
  verified_minutes bigint,
  billable_minutes bigint,
  remaining_minutes bigint,
  review_minutes bigint,
  visit_count bigint
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with bounds as (
    select
      date_trunc('month', p_month_start::timestamp)::date as month_start,
      (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as month_end
  ),
  ranked_authorizations as (
    select
      a.*,
      row_number() over (
        partition by a.lineage_id
        order by a.version_number desc
      ) as version_rank
    from ogevia.client_authorizations a
    cross join bounds b
    where a.organization_id = p_organization_id
      and (p_client_id is null or a.client_id = p_client_id)
      and a.deleted_at is null
      and a.period_start < b.month_end
      and a.period_end >= b.month_start
  ),
  authorizations as (
    select *
    from ranked_authorizations
    where version_rank = 1
  ),
  usage as (
    select
      va.lineage_id,
      coalesce(sum(v.worked_minutes), 0)::bigint as worked_minutes,
      coalesce(sum(v.verified_minutes), 0)::bigint as verified_minutes,
      coalesce(sum(v.billable_minutes), 0)::bigint as billable_minutes,
      coalesce(sum(v.worked_minutes) filter (where v.status = 'administrator_review'), 0)::bigint as review_minutes,
      count(*)::bigint as visit_count
    from ogevia.service_visits v
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
    cross join bounds b
    where v.organization_id = p_organization_id
      and (p_client_id is null or v.client_id = p_client_id)
      and v.service_date >= b.month_start
      and v.service_date < b.month_end
      and v.status in ('signed', 'administrator_review')
    group by va.lineage_id
  )
  select
    c.id,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code),
    sv.id,
    sv.code,
    sv.name,
    a.lineage_id,
    a.period_start,
    a.period_end,
    a.monthly_authorized_minutes,
    coalesce(u.worked_minutes, 0),
    coalesce(u.verified_minutes, 0),
    coalesce(u.billable_minutes, 0),
    greatest(a.monthly_authorized_minutes::bigint - coalesce(u.billable_minutes, 0), 0),
    coalesce(u.review_minutes, 0),
    coalesce(u.visit_count, 0)
  from authorizations a
  join ogevia.clients c
    on c.id = a.client_id
   and c.organization_id = a.organization_id
  join ogevia.services sv
    on sv.id = a.service_id
   and sv.organization_id = a.organization_id
  left join usage u on u.lineage_id = a.lineage_id
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
  order by sv.name, sv.code, a.period_start;
$$;

create function ogevia_api.list_correction_history_report(
  p_organization_id uuid,
  p_date_from date default null,
  p_date_to date default null,
  p_client_id uuid default null,
  p_service_id uuid default null
)
returns table (
  correction_id uuid,
  visit_number text,
  client_id uuid,
  client_code text,
  service_id uuid,
  service_code text,
  service_name text,
  service_date date,
  corrected_by_name text,
  reason text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select
    vc.id,
    original.visit_number_snapshot,
    original.client_id,
    original.client_code_snapshot,
    original.service_id,
    sv.code,
    sv.name,
    original.service_date,
    coalesce(u.display_name, 'Administrator'),
    vc.reason,
    vc.before_snapshot,
    vc.after_snapshot,
    vc.created_at
  from ogevia.visit_corrections vc
  join ogevia.service_visits original on original.id = vc.original_visit_id
  join ogevia.services sv on sv.id = original.service_id
  left join ogevia.app_users u on u.id = vc.corrected_by
  where ogevia.require_actor() is not null
    and vc.organization_id = p_organization_id
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
    and (p_date_from is null or original.service_date >= p_date_from)
    and (p_date_to is null or original.service_date <= p_date_to)
    and (p_client_id is null or original.client_id = p_client_id)
    and (p_service_id is null or original.service_id = p_service_id)
  order by original.service_date desc, vc.created_at desc;
$$;

revoke all on function ogevia.set_human_visit_number() from public;
revoke all on function ogevia_api.list_monthly_service_summary(uuid, date, uuid) from public;
revoke all on function ogevia_api.list_correction_history_report(uuid, date, date, uuid, uuid) from public;

grant execute on function ogevia_api.list_monthly_service_summary(uuid, date, uuid) to ogevia_app;
grant execute on function ogevia_api.list_correction_history_report(uuid, date, date, uuid, uuid) to ogevia_app;
