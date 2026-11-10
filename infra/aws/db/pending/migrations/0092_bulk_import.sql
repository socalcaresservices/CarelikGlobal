-- 0092 (PENDING: infra/aws/db/pending, not in the released set) | CLASS: ADDITIVE (one table, one function). Not applied to any database.
-- R11 bulk import of people (caregivers and other staff) and clients from a CSV/XLSX file that the API has already parsed into rows.
--   * One call = one transaction: either every new row is created or none is.
--   * Tenant comes from the session (the guards below), never from the file. Every row is created through the EXISTING creation functions
--     (create_caregiver, create_staff, create_client), so their rules, ids, client codes and audit events apply unchanged.
--   * PREVIEW (confirm = false) writes nothing. CONFIRM refuses a file that still has invalid rows; duplicates are skipped, never merged.
--   * Re-uploading the same file (same SHA-256) creates nothing: the first import is returned.
--   * No invitation is sent and no sign-in is created. No billing, authorization or schedule state is touched.
--   * One audit event per import holds the file hash and counts only (no names).
-- Rollback: pending/rollback/0092_bulk_import.down.sql
create table ogevia.import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  kind text not null check (kind in ('people', 'clients')),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name text check (file_name is null or length(file_name) <= 200),
  row_count integer not null check (row_count between 1 and 2000),
  created_count integer not null check (created_count >= 0),
  duplicate_count integer not null check (duplicate_count >= 0),
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  constraint import_batches_one_per_file unique (organization_id, kind, file_sha256)
);
alter table ogevia.import_batches enable row level security;
create trigger import_batches_append_only before update or delete on ogevia.import_batches
for each row execute function ogevia.append_only_guard();
grant select on table ogevia.import_batches to ogevia_readonly;
create policy readonly_select on ogevia.import_batches for select to ogevia_readonly using (true);

