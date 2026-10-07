-- 0019 Human billing approval (translated from current main).
--
-- Source: supabase 20260812193010 / 20260812193042 (pipeline),
-- 20260822020000 (rate snapshot, amount), 20260822030000 and
-- 20260825012407 (manager approves; dollar amounts and rates are owner-only).
-- Owner decision 2026-10-03 (docs/product/OGEVIA_UX_CHANGE_LIST.md):
-- managers may approve billing; payroll, costs, margins and agency finances
-- stay owner-only. The existing role grants already match (0002: owner and
-- manager hold billing.approve). This adds what was never migrated:
--
--   * ogevia.billing_approvals: one ACTIVE approval per visit (partial unique
--     index), append-only except the one-time void columns, never deleted.
--   * approve_visit_for_billing(visit, approved minutes, notes, key):
--     billing.approve; the visit must be 'signed' (Billing Ready). Visits in
--     administrator_review are never approvable until reviewed. Approved
--     minutes are 0..billable_minutes. (Current main caps at worked_minutes;
--     billable_minutes is already the authorization-capped quantity, so
--     approving above it would bill time the authorization does not cover.)
--     The rate is snapshotted at approval so a later amendment never changes
--     an approved amount. Idempotent with a key; audited.
--   * void_billing_approval(approval, reason, key): billing.approve, reason
--     required, audited. The visit returns to Billing Ready.
--   * list_billing_approvals(org, from, to): billing.visits.read. Rate and
--     amount are NULL unless the caller holds billing.read (owner only).
--   * billing.read (new key): view rates and dollar amounts. Owner only.
--   * A signed visit with an active approval cannot be corrected: the
--     approval must be voided first, so an approval never points at a
--     replaced visit (current main has no such guard).
--
-- Not in this migration (deliberately): payer submission (billing.submit),
-- invoices, exports, payroll. Approval is not submission.

insert into ogevia.permissions (key, description) values
  ('billing.read', 'View billing rates and dollar amounts');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'billing.read');

create table ogevia.billing_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  approved_by uuid not null references ogevia.app_users(id),
  approved_at timestamptz not null default now(),
  approved_minutes integer not null check (approved_minutes >= 0),
  billable_minutes_at_approval integer not null check (billable_minutes_at_approval >= 0),
  notes text,
  rate_cents integer check (rate_cents is null or rate_cents >= 0),
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  source_snapshot jsonb not null,
  voided_at timestamptz,
  voided_by uuid references ogevia.app_users(id),
  void_reason text,
  constraint billing_approvals_minutes_le_billable check (approved_minutes <= billable_minutes_at_approval),
  constraint billing_approvals_void_shape check (
    (voided_at is null and voided_by is null and void_reason is null)
    or (voided_at is not null and voided_by is not null and length(btrim(coalesce(void_reason, ''))) > 0)
  )
);
create unique index billing_approvals_active_visit_unique
  on ogevia.billing_approvals (visit_id) where voided_at is null;
create index billing_approvals_org_time_idx on ogevia.billing_approvals (organization_id, approved_at desc);

