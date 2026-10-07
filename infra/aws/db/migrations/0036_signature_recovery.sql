-- 0036 Missing-signature recovery: a visit without a client signature stays
-- pending while the agency collects the confirmation later, electronically
-- (staff-copied secure link + one-time code given by phone) or on paper.
--
-- Before this migration (verified in the repository, 2026-10-05):
--   * A visit confirmed without a signature or mark (verbal, typed,
--     unable_to_confirm) is locked in administrator_review with 0 billable
--     minutes (confirm_service_visit, 0006). Locked visits are immutable.
--   * 0031 offered only "close not billable" for it, and Needs attention kept
--     counting it until someone closed it: the only way to clear the list was
--     a non-billable closure.
--
-- After (owner direction 2026-10-05):
--   * visit_confirmation_requests: a request bound to the visit and a snapshot
--     of its times and service. Channel 'link': a 256-bit token (stored only as
--     SHA-256) and a 6-digit one-time code (stored only as SHA-256 of
--     token-hash:code) that staff give by phone to a recipient they verified;
--     5 wrong codes lock the link. Channel 'paper': a form to collect. Both
--     expire (1-30 days), can be revoked, and become void if the visit changes.
--   * While a request is open, the visit is "awaiting signature": out of the
--     Needs attention count, listed as a reminder. An expired, revoked or locked
--     request puts it back in Needs attention.
--   * visit_late_confirmations (append-only): the recipient's confirmation
--     (drawn or typed) or dispute, or a paper form recorded by staff, with the
--     visit snapshot it confirmed. Evidence goes to the private evidence bucket
--     under the existing key patterns (no IAM change):
--       {org}/{late_confirmation_id}/client-signature.png   drawn signature
--       {org}/documents/{late_confirmation_id}/paper-form    paper form scan
--     A response puts the visit back in Needs attention for review.
--   * visit_late_confirmation_reviews (append-only): a person with
--     visits.manage accepts or rejects it, with a reason. Accepting computes,
--     under the authorization lock, the accepted minutes: the worked minutes,
--     capped by the authorization's remaining time. It records an
--     accept_late_confirmation review decision. That makes the visit eligible
--     for the SEPARATE human billing approval (billing.approve) up to the
--     accepted minutes. Nothing is approved, submitted or billed automatically.
--     The visit row, its confirmation and its 0 billable minutes are never
--     changed; accepted minutes count against the authorization everywhere
--     (authorization_month_usage, monthly summary) while the decision is active.
--   * A dispute can only be recorded as reviewed (rejected); it never becomes
--     billable.
--   * Rounding (0029) now also covers a reviewed visit once its billing
--     approval is active; a reviewed visit with an active approval no longer
--     blocks daily-total rounding as "open".
-- Payer acceptance of late or electronic confirmations is NOT established by
-- this software; real-client use stays blocked until the owner confirms it.

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------
create table ogevia.visit_confirmation_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  channel text not null check (channel in ('link', 'paper')),
  recipient_name text not null check (length(btrim(recipient_name)) between 2 and 200),
  recipient_role ogevia.visit_signer_role not null,
  identity_check text check (identity_check is null or length(btrim(identity_check)) between 5 and 500),
  token_hash text unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  code_hash text check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'),
  failed_code_attempts integer not null default 0 check (failed_code_attempts between 0 and 5),
  locked_at timestamptz,
  visit_snapshot jsonb not null,
  expires_at timestamptz not null,
  responded_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references ogevia.app_users(id),
  revoke_reason text,
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  request_id uuid,
  constraint visit_confirmation_requests_link_shape check (
    (channel = 'link' and token_hash is not null and code_hash is not null and identity_check is not null)
    or (channel = 'paper' and token_hash is null and code_hash is null)
  ),
  constraint visit_confirmation_requests_revoke_shape check (
    (revoked_at is null and revoked_by is null and revoke_reason is null)
    or (revoked_at is not null and revoked_by is not null and length(btrim(coalesce(revoke_reason, ''))) > 0)
  ),
  constraint visit_confirmation_requests_expiry check (expires_at > created_at)
);
-- At most one request per visit that is neither answered nor revoked (an
-- expired one is revoked when a new one is made).
create unique index visit_confirmation_requests_one_open on ogevia.visit_confirmation_requests (visit_id)
  where responded_at is null and revoked_at is null;
create index visit_confirmation_requests_org_idx on ogevia.visit_confirmation_requests (organization_id, created_at desc);

-- Only these changes are allowed: wrong-code count/lock, answered once, revoked once.
create function ogevia.visit_confirmation_requests_guard()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Confirmation requests cannot be deleted' using errcode = 'OGC09';
  end if;
  if (to_jsonb(new) - array['failed_code_attempts', 'locked_at', 'responded_at', 'revoked_at', 'revoked_by', 'revoke_reason'])
     is distinct from (to_jsonb(old) - array['failed_code_attempts', 'locked_at', 'responded_at', 'revoked_at', 'revoked_by', 'revoke_reason'])
     or new.failed_code_attempts < old.failed_code_attempts
     or (old.locked_at is not null and new.locked_at is distinct from old.locked_at)
     or (old.responded_at is not null and new.responded_at is distinct from old.responded_at)
     or (old.revoked_at is not null and (new.revoked_at, new.revoked_by, new.revoke_reason) is distinct from (old.revoked_at, old.revoked_by, old.revoke_reason)) then
    raise exception 'A confirmation request cannot be changed; revoke it and make a new one' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
create trigger visit_confirmation_requests_guard before update or delete on ogevia.visit_confirmation_requests
for each row execute function ogevia.visit_confirmation_requests_guard();
alter table ogevia.visit_confirmation_requests enable row level security;
create policy readonly_select on ogevia.visit_confirmation_requests for select to ogevia_readonly using (true);
grant select on ogevia.visit_confirmation_requests to ogevia_readonly;

-- ---------------------------------------------------------------------------
-- Late confirmations (responses) and their review
-- ---------------------------------------------------------------------------
create table ogevia.visit_late_confirmations (
  id uuid primary key,
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  request_id uuid not null unique references ogevia.visit_confirmation_requests(id),
  outcome text not null check (outcome in ('confirmed', 'disputed')),
  method text check (method in ('draw', 'typed', 'paper')),
  signer_name text not null check (length(btrim(signer_name)) between 2 and 200),
  signer_role ogevia.visit_signer_role not null,
  dispute_reason text,
  attestation_version text not null,
  confirmed_visit_snapshot jsonb not null,
  signed_on date,
  evidence_object_key text,
  evidence_version_id text,
  evidence_content_type text,
  evidence_byte_size integer,
  evidence_sha256 text,
  received_at timestamptz not null default now(),
  recorded_by uuid references ogevia.app_users(id),
  response_key uuid not null,
  request_id_header uuid,
  constraint visit_late_confirmations_shape check (
    (outcome = 'disputed' and method is null and evidence_object_key is null
      and length(btrim(coalesce(dispute_reason, ''))) between 3 and 1000)
    or (outcome = 'confirmed' and dispute_reason is null and (
      (method = 'typed' and evidence_object_key is null)
      or (method = 'draw' and evidence_content_type = 'image/png'
          and evidence_object_key = organization_id::text || '/' || id::text || '/client-signature.png')
      or (method = 'paper' and recorded_by is not null and signed_on is not null
          and evidence_content_type in ('application/pdf', 'image/jpeg', 'image/png')
          and evidence_object_key = organization_id::text || '/documents/' || id::text || '/paper-form')))
  ),
  constraint visit_late_confirmations_evidence_shape check (
    (evidence_object_key is null and evidence_byte_size is null and evidence_sha256 is null and evidence_content_type is null)
    or (evidence_object_key is not null and evidence_byte_size between 1 and 10485760 and evidence_sha256 ~ '^[0-9a-f]{64}$')
  )
);
create index visit_late_confirmations_visit_idx on ogevia.visit_late_confirmations (visit_id, received_at desc);
create trigger visit_late_confirmations_no_update before update on ogevia.visit_late_confirmations
for each row execute function ogevia.forbid_update();
create trigger visit_late_confirmations_no_delete before delete on ogevia.visit_late_confirmations
for each row execute function ogevia.forbid_delete();
alter table ogevia.visit_late_confirmations enable row level security;
create policy readonly_select on ogevia.visit_late_confirmations for select to ogevia_readonly using (true);
grant select on ogevia.visit_late_confirmations to ogevia_readonly;

