begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

create type public.organization_status as enum ('active', 'suspended', 'closed');
create type public.membership_status as enum ('invited', 'active', 'suspended', 'revoked');
create type public.system_role as enum (
  'platform_owner',
  'organization_owner',
  'organization_admin',
  'manager',
  'coordinator',
  'staff',
  'read_only'
);
create type public.notification_channel as enum ('in_app', 'email', 'sms', 'push', 'webhook');
create type public.notification_status as enum ('queued', 'processing', 'sent', 'failed', 'cancelled');
create type public.event_status as enum ('pending', 'processing', 'published', 'failed', 'dead_letter');

create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  first_name text,
  last_name text,
  phone text,
  locale text not null default 'en-US',
  timezone text not null default 'America/Los_Angeles',
  platform_role public.system_role,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_profiles_platform_role_check
    check (platform_role is null or platform_role = 'platform_owner')
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique,
  legal_name text not null,
  display_name text not null,
  status public.organization_status not null default 'active',
  timezone text not null default 'America/Los_Angeles',
  country_code char(2) not null default 'US',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint organizations_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.system_role not null,
  status public.membership_status not null default 'active',
  invited_by uuid references auth.users(id),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id),
  constraint organization_memberships_role_check
    check (role <> 'platform_owner')
);

create table public.permissions (
  key text primary key,
  description text not null,
  created_at timestamptz not null default now()
);

create table public.role_permissions (
  role public.system_role not null,
  permission_key text not null references public.permissions(key) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role, permission_key),
  constraint role_permissions_platform_role_check check (role <> 'platform_owner')
);

create table public.organization_settings (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  value jsonb not null,
  version integer not null default 1,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (organization_id, key)
);

create table public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  organization_id uuid references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  configuration jsonb not null default '{}'::jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (key, organization_id),
  constraint feature_flags_window_check check (
    starts_at is null or ends_at is null or starts_at < ends_at
  )
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  request_id uuid,
  source text not null default 'application',
  ip_address inet,
  user_agent text,
  old_values jsonb,
  new_values jsonb,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table public.domain_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  event_type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  payload jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  status public.event_status not null default 'pending',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, idempotency_key)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  recipient_user_id uuid references auth.users(id) on delete cascade,
  channel public.notification_channel not null,
  template_key text not null,
  subject text,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  status public.notification_status not null default 'queued',
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, idempotency_key)
);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_type text not null,
  owner_id uuid,
  document_type text not null,
  bucket_id text not null,
  object_path text not null,
  original_filename text not null,
  mime_type text not null,
  size_bytes bigint not null,
  checksum_sha256 text,
  version integer not null default 1,
  uploaded_by uuid not null references auth.users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (bucket_id, object_path),
  constraint files_size_check check (size_bytes >= 0)
);

create index organization_memberships_user_idx
  on public.organization_memberships(user_id, status);
create index audit_logs_org_time_idx
  on public.audit_logs(organization_id, occurred_at desc);
create index domain_events_dispatch_idx
  on public.domain_events(status, available_at)
  where status in ('pending', 'failed');
create index notifications_dispatch_idx
  on public.notifications(status, scheduled_for)
  where status in ('queued', 'failed');
create index files_org_owner_idx
  on public.files(organization_id, owner_type, owner_id)
  where deleted_at is null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger user_profiles_set_updated_at
before update on public.user_profiles
for each row execute function public.set_updated_at();

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function public.set_updated_at();

create trigger organization_memberships_set_updated_at
before update on public.organization_memberships
for each row execute function public.set_updated_at();

create trigger feature_flags_set_updated_at
before update on public.feature_flags
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, display_name, first_name, last_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.email),
    new.raw_user_meta_data ->> 'first_name',
    new.raw_user_meta_data ->> 'last_name'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_platform_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_profiles
    where id = auth.uid()
      and platform_role = 'platform_owner'
  );
$$;

create or replace function public.is_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_platform_owner() or exists (
    select 1
    from public.organization_memberships
    where organization_id = target_organization_id
      and user_id = auth.uid()
      and status = 'active'
  );
$$;

