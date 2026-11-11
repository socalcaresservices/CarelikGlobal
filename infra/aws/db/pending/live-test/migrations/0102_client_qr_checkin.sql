create function ogevia.start_service_visit(
  p_organization_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_task_categories text[] default '{}',
  p_service_notes text default null,
  p_idempotency_key uuid default null,
  p_unscheduled_reason text default null, p_required_shift uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_started_at timestamptz := now();
  v_fingerprint text := concat_ws('|', p_organization_id, p_client_id, p_service_id, nullif(btrim(coalesce(p_unscheduled_reason, '')), ''));
  v_reason text := nullif(btrim(coalesce(p_unscheduled_reason, '')), '');
  v_prior jsonb;
  v_client ogevia.clients%rowtype;
  v_auth ogevia.client_authorizations%rowtype;
  v_record ogevia.caregiver_records%rowtype;
  v_org ogevia.organizations%rowtype;
  v_is_caregiver boolean;
  v_can_manage boolean;
  v_service_date date;
  v_name text;
  v_visit_id uuid;
  v_shift_id uuid;
begin
  select * into v_org from ogevia.organizations o where o.id = p_organization_id and o.status = 'active';
  if v_org.id is null then
    raise exception 'Organization is not active' using errcode = 'OGA03';
  end if;
  v_is_caregiver := ogevia.is_active_caregiver(p_organization_id);
  v_can_manage := ogevia.has_permission(p_organization_id, 'visits.manage');
  if not v_is_caregiver and not v_can_manage then
    raise exception 'Only an active caregiver or visit manager can start a visit' using errcode = 'OGA03';
  end if;

  -- Serialize starts per caller; with the partial unique indexes this makes
  -- double taps and concurrent starts safe.
  perform pg_advisory_xact_lock(hashtextextended('ogevia.start:' || v_actor::text, 0));

  if p_required_shift is not null then v_fingerprint := v_fingerprint || '|' || p_required_shift::text; end if;
  v_prior := ogevia.idempotency_begin('start_visit', p_idempotency_key, p_organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'visit_id')::uuid;
  end if;

  if exists (
    select 1 from ogevia.service_visits v
    where v.caregiver_user_id = v_actor and v.status in ('draft', 'awaiting_signature')
  ) then
    raise exception 'Finish your current visit before starting another client' using errcode = 'OGC09';
  end if;

  if not v_can_manage
     and not ogevia.caregiver_has_active_assignment(p_organization_id, p_client_id, p_service_id)
     and not ogevia.caregiver_has_current_shift(p_organization_id, p_client_id, p_service_id) then
    raise exception 'This client and service are not assigned to you' using errcode = 'OGA03';
  end if;

  select * into v_client from ogevia.clients c
  where c.id = p_client_id and c.organization_id = p_organization_id
    and c.deleted_at is null and c.status = 'active';
  if v_client.id is null then
    raise exception 'Client not found or inactive' using errcode = 'OGN04';
  end if;
  if not exists (
    select 1 from ogevia.services sv
    where sv.id = p_service_id and sv.organization_id = p_organization_id
      and sv.deleted_at is null and sv.is_active
  ) then
    raise exception 'Service not found or inactive' using errcode = 'OGN04';
  end if;

  v_service_date := ogevia.organization_local_date(p_organization_id, v_started_at);
  -- M-1 fix: CURRENT version only.
  select * into v_auth
  from ogevia.resolve_current_authorization(p_organization_id, p_client_id, p_service_id, v_service_date);
  if v_auth.id is null then
    raise exception 'No active authorization covers this client and service' using errcode = 'OGC09';
  end if;

  select cr.* into v_record
  from ogevia.caregiver_records cr
  where cr.organization_id = p_organization_id and cr.linked_user_id = v_actor and cr.deleted_at is null
  order by case when cr.status in ('active', 'ready') then 0 else 1 end, cr.updated_at desc
  limit 1;
  if v_is_caregiver and (v_record.id is null or v_record.status not in ('active', 'ready')) then
    raise exception 'Your Care Team profile is not active. Contact your agency manager before starting a visit.'
      using errcode = 'OGA03';
  end if;

  select coalesce(
    nullif(btrim(concat_ws(' ', coalesce(v_record.preferred_name, v_record.first_name), v_record.last_name)), ''),
    nullif(btrim(u.display_name), ''),
    'Caregiver'
  ) into v_name
  from ogevia.app_users u where u.id = v_actor;

  -- Link the visit to the caregiver's own scheduled shift for this client and
  -- service when one is in progress or about to start (server-side only).
  if p_required_shift is null then
    v_shift_id := ogevia.match_scheduled_shift_for_visit(
      p_organization_id, v_record.id, v_actor, p_client_id, p_service_id, v_started_at);
  else
    select s.id into v_shift_id from ogevia.shifts s
    where s.id = p_required_shift and s.organization_id = p_organization_id
      and s.client_id = p_client_id and s.service_id = p_service_id
      and s.status = 'scheduled' and v_is_caregiver
      and (s.caregiver_record_id = v_record.id or s.caregiver_user_id = v_actor)
      and v_started_at >= s.starts_at - ogevia.visit_shift_early_arrival() and v_started_at < s.ends_at
      and not ogevia.shift_is_called_out(s.id)
      and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided','corrected'))
    for update of s;
    if v_shift_id is null then
      raise exception 'No scheduled visit found.' using errcode = 'OGC09';
    end if;
  end if;

  -- 0050 (D-U): without a scheduled shift the visit is provisional and a reason is required (for every caregiver).
  -- The shift is never invented; the visit stays unlinked and is reviewed.
  if v_shift_id is null and (v_reason is null or length(v_reason) < 3) then
    raise exception 'A reason is required to start a visit without a scheduled shift' using errcode = 'OGV22';
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'The reason is too long (500 characters at most)' using errcode = 'OGV22';
  end if;

  -- A new visit by a caregiver needs verified, current CPR/TB (and service approval when Service checks are On), also when it starts
  -- through a standing assignment. Visits already in progress and manager-started visits are not touched.
  if v_is_caregiver and v_record.id is not null then
    perform ogevia.lock_caregiver(v_record.id);
    perform ogevia.assert_ready_for_work(p_organization_id, v_record.id, p_service_id, v_started_at,
      greatest(coalesce((select sh.ends_at from ogevia.shifts sh where sh.id = v_shift_id), v_started_at), v_started_at) + interval '1 minute',
      'visit_start', p_client_id);
  end if;

  insert into ogevia.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_record_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id, service_id,
    service_date, time_in, task_categories, service_notes, status, created_by, visit_number_snapshot, unscheduled_reason
  ) values (
    p_organization_id, v_client.id,
    coalesce(nullif(btrim(v_client.caregiver_display_code), ''), v_client.client_code),
    v_actor, v_record.id, coalesce(v_name, 'Caregiver'), v_shift_id, v_auth.id, p_service_id,
    v_service_date, v_started_at, coalesce(p_task_categories, '{}'),
    nullif(btrim(p_service_notes), ''), 'draft', v_actor,
    coalesce(nullif(upper(left(regexp_replace(v_org.slug, '[^a-zA-Z0-9]', '', 'g'), 4)), ''), 'OGEV')
      || '-V-' || to_char(v_service_date, 'YYYYMMDD')
      || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4)),
    case when v_shift_id is null then v_reason end
  ) returning id into v_visit_id;

  perform ogevia.write_audit(p_organization_id, 'service_visit.started', 'service_visits', v_visit_id,
    null, jsonb_build_object('status', 'draft', 'time_in', v_started_at,
                             'authorization_id', v_auth.id, 'service_id', p_service_id,
                             'scheduled_shift_id', v_shift_id, 'unscheduled', v_shift_id is null),
    case when v_shift_id is null then v_reason end);
  perform ogevia.idempotency_finish('start_visit', p_idempotency_key, p_organization_id, v_fingerprint,
    jsonb_build_object('visit_id', v_visit_id));
  return v_visit_id;
