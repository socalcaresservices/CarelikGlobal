-- 0020 Agency workspace: signed-in identity, agency branding colour,
-- NEEDS ATTENTION counts and the monthly utilisation overview.
-- Owner decisions 2026-10-03 (docs/product/OGEVIA_UX_CHANGE_LIST.md).
--
--   * get_my_profile(): the caller's own display name ("Name not set" is a
--     UI fallback; nothing is invented). set_my_display_name(): the caller
--     completes their own name; audited in each agency they belong to.
--   * organizations.accent_color: one agency accent colour, set only by
--     holders of organization.update (owner). The server refuses a colour
--     whose contrast with white text is below 4.5:1 (WCAG AA), so branding
--     can never make buttons unreadable. Warning red stays fixed in the UI.
--     get_organization_branding(): any active member.
--   * get_attention_summary(): visits.read. The same rules the Visit
--     records page uses (classifyIncompleteVisit): open past the shift end,
--     or open 12 h without a schedule; awaiting confirmation 60 min after
--     Time Out; visits in administrator review. "Billing ready, not
--     approved" is returned only to holders of billing.visits.read.
--   * get_utilisation_overview(): visits.read. Per service for one month:
--     authorized (latest version of each lineage, never summed across
--     versions), scheduled (future, not called out, not yet a visit),
--     worked, billable, in review, approved, hours left. Dollar values only
--     for billing.read (owner): billable value at the authorization's rate,
--     approved value (snapshotted), potential value of unused authorized
--     hours. Missing rates are reported, never treated as $0. There is no
--     caregiver pay source, so cost and margin are not computed.
--   * Agency logo (owner, organization.update): PNG or JPEG, at most 512 KB,
--     stored in the private evidence bucket at {org}/branding/logo/{uuid}
--     and read only through the API by members of the agency. The database
--     holds key, S3 version, type and SHA-256. Changes are audited.
--   * Client names (restricted): AWS clients carry codes only. An optional
--     legal first/last name lives in a separate table, readable and editable
--     only with clients.names.read / clients.names.manage (owner, manager).
--     Caregivers never receive names. Changes are audited. Real names must
--     not be entered before the AWS BAA/security gate (synthetic in TEST).

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create function ogevia_api.get_my_profile()
returns table (user_id uuid, display_name text)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select u.id, nullif(btrim(u.display_name), '')
  from ogevia.app_users u
  where u.id = ogevia.require_actor();
$$;

create function ogevia_api.set_my_display_name(p_display_name text)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_name text := btrim(coalesce(p_display_name, ''));
  v_before text;
  m record;
begin
  if length(v_name) < 2 or length(v_name) > 80 then
    raise exception 'Enter a name between 2 and 80 characters' using errcode = 'OGV22';
  end if;
  select display_name into v_before from ogevia.app_users where id = v_actor for update;
  if v_before is not distinct from v_name then
    return v_name;
  end if;
  update ogevia.app_users set display_name = v_name, updated_at = now() where id = v_actor;
  for m in select organization_id from ogevia.organization_memberships where user_id = v_actor and status = 'active' loop
    perform ogevia.write_audit(m.organization_id, 'user.display_name_set', 'app_users', v_actor,
      jsonb_build_object('display_name', v_before), jsonb_build_object('display_name', v_name), null);
  end loop;
  return v_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Branding
-- ---------------------------------------------------------------------------
insert into ogevia.permissions (key, description) values
  ('organization.update', 'Change agency name and branding')
on conflict (key) do nothing;
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'organization.update')
on conflict do nothing;

alter table ogevia.organizations
  add column accent_color text check (accent_color is null or accent_color ~ '^#[0-9a-f]{6}$');

