-- 0115 (PENDING: infra/aws/db/pending, not in any release) | CLASS: ADDITIVE (two tables, three functions; import_rows is REPLACED by a copy that also records what it created).
-- Release Train 2, priority C: bulk import history and rollback. Depends on 0105 (import_batches, import_rows) and 0086 (staff).
--   * import_batch_records: which records each applied import created (append-only). Imports applied BEFORE this migration have no records and cannot be rolled back
--     (history still lists them).
--   * list_import_batches: the import history (who, when, file name, counts, rolled back?). Counts and names only, no row content.
--   * rollback_import_batch: undoes ONE import, all or nothing, and only while every record it created is untouched (no shift, visit, authorization, assignment, sign-in or
--     invitation; status unchanged). It does not delete: caregivers and clients are set Inactive and staff Inactive through the existing functions (reasons and audit apply),
--     the rollback is recorded once (append-only) and a repeat is a no-op. A record that has activity makes the whole rollback refuse and names the counts.
--   * import_rows: same behaviour as 0105 (copied unchanged) plus the records above.
-- Rollback: pending/rollback/0115_import_history_rollback.down.sql (restores the 0105 function and drops the new tables).
create table ogevia.import_batch_records (
  batch_id uuid not null references ogevia.import_batches(id),
  organization_id uuid not null references ogevia.organizations(id),
  entity_type text not null check (entity_type in ('caregiver', 'staff', 'client')),
  entity_id uuid not null,
  primary key (batch_id, entity_type, entity_id)
);
create index import_batch_records_entity_idx on ogevia.import_batch_records (entity_type, entity_id);
alter table ogevia.import_batch_records enable row level security;
revoke all on ogevia.import_batch_records from public;
create trigger import_batch_records_append_only before update or delete on ogevia.import_batch_records for each row execute function ogevia.append_only_guard();
grant select on ogevia.import_batch_records to ogevia_readonly;
create policy readonly_select on ogevia.import_batch_records for select to ogevia_readonly using (true);

create table ogevia.import_batch_rollbacks (
  batch_id uuid primary key references ogevia.import_batches(id),
  organization_id uuid not null references ogevia.organizations(id),
  rolled_back_by uuid not null references ogevia.app_users(id),
  rolled_back_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  records integer not null check (records >= 0)
);
alter table ogevia.import_batch_rollbacks enable row level security;
revoke all on ogevia.import_batch_rollbacks from public;
create trigger import_batch_rollbacks_append_only before update or delete on ogevia.import_batch_rollbacks for each row execute function ogevia.append_only_guard();
grant select on ogevia.import_batch_rollbacks to ogevia_readonly;
create policy readonly_select on ogevia.import_batch_rollbacks for select to ogevia_readonly using (true);

