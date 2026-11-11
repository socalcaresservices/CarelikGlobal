-- 0089 Manager records actual work when BOTH scheduled punches are absent.
-- CLASS: additive; no existing migration is changed. No client confirmation is fabricated.
-- The old reservation is released and actual worked minutes become Pending exactly once.
-- Rollback refuses while any record created through this function exists.
create function ogevia_api.list_missing_scheduled_visits(
  p_organization_id uuid, p_from date, p_to date,
  p_client_id uuid default null, p_service_id uuid default null, p_caregiver_user_id uuid default null
)
returns table (shift_id uuid, client_id uuid, client_code text, service_name text,
  caregiver_name text, starts_at timestamptz, ends_at timestamptz, can_record boolean)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'visits.read') then raise exception 'Visit report access required' using errcode = 'OGA03'; end if;
  if p_from is not null and p_to is not null and p_to < p_from then raise exception 'Choose a valid date range' using errcode = 'OGV22'; end if;
  return query select s.id, s.client_id, c.client_code, sv.name,
    coalesce(nullif(btrim(concat_ws(' ', cr.first_name, cr.last_name)), ''), u.display_name, 'Unassigned'),
    s.starts_at, s.ends_at, s.service_id is not null and (s.caregiver_record_id is not null or s.caregiver_user_id is not null)
  from ogevia.shifts s join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  left join ogevia.caregiver_records cr on cr.id = s.caregiver_record_id
  left join ogevia.app_users u on u.id = s.caregiver_user_id
  where s.organization_id = p_organization_id and s.ends_at < now() and s.status <> 'cancelled'
    and (p_from is null or ogevia.organization_local_date(p_organization_id, s.starts_at) >= p_from)
    and (p_to is null or ogevia.organization_local_date(p_organization_id, s.starts_at) <= p_to)
    and (p_client_id is null or s.client_id = p_client_id)
    and (p_service_id is null or s.service_id = p_service_id)
    and (p_caregiver_user_id is null or s.caregiver_user_id = p_caregiver_user_id)
    and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected'))
    and not exists (select 1 from ogevia.shift_reconciliations r where r.shift_id = s.id and r.outcome = 'no_service_delivered')
    and not exists (select 1 from ogevia.service_visits v join ogevia.audit_events e on e.entity_id=v.id
      where v.scheduled_shift_id=s.id and e.action='service_visit.voided' and e.after_state->>'service_delivered'='false')
  order by s.starts_at, s.id;
end;
$$;
revoke all on function ogevia_api.list_missing_scheduled_visits(uuid,date,date,uuid,uuid,uuid) from public;
grant execute on function ogevia_api.list_missing_scheduled_visits(uuid,date,date,uuid,uuid,uuid) to ogevia_app;

