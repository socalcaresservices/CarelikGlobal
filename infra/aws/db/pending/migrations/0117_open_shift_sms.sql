-- 0117 Open shifts: coverage rounds, cancellation and filled handling, board matching, and automatic texting (mock sender first).
-- Needs 0113 (notifications) and 0063 (pickup requests). Everything is OFF until an agency turns it on; nothing here sends a live text.
--
-- WHAT THIS FIXES (verified against 0026/0063/0113):
--   * Coverage rounds. The alert key was shift+start time only, so after a REPLACEMENT caregiver called out the old key blocked a fresh alert round.
--     The key now carries the round (= number of call-outs of that shift): a replacement call-out starts a fresh round; a repeat within a round is still one copy.
--   * Client cancellation. Cancelling a shift now stops what is pending (queued emails and texts), archives the unread open-shift alerts, and tells only the
--     people who need to know: the assigned caregiver and anyone with a pending request (in-app, and a text if they opted in).
--   * Filled. When a shift is filled (office assignment or confirmed request), the selected caregiver gets the confirmation (in-app and a text if opted in);
--     every other alerted or requesting caregiver gets a "Filled" notice in-app only; pending alerts stop.
--   * Board matching. The caregiver Open Shifts board now follows the same audience rule as the alerts (coordinating office; agency setting and office override),
--     and shows the SERVICE city and the coordinating office. Never the office city in place of the service city.
--   * Office queue: each request says whether it is eligible right now and its rank within its shift (earliest eligible request first) so the screen can preselect it.
-- AUTOMATIC TEXTING (per agency; sender settings and limits are separate for each agency):
--   sms_settings (off by default), sms_contacts (a person's own number and consent: opt-in, STOP), sms_oncall (office / on-call numbers), sms_messages (outbox with
--   statuses, one row per message, unique dedupe key), plus the functions that queue, defer for quiet hours, limit, claim and record. Text bodies never contain a
--   client name, client code, street address or ZIP: the service city, date and time only.
-- Not in this migration: a live sender. provider 'mock' only records and "sends" inside the application; 'live' is stored but the worker refuses it until the owner approves a sender.

-- ---------------------------------------------------------------- rounds and keys
create function ogevia.cover_round(p_shift_id uuid)
returns integer language sql stable set search_path = ogevia, pg_temp as $$
  select count(*)::integer from ogevia.shift_coverage_events e where e.shift_id = p_shift_id and e.event_type = 'called_out';
$$;
create function ogevia.cover_key(p_shift ogevia.shifts)
returns text language sql stable set search_path = ogevia, pg_temp as $$
  select 'cover:' || p_shift.id::text || ':' || floor(extract(epoch from p_shift.starts_at))::bigint::text || ':r' || ogevia.cover_round(p_shift.id)::text;
$$;
revoke all on function ogevia.cover_round(uuid) from public;
revoke all on function ogevia.cover_key(ogevia.shifts) from public;

-- the second category: office-facing alerts (call-out, escalation)
do $$ declare c record; begin
  for c in select conrelid::regclass as t, conname from pg_constraint
            where contype = 'c' and conrelid in ('ogevia.user_notifications'::regclass, 'ogevia.notification_preferences'::regclass) and pg_get_constraintdef(oid) like '%category%' loop
    execute format('alter table %s drop constraint %I', c.t, c.conname);
  end loop;
end $$;
alter table ogevia.user_notifications add constraint user_notifications_category_check check (category in ('cover_shift', 'cover_office'));
alter table ogevia.notification_preferences add constraint notification_preferences_category_check check (category in ('cover_shift', 'cover_office'));

