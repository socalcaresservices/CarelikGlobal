-- Synthetic pilot organization fixture.
--
-- Unlike candidate_hiring_demo_data.sql (one narrow domain), this seeds a
-- full agency lifecycle into an EXISTING organization: clients, hired
-- caregivers (one linked to a real login, one without - exercising both
-- paths), authorizations, ~2 weeks of a recurring Mon/Wed/Fri schedule,
-- a call-out -> Needs Coverage -> reassignment (real coverage history),
-- one extra same-day visit walked through the real verification pipeline
-- to "awaiting signature", credentials in mixed expiry states, one
-- incident, and complimentary billing so nothing looks broken/unpaid.
--
-- Every insert goes through this app's real triggers exactly as the UI
-- would (billing gate, authorization cap/expiry, the caregiver-overlap
-- check, audit logging) - a clean run of this script is itself an
-- integration check across every domain it touches, not just a data dump.
--
-- Run with:
--   psql "$DATABASE_URL" -v organization_id="<uuid>" -f supabase/demo/synthetic_pilot_org_data.sql
--
-- Idempotent: every synthetic row uses a fixed uuid (not gen_random_uuid())
-- so a rerun - even against a *different* target organization - can
-- delete its own prior rows by exact id before reinserting, the same way
-- candidate_hiring_demo_data.sql deletes by its @example.test email
-- pattern. Explicit per-table deletes are used throughout rather than
-- relying on cascade behavior, so this stays correct even where a FK
-- turns out not to cascade.
--
-- NEVER run this against production. It exists to leave a fully
-- populated, walkable pilot organization in the demo project for
-- sales/investor/QA walkthroughs - nothing in this script checks which
-- project it's connected to, so that responsibility is on whoever
-- invokes psql.

\if :{?organization_id}
\else
  \echo 'organization_id is required; no data was written'
  \quit
\endif

begin;

-- Fixed synthetic ids, defined once via a temp table so every later
-- statement in this script can reference them by name instead of
-- repeating long literals (and so the teardown block below and the
-- insert block below can never drift out of sync with each other).
create temporary table pilot_ids (key text primary key, id uuid) on commit drop;
insert into pilot_ids (key, id) values
  ('client_1', 'b1111111-1111-4111-8111-111111111111'),
  ('client_2', 'b2222222-2222-4222-8222-222222222222'),
  ('client_3', 'b3333333-3333-4333-8333-333333333333'),
  ('caregiver_1', 'c1111111-1111-4111-8111-111111111111'),
  ('caregiver_2', 'c2222222-2222-4222-8222-222222222222'),
  ('caregiver_3', 'c3333333-3333-4333-8333-333333333333'),
  ('caregiver_1_user', 'd1111111-1111-4111-8111-111111111111'),
  ('caregiver_2_user', 'd2222222-2222-4222-8222-222222222222');

-- ---------------------------------------------------------------------
-- Teardown (idempotent rerun) - deepest dependents first.
-- ---------------------------------------------------------------------
delete from public.visit_signatures where visit_id in (
  select id from public.service_visits where client_id in (select id from pilot_ids where key like 'client_%')
);
delete from public.service_visits where client_id in (select id from pilot_ids where key like 'client_%');
delete from public.shift_coverage_events where shift_id in (
  select id from public.shifts where client_id in (select id from pilot_ids where key like 'client_%')
);
delete from public.incidents where client_id in (select id from pilot_ids where key like 'client_%');
delete from public.shifts where client_id in (select id from pilot_ids where key like 'client_%');
delete from public.client_authorizations where client_id in (select id from pilot_ids where key like 'client_%');
delete from public.caregiver_record_credentials where caregiver_record_id in (select id from pilot_ids where key like 'caregiver_%' and key not like '%_user');
delete from public.caregiver_record_availability where caregiver_record_id in (select id from pilot_ids where key like 'caregiver_%' and key not like '%_user');
delete from public.caregiver_records where id in (select id from pilot_ids where key like 'caregiver_%' and key not like '%_user');
delete from public.clients where id in (select id from pilot_ids where key like 'client_%');
delete from public.organization_memberships where user_id in (select id from pilot_ids where key like '%_user');
delete from auth.users where id in (select id from pilot_ids where key like '%_user');

-- ---------------------------------------------------------------------
-- Synthetic logins for the two linked caregivers.
-- ---------------------------------------------------------------------
insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, aud, role)
select id, 'pilot.caregiver.' || substring(key from '\d') || '@example.test', '', now(), now(), now(), 'authenticated', 'authenticated'
from pilot_ids where key in ('caregiver_1_user', 'caregiver_2_user');

