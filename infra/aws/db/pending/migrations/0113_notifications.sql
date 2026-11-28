-- 0113 (PENDING: infra/aws/db/pending, not in any release) | CLASS: ADDITIVE (five tables, functions). Not applied to any database.
-- Release Train 2, priority A. Open-shift (cover) notifications and the notification centre. Depends on 0110/0111 (offices, office assignments) and the live-test 0091 service ZIP.
--   * Decisions of 2026-11-23 (owner): the subject shows the SERVICE city (from the client's service address, never the office's city): "Open shift in Winchester | Fri, Nov 27 | 1:30–5:00 PM";
--     the body names the coordinating office. Never the client's name, code, street address or ZIP. A client without a service city AND ZIP blocks the alert.
--   * Routing by coordinating office: one office = that office; several = the office assigned to the shift (shifts.coordinating_office_id) or one the sender selects before publishing.
--     Audience: caregivers assigned to that office (agency setting 'office', or 'agency' for everyone; a per-office override may also say 'none'). The sender is always excluded and each person gets one copy.
--   * Per-agency settings, all OFF by default (cover_notification_settings): nothing is created for an agency until its owner turns it on.
--   * user_notifications: one row per person and event (a cover-shift offer). The body never holds a client name, code or address: service, local date and time only.
--     Rows are history: only read_at (once) and archived_at can change; nothing is deleted.
--   * notification_preferences: each person's in-app and email choice per category.
--   * notification_deliveries + notification_delivery_events: the email outbox (queued -> sending -> sent | retry -> failed | skipped) and its append-only audit of every attempt.
--   * Recipients come from ONE rule: active, linked caregivers assigned to the client and service, not the caregiver who called out, who pass the existing
--     check_shift_caregiver gate (status, overlaps, readiness, hours limits). Nothing here assigns anyone: a caregiver still asks and the office still confirms (0063).
--   * No email address is stored here: the address is read from caregiver_contacts / the invitation at send time, by the system worker only.
-- Rollback: pending/rollback/0113_notifications.down.sql (drops only what this file created; the audit events written stay).
create table ogevia.cover_notification_settings (
  organization_id uuid primary key references ogevia.organizations(id),
  enabled boolean not null default false,
  email_enabled boolean not null default false,
  auto_notify boolean not null default false,
  window_hours integer not null default 48 check (window_hours between 1 and 336),
  max_recipients integer not null default 25 check (max_recipients between 1 and 200),
  -- who is told: the caregivers of the coordinating office ('office') or every eligible caregiver of the agency ('agency')
  audience text not null default 'office' check (audience in ('office', 'agency')),
  -- the subject line; the service city is ALWAYS part of it (the check and the setter both require {city}); only these tokens exist
  subject_template text not null default 'Open shift in {city} | {date} | {time}' check (length(subject_template) between 10 and 120 and subject_template like '%{city}%'),
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now()
);
create table ogevia.cover_notification_office_audience (
  office_id uuid primary key,
  organization_id uuid not null references ogevia.organizations(id),
  audience text not null check (audience in ('office', 'agency', 'none')),
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  foreign key (office_id, organization_id) references ogevia.offices (id, organization_id)
);
alter table ogevia.cover_notification_office_audience enable row level security;
revoke all on ogevia.cover_notification_office_audience from public;
-- the office a shift is coordinated by (optional; one-office agencies need none)
alter table ogevia.shifts add column coordinating_office_id uuid;
alter table ogevia.shifts add constraint shifts_coordinating_office_fk foreign key (coordinating_office_id, organization_id) references ogevia.offices (id, organization_id);
-- one row per published alert: the shift, the office, the SERVICE city used, who sent it (null = the scheduled run) and how many people were told
create table ogevia.cover_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  shift_id uuid not null references ogevia.shifts(id),
  office_id uuid not null,
  service_city text not null check (length(btrim(service_city)) between 1 and 80),
  sent_by uuid references ogevia.app_users(id),
  recipients integer not null check (recipients >= 0),
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, dedupe_key),
  foreign key (office_id, organization_id) references ogevia.offices (id, organization_id)
);
alter table ogevia.cover_alerts enable row level security;
revoke all on ogevia.cover_alerts from public;
alter table ogevia.cover_notification_settings enable row level security;
revoke all on ogevia.cover_notification_settings from public;

create table ogevia.user_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  recipient_user_id uuid not null references ogevia.app_users(id),
  category text not null check (category in ('cover_shift')),
  title text not null check (length(title) between 1 and 200),
  body text not null check (length(body) between 1 and 500),
  link text check (link is null or link ~ '^/[a-z0-9/_-]*$'),
  shift_id uuid references ogevia.shifts(id),
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  in_app boolean not null default true,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  archived_at timestamptz,
  unique (organization_id, recipient_user_id, dedupe_key)
);
create index user_notifications_recipient_idx on ogevia.user_notifications (organization_id, recipient_user_id, created_at desc);
alter table ogevia.user_notifications enable row level security;
revoke all on ogevia.user_notifications from public;

