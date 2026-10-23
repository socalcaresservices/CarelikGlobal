-- SCOPED REMOVAL of confirmed TEST clients (and the unprotected records that hang off them) from ONE agency.
-- DRY-RUN BY DEFAULT: the same logic runs and the transaction is rolled back, so the report shows exactly what an apply would do.
--
--   psql ... -v org_slug=socal-care-services -v expected_clients=<N from the preview> -f test_data_purge.sql                       (dry run)
--   psql ... -v org_slug=... -v expected_clients=<N> -v mode=apply -v snapshot_id=<verified RDS snapshot id> \
--            -v confirm=PURGE-<org_slug>-<N> -f test_data_purge.sql                                                               (apply)
--   optional: -v scope_created_before=2026-10-23   (only clients created before that date; default is every client of the agency)
--
-- It NEVER bypasses a protection. It does not disable triggers, does not change session_replication_role, and refuses to run if any delete-protection
-- trigger is disabled. Each client is removed in its own savepoint: first the unprotected dependents (shifts, care requests, assignments, portals,
-- preparation, names, ...), then the client row. If the database refuses (the client still has a protected child: an authorization, document, service
-- hold, visit, confirmation, billing record, pickup request or reconciliation), that client is rolled back to exactly its prior state and reported as
-- KEPT. Protected rows are never touched.
--
-- Preserved by construction and re-checked before commit: the agency, its memberships (administrator access), settings, caregivers, every audit event.
-- One audit event (counts only, no names, codes or ids) records an apply.
\set ON_ERROR_STOP on
\if :{?mode}
\else
  \set mode dry-run
\endif
\if :{?scope_created_before}
\else
  \set scope_created_before ''
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
       set_config('og.cutoff', :'scope_created_before', true), set_config('og.confirm', :'confirm', true), set_config('og.snapshot', :'snapshot_id', true) \gset

create temp table purge_report (section text not null, item text not null, n bigint not null, note text) on commit drop;

do $purge$
declare
  v_org uuid;
  v_mode text := current_setting('og.mode');
  v_slug text := current_setting('og.org_slug');
  v_expected integer := current_setting('og.expected')::integer;
  v_cutoff text := current_setting('og.cutoff');
  v_snapshot text := current_setting('og.snapshot');
  c record;
  n bigint;
  v_in_scope integer;
  v_removed integer := 0;
  v_kept integer := 0;
  v_tbl text; v_con text; v_note text;
  v_members_before bigint; v_caregivers_before bigint; v_audit_before bigint; v_triggers_before bigint;
  v_members_after bigint; v_caregivers_after bigint; v_audit_after bigint; v_triggers_after bigint;