create function ogevia_api.record_missing_scheduled_visit(
  p_organization_id uuid, p_shift_id uuid, p_time_in timestamptz, p_time_out timestamptz,
  p_reason text, p_idempotency_key uuid default null
) returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  s ogevia.shifts%rowtype;
  a ogevia.client_authorizations%rowtype;
  a_end ogevia.client_authorizations%rowtype;
  v_prior jsonb;
  v_id uuid;
  v_minutes integer;
  v_fp text := concat_ws('|', p_shift_id, p_time_in, p_time_out, btrim(coalesce(p_reason,'')));
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'visits.manage') then raise exception 'Visit manager access required' using errcode = 'OGA03'; end if;
  if length(btrim(coalesce(p_reason,''))) < 10 or length(p_reason) > 1000 then raise exception 'Enter a reason of 10 to 1000 characters describing what you checked' using errcode = 'OGV22'; end if;
  if p_time_in is null or p_time_out is null or p_time_out <= p_time_in or p_time_out > now() then raise exception 'Enter actual start and end times, in order and not in the future' using errcode = 'OGV22'; end if;
  v_minutes := floor(extract(epoch from (p_time_out - p_time_in))/60)::integer;
  if v_minutes < 1 or v_minutes > 1440 then raise exception 'Duration must be between 1 minute and 24 hours' using errcode = 'OGV22'; end if;
  v_prior := ogevia.idempotency_begin('record_missing_visit',p_idempotency_key,p_organization_id,v_fp);
  if v_prior is not null then return (v_prior->>'visit_id')::uuid; end if;
  select * into s from ogevia.shifts sh where sh.id = p_shift_id and sh.organization_id = p_organization_id for update;
  if s.id is null then raise exception 'Shift not found' using errcode = 'OGN04'; end if;
  if s.ends_at >= now() or s.status = 'cancelled' or s.service_id is null or (s.caregiver_user_id is null and s.caregiver_record_id is null) then raise exception 'Choose an ended, assigned shift with a service' using errcode = 'OGC09'; end if;
  if exists(select 1 from ogevia.shift_reconciliations r where r.shift_id=s.id and r.outcome='no_service_delivered') then raise exception 'This shift was recorded as no service delivered; review that decision first' using errcode='OGC09'; end if;
  if exists(select 1 from ogevia.service_visits v join ogevia.audit_events e on e.entity_id=v.id where v.scheduled_shift_id=s.id and e.action='service_visit.voided' and e.after_state->>'service_delivered'='false') then raise exception 'This visit was recorded as no service delivered; review that decision first' using errcode='OGC09'; end if;
  if ogevia.organization_local_date(p_organization_id,p_time_in) <> ogevia.organization_local_date(p_organization_id,s.starts_at) then raise exception 'The actual start must be on the scheduled agency-local date' using errcode='OGV22'; end if;
  select * into a from ogevia.resolve_current_authorization(p_organization_id,s.client_id,s.service_id,ogevia.organization_local_date(p_organization_id,p_time_in));
  select * into a_end from ogevia.resolve_current_authorization(p_organization_id,s.client_id,s.service_id,ogevia.organization_local_date(p_organization_id,p_time_out));
  if a.id is null or a_end.id is distinct from a.id then raise exception 'The actual times must be covered by one active authorization' using errcode='OGC09'; end if;
  -- Shift -> reservation -> lineage, the same order as reconciliation and scheduling.
  perform 1 from ogevia.authorization_reservations r where r.shift_id=s.id for update;
  if exists(select 1 from ogevia.authorization_reservations r where r.shift_id=s.id and r.released_at is null and r.authorization_lineage_id<>a.lineage_id) then raise exception 'The shift reservation belongs to a different authorization; review it first' using errcode='OGC09'; end if;
  perform ogevia.lock_authorization_lineage(a.lineage_id);
  if exists(select 1 from ogevia.service_visits v where v.scheduled_shift_id=s.id and v.status not in ('voided','corrected')) then raise exception 'A visit already exists for this shift' using errcode='OGC09'; end if;
  if exists(select 1 from ogevia.service_visits v where v.organization_id=p_organization_id and v.status not in ('voided','corrected')
    and ((s.caregiver_user_id is not null and v.caregiver_user_id=s.caregiver_user_id) or (s.caregiver_record_id is not null and v.caregiver_record_id=s.caregiver_record_id))
    and (v.status in ('draft','awaiting_signature') or (v.time_in < p_time_out and coalesce(v.time_out,now()) > p_time_in))) then
    raise exception 'This caregiver has an open or overlapping visit; resolve it first' using errcode='OGC09';
  end if;
  insert into ogevia.service_visits(organization_id,client_id,client_code_snapshot,caregiver_user_id,caregiver_record_id,
    caregiver_name_snapshot,scheduled_shift_id,service_authorization_id,service_id,service_date,time_in,time_out,worked_minutes,
    status,created_by,visit_number_snapshot,correction_reason,time_out_entered_by,time_out_reason)
  select p_organization_id,s.client_id,coalesce(nullif(c.caregiver_display_code,''),c.client_code),s.caregiver_user_id,s.caregiver_record_id,
    coalesce(nullif(btrim(concat_ws(' ',cr.first_name,cr.last_name)),''),u.display_name,'Caregiver'),s.id,a.id,s.service_id,
    ogevia.organization_local_date(p_organization_id,p_time_in),p_time_in,p_time_out,v_minutes,'awaiting_signature',v_actor,
    'OGEV-V-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,16)),btrim(p_reason),v_actor,btrim(p_reason)
  from ogevia.clients c left join ogevia.caregiver_records cr on cr.id=s.caregiver_record_id left join ogevia.app_users u on u.id=s.caregiver_user_id
  where c.id=s.client_id returning id into v_id;
  update ogevia.authorization_reservations set released_at=now(),release_reason='manager_missing_visit_recorded' where shift_id=s.id and released_at is null;
  update ogevia.shifts set status='completed',updated_at=now() where id=s.id;
  perform ogevia.write_audit(p_organization_id,'service_visit.missing_punches_recorded','service_visits',v_id,
    jsonb_build_object('visit_id',null,'time_in',null,'time_out',null,'shift_id',s.id,'shift_status',s.status),
    jsonb_build_object('visit_id',v_id,'time_in',p_time_in,'time_out',p_time_out,'worked_minutes',v_minutes,'status','awaiting_signature',
      'shift_id',s.id,'entered_by',v_actor,'client_confirmed',false,'reservation_released',true),btrim(p_reason));
  perform ogevia.idempotency_finish('record_missing_visit',p_idempotency_key,p_organization_id,v_fp,jsonb_build_object('visit_id',v_id));
  return v_id;
