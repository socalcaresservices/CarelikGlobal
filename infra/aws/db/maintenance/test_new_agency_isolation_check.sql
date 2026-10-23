-- TEST DATABASE ONLY. New-agency emptiness and isolation check. It creates two synthetic agencies with an owner each, runs the checks through the application's
-- own functions exactly as the API does (SET LOCAL ROLE ogevia_app + ogevia_api.begin_request), and ALWAYS ENDS WITH ROLLBACK: no agency, user, client or audit
-- row remains. It refuses any database except ogevia_sv_test.
--
--   psql ... -d ogevia_sv_test -f test_new_agency_isolation_check.sql
--
-- Checks (each raises, and so fails the run, if it does not hold):
--   1. both new agencies hold ZERO rows in every client-, caregiver-, authorization-, shift-, visit-, document- and billing-related table;
--   2. each owner sees empty client, caregiver, shift, open-shift, reconciliation and staff-document lists;
--   3. after agency A creates a client, agency B still sees nothing, and B asking for A's organization or for A's client gets no rows.
-- If the database master cannot assume the application role, it stops with NOT RUN and checks nothing (it never falls back to a weaker check).
\set ON_ERROR_STOP on
select current_database() = 'ogevia_sv_test' as in_test \gset
\if :in_test
\else
  do $$ begin raise exception 'Refusing: this check runs only in the TEST database ogevia_sv_test.'; end $$;
\endif

begin;
do $chk$
declare
  v_tables text[] := array['clients','client_private_names','client_preparation','client_authorizations','authorization_reservations','client_service_holds',
    'client_care_portals','client_documents','client_document_versions','caregiver_records','caregiver_assignments','caregiver_onboarding_items',
    'staff_documents','shifts','care_requests','service_visits','visit_confirmations','visit_evidence','billing_approvals'];
  v_sub_a text := gen_random_uuid()::text; v_sub_b text := gen_random_uuid()::text;
  v_user_a uuid; v_user_b uuid; v_org_a uuid; v_org_b uuid; v_client uuid;
  v_org uuid; v_sub text; v_t text; n bigint;