create function ogevia.user_notifications_guard() returns trigger language plpgsql set search_path = ogevia, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'Notifications are kept as history' using errcode = 'OGC09'; end if;
  if new.id <> old.id or new.organization_id <> old.organization_id or new.recipient_user_id <> old.recipient_user_id or new.category <> old.category
     or new.title <> old.title or new.body <> old.body or new.link is distinct from old.link or new.shift_id is distinct from old.shift_id
     or new.dedupe_key <> old.dedupe_key or new.in_app <> old.in_app or new.created_at <> old.created_at then
    raise exception 'A notification can only be marked read or archived' using errcode = 'OGC09';
  end if;
  if old.read_at is not null and new.read_at is distinct from old.read_at then raise exception 'Already read' using errcode = 'OGC09'; end if;
  return new;
end;
$$;
create trigger user_notifications_guard before update or delete on ogevia.user_notifications for each row execute function ogevia.user_notifications_guard();

create table ogevia.notification_preferences (
  organization_id uuid not null references ogevia.organizations(id),
  user_id uuid not null references ogevia.app_users(id),
  category text not null check (category in ('cover_shift')),
  in_app boolean not null default true,
  email boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id, category)
);
alter table ogevia.notification_preferences enable row level security;
revoke all on ogevia.notification_preferences from public;

create table ogevia.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  notification_id uuid not null references ogevia.user_notifications(id),
  channel text not null check (channel in ('email')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'retry', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  next_attempt_at timestamptz not null default now(),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z_]{1,40}$'),
  provider_message_id text check (provider_message_id is null or length(provider_message_id) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (notification_id, channel)
);
create index notification_deliveries_due_idx on ogevia.notification_deliveries (next_attempt_at) where status in ('queued', 'retry', 'sending');
alter table ogevia.notification_deliveries enable row level security;
revoke all on ogevia.notification_deliveries from public;

create table ogevia.notification_delivery_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  delivery_id uuid not null references ogevia.notification_deliveries(id),
  event text not null check (event in ('queued', 'claimed', 'sent', 'retry_scheduled', 'failed', 'skipped', 'reclaimed')),
  detail text check (detail is null or detail ~ '^[a-z0-9_]{1,40}$'),
  attempt integer not null default 0,
  occurred_at timestamptz not null default now()
);
create index notification_delivery_events_delivery_idx on ogevia.notification_delivery_events (delivery_id, occurred_at);
alter table ogevia.notification_delivery_events enable row level security;
revoke all on ogevia.notification_delivery_events from public;
create trigger notification_delivery_events_append_only before update or delete on ogevia.notification_delivery_events for each row execute function ogevia.append_only_guard();

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- Settings (agency owner)
-- ---------------------------------------------------------------------------------------------------------------------------------------
create function ogevia_api.get_cover_notification_settings(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'organization.update')) then
    raise exception 'Not allowed' using errcode = 'OGA03';
  end if;
  return coalesce((select jsonb_build_object('enabled', s.enabled, 'emailEnabled', s.email_enabled, 'autoNotify', s.auto_notify, 'windowHours', s.window_hours,
                                             'maxRecipients', s.max_recipients, 'audience', s.audience, 'subjectTemplate', s.subject_template)
                     from ogevia.cover_notification_settings s where s.organization_id = p_organization_id),
                  jsonb_build_object('enabled', false, 'emailEnabled', false, 'autoNotify', false, 'windowHours', 48, 'maxRecipients', 25, 'audience', 'office',
                                     'subjectTemplate', 'Open shift in {city} | {date} | {time}'));
end;
$$;

