insert into public.permissions (key, description) values
  ('billing.read', 'View subscription prices and financial billing details'),
  ('billing.update', 'Manage subscription and billing details')
on conflict (key) do update set description = excluded.description;

-- Convert active legacy operational roles to the four supported tenant roles.
update public.organization_memberships set role = 'manager' where role = 'organization_admin';
update public.organization_memberships set role = 'scheduler' where role = 'coordinator';
update public.organization_memberships set role = 'caregiver' where role = 'staff';

delete from public.role_permissions
where role in ('organization_owner', 'organization_admin', 'manager', 'coordinator', 'staff', 'caregiver', 'read_only', 'scheduler');

-- Owners control the complete tenant, including its subscription amounts.
insert into public.role_permissions (role, permission_key)
select 'organization_owner'::public.system_role, key from public.permissions;

-- Managers run operations but cannot see or change subscription dollar data,
-- organization ownership, or account roles.
insert into public.role_permissions (role, permission_key)
select 'manager'::public.system_role, key
from public.permissions
where key in (
  'organization.read', 'membership.read', 'settings.read', 'audit.read',
  'files.read', 'files.create', 'files.delete',
  'clients.read', 'clients.update', 'shifts.read', 'shifts.update',
  'credentials.read', 'credentials.update',
  'authorizations.read', 'authorizations.update',
  'services.read', 'services.update',
  'incidents.read', 'incidents.create', 'incidents.update',
  'applicants.read', 'applicants.update',
  'skills.read', 'skills.update', 'languages.read', 'languages.update',
  'documents.read', 'documents.manage',
  'visits.read', 'visits.manage',
  'assignments.read', 'assignments.update'
);

-- Schedulers only receive the operational data required to assign and monitor
-- visits. They cannot edit client records, compliance, documents, staff, or
-- settings.
insert into public.role_permissions (role, permission_key)
select 'scheduler'::public.system_role, key
from public.permissions
where key in (
  'organization.read', 'clients.read', 'shifts.read', 'shifts.update',
  'services.read', 'authorizations.read', 'assignments.read',
  'assignments.update', 'visits.read'
);

-- Caregivers use ownership/assignment-aware RPCs and RLS, not broad table
-- permissions. They may record incidents but cannot edit profiles, schedules,
-- clients, credentials, authorizations, or organization files.
insert into public.role_permissions (role, permission_key) values
  ('caregiver', 'organization.read'),
  ('caregiver', 'incidents.create');

-- Financial details are a separate permission from ordinary settings.
create or replace function public.get_organization_billing_summary(target_organization_id uuid)
returns table (
  organization_id uuid, effective_status public.subscription_status,
  plan_id uuid, plan_key text, plan_name text, plan_version integer,
  monthly_price_cents integer, annual_price_cents integer,
  custom_monthly_price_cents integer, custom_annual_price_cents integer,
  is_complimentary boolean, billing_cycle text, billing_cycle_anchor date,
  trial_started_at timestamptz, trial_ends_at timestamptz,
  max_active_clients integer, max_active_caregivers integer,
  max_administrators integer, max_completed_visits integer,
  override_max_active_clients integer, override_max_active_caregivers integer,
  override_max_administrators integer, override_reason text,
  override_expires_at timestamptz, report_retention_days integer,
  bulk_export_limit integer, support_level text, sms_allowance integer,
  features text[], active_clients integer, active_caregivers integer,
  administrators integer, completed_visits integer, stripe_configured boolean,
  stripe_current_period_start timestamptz, stripe_current_period_end timestamptz
)
language sql stable security definer set search_path = public
as $$
  select o.id, public.get_effective_subscription_status(o.id),
    p.id, p.plan_key, p.name, p.version,
    p.monthly_price_cents, p.annual_price_cents,
    o.custom_monthly_price_cents, o.custom_annual_price_cents, o.is_complimentary,
    o.billing_cycle, o.billing_cycle_anchor, o.trial_started_at, o.trial_ends_at,
    p.max_active_clients, p.max_active_caregivers, p.max_administrators, p.max_completed_visits,
    o.override_max_active_clients, o.override_max_active_caregivers, o.override_max_administrators,
    o.override_reason, o.override_expires_at,
    p.report_retention_days, p.bulk_export_limit, p.support_level, p.sms_allowance, p.features,
    usage.active_clients, usage.active_caregivers, usage.administrators, usage.completed_visits,
    o.stripe_customer_id is not null, o.stripe_current_period_start, o.stripe_current_period_end
  from public.organizations o
  left join public.plan_definitions p on p.id = o.plan_definition_id
  cross join lateral public.get_organization_usage(o.id) usage
  where o.id = target_organization_id
    and public.has_permission(target_organization_id, 'billing.read');
