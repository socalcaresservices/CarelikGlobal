-- READ ONLY. Schema version and migration ledger.
select 'latest_migration_is_0065' as check_name,
       coalesce(max(version) = '0065', false) as ok,
       'latest=' || coalesce(max(version), 'none') as detail
from ogevia_meta.schema_migrations
union all
select 'migration_count_is_65', count(*) = 65, 'count=' || count(*)
from ogevia_meta.schema_migrations
union all
select 'migration_versions_contiguous',
       bool_and(version::int = rn), 'versions=' || string_agg(version, ',' order by version)
from (select version, row_number() over (order by version) as rn from ogevia_meta.schema_migrations) m;
