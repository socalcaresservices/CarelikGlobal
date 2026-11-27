-- 0124 (PENDING: infra/aws/db/pending) | CLASS: ADDITIVE (new tables and functions only; no existing table, column, function or row is changed). Not applied to any database.
-- NFC / QR home-label visit verification, GPS location checks at punches, sign-now-or-later, signing sessions, exceptions and reports.
-- Brief: docs/releases/2026-11-23-nfc-qr-visits/ (owner brief "Ogevia NFC and QR visit verification", 2026-11-23). Renumbered from 0120 on integration with PR #124
-- Release switch: homeLabels (OFF everywhere). Rollback: pending/rollback/0124_nfc_qr_visit_verification.down.sql.
--
-- REUSES (nothing re-implemented): ogevia_api.start_ad_hoc_service_visit (authorization, readiness, shift matching, one open visit), ogevia_api.end_service_visit,
-- ogevia_api.confirm_service_visit (signature evidence, verified/billable minutes), ogevia_api.correct_service_visit and close_missed_service_visit (audited corrections),
-- 0036 visit_confirmation_requests / visit_late_confirmations (secure expiring single-use link, code by phone, revocation of replaced links), ogevia.write_audit, idempotency records.
-- Authority: every write below is a server-authorized, atomic function; the browser supplies a label token hash, an intent, a retry key and the phone location only.
--
-- CONSTRAINTS FOUND IN THE EXISTING SYSTEM (decisions in the release record):
--  * An unsigned visit in 'awaiting_signature' blocks the caregiver's next visit (0005 unique indexes). "Sign later" therefore uses the EXISTING unable_to_confirm path
--    (visit locks in administrator_review with 0 billable minutes) and this migration tracks the pending signature in visit_signature_followups. The visit row is untouched.
--  * Visit times are immutable; a time correction creates a NEW visit row and keeps the ORIGINAL confirmation (0083). When the change is material this migration reopens
--    "Signature pending" for the corrected row and keeps the original signed revision in the audit history.

-- ---------------------------------------------------------------------------
-- Settings (per agency; defaults apply when no row exists)
-- ---------------------------------------------------------------------------
create table ogevia.visit_verification_settings (
  organization_id uuid primary key references ogevia.organizations(id),
  early_checkout_minutes integer not null default 30 check (early_checkout_minutes between 5 and 240),
  overdue_grace_minutes integer not null default 30 check (overdue_grace_minutes between 5 and 720),
  material_time_change_minutes integer not null default 5 check (material_time_change_minutes between 1 and 120),
  signature_session_seconds integer not null default 600 check (signature_session_seconds between 60 and 3600),
  accuracy_limit_m integer not null default 100 check (accuracy_limit_m between 20 and 1000),
  hold_billing_while_signature_pending boolean not null default false,
  hold_billing_on_open_exceptions boolean not null default false,
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now()
);
alter table ogevia.visit_verification_settings enable row level security;
revoke all on ogevia.visit_verification_settings from public;

create function ogevia.vv_settings(p_organization_id uuid)
returns ogevia.visit_verification_settings
language sql stable security definer set search_path = ogevia, pg_temp as $$
  select coalesce(
    (select s from ogevia.visit_verification_settings s where s.organization_id = p_organization_id),
    row(p_organization_id, 30, 30, 5, 600, 100, false, false, null, now())::ogevia.visit_verification_settings);
$$;
revoke all on function ogevia.vv_settings(uuid) from public;

-- ---------------------------------------------------------------------------
-- Locations: a client's service address(es) and approved community places
-- ---------------------------------------------------------------------------
create table ogevia.client_service_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  kind text not null check (kind in ('home', 'community')),
  name text not null check (length(btrim(name)) between 2 and 80),
  street text not null check (length(btrim(street)) between 2 and 120),
  city text not null check (length(btrim(city)) between 2 and 80),
  state text not null default 'CA' check (state ~ '^[A-Z]{2}$'),
  zip text not null check (zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
  latitude numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude is null or longitude between -180 and 180),
  geo_status text not null default 'not_checked' check (geo_status in ('not_checked', 'located', 'approximate', 'not_found')),
  radius_m integer not null default 150 check (radius_m between 50 and 1000),
  is_active boolean not null default true,
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  unique (id, organization_id),
  check ((latitude is null) = (longitude is null))
);
create index client_service_locations_client_idx on ogevia.client_service_locations (organization_id, client_id) where is_active;
alter table ogevia.client_service_locations enable row level security;
revoke all on ogevia.client_service_locations from public;

-- Default expected places by service, and an authorized per-shift override.
create table ogevia.service_location_rules (
  organization_id uuid not null references ogevia.organizations(id),
  service_id uuid not null,
  expected_start text not null default 'home' check (expected_start in ('home', 'community')),
  expected_end text not null default 'home' check (expected_end in ('home', 'community')),
  allow_override boolean not null default false,
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  primary key (organization_id, service_id),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id)
);
alter table ogevia.service_location_rules enable row level security;
revoke all on ogevia.service_location_rules from public;

create table ogevia.shift_location_overrides (
  shift_id uuid primary key references ogevia.shifts(id),
  organization_id uuid not null references ogevia.organizations(id),
  expected_start text not null check (expected_start in ('home', 'community')),
  expected_end text not null check (expected_end in ('home', 'community')),
  reason text not null check (length(btrim(reason)) between 3 and 300),
  set_by uuid not null references ogevia.app_users(id),
  set_at timestamptz not null default now()
);
alter table ogevia.shift_location_overrides enable row level security;
revoke all on ogevia.shift_location_overrides from public;

-- ---------------------------------------------------------------------------
-- Home labels (NFC stickers / QR) and their history
-- ---------------------------------------------------------------------------
create table ogevia.home_labels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  label_code text not null unique check (label_code ~ '^OGL-[A-HJ-NP-Z2-9]{8}$'),     -- printed ID; no client data in it
  batch_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),             -- the opaque link; the token itself is never stored here
  sealed_token text,                                                                  -- AES-GCM sealed by the API (same key as the existing client QR card); null once the link is revoked
  status text not null default 'unassigned' check (status in ('unassigned', 'active', 'disabled', 'replaced')),
  service_location_id uuid,
  client_id uuid,
  installed_at timestamptz,
  installed_by uuid references ogevia.app_users(id),
  ended_at timestamptz,
  ended_by uuid references ogevia.app_users(id),
  replaced_by_label_id uuid references ogevia.home_labels(id),
  last_used_at timestamptz,
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  foreign key (service_location_id, organization_id) references ogevia.client_service_locations (id, organization_id),
  unique (id, organization_id),
  constraint home_labels_active_shape check (status <> 'active' or (service_location_id is not null and client_id is not null and installed_at is not null and sealed_token is not null)),
  constraint home_labels_unassigned_shape check (status <> 'unassigned' or (service_location_id is null and ended_at is null)),
  constraint home_labels_ended_link check (status in ('unassigned', 'active') or sealed_token is null)
);
-- One active label per client service location.
create unique index home_labels_one_active_per_location on ogevia.home_labels (service_location_id) where status = 'active';
create index home_labels_org_status_idx on ogevia.home_labels (organization_id, status, created_at desc);
alter table ogevia.home_labels enable row level security;
revoke all on ogevia.home_labels from public;

create function ogevia.vv_forbid_change()
returns trigger language plpgsql set search_path = ogevia, pg_temp as $$
begin
  raise exception '% rows are append-only', tg_table_name using errcode = 'OGC09';
end;
$$;
revoke all on function ogevia.vv_forbid_change() from public;

create table ogevia.home_label_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references ogevia.organizations(id),
  label_id uuid not null references ogevia.home_labels(id),
  action text not null check (action in ('registered', 'assigned', 'deactivated', 'replaced', 'reassigned', 'link_revoked', 'link_viewed')),
  actor_user_id uuid references ogevia.app_users(id),
  from_location_id uuid,
  to_location_id uuid,
  related_label_id uuid,
  reason text,
  occurred_at timestamptz not null default now()
);
create index home_label_events_label_idx on ogevia.home_label_events (label_id, occurred_at);
create trigger home_label_events_append_only before update or delete on ogevia.home_label_events for each row execute function ogevia.vv_forbid_change();
alter table ogevia.home_label_events enable row level security;
revoke all on ogevia.home_label_events from public;

-- ---------------------------------------------------------------------------
-- Punches (append-only attempts and saved clock-in / clock-out events)
-- ---------------------------------------------------------------------------
create table ogevia.visit_punches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_user_id uuid not null references ogevia.app_users(id),
  source text not null check (source in ('label', 'app')),
  intent text not null check (intent in ('arrival', 'departure')),
  outcome text not null check (outcome in ('saved', 'needs_choice', 'needs_confirmation', 'not_saved')),
  reason text,
  label_id uuid references ogevia.home_labels(id),
  client_id uuid,
  shift_id uuid references ogevia.shifts(id),
  visit_id uuid references ogevia.service_visits(id),
  expected_kind text check (expected_kind in ('home', 'community')),
  location_result text check (location_result in ('within_range', 'outside_range', 'unavailable', 'low_accuracy')),
  distance_m integer check (distance_m is null or distance_m >= 0),
  device_latitude numeric(9, 6),
  device_longitude numeric(9, 6),
  accuracy_m integer check (accuracy_m is null or accuracy_m >= 0),
  idempotency_key uuid not null,
  response jsonb not null,
  recorded_at timestamptz not null default now(),
  unique (caregiver_user_id, idempotency_key)
);
create index visit_punches_visit_idx on ogevia.visit_punches (visit_id) where visit_id is not null;
create index visit_punches_org_time_idx on ogevia.visit_punches (organization_id, recorded_at desc);
create trigger visit_punches_append_only before update or delete on ogevia.visit_punches for each row execute function ogevia.vv_forbid_change();
alter table ogevia.visit_punches enable row level security;
revoke all on ogevia.visit_punches from public;

-- ---------------------------------------------------------------------------
-- Exceptions and their append-only history
-- ---------------------------------------------------------------------------
create table ogevia.visit_exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  kind text not null check (kind in ('missing_punch', 'failed_punch', 'overdue_clock_out', 'location_issue', 'overlap', 'disputed_signature', 'correction_request')),
  status text not null default 'open' check (status in ('open', 'in_review', 'resolved', 'dismissed')),
  dedupe_key text not null,
  visit_id uuid references ogevia.service_visits(id),
  shift_id uuid references ogevia.shifts(id),
  caregiver_user_id uuid references ogevia.app_users(id),
  client_id uuid,
  punch_id uuid references ogevia.visit_punches(id) deferrable initially deferred,   -- the punch row is written after the exception inside the same transaction
  detail jsonb not null default '{}'::jsonb,           -- codes, ids and numbers only; no names, addresses or coordinates
  opened_at timestamptz not null default now(),
  reviewer_user_id uuid references ogevia.app_users(id),
  resolved_at timestamptz,
  resolution text,
  constraint visit_exceptions_resolved_shape check ((status in ('resolved', 'dismissed')) = (resolved_at is not null))
);
create unique index visit_exceptions_one_open on ogevia.visit_exceptions (organization_id, dedupe_key) where status in ('open', 'in_review');
create index visit_exceptions_org_status_idx on ogevia.visit_exceptions (organization_id, status, opened_at desc);
alter table ogevia.visit_exceptions enable row level security;
revoke all on ogevia.visit_exceptions from public;

create table ogevia.visit_exception_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references ogevia.organizations(id),
  exception_id uuid not null references ogevia.visit_exceptions(id),
  action text not null check (action in ('opened', 'reviewing', 'resolved', 'dismissed', 'note')),
  actor_user_id uuid references ogevia.app_users(id),
  note text,
  occurred_at timestamptz not null default now()
);
create index visit_exception_events_idx on ogevia.visit_exception_events (exception_id, occurred_at);
create trigger visit_exception_events_append_only before update or delete on ogevia.visit_exception_events for each row execute function ogevia.vv_forbid_change();
alter table ogevia.visit_exception_events enable row level security;
revoke all on ogevia.visit_exception_events from public;

-- ---------------------------------------------------------------------------
-- Signature follow-up (the "Signature pending" work item), history and signing sessions
-- ---------------------------------------------------------------------------
create table ogevia.visit_signature_followups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  state text not null default 'pending' check (state in ('pending', 'resolved', 'void')),
  reason_code text not null check (reason_code in ('signing_later', 'client_unavailable', 'declined', 'off_site_checkout', 'times_corrected', 'other')),
  direct_signing_required boolean not null default false,
  owner_user_id uuid references ogevia.app_users(id),
  opened_by uuid references ogevia.app_users(id),
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text check (resolution is null or resolution in ('signed', 'disputed', 'closed_not_billable', 'superseded')),
  constraint visit_signature_followups_resolved check ((state = 'pending') = (resolved_at is null))
);
create unique index visit_signature_followups_one_pending on ogevia.visit_signature_followups (visit_id) where state = 'pending';
create index visit_signature_followups_org_idx on ogevia.visit_signature_followups (organization_id, state, opened_at desc);
alter table ogevia.visit_signature_followups enable row level security;
revoke all on ogevia.visit_signature_followups from public;

