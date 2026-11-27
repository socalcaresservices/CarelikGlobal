-- Rollback of 0120: the 0117 definitions of the three replaced functions, and the two new functions removed. Run in one transaction as ogevia_owner.
-- The alerts created under 0120 go back to the plain /schedule link (the guard is lifted for this one correction, then restored), and the old link rule returns.
alter table ogevia.user_notifications disable trigger user_notifications_guard;
update ogevia.user_notifications set link = '/schedule' where link ~ '^/my-shifts\?shift=';
alter table ogevia.user_notifications enable trigger user_notifications_guard;
alter table ogevia.user_notifications drop constraint user_notifications_link_check;
alter table ogevia.user_notifications add constraint user_notifications_link_check check (link is null or link ~ '^/[a-z0-9/_-]*$');
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
create or replace function ogevia.cover_notify_user(p_organization_id uuid, p_user_id uuid, p_category text, p_title text, p_body text, p_shift_id uuid, p_dedupe text)
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
drop function ogevia_api.get_cover_shift(uuid, uuid);
drop function ogevia.cover_shift_summary(uuid, uuid, uuid);
