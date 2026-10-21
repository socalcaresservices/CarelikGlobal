-- READ-ONLY. Emits "key<TAB>digest" lines; the same keys and digests as db/scripts/fingerprint.ts. No row value is ever returned, only md5 digests and counts.
select 'column:' || table_schema || '.' || table_name || '.' || column_name as k,
       md5(concat_ws('|', data_type, udt_name, is_nullable, coalesce(column_default, ''), coalesce(character_maximum_length::text, ''))) as h
  from information_schema.columns where table_schema in ('ogevia','ogevia_api')
union all
select 'constraint:' || c.conrelid::regclass::text || '.' || c.conname, md5(pg_get_constraintdef(c.oid))
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ('ogevia','ogevia_api')
union all
select 'index:' || schemaname || '.' || tablename || '.' || indexname, md5(indexdef) from pg_indexes where schemaname in ('ogevia','ogevia_api')
union all
select 'trigger:' || t.tgrelid::regclass::text || '.' || t.tgname, md5(pg_get_triggerdef(t.oid))
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where not t.tgisinternal and n.nspname in ('ogevia','ogevia_api')
union all
select 'policy:' || schemaname || '.' || tablename || '.' || policyname, md5(concat_ws('|', cmd, roles::text, coalesce(qual, ''), coalesce(with_check, '')))
  from pg_policies where schemaname in ('ogevia','ogevia_api')
union all
select 'function:' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', md5(pg_get_functiondef(p.oid) || '|' || coalesce(p.proacl::text, ''))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('ogevia','ogevia_api') and p.prokind = 'f'
union all
select 'tableacl:' || n.nspname || '.' || c.relname, md5(coalesce(c.relacl::text, '') || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('ogevia','ogevia_api') and c.relkind = 'r'
union all
select 'data:' || t.schemaname || '.' || t.tablename,
       (xpath('/row/n/text()', query_to_xml(format('select count(*)::text as n from %I.%I', t.schemaname, t.tablename), false, true, '')))[1]::text || ':' ||
       (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, ''|'' order by x::text), '''')) as h from %I.%I x', t.schemaname, t.tablename), false, true, '')))[1]::text
  from pg_tables t where t.schemaname = 'ogevia'
order by 1;
