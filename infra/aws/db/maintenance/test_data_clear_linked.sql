-- REMOVE THE TEST RECORDS THAT HANG OFF THE RETAINED TEST CLIENTS (option 1). The inactive client rows and their authorizations STAY. DRY-RUN BY DEFAULT.
--
--   psql ... -v org_slug=socal-care-services -v expected_clients=<N from the preview> -f test_data_clear_linked.sql                          (dry run)
--   psql ... -v org_slug=... -v expected_clients=<N> -v mode=apply -v snapshot_id=<verified RDS snapshot id> \
--            -v confirm=CLEAR-<org_slug>-<N> -f test_data_clear_linked.sql                                                                  (apply)
--
-- Removed, for the clients in scope only: shifts, authorization reservations, shift coverage and readiness events, care requests with their offers, events
-- and notifications, availability overrides, caregiver assignments with their readiness flags, client care portals, preparation and experience
-- requirements, service-area ZIPs and the clients' legal NAMES. Recurring series are removed only where the database allows; a series that still
-- carries protected skipped-date history stays, and nothing regenerates shifts from it (no scheduled job does).
--
-- Never touched: the client rows, client_authorizations (and every other delete-protected table), caregivers and their sign-ins, memberships, services,
-- settings, idempotency records, audit history. It never disables a trigger and refuses to run if a protection is off or triggers are suppressed.
-- Each statement runs in its own savepoint: if the database refuses (a protected child), that step is rolled back, reported KEPT, and the run goes on.
-- Before commit it re-counts EVERY table that has an organization_id and aborts unless only the tables listed above (plus one audit event) changed.
\set ON_ERROR_STOP on
\if :{?mode}
\else
  \set mode dry-run
\endif
\if :{?confirm}
\else
  \set confirm ''
\endif
\if :{?snapshot_id}
\else
  \set snapshot_id ''
\endif

begin;
select set_config('og.org_slug', :'org_slug', true), set_config('og.expected', :'expected_clients', true), set_config('og.mode', :'mode', true),
       set_config('og.confirm', :'confirm', true), set_config('og.snapshot', :'snapshot_id', true) \gset

create temp table clear_report (section text not null, item text not null, n bigint not null, note text) on commit drop;
create temp table counts_before (tbl text primary key, n bigint not null) on commit drop;

do $clear$
declare
  v_org uuid;
  v_mode text := current_setting('og.mode');
  v_slug text := current_setting('og.org_slug');
  v_expected integer := current_setting('og.expected')::integer;
  v_snapshot text := current_setting('og.snapshot');
  c record; s record; sh record;
  n bigint; v_in_scope integer; v_active integer;
  v_tbl text; v_con text; v_note text;
  v_triggers_before bigint; v_triggers_after bigint;
  v_auth_ids_before text; v_auth_ids_after text;
  v_cg_before text; v_cg_after text;
  v_t text; v_n_after bigint; v_n_before bigint;
  -- (label, statement template with %1$L = client id). Protected tables are never named here.
  v_steps text[][] := array[
    ['authorization_reservations', 'delete from ogevia.authorization_reservations where shift_id in (select id from ogevia.shifts where client_id = %1$L) or care_request_id in (select id from ogevia.care_requests where client_id = %1$L)'],
    ['care_notifications',         'delete from ogevia.care_notifications where care_request_id in (select id from ogevia.care_requests where client_id = %1$L)'],
    ['care_request_offers',        'delete from ogevia.care_request_offers where care_request_id in (select id from ogevia.care_requests where client_id = %1$L)'],
    ['care_request_events',        'delete from ogevia.care_request_events where care_request_id in (select id from ogevia.care_requests where client_id = %1$L) or shift_id in (select id from ogevia.shifts where client_id = %1$L)'],
    ['shift_coverage_events',      'delete from ogevia.shift_coverage_events where shift_id in (select id from ogevia.shifts where client_id = %1$L)'],
    ['shift_readiness_flags',      'delete from ogevia.shift_readiness_flags where shift_id in (select id from ogevia.shifts where client_id = %1$L)'],
    ['availability_overrides',     'delete from ogevia.availability_overrides where client_id = %1$L'],
    ['care_requests',              'delete from ogevia.care_requests where client_id = %1$L'],
    ['assignment_readiness_flags', 'delete from ogevia.assignment_readiness_flags where assignment_id in (select id from ogevia.caregiver_assignments where client_id = %1$L)'],
    ['caregiver_assignments',      'delete from ogevia.caregiver_assignments where client_id = %1$L'],
    ['client_care_portals',        'delete from ogevia.client_care_portals where client_id = %1$L'],
    ['client_experience_requirements', 'delete from ogevia.client_experience_requirements where client_id = %1$L'],
    ['client_preparation',         'delete from ogevia.client_preparation where client_id = %1$L'],
    ['client_private_names',       'delete from ogevia.client_private_names where client_id = %1$L'],
    ['client_service_zip',         'delete from ogevia.client_service_zip where client_id = %1$L']
  ];
  v_i integer;
  v_allowed text[] := array['authorization_reservations','care_notifications','care_request_offers','care_request_events','shift_coverage_events','shift_readiness_flags',
    'availability_overrides','care_requests','assignment_readiness_flags','caregiver_assignments','client_care_portals','client_experience_requirements',
    'client_preparation','client_private_names','client_service_zip','shifts','shift_series','audit_events'];