-- ---------------------------------------------------------------- texting tables
create table ogevia.sms_settings (
  organization_id uuid primary key references ogevia.organizations(id),
  enabled boolean not null default false,
  provider text not null default 'mock' check (provider in ('mock', 'live')),
  sender_label text not null default '' check (length(sender_label) <= 24 and sender_label !~ '[<>]'),
  sender_id text check (sender_id is null or sender_id ~ '^\+[1-9][0-9]{7,14}$'),
  sender_verified boolean not null default false,
  daily_limit integer not null default 200 check (daily_limit between 1 and 5000),
  hourly_limit integer not null default 60 check (hourly_limit between 1 and 1000),
  per_recipient_daily integer not null default 3 check (per_recipient_daily between 1 and 20),
  quiet_start time not null default '21:00',
  quiet_end time not null default '08:00',
  recruitment_days integer not null default 14 check (recruitment_days between 1 and 14),
  escalation_hours integer not null default 24 check (escalation_hours between 1 and 72),
  recruit_on boolean not null default true,
  receipt_on boolean not null default true,
  cancel_on boolean not null default true,
  confirm_on boolean not null default true,
  office_on boolean not null default true,
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  constraint sms_live_needs_sender check (provider <> 'live' or sender_id is not null)
);
create table ogevia.sms_contacts (
  organization_id uuid not null references ogevia.organizations(id),
  user_id uuid not null references ogevia.app_users(id),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  status text not null check (status in ('opted_in', 'opted_out')),
  consent_at timestamptz,
  consent_source text check (consent_source in ('in_app', 'sms_reply')),
  consent_text_version text check (consent_text_version is null or length(consent_text_version) <= 20),
  opted_out_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index sms_contacts_phone_idx on ogevia.sms_contacts (phone_e164);
create table ogevia.sms_oncall (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  office_id uuid,
  label text not null check (length(btrim(label)) between 1 and 40),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  active boolean not null default true,
  created_by uuid references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  foreign key (office_id, organization_id) references ogevia.offices (id, organization_id)
);
create unique index sms_oncall_unique on ogevia.sms_oncall (organization_id, coalesce(office_id, '00000000-0000-0000-0000-000000000000'::uuid), phone_e164) where active;
create table ogevia.sms_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  purpose text not null check (purpose in ('recruitment', 'callout_receipt', 'cancel_notice', 'filled_confirmation', 'office_alert', 'escalation')),
  recipient_kind text not null check (recipient_kind in ('caregiver', 'oncall')),
  recipient_user_id uuid references ogevia.app_users(id),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  shift_id uuid references ogevia.shifts(id),
  round integer not null default 0,
  body text not null check (length(body) between 1 and 320),
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  status text not null default 'queued' check (status in ('queued', 'sending', 'retry', 'sent', 'failed', 'cancelled', 'skipped_limit', 'skipped_opted_out')),
  reason text check (reason is null or reason ~ '^[a-z_]{1,40}$'),
  send_after timestamptz not null default now(),
  attempts integer not null default 0 check (attempts between 0 and 10),
  provider text not null default 'mock',
  provider_message_id text check (provider_message_id is null or length(provider_message_id) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (organization_id, dedupe_key)
);
create index sms_messages_due_idx on ogevia.sms_messages (send_after) where status in ('queued', 'retry', 'sending');
create index sms_messages_org_created_idx on ogevia.sms_messages (organization_id, created_at desc);
create index sms_messages_shift_idx on ogevia.sms_messages (shift_id) where shift_id is not null;
create table ogevia.sms_inbound_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  action text not null check (action in ('stop', 'start', 'help', 'ignored')),
  contacts_changed integer not null default 0,
  created_at timestamptz not null default now()
);
do $$ declare t text; begin
  foreach t in array array['sms_settings', 'sms_contacts', 'sms_oncall', 'sms_messages', 'sms_inbound_log'] loop
    execute format('alter table ogevia.%I enable row level security', t);
    execute format('revoke all on ogevia.%I from public', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- helpers
create function ogevia.sms_normalize_phone(p text)
returns text language plpgsql immutable set search_path = ogevia, pg_temp as $$
declare d text := regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g'); v text;
begin
  if d like '+%' then v := '+' || regexp_replace(substr(d, 2), '[^0-9]', '', 'g');
  else d := regexp_replace(d, '[^0-9]', '', 'g');
    if length(d) = 10 then v := '+1' || d; elsif length(d) = 11 and d like '1%' then v := '+' || d; else return null; end if;
  end if;
  return case when v ~ '^\+[1-9][0-9]{7,14}$' then v end;
end;
$$;

-- The one coordinating office of a shift: the only active office, else the shift's own; null when it still has to be chosen.
create function ogevia.cover_office_for(p_organization_id uuid, p_shift ogevia.shifts)
returns uuid language sql stable set search_path = ogevia, pg_temp as $$
  select coalesce(
    (select o.id from ogevia.offices o where o.id = p_shift.coordinating_office_id and o.organization_id = p_organization_id and o.is_active),
    (select o.id from ogevia.clients c join ogevia.offices o on o.id = c.responsible_office_id and o.organization_id = c.organization_id and o.is_active where c.id = p_shift.client_id),
    case when (select count(*) from ogevia.offices o where o.organization_id = p_organization_id and o.is_active) = 1
         then (select o.id from ogevia.offices o where o.organization_id = p_organization_id and o.is_active) end);
$$;
-- Is this caregiver in the audience of the shift's alert? (agency audience, no known office, or assigned to the coordinating office)
create function ogevia.cover_in_audience(p_organization_id uuid, p_shift ogevia.shifts, p_caregiver_record_id uuid)
returns boolean language sql stable set search_path = ogevia, pg_temp as $$
  with s as (select * from ogevia.cover_notification_settings where organization_id = p_organization_id and enabled), o as (select ogevia.cover_office_for(p_organization_id, p_shift) as id)
  select case when not exists (select 1 from s) then true
              when (select id from o) is null then true
              when coalesce((select a.audience from ogevia.cover_notification_office_audience a where a.office_id = (select id from o)), (select audience from s)) = 'agency' then true
              when coalesce((select a.audience from ogevia.cover_notification_office_audience a where a.office_id = (select id from o)), (select audience from s)) = 'none' then false
              else exists (select 1 from ogevia.office_assignments oa where oa.organization_id = p_organization_id and oa.caregiver_record_id = p_caregiver_record_id and oa.office_id = (select id from o)) end;
$$;
revoke all on function ogevia.sms_normalize_phone(text) from public;
revoke all on function ogevia.cover_office_for(uuid, ogevia.shifts) from public;
revoke all on function ogevia.cover_in_audience(uuid, ogevia.shifts, uuid) from public;

-- Quiet hours in the agency's local time (a window that crosses midnight is fine). Returns when a deferred text may go out.
create function ogevia.sms_quiet_until(p_organization_id uuid, p_at timestamptz)
returns timestamptz language plpgsql stable set search_path = ogevia, pg_temp as $$
declare v_set ogevia.sms_settings%rowtype; v_tz text; v_local timestamp; v_t time; v_inq boolean; v_end timestamp;
begin
  select * into v_set from ogevia.sms_settings where organization_id = p_organization_id;
  select timezone into v_tz from ogevia.organizations where id = p_organization_id;
  if v_set.organization_id is null or v_set.quiet_start = v_set.quiet_end then return p_at; end if;
  v_local := p_at at time zone v_tz; v_t := v_local::time;
  v_inq := case when v_set.quiet_start < v_set.quiet_end then v_t >= v_set.quiet_start and v_t < v_set.quiet_end else v_t >= v_set.quiet_start or v_t < v_set.quiet_end end;
  if not v_inq then return p_at; end if;
  v_end := v_local::date + v_set.quiet_end;
  if v_end <= v_local then v_end := v_end + interval '1 day'; end if;
  return v_end at time zone v_tz;
end;
$$;
revoke all on function ogevia.sms_quiet_until(uuid, timestamptz) from public;

-- The one place a text is queued. Returns: disabled | purpose_off | no_consent | duplicate | limit | queued.
-- Caregiver texts need an opted-in contact; on-call texts go to numbers an administrator entered. Quiet hours defer caregiver texts (never receipts, never
-- on-call, never a shift that starts within 12 hours). Limits are per agency (hour, day) and per recipient (day); an over-limit text is recorded as skipped.
create function ogevia.sms_enqueue(p_organization_id uuid, p_purpose text, p_kind text, p_user_id uuid, p_phone text, p_shift_id uuid, p_round integer, p_body text, p_dedupe text, p_shift_starts timestamptz default null)
returns text language plpgsql volatile set search_path = ogevia, pg_temp as $$
declare
  v_set ogevia.sms_settings%rowtype; v_phone text := p_phone; v_after timestamptz := now(); v_id uuid; v_flag boolean;
begin
  select * into v_set from ogevia.sms_settings where organization_id = p_organization_id;
  if v_set.organization_id is null or not v_set.enabled then return 'disabled'; end if;
  v_flag := case p_purpose when 'recruitment' then v_set.recruit_on when 'callout_receipt' then v_set.receipt_on when 'cancel_notice' then v_set.cancel_on
                           when 'filled_confirmation' then v_set.confirm_on else v_set.office_on end;
  if not v_flag then return 'purpose_off'; end if;
  if p_kind = 'caregiver' then
    select c.phone_e164 into v_phone from ogevia.sms_contacts c where c.organization_id = p_organization_id and c.user_id = p_user_id and c.status = 'opted_in';
    if v_phone is null then return 'no_consent'; end if;
  elsif v_phone is null then return 'no_consent';
  end if;
  if exists (select 1 from ogevia.sms_messages m where m.organization_id = p_organization_id and m.dedupe_key = p_dedupe) then return 'duplicate'; end if;
  if p_kind = 'caregiver' and p_purpose <> 'callout_receipt' and not (p_shift_starts is not null and p_shift_starts < now() + interval '12 hours') then
    v_after := ogevia.sms_quiet_until(p_organization_id, now());
  end if;
  if (select count(*) from ogevia.sms_messages m where m.organization_id = p_organization_id and m.created_at > now() - interval '1 hour' and m.status not in ('cancelled', 'skipped_limit', 'skipped_opted_out')) >= v_set.hourly_limit
     or (select count(*) from ogevia.sms_messages m where m.organization_id = p_organization_id and m.created_at > now() - interval '24 hours' and m.status not in ('cancelled', 'skipped_limit', 'skipped_opted_out')) >= v_set.daily_limit
     or (p_kind = 'caregiver' and (select count(*) from ogevia.sms_messages m where m.organization_id = p_organization_id and m.recipient_user_id = p_user_id and m.created_at > now() - interval '24 hours'
                                    and m.status not in ('cancelled', 'skipped_limit', 'skipped_opted_out')) >= v_set.per_recipient_daily) then
    insert into ogevia.sms_messages (organization_id, purpose, recipient_kind, recipient_user_id, phone_e164, shift_id, round, body, dedupe_key, status, reason, provider)
    values (p_organization_id, p_purpose, p_kind, p_user_id, v_phone, p_shift_id, p_round, p_body, p_dedupe, 'skipped_limit', 'limit_reached', v_set.provider)
    on conflict (organization_id, dedupe_key) do nothing;
    return 'limit';
  end if;
  insert into ogevia.sms_messages (organization_id, purpose, recipient_kind, recipient_user_id, phone_e164, shift_id, round, body, dedupe_key, send_after, provider)
  values (p_organization_id, p_purpose, p_kind, p_user_id, v_phone, p_shift_id, p_round, p_body, p_dedupe, v_after, v_set.provider)
  on conflict (organization_id, dedupe_key) do nothing returning id into v_id;
  return case when v_id is null then 'duplicate' else 'queued' end;
end;
$$;
revoke all on function ogevia.sms_enqueue(uuid, text, text, uuid, text, uuid, integer, text, text, timestamptz) from public;

-- Message text. No client name, client code, street address or ZIP: the service city, date and time only. Caregiver texts end with the STOP line.
create function ogevia.sms_text(p_organization_id uuid, p_kind text, p_shift ogevia.shifts, p_city text)
returns text language plpgsql stable set search_path = ogevia, pg_temp as $$
declare v_tz text; v_label text; v_when text; v_stop text := ' Reply STOP to opt out.'; v_where text := coalesce(p_city, 'address incomplete');
begin
  select timezone into v_tz from ogevia.organizations where id = p_organization_id;
  select nullif(btrim(sender_label), '') into v_label from ogevia.sms_settings where organization_id = p_organization_id;
  v_label := coalesce(v_label, 'Ogevia');
  v_when := to_char(p_shift.starts_at at time zone v_tz, 'Dy, Mon FMDD FMHH12:MI AM') || '–' || to_char(p_shift.ends_at at time zone v_tz, 'FMHH12:MI AM');
  return case p_kind
    when 'recruitment' then v_label || ': Open shift in ' || v_where || ', ' || v_when || '. Request it in Ogevia.' || v_stop
    when 'callout_receipt' then v_label || ': We recorded your call-out for ' || v_when || '. The office is arranging coverage.' || v_stop
    when 'cancel_notice' then v_label || ': The shift in ' || v_where || ', ' || v_when || ', was cancelled.' || v_stop
    when 'filled_confirmation' then v_label || ': You are confirmed for the shift in ' || v_where || ', ' || v_when || '.' || v_stop
    when 'callout_alert' then v_label || ': Call-out. The shift in ' || v_where || ', ' || v_when || ', needs coverage. Open Ogevia.'
    else v_label || ': Escalation. The shift in ' || v_where || ', ' || v_when || ', is still unfilled. Open Ogevia.' end;
end;
$$;
revoke all on function ogevia.sms_text(uuid, text, ogevia.shifts, text) from public;

-- ---------------------------------------------------------------- settings, consent, on-call (API)
create function ogevia_api.get_sms_settings(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v ogevia.sms_settings%rowtype;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'shifts.manage') then raise exception 'You do not have permission to see text-message settings' using errcode = 'OGA03'; end if;
  select * into v from ogevia.sms_settings where organization_id = p_organization_id;
  if v.organization_id is null then v := row(p_organization_id, false, 'mock', '', null, false, 200, 60, 3, '21:00', '08:00', 14, 24, true, true, true, true, true, null, now()); end if;
  return jsonb_build_object('enabled', v.enabled, 'provider', v.provider, 'senderLabel', v.sender_label, 'senderId', v.sender_id, 'senderVerified', v.sender_verified,
    'dailyLimit', v.daily_limit, 'hourlyLimit', v.hourly_limit, 'perRecipientDaily', v.per_recipient_daily,
    'quietStart', to_char(v.quiet_start, 'HH24:MI'), 'quietEnd', to_char(v.quiet_end, 'HH24:MI'), 'recruitmentDays', v.recruitment_days, 'escalationHours', v.escalation_hours,
    'recruitOn', v.recruit_on, 'receiptOn', v.receipt_on, 'cancelOn', v.cancel_on, 'confirmOn', v.confirm_on, 'officeOn', v.office_on,
    'sentToday', (select count(*) from ogevia.sms_messages m where m.organization_id = p_organization_id and m.created_at > now() - interval '24 hours' and m.status not in ('cancelled', 'skipped_limit', 'skipped_opted_out')),
    'liveSending', false);
end;
$$;
create function ogevia_api.set_sms_settings(p_organization_id uuid, p_settings jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor(); v_old jsonb; j jsonb := coalesce(p_settings, '{}'::jsonb);
  v_provider text := coalesce(j ->> 'provider', 'mock'); v_sender text := nullif(btrim(coalesce(j ->> 'senderId', '')), '');
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'Only the agency owner can change text-message settings' using errcode = 'OGA03'; end if;
  if v_provider not in ('mock', 'live') then raise exception 'Choose the test sender or the live sender' using errcode = 'OGV22'; end if;
  if v_sender is not null then v_sender := ogevia.sms_normalize_phone(v_sender); if v_sender is null then raise exception 'Enter the sender number with the country code, for example +19515550123' using errcode = 'OGV22'; end if; end if;
  if v_provider = 'live' and v_sender is null then raise exception 'The live sender needs the sender number first' using errcode = 'OGV22'; end if;
  begin
    v_old := ogevia_api.get_sms_settings(p_organization_id);
    insert into ogevia.sms_settings as s (organization_id, enabled, provider, sender_label, sender_id, daily_limit, hourly_limit, per_recipient_daily, quiet_start, quiet_end,
      recruitment_days, escalation_hours, recruit_on, receipt_on, cancel_on, confirm_on, office_on, updated_by, updated_at)
    values (p_organization_id, coalesce((j ->> 'enabled')::boolean, false), v_provider, btrim(coalesce(j ->> 'senderLabel', '')), v_sender,
      coalesce((j ->> 'dailyLimit')::integer, 200), coalesce((j ->> 'hourlyLimit')::integer, 60), coalesce((j ->> 'perRecipientDaily')::integer, 3),
      coalesce((j ->> 'quietStart')::time, '21:00'), coalesce((j ->> 'quietEnd')::time, '08:00'), coalesce((j ->> 'recruitmentDays')::integer, 14), coalesce((j ->> 'escalationHours')::integer, 24),
      coalesce((j ->> 'recruitOn')::boolean, true), coalesce((j ->> 'receiptOn')::boolean, true), coalesce((j ->> 'cancelOn')::boolean, true),
      coalesce((j ->> 'confirmOn')::boolean, true), coalesce((j ->> 'officeOn')::boolean, true), v_actor, now())
    on conflict (organization_id) do update set enabled = excluded.enabled, provider = excluded.provider, sender_label = excluded.sender_label, sender_id = excluded.sender_id,
      sender_verified = case when excluded.sender_id is distinct from s.sender_id then false else s.sender_verified end,
      daily_limit = excluded.daily_limit, hourly_limit = excluded.hourly_limit, per_recipient_daily = excluded.per_recipient_daily, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
      recruitment_days = excluded.recruitment_days, escalation_hours = excluded.escalation_hours, recruit_on = excluded.recruit_on, receipt_on = excluded.receipt_on, cancel_on = excluded.cancel_on,
      confirm_on = excluded.confirm_on, office_on = excluded.office_on, updated_by = v_actor, updated_at = now();
  exception when check_violation or invalid_text_representation or invalid_datetime_format or numeric_value_out_of_range then
    raise exception 'A text-message setting is out of range. Check the limits, quiet hours (HH:MM), recruitment days (1 to 14) and escalation hours (1 to 72).' using errcode = 'OGV22';
  end;
  perform ogevia.write_audit(p_organization_id, 'sms_settings.updated', 'sms_settings', p_organization_id, v_old - 'senderId', ogevia_api.get_sms_settings(p_organization_id) - 'senderId', null);
  return ogevia_api.get_sms_settings(p_organization_id);
end;
$$;

create function ogevia_api.get_my_sms(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v ogevia.sms_contacts%rowtype; v_on boolean;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  select * into v from ogevia.sms_contacts where organization_id = p_organization_id and user_id = ogevia.require_actor();
  select coalesce(enabled, false) into v_on from ogevia.sms_settings where organization_id = p_organization_id;
  return jsonb_build_object('available', coalesce(v_on, false), 'status', coalesce(v.status, 'none'), 'phoneLast4', right(v.phone_e164, 4), 'consentAt', v.consent_at, 'optedOutAt', v.opted_out_at);
end;
$$;
create function ogevia_api.set_my_sms(p_organization_id uuid, p_phone text, p_consent boolean, p_consent_version text default 'v1')
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); v_phone text; v_old text;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if p_consent is null then raise exception 'Choose whether to receive texts' using errcode = 'OGV22'; end if;
  select status into v_old from ogevia.sms_contacts where organization_id = p_organization_id and user_id = v_actor;
  if p_consent then
    v_phone := ogevia.sms_normalize_phone(p_phone);
    if v_phone is null then raise exception 'Enter a valid mobile number' using errcode = 'OGV22'; end if;
    insert into ogevia.sms_contacts (organization_id, user_id, phone_e164, status, consent_at, consent_source, consent_text_version, opted_out_at, updated_at)
    values (p_organization_id, v_actor, v_phone, 'opted_in', now(), 'in_app', left(coalesce(p_consent_version, 'v1'), 20), null, now())
    on conflict (organization_id, user_id) do update set phone_e164 = excluded.phone_e164, status = 'opted_in', consent_at = now(), consent_source = 'in_app',
      consent_text_version = excluded.consent_text_version, opted_out_at = null, updated_at = now();
  else
    update ogevia.sms_contacts set status = 'opted_out', opted_out_at = now(), updated_at = now() where organization_id = p_organization_id and user_id = v_actor;
    update ogevia.sms_messages set status = 'cancelled', reason = 'opted_out', updated_at = now()
     where organization_id = p_organization_id and recipient_user_id = v_actor and status in ('queued', 'retry');
  end if;
  perform ogevia.write_audit(p_organization_id, case when p_consent then 'sms_consent.opted_in' else 'sms_consent.opted_out' end, 'sms_contacts', v_actor, jsonb_build_object('status', v_old), jsonb_build_object('status', case when p_consent then 'opted_in' else 'opted_out' end), null);
  return ogevia_api.get_my_sms(p_organization_id);
end;
$$;

create function ogevia_api.list_sms_oncall(p_organization_id uuid)
returns table (id uuid, office_id uuid, office_name text, label text, phone_last4 text, active boolean)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  select c.id, c.office_id, o.name, c.label, right(c.phone_e164, 4), c.active
  from ogevia.sms_oncall c left join ogevia.offices o on o.id = c.office_id
  where c.organization_id = p_organization_id and c.active and ogevia.require_actor() is not null and ogevia.is_active_member(p_organization_id) and ogevia.has_permission(p_organization_id, 'shifts.manage')
  order by lower(coalesce(o.name, '')), lower(c.label);
$$;
create function ogevia_api.set_sms_oncall(p_organization_id uuid, p_action text, p_office_id uuid, p_label text, p_phone text, p_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); v_phone text; v_new uuid;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'Only the agency owner can change on-call numbers' using errcode = 'OGA03'; end if;
  if p_action = 'add' then
    v_phone := ogevia.sms_normalize_phone(p_phone);
    if v_phone is null then raise exception 'Enter a valid mobile number' using errcode = 'OGV22'; end if;
    if length(btrim(coalesce(p_label, ''))) not between 1 and 40 then raise exception 'Give the number a short label' using errcode = 'OGV22'; end if;
    if p_office_id is not null and not exists (select 1 from ogevia.offices o where o.id = p_office_id and o.organization_id = p_organization_id and o.is_active) then raise exception 'Office not found' using errcode = 'OGN04'; end if;
    insert into ogevia.sms_oncall (organization_id, office_id, label, phone_e164, created_by) values (p_organization_id, p_office_id, btrim(p_label), v_phone, v_actor) returning id into v_new;
    perform ogevia.write_audit(p_organization_id, 'sms_oncall.added', 'sms_oncall', v_new, null, jsonb_build_object('officeId', p_office_id), null);
    return jsonb_build_object('id', v_new);
  elsif p_action = 'remove' then
    update ogevia.sms_oncall set active = false where id = p_id and organization_id = p_organization_id and active;
    if not found then raise exception 'On-call number not found' using errcode = 'OGN04'; end if;
    update ogevia.sms_messages set status = 'cancelled', reason = 'removed', updated_at = now()
     where organization_id = p_organization_id and recipient_kind = 'oncall' and status in ('queued', 'retry') and phone_e164 = (select phone_e164 from ogevia.sms_oncall where id = p_id);
    perform ogevia.write_audit(p_organization_id, 'sms_oncall.removed', 'sms_oncall', p_id, null, null, null);
    return jsonb_build_object('id', p_id);
  end if;
  raise exception 'Choose add or remove' using errcode = 'OGV22';
end;
$$;
create function ogevia_api.list_sms_history(p_organization_id uuid, p_limit integer default 50)
returns table (id uuid, purpose text, recipient_kind text, status text, reason text, shift_id uuid, round integer, phone_last4 text, send_after timestamptz, sent_at timestamptz, created_at timestamptz, provider text)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  select m.id, m.purpose, m.recipient_kind, m.status, m.reason, m.shift_id, m.round, right(m.phone_e164, 4), m.send_after, m.sent_at, m.created_at, m.provider
  from ogevia.sms_messages m
  where m.organization_id = p_organization_id and ogevia.require_actor() is not null and ogevia.is_active_member(p_organization_id) and ogevia.has_permission(p_organization_id, 'shifts.manage')
  order by m.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- ---------------------------------------------------------------- alert: rounds + texting (replaces the 0113 functions; the 4-argument form goes away)
drop function ogevia.cover_notify(uuid, uuid, uuid, uuid);
create or replace function ogevia.cover_notify(p_organization_id uuid, p_shift_id uuid, p_office_id uuid default null, p_sender uuid default null, p_sms_only boolean default false)
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
  v_round integer; v_smsset ogevia.sms_settings%rowtype; v_sms text; v_sms_q integer := 0; v_sms_s integer := 0; v_in_window boolean; v_sms_body text;
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
  v_office := ogevia.cover_office_for(p_organization_id, v_s);   -- the shift's own office, else the client's coordinating office, else the agency's only office
  if v_office is not null then null;
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
  v_key := ogevia.cover_key(v_s); v_round := ogevia.cover_round(v_s.id);
  select * into v_smsset from ogevia.sms_settings where organization_id = p_organization_id;
  v_in_window := v_smsset.organization_id is not null and v_smsset.enabled and v_s.starts_at <= now() + make_interval(days => v_smsset.recruitment_days);
  v_sms_body := ogevia.sms_text(p_organization_id, 'recruitment', v_s, v_city);

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
    if v_in_window then   -- the 14-day (or shorter, per agency) recruitment window; text only people who opted in; one text per person, shift and round
      v_sms := ogevia.sms_enqueue(p_organization_id, 'recruitment', 'caregiver', v_rec.user_id, null, v_s.id, v_round, v_sms_body, 'sms:' || v_key || ':' || v_rec.user_id::text, v_s.starts_at);
      if v_sms = 'queued' then v_sms_q := v_sms_q + 1; else v_sms_s := v_sms_s + 1; end if;
    end if;
    if p_sms_only then continue; end if;
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
  if v_sent > 0 or v_sms_q > 0 then
    insert into ogevia.cover_alerts (organization_id, shift_id, office_id, service_city, sent_by, recipients, dedupe_key)
    values (p_organization_id, v_s.id, v_office, v_city, p_sender, greatest(v_sent, v_sms_q), v_key || ':' || gen_random_uuid()::text);
    -- counts and the office only: no name, address, ZIP or contact detail enters the audit trail
    perform ogevia.write_audit(p_organization_id, 'cover_notification.created', 'shifts', v_s.id, null,
      jsonb_build_object('notified', v_sent, 'emailQueued', v_queued, 'alreadyNotified', v_existing, 'notEligible', v_skipped, 'smsQueued', v_sms_q, 'officeId', v_office, 'audience', v_aud, 'round', v_round), null);
  end if;
  return jsonb_build_object('state', 'done', 'notified', v_sent, 'emailQueued', v_queued, 'alreadyNotified', v_existing, 'notEligible', v_skipped,
                            'smsQueued', v_sms_q, 'smsSkipped', v_sms_s, 'round', v_round, 'serviceCity', v_city, 'office', v_office_name, 'subject', v_title);
end;
$$;
create or replace function ogevia_api.system_cover_notify_org(p_organization_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare
  v_set ogevia.cover_notification_settings%rowtype;
  v_sms ogevia.sms_settings%rowtype; v_shift uuid; v_only boolean; v_r jsonb; v_shifts integer := 0; v_notified integer := 0; v_blocked jsonb := '{}'::jsonb;
begin
  select * into v_set from ogevia.cover_notification_settings where organization_id = p_organization_id and enabled and auto_notify;
  if v_set.organization_id is null then return jsonb_build_object('shifts', 0, 'notified', 0, 'blocked', '{}'::jsonb); end if;
  select * into v_sms from ogevia.sms_settings where organization_id = p_organization_id and enabled and recruit_on;
  for v_shift in
    select s.id from ogevia.shifts s
    where s.organization_id = p_organization_id and s.status = 'scheduled' and s.starts_at > now()
      and s.starts_at <= now() + greatest(make_interval(hours => v_set.window_hours), case when v_sms.organization_id is not null then make_interval(days => v_sms.recruitment_days) else interval '0' end)
      and ogevia.shift_coverage_state(s) = 'needs_coverage' and not ogevia.shift_is_care_request(s.id)
      and not exists (select 1 from ogevia.user_notifications n where n.organization_id = p_organization_id and n.shift_id = s.id and n.dedupe_key = ogevia.cover_key(s))
      and not exists (select 1 from ogevia.sms_messages m where m.organization_id = p_organization_id and m.shift_id = s.id and m.dedupe_key like 'sms:' || ogevia.cover_key(s) || ':%' and m.status <> 'cancelled')
    order by s.starts_at limit 200
  loop
    perform pg_advisory_xact_lock(hashtextextended('cover_notify:' || v_shift::text, 0));
    v_only := (select s.starts_at > now() + make_interval(hours => v_set.window_hours) from ogevia.shifts s where s.id = v_shift);   -- beyond the in-app window: text only
    v_r := ogevia.cover_notify(p_organization_id, v_shift, null, null, v_only);
    v_shifts := v_shifts + 1; v_notified := v_notified + coalesce((v_r ->> 'notified')::integer, 0);
    if v_r ->> 'state' in ('office_required', 'address_incomplete', 'office_audience_off') then
      v_blocked := jsonb_set(v_blocked, array[v_r ->> 'state'], to_jsonb(coalesce((v_blocked ->> (v_r ->> 'state'))::integer, 0) + 1));
    end if;
  end loop;
  return jsonb_build_object('shifts', v_shifts, 'notified', v_notified, 'blocked', v_blocked);
end;
$$;

-- ---------------------------------------------------------------- people to tell: in-app (+ email by preference), office and on-call
create function ogevia.cover_notify_user(p_organization_id uuid, p_user_id uuid, p_category text, p_title text, p_body text, p_shift_id uuid, p_dedupe text)
returns boolean language plpgsql volatile set search_path = ogevia, pg_temp as $$
declare v_pref ogevia.notification_preferences%rowtype; v_set ogevia.cover_notification_settings%rowtype; v_in_app boolean; v_email boolean; v_nid uuid; v_did uuid;
begin
  select * into v_set from ogevia.cover_notification_settings where organization_id = p_organization_id;
  select * into v_pref from ogevia.notification_preferences p where p.organization_id = p_organization_id and p.user_id = p_user_id and p.category = p_category;
  v_in_app := coalesce(v_pref.in_app, true); v_email := coalesce(v_pref.email, true) and coalesce(v_set.email_enabled, false);
  if not v_in_app and not v_email then return false; end if;
  insert into ogevia.user_notifications (organization_id, recipient_user_id, category, title, body, link, shift_id, dedupe_key, in_app)
  values (p_organization_id, p_user_id, p_category, left(p_title, 200), left(p_body, 500), '/schedule', p_shift_id, p_dedupe, v_in_app)
  on conflict (organization_id, recipient_user_id, dedupe_key) do nothing returning id into v_nid;
  if v_nid is null then return false; end if;
  if v_email then
    insert into ogevia.notification_deliveries (organization_id, notification_id, channel) values (p_organization_id, v_nid, 'email') returning id into v_did;
    insert into ogevia.notification_delivery_events (organization_id, delivery_id, event) values (p_organization_id, v_did, 'queued');
  end if;
  return true;
end;
$$;
revoke all on function ogevia.cover_notify_user(uuid, uuid, text, text, text, uuid, text) from public;

create function ogevia.cover_line(p_organization_id uuid, p_shift ogevia.shifts)
returns text language plpgsql stable set search_path = ogevia, pg_temp as $$
declare v_tz text; v_city text;
begin
  select timezone into v_tz from ogevia.organizations where id = p_organization_id;
  select a.city into v_city from ogevia.cover_service_address(p_organization_id, p_shift.client_id) a;
  return coalesce(v_city, 'address incomplete') || ' | ' || to_char(p_shift.starts_at at time zone v_tz, 'Dy, Mon FMDD') || ' | '
         || to_char(p_shift.starts_at at time zone v_tz, 'FMHH12:MI AM') || '–' || to_char(p_shift.ends_at at time zone v_tz, 'FMHH12:MI AM');
end;
$$;
revoke all on function ogevia.cover_line(uuid, ogevia.shifts) from public;

-- Tell the office: every active manager (in-app, and email if they chose it) and the on-call numbers of the coordinating office (else the agency-wide ones).
create function ogevia.cover_tell_office(p_organization_id uuid, p_shift ogevia.shifts, p_kind text)
returns void language plpgsql volatile set search_path = ogevia, pg_temp as $$
declare
  v_round integer := ogevia.cover_round(p_shift.id); v_office uuid := ogevia.cover_office_for(p_organization_id, p_shift); v_office_name text; v_city text; v_line text; v_u uuid; v_oc record;
  v_title text; v_tag text := case when p_kind = 'callout' then 'callout' else 'esc' end;
begin
  select o.name into v_office_name from ogevia.offices o where o.id = v_office;
  select a.city into v_city from ogevia.cover_service_address(p_organization_id, p_shift.client_id) a;
  v_line := ogevia.cover_line(p_organization_id, p_shift);
  v_title := case when p_kind = 'callout' then 'Call-out | ' else 'Still unfilled | ' end || v_line;
  for v_u in
    select distinct m.user_id from ogevia.organization_memberships m join ogevia.role_permissions rp on rp.role = m.role and rp.permission_key = 'shifts.manage'
      join ogevia.app_users u on u.id = m.user_id and u.status = 'active' where m.organization_id = p_organization_id and m.status = 'active'
  loop
    perform ogevia.cover_notify_user(p_organization_id, v_u, 'cover_office', v_title,
      case when p_kind = 'callout' then 'A caregiver called out. The shift is open again and its authorization reservation is kept.' else 'No one has been confirmed yet.' end
      || E'\nService city: ' || coalesce(v_city, 'address incomplete') || E'\nCoordinating office: ' || coalesce(v_office_name, 'not set'),
      p_shift.id, v_tag || ':' || p_shift.id::text || ':r' || v_round::text);
  end loop;
  for v_oc in select c.id, c.phone_e164 from ogevia.sms_oncall c where c.organization_id = p_organization_id and c.active
                and (c.office_id = v_office or (c.office_id is null and not exists (select 1 from ogevia.sms_oncall x where x.organization_id = p_organization_id and x.active and x.office_id = v_office)))
  loop
    perform ogevia.sms_enqueue(p_organization_id, case when p_kind = 'callout' then 'office_alert' else 'escalation' end, 'oncall', null, v_oc.phone_e164, p_shift.id, v_round,
      ogevia.sms_text(p_organization_id, case when p_kind = 'callout' then 'callout_alert' else 'escalation' end, p_shift, v_city), 'sms:' || v_tag || ':' || p_shift.id::text || ':r' || v_round::text || ':' || v_oc.id::text);
  end loop;
end;
$$;
revoke all on function ogevia.cover_tell_office(uuid, ogevia.shifts, text) from public;

-- A caregiver (or the office on their behalf) calls out: the same shift reopens and keeps its reservation (nothing here touches reservations);
-- the caregiver gets a text receipt (if opted in); the office and on-call are told. The next sweep starts the new recruitment round.
create function ogevia.cover_on_callout(p_organization_id uuid, p_shift ogevia.shifts)
returns void language plpgsql volatile set search_path = ogevia, pg_temp as $$
declare v_user uuid; v_city text;
begin
  select cr.linked_user_id into v_user from ogevia.caregiver_records cr where cr.id = p_shift.caregiver_record_id;
  select a.city into v_city from ogevia.cover_service_address(p_organization_id, p_shift.client_id) a;
  if v_user is not null then
    perform ogevia.sms_enqueue(p_organization_id, 'callout_receipt', 'caregiver', v_user, null, p_shift.id, ogevia.cover_round(p_shift.id),
      ogevia.sms_text(p_organization_id, 'callout_receipt', p_shift, v_city), 'sms:receipt:' || p_shift.id::text || ':r' || ogevia.cover_round(p_shift.id)::text || ':' || v_user::text, p_shift.starts_at);
  end if;
  perform ogevia.cover_tell_office(p_organization_id, p_shift, 'callout');
end;
$$;
revoke all on function ogevia.cover_on_callout(uuid, ogevia.shifts) from public;

-- call-out hook: the 0026 function plus ONE line (cover_on_callout)
create or replace function ogevia.callout_shift(p_organization_id uuid, p_s ogevia.shifts, p_actor uuid, p_reason text, p_by text)
returns void
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
begin
  if p_s.caregiver_record_id is null and p_s.caregiver_user_id is null then
    raise exception 'This shift has no caregiver to call out' using errcode = 'OGC09';
  end if;
  if ogevia.shift_is_called_out(p_s.id) then raise exception 'This call-out is already recorded' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = p_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit has already started for this shift' using errcode = 'OGC09';
  end if;
  insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type, actor_user_id, original_caregiver_record_id, reason, before_snapshot, after_snapshot)
  values (p_organization_id, p_s.id, 'called_out', p_actor, p_s.caregiver_record_id, p_reason,
          jsonb_build_object('caregiver_record_id', p_s.caregiver_record_id), jsonb_build_object('coverage_needed', true, 'recorded_by', p_by));
  perform ogevia.write_audit(p_organization_id, 'shift.called_out', 'shifts', p_s.id,
    jsonb_build_object('caregiver_record_id', p_s.caregiver_record_id), jsonb_build_object('coverage_needed', true, 'recorded_by', p_by), p_reason);
  perform ogevia.cover_on_callout(p_organization_id, p_s);   -- 0117: receipt, office and on-call alerts
end;
$$;

-- Stop what is pending for a shift (queued texts, queued emails) and archive its unread open-shift alerts.
create function ogevia.cover_stop_pending(p_organization_id uuid, p_shift_id uuid, p_reason text)
returns void language plpgsql volatile set search_path = ogevia, pg_temp as $$
begin
  update ogevia.sms_messages set status = 'cancelled', reason = p_reason, updated_at = now()
   where organization_id = p_organization_id and shift_id = p_shift_id and status in ('queued', 'retry') and purpose in ('recruitment', 'office_alert', 'escalation');
  with d as (
    update ogevia.notification_deliveries d set status = 'skipped', updated_at = now()
      from ogevia.user_notifications n
     where n.id = d.notification_id and n.organization_id = p_organization_id and n.shift_id = p_shift_id and d.status in ('queued', 'retry') returning d.id)
  insert into ogevia.notification_delivery_events (organization_id, delivery_id, event, detail) select p_organization_id, d.id, 'skipped', p_reason from d;
  update ogevia.user_notifications set archived_at = now()
   where organization_id = p_organization_id and shift_id = p_shift_id and archived_at is null and read_at is null and dedupe_key like 'cover:%';
end;
$$;
revoke all on function ogevia.cover_stop_pending(uuid, uuid, text) from public;

-- Client cancellation (or any cancellation of the shift): close the posting, stop pending alerts, tell only the assigned caregiver and anyone with a pending request.
create function ogevia.shifts_cover_cancelled()
returns trigger language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_u uuid; v_line text; v_city text; v_round integer := ogevia.cover_round(new.id); v_assigned uuid;
begin
  perform ogevia.cover_stop_pending(new.organization_id, new.id, 'shift_cancelled');
  v_line := ogevia.cover_line(new.organization_id, new);
  select a.city into v_city from ogevia.cover_service_address(new.organization_id, new.client_id) a;
  if new.caregiver_record_id is not null and not ogevia.shift_is_called_out(new.id) then
    select cr.linked_user_id into v_assigned from ogevia.caregiver_records cr where cr.id = new.caregiver_record_id;
  end if;
  for v_u in
    select distinct u from (select v_assigned as u
      union all select cr.linked_user_id from ogevia.shift_pickup_requests r join ogevia.caregiver_records cr on cr.id = r.caregiver_record_id
        where r.shift_id = new.id and (r.status = 'pending' or (r.status = 'superseded' and r.decided_at > now() - interval '1 minute'))) x where u is not null
  loop
    perform ogevia.cover_notify_user(new.organization_id, v_u, 'cover_shift', 'Cancelled | ' || v_line, 'The shift was cancelled. Nothing more is needed from you.', new.id, 'cancelled:' || new.id::text || ':r' || v_round::text);
    perform ogevia.sms_enqueue(new.organization_id, 'cancel_notice', 'caregiver', v_u, null, new.id, v_round, ogevia.sms_text(new.organization_id, 'cancel_notice', new, v_city),
      'sms:cancel:' || new.id::text || ':r' || v_round::text || ':' || v_u::text, new.starts_at);
  end loop;
  return null;
end;
$$;
revoke all on function ogevia.shifts_cover_cancelled() from public;
create trigger shifts_cover_cancelled after update of status on ogevia.shifts
for each row when (old.status is distinct from new.status and new.status = 'cancelled') execute function ogevia.shifts_cover_cancelled();

-- A shift that was open is filled (office assignment or confirmed request): the selected caregiver gets the confirmation; every other alerted or requesting
-- caregiver gets "Filled" in-app only; pending alerts stop. A swap of an already-covered shift is not an open-shift fill and tells no one here.
create function ogevia.shifts_cover_filled()
returns trigger language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_round integer := ogevia.cover_round(new.id); v_prev text; v_open boolean; v_sel uuid; v_u uuid; v_line text; v_city text;
begin
  -- Was the shift open before THIS change? Yes when it had no caregiver, or when the last event before this transaction was a call-out.
  select e.event_type into v_prev from ogevia.shift_coverage_events e where e.shift_id = new.id and e.created_at < now() order by e.created_at desc limit 1;
  v_open := old.caregiver_record_id is null or v_prev = 'called_out';
  if not v_open or new.status <> 'scheduled' then return null; end if;
  select cr.linked_user_id into v_sel from ogevia.caregiver_records cr where cr.id = new.caregiver_record_id;
  v_line := ogevia.cover_line(new.organization_id, new);
  select a.city into v_city from ogevia.cover_service_address(new.organization_id, new.client_id) a;
  perform ogevia.cover_stop_pending(new.organization_id, new.id, 'shift_filled');
  if v_sel is not null then
    perform ogevia.cover_notify_user(new.organization_id, v_sel, 'cover_shift', 'You are confirmed | ' || v_line, 'The office confirmed you for this shift.', new.id, 'confirmed:' || new.id::text || ':r' || v_round::text || ':' || v_sel::text);
    perform ogevia.sms_enqueue(new.organization_id, 'filled_confirmation', 'caregiver', v_sel, null, new.id, v_round, ogevia.sms_text(new.organization_id, 'filled_confirmation', new, v_city),
      'sms:confirm:' || new.id::text || ':r' || v_round::text || ':' || v_sel::text, new.starts_at);
  end if;
  for v_u in
    select distinct u from (select n.recipient_user_id as u from ogevia.user_notifications n where n.shift_id = new.id and n.category = 'cover_shift' and n.dedupe_key like 'cover:%'
      union all select cr.linked_user_id from ogevia.shift_pickup_requests r join ogevia.caregiver_records cr on cr.id = r.caregiver_record_id where r.shift_id = new.id) x
    where u is not null and u is distinct from v_sel
  loop
    perform ogevia.cover_notify_user(new.organization_id, v_u, 'cover_shift', 'Filled | ' || v_line, 'Someone else was confirmed for this shift. No action needed.', new.id, 'filled:' || new.id::text || ':r' || v_round::text || ':' || v_u::text);
  end loop;
  return null;
end;
$$;
revoke all on function ogevia.shifts_cover_filled() from public;
create trigger shifts_cover_filled after update of caregiver_record_id, caregiver_user_id on ogevia.shifts
for each row when (new.caregiver_record_id is not null and new.caregiver_record_id is distinct from old.caregiver_record_id) execute function ogevia.shifts_cover_filled();

-- ---------------------------------------------------------------- escalation, STOP handling, the sender queue (system functions: the sweep and the inbound handler)
create function ogevia_api.system_sms_escalate_org(p_organization_id uuid)
returns integer language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v_hours integer; v_s ogevia.shifts%rowtype; v_n integer := 0;
begin
  if not exists (select 1 from ogevia.cover_notification_settings where organization_id = p_organization_id and enabled) then return 0; end if;
  select coalesce((select escalation_hours from ogevia.sms_settings where organization_id = p_organization_id), 24) into v_hours;
  for v_s in
    select s.* from ogevia.shifts s
    where s.organization_id = p_organization_id and s.status = 'scheduled' and s.starts_at > now() and ogevia.shift_coverage_state(s) = 'needs_coverage' and not ogevia.shift_is_care_request(s.id)
      and exists (select 1 from ogevia.cover_alerts a where a.shift_id = s.id and a.dedupe_key like ogevia.cover_key(s) || ':%' and a.created_at <= now() - make_interval(hours => v_hours))
      and not exists (select 1 from ogevia.user_notifications n where n.shift_id = s.id and n.dedupe_key = 'esc:' || s.id::text || ':r' || ogevia.cover_round(s.id)::text)
    order by s.starts_at limit 100
  loop
    perform pg_advisory_xact_lock(hashtextextended('cover_escalate:' || v_s.id::text, 0));
    perform ogevia.cover_tell_office(p_organization_id, v_s, 'escalation'); v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
create function ogevia_api.system_sms_escalate_orgs()
returns integer language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v_org uuid; v_n integer := 0;
begin
  for v_org in select organization_id from ogevia.cover_notification_settings where enabled loop v_n := v_n + ogevia_api.system_sms_escalate_org(v_org); end loop;
  return v_n;
end;
$$;

-- Inbound reply from a person's phone to an agency's sender number. STOP-type words opt out at once (every agency that uses that sender number);
-- START/UNSTOP/YES opts back in only for someone who had opted in before; HELP changes nothing (the carrier/provider answers HELP). Returns the action and a count.
create function ogevia_api.system_sms_inbound(p_to text, p_from text, p_body text)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v_to text := ogevia.sms_normalize_phone(p_to); v_from text := ogevia.sms_normalize_phone(p_from); v_word text := upper(regexp_replace(btrim(coalesce(p_body, '')), '[^A-Za-z]', '', 'g'));
  v_action text; v_n integer := 0; v_org uuid; v_c integer;
begin
  if v_from is null then return jsonb_build_object('action', 'ignored', 'changed', 0); end if;
  v_action := case when v_word in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT') then 'stop' when v_word in ('START', 'UNSTOP', 'YES') then 'start' when v_word = 'HELP' then 'help' else 'ignored' end;
  for v_org in select s.organization_id from ogevia.sms_settings s where v_to is null or s.sender_id = v_to loop
    v_c := 0;
    if v_action = 'stop' then
      update ogevia.sms_contacts set status = 'opted_out', opted_out_at = now(), consent_source = 'sms_reply', updated_at = now() where organization_id = v_org and phone_e164 = v_from and status = 'opted_in';
      get diagnostics v_c = row_count;
      update ogevia.sms_messages set status = 'cancelled', reason = 'opted_out', updated_at = now() where organization_id = v_org and phone_e164 = v_from and recipient_kind = 'caregiver' and status in ('queued', 'retry');
    elsif v_action = 'start' then
      update ogevia.sms_contacts set status = 'opted_in', opted_out_at = null, consent_source = 'sms_reply', updated_at = now() where organization_id = v_org and phone_e164 = v_from and status = 'opted_out' and consent_at is not null;
      get diagnostics v_c = row_count;
    end if;
    insert into ogevia.sms_inbound_log (organization_id, action, contacts_changed) values (v_org, v_action, v_c);
    v_n := v_n + v_c;
  end loop;
  return jsonb_build_object('action', v_action, 'changed', v_n);
end;
$$;

-- The sender queue: claim due messages (consent re-checked at send time), then record the outcome with the same retry rule as email (5/15/45/135 minutes, 5 attempts).
create function ogevia_api.system_sms_claim(p_limit integer default 20)
returns table (id uuid, organization_id uuid, phone_e164 text, body text, provider text, sender_id text, sender_verified boolean, attempts integer)
language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
begin
  update ogevia.sms_messages m set status = 'queued', updated_at = now() where m.status = 'sending' and m.updated_at < now() - interval '10 minutes';
  update ogevia.sms_messages m set status = 'skipped_opted_out', reason = 'no_consent', updated_at = now()
   where m.status in ('queued', 'retry') and m.send_after <= now() and m.recipient_kind = 'caregiver'
     and not exists (select 1 from ogevia.sms_contacts c where c.organization_id = m.organization_id and c.user_id = m.recipient_user_id and c.status = 'opted_in');
  update ogevia.sms_messages m set status = 'cancelled', reason = 'disabled', updated_at = now()
   where m.status in ('queued', 'retry') and m.send_after <= now() and not exists (select 1 from ogevia.sms_settings s where s.organization_id = m.organization_id and s.enabled);
  return query
    with due as (select m.id from ogevia.sms_messages m where m.status in ('queued', 'retry') and m.send_after <= now() order by m.send_after limit least(greatest(p_limit, 1), 50) for update skip locked)
    update ogevia.sms_messages m set status = 'sending', attempts = m.attempts + 1, updated_at = now()
      from due, ogevia.sms_settings s where m.id = due.id and s.organization_id = m.organization_id
    returning m.id, m.organization_id, m.phone_e164, m.body, s.provider, s.sender_id, s.sender_verified, m.attempts;
end;
$$;
create function ogevia_api.system_sms_record(p_id uuid, p_outcome text, p_provider_message_id text, p_error text)
returns text language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v ogevia.sms_messages%rowtype; v_delay interval;
begin
  select * into v from ogevia.sms_messages where id = p_id for update;
  if v.id is null or v.status <> 'sending' then return coalesce(v.status, 'missing'); end if;
  if p_outcome = 'sent' then
    update ogevia.sms_messages set status = 'sent', sent_at = now(), provider_message_id = left(p_provider_message_id, 200), reason = null, updated_at = now() where id = p_id; return 'sent';
  end if;
  if p_outcome = 'transient' and v.attempts < 5 then
    v_delay := (array[interval '5 minutes', interval '15 minutes', interval '45 minutes', interval '135 minutes'])[least(v.attempts, 4)];
    update ogevia.sms_messages set status = 'retry', send_after = now() + v_delay, reason = case when coalesce(p_error, '') ~ '^[a-z_]{1,40}$' then p_error else 'send_failed' end, updated_at = now() where id = p_id; return 'retry';
  end if;
  update ogevia.sms_messages set status = 'failed', reason = case when coalesce(p_error, '') ~ '^[a-z_]{1,40}$' then p_error else 'send_failed' end, updated_at = now() where id = p_id; return 'failed';
end;
$$;

-- ---------------------------------------------------------------- board and office queue
drop function ogevia_api.list_shift_pickup_requests(uuid);
create function ogevia_api.list_shift_pickup_requests(p_organization_id uuid)
returns table (
  request_id uuid, shift_id uuid, requested_at timestamptz, starts_at timestamptz, ends_at timestamptz, minutes integer,
  client_code text, service_name text, caregiver_record_id uuid, caregiver_code text, caregiver_name text, blockers text[], eligible boolean, request_rank integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with base as (

  select r.id as request_id, r.shift_id, r.requested_at, s.starts_at, s.ends_at, floor(extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer as minutes,
         coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code) as client_code, sv.name as service_name,
         cr.id as caregiver_record_id, cr.caregiver_code, nullif(btrim(coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name), '') as caregiver_name,
         coalesce((select array_agg(x.message order by x.check_name) from ogevia.readiness_checks(r.organization_id, cr.id, s.service_id, s.starts_at, s.ends_at,
                    'reschedule', s.id, s.client_id, true) x where x.status = 'blocked' and x.enforced), array[]::text[]) as blockers
  from ogevia.shift_pickup_requests r
  join ogevia.shifts s on s.id = r.shift_id
  join ogevia.clients c on c.id = s.client_id
  join ogevia.caregiver_records cr on cr.id = r.caregiver_record_id
  left join ogevia.services sv on sv.id = s.service_id
  where r.organization_id = p_organization_id and r.status = 'pending' and s.status = 'scheduled' and s.ends_at > now()
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'shifts.manage')
  )
  select b.request_id, b.shift_id, b.requested_at, b.starts_at, b.ends_at, b.minutes, b.client_code, b.service_name, b.caregiver_record_id, b.caregiver_code, b.caregiver_name, b.blockers,
         cardinality(b.blockers) = 0 as eligible,
         (row_number() over (partition by b.shift_id order by (cardinality(b.blockers) > 0), b.requested_at))::integer as request_rank
  from base b order by b.starts_at, b.shift_id, request_rank;
$$;

-- The caregiver Open Shifts board: the 0104 board, now matched by the alert audience rule and showing the SERVICE city and the coordinating office.
drop function ogevia_api.list_open_shifts(uuid);
create function ogevia_api.list_open_shifts(p_organization_id uuid)
returns table (
  shift_id uuid, starts_at timestamptz, ends_at timestamptz, minutes integer,
  client_code text, service_name text, coverage_state text, my_request_status text, city text, office_name text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select s.id, s.starts_at, s.ends_at, floor(extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer,
         coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code), sv.name,
         ogevia.shift_coverage_state(s),
         (select 'requested' from ogevia.shift_pickup_requests r join ogevia.caregiver_records cr on cr.id = r.caregiver_record_id
           where r.shift_id = s.id and r.status = 'pending' and cr.linked_user_id = ogevia.require_actor() limit 1),
         -- the SERVICE city (never the office's). Client code and city only, never a name (R23).
         (select a.city from ogevia.cover_service_address(p_organization_id, s.client_id) a),
         (select o.name from ogevia.offices o where o.id = ogevia.cover_office_for(p_organization_id, s))
  from ogevia.shifts s
  join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  where s.organization_id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.is_active_caregiver(p_organization_id)
    and s.status = 'scheduled' and s.ends_at > now() and s.starts_at < now() + interval '14 days'
    and ogevia.shift_coverage_state(s) = 'needs_coverage'
    and not ogevia.shift_is_care_request(s.id)
    and ogevia.caregiver_has_active_assignment(p_organization_id, s.client_id, s.service_id)
    and ogevia.cover_in_audience(p_organization_id, s, (select cr.id from ogevia.caregiver_records cr where cr.organization_id = p_organization_id and cr.linked_user_id = ogevia.require_actor() and cr.deleted_at is null
                                                          order by case when cr.status in ('active', 'ready') then 0 else 1 end, cr.updated_at desc limit 1))
    and not exists (
      select 1 from ogevia.shift_coverage_events e
      join ogevia.caregiver_records cr on cr.id = e.original_caregiver_record_id
      where e.shift_id = s.id and e.event_type = 'called_out' and cr.linked_user_id = ogevia.require_actor()
    )
    and not exists (
      select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected')
    )
  order by s.starts_at;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function ogevia_api.list_shift_pickup_requests(uuid) from public;
revoke all on function ogevia_api.list_open_shifts(uuid) from public;
revoke all on function ogevia.cover_notify(uuid, uuid, uuid, uuid, boolean) from public;
revoke all on function ogevia_api.system_cover_notify_org(uuid) from public;
revoke all on function ogevia_api.get_sms_settings(uuid) from public;
revoke all on function ogevia_api.set_sms_settings(uuid, jsonb) from public;
revoke all on function ogevia_api.get_my_sms(uuid) from public;
revoke all on function ogevia_api.set_my_sms(uuid, text, boolean, text) from public;
revoke all on function ogevia_api.list_sms_oncall(uuid) from public;
revoke all on function ogevia_api.set_sms_oncall(uuid, text, uuid, text, text, uuid) from public;
revoke all on function ogevia_api.list_sms_history(uuid, integer) from public;
revoke all on function ogevia_api.system_sms_escalate_org(uuid) from public;
revoke all on function ogevia_api.system_sms_escalate_orgs() from public;
revoke all on function ogevia_api.system_sms_inbound(text, text, text) from public;
revoke all on function ogevia_api.system_sms_claim(integer) from public;
revoke all on function ogevia_api.system_sms_record(uuid, text, text, text) from public;
grant execute on function ogevia_api.list_shift_pickup_requests(uuid), ogevia_api.list_open_shifts(uuid), ogevia_api.get_sms_settings(uuid), ogevia_api.set_sms_settings(uuid, jsonb),
  ogevia_api.get_my_sms(uuid), ogevia_api.set_my_sms(uuid, text, boolean, text), ogevia_api.list_sms_oncall(uuid), ogevia_api.set_sms_oncall(uuid, text, uuid, text, text, uuid),
  ogevia_api.list_sms_history(uuid, integer), ogevia_api.system_sms_escalate_orgs(), ogevia_api.system_sms_inbound(text, text, text), ogevia_api.system_sms_claim(integer),
  ogevia_api.system_sms_record(uuid, text, text, text) to ogevia_app;
-- the org-level system functions stay internal (called by the *_orgs wrappers only), like the 0113 ones

-- ---------------------------------------------------------------- notification centre and preferences accept the office category
create or replace function ogevia_api.list_user_notifications(
  p_organization_id uuid, p_state text default 'inbox', p_category text default null, p_limit integer default 30, p_before timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_items jsonb; v_unread integer;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if p_state not in ('inbox', 'unread', 'archived', 'all') then raise exception 'Unknown filter' using errcode = 'OGV22'; end if;
  if p_category is not null and p_category not in ('cover_shift', 'cover_office') then raise exception 'Unknown category' using errcode = 'OGV22'; end if;
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
create or replace function ogevia_api.get_my_notification_preferences(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  return jsonb_build_object('coverShift', coalesce(
    (select jsonb_build_object('inApp', p.in_app, 'email', p.email) from ogevia.notification_preferences p
      where p.organization_id = p_organization_id and p.user_id = v_actor and p.category = 'cover_shift'),
    jsonb_build_object('inApp', true, 'email', true)),
    'coverOffice', coalesce(
    (select jsonb_build_object('inApp', p.in_app, 'email', p.email) from ogevia.notification_preferences p
      where p.organization_id = p_organization_id and p.user_id = v_actor and p.category = 'cover_office'),
    jsonb_build_object('inApp', true, 'email', true)),
    'canSeeOffice', ogevia.has_permission(p_organization_id, 'shifts.manage'),
    'emailAvailable', coalesce((select s.email_enabled from ogevia.cover_notification_settings s where s.organization_id = p_organization_id and s.enabled), false));
end;
$$;
create or replace function ogevia_api.set_my_notification_preferences(p_organization_id uuid, p_category text, p_in_app boolean, p_email boolean)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); v_before jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if p_category not in ('cover_shift', 'cover_office') then raise exception 'Unknown category' using errcode = 'OGV22'; end if;
  if p_in_app is null or p_email is null then raise exception 'Choose on or off' using errcode = 'OGV22'; end if;
  v_before := ogevia_api.get_my_notification_preferences(p_organization_id) -> case when p_category = 'cover_office' then 'coverOffice' else 'coverShift' end;
  insert into ogevia.notification_preferences (organization_id, user_id, category, in_app, email) values (p_organization_id, v_actor, p_category, p_in_app, p_email)
  on conflict (organization_id, user_id, category) do update set in_app = excluded.in_app, email = excluded.email, updated_at = now();
  perform ogevia.write_audit(p_organization_id, 'notification_preferences.changed', 'app_users', v_actor, v_before, jsonb_build_object('inApp', p_in_app, 'email', p_email), null);
  return ogevia_api.get_my_notification_preferences(p_organization_id);
end;
$$;
-- the email worker also resolves office staff addresses (0113 resolved caregivers only)
create or replace function ogevia_api.system_email_claim(p_limit integer default 20)
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
    if v_email is null then   -- 0117: office staff (managers and the owner) are reached at their staff profile's contact or sign-in email
      select coalesce(nullif(btrim(sp.contact_email), ''), nullif(btrim(sp.login_email), '')) into v_email
        from ogevia.staff_profiles sp where sp.organization_id = v_d.organization_id and sp.user_id = v_d.recipient_user_id and sp.status = 'active' limit 1;
    end if;
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
