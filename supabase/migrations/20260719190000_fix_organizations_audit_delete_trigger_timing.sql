begin;

-- organizations_audit fired AFTER delete on organizations, but by then the
-- row is already gone from the table (within the same transaction), so
-- the audit_logs insert this trigger performs - which sets
-- organization_id := OLD.id - violates audit_logs_organization_id_fkey
-- (it references organizations.id, and that row no longer exists to
-- reference). Confirmed by a live smoke-test delete against a real
-- Supabase project:
--   ERROR: 23503: insert or update on table "audit_logs" violates
--   foreign key constraint "audit_logs_organization_id_fkey"
--
-- This is specific to organizations because it is the only audited table
-- whose audit record links back to itself (every other table's
-- organization_id points at a still-existing parent organization, so a
-- row delete there never removes the thing the audit record references).
--
-- Fix: fire the delete-audit for organizations BEFORE the row is
-- actually removed, so it still exists when write_audit_log() inserts
-- the audit_logs row referencing it. Insert/update stay AFTER (the
-- previous, correct behavior - the row must exist first for INSERT, and
-- to_jsonb(NEW) needs the post-update values).
drop trigger if exists organizations_audit on public.organizations;

create trigger organizations_audit
after insert or update on public.organizations
for each row execute function public.write_audit_log();

create trigger organizations_audit_before_delete
before delete on public.organizations
for each row execute function public.write_audit_log();

commit;
