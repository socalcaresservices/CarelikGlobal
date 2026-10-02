-- 0011 - Self-service care requests, caregiver availability offers, assignment and cancellation.
--
-- Design goals:
--   * Clients/families request or cancel care from an opaque link; no phone call required.
--   * Possession of the link grants access to ONE client only. Raw tokens are never stored.
--   * Caregivers receive an opaque opportunity link and answer Available / Not available.
--   * "Available" is not an assignment. Only an authorized agency scheduler can assign.
--   * Every candidate/assignment decision stays scoped to organization + client + service.
--   * Public functions are deliberately narrow SECURITY DEFINER functions; ogevia_app has
--     no direct table privileges, so public routes cannot bypass these checks.

insert into ogevia.permissions (key, description) values
  ('care_requests.read', 'View care requests and caregiver responses'),
  ('care_requests.manage', 'Create offers, assign caregivers, and manage care requests')
on conflict (key) do nothing;

insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'care_requests.read'),
  ('organization_owner', 'care_requests.manage'),
  ('manager', 'care_requests.read'),
  ('manager', 'care_requests.manage'),
  ('scheduler', 'care_requests.read'),
  ('scheduler', 'care_requests.manage'),
  ('coordinator', 'care_requests.read'),
  ('coordinator', 'care_requests.manage')
on conflict do nothing;

create type ogevia.care_request_status as enum (
  'new', 'awaiting_responses', 'assigned', 'cancelled', 'closed'
);
create type ogevia.care_request_source as enum (
  'client_link', 'staff', 'caregiver_callout'
);
create type ogevia.care_offer_status as enum (
  'pending', 'available', 'unavailable', 'assigned', 'not_selected', 'expired'
);

create table ogevia.client_request_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  foreign key (client_id, organization_id) references ogevia.clients(id, organization_id),
  unique (token_hash)
);
create unique index client_request_links_one_active
  on ogevia.client_request_links (organization_id, client_id)
  where revoked_at is null;

create table ogevia.care_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  service_id uuid not null,
  requested_start timestamptz not null,
  requested_end timestamptz not null,
  status ogevia.care_request_status not null default 'new',
  source ogevia.care_request_source not null,
  request_note text check (request_note is null or length(request_note) <= 1000),
  original_shift_id uuid references ogevia.shifts(id),
  assigned_shift_id uuid references ogevia.shifts(id),
  assigned_caregiver_record_id uuid,
  created_by uuid references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  cancellation_reason text check (cancellation_reason is null or length(cancellation_reason) <= 500),
  constraint care_requests_time_check check (requested_start < requested_end),
  constraint care_requests_duration_check check (requested_end <= requested_start + interval '16 hours'),
  constraint care_requests_assignment_shape check (
    (status = 'assigned' and assigned_shift_id is not null and assigned_caregiver_record_id is not null)
    or status <> 'assigned'
  ),
  foreign key (client_id, organization_id) references ogevia.clients(id, organization_id),
  foreign key (service_id, organization_id) references ogevia.services(id, organization_id),
  foreign key (assigned_caregiver_record_id, organization_id)
    references ogevia.caregiver_records(id, organization_id)
);
create index care_requests_queue_idx
  on ogevia.care_requests (organization_id, status, requested_start);
create index care_requests_client_idx
  on ogevia.care_requests (organization_id, client_id, requested_start desc);

create table ogevia.care_request_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  care_request_id uuid not null references ogevia.care_requests(id),
  caregiver_record_id uuid not null,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  status ogevia.care_offer_status not null default 'pending',
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id)
    references ogevia.caregiver_records(id, organization_id),
  unique (token_hash),
  unique (care_request_id, caregiver_record_id)
);
create index care_request_offers_request_idx
  on ogevia.care_request_offers (care_request_id, status);
create index care_request_offers_caregiver_idx
  on ogevia.care_request_offers (organization_id, caregiver_record_id, status);

create table ogevia.public_care_request_idempotency (
  link_id uuid not null references ogevia.client_request_links(id),
  idempotency_key uuid not null,
  care_request_id uuid not null references ogevia.care_requests(id),
  created_at timestamptz not null default now(),
  primary key (link_id, idempotency_key)
);