create function ogevia_api.set_cover_notification_settings(
  p_organization_id uuid, p_enabled boolean, p_email_enabled boolean, p_auto_notify boolean, p_window_hours integer, p_max_recipients integer,
  p_audience text, p_subject_template text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_before jsonb;
  v_tpl text := btrim(coalesce(p_subject_template, ''));
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'Only the agency owner can change open-shift notification settings' using errcode = 'OGA03'; end if;
  if p_enabled is null or p_email_enabled is null or p_auto_notify is null then raise exception 'Choose on or off for each setting' using errcode = 'OGV22'; end if;
  if p_window_hours is null or p_window_hours not between 1 and 336 then raise exception 'The window must be 1 to 336 hours' using errcode = 'OGV22'; end if;
  if p_max_recipients is null or p_max_recipients not between 1 and 200 then raise exception 'Recipients per shift must be 1 to 200' using errcode = 'OGV22'; end if;
  if p_audience is null or p_audience not in ('office', 'agency') then raise exception 'Choose who is told: the coordinating office or the whole agency' using errcode = 'OGV22'; end if;
  if length(v_tpl) not between 10 and 120 or position('{city}' in v_tpl) = 0 then raise exception 'The subject must include {city}: the service city is always shown' using errcode = 'OGV22'; end if;
  if v_tpl ~ '\{(?!city\}|date\}|time\}|service\})' or v_tpl ~ '[\r\n]' then raise exception 'The subject can only use {city}, {date}, {time} and {service}' using errcode = 'OGV22'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'A reason is required' using errcode = 'OGV22'; end if;
  v_before := ogevia_api.get_cover_notification_settings(p_organization_id);
  insert into ogevia.cover_notification_settings (organization_id, enabled, email_enabled, auto_notify, window_hours, max_recipients, audience, subject_template, updated_by)
  values (p_organization_id, p_enabled, p_email_enabled, p_auto_notify, p_window_hours, p_max_recipients, p_audience, v_tpl, v_actor)
  on conflict (organization_id) do update set enabled = excluded.enabled, email_enabled = excluded.email_enabled, auto_notify = excluded.auto_notify,
    window_hours = excluded.window_hours, max_recipients = excluded.max_recipients, audience = excluded.audience, subject_template = excluded.subject_template, updated_by = v_actor, updated_at = now();
  perform ogevia.write_audit(p_organization_id, 'cover_notification_settings.changed', 'organization', p_organization_id, v_before,
    jsonb_build_object('enabled', p_enabled, 'emailEnabled', p_email_enabled, 'autoNotify', p_auto_notify, 'windowHours', p_window_hours, 'maxRecipients', p_max_recipients,
                       'audience', p_audience, 'subjectTemplate', v_tpl), btrim(p_reason));
  return ogevia_api.get_cover_notification_settings(p_organization_id);
end;
$$;

-- A per-office override of the audience ('office', 'agency' or 'none' = this office never sends open-shift alerts); null removes the override.
create function ogevia_api.set_cover_office_audience(p_organization_id uuid, p_office_id uuid, p_audience text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); v_before text;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'Only the agency owner can change an office''s audience' using errcode = 'OGA03'; end if;
  if not exists (select 1 from ogevia.offices o where o.id = p_office_id and o.organization_id = p_organization_id) then raise exception 'Office not found' using errcode = 'OGN04'; end if;
  if p_audience is not null and p_audience not in ('office', 'agency', 'none') then raise exception 'Choose the coordinating office, the whole agency or nobody' using errcode = 'OGV22'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'A reason is required' using errcode = 'OGV22'; end if;
  select a.audience into v_before from ogevia.cover_notification_office_audience a where a.office_id = p_office_id;
  if p_audience is null then delete from ogevia.cover_notification_office_audience where office_id = p_office_id;
  else
    insert into ogevia.cover_notification_office_audience (office_id, organization_id, audience, updated_by) values (p_office_id, p_organization_id, p_audience, v_actor)
    on conflict (office_id) do update set audience = excluded.audience, updated_by = v_actor, updated_at = now();
  end if;
  perform ogevia.write_audit(p_organization_id, 'cover_office_audience.changed', 'offices', p_office_id, jsonb_build_object('audience', v_before), jsonb_build_object('audience', p_audience), btrim(p_reason));
  return jsonb_build_object('audience', p_audience);
end;
$$;

create function ogevia_api.list_cover_office_audiences(p_organization_id uuid)
returns table (office_id uuid, office_name text, audience_override text)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'organization.update') or ogevia.has_permission(p_organization_id, 'shifts.manage')) then raise exception 'Not allowed' using errcode = 'OGA03'; end if;
  return query select o.id, o.name::text, a.audience::text from ogevia.offices o left join ogevia.cover_notification_office_audience a on a.office_id = o.id
    where o.organization_id = p_organization_id and o.is_active order by lower(o.name);
end;
$$;

-- The client's SERVICE address as the alert needs it: the service city (the service-ZIP record's city, else the client's own city) and the service ZIP. Never the office's.
create function ogevia.cover_service_address(p_organization_id uuid, p_client_id uuid)
returns table (city text, zip text) language sql stable set search_path = ogevia, pg_temp as $$
  select coalesce(nullif(btrim(z.city), ''), nullif(btrim(c.city), ''))::text, nullif(btrim(z.zip), '')::text
    from ogevia.clients c left join ogevia.client_service_zip z on z.client_id = c.id
   where c.id = p_client_id and c.organization_id = p_organization_id;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- Publishing the alert for one shift (shared by the office button and the scheduled run). p_sender = the person who published (null for the scheduled run).
-- ---------------------------------------------------------------------------------------------------------------------------------------
create function ogevia.cover_notify(p_organization_id uuid, p_shift_id uuid, p_office_id uuid default null, p_sender uuid default null)
returns jsonb language plpgsql volatile set search_path = ogevia, pg_temp as $$
declare
  v_set ogevia.cover_notification_settings%rowtype;
  v_s ogevia.shifts%rowtype;
  v_org ogevia.organizations%rowtype;
  v_service text; v_city text; v_zip text;
  v_called uuid[];
  v_rec record;
  v_pref ogevia.notification_preferences%rowtype;
  v_offices uuid[]; v_office uuid; v_office_name text; v_aud text;
  v_in_app boolean; v_email boolean;
  v_nid uuid; v_did uuid; v_key text;
  v_sent integer := 0; v_existing integer := 0; v_queued integer := 0; v_skipped integer := 0; v_considered integer := 0;
  v_title text; v_body text; v_date text; v_time text; v_t0 text; v_t1 text; v_m0 text; v_m1 text;
