-- READ-ONLY verification of pending migrations 0113-0116. Writes nothing.
--   psql -X -At -F '|' -v mig=0113 -v expect=absent|present -f VERIFY_PENDING.sql
-- One row per check: name|t|detail (t = ok, f = FAILING). The wrapper counts rows and fails on any "|f|".
-- Tables: must exist (present) / not exist (absent). Functions (by schema + name): must exist, be SECURITY DEFINER, have a pinned
-- search_path and no PUBLIC execute (present) / not exist (absent). Ledger row: present after, absent before.
\set ON_ERROR_STOP on
with t(mig, rel) as (values
  ('0113','ogevia.cover_notification_settings'),('0113','ogevia.cover_notification_office_audience'),('0113','ogevia.cover_alerts'),
  ('0113','ogevia.user_notifications'),('0113','ogevia.notification_preferences'),('0113','ogevia.notification_deliveries'),('0113','ogevia.notification_delivery_events'),
  ('0114','ogevia.office_branding'),
  ('0115','ogevia.import_batch_records'),('0115','ogevia.import_batch_rollbacks'),
  ('0116','ogevia.staff_merge_snapshots'),('0116','ogevia.staff_merge_reversals')
), f(mig, sch, fn) as (values
  ('0113','ogevia_api','get_cover_notification_settings'),('0113','ogevia_api','set_cover_notification_settings'),('0113','ogevia_api','set_cover_office_audience'),
  ('0113','ogevia_api','list_cover_office_audiences'),('0113','ogevia_api','notify_cover_shift'),('0113','ogevia_api','system_cover_notify_orgs'),
  ('0113','ogevia_api','list_user_notifications'),('0113','ogevia_api','mark_user_notifications'),('0113','ogevia_api','get_my_notification_preferences'),
  ('0113','ogevia_api','set_my_notification_preferences'),('0113','ogevia_api','list_cover_notification_history'),('0113','ogevia_api','system_email_claim'),('0113','ogevia_api','system_email_record'),
  ('0114','ogevia_api','set_office_branding'),('0114','ogevia_api','list_office_branding'),('0114','ogevia_api','get_invitation_look'),
  ('0115','ogevia_api','list_import_batches'),('0115','ogevia_api','rollback_import_batch'),
  ('0116','ogevia_api','preview_staff_merge'),('0116','ogevia_api','merge_staff_profiles_v2'),('0116','ogevia_api','unmerge_staff_profiles'),('0116','ogevia_api','list_staff_merges')
), p as (
  select f.mig, f.sch || '.' || f.fn as name, (select pr.oid from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = f.sch and pr.proname = f.fn limit 1) as oid
  from f where f.mig = :'mig'
)
select 'table ' || rel || ' ' || :'expect', case when :'expect' = 'absent' then to_regclass(rel) is null else to_regclass(rel) is not null end, '' from t where mig = :'mig'
union all
select 'function ' || name || ' ' || :'expect', case when :'expect' = 'absent' then oid is null else oid is not null end, '' from p
union all
select 'definer + pinned search_path ' || name, case when :'expect' = 'absent' then true else oid is not null and (select prosecdef and coalesce(proconfig::text like '%search_path=%', false) from pg_proc where oid = p.oid) end, '' from p
union all
select 'no PUBLIC execute ' || name, case when :'expect' = 'absent' then true else oid is not null and not exists (select 1 from pg_proc x, aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) a where x.oid = p.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') end, '' from p
union all
select 'app role execute ' || name, case when :'expect' = 'absent' then true else oid is not null and has_function_privilege('ogevia_app', oid, 'execute') end, '' from p
union all
select 'ledger row ' || :'mig' || ' ' || :'expect',
       case when :'expect' = 'absent' then not exists (select 1 from ogevia_meta.schema_migrations where version = :'mig')
            else (select count(*) from ogevia_meta.schema_migrations where version = :'mig') = 1 end, '';
