begin;

-- write_audit_log() assumed every audited table has an organization_id
-- foreign-key column. True for organization_memberships, feature_flags,
-- and files - not true for organizations itself, which has no
-- organization_id column (it only has id, referring to itself). Any
-- insert/update/delete on organizations therefore failed outright:
--   ERROR: 42703: record "new" has no field "organization_id"
-- Discovered by a live smoke-test insert against a real Supabase project.
--
-- Fix: when the audited table is organizations, the row's own id IS the
-- organization being audited. Everything else about the function is
-- unchanged from 20260719150000_audit_writer.sql.
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
  if TG_TABLE_NAME = 'organizations' then
    if TG_OP = 'DELETE' then
      v_organization_id := OLD.id;
      v_entity_id := OLD.id::text;
    else
      v_organization_id := NEW.id;
      v_entity_id := NEW.id::text;
    end if;
  else
    if TG_OP = 'DELETE' then
      v_organization_id := OLD.organization_id;
      v_entity_id := OLD.id::text;
    else
      v_organization_id := NEW.organization_id;
      v_entity_id := NEW.id::text;
    end if;
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

commit;