create table ogevia.visit_signature_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  action text not null check (action in ('deferred', 'request_created', 'link_copied', 'email_queued', 'delivery_failed', 'link_revoked', 'signed_at_checkout', 'signed_late', 'declined', 'unavailable', 'reopened', 'owner_set', 'session_opened', 'session_rejected')),
  actor_user_id uuid references ogevia.app_users(id),
  request_id uuid,
  detail jsonb not null default '{}'::jsonb,           -- never a token, code, address or signature data
  occurred_at timestamptz not null default now()
);
create index visit_signature_events_visit_idx on ogevia.visit_signature_events (visit_id, occurred_at);
create trigger visit_signature_events_append_only before update or delete on ogevia.visit_signature_events for each row execute function ogevia.vv_forbid_change();
alter table ogevia.visit_signature_events enable row level security;
revoke all on ogevia.visit_signature_events from public;

-- A signing session lets ONE drawn signature be accepted: bound to the exact visit and time revision, short-lived, replaced by a newer one, consumed atomically.
create table ogevia.visit_signature_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  revision_hash text not null check (revision_hash ~ '^[0-9a-f]{64}$'),
  issued_to uuid not null references ogevia.app_users(id),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  replaced_at timestamptz,
  consumed_at timestamptz,
  check (expires_at > issued_at)
);
create unique index visit_signature_sessions_one_live on ogevia.visit_signature_sessions (visit_id) where consumed_at is null and replaced_at is null;
alter table ogevia.visit_signature_sessions enable row level security;
revoke all on ogevia.visit_signature_sessions from public;

-- ---------------------------------------------------------------------------
-- Missed-punch / time correction requests (the audited path; applying one uses the existing correction functions)
-- ---------------------------------------------------------------------------
create table ogevia.punch_correction_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  reason_code text not null check (reason_code in ('poor_connectivity', 'dead_phone', 'lost_tag', 'delayed_login', 'other')),
  reason_note text not null check (length(btrim(reason_note)) between 3 and 1000),
  original_time_in timestamptz not null,
  original_time_out timestamptz,
  requested_time_in timestamptz,
  requested_time_out timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid not null references ogevia.app_users(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references ogevia.app_users(id),
  decided_at timestamptz,
  decision_note text,
  resulting_visit_id uuid references ogevia.service_visits(id),
  needs_resigning boolean,
  location_decision text check (location_decision is null or location_decision in ('accepted', 'not_applicable', 'rejected')),
  constraint punch_correction_decided check ((status = 'pending') = (decided_at is null))
);
create unique index punch_correction_one_pending on ogevia.punch_correction_requests (visit_id) where status = 'pending';
create index punch_correction_org_idx on ogevia.punch_correction_requests (organization_id, requested_at desc);
alter table ogevia.punch_correction_requests enable row level security;
revoke all on ogevia.punch_correction_requests from public;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create function ogevia.vv_distance_m(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric)
returns integer language sql immutable set search_path = ogevia, pg_temp as $$
  select round(2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians((p_lat2 - p_lat1)::float8) / 2), 2)
    + cos(radians(p_lat1::float8)) * cos(radians(p_lat2::float8)) * power(sin(radians((p_lng2 - p_lng1)::float8) / 2), 2)))))::integer;
$$;
revoke all on function ogevia.vv_distance_m(numeric, numeric, numeric, numeric) from public;

-- The four results are kept apart: within range, outside range, unavailable (no phone fix or no located address) and low accuracy (fix worse than the agency limit).
create function ogevia.vv_location_result(p_org uuid, p_lat numeric, p_lng numeric, p_accuracy integer, p_location_id uuid)
returns table (result text, distance_m integer)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare
  v_loc ogevia.client_service_locations%rowtype;
  v_limit integer := (ogevia.vv_settings(p_org)).accuracy_limit_m;
  v_d integer;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return query select 'unavailable'::text, null::integer; return;
  end if;
  select * into v_loc from ogevia.client_service_locations l where l.id = p_location_id and l.organization_id = p_org;
  if v_loc.id is null or v_loc.latitude is null then
    return query select 'unavailable'::text, null::integer; return;
  end if;
  v_d := ogevia.vv_distance_m(p_lat, p_lng, v_loc.latitude, v_loc.longitude);
  if p_accuracy is null or p_accuracy > v_limit then
    return query select 'low_accuracy'::text, v_d; return;
  end if;
  return query select case when v_d <= v_loc.radius_m then 'within_range' else 'outside_range' end, v_d;
end;
$$;
revoke all on function ogevia.vv_location_result(uuid, numeric, numeric, integer, uuid) from public;

-- Expected start and end places for a shift (override, else the service rule, else home/home).
create function ogevia.vv_expected_kinds(p_org uuid, p_shift_id uuid, p_service_id uuid)
returns table (expected_start text, expected_end text)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  select coalesce(o.expected_start, r.expected_start, 'home'), coalesce(o.expected_end, r.expected_end, 'home')
  from (select 1) x
  left join ogevia.shift_location_overrides o on o.shift_id = p_shift_id and o.organization_id = p_org
  left join ogevia.service_location_rules r on r.service_id = p_service_id and r.organization_id = p_org;
$$;
revoke all on function ogevia.vv_expected_kinds(uuid, uuid, uuid) from public;

create function ogevia.vv_open_exception(p_org uuid, p_kind text, p_dedupe text, p_visit uuid, p_shift uuid, p_caregiver uuid, p_client uuid, p_punch uuid, p_detail jsonb)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_id uuid;
begin
  insert into ogevia.visit_exceptions (organization_id, kind, dedupe_key, visit_id, shift_id, caregiver_user_id, client_id, punch_id, detail)
  values (p_org, p_kind, p_dedupe, p_visit, p_shift, p_caregiver, p_client, p_punch, coalesce(p_detail, '{}'::jsonb))
  on conflict (organization_id, dedupe_key) where status in ('open', 'in_review') do nothing
  returning id into v_id;
  if v_id is not null then
    insert into ogevia.visit_exception_events (organization_id, exception_id, action, actor_user_id) values (p_org, v_id, 'opened', ogevia.current_user_id());
  end if;
  return v_id;
end;
$$;
revoke all on function ogevia.vv_open_exception(uuid, text, text, uuid, uuid, uuid, uuid, uuid, jsonb) from public;

create function ogevia.vv_sig_event(p_org uuid, p_visit uuid, p_action text, p_request uuid, p_detail jsonb)
returns void language sql security definer set search_path = ogevia, pg_temp as $$
  insert into ogevia.visit_signature_events (organization_id, visit_id, action, actor_user_id, request_id, detail)
  values (p_org, p_visit, p_action, ogevia.current_user_id(), p_request, coalesce(p_detail, '{}'::jsonb));
$$;
revoke all on function ogevia.vv_sig_event(uuid, uuid, text, uuid, jsonb) from public;

-- The revision a signature is bound to: the visit's own times and service (same snapshot the 0036 link uses).
create function ogevia.vv_revision_hash(p_visit_id uuid)
returns text language sql stable security definer set search_path = ogevia, pg_temp as $$
  select encode(sha256(convert_to(ogevia.visit_snapshot_for_confirmation(p_visit_id)::text, 'UTF8')), 'hex');
$$;
revoke all on function ogevia.vv_revision_hash(uuid) from public;


-- Starts the visit ON the chosen shift. Uses the shift-aware start from 0102 when it is installed (it honours a choice between two valid shifts); otherwise the baseline start
-- is used and the result is checked: if the baseline matched a different shift the start is rolled back by the caller and nothing is clocked.
create function ogevia.vv_start_for_shift(p_org uuid, p_client uuid, p_service uuid, p_key uuid, p_shift uuid)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_visit uuid;
begin
  if to_regprocedure('ogevia.start_service_visit(uuid,uuid,uuid,text[],text,uuid,text,uuid)') is not null then
    execute 'select ogevia.start_service_visit($1,$2,$3,''{}''::text[],null,$4,null,$5)' into v_visit using p_org, p_client, p_service, p_key, p_shift;
  else
    v_visit := ogevia_api.start_ad_hoc_service_visit(p_org, p_client, p_service, '{}', null, p_key, null);
    if not exists (select 1 from ogevia.service_visits v where v.id = v_visit and v.scheduled_shift_id = p_shift) then
      raise exception 'The visit could not be matched to the chosen scheduled visit' using errcode = 'OGC09';
    end if;
  end if;
  return v_visit;
end;
$$;
revoke all on function ogevia.vv_start_for_shift(uuid, uuid, uuid, uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- Locations and rules (staff)
-- ---------------------------------------------------------------------------
create function ogevia_api.save_service_location(
  p_organization_id uuid, p_client_id uuid, p_location_id uuid, p_kind text, p_name text,
  p_street text, p_city text, p_state text, p_zip text,
  p_latitude numeric default null, p_longitude numeric default null, p_geo_status text default null, p_radius_m integer default null)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_id uuid := p_location_id;
  v_state text := upper(coalesce(nullif(btrim(p_state), ''), 'CA'));
  v_geo text := coalesce(p_geo_status, case when p_latitude is not null then 'located' else 'not_checked' end);
begin
  if not (ogevia.has_permission(p_organization_id, 'clients.manage') and ogevia.has_permission(p_organization_id, 'clients.names.manage')) then
    raise exception 'You do not have permission to manage client locations' using errcode = 'OGA03';
  end if;
  perform 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null;
  if not found then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  if p_kind not in ('home', 'community') then raise exception 'Location type must be home or community' using errcode = 'OGV22'; end if;
  if length(btrim(coalesce(p_city, ''))) < 2 then raise exception 'City is required' using errcode = 'OGV22'; end if;
  if coalesce(p_zip, '') !~ '^[0-9]{5}(-[0-9]{4})?$' then raise exception 'A 5-digit ZIP code is required' using errcode = 'OGV22'; end if;
  if length(btrim(coalesce(p_street, ''))) < 2 then raise exception 'Street address is required' using errcode = 'OGV22'; end if;
  if (p_latitude is null) <> (p_longitude is null) then raise exception 'Give both latitude and longitude or neither' using errcode = 'OGV22'; end if;
  if v_geo = 'located' and p_latitude is null then v_geo := 'not_checked'; end if;
  if v_id is null then
    insert into ogevia.client_service_locations (organization_id, client_id, kind, name, street, city, state, zip, latitude, longitude, geo_status, radius_m, created_by)
    values (p_organization_id, p_client_id, p_kind, btrim(p_name), btrim(p_street), btrim(p_city), v_state, p_zip, p_latitude, p_longitude, v_geo, coalesce(p_radius_m, 150), v_actor)
    returning id into v_id;
    perform ogevia.write_audit(p_organization_id, 'service_location.created', 'client_service_locations', v_id, null,
      jsonb_build_object('client_id', p_client_id, 'kind', p_kind, 'geo_status', v_geo), null);
  else
    update ogevia.client_service_locations l set kind = p_kind, name = btrim(p_name), street = btrim(p_street), city = btrim(p_city), state = v_state, zip = p_zip,
      latitude = p_latitude, longitude = p_longitude, geo_status = v_geo, radius_m = coalesce(p_radius_m, l.radius_m), updated_at = now()
     where l.id = v_id and l.organization_id = p_organization_id and l.client_id = p_client_id;
    if not found then raise exception 'Location not found' using errcode = 'OGN04'; end if;
    perform ogevia.write_audit(p_organization_id, 'service_location.updated', 'client_service_locations', v_id, null,
      jsonb_build_object('client_id', p_client_id, 'kind', p_kind, 'geo_status', v_geo), null);
  end if;
  return v_id;
end;
$$;

-- Staff see the full address; an assigned caregiver sees the place, city and ZIP only (no street).
create function ogevia_api.list_service_locations(p_organization_id uuid, p_client_id uuid)
returns table (location_id uuid, kind text, name text, street text, city text, state text, zip text, geo_status text, needs_attention boolean, radius_m integer, is_active boolean,
               label_id uuid, label_code text, label_installed_at timestamptz)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare
  v_staff boolean;
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  v_staff := ogevia.has_permission(p_organization_id, 'clients.names.read') or ogevia.has_permission(p_organization_id, 'clients.manage') or ogevia.has_permission(p_organization_id, 'visits.manage');
  if not v_staff and not exists (
    select 1 from ogevia.shifts s where s.organization_id = p_organization_id and s.client_id = p_client_id and s.status = 'scheduled'
       and (s.caregiver_user_id = ogevia.current_user_id() or s.caregiver_record_id = ogevia.my_caregiver_record(p_organization_id))
  ) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;
  return query
  select l.id, l.kind, l.name, case when v_staff then l.street end, l.city, l.state, l.zip, l.geo_status, l.geo_status in ('not_checked', 'not_found', 'approximate') as needs_attention,
         l.radius_m, l.is_active, hl.id, case when v_staff then hl.label_code end, case when v_staff then hl.installed_at end
    from ogevia.client_service_locations l
    left join ogevia.home_labels hl on hl.service_location_id = l.id and hl.status = 'active'
   where l.organization_id = p_organization_id and l.client_id = p_client_id and l.is_active
   order by l.kind, l.created_at;
end;
$$;

create function ogevia_api.set_service_location_rule(p_organization_id uuid, p_service_id uuid, p_expected_start text, p_expected_end text, p_allow_override boolean)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'services.manage') then raise exception 'You do not have permission to change service settings' using errcode = 'OGA03'; end if;
  perform 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id;
  if not found then raise exception 'Service not found' using errcode = 'OGN04'; end if;
  if p_expected_start not in ('home', 'community') or p_expected_end not in ('home', 'community') then raise exception 'Expected places must be home or community' using errcode = 'OGV22'; end if;
  insert into ogevia.service_location_rules (organization_id, service_id, expected_start, expected_end, allow_override, updated_by)
  values (p_organization_id, p_service_id, p_expected_start, p_expected_end, coalesce(p_allow_override, false), ogevia.current_user_id())
  on conflict (organization_id, service_id) do update set expected_start = excluded.expected_start, expected_end = excluded.expected_end,
    allow_override = excluded.allow_override, updated_by = excluded.updated_by, updated_at = now();
  perform ogevia.write_audit(p_organization_id, 'service_location_rule.set', 'services', p_service_id, null,
    jsonb_build_object('expected_start', p_expected_start, 'expected_end', p_expected_end, 'allow_override', coalesce(p_allow_override, false)), null);
