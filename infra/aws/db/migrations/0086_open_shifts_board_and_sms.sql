-- 0086 City-based Open Shifts board and automatic SMS notifications (owner brief 2026-11-22, Option A: first come, office approves).
--
-- ADDITIVE. Reuses the canonical shifts / shift_coverage_events / shift_pickup_requests / authorization reservations / readiness gate. Nothing is
-- sent by this migration; SMS stays off (agency_open_shift_settings.sms_enabled = false, sms_entitled = false, sender 'unverified') until the owner
-- approves a verified sender per agency.
--
-- Layers (kept separate): SHIFT (scheduled / cancelled ...; coverage state from 0026), COVERAGE ROUND (unposted | posted | closed, one open round per shift),
-- REQUEST (pending | confirmed | declined | withdrawn | superseded (filled) | invalidated (details changed) | closed (opening closed)), NOTIFICATION JOB
-- (delivery status only; sending a text never changes assignment state).
--
-- Before (0051/0063): the board listed client codes and required the caregiver to be assigned to the client and service. NOW the board is matched by the
-- shift's SERVICE CITY and the caregiver's approved coverage cities, shows no client information, and the client-assignment gate is not required for board
-- requests (the readiness gate, overlap, availability, hours, holds, service approval and client requirements are all still enforced). The legacy
-- list_open_shifts / pickup_open_shift (0063) are left in place for rollback and compatibility; the API routes move to the board functions below.
--
-- Concurrency: posting, requesting and confirming all take the shift row lock first (as every other assignment path does); one open round per shift is a
-- unique index; notification jobs are unique per (agency, dedupe key) = purpose | round | recipient, so retries, edits, unpost/repost and repeated worker
-- runs can never queue a second text. Quota is counted atomically when a job is claimed. Phone numbers live only in consent / contact tables and are
-- never returned except masked.

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Shift location and opaque reference
------------------------------------------------------------------------------------------------------------------------------------------------------
alter table ogevia.shifts
  add column public_ref uuid not null default gen_random_uuid(),
  add column service_city text check (service_city is null or length(btrim(service_city)) between 2 and 80),
  add column service_state text check (service_state is null or service_state ~ '^[A-Z]{2}$');
create unique index shifts_public_ref_idx on ogevia.shifts (public_ref);

-- Canonical city key: case/space-insensitive city plus state, so two cities with the same name in different states differ.
create function ogevia.city_key(p_city text, p_state text)
returns text
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select case when nullif(btrim(coalesce(p_city, '')), '') is null then null
              else lower(regexp_replace(btrim(p_city), '\s+', ' ', 'g')) || '|' || upper(coalesce(nullif(btrim(p_state), ''), 'CA')) end;
$$;

-- The shift's service city: its own (set by the office) or, when none, the client's city. NEVER the managing office's city.
create function ogevia.shift_city(p_shift_id uuid)
returns table (city text, state text, city_key text)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(nullif(btrim(s.service_city), ''), nullif(btrim(c.city), '')),
         coalesce(s.service_state, 'CA'),
         ogevia.city_key(coalesce(nullif(btrim(s.service_city), ''), nullif(btrim(c.city), '')), coalesce(s.service_state, 'CA'))
  from ogevia.shifts s join ogevia.clients c on c.id = s.client_id and c.organization_id = s.organization_id
  where s.id = p_shift_id;
$$;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 2. Caregiver coverage cities
------------------------------------------------------------------------------------------------------------------------------------------------------
create table ogevia.caregiver_coverage_cities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  city text not null check (length(btrim(city)) between 2 and 80),
  state text not null default 'CA' check (state ~ '^[A-Z]{2}$'),
  city_key text not null,
  created_by uuid references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references ogevia.app_users(id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);
create unique index caregiver_coverage_cities_one_active on ogevia.caregiver_coverage_cities (caregiver_record_id, city_key) where removed_at is null;
create index caregiver_coverage_cities_org_key on ogevia.caregiver_coverage_cities (organization_id, city_key) where removed_at is null;
create trigger caregiver_coverage_cities_no_delete before delete on ogevia.caregiver_coverage_cities for each row execute function ogevia.forbid_delete();
alter table ogevia.caregiver_coverage_cities enable row level security;
create policy readonly_select on ogevia.caregiver_coverage_cities for select to ogevia_readonly using (true);
grant select on ogevia.caregiver_coverage_cities to ogevia_readonly;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 3. Agency settings, usage, consent, office contacts (all per agency)
------------------------------------------------------------------------------------------------------------------------------------------------------
create table ogevia.agency_open_shift_settings (
  organization_id uuid primary key references ogevia.organizations(id),
  open_shifts_enabled boolean not null default true,
  -- Platform-controlled (no API function sets these): subscription entitlement and the verified sender mapped to THIS agency only.
  sms_entitled boolean not null default false,
  sender_status text not null default 'unverified' check (sender_status in ('unverified', 'verified', 'suspended')),
  sender_number text check (sender_number is null or sender_number ~ '^\+[1-9][0-9]{7,14}$'),
  -- Agency-controlled.
  sms_enabled boolean not null default false,
  sms_display_name text check (sms_display_name is null or length(btrim(sms_display_name)) between 2 and 60),
  monthly_send_limit integer not null default 100 check (monthly_send_limit between 0 and 100000),
  alert_window_days integer not null default 14 check (alert_window_days between 1 and 60),
  quiet_start time not null default '21:00',
  quiet_end time not null default '07:00',
  quiet_bypass boolean not null default false,
  urgent_hours integer not null default 48 check (urgent_hours between 1 and 336),
  escalation_hours integer not null default 24 check (escalation_hours between 1 and 168),
  office_open time not null default '08:00',
  office_close time not null default '18:00',
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table ogevia.agency_open_shift_settings enable row level security;
create policy readonly_select on ogevia.agency_open_shift_settings for select to ogevia_readonly using (true);
grant select on ogevia.agency_open_shift_settings to ogevia_readonly;
-- The sender number identifies exactly one agency (a toll-free number belongs to a single business).
create unique index agency_open_shift_settings_sender_unique on ogevia.agency_open_shift_settings (sender_number) where sender_number is not null;

create table ogevia.agency_sms_usage (
  organization_id uuid not null references ogevia.organizations(id),
  period_start date not null,
  sent_count integer not null default 0,
  segment_count integer not null default 0,
  blocked_count integer not null default 0,
  failed_count integer not null default 0,
  cost_micros bigint not null default 0,
  primary key (organization_id, period_start)
);
alter table ogevia.agency_sms_usage enable row level security;
create policy readonly_select on ogevia.agency_sms_usage for select to ogevia_readonly using (true);
grant select on ogevia.agency_sms_usage to ogevia_readonly;

create table ogevia.caregiver_sms_consent (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  status text not null check (status in ('opted_in', 'opted_out')),
  consent_at timestamptz,
  consent_source text,
  opted_out_at timestamptz,
  opt_out_source text,
  first_message_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, caregiver_record_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);
create index caregiver_sms_consent_phone on ogevia.caregiver_sms_consent (organization_id, phone_e164);
alter table ogevia.caregiver_sms_consent enable row level security;
-- No readonly policy: phone numbers are not exposed to reporting roles.

create table ogevia.caregiver_sms_consent_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  event text not null check (event in ('opted_in', 'opted_out')),
  source text not null,
  created_at timestamptz not null default now()
);
create trigger caregiver_sms_consent_events_no_delete before delete on ogevia.caregiver_sms_consent_events for each row execute function ogevia.forbid_delete();
alter table ogevia.caregiver_sms_consent_events enable row level security;

create table ogevia.office_notification_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  label text not null check (length(btrim(label)) between 2 and 80),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email text check (email is null or (length(email) <= 200 and email ~ '^[^@\s]+@[^@\s]+$')),
  notify_sms boolean not null default true,
  notify_email boolean not null default false,
  is_on_call boolean not null default false,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index office_notification_contacts_one_on_call on ogevia.office_notification_contacts (organization_id) where is_on_call and active;
create trigger office_notification_contacts_no_delete before delete on ogevia.office_notification_contacts for each row execute function ogevia.forbid_delete();
alter table ogevia.office_notification_contacts enable row level security;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 4. Coverage rounds (posting state) and request changes
------------------------------------------------------------------------------------------------------------------------------------------------------
create table ogevia.shift_coverage_rounds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  shift_id uuid not null references ogevia.shifts(id) on delete cascade,
  round_no integer not null check (round_no >= 1),
  state text not null check (state in ('unposted', 'posted', 'closed')),
  open_source text not null check (open_source in ('manual', 'callout', 'replacement_callout')),
  opened_at timestamptz not null default now(),
  opened_by uuid,
  posted_at timestamptz,
  posted_by uuid,
  unposted_at timestamptz,
  unposted_by uuid,
  former_caregiver_record_id uuid,
  callout_reason text,
  closed_at timestamptz,
  closed_reason text check (closed_reason in ('filled', 'client_cancelled', 'expired', 'invalid', 'new_round')),
  recruit_planned_at timestamptz,
  recipients_planned integer,
  escalated_at timestamptz,
  unique (shift_id, round_no),
  constraint shift_coverage_rounds_closed_shape check ((state = 'closed') = (closed_at is not null))
);
create unique index shift_coverage_rounds_one_open on ogevia.shift_coverage_rounds (shift_id) where state <> 'closed';
create index shift_coverage_rounds_org_open on ogevia.shift_coverage_rounds (organization_id) where state <> 'closed';
alter table ogevia.shift_coverage_rounds enable row level security;
create policy readonly_select on ogevia.shift_coverage_rounds for select to ogevia_readonly using (true);
grant select on ogevia.shift_coverage_rounds to ogevia_readonly;

do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'ogevia.shift_pickup_requests'::regclass and contype = 'c'
            and pg_get_constraintdef(oid) like '%superseded%' loop
    execute format('alter table ogevia.shift_pickup_requests drop constraint %I', c.conname);
  end loop;
end $$;
alter table ogevia.shift_pickup_requests
  add constraint shift_pickup_requests_status_check
    check (status in ('pending', 'confirmed', 'declined', 'withdrawn', 'superseded', 'invalidated', 'closed')),
  add column round_id uuid references ogevia.shift_coverage_rounds(id),
  add column request_seq bigint generated by default as identity,
  add column approved_order_position integer,
  add column skipped_earlier_reason text;
create index shift_pickup_requests_shift_seq on ogevia.shift_pickup_requests (shift_id, request_seq);

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 5. Notification jobs (durable intent, written in the same transaction as the event)
------------------------------------------------------------------------------------------------------------------------------------------------------
create table ogevia.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  purpose text not null check (purpose in ('open_shift', 'callout_receipt', 'office_callout', 'client_cancel', 'assignment_confirmed', 'office_escalation')),
  shift_id uuid not null references ogevia.shifts(id) on delete cascade,
  round_id uuid references ogevia.shift_coverage_rounds(id) on delete cascade,
  recipient_kind text not null check (recipient_kind in ('caregiver', 'office_contact')),
  recipient_caregiver_record_id uuid,
  recipient_contact_id uuid references ogevia.office_notification_contacts(id),
  dedupe_key text not null,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'accepted', 'delivered', 'failed', 'suppressed', 'unknown')),
  suppress_reason text,
  not_before timestamptz not null default now(),
  attempts integer not null default 0,
  claim_token uuid,
  claimed_at timestamptz,
  provider_message_id text,
  segments integer,
  cost_micros bigint,
  last_error_code text,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, dedupe_key),
  constraint notification_jobs_recipient_shape check (
    (recipient_kind = 'caregiver' and recipient_caregiver_record_id is not null and recipient_contact_id is null)
    or (recipient_kind = 'office_contact' and recipient_contact_id is not null and recipient_caregiver_record_id is null))
);
create index notification_jobs_due on ogevia.notification_jobs (not_before) where status = 'queued';
create index notification_jobs_round on ogevia.notification_jobs (round_id) where round_id is not null;
create index notification_jobs_provider on ogevia.notification_jobs (provider_message_id) where provider_message_id is not null;
alter table ogevia.notification_jobs enable row level security;
create policy readonly_select on ogevia.notification_jobs for select to ogevia_readonly using (true);
grant select (id, organization_id, purpose, shift_id, round_id, recipient_kind, status, suppress_reason, segments, sent_at, delivered_at, created_at)
  on ogevia.notification_jobs to ogevia_readonly;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 6. Settings rows always exist (backfill + trigger), helpers
