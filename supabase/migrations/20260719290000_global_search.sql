begin;

-- Global search: one function, unioning across every table that already
-- has a meaningful name/label to search on. Each branch reuses the exact
-- same permission check (and own-row carve-out, where one exists) as that
-- table's own RLS policy - global_search never shows a row the caller
-- couldn't already see on that table's own page. If the caller lacks the
-- read permission for a given entity type, that branch simply contributes
-- no rows rather than raising, so one search box degrades gracefully
-- across whatever the caller happens to have access to.
--
-- Deliberately NOT included: invoices, documents, and visits/diagnoses
-- (referenced as aspirational examples in docs/design-system.md's
-- "Search everywhere" section) - none of those have a table yet, and
-- inventing search results for data that doesn't exist would be exactly
-- the kind of fabrication this project avoids. Shifts aren't a separate
-- result type either; a shift's only searchable identity is its client
-- and caregiver, both of which are already covered by their own results.
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
  );
end;
$$;

revoke all on function public.global_search(uuid, text) from public;
grant execute on function public.global_search(uuid, text) to authenticated;
revoke execute on function public.global_search(uuid, text) from anon;

commit;