end;
$$;

create function ogevia_api.set_shift_location_override(p_organization_id uuid, p_shift_id uuid, p_expected_start text, p_expected_end text, p_reason text)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_shift ogevia.shifts%rowtype;
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'shifts.manage') then raise exception 'You do not have permission to change a scheduled visit' using errcode = 'OGA03'; end if;
  select * into v_shift from ogevia.shifts s where s.id = p_shift_id and s.organization_id = p_organization_id for update;
  if v_shift.id is null then raise exception 'Scheduled visit not found' using errcode = 'OGN04'; end if;
  if p_expected_start not in ('home', 'community') or p_expected_end not in ('home', 'community') then raise exception 'Expected places must be home or community' using errcode = 'OGV22'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'A reason is required' using errcode = 'OGV22'; end if;
  if not exists (select 1 from ogevia.service_location_rules r where r.organization_id = p_organization_id and r.service_id = v_shift.service_id and r.allow_override) then
    raise exception 'This service does not allow a per-visit change of expected places' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = p_shift_id and v.status not in ('voided', 'corrected')) then
    raise exception 'The visit has already started; the expected places cannot change' using errcode = 'OGC09';
  end if;
  insert into ogevia.shift_location_overrides (shift_id, organization_id, expected_start, expected_end, reason, set_by)
  values (p_shift_id, p_organization_id, p_expected_start, p_expected_end, btrim(p_reason), ogevia.current_user_id())
  on conflict (shift_id) do update set expected_start = excluded.expected_start, expected_end = excluded.expected_end, reason = excluded.reason, set_by = excluded.set_by, set_at = now();
  perform ogevia.write_audit(p_organization_id, 'shift_location_override.set', 'shifts', p_shift_id, null,
    jsonb_build_object('expected_start', p_expected_start, 'expected_end', p_expected_end), btrim(p_reason));
end;
$$;

-- What a caregiver (or staff) sees before the visit: both expected places, city and ZIP, and the clock-in / clock-out method.
create function ogevia_api.get_expected_locations(p_organization_id uuid, p_shift_id uuid)
returns table (expected_start text, expected_end text, clock_in_method text, clock_out_method text, start_city text, start_zip text, start_location_name text, start_needs_attention boolean,
               end_city text, end_zip text, end_location_name text, end_needs_attention boolean, overridden boolean)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare
  v_shift ogevia.shifts%rowtype;
  v_k record;
  v_home ogevia.client_service_locations%rowtype;
  v_comm ogevia.client_service_locations%rowtype;
  v_start ogevia.client_service_locations%rowtype;
  v_end ogevia.client_service_locations%rowtype;
begin
  perform ogevia.require_actor();
  select * into v_shift from ogevia.shifts s where s.id = p_shift_id and s.organization_id = p_organization_id;
  -- Null-safe: an open shift has no caregiver, and "null = x" must read as "no", never as "allowed".
  if v_shift.id is null or not ogevia.is_active_member(p_organization_id)
     or not (ogevia.has_permission(p_organization_id, 'visits.read') or ogevia.has_permission(p_organization_id, 'shifts.manage')
             or coalesce(v_shift.caregiver_user_id = ogevia.current_user_id(), false) or coalesce(v_shift.caregiver_record_id = ogevia.my_caregiver_record(p_organization_id), false)) then
    raise exception 'Scheduled visit not found' using errcode = 'OGN04';
  end if;
  select * into v_k from ogevia.vv_expected_kinds(p_organization_id, p_shift_id, v_shift.service_id);
  select * into v_home from ogevia.client_service_locations l where l.organization_id = p_organization_id and l.client_id = v_shift.client_id and l.kind = 'home' and l.is_active order by l.created_at limit 1;
  select * into v_comm from ogevia.client_service_locations l where l.organization_id = p_organization_id and l.client_id = v_shift.client_id and l.kind = 'community' and l.is_active order by l.created_at limit 1;
  v_start := case when v_k.expected_start = 'home' then v_home else v_comm end;
  v_end := case when v_k.expected_end = 'home' then v_home else v_comm end;
  return query select v_k.expected_start, v_k.expected_end,
    case when v_k.expected_start = 'home' then 'NFC or QR' else 'Assigned visit screen' end,
    case when v_k.expected_end = 'home' then 'NFC or QR, then signature' else 'Active visit screen, then signature' end,
    v_start.city, v_start.zip, v_start.name, coalesce(v_start.geo_status, 'not_checked') in ('not_checked', 'not_found', 'approximate') and v_start.id is not null or v_start.id is null,
    v_end.city, v_end.zip, v_end.name, coalesce(v_end.geo_status, 'not_checked') in ('not_checked', 'not_found', 'approximate') and v_end.id is not null or v_end.id is null,
    exists (select 1 from ogevia.shift_location_overrides o where o.shift_id = p_shift_id);
end;
$$;

create function ogevia_api.save_verification_settings(p_organization_id uuid, p_early_checkout_minutes integer, p_overdue_grace_minutes integer, p_material_time_change_minutes integer,
  p_signature_session_seconds integer, p_accuracy_limit_m integer, p_hold_signature boolean, p_hold_exceptions boolean)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'You do not have permission to change these settings' using errcode = 'OGA03'; end if;
  insert into ogevia.visit_verification_settings as s (organization_id, early_checkout_minutes, overdue_grace_minutes, material_time_change_minutes, signature_session_seconds, accuracy_limit_m,
    hold_billing_while_signature_pending, hold_billing_on_open_exceptions, updated_by)
  values (p_organization_id, p_early_checkout_minutes, p_overdue_grace_minutes, p_material_time_change_minutes, p_signature_session_seconds, p_accuracy_limit_m,
    coalesce(p_hold_signature, false), coalesce(p_hold_exceptions, false), ogevia.current_user_id())
  on conflict (organization_id) do update set early_checkout_minutes = excluded.early_checkout_minutes, overdue_grace_minutes = excluded.overdue_grace_minutes,
    material_time_change_minutes = excluded.material_time_change_minutes, signature_session_seconds = excluded.signature_session_seconds, accuracy_limit_m = excluded.accuracy_limit_m,
    hold_billing_while_signature_pending = excluded.hold_billing_while_signature_pending, hold_billing_on_open_exceptions = excluded.hold_billing_on_open_exceptions,
    updated_by = excluded.updated_by, updated_at = now();
  perform ogevia.write_audit(p_organization_id, 'visit_verification_settings.saved', 'organizations', p_organization_id, null,
    jsonb_build_object('early_checkout_minutes', p_early_checkout_minutes, 'accuracy_limit_m', p_accuracy_limit_m, 'hold_signature', coalesce(p_hold_signature, false), 'hold_exceptions', coalesce(p_hold_exceptions, false)), null);
end;
$$;

create function ogevia_api.get_verification_settings(p_organization_id uuid)
returns table (early_checkout_minutes integer, overdue_grace_minutes integer, material_time_change_minutes integer, signature_session_seconds integer, accuracy_limit_m integer,
               hold_billing_while_signature_pending boolean, hold_billing_on_open_exceptions boolean)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) or not (ogevia.has_permission(p_organization_id, 'visits.read') or ogevia.has_permission(p_organization_id, 'organization.update')) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  return query select s.early_checkout_minutes, s.overdue_grace_minutes, s.material_time_change_minutes, s.signature_session_seconds, s.accuracy_limit_m,
    s.hold_billing_while_signature_pending, s.hold_billing_on_open_exceptions from ogevia.vv_settings(p_organization_id) s;
end;
$$;

-- ---------------------------------------------------------------------------
-- Home label administration
-- ---------------------------------------------------------------------------
-- The API generates codes and tokens (it holds the sealing key); the database validates and stores only hashes and sealed copies.
create function ogevia_api.register_home_labels(p_organization_id uuid, p_labels jsonb)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_batch uuid := gen_random_uuid();
  v_item jsonb;
  v_id uuid;
begin
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then raise exception 'You do not have permission to register labels' using errcode = 'OGA03'; end if;
  if jsonb_typeof(p_labels) <> 'array' or jsonb_array_length(p_labels) not between 1 and 500 then raise exception 'Register between 1 and 500 labels at a time' using errcode = 'OGV22'; end if;
  for v_item in select * from jsonb_array_elements(p_labels) loop
    insert into ogevia.home_labels (organization_id, label_code, batch_id, token_hash, sealed_token, created_by)
    values (p_organization_id, v_item ->> 'code', v_batch, v_item ->> 'hash', v_item ->> 'sealed', v_actor)
    returning id into v_id;
    insert into ogevia.home_label_events (organization_id, label_id, action, actor_user_id) values (p_organization_id, v_id, 'registered', v_actor);
  end loop;
  perform ogevia.write_audit(p_organization_id, 'home_labels.registered', 'home_labels', v_batch, null, jsonb_build_object('count', jsonb_array_length(p_labels)), null);
  return v_batch;
end;
$$;

-- Tap, scan or type the sticker ID, choose the client service location. A label is found only inside the caller's own agency; anything else reads as "not found".
create function ogevia_api.assign_home_label(p_organization_id uuid, p_label_code text, p_service_location_id uuid, p_confirmed_address boolean, p_reassign boolean default false)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_label ogevia.home_labels%rowtype;
  v_loc ogevia.client_service_locations%rowtype;
  v_from uuid;
begin
  if not (ogevia.has_permission(p_organization_id, 'clients.manage') and ogevia.has_permission(p_organization_id, 'clients.names.manage')) then
    raise exception 'You do not have permission to assign labels' using errcode = 'OGA03';
  end if;
  if not coalesce(p_confirmed_address, false) then raise exception 'Confirm the address on file before assigning the label' using errcode = 'OGV22'; end if;
  select * into v_label from ogevia.home_labels h where upper(h.label_code) = upper(btrim(p_label_code)) and h.organization_id = p_organization_id for update;
  if v_label.id is null then raise exception 'Label not found for your agency' using errcode = 'OGN04'; end if;
  select * into v_loc from ogevia.client_service_locations l where l.id = p_service_location_id and l.organization_id = p_organization_id and l.is_active and l.kind = 'home';
  if v_loc.id is null then raise exception 'Service location not found' using errcode = 'OGN04'; end if;
  if v_label.status = 'active' then
    if v_label.service_location_id = p_service_location_id then return v_label.id; end if;      -- same assignment again: nothing to do
    if not coalesce(p_reassign, false) then raise exception 'This label is already active at another location. Choose reassign to move it.' using errcode = 'OGC09'; end if;
  elsif v_label.status <> 'unassigned' then
    raise exception 'This label is % and cannot be used again', v_label.status using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.home_labels h where h.service_location_id = p_service_location_id and h.status = 'active' and h.id <> v_label.id) then
    raise exception 'This location already has an active label. Replace it instead.' using errcode = 'OGC09';
  end if;
  v_from := v_label.service_location_id;
  update ogevia.home_labels h set status = 'active', service_location_id = p_service_location_id, client_id = v_loc.client_id, installed_at = now(), installed_by = v_actor, ended_at = null, ended_by = null
   where h.id = v_label.id;
  insert into ogevia.home_label_events (organization_id, label_id, action, actor_user_id, from_location_id, to_location_id)
  values (p_organization_id, v_label.id, case when v_from is null then 'assigned' else 'reassigned' end, v_actor, v_from, p_service_location_id);
  perform ogevia.write_audit(p_organization_id, case when v_from is null then 'home_label.assigned' else 'home_label.reassigned' end, 'home_labels', v_label.id, null,
    jsonb_build_object('service_location_id', p_service_location_id, 'client_id', v_loc.client_id), null);
  return v_label.id;