------------------------------------------------------------------------------------------------------------------------------------------------------
insert into ogevia.agency_open_shift_settings (organization_id) select o.id from ogevia.organizations o on conflict do nothing;

create function ogevia.organizations_default_open_shift_settings()
returns trigger
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
begin
  insert into ogevia.agency_open_shift_settings (organization_id) values (new.id) on conflict do nothing;
  return null;
end;
$$;
revoke all on function ogevia.organizations_default_open_shift_settings() from public;
create trigger organizations_default_open_shift_settings after insert on ogevia.organizations
for each row execute function ogevia.organizations_default_open_shift_settings();

create function ogevia.sms_available(p_organization_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce((select s.sms_entitled and s.sms_enabled and s.sender_status = 'verified' and s.sender_number is not null
                   from ogevia.agency_open_shift_settings s where s.organization_id = p_organization_id), false);
$$;

-- "Fri Nov 27, 1:30-5:00 PM" in the agency's time zone; an overnight shift shows both dates.
create function ogevia.fmt_sms_when(p_starts timestamptz, p_ends timestamptz, p_tz text)
returns text
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  s timestamp := p_starts at time zone p_tz;
  e timestamp := p_ends at time zone p_tz;
  v_start text;
begin
  if s::date <> e::date then
    return to_char(s, 'Dy Mon FMDD, FMHH12:MI AM') || '-' || to_char(e, 'Dy Mon FMDD, FMHH12:MI AM');
  end if;
  v_start := to_char(s, 'FMHH12:MI');
  if to_char(s, 'AM') <> to_char(e, 'AM') then v_start := v_start || ' ' || to_char(s, 'AM'); end if;
  return to_char(s, 'Dy Mon FMDD') || ', ' || v_start || '-' || to_char(e, 'FMHH12:MI AM');
end;
$$;

-- The caregiver record of the signed-in caregiver in this agency (same selection the 0063 pickup uses).
create function ogevia.actor_caregiver_record(p_organization_id uuid)
returns ogevia.caregiver_records
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select cr.* from ogevia.caregiver_records cr
  where cr.organization_id = p_organization_id and cr.linked_user_id = ogevia.require_actor() and cr.deleted_at is null
  order by case when cr.status in ('active', 'ready') then 0 else 1 end, cr.updated_at desc
  limit 1;
$$;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 7. Eligibility: one function used for listing, counting, requesting, SMS recipient selection, dispatch and confirmation.
--    Empty array = eligible. Reuses the readiness gate (holds, background, CPR/TB, documents, availability, overlap, 8h/40h limits, onboarding,
--    service approval, client requirements). The legacy client-assignment gate is deliberately NOT required for the board.
------------------------------------------------------------------------------------------------------------------------------------------------------
create function ogevia.coverage_blockers(p_organization_id uuid, p_shift_id uuid, p_caregiver_record_id uuid)
returns text[]
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_s ogevia.shifts%rowtype;
  v_r ogevia.caregiver_records%rowtype;
  v_key text;
  v_out text[] := array[]::text[];
  m text;
begin
  select * into v_s from ogevia.shifts s where s.id = p_shift_id and s.organization_id = p_organization_id;
  if v_s.id is null then return array['This opening is no longer available']; end if;
  select * into v_r from ogevia.caregiver_records c where c.id = p_caregiver_record_id and c.organization_id = p_organization_id and c.deleted_at is null;
  if v_r.id is null then return array['Caregiver not found']; end if;
  if v_s.status <> 'scheduled' or v_s.starts_at <= now() or ogevia.shift_is_care_request(v_s.id) then
    return array['This opening is no longer available'];
  end if;
  if ogevia.shift_coverage_state(v_s) <> 'needs_coverage' then return array['This shift was just filled']; end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    return array['Care has already started for this shift'];
  end if;
  if v_r.status not in ('ready', 'active') then v_out := v_out || 'The Care Team profile is not active'::text; end if;
  if v_r.linked_user_id is null then v_out := v_out || 'The caregiver has no Ogevia sign-in'::text; end if;
  select c.city_key into v_key from ogevia.shift_city(v_s.id) c;
  if v_key is null then
    v_out := v_out || 'The shift has no service city'::text;
  elsif not exists (select 1 from ogevia.caregiver_coverage_cities cc
                    where cc.caregiver_record_id = v_r.id and cc.organization_id = p_organization_id and cc.removed_at is null and cc.city_key = v_key) then
    v_out := v_out || 'Not approved to work in this service city'::text;
  end if;
  if exists (select 1 from ogevia.shift_coverage_events e where e.shift_id = v_s.id and e.event_type = 'called_out' and e.original_caregiver_record_id = v_r.id) then
    v_out := v_out || 'This caregiver called out of this shift'::text;
  end if;
  for m in
    select x.message from ogevia.readiness_checks(p_organization_id, v_r.id, v_s.service_id, v_s.starts_at, v_s.ends_at, 'reschedule', v_s.id, v_s.client_id, true) x
    where x.status = 'blocked' and x.enforced order by x.check_name
  loop v_out := v_out || m; end loop;
  return v_out;
end;
$$;
revoke all on function ogevia.coverage_blockers(uuid, uuid, uuid) from public;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 8. Rounds, planning and notification intent (internal)
------------------------------------------------------------------------------------------------------------------------------------------------------
create function ogevia.coverage_open_round(p_shift_id uuid, p_source text, p_actor uuid, p_former uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_s ogevia.shifts%rowtype;
  v_id uuid;
begin
  select * into v_s from ogevia.shifts where id = p_shift_id;
  insert into ogevia.shift_coverage_rounds (organization_id, shift_id, round_no, state, open_source, opened_by, posted_at, posted_by, former_caregiver_record_id, callout_reason)
  values (v_s.organization_id, v_s.id,
          coalesce((select max(r.round_no) from ogevia.shift_coverage_rounds r where r.shift_id = v_s.id), 0) + 1,
          'posted', p_source, p_actor, now(), p_actor, p_former, p_reason)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function ogevia.coverage_open_round(uuid, text, uuid, uuid, text) from public;

-- Closes the open round of a shift (if any): suppresses unsent coverage jobs and resolves waiting requests visibly.
create function ogevia.coverage_close_round(p_shift_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_r ogevia.shift_coverage_rounds%rowtype;
begin
  select * into v_r from ogevia.shift_coverage_rounds r where r.shift_id = p_shift_id and r.state <> 'closed' for update;
  if v_r.id is null then return; end if;
  update ogevia.shift_coverage_rounds set state = 'closed', closed_at = now(), closed_reason = p_reason, unposted_at = coalesce(unposted_at, null) where id = v_r.id;
  update ogevia.notification_jobs j set status = 'suppressed', suppress_reason = 'round_closed:' || p_reason, updated_at = now()
   where j.round_id = v_r.id and j.status = 'queued' and j.purpose in ('open_shift', 'office_escalation');
  update ogevia.shift_pickup_requests q
     set status = case p_reason when 'filled' then 'superseded' when 'new_round' then 'invalidated' else 'closed' end,
         decided_at = now(),
         decision_reason = case p_reason when 'filled' then 'The shift was filled'
                                         when 'new_round' then 'Coverage reopened; request the shift again'
                                         else 'This opening is no longer available' end
   where q.shift_id = p_shift_id and q.status = 'pending' and q.round_id = v_r.id;
end;
$$;
revoke all on function ogevia.coverage_close_round(uuid, text) from public;

-- Office recipients for an immediate notice. The on-call contact is included only outside the agency's office hours.
create function ogevia.enqueue_office_notice(p_organization_id uuid, p_purpose text, p_shift_id uuid, p_round_id uuid, p_key text)
returns integer
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_set ogevia.agency_open_shift_settings%rowtype;
  v_tz text;
  v_local time;
  v_after_hours boolean;
  v_n integer := 0;
  v_rc integer;
  c record;
begin
  select * into v_set from ogevia.agency_open_shift_settings where organization_id = p_organization_id;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  v_local := (now() at time zone v_tz)::time;
  v_after_hours := not (v_local >= v_set.office_open and v_local < v_set.office_close);
  for c in select * from ogevia.office_notification_contacts k
            where k.organization_id = p_organization_id and k.active and k.notify_sms and k.phone_e164 is not null
              and (not k.is_on_call or v_after_hours)
  loop
    insert into ogevia.notification_jobs (organization_id, purpose, shift_id, round_id, recipient_kind, recipient_contact_id, dedupe_key)
    values (p_organization_id, p_purpose, p_shift_id, p_round_id, 'office_contact', c.id, p_purpose || '|' || p_key || '|' || c.id)
    on conflict (organization_id, dedupe_key) do nothing;
    get diagnostics v_rc = row_count;
    v_n := v_n + v_rc;
  end loop;
  return v_n;
end;
$$;
revoke all on function ogevia.enqueue_office_notice(uuid, text, uuid, uuid, text) from public;

-- Recruitment texts: one per tenant, round and eligible, opted-in caregiver (a phone shared by two caregivers is texted once). Planned only once the shift is
-- inside the agency's alert window; whatever the round's state later, a round is planned at most once, so turning SMS on never texts old openings.
create function ogevia.coverage_plan_round(p_round_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_r ogevia.shift_coverage_rounds%rowtype;
  v_s ogevia.shifts%rowtype;
  v_set ogevia.agency_open_shift_settings%rowtype;
  v_n integer := 0;
  v_rc integer;
  c record;
begin
  select * into v_r from ogevia.shift_coverage_rounds where id = p_round_id for update;
  if v_r.id is null or v_r.state <> 'posted' or v_r.recruit_planned_at is not null then return; end if;
  select * into v_s from ogevia.shifts where id = v_r.shift_id;
  if v_s.status <> 'scheduled' or v_s.starts_at <= now() then return; end if;
  select * into v_set from ogevia.agency_open_shift_settings where organization_id = v_r.organization_id;
  if v_s.starts_at > now() + make_interval(days => v_set.alert_window_days) then return; end if;
  if (select c2.city_key from ogevia.shift_city(v_s.id) c2) is null then return; end if;
  if not ogevia.sms_available(v_r.organization_id) then
    update ogevia.shift_coverage_rounds set recruit_planned_at = now(), recipients_planned = 0 where id = v_r.id;
    return;
  end if;
  for c in
    select distinct on (k.phone_e164) k.caregiver_record_id
      from ogevia.caregiver_sms_consent k
     where k.organization_id = v_r.organization_id and k.status = 'opted_in'
     order by k.phone_e164, k.consent_at nulls last, k.caregiver_record_id
  loop
    if cardinality(ogevia.coverage_blockers(v_r.organization_id, v_s.id, c.caregiver_record_id)) = 0 then
      insert into ogevia.notification_jobs (organization_id, purpose, shift_id, round_id, recipient_kind, recipient_caregiver_record_id, dedupe_key)
      values (v_r.organization_id, 'open_shift', v_s.id, v_r.id, 'caregiver', c.caregiver_record_id, 'open_shift|' || v_r.id || '|' || c.caregiver_record_id)
      on conflict (organization_id, dedupe_key) do nothing;
      get diagnostics v_rc = row_count;
      v_n := v_n + v_rc;
    end if;
  end loop;
  update ogevia.shift_coverage_rounds set recruit_planned_at = now(), recipients_planned = v_n where id = v_r.id;
end;
$$;
revoke all on function ogevia.coverage_plan_round(uuid) from public;

-- Urgent office alert once per round when an unfilled opening is within the escalation window (immediately if posted inside it).
create function ogevia.coverage_escalate_if_due(p_round_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_r ogevia.shift_coverage_rounds%rowtype;
  v_s ogevia.shifts%rowtype;
  v_set ogevia.agency_open_shift_settings%rowtype;
begin
  select * into v_r from ogevia.shift_coverage_rounds where id = p_round_id for update;
  if v_r.id is null or v_r.state = 'closed' or v_r.escalated_at is not null then return; end if;
  select * into v_s from ogevia.shifts where id = v_r.shift_id;
  if v_s.status <> 'scheduled' or v_s.starts_at <= now() then return; end if;
  select * into v_set from ogevia.agency_open_shift_settings where organization_id = v_r.organization_id;
  if v_s.starts_at > now() + make_interval(hours => v_set.escalation_hours) then return; end if;
  update ogevia.shift_coverage_rounds set escalated_at = now() where id = v_r.id;
  perform ogevia.enqueue_office_notice(v_r.organization_id, 'office_escalation', v_s.id, v_r.id, v_r.id::text);
end;
$$;
revoke all on function ogevia.coverage_escalate_if_due(uuid) from public;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 9. Triggers: the same transaction as the event that causes them
------------------------------------------------------------------------------------------------------------------------------------------------------
-- A call-out (self-service or entered by staff) reposts the SAME shift in a new round and queues the receipt and office notice.
create function ogevia.coverage_on_coverage_event()
returns trigger
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_round uuid;
  v_src text;
begin
  if ogevia.shift_is_care_request(new.shift_id) then return null; end if;
  if new.event_type = 'reassigned' then
    perform ogevia.coverage_close_round(new.shift_id, 'filled');
    return null;
  end if;
  -- called_out
  perform ogevia.coverage_close_round(new.shift_id, 'new_round');
  v_src := case when exists (select 1 from ogevia.shift_coverage_rounds r where r.shift_id = new.shift_id) then 'replacement_callout' else 'callout' end;
  v_round := ogevia.coverage_open_round(new.shift_id, v_src, new.actor_user_id, new.original_caregiver_record_id, new.reason);
  if new.original_caregiver_record_id is not null then
    insert into ogevia.notification_jobs (organization_id, purpose, shift_id, round_id, recipient_kind, recipient_caregiver_record_id, dedupe_key)
    values (new.organization_id, 'callout_receipt', new.shift_id, v_round, 'caregiver', new.original_caregiver_record_id, 'callout_receipt|' || new.id || '|' || new.original_caregiver_record_id)
    on conflict (organization_id, dedupe_key) do nothing;
  end if;
  perform ogevia.enqueue_office_notice(new.organization_id, 'office_callout', new.shift_id, v_round, new.id::text);
  perform ogevia.write_audit(new.organization_id, 'shift.coverage_auto_posted', 'shifts', new.shift_id, null,
    jsonb_build_object('round_id', v_round, 'source', v_src), 'Caregiver call-out reposted the shift for coverage');
  perform ogevia.coverage_plan_round(v_round);
  perform ogevia.coverage_escalate_if_due(v_round);
  return null;
end;
$$;
revoke all on function ogevia.coverage_on_coverage_event() from public;
create trigger shift_coverage_events_open_round after insert on ogevia.shift_coverage_events
for each row execute function ogevia.coverage_on_coverage_event();

-- Replaces the 0063 trigger function: board requests are closed by their round with the right outcome (filled -> superseded, cancelled/ended/unposted -> closed);
-- requests that predate the board keep the 0063 statuses.
-- a client cancellation closes the round and tells the assigned caregiver, and a change of date, time or city invalidates waiting requests.
create or replace function ogevia.shifts_close_pickups()
returns trigger
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_old_key text;
  v_new_key text;
  v_client_city text;
begin
  if new.status <> 'scheduled' and old.status = 'scheduled' then
    perform ogevia.coverage_close_round(new.id, case when new.status = 'cancelled' then 'client_cancelled' else 'invalid' end);
    if new.status = 'cancelled' and old.caregiver_record_id is not null and not ogevia.shift_is_called_out(new.id) then
      insert into ogevia.notification_jobs (organization_id, purpose, shift_id, recipient_kind, recipient_caregiver_record_id, dedupe_key)
      values (new.organization_id, 'client_cancel', new.id, 'caregiver', old.caregiver_record_id, 'client_cancel|' || new.id || '|' || old.caregiver_record_id)
      on conflict (organization_id, dedupe_key) do nothing;
    end if;
  end if;
  if new.status <> 'scheduled' and exists (select 1 from ogevia.shift_pickup_requests r where r.shift_id = new.id and r.status = 'pending') then
    update ogevia.shift_pickup_requests r
       set status = 'superseded', decided_at = now(), decision_reason = 'The shift is no longer scheduled'
     where r.shift_id = new.id and r.status = 'pending';
  elsif new.caregiver_record_id is not null and not ogevia.shift_is_called_out(new.id)
        and exists (select 1 from ogevia.shift_pickup_requests r where r.shift_id = new.id and r.status = 'pending') then
    update ogevia.shift_pickup_requests r
       set status = 'superseded', decided_at = now(), decision_reason = 'The shift was filled'
     where r.shift_id = new.id and r.status = 'pending';
  end if;
  -- Date, time or service city changed while the opening is open: waiting requests no longer describe the shift.
  if new.status = 'scheduled' and (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
       or new.service_city is distinct from old.service_city or new.service_state is distinct from old.service_state) then
    select c.city into v_client_city from ogevia.clients c where c.id = new.client_id;
    v_old_key := ogevia.city_key(coalesce(nullif(btrim(old.service_city), ''), v_client_city), coalesce(old.service_state, 'CA'));
    v_new_key := ogevia.city_key(coalesce(nullif(btrim(new.service_city), ''), v_client_city), coalesce(new.service_state, 'CA'));
    if new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at or v_old_key is distinct from v_new_key then
      update ogevia.shift_pickup_requests r
         set status = 'invalidated', decided_at = now(), decision_reason = 'The shift changed; review the new details and request it again'
       where r.shift_id = new.id and r.status = 'pending';
    end if;
  end if;
  return null;
end;
$$;
drop trigger shifts_close_pickups on ogevia.shifts;
create trigger shifts_close_pickups after update of status, caregiver_record_id, caregiver_user_id, starts_at, ends_at, service_city, service_state on ogevia.shifts
for each row execute function ogevia.shifts_close_pickups();

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 10. Office actions: post, unpost, service city
------------------------------------------------------------------------------------------------------------------------------------------------------
create function ogevia_api.post_shift_for_coverage(p_organization_id uuid, p_shift_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_s ogevia.shifts%rowtype;
  v_r ogevia.shift_coverage_rounds%rowtype;
  v_round uuid;
  v_city record;
begin
  v_s := ogevia.lock_staff_shift(p_organization_id, p_shift_id);
  if v_s.ends_at <= now() then raise exception 'This shift is already over' using errcode = 'OGC09'; end if;
  if ogevia.shift_coverage_state(v_s) <> 'needs_coverage' then
    raise exception 'This shift has a caregiver. Record a call-out first.' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit has already started for this shift' using errcode = 'OGC09';
  end if;
  select * into v_r from ogevia.shift_coverage_rounds r where r.shift_id = v_s.id and r.state <> 'closed' for update;
  if v_r.id is not null and v_r.state = 'posted' then return 'posted'; end if;
  if v_r.id is not null then
    -- Repost reuses the round; messages suppressed by the unpost are released (still one per caregiver for the round).
    update ogevia.shift_coverage_rounds set state = 'posted', posted_at = now(), posted_by = v_actor where id = v_r.id;
    update ogevia.notification_jobs set status = 'queued', suppress_reason = null, updated_at = now()
     where round_id = v_r.id and status = 'suppressed' and suppress_reason = 'unposted';
    v_round := v_r.id;
  else
    v_round := ogevia.coverage_open_round(v_s.id, 'manual', v_actor, null, null);
  end if;
  -- Keep the city the office saw when it posted (a later change to the client record does not silently move the opening).
  if v_s.service_city is null then
    select c.city, c.state into v_city from ogevia.shift_city(v_s.id) c;
    if v_city.city is not null then
      update ogevia.shifts set service_city = v_city.city, service_state = v_city.state where id = v_s.id;
    end if;
  end if;
  perform ogevia.write_audit(p_organization_id, 'shift.coverage_posted', 'shifts', v_s.id, null, jsonb_build_object('round_id', v_round), 'Posted for coverage');
  perform ogevia.coverage_plan_round(v_round);
  perform ogevia.coverage_escalate_if_due(v_round);
  return 'posted';
end;
$$;

create function ogevia_api.unpost_shift(p_organization_id uuid, p_shift_id uuid, p_reason text default null)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_s ogevia.shifts%rowtype;
  v_r ogevia.shift_coverage_rounds%rowtype;
begin
  v_s := ogevia.lock_staff_shift(p_organization_id, p_shift_id);
  select * into v_r from ogevia.shift_coverage_rounds r where r.shift_id = v_s.id and r.state = 'posted' for update;
  if v_r.id is null then return 'not_posted'; end if;
  update ogevia.shift_coverage_rounds set state = 'unposted', unposted_at = now(), unposted_by = v_actor where id = v_r.id;
  update ogevia.shift_pickup_requests set status = 'closed', decided_at = now(), decided_by = v_actor, decision_reason = 'The office took this opening off the board'
   where shift_id = v_s.id and status = 'pending';
  update ogevia.notification_jobs set status = 'suppressed', suppress_reason = 'unposted', updated_at = now()
   where round_id = v_r.id and status = 'queued' and purpose in ('open_shift', 'office_escalation');
  perform ogevia.write_audit(p_organization_id, 'shift.coverage_unposted', 'shifts', v_s.id, null, jsonb_build_object('round_id', v_r.id), nullif(btrim(coalesce(p_reason, '')), ''));
  return 'unposted';
end;
$$;

create function ogevia_api.set_shift_service_city(p_organization_id uuid, p_shift_id uuid, p_city text, p_state text default 'CA')
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_s ogevia.shifts%rowtype;
  v_city text := nullif(btrim(coalesce(p_city, '')), '');
  v_state text := upper(coalesce(nullif(btrim(p_state), ''), 'CA'));
  v_round uuid;
begin
  if v_city is null or length(v_city) not between 2 and 80 then raise exception 'Enter the service city' using errcode = 'OGV22'; end if;
  if v_state !~ '^[A-Z]{2}$' then raise exception 'Enter the two-letter state' using errcode = 'OGV22'; end if;
  v_s := ogevia.lock_staff_shift(p_organization_id, p_shift_id);
  update ogevia.shifts set service_city = v_city, service_state = v_state, updated_at = now() where id = v_s.id;
  perform ogevia.write_audit(p_organization_id, 'shift.service_city_set', 'shifts', v_s.id,
    jsonb_build_object('city', v_s.service_city, 'state', v_s.service_state), jsonb_build_object('city', v_city, 'state', v_state), null);
  select r.id into v_round from ogevia.shift_coverage_rounds r where r.shift_id = v_s.id and r.state = 'posted';
  if v_round is not null then perform ogevia.coverage_plan_round(v_round); end if;
  return 'ok';
end;
$$;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 11. Caregiver board (privacy-limited: service city, local time and request status only; an opaque reference, never an id, code or address)
------------------------------------------------------------------------------------------------------------------------------------------------------
create function ogevia_api.list_open_shift_board(p_organization_id uuid, p_limit integer default 50, p_offset integer default 0)
returns table (shift_ref uuid, service_city text, starts_at timestamptz, ends_at timestamptz, timezone text, my_request_status text, total_count bigint)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_rec ogevia.caregiver_records%rowtype;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) or not ogevia.is_active_caregiver(p_organization_id) then
    return;
  end if;
  if not (select st.open_shifts_enabled from ogevia.agency_open_shift_settings st where st.organization_id = p_organization_id) then return; end if;
  v_rec := ogevia.actor_caregiver_record(p_organization_id);
  if v_rec.id is null then return; end if;
  return query
    with cand as (
      select s.public_ref, (select c.city from ogevia.shift_city(s.id) c) as city, s.starts_at, s.ends_at,
             (select 'requested' from ogevia.shift_pickup_requests q
               where q.shift_id = s.id and q.status = 'pending' and q.caregiver_record_id = v_rec.id limit 1) as mine
        from ogevia.shift_coverage_rounds r
        join ogevia.shifts s on s.id = r.shift_id
       where r.organization_id = p_organization_id and r.state = 'posted'
         and s.status = 'scheduled' and s.starts_at > now()
         and cardinality(ogevia.coverage_blockers(p_organization_id, s.id, v_rec.id)) = 0
    )
    select cand.public_ref, cand.city, cand.starts_at, cand.ends_at,
           (select o.timezone from ogevia.organizations o where o.id = p_organization_id), cand.mine, count(*) over ()
      from cand
     order by cand.starts_at, cand.public_ref
     limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0));
end;
$$;

-- The landing for a text link: the current safe status of one opening, identical for "never existed", "other agency" and "not for you".
create function ogevia_api.get_open_shift(p_organization_id uuid, p_shift_ref uuid)
returns table (shift_ref uuid, state text, service_city text, starts_at timestamptz, ends_at timestamptz, timezone text)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_s ogevia.shifts%rowtype;
  v_req text;
  v_tz text;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) or not ogevia.is_active_caregiver(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  v_rec := ogevia.actor_caregiver_record(p_organization_id);
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  select * into v_s from ogevia.shifts s where s.public_ref = p_shift_ref and s.organization_id = p_organization_id;
  if v_s.id is null or v_rec.id is null then
    return query select p_shift_ref, 'unavailable'::text, null::text, null::timestamptz, null::timestamptz, null::text; return;
  end if;
  select q.status into v_req from ogevia.shift_pickup_requests q where q.shift_id = v_s.id and q.caregiver_record_id = v_rec.id order by q.request_seq desc limit 1;
  if exists (select 1 from ogevia.shift_coverage_rounds r where r.shift_id = v_s.id and r.state = 'posted')
     and cardinality(ogevia.coverage_blockers(p_organization_id, v_s.id, v_rec.id)) = 0 then
    return query select v_s.public_ref, case when v_req = 'pending' then 'requested' else 'available' end, (select c.city from ogevia.shift_city(v_s.id) c), v_s.starts_at, v_s.ends_at, v_tz;
  elsif v_req is not null then
    return query select v_s.public_ref,
      case v_req when 'pending' then 'requested' when 'confirmed' then 'confirmed' when 'superseded' then 'filled' when 'invalidated' then 'changed' else 'unavailable' end,
      case when v_req in ('confirmed', 'pending', 'invalidated') then (select c.city from ogevia.shift_city(v_s.id) c) end,
      case when v_req in ('confirmed', 'pending', 'invalidated') then v_s.starts_at end,
      case when v_req in ('confirmed', 'pending', 'invalidated') then v_s.ends_at end, v_tz;
  else
    return query select p_shift_ref, 'unavailable'::text, null::text, null::timestamptz, null::timestamptz, null::text;
  end if;
end;
$$;

create function ogevia_api.request_open_shift(p_organization_id uuid, p_shift_ref uuid, p_idempotency_key uuid default null)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_shift_ref);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_s ogevia.shifts%rowtype;
  v_round ogevia.shift_coverage_rounds%rowtype;
  v_block text[];
  v_id uuid;
  v_gone constant text := 'This opening is no longer available';
begin
  if not ogevia.is_active_member(p_organization_id) or not ogevia.is_active_caregiver(p_organization_id) then
    raise exception 'Only an active caregiver can ask for a shift' using errcode = 'OGA03';
  end if;
  if not (select st.open_shifts_enabled from ogevia.agency_open_shift_settings st where st.organization_id = p_organization_id) then
    raise exception '%', v_gone using errcode = 'OGC09';
  end if;
  v_rec := ogevia.actor_caregiver_record(p_organization_id);
  if v_rec.id is null or v_rec.status not in ('active', 'ready') then
    raise exception 'Your Care Team profile is not active. Contact your agency manager before asking for a shift.' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('request_open_shift', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'state'; end if;
  select * into v_s from ogevia.shifts s where s.public_ref = p_shift_ref and s.organization_id = p_organization_id for update;
  if v_s.id is null then raise exception '%', v_gone using errcode = 'OGC09'; end if;
  select * into v_round from ogevia.shift_coverage_rounds r where r.shift_id = v_s.id and r.state = 'posted';
  if v_round.id is null then raise exception '%', v_gone using errcode = 'OGC09'; end if;
  v_block := ogevia.coverage_blockers(p_organization_id, v_s.id, v_rec.id);
  if cardinality(v_block) > 0 then
    -- A shift outside this caregiver's cities is not theirs to see: same answer as a shift that does not exist.
    if v_block[1] in ('Not approved to work in this service city', 'The shift has no service city', 'This opening is no longer available') then
      raise exception '%', v_gone using errcode = 'OGC09';
    end if;
    raise exception '%', v_block[1] using errcode = 'OGC09';
  end if;
  insert into ogevia.shift_pickup_requests (organization_id, shift_id, caregiver_record_id, requested_by, round_id)
  values (p_organization_id, v_s.id, v_rec.id, v_actor, v_round.id)
  on conflict (shift_id, caregiver_record_id) where status = 'pending' do nothing
  returning id into v_id;
  if v_id is not null then
    perform ogevia.write_audit(p_organization_id, 'shift.pickup_requested', 'shifts', v_s.id, null,
      jsonb_build_object('request_id', v_id, 'caregiver_record_id', v_rec.id, 'round_id', v_round.id), 'Open shift requested by caregiver');
  end if;
  perform ogevia.idempotency_finish('request_open_shift', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'requested'));
  return 'requested';
end;
$$;

create function ogevia_api.withdraw_open_shift_request(p_organization_id uuid, p_shift_ref uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare v_shift uuid;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  select s.id into v_shift from ogevia.shifts s where s.public_ref = p_shift_ref and s.organization_id = p_organization_id;
  if v_shift is null then raise exception 'You have no waiting request for this shift' using errcode = 'OGN04'; end if;
  return ogevia_api.withdraw_my_shift_pickup(p_organization_id, v_shift);
end;
$$;

-- The caregiver's own request outcomes (Requested / Confirmed / Filled / Changed / Closed), city and time only.
create function ogevia_api.list_my_open_shift_requests(p_organization_id uuid)
returns table (shift_ref uuid, outcome text, service_city text, starts_at timestamptz, ends_at timestamptz, timezone text, requested_at timestamptz)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select s.public_ref,
         case q.status when 'pending' then 'requested' when 'confirmed' then 'confirmed' when 'superseded' then 'filled' when 'invalidated' then 'changed'
                       when 'withdrawn' then 'withdrawn' when 'declined' then 'declined' else 'closed' end,
         (select c.city from ogevia.shift_city(s.id) c), s.starts_at, s.ends_at, o.timezone, q.requested_at
  from ogevia.shift_pickup_requests q
  join ogevia.shifts s on s.id = q.shift_id
  join ogevia.organizations o on o.id = q.organization_id
  join ogevia.caregiver_records cr on cr.id = q.caregiver_record_id and cr.organization_id = q.organization_id
  where q.organization_id = p_organization_id and q.round_id is not null
    and ogevia.require_actor() is not null and ogevia.is_active_member(p_organization_id) and ogevia.is_active_caregiver(p_organization_id)
    and cr.linked_user_id = ogevia.require_actor()
    and s.ends_at > now() - interval '7 days'
  order by s.starts_at, q.request_seq;
$$;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 12. Office queue, ordered requests, confirmation
------------------------------------------------------------------------------------------------------------------------------------------------------
create function ogevia_api.list_coverage_queue(p_organization_id uuid)
returns table (
  shift_id uuid, shift_ref uuid, starts_at timestamptz, ends_at timestamptz, timezone text, service_city text, client_code text,
  posting_state text, round_no integer, open_source text, former_caregiver_code text, urgent boolean, request_count integer,
  delivery jsonb, escalation_reasons text[]
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_set ogevia.agency_open_shift_settings%rowtype;
  v_tz text;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) or not ogevia.has_permission(p_organization_id, 'shifts.manage') then
    return;
  end if;
  select * into v_set from ogevia.agency_open_shift_settings where organization_id = p_organization_id;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  return query
    select s.id, s.public_ref, s.starts_at, s.ends_at, v_tz,
           (select c.city from ogevia.shift_city(s.id) c),
           coalesce(nullif(btrim(cl.caregiver_display_code), ''), cl.client_code),
           case when r.id is null then 'not_posted' else r.state end,
           r.round_no, r.open_source,
           (select cr.caregiver_code from ogevia.caregiver_records cr where cr.id = r.former_caregiver_record_id),
           s.starts_at <= now() + make_interval(hours => v_set.urgent_hours),
           (select count(*)::integer from ogevia.shift_pickup_requests q where q.shift_id = s.id and q.status = 'pending'),
           jsonb_build_object(
             'queued', (select count(*) from ogevia.notification_jobs j where j.round_id = r.id and j.purpose = 'open_shift' and j.status in ('queued', 'claimed')),
             'sent', (select count(*) from ogevia.notification_jobs j where j.round_id = r.id and j.purpose = 'open_shift' and j.status = 'accepted'),
             'delivered', (select count(*) from ogevia.notification_jobs j where j.round_id = r.id and j.purpose = 'open_shift' and j.status = 'delivered'),
             'failed', (select count(*) from ogevia.notification_jobs j where j.round_id = r.id and j.purpose = 'open_shift' and j.status = 'failed'),
             'unknown', (select count(*) from ogevia.notification_jobs j where j.round_id = r.id and j.purpose = 'open_shift' and j.status = 'unknown'),
             'suppressed', (select count(*) from ogevia.notification_jobs j where j.round_id = r.id and j.purpose = 'open_shift' and j.status = 'suppressed'),
             'suppressed_by', coalesce((select jsonb_object_agg(x.suppress_reason, x.n) from (
                 select j.suppress_reason, count(*) n from ogevia.notification_jobs j
                  where j.round_id = r.id and j.purpose = 'open_shift' and j.status = 'suppressed' group by j.suppress_reason) x), '{}'::jsonb)),
           array_remove(array[
             case when (select c.city_key from ogevia.shift_city(s.id) c) is null then 'missing_city' end,
             case when r.state = 'posted' and r.recruit_planned_at is not null and coalesce(r.recipients_planned, 0) = 0 then 'no_recipients' end,
             case when r.state = 'posted' and not ogevia.sms_available(p_organization_id) then 'sms_unavailable' end,
             case when r.state = 'posted' and r.recipients_planned > 0
                   and not exists (select 1 from ogevia.notification_jobs j where j.round_id = r.id and j.purpose = 'open_shift' and j.status in ('queued', 'claimed', 'accepted', 'delivered'))
                  then 'all_sends_failed' end,
             case when r.escalated_at is not null or (r.id is null and s.starts_at <= now() + make_interval(hours => v_set.escalation_hours)) then 'unfilled_soon' end
           ], null)
      from ogevia.shifts s
      join ogevia.clients cl on cl.id = s.client_id
      left join ogevia.shift_coverage_rounds r on r.shift_id = s.id and r.state <> 'closed'
     where s.organization_id = p_organization_id and s.status = 'scheduled' and s.ends_at > now()
       and ogevia.shift_coverage_state(s) = 'needs_coverage' and not ogevia.shift_is_care_request(s.id)
       and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected'))
     order by s.starts_at;
end;
$$;

-- Pending requests for a shift in submission order, each with what would block it right now; the first eligible one is pre-selected.
create function ogevia_api.list_coverage_requests(p_organization_id uuid, p_shift_id uuid)
returns table (
  request_id uuid, order_position integer, requested_at timestamptz, caregiver_record_id uuid, caregiver_code text, caregiver_name text,
  eligible boolean, blockers text[], preselected boolean
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with q as (
    select r.id, row_number() over (order by r.request_seq)::integer as pos, r.requested_at, r.caregiver_record_id,
           ogevia.coverage_blockers(p_organization_id, r.shift_id, r.caregiver_record_id) as b
      from ogevia.shift_pickup_requests r
     where r.organization_id = p_organization_id and r.shift_id = p_shift_id and r.status = 'pending'
       and ogevia.require_actor() is not null and ogevia.is_active_member(p_organization_id) and ogevia.has_permission(p_organization_id, 'shifts.manage')
  )
  select q.id, q.pos, q.requested_at, q.caregiver_record_id, cr.caregiver_code,
         nullif(btrim(coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name), ''),
         cardinality(q.b) = 0, q.b,
         cardinality(q.b) = 0 and q.pos = (select min(q2.pos) from q q2 where cardinality(q2.b) = 0)
    from q join ogevia.caregiver_records cr on cr.id = q.caregiver_record_id
   order by q.pos;
$$;

-- Replaces the 0063 confirmation: a request made through the board (round_id set) does not need the legacy client-assignment record; every other
-- check (shift open, no visit, called-out, readiness gate, overlap, hours, authorization capacity) is unchanged.
create or replace function ogevia_api.confirm_shift_pickup(p_organization_id uuid, p_request_id uuid, p_idempotency_key uuid default null)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_request_id);
  v_prior jsonb;
  v_req ogevia.shift_pickup_requests%rowtype;
  v_s ogevia.shifts%rowtype;
  v_rec ogevia.caregiver_records%rowtype;
  v_res ogevia.authorization_reservations%rowtype;
  v_kind text;
begin
  v_prior := ogevia.idempotency_begin('confirm_shift_pickup', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'state'; end if;
  select * into v_req from ogevia.shift_pickup_requests r where r.id = p_request_id and r.organization_id = p_organization_id;
  if v_req.id is null then raise exception 'Pickup request not found' using errcode = 'OGN04'; end if;

  -- The shift row first (as every other assignment path does), so competing confirmations serialise here.
  v_s := ogevia.lock_staff_shift(p_organization_id, v_req.shift_id);
  select * into v_req from ogevia.shift_pickup_requests r where r.id = p_request_id for update;
  if v_req.status <> 'pending' then
    raise exception 'This request was already %. Refresh the list.', case v_req.status when 'confirmed' then 'confirmed' when 'superseded' then 'closed (the shift was filled)' else v_req.status end
      using errcode = 'OGC09';
  end if;
  if v_s.ends_at <= now() then raise exception 'This shift is already over' using errcode = 'OGC09'; end if;
  if ogevia.shift_coverage_state(v_s) <> 'needs_coverage' then raise exception 'This shift was just filled' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit has already started for this shift' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.shift_coverage_events e
             where e.shift_id = v_s.id and e.event_type = 'called_out' and e.original_caregiver_record_id = v_req.caregiver_record_id) then
    raise exception 'This caregiver called out of this shift. Choose someone else.' using errcode = 'OGC09';
  end if;
  select * into v_rec from ogevia.caregiver_records r where r.id = v_req.caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status not in ('ready', 'active') then
    raise exception 'Only caregivers who are Ready to work or Active can be scheduled' using errcode = 'OGV22';
  end if;
  if v_rec.linked_user_id is null or (v_req.round_id is null and not exists (
       select 1 from ogevia.caregiver_assignments ca
       where ca.organization_id = p_organization_id and ca.caregiver_user_id = v_rec.linked_user_id
         and ca.client_id = v_s.client_id and ca.service_id = v_s.service_id and ca.is_active
         and ogevia.organization_local_date(p_organization_id, now()) >= ca.effective_start
         and (ca.effective_end is null or ogevia.organization_local_date(p_organization_id, now()) <= ca.effective_end))) then
    raise exception 'This client and service are no longer assigned to this caregiver' using errcode = 'OGC09';
  end if;

  -- The caregiver lock, then overlap and the whole readiness gate with the client: compliance hold, background, CPR/TB, documents, availability,
  -- work-hour limits (the agency policy included), onboarding, service approval, client requirements.
  perform ogevia.lock_caregiver(v_rec.id);
  if exists (
    select 1 from ogevia.shifts s
    where s.organization_id = p_organization_id and s.id is distinct from v_s.id
      and (s.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and s.caregiver_user_id = v_rec.linked_user_id))
      and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
      and s.starts_at < v_s.ends_at and s.ends_at > v_s.starts_at) then
    raise exception 'This caregiver already has a shift at that time' using errcode = 'OGC09';
  end if;
  perform ogevia.assert_ready_for_work(p_organization_id, v_rec.id, v_s.service_id, v_s.starts_at, v_s.ends_at, 'reschedule', v_s.client_id, v_s.id);

  -- The authorization still covers the shift's reservation.
  perform ogevia.assert_shift_authorization_covered(v_s.id);
  select * into v_res from ogevia.authorization_reservations r where r.shift_id = v_s.id and r.released_at is null;

  v_kind := case when v_s.caregiver_record_id is null then 'Open shift filled: request confirmed by the office'
                 else 'Replacement after call-out: request confirmed by the office' end;
  update ogevia.shift_pickup_requests
     set status = 'confirmed', decided_at = now(), decided_by = v_actor,
         confirmation_snapshot = jsonb_build_object('reservation_id', v_res.id, 'reserved_minutes', v_res.reserved_minutes,
           'checks', array['shift_open', 'caregiver_assigned_to_client', 'readiness_gate', 'overlap', 'work_hours', 'authorization_capacity'])
   where id = v_req.id;
  insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type, actor_user_id, original_caregiver_record_id,
                                            replacement_caregiver_record_id, reason, before_snapshot, after_snapshot)
  values (p_organization_id, v_s.id, 'reassigned', v_actor, v_s.caregiver_record_id, v_rec.id, v_kind,
          jsonb_build_object('caregiver_record_id', v_s.caregiver_record_id),
          jsonb_build_object('caregiver_record_id', v_rec.id, 'pickup_request_id', v_req.id, 'reservation_id', v_res.id, 'reserved_minutes', v_res.reserved_minutes,
                             'authorization_checked', true));
  update ogevia.shifts set caregiver_record_id = v_rec.id, caregiver_user_id = v_rec.linked_user_id, updated_at = now() where id = v_s.id;
  perform ogevia.write_audit(p_organization_id, 'shift.pickup_confirmed', 'shifts', v_s.id,
    jsonb_build_object('caregiver_record_id', v_s.caregiver_record_id),
    jsonb_build_object('caregiver_record_id', v_rec.id, 'request_id', v_req.id, 'reservation_id', v_res.id, 'reserved_minutes', v_res.reserved_minutes), v_kind);
  perform ogevia.idempotency_finish('confirm_shift_pickup', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'covered'));
  return 'covered';
