-- 0033 Document reminder thresholds, separate document status dimensions, and
-- one Needs attention definition for the badge and the Home list.
--
-- Owner findings 2026-10-05:
--   * Expiring documents and uncovered shifts were visible while the badge said 0:
--     the badge total (0020/0031) counted visits only.
--   * Reminder thresholds must be configurable (90, 60, 30, 14, 7 days by
--     default), per agency and per document type; no expiry alerts for document
--     types without an expiry requirement.
--   * Review state (Requested / Overdue / Awaiting review / Verified / Rejected)
--     must be separate from currency (Current / Expiring / Expired), with the
--     reviewer and review date.
-- Nothing here sends email or SMS: thresholds decide what the screens show.
--
-- Changes:
--   * organizations.document_reminder_days (default {90,60,30,14,7}) and
--     document_types.reminder_days (NULL = agency default); set with
--     set_document_reminder_days (documents.manage), audited.
--   * list_staff_documents: same rows; adds review_state, currency_status,
--     reminder_days, reminder_stage, reviewed_by_name, reviewed_at. "Expiring"
--     now uses the largest threshold of the document's type (was a fixed 30
--     days), and expiry counts only when the type requires an expiry date.
--     display_status is kept for older screens.
--   * get_document_alerts: same columns; defaults to the configured thresholds.
--   * list_document_types: adds reminder_days (effective) and uses_agency_default.
--   * get_attention_summary: adds uncovered_shifts (shifts.manage or
--     visits.manage), documents_blocking (expired + overdue), documents_to_review
--     and documents_expiring (documents.read; informational, not in the total).
--     total = visit items + uncovered shifts + blocking documents + documents to
--     review, each only for a caller allowed to see it.

create function ogevia.valid_reminder_days(p_days integer[])
returns boolean
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select p_days is not null
     and cardinality(p_days) between 1 and 8
     and not exists (select 1 from unnest(p_days) d where d is null or d < 1 or d > 365)
     and (select count(distinct d) from unnest(p_days) d) = cardinality(p_days);
$$;

alter table ogevia.organizations
  add column document_reminder_days integer[] not null default '{90,60,30,14,7}',
  add constraint organizations_document_reminder_days_valid check (coalesce(ogevia.valid_reminder_days(document_reminder_days), false));
alter table ogevia.document_types
  add column reminder_days integer[],
  add constraint document_types_reminder_days_valid check (reminder_days is null or coalesce(ogevia.valid_reminder_days(reminder_days), false));

-- The thresholds in force for a document type (largest first).
create function ogevia.document_reminder_days_for(p_document_type_id uuid)
returns integer[]
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select array(select d from unnest(coalesce(t.reminder_days, o.document_reminder_days)) d order by d desc)
  from ogevia.document_types t join ogevia.organizations o on o.id = t.organization_id
  where t.id = p_document_type_id;
$$;