end;
$$;

create function ogevia_api.deactivate_home_label(p_organization_id uuid, p_label_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); v_label ogevia.home_labels%rowtype;
begin
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then raise exception 'You do not have permission to change labels' using errcode = 'OGA03'; end if;
  select * into v_label from ogevia.home_labels h where h.id = p_label_id and h.organization_id = p_organization_id for update;
  if v_label.id is null then raise exception 'Label not found' using errcode = 'OGN04'; end if;
  if v_label.status not in ('active', 'unassigned') then raise exception 'This label is already ended' using errcode = 'OGC09'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'A reason is required' using errcode = 'OGV22'; end if;
  -- The link is revoked: its sealed copy is discarded and the hash can no longer start or end a visit. The assignment history stays.
  update ogevia.home_labels h set status = 'disabled', sealed_token = null, ended_at = now(), ended_by = v_actor where h.id = v_label.id;
  insert into ogevia.home_label_events (organization_id, label_id, action, actor_user_id, from_location_id, reason)
  values (p_organization_id, v_label.id, 'deactivated', v_actor, v_label.service_location_id, btrim(p_reason)),
         (p_organization_id, v_label.id, 'link_revoked', v_actor, null, null);
  perform ogevia.write_audit(p_organization_id, 'home_label.deactivated', 'home_labels', v_label.id, null, jsonb_build_object('service_location_id', v_label.service_location_id), btrim(p_reason));
end;
$$;

-- Replacement: the NEW sticker takes the location; the old link is revoked at the same moment (one transaction), the history keeps both.
create function ogevia_api.replace_home_label(p_organization_id uuid, p_old_label_id uuid, p_new_label_code text, p_reason text)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_old ogevia.home_labels%rowtype;
  v_new ogevia.home_labels%rowtype;
  v_loc ogevia.client_service_locations%rowtype;
begin
  if not (ogevia.has_permission(p_organization_id, 'clients.manage') and ogevia.has_permission(p_organization_id, 'clients.names.manage')) then
    raise exception 'You do not have permission to replace labels' using errcode = 'OGA03';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'A reason is required' using errcode = 'OGV22'; end if;
  select * into v_old from ogevia.home_labels h where h.id = p_old_label_id and h.organization_id = p_organization_id for update;
  if v_old.id is null then raise exception 'Label not found' using errcode = 'OGN04'; end if;
  if v_old.status <> 'active' then raise exception 'Only an active label can be replaced' using errcode = 'OGC09'; end if;
  select * into v_new from ogevia.home_labels h where upper(h.label_code) = upper(btrim(p_new_label_code)) and h.organization_id = p_organization_id for update;
  if v_new.id is null then raise exception 'Label not found for your agency' using errcode = 'OGN04'; end if;
  if v_new.status <> 'unassigned' then raise exception 'The new label is not unassigned' using errcode = 'OGC09'; end if;
  select * into v_loc from ogevia.client_service_locations l where l.id = v_old.service_location_id;
  update ogevia.home_labels h set status = 'replaced', sealed_token = null, ended_at = now(), ended_by = v_actor, replaced_by_label_id = v_new.id where h.id = v_old.id;
  update ogevia.home_labels h set status = 'active', service_location_id = v_old.service_location_id, client_id = v_old.client_id, installed_at = now(), installed_by = v_actor where h.id = v_new.id;
  insert into ogevia.home_label_events (organization_id, label_id, action, actor_user_id, from_location_id, to_location_id, related_label_id, reason)
  values (p_organization_id, v_old.id, 'replaced', v_actor, v_old.service_location_id, null, v_new.id, btrim(p_reason)),
         (p_organization_id, v_old.id, 'link_revoked', v_actor, null, null, null, null),
         (p_organization_id, v_new.id, 'assigned', v_actor, null, v_old.service_location_id, v_old.id, btrim(p_reason));
  perform ogevia.write_audit(p_organization_id, 'home_label.replaced', 'home_labels', v_new.id, null,
    jsonb_build_object('old_label_id', v_old.id, 'service_location_id', v_old.service_location_id), btrim(p_reason));
  return v_new.id;
end;
$$;

-- Preview, print and "copy link for tag programming": returns the sealed link for an ACTIVE or UNASSIGNED label only; every view is logged.
create function ogevia_api.get_home_label_link(p_organization_id uuid, p_label_id uuid)
returns text language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_label ogevia.home_labels%rowtype;
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then raise exception 'You do not have permission to see labels' using errcode = 'OGA03'; end if;
  select * into v_label from ogevia.home_labels h where h.id = p_label_id and h.organization_id = p_organization_id;
  if v_label.id is null or v_label.sealed_token is null then raise exception 'This label link is no longer available' using errcode = 'OGN04'; end if;
  insert into ogevia.home_label_events (organization_id, label_id, action, actor_user_id) values (p_organization_id, v_label.id, 'link_viewed', ogevia.current_user_id());
  return v_label.sealed_token;
end;
$$;

-- Inventory (also the "Home label inventory" report). Client names never appear; the location is named by the client's Ogevia code.
create function ogevia_api.list_home_labels(p_organization_id uuid, p_status text default null, p_client_id uuid default null, p_limit integer default 200)
returns table (label_id uuid, label_code text, status text, batch_id uuid, client_code text, location_name text, location_city text, installed_at timestamptz, ended_at timestamptz,
               replaced_by_code text, last_used_at timestamptz, created_at timestamptz, location_needs_attention boolean)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not (ogevia.has_permission(p_organization_id, 'clients.manage') or ogevia.has_permission(p_organization_id, 'visits.read')) then
    raise exception 'You do not have permission to see labels' using errcode = 'OGA03';
  end if;
  if p_status is not null and p_status not in ('unassigned', 'active', 'disabled', 'replaced') then raise exception 'Unknown status' using errcode = 'OGV22'; end if;
  return query
  select h.id, h.label_code, h.status, h.batch_id, c.client_code, l.name, l.city, h.installed_at, h.ended_at, r.label_code, h.last_used_at, h.created_at,
         l.id is not null and l.geo_status in ('not_checked', 'not_found', 'approximate')
    from ogevia.home_labels h
    left join ogevia.client_service_locations l on l.id = h.service_location_id
    left join ogevia.clients c on c.id = h.client_id
    left join ogevia.home_labels r on r.id = h.replaced_by_label_id
   where h.organization_id = p_organization_id and (p_status is null or h.status = p_status) and (p_client_id is null or h.client_id = p_client_id)
   order by h.created_at desc, h.label_code
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
end;
$$;

create function ogevia_api.list_home_label_history(p_organization_id uuid, p_label_id uuid)
returns table (occurred_at timestamptz, action text, actor_name text, reason text)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then raise exception 'You do not have permission to see labels' using errcode = 'OGA03'; end if;
  return query select e.occurred_at, e.action, u.display_name, e.reason from ogevia.home_label_events e left join ogevia.app_users u on u.id = e.actor_user_id
   where e.organization_id = p_organization_id and e.label_id = p_label_id and e.action <> 'link_viewed' order by e.occurred_at, e.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Punch preview (READ ONLY: opening the link or scanning never writes) and punch (the only writer)
-- ---------------------------------------------------------------------------
create function ogevia_api.preview_home_label(p_label_hash text)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_label ogevia.home_labels%rowtype;
  v_open ogevia.service_visits%rowtype;
  v_record uuid;
  v_shifts jsonb;
  v_n integer;
  v_code text;
  v_loc ogevia.client_service_locations%rowtype;
begin
  select * into v_label from ogevia.home_labels h where h.token_hash = p_label_hash;
  if v_label.id is null or v_label.status <> 'active' or not ogevia.is_active_caregiver(v_label.organization_id) then
    return jsonb_build_object('state', 'unavailable');
  end if;
  v_record := ogevia.my_caregiver_record(v_label.organization_id);
  select coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code) into v_code from ogevia.clients c where c.id = v_label.client_id;
  select * into v_loc from ogevia.client_service_locations l where l.id = v_label.service_location_id;
  select * into v_open from ogevia.service_visits v where v.caregiver_user_id = v_actor and v.status in ('draft', 'awaiting_signature') limit 1;
  if v_open.id is not null then
    if v_open.client_id = v_label.client_id and v_open.status = 'draft' then
      return jsonb_build_object('state', 'ready', 'action', 'departure', 'organizationId', v_label.organization_id, 'clientCode', v_code, 'city', v_loc.city,
        'visit', jsonb_build_object('id', v_open.id, 'timeIn', v_open.time_in));
    end if;
    return jsonb_build_object('state', 'blocked', 'reason', case when v_open.client_id = v_label.client_id then 'previous_visit_not_finished' else 'open_visit_elsewhere' end,
      'organizationId', v_label.organization_id, 'clientCode', v_code);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'startsAt', s.starts_at, 'endsAt', s.ends_at) order by s.starts_at), '[]'::jsonb), count(*) into v_shifts, v_n
    from ogevia.shifts s
   where s.organization_id = v_label.organization_id and s.client_id = v_label.client_id and s.status = 'scheduled' and s.service_id is not null
     and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record)
     and now() >= s.starts_at - ogevia.visit_shift_early_arrival() and now() < s.ends_at
     and not ogevia.shift_is_called_out(s.id)
     and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected'))
     and (select expected_start from ogevia.vv_expected_kinds(s.organization_id, s.id, s.service_id)) = 'home';
  if v_n = 0 then
    return jsonb_build_object('state', 'ready', 'action', 'none', 'reason',
      case when exists (select 1 from ogevia.shifts s where s.organization_id = v_label.organization_id and s.client_id = v_label.client_id and s.status = 'scheduled' and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record) and s.ends_at > now() - interval '12 hours')
           then 'no_visit_in_window' else 'not_assigned' end,
      'organizationId', v_label.organization_id, 'clientCode', v_code);
  end if;
  return jsonb_build_object('state', 'ready', 'action', case when v_n = 1 then 'arrival' else 'choose' end, 'organizationId', v_label.organization_id, 'clientCode', v_code, 'city', v_loc.city, 'shifts', v_shifts);
end;
$$;