update public.user_profiles set display_name = 'Pilot Caregiver ' || substring(pilot_ids.key from '\d')
from pilot_ids where user_profiles.id = pilot_ids.id and pilot_ids.key in ('caregiver_1_user', 'caregiver_2_user');

insert into public.organization_memberships (organization_id, user_id, role, status)
select :'organization_id'::uuid, id, 'caregiver', 'active'
from pilot_ids where key in ('caregiver_1_user', 'caregiver_2_user');

-- ---------------------------------------------------------------------
-- Clients.
-- ---------------------------------------------------------------------
insert into public.clients (id, organization_id, first_name, last_name, email, phone, address, care_notes, status)
select id, :'organization_id'::uuid, 'Pilot', 'Client ' || substring(key from '\d'),
  'pilot.client.' || substring(key from '\d') || '@example.test', '555-030' || substring(key from '\d'),
  (200 + substring(key from '\d')::int) || ' Pilot Street', 'SYNTHETIC PILOT DATA - safe to delete', 'active'
from pilot_ids where key like 'client_%';

-- ---------------------------------------------------------------------
-- Caregivers - caregiver_1 and caregiver_2 have a linked login (one is
-- the call-out actor, the other the reassignment target, both need a
-- real user id for call_out_shift/reassign_shift); caregiver_3 has no
-- login, exercising the same "Care Team record without a linked user"
-- path the scheduling form has always supported.
-- ---------------------------------------------------------------------
insert into public.caregiver_records (
  id, organization_id, linked_user_id, first_name, last_name, email, phone, status,
  employment_type, desired_weekly_hours, min_weekly_hours, max_weekly_hours,
  min_shift_hours, max_shift_hours, max_travel_minutes, languages
)
select
  c.id, :'organization_id'::uuid, u.id, 'Pilot', 'Caregiver ' || substring(c.key from '\d'),
  'pilot.caregiver.' || substring(c.key from '\d') || '@example.test', '555-040' || substring(c.key from '\d'), 'active',
  'full_time', 32, 16, 40, 3, 8, 30, array['English']::text[]
from pilot_ids c
left join pilot_ids u on u.key = c.key || '_user'
where c.key like 'caregiver_%' and c.key not like '%_user';

insert into public.caregiver_record_availability (organization_id, caregiver_record_id, day_of_week, start_time, end_time, preference)
select :'organization_id'::uuid, id, day_name::public.weekday, '08:00'::time, '18:00'::time, 'available'::public.availability_preference
from pilot_ids
cross join (values ('monday'), ('tuesday'), ('wednesday'), ('thursday'), ('friday')) days(day_name)
where key like 'caregiver_%' and key not like '%_user';

-- ---------------------------------------------------------------------
-- Authorizations - one active service per client, generous enough hours
-- that the recurring schedule below never trips the monthly cap.
-- ---------------------------------------------------------------------
do $$
declare
  v_org uuid := :'organization_id'::uuid;
  v_service_id uuid;
  v_client_id uuid;
  v_key text;
begin
  select id into v_service_id from public.services where organization_id = v_org and is_active order by created_at limit 1;
  if v_service_id is null then
    raise exception 'Organization % has no active service - add one before running this fixture', v_org;
  end if;

  for v_key in select key from pilot_ids where key like 'client_%' order by key loop
    select id into v_client_id from pilot_ids where key = v_key;
    insert into public.client_authorizations (organization_id, client_id, service_id, payer, max_monthly_hours, period_start, period_end)
    values (v_org, v_client_id, v_service_id, 'Medicaid (synthetic)', 80, current_date - interval '3 months', current_date + interval '9 months');
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Recurring schedule: 3 client/caregiver pairings, Mon/Wed/Fri, one
-- completed past week and one upcoming scheduled week. Pairings 1 and 3
-- share a time slot (09:00-12:00) but use different caregivers - not a
-- conflict. Pairing 2 is offset to 13:00-16:00 specifically so caregiver
-- 2 is free at 09:00-12:00 to receive the reassignment below.
-- ---------------------------------------------------------------------
do $$
declare
  v_org uuid := :'organization_id'::uuid;
  v_admin uuid;
  v_service_id uuid;
  v_this_monday date := date_trunc('week', current_date)::date;
  v_offset int;
  pairing record;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