begin
  select * into v_set from ogevia.cover_notification_settings where organization_id = p_organization_id;
  if v_set.organization_id is null or not v_set.enabled then return jsonb_build_object('state', 'disabled'); end if;
  select * into v_s from ogevia.shifts where id = p_shift_id and organization_id = p_organization_id;
  if v_s.id is null then raise exception 'Shift not found' using errcode = 'OGN04'; end if;
  if v_s.status <> 'scheduled' or v_s.ends_at <= now() or ogevia.shift_coverage_state(v_s) <> 'needs_coverage' or ogevia.shift_is_care_request(v_s.id) then
    return jsonb_build_object('state', 'not_needed');
  end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    return jsonb_build_object('state', 'not_needed');
  end if;

  -- 1. the SERVICE address must be complete (city AND ZIP): staff complete it on the client record. The office's city is never used in its place.
  select a.city, a.zip into v_city, v_zip from ogevia.cover_service_address(p_organization_id, v_s.client_id) a;
  if v_city is null or v_zip is null then
    return jsonb_build_object('state', 'address_incomplete', 'clientId', v_s.client_id,
      'missing', (select coalesce(jsonb_agg(m), '[]'::jsonb) from unnest(array[case when v_city is null then 'city' end, case when v_zip is null then 'zip' end]) m where m is not null));
  end if;

  -- 2. the coordinating office: one office = that office; several = the one assigned to the shift, else the one the sender selected; otherwise the sender must choose
  select coalesce(array_agg(o.id order by lower(o.name)), '{}') into v_offices from ogevia.offices o where o.organization_id = p_organization_id and o.is_active;
  if cardinality(v_offices) = 1 then v_office := v_offices[1];
  elsif v_s.coordinating_office_id is not null and v_s.coordinating_office_id = any (v_offices) then v_office := v_s.coordinating_office_id;
  elsif p_office_id is not null and p_office_id = any (v_offices) then
    v_office := p_office_id;
    if p_sender is not null then update ogevia.shifts set coordinating_office_id = v_office, updated_at = now() where id = v_s.id; end if;   -- the shift now has its office
  else
    return jsonb_build_object('state', 'office_required',
      'offices', (select coalesce(jsonb_agg(jsonb_build_object('officeId', o.id, 'name', o.name) order by lower(o.name)), '[]'::jsonb) from ogevia.offices o where o.id = any (v_offices)));
  end if;
  select o.name into v_office_name from ogevia.offices o where o.id = v_office;

  -- 3. the audience: the office's override, else the agency setting
  select coalesce((select a.audience from ogevia.cover_notification_office_audience a where a.office_id = v_office), v_set.audience) into v_aud;
  if v_aud = 'none' then return jsonb_build_object('state', 'office_audience_off', 'office', v_office_name); end if;

  select * into v_org from ogevia.organizations where id = p_organization_id;
  select sv.name into v_service from ogevia.services sv where sv.id = v_s.service_id;
  select coalesce(array_agg(e.original_caregiver_record_id), '{}') into v_called
    from ogevia.shift_coverage_events e where e.shift_id = v_s.id and e.event_type = 'called_out' and e.original_caregiver_record_id is not null;
  v_key := 'cover:' || v_s.id::text || ':' || floor(extract(epoch from v_s.starts_at))::bigint::text;

  -- subject: the agency's template; {city} is required by the setting, so the service city is in every format. Date and time are the agency's local ones.
  v_date := to_char(v_s.starts_at at time zone v_org.timezone, 'Dy, Mon FMDD');
  v_t0 := to_char(v_s.starts_at at time zone v_org.timezone, 'FMHH12:MI'); v_t1 := to_char(v_s.ends_at at time zone v_org.timezone, 'FMHH12:MI');
  v_m0 := to_char(v_s.starts_at at time zone v_org.timezone, 'AM'); v_m1 := to_char(v_s.ends_at at time zone v_org.timezone, 'AM');
  v_time := case when v_m0 = v_m1 then v_t0 || '–' || v_t1 || ' ' || v_m1 else v_t0 || ' ' || v_m0 || '–' || v_t1 || ' ' || v_m1 end;
  v_title := replace(replace(replace(replace(v_set.subject_template, '{city}', v_city), '{date}', v_date), '{time}', v_time), '{service}', coalesce(v_service, 'Shift'));
  v_body := coalesce(v_service, 'A shift') || ' · ' || v_date || ', ' || v_time || E'\nService city: ' || v_city || E'\nCoordinating office: ' || v_office_name
            || E'\nOpen Ogevia to ask for it. The office confirms who works it.';

  for v_rec in
    select cr.id as record_id, cr.linked_user_id as user_id
    from ogevia.caregiver_records cr
    join ogevia.app_users u on u.id = cr.linked_user_id and u.status = 'active'
    join ogevia.organization_memberships m on m.organization_id = cr.organization_id and m.user_id = cr.linked_user_id and m.status = 'active' and m.role = 'caregiver'
    where cr.organization_id = p_organization_id and cr.deleted_at is null and cr.linked_user_id is not null and cr.status in ('ready', 'active')
      and not (cr.id = any (v_called))
      and (p_sender is null or cr.linked_user_id <> p_sender)                       -- the person who sent the alert never receives it
      and (v_aud = 'agency' or exists (select 1 from ogevia.office_assignments oa     -- EXISTS: a caregiver in several offices (or twice) is one row
                                        where oa.organization_id = p_organization_id and oa.caregiver_record_id = cr.id and oa.office_id = v_office))
      and exists (select 1 from ogevia.caregiver_assignments ca
                   where ca.organization_id = p_organization_id and ca.caregiver_user_id = cr.linked_user_id and ca.client_id = v_s.client_id
                     and (v_s.service_id is null or ca.service_id = v_s.service_id) and ca.is_active
                     and ogevia.organization_local_date(p_organization_id, now()) >= ca.effective_start
                     and (ca.effective_end is null or ogevia.organization_local_date(p_organization_id, now()) <= ca.effective_end))
    order by cr.id
  loop
    exit when v_considered >= v_set.max_recipients;
    -- the same gate the office uses when it confirms (status, overlaps, readiness, work-hour limits); a refusal means "not eligible", not an error
    begin
      perform ogevia.check_shift_caregiver(p_organization_id, v_rec.record_id, v_s.starts_at, v_s.ends_at, v_s.id, v_s.service_id);
    exception when others then
      v_skipped := v_skipped + 1;
      continue;
    end;
    v_considered := v_considered + 1;
    select * into v_pref from ogevia.notification_preferences p where p.organization_id = p_organization_id and p.user_id = v_rec.user_id and p.category = 'cover_shift';
    v_in_app := coalesce(v_pref.in_app, true); v_email := coalesce(v_pref.email, true) and v_set.email_enabled;
    if not v_in_app and not v_email then v_skipped := v_skipped + 1; continue; end if;
    v_nid := null;
    insert into ogevia.user_notifications (organization_id, recipient_user_id, category, title, body, link, shift_id, dedupe_key, in_app)
    values (p_organization_id, v_rec.user_id, 'cover_shift', v_title, v_body, '/schedule', v_s.id, v_key, v_in_app)
    on conflict (organization_id, recipient_user_id, dedupe_key) do nothing
    returning id into v_nid;
    if v_nid is null then v_existing := v_existing + 1; continue; end if;
    v_sent := v_sent + 1;
    if v_email then
      insert into ogevia.notification_deliveries (organization_id, notification_id, channel) values (p_organization_id, v_nid, 'email') returning id into v_did;
      insert into ogevia.notification_delivery_events (organization_id, delivery_id, event) values (p_organization_id, v_did, 'queued');
      v_queued := v_queued + 1;
    end if;
  end loop;
  if v_sent > 0 then
    insert into ogevia.cover_alerts (organization_id, shift_id, office_id, service_city, sent_by, recipients, dedupe_key)
    values (p_organization_id, v_s.id, v_office, v_city, p_sender, v_sent, v_key || ':' || gen_random_uuid()::text);
    -- counts and the office only: no name, address, ZIP or contact detail enters the audit trail
    perform ogevia.write_audit(p_organization_id, 'cover_notification.created', 'shifts', v_s.id, null,
      jsonb_build_object('notified', v_sent, 'emailQueued', v_queued, 'alreadyNotified', v_existing, 'notEligible', v_skipped, 'officeId', v_office, 'audience', v_aud), null);
  end if;
  return jsonb_build_object('state', 'done', 'notified', v_sent, 'emailQueued', v_queued, 'alreadyNotified', v_existing, 'notEligible', v_skipped,
                            'serviceCity', v_city, 'office', v_office_name, 'subject', v_title);
