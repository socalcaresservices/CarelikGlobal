-- 0086 Caregiver readiness: ONE readiness source, Approve for work, CPR/TB due-date setting and extensions (owner decisions 2026-10-30).
--
-- OWNER-DEFINED PRODUCT RULES (2026-10-30). These are the agency's own rules, not verified legal requirements.
--   * HARD requirements before a caregiver can be approved: a VERIFIED APPROVED background check, at least one app sign-in, and the required
--     training (when the agency still requires it). No override and no grace period for the first two; a training item already waived by an
--     administrator under 0054 still counts as met (unchanged capability, reported as an open question).
--   * CPR and TB are FLEXIBLE: due within the agency's number of days after the hire date (new setting, default 30, replacing the fixed 14).
--     An administrator can extend ONE caregiver's CPR or TB due date with a required reason; every extension is kept (append-only) and audited.
--     Before the due date (or the extended date) a missing CPR/TB does not block approval or shifts: it is a warning with the due date.
--     After it: with agency enforcement ON a missing CPR/TB blocks new shift assignments (server-side, ogevia.readiness_checks);
--     with enforcement OFF it is reported as overdue and flagged only. The existing enforcement switch (0042) is unchanged.
--     NOTE: this REVERSES the 0081 choice (2026-10-19) that a missing CPR/TB blocked work from day one. The newer owner instruction controls.
--   * Approve for work is the single final human step. It replaces the "Compliance clearance" onboarding item and the manual status picker.
--     Status is CALCULATED: Not ready -> Approved -> Active (approved and has an active assignment or any visit), plus Inactive (manual only).
--
-- WHAT THIS DOES NOT CHANGE: no stored row is deleted. Onboarding items (including the old background_check and clearance rows) stay readable.
-- Background check: caregiver_background_checks (0055) is the ONE canonical record. The 0054 background_check / document / clearance onboarding
-- requirements are set inactive (not deleted), so no screen reads them any more. Everyone already Ready or Active when this runs is backfilled
-- as approved (source 'legacy_status', no approver) so nobody is deactivated or loses scheduling; the owner's Task 8 report lists who is missing what.
-- Sign-in link: email only, through the existing Cognito invitation. No SMS provider exists in this stack.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table ogevia.organization_compliance_settings (
  organization_id uuid primary key references ogevia.organizations(id),
  cpr_tb_due_days integer not null default 30 check (cpr_tb_due_days between 0 and 365),
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now()
);
alter table ogevia.organization_compliance_settings enable row level security;

create table ogevia.caregiver_cpr_tb_extensions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  requirement text not null check (requirement in ('cpr', 'tb')),
  old_due_date date not null,
  new_due_date date not null,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  extended_by uuid not null references ogevia.app_users(id),
  extended_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  constraint caregiver_cpr_tb_extensions_later check (new_due_date > old_due_date)
);
create index caregiver_cpr_tb_extensions_lookup_idx on ogevia.caregiver_cpr_tb_extensions (caregiver_record_id, requirement, extended_at desc);
alter table ogevia.caregiver_cpr_tb_extensions enable row level security;
create function ogevia.append_only_guard() returns trigger language plpgsql set search_path = ogevia, pg_temp as $$
begin raise exception 'This record is append-only' using errcode = 'OGC09'; end; $$;
create trigger caregiver_cpr_tb_extensions_append_only before update or delete on ogevia.caregiver_cpr_tb_extensions
for each row execute function ogevia.append_only_guard();

create table ogevia.caregiver_work_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  approved_by uuid references ogevia.app_users(id),
  approved_at timestamptz not null default now(),
  source text not null check (source in ('approval', 'legacy_status')),
  snapshot jsonb not null default '[]'::jsonb,
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  constraint caregiver_work_approvals_one unique (caregiver_record_id),
  constraint caregiver_work_approvals_actor check ((source = 'legacy_status') = (approved_by is null))
);
alter table ogevia.caregiver_work_approvals enable row level security;
create trigger caregiver_work_approvals_append_only before update or delete on ogevia.caregiver_work_approvals
for each row execute function ogevia.append_only_guard();

-- Restricted contact details. NOT readable by lists or by the read-only role: only the two API functions below touch it.
create table ogevia.caregiver_contacts (
  caregiver_record_id uuid primary key,
  organization_id uuid not null references ogevia.organizations(id),
  contact_email text check (contact_email is null or length(contact_email) <= 254),
  contact_phone text check (contact_phone is null or contact_phone ~ '^\+?[0-9 ()-]{7,20}$'),
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);
alter table ogevia.caregiver_contacts enable row level security;

grant select on table ogevia.organization_compliance_settings, ogevia.caregiver_cpr_tb_extensions, ogevia.caregiver_work_approvals to ogevia_readonly;
create policy readonly_select on ogevia.organization_compliance_settings for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.caregiver_cpr_tb_extensions for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.caregiver_work_approvals for select to ogevia_readonly using (true);

-- ---------------------------------------------------------------------------
-- Backfill and retired requirements (nothing deleted)
-- ---------------------------------------------------------------------------
insert into ogevia.caregiver_work_approvals (organization_id, caregiver_record_id, approved_by, approved_at, source, snapshot)
select r.organization_id, r.id, null, r.updated_at, 'legacy_status', '[]'::jsonb
from ogevia.caregiver_records r
where r.deleted_at is null and r.status in ('ready', 'active')
on conflict do nothing;

update ogevia.onboarding_requirements set is_active = false, updated_at = now()
where is_active and category in ('background_check', 'document', 'clearance');

create or replace function ogevia.ensure_onboarding_defaults(p_organization_id uuid)
returns void
language sql
set search_path = ogevia, pg_temp
as $$
  insert into ogevia.onboarding_requirements (organization_id, requirement_key, label, category, document_requirement, sort_order)
  select p_organization_id, 'training', 'Required training completed', 'training', null::text, 20
  where not exists (select 1 from ogevia.onboarding_requirements r where r.organization_id = p_organization_id)
  on conflict do nothing;
$$;

-- ---------------------------------------------------------------------------
-- Due-date rule: agency days (default 30) + per-caregiver, per-requirement extensions
-- ---------------------------------------------------------------------------
create or replace function ogevia.compliance_grace_days()
returns integer language sql immutable set search_path = ogevia, pg_temp as $$ select 30; $$;

create function ogevia.compliance_grace_days(p_organization_id uuid)
returns integer language sql stable set search_path = ogevia, pg_temp as $$
  select coalesce((select s.cpr_tb_due_days from ogevia.organization_compliance_settings s where s.organization_id = p_organization_id), 30);
$$;