create function ogevia_api.import_rows(p_organization_id uuid, p_kind text, p_rows jsonb, p_file_sha256 text, p_file_name text, p_confirm boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_n integer; v_i integer; r jsonb;
  v_first text; v_last text; v_type text; v_email text; v_phone text; v_city text;
  v_status text; v_msg text; v_staff_type uuid; v_client_type uuid; v_key text;
  v_seen text[] := '{}'; v_out jsonb := '[]'::jsonb; v_plan jsonb[] := '{}';
  v_new integer := 0; v_dup integer := 0; v_bad integer := 0; v_created integer := 0;
  v_prior ogevia.import_batches%rowtype; v_batch uuid; v_any_caregiver boolean := false; v_any_staff boolean := false;
  v_name_re constant text := '^[[:alpha:]][[:alpha:] .''’-]*$';
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if p_kind not in ('people', 'clients') then raise exception 'Unknown import type' using errcode = 'OGV22'; end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'File fingerprint missing' using errcode = 'OGV22'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'The file has no rows' using errcode = 'OGV22'; end if;
  v_n := jsonb_array_length(p_rows);
  if v_n < 1 then raise exception 'The file has no data rows' using errcode = 'OGV22'; end if;
  if v_n > 2000 then raise exception 'The file has more than 2,000 rows. Split it and import the parts.' using errcode = 'OGV22'; end if;
  -- Permission first, from the session (the existing guards): a person who cannot create these records cannot even preview them.
  if p_kind = 'clients' then perform ogevia.client_admin_guard(p_organization_id);
  else perform ogevia.staff_guard(p_organization_id, true); end if;

  perform pg_advisory_xact_lock(hashtextextended('import|' || p_organization_id::text || '|' || p_kind, 0));
  select * into v_prior from ogevia.import_batches b where b.organization_id = p_organization_id and b.kind = p_kind and b.file_sha256 = p_file_sha256;
  if v_prior.id is not null then
    return jsonb_build_object('mode', 'already_imported', 'kind', p_kind, 'fileSha256', p_file_sha256, 'importedAt', v_prior.created_at,
                              'counts', jsonb_build_object('total', v_prior.row_count, 'new', 0, 'duplicate', 0, 'invalid', 0),
                              'created', v_prior.created_count, 'rows', '[]'::jsonb);
  end if;

  for v_i in 0 .. v_n - 1 loop
    r := p_rows -> v_i;
    v_status := 'new'; v_msg := null; v_staff_type := null; v_client_type := null; v_email := null; v_phone := null; v_type := 'caregiver';
    if jsonb_typeof(r) <> 'object' then v_status := 'invalid'; v_msg := 'Row could not be read';
    else
      v_first := regexp_replace(btrim(coalesce(r ->> 'first_name', '')), '\s+', ' ', 'g');
      v_last := regexp_replace(btrim(coalesce(r ->> 'last_name', '')), '\s+', ' ', 'g');
      v_city := nullif(regexp_replace(btrim(coalesce(r ->> 'city', '')), '\s+', ' ', 'g'), '');
      if length(v_first) < 1 or length(v_last) < 1 then v_status := 'invalid'; v_msg := 'First name and last name are required';
      elsif length(v_first) > 60 or length(v_last) > 60 or v_first !~ v_name_re or v_last !~ v_name_re then v_status := 'invalid'; v_msg := 'Name has characters that are not allowed or is too long';
      elsif v_city is not null and length(v_city) > 80 then v_status := 'invalid'; v_msg := 'City is too long';
      end if;
    end if;

    if v_status = 'new' and p_kind = 'people' then
      v_type := lower(btrim(coalesce(r ->> 'type', 'caregiver')));
      if v_type = '' then v_type := 'caregiver'; end if;
      if v_type = 'caregiver' then
        v_any_caregiver := true;
        if exists (select 1 from ogevia.caregiver_records c where c.organization_id = p_organization_id and c.deleted_at is null and lower(c.first_name) = lower(v_first) and lower(c.last_name) = lower(v_last))
           or ('cg|' || lower(v_first) || '|' || lower(v_last)) = any (v_seen) then
          v_status := 'duplicate'; v_msg := 'A caregiver with this name already exists or is repeated in the file';
        else v_seen := v_seen || ('cg|' || lower(v_first) || '|' || lower(v_last)); end if;
      else
        v_any_staff := true;
        select t.id into v_staff_type from ogevia.staff_types t where t.organization_id = p_organization_id and t.is_active and lower(t.name) = v_type;
        if v_staff_type is null then v_status := 'invalid'; v_msg := 'Type must be Caregiver or one of your active staff types';
        else
          begin
            select * into v_email, v_phone from ogevia.staff_validate_contact(nullif(btrim(coalesce(r ->> 'email', '')), ''), nullif(btrim(coalesce(r ->> 'phone', '')), ''));
          exception when others then v_status := 'invalid'; v_msg := 'Email or phone is not valid';
          end;
          if v_status = 'new' and (
               (v_email is not null and (exists (select 1 from ogevia.staff_profiles p where p.organization_id = p_organization_id and p.contact_email = v_email) or ('em|' || v_email) = any (v_seen)))
            or (length(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g')) >= 7 and (exists (select 1 from ogevia.staff_profiles p where p.organization_id = p_organization_id and regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g')) or ('ph|' || regexp_replace(v_phone, '\D', '', 'g')) = any (v_seen)))) then
            v_status := 'duplicate'; v_msg := 'A staff member with this email or phone already exists or is repeated in the file';
          elsif v_status = 'new' then
            if v_email is not null then v_seen := v_seen || ('em|' || v_email); end if;
            if length(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g')) >= 7 then v_seen := v_seen || ('ph|' || regexp_replace(v_phone, '\D', '', 'g')); end if;
          end if;
        end if;
      end if;
    elsif v_status = 'new' and p_kind = 'clients' then
      if nullif(btrim(coalesce(r ->> 'client_type', '')), '') is not null then
        select t.id into v_client_type from ogevia.client_types t where t.organization_id = p_organization_id and t.is_active and lower(btrim(t.name)) = lower(btrim(r ->> 'client_type'));
        if v_client_type is null then v_status := 'invalid'; v_msg := 'Client type is not one of your active client types'; end if;
      end if;
      if v_status = 'new' then
        v_key := 'cl|' || lower(v_first) || '|' || lower(v_last) || '|' || lower(coalesce(v_city, ''));
        if exists (select 1 from ogevia.clients c join ogevia.client_private_names n on n.client_id = c.id
                    where c.organization_id = p_organization_id and c.deleted_at is null and lower(n.legal_first_name) = lower(v_first) and lower(n.legal_last_name) = lower(v_last)
                      and lower(coalesce(c.city, '')) = lower(coalesce(v_city, '')))
           or v_key = any (v_seen) then
          v_status := 'duplicate'; v_msg := 'A client with this name and city already exists or is repeated in the file';
        else v_seen := v_seen || v_key; end if;
      end if;
    end if;

    if v_status = 'new' then v_new := v_new + 1; v_plan := v_plan || jsonb_build_object('i', v_i, 'first', v_first, 'last', v_last, 'type', v_type, 'staff_type', v_staff_type,
                                                                                         'client_type', v_client_type, 'email', v_email, 'phone', v_phone, 'city', v_city);
    elsif v_status = 'duplicate' then v_dup := v_dup + 1;
    else v_bad := v_bad + 1; end if;
    if v_status <> 'new' and jsonb_array_length(v_out) < 200 then
      v_out := v_out || jsonb_build_object('row', coalesce(nullif(r ->> '_row', '')::integer, v_i + 1), 'status', v_status, 'message', v_msg);
    end if;
  end loop;

  if not p_confirm then
    return jsonb_build_object('mode', 'preview', 'kind', p_kind, 'fileSha256', p_file_sha256, 'created', 0,
                              'counts', jsonb_build_object('total', v_n, 'new', v_new, 'duplicate', v_dup, 'invalid', v_bad), 'rows', v_out);
  end if;
  if v_bad > 0 then raise exception 'The file still has % invalid row(s). Fix them and upload again; nothing was imported.', v_bad using errcode = 'OGV22'; end if;

  -- Same permission the single-record screens require, for the kinds of row that are present.
  if v_any_caregiver then perform ogevia.caregiver_admin_guard(p_organization_id); end if;
  for v_i in 1 .. coalesce(array_length(v_plan, 1), 0) loop
    r := v_plan[v_i];
    v_key := md5(p_file_sha256 || '|' || p_kind || '|' || (r ->> 'i'));
    if p_kind = 'clients' then
      perform ogevia_api.create_client(p_organization_id, r ->> 'first', r ->> 'last', r ->> 'city', nullif(r ->> 'client_type', '')::uuid, null, v_key::uuid);
    elsif r ->> 'type' = 'caregiver' then
      perform ogevia_api.create_caregiver(p_organization_id, r ->> 'first', r ->> 'last', null, 'onboarding', v_key::uuid);
    else
      perform ogevia_api.create_staff(p_organization_id, (r ->> 'first') || ' ' || (r ->> 'last'), (r ->> 'staff_type')::uuid, r ->> 'email', r ->> 'phone');
    end if;
    v_created := v_created + 1;
  end loop;
  insert into ogevia.import_batches (organization_id, kind, file_sha256, file_name, row_count, created_count, duplicate_count, created_by)
  values (p_organization_id, p_kind, p_file_sha256, left(p_file_name, 200), v_n, v_created, v_dup, v_actor) returning id into v_batch;
  perform ogevia.write_audit(p_organization_id, 'import.applied', 'import_batches', v_batch, null,
    jsonb_build_object('kind', p_kind, 'file_sha256', p_file_sha256, 'rows', v_n, 'created', v_created, 'duplicates_skipped', v_dup), null);
  return jsonb_build_object('mode', 'applied', 'kind', p_kind, 'fileSha256', p_file_sha256, 'created', v_created,
                            'counts', jsonb_build_object('total', v_n, 'new', v_new, 'duplicate', v_dup, 'invalid', 0), 'rows', v_out);
end;
$$;
revoke all on function ogevia_api.import_rows(uuid, text, jsonb, text, text, boolean) from public;
grant execute on function ogevia_api.import_rows(uuid, text, jsonb, text, text, boolean) to ogevia_app;
