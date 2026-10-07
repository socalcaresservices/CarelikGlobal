-- 0038 Agency letterhead details for printed reports.
--
-- Before this migration (verified in the repository, 2026-10-06): the AWS web
-- build printed the agency logo and name only. The print header is built to show
-- a legal name, a street address and a phone and email, but the AWS database had
-- nowhere to store them, so getLetterhead() returned nulls.
--
-- After: seven OPTIONAL columns on the agency (legal name, street, city, state,
-- ZIP, phone, email) that the agency's own Administrator enters. Nothing is
-- pre-filled and no agency's details are built into the product. They are agency
-- business contact details only, never client or caregiver information.
--   * get_organization_branding also returns them. Any active member of the
--     agency can read them (the print header needs them); nobody outside the
--     agency can.
--   * set_organization_letterhead saves them. It requires organization.update (the
--     same role that edits branding), is idempotent, and records an audit row
--     with the before and after values. A blank value clears a field.
--   * The existing set_organization_branding function and its signature are not
--     changed.

alter table ogevia.organizations
  add column legal_name text check (legal_name is null or length(legal_name) between 2 and 120),
  add column address_street text check (address_street is null or length(address_street) between 2 and 120),
  add column address_city text check (address_city is null or length(address_city) between 2 and 80),
  add column address_state text check (address_state is null or address_state ~ '^[A-Z]{2}$'),
  add column address_zip text check (address_zip is null or address_zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
  add column contact_phone text check (contact_phone is null or (length(contact_phone) between 7 and 25 and contact_phone ~ '^[0-9+(). -]+$')),
  add column contact_email text check (contact_email is null or (length(contact_email) <= 254 and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

drop function ogevia_api.get_organization_branding(uuid);
create function ogevia_api.get_organization_branding(p_organization_id uuid)
returns table (
  organization_id uuid, display_name text, accent_color text, logo_sha256 text,
  legal_name text, address_street text, address_city text, address_state text, address_zip text,
  contact_phone text, contact_email text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select o.id, o.display_name, o.accent_color, o.logo_sha256,
         o.legal_name, o.address_street, o.address_city, o.address_state, o.address_zip,
         o.contact_phone, o.contact_email
  from ogevia.organizations o
  where o.id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id);
$$;

create function ogevia_api.set_organization_letterhead(
  p_organization_id uuid,
  p_legal_name text,
  p_address_street text,
  p_address_city text,
  p_address_state text,
  p_address_zip text,
  p_contact_phone text,
  p_contact_email text,
  p_idempotency_key uuid default null
)
returns table (
  organization_id uuid, legal_name text, address_street text, address_city text, address_state text,
  address_zip text, contact_phone text, contact_email text
)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_legal text := nullif(btrim(coalesce(p_legal_name, '')), '');
  v_street text := nullif(btrim(coalesce(p_address_street, '')), '');
  v_city text := nullif(btrim(coalesce(p_address_city, '')), '');
  v_state text := upper(nullif(btrim(coalesce(p_address_state, '')), ''));
  v_zip text := nullif(btrim(coalesce(p_address_zip, '')), '');
  v_phone text := nullif(btrim(coalesce(p_contact_phone, '')), '');
  v_email text := lower(nullif(btrim(coalesce(p_contact_email, '')), ''));
  v_fingerprint text;
  v_prior jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then
    raise exception 'Only the agency Administrator can change the print letterhead' using errcode = 'OGA03';
  end if;
  v_fingerprint := concat_ws('|', p_organization_id, coalesce(v_legal, '-'), coalesce(v_street, '-'), coalesce(v_city, '-'),
    coalesce(v_state, '-'), coalesce(v_zip, '-'), coalesce(v_phone, '-'), coalesce(v_email, '-'));
  v_prior := ogevia.idempotency_begin('set_letterhead', p_idempotency_key, p_organization_id, v_fingerprint);
  if v_prior is null then
    if v_legal is not null and length(v_legal) not between 2 and 120 then
      raise exception 'Legal name must be between 2 and 120 characters' using errcode = 'OGV22';
    end if;
    if v_street is not null and length(v_street) not between 2 and 120 then
      raise exception 'Street address must be between 2 and 120 characters' using errcode = 'OGV22';
    end if;
    if v_city is not null and length(v_city) not between 2 and 80 then
      raise exception 'City must be between 2 and 80 characters' using errcode = 'OGV22';
    end if;
    if v_state is not null and v_state !~ '^[A-Z]{2}$' then
      raise exception 'State must be two letters, for example CA' using errcode = 'OGV22';
    end if;
    if v_zip is not null and v_zip !~ '^[0-9]{5}(-[0-9]{4})?$' then
      raise exception 'ZIP code must be 5 digits, or 5 digits, a dash and 4 digits' using errcode = 'OGV22';
    end if;
    if v_phone is not null and (length(v_phone) not between 7 and 25 or v_phone !~ '^[0-9+(). -]+$') then
      raise exception 'Phone may contain digits, spaces and + ( ) . - only, 7 to 25 characters' using errcode = 'OGV22';
    end if;
    if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
      raise exception 'Enter a valid email address' using errcode = 'OGV22';
    end if;
    select jsonb_build_object('legal_name', o.legal_name, 'address_street', o.address_street, 'address_city', o.address_city,
             'address_state', o.address_state, 'address_zip', o.address_zip, 'contact_phone', o.contact_phone, 'contact_email', o.contact_email)
      into v_before from ogevia.organizations o where o.id = p_organization_id for update;
    update ogevia.organizations o
       set legal_name = v_legal, address_street = v_street, address_city = v_city, address_state = v_state,
           address_zip = v_zip, contact_phone = v_phone, contact_email = v_email, updated_at = now()
     where o.id = p_organization_id;
    v_after := jsonb_build_object('legal_name', v_legal, 'address_street', v_street, 'address_city', v_city,
             'address_state', v_state, 'address_zip', v_zip, 'contact_phone', v_phone, 'contact_email', v_email);
    perform ogevia.write_audit(p_organization_id, 'organization.letterhead_updated', 'organizations', p_organization_id,
      v_before, v_after, null);
    perform ogevia.idempotency_finish('set_letterhead', p_idempotency_key, p_organization_id, v_fingerprint, v_after);
  end if;
  return query select o.id, o.legal_name, o.address_street, o.address_city, o.address_state, o.address_zip, o.contact_phone, o.contact_email
    from ogevia.organizations o where o.id = p_organization_id;
end;
$$;

revoke all on function ogevia_api.get_organization_branding(uuid) from public;
revoke all on function ogevia_api.set_organization_letterhead(uuid, text, text, text, text, text, text, text, uuid) from public;
grant execute on function ogevia_api.get_organization_branding(uuid) to ogevia_app;
grant execute on function ogevia_api.set_organization_letterhead(uuid, text, text, text, text, text, text, text, uuid) to ogevia_app;
