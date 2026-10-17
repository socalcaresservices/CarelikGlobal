-- READ ONLY. Activation preview for caregiver compliance and readiness enforcement. It changes NOTHING: the whole script runs in a read-only transaction and
-- ends with ROLLBACK. It does not activate enforcement, open a hold, flag a shift, send a message or write an audit row.
--
--   psql ... -v org_slug=socal-care-services -f enforcement_activation_preview.sql          (production owner, after the checklist is approved)
--   psql ... -v org_slug=scs-pilot-synthetic -f enforcement_activation_preview.sql          (the synthetic pilot)
--
-- Output contains caregiver codes, client codes and shift ids only. No names, no payer or member identifiers. Keep the output out of tickets and chat.
-- Reasons use the same functions the enforcement itself uses (compliance_blockers, readiness_checks, shift_document_risks, hour_limit_issue_range), so what is
-- listed here is what would happen at the moment the owner activates, as of now. Time passes: re-run it immediately before activation.
\set ON_ERROR_STOP on
begin read only;

\echo '== A. Organization, enforcement and work-hour policy =='
select o.slug, o.timezone,
       s.enforcement_active_from,
       coalesce(s.enforcement_active_from <= now(), false) as enforcement_active_now,
       (select concat(round(p.max_daily_minutes / 60.0, 1), ' h/day, ', round(p.max_weekly_minutes / 60.0, 1), ' h/week (policy v', p.version, ')')
          from ogevia.work_hour_policy(o.id) p) as work_hour_policy
from ogevia.organizations o
left join ogevia.organization_readiness_settings s on s.organization_id = o.id
where o.slug = :'org_slug';

\echo '== B. Caregivers who WOULD be placed on a compliance hold at activation (Ready/Active, at least one blocking requirement) =='
select r.caregiver_code, r.status::text as caregiver_status, r.hire_date, b.requirement, b.code, b.due_date
from ogevia.organizations o
join ogevia.caregiver_records r on r.organization_id = o.id and r.deleted_at is null and r.status in ('ready', 'active')
cross join lateral ogevia.compliance_blockers(o.id, r.id) b
where o.slug = :'org_slug' and b.blocking
order by r.caregiver_code, b.requirement;

\echo '== C. Future scheduled shifts that a hold would flag (caregivers in B). Nothing is cancelled or moved by activation. =='
select r.caregiver_code, sh.id as shift_id, sh.starts_at, sh.ends_at, c.client_code, (sh.starts_at <= now()) as in_progress_now
from ogevia.organizations o
join ogevia.caregiver_records r on r.organization_id = o.id and r.deleted_at is null and r.status in ('ready', 'active')
join ogevia.shifts sh on sh.organization_id = o.id and sh.status = 'scheduled' and sh.ends_at > now() and sh.caregiver_record_id = r.id
left join ogevia.clients c on c.id = sh.client_id
where o.slug = :'org_slug' and not ogevia.shift_is_called_out(sh.id)
  and exists (select 1 from ogevia.compliance_blockers(o.id, r.id) b where b.blocking)
order by r.caregiver_code, sh.starts_at;

\echo '== D. Standing assignments a hold would flag =='
select r.caregiver_code, ca.id as assignment_id, c.client_code, ca.effective_start, ca.effective_end
from ogevia.organizations o
join ogevia.caregiver_records r on r.organization_id = o.id and r.deleted_at is null and r.status in ('ready', 'active')
join ogevia.caregiver_assignments ca on ca.organization_id = o.id and ca.is_active and (ca.effective_end is null or ca.effective_end >= current_date)
     and (ca.caregiver_record_id = r.id or (ca.caregiver_record_id is null and ca.caregiver_user_id = r.linked_user_id))
left join ogevia.clients c on c.id = ca.client_id
where o.slug = :'org_slug' and exists (select 1 from ogevia.compliance_blockers(o.id, r.id) b where b.blocking)
order by r.caregiver_code, ca.effective_start;