create table ogevia.visit_late_confirmation_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  late_confirmation_id uuid not null unique references ogevia.visit_late_confirmations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  outcome text not null check (outcome in ('accepted', 'rejected')),
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  accepted_minutes integer,
  capped_by_authorization boolean,
  decided_by uuid not null references ogevia.app_users(id),
  decided_at timestamptz not null default now(),
  request_id uuid,
  constraint visit_late_confirmation_reviews_minutes check (
    (outcome = 'accepted' and accepted_minutes > 0 and capped_by_authorization is not null)
    or (outcome = 'rejected' and accepted_minutes is null and capped_by_authorization is null)
  )
);
create trigger visit_late_confirmation_reviews_no_update before update on ogevia.visit_late_confirmation_reviews
for each row execute function ogevia.forbid_update();
create trigger visit_late_confirmation_reviews_no_delete before delete on ogevia.visit_late_confirmation_reviews
for each row execute function ogevia.forbid_delete();
alter table ogevia.visit_late_confirmation_reviews enable row level security;
create policy readonly_select on ogevia.visit_late_confirmation_reviews for select to ogevia_readonly using (true);
grant select on ogevia.visit_late_confirmation_reviews to ogevia_readonly;

-- An accepted late confirmation is an ordinary (revocable) review decision.
alter table ogevia.visit_review_decisions drop constraint visit_review_decisions_decision_check;
alter table ogevia.visit_review_decisions add constraint visit_review_decisions_decision_check
  check (decision in ('accept_capped_billable', 'close_not_billable', 'accept_late_confirmation'));
alter table ogevia.visit_review_decisions add column late_confirmation_review_id uuid references ogevia.visit_late_confirmation_reviews(id);
alter table ogevia.visit_review_decisions add column accepted_minutes integer;
alter table ogevia.visit_review_decisions add constraint visit_review_decisions_late_shape check (
  (decision = 'accept_late_confirmation') = (late_confirmation_review_id is not null)
  and (decision = 'accept_late_confirmation') = (accepted_minutes is not null)
  and (accepted_minutes is null or accepted_minutes > 0)
);

-- ---------------------------------------------------------------------------
-- State helpers (server-side only; never from the browser)
-- ---------------------------------------------------------------------------
-- Whether the visit still matches what a request or response was bound to.
create function ogevia.visit_matches_snapshot(p_visit_id uuid, p_snapshot jsonb)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce((
    select v.status = 'administrator_review'
       and v.time_in = (p_snapshot ->> 'timeIn')::timestamptz
       and v.time_out = (p_snapshot ->> 'timeOut')::timestamptz
       and v.service_id = (p_snapshot ->> 'serviceId')::uuid
       and v.worked_minutes = (p_snapshot ->> 'workedMinutes')::integer
    from ogevia.service_visits v where v.id = p_visit_id), false);
$$;

create function ogevia.visit_snapshot_for_confirmation(p_visit_id uuid)
returns jsonb
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select jsonb_build_object('visitId', v.id, 'timeIn', v.time_in, 'timeOut', v.time_out, 'serviceId', v.service_id,
    'serviceDate', v.service_date, 'workedMinutes', v.worked_minutes, 'clientId', v.client_id,
    'visitNumber', v.visit_number_snapshot)
  from ogevia.service_visits v where v.id = p_visit_id;
$$;

-- open | expired | locked | revoked | answered | void (visit changed)
create function ogevia.confirmation_request_state(r ogevia.visit_confirmation_requests)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case
    when r.revoked_at is not null then 'revoked'
    when r.responded_at is not null then 'answered'
    when r.locked_at is not null then 'locked'
    when r.expires_at <= now() then 'expired'
    when not ogevia.visit_matches_snapshot(r.visit_id, r.visit_snapshot) then 'void'
    else 'open'
  end;
$$;

-- awaiting_response | response_to_review | null (nothing in progress)
create function ogevia.visit_recovery_state(p_visit_id uuid)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case
    when exists (select 1 from ogevia.visit_late_confirmations lc
                 where lc.visit_id = p_visit_id
                   and not exists (select 1 from ogevia.visit_late_confirmation_reviews rv where rv.late_confirmation_id = lc.id))
      then 'response_to_review'
    when exists (select 1 from ogevia.visit_confirmation_requests r
                 where r.visit_id = p_visit_id and ogevia.confirmation_request_state(r) = 'open')
      then 'awaiting_response'
  end;
$$;

-- ---------------------------------------------------------------------------
-- Staff: request, revoke, list
-- ---------------------------------------------------------------------------
create function ogevia_api.create_visit_confirmation_request(
  p_visit_id uuid,
  p_channel text,
  p_recipient_name text,
  p_recipient_role text,
  p_identity_check text,
  p_token_hash text,
  p_code_hash text,
  p_expires_in_days integer,
  p_idempotency_key uuid default null
)
returns table (request_id uuid, expires_at timestamptz, is_new boolean)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_name text := btrim(coalesce(p_recipient_name, ''));
  v_check text := nullif(btrim(coalesce(p_identity_check, '')), '');
  -- The link token and code are new on every attempt, so they are not part of the retry fingerprint;
  -- a retry returns the request already made (is_new = false; its link cannot be shown again).
  v_fp text := concat_ws('|', p_visit_id, p_channel, v_name, p_recipient_role, v_check, p_expires_in_days);
  v_prior jsonb;
  v_open ogevia.visit_confirmation_requests%rowtype;
  v_id uuid;
  v_expires timestamptz;
