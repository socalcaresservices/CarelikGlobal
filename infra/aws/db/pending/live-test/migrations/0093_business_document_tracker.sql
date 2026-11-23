-- Agency business document tracker. File storage is separate from tracking metadata.
create table ogevia.business_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  name text not null check (length(btrim(name)) between 1 and 120),
  responsible_person text check (length(responsible_person) <= 120),
  due_on date,
  notes text check (length(notes) <= 2000),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index business_documents_org_idx on ogevia.business_documents(organization_id);
alter table ogevia.business_documents enable row level security;

create function ogevia_api.list_business_documents(p_org uuid)
returns table(id uuid, name text, responsible_person text, due_on date, notes text, status text, updated_at timestamptz, history jsonb)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v_today date := ogevia.organization_local_date(p_org, now());
begin
  if not ogevia.is_active_member(p_org) or not ogevia.has_permission(p_org, 'accounts.manage') then
    raise exception 'Forbidden' using errcode = 'OGA03';
  end if;
  return query select d.id, d.name, d.responsible_person, d.due_on, d.notes,
    case when d.due_on < v_today then 'Overdue'
         when d.reviewed_at is null then 'Needs review'
         when d.due_on <= v_today + 30 then 'Due soon'
         else 'Current' end, d.updated_at,
    coalesce((select jsonb_agg(h.event order by h.id desc) from (
      select e.id, jsonb_build_object('action', e.action, 'at', e.occurred_at,
        'actor', coalesce(u.display_name, 'Staff member'), 'dueOn', e.after_state->>'due_on') as event
      from ogevia.audit_events e left join ogevia.app_users u on u.id=e.actor_user_id
      where e.organization_id=p_org and e.entity_type='business_documents' and e.entity_id=d.id
      order by e.id desc limit 20
    ) h), '[]'::jsonb)
  from ogevia.business_documents d where d.organization_id = p_org
  order by d.due_on nulls last, lower(d.name), d.id;
end;
$$;

create function ogevia_api.save_business_document(
  p_org uuid, p_id uuid, p_name text, p_person text, p_due date, p_notes text,
  p_expected timestamptz, p_review boolean
) returns uuid
language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_id uuid; v_old ogevia.business_documents%rowtype;
begin
  if not ogevia.is_active_member(p_org) or not ogevia.has_permission(p_org, 'accounts.manage') then
    raise exception 'Forbidden' using errcode = 'OGA03';
  end if;
  if p_review and p_id is null then raise exception 'Select a document to review' using errcode = 'OGV22'; end if;
  if p_id is null then
    insert into ogevia.business_documents(organization_id,name,responsible_person,due_on,notes)
      values(p_org,btrim(p_name),p_person,p_due,p_notes) returning id into v_id;
  else
    select * into v_old from ogevia.business_documents
      where id=p_id and organization_id=p_org for update;
    if not found then raise exception 'Document not found' using errcode = 'OGN04'; end if;
    if p_expected is distinct from v_old.updated_at then
      raise exception 'This record changed. Refresh before saving.' using errcode = 'OGC09';
    end if;
    if p_review then
      update ogevia.business_documents set reviewed_at=now(), updated_at=date_trunc('milliseconds',clock_timestamp()) where id=p_id;
    else
      update ogevia.business_documents set name=btrim(p_name), responsible_person=p_person,
        due_on=p_due, notes=p_notes, reviewed_at=null, updated_at=date_trunc('milliseconds',clock_timestamp()) where id=p_id;
    end if;
    v_id := p_id;
  end if;
  perform ogevia.write_audit(p_org,case when p_review then 'business_document.reviewed' else 'business_document.saved' end,
    'business_documents',v_id,null,jsonb_build_object('due_on', case when p_review then v_old.due_on else p_due end),null);
  return v_id;
end;
$$;
alter table ogevia.business_documents alter column updated_at set default date_trunc('milliseconds',clock_timestamp());
revoke all on function ogevia_api.list_business_documents(uuid) from public;
revoke all on function ogevia_api.save_business_document(uuid,uuid,text,text,date,text,timestamptz,boolean) from public;
grant execute on function ogevia_api.list_business_documents(uuid) to ogevia_app;
grant execute on function ogevia_api.save_business_document(uuid,uuid,text,text,date,text,timestamptz,boolean) to ogevia_app;