create function ogevia_api.set_document_reminder_days(
  p_organization_id uuid,
  p_document_type_id uuid,
  p_days integer[],
  p_idempotency_key uuid default null
)
returns integer[]
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fingerprint text := concat_ws('|', p_organization_id, p_document_type_id, array_to_string(p_days, ','));
  v_prior jsonb;
  v_before integer[];
  v_sorted integer[];
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'documents.manage') then
    raise exception 'You do not have permission to configure documents' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_document_reminder_days', p_idempotency_key, p_organization_id, v_fingerprint);
  if v_prior is not null then
    return array(select jsonb_array_elements_text(v_prior -> 'days')::integer);
  end if;
  -- NULL for a document type = use the agency default again.
  if p_days is not null and not coalesce(ogevia.valid_reminder_days(p_days), false) then
    raise exception 'Reminder days must be 1 to 8 different whole numbers from 1 to 365' using errcode = 'OGV22';
  end if;
  if p_document_type_id is null and p_days is null then
    raise exception 'The agency default needs at least one reminder day' using errcode = 'OGV22';
  end if;
  v_sorted := case when p_days is null then null else array(select d from unnest(p_days) d order by d desc) end;
  if p_document_type_id is null then
    select document_reminder_days into v_before from ogevia.organizations where id = p_organization_id for update;
    update ogevia.organizations set document_reminder_days = v_sorted where id = p_organization_id;
    perform ogevia.write_audit(p_organization_id, 'documents.reminder_days_set', 'organizations', p_organization_id,
      jsonb_build_object('days', v_before), jsonb_build_object('days', v_sorted), null);
  else
    select reminder_days into v_before from ogevia.document_types where id = p_document_type_id and organization_id = p_organization_id for update;
    if not found then
      raise exception 'Document type not found' using errcode = 'OGN04';
    end if;
    update ogevia.document_types set reminder_days = v_sorted where id = p_document_type_id;
    perform ogevia.write_audit(p_organization_id, 'documents.reminder_days_set', 'document_types', p_document_type_id,
      jsonb_build_object('days', v_before), jsonb_build_object('days', v_sorted), null);
  end if;
  perform ogevia.idempotency_finish('set_document_reminder_days', p_idempotency_key, p_organization_id, v_fingerprint,
    jsonb_build_object('days', to_jsonb(coalesce(v_sorted, array[]::integer[]))));
  return v_sorted;
end;
$$;

drop function ogevia_api.list_document_types(uuid);
create function ogevia_api.list_document_types(p_organization_id uuid)
returns table (document_type_id uuid, name text, requires_expiry boolean, is_active boolean, reminder_days integer[], uses_agency_default boolean)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select t.id, t.name, t.requires_expiry, t.is_active, ogevia.document_reminder_days_for(t.id), t.reminder_days is null
  from ogevia.document_types t
  where t.organization_id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'documents.read') or ogevia.has_permission(p_organization_id, 'documents.manage_own'))
  order by t.name;
$$;

