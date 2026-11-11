-- 0094 (PENDING: infra/aws/db/pending) | CLASS: ADDITIVE DATA (inserts at most two document type rows per agency). Not applied to any database.
-- Owner decision (2026-11-10, R7(d)): every agency has document types named CPR and TB without a manual step.
-- These are CATEGORY NAMES ONLY. The migration does NOT choose them as the agency's CPR/TB requirement, sets NO validity rule, and approves no caregiver:
-- "Document setup" stays incomplete until an administrator chooses the types, the validity rule and gives a reason. Types are created with no expiry requirement.
-- An agency that already has a type whose name starts with CPR (or TB) is left alone (no duplicate clutter). Each created row writes an audit event.
-- ogevia.ensure_standard_document_types(org) is idempotent and is what a new agency's bootstrap calls (deploy/12_prd_bootstrap_tenant.sql and the seeds).
-- Rollback: pending/rollback/0094_standard_document_types.down.sql (removes only the rows this migration created that no document uses).
create function ogevia.ensure_standard_document_types(p_organization_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_by uuid; v_made integer := 0; v_name text; v_id uuid;
begin
  select u.id into v_by from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id
   where m.organization_id = p_organization_id and m.role = 'organization_owner' and m.status = 'active' order by m.created_at limit 1;
  if v_by is null then return 0; end if;   -- no owner yet: nothing to attribute the rows to; run again after the owner exists
  foreach v_name in array array['CPR', 'TB'] loop
    if not exists (select 1 from ogevia.document_types t where t.organization_id = p_organization_id and (lower(btrim(t.name)) = lower(v_name) or lower(btrim(t.name)) like lower(v_name) || ' %')) then
      insert into ogevia.document_types (organization_id, name, requires_expiry, created_by) values (p_organization_id, v_name, false, v_by) returning id into v_id;
      perform ogevia.write_audit(p_organization_id, 'document_type.created', 'document_types', v_id, null,
        jsonb_build_object('name', v_name, 'requires_expiry', false, 'source', 'standard_types_0094'), null);
      v_made := v_made + 1;
    end if;
  end loop;
  return v_made;
end;
$$;
revoke all on function ogevia.ensure_standard_document_types(uuid) from public;

do $$ declare o record; begin
  for o in select id from ogevia.organizations loop perform ogevia.ensure_standard_document_types(o.id); end loop;
end $$;
