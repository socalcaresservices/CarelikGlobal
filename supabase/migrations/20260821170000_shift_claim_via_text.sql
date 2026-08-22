begin;

-- Self-service shift claiming: a call-out now offers the shift to the
-- top CareScore-ranked, conflict-free candidates via a one-tap link
-- texted to them (no office broadcast - the office already sees "Needs
-- coverage" in-app via list_shifts().needs_coverage, this is additive,
-- not a replacement for that visibility). First candidate to tap and
-- confirm gets the shift; every other outstanding offer for that shift
-- is revoked the moment one is claimed.

-- list_caregiver_matches() checks has_permission(org, 'shifts.update')
-- against auth.uid() - fine for its real caller (Client Detail's Matches
-- tab), but call_out_shift() is also invoked by a caregiver calling out
-- their OWN shift, who typically doesn't hold shifts.update. Extracting
-- the scoring logic into an unchecked internal helper lets call_out_shift
-- reuse the exact same ranking without re-running that permission check
-- against the wrong actor. list_caregiver_matches() itself is unchanged
-- from the caller's perspective - same signature, same permission check,
-- just delegates now.
create or replace function public._score_caregiver_matches(target_organization_id uuid, target_client_id uuid)
returns table (
  caregiver_record_id uuid,
  caregiver_name text,
  match_score integer,
  proximity_score integer,
  language_score integer,
  availability_score integer,
  skills_score integer,
  history_score integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  client_zip text;
  client_city text;
  client_state text;
  client_language_needs text[];
  client_care_needs text[];
  week_start timestamptz := date_trunc('week', now());
  week_end timestamptz := date_trunc('week', now()) + interval '7 days';
begin
  select c.address_zip, c.address_city, c.address_state, c.language_needs, c.care_needs
  into client_zip, client_city, client_state, client_language_needs, client_care_needs
  from public.clients c
  where c.id = target_client_id and c.organization_id = target_organization_id;

  if not found then
    raise exception 'Client not found in this organization';
  end if;

  return query
  with caregiver_base as (
    select
      cr.id as caregiver_record_id,
      coalesce(nullif(trim(cr.preferred_name), ''), cr.first_name || ' ' || cr.last_name) as display_name,
      cr.address_zip,
      cr.address_city,
      cr.address_state,
      cr.languages,
      up.skills,
      cr.desired_weekly_hours as target_hours_per_week,
      coalesce(
        (
          select sum(extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0)
          from public.shifts s
          where s.caregiver_record_id = cr.id
            and s.organization_id = target_organization_id
            and s.status in ('scheduled', 'completed')
            and s.starts_at < week_end
            and s.ends_at > week_start
        ),
        0
      ) as scheduled_hours_this_week,
      (
        select count(*)::int
        from public.shifts s
        where s.caregiver_record_id = cr.id
          and s.client_id = target_client_id
          and s.status = 'completed'
      ) as completed_together,
      (
        cr.linked_user_id is not null and exists (
          select 1
          from public.incidents i
          where i.caregiver_user_id = cr.linked_user_id
            and i.client_id = target_client_id
            and i.status != 'resolved'
        )
      ) as has_open_incident_together
    from public.caregiver_records cr
    left join public.user_profiles up on up.id = cr.linked_user_id
    where cr.organization_id = target_organization_id
      and cr.deleted_at is null
      and cr.status = 'active'
  ),
  scored as (
    select
      cb.caregiver_record_id,
      cb.display_name,
      (case
        when client_zip is not null and cb.address_zip is not null and client_zip = cb.address_zip then 30
        when client_city is not null and cb.address_city is not null and client_state is not null and cb.address_state is not null
          and lower(client_city) = lower(cb.address_city) and lower(client_state) = lower(cb.address_state) then 18
        when client_state is not null and cb.address_state is not null and lower(client_state) = lower(cb.address_state) then 6
        else 0
      end)::integer as proximity_score,
      (case
        when client_language_needs is null or array_length(client_language_needs, 1) is null then 25
        else round(25.0 * (
          select count(*) from unnest(client_language_needs) lang where lang = any(cb.languages)
        ) / array_length(client_language_needs, 1))
      end)::integer as language_score,
      (case
        when cb.target_hours_per_week is null then 15
        when cb.target_hours_per_week - cb.scheduled_hours_this_week <= 0 then 0
        when cb.target_hours_per_week - cb.scheduled_hours_this_week >= 10 then 20
        else round(20.0 * (cb.target_hours_per_week - cb.scheduled_hours_this_week) / 10.0)
      end)::integer as availability_score,
      (case
        when cb.skills is null or client_care_needs is null or array_length(client_care_needs, 1) is null then 10
        else round(10.0 * (
          select count(*) from unnest(client_care_needs) need where need = any(cb.skills)
        ) / array_length(client_care_needs, 1))
      end)::integer as skills_score,
      greatest(0,
        least(15, round(15.0 * least(cb.completed_together, 3) / 3.0))
        - (case when cb.has_open_incident_together then 10 else 0 end)
      )::integer as history_score
    from caregiver_base cb
  )
  select
    s.caregiver_record_id,
    s.display_name,
    least(100, greatest(0,
      s.proximity_score + s.language_score + s.availability_score + s.skills_score + s.history_score
    )),
    s.proximity_score,
    s.language_score,
    s.availability_score,
    s.skills_score,
    s.history_score
  from scored s
  order by 3 desc, s.display_name;
end;
$$;

revoke all on function public._score_caregiver_matches(uuid, uuid) from public, anon, authenticated;

create or replace function public.list_caregiver_matches(target_organization_id uuid, target_client_id uuid)
returns table(caregiver_record_id uuid, caregiver_name text, match_score integer, proximity_score integer, language_score integer, availability_score integer, skills_score integer, history_score integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'shifts.update') then
    raise exception 'You do not have permission to view caregiver matches for this organization';
  end if;
  return query select * from public._score_caregiver_matches(target_organization_id, target_client_id);
end;
$$;

revoke all on function public.list_caregiver_matches(uuid, uuid) from public;
grant execute on function public.list_caregiver_matches(uuid, uuid) to authenticated;
revoke execute on function public.list_caregiver_matches(uuid, uuid) from anon;

-- actor_user_id was NOT NULL from this table's original definition -
-- fine while every actor was an authenticated staff member or a caregiver
-- calling out their own shift, both of which always have auth.uid(). A
-- text-link claim has no session at all, so there's no actor_user_id to
-- record when the claiming caregiver has no login (linked_user_id null).
-- original_caregiver_user_id/replacement_caregiver_user_id were already
-- relaxed the same way for the same underlying reason
-- (20260821090000_reassign_shift_no_login_caregiver.sql).
alter table public.shift_coverage_events alter column actor_user_id drop not null;

create or replace function public.list_shift_coverage_history(target_shift_id uuid)
 returns table(id uuid, event_type shift_coverage_event_type, original_caregiver_name text, replacement_caregiver_name text, actor_name text, reason text, created_at timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    e.id, e.event_type,
    coalesce(op.display_name, nullif(concat_ws(' ', coalesce(ocr.preferred_name, ocr.first_name), ocr.last_name), ''), 'Caregiver'),
    coalesce(rp.display_name, nullif(concat_ws(' ', coalesce(rcr.preferred_name, rcr.first_name), rcr.last_name), '')),
    case when e.actor_user_id is null then 'Claimed via text link' else coalesce(ap.display_name, 'Administrator') end,
    e.reason, e.created_at
  from public.shift_coverage_events e
  join public.shifts s on s.id = e.shift_id
  left join public.user_profiles op on op.id = e.original_caregiver_user_id
  left join public.caregiver_records ocr on ocr.id = e.original_caregiver_record_id
  left join public.user_profiles rp on rp.id = e.replacement_caregiver_user_id
  left join public.caregiver_records rcr on rcr.id = e.replacement_caregiver_record_id
  left join public.user_profiles ap on ap.id = e.actor_user_id
  where e.shift_id = target_shift_id
    and (
      public.has_permission(s.organization_id, 'shifts.read')
      or e.original_caregiver_user_id = auth.uid()
      or e.replacement_caregiver_user_id = auth.uid()
    )
  order by e.created_at asc;
$function$;

-- Revocable, expiring shift-claim links - same shape as
-- candidate_portal_tokens (only the SHA-256 hash is stored; the raw
-- token exists only transiently in the domain_events payload the edge
-- function reads to build the text, and in the text itself).
create table public.shift_claim_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  caregiver_record_id uuid not null references public.caregiver_records(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index shift_claim_tokens_shift_idx on public.shift_claim_tokens (shift_id, created_at desc);

alter table public.shift_claim_tokens enable row level security;

create policy "authorized_read_shift_claim_tokens"
on public.shift_claim_tokens for select
to authenticated
using (public.has_permission(organization_id, 'shifts.read'));

revoke all on public.shift_claim_tokens from public, anon;
grant select on public.shift_claim_tokens to authenticated;

-- call_out_shift now also offers the shift to the top 5 ranked,
-- conflict-free candidates (excluding whoever just called out) via a
-- one-tap claim link, one shift.coverage_offer domain event per
-- candidate. No office-facing domain event is enqueued here by design -
-- the in-app "Needs coverage" card (list_shifts().needs_coverage) already
-- covers office visibility without a text; this is additive self-service
-- for caregivers, not a replacement for that.
create or replace function public.call_out_shift(target_shift_id uuid, reason text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  target_shift public.shifts%rowtype;
  event_id uuid;
  latest_event_type public.shift_coverage_event_type;
  candidate record;
  raw_token text;
  offer_expiry timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to call out a shift';
  end if;

  select * into target_shift from public.shifts where id = target_shift_id for update;
  if target_shift.id is null then raise exception 'Shift not found'; end if;
  if target_shift.caregiver_user_id <> auth.uid()
     and not public.has_permission(target_shift.organization_id, 'shifts.update') then
    raise exception 'You cannot call out another caregiver''s shift';
  end if;
  if target_shift.status <> 'scheduled' then
    raise exception 'Only a scheduled shift can be called out';
  end if;

  select event_type into latest_event_type from public.shift_coverage_events
  where shift_id = target_shift.id
  order by created_at desc
  limit 1;

  if latest_event_type = 'called_out' then
    raise exception 'This shift already has an open call-out awaiting coverage';
  end if;

  insert into public.shift_coverage_events (
    organization_id, shift_id, event_type, original_caregiver_user_id, original_caregiver_record_id, actor_user_id, reason
  ) values (
    target_shift.organization_id, target_shift.id, 'called_out',
    target_shift.caregiver_user_id, target_shift.caregiver_record_id, auth.uid(), btrim(reason)
  ) returning id into event_id;

  offer_expiry := least(target_shift.starts_at, now() + interval '24 hours');

  for candidate in
    select m.caregiver_record_id
    from public._score_caregiver_matches(target_shift.organization_id, target_shift.client_id) m
    where m.caregiver_record_id is distinct from target_shift.caregiver_record_id
      and not exists (
        select 1 from public.shifts s2
        where s2.caregiver_record_id = m.caregiver_record_id
          and s2.status in ('scheduled', 'completed')
          and s2.id <> target_shift.id
          and s2.starts_at < target_shift.ends_at
          and s2.ends_at > target_shift.starts_at
      )
    order by m.match_score desc
    limit 5
  loop
    raw_token := encode(extensions.gen_random_bytes(32), 'hex');

    insert into public.shift_claim_tokens (
      organization_id, shift_id, caregiver_record_id, token_hash, expires_at
    ) values (
      target_shift.organization_id, target_shift.id, candidate.caregiver_record_id,
      encode(extensions.digest(raw_token, 'sha256'), 'hex'), offer_expiry
    );

    insert into public.domain_events (
      organization_id, event_type, aggregate_type, aggregate_id, payload, metadata, idempotency_key
    ) values (
      target_shift.organization_id,
      'shift.coverage_offer',
      'shift',
      target_shift.id::text,
      jsonb_build_object(
        'shift_id', target_shift.id,
        'client_id', target_shift.client_id,
        'caregiver_record_id', candidate.caregiver_record_id,
        'starts_at', target_shift.starts_at,
        'ends_at', target_shift.ends_at,
        'reason', btrim(reason),
        'claim_token', raw_token
      ),
      '{}'::jsonb,
      'shift_coverage_offer:' || target_shift.id || ':' || candidate.caregiver_record_id || ':' || event_id
    )
    on conflict (organization_id, idempotency_key) do nothing;
  end loop;

  return event_id;
end;
$function$;

-- get_shift_claim / claim_shift: anon-accessible, token-gated - same
-- trust model as get_candidate_portal / save_candidate_portal_profile.
-- No organization- or shift-wide data is ever exposed, only what the
-- one valid token's own row points to.
create or replace function public.get_shift_claim(target_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  token_row public.shift_claim_tokens;
  shift_row public.shifts;
  client_row public.clients;
  org_row public.organizations;
  latest_event_type public.shift_coverage_event_type;
  result jsonb;
begin
  select * into token_row
  from public.shift_claim_tokens
  where token_hash = encode(extensions.digest(target_token, 'sha256'), 'hex')
    and revoked_at is null
    and expires_at > now();

  if not found then raise exception 'This shift offer is no longer available.'; end if;

  select * into shift_row from public.shifts where id = token_row.shift_id;
  select * into client_row from public.clients where id = shift_row.client_id;
  select * into org_row from public.organizations where id = token_row.organization_id;

  select event_type into latest_event_type from public.shift_coverage_events
  where shift_id = shift_row.id order by created_at desc limit 1;

  select jsonb_build_object(
    'organization', jsonb_build_object('display_name', org_row.display_name),
    'client_name', client_row.first_name || ' ' || left(client_row.last_name, 1) || '.',
    'starts_at', shift_row.starts_at,
    'ends_at', shift_row.ends_at,
    'already_claimed', token_row.claimed_at is not null,
    'still_available', shift_row.status = 'scheduled' and latest_event_type = 'called_out' and token_row.claimed_at is null
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_shift_claim(text) from public;
grant execute on function public.get_shift_claim(text) to anon, authenticated;

create or replace function public.claim_shift(target_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  token_row public.shift_claim_tokens;
  shift_row public.shifts;
  latest_event_type public.shift_coverage_event_type;
  new_caregiver_user_id uuid;
begin
  select * into token_row
  from public.shift_claim_tokens
  where token_hash = encode(extensions.digest(target_token, 'sha256'), 'hex')
    and revoked_at is null
    and claimed_at is null
    and expires_at > now()
  for update;

  if not found then raise exception 'This shift offer is no longer available.'; end if;

  select * into shift_row from public.shifts where id = token_row.shift_id for update;
  if shift_row.status <> 'scheduled' then
    raise exception 'This shift is no longer available.';
  end if;

  select event_type into latest_event_type from public.shift_coverage_events
  where shift_id = shift_row.id order by created_at desc limit 1;
  if latest_event_type is distinct from 'called_out' then
    raise exception 'This shift has already been covered.';
  end if;

  select cr.linked_user_id into new_caregiver_user_id
  from public.caregiver_records cr
  where cr.id = token_row.caregiver_record_id
    and cr.organization_id = token_row.organization_id
    and cr.deleted_at is null
    and cr.status in ('active', 'ready');
  if not found then
    raise exception 'You are no longer eligible for this shift.';
  end if;

  insert into public.shift_coverage_events (
    organization_id, shift_id, event_type,
    original_caregiver_user_id, original_caregiver_record_id,
    replacement_caregiver_user_id, replacement_caregiver_record_id,
    actor_user_id, reason
  ) values (
    shift_row.organization_id, shift_row.id, 'reassigned',
    shift_row.caregiver_user_id, shift_row.caregiver_record_id,
    new_caregiver_user_id, token_row.caregiver_record_id,
    new_caregiver_user_id, 'Claimed via text message link'
  );

  update public.shifts
  set caregiver_user_id = new_caregiver_user_id,
      caregiver_record_id = token_row.caregiver_record_id
  where id = shift_row.id;

  update public.shift_claim_tokens set claimed_at = now() where id = token_row.id;

  -- First to claim wins - close out every other outstanding offer for
  -- this same shift so a second candidate can't also claim it.
  update public.shift_claim_tokens
  set revoked_at = now()
  where shift_id = shift_row.id and id <> token_row.id and claimed_at is null;

  insert into public.domain_events (
    organization_id, event_type, aggregate_type, aggregate_id, payload, metadata, idempotency_key
  ) values (
    shift_row.organization_id,
    'shift.assigned',
    'shift',
    shift_row.id::text,
    jsonb_build_object(
      'shift_id', shift_row.id,
      'client_id', shift_row.client_id,
      'caregiver_user_id', new_caregiver_user_id,
      'caregiver_record_id', token_row.caregiver_record_id,
      'starts_at', shift_row.starts_at,
      'ends_at', shift_row.ends_at
    ),
    '{}'::jsonb,
    'shift_claimed:' || shift_row.id || ':' || extract(epoch from now())::text
  )
  on conflict (organization_id, idempotency_key) do nothing;
end;
$$;

revoke all on function public.claim_shift(text) from public;
grant execute on function public.claim_shift(text) to anon, authenticated;

commit;
