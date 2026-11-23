-- Rollback of 0117 (open-shift coverage rounds, cancellation/filled handling, board matching, automatic texting). BACKUP REQUIRED: the texting tables, the office-category
-- notifications (cover_office) and their preferences are DROPPED / DELETED. Run in one transaction as ogevia_owner (the ledger row is removed by the operator script).
-- Restores: the 0113 alert functions (4-argument cover_notify; round-less key), the 0026 call-out function, the 0104 board, the 0063 office queue, the 0113 notification
-- centre functions and email claim, and the single-category constraints.
drop trigger if exists shifts_cover_filled on ogevia.shifts;
drop trigger if exists shifts_cover_cancelled on ogevia.shifts;
drop function if exists ogevia.shifts_cover_filled();
drop function if exists ogevia.shifts_cover_cancelled();
drop function if exists ogevia_api.system_sms_record(uuid, text, text, text);
drop function if exists ogevia_api.system_sms_claim(integer);
drop function if exists ogevia_api.system_sms_inbound(text, text, text);
drop function if exists ogevia_api.system_sms_escalate_orgs();
drop function if exists ogevia_api.system_sms_escalate_org(uuid);
drop function if exists ogevia_api.list_sms_history(uuid, integer);
drop function if exists ogevia_api.set_sms_oncall(uuid, text, uuid, text, text, uuid);
drop function if exists ogevia_api.list_sms_oncall(uuid);
drop function if exists ogevia_api.set_my_sms(uuid, text, boolean, text);
drop function if exists ogevia_api.get_my_sms(uuid);
drop function if exists ogevia_api.set_sms_settings(uuid, jsonb);
drop function if exists ogevia_api.get_sms_settings(uuid);

-- call-out: back to the 0026 function (no cover_on_callout)
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
end;
$$;
drop function if exists ogevia.cover_on_callout(uuid, ogevia.shifts);
drop function if exists ogevia.cover_tell_office(uuid, ogevia.shifts, text);
drop function if exists ogevia.cover_stop_pending(uuid, uuid, text);

-- alerts: back to the 0113 functions
drop function if exists ogevia.cover_notify(uuid, uuid, uuid, uuid, boolean);
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
revoke all on function ogevia.cover_notify(uuid, uuid, uuid, uuid) from public;
create or replace function ogevia_api.system_cover_notify_org(p_organization_id uuid)
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

-- notification centre, preferences and the email claim: back to 0113
create or replace function ogevia_api.list_user_notifications(
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
create or replace function ogevia_api.get_my_notification_preferences(p_organization_id uuid)
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
create or replace function ogevia_api.set_my_notification_preferences(p_organization_id uuid, p_category text, p_in_app boolean, p_email boolean)
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

-- the board and the office queue: back to 0104 / 0063 (return types differ, so drop first)
drop function ogevia_api.list_shift_pickup_requests(uuid);
drop function ogevia_api.list_open_shifts(uuid);
create function ogevia_api.list_shift_pickup_requests(p_organization_id uuid)
returns table (
  request_id uuid, shift_id uuid, requested_at timestamptz, starts_at timestamptz, ends_at timestamptz, minutes integer,
  client_code text, service_name text, caregiver_record_id uuid, caregiver_code text, caregiver_name text, blockers text[]
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select r.id, r.shift_id, r.requested_at, s.starts_at, s.ends_at, floor(extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer,
         coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code), sv.name,
         cr.id, cr.caregiver_code, nullif(btrim(coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name), ''),
         coalesce((select array_agg(x.message order by x.check_name) from ogevia.readiness_checks(r.organization_id, cr.id, s.service_id, s.starts_at, s.ends_at,
                    'reschedule', s.id, s.client_id, true) x where x.status = 'blocked' and x.enforced), array[]::text[])
  from ogevia.shift_pickup_requests r
  join ogevia.shifts s on s.id = r.shift_id
  join ogevia.clients c on c.id = s.client_id
  join ogevia.caregiver_records cr on cr.id = r.caregiver_record_id
  left join ogevia.services sv on sv.id = s.service_id
  where r.organization_id = p_organization_id and r.status = 'pending' and s.status = 'scheduled' and s.ends_at > now()
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'shifts.manage')
  order by s.starts_at, r.requested_at;
$$;
create function ogevia_api.list_open_shifts(p_organization_id uuid)
returns table (
  shift_id uuid, starts_at timestamptz, ends_at timestamptz, minutes integer,
  client_code text, service_name text, coverage_state text, my_request_status text, city text
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
         -- 0091 (owner decision R23): an open shift shows the client CODE and CITY only, never a name.
         nullif(btrim(c.city), '')
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
revoke all on function ogevia_api.list_shift_pickup_requests(uuid) from public;
revoke all on function ogevia_api.list_open_shifts(uuid) from public;
grant execute on function ogevia_api.list_shift_pickup_requests(uuid), ogevia_api.list_open_shifts(uuid) to ogevia_app;

-- office-category data and constraints
-- the history guards forbid deletes; they are lifted for exactly this clean-up and restored in the same transaction
alter table ogevia.user_notifications disable trigger user_notifications_guard;
alter table ogevia.notification_delivery_events disable trigger notification_delivery_events_append_only;
delete from ogevia.notification_delivery_events where delivery_id in (select d.id from ogevia.notification_deliveries d join ogevia.user_notifications n on n.id = d.notification_id where n.category = 'cover_office');
delete from ogevia.notification_deliveries where notification_id in (select id from ogevia.user_notifications where category = 'cover_office');
delete from ogevia.user_notifications where category = 'cover_office';
delete from ogevia.notification_preferences where category = 'cover_office';
alter table ogevia.user_notifications enable trigger user_notifications_guard;
alter table ogevia.notification_delivery_events enable trigger notification_delivery_events_append_only;
alter table ogevia.user_notifications drop constraint user_notifications_category_check;
alter table ogevia.notification_preferences drop constraint notification_preferences_category_check;
alter table ogevia.user_notifications add constraint user_notifications_category_check check (category in ('cover_shift'));
alter table ogevia.notification_preferences add constraint notification_preferences_category_check check (category in ('cover_shift'));

-- texting tables (BACKUP REQUIRED) and helpers
drop table ogevia.sms_inbound_log;
drop table ogevia.sms_messages;
drop table ogevia.sms_oncall;
drop table ogevia.sms_contacts;
drop table ogevia.sms_settings;
drop function ogevia.sms_text(uuid, text, ogevia.shifts, text);
drop function ogevia.sms_enqueue(uuid, text, text, uuid, text, uuid, integer, text, text, timestamptz);
drop function ogevia.sms_quiet_until(uuid, timestamptz);
drop function ogevia.cover_line(uuid, ogevia.shifts);
drop function ogevia.cover_notify_user(uuid, uuid, text, text, text, uuid, text);
drop function ogevia.cover_in_audience(uuid, ogevia.shifts, uuid);
drop function ogevia.cover_office_for(uuid, ogevia.shifts);
drop function ogevia.sms_normalize_phone(text);
drop function ogevia.cover_key(ogevia.shifts);
drop function ogevia.cover_round(uuid);
