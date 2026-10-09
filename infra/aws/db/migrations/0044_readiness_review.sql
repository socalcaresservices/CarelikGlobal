-- PR #76 review: mandatory client requirements on all commitment paths,
-- new manager-started visits, and permission-scoped ZIP reads for real forms.
-- Does not alter historic visits, existing shifts, or enforcement settings.

create function ogevia.assert_client_requirements(p_org uuid, p_client uuid, p_caregiver uuid)
returns void language plpgsql volatile set search_path = ogevia, pg_temp as $$
declare v_message text;
begin
  -- Assignment paths already take the caregiver lock. Taking it again is safe;
  -- use caregiver -> client order consistently with experience reviews.
  perform ogevia.lock_caregiver(p_caregiver);
  perform pg_advisory_xact_lock(hashtextextended('ogevia.client-requirements:' || p_client::text, 0));
  select string_agg(message, ' ' order by code, message) into v_message
    from ogevia.client_requirement_issues(p_org, p_client, p_caregiver);
  if v_message is not null then raise exception '%', v_message using errcode = 'OGR30'; end if;
end;
$$;

create function ogevia.client_requirements_commit_guard()
returns trigger language plpgsql set search_path = ogevia, pg_temp as $$
declare v_rec uuid; v_status text;
begin
  if tg_table_name = 'shifts' then
    if new.status <> 'scheduled' or new.ends_at <= now() then return new; end if;
    if tg_op = 'UPDATE' then
      if (new.caregiver_record_id, new.caregiver_user_id, new.client_id, new.service_id, new.starts_at, new.ends_at, new.status)
        is not distinct from (old.caregiver_record_id, old.caregiver_user_id, old.client_id, old.service_id, old.starts_at, old.ends_at, old.status)
        then return new; end if;
    end if;
  else
    if not new.is_active or new.effective_end < ogevia.organization_local_date(new.organization_id, now()) then return new; end if;
    if tg_op = 'UPDATE' then
      if (new.caregiver_record_id, new.caregiver_user_id, new.client_id, new.service_id, new.effective_start, new.effective_end, new.is_active)
        is not distinct from (old.caregiver_record_id, old.caregiver_user_id, old.client_id, old.service_id, old.effective_start, old.effective_end, old.is_active)
        then return new; end if;
    end if;
  end if;
  select r.id, r.status into v_rec, v_status from ogevia.caregiver_records r
    where r.organization_id = new.organization_id and r.deleted_at is null
      and (r.id = new.caregiver_record_id or (new.caregiver_record_id is null and r.linked_user_id = new.caregiver_user_id))
    order by r.id limit 1;
  -- Planned relationships do not grant access. Dated work is still gated.
  if v_rec is not null and (tg_table_name = 'shifts' or v_status in ('ready', 'active')) then
    perform ogevia.assert_client_requirements(new.organization_id, new.client_id, v_rec);
  end if;
  return new;
end;
$$;
create trigger shifts_client_requirements before insert or update on ogevia.shifts
  for each row execute function ogevia.client_requirements_commit_guard();
create trigger assignments_client_requirements before insert or update on ogevia.caregiver_assignments
  for each row execute function ogevia.client_requirements_commit_guard();

-- A new live visit is work regardless of the actor's role. Historical imports,
-- already-running visits, corrections and billing updates are not rewritten.
create function ogevia.new_live_visit_readiness_guard()
returns trigger language plpgsql set search_path = ogevia, pg_temp as $$
declare v_rec uuid; v_end timestamptz;
begin
  if new.status <> 'draft' or new.time_out is not null then return new; end if;
  select r.id into v_rec from ogevia.caregiver_records r
    where r.organization_id = new.organization_id and r.deleted_at is null
      and (r.id = new.caregiver_record_id or (new.caregiver_record_id is null and r.linked_user_id = new.caregiver_user_id))
    order by r.id limit 1;
  if v_rec is null then raise exception 'An active Care Team profile is required before starting work.' using errcode = 'OGR30'; end if;
  perform ogevia.lock_caregiver(v_rec);
  select s.ends_at into v_end from ogevia.shifts s where s.id = new.scheduled_shift_id and s.organization_id = new.organization_id;
  v_end := greatest(coalesce(v_end, new.time_in + interval '1 minute'), new.time_in + interval '1 minute');
  perform ogevia.assert_ready_for_work(new.organization_id, v_rec, new.service_id, new.time_in, v_end, 'visit_start', new.client_id);
  perform ogevia.assert_client_requirements(new.organization_id, new.client_id, v_rec);
  -- A completed shift has been delivered; its former planned end must not
  -- block a later live visit. Undelivered scheduled work remains mandatory.
  if exists (select 1 from ogevia.shifts s
    where s.organization_id = new.organization_id and s.id is distinct from new.scheduled_shift_id
      and (s.caregiver_record_id = v_rec or s.caregiver_user_id = new.caregiver_user_id)
      and s.status = 'scheduled' and not ogevia.shift_is_called_out(s.id)
      and s.starts_at < v_end and s.ends_at > new.time_in) then
    raise exception 'Already booked.' using errcode = 'OGR30';
  end if;
  return new;
