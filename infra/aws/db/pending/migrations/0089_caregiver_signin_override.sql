-- 0089 (PENDING: infra/aws/db/pending, not in the released set) | CLASS: ADDITIVE (one table, one permission, three functions; no existing row is changed)
-- Admin override for a caregiver who has not signed in to the app yet (owner decision 2026-11-10; replaces the withdrawn "sign-in is a follow-up" idea).
--   * An ADMINISTRATOR (organization_owner, organization_admin; permission caregivers.signin_override, never a manager) can approve a caregiver for work before the first
--     sign-in. A REASON is required (at least 5 characters after trimming). The approver, the time and an audit event are written in the same transaction.
--   * The BACKGROUND CHECK stays a hard block: no override is recorded unless the check is verified clear. Required training and every other hard requirement are unchanged.
--   * CPR and TB are untouched (the existing grace period and per-caregiver extensions).
--   * The sign-in readiness row is "met" (detail "Approved by override: not signed in") only while there is no real sign-in; after the first sign-in the ordinary row takes over.
--   * The override record is append-only and one per caregiver. ogevia_api.list_signin_overrides tells the schedule and the Care Team which caregivers carry the badge.
--   * A caregiver who has not signed in cannot verify a visit: they have no account. Nothing here changes that.
-- Not applied to any database. Rollback: pending/rollback/0089_caregiver_signin_override.down.sql (restores the 0088 function; drops the table and its rows: BACKUP REQUIRED).

insert into ogevia.permissions (key, description) values
  ('caregivers.signin_override', 'Approve a caregiver for work before their first app sign-in, with a reason (never for the background check)');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'caregivers.signin_override'),
  ('organization_admin', 'caregivers.signin_override');

create table ogevia.caregiver_signin_overrides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  reason text not null check (length(btrim(reason)) between 5 and 500),
  approved_by uuid not null references ogevia.app_users(id),
  approved_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  constraint caregiver_signin_overrides_one unique (caregiver_record_id)
);
alter table ogevia.caregiver_signin_overrides enable row level security;
create trigger caregiver_signin_overrides_append_only before update or delete on ogevia.caregiver_signin_overrides
for each row execute function ogevia.append_only_guard();
grant select on table ogevia.caregiver_signin_overrides to ogevia_readonly;
create policy readonly_select on ogevia.caregiver_signin_overrides for select to ogevia_readonly using (true);