begin
  select * into v_visit from ogevia.service_visits v where v.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_visit.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to request confirmations' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('create_confirmation_request', p_idempotency_key, v_visit.organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'request_id')::uuid, (v_prior ->> 'expires_at')::timestamptz, false;
    return;
  end if;
  if p_channel is null or p_channel not in ('link', 'paper') then
    raise exception 'Choose a secure link or a paper form' using errcode = 'OGV22';
  end if;
  if length(v_name) not between 2 and 200 then
    raise exception 'Enter the name of the person who will confirm the visit' using errcode = 'OGV22';
  end if;
  if p_recipient_role is null or p_recipient_role not in ('client', 'parent', 'guardian', 'authorized_representative') then
    raise exception 'Choose who the person is (client, parent, guardian or authorized representative)' using errcode = 'OGV22';
  end if;
  if p_expires_in_days is null or p_expires_in_days not between 1 and 30 then
    raise exception 'The request must expire within 1 to 30 days' using errcode = 'OGV22';
  end if;
  if p_channel = 'link' then
    if v_check is null or length(v_check) not between 5 and 500 then
      raise exception 'Record how you will verify the person by phone before giving the code (for example, a call to the number on file)' using errcode = 'OGV22';
    end if;
    if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then
      raise exception 'Invalid link' using errcode = 'OGV22';
    end if;
  end if;
  if v_visit.status <> 'administrator_review' or not ('no_client_signature' = any (coalesce(ogevia.visit_review_reasons(v_visit.id), array[]::text[]))) then
    raise exception 'A confirmation can be requested only for a visit in review without a client signature' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v_visit.id and d.revoked_at is null) then
    raise exception 'This visit already has a review decision; revoke it first to request a confirmation' using errcode = 'OGC09';
  end if;
  if ogevia.visit_recovery_state(v_visit.id) = 'response_to_review' then
    raise exception 'A response is waiting for review; review it first' using errcode = 'OGC09';
  end if;
  select * into v_open from ogevia.visit_confirmation_requests r
  where r.visit_id = v_visit.id and r.responded_at is null and r.revoked_at is null for update;
  if v_open.id is not null then
    if ogevia.confirmation_request_state(v_open) = 'open' then
      raise exception 'A request for this visit is already open; revoke it first' using errcode = 'OGC09';
    end if;
    -- An expired, locked or void request is closed and kept on record.
    update ogevia.visit_confirmation_requests set revoked_at = now(), revoked_by = v_actor,
      revoke_reason = 'Closed when a new request was made (' || ogevia.confirmation_request_state(v_open) || ')'
    where id = v_open.id;
  end if;

  v_expires := now() + make_interval(days => p_expires_in_days);
  insert into ogevia.visit_confirmation_requests (organization_id, visit_id, channel, recipient_name, recipient_role, identity_check,
    token_hash, code_hash, visit_snapshot, expires_at, created_by, request_id)
  values (v_visit.organization_id, v_visit.id, p_channel, v_name, p_recipient_role::ogevia.visit_signer_role,
    case when p_channel = 'link' then v_check end,
    case when p_channel = 'link' then p_token_hash end, case when p_channel = 'link' then p_code_hash end,
    ogevia.visit_snapshot_for_confirmation(v_visit.id), v_expires, v_actor, ogevia.current_request_id())
  returning id into v_id;

  perform ogevia.write_audit(v_visit.organization_id, 'visit.confirmation_requested', 'visit_confirmation_requests', v_id, null,
    jsonb_build_object('visit_id', v_visit.id, 'channel', p_channel, 'recipient_role', p_recipient_role, 'expires_at', v_expires), null);
  perform ogevia.idempotency_finish('create_confirmation_request', p_idempotency_key, v_visit.organization_id, v_fp,
    jsonb_build_object('request_id', v_id, 'expires_at', v_expires));
  return query select v_id, v_expires, true;
end;
$$;

