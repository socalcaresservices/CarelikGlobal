-- Read-only. Groups the readiness archive tables (ogevia.archived_*_00NN_<timestamp>) into recovery sets: archives created less than
-- 10 minutes apart belong to the same rollback attempt. Pick ONE row (normally the newest) and pass its archive_names to
-- readiness_restore_from_archives.sql as  set ogevia.recovery_set = '<archive_names>'.
with a as (
  select t.tablename::text as name, to_timestamp((regexp_match(t.tablename, '_([0-9]{14})$'))[1], 'YYYYMMDDHH24MISS')::timestamp as ts
    from pg_catalog.pg_tables t
   where t.schemaname = 'ogevia' and t.tablename ~ '^archived_.+_[0-9]{4}_[0-9]{14}$'
), gaps as (
  select name, ts, (ts - lag(ts) over (order by ts, name)) > interval '10 minutes' as new_set from a
), g as (
  select name, ts, sum(case when new_set then 1 else 0 end) over (order by ts, name) as grp from gaps
)
select grp + 1 as recovery_set, min(ts) as first_archive_at, max(ts) as last_archive_at, count(*) as archives,
       string_agg(name, ',' order by name) as archive_names
  from g group by grp order by grp;
