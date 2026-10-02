-- 0011 - Self-service care requests, caregiver availability, offers, assignment and coverage.
-- Extends the canonical shifts/authorizations model; it does NOT create a second scheduler.

create type ogevia.care_request_status as enum (
  'requested', 'offering', 'accepted_pending_assignment', 'assigned',
  'coverage_needed', 'client_cancelled', 'filled', 'closed'
);
create type ogevia.care_offer_status as enum ('sent', 'available', 'not_available', 'assigned', 'filled', 'cancelled');
create type ogevia.care_notification_recipient as enum ('staff', 'client_portal', 'caregiver');

insert into ogevia.permissions (key, description) values
  ('care_requests.read', 'View care requests and coverage queue'),
  ('care_requests.manage', 'Manage care requests, offers, assignment, and coverage'),
  ('availability.manage_own', 'Manage own caregiver availability')
on conflict (key) do nothing;

insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'care_requests.read'), ('organization_owner', 'care_requests.manage'),
  ('organization_admin', 'care_requests.read'), ('organization_admin', 'care_requests.manage'),
  ('manager', 'care_requests.read'), ('manager', 'care_requests.manage'),
  ('scheduler', 'care_requests.read'), ('scheduler', 'care_requests.manage'),
  ('coordinator', 'care_requests.read'), ('coordinator', 'care_requests.manage'),
  ('caregiver', 'availability.manage_own')
on conflict do nothing;

create table ogevia.client_care_portals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  token_hash bytea not null unique,
  label text,
  is_active boolean not null default true,
  created_by uuid references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  foreign key (client_id, organization_id) references ogevia.clients(id, organization_id)
);
create index client_care_portals_client_idx on ogevia.client_care_portals(organization_id, client_id) where is_active;

create table ogevia.caregiver_availability_windows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  weekday smallint,
  specific_date date,
  start_local time not null,
  end_local time not null,
  created_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records(id, organization_id),
  constraint availability_window_shape check ((weekday is null) <> (specific_date is null)),
  constraint availability_weekday check (weekday is null or weekday between 0 and 6),
  constraint availability_time check (start_local < end_local)
);
create index caregiver_availability_lookup_idx on ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, specific_date, weekday);

create table ogevia.caregiver_unavailable_dates (
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  unavailable_date date not null,
  reason text,
  created_at timestamptz not null default now(),
  primary key (organization_id, caregiver_record_id, unavailable_date),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records(id, organization_id)
);

create table ogevia.care_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  service_id uuid not null,
  portal_id uuid references ogevia.client_care_portals(id),
  authorization_lineage_id uuid not null references ogevia.client_authorizations(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  requested_minutes integer not null check (requested_minutes >= 180),
  status ogevia.care_request_status not null default 'requested',
  note text,
  short_notice boolean not null default false,
  request_key uuid not null,
  assigned_shift_id uuid references ogevia.shifts(id),
  assigned_caregiver_record_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  assigned_at timestamptz,
  cancelled_at timestamptz,
  foreign key (client_id, organization_id) references ogevia.clients(id, organization_id),
  foreign key (service_id, organization_id) references ogevia.services(id, organization_id),
  foreign key (assigned_caregiver_record_id, organization_id) references ogevia.caregiver_records(id, organization_id),
  constraint care_request_time_check check (starts_at < ends_at),
  unique (portal_id, request_key)
);
create index care_requests_queue_idx on ogevia.care_requests(organization_id, status, starts_at);

create table ogevia.care_request_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  care_request_id uuid not null references ogevia.care_requests(id),
  caregiver_record_id uuid not null,
  token_hash bytea not null unique,
  status ogevia.care_offer_status not null default 'sent',
  note text,
  sent_at timestamptz not null default now(),
  responded_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records(id, organization_id),
  unique (care_request_id, caregiver_record_id)
);
create index care_request_offers_request_idx on ogevia.care_request_offers(care_request_id, status);

create table ogevia.authorization_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  authorization_lineage_id uuid not null references ogevia.client_authorizations(id),
  care_request_id uuid not null unique references ogevia.care_requests(id),
  shift_id uuid not null unique references ogevia.shifts(id),
  service_date date not null,
  reserved_minutes integer not null check (reserved_minutes > 0),
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now()
);
create index authorization_reservations_usage_idx on ogevia.authorization_reservations(authorization_lineage_id, service_date) where released_at is null;

alter table ogevia.shift_coverage_events
  add column actor_user_id uuid references ogevia.app_users(id),
  add column original_caregiver_record_id uuid,
  add column replacement_caregiver_record_id uuid,
  add column reason text,
  add column before_snapshot jsonb,
  add column after_snapshot jsonb;

create table ogevia.care_request_alert_recipients (
  organization_id uuid not null references ogevia.organizations(id),
  user_id uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table ogevia.care_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  care_request_id uuid not null references ogevia.care_requests(id),
  recipient_type ogevia.care_notification_recipient not null,
  recipient_user_id uuid references ogevia.app_users(id),
  caregiver_record_id uuid,
  event_key text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records(id, organization_id)
);
create index care_notifications_staff_idx on ogevia.care_notifications(organization_id, recipient_user_id, read_at, created_at desc);

