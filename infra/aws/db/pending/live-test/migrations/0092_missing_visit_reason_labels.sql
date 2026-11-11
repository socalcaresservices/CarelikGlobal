-- Store a reusable agency reason label separately from the visit-specific audit note.
create table ogevia.missing_visit_reason_labels (
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  label text not null check (length(label) between 1 and 80),
  primary key (organization_id, visit_id)
);
alter table ogevia.missing_visit_reason_labels enable row level security;

create function ogevia_api.list_missing_visit_reason_labels(p_org uuid)
returns table(label text, visits bigint)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  if not ogevia.is_active_member(p_org) or not ogevia.has_permission(p_org, 'visits.read') then
    raise exception 'Forbidden' using errcode = 'OGA03';
  end if;
  return query select min(r.label), count(*) from ogevia.missing_visit_reason_labels r
   where r.organization_id = p_org group by lower(r.label) order by lower(r.label);
end;
$$;

create function ogevia_api.record_missing_scheduled_visit(
  p_org uuid, p_shift uuid, p_in timestamptz, p_out timestamptz, p_reason text, p_key uuid, p_label text
) returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_visit uuid; v_label text := nullif(btrim(p_label), '');
begin
  v_visit := ogevia_api.record_missing_scheduled_visit(p_org,p_shift,p_in,p_out,p_reason,p_key);
  if v_label is not null then
    insert into ogevia.missing_visit_reason_labels(organization_id, visit_id, label)
      values (p_org, v_visit, v_label) on conflict do nothing;
    if not exists (select 1 from ogevia.missing_visit_reason_labels r
      where r.organization_id = p_org and r.visit_id = v_visit and r.label = v_label) then
      raise exception 'This correction already has a different reason category' using errcode = 'OGV22';
    end if;
  end if;
  return v_visit;
end;
$$;
revoke all on function ogevia_api.list_missing_visit_reason_labels(uuid) from public;
revoke all on function ogevia_api.record_missing_scheduled_visit(uuid,uuid,timestamptz,timestamptz,text,uuid,text) from public;
grant execute on function ogevia_api.list_missing_visit_reason_labels(uuid) to ogevia_app;
grant execute on function ogevia_api.record_missing_scheduled_visit(uuid,uuid,timestamptz,timestamptz,text,uuid,text) to ogevia_app;
