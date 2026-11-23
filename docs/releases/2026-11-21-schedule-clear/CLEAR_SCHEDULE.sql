-- PRODUCTION SCHEDULE CLEAR (runs only on the owner's explicit GO, after a verified backup). One transaction as the agency's Administrator (the app's own functions check who is acting).
--   psql -X -At -F '|' -v org_slug=<optional> -v expect_nov=<n> -v expect_dec=<n> -v expect_series=<n> -f CLEAR_SCHEDULE.sql
-- It uses ONLY the app's own history-preserving functions: ogevia_api.end_shift_series (ends the recurring series from 2026-11-01 so nothing regenerates) and ogevia_api.cancel_shift (cancels one unworked shift
-- with a reason, releases its reservation, writes an audit event). Nothing is deleted. Clients, caregivers and authorizations (including authorized hours) are not touched; the script proves it (fingerprint before = after).
-- WINDOW A: agency-local 2026-11-01 .. 2026-11-30.   WINDOW B: 2026-12-01 onward.   Shifts with a visit, completed/no-show shifts and Care Request shifts are never cancelled by this script.
-- The expected counts come from the owner's preview; if the data moved since then, the script stops and changes nothing.
\set ON_ERROR_STOP on
\if :{?org_slug}
\else
  \set org_slug ''
\endif
\if :{?expect_nov}
\else
  \echo 'STOP: pass -v expect_nov=<n> -v expect_dec=<n> -v expect_series=<n> from the owner preview'
  \quit
\endif
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';
select pg_advisory_xact_lock(4317111);
select set_config('clear.org_slug', :'org_slug', true), set_config('clear.expect_nov', :'expect_nov', true), set_config('clear.expect_dec', :'expect_dec', true), set_config('clear.expect_series', :'expect_series', true) \gset
do $clear$
declare
  v_org uuid; v_tz text; v_sub text; v_owners int; v_reason constant text := 'Schedule cleared by the owner to rebuild it (2026-11-21)';
  v_nov int; v_dec int; v_series int; v_care int; v_fp_before text; v_fp_after text; v_clients int; v_caregivers int; v_visit_shifts int;
  rec record; v_cancelled int := 0; v_ended int := 0; v_left int;
begin
  select o.id, o.timezone into v_org, v_tz from ogevia.organizations o
   where (nullif(current_setting('clear.org_slug'), '') is not null and o.slug = current_setting('clear.org_slug'))
      or (nullif(current_setting('clear.org_slug'), '') is null and (select count(*) from ogevia.organizations) = 1);
  if v_org is null then raise exception 'Name the agency: pass -v org_slug=<slug>'; end if;
  select count(*), min(u.cognito_sub) into v_owners, v_sub from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id
   where m.organization_id = v_org and m.role = 'organization_owner' and m.status = 'active' and u.status = 'active' and u.cognito_sub is not null;
  if v_owners <> 1 then raise exception 'Expected exactly one active agency owner to act as, found %', v_owners; end if;
  perform ogevia_api.begin_request(v_sub, gen_random_uuid());
  create temp table _w on commit drop as
    select s.id, s.series_id, (s.starts_at at time zone v_tz)::date d, ogevia.shift_is_care_request(s.id) care
      from ogevia.shifts s
     where s.organization_id = v_org and s.status = 'scheduled' and (s.starts_at at time zone v_tz)::date >= date '2026-11-01'
       and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected'));
  select count(*) filter (where d <= date '2026-11-30' and not care), count(*) filter (where d >= date '2026-12-01' and not care), count(*) filter (where care) into v_nov, v_dec, v_care from _w;
  select count(*) into v_series from ogevia.shift_series sr where sr.organization_id = v_org and sr.status = 'active' and coalesce(sr.ends_on, date '9999-12-31') >= date '2026-11-01';
  if v_care > 0 then raise exception 'Care Request shifts are in the window (%); clear those on the Care Requests page first', v_care; end if;
  if v_nov <> current_setting('clear.expect_nov')::int or v_dec <> current_setting('clear.expect_dec')::int or v_series <> current_setting('clear.expect_series')::int then
    raise exception 'The data differs from the preview: November % (expected %), December on % (expected %), active series % (expected %). Nothing was changed.', v_nov, current_setting('clear.expect_nov'), v_dec, current_setting('clear.expect_dec'), v_series, current_setting('clear.expect_series');
  end if;
  select md5(coalesce(string_agg(a::text, '|' order by a.id), '')) into v_fp_before from ogevia.client_authorizations a where a.organization_id = v_org;
  select count(*) into v_clients from ogevia.clients where organization_id = v_org;
  select count(*) into v_caregivers from ogevia.caregiver_records where organization_id = v_org and deleted_at is null;
  select count(*) into v_visit_shifts from ogevia.shifts s where s.organization_id = v_org and exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id);
  -- 1. end every active recurring series from 2026-11-01 (cancels its future unworked shifts; earlier shifts are untouched; the series cannot generate more)
  for rec in select id from ogevia.shift_series where organization_id = v_org and status = 'active' and coalesce(ends_on, date '9999-12-31') >= date '2026-11-01' order by starts_on, id loop
    perform ogevia_api.end_shift_series(v_org, rec.id, date '2026-11-01', v_reason, null); v_ended := v_ended + 1;
  end loop;
  -- 2. cancel every remaining unworked shift in the window (past dates, and any that were not part of a series)
  for rec in select s.id from ogevia.shifts s where s.organization_id = v_org and s.status = 'scheduled' and (s.starts_at at time zone v_tz)::date >= date '2026-11-01'
              and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected')) order by s.starts_at, s.id loop
    perform ogevia_api.cancel_shift(v_org, rec.id, v_reason, null); v_cancelled := v_cancelled + 1;
  end loop;
  -- 3. prove the result before committing
  select count(*) into v_left from ogevia.shifts s where s.organization_id = v_org and s.status = 'scheduled' and (s.starts_at at time zone v_tz)::date >= date '2026-11-01'
     and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected'));
  if v_left <> 0 then raise exception '% unworked shifts are still scheduled; nothing was changed', v_left; end if;
  if (select count(*) from ogevia.shift_series where organization_id = v_org and status = 'active' and coalesce(ends_on, date '9999-12-31') >= date '2026-11-01') <> 0 then raise exception 'a recurring series can still generate shifts; nothing was changed'; end if;
  select md5(coalesce(string_agg(a::text, '|' order by a.id), '')) into v_fp_after from ogevia.client_authorizations a where a.organization_id = v_org;
  if v_fp_after <> v_fp_before then raise exception 'authorizations changed; nothing was changed'; end if;
  if (select count(*) from ogevia.clients where organization_id = v_org) <> v_clients or (select count(*) from ogevia.caregiver_records where organization_id = v_org and deleted_at is null) <> v_caregivers then raise exception 'clients or caregivers changed; nothing was changed'; end if;
  if (select count(*) from ogevia.shifts s where s.organization_id = v_org and exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id)) <> v_visit_shifts then raise exception 'a shift with a visit changed; nothing was changed'; end if;
  if v_cancelled + (select count(*) from ogevia.shifts s where s.organization_id = v_org and s.status = 'cancelled' and s.cancel_reason = v_reason and (s.starts_at at time zone v_tz)::date >= date '2026-11-01') - v_cancelled < 0 then raise exception 'unexpected count'; end if;
  raise notice 'CLEARED: % series ended, % shifts cancelled by this run plus those the series ended (window November: %, December on: % were scheduled). Authorizations, clients, caregivers and visits unchanged.', v_ended, v_cancelled, v_nov, v_dec;
end
$clear$;
select 'cancelled with this reason (all)', count(*) from ogevia.shifts where cancel_reason = 'Schedule cleared by the owner to rebuild it (2026-11-21)';
select 'audit events written', count(*) from ogevia.audit_events where reason = 'Schedule cleared by the owner to rebuild it (2026-11-21)';
commit;