create function ogevia_api.record_punch(
  p_label_hash text, p_organization_id uuid, p_intent text, p_shift_id uuid, p_visit_id uuid,
  p_latitude numeric, p_longitude numeric, p_accuracy_m integer, p_idempotency_key uuid, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_prior jsonb;
  v_label ogevia.home_labels%rowtype;
  v_org uuid;
  v_source text := case when p_label_hash is null then 'app' else 'label' end;
  v_record uuid;
  v_open ogevia.service_visits%rowtype;
  v_shift ogevia.shifts%rowtype;
  v_cands uuid[];
  v_kinds record;
  v_loc_id uuid;
  v_loc record;
  v_visit uuid;
  v_client uuid;
  v_outcome text := 'not_saved';
  v_reason text;
  v_message text;
  v_resp jsonb;
  v_punch uuid := gen_random_uuid();
  v_time_out timestamptz;
  v_signing text;
  v_settings ogevia.visit_verification_settings;
  v_choices jsonb := '[]'::jsonb;
  v_expected text;
  v_row_shift uuid;
  v_want text := case when p_label_hash is null then 'community' else 'home' end;
begin
  if p_idempotency_key is null then raise exception 'A retry key is required' using errcode = 'OGV22'; end if;
  if p_intent not in ('arrival', 'departure') then raise exception 'Intent must be arrival or departure' using errcode = 'OGV22'; end if;
  if p_latitude is not null and (p_latitude not between -90 and 90) or p_longitude is not null and (p_longitude not between -180 and 180) then
    raise exception 'The phone location is not valid' using errcode = 'OGV22';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ogevia.punch:' || v_actor::text, 0));
  -- A retry, reload or second tap with the SAME key returns the first answer; it never writes a second punch.
  select p.response into v_prior from ogevia.visit_punches p where p.caregiver_user_id = v_actor and p.idempotency_key = p_idempotency_key;
  if v_prior is not null then return v_prior || jsonb_build_object('replayed', true); end if;

  if v_source = 'label' then
    select * into v_label from ogevia.home_labels h where h.token_hash = p_label_hash for update;
    if v_label.id is null or not ogevia.is_active_caregiver(v_label.organization_id) then
      return jsonb_build_object('outcome', 'not_saved', 'reason', 'label_unavailable', 'message', 'This label cannot be used. Ask the office.');   -- nothing recorded: no agency to attach it to
    end if;
    v_org := v_label.organization_id;
    if p_organization_id is not null and p_organization_id <> v_org then
      return jsonb_build_object('outcome', 'not_saved', 'reason', 'label_unavailable', 'message', 'This label cannot be used. Ask the office.');
    end if;
    v_client := v_label.client_id;
    v_loc_id := v_label.service_location_id;
  else
    v_org := p_organization_id;
    if v_org is null or not ogevia.is_active_caregiver(v_org) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  end if;
  v_settings := ogevia.vv_settings(v_org);
  v_record := ogevia.my_caregiver_record(v_org);

  if v_source = 'label' and v_label.status <> 'active' then
    v_reason := 'label_revoked'; v_message := 'This label was replaced or turned off. Ask the office.';
  elsif p_intent = 'arrival' then
    select * into v_open from ogevia.service_visits v where v.caregiver_user_id = v_actor and v.status in ('draft', 'awaiting_signature') limit 1;
    if v_open.id is not null then
      -- An arrival NEVER becomes a checkout. The caregiver is told, and the departure is a separate, explicit action.
      v_reason := case when v_open.client_id = v_client and v_open.status = 'draft' then 'already_clocked_in'
                       when v_open.status = 'awaiting_signature' then 'previous_visit_not_finished' else 'open_visit_elsewhere' end;
      v_visit := v_open.id;
      v_message := case v_reason when 'already_clocked_in' then 'You are already clocked in here.' when 'previous_visit_not_finished' then 'Finish the signature on your last visit first.' else 'You have another visit open. Finish it first.' end;
      if v_reason = 'open_visit_elsewhere' then
        perform ogevia.vv_open_exception(v_org, 'overlap', 'overlap:' || v_open.id::text, v_open.id, null, v_actor, v_client, null, jsonb_build_object('attempt', 'arrival'));
      end if;
    else
      select coalesce(array_agg(s.id order by s.starts_at), '{}') into v_cands
        from ogevia.shifts s
       where s.organization_id = v_org and s.status = 'scheduled' and s.service_id is not null
         and (v_client is null or s.client_id = v_client)
         and (p_shift_id is null or s.id = p_shift_id)
         and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record)
         and now() >= s.starts_at - ogevia.visit_shift_early_arrival() and now() < s.ends_at
         and not ogevia.shift_is_called_out(s.id)
         and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected'))
         and (select expected_start from ogevia.vv_expected_kinds(s.organization_id, s.id, s.service_id)) = case when v_source = 'label' then 'home' else 'community' end;
      -- the client of an app clock-in comes from the caregiver's OWN shift only; a shift that is not hers names nothing
      if p_shift_id is not null and v_source = 'app' then v_client := (select s.client_id from ogevia.shifts s where s.id = p_shift_id and s.organization_id = v_org and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record)); end if;
      if coalesce(array_length(v_cands, 1), 0) = 0 then
        v_reason := case
          when exists (select 1 from ogevia.shifts s where s.organization_id = v_org and (v_client is null or s.client_id = v_client) and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record) and s.status = 'scheduled'
                          and now() >= s.starts_at - ogevia.visit_shift_early_arrival() and now() < s.ends_at
                          and (select expected_start from ogevia.vv_expected_kinds(s.organization_id, s.id, s.service_id)) <> case when v_source = 'label' then 'home' else 'community' end)
            then 'wrong_clock_in_method'
          when exists (select 1 from ogevia.shifts s where s.organization_id = v_org and (v_client is null or s.client_id = v_client) and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record) and s.status = 'scheduled' and s.ends_at > now() - interval '12 hours')
            then 'no_visit_in_window'
          when exists (select 1 from ogevia.shifts s where s.organization_id = v_org and (v_client is null or s.client_id = v_client) and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record) and s.status <> 'scheduled' and s.ends_at > now() - interval '12 hours')
            then 'visit_cancelled'
          else 'not_assigned' end;
        v_message := case v_reason when 'wrong_clock_in_method' then 'This visit starts another way. Use the method shown on your schedule.' when 'no_visit_in_window' then 'No visit is scheduled for you at this time. Nothing was clocked.'
                      when 'visit_cancelled' then 'This visit was cancelled or reassigned. Nothing was clocked.' else 'You are not assigned to this client. Nothing was clocked.' end;
        if v_reason in ('no_visit_in_window', 'visit_cancelled') then
          perform ogevia.vv_open_exception(v_org, 'failed_punch', 'failed:' || v_actor::text || ':' || coalesce(v_client::text, '-') || ':' || to_char(now(), 'YYYYMMDDHH24'), null, null, v_actor, v_client, null, jsonb_build_object('reason', v_reason, 'intent', 'arrival'));
        end if;
      elsif array_length(v_cands, 1) > 1 and p_shift_id is null then
        v_outcome := 'needs_choice'; v_reason := 'choose_visit'; v_message := 'Choose which visit you are starting.';
        select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'startsAt', s.starts_at, 'endsAt', s.ends_at) order by s.starts_at), '[]'::jsonb) into v_choices from ogevia.shifts s where s.id = any (v_cands);
      else
        select * into v_shift from ogevia.shifts s where s.id = v_cands[1];
        v_client := v_shift.client_id;
        begin
          v_visit := ogevia.vv_start_for_shift(v_org, v_shift.client_id, v_shift.service_id, p_idempotency_key, v_shift.id);
          v_outcome := 'saved';
        exception when others then
          v_visit := null; v_outcome := 'not_saved'; v_reason := 'start_refused'; v_message := sqlerrm;
          perform ogevia.vv_open_exception(v_org, 'failed_punch', 'failed:' || v_actor::text || ':' || v_shift.id::text, null, v_shift.id, v_actor, v_shift.client_id, null, jsonb_build_object('reason', 'start_refused', 'intent', 'arrival'));
        end;
      end if;
    end if;
    v_expected := case when v_source = 'label' then 'home' else 'community' end;
  else
    -- departure: the caregiver's own running visit; it must be the one at this label.
    select * into v_open from ogevia.service_visits v
     where v.caregiver_user_id = v_actor and v.organization_id = v_org and v.status = 'draft' and (p_visit_id is null or v.id = p_visit_id) limit 1 for update;
    if v_open.id is null then
      v_reason := 'no_active_visit'; v_message := 'You have no running visit to end.';
      perform ogevia.vv_open_exception(v_org, 'failed_punch', 'failed:' || v_actor::text || ':nodep:' || to_char(now(), 'YYYYMMDDHH24'), null, null, v_actor, v_client, null, jsonb_build_object('reason', v_reason, 'intent', 'departure'));
    elsif v_source = 'label' and v_open.client_id <> v_client then
      v_reason := 'wrong_home'; v_message := 'This is not the home of your running visit. Nothing was saved.'; v_visit := v_open.id;
      perform ogevia.vv_open_exception(v_org, 'failed_punch', 'failed:' || v_open.id::text || ':wronghome', v_open.id, v_open.scheduled_shift_id, v_actor, v_open.client_id, null, jsonb_build_object('reason', v_reason, 'intent', 'departure'));
    else
      v_client := v_open.client_id; v_visit := v_open.id;
      select * into v_shift from ogevia.shifts s where s.id = v_open.scheduled_shift_id;
      select * into v_kinds from ogevia.vv_expected_kinds(v_org, v_open.scheduled_shift_id, v_open.service_id);
      v_expected := v_kinds.expected_end;
      if v_expected <> v_want then
        v_reason := 'wrong_clock_out_method'; v_message := 'This visit ends another way. Use the method shown on your visit.';
      elsif v_open.time_in > now() - interval '1 minute' then
        v_reason := 'too_soon'; v_message := 'The visit started less than a minute ago. Nothing was ended.';
      elsif v_shift.id is not null and now() < v_shift.ends_at - make_interval(mins => v_settings.early_checkout_minutes) and not coalesce(p_confirm, false) then
        v_outcome := 'needs_confirmation'; v_reason := 'early_checkout'; v_message := 'This is much earlier than the scheduled end. Confirm to end the visit now.';
      else
        begin
          perform ogevia_api.end_service_visit(v_open.id);
          select v.time_out into v_time_out from ogevia.service_visits v where v.id = v_open.id;
          v_outcome := 'saved';
        exception when others then
          v_outcome := 'not_saved'; v_reason := 'end_refused'; v_message := sqlerrm;
          perform ogevia.vv_open_exception(v_org, 'failed_punch', 'failed:' || v_open.id::text || ':end', v_open.id, v_open.scheduled_shift_id, v_actor, v_open.client_id, null, jsonb_build_object('reason', 'end_refused', 'intent', 'departure'));
        end;
      end if;
    end if;
  end if;

  -- Location: compared with the expected endpoint only for a saved or reviewable punch at a known place.
  declare v_res record; v_cm uuid;
  begin
    if v_expected = 'community' and v_client is not null then
      select l.id into v_cm from ogevia.client_service_locations l where l.organization_id = v_org and l.client_id = v_client and l.kind = 'community' and l.is_active
       order by (case when l.latitude is null or p_latitude is null then 0 else ogevia.vv_distance_m(p_latitude, p_longitude, l.latitude, l.longitude) end), l.created_at limit 1;
      v_loc_id := v_cm;
    elsif v_expected = 'home' and v_loc_id is null and v_client is not null then
      select l.id into v_loc_id from ogevia.client_service_locations l where l.organization_id = v_org and l.client_id = v_client and l.kind = 'home' and l.is_active order by l.created_at limit 1;
    end if;
    select * into v_res from ogevia.vv_location_result(v_org, p_latitude, p_longitude, p_accuracy_m, v_loc_id);
    v_loc := v_res;
  end;

  v_signing := null;
  if v_outcome = 'saved' then
    if v_loc.result is distinct from 'within_range' then
      perform ogevia.vv_open_exception(v_org, 'location_issue', 'loc:' || v_visit::text || ':' || p_intent, v_visit, (select scheduled_shift_id from ogevia.service_visits where id = v_visit), v_actor, v_client, v_punch,
        jsonb_build_object('result', v_loc.result, 'distance_m', v_loc.distance_m, 'intent', p_intent, 'expected', v_expected));
    end if;
    if p_intent = 'departure' then
      v_signing := 'sign_now';
      -- Unexpected off-site checkout of a home-only visit goes to direct client confirmation: the caregiver phone is not offered for the signature.
      if v_source = 'label' and v_kinds.expected_start = 'home' and v_kinds.expected_end = 'home' and v_loc.result = 'outside_range' then
        v_signing := 'direct_required';
        insert into ogevia.visit_signature_followups (organization_id, visit_id, reason_code, direct_signing_required, opened_by)
        values (v_org, v_visit, 'off_site_checkout', true, v_actor) on conflict do nothing;
        perform ogevia.vv_sig_event(v_org, v_visit, 'deferred', null, jsonb_build_object('reason', 'off_site_checkout'));
        -- The visit leaves the caregiver's open state (existing unable_to_confirm path) so the next visit is not blocked; the client confirms directly through the office.
        perform ogevia_api.confirm_service_visit(v_visit, 'client', 'unable_to_confirm', null, null, null, 'Client confirmation required directly after an off-site checkout', null, null);
      end if;
    end if;
    if v_source = 'label' then update ogevia.home_labels set last_used_at = now() where id = v_label.id; end if;
  end if;

  select s.id into v_row_shift from ogevia.shifts s where s.organization_id = v_org and s.id = coalesce(v_open.scheduled_shift_id, v_shift.id, p_shift_id);
  v_resp := jsonb_build_object('outcome', v_outcome, 'reason', v_reason, 'message', v_message, 'intent', p_intent, 'visitId', v_visit, 'savedAt', case when v_outcome = 'saved' then now() end,
    'locationResult', v_loc.result, 'distanceM', v_loc.distance_m, 'signing', v_signing, 'choices', v_choices, 'organizationId', v_org);
  insert into ogevia.visit_punches (id, organization_id, caregiver_user_id, source, intent, outcome, reason, label_id, client_id, shift_id, visit_id, expected_kind, location_result, distance_m,
    device_latitude, device_longitude, accuracy_m, idempotency_key, response)
  values (v_punch, v_org, v_actor, v_source, p_intent, v_outcome, v_reason, v_label.id, v_client, v_row_shift, v_visit, v_expected, v_loc.result, v_loc.distance_m,
    p_latitude, p_longitude, p_accuracy_m, p_idempotency_key, v_resp);
  return v_resp;
end;
$$;

-- ---------------------------------------------------------------------------
-- Signing: now (session-bound drawn signature on the caregiver phone) or later (follow-up work item)
-- ---------------------------------------------------------------------------
create function ogevia_api.open_signature_session(p_visit_id uuid)
returns table (session_id uuid, expires_at timestamptz, service_date date, time_in timestamptz, time_out timestamptz, direct_required boolean)
language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_sid uuid := gen_random_uuid();
  v_ttl integer;