-- WCAG 2.x contrast ratio of a #rrggbb colour against white.
create function ogevia.contrast_with_white(p_hex text)
returns numeric
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  with c as (
    select ('x' || substr(p_hex, 2, 2))::bit(8)::int / 255.0 as r,
           ('x' || substr(p_hex, 4, 2))::bit(8)::int / 255.0 as g,
           ('x' || substr(p_hex, 6, 2))::bit(8)::int / 255.0 as b
  ), lin as (
    select case when r <= 0.03928 then r / 12.92 else power((r + 0.055) / 1.055, 2.4) end as r,
           case when g <= 0.03928 then g / 12.92 else power((g + 0.055) / 1.055, 2.4) end as g,
           case when b <= 0.03928 then b / 12.92 else power((b + 0.055) / 1.055, 2.4) end as b
    from c
  )
  select round(1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05), 2) from lin;
$$;

alter table ogevia.organizations
  add column logo_object_key text,
  add column logo_s3_version_id text,
  add column logo_content_type text check (logo_content_type is null or logo_content_type in ('image/png', 'image/jpeg')),
  add column logo_sha256 text check (logo_sha256 is null or logo_sha256 ~ '^[0-9a-f]{64}$'),
  add column logo_updated_at timestamptz;

create function ogevia_api.get_organization_branding(p_organization_id uuid)
returns table (organization_id uuid, display_name text, accent_color text, logo_sha256 text)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select o.id, o.display_name, o.accent_color, o.logo_sha256
  from ogevia.organizations o
  where o.id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id);
$$;

create function ogevia_api.set_organization_branding(
  p_organization_id uuid,
  p_display_name text,
  p_accent_color text,
  p_idempotency_key uuid default null
)
returns table (organization_id uuid, display_name text, accent_color text)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_name text := btrim(coalesce(p_display_name, ''));
  v_color text := lower(nullif(btrim(coalesce(p_accent_color, '')), ''));
  v_fingerprint text := concat_ws('|', p_organization_id, v_name, coalesce(v_color, '-'));
  v_prior jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then
    raise exception 'Only the agency owner can change branding' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_branding', p_idempotency_key, p_organization_id, v_fingerprint);
  if v_prior is null then
    if length(v_name) < 2 or length(v_name) > 120 then
      raise exception 'Enter an agency name between 2 and 120 characters' using errcode = 'OGV22';
    end if;
    if v_color is not null and v_color !~ '^#[0-9a-f]{6}$' then
      raise exception 'Colour must look like #1f5f8b' using errcode = 'OGV22';
    end if;
    if v_color is not null and ogevia.contrast_with_white(v_color) < 4.5 then
      raise exception 'That colour is too light for white text (contrast %:1, needs 4.5:1). Choose a darker colour.',
        ogevia.contrast_with_white(v_color) using errcode = 'OGV22';
    end if;
    select jsonb_build_object('display_name', o.display_name, 'accent_color', o.accent_color) into v_before
      from ogevia.organizations o where o.id = p_organization_id for update;
    update ogevia.organizations o set display_name = v_name, accent_color = v_color, updated_at = now()
     where o.id = p_organization_id;
    v_after := jsonb_build_object('display_name', v_name, 'accent_color', v_color);
    perform ogevia.write_audit(p_organization_id, 'organization.branding_updated', 'organizations', p_organization_id,
      v_before, v_after, null);
    perform ogevia.idempotency_finish('set_branding', p_idempotency_key, p_organization_id, v_fingerprint, v_after);
  end if;
  return query select o.id, o.display_name, o.accent_color from ogevia.organizations o where o.id = p_organization_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- NEEDS ATTENTION
-- ---------------------------------------------------------------------------
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
      count(*) filter (where v.status = 'administrator_review')::integer as needs_review,
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