create or replace function ogevia_api.import_rows(p_organization_id uuid, p_kind text, p_rows jsonb, p_file_sha256 text, p_file_name text, p_confirm boolean)
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
  v_ids uuid[] := '{}'; v_types text[] := '{}'; v_id uuid; v_etype text;
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
        -- Caregiver rows need the caregiver permission from the PREVIEW on: a preview must not tell someone who cannot manage caregivers whether a caregiver name exists.
        if not v_any_caregiver then perform ogevia.caregiver_admin_guard(p_organization_id); end if;
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
      select c.client_id into v_id from ogevia_api.create_client(p_organization_id, r ->> 'first', r ->> 'last', r ->> 'city', nullif(r ->> 'client_type', '')::uuid, null, v_key::uuid) c; v_etype := 'client';
    elsif r ->> 'type' = 'caregiver' then
      select c.caregiver_record_id into v_id from ogevia_api.create_caregiver(p_organization_id, r ->> 'first', r ->> 'last', null, 'onboarding', v_key::uuid) c; v_etype := 'caregiver';
    else
      v_id := ogevia_api.create_staff(p_organization_id, (r ->> 'first') || ' ' || (r ->> 'last'), (r ->> 'staff_type')::uuid, r ->> 'email', r ->> 'phone'); v_etype := 'staff';
    end if;
    v_created := v_created + 1;
    v_ids := v_ids || v_id; v_types := v_types || v_etype;
  end loop;
  insert into ogevia.import_batches (organization_id, kind, file_sha256, file_name, row_count, created_count, duplicate_count, created_by)
  values (p_organization_id, p_kind, p_file_sha256, left(p_file_name, 200), v_n, v_created, v_dup, v_actor) returning id into v_batch;
  insert into ogevia.import_batch_records (batch_id, organization_id, entity_type, entity_id) select v_batch, p_organization_id, t.et, t.id from unnest(v_types, v_ids) as t(et, id);
  perform ogevia.write_audit(p_organization_id, 'import.applied', 'import_batches', v_batch, null,
    jsonb_build_object('kind', p_kind, 'file_sha256', p_file_sha256, 'rows', v_n, 'created', v_created, 'duplicates_skipped', v_dup), null);
  return jsonb_build_object('mode', 'applied', 'kind', p_kind, 'fileSha256', p_file_sha256, 'created', v_created,
                            'counts', jsonb_build_object('total', v_n, 'new', v_new, 'duplicate', v_dup, 'invalid', 0), 'rows', v_out);
end;
$$;
revoke all on function ogevia_api.import_rows(uuid, text, jsonb, text, text, boolean) from public;
grant execute on function ogevia_api.import_rows(uuid, text, jsonb, text, text, boolean) to ogevia_app;

create function ogevia_api.list_import_batches(p_organization_id uuid, p_limit integer default 50)
returns table (batch_id uuid, kind text, file_name text, row_count integer, created_count integer, duplicate_count integer, created_at timestamptz, created_by_name text,
               can_roll_back boolean, rolled_back_at timestamptz, rolled_back_reason text)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'organization.update') or ogevia.has_permission(p_organization_id, 'staff.manage') or ogevia.has_permission(p_organization_id, 'clients.manage')) then
    raise exception 'Not allowed' using errcode = 'OGA03';
  end if;
  p_limit := greatest(1, least(coalesce(p_limit, 50), 200));
  return query
    select b.id, b.kind::text, b.file_name::text, b.row_count, b.created_count, b.duplicate_count, b.created_at, u.display_name::text,
           (r.batch_id is null and exists (select 1 from ogevia.import_batch_records x where x.batch_id = b.id)), r.rolled_back_at, r.reason::text
    from ogevia.import_batches b
    left join ogevia.app_users u on u.id = b.created_by
    left join ogevia.import_batch_rollbacks r on r.batch_id = b.id
    where b.organization_id = p_organization_id order by b.created_at desc, b.id limit p_limit;
end;
$$;