begin
  select * into v_visit from ogevia.service_visits v where v.id = p_visit_id for update;
  if v_visit.id is null or v_visit.caregiver_user_id is distinct from v_actor or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if v_visit.status <> 'awaiting_signature' then raise exception 'This visit is not waiting for a signature' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.visit_signature_followups f where f.visit_id = p_visit_id and f.state = 'pending' and f.direct_signing_required) then
    perform ogevia.vv_sig_event(v_visit.organization_id, p_visit_id, 'session_rejected', null, jsonb_build_object('why', 'direct_required'));
    raise exception 'This visit needs the client to confirm directly. It cannot be signed on your phone.' using errcode = 'OGC09';
  end if;
  v_ttl := (ogevia.vv_settings(v_visit.organization_id)).signature_session_seconds;
  update ogevia.visit_signature_sessions s set replaced_at = now() where s.visit_id = p_visit_id and s.consumed_at is null and s.replaced_at is null;
  insert into ogevia.visit_signature_sessions (id, organization_id, visit_id, revision_hash, issued_to, expires_at)
  values (v_sid, v_visit.organization_id, p_visit_id, ogevia.vv_revision_hash(p_visit_id), v_actor, now() + make_interval(secs => v_ttl));
  perform ogevia.vv_sig_event(v_visit.organization_id, p_visit_id, 'session_opened', null, '{}'::jsonb);
  return query select v_sid, now() + make_interval(secs => v_ttl), v_visit.service_date, v_visit.time_in, v_visit.time_out, false;
end;
$$;

-- Checks a session WITHOUT consuming it (used before the image is made and stored). Returns null when the session is valid, else the reason, and records the rejection.
create function ogevia_api.check_signature_session(p_session_id uuid, p_visit_id uuid)
returns text language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare s ogevia.visit_signature_sessions%rowtype; v_actor uuid := ogevia.require_actor(); v_reason text;
begin
  select * into s from ogevia.visit_signature_sessions x where x.id = p_session_id;
  v_reason := case when s.id is null or s.issued_to <> v_actor then 'unknown' when s.visit_id <> p_visit_id then 'wrong_visit' when s.consumed_at is not null then 'reused'
                   when s.replaced_at is not null then 'replaced' when s.expires_at <= now() then 'expired'
                   when s.revision_hash <> ogevia.vv_revision_hash(p_visit_id) then 'stale_revision' end;
  if v_reason is not null and s.id is not null and s.issued_to = v_actor then
    perform ogevia.vv_sig_event(s.organization_id, s.visit_id, 'session_rejected', null, jsonb_build_object('why', v_reason));
  end if;
  return v_reason;
end;
$$;

-- Consumes the session atomically. Called inside the same transaction that registers the evidence and confirms the visit, so a failure there releases it.
create function ogevia_api.consume_signature_session(p_session_id uuid, p_visit_id uuid)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); s ogevia.visit_signature_sessions%rowtype; v_reason text;
begin
  select * into s from ogevia.visit_signature_sessions x where x.id = p_session_id for update;
  v_reason := case when s.id is null or s.issued_to <> v_actor then 'unknown' when s.visit_id <> p_visit_id then 'wrong_visit' when s.consumed_at is not null then 'reused'
                   when s.replaced_at is not null then 'replaced' when s.expires_at <= now() then 'expired'
                   when s.revision_hash <> ogevia.vv_revision_hash(p_visit_id) then 'stale_revision' end;
  if v_reason is not null then
    raise exception 'This signing session is no longer valid. Open the signing screen again.' using errcode = 'OGC09';
  end if;
  update ogevia.visit_signature_sessions x set consumed_at = now() where x.id = s.id and x.consumed_at is null;
  if not found then raise exception 'This signing session is no longer valid. Open the signing screen again.' using errcode = 'OGC09'; end if;
  perform ogevia.vv_sig_event(s.organization_id, s.visit_id, 'signed_at_checkout', null, '{}'::jsonb);
end;
$$;

-- Sign later: uses the existing "unable to confirm" path so the visit leaves the caregiver's open state and keeps its actual checkout; the follow-up tracks who chases it.
create function ogevia_api.defer_visit_signature(p_visit_id uuid, p_reason_code text, p_idempotency_key uuid default null)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_id uuid;
  v_text text;
begin
  select * into v_visit from ogevia.service_visits v where v.id = p_visit_id for update;
  if v_visit.id is null or v_visit.caregiver_user_id is distinct from v_actor or not ogevia.is_active_member(v_visit.organization_id) then raise exception 'Visit not found' using errcode = 'OGN04'; end if;
  if p_reason_code not in ('signing_later', 'client_unavailable', 'declined') then raise exception 'Choose a valid reason' using errcode = 'OGV22'; end if;
  select f.id into v_id from ogevia.visit_signature_followups f where f.visit_id = p_visit_id and f.state = 'pending';
  if v_visit.status <> 'awaiting_signature' then
    if v_id is not null then return v_id; end if;
    raise exception 'This visit is not waiting for a signature' using errcode = 'OGC09';
  end if;
  v_text := case p_reason_code when 'signing_later' then 'Client will sign later (follow-up opened)' when 'client_unavailable' then 'Client was unavailable to sign at checkout' else 'Client declined to sign at checkout' end;
  perform ogevia_api.confirm_service_visit(p_visit_id, 'client', 'unable_to_confirm', null, null, null, v_text, p_idempotency_key, null);
  insert into ogevia.visit_signature_followups (organization_id, visit_id, reason_code, direct_signing_required, opened_by)
  values (v_visit.organization_id, p_visit_id, p_reason_code, false, v_actor)
  on conflict (visit_id) where state = 'pending' do update set reason_code = excluded.reason_code
  returning id into v_id;
  perform ogevia.vv_sig_event(v_visit.organization_id, p_visit_id, case p_reason_code when 'signing_later' then 'deferred' when 'declined' then 'declined' else 'unavailable' end, null, jsonb_build_object('reason', p_reason_code));
  return v_id;
end;
$$;

-- The follow-up is resolved when a valid late confirmation arrives (derived, not copied): the signature issue clears, nothing else changes.
create function ogevia.vv_followup_resolved_by_signature(p_visit_id uuid)
returns boolean language sql stable security definer set search_path = ogevia, pg_temp as $$
  select exists (select 1 from ogevia.visit_late_confirmations lc where lc.visit_id = p_visit_id and lc.outcome = 'confirmed')
      or exists (select 1 from ogevia.visit_confirmations vc where vc.visit_id = p_visit_id and vc.confirmation_method in ('draw', 'assisted_mark'));
$$;
revoke all on function ogevia.vv_followup_resolved_by_signature(uuid) from public;

create function ogevia.vv_sync_followups(p_org uuid)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare r record;
begin
  for r in select f.id, f.visit_id from ogevia.visit_signature_followups f where f.organization_id = p_org and f.state = 'pending'
            and exists (select 1 from ogevia.visit_late_confirmations lc where lc.visit_id = f.visit_id and lc.outcome = 'confirmed' and lc.received_at >= f.opened_at)
  loop
    update ogevia.visit_signature_followups set state = 'resolved', resolved_at = now(), resolution = 'signed' where id = r.id;
    perform ogevia.vv_sig_event(p_org, r.visit_id, 'signed_late', null, '{}'::jsonb);
  end loop;
  for r in select f.id, f.visit_id from ogevia.visit_signature_followups f where f.organization_id = p_org and f.state = 'pending'
            and exists (select 1 from ogevia.visit_late_confirmations lc where lc.visit_id = f.visit_id and lc.outcome = 'disputed' and lc.received_at >= f.opened_at)
  loop
    perform ogevia.vv_open_exception(p_org, 'disputed_signature', 'dispute:' || r.visit_id::text, r.visit_id, null, null, null, null, '{}'::jsonb);
  end loop;
end;
$$;
revoke all on function ogevia.vv_sync_followups(uuid) from public;

create function ogevia_api.set_signature_followup_owner(p_organization_id uuid, p_visit_id uuid, p_owner_user_id uuid, p_assign_to_me boolean default false)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if coalesce(p_assign_to_me, false) then p_owner_user_id := ogevia.current_user_id(); end if;
  if not ogevia.has_permission(p_organization_id, 'visits.manage') then raise exception 'You do not have permission to manage follow-ups' using errcode = 'OGA03'; end if;
  perform 1 from ogevia.visit_signature_followups f where f.organization_id = p_organization_id and f.visit_id = p_visit_id and f.state = 'pending';
  if not found then raise exception 'No pending signature follow-up for this visit' using errcode = 'OGN04'; end if;
  if p_owner_user_id is not null and not exists (select 1 from ogevia.organization_memberships m where m.organization_id = p_organization_id and m.user_id = p_owner_user_id and m.status = 'active') then
    raise exception 'That person is not an active member of this agency' using errcode = 'OGV22';
  end if;
  update ogevia.visit_signature_followups f set owner_user_id = p_owner_user_id where f.organization_id = p_organization_id and f.visit_id = p_visit_id and f.state = 'pending';
  perform ogevia.vv_sig_event(p_organization_id, p_visit_id, 'owner_set', null, jsonb_build_object('owner_set', p_owner_user_id is not null));
end;
$$;

-- Delivery history: the API calls this after it creates (or revokes) a 0036 link or hands the staff member the link to copy. Token and code are never passed here.
create function ogevia_api.log_signature_delivery(p_organization_id uuid, p_visit_id uuid, p_action text, p_request_id uuid, p_channel text, p_status text)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'visits.manage') then raise exception 'You do not have permission to manage follow-ups' using errcode = 'OGA03'; end if;
  if p_action not in ('request_created', 'link_copied', 'email_queued', 'delivery_failed', 'link_revoked') then raise exception 'Unknown action' using errcode = 'OGV22'; end if;
  perform 1 from ogevia.service_visits v where v.id = p_visit_id and v.organization_id = p_organization_id;
  if not found then raise exception 'Visit not found' using errcode = 'OGN04'; end if;
  perform ogevia.vv_sig_event(p_organization_id, p_visit_id, p_action, p_request_id, jsonb_build_object('channel', p_channel, 'status', p_status));
end;
$$;

-- ---------------------------------------------------------------------------
-- Exceptions: overdue open visits, listing, resolution
-- ---------------------------------------------------------------------------
-- Actual and scheduled times stay apart: the exception stores neither; the report joins both.
create function ogevia_api.flag_overdue_visits(p_organization_id uuid)
returns integer language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_n integer := 0; r record; v_grace integer;
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'visits.manage') then raise exception 'You do not have permission to review visits' using errcode = 'OGA03'; end if;
  v_grace := (ogevia.vv_settings(p_organization_id)).overdue_grace_minutes;
  for r in select v.id, v.scheduled_shift_id, v.caregiver_user_id, v.client_id from ogevia.service_visits v left join ogevia.shifts s on s.id = v.scheduled_shift_id
            where v.organization_id = p_organization_id and v.status = 'draft'
              and coalesce(s.ends_at + make_interval(mins => v_grace), v.time_in + interval '12 hours') < now()
  loop
    if ogevia.vv_open_exception(p_organization_id, 'overdue_clock_out', 'overdue:' || r.id::text, r.id, r.scheduled_shift_id, r.caregiver_user_id, r.client_id, null, '{}'::jsonb) is not null then v_n := v_n + 1; end if;
  end loop;
  -- A shift that ended with no visit at all is a missing punch.
  for r in select s.id, s.caregiver_user_id, s.client_id from ogevia.shifts s
            where s.organization_id = p_organization_id and s.status = 'scheduled' and s.ends_at + make_interval(mins => v_grace) < now() and s.ends_at > now() - interval '14 days'
              and s.service_id is not null and not ogevia.shift_is_called_out(s.id)
              and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected'))
              and (s.caregiver_user_id is not null or s.caregiver_record_id is not null)
  loop
    if ogevia.vv_open_exception(p_organization_id, 'missing_punch', 'missing:' || r.id::text, null, r.id, r.caregiver_user_id, r.client_id, null, '{}'::jsonb) is not null then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end;
$$;

create function ogevia_api.list_visit_exceptions(p_organization_id uuid, p_status text default null, p_kind text default null, p_from date default null, p_to date default null,
  p_caregiver_user_id uuid default null, p_client_id uuid default null, p_service_id uuid default null)
returns table (exception_id uuid, kind text, status text, opened_at timestamptz, age_hours integer, visit_id uuid, shift_id uuid, caregiver_name text, client_code text, service_name text,
               scheduled_start timestamptz, scheduled_end timestamptz, actual_time_in timestamptz, actual_time_out timestamptz, detail jsonb, reviewer_name text, resolved_at timestamptz, resolution text)