create table ogevia.care_request_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  care_request_id uuid not null references ogevia.care_requests(id),
  shift_id uuid references ogevia.shifts(id),
  event_key text not null,
  actor_user_id uuid references ogevia.app_users(id),
  reason text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz not null default now()
);
create index care_request_events_request_idx on ogevia.care_request_events(care_request_id, created_at);

create function ogevia.care_request_reserved_usage(p_lineage_id uuid, p_service_date date, p_exclude_request_id uuid default null)
returns bigint language sql stable set search_path=ogevia,pg_temp as $$
  select coalesce(sum(r.reserved_minutes),0)::bigint
  from ogevia.authorization_reservations r
  where r.authorization_lineage_id=p_lineage_id
    and r.released_at is null
    and r.service_date >= date_trunc('month',p_service_date::timestamp)::date
    and r.service_date < (date_trunc('month',p_service_date::timestamp)+interval '1 month')::date
    and r.care_request_id is distinct from p_exclude_request_id;
$$;

create function ogevia_api.create_client_care_portal(p_organization_id uuid,p_client_id uuid,p_label text default null)
returns table(portal_id uuid, token text)
language plpgsql security definer set search_path=ogevia,pg_temp as $$
declare v_token text; v_id uuid;
begin
  if not ogevia.has_permission(p_organization_id,'care_requests.manage') then raise exception 'Forbidden' using errcode='OGA03'; end if;
  if not exists(select 1 from ogevia.clients where id=p_client_id and organization_id=p_organization_id and status='active' and deleted_at is null) then raise exception 'Client not found' using errcode='OGN04'; end if;
  v_token:=encode(gen_random_bytes(32),'hex');
  insert into ogevia.client_care_portals(organization_id,client_id,token_hash,label,created_by)
  values(p_organization_id,p_client_id,digest(decode(v_token,'hex'),'sha256'),nullif(btrim(p_label),''),ogevia.require_actor()) returning id into v_id;
  return query select v_id,v_token;
end;$$;

create function ogevia_api.get_public_care_portal(p_token text)
returns table(organization_name text, client_code text, service_id uuid, service_code text, service_name text, period_end date)
language sql security definer set search_path=ogevia,pg_temp as $$
  select o.display_name,c.client_code,s.id,s.code,s.name,a.period_end
  from ogevia.client_care_portals p
  join ogevia.organizations o on o.id=p.organization_id and o.status='active'
  join ogevia.clients c on c.id=p.client_id and c.organization_id=p.organization_id and c.status='active' and c.deleted_at is null
  join ogevia.client_authorizations a on a.organization_id=p.organization_id and a.client_id=p.client_id and a.is_current and a.deleted_at is null and a.period_end >= ogevia.organization_local_date(p.organization_id,now())
  join ogevia.services s on s.id=a.service_id and s.organization_id=p.organization_id and s.is_active and s.deleted_at is null
  where p.is_active and p.token_hash=digest(decode(p_token,'hex'),'sha256')
  order by s.code;
$$;

create function ogevia_api.public_create_care_request(p_token text,p_service_id uuid,p_starts_at timestamptz,p_ends_at timestamptz,p_note text,p_request_key uuid)
returns table(request_id uuid,status ogevia.care_request_status,short_notice boolean)
language plpgsql security definer set search_path=ogevia,pg_temp as $$
declare v_portal ogevia.client_care_portals%rowtype; v_auth ogevia.client_authorizations%rowtype; v_minutes integer; v_id uuid; v_short boolean;
begin
  select * into v_portal from ogevia.client_care_portals where is_active and token_hash=digest(decode(p_token,'hex'),'sha256');
  if v_portal.id is null then raise exception 'Invalid care portal' using errcode='OGA01'; end if;
  if p_ends_at<=p_starts_at or p_starts_at<=now() then raise exception 'Choose a future time range' using errcode='OGV22'; end if;
  v_minutes:=ceil(extract(epoch from(p_ends_at-p_starts_at))/60)::integer;
  if v_minutes<180 then raise exception 'Care requests must be at least 3 hours' using errcode='OGV22'; end if;
  select * into v_auth from ogevia.resolve_current_authorization(v_portal.organization_id,v_portal.client_id,p_service_id,ogevia.organization_local_date(v_portal.organization_id,p_starts_at)) limit 1;
  if v_auth.id is null then raise exception 'No active authorization covers this service date' using errcode='OGV22'; end if;
  v_short:=p_starts_at < now()+interval '72 hours';
  insert into ogevia.care_requests(organization_id,client_id,service_id,portal_id,authorization_lineage_id,starts_at,ends_at,requested_minutes,note,short_notice,request_key)
  values(v_portal.organization_id,v_portal.client_id,p_service_id,v_portal.id,v_auth.lineage_id,p_starts_at,p_ends_at,v_minutes,nullif(btrim(p_note),''),v_short,p_request_key)
  on conflict(portal_id,request_key) do update set updated_at=ogevia.care_requests.updated_at
  returning id into v_id;
  insert into ogevia.care_notifications(organization_id,care_request_id,recipient_type,recipient_user_id,event_key)
  select v_portal.organization_id,v_id,'staff',m.user_id,'care_request_created'
  from ogevia.organization_memberships m
  where m.organization_id=v_portal.organization_id and m.status='active'
    and (exists(select 1 from ogevia.care_request_alert_recipients ar where ar.organization_id=m.organization_id and ar.user_id=m.user_id)
      or (not exists(select 1 from ogevia.care_request_alert_recipients ar where ar.organization_id=m.organization_id)
          and exists(select 1 from ogevia.role_permissions rp where rp.role=m.role and rp.permission_key='care_requests.manage')));
  return query select r.id,r.status,r.short_notice from ogevia.care_requests r where r.id=v_id;