create function ogevia_api.rollback_import_batch(p_organization_id uuid, p_batch_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_b ogevia.import_batches%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_rec record; v_blocked integer := 0; v_n integer := 0; v_ok boolean;
  v_blocked_by jsonb := '{}'::jsonb; v_staff ogevia.staff_profiles%rowtype;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if length(v_reason) < 3 then raise exception 'A reason is required' using errcode = 'OGV22'; end if;
  perform pg_advisory_xact_lock(hashtextextended('import_rollback|' || p_batch_id::text, 0));
  select * into v_b from ogevia.import_batches where id = p_batch_id and organization_id = p_organization_id;
  if v_b.id is null then raise exception 'Import not found' using errcode = 'OGN04'; end if;
  -- the same permission that created the records
  if v_b.kind = 'clients' then perform ogevia.client_admin_guard(p_organization_id); else perform ogevia.staff_guard(p_organization_id, true); end if;
  if exists (select 1 from ogevia.import_batch_rollbacks r where r.batch_id = p_batch_id) then return jsonb_build_object('state', 'already_rolled_back'); end if;
  if not exists (select 1 from ogevia.import_batch_records x where x.batch_id = p_batch_id) then
    raise exception 'This import was made before rollback was available and cannot be rolled back' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.import_batch_records x where x.batch_id = p_batch_id and x.entity_type = 'caregiver') then perform ogevia.caregiver_admin_guard(p_organization_id); end if;

  -- Check EVERY record first: nothing is changed unless all of them are untouched.
  for v_rec in select x.entity_type, x.entity_id from ogevia.import_batch_records x where x.batch_id = p_batch_id loop
    v_ok := case v_rec.entity_type
      when 'client' then exists (select 1 from ogevia.clients c where c.id = v_rec.entity_id and c.deleted_at is null and c.status = 'active')
                      and not exists (select 1 from ogevia.shifts s where s.client_id = v_rec.entity_id)
                      and not exists (select 1 from ogevia.service_visits v where v.client_id = v_rec.entity_id)
                      and not exists (select 1 from ogevia.client_authorizations a where a.client_id = v_rec.entity_id)
                      and not exists (select 1 from ogevia.caregiver_assignments ca where ca.client_id = v_rec.entity_id)
      when 'caregiver' then exists (select 1 from ogevia.caregiver_records c where c.id = v_rec.entity_id and c.deleted_at is null and c.status = 'onboarding' and c.linked_user_id is null)
                      and not exists (select 1 from ogevia.shifts s where s.caregiver_record_id = v_rec.entity_id)
                      and not exists (select 1 from ogevia.caregiver_invitations i where i.caregiver_record_id = v_rec.entity_id)
      else exists (select 1 from ogevia.staff_profiles p where p.id = v_rec.entity_id and p.status = 'active' and p.user_id is null and p.invited_at is null)
    end;
    if not v_ok then v_blocked := v_blocked + 1; v_blocked_by := jsonb_set(v_blocked_by, array[v_rec.entity_type], to_jsonb(coalesce((v_blocked_by ->> v_rec.entity_type)::integer, 0) + 1)); end if;
  end loop;
  if v_blocked > 0 then
    raise exception 'Cannot roll back: % imported record(s) already have activity or were changed (%). Nothing was changed.', v_blocked, v_blocked_by::text using errcode = 'OGC09';
  end if;

  for v_rec in select x.entity_type, x.entity_id from ogevia.import_batch_records x where x.batch_id = p_batch_id order by x.entity_type, x.entity_id loop
    if v_rec.entity_type = 'client' then perform ogevia_api.set_client_status(p_organization_id, v_rec.entity_id, 'inactive', 'Import rolled back: ' || v_reason);
    elsif v_rec.entity_type = 'caregiver' then perform ogevia_api.set_caregiver_status(p_organization_id, v_rec.entity_id, 'inactive', 'Import rolled back: ' || v_reason);
    else
      select * into v_staff from ogevia.staff_profiles where id = v_rec.entity_id;
      perform ogevia_api.update_staff(p_organization_id, v_staff.id, v_staff.display_name, v_staff.staff_type_id, v_staff.contact_email, v_staff.phone, 'inactive');
    end if;
    v_n := v_n + 1;
  end loop;
  insert into ogevia.import_batch_rollbacks (batch_id, organization_id, rolled_back_by, reason, records) values (p_batch_id, p_organization_id, v_actor, v_reason, v_n);
  perform ogevia.write_audit(p_organization_id, 'import.rolled_back', 'import_batches', p_batch_id, null, jsonb_build_object('kind', v_b.kind, 'records', v_n), v_reason);
  return jsonb_build_object('state', 'rolled_back', 'records', v_n);
end;
$$;

revoke all on function ogevia_api.list_import_batches(uuid, integer) from public;
revoke all on function ogevia_api.rollback_import_batch(uuid, uuid, text) from public;
grant execute on function ogevia_api.list_import_batches(uuid, integer) to ogevia_app;
grant execute on function ogevia_api.rollback_import_batch(uuid, uuid, text) to ogevia_app;
