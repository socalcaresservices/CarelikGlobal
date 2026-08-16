begin;

-- Platform document types are shared vocabulary, but they must not be
-- mandatory for every agency. Store an organization-specific preference
-- for each platform default instead of copying or mutating the global row.
create table public.organization_document_type_preferences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_type_id uuid not null references public.document_types(id) on delete cascade,
  is_enabled boolean not null default true,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (organization_id, document_type_id)
);

alter table public.organization_document_type_preferences enable row level security;

create policy "read_organization_document_type_preferences"
on public.organization_document_type_preferences for select to authenticated
using (public.has_permission(organization_id, 'documents.read'));

-- Use RPCs for writes so callers cannot attach a preference to an
-- organization-owned custom type or to a type from another organization.
create function public.list_configurable_document_types(target_organization_id uuid)
returns table (
  id uuid,
  organization_id uuid,
  name text,
  category text,
  requires_expiration boolean,
  is_active boolean,
  is_platform_default boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    dt.id,
    dt.organization_id,
    dt.name,
    dt.category,
    dt.requires_expiration,
    case
      when dt.organization_id is null then coalesce(pref.is_enabled, true)
      else dt.is_active
    end,
    dt.organization_id is null
  from public.document_types dt
  left join public.organization_document_type_preferences pref
    on pref.organization_id = target_organization_id
   and pref.document_type_id = dt.id
  where dt.deleted_at is null
    and (dt.organization_id is null or dt.organization_id = target_organization_id)
    and public.has_permission(target_organization_id, 'documents.read')
  order by coalesce(dt.category, 'Other'), dt.name;
$$;

create function public.set_document_type_enabled(
  target_organization_id uuid,
  target_document_type_id uuid,
  target_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  type_org uuid;
begin
  if not public.has_permission(target_organization_id, 'documents.manage') then
    raise exception 'You do not have permission to configure document types for this organization';
  end if;

  select organization_id into type_org
  from public.document_types
  where id = target_document_type_id and deleted_at is null;

  if not found then
    raise exception 'Document type not found';
  end if;

  if type_org is null then
    insert into public.organization_document_type_preferences (
      organization_id, document_type_id, is_enabled, updated_by
    ) values (
      target_organization_id, target_document_type_id, target_enabled, auth.uid()
    )
    on conflict (organization_id, document_type_id) do update
      set is_enabled = excluded.is_enabled,
          updated_by = auth.uid(),
          updated_at = now();
  elsif type_org = target_organization_id then
    update public.document_types
    set is_active = target_enabled, updated_by = auth.uid()
    where id = target_document_type_id;
  else
    raise exception 'Document type does not belong to this organization';
  end if;
end;
$$;

revoke all on function public.list_configurable_document_types(uuid) from public, anon;
grant execute on function public.list_configurable_document_types(uuid) to authenticated;
revoke all on function public.set_document_type_enabled(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_document_type_enabled(uuid, uuid, boolean) to authenticated;

commit;