$$;
revoke all on function public.get_organization_billing_summary(uuid) from public, anon;
grant execute on function public.get_organization_billing_summary(uuid) to authenticated;

-- A non-platform identity may belong to only one tenant. Existing duplicate
-- accounts are grandfathered until the approved account cleanup is performed;
-- every new invite, activation, or transfer is blocked from adding another.
create or replace function public.enforce_single_tenant_identity()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.status not in ('active', 'invited') then return new; end if;
  if exists (select 1 from public.user_profiles p where p.id = new.user_id and p.platform_role = 'platform_owner') then
    raise exception 'Platform accounts cannot be tenant members; use time-limited support access';
  end if;
  if exists (
    select 1 from public.organization_memberships m
    where m.user_id = new.user_id and m.organization_id <> new.organization_id
      and m.status in ('active', 'invited') and m.id <> new.id
  ) then
    raise exception 'This login already belongs to another organization';
  end if;
  return new;
end;
$$;
revoke execute on function public.enforce_single_tenant_identity() from public, anon, authenticated;
drop trigger if exists organization_memberships_single_tenant on public.organization_memberships;
create trigger organization_memberships_single_tenant
before insert or update of organization_id, user_id, status on public.organization_memberships
for each row execute function public.enforce_single_tenant_identity();

-- Platform onboarding creates the tenant and catalog but does not make the
-- SaaS operator a tenant member. The separately invited owner becomes the
-- first tenant identity.
create or replace function public.create_organization(
  slug text, legal_name text, display_name text,
  timezone text default 'America/Los_Angeles', country_code text default 'US',
  dba text default null, tax_id text default null, business_license text default null,
  org_type text default null, website text default null, currency text default 'USD',
  agency_code text default null, address_street text default null, address_suite text default null,
  address_city text default null, address_state text default null, address_zip text default null,
  address_country text default null, primary_contact_name text default null,
  contact_email text default null, contact_phone text default null, emergency_phone text default null,
  logo_url text default null, primary_color text default null, secondary_color text default null,
  accent_color text default null, theme_mode text default 'light', default_services text[] default '{}'
)
returns public.organizations language plpgsql security definer set search_path=public
as $$
declare new_organization public.organizations; service_name text;
begin
  if not public.is_platform_owner() then raise exception 'Only a platform owner can create organizations'; end if;
  insert into public.organizations (slug,legal_name,display_name,timezone,country_code,dba,tax_id,
    business_license,org_type,website,currency,agency_code,address_street,address_suite,address_city,
    address_state,address_zip,address_country,primary_contact_name,contact_email,contact_phone,
    emergency_phone,logo_url,primary_color,secondary_color,accent_color,theme_mode,created_by,updated_by)
  values (slug,legal_name,display_name,timezone,country_code,dba,tax_id,business_license,org_type,website,
    coalesce(currency,'USD'),agency_code,address_street,address_suite,address_city,address_state,address_zip,
    address_country,primary_contact_name,contact_email,contact_phone,emergency_phone,logo_url,primary_color,
    secondary_color,accent_color,coalesce(theme_mode,'light'),auth.uid(),auth.uid()) returning * into new_organization;
  foreach service_name in array coalesce(default_services,'{}') loop
    if trim(service_name)<>'' then
      insert into public.services (organization_id,name,created_by,updated_by)
      values (new_organization.id,trim(service_name),auth.uid(),auth.uid()) on conflict do nothing;
    end if;
  end loop;
  return new_organization;
