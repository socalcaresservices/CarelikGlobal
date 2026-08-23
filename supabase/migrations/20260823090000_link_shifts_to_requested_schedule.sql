begin;

-- Scheduling audit's last item: client_requested_schedule (what a
-- client says they need, entered via replace_client_requested_schedule)
-- and shifts (what's actually booked) had no link between them - nothing
-- recorded which requested window, if any, a given shift was created to
-- fulfill. Shifts are created by a direct client-side insert
-- (schedule-page.tsx), not a template-expansion RPC, so this is wired in
-- at the data layer via a BEFORE INSERT trigger rather than requiring
-- every insert path (today's UI, any future one) to compute the link
-- itself - "business rules belong in the DB layer" per
-- docs/PRODUCT_CONSTITUTION.md.
--
-- Only auto-links when the match is unambiguous: same client, same
-- day-of-week, and a requested window that overlaps the shift's time of
-- day. Zero or multiple candidate requested-schedule rows leave the
-- column null rather than guessing - a client with two Monday morning
-- requests (both allowed, up to two windows/day) that happen to overlap
-- the same new shift shouldn't have one arbitrarily picked. INSERT-only,
-- not UPDATE: recomputing on every update would risk silently
-- overwriting an already-set link when call_out_shift/reassign_shift/
-- claim_shift update the row for an unrelated reason (coverage, not
-- rescheduling).
alter table public.shifts add column source_requested_schedule_id uuid
  references public.client_requested_schedule(id) on delete set null;

create index shifts_source_requested_schedule_idx
  on public.shifts (source_requested_schedule_id)
  where source_requested_schedule_id is not null;

create or replace function public.link_shift_to_requested_schedule()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  matched_id uuid;
  matched_count integer;
  shift_weekday public.weekday;
begin
  if new.source_requested_schedule_id is not null then
    return new;
  end if;

  shift_weekday := (array['monday','tuesday','wednesday','thursday','friday','saturday','sunday'])[extract(isodow from new.starts_at)::int]::public.weekday;

  select crs.id, count(*) over ()
  into matched_id, matched_count
  from public.client_requested_schedule crs
  where crs.organization_id = new.organization_id
    and crs.client_id = new.client_id
    and crs.day_of_week = shift_weekday
    and crs.start_time < new.ends_at::time
    and crs.end_time > new.starts_at::time
  limit 1;

  if matched_count = 1 then
    new.source_requested_schedule_id := matched_id;
  end if;

  return new;
end;
$function$;

create trigger shifts_link_requested_schedule
before insert on public.shifts
for each row execute function public.link_shift_to_requested_schedule();

commit;