drop function ogevia_api.get_document_alerts(uuid, integer);
drop function ogevia_api.list_staff_documents(uuid, integer);
create function ogevia_api.list_staff_documents(p_organization_id uuid, p_expiring_window_days integer default null)
returns table (
  document_id uuid,
  caregiver_record_id uuid,
  person_name text,
  document_type_id uuid,
  document_type_name text,
  requires_expiry boolean,
  due_on date,
  requested_at timestamptz,
  latest_version_id uuid,
  latest_version_number integer,
  latest_content_type text,
  latest_uploaded_at timestamptz,
  latest_review_status ogevia.document_review_status,
  latest_rejection_reason text,
  issued_on date,
  expires_on date,
  verified_expires_on date,
  display_status text,
  days_until integer,
  latest_uploaded_by_me boolean,
  review_state text,
  currency_status text,
  reminder_days integer[],
  reminder_stage integer,
  reviewed_by_name text,
  reviewed_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id) as member,
           ogevia.has_permission(p_organization_id, 'documents.read') as can_all,
           ogevia.has_permission(p_organization_id, 'documents.manage_own') as can_own,
           ogevia.my_caregiver_record(p_organization_id) as own_record,
           ogevia.organization_local_date(p_organization_id, now()) as today
  ), docs as (
    select d.*, t.name as type_name, t.requires_expiry,
           coalesce(nullif(btrim(r.preferred_name), ''), r.first_name) || ' ' || r.last_name as person,
           lv.id as v_id, lv.version_number as v_no, lv.content_type as v_type, lv.uploaded_at as v_at,
           lv.review_status as v_status, lv.rejection_reason as v_reason, lv.issued_on as v_issued, lv.expires_on as v_expires,
           lv.uploaded_by = ctx.actor as v_mine,
           -- 0033: an expiry counts only for a type that requires one.
           case when t.requires_expiry then
             (select vv.expires_on from ogevia.document_versions vv where vv.document_id = d.id and vv.review_status = 'verified'
              order by vv.version_number desc limit 1) end as verified_expires,
           exists (select 1 from ogevia.document_versions vv where vv.document_id = d.id and vv.review_status = 'verified') as any_verified,
           ogevia.document_reminder_days_for(t.id) as rdays,
           rv.reviewed_at as rv_at, ru.display_name as rv_by
    from ctx
    join ogevia.staff_documents d on d.organization_id = p_organization_id and d.closed_at is null
    join ogevia.document_types t on t.id = d.document_type_id
    join ogevia.caregiver_records r on r.id = d.caregiver_record_id
    left join lateral (
      select v.* from ogevia.document_versions v where v.document_id = d.id order by v.version_number desc limit 1
    ) lv on true
    left join lateral (
      select v.reviewed_at, v.reviewed_by from ogevia.document_versions v
      where v.document_id = d.id and v.review_status <> 'awaiting_review' order by v.version_number desc limit 1
    ) rv on true
    left join ogevia.app_users ru on ru.id = rv.reviewed_by
    where ctx.actor is not null and ctx.member
      and (ctx.can_all or (ctx.can_own and d.caregiver_record_id = ctx.own_record))
  ), w as (
    select docs.*, coalesce(p_expiring_window_days, docs.rdays[1]) as window_days from docs
  )
  select w.id, w.caregiver_record_id, w.person, w.document_type_id, w.type_name, w.requires_expiry,
         w.due_on, w.requested_at, w.v_id, w.v_no, w.v_type, w.v_at, w.v_status, w.v_reason,
         w.v_issued, w.v_expires, w.verified_expires,
         case
           when w.v_status = 'awaiting_review' then 'awaiting_review'
           when w.verified_expires is not null and w.verified_expires < ctx.today then 'expired'
           when w.verified_expires is not null and w.verified_expires <= ctx.today + w.window_days then 'expiring'
           when w.any_verified then 'verified'
           when w.v_status = 'rejected' then 'rejected'
           when w.due_on is not null and w.due_on < ctx.today then 'overdue'
           else 'requested'
         end,
         case
           when w.verified_expires is not null then w.verified_expires - ctx.today
           when w.due_on is not null and not w.any_verified then w.due_on - ctx.today
         end,
         coalesce(w.v_mine, false),
         case
           when w.v_status = 'awaiting_review' then 'awaiting_review'
           when w.v_status = 'rejected' then 'rejected'
           when w.any_verified then 'verified'
           when w.due_on is not null and w.due_on < ctx.today then 'overdue'
           else 'requested'
         end,
         case
           when not w.requires_expiry then 'no_expiry_required'
           when w.verified_expires is null then 'not_verified'
           when w.verified_expires < ctx.today then 'expired'
           when w.verified_expires <= ctx.today + w.window_days then 'expiring'
           else 'current'
         end,
         w.rdays,
         case when w.verified_expires is not null and w.verified_expires >= ctx.today
              then (select min(d) from unnest(w.rdays) d where w.verified_expires - ctx.today <= d) end,
         w.rv_by,
         w.rv_at
  from w, ctx
  order by w.person, w.type_name;
$$;

create function ogevia_api.get_document_alerts(p_organization_id uuid, p_expiring_window_days integer default null)
returns table (expired integer, expiring integer, overdue integer, awaiting_review integer, rejected integer)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select count(*) filter (where d.display_status = 'expired')::integer,
         count(*) filter (where d.display_status = 'expiring')::integer,
         count(*) filter (where d.display_status = 'overdue')::integer,
         count(*) filter (where d.display_status = 'awaiting_review')::integer,
         count(*) filter (where d.display_status = 'rejected')::integer
  from ogevia_api.list_staff_documents(p_organization_id, p_expiring_window_days) d
  having ogevia.require_actor() is not null
     and ogevia.is_active_member(p_organization_id)
     and ogevia.has_permission(p_organization_id, 'documents.read');
$$;