end;$$;

create function ogevia_api.public_get_care_request(p_token text,p_request_id uuid)
returns table(request_id uuid,status ogevia.care_request_status,service_code text,service_name text,starts_at timestamptz,ends_at timestamptz,caregiver_name text)
language sql security definer set search_path=ogevia,pg_temp as $$
  select r.id,r.status,s.code,s.name,r.starts_at,r.ends_at,
    case when r.status='assigned' then coalesce(cr.preferred_name,cr.first_name) else null end
  from ogevia.client_care_portals p join ogevia.care_requests r on r.portal_id=p.id
  join ogevia.services s on s.id=r.service_id
  left join ogevia.caregiver_records cr on cr.id=r.assigned_caregiver_record_id
  where p.is_active and p.token_hash=digest(decode(p_token,'hex'),'sha256') and r.id=p_request_id;
$$;

create function ogevia_api.public_cancel_care_request(p_token text,p_request_id uuid,p_reason text default null)
returns ogevia.care_request_status language plpgsql security definer set search_path=ogevia,pg_temp as $$
declare r ogevia.care_requests%rowtype;
begin
  select cr.* into r from ogevia.client_care_portals p join ogevia.care_requests cr on cr.portal_id=p.id
  where p.is_active and p.token_hash=digest(decode(p_token,'hex'),'sha256') and cr.id=p_request_id for update of cr;
  if r.id is null then raise exception 'Request not found' using errcode='OGN04'; end if;
  if r.status in ('client_cancelled','filled','closed') then return r.status; end if;
  update ogevia.care_requests set status='client_cancelled',cancelled_at=now(),updated_at=now() where id=r.id;
  if r.assigned_shift_id is not null then
    update ogevia.shifts set status='cancelled',updated_at=now() where id=r.assigned_shift_id;
    update ogevia.authorization_reservations set released_at=now(),release_reason='client_cancelled' where care_request_id=r.id and released_at is null;
    update ogevia.care_request_offers set status='cancelled',updated_at=now() where care_request_id=r.id and status='assigned';
    insert into ogevia.care_request_events(organization_id,care_request_id,shift_id,event_key,reason,before_snapshot,after_snapshot)
    values(r.organization_id,r.id,r.assigned_shift_id,'client_cancelled',coalesce(nullif(btrim(p_reason),''),'Client cancelled'),jsonb_build_object('status','scheduled'),jsonb_build_object('status','cancelled'));
  end if;
  insert into ogevia.care_notifications(organization_id,care_request_id,recipient_type,caregiver_record_id,event_key)
  select r.organization_id,r.id,'caregiver',r.assigned_caregiver_record_id,'client_cancelled' where r.assigned_caregiver_record_id is not null;
  insert into ogevia.care_notifications(organization_id,care_request_id,recipient_type,recipient_user_id,event_key)
  select r.organization_id,r.id,'staff',m.user_id,case when r.starts_at < now()+interval '24 hours' then 'client_cancelled_short_notice' else 'client_cancelled' end
  from ogevia.organization_memberships m
  where m.organization_id=r.organization_id and m.status='active'
    and (exists(select 1 from ogevia.care_request_alert_recipients ar where ar.organization_id=m.organization_id and ar.user_id=m.user_id)
      or (not exists(select 1 from ogevia.care_request_alert_recipients ar where ar.organization_id=m.organization_id)
          and exists(select 1 from ogevia.role_permissions rp where rp.role=m.role and rp.permission_key='care_requests.manage')));
  return 'client_cancelled';
end;$$;

create function ogevia_api.list_care_requests(p_organization_id uuid,p_status ogevia.care_request_status default null)
returns table(request_id uuid,client_code text,service_id uuid,service_code text,service_name text,starts_at timestamptz,ends_at timestamptz,requested_minutes integer,status ogevia.care_request_status,short_notice boolean,available_count bigint,awaiting_count bigint,assigned_caregiver_name text)
language sql stable security definer set search_path=ogevia,pg_temp as $$
  select r.id,c.client_code,s.id,s.code,s.name,r.starts_at,r.ends_at,r.requested_minutes,r.status,r.short_notice,
    count(o.id) filter(where o.status='available'),count(o.id) filter(where o.status='sent'),coalesce(cr.preferred_name,cr.first_name)
  from ogevia.care_requests r join ogevia.clients c on c.id=r.client_id join ogevia.services s on s.id=r.service_id
  left join ogevia.care_request_offers o on o.care_request_id=r.id
  left join ogevia.caregiver_records cr on cr.id=r.assigned_caregiver_record_id
  where r.organization_id=p_organization_id and ogevia.has_permission(p_organization_id,'care_requests.read') and (p_status is null or r.status=p_status)
  group by r.id,c.client_code,s.id,s.code,s.name,cr.preferred_name,cr.first_name order by r.starts_at;