begin
  if v_mode not in ('dry-run', 'apply') then raise exception 'mode must be dry-run or apply'; end if;
  select id into v_org from ogevia.organizations where slug = v_slug;
  if v_org is null then raise exception 'Refusing: agency "%" not found', v_slug; end if;
  if v_mode = 'apply' then
    if current_setting('og.confirm') <> format('CLEAR-%s-%s', v_slug, v_expected) then raise exception 'Refusing: apply needs confirm=CLEAR-%-% exactly', v_slug, v_expected; end if;
    if v_snapshot !~ '^[A-Za-z0-9-]{10,80}$' then raise exception 'Refusing: apply needs snapshot_id, the id of a verified RDS snapshot'; end if;
  end if;
  if current_setting('session_replication_role') <> 'origin' then raise exception 'Refusing: session_replication_role is %, triggers would be skipped', current_setting('session_replication_role'); end if;
  select count(*) into v_triggers_before from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'forbid_delete' and not t.tgisinternal and t.tgenabled = 'O';
  if v_triggers_before = 0 or exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'forbid_delete' and not t.tgisinternal and t.tgenabled <> 'O') then
    raise exception 'Refusing: delete-protection triggers are missing or disabled';
  end if;

  create temp table scope_clients on commit drop as select id, status from ogevia.clients where organization_id = v_org;
  select count(*) into v_in_scope from scope_clients;
  select count(*) into v_active from scope_clients where status <> 'inactive';
  insert into clear_report values ('scope', 'clients in scope', v_in_scope, null), ('scope', 'clients in scope that are NOT inactive', v_active, null);
  if v_in_scope <> v_expected then raise exception 'Refusing: % clients are in scope but expected_clients=% (re-run the preview); nothing was changed', v_in_scope, v_expected; end if;
  if v_active > 0 then raise exception 'Refusing: % in-scope client(s) are not inactive. Only the retained inactive test clients are cleared; nothing was changed', v_active; end if;

  -- Baseline: every organization-scoped table, the authorization ids and the caregiver sign-in links.
  for v_t in select c2.table_name from information_schema.columns c2
              join information_schema.tables t2 on t2.table_schema = c2.table_schema and t2.table_name = c2.table_name and t2.table_type = 'BASE TABLE'
             where c2.table_schema = 'ogevia' and c2.column_name = 'organization_id' loop
    execute format('select count(*) from ogevia.%I where organization_id = $1', v_t) into n using v_org;
    insert into counts_before values (v_t, n);
  end loop;
  select coalesce(md5(string_agg(id::text, ',' order by id)), '') into v_auth_ids_before from ogevia.client_authorizations where organization_id = v_org;
  select coalesce(md5(string_agg(id::text || ':' || coalesce(linked_user_id::text, ''), ',' order by id)), '') into v_cg_before from ogevia.caregiver_records where organization_id = v_org;

  for c in select id from scope_clients order by id loop
    for v_i in 1 .. array_length(v_steps, 1) loop
      begin
        execute format(v_steps[v_i][2], c.id);
        get diagnostics n = row_count;
        insert into clear_report values ('removed', v_steps[v_i][1], n, null);
      exception when foreign_key_violation then
        get stacked diagnostics v_tbl = table_name;
        insert into clear_report values ('kept', v_steps[v_i][1], 1, 'blocked by ' || coalesce(v_tbl, 'a related record'));
      end;
    end loop;
    -- Shifts: all at once; if any carries a protected child, one by one so the others still go.
    begin
      delete from ogevia.shifts where client_id = c.id;
      get diagnostics n = row_count;
      insert into clear_report values ('removed', 'shifts', n, null);
    exception when foreign_key_violation then
      for sh in select id from ogevia.shifts where client_id = c.id loop
        begin
          delete from ogevia.shifts where id = sh.id;
          insert into clear_report values ('removed', 'shifts', 1, null);
        exception when foreign_key_violation then
          get stacked diagnostics v_tbl = table_name;
          insert into clear_report values ('kept', 'shifts', 1, 'blocked by ' || coalesce(v_tbl, 'a related record'));
        end;
      end loop;
    end;
    -- Recurring series: removed one by one only where the database allows it (protected skipped-date history keeps a series).
    for s in select id from ogevia.shift_series where client_id = c.id loop
      begin
        delete from ogevia.shift_series where id = s.id;
        insert into clear_report values ('removed', 'shift_series', 1, null);
      exception when foreign_key_violation then
        get stacked diagnostics v_tbl = table_name;
        insert into clear_report values ('kept', 'shift_series', 1, 'protected history: ' || coalesce(v_tbl, 'a related record'));
      end;
    end loop;
  end loop;

  -- Post-conditions: nothing outside the listed tables changed, and what must stay is byte-for-byte what it was.
  for v_t in select tbl from counts_before order by tbl loop
    execute format('select count(*) from ogevia.%I where organization_id = $1', v_t) into v_n_after using v_org;
    select cb.n into v_n_before from counts_before cb where cb.tbl = v_t;
    if v_n_after <> v_n_before then
      if not (v_t = any (v_allowed)) then raise exception 'Abort: table % changed (% -> %) but is not part of this cleanup', v_t, v_n_before, v_n_after; end if;
      if v_t <> 'audit_events' and v_n_after > v_n_before then raise exception 'Abort: table % grew during a removal', v_t; end if;
    end if;
    if v_t = any (v_allowed) and v_t <> 'audit_events' then insert into clear_report values ('counts', v_t, v_n_before, 'after: ' || v_n_after); end if;
  end loop;
  select coalesce(md5(string_agg(id::text, ',' order by id)), '') into v_auth_ids_after from ogevia.client_authorizations where organization_id = v_org;
  select coalesce(md5(string_agg(id::text || ':' || coalesce(linked_user_id::text, ''), ',' order by id)), '') into v_cg_after from ogevia.caregiver_records where organization_id = v_org;
  if v_auth_ids_after <> v_auth_ids_before then raise exception 'Abort: authorizations changed'; end if;
  if v_cg_after <> v_cg_before then raise exception 'Abort: caregiver records or their sign-in links changed'; end if;
  if (select count(*) from ogevia.clients where organization_id = v_org) <> v_in_scope then raise exception 'Abort: client rows changed'; end if;
  select count(*) into v_triggers_after from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'forbid_delete' and not t.tgisinternal and t.tgenabled = 'O';
  if v_triggers_after <> v_triggers_before then raise exception 'Abort: delete-protection triggers changed'; end if;
  insert into clear_report values ('preserved', 'client rows (inactive)', v_in_scope, null),
    ('preserved', 'client authorizations', (select count(*) from ogevia.client_authorizations where organization_id = v_org), null),
    ('preserved', 'caregiver records (sign-in links identical)', (select count(*) from ogevia.caregiver_records where organization_id = v_org), null),
    ('preserved', 'delete-protection triggers enabled', v_triggers_after, null);

  if v_mode = 'apply' then
    perform ogevia.write_audit(v_org, 'client.test_linked_data_removed', 'organizations', v_org, null,
      jsonb_build_object('clients_in_scope', v_in_scope, 'snapshot', v_snapshot,
        'removed', (select coalesce(jsonb_object_agg(item, total), '{}'::jsonb) from (select r0.item, sum(r0.n) total from clear_report r0 where r0.section = 'removed' group by r0.item) r),
        'scope', 'inactive test clients; client rows and authorizations retained'), 'confirmed test data');
  end if;
end
$clear$;

\echo '== Report (counts only). Mode:' :mode
select section, item, sum(n) as n, string_agg(distinct note, '; ') as note from clear_report group by section, item
order by case section when 'scope' then 1 when 'removed' then 2 when 'kept' then 3 when 'counts' then 4 else 5 end, item;

select :'mode' = 'apply' as do_commit \gset
\if :do_commit
  commit;
  \echo 'APPLIED: the transaction was committed.'
\else
  rollback;
  \echo 'DRY RUN: the transaction was rolled back. Nothing changed.'
\endif