-- Only the void columns may change, once. Everything else is append-only.
create function ogevia.billing_approvals_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.voided_at is not null then
    raise exception 'A voided billing approval cannot be changed' using errcode = 'OGC09';
  end if;
  if (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason'])
     is distinct from (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason']) then
    raise exception 'Billing approvals are append-only; void and approve again' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
create trigger billing_approvals_guard_update before update on ogevia.billing_approvals
for each row execute function ogevia.billing_approvals_guard_update();
create trigger billing_approvals_no_delete before delete on ogevia.billing_approvals
for each row execute function ogevia.forbid_delete();

alter table ogevia.billing_approvals enable row level security;
create policy readonly_select on ogevia.billing_approvals for select to ogevia_readonly using (true);
grant select on ogevia.billing_approvals to ogevia_readonly;

-- A correction replaces the visit row; an active approval must be voided first.
create function ogevia.service_visits_billing_approval_guard()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if new.status is distinct from old.status
     and exists (select 1 from ogevia.billing_approvals b where b.visit_id = old.id and b.voided_at is null) then
    raise exception 'This visit is approved for billing; void the billing approval before correcting it'
      using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
create trigger service_visits_billing_approval_guard
before update of status on ogevia.service_visits
for each row execute function ogevia.service_visits_billing_approval_guard();

create function ogevia_api.approve_visit_for_billing(
  p_visit_id uuid,
  p_approved_minutes integer,
  p_notes text default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_rate integer;
  v_amount integer;
  v_fingerprint text := concat_ws('|', p_visit_id, p_approved_minutes, btrim(coalesce(p_notes, '')));
  v_prior jsonb;
  v_id uuid;
  v_after jsonb;
begin
  select * into v_visit from ogevia.service_visits v where v.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_visit.organization_id, 'billing.approve') then
    raise exception 'You do not have permission to approve billing for this organization' using errcode = 'OGA03';
  end if;

  v_prior := ogevia.idempotency_begin('approve_billing', p_idempotency_key, v_visit.organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'billing_approval_id')::uuid;
  end if;

  if v_visit.status <> 'signed' then
    raise exception 'Only a Billing Ready visit can be approved; visits needing review must be reviewed first'
      using errcode = 'OGC09';
  end if;
  if p_approved_minutes is null or p_approved_minutes < 0 or p_approved_minutes > v_visit.billable_minutes then
    raise exception 'Approved minutes must be between 0 and the billable minutes (%)', v_visit.billable_minutes
      using errcode = 'OGV22';
  end if;
  if exists (select 1 from ogevia.billing_approvals b where b.visit_id = v_visit.id and b.voided_at is null) then
    raise exception 'This visit already has an active billing approval' using errcode = 'OGC09';
  end if;

  select a.hourly_rate_cents into v_rate from ogevia.client_authorizations a where a.id = v_visit.service_authorization_id;
  if v_rate is not null then
    v_amount := round(p_approved_minutes / 60.0 * v_rate)::integer;
  end if;

  insert into ogevia.billing_approvals (
    organization_id, visit_id, approved_by, approved_minutes, billable_minutes_at_approval,
    notes, rate_cents, amount_cents, source_snapshot
  ) values (
    v_visit.organization_id, v_visit.id, v_actor, p_approved_minutes, v_visit.billable_minutes,
    nullif(btrim(coalesce(p_notes, '')), ''), v_rate, v_amount,
    jsonb_build_object(
      'visitId', v_visit.id, 'visitNumber', v_visit.visit_number_snapshot,
      'clientId', v_visit.client_id, 'clientCode', v_visit.client_code_snapshot,
      'serviceId', v_visit.service_id, 'serviceDate', v_visit.service_date,
      'timeIn', v_visit.time_in, 'timeOut', v_visit.time_out,
      'workedMinutes', v_visit.worked_minutes, 'billableMinutes', v_visit.billable_minutes,
      'serviceAuthorizationId', v_visit.service_authorization_id)
  ) returning id into v_id;

  -- The audit row carries minutes only; dollar values stay in the owner-only columns.
  v_after := jsonb_build_object('billing_approval_id', v_id, 'visit_id', v_visit.id,
    'approved_minutes', p_approved_minutes, 'billable_minutes', v_visit.billable_minutes);
  perform ogevia.write_audit(v_visit.organization_id, 'billing.approved', 'billing_approvals', v_id,
    null, v_after, nullif(btrim(coalesce(p_notes, '')), ''));
  perform ogevia.idempotency_finish('approve_billing', p_idempotency_key, v_visit.organization_id,
    v_fingerprint, jsonb_build_object('billing_approval_id', v_id));
  return v_id;
end;
$$;

create function ogevia_api.void_billing_approval(
  p_approval_id uuid,
  p_reason text,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_row ogevia.billing_approvals%rowtype;
  v_fingerprint text := concat_ws('|', p_approval_id, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to void a billing approval' using errcode = 'OGV22';
  end if;
  select * into v_row from ogevia.billing_approvals b where b.id = p_approval_id for update;
  if v_row.id is null or not ogevia.is_active_member(v_row.organization_id) then
    raise exception 'Billing approval not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_row.organization_id, 'billing.approve') then
    raise exception 'You do not have permission to void billing approvals for this organization' using errcode = 'OGA03';
  end if;

  v_prior := ogevia.idempotency_begin('void_billing_approval', p_idempotency_key, v_row.organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'billing_approval_id')::uuid;
  end if;
  if v_row.voided_at is not null then
    raise exception 'This billing approval is already voided' using errcode = 'OGC09';
  end if;

  update ogevia.billing_approvals
     set voided_at = now(), voided_by = v_actor, void_reason = btrim(p_reason)
   where id = v_row.id;

  perform ogevia.write_audit(v_row.organization_id, 'billing.approval_voided', 'billing_approvals', v_row.id,
    jsonb_build_object('billing_approval_id', v_row.id, 'visit_id', v_row.visit_id, 'approved_minutes', v_row.approved_minutes),
    jsonb_build_object('billing_approval_id', v_row.id, 'visit_id', v_row.visit_id, 'voided', true),
    btrim(p_reason));
  perform ogevia.idempotency_finish('void_billing_approval', p_idempotency_key, v_row.organization_id,
    v_fingerprint, jsonb_build_object('billing_approval_id', v_row.id));
  return v_row.id;
end;
$$;

create function ogevia_api.list_billing_approvals(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  billing_approval_id uuid,
  visit_id uuid,
  visit_number text,
  service_date date,
  approved_minutes integer,
  billable_minutes_at_approval integer,
  approved_at timestamptz,
  approved_by_name text,
  notes text,
  voided_at timestamptz,
  voided_by_name text,
  void_reason text,
  rate_cents integer,
  amount_cents integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.has_permission(p_organization_id, 'billing.visits.read') as can_read,
           ogevia.has_permission(p_organization_id, 'billing.read') as can_see_money
  )
  select
    b.id, b.visit_id, v.visit_number_snapshot, v.service_date,
    b.approved_minutes, b.billable_minutes_at_approval, b.approved_at,
    coalesce(nullif(btrim(ua.display_name), ''), 'Name not set'),
    b.notes, b.voided_at,
    case when b.voided_by is null then null else coalesce(nullif(btrim(uv.display_name), ''), 'Name not set') end,
    b.void_reason,
    case when ctx.can_see_money then b.rate_cents end,
    case when ctx.can_see_money then b.amount_cents end
  from ctx
  join ogevia.billing_approvals b on b.organization_id = p_organization_id
  join ogevia.service_visits v on v.id = b.visit_id
  join ogevia.app_users ua on ua.id = b.approved_by
  left join ogevia.app_users uv on uv.id = b.voided_by
  where ctx.actor is not null
    and ctx.can_read
    and v.service_date between p_date_from and p_date_to
  order by v.service_date, b.approved_at;
$$;

revoke all on function ogevia_api.approve_visit_for_billing(uuid, integer, text, uuid) from public;
revoke all on function ogevia_api.void_billing_approval(uuid, text, uuid) from public;
revoke all on function ogevia_api.list_billing_approvals(uuid, date, date) from public;
grant execute on function ogevia_api.approve_visit_for_billing(uuid, integer, text, uuid) to ogevia_app;
grant execute on function ogevia_api.void_billing_approval(uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_billing_approvals(uuid, date, date) to ogevia_app;
