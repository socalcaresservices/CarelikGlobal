-- ROLLBACK 0108 | CLASS: RESTORES THE 2026-11-14 PRODUCTION DEFECT where the objects are owned by another role. Read before running.
-- It removes only what 0108 can have added, and only where that is a real grant:
--   * the policy owner_definer_select on ogevia.business_documents (dropped if present);
--   * ogevia_owner's SELECT on ogevia.business_documents and EXECUTE on ogevia.action_issue_rows, revoked ONLY when ogevia_owner does not own the object
--     (an owner's own privileges are never revoked: in a database built from this repository the owner keeps them).
-- In PRODUCTION, where ogevia_admin owns both objects, running this brings back the permission-denied (42501) errors in ogevia_api.system_compliance_orgs(),
-- list_my_notifications and get_attention_counts. Use it only to return to the pre-fix state on purpose; the normal answer to a problem is to fix forward.
-- It must run as the owner of those objects (or a role that granted the privileges): a role that did not grant a privilege cannot revoke it.

do $rollback$
begin
  if to_regclass('ogevia.business_documents') is not null then
    if exists (select 1 from pg_policy where polrelid = 'ogevia.business_documents'::regclass and polname = 'owner_definer_select') then
      drop policy owner_definer_select on ogevia.business_documents;
    end if;
    if (select pg_get_userbyid(relowner) from pg_class where oid = 'ogevia.business_documents'::regclass) <> 'ogevia_owner' then
      revoke select on ogevia.business_documents from ogevia_owner;
    end if;
  end if;
  if to_regprocedure('ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer)') is not null then
    if (select pg_get_userbyid(proowner) from pg_proc where oid = 'ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer)'::regprocedure) <> 'ogevia_owner' then
      revoke execute on function ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer) from ogevia_owner;
    end if;
  end if;
end
$rollback$;