drop function ogevia_api.get_attention_summary(uuid, integer, integer);
create function ogevia_api.get_attention_summary(
  p_organization_id uuid,
  p_unscheduled_open_hours integer default 12,
  p_unconfirmed_minutes integer default 60
)
returns table (
  missing_time_out integer,
  not_confirmed integer,
  needs_review integer,
  billing_ready_unapproved integer,
  total integer,
  uncovered_shifts integer,
  documents_blocking integer,
  documents_to_review integer,
  documents_expiring integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id)
             and ogevia.has_permission(p_organization_id, 'visits.read') as can_read,
           ogevia.has_permission(p_organization_id, 'billing.visits.read') as can_bill,
           ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage') as can_cover,
           ogevia.has_permission(p_organization_id, 'documents.read') as can_docs
  ), c as (
    select
      count(*) filter (
        where v.status = 'draft' and v.time_out is null
          and ((s.id is not null and s.ends_at < now())
               or (s.id is null and v.time_in <= now() - make_interval(hours => p_unscheduled_open_hours)))
      )::integer as missing_time_out,
      count(*) filter (
        where v.status = 'awaiting_signature' and v.time_out is not null
          and v.time_out <= now() - make_interval(mins => p_unconfirmed_minutes)
      )::integer as not_confirmed,
      count(*) filter (
        where v.status = 'administrator_review'
          and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
      )::integer as needs_review,
      count(*) filter (
        where v.status = 'signed'
          and not exists (select 1 from ogevia.billing_approvals b where b.visit_id = v.id and b.voided_at is null)
      )::integer as ready_unapproved
    from ogevia.service_visits v
    left join ogevia.shifts s on s.id = v.scheduled_shift_id
    where v.organization_id = p_organization_id
      and v.status in ('draft', 'awaiting_signature', 'administrator_review', 'signed')
  ), cov as (
    -- Upcoming shifts with nobody to work them (open, or called out and not replaced).
    select count(*)::integer as uncovered
    from ctx, ogevia.shifts sh
    where ctx.can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled'
      and sh.ends_at > now() and ogevia.shift_coverage_state(sh) = 'needs_coverage'
  ), docs as (
    select a.* from ctx, ogevia_api.get_document_alerts(p_organization_id) a where ctx.can_docs
  )
  select c.missing_time_out, c.not_confirmed, c.needs_review,
         case when ctx.can_bill then c.ready_unapproved end,
         c.missing_time_out + c.not_confirmed + c.needs_review
           + case when ctx.can_cover then cov.uncovered else 0 end
           + coalesce((select d.expired + d.overdue + d.awaiting_review from docs d), 0),
         case when ctx.can_cover then cov.uncovered end,
         (select d.expired + d.overdue from docs d),
         (select d.awaiting_review from docs d),
         (select d.expiring from docs d)
  from ctx, c, cov
  where ctx.actor is not null and ctx.can_read;
$$;

revoke all on function ogevia.valid_reminder_days(integer[]) from public;
revoke all on function ogevia.document_reminder_days_for(uuid) from public;
revoke all on function ogevia_api.set_document_reminder_days(uuid, uuid, integer[], uuid) from public;
revoke all on function ogevia_api.list_document_types(uuid) from public;
revoke all on function ogevia_api.list_staff_documents(uuid, integer) from public;
revoke all on function ogevia_api.get_document_alerts(uuid, integer) from public;
revoke all on function ogevia_api.get_attention_summary(uuid, integer, integer) from public;
grant execute on function ogevia_api.set_document_reminder_days(uuid, uuid, integer[], uuid) to ogevia_app;
grant execute on function ogevia_api.list_document_types(uuid) to ogevia_app;
grant execute on function ogevia_api.list_staff_documents(uuid, integer) to ogevia_app;
grant execute on function ogevia_api.get_document_alerts(uuid, integer) to ogevia_app;
grant execute on function ogevia_api.get_attention_summary(uuid, integer, integer) to ogevia_app;