begin
  begin
    set local role ogevia_app;
    reset role;
  exception when insufficient_privilege then
    raise exception 'NOT RUN: the database master cannot assume the application role ogevia_app, so the check would not run as the API runs. Nothing was checked and nothing was changed.';
  end;

  insert into ogevia.app_users (cognito_sub, display_name) values (v_sub_a, 'Isolation check owner A (synthetic)') returning id into v_user_a;
  insert into ogevia.app_users (cognito_sub, display_name) values (v_sub_b, 'Isolation check owner B (synthetic)') returning id into v_user_b;
  insert into ogevia.organizations (slug, display_name, timezone) values ('verify-a-' || substr(md5(random()::text), 1, 8), 'Verify agency A (synthetic)', 'America/Los_Angeles') returning id into v_org_a;
  insert into ogevia.organizations (slug, display_name, timezone) values ('verify-b-' || substr(md5(random()::text), 1, 8), 'Verify agency B (synthetic)', 'America/Los_Angeles') returning id into v_org_b;
  insert into ogevia.organization_memberships (organization_id, user_id, role, status) values (v_org_a, v_user_a, 'organization_owner', 'active'), (v_org_b, v_user_b, 'organization_owner', 'active');

  -- 1. storage level: every listed table exists, has an organization_id, and is empty for both new agencies.
  foreach v_t in array v_tables loop
    if not exists (select 1 from information_schema.columns where table_schema = 'ogevia' and table_name = v_t and column_name = 'organization_id') then
      raise exception 'CHECK FAILED: % is not an ogevia table with organization_id', v_t;
    end if;
    foreach v_org in array array[v_org_a, v_org_b] loop
      execute format('select count(*) from ogevia.%I where organization_id = $1', v_t) into n using v_org;
      if n <> 0 then raise exception 'CHECK FAILED: a new agency has % rows in %', n, v_t; end if;
    end loop;
  end loop;
  raise notice 'PASS 1: both new agencies hold zero rows in all % client, caregiver, authorization, shift, visit, document and billing tables', array_length(v_tables, 1);

  -- 2. API level, as each owner: empty lists.
  for v_org, v_sub in select * from (values (v_org_a, v_sub_a), (v_org_b, v_sub_b)) as t(o, s) loop
    set local role ogevia_app;
    perform ogevia_api.begin_request(v_sub, gen_random_uuid());
    select count(*) into n from ogevia_api.list_clients(v_org);              if n <> 0 then raise exception 'CHECK FAILED: list_clients returned % rows for a new agency', n; end if;
    select count(*) into n from ogevia_api.list_client_directory(v_org);     if n <> 0 then raise exception 'CHECK FAILED: list_client_directory returned % rows', n; end if;
    select count(*) into n from ogevia_api.list_caregivers(v_org);           if n <> 0 then raise exception 'CHECK FAILED: list_caregivers returned % rows', n; end if;
    select count(*) into n from ogevia_api.list_shifts(v_org, date '2026-01-01', date '2027-12-31'); if n <> 0 then raise exception 'CHECK FAILED: list_shifts returned % rows', n; end if;
    select count(*) into n from ogevia_api.list_open_shifts(v_org);          if n <> 0 then raise exception 'CHECK FAILED: list_open_shifts returned % rows', n; end if;
    select count(*) into n from ogevia_api.list_shifts_to_reconcile(v_org);  if n <> 0 then raise exception 'CHECK FAILED: list_shifts_to_reconcile returned % rows', n; end if;
    select count(*) into n from ogevia_api.list_staff_documents(v_org);      if n <> 0 then raise exception 'CHECK FAILED: list_staff_documents returned % rows', n; end if;
    reset role;
  end loop;
  raise notice 'PASS 2: each owner sees empty client, caregiver, shift, open-shift, reconciliation and staff-document lists';

  -- 3. isolation: A starts working; B must see nothing of A, by organization or by client id.
  set local role ogevia_app;
  perform ogevia_api.begin_request(v_sub_a, gen_random_uuid());
  select client_id into v_client from ogevia_api.create_client(v_org_a, 'Synthetic', 'Isolation Check', null, null, null, null);
  select count(*) into n from ogevia_api.list_clients(v_org_a);
  if n <> 1 then raise exception 'CHECK FAILED: agency A sees % clients after creating one', n; end if;
  reset role;
  set local role ogevia_app;
  perform ogevia_api.begin_request(v_sub_b, gen_random_uuid());
  select count(*) into n from ogevia_api.list_clients(v_org_b);                      if n <> 0 then raise exception 'CHECK FAILED: agency B sees % clients of its own', n; end if;
  select count(*) into n from ogevia_api.list_clients(v_org_a);                      if n <> 0 then raise exception 'CHECK FAILED: LEAK: agency B read % clients of agency A', n; end if;
  select count(*) into n from ogevia_api.list_client_directory(v_org_a);             if n <> 0 then raise exception 'CHECK FAILED: LEAK: agency B read A''s client directory (% rows)', n; end if;
  select count(*) into n from ogevia_api.list_caregivers(v_org_a);                   if n <> 0 then raise exception 'CHECK FAILED: LEAK: agency B read A''s caregivers'; end if;
  select count(*) into n from ogevia_api.list_client_authorizations(v_org_a, v_client); if n <> 0 then raise exception 'CHECK FAILED: LEAK: agency B read A''s client authorizations'; end if;
  select count(*) into n from ogevia_api.list_client_authorizations(v_org_b, v_client); if n <> 0 then raise exception 'CHECK FAILED: LEAK: B''s own scope returned A''s client'; end if;
  reset role;
  raise notice 'PASS 3: after agency A created a client, agency B sees nothing of it (by organization or by client id) and still sees an empty agency';
end
$chk$;
rollback;
\echo 'RESULT: all checks passed. ROLLED BACK: no agency, user, client or audit row remains.'
select count(*) as verification_agencies_left_behind from ogevia.organizations where slug like 'verify-a-%' or slug like 'verify-b-%';
