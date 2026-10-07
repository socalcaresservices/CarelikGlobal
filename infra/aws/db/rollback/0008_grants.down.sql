-- ROLLBACK 0008_grants  |  CLASS: SAFE AUTOMATED
-- Removes grants/policies only. No data is touched.
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'ogevia' loop
    execute format('drop policy if exists readonly_select on ogevia.%I', t);
  end loop;
end $$;
revoke all on all tables in schema ogevia from ogevia_readonly;
revoke usage on schema ogevia from ogevia_readonly, ogevia_app;
revoke execute on all functions in schema ogevia_api from ogevia_app;
revoke usage on schema ogevia_api from ogevia_app;
delete from ogevia_meta.schema_migrations where version = '0008';
