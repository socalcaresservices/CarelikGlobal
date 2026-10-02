begin;

-- Incidents can carry more than one category (e.g. "Fall" and "Injury").
--
-- incidents.category (text, not null) stays as the PRIMARY category so
-- every existing reader (sorting, audit history, actionable counts, older
-- clients) keeps working. New incidents.categories text[] holds the full
-- ordered list; a trigger keeps the two consistent:
--   - categories is trimmed, blanks dropped, duplicates (case-insensitive)
--     removed, order kept;
--   - if categories is empty it becomes {category}; otherwise category is
--     set to categories[1];
--   - at least one category is required (category stays not null).
-- Backfill: categories = {category} for existing rows.
-- list_incidents returns categories (new trailing column); global search
-- matches and shows every category. Table RLS is unchanged: the existing
-- insert/update policies cover the new column.

alter table public.incidents
  add column if not exists categories text[] not null default '{}';

create or replace function public.normalize_incident_categories()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cleaned text[];
begin
  -- An update that changes only the legacy single category (older clients)
  -- replaces the primary category instead of being overwritten by it.
  if tg_op = 'UPDATE'
     and new.category is distinct from old.category
     and new.categories is not distinct from old.categories then
    new.categories := array[new.category] || coalesce(old.categories[2:], '{}');
  end if;

  select coalesce(array_agg(c order by first_pos), '{}')
    into cleaned
  from (
    select min(btrim(x)) as c, min(ord) as first_pos
    from unnest(coalesce(new.categories, '{}')) with ordinality as t(x, ord)
    where btrim(coalesce(x, '')) <> ''
    group by lower(btrim(x))
  ) d;

  if cardinality(cleaned) = 0 and btrim(coalesce(new.category, '')) <> '' then
    cleaned := array[btrim(new.category)];
  end if;
  if cardinality(cleaned) = 0 then
    raise exception 'An incident needs at least one category';
  end if;

  new.categories := cleaned;
  new.category := cleaned[1];
  return new;
end;
$$;

revoke all on function public.normalize_incident_categories() from public, anon, authenticated;

drop trigger if exists incidents_normalize_categories on public.incidents;
create trigger incidents_normalize_categories
before insert or update of category, categories on public.incidents
for each row execute function public.normalize_incident_categories();

update public.incidents
   set categories = array[category]
 where cardinality(categories) = 0;

drop function if exists public.list_incidents(uuid, integer, timestamptz, uuid);

create function public.list_incidents(
  target_organization_id uuid,
  result_limit integer default 200,
  before_occurred_at timestamptz default null,
  before_id uuid default null
)
returns table (
  id uuid,
  client_id uuid,
  client_name text,
  caregiver_user_id uuid,
  caregiver_name text,
  occurred_at timestamptz,
  category text,
  severity public.incident_severity,
  status public.incident_status,
  description text,
  reported_by uuid,
  reported_by_name text,
  resolution_notes text,
  resolved_at timestamptz,
  categories text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id,
    i.client_id,
    c.first_name || ' ' || c.last_name,
    i.caregiver_user_id,
    cg.display_name,
    i.occurred_at,
    i.category,
    i.severity,
    i.status,
    i.description,
    i.reported_by,
    coalesce(rp.display_name, 'Unknown member'),
    i.resolution_notes,
    i.resolved_at,
    i.categories
  from public.incidents i
  left join public.clients c on c.id = i.client_id
  left join public.user_profiles cg on cg.id = i.caregiver_user_id
  left join public.user_profiles rp on rp.id = i.reported_by
  where i.organization_id = target_organization_id
    and i.deleted_at is null
    and (
      public.has_permission(target_organization_id, 'incidents.read')
      or i.reported_by = auth.uid()
    )
    and (
      before_occurred_at is null
      or (i.occurred_at, i.id) < (before_occurred_at, before_id)
    )
  order by i.occurred_at desc, i.id desc
  limit least(greatest(result_limit, 1), 500);
$$;
revoke all on function public.list_incidents(uuid, integer, timestamptz, uuid) from public;
grant execute on function public.list_incidents(uuid, integer, timestamptz, uuid) to authenticated;
revoke execute on function public.list_incidents(uuid, integer, timestamptz, uuid) from anon;

create or replace function public.global_search(target_organization_id uuid, search_query text)
returns table (result_type text, entity_id uuid, title text, subtitle text)
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
    select 'credential'::text, crc.id, crc.credential_type, coalesce(nullif(trim(cr.preferred_name), ''), cr.first_name || ' ' || cr.last_name)
    from public.caregiver_record_credentials crc
    join public.caregiver_records cr on cr.id = crc.caregiver_record_id
    where crc.organization_id = target_organization_id
      and crc.deleted_at is null
      and cr.linked_user_id is not null
      and (
        public.has_permission(target_organization_id, 'credentials.read')
        or (cr.linked_user_id = auth.uid() and public.organization_is_active(target_organization_id))
      )
      and (crc.credential_type ilike q or (cr.first_name || ' ' || cr.last_name) ilike q)
    order by crc.credential_type
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
    select 'incident'::text, i.id, array_to_string(i.categories, ', '), coalesce(cl.first_name || ' ' || cl.last_name, 'No client on file')
    from public.incidents i
    left join public.clients cl on cl.id = i.client_id
    where i.organization_id = target_organization_id
      and i.deleted_at is null
      and (
        public.has_permission(target_organization_id, 'incidents.read')
        or i.reported_by = auth.uid()
      )
      and (array_to_string(i.categories, ' ') ilike q or i.category ilike q or i.description ilike q)
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
  )
  union all
  (
    select 'applicant'::text, ja.id, ja.first_name || ' ' || ja.last_name, initcap(replace(ja.status::text, '_', ' '))
    from public.job_applicants ja
    where ja.organization_id = target_organization_id
      and public.has_permission(target_organization_id, 'applicants.read')
      and (ja.first_name ilike q or ja.last_name ilike q or ja.email::text ilike q or ja.phone ilike q)
    order by ja.created_at desc
    limit 8
  );
end;
$$;

commit;