end;
$$;
revoke all on function public.create_organization(text,text,text,text,text,text,text,text,text,text,text,text,
  text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text[]) from public,anon;
grant execute on function public.create_organization(text,text,text,text,text,text,text,text,text,text,text,text,
  text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text[]) to authenticated;

-- Caregivers may discover and visit only clients/services assigned to their
-- authenticated account. Managers/owners keep operational override access.
create or replace function public.caregiver_has_active_assignment(
  target_organization_id uuid, target_client_id uuid, target_service_id uuid default null
)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.caregiver_assignments ca
    where ca.organization_id = target_organization_id
      and ca.caregiver_user_id = auth.uid()
      and ca.client_id = target_client_id
      and (target_service_id is null or ca.service_id = target_service_id)
      and ca.is_active
      and current_date >= ca.effective_start
      and (ca.effective_end is null or current_date <= ca.effective_end)
  );
$$;
revoke all on function public.caregiver_has_active_assignment(uuid, uuid, uuid) from public, anon;
grant execute on function public.caregiver_has_active_assignment(uuid, uuid, uuid) to authenticated;

create or replace function public.find_client_for_visit(target_organization_id uuid, search_term text)
returns table (client_id uuid, client_code text, client_name text)
language plpgsql security definer set search_path = public
as $$
declare normalized_term text := lower(btrim(search_term)); match_count integer; recent_failures integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_organization_member(target_organization_id) then raise exception 'Not a member of this organization'; end if;
  if normalized_term = '' then raise exception 'Enter a client name or ID'; end if;
  select count(*) into recent_failures from public.audit_logs
   where actor_user_id=auth.uid() and organization_id=target_organization_id
     and action='client_lookup.failed' and occurred_at > now()-interval '10 minutes';
  if recent_failures >= 5 then raise exception 'RATE_LIMITED: Too many attempts. Wait a few minutes or contact your administrator.'; end if;
  select count(*) into match_count from public.clients c
   where c.organization_id=target_organization_id and c.deleted_at is null and c.status='active'
     and (public.has_permission(target_organization_id, 'visits.manage')
       or public.caregiver_has_active_assignment(target_organization_id, c.id, null))
     and (lower(c.client_code)=normalized_term or lower(btrim(c.first_name||' '||c.last_name))=normalized_term);
  if match_count=0 then
    insert into public.audit_logs (organization_id,actor_user_id,action,entity_type,source)
    values (target_organization_id,auth.uid(),'client_lookup.failed','clients','application');
    return;
  end if;
  if match_count>1 then raise exception 'AMBIGUOUS_CLIENT: More than one assigned client has that name. Enter the client ID instead.'; end if;
  return query select c.id,c.client_code,btrim(c.first_name||' '||c.last_name)
  from public.clients c where c.organization_id=target_organization_id and c.deleted_at is null and c.status='active'
    and (public.has_permission(target_organization_id, 'visits.manage')
      or public.caregiver_has_active_assignment(target_organization_id,c.id,null))
    and (lower(c.client_code)=normalized_term or lower(btrim(c.first_name||' '||c.last_name))=normalized_term)
  limit 1;
end;
$$;
revoke all on function public.find_client_for_visit(uuid,text) from public,anon;
grant execute on function public.find_client_for_visit(uuid,text) to authenticated;

create or replace function public.list_authorized_services_for_client(
  target_organization_id uuid, target_client_id uuid
)
returns table (service_id uuid, service_code text, service_name text, service_color text,
  authorization_id uuid, max_monthly_hours numeric, hours_used_this_month numeric,
  hours_scheduled_this_month numeric)
