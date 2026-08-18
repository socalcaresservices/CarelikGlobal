begin;

-- Follow-up to 20260818010000_enforce_organization_status_in_has_permission.sql,
-- flagged as a known residual gap in that migration. That fix closed the
-- gap for every policy gated purely by has_permission(), but four SELECT
-- policies grant read access via "has_permission(...) or <self column> =
-- auth.uid()" - a caregiver reading their own single row. That
-- self-referential branch never calls has_permission() at all, so it
-- was never touched by the org-status check and still lets a caregiver
-- in a suspended org read their own workforce record, availability, or
-- credentials. Lower severity than the gap already closed (no write
-- access, no visibility into anyone else's data), but the same
-- underlying bug: organizations.status not actually enforced.
create or replace function public.organization_is_active(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organizations
    where id = target_organization_id
      and status = 'active'
  );
$$;

revoke all on function public.organization_is_active(uuid) from public, anon;
grant execute on function public.organization_is_active(uuid) to authenticated;

drop policy if exists members_read_availability on public.caregiver_availability;
create policy members_read_availability
on public.caregiver_availability for select
to authenticated
using (
  public.has_permission(organization_id, 'membership.read')
  or (caregiver_user_id = auth.uid() and public.organization_is_active(organization_id))
);

drop policy if exists authorized_read_caregiver_records on public.caregiver_records;
create policy authorized_read_caregiver_records
on public.caregiver_records for select
to authenticated
using (
  deleted_at is null and (
    public.has_permission(organization_id, 'membership.read')
    or (linked_user_id = auth.uid() and public.organization_is_active(organization_id))
  )
);

drop policy if exists authorized_read_caregiver_record_availability on public.caregiver_record_availability;
create policy authorized_read_caregiver_record_availability
on public.caregiver_record_availability for select
to authenticated
using (
  public.has_permission(organization_id, 'membership.read')
  or (
    public.organization_is_active(organization_id)
    and exists (
      select 1 from public.caregiver_records cr
      where cr.id = caregiver_record_availability.caregiver_record_id and cr.linked_user_id = auth.uid()
    )
  )
);

drop policy if exists authorized_read_caregiver_record_credentials on public.caregiver_record_credentials;
create policy authorized_read_caregiver_record_credentials
on public.caregiver_record_credentials for select
to authenticated
using (
  deleted_at is null and (
    public.has_permission(organization_id, 'credentials.read')
    or (
      public.organization_is_active(organization_id)
      and exists (
        select 1 from public.caregiver_records cr
        where cr.id = caregiver_record_credentials.caregiver_record_id and cr.linked_user_id = auth.uid()
      )
    )
  )
);

commit;