end;
$$;

-- Office approval: the earliest ELIGIBLE request is the default; approving anyone else needs a reason. Order position and the reason are recorded.
-- Nothing is assigned until this runs; the full confirmation (above) re-checks everything under the shift lock.
create function ogevia_api.confirm_coverage_request(p_organization_id uuid, p_request_id uuid, p_skip_reason text default null, p_idempotency_key uuid default null)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_reason text := nullif(btrim(coalesce(p_skip_reason, '')), '');
  v_fp text := concat_ws('|', p_organization_id, p_request_id);
  v_prior jsonb;
  v_req ogevia.shift_pickup_requests%rowtype;
  v_s ogevia.shifts%rowtype;
  v_first uuid;
  v_pos integer;
  v_block text[];
begin
  v_prior := ogevia.idempotency_begin('confirm_coverage_request', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'state'; end if;
  select * into v_req from ogevia.shift_pickup_requests r where r.id = p_request_id and r.organization_id = p_organization_id;
  if v_req.id is null then raise exception 'Pickup request not found' using errcode = 'OGN04'; end if;
  v_s := ogevia.lock_staff_shift(p_organization_id, v_req.shift_id);
  select * into v_req from ogevia.shift_pickup_requests r where r.id = p_request_id for update;
  if v_req.status <> 'pending' then
    raise exception 'This request was already %. Refresh the list.', v_req.status using errcode = 'OGC09';
  end if;
  if v_req.round_id is not null then
    v_block := ogevia.coverage_blockers(p_organization_id, v_s.id, v_req.caregiver_record_id);
    if cardinality(v_block) > 0 then raise exception '%', v_block[1] using errcode = 'OGC09'; end if;
  end if;
  select r.id into v_first from ogevia.shift_pickup_requests r
   where r.shift_id = v_s.id and r.status = 'pending' and cardinality(ogevia.coverage_blockers(p_organization_id, v_s.id, r.caregiver_record_id)) = 0
   order by r.request_seq limit 1;
  select count(*)::integer into v_pos from ogevia.shift_pickup_requests r where r.shift_id = v_s.id and r.status = 'pending' and r.request_seq <= v_req.request_seq;
  if v_first is not null and v_first <> v_req.id and (v_reason is null or length(v_reason) < 3) then
    raise exception 'Give the reason for choosing someone other than the earliest eligible request' using errcode = 'OGV22';
  end if;
  update ogevia.shift_pickup_requests
     set approved_order_position = v_pos, skipped_earlier_reason = case when v_first is distinct from v_req.id then v_reason end
   where id = v_req.id;
  perform ogevia_api.confirm_shift_pickup(p_organization_id, v_req.id, null);
  insert into ogevia.notification_jobs (organization_id, purpose, shift_id, round_id, recipient_kind, recipient_caregiver_record_id, dedupe_key)
  values (p_organization_id, 'assignment_confirmed', v_s.id, v_req.round_id, 'caregiver', v_req.caregiver_record_id,
          'assignment_confirmed|' || v_req.id || '|' || v_req.caregiver_record_id)
  on conflict (organization_id, dedupe_key) do nothing;
  perform ogevia.write_audit(p_organization_id, 'shift.coverage_request_approved', 'shifts', v_s.id, null,
    jsonb_build_object('request_id', v_req.id, 'order_position', v_pos, 'earliest_eligible_request_id', v_first,
                       'skipped_earlier', v_first is distinct from v_req.id), v_reason);
  perform ogevia.idempotency_finish('confirm_coverage_request', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'covered'));
  return 'covered';