language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'visits.read') then raise exception 'You do not have permission to see visit exceptions' using errcode = 'OGA03'; end if;
  perform ogevia.vv_sync_followups(p_organization_id);
  if ogevia.has_permission(p_organization_id, 'visits.manage') then perform ogevia_api.flag_overdue_visits(p_organization_id); end if;
  return query
  select e.id, e.kind, e.status, e.opened_at, (extract(epoch from (coalesce(e.resolved_at, now()) - e.opened_at)) / 3600)::integer, e.visit_id, e.shift_id,
         coalesce(v.caregiver_name_snapshot, cu.display_name), c.client_code, sv.name, s.starts_at, s.ends_at, v.time_in, v.time_out, e.detail, ru.display_name, e.resolved_at, e.resolution
    from ogevia.visit_exceptions e
    left join ogevia.service_visits v on v.id = e.visit_id
    left join ogevia.shifts s on s.id = coalesce(e.shift_id, v.scheduled_shift_id)
    left join ogevia.app_users cu on cu.id = e.caregiver_user_id
    left join ogevia.clients c on c.id = coalesce(e.client_id, v.client_id)
    left join ogevia.services sv on sv.id = coalesce(v.service_id, s.service_id)
    left join ogevia.app_users ru on ru.id = e.reviewer_user_id
   where e.organization_id = p_organization_id
     and (p_status is null or e.status = p_status or (p_status = 'open' and e.status in ('open', 'in_review')))
     and (p_kind is null or e.kind = p_kind)
     and (p_from is null or e.opened_at::date >= p_from) and (p_to is null or e.opened_at::date <= p_to)
     and (p_caregiver_user_id is null or e.caregiver_user_id = p_caregiver_user_id)
     and (p_client_id is null or coalesce(e.client_id, v.client_id) = p_client_id)
     and (p_service_id is null or coalesce(v.service_id, s.service_id) = p_service_id)
   order by e.opened_at desc limit 500;
end;
$$;

create function ogevia_api.resolve_visit_exception(p_organization_id uuid, p_exception_id uuid, p_action text, p_note text)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); e ogevia.visit_exceptions%rowtype;
begin
  if not ogevia.has_permission(p_organization_id, 'visits.manage') then raise exception 'You do not have permission to review visits' using errcode = 'OGA03'; end if;
  if p_action not in ('reviewing', 'resolved', 'dismissed') then raise exception 'Unknown action' using errcode = 'OGV22'; end if;
  if length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'A note is required' using errcode = 'OGV22'; end if;
  select * into e from ogevia.visit_exceptions x where x.id = p_exception_id and x.organization_id = p_organization_id for update;
  if e.id is null then raise exception 'Exception not found' using errcode = 'OGN04'; end if;
  if e.status in ('resolved', 'dismissed') then raise exception 'This exception is already closed' using errcode = 'OGC09'; end if;
  update ogevia.visit_exceptions x set status = case p_action when 'reviewing' then 'in_review' else p_action end, reviewer_user_id = v_actor,
         resolved_at = case when p_action = 'reviewing' then null else now() end, resolution = case when p_action = 'reviewing' then null else btrim(p_note) end
   where x.id = e.id;
  insert into ogevia.visit_exception_events (organization_id, exception_id, action, actor_user_id, note) values (p_organization_id, e.id, p_action, v_actor, btrim(p_note));
  perform ogevia.write_audit(p_organization_id, 'visit_exception.' || p_action, 'visit_exceptions', e.id, null, jsonb_build_object('kind', e.kind), btrim(p_note));
end;
$$;

create function ogevia_api.list_visit_exception_history(p_organization_id uuid, p_exception_id uuid)
returns table (occurred_at timestamptz, action text, actor_name text, note text)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'visits.read') then raise exception 'You do not have permission to see visit exceptions' using errcode = 'OGA03'; end if;
  return query select ev.occurred_at, ev.action, u.display_name, ev.note from ogevia.visit_exception_events ev left join ogevia.app_users u on u.id = ev.actor_user_id
   where ev.organization_id = p_organization_id and ev.exception_id = p_exception_id order by ev.occurred_at, ev.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audited missed-punch / time corrections (poor connectivity, dead phone, lost tag, delayed login)
-- ---------------------------------------------------------------------------
create function ogevia_api.request_punch_correction(p_visit_id uuid, p_reason_code text, p_reason_note text, p_requested_time_in timestamptz, p_requested_time_out timestamptz)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); v ogevia.service_visits%rowtype; v_id uuid;
begin
  select * into v from ogevia.service_visits sv where sv.id = p_visit_id;
  if v.id is null or not ogevia.is_active_member(v.organization_id)
     or not (coalesce(v.caregiver_user_id = v_actor, false) or ogevia.has_permission(v.organization_id, 'visits.manage')) then raise exception 'Visit not found' using errcode = 'OGN04'; end if;
  if p_requested_time_out is null or p_requested_time_out > now() then raise exception 'The corrected time out must be in the past' using errcode = 'OGV22'; end if;
  if p_requested_time_in is not null and p_requested_time_out <= p_requested_time_in then raise exception 'Time out must be after time in' using errcode = 'OGV22'; end if;
  if v.status in ('voided', 'corrected') then raise exception 'This visit can no longer be corrected' using errcode = 'OGC09'; end if;
  insert into ogevia.punch_correction_requests (organization_id, visit_id, reason_code, reason_note, original_time_in, original_time_out, requested_time_in, requested_time_out, requested_by)
  values (v.organization_id, p_visit_id, p_reason_code, btrim(coalesce(p_reason_note, '')), v.time_in, v.time_out, p_requested_time_in, p_requested_time_out, v_actor)
  returning id into v_id;
  perform ogevia.vv_open_exception(v.organization_id, 'correction_request', 'corr:' || v_id::text, p_visit_id, v.scheduled_shift_id, v.caregiver_user_id, v.client_id, null, jsonb_build_object('reason_code', p_reason_code, 'request_id', v_id));
  perform ogevia.write_audit(v.organization_id, 'punch_correction.requested', 'punch_correction_requests', v_id, null, jsonb_build_object('visit_id', p_visit_id, 'reason_code', p_reason_code), btrim(p_reason_note));
  return v_id;
end;
$$;

create function ogevia_api.decide_punch_correction(p_organization_id uuid, p_request_id uuid, p_approve boolean, p_note text, p_location_decision text default 'not_applicable', p_idempotency_key uuid default null)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  r ogevia.punch_correction_requests%rowtype;
  v ogevia.service_visits%rowtype;
  v_new uuid;
  v_material integer := (ogevia.vv_settings(p_organization_id)).material_time_change_minutes;
  v_signed boolean;
  v_resign boolean := false;
  v_rev text;
  v_reason text;
begin
  if not ogevia.has_permission(p_organization_id, 'visits.manage') then raise exception 'You do not have permission to decide corrections' using errcode = 'OGA03'; end if;
  if length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'A decision note is required' using errcode = 'OGV22'; end if;
  if p_location_decision not in ('accepted', 'not_applicable', 'rejected') then raise exception 'Unknown location decision' using errcode = 'OGV22'; end if;
  select * into r from ogevia.punch_correction_requests x where x.id = p_request_id and x.organization_id = p_organization_id for update;
  if r.id is null then raise exception 'Correction request not found' using errcode = 'OGN04'; end if;
  if r.status <> 'pending' then raise exception 'This request was already decided' using errcode = 'OGC09'; end if;
  if r.requested_by = v_actor then raise exception 'Another reviewer must decide a request you made' using errcode = 'OGA03'; end if;
  select * into v from ogevia.service_visits sv where sv.id = r.visit_id for update;
  v_reason := 'Missed-punch correction (' || replace(r.reason_code, '_', ' ') || '): ' || r.reason_note;
  v_new := r.visit_id;
  if p_approve then
    if v.status = 'draft' then
      if r.requested_time_in is not null and date_trunc('second', r.requested_time_in) <> date_trunc('second', v.time_in) then
        raise exception 'The start time of a running visit cannot change. Close it first, then correct the submitted visit.' using errcode = 'OGC09';
      end if;
      perform ogevia_api.close_missed_service_visit(v.id, r.requested_time_out, v_reason, p_idempotency_key);
    elsif v.status in ('signed', 'administrator_review') then
      v_signed := ogevia.vv_followup_resolved_by_signature(coalesce(v.original_visit_id, v.id)) or ogevia.vv_followup_resolved_by_signature(v.id);
      v_rev := ogevia.vv_revision_hash(v.id);
      v_new := ogevia_api.correct_service_visit(v.id, coalesce(r.requested_time_in, v.time_in), r.requested_time_out, v_reason, p_idempotency_key);
      v_resign := v_signed and (abs(extract(epoch from (coalesce(r.requested_time_in, v.time_in) - v.time_in))) / 60 >= v_material
                              or abs(extract(epoch from (r.requested_time_out - v.time_out))) / 60 >= v_material);
      if v_resign then
        -- The original signed revision stays in the audit history (the old row and its confirmation are untouched); the corrected row needs a fresh signature.
        update ogevia.visit_signature_followups f set state = 'void', resolved_at = now(), resolution = 'superseded' where f.visit_id = v.id and f.state = 'pending';
        insert into ogevia.visit_signature_followups (organization_id, visit_id, reason_code, direct_signing_required, opened_by) values (p_organization_id, v_new, 'times_corrected', false, v_actor);
        perform ogevia.vv_sig_event(p_organization_id, v_new, 'reopened', null, jsonb_build_object('original_visit_id', v.id, 'original_revision', v_rev));
      end if;
    else
      raise exception 'A visit that is waiting for its signature, voided or already corrected cannot be corrected this way' using errcode = 'OGC09';
    end if;
  end if;
  update ogevia.punch_correction_requests x set status = case when p_approve then 'approved' else 'rejected' end, decided_by = v_actor, decided_at = now(), decision_note = btrim(p_note),
         resulting_visit_id = case when p_approve then v_new end, needs_resigning = case when p_approve then v_resign end, location_decision = p_location_decision
   where x.id = r.id;
  update ogevia.visit_exceptions e set status = 'resolved', reviewer_user_id = v_actor, resolved_at = now(), resolution = case when p_approve then 'correction approved' else 'correction rejected' end
   where e.organization_id = p_organization_id and e.dedupe_key = 'corr:' || r.id::text and e.status in ('open', 'in_review');
  perform ogevia.write_audit(p_organization_id, case when p_approve then 'punch_correction.approved' else 'punch_correction.rejected' end, 'punch_correction_requests', r.id, null,
    jsonb_build_object('visit_id', r.visit_id, 'resulting_visit_id', v_new, 'needs_resigning', v_resign, 'location_decision', p_location_decision), btrim(p_note));
  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports (existing filters; staff only; no signature images, no precise GPS, no signing links in any column)
-- ---------------------------------------------------------------------------
create function ogevia_api.list_unsigned_checkouts(p_organization_id uuid, p_from date default null, p_to date default null, p_caregiver_user_id uuid default null,
  p_client_id uuid default null, p_service_id uuid default null, p_include_resolved boolean default false)
returns table (visit_id uuid, visit_number text, service_date date, caregiver_name text, client_code text, service_name text, checkout_at timestamptz, pending_since timestamptz, pending_hours integer,
               state text, reason text, direct_required boolean, last_request_at timestamptz, last_delivery text, owner_name text, resolved_at timestamptz, resolution text)
language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'visits.read') then raise exception 'You do not have permission to see this report' using errcode = 'OGA03'; end if;
  perform ogevia.vv_sync_followups(p_organization_id);
  return query
  select v.id, v.visit_number_snapshot, v.service_date, v.caregiver_name_snapshot, c.client_code, sv.name, v.time_out, coalesce(f.opened_at, v.time_out),
         (extract(epoch from (coalesce(f.resolved_at, now()) - coalesce(f.opened_at, v.time_out))) / 3600)::integer,
         coalesce(f.state, 'pending'), coalesce(f.reason_code, 'at_checkout'), coalesce(f.direct_signing_required, false),
         (select max(e.occurred_at) from ogevia.visit_signature_events e where e.visit_id = v.id and e.action in ('request_created', 'link_copied', 'email_queued')),
         (select e.action from ogevia.visit_signature_events e where e.visit_id = v.id and e.action in ('request_created', 'link_copied', 'email_queued', 'delivery_failed', 'link_revoked') order by e.occurred_at desc, e.id desc limit 1),
         ou.display_name, f.resolved_at, f.resolution
    from ogevia.service_visits v
    join ogevia.clients c on c.id = v.client_id
    join ogevia.services sv on sv.id = v.service_id
    left join ogevia.visit_signature_followups f on f.visit_id = v.id and (f.state = 'pending' or p_include_resolved)
    left join ogevia.app_users ou on ou.id = f.owner_user_id
   where v.organization_id = p_organization_id and v.time_out is not null
     and (f.id is not null or v.status = 'awaiting_signature')
     and (p_from is null or v.service_date >= p_from) and (p_to is null or v.service_date <= p_to)
     and (p_caregiver_user_id is null or v.caregiver_user_id = p_caregiver_user_id) and (p_client_id is null or v.client_id = p_client_id) and (p_service_id is null or v.service_id = p_service_id)
   order by coalesce(f.opened_at, v.time_out) limit 1000;
end;
$$;

create function ogevia_api.list_time_signature_register(p_organization_id uuid, p_from date default null, p_to date default null, p_caregiver_user_id uuid default null,
  p_client_id uuid default null, p_service_id uuid default null, p_status text default null)