$$;

create function ogevia_api.list_available_caregivers(p_organization_id uuid,p_request_id uuid)
returns table(caregiver_record_id uuid,caregiver_name text,current_client_match boolean,availability_source text)
language sql stable security definer set search_path=ogevia,pg_temp as $$
  with req as(
    select r.*,o.timezone,(r.starts_at at time zone o.timezone)::date local_date,
      (r.starts_at at time zone o.timezone)::time local_start,
      (r.ends_at at time zone o.timezone)::time local_end,
      extract(dow from r.starts_at at time zone o.timezone)::smallint dow
    from ogevia.care_requests r join ogevia.organizations o on o.id=r.organization_id
    where r.id=p_request_id and r.organization_id=p_organization_id
  ), candidates as(
    select cr.id caregiver_record_id,cr.linked_user_id,cr.first_name,cr.last_name,cr.preferred_name,
      q.client_id,q.service_id,q.local_date,q.dow
    from req q join ogevia.caregiver_records cr on cr.organization_id=q.organization_id and cr.status in('ready','active') and cr.deleted_at is null
    where not exists(select 1 from ogevia.caregiver_unavailable_dates u where u.organization_id=q.organization_id and u.caregiver_record_id=cr.id and u.unavailable_date=q.local_date)
      and exists(select 1 from ogevia.caregiver_availability_windows w where w.organization_id=q.organization_id and w.caregiver_record_id=cr.id and (w.specific_date=q.local_date or (w.specific_date is null and w.weekday=q.dow)) and w.start_local<=q.local_start and w.end_local>=q.local_end)
      and not exists(select 1 from ogevia.shifts sh where sh.organization_id=q.organization_id and sh.caregiver_record_id=cr.id and sh.id is distinct from q.assigned_shift_id and sh.status in('scheduled','completed') and sh.starts_at<q.ends_at and sh.ends_at>q.starts_at)
      and not exists(select 1 from ogevia.care_request_offers oo where oo.care_request_id=q.id and oo.caregiver_record_id=cr.id and oo.status in('not_available','cancelled'))
  )
  select c.caregiver_record_id,coalesce(c.preferred_name,c.first_name)||' '||c.last_name,
    exists(select 1 from ogevia.caregiver_assignments a where a.organization_id=p_organization_id and a.caregiver_user_id=c.linked_user_id and a.client_id=c.client_id and a.service_id=c.service_id and a.is_active),
    case when exists(select 1 from ogevia.caregiver_availability_windows w where w.caregiver_record_id=c.caregiver_record_id and w.specific_date=c.local_date) then 'date-specific' else 'recurring' end
  from candidates c where ogevia.has_permission(p_organization_id,'care_requests.manage')
  order by 3 desc,2;
$$;

create function ogevia_api.send_care_offer(p_organization_id uuid,p_request_id uuid,p_caregiver_record_id uuid)
returns table(offer_id uuid,token text)
language plpgsql security definer set search_path=ogevia,pg_temp as $$
declare v_token text; v_offer uuid;
begin
  if not ogevia.has_permission(p_organization_id,'care_requests.manage') then raise exception 'Forbidden' using errcode='OGA03'; end if;
  if not exists(select 1 from ogevia_api.list_available_caregivers(p_organization_id,p_request_id) x where x.caregiver_record_id=p_caregiver_record_id) then raise exception 'Caregiver is not currently available for this request' using errcode='OGV22'; end if;
  v_token:=encode(gen_random_bytes(32),'hex');
  insert into ogevia.care_request_offers(organization_id,care_request_id,caregiver_record_id,token_hash)
  values(p_organization_id,p_request_id,p_caregiver_record_id,digest(decode(v_token,'hex'),'sha256'))
  on conflict(care_request_id,caregiver_record_id) do update set token_hash=excluded.token_hash,status='sent',responded_at=null,updated_at=now()
  returning id into v_offer;
  update ogevia.care_requests set status='offering',updated_at=now() where id=p_request_id and status in('requested','coverage_needed');
  return query select v_offer,v_token;
end;$$;

create function ogevia_api.public_get_care_offer(p_token text)
returns table(offer_id uuid,status ogevia.care_offer_status,service_code text,service_name text,starts_at timestamptz,ends_at timestamptz,client_label text)
language sql security definer set search_path=ogevia,pg_temp as $$
 select o.id,o.status,s.code,s.name,r.starts_at,r.ends_at,coalesce(c.caregiver_display_code,c.client_code)
 from ogevia.care_request_offers o join ogevia.care_requests r on r.id=o.care_request_id join ogevia.services s on s.id=r.service_id join ogevia.clients c on c.id=r.client_id
 where o.token_hash=digest(decode(p_token,'hex'),'sha256');
$$;

