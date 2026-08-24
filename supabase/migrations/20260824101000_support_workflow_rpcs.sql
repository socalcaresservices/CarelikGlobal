begin;

-- Support workflow MVP: RPCs for subscriber-controlled access granting
-- Replaces old request_support_access model with new two-stage flow:
-- 1. Org owner creates support request (ticket)
-- 2. Support staff proposes access level/duration
-- 3. Org owner approves/rejects
-- 4. Support staff can access only if approved

-- 1. Create support request (org owner initiates)
create or replace function public.create_support_request(
  target_organization_id uuid,
  request_subject text,
  request_description text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  request_id uuid;
begin
  -- Verify user is org member
  if not public.is_organization_member(target_organization_id) then
    raise exception 'Not a member of this organization';
  end if;

  if length(btrim(coalesce(request_subject, ''))) = 0 then
    raise exception 'Subject is required';
  end if;

  insert into public.support_requests (
    organization_id, created_by, subject, description
  ) values (
    target_organization_id, auth.uid(), btrim(request_subject), request_description
  )
  returning id into request_id;

  return request_id;
end;
$$;

-- 2. List support requests for an organization (org member view)
create or replace function public.list_support_requests(
  target_organization_id uuid,
  result_limit integer default 100
) returns table (
  id uuid,
  subject text,
  description text,
  status text,
  created_by_email text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sr.id,
    sr.subject,
    sr.description,
    sr.status,
    u.email,
    sr.created_at
  from public.support_requests sr
  left join auth.users u on sr.created_by = u.id
  where sr.organization_id = target_organization_id
    and (
      public.has_permission(target_organization_id, 'settings.read')
      or (public.is_platform_owner() and exists (
        select 1 from public.support_access_grants
        where organization_id = sr.organization_id
          and grantee_user_id = auth.uid()
          and status in ('active', 'pending_approval')
      ))
    )
  order by sr.created_at desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_support_requests(uuid, integer) from public, anon;
grant execute on function public.list_support_requests(uuid, integer) to authenticated;

-- 3. Request support access (support staff proposes - creates pending_approval)
create or replace function public.request_support_access_new(
  target_request_id uuid,
  target_organization_id uuid,
  target_access_level text,
  target_reason text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  grant_id uuid;
  existing_grant uuid;
begin
  -- Verify caller is platform owner (support staff)
  if not public.is_platform_owner() then
    raise exception 'Only Ogevia support staff can request access';
  end if;

  if target_access_level not in ('read_only', 'edit') then
    raise exception 'Invalid access level';
  end if;

  if length(btrim(coalesce(target_reason, ''))) = 0 then
    raise exception 'Reason is required';
  end if;

  -- Check for existing open grant
  select id into existing_grant from public.support_access_grants
  where organization_id = target_organization_id
    and grantee_user_id = auth.uid()
    and status in ('pending_approval', 'active');

  if existing_grant is not null then
    raise exception 'You already have a pending or active grant for this organization';
  end if;

  insert into public.support_access_grants (
    organization_id,
    grantee_user_id,
    request_id,
    access_level,
    reason,
    requested_by,
    status,
    requested_minutes
  ) values (
    target_organization_id,
    auth.uid(),
    target_request_id,
    target_access_level,
    btrim(target_reason),
    auth.uid(),
    'pending_approval',
    case when target_access_level = 'edit' then 30 else 120 end
  )
  returning id into grant_id;

  return grant_id;
end;
$$;

revoke all on function public.request_support_access_new(uuid, uuid, text, text) from public, anon;
grant execute on function public.request_support_access_new(uuid, uuid, text, text) to authenticated;

-- 4. Approve support access (org owner approves - activates grant)
create or replace function public.approve_support_access_new(
  grant_id uuid,
  expires_in_minutes integer default null
) returns public.support_access_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_grant public.support_access_grants;
  target_org uuid;
  final_expires_minutes integer;
begin
  select organization_id into target_org
  from public.support_access_grants
  where id = grant_id;

  if target_org is null then
    raise exception 'Grant not found';
  end if;

  if not public.has_permission(target_org, 'settings.update') then
    raise exception 'You do not have permission to approve access for this organization';
  end if;

  -- Determine expiration: use provided or defaults per access_level
  if expires_in_minutes is null then
    select
      case
        when access_level = 'edit' then 30
        else 120
      end
    into final_expires_minutes
    from public.support_access_grants
    where id = grant_id;
  else
    final_expires_minutes := least(greatest(expires_in_minutes, 15), 480);
  end if;

  update public.support_access_grants
  set
    status = 'active',
    approved_by = auth.uid(),
    approved_at = now(),
    expires_at = now() + make_interval(mins => final_expires_minutes),
    requested_minutes = final_expires_minutes
  where id = grant_id
    and status = 'pending_approval'
  returning * into updated_grant;

  if updated_grant.id is null then
    raise exception 'Grant is not in pending approval state';
  end if;

  -- Log approval to audit
  insert into public.support_access_audit_log (
    grant_id, organization_id, user_id, event_type
  ) values (
    grant_id, target_org, auth.uid(), 'login'
  );

  return updated_grant;
end;
$$;

revoke all on function public.approve_support_access_new(uuid, integer) from public, anon;
grant execute on function public.approve_support_access_new(uuid, integer) to authenticated;

-- 5. Reject support access (org owner rejects)
create or replace function public.reject_support_access(
  grant_id uuid
) returns public.support_access_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_grant public.support_access_grants;
  target_org uuid;
begin
  select organization_id into target_org
  from public.support_access_grants
  where id = grant_id;

  if target_org is null then
    raise exception 'Grant not found';
  end if;

  if not public.has_permission(target_org, 'settings.update') then
    raise exception 'You do not have permission to manage access for this organization';
  end if;

  update public.support_access_grants
  set status = 'revoked'
  where id = grant_id
    and status = 'pending_approval'
  returning * into updated_grant;

  if updated_grant.id is null then
    raise exception 'Grant is not in pending approval state';
  end if;

  return updated_grant;
end;
$$;

revoke all on function public.reject_support_access(uuid) from public, anon;
grant execute on function public.reject_support_access(uuid) to authenticated;

-- 6. Revoke support access anytime (org owner or support staff can revoke)
create or replace function public.revoke_support_access_new(
  grant_id uuid
) returns public.support_access_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_grant public.support_access_grants;
  target_org uuid;
  target_grantee uuid;
begin
  select organization_id, grantee_user_id into target_org, target_grantee
  from public.support_access_grants
  where id = grant_id;

  if target_org is null then
    raise exception 'Grant not found';
  end if;

  -- Either the grantee (support staff) or org admin can revoke
  if not (
    target_grantee = auth.uid()
    or public.has_permission(target_org, 'settings.update')
  ) then
    raise exception 'You do not have permission to revoke this access';
  end if;

  update public.support_access_grants
  set
    status = 'revoked',
    revoked_by = auth.uid(),
    revoked_at = now()
  where id = grant_id
    and status in ('pending_approval', 'active')
  returning * into updated_grant;

  if updated_grant.id is null then
    raise exception 'Grant is not in a state that can be revoked';
  end if;

  -- Log revocation to audit
  insert into public.support_access_audit_log (
    grant_id, organization_id, user_id, event_type
  ) values (
    grant_id, target_org, auth.uid(), 'revoke'
  );

  return updated_grant;
end;
$$;

revoke all on function public.revoke_support_access_new(uuid) from public, anon;
grant execute on function public.revoke_support_access_new(uuid) to authenticated;

-- 7. Grant emergency support access (manager only, 1 hour max)
create or replace function public.grant_emergency_support_access(
  target_organization_id uuid,
  target_user_id uuid,
  emergency_reason text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  grant_id uuid;
begin
  -- Verify caller is platform owner
  if not public.is_platform_owner() then
    raise exception 'Only Ogevia managers can grant emergency access';
  end if;

  if length(btrim(coalesce(emergency_reason, ''))) = 0 then
    raise exception 'Reason is required for emergency access';
  end if;

  insert into public.support_access_grants (
    organization_id,
    grantee_user_id,
    access_level,
    reason,
    requested_by,
    approved_by,
    status,
    requested_minutes,
    expires_at,
    emergency
  ) values (
    target_organization_id,
    target_user_id,
    'read_only',
    btrim(emergency_reason),
    auth.uid(),
    auth.uid(),
    'active',
    60,
    now() + interval '1 hour',
    true
  )
  returning id into grant_id;

  -- Log emergency grant to audit
  insert into public.support_access_audit_log (
    grant_id, organization_id, user_id, event_type, reason
  ) values (
    grant_id, target_organization_id, auth.uid(), 'emergency', emergency_reason
  );

  return grant_id;
end;
$$;

revoke all on function public.grant_emergency_support_access(uuid, uuid, text) from public, anon;
grant execute on function public.grant_emergency_support_access(uuid, uuid, text) to authenticated;

-- 8. List support access grants for an organization
create or replace function public.list_support_access_grants_new(
  target_organization_id uuid,
  result_limit integer default 100
) returns table (
  id uuid,
  grantee_email text,
  access_level text,
  status text,
  expires_at timestamptz,
  reason text,
  requested_at timestamptz,
  approved_at timestamptz,
  emergency boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sag.id,
    u.email,
    sag.access_level,
    sag.status,
    sag.expires_at,
    sag.reason,
    sag.requested_at,
    sag.approved_at,
    sag.emergency
  from public.support_access_grants sag
  left join auth.users u on sag.grantee_user_id = u.id
  where sag.organization_id = target_organization_id
    and (
      public.is_platform_owner()
      or public.has_permission(target_organization_id, 'settings.read')
    )
  order by sag.created_at desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_support_access_grants_new(uuid, integer) from public, anon;
grant execute on function public.list_support_access_grants_new(uuid, integer) to authenticated;

-- 9. List support requests for Ogevia staff
create or replace function public.list_support_requests_for_staff(
  result_limit integer default 100
) returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  subject text,
  description text,
  status text,
  created_by_email text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sr.id,
    sr.organization_id,
    o.display_name,
    sr.subject,
    sr.description,
    sr.status,
    u.email,
    sr.created_at
  from public.support_requests sr
  left join public.organizations o on sr.organization_id = o.id
  left join auth.users u on sr.created_by = u.id
  where public.is_platform_owner()
    and sr.status in ('open', 'in_review')
  order by sr.created_at asc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_support_requests_for_staff(integer) from public, anon;
grant execute on function public.list_support_requests_for_staff(integer) to authenticated;

-- 10. Get audit log for a grant
create or replace function public.get_support_access_audit(
  grant_id uuid,
  result_limit integer default 100
) returns table (
  id uuid,
  event_type text,
  resource_type text,
  action text,
  changes jsonb,
  reason text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    saal.id,
    saal.event_type,
    saal.resource_type,
    saal.action,
    saal.changes,
    saal.reason,
    saal.created_at
  from public.support_access_audit_log saal
  where saal.grant_id = grant_id
    and (
      public.is_platform_owner()
      or exists (
        select 1 from public.organization_memberships
        where organization_id = saal.organization_id
          and user_id = auth.uid()
          and status = 'active'
      )
    )
  order by saal.created_at desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.get_support_access_audit(uuid, integer) from public, anon;
grant execute on function public.get_support_access_audit(uuid, integer) to authenticated;

commit;