-- The period for one caregiver (and, when p_requirement is 'cpr' or 'tb', that requirement's extension) at one instant.
-- due_date = the LAST day: hire_date + agency days, or the latest extension's new date when later. grace_ends_at = local midnight after it.
-- A hold opened because the period ended stays sticky, unless an administrator extended this requirement AFTER the hold opened.
create function ogevia.compliance_grace_for(p_organization_id uuid, p_caregiver_record_id uuid, p_as_of timestamptz, p_requirement text)
returns table (hire_date date, due_date date, grace_ends_at timestamptz, in_grace boolean, sticky boolean)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_hire date;
  v_tz text;
  v_due date;
  v_ext date;
  v_ends timestamptz;
  v_sticky boolean;
  v_opened timestamptz;
begin
  select r.hire_date into v_hire from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  select h.opened_at into v_opened from ogevia.caregiver_compliance_holds h
  where h.caregiver_record_id = p_caregiver_record_id and h.released_at is null and h.grace_closed;
  v_sticky := v_opened is not null;
  if v_hire is not null then
    v_due := v_hire + ogevia.compliance_grace_days(p_organization_id);
    if p_requirement in ('cpr', 'tb') then
      select max(x.new_due_date) into v_ext from ogevia.caregiver_cpr_tb_extensions x
      where x.caregiver_record_id = p_caregiver_record_id and x.requirement = p_requirement;
      if v_ext is not null and v_ext > v_due then v_due := v_ext; end if;
      if v_sticky and exists (select 1 from ogevia.caregiver_cpr_tb_extensions x
                              where x.caregiver_record_id = p_caregiver_record_id and x.requirement = p_requirement and x.extended_at >= v_opened) then
        v_sticky := false;
      end if;
    end if;
  end if;
  if v_due is not null and v_tz is not null then v_ends := (v_due + 1)::timestamp at time zone v_tz; end if;
  return query select v_hire, v_due, v_ends, coalesce(v_ends is not null and p_as_of < v_ends and not v_sticky, false), v_sticky;
end;
$$;

-- The 0055 signature stays (older rollback scripts and callers use it); it now follows the agency's days and has no per-requirement extension.
create or replace function ogevia.compliance_grace(p_organization_id uuid, p_caregiver_record_id uuid, p_as_of timestamptz default now())
returns table (hire_date date, due_date date, grace_ends_at timestamptz, in_grace boolean, sticky boolean)
language sql
stable
set search_path = ogevia, pg_temp
as $$ select * from ogevia.compliance_grace_for(p_organization_id, p_caregiver_record_id, p_as_of, null); $$;


-- ---------------------------------------------------------------------------
-- ONE readiness source
-- ---------------------------------------------------------------------------
create function ogevia.caregiver_has_signed_in(p_organization_id uuid, p_caregiver_record_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce((
    select r.linked_user_id is not null and (i.id is null or i.first_signed_in_at is not null)
    from ogevia.caregiver_records r
    left join ogevia.caregiver_invitations i on i.organization_id = r.organization_id and i.caregiver_record_id = r.id
    where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null), false);
$$;

-- True when an email is on file (stored contact, or an invitation already sent to one). Never returns the value.
create function ogevia.caregiver_has_contact(p_organization_id uuid, p_caregiver_record_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (select 1 from ogevia.caregiver_contacts c where c.organization_id = p_organization_id and c.caregiver_record_id = p_caregiver_record_id and c.contact_email is not null)
      or exists (select 1 from ogevia.caregiver_invitations i where i.organization_id = p_organization_id and i.caregiver_record_id = p_caregiver_record_id);
$$;

-- One row per requirement: state met | unmet | pending (flexible, inside its due date) | overdue (flexible, past due) | problem (rejected/expired/...).
-- blocks_shifts says whether the row would stop NEW shift assignments right now (overdue/problem AND agency enforcement on).
create function ogevia.caregiver_readiness(p_organization_id uuid, p_caregiver_record_id uuid)
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

-- Calculated status, identical everywhere: not_ready | approved | active | inactive. Never set by hand (inactive is the one manual input).
create function ogevia.caregiver_work_status(p_organization_id uuid, p_caregiver_record_id uuid)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case
           when r.status = 'inactive' then 'inactive'
           when not exists (select 1 from ogevia.caregiver_work_approvals a where a.caregiver_record_id = r.id) then 'not_ready'
           when exists (select 1 from ogevia.caregiver_assignments x
                         where x.organization_id = r.organization_id and x.is_active
                           and (x.caregiver_record_id = r.id or (x.caregiver_record_id is null and x.caregiver_user_id = r.linked_user_id))
                           and (x.effective_end is null or x.effective_end >= ogevia.organization_local_date(r.organization_id, now())))
             or exists (select 1 from ogevia.service_visits v
                         where v.organization_id = r.organization_id and (v.caregiver_record_id = r.id or (r.linked_user_id is not null and v.caregiver_user_id = r.linked_user_id)))
             then 'active'
           else 'approved' end
  from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
$$;

create function ogevia.caregiver_readiness_summary(p_organization_id uuid, p_caregiver_record_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_items jsonb;
  v_waiting text[];
  v_met integer;
  v_total integer;
  a ogevia.caregiver_work_approvals%rowtype;
  v_by text;
  v_days integer := ogevia.compliance_grace_days(p_organization_id);
  v_status text;
begin
  select * into v_rec from ogevia.caregiver_records c
  where c.id = p_caregiver_record_id and c.organization_id = p_organization_id and c.deleted_at is null;
  if v_rec.id is null then raise exception 'Care Team member not found' using errcode = 'OGN04'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'requirement', q.requirement, 'label', q.label, 'kind', q.kind, 'state', q.state, 'detail', q.detail, 'dueDate', q.due_date,
           'metOn', q.met_on, 'actorName', q.actor_name, 'blocksShifts', q.blocks_shifts, 'nextAction', q.next_action, 'extra', q.extra) order by q.sort_order), '[]'::jsonb),
         count(*) filter (where q.state = 'met')::integer, count(*)::integer,
         coalesce(array_agg(q.label order by q.sort_order) filter (where q.kind = 'hard' and q.state <> 'met'), '{}'::text[])
    into v_items, v_met, v_total, v_waiting
  from ogevia.caregiver_readiness(p_organization_id, p_caregiver_record_id) q;
  select * into a from ogevia.caregiver_work_approvals x where x.caregiver_record_id = v_rec.id;
  select u.display_name into v_by from ogevia.app_users u where u.id = a.approved_by;
  v_status := ogevia.caregiver_work_status(p_organization_id, v_rec.id);
  return jsonb_build_object(
    'caregiverRecordId', v_rec.id, 'caregiverCode', v_rec.caregiver_code, 'status', v_status,
    'approved', a.id is not null, 'approvedAt', a.approved_at, 'approvedByName', v_by, 'approvalSource', a.source,
    'met', v_met, 'total', v_total, 'waitingOn', to_jsonb(v_waiting),
    'canApprove', (v_status in ('not_ready', 'inactive')) and cardinality(v_waiting) = 0,
    'hireDate', v_rec.hire_date, 'graceDays', v_days,
    'cprTbDueDate', case when v_rec.hire_date is null then null else v_rec.hire_date + v_days end,
    'enforcementActive', ogevia.readiness_enforced(p_organization_id, 'cpr', 'shift'),
    'items', v_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------
create function ogevia_api.get_caregiver_readiness(p_organization_id uuid, p_caregiver_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.compliance_read_guard(p_organization_id);
  return ogevia.caregiver_readiness_summary(p_organization_id, p_caregiver_record_id);
end;
$$;

-- Approve for work: the one final human step. Enforced here, not in the browser. Refuses while a hard requirement is unmet, and a second
-- click (or a retry) finds the existing approval and writes nothing.
create function ogevia_api.approve_caregiver_for_work(p_organization_id uuid, p_caregiver_record_id uuid, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_sum jsonb;
  v_waiting text[];
  v_was_inactive boolean;
  v_out jsonb;
begin
  v_prior := ogevia.idempotency_begin('approve_caregiver_for_work', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;
  perform ogevia.lock_caregiver(p_caregiver_record_id);
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  v_was_inactive := v_rec.status = 'inactive';
  if not v_was_inactive and exists (select 1 from ogevia.caregiver_work_approvals a where a.caregiver_record_id = v_rec.id) then
    v_out := ogevia.caregiver_readiness_summary(p_organization_id, v_rec.id) || jsonb_build_object('alreadyApproved', true);
    perform ogevia.idempotency_finish('approve_caregiver_for_work', p_idempotency_key, p_organization_id, v_fp, v_out);
    return v_out;
  end if;
  v_sum := ogevia.caregiver_readiness_summary(p_organization_id, v_rec.id);
  select coalesce(array_agg(x), '{}'::text[]) into v_waiting from jsonb_array_elements_text(v_sum -> 'waitingOn') x;
  if cardinality(v_waiting) > 0 then
    raise exception 'Cannot approve yet. Waiting on: %', array_to_string(v_waiting, ', ') using errcode = 'OGC09';
  end if;
  insert into ogevia.caregiver_work_approvals (organization_id, caregiver_record_id, approved_by, source, snapshot)
  values (p_organization_id, v_rec.id, v_actor, 'approval', v_sum -> 'items')
  on conflict (caregiver_record_id) do nothing;
  if v_was_inactive and v_rec.linked_user_id is not null then
    update ogevia.organization_memberships m set status = 'active', updated_at = now()
     where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver' and m.status = 'suspended';
  end if;
  update ogevia.caregiver_records set status = case when status in ('ready', 'active') then status else 'ready' end, updated_at = now() where id = v_rec.id;
  perform ogevia.write_audit(p_organization_id, 'caregiver.approved_for_work', 'caregiver_records', v_rec.id,
    jsonb_build_object('status', v_rec.status), jsonb_build_object('status', 'ready', 'reactivated', v_was_inactive, 'requirements', v_sum -> 'items'), null);
  v_out := ogevia.caregiver_readiness_summary(p_organization_id, v_rec.id) || jsonb_build_object('alreadyApproved', false);
  perform ogevia.idempotency_finish('approve_caregiver_for_work', p_idempotency_key, p_organization_id, v_fp, v_out);
  return v_out;
end;
$$;

-- Extend ONE caregiver's CPR or TB due date. Administrator action (caregivers.compliance.manage). Reason required; history is append-only.
create function ogevia_api.extend_cpr_tb_due_date(
  p_organization_id uuid, p_caregiver_record_id uuid, p_requirement text, p_new_due_date date, p_reason text, p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_requirement, p_new_due_date, v_reason);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  g record;
  v_doc text;
  v_out jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.compliance.manage') then
    raise exception 'Only an administrator can extend a CPR or TB due date' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('extend_cpr_tb_due_date', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;
  if p_requirement is null or p_requirement not in ('cpr', 'tb') then raise exception 'Choose CPR or TB' using errcode = 'OGV22'; end if;
  if length(v_reason) not between 3 and 500 then raise exception 'Enter a reason for the extension' using errcode = 'OGV22'; end if;
  perform ogevia.lock_caregiver(p_caregiver_record_id);
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.hire_date is null then raise exception 'Record the hire date before extending a due date' using errcode = 'OGC09'; end if;
  select c.status into v_doc from ogevia.document_requirement_check(p_organization_id, v_rec.id, p_requirement, null, null) c;
  if v_doc = 'ok' then raise exception 'This requirement is already verified' using errcode = 'OGC09'; end if;
  select * into g from ogevia.compliance_grace_for(p_organization_id, v_rec.id, now(), p_requirement);
  if p_new_due_date is null or p_new_due_date <= g.due_date then
    raise exception 'Choose a date after the current due date (%)', to_char(g.due_date, 'YYYY-MM-DD') using errcode = 'OGV22';
  end if;
  if p_new_due_date > ogevia.organization_local_date(p_organization_id, now()) + 365 then
    raise exception 'The new due date cannot be more than a year away' using errcode = 'OGV22';
  end if;
  insert into ogevia.caregiver_cpr_tb_extensions (organization_id, caregiver_record_id, requirement, old_due_date, new_due_date, reason, extended_by)
  values (p_organization_id, v_rec.id, p_requirement, g.due_date, p_new_due_date, v_reason, v_actor);
  perform ogevia.write_audit(p_organization_id, 'caregiver.cpr_tb_due_extended', 'caregiver_records', v_rec.id,
    jsonb_build_object('requirement', p_requirement, 'due_date', g.due_date), jsonb_build_object('requirement', p_requirement, 'due_date', p_new_due_date), v_reason);
  perform ogevia.compliance_evaluate(p_organization_id, v_rec.id, v_actor);
  v_out := ogevia.caregiver_readiness_summary(p_organization_id, v_rec.id);
  perform ogevia.idempotency_finish('extend_cpr_tb_due_date', p_idempotency_key, p_organization_id, v_fp, v_out);
  return v_out;
end;
$$;

create function ogevia_api.list_cpr_tb_extensions(p_organization_id uuid, p_caregiver_record_id uuid)
returns table (requirement text, old_due_date date, new_due_date date, reason text, extended_by_name text, extended_at timestamptz)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.compliance_read_guard(p_organization_id);
  return query
  select x.requirement, x.old_due_date, x.new_due_date, x.reason, u.display_name, x.extended_at
  from ogevia.caregiver_cpr_tb_extensions x left join ogevia.app_users u on u.id = x.extended_by
  where x.organization_id = p_organization_id and x.caregiver_record_id = p_caregiver_record_id
  order by x.extended_at desc;
end;
$$;

create function ogevia_api.get_compliance_settings(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.compliance_read_guard(p_organization_id);
  return jsonb_build_object('cprTbDueDays', ogevia.compliance_grace_days(p_organization_id),
                            'enforcementActive', ogevia.readiness_enforced(p_organization_id, 'cpr', 'shift'));
end;
$$;

create function ogevia_api.set_cpr_tb_due_days(p_organization_id uuid, p_days integer, p_reason text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_days, v_reason);
  v_prior jsonb;
  v_old integer;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.compliance.manage') then
    raise exception 'Only an administrator can change the CPR and TB due days' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_cpr_tb_due_days', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;
  if p_days is null or p_days not between 0 and 365 then raise exception 'Enter a number of days from 0 to 365' using errcode = 'OGV22'; end if;
  if length(v_reason) not between 3 and 500 then raise exception 'Enter a reason for the change' using errcode = 'OGV22'; end if;
  v_old := ogevia.compliance_grace_days(p_organization_id);
  insert into ogevia.organization_compliance_settings (organization_id, cpr_tb_due_days, updated_by) values (p_organization_id, p_days, v_actor)
  on conflict (organization_id) do update set cpr_tb_due_days = excluded.cpr_tb_due_days, updated_by = excluded.updated_by, updated_at = now();
  perform ogevia.write_audit(p_organization_id, 'organization.cpr_tb_due_days_set', 'organizations', p_organization_id,
    jsonb_build_object('cpr_tb_due_days', v_old), jsonb_build_object('cpr_tb_due_days', p_days), v_reason);
  perform ogevia.idempotency_finish('set_cpr_tb_due_days', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('cprTbDueDays', p_days));
  return jsonb_build_object('cprTbDueDays', p_days);
end;
$$;

-- Contact details: write by caregiver managers; read ONLY by the server when it sends a sign-in link. Lists never see the value.
create function ogevia_api.set_caregiver_contact(p_organization_id uuid, p_caregiver_record_id uuid, p_email text, p_phone text default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_email text := case when nullif(btrim(coalesce(p_email, '')), '') is null then null else ogevia.normalize_invitation_email(p_email) end;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  if v_email is null and v_phone is null then raise exception 'Enter an email address' using errcode = 'OGV22'; end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ()-]{7,20}$' then raise exception 'Enter a valid phone number' using errcode = 'OGV22'; end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Caregiver not found' using errcode = 'OGN04';
  end if;
  insert into ogevia.caregiver_contacts (caregiver_record_id, organization_id, contact_email, contact_phone, updated_by)
  values (p_caregiver_record_id, p_organization_id, v_email, v_phone, v_actor)
  on conflict (caregiver_record_id) do update
    set contact_email = coalesce(excluded.contact_email, ogevia.caregiver_contacts.contact_email),
        contact_phone = coalesce(excluded.contact_phone, ogevia.caregiver_contacts.contact_phone),
        updated_by = excluded.updated_by, updated_at = now();
  -- The audit row records THAT a contact was set, never the value.
  perform ogevia.write_audit(p_organization_id, 'caregiver.contact_set', 'caregiver_records', p_caregiver_record_id, null,
    jsonb_build_object('email_set', v_email is not null, 'phone_set', v_phone is not null), null);
  return jsonb_build_object('hasEmail', ogevia.caregiver_has_contact(p_organization_id, p_caregiver_record_id));
end;
$$;

-- Server-side only: the email a sign-in link goes to (stored contact first, then the invitation address) and whether an invitation exists.
create function ogevia_api.get_signin_contact(p_organization_id uuid, p_caregiver_record_id uuid)
returns table (email text, invited boolean)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_email text;
  v_invited boolean;
begin
  select coalesce(c.contact_email, i.email), i.id is not null into v_email, v_invited
  from ogevia.caregiver_records r
  left join ogevia.caregiver_contacts c on c.caregiver_record_id = r.id
  left join ogevia.caregiver_invitations i on i.organization_id = r.organization_id and i.caregiver_record_id = r.id
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_email is null then raise exception 'Add an email address first' using errcode = 'OGC09'; end if;
  return query select v_email, v_invited;
end;
$$;

create or replace function ogevia.compliance_blockers(p_organization_id uuid, p_caregiver_record_id uuid, p_as_of timestamptz default now())
returns table (requirement text, code text, message text, blocking boolean, due_date date)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  g record;
  c record;
  r text;
  v_bg text;
  v_base text;
  v_days text := ogevia.compliance_grace_days(p_organization_id)::text || '-day';
begin
  v_bg := ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id);
  if v_bg <> 'approved' then
    return query select 'background'::text, 'background_' || v_bg, ogevia.readiness_message('background', 'background_' || v_bg), true, null::date;
  end if;
  for r in select x from unnest(array['cpr', 'tb']) as x loop
    select * into c from ogevia.document_requirement_check(p_organization_id, p_caregiver_record_id, r, null, null);
    select * into g from ogevia.compliance_grace_for(p_organization_id, p_caregiver_record_id, p_as_of, r);
    if c.status = 'ok' then continue; end if;
    if c.status in ('missing', 'awaiting_review') then
      v_base := ogevia.readiness_message(r, c.status);
      if g.in_grace then
        return query select r, c.status || '_pending', v_base || ' Due ' || to_char(g.due_date, 'YYYY-MM-DD') || '.', false, g.due_date;
      elsif g.hire_date is null then
        return query select r, c.status || '_no_hire_date',
          v_base || ' Hire date is not recorded, so the ' || v_days || ' period cannot be applied.', true, null::date;
      elsif g.sticky then
        return query select r, c.status || '_after_deadline',
          v_base || ' A compliance hold is open for this caregiver. It is released only when this requirement is verified; entering or changing the hire date does not release it.', true, g.due_date;
      else
        return query select r, c.status || '_after_deadline',
          v_base || ' The ' || v_days || ' period ended ' || to_char(g.due_date, 'YYYY-MM-DD') || '.', true, g.due_date;
      end if;
    else
      -- rejected, expired, expires_during, expiry_missing, type_not_set, policy_not_set: unchanged strict behaviour
      return query select r, c.status, ogevia.readiness_message(r, c.status), true, null::date;
    end if;
  end loop;
end;
$$;
create or replace function ogevia.compliance_snapshot(p_organization_id uuid, p_caregiver_record_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  g record;
  b ogevia.caregiver_background_checks%rowtype;
  h ogevia.caregiver_compliance_holds%rowtype;
  v_tz text;
  v_req jsonb;
  v_hold jsonb := null;
  v_bg jsonb;
  v_name text;
begin
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null then raise exception 'Care Team member not found' using errcode = 'OGN04'; end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  select * into g from ogevia.compliance_grace(p_organization_id, p_caregiver_record_id);
  select * into b from ogevia.caregiver_background_checks x where x.caregiver_record_id = p_caregiver_record_id;
  select u.display_name into v_name from ogevia.app_users u where u.id = b.verified_by;
  v_bg := jsonb_build_object(
    'state', ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id),
    'qualifies', ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id) = 'approved',
    'status', coalesce(b.status, 'not_started'), 'result', b.result, 'evidenceNote', b.evidence_note,
    'verifiedAt', b.verified_at, 'verifiedByName', v_name);
  select coalesce(jsonb_agg(jsonb_build_object(
           'requirement', d.requirement, 'documentStatus', d.status, 'validUntil', d.valid_until, 'documentId', d.document_id,
           'blocking', coalesce(k.blocking, false), 'pending', k.blocking is false, 'current', d.status = 'ok',
           'code', k.code, 'message', k.message, 'dueDate', k.due_date) order by d.requirement), '[]'::jsonb)
    into v_req
  from ogevia.document_readiness(p_organization_id, p_caregiver_record_id) d
  left join ogevia.compliance_blockers(p_organization_id, p_caregiver_record_id) k on k.requirement = d.requirement;
  select * into h from ogevia.caregiver_compliance_holds x where x.caregiver_record_id = p_caregiver_record_id and x.released_at is null;
  if h.id is not null then
    v_hold := jsonb_build_object('id', h.id, 'openedAt', h.opened_at, 'automatic', h.opened_by is null, 'reasons', h.reasons, 'graceClosed', h.grace_closed);
  end if;
  return jsonb_build_object(
    'caregiverRecordId', v_rec.id, 'caregiverStatus', v_rec.status,
    'enforcementActive', ogevia.readiness_enforced(p_organization_id, 'background', 'visit_start'),
    'timezone', v_tz, 'graceDays', ogevia.compliance_grace_days(p_organization_id),
    'hireDate', g.hire_date, 'dueDate', g.due_date, 'graceEndsAt', g.grace_ends_at, 'inGrace', g.in_grace,
    'deadlineRule', 'Hire date is day 0. The last day is the hire date plus ' || ogevia.compliance_grace_days(p_organization_id) || ' calendar days in the agency time zone ('
                    || coalesce(v_tz, 'not set') || '). A hold starts at 00:00 the next day.',
    'background', v_bg, 'requirements', v_req, 'hold', v_hold,
    'shiftRisks', coalesce((select jsonb_agg(jsonb_build_object('shiftId', x.shift_id, 'startsAt', x.starts_at, 'endsAt', x.ends_at, 'requirement', x.requirement,
                                                                   'documentStatus', x.document_status, 'validUntil', x.valid_until, 'inProgress', x.in_progress,
                                                                   'visitId', x.visit_id) order by x.starts_at, x.requirement)
                            from ogevia.shift_document_risks(p_organization_id, p_caregiver_record_id) x), '[]'::jsonb),
    'eligible', not exists (select 1 from ogevia.compliance_blockers(p_organization_id, p_caregiver_record_id) k where k.blocking),
    'hireDateRequired', g.hire_date is null and exists (select 1 from jsonb_array_elements(v_req) e where (e ->> 'current')::boolean is not true));
end;
$$;
create or replace function ogevia_api.get_compliance_summary(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  c record;
  n integer := 0; n_bg integer := 0; n_pending integer := 0; n_deadline integer := 0; n_nohire integer := 0; n_strict integer := 0; n_hold integer := 0; n_wouldhold integer := 0;
  v_block boolean; v_pending boolean; v_bg boolean; v_dead boolean; v_nohire boolean; v_strict boolean;
begin
  perform ogevia.compliance_read_guard(p_organization_id);
  for c in select r.id from ogevia.caregiver_records r
           where r.organization_id = p_organization_id and r.deleted_at is null and r.status in ('ready', 'active') loop
    n := n + 1;
    select coalesce(bool_or(k.blocking), false), coalesce(bool_or(not k.blocking), false),
           coalesce(bool_or(k.requirement = 'background' and k.blocking), false),
           coalesce(bool_or(k.code like '%\_after\_deadline'), false), coalesce(bool_or(k.code like '%\_no\_hire\_date'), false),
           coalesce(bool_or(k.requirement in ('cpr', 'tb') and k.blocking and k.code not like '%\_after\_deadline' and k.code not like '%\_no\_hire\_date'), false)
      into v_block, v_pending, v_bg, v_dead, v_nohire, v_strict
    from ogevia.compliance_blockers(p_organization_id, c.id) k;
    if v_block then n_wouldhold := n_wouldhold + 1; end if;
    if v_bg then n_bg := n_bg + 1; end if;
    if v_pending and not v_block then n_pending := n_pending + 1; end if;
    if v_dead then n_deadline := n_deadline + 1; end if;
    if v_nohire then n_nohire := n_nohire + 1; end if;
    if v_strict then n_strict := n_strict + 1; end if;
  end loop;
  select count(*)::int into n_hold from ogevia.caregiver_compliance_holds h where h.organization_id = p_organization_id and h.released_at is null;
  return jsonb_build_object(
    'enforcementActive', ogevia.readiness_enforced(p_organization_id, 'background', 'visit_start'),
    'graceDays', ogevia.compliance_grace_days(p_organization_id),
    'readyOrActive', n, 'wouldBeHeld', n_wouldhold, 'withoutApprovedBackground', n_bg, 'insideGracePending', n_pending,
    'pastDeadline', n_deadline, 'hireDateMissing', n_nohire, 'strictDocumentProblem', n_strict, 'openHolds', n_hold);
end;
$$;
create or replace function ogevia.readiness_checks(p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamp with time zone, p_ends timestamp with time zone, p_context text DEFAULT 'shift'::text, p_exclude_shift uuid DEFAULT NULL::uuid, p_client_id uuid DEFAULT NULL::uuid, p_with_conflict boolean DEFAULT false)
 RETURNS TABLE(check_name text, status text, code text, message text, enforced boolean)
 LANGUAGE plpgsql
 STABLE
 set search_path = ogevia, pg_temp
AS $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_st text;
  d record;
  i record;
  v_ov boolean;
  v_bg text;
  g record;
begin
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if p_context = 'assignment' then
    -- A standing assignment may be prepared for a caregiver who is not Ready yet; it grants nothing until they are.
    null;
  elsif v_rec.id is null or v_rec.status not in ('ready', 'active') then
    return query select 'caregiver'::text, 'blocked'::text, 'caregiver_not_active'::text, ogevia.readiness_message('caregiver', null), true;
  else
    return query select 'caregiver'::text, 'ok'::text, null::text, null::text, true;
  end if;

  if p_context <> 'visit_start' and v_rec.id is not null and v_rec.onboarding_required then
    declare v_open text[];
    begin
      v_open := ogevia.onboarding_outstanding(p_organization_id, v_rec.id, false);
      if cardinality(v_open) > 0 then
        return query select 'onboarding'::text, 'blocked'::text, 'onboarding_incomplete'::text,
          ('Onboarding incomplete: ' || array_to_string(v_open, ', ') || '.')::text, true;
      else
        return query select 'onboarding'::text, 'ok'::text, null::text, null::text, true;
      end if;
    end;
  end if;

  -- Background-check clearance (0055): only a VERIFIED APPROVED result qualifies. "Completed" alone never does.
  v_bg := ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id);
  if v_bg = 'approved' then
    return query select 'background'::text, 'ok'::text, null::text, null::text, ogevia.readiness_enforced(p_organization_id, 'background', p_context);
  else
    return query select 'background'::text, 'blocked'::text, 'background_' || v_bg, ogevia.readiness_message('background', 'background_' || v_bg),
                        ogevia.readiness_enforced(p_organization_id, 'background', p_context);
  end if;

  if p_service_id is null then
    return query select 'service'::text, 'not_checked'::text, null::text, null::text, false;
  else
    v_st := ogevia.service_approval_status(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends);
    return query select 'service'::text, case when v_st = 'approved' then 'ok' else 'blocked' end,
                        case when v_st = 'approved' then null else 'service_' || v_st end,
                        case when v_st = 'approved' then null else ogevia.readiness_message('service', 'service_' || v_st) end,
                        ogevia.readiness_enforced(p_organization_id, 'service', p_context);
  end if;

  -- CPR / TB (0081, owner correction): ONLY a VERIFIED, CURRENT document qualifies. A document that is missing, uploaded but still awaiting review, rejected, expired,
  -- expiring before the work ends, without an expiry date, or whose agency rule/type is not set up all produce the same result: status 'blocked' (Blocked when
  -- enforcement is active, a Warning while the agency is report-only). The 14-day period from the hire date (0055) no longer lets work go ahead; it still governs only
  -- when an automatic compliance HOLD is opened (ogevia.compliance_blockers, unchanged). The period is no longer read here.
  for d in select * from ogevia.document_readiness(p_organization_id, p_caregiver_record_id, p_starts, p_ends) loop
    -- 0086 (owner decision 2026-10-30): a MISSING or only-uploaded CPR/TB is a warning until its due date (hire date + the agency's days, or the
    -- administrator's extension). After that date it is blocked (a Warning while the agency is report-only). Rejected, expired, expiring before the
    -- work ends, or a rule that is not set up still block at once.
    if d.status in ('missing', 'awaiting_review') then
      select * into g from ogevia.compliance_grace_for(p_organization_id, p_caregiver_record_id, now(), d.requirement);
      if g.in_grace then
        return query select d.requirement, 'pending'::text, d.status,
                            ogevia.readiness_message(d.requirement, d.status) || ' Due ' || to_char(g.due_date, 'YYYY-MM-DD') || '.',
                            ogevia.readiness_enforced(p_organization_id, d.requirement, p_context);
        continue;
      end if;
    end if;
    return query select d.requirement, case when d.status = 'ok' then 'ok' else 'blocked' end,
                        case when d.status = 'ok' then null else d.status end,
                        case when d.status = 'ok' then null else ogevia.readiness_message(d.requirement, d.status) end,
                        ogevia.readiness_enforced(p_organization_id, d.requirement, p_context);
  end loop;

  if p_context in ('shift', 'care_request', 'reschedule', 'series', 'visit_start') then
    v_st := ogevia.availability_status(p_organization_id, p_caregiver_record_id, p_starts, p_ends);
    if v_st = 'covered' then
      return query select 'availability'::text, 'ok'::text, null::text, null::text, ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
    else
      v_ov := ogevia.availability_override_for(p_organization_id, p_caregiver_record_id, p_starts, p_ends, p_context, p_client_id) is not null;
      if v_ov then
        return query select 'availability'::text, 'overridden'::text, 'availability_override'::text,
                            ogevia.readiness_message('availability', 'availability_override'), ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
      else
        return query select 'availability'::text, 'blocked'::text, 'availability_' || v_st,
                            ogevia.readiness_message('availability', 'availability_' || v_st), ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
      end if;
    end if;
  end if;

  if p_context in ('shift', 'care_request', 'reschedule', 'series') and v_rec.id is not null then
    declare
      v_lim ogevia.caregiver_hour_limits%rowtype;
      v_issue text;
      h record;
      v_tz text;
      v_date date;
      v_min integer;
    begin
      v_lim := ogevia.effective_hour_limit(p_organization_id, p_caregiver_record_id);
      if v_lim.id is not null then
        select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
        v_date := (p_starts at time zone v_tz)::date;
        v_min := floor(extract(epoch from (p_ends - p_starts)) / 60)::integer;
        select * into h from ogevia.hour_limit_detail(p_organization_id, p_caregiver_record_id, p_starts, p_ends, p_exclude_shift);
        v_issue := h.issue;
        if v_issue is null then
          return query select 'hours'::text, 'ok'::text, null::text, null::text, v_lim.mode = 'block';
        else
          return query select 'hours'::text, 'blocked'::text, v_issue || '_hour_limit', ogevia.hour_limit_message(h.issue, h.actual_minutes, h.allowed_minutes), v_lim.mode = 'block';
        end if;
      end if;
    end;
  end if;

  if p_with_conflict then
    if exists (
      select 1 from ogevia.shifts s
      where s.organization_id = p_organization_id and s.id is distinct from p_exclude_shift
        and (s.caregiver_record_id = p_caregiver_record_id or (v_rec.linked_user_id is not null and s.caregiver_user_id = v_rec.linked_user_id))
        and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
        and s.starts_at < p_ends and s.ends_at > p_starts) then
      return query select 'conflict'::text, 'blocked'::text, 'already_booked'::text, ogevia.readiness_message('conflict', null), true;
    else
      return query select 'conflict'::text, 'ok'::text, null::text, null::text, true;
    end if;
  end if;

  if p_client_id is not null then
    for i in select * from ogevia.client_requirement_issues(p_organization_id, p_client_id, p_caregiver_record_id) loop
      return query select 'client'::text, 'blocked'::text, i.code, coalesce(i.message, ogevia.readiness_message('client', null)),
                          ogevia.readiness_enforced(p_organization_id, 'client', p_context);
    end loop;
  end if;
end;
$$;
create or replace function ogevia_api.set_caregiver_status(p_organization_id uuid, p_caregiver_record_id uuid, p_status text, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS TABLE(ended_assignments integer, sign_in_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_status);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_ended integer := 0;
  v_sign_in text;
  v_open text[];
  v_pre boolean := p_status in ('applicant', 'interview', 'offer', 'onboarding', 'pending_documents');
begin
  v_prior := ogevia.idempotency_begin('set_caregiver_status', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'ended_assignments')::integer, v_prior ->> 'sign_in_status';
    return;
  end if;
  if p_status is null or p_status not in ('applicant', 'interview', 'offer', 'onboarding', 'pending_documents', 'ready', 'active', 'inactive') then
    raise exception 'Choose a status' using errcode = 'OGV22';
  end if;
  if length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason for the status change' using errcode = 'OGV22';
  end if;
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status = p_status then raise exception 'The caregiver already has this status' using errcode = 'OGC09'; end if;

  -- Moving a person who is already Approved or Active back a stage (paperwork, a pause) does not put them on the checklist;
  -- every other move into a stage before Approved does (a new applicant, or someone returning from Inactive).
  -- Approval gate: a record that needs onboarding cannot become Approved ('ready') or Active until every required item is satisfied.
  if p_status in ('ready', 'active') then
    raise exception 'Use Approve for work to approve or reactivate a caregiver' using errcode = 'OGC09';
  end if;
  if p_status = 'inactive' then
    if exists (select 1 from ogevia.service_visits v where v.organization_id = p_organization_id and v.status = 'draft'
               and (v.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and v.caregiver_user_id = v_rec.linked_user_id))) then
      raise exception 'This caregiver has a visit in progress; end or close it first' using errcode = 'OGC09';
    end if;
    update ogevia.caregiver_assignments a
       set is_active = false, effective_end = greatest(a.effective_start, v_today), updated_at = now()
     where a.organization_id = p_organization_id and a.is_active
       and (a.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and a.caregiver_user_id = v_rec.linked_user_id));
    get diagnostics v_ended = row_count;
    if v_rec.linked_user_id is not null then
      update ogevia.organization_memberships m set status = 'suspended', updated_at = now()
       where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver' and m.status = 'active';
    end if;
  elsif v_rec.status = 'inactive' and v_rec.linked_user_id is not null then
    update ogevia.organization_memberships m set status = 'active', updated_at = now()
     where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver' and m.status = 'suspended';
  end if;
  update ogevia.caregiver_records set status = p_status, onboarding_required = onboarding_required or (v_pre and v_rec.status not in ('ready', 'active')), updated_at = now() where id = v_rec.id;
  select m.status::text into v_sign_in from ogevia.organization_memberships m
   where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver';
  perform ogevia.write_audit(p_organization_id, 'caregiver.status_changed', 'caregiver_records', v_rec.id,
    jsonb_build_object('status', v_rec.status, 'onboarding_required', v_rec.onboarding_required),
    jsonb_build_object('status', p_status, 'onboarding_required', v_rec.onboarding_required or (v_pre and v_rec.status not in ('ready', 'active')), 'ended_assignments', v_ended, 'sign_in_status', v_sign_in), v_reason);
  perform ogevia.idempotency_finish('set_caregiver_status', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('ended_assignments', v_ended, 'sign_in_status', v_sign_in));
  return query select v_ended, v_sign_in;
end;
$$;
create or replace function ogevia_api.begin_invitation_resend(p_organization_id uuid, p_caregiver_record_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_inv ogevia.caregiver_invitations%rowtype;
begin
  select i.* into v_inv from ogevia.caregiver_invitations i
  join ogevia.caregiver_records r on r.id = i.caregiver_record_id and r.organization_id = i.organization_id
   and r.deleted_at is null and r.linked_user_id = i.user_id
  where i.organization_id = p_organization_id and i.caregiver_record_id = p_caregiver_record_id;
  if v_inv.id is null then raise exception 'This caregiver has not been invited' using errcode = 'OGN04'; end if;
  if v_inv.first_signed_in_at is not null then
    raise exception 'This caregiver has already signed in; if they are locked out they can reset their sign-in from the sign-in page' using errcode = 'OGC09';
  end if;
  if v_inv.existing_account then
    raise exception 'This caregiver already had a sign-in; ask them to sign in with it, or reset it from the sign-in page' using errcode = 'OGC09';
  end if;
  -- 0086: at least a minute between sends, and at most 5 resends in any 24 hours (counted from the audit trail).
  if v_inv.last_sent_at > now() - interval '60 seconds' then
    raise exception 'A sign-in link was just sent. Wait a minute before sending another.' using errcode = 'OGC09';
  end if;
  if (select count(*) from ogevia.audit_events e
       where e.organization_id = p_organization_id and e.entity_id = p_caregiver_record_id and e.action = 'caregiver.invitation_resent'
         and e.occurred_at > now() - interval '24 hours') >= 5 then
    raise exception 'The resend limit was reached for today. Try again tomorrow.' using errcode = 'OGC09';
  end if;
  return v_inv.email;
end;
$$;
drop function ogevia_api.list_caregivers(uuid);
create function ogevia_api.list_caregivers(p_organization_id uuid)
 RETURNS TABLE(caregiver_record_id uuid, caregiver_code text, first_name text, last_name text, preferred_name text, status text, has_sign_in boolean, sign_in_status text, active_assignments integer, open_visits integer, updated_at timestamp with time zone, invitation_email text, invited_at timestamp with time zone, invitation_last_sent_at timestamp with time zone, invitation_send_count integer, first_signed_in_at timestamp with time zone, planned_assignments integer, hire_type text, scheduling_mode text, onboarding_required boolean, onboarding_done integer, onboarding_total integer, work_status text, readiness_met integer, readiness_total integer, waiting_on text[], signed_in boolean, has_contact boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
  select cr.id, cr.caregiver_code, cr.first_name, cr.last_name, cr.preferred_name, cr.status,
         cr.linked_user_id is not null,
         m.status::text,
         (select count(*)::integer from ogevia.caregiver_assignments a
           where a.organization_id = cr.organization_id and a.is_active
             and (a.caregiver_record_id = cr.id or (a.caregiver_record_id is null and a.caregiver_user_id = cr.linked_user_id))
             and (a.effective_end is null or a.effective_end >= ogevia.organization_local_date(cr.organization_id, now()))),
         (select count(*)::integer from ogevia.service_visits v
           where v.organization_id = cr.organization_id and v.status = 'draft'
             and (v.caregiver_record_id = cr.id or (cr.linked_user_id is not null and v.caregiver_user_id = cr.linked_user_id))),
         cr.updated_at,
         i.email, i.invited_at, i.last_sent_at, i.send_count, i.first_signed_in_at,
         (select count(*)::integer from ogevia.caregiver_assignments a
           where a.organization_id = cr.organization_id and a.is_active and a.caregiver_record_id = cr.id
             and a.caregiver_user_id is null
             and (a.effective_end is null or a.effective_end >= ogevia.organization_local_date(cr.organization_id, now()))),
         cr.hire_type, cr.scheduling_mode, cr.onboarding_required,
         (select count(*)::integer from ogevia.onboarding_checklist(cr.organization_id, cr.id) k where k.required and k.state in ('done', 'waived')),
         (select count(*)::integer from ogevia.onboarding_checklist(cr.organization_id, cr.id) k where k.required),
         ogevia.caregiver_work_status(cr.organization_id, cr.id), rd.met, rd.total, rd.waiting,
         ogevia.caregiver_has_signed_in(cr.organization_id, cr.id), ogevia.caregiver_has_contact(cr.organization_id, cr.id)
  from ogevia.caregiver_records cr
  left join ogevia.organization_memberships m on m.organization_id = cr.organization_id and m.user_id = cr.linked_user_id and m.role = 'caregiver'
  left join ogevia.caregiver_invitations i on i.organization_id = cr.organization_id and i.caregiver_record_id = cr.id
  left join lateral (select count(*) filter (where q.state = 'met')::integer as met, count(*)::integer as total,
                            coalesce(array_agg(q.label order by q.sort_order) filter (where q.kind = 'hard' and q.state <> 'met'), '{}'::text[]) as waiting
                       from ogevia.caregiver_readiness(cr.organization_id, cr.id) q) rd on true
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
    and cr.organization_id = p_organization_id and cr.deleted_at is null
  order by case ogevia.caregiver_work_status(cr.organization_id, cr.id) when 'active' then 0 when 'approved' then 1 when 'not_ready' then 2 else 3 end, lower(cr.last_name), lower(cr.first_name);
$$;
drop function ogevia_api.list_accounts(uuid);
create function ogevia_api.list_accounts(p_organization_id uuid)
returns table (
  user_id uuid, display_name text, role text, membership_status text, account_status text,
  caregiver_record_id uuid, caregiver_code text, caregiver_name text,
  invited_at timestamptz, first_signed_in_at timestamptz, is_self boolean,
  work_status text, readiness_met integer, readiness_total integer, has_contact boolean
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.accounts_manage_guard(p_organization_id);
begin
  return query
  select x.* from (
    select u.id as user_id,
           coalesce(nullif(btrim(u.display_name), ''), case when cr.id is not null then coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name end) as display_name,
           m.role::text as role, m.status::text as membership_status,
           case when m.status = 'suspended' or u.status = 'disabled' then 'disabled'
                when m.status = 'invited' or (i.id is not null and i.first_signed_in_at is null) then 'invitation_pending'
                else 'active' end as account_status,
           cr.id as caregiver_record_id, cr.caregiver_code as caregiver_code,
           case when cr.id is not null then coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name end as caregiver_name,
           i.invited_at as invited_at, i.first_signed_in_at as first_signed_in_at, (u.id = v_actor) as is_self,
           case when cr.id is not null then ogevia.caregiver_work_status(cr.organization_id, cr.id) end as work_status,
           case when cr.id is not null then (select count(*)::integer from ogevia.caregiver_readiness(cr.organization_id, cr.id) q where q.state = 'met') end as readiness_met,
           case when cr.id is not null then (select count(*)::integer from ogevia.caregiver_readiness(cr.organization_id, cr.id) q) end as readiness_total,
           case when cr.id is not null then ogevia.caregiver_has_contact(cr.organization_id, cr.id) end as has_contact
    from ogevia.organization_memberships m
    join ogevia.app_users u on u.id = m.user_id
    left join ogevia.caregiver_records cr on cr.organization_id = m.organization_id and cr.linked_user_id = u.id and cr.deleted_at is null
    left join ogevia.caregiver_invitations i on i.organization_id = m.organization_id and i.user_id = u.id
    where m.organization_id = p_organization_id and m.status <> 'revoked'
    union all
    select null::uuid, coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name, 'caregiver', 'none', 'setup_required',
           cr.id, cr.caregiver_code, coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name, null::timestamptz, null::timestamptz, false,
           ogevia.caregiver_work_status(cr.organization_id, cr.id),
           (select count(*)::integer from ogevia.caregiver_readiness(cr.organization_id, cr.id) q where q.state = 'met'),
           (select count(*)::integer from ogevia.caregiver_readiness(cr.organization_id, cr.id) q),
           ogevia.caregiver_has_contact(cr.organization_id, cr.id)
    from ogevia.caregiver_records cr
    where cr.organization_id = p_organization_id and cr.linked_user_id is null and cr.deleted_at is null and cr.status <> 'inactive'
  ) x
  order by (x.account_status = 'disabled'), lower(coalesce(x.display_name, '')), x.caregiver_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (same shape as 0055)
-- ---------------------------------------------------------------------------
revoke all on function ogevia.append_only_guard() from public;
revoke all on function ogevia.compliance_grace_days() from public;
revoke all on function ogevia.compliance_grace_days(uuid) from public;
revoke all on function ogevia.compliance_grace_for(uuid, uuid, timestamptz, text) from public;
revoke all on function ogevia.caregiver_has_signed_in(uuid, uuid) from public;
revoke all on function ogevia.caregiver_has_contact(uuid, uuid) from public;
revoke all on function ogevia.caregiver_readiness(uuid, uuid) from public;
revoke all on function ogevia.caregiver_work_status(uuid, uuid) from public;
revoke all on function ogevia.caregiver_readiness_summary(uuid, uuid) from public;
revoke all on function ogevia_api.get_caregiver_readiness(uuid, uuid) from public;
revoke all on function ogevia_api.approve_caregiver_for_work(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.extend_cpr_tb_due_date(uuid, uuid, text, date, text, uuid) from public;
revoke all on function ogevia_api.list_cpr_tb_extensions(uuid, uuid) from public;
revoke all on function ogevia_api.get_compliance_settings(uuid) from public;
revoke all on function ogevia_api.set_cpr_tb_due_days(uuid, integer, text, uuid) from public;
revoke all on function ogevia_api.set_caregiver_contact(uuid, uuid, text, text, uuid) from public;
revoke all on function ogevia_api.get_signin_contact(uuid, uuid) from public;
revoke all on function ogevia_api.list_caregivers(uuid) from public;
revoke all on function ogevia_api.list_accounts(uuid) from public;
grant execute on function ogevia_api.get_caregiver_readiness(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.approve_caregiver_for_work(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.extend_cpr_tb_due_date(uuid, uuid, text, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_cpr_tb_extensions(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.get_compliance_settings(uuid) to ogevia_app;
grant execute on function ogevia_api.set_cpr_tb_due_days(uuid, integer, text, uuid) to ogevia_app;
grant execute on function ogevia_api.set_caregiver_contact(uuid, uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.get_signin_contact(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_caregivers(uuid) to ogevia_app;
grant execute on function ogevia_api.list_accounts(uuid) to ogevia_app;