create function ogevia_api.public_respond_care_offer(p_token text,p_available boolean,p_note text default null)
returns ogevia.care_offer_status language plpgsql security definer set search_path=ogevia,pg_temp as $$
declare o ogevia.care_request_offers%rowtype; v_status ogevia.care_offer_status;
begin
 select * into o from ogevia.care_request_offers where token_hash=digest(decode(p_token,'hex'),'sha256') for update;
 if o.id is null then raise exception 'Offer not found' using errcode='OGN04'; end if;
 if o.status not in('sent','available','not_available') then return o.status; end if;
 v_status:=case when p_available then 'available'::ogevia.care_offer_status else 'not_available'::ogevia.care_offer_status end;
 update ogevia.care_request_offers set status=v_status,note=nullif(btrim(p_note),''),responded_at=now(),updated_at=now() where id=o.id;
 if p_available then update ogevia.care_requests set status='accepted_pending_assignment',updated_at=now() where id=o.care_request_id and status='offering'; end if;
 insert into ogevia.care_notifications(organization_id,care_request_id,recipient_type,recipient_user_id,event_key)
 select o.organization_id,o.care_request_id,'staff',m.user_id,case when p_available then 'caregiver_available' else 'caregiver_unavailable' end
 from ogevia.organization_memberships m where m.organization_id=o.organization_id and m.status='active' and exists(select 1 from ogevia.role_permissions rp where rp.role=m.role and rp.permission_key='care_requests.manage');
 return v_status;
end;$$;

create function ogevia_api.assign_care_request(p_organization_id uuid,p_request_id uuid,p_offer_id uuid)
returns uuid language plpgsql security definer set search_path=ogevia,pg_temp as $$
declare r ogevia.care_requests%rowtype; o ogevia.care_request_offers%rowtype; cr ogevia.caregiver_records%rowtype; a ogevia.client_authorizations%rowtype; v_shift uuid; v_used bigint; v_reserved bigint; v_date date;
begin
 if not ogevia.has_permission(p_organization_id,'care_requests.manage') then raise exception 'Forbidden' using errcode='OGA03'; end if;
 select * into r from ogevia.care_requests where id=p_request_id and organization_id=p_organization_id for update;
 select * into o from ogevia.care_request_offers where id=p_offer_id and care_request_id=p_request_id and organization_id=p_organization_id and status='available' for update;
 if r.id is null or o.id is null then raise exception 'Request or accepted offer not found' using errcode='OGN04'; end if;
 select * into cr from ogevia.caregiver_records where id=o.caregiver_record_id and organization_id=p_organization_id and status in('ready','active') and deleted_at is null;
 if cr.id is null then raise exception 'Caregiver is no longer active' using errcode='OGV22'; end if;
 if not exists(select 1 from ogevia_api.list_available_caregivers(p_organization_id,p_request_id) x where x.caregiver_record_id=cr.id) then
   raise exception 'Caregiver is no longer available for this request' using errcode='OGC09';
 end if;
 if exists(select 1 from ogevia.shifts sh where sh.organization_id=p_organization_id and sh.caregiver_record_id=cr.id and sh.id is distinct from r.assigned_shift_id and sh.status in('scheduled','completed') and sh.starts_at<r.ends_at and sh.ends_at>r.starts_at) then raise exception 'Caregiver is already scheduled at this time' using errcode='OGC09'; end if;
 v_date:=ogevia.organization_local_date(p_organization_id,r.starts_at);
 if r.assigned_shift_id is null then
   select * into a from ogevia.client_authorizations where lineage_id=r.authorization_lineage_id and is_current and deleted_at is null and v_date between period_start and period_end;
   if a.id is null then raise exception 'Authorization is no longer active' using errcode='OGV22'; end if;
   perform ogevia.lock_authorization_lineage(r.authorization_lineage_id);
   v_used:=ogevia.authorization_month_usage(r.authorization_lineage_id,v_date,null);
   v_reserved:=ogevia.care_request_reserved_usage(r.authorization_lineage_id,v_date,r.id);
   if v_used+v_reserved+r.requested_minutes>a.monthly_authorized_minutes then raise exception 'Not enough authorized time remains for this assignment' using errcode='OGC09'; end if;
   insert into ogevia.shifts(organization_id,client_id,service_id,caregiver_user_id,caregiver_record_id,starts_at,ends_at,status)
   values(p_organization_id,r.client_id,r.service_id,cr.linked_user_id,cr.id,r.starts_at,r.ends_at,'scheduled') returning id into v_shift;
   insert into ogevia.authorization_reservations(organization_id,authorization_lineage_id,care_request_id,shift_id,service_date,reserved_minutes)
   values(p_organization_id,r.authorization_lineage_id,r.id,v_shift,v_date,r.requested_minutes);
 else
   v_shift:=r.assigned_shift_id;
   insert into ogevia.shift_coverage_events(organization_id,shift_id,event_type,actor_user_id,original_caregiver_record_id,replacement_caregiver_record_id,reason,before_snapshot,after_snapshot)
   values(p_organization_id,v_shift,'reassigned',ogevia.require_actor(),r.assigned_caregiver_record_id,cr.id,'Coverage reassigned',jsonb_build_object('caregiver_record_id',r.assigned_caregiver_record_id),jsonb_build_object('caregiver_record_id',cr.id));
   insert into ogevia.care_request_events(organization_id,care_request_id,shift_id,event_key,actor_user_id,before_snapshot,after_snapshot)
   values(p_organization_id,r.id,v_shift,'reassigned',ogevia.require_actor(),jsonb_build_object('caregiver_record_id',r.assigned_caregiver_record_id),jsonb_build_object('caregiver_record_id',cr.id));
   update ogevia.shifts set caregiver_record_id=cr.id,caregiver_user_id=cr.linked_user_id,status='scheduled',updated_at=now() where id=v_shift;
 end if;
 update ogevia.care_requests set status='assigned',assigned_shift_id=v_shift,assigned_caregiver_record_id=cr.id,assigned_at=now(),updated_at=now() where id=r.id;
 update ogevia.care_request_offers set status=case when id=o.id then 'assigned'::ogevia.care_offer_status when status in('sent','available') then 'filled'::ogevia.care_offer_status else status end,updated_at=now() where care_request_id=r.id;
 insert into ogevia.care_notifications(organization_id,care_request_id,recipient_type,caregiver_record_id,event_key) values(p_organization_id,r.id,'caregiver',cr.id,'assignment_confirmed');
 insert into ogevia.care_notifications(organization_id,care_request_id,recipient_type,event_key) values(p_organization_id,r.id,'client_portal','assignment_confirmed');
 return v_shift;