create table ogevia.care_request_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references ogevia.organizations(id),
  care_request_id uuid not null references ogevia.care_requests(id),
  actor_user_id uuid references ogevia.app_users(id),
  event_type text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index care_request_events_request_idx
  on ogevia.care_request_events (care_request_id, created_at);

create trigger care_request_events_append_only
before update on ogevia.care_request_events
for each row execute function ogevia.forbid_update();
create trigger care_request_events_no_delete
before delete on ogevia.care_request_events
for each row execute function ogevia.forbid_delete();

create function ogevia.write_care_request_event(
  p_organization_id uuid,
  p_care_request_id uuid,
  p_event_type text,
  p_detail jsonb default null
)
returns void
language sql
set search_path = ogevia, pg_temp
as $$
  insert into ogevia.care_request_events (
    organization_id, care_request_id, actor_user_id, event_type, detail
  ) values (
    p_organization_id, p_care_request_id, ogevia.current_user_id(), p_event_type, p_detail
  );
$$;

-- ---------------------------------------------------------------------------
-- Manager/scheduler API
-- ---------------------------------------------------------------------------

create function ogevia_api.create_client_request_link(
  p_organization_id uuid,
  p_client_id uuid,
  p_token_hash text,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_id uuid;
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id)
     or not ogevia.has_permission(p_organization_id, 'care_requests.manage') then
    raise exception 'Not permitted' using errcode = 'OGA03';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid token hash' using errcode = 'OGV22';
  end if;
  if not exists (
    select 1 from ogevia.clients c
    where c.id = p_client_id and c.organization_id = p_organization_id
      and c.status = 'active' and c.deleted_at is null
  ) then
    raise exception 'Client not found' using errcode = 'OGA04';
  end if;

  update ogevia.client_request_links
  set revoked_at = now()
  where organization_id = p_organization_id
    and client_id = p_client_id
    and revoked_at is null;

  insert into ogevia.client_request_links (
    organization_id, client_id, token_hash, created_by, expires_at
  ) values (
    p_organization_id, p_client_id, p_token_hash, ogevia.current_user_id(), p_expires_at
  )
  returning id into v_id;

  perform ogevia.write_audit(
    p_organization_id, 'client_request_link.created', 'client', p_client_id,
    null, jsonb_build_object('linkId', v_id), null
  );
  return v_id;
end;
$$;

create function ogevia_api.list_care_request_clients(p_organization_id uuid)
returns table (
  client_id uuid,
  client_code text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select c.id, coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code)
  from ogevia.clients c
  where ogevia.require_actor() is not null
    and c.organization_id = p_organization_id
    and c.status = 'active'
    and c.deleted_at is null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'care_requests.manage')
  order by 2;
$$;

create function ogevia_api.list_care_requests(
  p_organization_id uuid,
  p_status ogevia.care_request_status default null
)
returns table (
  request_id uuid,
  client_id uuid,
  client_code text,
  service_id uuid,
  service_code text,
  service_name text,
  requested_start timestamptz,
  requested_end timestamptz,
  status ogevia.care_request_status,
  source ogevia.care_request_source,
  request_note text,
  assigned_caregiver_record_id uuid,
  assigned_caregiver_name text,
  assigned_shift_id uuid,
  pending_offer_count bigint,
  available_offer_count bigint,
  unavailable_offer_count bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select
    r.id,
    r.client_id,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code),
    r.service_id,
    s.code,
    s.name,
    r.requested_start,
    r.requested_end,
    r.status,
    r.source,
    r.request_note,
    r.assigned_caregiver_record_id,
    case when cr.id is null then null
      else coalesce(nullif(btrim(cr.preferred_name), ''), cr.first_name) || ' ' || cr.last_name
    end,
    r.assigned_shift_id,
    count(o.id) filter (where o.status = 'pending'),
    count(o.id) filter (where o.status = 'available'),
    count(o.id) filter (where o.status = 'unavailable'),
    r.created_at
  from ogevia.care_requests r
  join ogevia.clients c on c.id = r.client_id
  join ogevia.services s on s.id = r.service_id
  left join ogevia.caregiver_records cr on cr.id = r.assigned_caregiver_record_id
  left join ogevia.care_request_offers o on o.care_request_id = r.id
  where ogevia.require_actor() is not null
    and r.organization_id = p_organization_id
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'care_requests.read')
    and (p_status is null or r.status = p_status)
  group by r.id, c.caregiver_display_code, c.client_code, s.code, s.name, cr.id
  order by
    case r.status when 'new' then 0 when 'awaiting_responses' then 1 when 'assigned' then 2 else 3 end,
    r.requested_start;
