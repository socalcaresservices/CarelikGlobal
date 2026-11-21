-- READ-ONLY PREVIEW. Writes nothing to any real table: it only builds session-local temporary tables, then switches the transaction to READ ONLY before any report, and ends with ROLLBACK. Output uses client CODES and counts only: no names, no notes.
--   psql -X -At -F '|' -v org_slug=<agency slug, optional if the database has exactly one agency> -f PREVIEW_SCHEDULE_CLEAR.sql
-- Question answered: if the schedule is cleared as described, what would be cancelled, what stays in history, and what changes in the recurring series and authorizations?
--   WINDOW A  November 2026 (agency-local dates 2026-11-01 .. 2026-11-30)       WINDOW B  2026-12-01 onward
-- CLEAR (planned: ogevia_api.cancel_shift, one shift at a time, with a reason): status 'scheduled', no linked visit (voided and corrected visits do not count), not from a Care Request.
-- STAYS: any shift with a visit record, or status completed / no_show (history). A shift already cancelled is left as it is.
-- CARE REQUEST shifts cannot be cancelled with cancel_shift (the app sends them to the Care Requests page); they are listed separately.
\set ON_ERROR_STOP on
\if :{?org_slug}
\else
  \set org_slug ''
\endif
begin;
create temp table _org on commit drop as
  select o.id, o.timezone from ogevia.organizations o where (:'org_slug' = '' and (select count(*) from ogevia.organizations) = 1) or o.slug = :'org_slug';
do $$ begin if (select count(*) from _org) <> 1 then raise exception 'Name the agency: pass -v org_slug=<slug> (found % matching agencies)', (select count(*) from _org); end if; end $$;
create temp table _s on commit drop as
  select s.id, s.series_id, s.status::text as status, s.starts_at, s.ends_at, (s.starts_at at time zone o.timezone)::date as d, s.client_id, c.client_code, s.caregiver_record_id is not null as has_caregiver,
         case when (s.starts_at at time zone o.timezone)::date between date '2026-11-01' and date '2026-11-30' then 'A November 2026'
              when (s.starts_at at time zone o.timezone)::date >= date '2026-12-01' then 'B December 1 onward' end as win,
         ogevia.shift_is_care_request(s.id) as care_request,
         exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected')) as has_visit
  from ogevia.shifts s join _org o on o.id = s.organization_id join ogevia.clients c on c.id = s.client_id;
create temp table _v on commit drop as
  select v.id as visit_id, v.scheduled_shift_id as shift_id, v.visit_number_snapshot as visit_number, v.status::text as vstatus, v.worked_minutes, v.verified_minutes, v.billable_minutes,
         exists (select 1 from ogevia.billing_approvals b where b.visit_id = v.id and b.voided_at is null) as billing_approved
  from ogevia.service_visits v where v.status not in ('voided', 'corrected');
create temp table _plan on commit drop as
  select s.*, case when s.win is null then 'outside the window'
                    when s.status = 'cancelled' then 'already cancelled'
                    when s.status = 'scheduled' and not s.has_visit and s.care_request then 'CARE REQUEST shift (separate path)'
                    when s.status = 'scheduled' and not s.has_visit then 'CLEAR (cancel)'
                    else 'STAYS in history' end as outcome
  from _s s;

set transaction read only;
\echo === 1. WHAT WOULD HAPPEN, by window (shift counts) ===
select win, outcome, count(*) from _plan where win is not null group by 1, 2 order by 1, 2;
\echo === 2. CLEAR: past dates vs future dates (agency date today: shown first) ===
select 'agency today', (now() at time zone (select timezone from _org))::date;
select win, case when d < (now() at time zone (select timezone from _org))::date then 'past (unworked, never started)' else 'today or later' end as when_, count(*) from _plan where outcome = 'CLEAR (cancel)' group by 1, 2 order by 1, 2;
\echo === 3. STAYS in history: by visit status and billing (nothing here is changed) ===
select p.win, coalesce(v.vstatus, '(no visit; shift status ' || p.status || ')') as visit_or_shift, case when v.billing_approved then 'billing approved' else 'not billing approved' end as billing, count(*) as shifts
  from _plan p left join _v v on v.shift_id = p.id where p.outcome = 'STAYS in history' and p.win is not null group by 1, 2, 3 order by 1, 2, 3;