create function ogevia_api.revoke_visit_confirmation_request(p_request_id uuid, p_reason text, p_idempotency_key uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_r ogevia.visit_confirmation_requests%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_fp text := concat_ws('|', p_request_id, v_reason);
  v_prior jsonb;
begin
  select * into v_r from ogevia.visit_confirmation_requests r where r.id = p_request_id for update;
  if v_r.id is null or not ogevia.is_active_member(v_r.organization_id) then
    raise exception 'Request not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_r.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to manage confirmation requests' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('revoke_confirmation_request', p_idempotency_key, v_r.organization_id, v_fp);
  if v_prior is not null then
    return (v_prior ->> 'request_id')::uuid;
  end if;
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'Give the reason for revoking the request' using errcode = 'OGV22';
  end if;
  if v_r.revoked_at is not null then raise exception 'This request was already revoked' using errcode = 'OGC09'; end if;
  if v_r.responded_at is not null then raise exception 'This request was already answered; review the response instead' using errcode = 'OGC09'; end if;
  update ogevia.visit_confirmation_requests set revoked_at = now(), revoked_by = v_actor, revoke_reason = v_reason where id = v_r.id;
  perform ogevia.write_audit(v_r.organization_id, 'visit.confirmation_request_revoked', 'visit_confirmation_requests', v_r.id,
    jsonb_build_object('state', ogevia.confirmation_request_state(v_r)), jsonb_build_object('revoked', true), v_reason);
  perform ogevia.idempotency_finish('revoke_confirmation_request', p_idempotency_key, v_r.organization_id, v_fp,
    jsonb_build_object('request_id', v_r.id));
  return v_r.id;
end;
$$;

-- Everything about recovery for one visit (visits.read). No token or code is ever returned.
create function ogevia_api.list_visit_confirmation_requests(p_visit_id uuid)
returns table (
  request_id uuid, channel text, recipient_name text, recipient_role text, identity_check text, state text,
  failed_code_attempts integer, expires_at timestamptz, created_by_name text, created_at timestamptz,
  revoked_by_name text, revoked_at timestamptz, revoke_reason text,
  late_confirmation_id uuid, outcome text, method text, signer_name text, signer_role text, dispute_reason text,
  signed_on date, received_at timestamptz, recorded_by_name text, has_evidence boolean, evidence_content_type text,
  review_outcome text, review_reason text, accepted_minutes integer, capped_by_authorization boolean,
  reviewed_by_name text, reviewed_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select r.id, r.channel, r.recipient_name, r.recipient_role::text, r.identity_check, ogevia.confirmation_request_state(r),
         r.failed_code_attempts, r.expires_at, cu.display_name, r.created_at, ru.display_name, r.revoked_at, r.revoke_reason,
         lc.id, lc.outcome, lc.method, lc.signer_name, lc.signer_role::text, lc.dispute_reason, lc.signed_on, lc.received_at,
         lu.display_name, lc.evidence_object_key is not null, lc.evidence_content_type,
         rv.outcome, rv.reason, rv.accepted_minutes, rv.capped_by_authorization, vu.display_name, rv.decided_at
  from ogevia.visit_confirmation_requests r
  join ogevia.service_visits v on v.id = r.visit_id
  left join ogevia.app_users cu on cu.id = r.created_by
  left join ogevia.app_users ru on ru.id = r.revoked_by
  left join ogevia.visit_late_confirmations lc on lc.request_id = r.id
  left join ogevia.app_users lu on lu.id = lc.recorded_by
  left join ogevia.visit_late_confirmation_reviews rv on rv.late_confirmation_id = lc.id
  left join ogevia.app_users vu on vu.id = rv.decided_by
  where r.visit_id = p_visit_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(v.organization_id)
    and ogevia.has_permission(v.organization_id, 'visits.read')
  order by r.created_at desc;
$$;

-- Where a late confirmation's evidence is stored (visits.read); the API reads the object.
create function ogevia_api.get_late_confirmation_evidence(p_late_confirmation_id uuid)
returns table (object_key text, version_id text, content_type text, byte_size integer, sha256 text)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select lc.evidence_object_key, lc.evidence_version_id, lc.evidence_content_type, lc.evidence_byte_size, lc.evidence_sha256
  from ogevia.visit_late_confirmations lc
  where lc.id = p_late_confirmation_id and lc.evidence_object_key is not null
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(lc.organization_id)
    and ogevia.has_permission(lc.organization_id, 'visits.read');
$$;

-- ---------------------------------------------------------------------------
-- Public (no sign-in): the link holder, with the one-time code
-- ---------------------------------------------------------------------------
-- Resolves a link and checks the code. Returns a status instead of raising so
-- that a wrong-code count is kept (the caller's transaction commits). Every
-- invalid, expired, revoked, answered, locked or void link reads 'unavailable'
-- (no detail about which).
create function ogevia.confirmation_request_check(p_token_hash text, p_code_hash text)
returns table (status text, request ogevia.visit_confirmation_requests)
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_r ogevia.visit_confirmation_requests%rowtype;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then
    return query select 'unavailable'::text, null::ogevia.visit_confirmation_requests; return;
  end if;
  select * into v_r from ogevia.visit_confirmation_requests r
  where r.token_hash = p_token_hash and r.channel = 'link'
    and exists (select 1 from ogevia.organizations o where o.id = r.organization_id and o.status = 'active')
  for update;
  if v_r.id is null or ogevia.confirmation_request_state(v_r) in ('revoked', 'answered', 'expired', 'void') then
    return query select 'unavailable'::text, null::ogevia.visit_confirmation_requests; return;
  end if;
  if v_r.locked_at is not null then
    return query select 'locked'::text, null::ogevia.visit_confirmation_requests; return;
  end if;
  if v_r.code_hash <> p_code_hash then
    update ogevia.visit_confirmation_requests
       set failed_code_attempts = failed_code_attempts + 1,
           locked_at = case when failed_code_attempts + 1 >= 5 then now() end
     where id = v_r.id;
    if v_r.failed_code_attempts + 1 >= 5 then
      perform ogevia.write_audit(v_r.organization_id, 'visit.confirmation_request_locked', 'visit_confirmation_requests', v_r.id,
        null, jsonb_build_object('failed_code_attempts', 5), null);
      return query select 'locked'::text, null::ogevia.visit_confirmation_requests; return;
    end if;
    return query select 'wrong_code'::text, null::ogevia.visit_confirmation_requests; return;
  end if;
  return query select 'ok'::text, v_r;
end;
$$;

-- What the recipient sees: only what is needed to confirm the visit.
create function ogevia_api.public_open_visit_confirmation(p_token_hash text, p_code_hash text)
returns table (
  status text, organization_id uuid, agency_name text, recipient_name text, service_name text, service_date date,
  time_in timestamptz, time_out timestamptz, worked_minutes integer, caregiver_first_name text, timezone text,
  expires_at timestamptz, attempts_left integer
)
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  c record;
  v_left integer;
begin
  select * into c from ogevia.confirmation_request_check(p_token_hash, p_code_hash);
  if c.status <> 'ok' then
    select 5 - r.failed_code_attempts into v_left from ogevia.visit_confirmation_requests r where r.token_hash = p_token_hash;
    return query select c.status, null::uuid, null::text, null::text, null::text, null::date, null::timestamptz, null::timestamptz,
      null::integer, null::text, null::text, null::timestamptz, case when c.status = 'wrong_code' then v_left end;
    return;
  end if;
  return query
  select 'ok'::text, o.id, o.display_name, (c.request).recipient_name, s.name, v.service_date, v.time_in, v.time_out, v.worked_minutes,
         split_part(btrim(coalesce(v.caregiver_name_snapshot, '')), ' ', 1), o.timezone, (c.request).expires_at,
         5 - (c.request).failed_code_attempts
  from ogevia.service_visits v
  join ogevia.services s on s.id = v.service_id
  join ogevia.organizations o on o.id = v.organization_id
  where v.id = (c.request).visit_id;
end;
$$;

-- The recipient confirms (drawn or typed) or disputes. One response per link;
-- a retry with the same response key returns the same result.
create function ogevia_api.public_respond_visit_confirmation(
  p_token_hash text,
  p_code_hash text,
  p_late_confirmation_id uuid,
  p_outcome text,
  p_method text,
  p_signer_name text,
  p_dispute_reason text,
  p_attested boolean,
  p_evidence_object_key text,
  p_evidence_version_id text,
  p_evidence_byte_size integer,
  p_evidence_sha256 text,
  p_response_key uuid
)
returns table (status text, late_confirmation_id uuid)
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  c record;
  v_prior ogevia.visit_late_confirmations%rowtype;
  v_r ogevia.visit_confirmation_requests%rowtype;
  v_name text := btrim(coalesce(p_signer_name, ''));
begin
  if p_response_key is null or p_late_confirmation_id is null then
    raise exception 'Missing response key' using errcode = 'OGV22';
  end if;
  -- Retry of an already recorded response (the link is answered by now).
  select lc.* into v_prior from ogevia.visit_late_confirmations lc
  join ogevia.visit_confirmation_requests r on r.id = lc.request_id
  where r.token_hash = p_token_hash and r.code_hash = p_code_hash and lc.response_key = p_response_key;
  if v_prior.id is not null then
    return query select 'ok'::text, v_prior.id; return;
  end if;
  select * into c from ogevia.confirmation_request_check(p_token_hash, p_code_hash);
  if c.status <> 'ok' then
    return query select c.status, null::uuid; return;
  end if;
  v_r := c.request;
  if p_outcome is null or p_outcome not in ('confirmed', 'disputed') then
    raise exception 'Choose whether you confirm the visit or report a problem' using errcode = 'OGV22';
  end if;
  if length(v_name) not between 2 and 200 then
    raise exception 'Enter your full name' using errcode = 'OGV22';
  end if;
  if p_outcome = 'confirmed' then
    if p_method is null or p_method not in ('draw', 'typed') then
      raise exception 'Sign with your finger or type your full name' using errcode = 'OGV22';
    end if;
    if coalesce(p_attested, false) is not true then
      raise exception 'Confirm that the visit took place as shown' using errcode = 'OGV22';
    end if;
    if p_method = 'draw' and (p_evidence_object_key is null
        or p_evidence_object_key <> v_r.organization_id::text || '/' || p_late_confirmation_id::text || '/client-signature.png') then
      raise exception 'A drawn signature is required' using errcode = 'OGV22';
    end if;
  elsif length(btrim(coalesce(p_dispute_reason, ''))) not between 3 and 1000 then
    raise exception 'Describe what is wrong with this visit' using errcode = 'OGV22';
  end if;

  insert into ogevia.visit_late_confirmations (id, organization_id, visit_id, request_id, outcome, method, signer_name, signer_role,
    dispute_reason, attestation_version, confirmed_visit_snapshot, evidence_object_key, evidence_version_id, evidence_content_type,
    evidence_byte_size, evidence_sha256, response_key, request_id_header)
  values (p_late_confirmation_id, v_r.organization_id, v_r.visit_id, v_r.id, p_outcome,
    case when p_outcome = 'confirmed' then p_method end, v_name, v_r.recipient_role,
    case when p_outcome = 'disputed' then btrim(p_dispute_reason) end,
    'late-confirmation-v1', ogevia.visit_snapshot_for_confirmation(v_r.visit_id),
    case when p_outcome = 'confirmed' and p_method = 'draw' then p_evidence_object_key end,
    case when p_outcome = 'confirmed' and p_method = 'draw' then p_evidence_version_id end,
    case when p_outcome = 'confirmed' and p_method = 'draw' then 'image/png' end,
    case when p_outcome = 'confirmed' and p_method = 'draw' then p_evidence_byte_size end,
    case when p_outcome = 'confirmed' and p_method = 'draw' then p_evidence_sha256 end,
    p_response_key, ogevia.current_request_id());
  update ogevia.visit_confirmation_requests set responded_at = now() where id = v_r.id;
  perform ogevia.write_audit(v_r.organization_id, 'visit.late_confirmation_received', 'visit_late_confirmations', p_late_confirmation_id, null,
    jsonb_build_object('visit_id', v_r.visit_id, 'request_id', v_r.id, 'outcome', p_outcome, 'method', p_method,
      'signer_role', v_r.recipient_role), null);
  return query select 'ok'::text, p_late_confirmation_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff: paper form, review
-- ---------------------------------------------------------------------------
create function ogevia_api.record_paper_visit_confirmation(
  p_request_id uuid,
  p_late_confirmation_id uuid,
  p_signer_name text,
  p_signer_role text,
  p_signed_on date,
  p_evidence_object_key text,
  p_evidence_version_id text,
  p_evidence_content_type text,
  p_evidence_byte_size integer,
  p_evidence_sha256 text,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_r ogevia.visit_confirmation_requests%rowtype;
  v_name text := btrim(coalesce(p_signer_name, ''));
  v_fp text := concat_ws('|', p_request_id, v_name, p_signer_role, p_signed_on, p_evidence_sha256);
  v_prior jsonb;
  v_visit ogevia.service_visits%rowtype;
begin
  select * into v_r from ogevia.visit_confirmation_requests r where r.id = p_request_id for update;
  if v_r.id is null or not ogevia.is_active_member(v_r.organization_id) then
    raise exception 'Request not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_r.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to record confirmations' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('record_paper_confirmation', p_idempotency_key, v_r.organization_id, v_fp);
  if v_prior is not null then
    return (v_prior ->> 'late_confirmation_id')::uuid;
  end if;
  if ogevia.confirmation_request_state(v_r) <> 'open' then
    raise exception 'This request is no longer open (%); make a new request', ogevia.confirmation_request_state(v_r) using errcode = 'OGC09';
  end if;
  if length(v_name) not between 2 and 200 then
    raise exception 'Enter the name of the person who signed the form' using errcode = 'OGV22';
  end if;
  if p_signer_role is null or p_signer_role not in ('client', 'parent', 'guardian', 'authorized_representative') then
    raise exception 'Choose who signed the form' using errcode = 'OGV22';
  end if;
  select * into v_visit from ogevia.service_visits v where v.id = v_r.visit_id;
  if p_signed_on is null or p_signed_on < v_visit.service_date or p_signed_on > ogevia.organization_local_date(v_r.organization_id, now()) then
    raise exception 'The date written on the form must be between the visit date and today' using errcode = 'OGV22';
  end if;
  if p_evidence_object_key is null or p_evidence_object_key <> v_r.organization_id::text || '/documents/' || p_late_confirmation_id::text || '/paper-form' then
    raise exception 'Attach the scanned form' using errcode = 'OGV22';
  end if;

  insert into ogevia.visit_late_confirmations (id, organization_id, visit_id, request_id, outcome, method, signer_name, signer_role,
    attestation_version, confirmed_visit_snapshot, signed_on, evidence_object_key, evidence_version_id, evidence_content_type,
    evidence_byte_size, evidence_sha256, recorded_by, response_key, request_id_header)
  values (p_late_confirmation_id, v_r.organization_id, v_r.visit_id, v_r.id, 'confirmed', 'paper', v_name,
    p_signer_role::ogevia.visit_signer_role, 'paper-form-v1', ogevia.visit_snapshot_for_confirmation(v_r.visit_id), p_signed_on,
    p_evidence_object_key, p_evidence_version_id, p_evidence_content_type, p_evidence_byte_size, p_evidence_sha256, v_actor,
    coalesce(p_idempotency_key, gen_random_uuid()), ogevia.current_request_id());
  update ogevia.visit_confirmation_requests set responded_at = now() where id = v_r.id;
  perform ogevia.write_audit(v_r.organization_id, 'visit.late_confirmation_recorded', 'visit_late_confirmations', p_late_confirmation_id, null,
    jsonb_build_object('visit_id', v_r.visit_id, 'request_id', v_r.id, 'method', 'paper', 'signed_on', p_signed_on), null);
  perform ogevia.idempotency_finish('record_paper_confirmation', p_idempotency_key, v_r.organization_id, v_fp,
    jsonb_build_object('late_confirmation_id', p_late_confirmation_id));
  return p_late_confirmation_id;
end;
$$;

-- Checked by the API BEFORE it stores a scanned form: the caller manages visits
-- in this agency and the request is open. Raises otherwise; stores nothing.
create function ogevia_api.check_paper_confirmation_upload(p_request_id uuid, p_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_r ogevia.visit_confirmation_requests%rowtype;
begin
  perform ogevia.require_actor();
  select * into v_r from ogevia.visit_confirmation_requests r where r.id = p_request_id;
  if v_r.id is null or v_r.organization_id <> p_organization_id or not ogevia.is_active_member(v_r.organization_id) then
    raise exception 'Request not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_r.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to record confirmations' using errcode = 'OGA03';
  end if;
  if ogevia.confirmation_request_state(v_r) <> 'open' then
    raise exception 'This request is no longer open (%); make a new request', ogevia.confirmation_request_state(v_r) using errcode = 'OGC09';
  end if;
  return true;
end;
$$;

create function ogevia_api.review_late_visit_confirmation(
  p_late_confirmation_id uuid,
  p_outcome text,
  p_reason text,
  p_idempotency_key uuid default null
)
returns table (review_id uuid, decision_id uuid, accepted_minutes integer, capped_by_authorization boolean)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_lc ogevia.visit_late_confirmations%rowtype;
  v_visit ogevia.service_visits%rowtype;
  v_auth ogevia.client_authorizations%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_fp text := concat_ws('|', p_late_confirmation_id, p_outcome, v_reason);
  v_prior jsonb;
  v_room bigint;
  v_minutes integer;
  v_capped boolean;
  v_review uuid;
  v_decision uuid;
begin
  select * into v_lc from ogevia.visit_late_confirmations lc where lc.id = p_late_confirmation_id;
  if v_lc.id is null or not ogevia.is_active_member(v_lc.organization_id) then
    raise exception 'Response not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_lc.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to review visits' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('review_late_confirmation', p_idempotency_key, v_lc.organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'review_id')::uuid, (v_prior ->> 'decision_id')::uuid,
      (v_prior ->> 'accepted_minutes')::integer, (v_prior ->> 'capped')::boolean;
    return;
  end if;
  if p_outcome is null or p_outcome not in ('accepted', 'rejected') then
    raise exception 'Choose accept or reject' using errcode = 'OGV22';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 1000 then
    raise exception 'Give the reason for this decision' using errcode = 'OGV22';
  end if;
  select * into v_visit from ogevia.service_visits v where v.id = v_lc.visit_id for update;
  if exists (select 1 from ogevia.visit_late_confirmation_reviews rv where rv.late_confirmation_id = v_lc.id) then
    raise exception 'This response was already reviewed' using errcode = 'OGC09';
  end if;
  if p_outcome = 'accepted' then
    if v_lc.outcome <> 'confirmed' then
      raise exception 'A reported problem cannot be accepted as a confirmation; record it as reviewed, then correct or close the visit' using errcode = 'OGC09';
    end if;
    if not ogevia.visit_matches_snapshot(v_visit.id, v_lc.confirmed_visit_snapshot) then
      raise exception 'The visit changed after this confirmation was given; it no longer confirms the visit as it is now. Reject it and request a new confirmation' using errcode = 'OGC09';
    end if;
    if exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v_visit.id and d.revoked_at is null) then
      raise exception 'This visit already has a review decision; revoke it first' using errcode = 'OGC09';
    end if;
    select a.* into v_auth from ogevia.client_authorizations a where a.id = v_visit.service_authorization_id;
    perform ogevia.lock_authorization_lineage(v_auth.lineage_id);
    select a.* into v_auth from ogevia.client_authorizations a
    where a.lineage_id = v_auth.lineage_id and a.is_current and a.deleted_at is null
      and v_visit.service_date between a.period_start and a.period_end;
    v_room := coalesce(v_auth.monthly_authorized_minutes, 0) - ogevia.authorization_month_usage(v_auth.lineage_id, v_visit.service_date, v_visit.id);
    v_minutes := greatest(0, least(v_visit.worked_minutes::bigint, v_room))::integer;
    v_capped := v_minutes < v_visit.worked_minutes;
    if v_minutes = 0 then
      raise exception 'No authorized time remains this month for this service, so nothing could become billable. Reject the response or close the visit not billable, or record an authorization amendment first' using errcode = 'OGC09';
    end if;
  end if;

  insert into ogevia.visit_late_confirmation_reviews (organization_id, late_confirmation_id, visit_id, outcome, reason,
    accepted_minutes, capped_by_authorization, decided_by, request_id)
  values (v_lc.organization_id, v_lc.id, v_visit.id, p_outcome, v_reason,
    case when p_outcome = 'accepted' then v_minutes end, case when p_outcome = 'accepted' then v_capped end,
    v_actor, ogevia.current_request_id())
  returning id into v_review;

  if p_outcome = 'accepted' then
    insert into ogevia.visit_review_decisions (organization_id, visit_id, decision, reason, review_reasons, visit_snapshot,
      decided_by, request_id, late_confirmation_review_id, accepted_minutes)
    values (v_visit.organization_id, v_visit.id, 'accept_late_confirmation', v_reason,
      coalesce(ogevia.visit_review_reasons(v_visit.id), array[]::text[]),
      jsonb_build_object('status', v_visit.status, 'workedMinutes', v_visit.worked_minutes, 'billableMinutes', v_visit.billable_minutes,
        'authorizationStatus', v_visit.authorization_status, 'timeIn', v_visit.time_in, 'timeOut', v_visit.time_out,
        'lateConfirmationId', v_lc.id, 'lateMethod', v_lc.method, 'acceptedMinutes', v_minutes, 'capped', v_capped),
      v_actor, ogevia.current_request_id(), v_review, v_minutes)
    returning id into v_decision;
  end if;

  perform ogevia.write_audit(v_lc.organization_id, 'visit.late_confirmation_reviewed', 'visit_late_confirmation_reviews', v_review, null,
    jsonb_build_object('visit_id', v_visit.id, 'late_confirmation_id', v_lc.id, 'outcome', p_outcome,
      'accepted_minutes', v_minutes, 'capped', v_capped, 'decision_id', v_decision), v_reason);
  perform ogevia.idempotency_finish('review_late_confirmation', p_idempotency_key, v_lc.organization_id, v_fp,
    jsonb_build_object('review_id', v_review, 'decision_id', v_decision, 'accepted_minutes', v_minutes, 'capped', v_capped));
  return query select v_review, v_decision, v_minutes, v_capped;
end;
$$;


-- ---------------------------------------------------------------------------
-- Changed functions (otherwise identical to their latest versions)
-- ---------------------------------------------------------------------------
create or replace function ogevia.authorization_month_usage(
  p_lineage_id uuid,
  p_service_date date,
  p_exclude_visit_id uuid default null
)
returns bigint
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select (
    select coalesce(sum(v.billable_minutes), 0)
    from ogevia.service_visits v
    join ogevia.client_authorizations a on a.id = v.service_authorization_id
    where a.lineage_id = p_lineage_id
      and v.service_date >= date_trunc('month', p_service_date::timestamp)::date
      and v.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date
      and v.status in ('signed', 'administrator_review')
      and v.id is distinct from p_exclude_visit_id
  ) + (
    select coalesce(sum(r.adjustment_minutes), 0)
    from ogevia.billing_rounding_adjustments r
    where r.authorization_lineage_id = p_lineage_id and r.voided_at is null
      and r.service_date >= date_trunc('month', p_service_date::timestamp)::date
      and r.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date
  ) + (
    -- 0036: minutes accepted from a late confirmation (the visit row keeps 0 billable).
    select coalesce(sum(d.accepted_minutes), 0)
    from ogevia.visit_review_decisions d
    join ogevia.service_visits v on v.id = d.visit_id
    join ogevia.client_authorizations a on a.id = v.service_authorization_id
    where a.lineage_id = p_lineage_id and d.revoked_at is null and d.decision = 'accept_late_confirmation'
      and v.service_date >= date_trunc('month', p_service_date::timestamp)::date
      and v.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date
      and v.status = 'administrator_review'
      and v.id is distinct from p_exclude_visit_id
  )::bigint;
$$;

create or replace function ogevia_api.list_monthly_service_summary(
  p_organization_id uuid,
  p_month_start date,
  p_client_id uuid default null
)
returns table (
  client_id uuid,
  client_code text,
  service_id uuid,
  service_code text,
  service_name text,
  authorization_lineage_id uuid,
  authorization_period_start date,
  authorization_period_end date,
  authorized_minutes integer,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  remaining_minutes integer,
  review_minutes integer,
  visit_count integer,
  reserved_minutes integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with bounds as (
    select
      date_trunc('month', p_month_start::timestamp)::date as month_start,
      (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as month_end
  ),
  ranked_authorizations as (
    select
      a.*,
      row_number() over (
        partition by a.lineage_id
        order by a.version_number desc
      ) as version_rank
    from ogevia.client_authorizations a
    cross join bounds b
    where a.organization_id = p_organization_id
      and (p_client_id is null or a.client_id = p_client_id)
      and a.deleted_at is null
      and a.period_start < b.month_end
      and a.period_end >= b.month_start
  ),
  authorizations as (
    select *
    from ranked_authorizations
    where version_rank = 1
  ),
  usage as (
    select
      va.lineage_id,
      coalesce(sum(v.worked_minutes), 0)::integer as worked_minutes,
      coalesce(sum(v.verified_minutes), 0)::integer as verified_minutes,
      coalesce(sum(v.billable_minutes + (select coalesce(sum(d.accepted_minutes), 0) from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null and d.decision = 'accept_late_confirmation')), 0)::integer as billable_minutes,
      coalesce(sum(v.worked_minutes) filter (where v.status = 'administrator_review'), 0)::integer as review_minutes,
      count(*)::integer as visit_count
    from ogevia.service_visits v
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
    cross join bounds b
    where v.organization_id = p_organization_id
      and (p_client_id is null or v.client_id = p_client_id)
      and v.service_date >= b.month_start
      and v.service_date < b.month_end
      and v.status in ('signed', 'administrator_review')
    group by va.lineage_id
  ),
  -- Time held by assigned Care Request shifts that no signed visit has
  -- consumed yet (released when the linked visit is signed, 0013). The
  -- assignment cap counts it, so "remaining" must too.
  -- Approved billing rounding adjustments (0029) consume (or return) authorized time.
  adjusted as (
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.adjustment_minutes), 0)::integer as adjustment_minutes
    from ogevia.billing_rounding_adjustments r
    cross join bounds b
    where r.organization_id = p_organization_id and r.voided_at is null
      and r.service_date >= b.month_start and r.service_date < b.month_end
    group by r.authorization_lineage_id
  ),
  reserved as (
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.reserved_minutes), 0)::integer as reserved_minutes
    from ogevia.authorization_reservations r
    cross join bounds b
    where r.organization_id = p_organization_id
      and r.released_at is null
      and r.service_date >= b.month_start
      and r.service_date < b.month_end
    group by r.authorization_lineage_id
  )
  select
    c.id,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code),
    sv.id,
    sv.code,
    sv.name,
    a.lineage_id,
    a.period_start,
    a.period_end,
    a.monthly_authorized_minutes,
    coalesce(u.worked_minutes, 0),
    coalesce(u.verified_minutes, 0),
    coalesce(u.billable_minutes, 0),
    greatest(a.monthly_authorized_minutes - coalesce(u.billable_minutes, 0) - coalesce(ad.adjustment_minutes, 0) - coalesce(rs.reserved_minutes, 0), 0),
    coalesce(u.review_minutes, 0),
    coalesce(u.visit_count, 0),
    coalesce(rs.reserved_minutes, 0)
  from authorizations a
  join ogevia.clients c
    on c.id = a.client_id
   and c.organization_id = a.organization_id
  join ogevia.services sv
    on sv.id = a.service_id
   and sv.organization_id = a.organization_id
  left join usage u on u.lineage_id = a.lineage_id
  left join reserved rs on rs.lineage_id = a.lineage_id
  left join adjusted ad on ad.lineage_id = a.lineage_id
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
  order by sv.name, sv.code, a.period_start;
$$;

create or replace function ogevia_api.approve_visit_for_billing(
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
  v_review_accepted boolean;
  v_limit integer;
  v_late_minutes integer;
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

  v_review_accepted := v_visit.status = 'administrator_review' and exists (
    select 1 from ogevia.visit_review_decisions d
    where d.visit_id = v_visit.id and d.revoked_at is null and d.decision in ('accept_capped_billable', 'accept_late_confirmation'));
  -- 0036: a late confirmation accepted in review is eligible up to its accepted minutes.
  select d.accepted_minutes into v_late_minutes from ogevia.visit_review_decisions d
  where d.visit_id = v_visit.id and d.revoked_at is null and d.decision = 'accept_late_confirmation';
  v_limit := coalesce(v_late_minutes, v_visit.billable_minutes);
  if v_visit.status <> 'signed' and not v_review_accepted then
    raise exception 'Only a Billing Ready visit can be approved; visits needing review must be reviewed first'
      using errcode = 'OGC09';
  end if;
  if p_approved_minutes is null or p_approved_minutes < 0 or p_approved_minutes > v_limit then
    raise exception 'Approved minutes must be between 0 and the billable minutes (%)', v_limit
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
    v_visit.organization_id, v_visit.id, v_actor, p_approved_minutes, v_limit,
    nullif(btrim(coalesce(p_notes, '')), ''), v_rate, v_amount,
    jsonb_build_object(
      'visitId', v_visit.id, 'visitNumber', v_visit.visit_number_snapshot,
      'clientId', v_visit.client_id, 'clientCode', v_visit.client_code_snapshot,
      'serviceId', v_visit.service_id, 'serviceDate', v_visit.service_date,
      'timeIn', v_visit.time_in, 'timeOut', v_visit.time_out,
      'workedMinutes', v_visit.worked_minutes, 'billableMinutes', v_visit.billable_minutes,
      'serviceAuthorizationId', v_visit.service_authorization_id,
      'reviewAccepted', v_review_accepted, 'lateAcceptedMinutes', v_late_minutes)
  ) returning id into v_id;

  -- The audit row carries minutes only; dollar values stay in the owner-only columns.
  v_after := jsonb_build_object('billing_approval_id', v_id, 'visit_id', v_visit.id,
    'approved_minutes', p_approved_minutes, 'billable_minutes', v_limit);
  perform ogevia.write_audit(v_visit.organization_id, 'billing.approved', 'billing_approvals', v_id,
    null, v_after, nullif(btrim(coalesce(p_notes, '')), ''));
  perform ogevia.idempotency_finish('approve_billing', p_idempotency_key, v_visit.organization_id,
    v_fingerprint, jsonb_build_object('billing_approval_id', v_id));
  return v_id;
end;
$$;

create or replace function ogevia.visit_review_allowed(p_visit_id uuid)
returns text[]
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case
    when v.status <> 'administrator_review'
      or exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
      or ogevia.visit_recovery_state(v.id) is not null
      then array[]::text[]
    when c.confirmation_method in ('draw', 'assisted_mark') and v.billable_minutes > 0
      then array['accept_capped_billable', 'close_not_billable']
    else array['close_not_billable']
  end
  from ogevia.service_visits v
  left join ogevia.visit_confirmations c on c.visit_id = coalesce(v.original_visit_id, v.id)
  where v.id = p_visit_id;
$$;

drop function ogevia_api.get_visit_review(uuid);
create function ogevia_api.get_visit_review(p_visit_id uuid)
returns table (
  visit_id uuid,
  organization_id uuid,
  visit_number text,
  visit_status ogevia.service_visit_status,
  client_id uuid,
  client_code text,
  client_name text,
  caregiver_name text,
  service_code text,
  service_name text,
  service_date date,
  time_in timestamptz,
  time_out timestamptz,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  authorization_status ogevia.visit_authorization_status,
  scheduled_starts_at timestamptz,
  scheduled_ends_at timestamptz,
  caregiver_scheduling_mode text,
  confirmation_method text,
  signer_role text,
  signer_name text,
  signer_relationship text,
  confirmation_reason text,
  confirmed_at timestamptz,
  has_signature_evidence boolean,
  is_correction boolean,
  original_visit_id uuid,
  review_reasons text[],
  decision_id uuid,
  decision text,
  decision_reason text,
  decided_by_name text,
  decided_at timestamptz,
  active_billing_approval_id uuid,
  approved_minutes integer,
  can_decide boolean,
  allowed_decisions text[],
  recovery_state text,
  can_request_confirmation boolean,
  decision_accepted_minutes integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select
    v.id, v.organization_id, v.visit_number_snapshot, v.status, v.client_id, v.client_code_snapshot,
    case when ogevia.has_permission(v.organization_id, 'clients.names.read')
         then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
    v.caregiver_name_snapshot, sv.code, sv.name, v.service_date, v.time_in, v.time_out,
    v.worked_minutes, v.verified_minutes, v.billable_minutes, v.authorization_status,
    sh.starts_at, sh.ends_at,
    (select cr.scheduling_mode from ogevia.caregiver_records cr where cr.organization_id = v.organization_id and cr.deleted_at is null
       and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id)) limit 1),
    c.confirmation_method, c.signer_role::text, c.typed_signer_name, c.signer_relationship, c.confirmation_reason, c.confirmed_at,
    c.evidence_id is not null,
    v.original_visit_id is not null, v.original_visit_id,
    coalesce(ogevia.visit_review_reasons(v.id), array[]::text[]),
    d.id, d.decision, d.reason, du.display_name, d.decided_at,
    b.id, b.approved_minutes,
    ogevia.has_permission(v.organization_id, 'visits.manage'),
    case when ogevia.has_permission(v.organization_id, 'visits.manage')
         then coalesce(ogevia.visit_review_allowed(v.id), array[]::text[]) else array[]::text[] end,
    ogevia.visit_recovery_state(v.id),
    ogevia.has_permission(v.organization_id, 'visits.manage') and v.status = 'administrator_review'
      and 'no_client_signature' = any (coalesce(ogevia.visit_review_reasons(v.id), array[]::text[]))
      and d.id is null and ogevia.visit_recovery_state(v.id) is null,
    d.accepted_minutes
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  left join ogevia.shifts sh on sh.id = v.scheduled_shift_id
  left join ogevia.visit_confirmations c on c.visit_id = coalesce(v.original_visit_id, v.id)
  left join ogevia.client_private_names n on n.client_id = v.client_id
  left join ogevia.visit_review_decisions d on d.visit_id = v.id and d.revoked_at is null
  left join ogevia.app_users du on du.id = d.decided_by
  left join ogevia.billing_approvals b on b.visit_id = v.id and b.voided_at is null
  where v.id = p_visit_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(v.organization_id)
    and ogevia.has_permission(v.organization_id, 'visits.read');
