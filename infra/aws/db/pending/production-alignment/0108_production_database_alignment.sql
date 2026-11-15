-- 0108 (PROPOSED: infra/aws/db/pending/production-alignment, NOT applied to any database, NOT loaded by the migration runner) | CLASS: ADDITIVE, IDEMPOTENT, FAILS CLOSED
-- Brings the repository in line with two manual PRODUCTION fixes made on 2026-11-14 (docs/releases/2026-11-15-signin-override-production/PRODUCTION_DB_CHANGES_2026-11-14.md):
--   1. ogevia_owner may SELECT ogevia.business_documents, through the policy owner_definer_select (SELECT, ogevia_owner only, USING (true)).
--   2. ogevia_owner may EXECUTE ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer).
-- Why they were needed: in production migrations 0093 and 0100 were applied under the migration admin login, so ogevia_admin owns that table and that function while the
-- notification, attention and compliance-sweep functions run as ogevia_owner. A database built from this repository has ogevia_owner owning both, so there the grants are no-ops.
--
-- It states an END STATE and checks it; it never blindly overwrites:
--   * a privilege that is already effective is left alone (production, a fresh database);
--   * a missing privilege is granted, which needs the right to grant it: the owner of the object, or a role with GRANT OPTION. A role that lacks it makes the final check fail and the
--     whole migration roll back with a clear message (a plain GRANT by such a role only prints a warning, so the result is verified, not trusted);
--   * the policy is created when absent. If a policy of that name exists with ANY other definition (command, roles, permissive/restrictive, USING or WITH CHECK) the migration
--     REFUSES to overwrite it and stops: compare it with the live capture (CAPTURE_LIVE_DB_FIXES.sql) and decide.
-- Runs in the runner's own transaction. No data is read or written. Rollback: production-alignment/0108_production_database_alignment.down.sql (read its warning first).

do $alignment$
declare
  c_fn constant regprocedure := to_regprocedure('ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer)');
  v_owner oid := (select oid from pg_roles where rolname = 'ogevia_owner');
  v_pol record;
begin
  if v_owner is null then raise exception '0108: the role ogevia_owner does not exist'; end if;
  if to_regclass('ogevia.business_documents') is null then raise exception '0108: ogevia.business_documents does not exist (apply 0093 first)'; end if;
  if c_fn is null then raise exception '0108: ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer) does not exist (apply 0100 first)'; end if;

  -- 1a. SELECT on the table (a no-op when ogevia_owner owns it, or already holds it)
  if not has_table_privilege('ogevia_owner', 'ogevia.business_documents', 'SELECT') then
    execute 'grant select on ogevia.business_documents to ogevia_owner';
  end if;

  -- 1b. the policy: present and exactly as recorded, or created
  select p.polcmd, p.polpermissive, p.polroles, pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as chk
    into v_pol
    from pg_policy p
   where p.polrelid = 'ogevia.business_documents'::regclass and p.polname = 'owner_definer_select';
  if not found then
    create policy owner_definer_select on ogevia.business_documents for select to ogevia_owner using (true);
  elsif not (v_pol.polcmd = 'r' and v_pol.polpermissive and v_pol.polroles = array[v_owner] and v_pol.qual = 'true' and v_pol.chk is null) then
    raise exception '0108: a policy named owner_definer_select exists on ogevia.business_documents with a DIFFERENT definition (command %, permissive %, roles %, USING %, WITH CHECK %); refusing to overwrite it. Compare it with the live capture and decide.',
      v_pol.polcmd, v_pol.polpermissive, v_pol.polroles::regrole[]::text, coalesce(v_pol.qual, '(none)'), coalesce(v_pol.chk, '(none)');
  end if;

  -- 2. EXECUTE on the wrapper (a no-op when ogevia_owner owns it, or already holds it)
  if not has_function_privilege('ogevia_owner', c_fn, 'EXECUTE') then
    execute 'grant execute on function ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer) to ogevia_owner';
  end if;

  -- The end state, verified: a GRANT by a role without the right to grant only warns.
  if not has_table_privilege('ogevia_owner', 'ogevia.business_documents', 'SELECT') then
    raise exception '0108: ogevia_owner still cannot SELECT ogevia.business_documents. The role running this migration is not allowed to grant it (run it as the table owner, or a role with GRANT OPTION).';
  end if;
  if not has_function_privilege('ogevia_owner', c_fn, 'EXECUTE') then
    raise exception '0108: ogevia_owner still cannot EXECUTE ogevia.action_issue_rows. The role running this migration is not allowed to grant it.';
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'ogevia.business_documents'::regclass and polname = 'owner_definer_select') then
    raise exception '0108: the policy owner_definer_select is missing after the migration';
  end if;
end
$alignment$;