language sql stable security definer set search_path = public
as $$
  select sv.id,sv.code,sv.name,sv.color,a.id,a.max_monthly_hours,
    coalesce(usage.hours_used_this_month,0),coalesce(usage.hours_scheduled_this_month,0)
  from public.client_authorizations a
  join public.services sv on sv.id=a.service_id and sv.deleted_at is null
  left join lateral (
    select coalesce(sum(extract(epoch from (least(s.ends_at,w.window_end)-greatest(s.starts_at,w.window_start)))/3600.0)
      filter (where s.status='completed'),0) hours_used_this_month,
      coalesce(sum(extract(epoch from (least(s.ends_at,w.window_end)-greatest(s.starts_at,w.window_start)))/3600.0)
      filter (where s.status='scheduled'),0) hours_scheduled_this_month
    from (select greatest(date_trunc('month',now()),a.period_start::timestamptz) window_start,
      least(date_trunc('month',now())+interval '1 month',a.period_end::timestamptz+interval '1 day') window_end) w
    left join public.shifts s on s.client_id=a.client_id and s.service_id=a.service_id
      and s.organization_id=a.organization_id and s.status in ('completed','scheduled')
      and s.starts_at<w.window_end and s.ends_at>w.window_start
  ) usage on true
  where a.organization_id=target_organization_id and a.client_id=target_client_id
    and a.deleted_at is null and current_date between a.period_start and a.period_end
    and (public.has_permission(target_organization_id,'visits.manage')
      or public.caregiver_has_active_assignment(target_organization_id,target_client_id,a.service_id))
  order by sv.name;
$$;
revoke all on function public.list_authorized_services_for_client(uuid,uuid) from public,anon;
grant execute on function public.list_authorized_services_for_client(uuid,uuid) to authenticated;

-- Retire the superseded broad caregiver entry points so they cannot bypass
-- the assigned-client checks above.
revoke execute on function public.find_client_by_code(uuid,text) from authenticated;
revoke execute on function public.start_service_visit_by_client_code(uuid,text,uuid,text[],text) from authenticated;

-- Harden the existing visit starter without changing its external API.
create or replace function public.start_ad_hoc_service_visit(
  target_organization_id uuid, target_client_id uuid, target_service_id uuid,
  visit_task_categories text[] default '{}', visit_service_notes text default null
)
returns uuid language plpgsql security definer set search_path = public
as $$
declare target_client public.clients%rowtype; target_auth public.client_authorizations%rowtype;
  caregiver_name text; visit_id uuid; started_at timestamptz:=now(); org_slug text; new_visit_number text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.organization_memberships om where om.organization_id=target_organization_id
    and om.user_id=auth.uid() and om.status='active'
    and (om.role='caregiver' or public.has_permission(target_organization_id,'visits.manage'))) then
    raise exception 'Only an active caregiver or visit manager can start a visit';
  end if;
  if not public.has_permission(target_organization_id,'visits.manage')
     and not public.caregiver_has_active_assignment(target_organization_id,target_client_id,target_service_id) then
    raise exception 'This client and service are not assigned to you';
  end if;
  if exists (select 1 from public.service_visits v where v.organization_id=target_organization_id
    and v.caregiver_user_id=auth.uid() and v.status in ('draft','awaiting_signature')) then
    raise exception 'Finish or submit your current visit before starting another client';
  end if;
  select * into target_client from public.clients where id=target_client_id and organization_id=target_organization_id
    and deleted_at is null and status='active';
  if target_client.id is null then raise exception 'Client not found or inactive'; end if;
  select * into target_auth from public.client_authorizations where organization_id=target_organization_id
    and client_id=target_client_id and service_id=target_service_id
    and started_at::date between period_start and period_end and deleted_at is null
    order by period_start desc limit 1 for update;
  if target_auth.id is null then raise exception 'No active authorization covers this client and service'; end if;
  select coalesce(nullif(btrim(cr.preferred_name||' '||cr.last_name),''),
    nullif(btrim(cr.first_name||' '||cr.last_name),''),up.display_name,'Caregiver') into caregiver_name
  from public.user_profiles up left join public.caregiver_records cr on cr.organization_id=target_organization_id
    and cr.linked_user_id=up.id and cr.deleted_at is null where up.id=auth.uid() limit 1;
  select upper(left(regexp_replace(slug,'[^a-zA-Z0-9]','','g'),4)) into org_slug
    from public.organizations where id=target_organization_id;
  new_visit_number:=coalesce(nullif(org_slug,''),'OGEV')||'-V-'||to_char(started_at,'YYYYMMDD')
    ||'-'||upper(substr(md5(gen_random_uuid()::text),1,4));
  insert into public.service_visits (organization_id,client_id,client_code_snapshot,caregiver_user_id,
    caregiver_name_snapshot,scheduled_shift_id,service_authorization_id,service_id,service_date,time_in,
    task_categories,service_notes,status,created_by,visit_number_snapshot)
  values (target_organization_id,target_client.id,target_client.client_code,auth.uid(),coalesce(caregiver_name,'Caregiver'),
    null,target_auth.id,target_service_id,started_at::date,started_at,coalesce(visit_task_categories,'{}'),
    nullif(trim(visit_service_notes),''),'draft',auth.uid(),new_visit_number) returning id into visit_id;
  insert into public.audit_logs (organization_id,actor_user_id,action,entity_type,entity_id,source)
    values (target_organization_id,auth.uid(),'service_visit.started_ad_hoc','service_visits',visit_id,'application');
  return visit_id;
