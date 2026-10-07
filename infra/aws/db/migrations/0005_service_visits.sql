-- 0005 - Service visits, confirmations, evidence metadata, corrections,
-- audit events, idempotency records.

-- Status vocabularies VERIFIED unchanged on current main (no ALTER TYPE since
-- 20260809042943_service_verification.sql).
create type ogevia.service_visit_status as enum (
  'draft', 'awaiting_signature', 'signed', 'administrator_review', 'corrected', 'voided'
);
create type ogevia.visit_authorization_status as enum (
  'within_authorization', 'limit_reached', 'exceeds_authorization', 'administrator_override'
);
create type ogevia.visit_signer_role as enum (
  'client', 'parent', 'guardian', 'authorized_representative'
);

create table ogevia.service_visits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  client_code_snapshot text not null,
  caregiver_user_id uuid references ogevia.app_users(id),
  caregiver_record_id uuid,
  caregiver_name_snapshot text not null,
  scheduled_shift_id uuid references ogevia.shifts(id),
  service_authorization_id uuid not null,
  service_id uuid not null,
  service_date date not null,
  -- Server timestamps only. No API function accepts time_in/time_out from a
  -- caller (managers' corrections create a NEW row; see correct_service_visit).
  time_in timestamptz not null,
  time_out timestamptz,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  task_categories text[] not null default '{}',
  service_notes text,
  caregiver_attested_at timestamptz,
  status ogevia.service_visit_status not null default 'draft',
  authorization_status ogevia.visit_authorization_status,
  signed_at timestamptz,
  locked_at timestamptz,
  original_visit_id uuid references ogevia.service_visits(id),
  correction_reason text,
  voided_at timestamptz,
  voided_by uuid references ogevia.app_users(id),
  void_reason text,
  visit_number_snapshot text not null,
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id),
  foreign key (service_authorization_id, organization_id)
    references ogevia.client_authorizations (id, organization_id),
  foreign key (caregiver_record_id, organization_id)
    references ogevia.caregiver_records (id, organization_id),
  constraint service_visits_caregiver_present
    check (caregiver_user_id is not null or caregiver_record_id is not null),
  constraint service_visits_time_check check (time_out is null or time_out > time_in),
  constraint service_visits_worked_range check (worked_minutes is null or worked_minutes between 1 and 1440),
  constraint service_visits_minutes_nonnegative check (
    (verified_minutes is null or verified_minutes >= 0)
    and (billable_minutes is null or billable_minutes >= 0)
  ),
  constraint service_visits_billable_le_worked check (
    billable_minutes is null or worked_minutes is null or billable_minutes <= worked_minutes
  ),
  constraint service_visits_draft_shape check (
    status <> 'draft' or (time_out is null and worked_minutes is null and signed_at is null)
  ),
  constraint service_visits_ended_shape check (
    status in ('draft', 'voided') or (time_out is not null and worked_minutes is not null)
  ),
  constraint service_visits_locked_shape check (
    status not in ('signed', 'administrator_review', 'corrected')
    or (verified_minutes is not null and billable_minutes is not null
        and authorization_status is not null and signed_at is not null and locked_at is not null)
  ),
  constraint service_visits_voided_shape check (
    status <> 'voided' or (voided_at is not null and voided_by is not null
                           and length(btrim(coalesce(void_reason, ''))) > 0)
  ),
  constraint service_visits_correction_shape check (
    original_visit_id is null or length(btrim(coalesce(correction_reason, ''))) > 0
  )
);

-- One open visit per caregiver (login or Care Team record), org-wide,
-- enforced by the database (current main v3 indexes).
create unique index service_visits_one_open_per_caregiver_user
  on ogevia.service_visits (caregiver_user_id)
  where caregiver_user_id is not null and status in ('draft', 'awaiting_signature');
create unique index service_visits_one_open_per_caregiver_record
  on ogevia.service_visits (caregiver_record_id)
  where caregiver_record_id is not null and status in ('draft', 'awaiting_signature');
-- One live visit per scheduled shift.
create unique index service_visits_shift_unique
  on ogevia.service_visits (scheduled_shift_id)
  where scheduled_shift_id is not null and status not in ('voided', 'corrected');
create index service_visits_org_date_idx on ogevia.service_visits (organization_id, service_date desc);
create index service_visits_org_status_idx on ogevia.service_visits (organization_id, status);
create index service_visits_caregiver_date_idx on ogevia.service_visits (caregiver_user_id, service_date desc);
create index service_visits_authorization_date_idx
  on ogevia.service_visits (service_authorization_id, service_date)
  where status in ('signed', 'administrator_review');