create or replace function public.has_permission(
  target_organization_id uuid,
  requested_permission text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_platform_owner() or exists (
    select 1
    from public.organization_memberships m
    join public.role_permissions rp on rp.role = m.role
    where m.organization_id = target_organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and rp.permission_key = requested_permission
  );
$$;

revoke all on function public.is_platform_owner() from public;
revoke all on function public.is_organization_member(uuid) from public;
revoke all on function public.has_permission(uuid, text) from public;
grant execute on function public.is_platform_owner() to authenticated;
grant execute on function public.is_organization_member(uuid) to authenticated;
grant execute on function public.has_permission(uuid, text) to authenticated;

alter table public.user_profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.organization_settings enable row level security;
alter table public.feature_flags enable row level security;
alter table public.audit_logs enable row level security;
alter table public.domain_events enable row level security;
alter table public.notifications enable row level security;
alter table public.files enable row level security;

create policy "users_read_own_profile"
on public.user_profiles for select
to authenticated
using (id = auth.uid() or public.is_platform_owner());

create policy "users_update_own_profile"
on public.user_profiles for update
to authenticated
using (id = auth.uid() or public.is_platform_owner())
with check (id = auth.uid() or public.is_platform_owner());

create policy "members_read_organizations"
on public.organizations for select
to authenticated
using (public.is_organization_member(id));

create policy "authorized_update_organizations"
on public.organizations for update
to authenticated
using (public.has_permission(id, 'organization.update'))
with check (public.has_permission(id, 'organization.update'));

create policy "members_read_memberships"
on public.organization_memberships for select
to authenticated
using (
  user_id = auth.uid()
  or public.has_permission(organization_id, 'membership.read')
);

create policy "authorized_manage_memberships"
on public.organization_memberships for all
to authenticated
using (public.has_permission(organization_id, 'membership.update'))
with check (public.has_permission(organization_id, 'membership.update'));

create policy "authenticated_read_permissions"
on public.permissions for select
to authenticated
using (true);

create policy "authenticated_read_role_permissions"
on public.role_permissions for select
to authenticated
using (true);

create policy "authorized_read_settings"
on public.organization_settings for select
to authenticated
using (public.has_permission(organization_id, 'settings.read'));

create policy "authorized_manage_settings"
on public.organization_settings for all
to authenticated
using (public.has_permission(organization_id, 'settings.update'))
with check (public.has_permission(organization_id, 'settings.update'));

create policy "members_read_feature_flags"
on public.feature_flags for select
to authenticated
using (
  organization_id is null
  or public.is_organization_member(organization_id)
);

create policy "platform_owner_manage_feature_flags"
on public.feature_flags for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

create policy "authorized_read_audit"
on public.audit_logs for select
to authenticated
using (
  organization_id is not null
  and public.has_permission(organization_id, 'audit.read')
);

create policy "members_read_notifications"
on public.notifications for select
to authenticated
using (
  recipient_user_id = auth.uid()
  and public.is_organization_member(organization_id)
);

create policy "members_read_files"
on public.files for select
to authenticated
using (
  deleted_at is null
  and public.has_permission(organization_id, 'files.read')
);

create policy "members_create_files"
on public.files for insert
to authenticated
with check (
  uploaded_by = auth.uid()
  and public.has_permission(organization_id, 'files.create')
);

create policy "members_soft_delete_files"
on public.files for update
to authenticated
using (public.has_permission(organization_id, 'files.delete'))
with check (public.has_permission(organization_id, 'files.delete'));

insert into public.permissions (key, description) values
  ('organization.read', 'View organization information'),
  ('organization.update', 'Update organization information'),
  ('membership.read', 'View organization memberships'),
  ('membership.invite', 'Invite organization members'),
  ('membership.update', 'Update organization memberships'),
  ('membership.remove', 'Remove organization memberships'),
  ('settings.read', 'View organization settings'),
  ('settings.update', 'Update organization settings'),
  ('audit.read', 'View organization audit logs'),
  ('files.read', 'View organization files'),
  ('files.create', 'Upload organization files'),
  ('files.delete', 'Delete organization files');

insert into public.role_permissions (role, permission_key)
select role_value, permission_key
from (
  values
    ('organization_owner'::public.system_role),
    ('organization_admin'::public.system_role)
) roles(role_value)
cross join public.permissions;

insert into public.role_permissions (role, permission_key) values
  ('manager', 'organization.read'),
  ('manager', 'membership.read'),
  ('manager', 'settings.read'),
  ('manager', 'audit.read'),
  ('manager', 'files.read'),
  ('manager', 'files.create'),
  ('manager', 'files.delete'),
  ('coordinator', 'organization.read'),
  ('coordinator', 'membership.read'),
  ('coordinator', 'settings.read'),
  ('coordinator', 'files.read'),
  ('coordinator', 'files.create'),
  ('staff', 'organization.read'),
  ('staff', 'files.read'),
  ('staff', 'files.create'),
  ('read_only', 'organization.read'),
  ('read_only', 'files.read');

insert into storage.buckets (id, name, public, file_size_limit)
values ('organization-documents', 'organization-documents', false, 52428800)
on conflict (id) do nothing;

create policy "organization_members_read_storage"
on storage.objects for select
to authenticated
using (
  bucket_id = 'organization-documents'
  and public.has_permission(
    nullif((storage.foldername(name))[1], '')::uuid,
    'files.read'
  )
);

create policy "organization_members_upload_storage"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'organization-documents'
  and public.has_permission(
    nullif((storage.foldername(name))[1], '')::uuid,
    'files.create'
  )
);

create policy "organization_members_delete_storage"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'organization-documents'
  and public.has_permission(
    nullif((storage.foldername(name))[1], '')::uuid,
    'files.delete'
  )
);

commit;
