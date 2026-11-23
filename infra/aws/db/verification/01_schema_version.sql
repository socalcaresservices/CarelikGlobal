-- READ ONLY. Schema version and migration ledger. The approved release is 0085; a database that has the later, additive 0086 (Open Shifts and SMS) is also valid.
select 'latest_migration_is_0085_or_0086' as check_name,
       coalesce(max(version) in ('0085', '0086'), false) as ok,
       'latest=' || coalesce(max(version), 'none') as detail
from ogevia_meta.schema_migrations
union all
select 'migration_count_matches_latest', count(*) = max(version)::int, 'count=' || count(*)
from ogevia_meta.schema_migrations
union all
select 'migration_versions_contiguous',
       bool_and(version::int = rn), 'versions=' || string_agg(version, ',' order by version)
from (select version, row_number() over (order by version) as rn from ogevia_meta.schema_migrations) m;