end;
$$;

revoke all on function ogevia.start_service_visit(uuid,uuid,uuid,text[],text,uuid,text,uuid) from public;

create or replace function ogevia_api.start_ad_hoc_service_visit(
  p_organization_id uuid, p_client_id uuid, p_service_id uuid,
  p_task_categories text[] default '{}', p_service_notes text default null,
  p_idempotency_key uuid default null, p_unscheduled_reason text default null
) returns uuid language sql security definer set search_path = ogevia, pg_temp as $$
  select ogevia.start_service_visit($1,$2,$3,$4,$5,$6,$7,null);
$$;

create table ogevia.client_qr_cards (
  client_id uuid primary key references ogevia.clients(id),
  organization_id uuid not null references ogevia.organizations(id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  encrypted_token text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  regenerated_at timestamptz,
  check ((revoked_at is null) = (encrypted_token is not null))
);
alter table ogevia.client_qr_cards enable row level security;
revoke all on ogevia.client_qr_cards from public;

create function ogevia_api.manage_client_qr(p_org uuid,p_client uuid,p_action text,p_hash text,p_encrypted text)
returns jsonb language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_card ogevia.client_qr_cards%rowtype;
begin
  if not ogevia.has_permission(p_org,'clients.manage') or not ogevia.has_permission(p_org,'clients.names.manage') then
    raise exception 'Client not found' using errcode='OGN04';
  end if;
  perform 1 from ogevia.clients where id=p_client and organization_id=p_org and deleted_at is null for no key update;
  if not found then raise exception 'Client not found' using errcode='OGN04'; end if;
  select * into v_card from ogevia.client_qr_cards where client_id=p_client and organization_id=p_org for update;
  if p_action='status' then
    return jsonb_build_object('exists',v_card.client_id is not null,'active',v_card.client_id is not null and v_card.revoked_at is null);
  elsif p_action='generate' and v_card.client_id is null then
    insert into ogevia.client_qr_cards(client_id,organization_id,token_hash,encrypted_token)
      values(p_client,p_org,p_hash,p_encrypted) returning * into v_card;
  elsif p_action='regenerate' and v_card.client_id is not null then
    update ogevia.client_qr_cards set token_hash=p_hash,encrypted_token=p_encrypted,revoked_at=null,regenerated_at=now()
      where client_id=p_client returning * into v_card;
  elsif p_action='revoke' and v_card.revoked_at is null and v_card.client_id is not null then
    update ogevia.client_qr_cards set revoked_at=now(),encrypted_token=null where client_id=p_client returning * into v_card;
  elsif p_action <> 'reprint' or v_card.client_id is null or v_card.revoked_at is not null then
    raise exception 'Refresh the QR card and try again' using errcode='OGC09';
  end if;
  perform ogevia.write_audit(p_org,
    case p_action when 'generate' then 'QR_CREATED' when 'regenerate' then 'QR_REGENERATED' when 'revoke' then 'QR_REVOKED' else 'QR_REPRINTED' end,
    'client_qr_cards',p_client,null,null,null);
  return jsonb_build_object('active',v_card.revoked_at is null,'encryptedToken',v_card.encrypted_token);
end;
$$;

create function ogevia_api.client_qr_checkin(p_hash text,p_shift uuid default null,p_key uuid default null,p_end uuid default null)
returns jsonb language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_card ogevia.client_qr_cards%rowtype;
  v_name text;
  v_visit uuid;
  v_shifts jsonb;
  v_service uuid;
begin
  select q.* into v_card from ogevia.client_qr_cards q
  join ogevia.clients c on c.id=q.client_id and c.organization_id=q.organization_id
  where q.token_hash=p_hash and q.revoked_at is null and c.deleted_at is null and c.status='active'
    and ogevia.is_active_caregiver(q.organization_id)
  for share of q;
  if not found then return jsonb_build_object('state','unavailable'); end if;

  if p_end is not null then
    perform 1 from ogevia.service_visits v
    where v.id=p_end and v.organization_id=v_card.organization_id and v.client_id=v_card.client_id
      and v.caregiver_user_id=v_actor and v.status in ('draft','awaiting_signature')
    for update;
    if not found then return jsonb_build_object('state','unavailable'); end if;
    if exists (select 1 from ogevia.service_visits where id=p_end and status='draft') then
      perform ogevia_api.end_service_visit(p_end);
    end if;
    return jsonb_build_object('state','confirmation','organizationId',v_card.organization_id,'visitId',p_end);
  end if;

  if p_shift is not null then
    select s.service_id into v_service from ogevia.shifts s
    where s.id=p_shift and s.organization_id=v_card.organization_id and s.client_id=v_card.client_id
      and (s.caregiver_user_id=v_actor or s.caregiver_record_id=ogevia.my_caregiver_record(v_card.organization_id));
    if v_service is null then return jsonb_build_object('state','unavailable'); end if;
    v_visit := ogevia.start_service_visit(v_card.organization_id,v_card.client_id,v_service,'{}',null,p_key,null,p_shift);
    return jsonb_build_object('state','active','visitId',v_visit,'organizationId',v_card.organization_id);
  end if;

  select v.id into v_visit from ogevia.service_visits v
  where v.organization_id=v_card.organization_id and v.client_id=v_card.client_id
    and v.caregiver_user_id=v_actor and v.status in ('draft','awaiting_signature')
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'startsAt',s.starts_at,'endsAt',s.ends_at) order by s.starts_at),'[]'::jsonb)
  into v_shifts from ogevia.shifts s
  where s.organization_id=v_card.organization_id and s.client_id=v_card.client_id and s.status='scheduled'
    and s.service_id is not null
    and (s.caregiver_user_id=v_actor or s.caregiver_record_id=ogevia.my_caregiver_record(v_card.organization_id))
    and now() >= s.starts_at-ogevia.visit_shift_early_arrival() and now() < s.ends_at
    and not ogevia.shift_is_called_out(s.id)
    and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id=s.id and v.status not in ('voided','corrected'));

  if v_visit is null and jsonb_array_length(v_shifts)=0 then
    if not exists (select 1 from ogevia.caregiver_assignments a
      where a.organization_id=v_card.organization_id and a.client_id=v_card.client_id
        and a.caregiver_user_id=v_actor and ogevia.caregiver_has_active_assignment(a.organization_id,a.client_id,a.service_id)) then
      return jsonb_build_object('state','unavailable');
    end if;
    return jsonb_build_object('state','empty');
  end if;
  select client_code into v_name from ogevia.clients where id=v_card.client_id;
  return jsonb_build_object('state',case when v_visit is null then 'scheduled' when exists(select 1 from ogevia.service_visits where id=v_visit and status='awaiting_signature') then 'confirmation' else 'active' end,
    'clientCode',v_name,'organizationId',v_card.organization_id,'visitId',v_visit,'shifts',v_shifts);
end;
$$;
revoke all on function ogevia_api.manage_client_qr(uuid,uuid,text,text,text) from public;
revoke all on function ogevia_api.client_qr_checkin(text,uuid,uuid,uuid) from public;
grant execute on function ogevia_api.manage_client_qr(uuid,uuid,text,text,text) to ogevia_app;
grant execute on function ogevia_api.client_qr_checkin(text,uuid,uuid,uuid) to ogevia_app;