create index service_visits_client_idx on ogevia.service_visits (client_id);
create index service_visits_original_idx on ogevia.service_visits (original_visit_id)
  where original_visit_id is not null;

-- Lifecycle + immutability guard. Applies to EVERY role, including the owner.
create function ogevia.service_visits_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare
  immutable_cols text[] := array[
    'id', 'organization_id', 'client_id', 'client_code_snapshot', 'caregiver_user_id',
    'caregiver_record_id', 'caregiver_name_snapshot', 'scheduled_shift_id', 'service_id',
    'service_date', 'time_in', 'original_visit_id', 'correction_reason',
    'visit_number_snapshot', 'created_by', 'created_at'
  ];
  col text;
begin
  -- Locked records: the only legal change is marking them 'corrected'.
  if old.status in ('signed', 'administrator_review') then
    if new.status = 'corrected'
       and (to_jsonb(new) - array['status', 'updated_at'])
           = (to_jsonb(old) - array['status', 'updated_at']) then
      return new;
    end if;
    raise exception 'A submitted visit is locked; use a correction' using errcode = 'OGC09';
  end if;
  if old.status in ('corrected', 'voided') then
    raise exception 'A % visit cannot be changed', old.status using errcode = 'OGC09';
  end if;

  -- Identity and server-recorded time first, so a tampering attempt is
  -- reported as such regardless of the status it targets.
  if old.time_in is distinct from new.time_in then
    raise exception 'time_in is server-recorded and immutable' using errcode = 'OGC09';
  end if;
  foreach col in array immutable_cols loop
    if (to_jsonb(old) -> col) is distinct from (to_jsonb(new) -> col) then
      raise exception 'Visit field % is immutable', col using errcode = 'OGC09';
    end if;
  end loop;

  if not (
    (old.status = 'draft' and new.status in ('awaiting_signature', 'voided'))
    or (old.status = 'awaiting_signature' and new.status in ('signed', 'administrator_review', 'voided'))
  ) then
    raise exception 'Illegal visit transition % -> %', old.status, new.status using errcode = 'OGC09';
  end if;

  -- Rebinding at confirmation may only move within the same authorization lineage.
  if old.service_authorization_id is distinct from new.service_authorization_id
     and (select lineage_id from ogevia.client_authorizations where id = old.service_authorization_id)
         is distinct from
         (select lineage_id from ogevia.client_authorizations where id = new.service_authorization_id)
  then
    raise exception 'A visit can only move to another version of its authorization' using errcode = 'OGC09';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger service_visits_guard_update
before update on ogevia.service_visits
for each row execute function ogevia.service_visits_guard_update();

create trigger service_visits_no_delete
before delete on ogevia.service_visits
for each row execute function ogevia.forbid_delete();

-- Evidence metadata for Phase 5 private S3 storage. The image bytes never
-- enter PostgreSQL. Object keys contain UUIDs only.
create table ogevia.visit_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  evidence_type text not null default 'client_signature' check (evidence_type = 'client_signature'),
  storage_provider text not null default 's3' check (storage_provider = 's3'),
  object_key text not null,
  object_version_id text,
  content_type text not null check (content_type = 'image/png'),
  -- 1 MiB ceiling, same as the current Supabase visit-signatures bucket.
  byte_size integer not null check (byte_size between 1 and 1048576),
  sha256_hex text not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  registered_by uuid not null references ogevia.app_users(id),
  registered_at timestamptz not null default now(),
  request_id uuid,
  constraint visit_evidence_key_shape check (
    object_key = organization_id::text || '/' || visit_id::text || '/client-signature.png'
  )
);
create index visit_evidence_visit_idx on ogevia.visit_evidence (visit_id, registered_at desc);