-- ---------------------------------------------------------------------------
-- Utilisation overview
-- ---------------------------------------------------------------------------
create function ogevia_api.get_utilisation_overview(p_organization_id uuid, p_month_start date)
returns table (
  service_id uuid,
  service_code text,
  service_name text,
  client_count integer,
  authorized_minutes integer,
  scheduled_minutes integer,
  worked_minutes integer,
  billable_minutes integer,
  review_minutes integer,
  approved_minutes integer,
  remaining_minutes integer,
  lineages_without_rate integer,
  billable_value_cents bigint,
  approved_value_cents bigint,
  unused_value_cents bigint
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
           ogevia.has_permission(p_organization_id, 'billing.read') as can_see_money,
           date_trunc('month', p_month_start::timestamp)::date as m0,
           (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as m1
  ),
  -- One row per client/service/lineage; the latest version only (0010).
  summary as (
    select s.* from ctx, ogevia_api.list_monthly_service_summary(p_organization_id, ctx.m0, null) s
    where ctx.can_read
  ),
  lineage_rate as (
    select distinct on (a.lineage_id) a.lineage_id, a.hourly_rate_cents
    from ogevia.client_authorizations a
    join summary su on su.authorization_lineage_id = a.lineage_id
    order by a.lineage_id, a.version_number desc
  ),
  visit_values as (
    select va.lineage_id,
           sum(v.billable_minutes::numeric / 60 * va.hourly_rate_cents) filter (where va.hourly_rate_cents is not null) as billable_value,
           coalesce(sum(b.approved_minutes), 0)::integer as approved_minutes,
           sum(b.amount_cents) as approved_value
    from ctx
    join ogevia.service_visits v on v.organization_id = p_organization_id
     and v.service_date >= ctx.m0 and v.service_date < ctx.m1
     and v.status in ('signed', 'administrator_review')
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
    left join ogevia.billing_approvals b on b.visit_id = v.id and b.voided_at is null
    where ctx.can_read
    group by va.lineage_id
  ),
  scheduled as (
    select sh.service_id, sum(extract(epoch from (sh.ends_at - sh.starts_at)) / 60)::integer as minutes
    from ctx
    join ogevia.shifts sh on sh.organization_id = p_organization_id
     and sh.status = 'scheduled' and sh.starts_at >= now()
     and sh.starts_at >= ctx.m0::timestamp and sh.starts_at < ctx.m1::timestamp
    where ctx.can_read
      and not ogevia.shift_is_called_out(sh.id)
      and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = sh.id and v.status not in ('voided', 'corrected'))
    group by sh.service_id
  ),
  per_service as (
    select su.service_id, su.service_code, su.service_name,
           count(distinct su.client_id)::integer as client_count,
           sum(su.authorized_minutes)::integer as authorized_minutes,
           sum(su.worked_minutes)::integer as worked_minutes,
           sum(su.billable_minutes)::integer as billable_minutes,
           sum(su.review_minutes)::integer as review_minutes,
           coalesce(sum(vv.approved_minutes), 0)::integer as approved_minutes,
           sum(su.remaining_minutes)::integer as remaining_minutes,
           count(*) filter (where lr.hourly_rate_cents is null)::integer as lineages_without_rate,
           round(sum(vv.billable_value))::bigint as billable_value,
           sum(vv.approved_value)::bigint as approved_value,
           round(sum(su.remaining_minutes::numeric / 60 * lr.hourly_rate_cents) filter (where lr.hourly_rate_cents is not null))::bigint as unused_value
    from summary su
    left join lineage_rate lr on lr.lineage_id = su.authorization_lineage_id
    left join visit_values vv on vv.lineage_id = su.authorization_lineage_id
    group by su.service_id, su.service_code, su.service_name
  )
  select ps.service_id, ps.service_code, ps.service_name, ps.client_count, ps.authorized_minutes,
         coalesce(sc.minutes, 0), ps.worked_minutes, ps.billable_minutes, ps.review_minutes,
         ps.approved_minutes, ps.remaining_minutes, ps.lineages_without_rate,
         case when ctx.can_see_money then ps.billable_value end,
         case when ctx.can_see_money then ps.approved_value end,
         case when ctx.can_see_money then ps.unused_value end
  from ctx
  join per_service ps on true
  left join scheduled sc on sc.service_id = ps.service_id
  where ctx.actor is not null and ctx.can_read
  order by ps.service_name, ps.service_code;
$$;