returns table (visit_id uuid, visit_number text, service_date date, caregiver_name text, client_code text, service_name text, scheduled_start timestamptz, scheduled_end timestamptz,
               actual_time_in timestamptz, actual_time_out timestamptz, punch_in_method text, punch_out_method text, expected_start text, expected_end text,
               location_in text, location_out text, signature_status text, signature_method text, signed_at timestamptz, visit_status text)
language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'visits.read') then raise exception 'You do not have permission to see this report' using errcode = 'OGA03'; end if;
  perform ogevia.vv_sync_followups(p_organization_id);
  return query
  select v.id, v.visit_number_snapshot, v.service_date, v.caregiver_name_snapshot, c.client_code, sv.name, s.starts_at, s.ends_at, v.time_in, v.time_out,
         coalesce((select case p.source when 'label' then 'NFC or QR' else 'App' end from ogevia.visit_punches p where p.visit_id = v.id and p.intent = 'arrival' and p.outcome = 'saved' limit 1), 'Manual or earlier method'),
         coalesce((select case p.source when 'label' then 'NFC or QR' else 'App' end from ogevia.visit_punches p where p.visit_id = v.id and p.intent = 'departure' and p.outcome = 'saved' limit 1), 'Manual or earlier method'),
         k.expected_start, k.expected_end,
         (select p.location_result from ogevia.visit_punches p where p.visit_id = v.id and p.intent = 'arrival' and p.outcome = 'saved' limit 1),
         (select p.location_result from ogevia.visit_punches p where p.visit_id = v.id and p.intent = 'departure' and p.outcome = 'saved' limit 1),
         case when exists (select 1 from ogevia.visit_signature_followups f where f.visit_id = v.id and f.state = 'pending' and f.direct_signing_required) then 'direct_required'
              when exists (select 1 from ogevia.visit_signature_followups f where f.visit_id = v.id and f.state = 'pending') then 'pending'
              when v.status = 'awaiting_signature' then 'pending'
              when v.status = 'draft' then 'not_yet_due'
              when ogevia.vv_followup_resolved_by_signature(coalesce(v.original_visit_id, v.id)) or ogevia.vv_followup_resolved_by_signature(v.id) then 'signed'
              else 'not_signed' end,
         coalesce((select lc.method from ogevia.visit_late_confirmations lc where lc.visit_id = v.id and lc.outcome = 'confirmed' order by lc.received_at desc limit 1),
                  (select vc.confirmation_method from ogevia.visit_confirmations vc where vc.visit_id in (v.id, v.original_visit_id) and vc.confirmation_method <> 'unable_to_confirm' order by vc.confirmed_at desc limit 1)),
         coalesce((select lc.received_at from ogevia.visit_late_confirmations lc where lc.visit_id = v.id and lc.outcome = 'confirmed' order by lc.received_at desc limit 1),
                  (select vc.confirmed_at from ogevia.visit_confirmations vc where vc.visit_id in (v.id, v.original_visit_id) and vc.confirmation_method <> 'unable_to_confirm' order by vc.confirmed_at desc limit 1)),
         v.status::text
    from ogevia.service_visits v
    join ogevia.clients c on c.id = v.client_id
    join ogevia.services sv on sv.id = v.service_id
    left join ogevia.shifts s on s.id = v.scheduled_shift_id
    left join lateral ogevia.vv_expected_kinds(v.organization_id, v.scheduled_shift_id, v.service_id) k on true
   where v.organization_id = p_organization_id and v.status not in ('voided', 'corrected')
     and (p_from is null or v.service_date >= p_from) and (p_to is null or v.service_date <= p_to)
     and (p_caregiver_user_id is null or v.caregiver_user_id = p_caregiver_user_id) and (p_client_id is null or v.client_id = p_client_id) and (p_service_id is null or v.service_id = p_service_id)
     and (p_status is null or v.status::text = p_status)
   order by v.service_date desc, v.time_in desc limit 1000;
end;
$$;

create function ogevia_api.list_corrections_audit(p_organization_id uuid, p_from date default null, p_to date default null)
returns table (occurred_at timestamptz, kind text, subject text, original jsonb, revised jsonb, requester text, approver text, reason text, needs_resigning boolean, location_decision text)
language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'visits.read') then raise exception 'You do not have permission to see this report' using errcode = 'OGA03'; end if;
  return query
  select * from (
    select vc.created_at, 'time_correction'::text, ov.visit_number_snapshot, vc.before_snapshot, vc.after_snapshot, u.display_name, u.display_name, vc.reason,
           exists (select 1 from ogevia.visit_signature_events e where e.visit_id = vc.corrected_visit_id and e.action = 'reopened'), null::text
      from ogevia.visit_corrections vc join ogevia.service_visits ov on ov.id = vc.original_visit_id left join ogevia.app_users u on u.id = vc.corrected_by
     where vc.organization_id = p_organization_id
    union all
    select coalesce(r.decided_at, r.requested_at), 'punch_correction', v.visit_number_snapshot,
           jsonb_build_object('timeIn', r.original_time_in, 'timeOut', r.original_time_out), jsonb_build_object('timeIn', coalesce(r.requested_time_in, r.original_time_in), 'timeOut', r.requested_time_out),
           ru.display_name, du.display_name, r.reason_code || ': ' || r.reason_note || coalesce(' / decision: ' || r.decision_note, ''), r.needs_resigning, r.location_decision
      from ogevia.punch_correction_requests r join ogevia.service_visits v on v.id = r.visit_id left join ogevia.app_users ru on ru.id = r.requested_by left join ogevia.app_users du on du.id = r.decided_by
     where r.organization_id = p_organization_id
    union all
    select e.occurred_at, 'label_change', h.label_code, jsonb_build_object('locationId', e.from_location_id), jsonb_build_object('locationId', e.to_location_id), u.display_name, u.display_name, coalesce(e.reason, e.action), null, null
      from ogevia.home_label_events e join ogevia.home_labels h on h.id = e.label_id left join ogevia.app_users u on u.id = e.actor_user_id
     where e.organization_id = p_organization_id and e.action in ('assigned', 'deactivated', 'replaced', 'reassigned', 'link_revoked')
  ) x (occurred_at, kind, subject, original, revised, requester, approver, reason, needs_resigning, location_decision)
  where (p_from is null or x.occurred_at::date >= p_from) and (p_to is null or x.occurred_at::date <= p_to)
  order by x.occurred_at desc limit 1000;
end;
$$;

create function ogevia_api.list_punch_billing_review(p_organization_id uuid, p_from date default null, p_to date default null, p_caregiver_user_id uuid default null,
  p_client_id uuid default null, p_service_id uuid default null)
returns table (visit_id uuid, visit_number text, service_date date, caregiver_name text, client_code text, service_name text, recorded_minutes integer, reviewed_minutes integer, billable_minutes integer,
               open_exceptions integer, signature_status text, billing_hold boolean, hold_reasons text[])
language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_set ogevia.visit_verification_settings;
begin
  perform ogevia.require_actor();
  if not (ogevia.has_permission(p_organization_id, 'visits.read') and ogevia.has_permission(p_organization_id, 'billing.visits.read')) then raise exception 'You do not have permission to see this report' using errcode = 'OGA03'; end if;
  perform ogevia.vv_sync_followups(p_organization_id);
  v_set := ogevia.vv_settings(p_organization_id);
  return query
  select t.visit_id, t.visit_number, t.service_date, t.caregiver_name, t.client_code, t.service_name, t.recorded, t.reviewed, t.billable, t.open_exc, t.sig,
         (v_set.hold_billing_while_signature_pending and t.sig in ('pending', 'direct_required')) or (v_set.hold_billing_on_open_exceptions and t.open_exc > 0),
         array_remove(array[case when v_set.hold_billing_while_signature_pending and t.sig in ('pending', 'direct_required') then 'signature_pending' end,
                            case when v_set.hold_billing_on_open_exceptions and t.open_exc > 0 then 'open_exception' end], null)
    from (
      select v.id as visit_id, v.visit_number_snapshot as visit_number, v.service_date, v.caregiver_name_snapshot as caregiver_name, c.client_code, sv.name as service_name,
             v.worked_minutes as recorded, v.verified_minutes as reviewed, v.billable_minutes as billable,
             (select count(*)::integer from ogevia.visit_exceptions e where e.visit_id = v.id and e.status in ('open', 'in_review')) as open_exc,
             case when exists (select 1 from ogevia.visit_signature_followups f where f.visit_id = v.id and f.state = 'pending' and f.direct_signing_required) then 'direct_required'
                  when exists (select 1 from ogevia.visit_signature_followups f where f.visit_id = v.id and f.state = 'pending') or v.status = 'awaiting_signature' then 'pending' else 'signed_or_not_required' end as sig
        from ogevia.service_visits v join ogevia.clients c on c.id = v.client_id join ogevia.services sv on sv.id = v.service_id
       where v.organization_id = p_organization_id and v.status not in ('voided', 'corrected', 'draft')
         and (p_from is null or v.service_date >= p_from) and (p_to is null or v.service_date <= p_to)
         and (p_caregiver_user_id is null or v.caregiver_user_id = p_caregiver_user_id) and (p_client_id is null or v.client_id = p_client_id) and (p_service_id is null or v.service_id = p_service_id)
    ) t order by t.service_date desc, t.visit_number limit 1000;
end;
$$;


-- Tap or scan a sticker to capture it: the app reads the sticker's link, hashes the token and asks which sticker ID it belongs to. Own agency only; staff only.
create function ogevia_api.resolve_home_label_code(p_organization_id uuid, p_token_hash text)
returns table (label_id uuid, label_code text, status text)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then raise exception 'You do not have permission to assign labels' using errcode = 'OGA03'; end if;
  return query select h.id, h.label_code, h.status from ogevia.home_labels h where h.organization_id = p_organization_id and h.token_hash = p_token_hash;
  if not found then raise exception 'Label not found for your agency' using errcode = 'OGN04'; end if;
end;
$$;

-- CSV export of a 0124 report: the caller needs reports.export; the export is audited (report key and row count only, never the rows).
create function ogevia_api.authorize_verification_export(p_organization_id uuid, p_report text, p_row_count integer)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.has_permission(p_organization_id, 'reports.export') then raise exception 'You do not have permission to export reports' using errcode = 'OGA03'; end if;
  if p_report not in ('visit_exceptions', 'unsigned_checkouts', 'time_signature_register', 'corrections_audit', 'billing_review', 'label_inventory') then raise exception 'Unknown report' using errcode = 'OGV22'; end if;
  perform ogevia.write_audit(p_organization_id, 'verification_report.exported', 'organizations', p_organization_id, null, jsonb_build_object('report', p_report, 'rows', p_row_count), null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the application role may call only the API functions below
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'save_service_location(uuid,uuid,uuid,text,text,text,text,text,text,numeric,numeric,text,integer)',
    'list_service_locations(uuid,uuid)',
    'set_service_location_rule(uuid,uuid,text,text,boolean)',
    'set_shift_location_override(uuid,uuid,text,text,text)',
    'get_expected_locations(uuid,uuid)',
    'save_verification_settings(uuid,integer,integer,integer,integer,integer,boolean,boolean)',
    'get_verification_settings(uuid)',
    'register_home_labels(uuid,jsonb)',
    'assign_home_label(uuid,text,uuid,boolean,boolean)',
    'deactivate_home_label(uuid,uuid,text)',
    'replace_home_label(uuid,uuid,text,text)',
    'get_home_label_link(uuid,uuid)',
    'list_home_labels(uuid,text,uuid,integer)',
    'list_home_label_history(uuid,uuid)',
    'preview_home_label(text)',
    'record_punch(text,uuid,text,uuid,uuid,numeric,numeric,integer,uuid,boolean)',
    'open_signature_session(uuid)',
    'check_signature_session(uuid,uuid)',
    'consume_signature_session(uuid,uuid)',
    'defer_visit_signature(uuid,text,uuid)',
    'set_signature_followup_owner(uuid,uuid,uuid,boolean)',
    'log_signature_delivery(uuid,uuid,text,uuid,text,text)',
    'flag_overdue_visits(uuid)',
    'list_visit_exceptions(uuid,text,text,date,date,uuid,uuid,uuid)',
    'resolve_visit_exception(uuid,uuid,text,text)',
    'list_visit_exception_history(uuid,uuid)',
    'request_punch_correction(uuid,text,text,timestamptz,timestamptz)',
    'decide_punch_correction(uuid,uuid,boolean,text,text,uuid)',
    'list_unsigned_checkouts(uuid,date,date,uuid,uuid,uuid,boolean)',
    'list_time_signature_register(uuid,date,date,uuid,uuid,uuid,text)',
    'list_corrections_audit(uuid,date,date)',
    'list_punch_billing_review(uuid,date,date,uuid,uuid,uuid)',
    'authorize_verification_export(uuid,text,integer)',
    'resolve_home_label_code(uuid,text)'
  ] loop
    execute format('revoke all on function ogevia_api.%s from public', f);
    execute format('grant execute on function ogevia_api.%s to ogevia_app', f);
  end loop;
end $$;