end;
$$;
revoke all on function ogevia_api.record_missing_scheduled_visit(uuid,uuid,timestamptz,timestamptz,text,uuid) from public;
grant execute on function ogevia_api.record_missing_scheduled_visit(uuid,uuid,timestamptz,timestamptz,text,uuid) to ogevia_app;

-- The existing History action also shows manager-entered punches, without rewriting the append-only audit.
create or replace function ogevia_api.list_visit_corrections(p_visit_id uuid)
returns table(id uuid,corrected_by uuid,corrected_by_name text,reason text,before_snapshot jsonb,after_snapshot jsonb,created_at timestamptz)
language sql stable security definer set search_path=ogevia,pg_temp as $$
  select vc.id,vc.corrected_by,coalesce(u.display_name,'Administrator'),vc.reason,vc.before_snapshot,vc.after_snapshot,vc.created_at
  from ogevia.visit_corrections vc left join ogevia.app_users u on u.id=vc.corrected_by
  where ogevia.require_actor() is not null and (vc.original_visit_id=p_visit_id or vc.corrected_visit_id=p_visit_id)
    and ogevia.has_permission(vc.organization_id,'visits.read')
  union all
  select md5('audit:'||e.id)::uuid,e.actor_user_id,coalesce(u.display_name,'Administrator'),e.reason,
    jsonb_build_object('timeIn',case when e.action='service_visit.closed_by_manager' then v.time_in else null end,'timeOut',null,'workedMinutes',0,'billableMinutes',0),
    jsonb_build_object('timeIn',coalesce(e.after_state->>'time_in',v.time_in::text),'timeOut',e.after_state->>'time_out','workedMinutes',e.after_state->'worked_minutes','billableMinutes',0),e.occurred_at
  from ogevia.audit_events e join ogevia.service_visits v on v.id=e.entity_id
  left join ogevia.app_users u on u.id=e.actor_user_id
  where ogevia.require_actor() is not null and (v.id=p_visit_id or v.id=(select x.original_visit_id from ogevia.service_visits x where x.id=p_visit_id))
    and e.action in ('service_visit.missing_punches_recorded','service_visit.closed_by_manager')
    and ogevia.has_permission(e.organization_id,'visits.read')
  order by 7 desc;
$$;
