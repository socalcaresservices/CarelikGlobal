begin;

-- Keep the workforce record as the scheduling source of truth. If it has a
-- linked login, derive the legacy user id from that record; never allow a shift
-- to pair one workforce record with another person's login.
create function public.normalize_shift_workforce_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_user uuid;
begin
  if new.caregiver_record_id is not null then
    select cr.linked_user_id into linked_user
    from public.caregiver_records cr
    where cr.id = new.caregiver_record_id
      and cr.organization_id = new.organization_id
      and cr.deleted_at is null;

    if not found then
      raise exception 'Care Team record not found in this organization';
    end if;
    new.caregiver_user_id := linked_user;
  end if;

  if new.caregiver_record_id is null and new.caregiver_user_id is null then
    raise exception 'A Care Team record or caregiver login is required';
  end if;
  return new;
end;
$$;

revoke all on function public.normalize_shift_workforce_identity() from public, anon, authenticated;

create trigger shifts_normalize_workforce_identity
before insert or update of organization_id, caregiver_record_id, caregiver_user_id
on public.shifts
for each row execute function public.normalize_shift_workforce_identity();

-- Every newly scheduled shift must identify a service that is authorized for
-- the same tenant/client on the shift date. This closes the UI/API gap where a
-- shift could be created successfully but could never enter verification.
create function public.validate_shift_authorization()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'scheduled' and not exists (
    select 1
    from public.client_authorizations a
    where a.organization_id = new.organization_id
      and a.client_id = new.client_id
      and a.service_id = new.service_id
      and new.starts_at::date between a.period_start and a.period_end
      and a.deleted_at is null
  ) then
    raise exception 'An active client authorization is required for the selected service and shift date';
  end if;
  return new;
end;
$$;

revoke all on function public.validate_shift_authorization() from public, anon, authenticated;

create trigger shifts_validate_authorization
before insert or update of organization_id, client_id, service_id, starts_at, status
on public.shifts
for each row execute function public.validate_shift_authorization();

-- A SECURITY DEFINER confirmation RPC must not let an administrator create a
-- caregiver attestation on someone else's behalf. Administrative corrections
-- remain available through the correction workflow and retain the original.
create function public.enforce_caregiver_attestation_actor()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.caregiver_attested_at is distinct from old.caregiver_attested_at
     and new.caregiver_attested_at is not null
     and auth.uid() is distinct from new.caregiver_user_id then
    raise exception 'Only the assigned caregiver can attest to this visit';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_caregiver_attestation_actor() from public, anon, authenticated;

create trigger service_visits_enforce_attestation_actor
before update of caregiver_attested_at on public.service_visits
for each row execute function public.enforce_caregiver_attestation_actor();

commit;
