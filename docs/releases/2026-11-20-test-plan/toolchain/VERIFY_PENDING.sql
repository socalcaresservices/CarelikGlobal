-- READ-ONLY verification of pending migrations 0113-0121. Writes nothing.
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
  ('0116','ogevia.staff_merge_snapshots'),('0116','ogevia.staff_merge_reversals'),
  ('0117','ogevia.sms_settings'),('0117','ogevia.sms_contacts'),('0117','ogevia.sms_oncall'),('0117','ogevia.sms_messages'),('0117','ogevia.sms_inbound_log'),('0118','ogevia.zip_county_reference')
), f(mig, sch, fn) as (values
  ('0113','ogevia_api','get_cover_notification_settings'),('0113','ogevia_api','set_cover_notification_settings'),('0113','ogevia_api','set_cover_office_audience'),
  ('0113','ogevia_api','list_cover_office_audiences'),('0113','ogevia_api','notify_cover_shift'),('0113','ogevia_api','system_cover_notify_orgs'),
  ('0113','ogevia_api','list_user_notifications'),('0113','ogevia_api','mark_user_notifications'),('0113','ogevia_api','get_my_notification_preferences'),
  ('0113','ogevia_api','set_my_notification_preferences'),('0113','ogevia_api','list_cover_notification_history'),('0113','ogevia_api','system_email_claim'),('0113','ogevia_api','system_email_record'),
  ('0114','ogevia_api','set_office_branding'),('0114','ogevia_api','list_office_branding'),('0114','ogevia_api','get_invitation_look'),
  ('0115','ogevia_api','list_import_batches'),('0115','ogevia_api','rollback_import_batch'),
  ('0116','ogevia_api','preview_staff_merge'),('0116','ogevia_api','merge_staff_profiles_v2'),('0116','ogevia_api','unmerge_staff_profiles'),('0116','ogevia_api','list_staff_merges'),
  ('0117','ogevia_api','get_sms_settings'),('0117','ogevia_api','set_sms_settings'),('0117','ogevia_api','get_my_sms'),('0117','ogevia_api','set_my_sms'),('0117','ogevia_api','list_sms_oncall'),('0117','ogevia_api','set_sms_oncall'),
  ('0117','ogevia_api','list_sms_history'),('0117','ogevia_api','system_sms_escalate_orgs'),('0117','ogevia_api','system_sms_inbound'),('0117','ogevia_api','system_sms_claim'),('0117','ogevia_api','system_sms_record'),
  ('0118','ogevia_api','get_client_service_location'),('0118','ogevia_api','set_client_service_location'),
  ('0120','ogevia_api','get_cover_shift')
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
select 'function ogevia.cover_key exists', to_regprocedure('ogevia.cover_key(ogevia.shifts)') is not null, '' where :'mig' = '0119'
union all
select 'round 0 keeps the original key (0119) ' || :'expect',
       case when :'expect' = 'absent' then true else coalesce(pg_get_functiondef(to_regprocedure('ogevia.cover_key(ogevia.shifts)')) like '%0119 legacy key for round 0%', false) end, '' where :'mig' = '0119'
union all
select 'cover_key is defined exactly once', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia' and p.proname = 'cover_key') = 1, '' where :'mig' = '0119'
union all
select 'function ogevia.cover_shift_summary exists, not callable by the app role directly ' || :'expect',
       case when :'expect' = 'absent' then to_regprocedure('ogevia.cover_shift_summary(uuid,uuid,uuid)') is null
            else to_regprocedure('ogevia.cover_shift_summary(uuid,uuid,uuid)') is not null
                 and not has_function_privilege('ogevia_app', to_regprocedure('ogevia.cover_shift_summary(uuid,uuid,uuid)'), 'execute') end, '' where :'mig' = '0120'
union all
select 'alert link rule allows the exact-shift link only ' || :'expect',
       case when :'expect' = 'absent' then coalesce((select pg_get_constraintdef(c.oid) not like '%my-shifts%' from pg_constraint c where c.conrelid = to_regclass('ogevia.user_notifications') and c.conname = 'user_notifications_link_check'), false)
            else coalesce((select pg_get_constraintdef(c.oid) like '%my-shifts%' from pg_constraint c where c.conrelid = to_regclass('ogevia.user_notifications') and c.conname = 'user_notifications_link_check'), false) end, '' where :'mig' = '0120'
union all
select 'new alerts carry the exact-shift link ' || :'expect',
       case when :'expect' = 'absent' then coalesce(pg_get_functiondef(to_regprocedure('ogevia.cover_notify(uuid,uuid,uuid,uuid,boolean)')) not like '%/my-shifts?shift=%', false)
            else coalesce(pg_get_functiondef(to_regprocedure('ogevia.cover_notify(uuid,uuid,uuid,uuid,boolean)')) like '%/my-shifts?shift=%', false) end, '' where :'mig' = '0120'
union all
select 'function ogevia.email_used_by_other exists ' || :'expect',
       case when :'expect' = 'absent' then to_regprocedure('ogevia.email_used_by_other(uuid,text,uuid,uuid)') is null
            else to_regprocedure('ogevia.email_used_by_other(uuid,text,uuid,uuid)') is not null end, '' where :'mig' = '0121'
union all
select 'the caregiver contact, staff and invitation writes use it ' || :'expect',
       case when :'expect' = 'absent' then (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname in ('set_caregiver_contact','begin_caregiver_invitation','begin_staff_invitation','create_staff','update_staff') and pg_get_functiondef(p.oid) like '%email_used_by_other%') = 0
            else (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname in ('set_caregiver_contact','begin_caregiver_invitation','begin_staff_invitation','create_staff','update_staff') and pg_get_functiondef(p.oid) like '%email_used_by_other%') = 5 end, '' where :'mig' = '0121'
union all
select 'ledger row ' || :'mig' || ' ' || :'expect',
       case when :'expect' = 'absent' then not exists (select 1 from ogevia_meta.schema_migrations where version = :'mig')
            else (select count(*) from ogevia_meta.schema_migrations where version = :'mig') = 1 end, '';