end;
$$;

create function ogevia_api.notify_cover_shift(p_organization_id uuid, p_shift_id uuid, p_office_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'shifts.manage') then raise exception 'Only a scheduler or manager can notify caregivers' using errcode = 'OGA03'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cover_notify:' || p_shift_id::text, 0));
  return ogevia.cover_notify(p_organization_id, p_shift_id, p_office_id, v_actor);
end;
$$;

-- The scheduled run (no signed-in person, so no sender): agencies with auto-notify on, then one agency at a time. Counts only. A shift that cannot be published (no office chosen,
-- incomplete service address, office audience off) is counted under `blocked` and left for a person.
create function ogevia_api.system_cover_notify_orgs()
returns setof uuid language sql stable security definer set search_path = ogevia, pg_temp as $$
  select s.organization_id from ogevia.cover_notification_settings s
  join ogevia.organizations o on o.id = s.organization_id and o.status = 'active'
  where s.enabled and s.auto_notify order by s.organization_id;
$$;

create function ogevia_api.system_cover_notify_org(p_organization_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare
  v_set ogevia.cover_notification_settings%rowtype;
  v_shift uuid; v_r jsonb; v_shifts integer := 0; v_notified integer := 0; v_blocked jsonb := '{}'::jsonb;
begin
  select * into v_set from ogevia.cover_notification_settings where organization_id = p_organization_id and enabled and auto_notify;
  if v_set.organization_id is null then return jsonb_build_object('shifts', 0, 'notified', 0, 'blocked', '{}'::jsonb); end if;
  for v_shift in
    select s.id from ogevia.shifts s
    where s.organization_id = p_organization_id and s.status = 'scheduled' and s.starts_at > now() and s.starts_at <= now() + make_interval(hours => v_set.window_hours)
      and ogevia.shift_coverage_state(s) = 'needs_coverage' and not ogevia.shift_is_care_request(s.id)
      and not exists (select 1 from ogevia.user_notifications n where n.organization_id = p_organization_id and n.shift_id = s.id
                       and n.dedupe_key = 'cover:' || s.id::text || ':' || floor(extract(epoch from s.starts_at))::bigint::text)
    order by s.starts_at limit 200
  loop
    perform pg_advisory_xact_lock(hashtextextended('cover_notify:' || v_shift::text, 0));
    v_r := ogevia.cover_notify(p_organization_id, v_shift, null, null);
    v_shifts := v_shifts + 1; v_notified := v_notified + coalesce((v_r ->> 'notified')::integer, 0);
    if v_r ->> 'state' in ('office_required', 'address_incomplete', 'office_audience_off') then
      v_blocked := jsonb_set(v_blocked, array[v_r ->> 'state'], to_jsonb(coalesce((v_blocked ->> (v_r ->> 'state'))::integer, 0) + 1));
    end if;
  end loop;
  return jsonb_build_object('shifts', v_shifts, 'notified', v_notified, 'blocked', v_blocked);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The notification centre (the signed-in person's own notifications and preferences)
-- ---------------------------------------------------------------------------------------------------------------------------------------
create function ogevia_api.list_user_notifications(
  p_organization_id uuid, p_state text default 'inbox', p_category text default null, p_limit integer default 30, p_before timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_items jsonb; v_unread integer;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if p_state not in ('inbox', 'unread', 'archived', 'all') then raise exception 'Unknown filter' using errcode = 'OGV22'; end if;
  if p_category is not null and p_category not in ('cover_shift') then raise exception 'Unknown category' using errcode = 'OGV22'; end if;
  p_limit := greatest(1, least(coalesce(p_limit, 30), 100));
  select count(*)::integer into v_unread from ogevia.user_notifications n
   where n.organization_id = p_organization_id and n.recipient_user_id = v_actor and n.in_app and n.read_at is null and n.archived_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'category', t.category, 'title', t.title, 'body', t.body, 'link', t.link, 'shiftId', t.shift_id,
           'createdAt', t.created_at, 'readAt', t.read_at, 'archivedAt', t.archived_at,
           'state', case when t.archived_at is not null then 'archived' when t.read_at is not null then 'read' else 'unread' end) order by t.created_at desc, t.id), '[]'::jsonb)
    into v_items
  from (select n.* from ogevia.user_notifications n
         where n.organization_id = p_organization_id and n.recipient_user_id = v_actor and n.in_app
           and (p_category is null or n.category = p_category)
           and (p_before is null or n.created_at < p_before)
           and case p_state when 'inbox' then n.archived_at is null when 'unread' then n.archived_at is null and n.read_at is null
                            when 'archived' then n.archived_at is not null else true end
         order by n.created_at desc, n.id limit p_limit) t;
  return jsonb_build_object('asOf', now(), 'unread', v_unread, 'items', v_items);
