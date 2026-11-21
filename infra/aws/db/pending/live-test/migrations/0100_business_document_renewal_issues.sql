-- Make renewal deadlines visible to authorized staff in Action Needed and their inbox.
alter function ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer)
  rename to operational_action_issue_rows;

create function ogevia.action_issue_rows(p_organization_id uuid, p_can_cover boolean, p_can_visits boolean,
  p_can_docs boolean, p_can_comp boolean, p_can_bill boolean, p_urgent_hours integer default 48)
returns table (issue_key text, kind text, reason text, queue text, category text, severity text, deadline timestamptz,
  since timestamptz, client_id uuid, caregiver_record_id uuid, service_id uuid, shift_id uuid, visit_id uuid, entity_id uuid)
language sql stable set search_path = ogevia, pg_temp as $$
  select * from ogevia.operational_action_issue_rows(p_organization_id, p_can_cover, p_can_visits,
    p_can_docs, p_can_comp, p_can_bill, p_urgent_hours)
  union all
  select 'business-document:' || d.id || ':' || d.due_on, 'business_document', 'business_document_renewal',
    'documents_compliance', 'compliance',
    case when d.due_on < ogevia.organization_local_date(p_organization_id, now()) then 'critical' else 'urgent' end,
    (d.due_on + 1)::timestamp at time zone o.timezone, d.updated_at,
    null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, d.id
  from ogevia.business_documents d
  join ogevia.organizations o on o.id = d.organization_id
  where d.organization_id = p_organization_id
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'accounts.manage')
    and d.due_on <= ogevia.organization_local_date(p_organization_id, now()) + 7;
$$;
revoke all on function ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer) from public;

-- Keep the scheduled path independent of the signed-in inbox.
create or replace function ogevia_api.system_compliance_orgs()
returns setof uuid language sql stable security definer set search_path = ogevia, pg_temp as $$
  select o.id from ogevia.organizations o
  where o.status = 'active' and (
    exists (select 1 from ogevia.organization_readiness_settings s
      where s.organization_id = o.id and s.enforcement_active_from <= now())
    or exists (select 1 from ogevia.business_documents d where d.organization_id = o.id and d.due_on is not null)
  )
  order by o.id;
$$;

create or replace function ogevia_api.system_compliance_sweep_org(p_organization_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_inserted integer;
begin
  insert into ogevia.issue_notifications
    (organization_id, recipient_user_id, issue_key, severity, kind, reason, queue)
  select d.organization_id, m.user_id, 'business-document:' || d.id || ':' || d.due_on,
    case when d.due_on < v_today then 'critical' else 'urgent' end,
    'business_document', 'business_document_renewal', 'documents_compliance'
  from ogevia.business_documents d
  join ogevia.organizations o on o.id = d.organization_id and o.status = 'active'
  join ogevia.organization_memberships m on m.organization_id = o.id and m.status = 'active'
  join ogevia.role_permissions rp on rp.role = m.role and rp.permission_key = 'accounts.manage'
  left join ogevia.agency_notification_settings s on s.organization_id = o.id
  where d.organization_id = p_organization_id and d.due_on <= v_today + 7
    and (d.due_on < v_today or coalesce(s.urgent_in_app, true))
  on conflict (organization_id, recipient_user_id, issue_key, severity, reopen_count) do nothing;
  get diagnostics v_inserted = row_count;

  return ogevia.compliance_sweep(p_organization_id, null)
    || jsonb_build_object('businessRemindersCreated', v_inserted);
end;
$$;