begin
  if v_mode not in ('dry-run', 'apply') then raise exception 'mode must be dry-run or apply'; end if;
  if v_expected is null or v_expected < 0 then raise exception 'expected_clients must be a non-negative number taken from the preview'; end if;
  select id into v_org from ogevia.organizations where slug = v_slug;
  if v_org is null then raise exception 'Refusing: agency "%" not found', v_slug; end if;
  if v_mode = 'apply' then
    if current_setting('og.confirm') <> format('PURGE-%s-%s', v_slug, v_expected) then
      raise exception 'Refusing: apply needs confirm=PURGE-%-% exactly', v_slug, v_expected;
    end if;
    if v_snapshot !~ '^[A-Za-z0-9-]{10,80}$' then raise exception 'Refusing: apply needs snapshot_id, the id of a verified RDS snapshot'; end if;
  end if;

  -- Protections must be exactly as released. No bypass: refuse if any is off or if triggers are suppressed for this session.
  if current_setting('session_replication_role') <> 'origin' then
    raise exception 'Refusing: session_replication_role is %, triggers would be skipped', current_setting('session_replication_role');
  end if;
  select count(*) into v_triggers_before from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where p.proname = 'forbid_delete' and not t.tgisinternal and t.tgenabled = 'O';
  if v_triggers_before = 0 or exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'forbid_delete' and not t.tgisinternal and t.tgenabled <> 'O') then
    raise exception 'Refusing: delete-protection triggers are missing or disabled';
  end if;

  select count(*) into v_members_before from ogevia.organization_memberships where organization_id = v_org;
  select count(*) into v_caregivers_before from ogevia.caregiver_records where organization_id = v_org;
  select count(*) into v_audit_before from ogevia.audit_events where organization_id = v_org;

  create temp table scope_clients on commit drop as
    select id from ogevia.clients
     where organization_id = v_org and (v_cutoff = '' or created_at < v_cutoff::timestamptz);
  select count(*) into v_in_scope from scope_clients;
  insert into purge_report values ('scope', 'clients in scope', v_in_scope, null);
  if v_in_scope <> v_expected then
    raise exception 'Refusing: % clients are in scope but expected_clients=% (re-run the preview); nothing was changed', v_in_scope, v_expected;
  end if;

  for c in select id from scope_clients order by id loop
    begin
      -- Unprotected dependents, leaf first. Protected tables are never named here.
      delete from ogevia.authorization_reservations where shift_id in (select id from ogevia.shifts where client_id = c.id)
                                                       or care_request_id in (select id from ogevia.care_requests where client_id = c.id);
      get diagnostics n = row_count; insert into purge_report values ('removed', 'authorization_reservations', n, null);
      delete from ogevia.care_notifications where care_request_id in (select id from ogevia.care_requests where client_id = c.id);
      get diagnostics n = row_count; insert into purge_report values ('removed', 'care_notifications', n, null);
      delete from ogevia.care_request_offers where care_request_id in (select id from ogevia.care_requests where client_id = c.id);
      get diagnostics n = row_count; insert into purge_report values ('removed', 'care_request_offers', n, null);
      delete from ogevia.care_request_events where care_request_id in (select id from ogevia.care_requests where client_id = c.id)
                                                or shift_id in (select id from ogevia.shifts where client_id = c.id);
      get diagnostics n = row_count; insert into purge_report values ('removed', 'care_request_events', n, null);
      delete from ogevia.shift_coverage_events where shift_id in (select id from ogevia.shifts where client_id = c.id);
      get diagnostics n = row_count; insert into purge_report values ('removed', 'shift_coverage_events', n, null);
      delete from ogevia.shift_readiness_flags where shift_id in (select id from ogevia.shifts where client_id = c.id);
      get diagnostics n = row_count; insert into purge_report values ('removed', 'shift_readiness_flags', n, null);
      delete from ogevia.availability_overrides where client_id = c.id;
      get diagnostics n = row_count; insert into purge_report values ('removed', 'availability_overrides', n, null);
      delete from ogevia.care_requests where client_id = c.id;
      get diagnostics n = row_count; insert into purge_report values ('removed', 'care_requests', n, null);
      delete from ogevia.shifts where client_id = c.id;
      get diagnostics n = row_count; insert into purge_report values ('removed', 'shifts', n, null);
      delete from ogevia.shift_series where client_id = c.id;
      get diagnostics n = row_count; insert into purge_report values ('removed', 'shift_series', n, null);
      delete from ogevia.assignment_readiness_flags where assignment_id in (select id from ogevia.caregiver_assignments where client_id = c.id);
      get diagnostics n = row_count; insert into purge_report values ('removed', 'assignment_readiness_flags', n, null);
      delete from ogevia.caregiver_assignments where client_id = c.id;
      get diagnostics n = row_count; insert into purge_report values ('removed', 'caregiver_assignments', n, null);
      delete from ogevia.client_care_portals where client_id = c.id;
      get diagnostics n = row_count; insert into purge_report values ('removed', 'client_care_portals', n, null);
      delete from ogevia.client_experience_requirements where client_id = c.id;
      get diagnostics n = row_count; insert into purge_report values ('removed', 'client_experience_requirements', n, null);
      delete from ogevia.client_preparation where client_id = c.id;
      get diagnostics n = row_count; insert into purge_report values ('removed', 'client_preparation', n, null);
      delete from ogevia.client_private_names where client_id = c.id;
      get diagnostics n = row_count; insert into purge_report values ('removed', 'client_private_names', n, null);
      delete from ogevia.client_service_zip where client_id = c.id;
      get diagnostics n = row_count; insert into purge_report values ('removed', 'client_service_zip', n, null);
      delete from ogevia.clients where id = c.id;
      get diagnostics n = row_count; insert into purge_report values ('removed', 'clients', n, null);
      v_removed := v_removed + 1;
    exception when foreign_key_violation then
      -- Everything this client's block did is rolled back. The client stays exactly as it was.
      get stacked diagnostics v_tbl = table_name, v_con = constraint_name;
      v_note := case
        when exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_class k on k.oid = t.tgrelid
                      where p.proname = 'forbid_delete' and k.relname = coalesce(v_tbl, '')) then 'protected record (delete-protected table)'
        when coalesce(v_tbl, '') = '' then 'blocked by a related record'
        else 'UNLISTED DEPENDENT: add ' || v_tbl || ' to this script after review' end;
      v_kept := v_kept + 1;
      insert into purge_report values ('kept', coalesce(v_tbl, '(unknown table)'), 1, v_note);
    end;
  end loop;
  insert into purge_report values ('scope', 'clients removed', v_removed, null), ('scope', 'clients kept (blocked by protected records)', v_kept, null);

  -- Re-check everything that must be preserved, and that the protections are still on.
  select count(*) into v_members_after from ogevia.organization_memberships where organization_id = v_org;
  select count(*) into v_caregivers_after from ogevia.caregiver_records where organization_id = v_org;
  select count(*) into v_audit_after from ogevia.audit_events where organization_id = v_org;
  select count(*) into v_triggers_after from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'forbid_delete' and not t.tgisinternal and t.tgenabled = 'O';
  if not exists (select 1 from ogevia.organizations where id = v_org) then raise exception 'Abort: the agency row changed'; end if;
  if v_members_after <> v_members_before then raise exception 'Abort: memberships changed (% -> %)', v_members_before, v_members_after; end if;
  if v_caregivers_after <> v_caregivers_before then raise exception 'Abort: caregiver records changed (% -> %)', v_caregivers_before, v_caregivers_after; end if;
  if v_audit_after < v_audit_before then raise exception 'Abort: audit events decreased'; end if;
  if v_triggers_after <> v_triggers_before then raise exception 'Abort: delete-protection triggers changed'; end if;
  insert into purge_report values ('preserved', 'memberships', v_members_after, null), ('preserved', 'caregiver records', v_caregivers_after, null),
                                  ('preserved', 'audit events (before this run)', v_audit_before, null), ('preserved', 'delete-protection triggers enabled', v_triggers_after, null);

  if v_mode = 'apply' then
    perform ogevia.write_audit(v_org, 'client.test_data_removed', 'organizations', v_org, null,
      jsonb_build_object('clients_removed', v_removed, 'clients_kept_protected', v_kept, 'snapshot', v_snapshot,
                         'scope', case when v_cutoff = '' then 'all clients of the agency' else 'clients created before ' || v_cutoff end), 'confirmed test data');
  end if;
end
$purge$;

\echo '== Report (counts only). Mode:' :mode
select section, item, sum(n) as n, string_agg(distinct note, '; ') as note from purge_report group by section, item
order by case section when 'scope' then 1 when 'removed' then 2 when 'kept' then 3 else 4 end, item;

select :'mode' = 'apply' as do_commit \gset
\if :do_commit
  commit;
  \echo 'APPLIED: the transaction was committed.'
\else
  rollback;
  \echo 'DRY RUN: the transaction was rolled back. Nothing changed.'
\endif
