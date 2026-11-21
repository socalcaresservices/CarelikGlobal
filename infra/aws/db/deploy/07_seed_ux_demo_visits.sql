-- DEMO (ogevia_sv_test) seed for the UX redesign milestones: a caregiver with a visit SCHEDULED TODAY, a second one later today, and an assigned client with NO
-- shift (so the "unscheduled visit" path can be tried). SYNTHETIC ONLY: three clients named "Demo Today A", "Demo Today B", "Demo Unscheduled (synthetic)".
--
--   psql "$DEMO_DB_URL" -v org_slug=<agency slug> -v caregiver_code=<code of a caregiver who can sign in> -f 07_seed_ux_demo_visits.sql
--
-- It REFUSES any database that is not named ogevia_sv_test (never production: ogevia_prd). Run it again at any time: it adds nothing that already exists and
-- re-creates only today's shifts, so each morning you can run it once more to have a visit for the day. Shifts are created through the real application
-- function (ogevia_api.create_shift) as the agency's owner, so the authorization reservation, overlap and readiness rules apply exactly as in the product.
-- If a rule refuses a shift (for example the caregiver is not approved for work, or an hour limit is reached) the script says which one and carries on.
-- It writes no audit rows by hand, deletes nothing, and never touches another agency. Do not run it after 21:00 Pacific (the shifts must end the same day).
\set ON_ERROR_STOP on
\if :{?org_slug} \else \echo 'usage: psql <db> -v org_slug=<slug> -v caregiver_code=<code> -f 07_seed_ux_demo_visits.sql' \quit \endif
\if :{?caregiver_code} \else \echo 'usage: psql <db> -v org_slug=<slug> -v caregiver_code=<code> -f 07_seed_ux_demo_visits.sql' \quit \endif

select set_config('ux.org_slug', :'org_slug', false), set_config('ux.cg_code', :'caregiver_code', false) \gset

do $$
declare
  v_org uuid; v_cg uuid; v_cg_user uuid; v_actor_sub text; v_service uuid; v_tz text; v_local timestamp;
  v_names text[] := array['Today A', 'Today B', 'Unscheduled (synthetic)'];
  v_name text; v_client uuid; v_i int := 0; v_start time; v_end time; v_day date; v_made int := 0;
begin
  if current_database() <> 'ogevia_sv_test' then
    raise exception 'REFUSED: this seed runs only in ogevia_sv_test (this database is %)', current_database();
  end if;
  select id, coalesce(timezone, 'America/Los_Angeles') into v_org, v_tz from ogevia.organizations where slug = current_setting('ux.org_slug');
  if v_org is null then raise exception 'No agency with slug %', current_setting('ux.org_slug'); end if;
  select id, linked_user_id into v_cg, v_cg_user from ogevia.caregiver_records
   where organization_id = v_org and caregiver_code = current_setting('ux.cg_code') and deleted_at is null;
  if v_cg is null then raise exception 'No caregiver with code % in this agency', current_setting('ux.cg_code'); end if;
  if v_cg_user is null then raise exception 'Caregiver % has no sign-in; choose one who can sign in to demo.ogevia.com', current_setting('ux.cg_code'); end if;
  select u.cognito_sub into v_actor_sub from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id
   where m.organization_id = v_org and m.role = 'organization_owner' and m.status = 'active' order by m.created_at limit 1;
  if v_actor_sub is null then raise exception 'This agency has no active owner to act as'; end if;
  select id into v_service from ogevia.services where organization_id = v_org and is_active and deleted_at is null order by name limit 1;
  if v_service is null then raise exception 'This agency has no active service'; end if;
  v_local := now() at time zone v_tz;
  v_day := v_local::date;
  if v_local::time > time '21:00' then raise exception 'It is after 21:00 in the agency time zone; run this earlier in the day so today''s shifts end today'; end if;

  foreach v_name in array v_names loop
    v_i := v_i + 1;
    select c.id into v_client from ogevia.clients c join ogevia.client_private_names n on n.client_id = c.id
     where c.organization_id = v_org and n.legal_first_name = 'Demo' and n.legal_last_name = v_name;
    if v_client is null then
      insert into ogevia.clients (organization_id) values (v_org) returning id into v_client;
      set local role ogevia_app;
      perform ogevia_api.begin_request(v_actor_sub, gen_random_uuid());
      perform ogevia_api.set_client_legal_name(v_org, v_client, 'Demo', v_name, null);
      reset role;
      insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end, hourly_rate_cents)
      values (v_org, v_client, v_service, 'Synthetic Regional Center (demo)', 40 * 60, (date_trunc('month', now()) - interval '1 month')::date, (date_trunc('month', now()) + interval '3 months')::date, 3200);
      insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, caregiver_record_id, client_id, service_id, effective_start)
      values (v_org, v_cg_user, v_cg, v_client, v_service, (now() - interval '30 days')::date);
      raise notice 'created client Demo % and assigned it to %', v_name, current_setting('ux.cg_code');
    end if;
    -- The two "Today" clients get a shift today: A now (10 minutes ago, two hours long), B starting two hours and ten minutes from now (only before 18:00).
    if v_i = 1 then
      v_start := date_trunc('minute', v_local - interval '10 minutes')::time; v_end := (date_trunc('minute', v_local) + interval '110 minutes')::time;
    elsif v_i = 2 and v_local::time <= time '18:00' then
      v_start := (date_trunc('minute', v_local) + interval '130 minutes')::time; v_end := (date_trunc('minute', v_local) + interval '250 minutes')::time;
    else
      continue;
    end if;
    if v_start > v_end then raise notice 'skipped the shift for Demo %: it would cross midnight', v_name; continue; end if;
    if exists (select 1 from ogevia.shifts s where s.organization_id = v_org and s.client_id = v_client and s.starts_at >= (v_day::timestamp at time zone v_tz) and s.starts_at < ((v_day + 1)::timestamp at time zone v_tz) and s.status <> 'cancelled') then
      raise notice 'Demo % already has a shift today; left as it is', v_name; continue;
    end if;
    begin
      set local role ogevia_app;
      perform ogevia_api.begin_request(v_actor_sub, gen_random_uuid());
      perform 1 from ogevia_api.create_shift(v_org, v_client, v_service, v_day, v_start, v_end, v_cg, null);
      reset role;
      v_made := v_made + 1;
      raise notice 'created today''s shift % to % for Demo %', v_start, v_end, v_name;
    exception when others then
      reset role;
      raise notice 'NOT created for Demo %: % (the application rule that refused it)', v_name, sqlerrm;
    end;
  end loop;
  raise notice 'done: % shift(s) created today for caregiver %', v_made, current_setting('ux.cg_code');
end
$$;

-- What the caregiver will see today (read-only check).
select s.starts_at at time zone coalesce(o.timezone, 'America/Los_Angeles') as starts_local, s.ends_at at time zone coalesce(o.timezone, 'America/Los_Angeles') as ends_local,
       n.legal_first_name || ' ' || n.legal_last_name as client
  from ogevia.shifts s join ogevia.organizations o on o.id = s.organization_id
  join ogevia.client_private_names n on n.client_id = s.client_id
 where o.slug = :'org_slug' and n.legal_first_name = 'Demo' and n.legal_last_name in ('Today A', 'Today B')
   and s.starts_at >= (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date::timestamp at time zone coalesce(o.timezone, 'America/Los_Angeles')
   and s.status <> 'cancelled'
 order by s.starts_at;
