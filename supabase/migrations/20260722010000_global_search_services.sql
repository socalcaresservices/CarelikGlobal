begin;

-- Add "service" as a 6th global_search() result type. The services
-- table (supabase/migrations/20260721010000_services_and_authorization_usage.sql)
-- didn't exist yet when global_search() was first written
-- (20260719290000_global_search.sql) - it's the most obvious gap left
-- from that migration's "every table with a meaningful name/label"
-- rule now that a services catalog exists. Same pattern as every other
-- branch: reuses the table's own read permission, degrades to no rows
-- rather than raising if the caller lacks it, capped at 8.
create or replace function public.global_search(
  target_organization_id uuid,
  search_query text
)
returns table (
  result_type text,
  entity_id uuid,
  title text,
  subtitle text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text;
begin
  if trim(coalesce(search_query, '')) = '' then
    return;
  end if;
  q := '%' || trim(search_query) || '%';

  return query
  (
    select 'client'::text, c.id, c.first_name || ' ' || c.last_name, coalesce(c.phone, c.email, initcap(c.status::text))
    from public.clients c
    where c.organization_id = target_organization_id
      and c.deleted_at is null
      and public.has_permission(target_organization_id, 'clients.read')
      and (c.first_name ilike q or c.last_name ilike q or c.phone ilike q or c.email ilike q)
    order by c.last_name
    limit 8
  )
  union all
  (
    select 'caregiver'::text, m.user_id, coalesce(p.display_name, 'Unknown member'), initcap(replace(m.role::text, '_', ' '))
    from public.organization_memberships m
    join public.user_profiles p on p.id = m.user_id
    where m.organization_id = target_organization_id
      and public.has_permission(target_organization_id, 'membership.read')
      and p.display_name ilike q
    order by p.display_name
    limit 8
  )
  union all
  (
    select 'credential'::text, cr.id, cr.credential_type, coalesce(p.display_name, 'Unknown member')
    from public.caregiver_credentials cr
    join public.user_profiles p on p.id = cr.caregiver_user_id
    where cr.organization_id = target_organization_id
      and cr.deleted_at is null
      and (
        public.has_permission(target_organization_id, 'credentials.read')
        or cr.caregiver_user_id = auth.uid()
      )
      and (cr.credential_type ilike q or p.display_name ilike q)
    order by cr.credential_type
    limit 8
  )
  union all
  (
    select 'authorization'::text, a.id, a.payer, cl.first_name || ' ' || cl.last_name
    from public.client_authorizations a
    join public.clients cl on cl.id = a.client_id
    where a.organization_id = target_organization_id
      and a.deleted_at is null
      and public.has_permission(target_organization_id, 'authorizations.read')
      and (a.payer ilike q or cl.first_name ilike q or cl.last_name ilike q)
    order by a.payer
    limit 8
  )
  union all
  (
    select 'incident'::text, i.id, i.category, coalesce(cl.first_name || ' ' || cl.last_name, 'No client on file')
    from public.incidents i
    left join public.clients cl on cl.id = i.client_id
    where i.organization_id = target_organization_id
      and i.deleted_at is null
      and (
        public.has_permission(target_organization_id, 'incidents.read')
        or i.reported_by = auth.uid()
      )
      and (i.category ilike q or i.description ilike q)
    order by i.occurred_at desc
    limit 8
  )
  union all
  (
    select 'service'::text, s.id, s.name, case when s.is_active then 'Active service' else 'Inactive service' end
    from public.services s
    where s.organization_id = target_organization_id
      and s.deleted_at is null
      and public.has_permission(target_organization_id, 'services.read')
      and s.name ilike q
    order by s.name
    limit 8
  );
end;
$$;

commit;