end;
$$;

-- Posting status of one shift for the schedule's shift details.
create function ogevia_api.get_shift_coverage_status(p_organization_id uuid, p_shift_id uuid)
returns table (posting_state text, round_no integer, request_count integer, escalated boolean)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select coalesce((select r.state from ogevia.shift_coverage_rounds r where r.shift_id = s.id and r.state <> 'closed'), 'not_posted'),
         (select r.round_no from ogevia.shift_coverage_rounds r where r.shift_id = s.id and r.state <> 'closed'),
         (select count(*)::integer from ogevia.shift_pickup_requests q where q.shift_id = s.id and q.status = 'pending'),
         coalesce((select r.escalated_at is not null from ogevia.shift_coverage_rounds r where r.shift_id = s.id and r.state <> 'closed'), false)
    from ogevia.shifts s
   where s.id = p_shift_id and s.organization_id = p_organization_id
     and ogevia.require_actor() is not null and ogevia.is_active_member(p_organization_id) and ogevia.has_permission(p_organization_id, 'shifts.manage');
$$;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 13. Agency settings, office contacts, coverage cities, caregiver consent
------------------------------------------------------------------------------------------------------------------------------------------------------
create function ogevia.mask_phone(p text)
returns text
language sql
immutable
set search_path = ogevia, pg_temp
as $$ select case when p is null then null else '***' || right(p, 4) end; $$;

