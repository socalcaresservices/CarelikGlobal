-- ROLLBACK 0033_document_reminders_attention | CLASS: SAFE AUTOMATED (refuses when settings would be lost)
-- Refuses while any agency or document type has reminder days other than the
-- default (those settings would be lost). Otherwise restores list_document_types,
-- list_staff_documents, get_document_alerts (0021) and get_attention_summary (0031).
do $$ begin
  if exists (select 1 from ogevia.organizations where document_reminder_days <> '{90,60,30,14,7}')
     or exists (select 1 from ogevia.document_types where reminder_days is not null) then
    raise exception 'ROLLBACK REFUSED: custom document reminder days are recorded; export them first (they would be lost)';
  end if;
end $$;
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
  total integer
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
           ogevia.has_permission(p_organization_id, 'billing.visits.read') as can_bill
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
      -- 0031: a visit with an active review decision no longer needs attention.
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
  )
  select c.missing_time_out, c.not_confirmed, c.needs_review,
         case when ctx.can_bill then c.ready_unapproved end,
         c.missing_time_out + c.not_confirmed + c.needs_review
  from ctx, c
  where ctx.actor is not null and ctx.can_read;
$$;
drop function ogevia_api.get_document_alerts(uuid, integer);
drop function ogevia_api.list_staff_documents(uuid, integer);
create function ogevia_api.list_staff_documents(p_organization_id uuid, p_expiring_window_days integer default 30)
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
  latest_uploaded_by_me boolean
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
           (select vv.expires_on from ogevia.document_versions vv where vv.document_id = d.id and vv.review_status = 'verified'
            order by vv.version_number desc limit 1) as verified_expires,
           exists (select 1 from ogevia.document_versions vv where vv.document_id = d.id and vv.review_status = 'verified') as any_verified
    from ctx
    join ogevia.staff_documents d on d.organization_id = p_organization_id and d.closed_at is null
    join ogevia.document_types t on t.id = d.document_type_id
    join ogevia.caregiver_records r on r.id = d.caregiver_record_id
    left join lateral (
      select v.* from ogevia.document_versions v where v.document_id = d.id order by v.version_number desc limit 1
    ) lv on true
    where ctx.actor is not null and ctx.member
      and (ctx.can_all or (ctx.can_own and d.caregiver_record_id = ctx.own_record))
  )
  select docs.id, docs.caregiver_record_id, docs.person, docs.document_type_id, docs.type_name, docs.requires_expiry,
         docs.due_on, docs.requested_at, docs.v_id, docs.v_no, docs.v_type, docs.v_at, docs.v_status, docs.v_reason,
         docs.v_issued, docs.v_expires, docs.verified_expires,
         case
           when docs.v_status = 'awaiting_review' then 'awaiting_review'
           when docs.verified_expires is not null and docs.verified_expires < ctx.today then 'expired'
           when docs.verified_expires is not null and docs.verified_expires <= ctx.today + p_expiring_window_days then 'expiring'
           when docs.any_verified then 'verified'
           when docs.v_status = 'rejected' then 'rejected'
           when docs.due_on is not null and docs.due_on < ctx.today then 'overdue'
           else 'requested'
         end,
         case
           when docs.verified_expires is not null then docs.verified_expires - ctx.today
           when docs.due_on is not null and not docs.any_verified then docs.due_on - ctx.today
         end,
         coalesce(docs.v_mine, false)
  from docs, ctx
  order by docs.person, docs.type_name;
$$;
create function ogevia_api.get_document_alerts(p_organization_id uuid, p_expiring_window_days integer default 30)
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
drop function ogevia_api.list_document_types(uuid);
create function ogevia_api.list_document_types(p_organization_id uuid)
returns table (document_type_id uuid, name text, requires_expiry boolean, is_active boolean)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select t.id, t.name, t.requires_expiry, t.is_active
  from ogevia.document_types t
  where t.organization_id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'documents.read') or ogevia.has_permission(p_organization_id, 'documents.manage_own'))
  order by t.name;
$$;
drop function if exists ogevia_api.set_document_reminder_days(uuid, uuid, integer[], uuid);
revoke all on function ogevia_api.list_document_types(uuid) from public;
revoke all on function ogevia_api.list_staff_documents(uuid, integer) from public;
revoke all on function ogevia_api.get_document_alerts(uuid, integer) from public;
revoke all on function ogevia_api.get_attention_summary(uuid, integer, integer) from public;
grant execute on function ogevia_api.list_document_types(uuid) to ogevia_app;
grant execute on function ogevia_api.list_staff_documents(uuid, integer) to ogevia_app;
grant execute on function ogevia_api.get_document_alerts(uuid, integer) to ogevia_app;
grant execute on function ogevia_api.get_attention_summary(uuid, integer, integer) to ogevia_app;
alter table ogevia.document_types drop constraint document_types_reminder_days_valid, drop column reminder_days;
alter table ogevia.organizations drop constraint organizations_document_reminder_days_valid, drop column document_reminder_days;
drop function if exists ogevia.document_reminder_days_for(uuid);
drop function if exists ogevia.valid_reminder_days(integer[]);
