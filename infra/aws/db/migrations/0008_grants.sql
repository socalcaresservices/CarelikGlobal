-- 0008 - Least-privilege grants.
--
-- ogevia_app: may only EXECUTE ogevia_api functions. It has no privilege on
-- any table, so the API functions are the integrity boundary; direct
-- INSERT/UPDATE/DELETE/SELECT on ogevia.* is impossible for the runtime.
-- ogevia_readonly: SELECT for verification/support. NOLOGIN until an owner
-- approves an individual, audited support login.

revoke all on all tables in schema ogevia from public;
revoke all on all functions in schema ogevia from public;
revoke all on all functions in schema ogevia_api from public;

grant usage on schema ogevia_api to ogevia_app;
grant execute on all functions in schema ogevia_api to ogevia_app;
-- API signatures use ogevia enum types; resolving them needs schema USAGE.
-- USAGE grants no access to any table or function in the schema.
grant usage on schema ogevia to ogevia_app;

grant usage on schema ogevia to ogevia_readonly;
grant select on all tables in schema ogevia to ogevia_readonly;

-- Defense in depth: RLS on, no policies. Only the owner (functions) reaches rows.
alter table ogevia.app_users enable row level security;
alter table ogevia.organizations enable row level security;
alter table ogevia.organization_memberships enable row level security;
alter table ogevia.caregiver_records enable row level security;
alter table ogevia.clients enable row level security;
alter table ogevia.services enable row level security;
alter table ogevia.caregiver_assignments enable row level security;
alter table ogevia.shifts enable row level security;
alter table ogevia.shift_coverage_events enable row level security;
alter table ogevia.client_authorizations enable row level security;
alter table ogevia.service_visits enable row level security;
alter table ogevia.visit_evidence enable row level security;
alter table ogevia.visit_confirmations enable row level security;
alter table ogevia.visit_corrections enable row level security;
alter table ogevia.audit_events enable row level security;
alter table ogevia.idempotency_records enable row level security;

-- Read-only role reads through explicit permissive policies (SELECT only).
do $$
declare
  t text;
begin
  for t in select tablename from pg_tables where schemaname = 'ogevia' loop
    execute format('create policy readonly_select on ogevia.%I for select to ogevia_readonly using (true)', t);
  end loop;
end
$$;