create function ogevia_api.get_open_shift_settings(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  s ogevia.agency_open_shift_settings%rowtype;
  v_tz text;
  v_period date;
  u ogevia.agency_sms_usage%rowtype;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id)
     or not (ogevia.has_permission(p_organization_id, 'organization.update') or ogevia.has_permission(p_organization_id, 'shifts.manage')) then
    raise exception 'You do not have permission to view these settings' using errcode = 'OGA03';
  end if;
  select * into s from ogevia.agency_open_shift_settings where organization_id = p_organization_id;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  v_period := date_trunc('month', now() at time zone v_tz)::date;
  select * into u from ogevia.agency_sms_usage where organization_id = p_organization_id and period_start = v_period;
  return jsonb_build_object(
    'openShiftsEnabled', s.open_shifts_enabled, 'smsEnabled', s.sms_enabled, 'smsEntitled', s.sms_entitled, 'senderStatus', s.sender_status,
    'smsAvailable', ogevia.sms_available(p_organization_id), 'smsDisplayName', s.sms_display_name,
    'monthlySendLimit', s.monthly_send_limit, 'alertWindowDays', s.alert_window_days,
    'quietStart', to_char(s.quiet_start, 'HH24:MI'), 'quietEnd', to_char(s.quiet_end, 'HH24:MI'), 'quietBypass', s.quiet_bypass,
    'urgentHours', s.urgent_hours, 'escalationHours', s.escalation_hours,
    'officeOpen', to_char(s.office_open, 'HH24:MI'), 'officeClose', to_char(s.office_close, 'HH24:MI'),
    'usage', jsonb_build_object('period', v_period, 'sent', coalesce(u.sent_count, 0), 'segments', coalesce(u.segment_count, 0),
                                'blocked', coalesce(u.blocked_count, 0), 'failed', coalesce(u.failed_count, 0)));