-- ---------------------------------------------------------------------------
-- Agency logo
-- ---------------------------------------------------------------------------
create function ogevia_api.set_organization_logo(
  p_organization_id uuid, p_logo_id uuid, p_object_key text, p_s3_version_id text,
  p_content_type text, p_byte_size integer, p_sha256 text, p_idempotency_key uuid default null
)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, lower(coalesce(p_sha256, '')));
  v_prior jsonb;
  v_before jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then
    raise exception 'Only the agency owner can change the logo' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_logo', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'sha256'; end if;
  if p_object_key <> p_organization_id::text || '/branding/logo/' || p_logo_id::text then
    raise exception 'Invalid object key' using errcode = 'OGV22';
  end if;
  if p_content_type not in ('image/png', 'image/jpeg') or p_byte_size not between 1 and 512000 then
    raise exception 'The logo must be a PNG or JPEG of at most 512 KB' using errcode = 'OGV22';
  end if;
  select jsonb_build_object('logo_sha256', o.logo_sha256, 'logo_object_key', o.logo_object_key) into v_before
    from ogevia.organizations o where o.id = p_organization_id for update;
  update ogevia.organizations
     set logo_object_key = p_object_key, logo_s3_version_id = p_s3_version_id, logo_content_type = p_content_type,
         logo_sha256 = lower(p_sha256), logo_updated_at = now(), updated_at = now()
   where id = p_organization_id;
  perform ogevia.write_audit(p_organization_id, 'organization.logo_updated', 'organizations', p_organization_id,
    v_before, jsonb_build_object('logo_sha256', lower(p_sha256), 'logo_object_key', p_object_key, 'byte_size', p_byte_size), null);
  perform ogevia.idempotency_finish('set_logo', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('sha256', lower(p_sha256)));
  return lower(p_sha256);
end;
$$;

create function ogevia_api.clear_organization_logo(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_before jsonb;
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then
    raise exception 'Only the agency owner can change the logo' using errcode = 'OGA03';
  end if;
  select jsonb_build_object('logo_sha256', o.logo_sha256, 'logo_object_key', o.logo_object_key) into v_before
    from ogevia.organizations o where o.id = p_organization_id for update;
  -- The S3 object is kept (versioned bucket); only the reference is removed.
  update ogevia.organizations
     set logo_object_key = null, logo_s3_version_id = null, logo_content_type = null, logo_sha256 = null,
         logo_updated_at = now(), updated_at = now()
   where id = p_organization_id;
  perform ogevia.write_audit(p_organization_id, 'organization.logo_removed', 'organizations', p_organization_id,
    v_before, jsonb_build_object('logo_sha256', null), null);
end;
$$;

create function ogevia_api.get_organization_logo(p_organization_id uuid)
returns table (object_key text, s3_version_id text, content_type text, sha256 text)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select o.logo_object_key, o.logo_s3_version_id, o.logo_content_type, o.logo_sha256
  from ogevia.organizations o
  where o.id = p_organization_id
    and o.logo_object_key is not null
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id);
$$;

-- ---------------------------------------------------------------------------
-- Restricted client names
-- ---------------------------------------------------------------------------
insert into ogevia.permissions (key, description) values
  ('clients.names.read', 'See client legal names (office only; never caregivers)'),
  ('clients.names.manage', 'Enter or change client legal names (office only)')
on conflict (key) do nothing;
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'clients.names.read'),
  ('organization_owner', 'clients.names.manage'),
  ('manager', 'clients.names.read'),
  ('manager', 'clients.names.manage')
on conflict do nothing;

create table ogevia.client_private_names (
  client_id uuid primary key,
  organization_id uuid not null references ogevia.organizations(id),
  legal_first_name text not null check (length(btrim(legal_first_name)) between 1 and 80),
  legal_last_name text not null check (length(btrim(legal_last_name)) between 1 and 80),
  updated_by uuid not null references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id)
);
alter table ogevia.client_private_names enable row level security;
create policy readonly_select on ogevia.client_private_names for select to ogevia_readonly using (true);
grant select on ogevia.client_private_names to ogevia_readonly;

