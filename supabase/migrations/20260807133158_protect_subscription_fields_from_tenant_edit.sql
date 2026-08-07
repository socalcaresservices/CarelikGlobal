begin;

-- The existing "authorized_update_organizations" RLS policy (organization.update
-- permission) is column-agnostic - it lets an organization_owner/admin update
-- any column on their own row, which is exactly what's wanted for
-- legal_name/display_name/branding/etc. Adding subscription_plan/
-- subscription_status/billing_email/trial_ends_at/storage_limit_gb to the
-- same table without protecting them would let a tenant admin self-upgrade
-- their own plan or fake an 'active' subscription_status via a plain
-- supabase.from('organizations').update(...) call, completely bypassing
-- set_organization_subscription()'s is_platform_owner() gate. This trigger
-- closes that: any change to those columns is blocked unless the caller is
-- the platform owner (which is who set_organization_subscription() and the
-- platform onboarding path run as).
create or replace function public.prevent_tenant_subscription_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_owner() and (
    NEW.subscription_plan is distinct from OLD.subscription_plan
    or NEW.subscription_status is distinct from OLD.subscription_status
    or NEW.billing_email is distinct from OLD.billing_email
    or NEW.trial_ends_at is distinct from OLD.trial_ends_at
    or NEW.storage_limit_gb is distinct from OLD.storage_limit_gb
  ) then
    raise exception 'Only platform staff can change subscription or billing fields';
  end if;
  return NEW;
end;
$$;

create trigger organizations_protect_subscription_fields
before update on public.organizations
for each row execute function public.prevent_tenant_subscription_edit();

commit;