$$;

drop function ogevia_api.list_billing_review_visits(uuid, date, date);
create function ogevia_api.list_billing_review_visits(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  visit_id uuid,
  visit_number text,
  client_id uuid,
  service_id uuid,
  service_code text,
  authorization_id uuid,
  authorization_lineage_id uuid,
  authorization_version integer,
  service_date date,
  time_in timestamptz,
  time_out timestamptz,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  visit_status ogevia.service_visit_status,
  authorization_status ogevia.visit_authorization_status,
  has_administrator_override boolean,
  confirmation_method text,
  has_signature_evidence boolean,
  is_correction boolean,
  original_visit_id uuid,
  review_state text,
  latest_audit_event_id bigint,
  client_code text,
  client_name text,
  caregiver_name text,
  service_name text,
  caregiver_scheduling_mode text,
  scheduled_shift_id uuid,
  review_reasons text[],
  review_decision text,
  review_decided_at timestamptz,
  eligible_minutes integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select
    v.id, v.visit_number_snapshot, v.client_id, v.service_id, sv.code,
    a.id, a.lineage_id, a.version_number,
    v.service_date, v.time_in, v.time_out, v.worked_minutes, v.verified_minutes, v.billable_minutes,
    v.status, v.authorization_status,
    v.authorization_status = 'administrator_override',
    root_conf.confirmation_method,
    root_conf.evidence_id is not null,
    v.original_visit_id is not null,
    v.original_visit_id,
    case
      when v.status = 'signed' then 'ready'
      when d.decision in ('accept_capped_billable', 'accept_late_confirmation') then 'reviewed_eligible'
      when d.decision = 'close_not_billable' then 'reviewed_not_billable'
      when ogevia.visit_recovery_state(v.id) = 'awaiting_response' then 'awaiting_signature'
      when ogevia.visit_recovery_state(v.id) = 'response_to_review' then 'late_response_to_review'
      else 'needs_review'
    end,
    (select max(ae.id) from ogevia.audit_events ae where ae.entity_id = v.id),
    v.client_code_snapshot,
    -- Legal names only for clients.names.read (Administrator, manager); null otherwise.
    case when ogevia.has_permission(p_organization_id, 'clients.names.read')
         then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
    v.caregiver_name_snapshot,
    sv.name,
    (select cr.scheduling_mode from ogevia.caregiver_records cr where cr.organization_id = v.organization_id and cr.deleted_at is null
       and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id)) limit 1),
    v.scheduled_shift_id,
    coalesce(ogevia.visit_review_reasons(v.id), array[]::text[]),
    d.decision,
    d.decided_at,
    case when v.status = 'signed' then v.billable_minutes
         when d.decision = 'accept_capped_billable' then v.billable_minutes
         when d.decision = 'accept_late_confirmation' then d.accepted_minutes
         else 0 end
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  left join ogevia.visit_confirmations root_conf
    on root_conf.visit_id = coalesce(v.original_visit_id, v.id)
  left join ogevia.client_private_names n on n.client_id = v.client_id
  left join ogevia.visit_review_decisions d on d.visit_id = v.id and d.revoked_at is null
  where ogevia.require_actor() is not null
    and v.organization_id = p_organization_id
    and ogevia.has_permission(p_organization_id, 'billing.visits.read')
    and v.status in ('signed', 'administrator_review')
    and v.service_date between p_date_from and p_date_to
  order by v.service_date, v.time_in;
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
  documents_expiring integer,
  awaiting_signature integer,
  late_responses_to_review integer
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
      -- 0036: a visit waiting for a late confirmation is a reminder, not an action;
      -- a received response is its own action item.
      count(*) filter (
        where v.status = 'administrator_review'
          and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
          and ogevia.visit_recovery_state(v.id) is null
      )::integer as needs_review,
      count(*) filter (
        where v.status = 'administrator_review'
          and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
          and ogevia.visit_recovery_state(v.id) = 'awaiting_response'
      )::integer as awaiting_signature,
      count(*) filter (
        where v.status = 'administrator_review'
          and ogevia.visit_recovery_state(v.id) = 'response_to_review'
      )::integer as late_responses,
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
         c.missing_time_out + c.not_confirmed + c.needs_review + c.late_responses
           + case when ctx.can_cover then cov.uncovered else 0 end
           + coalesce((select d.expired + d.overdue + d.awaiting_review from docs d), 0),
         case when ctx.can_cover then cov.uncovered end,
         (select d.expired + d.overdue from docs d),
         (select d.awaiting_review from docs d),
         (select d.expiring from docs d),
         c.awaiting_signature,
         c.late_responses
  from ctx, c, cov
  where ctx.actor is not null and ctx.can_read;
