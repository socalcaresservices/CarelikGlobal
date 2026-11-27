-- 0114 (PENDING: infra/aws/db/pending, not in any release) | CLASS: ADDITIVE (one table, four functions). Not applied to any database. Depends on 0110/0111 (offices, office assignments).
-- Release Train 2, priority B: an office's look for sign-in invitation emails (accent colour, logo address, help address). Optional per office; an office without a row uses the
-- company look. The office name comes from the office itself. The logo is an https ADDRESS the agency hosts (the private evidence bucket is never exposed); no image is stored here.
--   * set_office_branding: agency Administrator only (organization.update), validated, audited (before/after).
--   * list_office_branding: the Administrator or a scheduler.
--   * get_invitation_look: used by the API while it sends a caregiver invitation or resend (caregivers.manage). Returns the look of the caregiver's PRIMARY office, or an empty object.
-- Rollback: pending/rollback/0114_office_branding.down.sql
create table ogevia.office_branding (
  office_id uuid primary key,
  organization_id uuid not null references ogevia.organizations(id),
  accent_color text check (accent_color is null or accent_color ~ '^#[0-9a-fA-F]{6}$'),
  logo_url text check (logo_url is null or (length(logo_url) <= 300 and logo_url ~ '^https://[^[:space:]"''<>{}]+$')),
  support_email text check (support_email is null or (length(support_email) <= 254 and support_email ~ '^[^[:space:]@<>"{}]+@[^[:space:]@<>"{}]+\.[^[:space:]@<>"{}]+$')),
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  foreign key (office_id, organization_id) references ogevia.offices (id, organization_id)
);
alter table ogevia.office_branding enable row level security;
revoke all on ogevia.office_branding from public;
grant select on ogevia.office_branding to ogevia_readonly;
create policy readonly_select on ogevia.office_branding for select to ogevia_readonly using (true);

create function ogevia_api.set_office_branding(p_organization_id uuid, p_office_id uuid, p_accent_color text, p_logo_url text, p_support_email text)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_color text := nullif(btrim(coalesce(p_accent_color, '')), '');
  v_logo text := nullif(btrim(coalesce(p_logo_url, '')), '');
  v_mail text := nullif(btrim(coalesce(p_support_email, '')), '');
  v_before jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'Only the agency Administrator can change an office''s invitation look' using errcode = 'OGA03'; end if;
  if not exists (select 1 from ogevia.offices o where o.id = p_office_id and o.organization_id = p_organization_id) then raise exception 'Office not found' using errcode = 'OGN04'; end if;
  if v_color is not null and v_color !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Colour must look like #0F5F66' using errcode = 'OGV22'; end if;
  if v_logo is not null and (length(v_logo) > 300 or v_logo !~ '^https://[^[:space:]"''<>{}]+$') then raise exception 'The logo must be an https address' using errcode = 'OGV22'; end if;
  if v_mail is not null and (length(v_mail) > 254 or v_mail !~ '^[^[:space:]@<>"{}]+@[^[:space:]@<>"{}]+\.[^[:space:]@<>"{}]+$') then raise exception 'Enter a valid help email address' using errcode = 'OGV22'; end if;
  select jsonb_build_object('accentColor', b.accent_color, 'logoUrl', b.logo_url, 'supportEmail', b.support_email) into v_before from ogevia.office_branding b where b.office_id = p_office_id;
  if v_color is null and v_logo is null and v_mail is null then
    delete from ogevia.office_branding where office_id = p_office_id;
  else
    insert into ogevia.office_branding (office_id, organization_id, accent_color, logo_url, support_email, updated_by) values (p_office_id, p_organization_id, v_color, v_logo, v_mail, v_actor)
    on conflict (office_id) do update set accent_color = excluded.accent_color, logo_url = excluded.logo_url, support_email = excluded.support_email, updated_by = v_actor, updated_at = now();
  end if;
  perform ogevia.write_audit(p_organization_id, 'office_branding.changed', 'offices', p_office_id, v_before, jsonb_build_object('accentColor', v_color, 'logoUrl', v_logo, 'supportEmail', v_mail), null);
  return jsonb_build_object('accentColor', v_color, 'logoUrl', v_logo, 'supportEmail', v_mail);
end;
$$;

create function ogevia_api.list_office_branding(p_organization_id uuid)
returns table (office_id uuid, office_name text, accent_color text, logo_url text, support_email text)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'organization.update') or ogevia.has_permission(p_organization_id, 'shifts.manage')) then raise exception 'Not allowed' using errcode = 'OGA03'; end if;
  return query select o.id, o.name::text, b.accent_color::text, b.logo_url::text, b.support_email::text
    from ogevia.offices o left join ogevia.office_branding b on b.office_id = o.id where o.organization_id = p_organization_id and o.is_active order by lower(o.name);
end;
$$;

create function ogevia_api.get_invitation_look(p_organization_id uuid, p_caregiver_record_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v_look jsonb;
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) or not ogevia.has_permission(p_organization_id, 'caregivers.manage') then raise exception 'Not allowed' using errcode = 'OGA03'; end if;
  select jsonb_strip_nulls(jsonb_build_object('officeName', o.name, 'officeColor', b.accent_color, 'officeLogoUrl', b.logo_url, 'officeSupportEmail', b.support_email)) into v_look
    from ogevia.office_assignments a join ogevia.offices o on o.id = a.office_id and o.is_active left join ogevia.office_branding b on b.office_id = o.id
   where a.organization_id = p_organization_id and a.caregiver_record_id = p_caregiver_record_id and a.is_primary;
  return coalesce(v_look, '{}'::jsonb);
end;
$$;

revoke all on function ogevia_api.set_office_branding(uuid, uuid, text, text, text) from public;
revoke all on function ogevia_api.list_office_branding(uuid) from public;
revoke all on function ogevia_api.get_invitation_look(uuid, uuid) from public;
grant execute on function ogevia_api.set_office_branding(uuid, uuid, text, text, text) to ogevia_app;
grant execute on function ogevia_api.list_office_branding(uuid) to ogevia_app;
grant execute on function ogevia_api.get_invitation_look(uuid, uuid) to ogevia_app;