end;
$$;

create function ogevia_api.update_open_shift_settings(p_organization_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  b jsonb;
  s ogevia.agency_open_shift_settings%rowtype;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'You do not have permission to change these settings' using errcode = 'OGA03'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'Nothing to change' using errcode = 'OGV22'; end if;
  select * into s from ogevia.agency_open_shift_settings where organization_id = p_organization_id for update;
  b := to_jsonb(s) - 'updated_at';
  update ogevia.agency_open_shift_settings set
    open_shifts_enabled = coalesce((p_patch ->> 'openShiftsEnabled')::boolean, open_shifts_enabled),
    sms_enabled = coalesce((p_patch ->> 'smsEnabled')::boolean, sms_enabled),
    sms_display_name = case when p_patch ? 'smsDisplayName' then nullif(btrim(p_patch ->> 'smsDisplayName'), '') else sms_display_name end,
    monthly_send_limit = coalesce((p_patch ->> 'monthlySendLimit')::integer, monthly_send_limit),
    alert_window_days = coalesce((p_patch ->> 'alertWindowDays')::integer, alert_window_days),
    quiet_start = coalesce((p_patch ->> 'quietStart')::time, quiet_start),
    quiet_end = coalesce((p_patch ->> 'quietEnd')::time, quiet_end),
    quiet_bypass = coalesce((p_patch ->> 'quietBypass')::boolean, quiet_bypass),
    urgent_hours = coalesce((p_patch ->> 'urgentHours')::integer, urgent_hours),
    escalation_hours = coalesce((p_patch ->> 'escalationHours')::integer, escalation_hours),
    office_open = coalesce((p_patch ->> 'officeOpen')::time, office_open),
    office_close = coalesce((p_patch ->> 'officeClose')::time, office_close),
    updated_by = v_actor, updated_at = now()
  where organization_id = p_organization_id
  returning * into s;
  perform ogevia.write_audit(p_organization_id, 'open_shift_settings.updated', 'organizations', p_organization_id, b, to_jsonb(s) - 'updated_at', null);
  return ogevia_api.get_open_shift_settings(p_organization_id);
end;
$$;

create function ogevia_api.list_office_contacts(p_organization_id uuid)
returns table (contact_id uuid, label text, phone_masked text, email text, notify_sms boolean, notify_email boolean, is_on_call boolean, active boolean)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select k.id, k.label, ogevia.mask_phone(k.phone_e164), k.email, k.notify_sms, k.notify_email, k.is_on_call, k.active
    from ogevia.office_notification_contacts k
   where k.organization_id = p_organization_id and ogevia.require_actor() is not null and ogevia.is_active_member(p_organization_id)
     and ogevia.has_permission(p_organization_id, 'organization.update')
   order by k.created_at;
$$;

create function ogevia_api.upsert_office_contact(
  p_organization_id uuid, p_contact_id uuid, p_label text, p_phone text, p_email text, p_notify_sms boolean, p_notify_email boolean, p_is_on_call boolean, p_active boolean
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_id uuid := p_contact_id;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'You do not have permission to change office contacts' using errcode = 'OGA03'; end if;
  if v_id is null then
    insert into ogevia.office_notification_contacts (organization_id, label, phone_e164, email, notify_sms, notify_email, is_on_call, active, created_by)
    values (p_organization_id, btrim(p_label), nullif(btrim(coalesce(p_phone, '')), ''), nullif(btrim(coalesce(p_email, '')), ''),
            coalesce(p_notify_sms, true), coalesce(p_notify_email, false), coalesce(p_is_on_call, false), coalesce(p_active, true), v_actor)
    returning id into v_id;
  else
    update ogevia.office_notification_contacts set
      label = coalesce(nullif(btrim(p_label), ''), label),
      phone_e164 = case when p_phone is null then phone_e164 else nullif(btrim(p_phone), '') end,
      email = case when p_email is null then email else nullif(btrim(p_email), '') end,
      notify_sms = coalesce(p_notify_sms, notify_sms), notify_email = coalesce(p_notify_email, notify_email),
      is_on_call = coalesce(p_is_on_call, is_on_call), active = coalesce(p_active, active), updated_at = now()
    where id = v_id and organization_id = p_organization_id;
    if not found then raise exception 'Contact not found' using errcode = 'OGN04'; end if;
  end if;
  perform ogevia.write_audit(p_organization_id, 'office_contact.saved', 'organizations', p_organization_id, null, jsonb_build_object('contact_id', v_id), null);
  return v_id;
end;
$$;

create function ogevia_api.list_caregiver_coverage_cities(p_organization_id uuid, p_caregiver_record_id uuid)
returns table (city text, state text)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select cc.city, cc.state from ogevia.caregiver_coverage_cities cc
   where cc.organization_id = p_organization_id and cc.caregiver_record_id = p_caregiver_record_id and cc.removed_at is null
     and ogevia.require_actor() is not null and ogevia.is_active_member(p_organization_id)
     and (ogevia.has_permission(p_organization_id, 'caregivers.manage') or ogevia.has_permission(p_organization_id, 'shifts.manage'))
   order by cc.city_key;
$$;

-- Replaces the caregiver's approved cities with the given list ([{"city":"Winchester","state":"CA"}, ...]).
create function ogevia_api.set_caregiver_coverage_cities(p_organization_id uuid, p_caregiver_record_id uuid, p_cities jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  e jsonb;
  v_keys text[] := array[]::text[];
  v_city text;
  v_state text;
  v_key text;
begin
  if p_cities is null or jsonb_typeof(p_cities) <> 'array' or jsonb_array_length(p_cities) > 50 then raise exception 'Give the cities as a list (at most 50)' using errcode = 'OGV22'; end if;
  if not exists (select 1 from ogevia.caregiver_records c where c.id = p_caregiver_record_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Caregiver not found' using errcode = 'OGN04';
  end if;
  for e in select * from jsonb_array_elements(p_cities) loop
    v_city := nullif(btrim(coalesce(e ->> 'city', '')), '');
    v_state := upper(coalesce(nullif(btrim(e ->> 'state'), ''), 'CA'));
    if v_city is null or length(v_city) not between 2 and 80 or v_state !~ '^[A-Z]{2}$' then raise exception 'Each city needs a name and a two-letter state' using errcode = 'OGV22'; end if;
    v_key := ogevia.city_key(v_city, v_state);
    v_keys := v_keys || v_key;
    insert into ogevia.caregiver_coverage_cities (organization_id, caregiver_record_id, city, state, city_key, created_by)
    values (p_organization_id, p_caregiver_record_id, v_city, v_state, v_key, v_actor)
    on conflict (caregiver_record_id, city_key) where removed_at is null do nothing;
  end loop;
  update ogevia.caregiver_coverage_cities set removed_at = now(), removed_by = v_actor
   where organization_id = p_organization_id and caregiver_record_id = p_caregiver_record_id and removed_at is null and not (city_key = any (v_keys));
  perform ogevia.write_audit(p_organization_id, 'caregiver.coverage_cities_set', 'caregiver_records', p_caregiver_record_id, null, jsonb_build_object('cities', p_cities), null);
  return coalesce(array_length(v_keys, 1), 0);
end;
$$;

-- The caregiver's own text-message consent for THIS agency (consent is per agency and per sender).
create function ogevia_api.set_my_sms_consent(p_organization_id uuid, p_phone text, p_opt_in boolean, p_source text default 'app')
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g');
  v_src text := coalesce(nullif(btrim(p_source), ''), 'app');
begin
  if not ogevia.is_active_member(p_organization_id) or not ogevia.is_active_caregiver(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  v_rec := ogevia.actor_caregiver_record(p_organization_id);
  if v_rec.id is null then raise exception 'Your Care Team profile was not found' using errcode = 'OGN04'; end if;
  if v_phone ~ '^[0-9]{10}$' then v_phone := '+1' || v_phone; end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Enter a valid mobile number' using errcode = 'OGV22'; end if;
  if coalesce(p_opt_in, false) then
    insert into ogevia.caregiver_sms_consent (organization_id, caregiver_record_id, phone_e164, status, consent_at, consent_source)
    values (p_organization_id, v_rec.id, v_phone, 'opted_in', now(), v_src)
    on conflict (organization_id, caregiver_record_id) do update
      set phone_e164 = excluded.phone_e164, status = 'opted_in', consent_at = now(), consent_source = excluded.consent_source, opted_out_at = null, opt_out_source = null, updated_at = now();
  else
    insert into ogevia.caregiver_sms_consent (organization_id, caregiver_record_id, phone_e164, status, opted_out_at, opt_out_source)
    values (p_organization_id, v_rec.id, v_phone, 'opted_out', now(), v_src)
    on conflict (organization_id, caregiver_record_id) do update
      set status = 'opted_out', opted_out_at = now(), opt_out_source = excluded.opt_out_source, updated_at = now();
    update ogevia.notification_jobs set status = 'suppressed', suppress_reason = 'opted_out', updated_at = now()
     where organization_id = p_organization_id and recipient_caregiver_record_id = v_rec.id and status = 'queued' and purpose = 'open_shift';
  end if;
  insert into ogevia.caregiver_sms_consent_events (organization_id, caregiver_record_id, event, source)
  values (p_organization_id, v_rec.id, case when coalesce(p_opt_in, false) then 'opted_in' else 'opted_out' end, v_src);
  return case when coalesce(p_opt_in, false) then 'opted_in' else 'opted_out' end;
end;
$$;

create function ogevia_api.get_my_sms_consent(p_organization_id uuid)
returns table (status text, phone_masked text, consent_at timestamptz)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select k.status, ogevia.mask_phone(k.phone_e164), k.consent_at
    from ogevia.caregiver_sms_consent k join ogevia.caregiver_records cr on cr.id = k.caregiver_record_id and cr.organization_id = k.organization_id
   where k.organization_id = p_organization_id and cr.linked_user_id = ogevia.require_actor() and cr.deleted_at is null and ogevia.is_active_member(p_organization_id);
$$;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 14. The worker (no signed-in person; tenant is carried by each job). Messages are rendered and re-checked at the moment of sending.
------------------------------------------------------------------------------------------------------------------------------------------------------
-- Decide what to do with one job right now: send / suppress (with reason) / defer. Never writes.
create function ogevia.sms_evaluate_job(p_job_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  j ogevia.notification_jobs%rowtype;
  st ogevia.agency_open_shift_settings%rowtype;
  sh ogevia.shifts%rowtype;
  rd ogevia.shift_coverage_rounds%rowtype;
  v_tz text;
  v_name text;
  v_phone text;
  v_first boolean := false;
  v_city text;
  v_when text;
  v_body text;
  v_path text;
  v_local time;
  v_in_quiet boolean;
  v_next timestamptz;
begin
  select * into j from ogevia.notification_jobs where id = p_job_id;
  select * into st from ogevia.agency_open_shift_settings where organization_id = j.organization_id;
  select o.timezone, coalesce(st.sms_display_name, o.display_name) into v_tz, v_name from ogevia.organizations o where o.id = j.organization_id;
  select * into sh from ogevia.shifts where id = j.shift_id;
  if not st.sms_entitled then return jsonb_build_object('action', 'suppress', 'reason', 'not_entitled'); end if;
  if not st.sms_enabled then return jsonb_build_object('action', 'suppress', 'reason', 'sms_disabled'); end if;
  if st.sender_status <> 'verified' or st.sender_number is null then return jsonb_build_object('action', 'suppress', 'reason', 'sender_unavailable'); end if;

  if j.recipient_kind = 'caregiver' then
    select k.phone_e164, k.first_message_at is null into v_phone, v_first from ogevia.caregiver_sms_consent k
     where k.organization_id = j.organization_id and k.caregiver_record_id = j.recipient_caregiver_record_id and k.status = 'opted_in';
    if v_phone is null then return jsonb_build_object('action', 'suppress', 'reason', 'no_consent'); end if;
    if not exists (select 1 from ogevia.caregiver_records c where c.id = j.recipient_caregiver_record_id and c.organization_id = j.organization_id
                    and c.deleted_at is null and c.status in ('ready', 'active')) then
      return jsonb_build_object('action', 'suppress', 'reason', 'caregiver_inactive');
    end if;
  else
    select k.phone_e164 into v_phone from ogevia.office_notification_contacts k
     where k.id = j.recipient_contact_id and k.organization_id = j.organization_id and k.active and k.notify_sms;
    if v_phone is null then return jsonb_build_object('action', 'suppress', 'reason', 'contact_unavailable'); end if;
  end if;

  select c.city into v_city from ogevia.shift_city(sh.id) c;
  v_when := ogevia.fmt_sms_when(sh.starts_at, sh.ends_at, v_tz);

  if j.purpose = 'open_shift' then
    select * into rd from ogevia.shift_coverage_rounds where id = j.round_id;
    if rd.id is null or rd.state <> 'posted' then return jsonb_build_object('action', 'suppress', 'reason', 'round_closed'); end if;
    if sh.status <> 'scheduled' or sh.starts_at <= now() or ogevia.shift_coverage_state(sh) <> 'needs_coverage' then
      return jsonb_build_object('action', 'suppress', 'reason', 'shift_not_open');
    end if;
    if cardinality(ogevia.coverage_blockers(j.organization_id, sh.id, j.recipient_caregiver_record_id)) > 0 then
      return jsonb_build_object('action', 'suppress', 'reason', 'ineligible');
    end if;
    if sh.starts_at > now() + make_interval(days => st.alert_window_days) then
      return jsonb_build_object('action', 'defer', 'until', sh.starts_at - make_interval(days => st.alert_window_days));
    end if;
    v_local := (now() at time zone v_tz)::time;
    v_in_quiet := case when st.quiet_start <= st.quiet_end then v_local >= st.quiet_start and v_local < st.quiet_end
                       else v_local >= st.quiet_start or v_local < st.quiet_end end;
    if v_in_quiet and not st.quiet_bypass then
      v_next := (date_trunc('day', now() at time zone v_tz) + st.quiet_end::interval) at time zone v_tz;
      if v_next <= now() then v_next := v_next + interval '1 day'; end if;
      return jsonb_build_object('action', 'defer', 'until', v_next);
    end if;
    v_body := v_name || ': Open shift in ' || coalesce(v_city, 'your area') || ', ' || v_when || '. Request in Ogevia: {link}';
    v_path := '/open-shifts?ref=' || sh.public_ref;
  elsif j.purpose = 'callout_receipt' then
    v_body := v_name || ': We received your call-out for ' || v_when || '. The office was notified.';
  elsif j.purpose = 'client_cancel' then
    if sh.status <> 'cancelled' then return jsonb_build_object('action', 'suppress', 'reason', 'not_cancelled'); end if;
    v_body := v_name || ': Your shift on ' || v_when || ' is cancelled. Please do not go. Ogevia: {link}';
    v_path := '/my-shifts';
  elsif j.purpose = 'assignment_confirmed' then
    if sh.status <> 'scheduled' or sh.caregiver_record_id is distinct from j.recipient_caregiver_record_id or ogevia.shift_is_called_out(sh.id) then
      return jsonb_build_object('action', 'suppress', 'reason', 'assignment_changed');
    end if;
    v_body := v_name || ': You''re confirmed for ' || v_when || ' in ' || coalesce(v_city, 'your area') || '. Details in Ogevia: {link}';
    v_path := '/my-shifts';
  elsif j.purpose = 'office_callout' then
    v_body := 'Ogevia: Caregiver cancelled ' || v_when || ', ' || coalesce(v_city, 'no city set') || '. Reposted for coverage. Review: {link}';
    v_path := '/coverage';
  elsif j.purpose = 'office_escalation' then
    select * into rd from ogevia.shift_coverage_rounds where id = j.round_id;
    if rd.id is null or rd.state = 'closed' or sh.status <> 'scheduled' or ogevia.shift_coverage_state(sh) <> 'needs_coverage' then
      return jsonb_build_object('action', 'suppress', 'reason', 'no_longer_needed');
    end if;
    v_body := v_name || ': Coverage needed in ' || coalesce(v_city, 'no city set') || ', ' || v_when || '. Review in Ogevia: {link}';
    v_path := '/coverage';
  end if;
  if v_first then v_body := v_body || ' Reply STOP to opt out.'; end if;
  return jsonb_build_object('action', 'send', 'to', v_phone, 'sender', st.sender_number, 'body', v_body, 'path', v_path);
end;
$$;
revoke all on function ogevia.sms_evaluate_job(uuid) from public;

create function ogevia_api.system_sms_claim(p_limit integer default 25)
returns table (job_id uuid, claim_token uuid, organization_id uuid, sender_number text, to_phone text, body_template text, link_path text)
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  j record;
  v jsonb;
  v_tz text;
  v_period date;
  v_limit integer;
  v_got integer;
  v_token uuid;
begin
  for j in select n.id, n.organization_id from ogevia.notification_jobs n
            where n.status = 'queued' and n.not_before <= now()
            order by n.not_before, n.created_at limit greatest(1, least(coalesce(p_limit, 25), 200))
            for update skip locked
  loop
    v := ogevia.sms_evaluate_job(j.id);
    if v ->> 'action' = 'suppress' then
      update ogevia.notification_jobs set status = 'suppressed', suppress_reason = v ->> 'reason', updated_at = now() where id = j.id;
      continue;
    elsif v ->> 'action' = 'defer' then
      update ogevia.notification_jobs set not_before = (v ->> 'until')::timestamptz, updated_at = now() where id = j.id;
      continue;
    end if;
    -- Atomic quota: one text counted per claim; refused (and shown to the office) when the agency's monthly limit is reached.
    select o.timezone into v_tz from ogevia.organizations o where o.id = j.organization_id;
    v_period := date_trunc('month', now() at time zone v_tz)::date;
    select s.monthly_send_limit into v_limit from ogevia.agency_open_shift_settings s where s.organization_id = j.organization_id;
    insert into ogevia.agency_sms_usage (organization_id, period_start) values (j.organization_id, v_period) on conflict do nothing;
    update ogevia.agency_sms_usage u set sent_count = u.sent_count + 1
     where u.organization_id = j.organization_id and u.period_start = v_period and u.sent_count < v_limit;
    get diagnostics v_got = row_count;
    if v_got = 0 then
      update ogevia.agency_sms_usage u set blocked_count = u.blocked_count + 1 where u.organization_id = j.organization_id and u.period_start = v_period;
      update ogevia.notification_jobs set status = 'suppressed', suppress_reason = 'quota_exceeded', updated_at = now() where id = j.id;
      continue;
    end if;
    v_token := gen_random_uuid();
    update ogevia.notification_jobs set status = 'claimed', claim_token = v_token, claimed_at = now(), attempts = attempts + 1, updated_at = now() where id = j.id;
    return query select j.id, v_token, j.organization_id, v ->> 'sender', v ->> 'to', v ->> 'body', v ->> 'path';
  end loop;
end;
$$;

-- Outcome of one send attempt. 'accepted' = the provider took it; 'failed' = definitely not sent; 'transient' = not sent, retry later (bounded);
-- 'unknown' = outcome uncertain (timeout): never retried automatically, surfaced to the office.
create function ogevia_api.system_sms_record(
  p_job_id uuid, p_claim_token uuid, p_outcome text, p_provider_message_id text default null, p_segments integer default null,
  p_cost_micros bigint default null, p_error_code text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  j ogevia.notification_jobs%rowtype;
  v_tz text;
  v_period date;
begin
  if p_outcome not in ('accepted', 'failed', 'transient', 'unknown') then raise exception 'Unknown outcome' using errcode = 'OGV22'; end if;
  select * into j from ogevia.notification_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'Job not found' using errcode = 'OGN04'; end if;
  if j.status <> 'claimed' or j.claim_token is distinct from p_claim_token then return j.status; end if; -- a repeat report changes nothing
  select o.timezone into v_tz from ogevia.organizations o where o.id = j.organization_id;
  v_period := date_trunc('month', now() at time zone v_tz)::date;
  if p_outcome = 'accepted' then
    update ogevia.notification_jobs set status = 'accepted', provider_message_id = p_provider_message_id, segments = p_segments, cost_micros = p_cost_micros,
           sent_at = now(), claim_token = null, updated_at = now() where id = j.id;
    update ogevia.agency_sms_usage set segment_count = segment_count + coalesce(p_segments, 1), cost_micros = cost_micros + coalesce(p_cost_micros, 0)
     where organization_id = j.organization_id and period_start = v_period;
    if j.recipient_kind = 'caregiver' then
      update ogevia.caregiver_sms_consent set first_message_at = coalesce(first_message_at, now())
       where organization_id = j.organization_id and caregiver_record_id = j.recipient_caregiver_record_id;
    end if;
    return 'accepted';
  elsif p_outcome = 'unknown' then
    update ogevia.notification_jobs set status = 'unknown', last_error_code = left(p_error_code, 60), claim_token = null, updated_at = now() where id = j.id;
    return 'unknown';
  end if;
  -- Definitely not sent: give the count back.
  update ogevia.agency_sms_usage set sent_count = greatest(sent_count - 1, 0), failed_count = failed_count + case when p_outcome = 'failed' or j.attempts >= 3 then 1 else 0 end
   where organization_id = j.organization_id and period_start = v_period;
  if p_outcome = 'transient' and j.attempts < 3 then
    update ogevia.notification_jobs set status = 'queued', not_before = now() + make_interval(mins => j.attempts * j.attempts * 2), last_error_code = left(p_error_code, 60),
           claim_token = null, updated_at = now() where id = j.id;
    return 'queued';
  end if;
  update ogevia.notification_jobs set status = 'failed', last_error_code = left(p_error_code, 60), claim_token = null, updated_at = now() where id = j.id;
  return 'failed';
end;
$$;

-- Provider delivery receipt. The agency is found from the SENDER number the message went out on, never from the recipient.
create function ogevia_api.system_sms_receipt(p_sender_number text, p_provider_message_id text, p_delivered boolean, p_error_code text default null)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  select s.organization_id into v_org from ogevia.agency_open_shift_settings s where s.sender_number = p_sender_number;
  if v_org is null then return 'ignored'; end if;
  update ogevia.notification_jobs j
     set status = case when p_delivered then 'delivered' else 'failed' end, delivered_at = case when p_delivered then now() end,
         last_error_code = case when p_delivered then last_error_code else left(p_error_code, 60) end, updated_at = now()
   where j.organization_id = v_org and j.provider_message_id = p_provider_message_id and j.status in ('accepted', 'unknown', 'delivered')
  returning j.id into v_id;
  return case when v_id is null then 'ignored' else 'recorded' end;
end;
$$;

-- STOP received on an agency's sender: opts the number out of THAT agency only.
create function ogevia_api.system_sms_stop(p_sender_number text, p_phone text)
returns integer
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_org uuid;
  v_n integer := 0;
  c record;
begin
  select s.organization_id into v_org from ogevia.agency_open_shift_settings s where s.sender_number = p_sender_number;
  if v_org is null then return 0; end if;
  for c in update ogevia.caregiver_sms_consent k set status = 'opted_out', opted_out_at = now(), opt_out_source = 'stop_reply', updated_at = now()
            where k.organization_id = v_org and k.phone_e164 = p_phone and k.status = 'opted_in' returning k.caregiver_record_id
  loop
    insert into ogevia.caregiver_sms_consent_events (organization_id, caregiver_record_id, event, source) values (v_org, c.caregiver_record_id, 'opted_out', 'stop_reply');
    update ogevia.notification_jobs set status = 'suppressed', suppress_reason = 'opted_out', updated_at = now()
     where organization_id = v_org and recipient_caregiver_record_id = c.caregiver_record_id and status = 'queued';
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Scheduled sweep: expire openings that have started, plan rounds that entered the alert window, escalate unfilled openings, and surface
-- jobs stuck mid-send as 'unknown' (never re-sent automatically). Counts only.
create function ogevia_api.system_coverage_sweep()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  r record;
  v_expired integer := 0;
  v_planned integer := 0;
  v_escalated integer := 0;
  v_stuck integer;
begin
  for r in select cr.id, cr.shift_id, s.status, s.starts_at from ogevia.shift_coverage_rounds cr join ogevia.shifts s on s.id = cr.shift_id
            where cr.state <> 'closed' and (s.starts_at <= now() or s.status <> 'scheduled') order by cr.opened_at limit 500 loop
    perform ogevia.coverage_close_round(r.shift_id, case when r.status <> 'scheduled' then 'invalid' else 'expired' end);
    v_expired := v_expired + 1;
  end loop;
  for r in select cr.id from ogevia.shift_coverage_rounds cr where cr.state = 'posted' and cr.recruit_planned_at is null order by cr.posted_at limit 500 loop
    perform ogevia.coverage_plan_round(r.id);
    v_planned := v_planned + 1;
  end loop;
  for r in select cr.id from ogevia.shift_coverage_rounds cr where cr.state <> 'closed' and cr.escalated_at is null order by cr.opened_at limit 500 loop
    perform ogevia.coverage_escalate_if_due(r.id);
    if (select escalated_at is not null from ogevia.shift_coverage_rounds where id = r.id) then v_escalated := v_escalated + 1; end if;
  end loop;
  update ogevia.notification_jobs set status = 'unknown', last_error_code = 'claim_timeout', claim_token = null, updated_at = now()
   where status = 'claimed' and claimed_at < now() - interval '15 minutes';
  get diagnostics v_stuck = row_count;
  return jsonb_build_object('roundsClosed', v_expired, 'roundsPlanned', v_planned, 'roundsEscalated', v_escalated, 'stuckToUnknown', v_stuck);
end;
$$;

------------------------------------------------------------------------------------------------------------------------------------------------------
-- 15. Grants
------------------------------------------------------------------------------------------------------------------------------------------------------
revoke all on function ogevia_api.post_shift_for_coverage(uuid, uuid) from public;
revoke all on function ogevia_api.unpost_shift(uuid, uuid, text) from public;
revoke all on function ogevia_api.set_shift_service_city(uuid, uuid, text, text) from public;
revoke all on function ogevia_api.list_open_shift_board(uuid, integer, integer) from public;
revoke all on function ogevia_api.get_open_shift(uuid, uuid) from public;
revoke all on function ogevia_api.request_open_shift(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.withdraw_open_shift_request(uuid, uuid) from public;
revoke all on function ogevia_api.list_my_open_shift_requests(uuid) from public;
revoke all on function ogevia_api.list_coverage_queue(uuid) from public;
revoke all on function ogevia_api.list_coverage_requests(uuid, uuid) from public;
revoke all on function ogevia_api.confirm_coverage_request(uuid, uuid, text, uuid) from public;
revoke all on function ogevia_api.get_shift_coverage_status(uuid, uuid) from public;
revoke all on function ogevia_api.get_open_shift_settings(uuid) from public;
revoke all on function ogevia_api.update_open_shift_settings(uuid, jsonb) from public;
revoke all on function ogevia_api.list_office_contacts(uuid) from public;
revoke all on function ogevia_api.upsert_office_contact(uuid, uuid, text, text, text, boolean, boolean, boolean, boolean) from public;
revoke all on function ogevia_api.list_caregiver_coverage_cities(uuid, uuid) from public;
revoke all on function ogevia_api.set_caregiver_coverage_cities(uuid, uuid, jsonb) from public;
revoke all on function ogevia_api.set_my_sms_consent(uuid, text, boolean, text) from public;
revoke all on function ogevia_api.get_my_sms_consent(uuid) from public;
revoke all on function ogevia_api.system_sms_claim(integer) from public;
revoke all on function ogevia_api.system_sms_record(uuid, uuid, text, text, integer, bigint, text) from public;
revoke all on function ogevia_api.system_sms_receipt(text, text, boolean, text) from public;
revoke all on function ogevia_api.system_sms_stop(text, text) from public;
revoke all on function ogevia_api.system_coverage_sweep() from public;
revoke all on function ogevia.city_key(text, text) from public;
revoke all on function ogevia.shift_city(uuid) from public;
revoke all on function ogevia.sms_available(uuid) from public;
revoke all on function ogevia.fmt_sms_when(timestamptz, timestamptz, text) from public;
revoke all on function ogevia.actor_caregiver_record(uuid) from public;
revoke all on function ogevia.mask_phone(text) from public;

grant execute on function ogevia_api.post_shift_for_coverage(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.unpost_shift(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.set_shift_service_city(uuid, uuid, text, text) to ogevia_app;
grant execute on function ogevia_api.list_open_shift_board(uuid, integer, integer) to ogevia_app;
grant execute on function ogevia_api.get_open_shift(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.request_open_shift(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.withdraw_open_shift_request(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_my_open_shift_requests(uuid) to ogevia_app;
grant execute on function ogevia_api.list_coverage_queue(uuid) to ogevia_app;
grant execute on function ogevia_api.list_coverage_requests(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.confirm_coverage_request(uuid, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.get_shift_coverage_status(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.get_open_shift_settings(uuid) to ogevia_app;
grant execute on function ogevia_api.update_open_shift_settings(uuid, jsonb) to ogevia_app;
grant execute on function ogevia_api.list_office_contacts(uuid) to ogevia_app;
grant execute on function ogevia_api.upsert_office_contact(uuid, uuid, text, text, text, boolean, boolean, boolean, boolean) to ogevia_app;
grant execute on function ogevia_api.list_caregiver_coverage_cities(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.set_caregiver_coverage_cities(uuid, uuid, jsonb) to ogevia_app;
grant execute on function ogevia_api.set_my_sms_consent(uuid, text, boolean, text) to ogevia_app;
grant execute on function ogevia_api.get_my_sms_consent(uuid) to ogevia_app;
grant execute on function ogevia_api.system_sms_claim(integer) to ogevia_app;
grant execute on function ogevia_api.system_sms_record(uuid, uuid, text, text, integer, bigint, text) to ogevia_app;
grant execute on function ogevia_api.system_sms_receipt(text, text, boolean, text) to ogevia_app;
grant execute on function ogevia_api.system_sms_stop(text, text) to ogevia_app;
grant execute on function ogevia_api.system_coverage_sweep() to ogevia_app;