$$;

create or replace function ogevia.rounding_units(p_organization_id uuid, p_from date, p_to date)
returns table (
  unit_kind text, unit_key text, visit_id uuid, authorization_lineage_id uuid, client_id uuid, service_id uuid, service_date date,
  payer text, policy_id uuid, covered_visit_ids uuid[], visit_count integer, first_time_in timestamptz, last_time_out timestamptz,
  worked_minutes integer, billable_minutes integer, approved_minutes integer, all_approved boolean, open_visits integer
)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  with v as (
    select sv.*, a.lineage_id, a.payer, (ogevia.rounding_policy_for(p_organization_id, a.payer, sv.service_id, sv.service_date)) as pol,
           (select b.approved_minutes from ogevia.billing_approvals b where b.visit_id = sv.id and b.voided_at is null) as appr
    from ogevia.service_visits sv
    join ogevia.client_authorizations a on a.id = sv.service_authorization_id
    where sv.organization_id = p_organization_id and sv.service_date between p_from and p_to
      and (sv.status = 'signed'
           or (sv.status = 'administrator_review'
               and exists (select 1 from ogevia.billing_approvals b2 where b2.visit_id = sv.id and b2.voided_at is null)))
  ), u as (
    select case when (v.pol).basis = 'daily_total' and (v.pol).method <> 'none' then 'day' else 'visit' end as kind, v.*
    from v
  )
  select u.kind,
         case when u.kind = 'day' then u.lineage_id::text || ':' || u.service_date::text else min(u.id::text) end,
         case when u.kind = 'visit' then (array_agg(u.id))[1] end,
         u.lineage_id, (array_agg(u.client_id))[1], (array_agg(u.service_id))[1], u.service_date, (array_agg(u.payer))[1],
         (array_agg((u.pol).id))[1], array_agg(u.id order by u.time_in), count(*)::integer, min(u.time_in), max(u.time_out),
         sum(u.worked_minutes)::integer, sum(u.billable_minutes)::integer, sum(u.appr)::integer, bool_and(u.appr is not null),
         (select count(*)::integer from ogevia.service_visits o join ogevia.client_authorizations oa on oa.id = o.service_authorization_id
          where u.kind = 'day' and oa.lineage_id = u.lineage_id and o.service_date = u.service_date
            and (o.status in ('draft', 'awaiting_signature')
                 or (o.status = 'administrator_review'
                     and not exists (select 1 from ogevia.billing_approvals b3 where b3.visit_id = o.id and b3.voided_at is null))))
  from u
  group by u.kind, u.lineage_id, u.service_date, case when u.kind = 'day' then null else u.id end;