end;
$$;

create function ogevia_api.mark_user_notifications(p_organization_id uuid, p_ids uuid[], p_action text)
returns integer language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_n integer;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if p_action not in ('read', 'read_all', 'archive', 'unarchive') then raise exception 'Unknown action' using errcode = 'OGV22'; end if;
  if p_action <> 'read_all' and (p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 200) then raise exception 'Choose 1 to 200 notifications' using errcode = 'OGV22'; end if;
  if p_action in ('read', 'read_all') then
    update ogevia.user_notifications n set read_at = now()
     where n.organization_id = p_organization_id and n.recipient_user_id = v_actor and n.read_at is null and (p_action = 'read_all' or n.id = any (p_ids));
  elsif p_action = 'archive' then
    update ogevia.user_notifications n set archived_at = now(), read_at = coalesce(n.read_at, now())
     where n.organization_id = p_organization_id and n.recipient_user_id = v_actor and n.archived_at is null and n.id = any (p_ids);
  else
    update ogevia.user_notifications n set archived_at = null
     where n.organization_id = p_organization_id and n.recipient_user_id = v_actor and n.archived_at is not null and n.id = any (p_ids);
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create function ogevia_api.get_my_notification_preferences(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  return jsonb_build_object('coverShift', coalesce(
    (select jsonb_build_object('inApp', p.in_app, 'email', p.email) from ogevia.notification_preferences p
      where p.organization_id = p_organization_id and p.user_id = v_actor and p.category = 'cover_shift'),
    jsonb_build_object('inApp', true, 'email', true)),
    'emailAvailable', coalesce((select s.email_enabled from ogevia.cover_notification_settings s where s.organization_id = p_organization_id and s.enabled), false));
end;
$$;

create function ogevia_api.set_my_notification_preferences(p_organization_id uuid, p_category text, p_in_app boolean, p_email boolean)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); v_before jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if p_category <> 'cover_shift' then raise exception 'Unknown category' using errcode = 'OGV22'; end if;
  if p_in_app is null or p_email is null then raise exception 'Choose on or off' using errcode = 'OGV22'; end if;
  v_before := ogevia_api.get_my_notification_preferences(p_organization_id) -> 'coverShift';
  insert into ogevia.notification_preferences (organization_id, user_id, category, in_app, email) values (p_organization_id, v_actor, p_category, p_in_app, p_email)
  on conflict (organization_id, user_id, category) do update set in_app = excluded.in_app, email = excluded.email, updated_at = now();
  perform ogevia.write_audit(p_organization_id, 'notification_preferences.changed', 'app_users', v_actor, v_before, jsonb_build_object('inApp', p_in_app, 'email', p_email), null);
  return ogevia_api.get_my_notification_preferences(p_organization_id);