$$;

create function ogevia_api.list_care_request_candidates(p_care_request_id uuid)
returns table (
  caregiver_record_id uuid,
  caregiver_name text,
  caregiver_code text,
  priority_score integer,
  priority_reason text
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_org uuid;
  v_client uuid;
  v_service uuid;
  v_start timestamptz;
  v_end timestamptz;
begin
  perform ogevia.require_actor();
  select organization_id, client_id, service_id, requested_start, requested_end
  into v_org, v_client, v_service, v_start, v_end
  from ogevia.care_requests
  where id = p_care_request_id;

  if v_org is null then
    raise exception 'Care request not found' using errcode = 'OGA04';
  end if;
  if not ogevia.is_active_member(v_org)
     or not ogevia.has_permission(v_org, 'care_requests.manage') then
    raise exception 'Not permitted' using errcode = 'OGA03';
  end if;

  return query
  select
    cr.id,
    coalesce(nullif(btrim(cr.preferred_name), ''), cr.first_name) || ' ' || cr.last_name,
    cr.caregiver_code,
    case
      when exists (
        select 1 from ogevia.caregiver_assignments ca
        where ca.organization_id = v_org
          and ca.caregiver_user_id = cr.linked_user_id
          and ca.client_id = v_client and ca.service_id = v_service and ca.is_active
      ) then 100
      when exists (
        select 1 from ogevia.caregiver_assignments ca
        where ca.organization_id = v_org
          and ca.caregiver_user_id = cr.linked_user_id
          and ca.client_id = v_client and ca.is_active
      ) then 90
      else 70
    end,
    case
      when exists (
        select 1 from ogevia.caregiver_assignments ca
        where ca.organization_id = v_org
          and ca.caregiver_user_id = cr.linked_user_id
          and ca.client_id = v_client and ca.service_id = v_service and ca.is_active
      ) then 'Current client/service match'
      when exists (
        select 1 from ogevia.caregiver_assignments ca
        where ca.organization_id = v_org
          and ca.caregiver_user_id = cr.linked_user_id
          and ca.client_id = v_client and ca.is_active
      ) then 'Current client match'
      else 'Schedule is clear'
    end
  from ogevia.caregiver_records cr
  where cr.organization_id = v_org
    and cr.deleted_at is null
    and cr.status in ('ready', 'active')
    and not exists (
      select 1
      from ogevia.shifts sh
      where sh.organization_id = v_org
        and sh.caregiver_record_id = cr.id
        and sh.status = 'scheduled'
        and sh.starts_at < v_end
        and sh.ends_at > v_start
    )
  order by 4 desc, 2;
end;
$$;

create function ogevia_api.list_care_request_offers(p_care_request_id uuid)
returns table (
  offer_id uuid,
  caregiver_record_id uuid,
  caregiver_name text,
  status ogevia.care_offer_status,
  responded_at timestamptz,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $
declare
  v_org uuid;
begin
  perform ogevia.require_actor();
  select organization_id into v_org from ogevia.care_requests where id = p_care_request_id;
  if v_org is null then raise exception 'Care request not found' using errcode = 'OGA04'; end if;
  if not ogevia.is_active_member(v_org)
     or not ogevia.has_permission(v_org, 'care_requests.read') then
    raise exception 'Not permitted' using errcode = 'OGA03';
  end if;
  return query
  select f.id, f.caregiver_record_id,
         coalesce(nullif(btrim(cr.preferred_name), ''), cr.first_name) || ' ' || cr.last_name,
         f.status, f.responded_at, f.expires_at
  from ogevia.care_request_offers f
  join ogevia.caregiver_records cr on cr.id = f.caregiver_record_id
  where f.care_request_id = p_care_request_id
  order by case f.status when 'available' then 0 when 'pending' then 1 else 2 end, 3;
end;
$;

create function ogevia_api.create_care_request_offer(
  p_care_request_id uuid,
  p_caregiver_record_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_request ogevia.care_requests%rowtype;
  v_offer_id uuid;
begin
  perform ogevia.require_actor();
  select * into v_request from ogevia.care_requests where id = p_care_request_id for update;
  if v_request.id is null then raise exception 'Care request not found' using errcode = 'OGA04'; end if;
  if not ogevia.is_active_member(v_request.organization_id)
     or not ogevia.has_permission(v_request.organization_id, 'care_requests.manage') then
    raise exception 'Not permitted' using errcode = 'OGA03';
  end if;
  if v_request.status not in ('new', 'awaiting_responses') then
    raise exception 'This care request is no longer accepting caregiver responses' using errcode = 'OGC09';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' or p_expires_at <= now() then
    raise exception 'Invalid offer link' using errcode = 'OGV22';
  end if;
  if not exists (
    select 1 from ogevia.caregiver_records cr
    where cr.id = p_caregiver_record_id
      and cr.organization_id = v_request.organization_id
      and cr.status in ('ready','active') and cr.deleted_at is null
  ) then raise exception 'Caregiver is not active' using errcode = 'OGV22'; end if;
  if exists (
    select 1 from ogevia.shifts sh
    where sh.organization_id = v_request.organization_id
      and sh.caregiver_record_id = p_caregiver_record_id
      and sh.status = 'scheduled'
      and sh.starts_at < v_request.requested_end
      and sh.ends_at > v_request.requested_start
  ) then raise exception 'Caregiver is already scheduled at this time' using errcode = 'OGC09'; end if;

  insert into ogevia.care_request_offers (
    organization_id, care_request_id, caregiver_record_id, token_hash,
    created_by, expires_at
  ) values (
    v_request.organization_id, v_request.id, p_caregiver_record_id, p_token_hash,
    ogevia.current_user_id(), p_expires_at
  )
  on conflict (care_request_id, caregiver_record_id) do update
  set token_hash = excluded.token_hash,
      status = 'pending',
      expires_at = excluded.expires_at,
      responded_at = null,
      updated_at = now()
  where ogevia.care_request_offers.status not in ('assigned', 'not_selected')
  returning id into v_offer_id;

  if v_offer_id is null then
    raise exception 'This caregiver offer is already closed' using errcode = 'OGC09';
  end if;

  update ogevia.care_requests
  set status = 'awaiting_responses', updated_at = now()
  where id = v_request.id and status = 'new';

  perform ogevia.write_care_request_event(
    v_request.organization_id, v_request.id, 'offer_sent',
    jsonb_build_object('offerId', v_offer_id, 'caregiverRecordId', p_caregiver_record_id)
  );
  return v_offer_id;
end;
$$;

create function ogevia_api.assign_care_request(
  p_care_request_id uuid,
  p_caregiver_record_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_request ogevia.care_requests%rowtype;
  v_caregiver ogevia.caregiver_records%rowtype;
  v_shift uuid;
begin
  perform ogevia.require_actor();
  select * into v_request from ogevia.care_requests where id = p_care_request_id for update;
  if v_request.id is null then raise exception 'Care request not found' using errcode = 'OGA04'; end if;
  if not ogevia.is_active_member(v_request.organization_id)
     or not ogevia.has_permission(v_request.organization_id, 'care_requests.manage') then
    raise exception 'Not permitted' using errcode = 'OGA03';
  end if;
  if v_request.status not in ('new', 'awaiting_responses') then
    raise exception 'This care request cannot be assigned' using errcode = 'OGC09';
  end if;

  select * into v_caregiver
  from ogevia.caregiver_records
  where id = p_caregiver_record_id
    and organization_id = v_request.organization_id
    and status in ('ready','active') and deleted_at is null
  for update;
  if v_caregiver.id is null then raise exception 'Caregiver is not active' using errcode = 'OGV22'; end if;

  -- If offers were sent, assignment requires an explicit Available response.
  if exists (select 1 from ogevia.care_request_offers where care_request_id = v_request.id)
     and not exists (
       select 1 from ogevia.care_request_offers
       where care_request_id = v_request.id
         and caregiver_record_id = p_caregiver_record_id
         and status = 'available'
     ) then
    raise exception 'Caregiver has not accepted this opportunity' using errcode = 'OGC09';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ogevia.caregiver-schedule:' || p_caregiver_record_id::text, 0));
  if exists (
    select 1 from ogevia.shifts sh
    where sh.organization_id = v_request.organization_id
      and sh.caregiver_record_id = p_caregiver_record_id
      and sh.status = 'scheduled'
      and sh.starts_at < v_request.requested_end
      and sh.ends_at > v_request.requested_start
  ) then raise exception 'Caregiver is already scheduled at this time' using errcode = 'OGC09'; end if;

  if not exists (
    select 1 from ogevia.resolve_current_authorization(
      v_request.organization_id, v_request.client_id, v_request.service_id,
      ogevia.organization_local_date(v_request.organization_id, v_request.requested_start)
    )
  ) then raise exception 'No current authorization covers this service date' using errcode = 'OGC09'; end if;

  insert into ogevia.shifts (
    organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id,
    starts_at, ends_at, status
  ) values (
    v_request.organization_id, v_request.client_id, v_request.service_id,
    v_caregiver.linked_user_id, v_caregiver.id,
    v_request.requested_start, v_request.requested_end, 'scheduled'
  ) returning id into v_shift;

  update ogevia.care_requests
  set status = 'assigned',
      assigned_shift_id = v_shift,
      assigned_caregiver_record_id = v_caregiver.id,
      resolved_at = now(),
      updated_at = now()
  where id = v_request.id;

  update ogevia.care_request_offers
  set status = case when caregiver_record_id = v_caregiver.id then 'assigned'::ogevia.care_offer_status
                    else 'not_selected'::ogevia.care_offer_status end,
      updated_at = now()
  where care_request_id = v_request.id
    and status in ('pending','available','unavailable');

  perform ogevia.write_care_request_event(
    v_request.organization_id, v_request.id, 'assigned',
    jsonb_build_object('caregiverRecordId', v_caregiver.id, 'shiftId', v_shift)
  );
  perform ogevia.write_audit(
    v_request.organization_id, 'care_request.assigned', 'care_request', v_request.id,
    null, jsonb_build_object('shiftId', v_shift, 'caregiverRecordId', v_caregiver.id), null
  );
  return v_shift;
end;
$$;

create function ogevia_api.list_my_care_opportunities(p_organization_id uuid)
returns table (
  offer_id uuid,
  request_id uuid,
  service_code text,
  service_name text,
  requested_start timestamptz,
  requested_end timestamptz,
  offer_status ogevia.care_offer_status,
  request_status ogevia.care_request_status,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $
  select f.id, r.id, s.code, s.name, r.requested_start, r.requested_end,
         f.status, r.status, f.expires_at
  from ogevia.care_request_offers f
  join ogevia.care_requests r on r.id = f.care_request_id
  join ogevia.services s on s.id = r.service_id
  join ogevia.caregiver_records cr on cr.id = f.caregiver_record_id
  where ogevia.require_actor() is not null
    and f.organization_id = p_organization_id
    and ogevia.is_active_member(p_organization_id)
    and cr.organization_id = p_organization_id
    and cr.linked_user_id = ogevia.current_user_id()
  order by case f.status when 'pending' then 0 when 'available' then 1 when 'assigned' then 2 else 3 end,
           r.requested_start;
$;

create function ogevia_api.respond_my_care_offer(
  p_offer_id uuid,
  p_available boolean
)
returns ogevia.care_offer_status
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $
declare
  v_offer ogevia.care_request_offers%rowtype;
  v_request_status ogevia.care_request_status;
  v_status ogevia.care_offer_status;
begin
  perform ogevia.require_actor();
  select f.*, r.status into v_offer, v_request_status
  from ogevia.care_request_offers f
  join ogevia.care_requests r on r.id = f.care_request_id
  join ogevia.caregiver_records cr on cr.id = f.caregiver_record_id
  where f.id = p_offer_id
    and cr.organization_id = f.organization_id
    and cr.linked_user_id = ogevia.current_user_id()
  for update of f;

  if v_offer.id is null then raise exception 'Opportunity not found' using errcode = 'OGA04'; end if;
  if not ogevia.is_active_member(v_offer.organization_id) then
    raise exception 'Not permitted' using errcode = 'OGA03';
  end if;
  if v_offer.expires_at <= now() then
    if v_offer.status = 'pending' then
      update ogevia.care_request_offers set status = 'expired', updated_at = now() where id = v_offer.id;
    end if;
    return 'expired';
  end if;
  if v_request_status in ('assigned','cancelled','closed') then
    if v_offer.status in ('pending','available','unavailable') then
      update ogevia.care_request_offers set status = 'not_selected', updated_at = now() where id = v_offer.id;
    end if;
    return 'not_selected';
  end if;
  if v_offer.status not in ('pending','available','unavailable') then return v_offer.status; end if;

  v_status := case when p_available then 'available'::ogevia.care_offer_status
                   else 'unavailable'::ogevia.care_offer_status end;
  update ogevia.care_request_offers
  set status = v_status, responded_at = now(), updated_at = now()
  where id = v_offer.id;

  perform ogevia.write_care_request_event(
    v_offer.organization_id, v_offer.care_request_id, 'caregiver_responded',
    jsonb_build_object('caregiverRecordId', v_offer.caregiver_record_id, 'response', v_status)
  );
  return v_status;
end;
$;

-- ---------------------------------------------------------------------------
-- Public token-scoped API. No actor context is required or accepted.
-- ---------------------------------------------------------------------------

create function ogevia_api.public_request_link_context(p_token_hash text)
returns table (
  organization_name text,
  client_code text,
  services jsonb,
  requests jsonb
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with link as (
    select l.*, o.display_name, c.client_code, c.caregiver_display_code
    from ogevia.client_request_links l
    join ogevia.organizations o on o.id = l.organization_id and o.status = 'active'
    join ogevia.clients c on c.id = l.client_id and c.organization_id = l.organization_id
    where l.token_hash = p_token_hash
      and l.revoked_at is null
      and (l.expires_at is null or l.expires_at > now())
      and c.status = 'active' and c.deleted_at is null
  )
  select
    link.display_name,
    coalesce(nullif(btrim(link.caregiver_display_code), ''), link.client_code),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'serviceId', s.id, 'serviceCode', s.code, 'serviceName', s.name
      ) order by s.code)
      from ogevia.services s
      where s.organization_id = link.organization_id
        and s.is_active and s.deleted_at is null
        and exists (
          select 1 from ogevia.client_authorizations a
          where a.organization_id = link.organization_id
            and a.client_id = link.client_id
            and a.service_id = s.id
            and a.is_current and a.deleted_at is null
            and a.period_end >= ogevia.organization_local_date(link.organization_id, now())
        )
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'requestId', r.id,
        'serviceCode', s.code,
        'serviceName', s.name,
        'requestedStart', r.requested_start,
        'requestedEnd', r.requested_end,
        'status', r.status,
        'caregiverName', case when cr.id is null then null
          else coalesce(nullif(btrim(cr.preferred_name), ''), cr.first_name) || ' ' || cr.last_name end
      ) order by r.requested_start desc)
      from ogevia.care_requests r
      join ogevia.services s on s.id = r.service_id
      left join ogevia.caregiver_records cr on cr.id = r.assigned_caregiver_record_id
      where r.organization_id = link.organization_id
        and r.client_id = link.client_id
        and r.created_at >= now() - interval '120 days'
    ), '[]'::jsonb)
  from link;