begin
  select user_id into v_admin from public.organization_memberships
  where organization_id = v_org and role in ('organization_owner', 'organization_admin') and status = 'active'
  order by created_at limit 1;
  if v_admin is null then
    raise exception 'Organization % has no active owner/admin membership to attribute this fixture to', v_org;
  end if;

  select id into v_service_id from public.services where organization_id = v_org and is_active order by created_at limit 1;

  for pairing in
    select * from (values
      ('client_1', 'caregiver_1', '09:00'::time, '12:00'::time),
      ('client_2', 'caregiver_2', '13:00'::time, '16:00'::time),
      ('client_3', 'caregiver_3', '09:00'::time, '12:00'::time)
    ) as p(client_key, caregiver_key, start_time, end_time)
  loop
    foreach v_offset in array array[-7, -5, -3, 7, 9, 11] loop
      select (v_this_monday + v_offset) + pairing.start_time into v_starts_at;
      select (v_this_monday + v_offset) + pairing.end_time into v_ends_at;
      insert into public.shifts (organization_id, client_id, caregiver_record_id, caregiver_user_id, service_id, starts_at, ends_at, notes, created_by)
      select v_org, c.id, cg.id, cgu.id, v_service_id, v_starts_at, v_ends_at, 'SYNTHETIC PILOT DATA - safe to delete', v_admin
      from pilot_ids c, pilot_ids cg
      left join pilot_ids cgu on cgu.key = pairing.caregiver_key || '_user'
      where c.key = pairing.client_key and cg.key = pairing.caregiver_key;
    end loop;

    -- Mark the past week's occurrences completed, same as a manager
    -- using the status dropdown on the Schedule page - not routed
    -- through the visit-verification pipeline, same as that dropdown.
    update public.shifts s
    set status = 'completed'
    from pilot_ids c
    where s.client_id = c.id and c.key = pairing.client_key
      and s.starts_at < now() and s.notes = 'SYNTHETIC PILOT DATA - safe to delete';
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Call-out -> Needs Coverage -> reassignment on pairing 1's next
-- scheduled Monday shift, via the real RPCs (session-simulated), so
-- shift_coverage_events holds a genuine, queryable history.
-- ---------------------------------------------------------------------
do $$
declare
  v_shift_id uuid;
  v_cg1_user uuid;
  v_cg2_user uuid;
  v_admin uuid;
  v_org uuid := :'organization_id'::uuid;
begin
  select id into v_cg1_user from pilot_ids where key = 'caregiver_1_user';
  select id into v_cg2_user from pilot_ids where key = 'caregiver_2_user';
  select user_id into v_admin from public.organization_memberships
  where organization_id = v_org and role in ('organization_owner', 'organization_admin') and status = 'active'
  order by created_at limit 1;

  select s.id into v_shift_id
  from public.shifts s
  join pilot_ids c on c.id = s.client_id and c.key = 'client_1'
  where s.status = 'scheduled' and s.starts_at > now()
  order by s.starts_at limit 1;

  if v_shift_id is not null then
    perform set_config('request.jwt.claim.sub', v_cg1_user::text, true);
    set local role authenticated;
    perform public.call_out_shift(v_shift_id, 'SYNTHETIC PILOT DATA - illness, safe to delete');
    reset role;

    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    set local role authenticated;
    perform public.reassign_shift(v_shift_id, v_cg2_user, 'SYNTHETIC PILOT DATA - caregiver 2 covering, safe to delete');
    reset role;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- One extra, same-day, one-off visit (not part of the recurring
-- pattern) walked through the real verification pipeline up to
-- "awaiting signature" - the furthest a script can honestly take it
-- without a real signature image upload to Storage, which
-- sign_service_visit correctly requires and this fixture deliberately
-- does not fake.
-- ---------------------------------------------------------------------
do $$
declare
  v_org uuid := :'organization_id'::uuid;
  v_admin uuid;
  v_service_id uuid;
  v_client_id uuid;
  v_cg_record_id uuid;
  v_cg_user_id uuid;
  v_shift_id uuid;
  v_visit_id uuid;