\echo '== E. Visits IN PROGRESS for those caregivers. Activation never ends a visit; the office is alerted to arrange safe coverage. =='
select r.caregiver_code, v.id as visit_id, v.time_in, c.client_code
from ogevia.organizations o
join ogevia.caregiver_records r on r.organization_id = o.id and r.deleted_at is null and r.status in ('ready', 'active')
join ogevia.service_visits v on v.organization_id = o.id and v.status = 'draft' and v.time_out is null
     and (v.caregiver_record_id = r.id or (v.caregiver_record_id is null and v.caregiver_user_id = r.linked_user_id))
left join ogevia.clients c on c.id = v.client_id
where o.slug = :'org_slug' and exists (select 1 from ogevia.compliance_blockers(o.id, r.id) b where b.blocking)
order by r.caregiver_code, v.time_in;

\echo '== F. Scheduled shifts where CPR/TB is expired or expires during the shift (not necessarily a hold yet) =='
select r.caregiver_code, x.shift_id, x.starts_at, x.ends_at, x.requirement, x.document_status, x.valid_until, x.in_progress, x.on_hold
from ogevia.organizations o
cross join lateral ogevia.shift_document_risks(o.id) x
join ogevia.caregiver_records r on r.id = x.caregiver_record_id
where o.slug = :'org_slug'
order by x.starts_at, r.caregiver_code, x.requirement;

\echo '== G. Future scheduled shifts the general readiness gate would block today (documents, availability, other checks; service approvals excluded as in the activation count) =='
select r.caregiver_code, sh.id as shift_id, sh.starts_at, k.check_name, k.code
from ogevia.organizations o
join ogevia.shifts sh on sh.organization_id = o.id and sh.status = 'scheduled' and sh.starts_at > now() and sh.caregiver_record_id is not null
join ogevia.caregiver_records r on r.id = sh.caregiver_record_id
cross join lateral ogevia.readiness_checks(o.id, sh.caregiver_record_id, sh.service_id, sh.starts_at, sh.ends_at, 'shift') k
where o.slug = :'org_slug' and not ogevia.shift_is_called_out(sh.id) and k.status = 'blocked' and k.check_name <> 'service'
order by r.caregiver_code, sh.starts_at, k.check_name;

\echo '== H. Future scheduled shifts already over the work-hour policy (counted at scheduled duration; see the scope note in the activation checklist) =='
select r.caregiver_code, sh.id as shift_id, sh.starts_at, sh.ends_at,
       ogevia.hour_limit_issue_range(o.id, sh.caregiver_record_id, sh.starts_at, sh.ends_at, sh.id) as hour_limit_issue
from ogevia.organizations o
join ogevia.shifts sh on sh.organization_id = o.id and sh.status = 'scheduled' and sh.ends_at > now() and sh.caregiver_record_id is not null
join ogevia.caregiver_records r on r.id = sh.caregiver_record_id
where o.slug = :'org_slug' and ogevia.hour_limit_issue_range(o.id, sh.caregiver_record_id, sh.starts_at, sh.ends_at, sh.id) is not null
order by r.caregiver_code, sh.starts_at;

\echo '== I. Totals =='
with org as (select id from ogevia.organizations where slug = :'org_slug'),
held as (
  select r.id from org o join ogevia.caregiver_records r on r.organization_id = o.id and r.deleted_at is null and r.status in ('ready', 'active')
  where exists (select 1 from ogevia.compliance_blockers(o.id, r.id) b where b.blocking))
select (select count(*) from org o join ogevia.caregiver_records r on r.organization_id = o.id and r.deleted_at is null and r.status in ('ready', 'active')) as ready_or_active_caregivers,
       (select count(*) from held) as caregivers_that_would_be_held,
       (select count(*) from held h join ogevia.shifts sh on sh.caregiver_record_id = h.id and sh.status = 'scheduled' and sh.ends_at > now() and not ogevia.shift_is_called_out(sh.id)) as shifts_flagged,
       (select count(*) from held h join ogevia.service_visits v on (v.caregiver_record_id = h.id) and v.status = 'draft' and v.time_out is null) as visits_in_progress;
rollback;