end;$$;

create function ogevia_api.public_cancel_assigned_offer(p_token text,p_reason text)
returns ogevia.care_request_status language plpgsql security definer set search_path=ogevia,pg_temp as $$
declare o ogevia.care_request_offers%rowtype; r ogevia.care_requests%rowtype;
begin
 select * into o from ogevia.care_request_offers where token_hash=digest(decode(p_token,'hex'),'sha256') for update;
 if o.id is null or o.status<>'assigned' then raise exception 'Assigned offer not found' using errcode='OGN04'; end if;
 select * into r from ogevia.care_requests where id=o.care_request_id for update;
 update ogevia.care_request_offers set status='cancelled',note=nullif(btrim(p_reason),''),updated_at=now() where id=o.id;
 update ogevia.care_requests set status='coverage_needed',updated_at=now() where id=r.id;
 insert into ogevia.shift_coverage_events(organization_id,shift_id,event_type,original_caregiver_record_id,reason,before_snapshot,after_snapshot)
 values(r.organization_id,r.assigned_shift_id,'called_out',o.caregiver_record_id,coalesce(nullif(btrim(p_reason),''),'Caregiver unavailable'),jsonb_build_object('caregiver_record_id',o.caregiver_record_id),jsonb_build_object('coverage_needed',true));
 insert into ogevia.care_request_events(organization_id,care_request_id,shift_id,event_key,reason,before_snapshot,after_snapshot)
 values(r.organization_id,r.id,r.assigned_shift_id,'caregiver_callout',coalesce(nullif(btrim(p_reason),''),'Caregiver unavailable'),jsonb_build_object('caregiver_record_id',o.caregiver_record_id),jsonb_build_object('coverage_needed',true));
 insert into ogevia.care_notifications(organization_id,care_request_id,recipient_type,recipient_user_id,event_key)
 select r.organization_id,r.id,'staff',m.user_id,'coverage_needed' from ogevia.organization_memberships m where m.organization_id=r.organization_id and m.status='active' and exists(select 1 from ogevia.role_permissions rp where rp.role=m.role and rp.permission_key='care_requests.manage');
 return 'coverage_needed';
end;$$;

create function ogevia_api.get_my_availability(p_organization_id uuid)
returns table(window_id uuid,weekday smallint,specific_date date,start_local time,end_local time)
language sql stable security definer set search_path=ogevia,pg_temp as $$
 select w.id,w.weekday,w.specific_date,w.start_local,w.end_local from ogevia.caregiver_availability_windows w join ogevia.caregiver_records cr on cr.id=w.caregiver_record_id and cr.organization_id=w.organization_id and cr.linked_user_id=ogevia.require_actor()
 where w.organization_id=p_organization_id and ogevia.has_permission(p_organization_id,'availability.manage_own') order by w.specific_date nulls last,w.weekday,w.start_local;
$$;

create function ogevia_api.replace_my_availability(p_organization_id uuid,p_windows jsonb,p_unavailable_dates jsonb default '[]'::jsonb)
returns void language plpgsql security definer set search_path=ogevia,pg_temp as $$
declare v_cr uuid;
begin
 if not ogevia.has_permission(p_organization_id,'availability.manage_own') then raise exception 'Forbidden' using errcode='OGA03'; end if;
 select id into v_cr from ogevia.caregiver_records where organization_id=p_organization_id and linked_user_id=ogevia.require_actor() and status in('ready','active') and deleted_at is null;
 if v_cr is null then raise exception 'Caregiver record not found' using errcode='OGN04'; end if;
 delete from ogevia.caregiver_availability_windows where organization_id=p_organization_id and caregiver_record_id=v_cr;
 insert into ogevia.caregiver_availability_windows(organization_id,caregiver_record_id,weekday,specific_date,start_local,end_local)
 select p_organization_id,v_cr,x.weekday,x.specific_date,x.start_local,x.end_local from jsonb_to_recordset(coalesce(p_windows,'[]'::jsonb)) as x(weekday smallint,specific_date date,start_local time,end_local time);
 delete from ogevia.caregiver_unavailable_dates where organization_id=p_organization_id and caregiver_record_id=v_cr;
 insert into ogevia.caregiver_unavailable_dates(organization_id,caregiver_record_id,unavailable_date)
 select p_organization_id,v_cr,(jsonb_array_elements_text(coalesce(p_unavailable_dates,'[]'::jsonb)))::date;
