-- 0125 (PENDING: infra/aws/db/pending) | CLASS: ADDITIVE (one read function; no table, column or data change). Not applied to any database.
-- Owner directive 2026-11-27: Authorization Worklist. One list of every client service whose authorization needs attention: MISSING, EXPIRED, EXPIRING, EXHAUSTED or NEARLY EXHAUSTED, with
-- authorized, used, scheduled and remaining hours for a chosen month, filterable by client, office, program (payer), status and date.
-- Numbers come from the existing one-bucket hours accounting (get_monthly_chain_report, 0079): Authorized = Billable + Rounding + Pending + Reserved + Hours left. USED here is
-- Billable + Rounding + Pending (hours that have happened), SCHEDULED is Reserved, REMAINING is Hours left (negative = over the limit). Nothing here changes a stored value.
-- Read only; requires authorizations.read; returns client codes, never names. Rollback: pending/rollback/0125_authorization_worklist.down.sql.
create function ogevia_api.list_authorization_worklist(
  p_organization_id uuid, p_month_start date default null, p_client_id uuid default null, p_office_id uuid default null, p_program text default null,
  p_status text default null, p_expiring_days integer default 30, p_nearly_percent integer default 85, p_from date default null, p_to date default null)
returns table (
  client_id uuid, client_code text, office_id uuid, office_name text, service_id uuid, service_name text, program text, authorization_id uuid, authorization_number text,
  version_number integer, period_start date, period_end date, days_to_expiry integer, authorized_minutes integer, used_minutes integer, scheduled_minutes integer, remaining_minutes integer,
  percent_committed integer, status text, flags text[])
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare
  v_today date;
  v_month date;
  v_from date;
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'authorizations.read') then raise exception 'You do not have permission to see authorizations' using errcode = 'OGA03'; end if;
  if p_status is not null and p_status not in ('missing', 'expired', 'expiring', 'exhausted', 'nearly_exhausted', 'ok', 'attention') then raise exception 'Unknown status' using errcode = 'OGV22'; end if;
  if coalesce(p_expiring_days, 30) not between 1 and 180 or coalesce(p_nearly_percent, 85) not between 50 and 99 then raise exception 'The warning limits are not valid' using errcode = 'OGV22'; end if;
  if p_from is not null and p_to is not null and p_from > p_to then raise exception 'The start date is after the end date' using errcode = 'OGV22'; end if;
  v_today := ogevia.organization_local_date(p_organization_id, now());
  v_month := date_trunc('month', coalesce(p_month_start, v_today)::timestamp)::date;
  v_from := coalesce(p_from, v_today - 60);
  return query
  with hours as (
    select r.authorization_lineage_id as lineage_id, r.hours_billable_minutes + r.hours_rounding_minutes + r.hours_pending_minutes as used,
           r.hours_reserved_minutes as scheduled, r.hours_left_minutes as remaining
      from ogevia_api.get_monthly_chain_report(p_organization_id, v_month, p_client_id) r
  ),
  auths as (
    select a.client_id, a.service_id, a.payer, a.id as authorization_id, a.authorization_number, a.version_number, a.period_start, a.period_end, a.monthly_authorized_minutes, a.lineage_id
      from ogevia.client_authorizations a
     where a.organization_id = p_organization_id and a.is_current and a.deleted_at is null
       and a.period_end >= v_from and (p_to is null or a.period_start <= p_to)
       and (p_client_id is null or a.client_id = p_client_id)
  ),
  rows_a as (
    select a.client_id, a.service_id, a.payer as program, a.authorization_id, a.authorization_number, a.version_number, a.period_start, a.period_end,
           (a.period_end - v_today) as days_to_expiry, a.monthly_authorized_minutes as authorized, coalesce(h.used, 0) as used, coalesce(h.scheduled, 0) as scheduled,
           coalesce(h.remaining, a.monthly_authorized_minutes) as remaining,
           -- A later authorization for the same client and service means this one was renewed, not expired.
           exists (select 1 from ogevia.client_authorizations n where n.organization_id = p_organization_id and n.client_id = a.client_id and n.service_id = a.service_id
                     and n.is_current and n.deleted_at is null and n.period_end > a.period_end) as renewed,
           (v_month between date_trunc('month', a.period_start)::date and a.period_end) as in_month
      from auths a left join hours h on h.lineage_id = a.lineage_id
  ),
  flagged as (
    select ra.*,
           array_remove(array[
             case when ra.period_end < v_today and not ra.renewed then 'expired' end,
             case when ra.period_end >= v_today and ra.period_end <= v_today + coalesce(p_expiring_days, 30) and not ra.renewed then 'expiring' end,
             case when ra.in_month and ra.period_end >= v_today and ra.authorized > 0 and ra.remaining <= 0 then 'exhausted' end,
             case when ra.in_month and ra.period_end >= v_today and ra.authorized > 0 and ra.remaining > 0
                       and (ra.used + ra.scheduled) * 100 >= coalesce(p_nearly_percent, 85) * ra.authorized then 'nearly_exhausted' end
           ], null) as flags
      from rows_a ra
     where not (ra.period_end < v_today and ra.renewed)         -- a renewed, ended authorization is history, not a work item
  ),
  missing as (
    -- A client with an active assignment or a scheduled shift for a service, and no current authorization that still runs or ended inside the window (those show as EXPIRED).
    select s.client_id, s.service_id
      from (
        select ca.client_id, ca.service_id from ogevia.caregiver_assignments ca
         where ca.organization_id = p_organization_id and ca.is_active and ca.effective_start <= v_today and (ca.effective_end is null or ca.effective_end >= v_today)
        union
        select sh.client_id, sh.service_id from ogevia.shifts sh
         where sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.service_id is not null and sh.starts_at >= now() - interval '1 day'
      ) s
      join ogevia.clients c on c.id = s.client_id and c.organization_id = p_organization_id and c.deleted_at is null and c.status = 'active'
     where (p_client_id is null or s.client_id = p_client_id)
       and not exists (select 1 from ogevia.client_authorizations n where n.organization_id = p_organization_id and n.client_id = s.client_id and n.service_id = s.service_id
                         and n.is_current and n.deleted_at is null and n.period_end >= v_from)   -- one that ended inside the window is listed as EXPIRED instead
  ),
  combined as (
    select f.client_id, f.service_id, f.program, f.authorization_id, f.authorization_number, f.version_number, f.period_start, f.period_end, f.days_to_expiry::integer,
           f.authorized::integer, f.used::integer, f.scheduled::integer, f.remaining::integer,
           case when f.authorized > 0 then least(999, round((f.used + f.scheduled) * 100.0 / f.authorized))::integer end as pct,
           case when 'expired' = any (f.flags) then 'expired' when 'exhausted' = any (f.flags) then 'exhausted' when 'expiring' = any (f.flags) then 'expiring'
                when 'nearly_exhausted' = any (f.flags) then 'nearly_exhausted' else 'ok' end as status, f.flags
      from flagged f
    union all
    select m.client_id, m.service_id, null, null, null, null, null, null, null, null, null, null, null, null, 'missing', array['missing']
      from missing m
  )
  select cb.client_id, c.client_code, o.id, o.name, cb.service_id, sv.name, cb.program, cb.authorization_id, cb.authorization_number, cb.version_number, cb.period_start, cb.period_end,
         cb.days_to_expiry, cb.authorized, cb.used, cb.scheduled, cb.remaining, cb.pct, cb.status, cb.flags
    from combined cb
    join ogevia.clients c on c.id = cb.client_id
    join ogevia.services sv on sv.id = cb.service_id
    left join ogevia.offices o on o.organization_id = p_organization_id
         and o.id = coalesce((select oa.office_id from ogevia.office_assignments oa where oa.client_id = c.id and oa.is_primary limit 1), c.responsible_office_id)
   where c.deleted_at is null
     and (p_office_id is null or o.id = p_office_id)
     and (p_program is null or cb.program = p_program)
     and (p_status is null or (p_status = 'attention' and cb.status <> 'ok') or p_status = any (cb.flags) or (p_status = 'ok' and cb.status = 'ok'))
   order by case cb.status when 'missing' then 1 when 'expired' then 2 when 'exhausted' then 3 when 'expiring' then 4 when 'nearly_exhausted' then 5 else 6 end,
            cb.period_end nulls first, c.client_code, sv.name
   limit 2000;
end;
$$;
revoke all on function ogevia_api.list_authorization_worklist(uuid, date, uuid, uuid, text, text, integer, integer, date, date) from public;
grant execute on function ogevia_api.list_authorization_worklist(uuid, date, uuid, uuid, text, text, integer, integer, date, date) to ogevia_app;