create function ogevia.caregiver_has_signin_override(p_organization_id uuid, p_caregiver_record_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (select 1 from ogevia.caregiver_signin_overrides o where o.organization_id = p_organization_id and o.caregiver_record_id = p_caregiver_record_id);
$$;
revoke all on function ogevia.caregiver_has_signin_override(uuid, uuid) from public;

create or replace function ogevia.caregiver_readiness(p_organization_id uuid, p_caregiver_record_id uuid)
returns table (requirement text, label text, kind text, sort_order integer, state text, detail text, due_date date, met_on date,
               actor_name text, blocks_shifts boolean, next_action text, extra jsonb)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_tz text;
  b ogevia.caregiver_background_checks%rowtype;
  v_bg text;
  v_name text;
  t record;
  v_inv ogevia.caregiver_invitations%rowtype;
  d record;
  g record;
  r text;
  v_enf boolean;
  v_ovr ogevia.caregiver_signin_overrides%rowtype;
  v_ovr_name text;
begin
  select * into v_rec from ogevia.caregiver_records c
  where c.id = p_caregiver_record_id and c.organization_id = p_organization_id and c.deleted_at is null;
  if v_rec.id is null then return; end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;

  -- 1. Background check: caregiver_background_checks is the ONE canonical record (0055).
  select * into b from ogevia.caregiver_background_checks x where x.caregiver_record_id = v_rec.id;
  v_bg := ogevia.background_clearance_state(p_organization_id, v_rec.id);
  if v_bg = 'approved' then
    select u.display_name into v_name from ogevia.app_users u where u.id = b.verified_by;
    return query select 'background'::text, 'Background check'::text, 'hard'::text, 10, 'met'::text, 'Verified'::text, null::date,
                        (b.verified_at at time zone coalesce(v_tz, 'UTC'))::date, v_name, false, 'view'::text, '{}'::jsonb;
  else
    return query select 'background'::text, 'Background check'::text, 'hard'::text, 10, 'unmet'::text,
                        (case v_bg when 'not_recorded' then 'Not started' when 'not_started' then 'Not started' when 'not_approved' then 'Not approved'
                                   when 'completed_not_approved' then 'Completed, but no approved result is verified yet'
                                   else 'In progress' end)::text,
                        null::date, null::date, null::text, false, 'verify'::text, '{}'::jsonb;
  end if;

  -- 2. Required training (0054 onboarding item), only while the agency still requires it.
  select * into t from ogevia.onboarding_checklist(p_organization_id, v_rec.id) c where c.requirement_key = 'training' and c.required;
  if t.requirement_key is not null then
    if t.state in ('done', 'waived') then
      return query select 'training'::text, 'Required training'::text, 'hard'::text, 20, 'met'::text, (case when t.state = 'waived' then 'Waived' else 'Done' end)::text,
                          null::date, t.completed_on, null::text, false, 'reopen'::text, jsonb_build_object('requirementId', t.requirement_id);
    else
      return query select 'training'::text, 'Required training'::text, 'hard'::text, 20, 'unmet'::text, (case when t.state = 'expired' then 'Expired' else 'Not recorded' end)::text,
                          null::date, null::date, null::text, false, 'record'::text, jsonb_build_object('requirementId', t.requirement_id);
    end if;
  end if;

  -- 3. App sign-in.
  select * into v_inv from ogevia.caregiver_invitations i where i.organization_id = p_organization_id and i.caregiver_record_id = v_rec.id;
  if ogevia.caregiver_has_signed_in(p_organization_id, v_rec.id) then
    return query select 'signin'::text, 'App sign-in'::text, 'hard'::text, 30, 'met'::text, 'Signed in'::text, null::date,
                        (v_inv.first_signed_in_at at time zone coalesce(v_tz, 'UTC'))::date, null::text, false, 'none'::text, '{}'::jsonb;
  elsif ogevia.caregiver_has_signin_override(p_organization_id, v_rec.id) then
    -- An administrator approved this caregiver for work before the first sign-in (reason, approver and time are on the override record). The row is met, not skipped:
    -- the badge "Approved by override: not signed in" stays until the first real sign-in turns the first branch on. The reason is NOT repeated here.
    select * into v_ovr from ogevia.caregiver_signin_overrides o where o.caregiver_record_id = v_rec.id;
    select u.display_name into v_ovr_name from ogevia.app_users u where u.id = v_ovr.approved_by;
    return query select 'signin'::text, 'App sign-in'::text, 'hard'::text, 30, 'met'::text, 'Approved by override: not signed in'::text, null::date,
                        (v_ovr.approved_at at time zone coalesce(v_tz, 'UTC'))::date, v_ovr_name, false, 'none'::text, jsonb_build_object('override', true);
  else
    return query select 'signin'::text, 'App sign-in'::text, 'hard'::text, 30, 'unmet'::text,
                        (case when not ogevia.caregiver_has_contact(p_organization_id, v_rec.id) then 'No email on file'
                              when v_inv.id is null then 'Not invited yet'
                              else 'Invited, has not signed in yet' end)::text,
                        null::date, null::date, null::text, false,
                        (case when not ogevia.caregiver_has_contact(p_organization_id, v_rec.id) then 'add_contact'
                              when v_inv.id is null then 'send_link' else 'resend_link' end)::text,
                        jsonb_build_object('lastSentAt', v_inv.last_sent_at, 'sendCount', v_inv.send_count);
  end if;

  -- 4 and 5. CPR and TB: flexible, due within the agency's days of the hire date, or the administrator's extension.
  foreach r in array array['cpr', 'tb'] loop
    select * into d from ogevia.document_requirement_check(p_organization_id, v_rec.id, r, null, null);
    select * into g from ogevia.compliance_grace_for(p_organization_id, v_rec.id, now(), r);
    v_enf := ogevia.readiness_enforced(p_organization_id, r, 'shift');
    if d.status = 'ok' then
      return query select r, (case r when 'cpr' then 'CPR certificate' else 'TB clearance' end)::text, 'flexible'::text, (case r when 'cpr' then 40 else 50 end), 'met'::text,
                          'Verified'::text, d.valid_until, null::date, null::text, false, 'none'::text, '{}'::jsonb;
    elsif d.status in ('missing', 'awaiting_review') then
      return query select r, (case r when 'cpr' then 'CPR certificate' else 'TB clearance' end)::text, 'flexible'::text, (case r when 'cpr' then 40 else 50 end),
                          (case when g.in_grace then 'pending' else 'overdue' end)::text,
                          (case d.status when 'missing' then 'Not uploaded' else 'Uploaded, waiting for review' end ||
                           case when g.hire_date is null then ' (hire date not recorded)' else '' end)::text,
                          g.due_date, null::date, null::text, (not g.in_grace) and v_enf, 'upload'::text, '{}'::jsonb;
    else
      return query select r, (case r when 'cpr' then 'CPR certificate' else 'TB clearance' end)::text, 'flexible'::text, (case r when 'cpr' then 40 else 50 end), 'problem'::text,
                          (case d.status when 'rejected' then 'Rejected' when 'expired' then 'Expired' when 'expiry_missing' then 'Expiry date missing'
                                         when 'policy_not_set' then 'Agency document rule not set up' when 'type_not_set' then 'Document type not set up'
                                         else 'Not current' end)::text,
                          g.due_date, null::date, null::text, v_enf, 'upload'::text, '{}'::jsonb;
    end if;
  end loop;
end;
$$;

-- Record the override. Idempotent: a second call finds the first and writes nothing (no second audit event).
create function ogevia_api.approve_signin_override(p_organization_id uuid, p_caregiver_record_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_rec ogevia.caregiver_records%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_new boolean := false;
  v_rows integer;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.signin_override') then
    raise exception 'Only an administrator can approve a caregiver before their first sign-in' using errcode = 'OGA03';
  end if;
  if length(v_reason) < 5 then raise exception 'Write why you are approving this caregiver before their first sign-in (at least 5 characters)' using errcode = 'OGV22'; end if;
  if length(v_reason) > 500 then raise exception 'The reason is too long (500 characters at most)' using errcode = 'OGV22'; end if;
  perform ogevia.lock_caregiver(p_caregiver_record_id);
  select * into v_rec from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if ogevia.caregiver_has_signed_in(p_organization_id, v_rec.id) then
    raise exception 'This caregiver has already signed in; no override is needed' using errcode = 'OGC09';
  end if;
  if ogevia.background_clearance_state(p_organization_id, v_rec.id) <> 'approved' then
    raise exception 'The background check is not clear. There is no override for it' using errcode = 'OGC09';
  end if;
  insert into ogevia.caregiver_signin_overrides (organization_id, caregiver_record_id, reason, approved_by)
  values (p_organization_id, v_rec.id, v_reason, v_actor)
  on conflict (caregiver_record_id) do nothing;
  get diagnostics v_rows = row_count;
  v_new := v_rows > 0;
  if v_new then
    perform ogevia.write_audit(p_organization_id, 'caregiver.signin_override', 'caregiver_records', v_rec.id, null,
      jsonb_build_object('approvedBeforeFirstSignIn', true), v_reason);
  end if;
  return ogevia.caregiver_readiness_summary(p_organization_id, v_rec.id) || jsonb_build_object('overrideRecorded', v_new);
end;
$$;

-- Caregivers who carry the badge "Approved by override: not signed in": an override exists and the first sign-in has not happened. The approver and reason are shown
-- only to someone who can manage the Care Team; a scheduler sees that the badge applies, not why.
create function ogevia_api.list_signin_overrides(p_organization_id uuid)
returns table (caregiver_record_id uuid, approved_at timestamptz, approved_by_name text, reason text)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_detail boolean;
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'caregivers.manage') or ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'readiness.read')) then
    raise exception 'You do not have permission to see this' using errcode = 'OGA03';
  end if;
  v_detail := ogevia.has_permission(p_organization_id, 'caregivers.manage');
  return query
    select o.caregiver_record_id, o.approved_at, case when v_detail then u.display_name::text end, case when v_detail then o.reason end
      from ogevia.caregiver_signin_overrides o join ogevia.app_users u on u.id = o.approved_by
     where o.organization_id = p_organization_id and not ogevia.caregiver_has_signed_in(p_organization_id, o.caregiver_record_id)
     order by o.approved_at;
end;
$$;

revoke all on function ogevia_api.approve_signin_override(uuid, uuid, text) from public;
revoke all on function ogevia_api.list_signin_overrides(uuid) from public;
grant execute on function ogevia_api.approve_signin_override(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.list_signin_overrides(uuid) to ogevia_app;
