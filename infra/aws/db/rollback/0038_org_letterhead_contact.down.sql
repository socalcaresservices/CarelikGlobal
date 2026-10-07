-- ROLLBACK 0038_org_letterhead_contact | CLASS: SAFE AUTOMATED (refuses if letterhead data exists)
-- Restores get_organization_branding exactly as 0020 defined it, drops set_organization_letterhead and
-- the seven columns. Refuses while any agency has a letterhead value stored: those values would be
-- lost. Export them first (they are also in the audit trail), clear them in Settings, then run again.
do $$ begin
  if exists (
    select 1 from ogevia.organizations
    where legal_name is not null or address_street is not null or address_city is not null or address_state is not null
       or address_zip is not null or contact_phone is not null or contact_email is not null
  ) then
    raise exception 'ROLLBACK REFUSED: agency letterhead details are stored; export or clear them first';
  end if;
end $$;
drop function ogevia_api.set_organization_letterhead(uuid, text, text, text, text, text, text, text, uuid);
drop function ogevia_api.get_organization_branding(uuid);
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
revoke all on function ogevia_api.get_organization_branding(uuid) from public;
grant execute on function ogevia_api.get_organization_branding(uuid) to ogevia_app;
alter table ogevia.organizations
  drop column legal_name, drop column address_street, drop column address_city, drop column address_state,
  drop column address_zip, drop column contact_phone, drop column contact_email;