end;
$$;
revoke all on function public.start_ad_hoc_service_visit(uuid,uuid,uuid,text[],text) from public,anon;
grant execute on function public.start_ad_hoc_service_visit(uuid,uuid,uuid,text[],text) to authenticated;

-- Remove caregiver self-edit access. Caregivers retain read-only access to
-- their own workforce and availability records.
drop policy if exists self_or_authorized_manage_availability on public.caregiver_availability;
create policy authorized_manage_availability on public.caregiver_availability
for all to authenticated
using (public.has_permission(organization_id, 'membership.update'))
with check (public.has_permission(organization_id, 'membership.update'));

create or replace function public.set_caregiver_profile(
  target_organization_id uuid, target_user_id uuid,
  new_address_city text, new_address_state text, new_address_zip text,
  new_languages text[], new_skills text[]
)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'membership.update') then
    raise exception 'Only an organization owner can edit caregiver profiles';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = target_organization_id and m.user_id = target_user_id
  ) then raise exception 'No membership found for that user in this organization'; end if;
  update public.user_profiles set address_city = new_address_city,
    address_state = new_address_state, address_zip = new_address_zip,
    languages = coalesce(new_languages, '{}'), skills = coalesce(new_skills, '{}')
  where id = target_user_id;
  if not found then raise exception 'No profile found for that user'; end if;
end;
$$;
revoke all on function public.set_caregiver_profile(uuid, uuid, text, text, text, text[], text[]) from public, anon;
grant execute on function public.set_caregiver_profile(uuid, uuid, text, text, text, text[], text[]) to authenticated;

-- Weekly targets are organization-managed scheduling data. The previous
-- function allowed any shifts.update holder; keep that behavior for owners,
-- managers and schedulers while explicitly rejecting caregiver self-edits.
create or replace function public.set_caregiver_weekly_target(
  target_organization_id uuid, target_user_id uuid, target_hours numeric
)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'shifts.update') then
    raise exception 'You do not have permission to set caregiver targets for this organization';
  end if;
  if exists (
    select 1 from public.organization_memberships m
    where m.organization_id = target_organization_id and m.user_id = auth.uid()
      and m.role = 'caregiver'
  ) then
    raise exception 'Caregivers cannot edit weekly hour targets';
  end if;
  update public.organization_memberships set target_hours_per_week = target_hours
  where organization_id = target_organization_id and user_id = target_user_id;
  if not found then raise exception 'No membership found for that user in this organization'; end if;
end;
$$;
revoke all on function public.set_caregiver_weekly_target(uuid, uuid, numeric) from public, anon;
grant execute on function public.set_caregiver_weekly_target(uuid, uuid, numeric) to authenticated;