$$;

create function ogevia_api.public_create_care_request(
  p_token_hash text,
  p_service_id uuid,
  p_requested_start timestamptz,
  p_requested_end timestamptz,
  p_request_note text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_link ogevia.client_request_links%rowtype;
  v_request uuid;
  v_local_date date;
begin
  select l.* into v_link
  from ogevia.client_request_links l
  join ogevia.organizations o on o.id = l.organization_id and o.status = 'active'
  join ogevia.clients c on c.id = l.client_id and c.organization_id = l.organization_id
  where l.token_hash = p_token_hash
    and l.revoked_at is null
    and (l.expires_at is null or l.expires_at > now())
    and c.status = 'active' and c.deleted_at is null
  for update;

  if v_link.id is null then raise exception 'Request link is invalid or expired' using errcode = 'OGA04'; end if;

  select i.care_request_id into v_request
  from ogevia.public_care_request_idempotency i
  where i.link_id = v_link.id and i.idempotency_key = p_idempotency_key;
  if v_request is not null then return v_request; end if;

  if p_requested_start <= now() - interval '5 minutes'
     or p_requested_start > now() + interval '180 days'
     or p_requested_end <= p_requested_start
     or p_requested_end > p_requested_start + interval '16 hours' then
    raise exception 'Requested date or time is invalid' using errcode = 'OGV22';
  end if;
  if p_request_note is not null and length(p_request_note) > 1000 then
    raise exception 'Request note is too long' using errcode = 'OGV22';
  end if;

  v_local_date := ogevia.organization_local_date(v_link.organization_id, p_requested_start);
  if not exists (
    select 1 from ogevia.resolve_current_authorization(
      v_link.organization_id, v_link.client_id, p_service_id, v_local_date
    )
  ) then
    raise exception 'This service is not authorized for the requested date' using errcode = 'OGC09';
  end if;

  insert into ogevia.care_requests (
    organization_id, client_id, service_id, requested_start, requested_end,
    source, request_note
  ) values (
    v_link.organization_id, v_link.client_id, p_service_id, p_requested_start, p_requested_end,
    'client_link', nullif(btrim(p_request_note), '')
  ) returning id into v_request;

  insert into ogevia.public_care_request_idempotency(link_id, idempotency_key, care_request_id)
  values (v_link.id, p_idempotency_key, v_request);

  update ogevia.client_request_links set last_used_at = now() where id = v_link.id;
  perform ogevia.write_care_request_event(
    v_link.organization_id, v_request, 'client_requested',
    jsonb_build_object('serviceId', p_service_id, 'requestedStart', p_requested_start, 'requestedEnd', p_requested_end)
  );
  perform ogevia.write_audit(
    v_link.organization_id, 'care_request.created', 'care_request', v_request,
    null, jsonb_build_object('source', 'client_link', 'serviceId', p_service_id), null
  );
  return v_request;
end;
$$;

create function ogevia_api.public_cancel_care_request(
  p_token_hash text,
  p_care_request_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_link ogevia.client_request_links%rowtype;
  v_request ogevia.care_requests%rowtype;
begin
  select * into v_link
  from ogevia.client_request_links
  where token_hash = p_token_hash
    and revoked_at is null
    and (expires_at is null or expires_at > now());
  if v_link.id is null then raise exception 'Request link is invalid or expired' using errcode = 'OGA04'; end if;

  select * into v_request
  from ogevia.care_requests
  where id = p_care_request_id
    and organization_id = v_link.organization_id
    and client_id = v_link.client_id
  for update;
  if v_request.id is null then raise exception 'Care request not found' using errcode = 'OGA04'; end if;
  if v_request.status in ('cancelled','closed') then return; end if;

  if v_request.assigned_shift_id is not null then
    update ogevia.shifts
    set status = 'cancelled', updated_at = now()
    where id = v_request.assigned_shift_id
      and organization_id = v_link.organization_id
      and status = 'scheduled';
  end if;

  update ogevia.care_requests
  set status = 'cancelled',
      cancellation_reason = left(nullif(btrim(p_reason), ''), 500),
      resolved_at = now(),
      updated_at = now()
  where id = v_request.id;

  update ogevia.care_request_offers
  set status = 'not_selected', updated_at = now()
  where care_request_id = v_request.id and status in ('pending','available');

  perform ogevia.write_care_request_event(
    v_link.organization_id, v_request.id, 'client_cancelled',
    jsonb_build_object('hadAssignedShift', v_request.assigned_shift_id is not null)
  );
end;
$$;

create function ogevia_api.public_offer_context(p_token_hash text)
returns table (
  organization_name text,
  service_code text,
  service_name text,
  requested_start timestamptz,
  requested_end timestamptz,
  offer_status ogevia.care_offer_status,
  request_status ogevia.care_request_status,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select o.display_name, s.code, s.name, r.requested_start, r.requested_end,
         f.status, r.status, f.expires_at
  from ogevia.care_request_offers f
  join ogevia.care_requests r on r.id = f.care_request_id
  join ogevia.organizations o on o.id = f.organization_id and o.status = 'active'
  join ogevia.services s on s.id = r.service_id
  where f.token_hash = p_token_hash;
$$;

create function ogevia_api.public_respond_care_offer(
  p_token_hash text,
  p_available boolean
)
returns ogevia.care_offer_status
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_offer ogevia.care_request_offers%rowtype;
  v_request_status ogevia.care_request_status;
  v_status ogevia.care_offer_status;
begin
  select f.*, r.status into v_offer, v_request_status
  from ogevia.care_request_offers f
  join ogevia.care_requests r on r.id = f.care_request_id
  where f.token_hash = p_token_hash
  for update of f;

  if v_offer.id is null then raise exception 'Opportunity link is invalid' using errcode = 'OGA04'; end if;
  if v_offer.expires_at <= now() then
    if v_offer.status = 'pending' then
      update ogevia.care_request_offers set status = 'expired', updated_at = now() where id = v_offer.id;
    end if;
    return 'expired';
  end if;
  if v_request_status in ('assigned','cancelled','closed') then
    if v_offer.status in ('pending','available','unavailable') then
      update ogevia.care_request_offers set status = 'not_selected', updated_at = now() where id = v_offer.id;
    end if;
    return 'not_selected';
  end if;
  if v_offer.status not in ('pending','available','unavailable') then
    return v_offer.status;
  end if;

  v_status := case when p_available then 'available'::ogevia.care_offer_status
                   else 'unavailable'::ogevia.care_offer_status end;
  update ogevia.care_request_offers
  set status = v_status, responded_at = now(), updated_at = now()
  where id = v_offer.id;

  perform ogevia.write_care_request_event(
    v_offer.organization_id, v_offer.care_request_id, 'caregiver_responded',
    jsonb_build_object('caregiverRecordId', v_offer.caregiver_record_id, 'response', v_status)
  );
  return v_status;
end;
$$;

-- Public functions can be executed by the restricted runtime role, but cannot
-- reach any other table directly because ogevia_app has no table privileges.
revoke all on function ogevia_api.create_client_request_link(uuid, uuid, text, timestamptz) from public;
revoke all on function ogevia_api.list_care_request_clients(uuid) from public;
revoke all on function ogevia_api.list_care_requests(uuid, ogevia.care_request_status) from public;
revoke all on function ogevia_api.list_care_request_candidates(uuid) from public;
revoke all on function ogevia_api.list_care_request_offers(uuid) from public;
revoke all on function ogevia_api.create_care_request_offer(uuid, uuid, text, timestamptz) from public;
revoke all on function ogevia_api.assign_care_request(uuid, uuid) from public;
revoke all on function ogevia_api.list_my_care_opportunities(uuid) from public;
revoke all on function ogevia_api.respond_my_care_offer(uuid, boolean) from public;
revoke all on function ogevia_api.public_request_link_context(text) from public;
revoke all on function ogevia_api.public_create_care_request(text, uuid, timestamptz, timestamptz, text, uuid) from public;
revoke all on function ogevia_api.public_cancel_care_request(text, uuid, text) from public;
revoke all on function ogevia_api.public_offer_context(text) from public;
revoke all on function ogevia_api.public_respond_care_offer(text, boolean) from public;

grant execute on function ogevia_api.create_client_request_link(uuid, uuid, text, timestamptz) to ogevia_app;
grant execute on function ogevia_api.list_care_request_clients(uuid) to ogevia_app;
grant execute on function ogevia_api.list_care_requests(uuid, ogevia.care_request_status) to ogevia_app;
grant execute on function ogevia_api.list_care_request_candidates(uuid) to ogevia_app;
grant execute on function ogevia_api.list_care_request_offers(uuid) to ogevia_app;
grant execute on function ogevia_api.create_care_request_offer(uuid, uuid, text, timestamptz) to ogevia_app;
grant execute on function ogevia_api.assign_care_request(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_my_care_opportunities(uuid) to ogevia_app;
grant execute on function ogevia_api.respond_my_care_offer(uuid, boolean) to ogevia_app;
grant execute on function ogevia_api.public_request_link_context(text) to ogevia_app;
grant execute on function ogevia_api.public_create_care_request(text, uuid, timestamptz, timestamptz, text, uuid) to ogevia_app;
grant execute on function ogevia_api.public_cancel_care_request(text, uuid, text) to ogevia_app;
grant execute on function ogevia_api.public_offer_context(text) to ogevia_app;
grant execute on function ogevia_api.public_respond_care_offer(text, boolean) to ogevia_app;
