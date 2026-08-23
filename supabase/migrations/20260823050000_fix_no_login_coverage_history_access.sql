begin;

-- shift_coverage_events.original_caregiver_record_id/
-- replacement_caregiver_record_id were added in 20260821090000
-- specifically so a no-login caregiver's call-outs/reassignments could
-- be recorded - shifts's own read RLS was updated in the same wave to
-- fall back to caregiver_records.linked_user_id, but this table's read
-- policy and list_shift_coverage_history() were never updated to match.
-- Net effect: a no-login caregiver who called out or was reassigned
-- into a shift cannot see their own coverage history, through either
-- the table directly or the RPC - only staff with shifts.read can. Not
-- a data leak (the opposite - an unintended access denial), but a real
-- scoping gap the scheduling audit flagged. Fixed by adding the same
-- caregiver_records.linked_user_id fallback shifts's own read policy
-- already uses.

drop policy "members_read_shift_coverage_events" on public.shift_coverage_events;
create policy "members_read_shift_coverage_events" on public.shift_coverage_events for select to authenticated
  using (
    has_permission(organization_id, 'shifts.read')
    or original_caregiver_user_id = (select auth.uid())
    or replacement_caregiver_user_id = (select auth.uid())
    or exists (
      select 1 from public.caregiver_records cr
      where cr.id = shift_coverage_events.original_caregiver_record_id
        and cr.organization_id = shift_coverage_events.organization_id
        and cr.linked_user_id = (select auth.uid())
    )
    or exists (
      select 1 from public.caregiver_records cr
      where cr.id = shift_coverage_events.replacement_caregiver_record_id
        and cr.organization_id = shift_coverage_events.organization_id
        and cr.linked_user_id = (select auth.uid())
    )
  );

create or replace function public.list_shift_coverage_history(target_shift_id uuid)
returns table (
  id uuid,
  event_type shift_coverage_event_type,
  original_caregiver_name text,
  replacement_caregiver_name text,
  actor_name text,
  reason text,
  created_at timestamptz
)
language sql
stable
security definer
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
      or exists (
        select 1 from public.caregiver_records cr
        where cr.id = e.original_caregiver_record_id
          and cr.organization_id = s.organization_id
          and cr.linked_user_id = auth.uid()
      )
      or exists (
        select 1 from public.caregiver_records cr
        where cr.id = e.replacement_caregiver_record_id
          and cr.organization_id = s.organization_id
          and cr.linked_user_id = auth.uid()
      )
    )
  order by e.created_at asc;
$function$;

commit;