end;
$$;

-- Office view of what was sent for one shift or recently: counts and statuses by caregiver code (no name, no address).
create function ogevia_api.list_cover_notification_history(p_organization_id uuid, p_limit integer default 50)
returns table (notification_id uuid, shift_id uuid, caregiver_code text, created_at timestamptz, in_app boolean, read_at timestamptz,
               email_status text, email_attempts integer, email_error text, email_sent_at timestamptz)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'shifts.manage') then raise exception 'Not allowed' using errcode = 'OGA03'; end if;
  p_limit := greatest(1, least(coalesce(p_limit, 50), 200));
  return query
    select n.id, n.shift_id, (select cr.caregiver_code::text from ogevia.caregiver_records cr where cr.organization_id = n.organization_id and cr.linked_user_id = n.recipient_user_id limit 1),
           n.created_at, n.in_app, n.read_at, d.status::text, d.attempts, d.last_error_code::text, d.sent_at
    from ogevia.user_notifications n left join ogevia.notification_deliveries d on d.notification_id = n.id and d.channel = 'email'
    where n.organization_id = p_organization_id and n.category = 'cover_shift'
    order by n.created_at desc, n.id limit p_limit;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The email worker (system only; the application role calls these from the scheduled run)
-- ---------------------------------------------------------------------------------------------------------------------------------------
-- Claims due deliveries (queued, retry, or "sending" for more than 10 minutes after a crashed run). The address is resolved HERE and returned only to the worker.
create function ogevia_api.system_email_claim(p_limit integer default 20)
returns table (delivery_id uuid, organization_id uuid, to_email text, subject text, body text, link text, attempt integer)
language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v_d record; v_email text;
begin
  p_limit := greatest(1, least(coalesce(p_limit, 20), 50));
  for v_d in
    select d.id, d.organization_id, d.attempts, d.status, n.title, n.body, n.link, n.recipient_user_id
    from ogevia.notification_deliveries d join ogevia.user_notifications n on n.id = d.notification_id
    where d.channel = 'email' and ((d.status in ('queued', 'retry') and d.next_attempt_at <= now()) or (d.status = 'sending' and d.updated_at < now() - interval '10 minutes'))
    order by d.next_attempt_at, d.id limit p_limit for update of d skip locked
  loop
    select coalesce(c.contact_email, i.email) into v_email
      from ogevia.caregiver_records cr
      left join ogevia.caregiver_contacts c on c.caregiver_record_id = cr.id
      left join lateral (select ci.email from ogevia.caregiver_invitations ci where ci.caregiver_record_id = cr.id order by ci.invited_at desc limit 1) i on true
     where cr.organization_id = v_d.organization_id and cr.linked_user_id = v_d.recipient_user_id and cr.deleted_at is null limit 1;
    if v_email is null then
      update ogevia.notification_deliveries set status = 'skipped', last_error_code = 'no_email', updated_at = now() where id = v_d.id;
      insert into ogevia.notification_delivery_events (organization_id, delivery_id, event, detail, attempt) values (v_d.organization_id, v_d.id, 'skipped', 'no_email', v_d.attempts);
      continue;
    end if;
    if v_d.status = 'sending' then
      insert into ogevia.notification_delivery_events (organization_id, delivery_id, event, detail, attempt) values (v_d.organization_id, v_d.id, 'reclaimed', 'stale_claim', v_d.attempts);
    end if;
    update ogevia.notification_deliveries set status = 'sending', attempts = attempts + 1, updated_at = now() where id = v_d.id;
    insert into ogevia.notification_delivery_events (organization_id, delivery_id, event, attempt) values (v_d.organization_id, v_d.id, 'claimed', v_d.attempts + 1);
    delivery_id := v_d.id; organization_id := v_d.organization_id; to_email := v_email; subject := v_d.title; body := v_d.body; link := v_d.link; attempt := v_d.attempts + 1;
    return next;
  end loop;
end;
$$;