end;
$$;
create trigger new_live_visit_readiness before insert on ogevia.service_visits
  for each row execute function ogevia.new_live_visit_readiness_guard();

-- Required CPR/TB verification follows the owner's administrator-only rule.
-- Managers retain existing permissions for other documents.
do $$
declare v_old text; v_new text;
begin
  select pg_get_functiondef('ogevia_api.review_document_version(uuid,text,text,uuid)'::regprocedure) into v_old;
  v_new := replace(v_old, '  if v_requirement is not null then perform ogevia.lock_caregiver(v_rec); end if;',
    '  if v_requirement is not null then
    if not ogevia.has_permission(v.organization_id, ''documents.requirements.manage'') then
      raise exception ''Only an administrator may verify required CPR and TB records.'' using errcode = ''OGA03'';
    end if;
    perform ogevia.lock_caregiver(v_rec);
  end if;');
  if v_new = v_old then raise exception '0044: required document verifier patch did not match'; end if;
  execute v_new;
end $$;

-- Serialize changes to mandatory preferences with commitment checks. This does
-- not lock or edit past work and does not create automatic approvals.
do $$
declare v_old text; v_new text;
begin
  select pg_get_functiondef('ogevia_api.set_client_experience_requirements(uuid,uuid,jsonb,text)'::regprocedure) into v_old;
  v_new := replace(v_old, '  delete from ogevia.client_experience_requirements where client_id = p_client_id;',
    '  perform pg_advisory_xact_lock(hashtextextended(''ogevia.client-requirements:'' || p_client_id::text, 0));
  delete from ogevia.client_experience_requirements where client_id = p_client_id;');
  if v_new = v_old then raise exception '0044: requirements setter patch did not match'; end if;
  execute v_new;
end $$;

create function ogevia_api.get_matching_zip(p_organization_id uuid, p_record_id uuid, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v_zip text;
begin
  perform ogevia.matching_manage_guard(p_organization_id);
  if p_kind = 'caregiver' then
    if not exists (select 1 from ogevia.caregiver_records r where r.id = p_record_id and r.organization_id = p_organization_id and r.deleted_at is null)
      then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
    select z.zip into v_zip from ogevia.caregiver_zip z where z.caregiver_record_id = p_record_id and z.organization_id = p_organization_id;
  elsif p_kind = 'client' then
    if not exists (select 1 from ogevia.clients c where c.id = p_record_id and c.organization_id = p_organization_id and c.deleted_at is null)
      then raise exception 'Client not found' using errcode = 'OGN04'; end if;
    select z.zip into v_zip from ogevia.client_service_zip z where z.client_id = p_record_id and z.organization_id = p_organization_id;
  else raise exception 'Invalid location record type' using errcode = 'OGV22'; end if;
  return jsonb_build_object('zip', v_zip);
end;
$$;
revoke all on function ogevia.assert_client_requirements(uuid, uuid, uuid) from public;
revoke all on function ogevia.client_requirements_commit_guard() from public;
revoke all on function ogevia.new_live_visit_readiness_guard() from public;
revoke all on function ogevia_api.get_matching_zip(uuid, uuid, text) from public;
grant execute on function ogevia_api.get_matching_zip(uuid, uuid, text) to ogevia_app;