-- Office directory: codes for visits.read; names only with clients.names.read.
create function ogevia_api.list_client_directory(p_organization_id uuid)
returns table (client_id uuid, client_code text, caregiver_display_code text, status ogevia.client_status,
               legal_first_name text, legal_last_name text)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id) and ogevia.has_permission(p_organization_id, 'visits.read') as can_list,
           ogevia.has_permission(p_organization_id, 'clients.names.read') as can_names
  )
  select c.id, c.client_code, c.caregiver_display_code, c.status,
         case when ctx.can_names then n.legal_first_name end,
         case when ctx.can_names then n.legal_last_name end
  from ctx
  join ogevia.clients c on c.organization_id = p_organization_id and c.deleted_at is null
  left join ogevia.client_private_names n on n.client_id = c.id
  where ctx.actor is not null and ctx.can_list
  order by c.client_code;
$$;

create function ogevia_api.set_client_legal_name(
  p_organization_id uuid, p_client_id uuid, p_first_name text, p_last_name text, p_idempotency_key uuid default null
)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_first text := btrim(coalesce(p_first_name, ''));
  v_last text := btrim(coalesce(p_last_name, ''));
  v_fp text := concat_ws('|', p_organization_id, p_client_id, v_first, v_last);
  v_prior jsonb;
  v_before jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'clients.names.manage') then
    raise exception 'You do not have permission to change client names' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_client_name', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return; end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;
  if length(v_first) not between 1 and 80 or length(v_last) not between 1 and 80 then
    raise exception 'Enter a first and last name (up to 80 characters each)' using errcode = 'OGV22';
  end if;
  select to_jsonb(n) - array['updated_by', 'updated_at'] into v_before from ogevia.client_private_names n where n.client_id = p_client_id;
  insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by)
  values (p_client_id, p_organization_id, v_first, v_last, v_actor)
  on conflict (client_id) do update set legal_first_name = excluded.legal_first_name, legal_last_name = excluded.legal_last_name,
    updated_by = excluded.updated_by, updated_at = now();
  perform ogevia.write_audit(p_organization_id, 'client.legal_name_set', 'clients', p_client_id,
    v_before, jsonb_build_object('legal_first_name', v_first, 'legal_last_name', v_last), null);
  perform ogevia.idempotency_finish('set_client_name', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('ok', true));
end;
$$;

revoke all on function ogevia_api.set_organization_logo(uuid, uuid, text, text, text, integer, text, uuid) from public;
revoke all on function ogevia_api.clear_organization_logo(uuid) from public;
revoke all on function ogevia_api.get_organization_logo(uuid) from public;
revoke all on function ogevia_api.list_client_directory(uuid) from public;
revoke all on function ogevia_api.set_client_legal_name(uuid, uuid, text, text, uuid) from public;
grant execute on function ogevia_api.set_organization_logo(uuid, uuid, text, text, text, integer, text, uuid) to ogevia_app;
grant execute on function ogevia_api.clear_organization_logo(uuid) to ogevia_app;
grant execute on function ogevia_api.get_organization_logo(uuid) to ogevia_app;
grant execute on function ogevia_api.list_client_directory(uuid) to ogevia_app;
grant execute on function ogevia_api.set_client_legal_name(uuid, uuid, text, text, uuid) to ogevia_app;
revoke all on function ogevia_api.get_my_profile() from public;
revoke all on function ogevia_api.set_my_display_name(text) from public;
revoke all on function ogevia_api.get_organization_branding(uuid) from public;
revoke all on function ogevia_api.set_organization_branding(uuid, text, text, uuid) from public;
revoke all on function ogevia_api.get_attention_summary(uuid, integer, integer) from public;
revoke all on function ogevia_api.get_utilisation_overview(uuid, date) from public;
revoke all on function ogevia.contrast_with_white(text) from public;
grant execute on function ogevia_api.get_my_profile() to ogevia_app;
grant execute on function ogevia_api.set_my_display_name(text) to ogevia_app;
grant execute on function ogevia_api.get_organization_branding(uuid) to ogevia_app;
grant execute on function ogevia_api.set_organization_branding(uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.get_attention_summary(uuid, integer, integer) to ogevia_app;
grant execute on function ogevia_api.get_utilisation_overview(uuid, date) to ogevia_app;