\echo === 4. STAYS: visit records that appear on the November schedule today (visit number | date | client code | visit status | worked/verified/billable minutes | billing approved) ===
select v.visit_number, p.d, p.client_code, v.vstatus, coalesce(v.worked_minutes::text, '-') || '/' || coalesce(v.verified_minutes::text, '-') || '/' || coalesce(v.billable_minutes::text, '-'), v.billing_approved
  from _plan p join _v v on v.shift_id = p.id where p.outcome = 'STAYS in history' and p.win is not null order by p.d, p.client_code, v.visit_number;
\echo === 5. NEED YOUR DECISION: shifts that stay but are not closed (visit in review, or a past shift with no visit and an open status such as completed/no_show without a visit) ===
select p.win, p.status, coalesce(v.vstatus, 'no visit'), count(*) from _plan p left join _v v on v.shift_id = p.id
 where p.outcome = 'STAYS in history' and p.win is not null and (v.vstatus in ('draft', 'awaiting_signature', 'administrator_review') or v.shift_id is null) group by 1, 2, 3 order by 1, 2, 3;
\echo === 6. CARE REQUEST shifts that would NOT be cleared by the plan (cancel them from the Care Requests page): count by window ===
select win, count(*) from _plan where outcome like 'CARE REQUEST%' group by 1 order by 1;
\echo === 7. RECURRING SERIES: what each active series would do (id prefix | client code | starts | ends | generated through | shifts to clear | shifts kept | after: ends on / status) ===
select left(r.id::text, 8), c.client_code, r.starts_on, coalesce(r.ends_on::text, 'open'), r.generated_through,
       (select count(*) from _plan p where p.series_id = r.id and p.outcome = 'CLEAR (cancel)'),
       (select count(*) from _plan p where p.series_id = r.id and p.outcome = 'STAYS in history' and p.win is not null),
       case when r.starts_on >= date '2026-11-01' then 'ended entirely (starts in/after November)' else 'ends on 2026-10-31 (earlier shifts untouched)' end
  from ogevia.shift_series r join _org o on o.id = r.organization_id join ogevia.clients c on c.id = r.client_id
 where r.status = 'active' and coalesce(r.ends_on, date '9999-12-31') >= date '2026-11-01' order by c.client_code, r.starts_on;
select 'active series that would NOT be touched (already end before November)', count(*) from ogevia.shift_series r join _org o on o.id = r.organization_id where r.status = 'active' and r.ends_on < date '2026-11-01';
\echo === 8. AUTHORIZED HOURS: unchanged. RESERVATIONS that would be released by the clear (reserved time only returns to the authorization) ===
select count(*) as active_reservations_released, coalesce(sum(r.reserved_minutes), 0) as minutes_released, round(coalesce(sum(r.reserved_minutes), 0) / 60.0, 1) as hours_released
  from ogevia.authorization_reservations r join _plan p on p.id = r.shift_id where p.outcome = 'CLEAR (cancel)' and r.released_at is null;
\echo === 9. OTHER RECORDS ON THE SHIFTS TO CLEAR (kept as history; shown so nothing surprises you) ===
select 'pending open-shift pickup requests (closed when the shift is cancelled)', count(*) from ogevia.shift_pickup_requests q join _plan p on p.id = q.shift_id where p.outcome = 'CLEAR (cancel)' and q.status::text = 'pending';
select 'shifts to clear that were called out by the caregiver', count(distinct e.shift_id) from ogevia.shift_coverage_events e join _plan p on p.id = e.shift_id where p.outcome = 'CLEAR (cancel)' and e.event_type = 'called_out';
select 'shifts to clear that are make-up shifts', count(*) from ogevia.shifts s join _plan p on p.id = s.id where p.outcome = 'CLEAR (cancel)' and s.makeup_for_shift_id is not null;
\echo === 10. CLIENTS, CAREGIVERS, AUTHORIZATIONS: not touched. Counts for the record ===
select (select count(*) from ogevia.clients c join _org o on o.id = c.organization_id) as clients, (select count(*) from ogevia.caregiver_records c join _org o on o.id = c.organization_id where c.deleted_at is null) as caregivers,
       (select count(*) from ogevia.client_authorizations a join _org o on o.id = a.organization_id) as authorizations;
\echo === PAYROLL: Ogevia has no payroll records, so nothing here is payroll-linked inside Ogevia. If payroll is run elsewhere from these hours, that system keeps its own copy. ===
rollback;
