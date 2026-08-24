begin;

-- Audit trigger: logs all writes (INSERT/UPDATE) on business tables while support staff has active access
-- This runs AFTER the write, so it captures the new state

create or replace function public.audit_support_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  grant_id uuid;
begin
  -- Find active support grant for this org/user
  select id into grant_id from public.support_access_grants
  where organization_id = NEW.organization_id
    and grantee_user_id = auth.uid()
    and status = 'active'
    and expires_at > now()
  limit 1;

  if grant_id is not null then
    -- Check if user has edit access
    if exists (
      select 1 from public.support_access_grants
      where id = grant_id
        and access_level = 'edit'
    ) then
      insert into public.support_access_audit_log (
        grant_id,
        organization_id,
        user_id,
        event_type,
        resource_type,
        action,
        resource_id,
        changes
      ) values (
        grant_id,
        NEW.organization_id,
        auth.uid(),
        'write',
        TG_TABLE_NAME,
        TG_OP,
        NEW.id,
        case
          when TG_OP = 'UPDATE' then jsonb_build_object(
            'old', to_jsonb(OLD),
            'new', to_jsonb(NEW)
          )
          when TG_OP = 'INSERT' then jsonb_build_object(
            'new', to_jsonb(NEW)
          )
        end
      );
    end if;
  end if;

  return new;
end;
$$;

-- Attach trigger to caregiver_records
drop trigger if exists audit_support_caregiver_write on public.caregiver_records;
create trigger audit_support_caregiver_write
  after insert or update on public.caregiver_records
  for each row
  execute function public.audit_support_write();

-- Attach trigger to clients
drop trigger if exists audit_support_client_write on public.clients;
create trigger audit_support_client_write
  after insert or update on public.clients
  for each row
  execute function public.audit_support_write();

-- Add more tables as needed (authorization, schedules, etc.)
drop trigger if exists audit_support_authorization_write on public.client_authorizations;
create trigger audit_support_authorization_write
  after insert or update on public.client_authorizations
  for each row
  execute function public.audit_support_write();

commit;
