-- READ ONLY. Schema version and migration ledger.
select 'latest_migration_is_0038' as check_name,
       coalesce(max(version) = '0038', false) as ok,
       'latest=' || coalesce(max(version), 'none') as detail
from ogevia_meta.schema_migrations
union all
select 'migration_count_is_38', count(*) = 38, 'count=' || count(*)
from ogevia_meta.schema_migrations
union all
select 'migration_versions_contiguous',
       bool_and(version::int = rn), 'versions=' || string_agg(version, ',' order by version)
from (select version, row_number() over (order by version) as rn from ogevia_meta.schema_migrations) m;
