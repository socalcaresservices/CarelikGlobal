-- 0004 - Versioned client authorizations (financial control).
--
-- Current main: client_authorizations with version_number / is_current /
-- supersedes_id / superseded_by_id (20260812185552). Defect M-1: the SV v3
-- functions resolved authorizations WITHOUT is_current, so after an amendment
-- a visit could bind to the superseded version, and usage was summed per
-- version id, so minutes on the old version did not count against the new cap.
--
-- Target invariants:
--  1. lineage_id groups every version of one authorization (v1.id).
--  2. At most one CURRENT, non-deleted version covers any date for an
--     organization + client + service (exclusion constraint, not just a
--     same-period unique index).
--  3. Only current versions are resolvable (ogevia.resolve_current_authorization).
--  4. Usage is summed across the whole lineage (ogevia.authorization_month_usage
--     in 0005), so an amendment can never reset consumption.
--  5. Versions are immutable; the only permitted update is the supersede
--     transition performed by ogevia_api.amend_client_authorization.
--  6. Caps are exact integer minutes (no floating-point hours).

create table ogevia.client_authorizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  service_id uuid not null,
  lineage_id uuid not null,
  version_number integer not null default 1 check (version_number >= 1),
  is_current boolean not null default true,
  supersedes_id uuid references ogevia.client_authorizations(id),
  superseded_by_id uuid references ogevia.client_authorizations(id),
  payer text not null,
  authorization_number text,
  -- Monthly cap in whole minutes. Current main stores max_monthly_hours numeric;
  -- migration converts with round(hours * 60) (PHASE_2_DATA_MIGRATION_PLAN.md).
  monthly_authorized_minutes integer not null check (monthly_authorized_minutes >= 0),
  period_start date not null,
  period_end date not null,
  -- Billing rate; carried forward unchanged by amendments (current main
  -- protect_authorization_financial_fields: managers can never set it).
  hourly_rate_cents integer check (hourly_rate_cents is null or hourly_rate_cents >= 0),
  received_date date,
  source_reference text,
  change_reason text,
  created_by uuid references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint client_authorizations_period_check check (period_start < period_end),
  constraint client_authorizations_lineage_fk
    foreign key (lineage_id) references ogevia.client_authorizations(id),
  constraint client_authorizations_supersede_shape check (
    (version_number = 1 and supersedes_id is null)
    or (version_number > 1 and supersedes_id is not null)
  ),
  constraint client_authorizations_current_not_superseded check (
    not (is_current and superseded_by_id is not null)
  ),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id),
  unique (id, organization_id),
  unique (lineage_id, version_number),
  constraint client_authorizations_one_current_per_coverage
    exclude using gist (
      organization_id with =,
      client_id with =,
      service_id with =,
      daterange(period_start, period_end, '[]') with &&
    ) where (is_current and deleted_at is null)
);

create index client_authorizations_current_lookup_idx
  on ogevia.client_authorizations (organization_id, client_id, service_id, period_start, period_end)
  where is_current and deleted_at is null;
create index client_authorizations_lineage_idx on ogevia.client_authorizations (lineage_id);

create function ogevia.client_authorizations_before_insert()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if new.lineage_id is null then
    if new.version_number <> 1 then
      raise exception 'A later authorization version must name its lineage' using errcode = 'OGV22';
    end if;
    new.lineage_id := new.id;
  end if;
  return new;
end;
$$;

create trigger client_authorizations_set_lineage
before insert on ogevia.client_authorizations
for each row execute function ogevia.client_authorizations_before_insert();

-- Versions are immutable. The only allowed change is current -> superseded.
create function ogevia.client_authorizations_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.is_current
     and not new.is_current
     and old.superseded_by_id is null
     and (to_jsonb(new) - array['is_current', 'superseded_by_id', 'updated_at'])
         = (to_jsonb(old) - array['is_current', 'superseded_by_id', 'updated_at'])
  then
    return new;
  end if;
  if old.superseded_by_id is null
     and new.superseded_by_id is not null
     and not old.is_current and not new.is_current
     and (to_jsonb(new) - array['superseded_by_id', 'updated_at'])
         = (to_jsonb(old) - array['superseded_by_id', 'updated_at'])
  then
    return new;
  end if;
  raise exception 'Authorization versions are immutable; amend to create a new version'
    using errcode = 'OGC09';
end;
$$;

create trigger client_authorizations_immutable
before update on ogevia.client_authorizations
for each row execute function ogevia.client_authorizations_guard_update();

create function ogevia.forbid_delete()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  raise exception '% rows are never deleted', tg_table_name using errcode = 'OGC09';
end;
$$;

create trigger client_authorizations_no_delete
before delete on ogevia.client_authorizations
for each row execute function ogevia.forbid_delete();

-- The single CURRENT authorization covering a date, or no row.
create function ogevia.resolve_current_authorization(
  p_organization_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_on date
)
returns setof ogevia.client_authorizations
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select a.*
  from ogevia.client_authorizations a
  where a.organization_id = p_organization_id
    and a.client_id = p_client_id
    and a.service_id = p_service_id
    and a.is_current
    and a.deleted_at is null
    and p_on between a.period_start and a.period_end;
$$;

-- Serializes every cap decision for one authorization lineage (confirm,
-- correct, amend) so concurrent requests cannot both spend the same minutes.
create function ogevia.lock_authorization_lineage(p_lineage_id uuid)
returns void
language sql
set search_path = ogevia, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('ogevia.authorization-lineage:' || p_lineage_id::text, 0));
$$;