begin
  select user_id into v_admin from public.organization_memberships
  where organization_id = v_org and role in ('organization_owner', 'organization_admin') and status = 'active'
  order by created_at limit 1;
  select id into v_service_id from public.services where organization_id = v_org and is_active order by created_at limit 1;
  select id into v_client_id from pilot_ids where key = 'client_1';
  select id into v_cg_record_id from pilot_ids where key = 'caregiver_1';
  select id into v_cg_user_id from pilot_ids where key = 'caregiver_1_user';

  insert into public.shifts (organization_id, client_id, caregiver_record_id, caregiver_user_id, service_id, starts_at, ends_at, notes, created_by)
  values (v_org, v_client_id, v_cg_record_id, v_cg_user_id, v_service_id, current_date + time '14:00', current_date + time '16:00', 'SYNTHETIC PILOT DATA - extra pickup shift, safe to delete', v_admin)
  returning id into v_shift_id;

  perform set_config('request.jwt.claim.sub', v_cg_user_id::text, true);
  set local role authenticated;
  v_visit_id := public.start_service_visit(v_org, v_shift_id, array['personal_care']::text[], 'SYNTHETIC PILOT DATA - safe to delete');
  reset role;

  -- Backdate time_in so end_service_visit computes a realistic ~2-hour
  -- duration instead of the near-zero minutes a same-instant start/end
  -- would otherwise produce. Done outside the authenticated role - RLS
  -- has no general UPDATE policy on service_visits for its own caregiver
  -- (writes to it are meant to only ever happen through the RPCs above),
  -- so this update has to run as this script's own elevated role.
  update public.service_visits set time_in = now() - interval '2 hours' where id = v_visit_id;

  perform set_config('request.jwt.claim.sub', v_cg_user_id::text, true);
  set local role authenticated;
  perform public.end_service_visit(v_visit_id);
  reset role;
end $$;

-- ---------------------------------------------------------------------
-- Credentials - mixed expiry states so the Credentials page shows
-- something real: valid, expiring soon, and already expired.
-- ---------------------------------------------------------------------
insert into public.caregiver_record_credentials (organization_id, caregiver_record_id, credential_type, issue_date, expiration_date, does_not_expire, issuing_organization, verification_status, notes)
select :'organization_id'::uuid, id, 'CPR Certification', current_date - interval '1 year', current_date + interval '3 years', false, 'American Red Cross', 'verified', 'SYNTHETIC PILOT DATA - safe to delete'
from pilot_ids where key = 'caregiver_1'
union all
select :'organization_id'::uuid, id, 'Background Check', current_date - interval '2 years', current_date + interval '20 days', false, 'State DOJ', 'verified', 'SYNTHETIC PILOT DATA - safe to delete'
from pilot_ids where key = 'caregiver_1'
union all
select :'organization_id'::uuid, id, 'Driver''s License', current_date - interval '4 years', current_date - interval '10 days', false, 'DMV', 'verified', 'SYNTHETIC PILOT DATA - safe to delete'
from pilot_ids where key = 'caregiver_2';

-- ---------------------------------------------------------------------
-- One incident, resolved, tied to a completed past shift.
-- ---------------------------------------------------------------------
do $$
declare
  v_org uuid := :'organization_id'::uuid;
  v_client_id uuid;
  v_cg_user_id uuid;
  v_shift_id uuid;
  v_admin uuid;
begin
  select id into v_client_id from pilot_ids where key = 'client_1';
  select id into v_cg_user_id from pilot_ids where key = 'caregiver_1_user';
  select user_id into v_admin from public.organization_memberships
  where organization_id = v_org and role in ('organization_owner', 'organization_admin') and status = 'active'
  order by created_at limit 1;

  select s.id into v_shift_id from public.shifts s
  where s.client_id = v_client_id and s.status = 'completed'
  order by s.starts_at desc limit 1;

  insert into public.incidents (organization_id, client_id, caregiver_user_id, shift_id, occurred_at, category, severity, status, description, reported_by, resolution_notes, resolved_at, created_by)
  values (
    v_org, v_client_id, v_cg_user_id, v_shift_id, coalesce((select starts_at from public.shifts where id = v_shift_id), now() - interval '5 days'),
    'Minor injury', 'low', 'resolved',
    'SYNTHETIC PILOT DATA - client reported a minor bruise from a fall in the bathroom; caregiver assisted immediately, no further care needed.',
    v_cg_user_id, 'SYNTHETIC PILOT DATA - discussed with family, no follow-up required.', now() - interval '4 days', v_admin
  );
end $$;

-- ---------------------------------------------------------------------
-- Billing: complimentary, so the pilot org never shows a trial-expiry
-- or payment-required banner mid-walkthrough.
-- ---------------------------------------------------------------------
-- prevent_tenant_subscription_edit blocks any non-platform-owner write
-- to billing columns; app.bypass_subscription_guard is its documented
-- escape hatch for exactly this kind of trusted, elevated script.
set local app.bypass_subscription_guard = 'on';
update public.organizations set is_complimentary = true where id = :'organization_id'::uuid;

commit;