create table ogevia.visit_confirmations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null unique references ogevia.service_visits(id),
  signer_role ogevia.visit_signer_role not null,
  confirmation_method text not null
    check (confirmation_method in ('draw', 'typed', 'verbal', 'assisted_mark', 'unable_to_confirm')),
  evidence_id uuid references ogevia.visit_evidence(id),
  typed_signer_name text,
  signer_relationship text,
  confirmation_reason text,
  confirmed_visit_snapshot jsonb not null,
  confirmation_version integer not null,
  confirmed_by uuid not null references ogevia.app_users(id),
  confirmed_at timestamptz not null default now(),
  request_id uuid,
  constraint visit_confirmations_method_evidence check (
    (confirmation_method in ('draw', 'assisted_mark') and evidence_id is not null)
    or (confirmation_method not in ('draw', 'assisted_mark') and evidence_id is null)
  ),
  constraint visit_confirmations_typed_name check (
    confirmation_method not in ('typed', 'verbal') or length(btrim(coalesce(typed_signer_name, ''))) > 0
  ),
  constraint visit_confirmations_unable_reason check (
    confirmation_method <> 'unable_to_confirm' or length(btrim(coalesce(confirmation_reason, ''))) > 0
  )
);

create table ogevia.visit_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  -- A row is corrected at most once; later corrections target the new row.
  original_visit_id uuid not null unique references ogevia.service_visits(id),
  corrected_visit_id uuid not null unique references ogevia.service_visits(id),
  corrected_by uuid not null references ogevia.app_users(id),
  reason text not null check (length(btrim(reason)) > 0),
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  request_id uuid
);
create index visit_corrections_org_idx on ogevia.visit_corrections (organization_id);

-- Append-only audit trail. Payloads hold ids, statuses, minutes and
-- timestamps only - never names, notes, or signature data.
create table ogevia.audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references ogevia.organizations(id),
  actor_user_id uuid references ogevia.app_users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  request_id uuid,
  reason text,
  before_state jsonb,
  after_state jsonb,
  occurred_at timestamptz not null default now()
);
create index audit_events_org_time_idx on ogevia.audit_events (organization_id, occurred_at desc);
create index audit_events_entity_idx on ogevia.audit_events (entity_type, entity_id);

create function ogevia.forbid_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  raise exception '% rows are append-only', tg_table_name using errcode = 'OGC09';
end;
$$;

create trigger visit_evidence_append_only before update on ogevia.visit_evidence
for each row execute function ogevia.forbid_update();
create trigger visit_evidence_no_delete before delete on ogevia.visit_evidence
for each row execute function ogevia.forbid_delete();
create trigger visit_confirmations_append_only before update on ogevia.visit_confirmations
for each row execute function ogevia.forbid_update();
create trigger visit_confirmations_no_delete before delete on ogevia.visit_confirmations
for each row execute function ogevia.forbid_delete();
create trigger visit_corrections_append_only before update on ogevia.visit_corrections
for each row execute function ogevia.forbid_update();
create trigger visit_corrections_no_delete before delete on ogevia.visit_corrections
for each row execute function ogevia.forbid_delete();
create trigger audit_events_append_only before update on ogevia.audit_events
for each row execute function ogevia.forbid_update();
create trigger audit_events_no_delete before delete on ogevia.audit_events
for each row execute function ogevia.forbid_delete();

create function ogevia.write_audit(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
)
returns void
language sql
set search_path = ogevia, pg_temp
as $$
  insert into ogevia.audit_events (
    organization_id, actor_user_id, action, entity_type, entity_id,
    request_id, reason, before_state, after_state
  ) values (
    p_organization_id, ogevia.current_user_id(), p_action, p_entity_type, p_entity_id,
    ogevia.current_request_id(), p_reason, p_before, p_after
  );
$$;

-- Idempotency: a retried request with the same key and same parameters
-- returns the stored response instead of acting twice.
create table ogevia.idempotency_records (
  actor_user_id uuid not null references ogevia.app_users(id),
  operation text not null,
  idempotency_key uuid not null,
  organization_id uuid not null references ogevia.organizations(id),
  request_fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_user_id, operation, idempotency_key)
);
create index idempotency_records_created_idx on ogevia.idempotency_records (created_at);

-- Minutes consumed this calendar month across the WHOLE authorization
-- lineage (fix for M-1). Counts signed and administrator_review visits, which
-- carry their capped billable_minutes (0 when unconfirmed), like current main.
create function ogevia.authorization_month_usage(
  p_lineage_id uuid,
  p_service_date date,
  p_exclude_visit_id uuid default null
)
returns bigint
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(sum(v.billable_minutes), 0)::bigint
  from ogevia.service_visits v
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  where a.lineage_id = p_lineage_id
    and v.service_date >= date_trunc('month', p_service_date::timestamp)::date
    and v.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date
    and v.status in ('signed', 'administrator_review')
    and v.id is distinct from p_exclude_visit_id;
$$;