end;$$;

create function ogevia_api.list_staff_care_notifications(p_organization_id uuid)
returns table(notification_id uuid,care_request_id uuid,event_key text,created_at timestamptz)
language sql stable security definer set search_path=ogevia,pg_temp as $$
 select n.id,n.care_request_id,n.event_key,n.created_at from ogevia.care_notifications n where n.organization_id=p_organization_id and n.recipient_type='staff' and n.recipient_user_id=ogevia.require_actor() and n.read_at is null and ogevia.has_permission(p_organization_id,'care_requests.read') order by n.created_at desc limit 100;
$$;

revoke all on function ogevia_api.create_client_care_portal(uuid,uuid,text) from public;
revoke all on function ogevia_api.get_public_care_portal(text) from public;
revoke all on function ogevia_api.public_create_care_request(text,uuid,timestamptz,timestamptz,text,uuid) from public;
revoke all on function ogevia_api.public_get_care_request(text,uuid) from public;
revoke all on function ogevia_api.public_cancel_care_request(text,uuid,text) from public;
revoke all on function ogevia_api.list_care_requests(uuid,ogevia.care_request_status) from public;
revoke all on function ogevia_api.list_available_caregivers(uuid,uuid) from public;
revoke all on function ogevia_api.send_care_offer(uuid,uuid,uuid) from public;
revoke all on function ogevia_api.public_get_care_offer(text) from public;
revoke all on function ogevia_api.public_respond_care_offer(text,boolean,text) from public;
revoke all on function ogevia_api.assign_care_request(uuid,uuid,uuid) from public;
revoke all on function ogevia_api.public_cancel_assigned_offer(text,text) from public;
revoke all on function ogevia_api.get_my_availability(uuid) from public;
revoke all on function ogevia_api.replace_my_availability(uuid,jsonb,jsonb) from public;
revoke all on function ogevia_api.list_staff_care_notifications(uuid) from public;

grant execute on function ogevia_api.create_client_care_portal(uuid,uuid,text) to ogevia_app;
grant execute on function ogevia_api.get_public_care_portal(text) to ogevia_app;
grant execute on function ogevia_api.public_create_care_request(text,uuid,timestamptz,timestamptz,text,uuid) to ogevia_app;
grant execute on function ogevia_api.public_get_care_request(text,uuid) to ogevia_app;
grant execute on function ogevia_api.public_cancel_care_request(text,uuid,text) to ogevia_app;
grant execute on function ogevia_api.list_care_requests(uuid,ogevia.care_request_status) to ogevia_app;
grant execute on function ogevia_api.list_available_caregivers(uuid,uuid) to ogevia_app;
grant execute on function ogevia_api.send_care_offer(uuid,uuid,uuid) to ogevia_app;
grant execute on function ogevia_api.public_get_care_offer(text) to ogevia_app;
grant execute on function ogevia_api.public_respond_care_offer(text,boolean,text) to ogevia_app;
grant execute on function ogevia_api.assign_care_request(uuid,uuid,uuid) to ogevia_app;
grant execute on function ogevia_api.public_cancel_assigned_offer(text,text) to ogevia_app;
grant execute on function ogevia_api.get_my_availability(uuid) to ogevia_app;
grant execute on function ogevia_api.replace_my_availability(uuid,jsonb,jsonb) to ogevia_app;
grant execute on function ogevia_api.list_staff_care_notifications(uuid) to ogevia_app;


create function ogevia_api.list_care_request_offers(p_organization_id uuid,p_request_id uuid)
returns table(offer_id uuid,caregiver_record_id uuid,caregiver_name text,status ogevia.care_offer_status,responded_at timestamptz)
language sql stable security definer set search_path=ogevia,pg_temp as $$
 select o.id,o.caregiver_record_id,coalesce(cr.preferred_name,cr.first_name)||' '||cr.last_name,o.status,o.responded_at
 from ogevia.care_request_offers o join ogevia.caregiver_records cr on cr.id=o.caregiver_record_id
 where o.organization_id=p_organization_id and o.care_request_id=p_request_id and ogevia.has_permission(p_organization_id,'care_requests.read')
 order by case o.status when 'available' then 0 when 'sent' then 1 else 2 end,cr.last_name,cr.first_name;
$$;

create function ogevia_api.list_client_portal_options(p_organization_id uuid)
returns table(client_id uuid,client_code text)
language sql stable security definer set search_path=ogevia,pg_temp as $$
 select c.id,c.client_code from ogevia.clients c where c.organization_id=p_organization_id and c.status='active' and c.deleted_at is null and ogevia.has_permission(p_organization_id,'care_requests.manage') order by c.client_code;
$$;