-- Records one attempt. outcome: sent | transient | permanent. Transient failures retry with a growing delay (5 min, 15 min, 45 min, 2 h 15 min) and fail after the 5th attempt.
create function ogevia_api.system_email_record(p_delivery_id uuid, p_outcome text, p_provider_message_id text default null, p_error_code text default null)
returns text language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v_d ogevia.notification_deliveries%rowtype; v_next text; v_code text;
begin
  if p_outcome not in ('sent', 'transient', 'permanent') then raise exception 'Unknown outcome' using errcode = 'OGV22'; end if;
  select * into v_d from ogevia.notification_deliveries where id = p_delivery_id for update;
  if v_d.id is null then raise exception 'Delivery not found' using errcode = 'OGN04'; end if;
  if v_d.status <> 'sending' then return v_d.status; end if;   -- a repeated report changes nothing
  v_code := case when p_error_code ~ '^[a-z_]{1,40}$' then p_error_code else 'send_failed' end;
  if p_outcome = 'sent' then
    update ogevia.notification_deliveries set status = 'sent', sent_at = now(), provider_message_id = left(p_provider_message_id, 200), last_error_code = null, updated_at = now() where id = v_d.id;
    insert into ogevia.notification_delivery_events (organization_id, delivery_id, event, attempt) values (v_d.organization_id, v_d.id, 'sent', v_d.attempts);
    return 'sent';
  end if;
  if p_outcome = 'transient' and v_d.attempts < 5 then
    update ogevia.notification_deliveries set status = 'retry', last_error_code = v_code, updated_at = now(),
           next_attempt_at = now() + (interval '5 minutes' * power(3, v_d.attempts - 1)::integer) where id = v_d.id;
    insert into ogevia.notification_delivery_events (organization_id, delivery_id, event, detail, attempt) values (v_d.organization_id, v_d.id, 'retry_scheduled', v_code, v_d.attempts);
    return 'retry';
  end if;
  update ogevia.notification_deliveries set status = 'failed', last_error_code = v_code, updated_at = now() where id = v_d.id;
  insert into ogevia.notification_delivery_events (organization_id, delivery_id, event, detail, attempt) values (v_d.organization_id, v_d.id, 'failed', v_code, v_d.attempts);
  perform ogevia.write_audit(v_d.organization_id, 'notification.delivery_failed', 'notification_deliveries', v_d.id, null, jsonb_build_object('channel', 'email', 'attempts', v_d.attempts, 'code', v_code), null);
  return 'failed';
end;
$$;

revoke all on function ogevia.user_notifications_guard() from public;
revoke all on function ogevia.cover_notify(uuid, uuid, uuid, uuid) from public;
revoke all on function ogevia.cover_service_address(uuid, uuid) from public;
revoke all on function ogevia_api.get_cover_notification_settings(uuid) from public;
revoke all on function ogevia_api.set_cover_notification_settings(uuid, boolean, boolean, boolean, integer, integer, text, text, text) from public;
revoke all on function ogevia_api.set_cover_office_audience(uuid, uuid, text, text) from public;
revoke all on function ogevia_api.list_cover_office_audiences(uuid) from public;
revoke all on function ogevia_api.notify_cover_shift(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.system_cover_notify_orgs() from public;
revoke all on function ogevia_api.system_cover_notify_org(uuid) from public;
revoke all on function ogevia_api.list_user_notifications(uuid, text, text, integer, timestamptz) from public;
revoke all on function ogevia_api.mark_user_notifications(uuid, uuid[], text) from public;
revoke all on function ogevia_api.get_my_notification_preferences(uuid) from public;
revoke all on function ogevia_api.set_my_notification_preferences(uuid, text, boolean, boolean) from public;
revoke all on function ogevia_api.list_cover_notification_history(uuid, integer) from public;
revoke all on function ogevia_api.system_email_claim(integer) from public;
revoke all on function ogevia_api.system_email_record(uuid, text, text, text) from public;
grant execute on function ogevia_api.get_cover_notification_settings(uuid) to ogevia_app;
grant execute on function ogevia_api.set_cover_notification_settings(uuid, boolean, boolean, boolean, integer, integer, text, text, text) to ogevia_app;
grant execute on function ogevia_api.set_cover_office_audience(uuid, uuid, text, text) to ogevia_app;
grant execute on function ogevia_api.list_cover_office_audiences(uuid) to ogevia_app;
grant execute on function ogevia_api.notify_cover_shift(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.system_cover_notify_orgs() to ogevia_app;
grant execute on function ogevia_api.system_cover_notify_org(uuid) to ogevia_app;
grant execute on function ogevia_api.list_user_notifications(uuid, text, text, integer, timestamptz) to ogevia_app;
grant execute on function ogevia_api.mark_user_notifications(uuid, uuid[], text) to ogevia_app;
grant execute on function ogevia_api.get_my_notification_preferences(uuid) to ogevia_app;
grant execute on function ogevia_api.set_my_notification_preferences(uuid, text, boolean, boolean) to ogevia_app;
grant execute on function ogevia_api.list_cover_notification_history(uuid, integer) to ogevia_app;
grant execute on function ogevia_api.system_email_claim(integer) to ogevia_app;
grant execute on function ogevia_api.system_email_record(uuid, text, text, text) to ogevia_app;
grant select on table ogevia.cover_notification_settings, ogevia.user_notifications, ogevia.notification_preferences, ogevia.notification_deliveries, ogevia.notification_delivery_events to ogevia_readonly;
create policy readonly_select on ogevia.cover_notification_settings for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.user_notifications for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.notification_preferences for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.notification_deliveries for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.notification_delivery_events for select to ogevia_readonly using (true);
grant select on table ogevia.cover_notification_office_audience, ogevia.cover_alerts to ogevia_readonly;
create policy readonly_select on ogevia.cover_notification_office_audience for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.cover_alerts for select to ogevia_readonly using (true);
