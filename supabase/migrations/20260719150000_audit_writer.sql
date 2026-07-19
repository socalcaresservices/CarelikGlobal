begin;

-- Generic audit writer. There is deliberately no INSERT policy on
-- audit_logs (see docs/phase-1-foundation.md: "Audit records are not
-- directly writable from the browser") - this trigger is the only way
-- rows get written, running as security definer so it can insert
-- regardless of the acting session's own RLS permissions.
create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
  v_entity_id text;
begin
  if TG_OP = 'DELETE' then
    v_organization_id := OLD.organization_id;
    v_entity_id := OLD.id::text;
  else
    v_organization_id := NEW.organization_id;
    v_entity_id := NEW.id::text;
  end if;

  insert into public.audit_logs (
    organization_id,
    actor_user_id,
    action,
    entity_type,
    entity_id,
    source,
    old_values,
    new_values
  ) values (
    v_organization_id,
    auth.uid(),
    TG_TABLE_NAME || '.' || lower(TG_OP),
    TG_TABLE_NAME,
    v_entity_id,
    'database_trigger',
    case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(OLD) else null end,
    case when TG_OP in ('INSERT', 'UPDATE') then to_jsonb(NEW) else null end
  );

  return coalesce(NEW, OLD);
end;
$$;

-- organization_settings and role_permissions use composite/non-uuid
-- primary keys, so they're left out of this generic version (entity_id
-- assumes a single uuid `id` column). Covers the operational tables
-- that matter most for an audit trail; can be extended per-table later.
create trigger organizations_audit
after insert or update or delete on public.organizations
for each row execute function public.write_audit_log();

create trigger organization_memberships_audit
after insert or update or delete on public.organization_memberships
for each row execute function public.write_audit_log();

create trigger feature_flags_audit
after insert or update or delete on public.feature_flags
for each row execute function public.write_audit_log();

create trigger files_audit
after insert or update or delete on public.files
for each row execute function public.write_audit_log();

commit;