$$;

revoke all on function ogevia.visit_confirmation_requests_guard() from public;
revoke all on function ogevia.visit_matches_snapshot(uuid, jsonb) from public;
revoke all on function ogevia.visit_snapshot_for_confirmation(uuid) from public;
revoke all on function ogevia.confirmation_request_state(ogevia.visit_confirmation_requests) from public;
revoke all on function ogevia.visit_recovery_state(uuid) from public;
revoke all on function ogevia.confirmation_request_check(text, text) from public;
revoke all on function ogevia_api.create_visit_confirmation_request(uuid, text, text, text, text, text, text, integer, uuid) from public;
revoke all on function ogevia_api.revoke_visit_confirmation_request(uuid, text, uuid) from public;
revoke all on function ogevia_api.list_visit_confirmation_requests(uuid) from public;
revoke all on function ogevia_api.get_late_confirmation_evidence(uuid) from public;
revoke all on function ogevia_api.public_open_visit_confirmation(text, text) from public;
revoke all on function ogevia_api.public_respond_visit_confirmation(text, text, uuid, text, text, text, text, boolean, text, text, integer, text, uuid) from public;
revoke all on function ogevia_api.record_paper_visit_confirmation(uuid, uuid, text, text, date, text, text, text, integer, text, uuid) from public;
revoke all on function ogevia_api.review_late_visit_confirmation(uuid, text, text, uuid) from public;
revoke all on function ogevia_api.check_paper_confirmation_upload(uuid, uuid) from public;
revoke all on function ogevia_api.get_visit_review(uuid) from public;
revoke all on function ogevia_api.list_billing_review_visits(uuid, date, date) from public;
revoke all on function ogevia_api.get_attention_summary(uuid, integer, integer) from public;
grant execute on function ogevia_api.create_visit_confirmation_request(uuid, text, text, text, text, text, text, integer, uuid) to ogevia_app;
grant execute on function ogevia_api.revoke_visit_confirmation_request(uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_visit_confirmation_requests(uuid) to ogevia_app;
grant execute on function ogevia_api.get_late_confirmation_evidence(uuid) to ogevia_app;
grant execute on function ogevia_api.public_open_visit_confirmation(text, text) to ogevia_app;
grant execute on function ogevia_api.public_respond_visit_confirmation(text, text, uuid, text, text, text, text, boolean, text, text, integer, text, uuid) to ogevia_app;
grant execute on function ogevia_api.record_paper_visit_confirmation(uuid, uuid, text, text, date, text, text, text, integer, text, uuid) to ogevia_app;
grant execute on function ogevia_api.review_late_visit_confirmation(uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.check_paper_confirmation_upload(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.get_visit_review(uuid) to ogevia_app;
grant execute on function ogevia_api.list_billing_review_visits(uuid, date, date) to ogevia_app;
grant execute on function ogevia_api.get_attention_summary(uuid, integer, integer) to ogevia_app;