create function ogevia_api.list_care_alert_staff(p_organization_id uuid)
returns table(user_id uuid,display_name text,selected boolean)
language sql stable security definer set search_path=ogevia,pg_temp as $$
 select u.id,coalesce(u.display_name,'Staff'),exists(select 1 from ogevia.care_request_alert_recipients a where a.organization_id=p_organization_id and a.user_id=u.id)
 from ogevia.organization_memberships m join ogevia.app_users u on u.id=m.user_id
 where m.organization_id=p_organization_id and m.status='active' and ogevia.has_permission(p_organization_id,'care_requests.manage')
   and exists(select 1 from ogevia.role_permissions rp where rp.role=m.role and rp.permission_key='care_requests.manage')
 order by 2;
$$;

create function ogevia_api.replace_care_alert_staff(p_organization_id uuid,p_user_ids uuid[])
returns void language plpgsql security definer set search_path=ogevia,pg_temp as $$
begin
 if not ogevia.has_permission(p_organization_id,'care_requests.manage') then raise exception 'Forbidden' using errcode='OGA03'; end if;
 delete from ogevia.care_request_alert_recipients where organization_id=p_organization_id;
 insert into ogevia.care_request_alert_recipients(organization_id,user_id)
 select p_organization_id,m.user_id from ogevia.organization_memberships m
 where m.organization_id=p_organization_id and m.status='active' and m.user_id=any(coalesce(p_user_ids,'{}'::uuid[]))
   and exists(select 1 from ogevia.role_permissions rp where rp.role=m.role and rp.permission_key='care_requests.manage');
end;$$;

create function ogevia_api.list_my_care_opportunities(p_organization_id uuid)
returns table(offer_id uuid,care_request_id uuid,status ogevia.care_offer_status,service_code text,service_name text,starts_at timestamptz,ends_at timestamptz,client_label text)
language sql stable security definer set search_path=ogevia,pg_temp as $$
 select o.id,r.id,o.status,s.code,s.name,r.starts_at,r.ends_at,coalesce(c.caregiver_display_code,c.client_code)
 from ogevia.caregiver_records cr join ogevia.care_request_offers o on o.caregiver_record_id=cr.id and o.organization_id=cr.organization_id
 join ogevia.care_requests r on r.id=o.care_request_id join ogevia.services s on s.id=r.service_id join ogevia.clients c on c.id=r.client_id
 where cr.organization_id=p_organization_id and cr.linked_user_id=ogevia.require_actor() and cr.deleted_at is null and ogevia.is_active_member(p_organization_id)
 order by r.starts_at;
$$;

create function ogevia_api.respond_my_care_opportunity(p_organization_id uuid,p_offer_id uuid,p_available boolean,p_note text default null)
returns ogevia.care_offer_status language plpgsql security definer set search_path=ogevia,pg_temp as $$
declare v_request uuid; v_status ogevia.care_offer_status;
begin
 select o.care_request_id into v_request from ogevia.care_request_offers o join ogevia.caregiver_records cr on cr.id=o.caregiver_record_id and cr.organization_id=o.organization_id
 where o.id=p_offer_id and o.organization_id=p_organization_id and cr.linked_user_id=ogevia.require_actor() for update of o;
 if v_request is null then raise exception 'Offer not found' using errcode='OGN04'; end if;
 v_status:=case when p_available then 'available'::ogevia.care_offer_status else 'not_available'::ogevia.care_offer_status end;
 update ogevia.care_request_offers set status=v_status,note=nullif(btrim(p_note),''),responded_at=now(),updated_at=now() where id=p_offer_id;
 if p_available then update ogevia.care_requests set status='accepted_pending_assignment',updated_at=now() where id=v_request and status='offering'; end if;
 insert into ogevia.care_notifications(organization_id,care_request_id,recipient_type,recipient_user_id,event_key)
 select p_organization_id,v_request,'staff',m.user_id,case when p_available then 'caregiver_available' else 'caregiver_unavailable' end
 from ogevia.organization_memberships m where m.organization_id=p_organization_id and m.status='active'
   and exists(select 1 from ogevia.role_permissions rp where rp.role=m.role and rp.permission_key='care_requests.manage');
 return v_status;
end;$$;

revoke all on function ogevia_api.list_care_request_offers(uuid,uuid) from public;
revoke all on function ogevia_api.list_client_portal_options(uuid) from public;
revoke all on function ogevia_api.list_care_alert_staff(uuid) from public;
revoke all on function ogevia_api.replace_care_alert_staff(uuid,uuid[]) from public;
revoke all on function ogevia_api.list_my_care_opportunities(uuid) from public;
revoke all on function ogevia_api.respond_my_care_opportunity(uuid,uuid,boolean,text) from public;
grant execute on function ogevia_api.list_care_request_offers(uuid,uuid) to ogevia_app;
grant execute on function ogevia_api.list_client_portal_options(uuid) to ogevia_app;
grant execute on function ogevia_api.list_care_alert_staff(uuid) to ogevia_app;
grant execute on function ogevia_api.replace_care_alert_staff(uuid,uuid[]) to ogevia_app;
grant execute on function ogevia_api.list_my_care_opportunities(uuid) to ogevia_app;
grant execute on function ogevia_api.respond_my_care_opportunity(uuid,uuid,boolean,text) to ogevia_app;
