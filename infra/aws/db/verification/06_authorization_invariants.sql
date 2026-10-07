-- READ ONLY. Authorization versioning (Phase 0 M-1) invariants.
select 'no_overlapping_current_authorizations' as check_name, count(*) = 0 as ok, 'pairs=' || count(*) as detail
from ogevia.client_authorizations a
join ogevia.client_authorizations b
  on a.id < b.id and a.organization_id = b.organization_id and a.client_id = b.client_id
 and a.service_id = b.service_id and a.is_current and b.is_current
 and a.deleted_at is null and b.deleted_at is null
 and daterange(a.period_start, a.period_end, '[]') && daterange(b.period_start, b.period_end, '[]')
union all
select 'at_most_one_current_version_per_lineage', count(*) = 0, 'lineages=' || count(*)
from (select lineage_id from ogevia.client_authorizations where is_current and deleted_at is null
      group by lineage_id having count(*) > 1) x
union all
select 'superseded_versions_are_linked', count(*) = 0, 'unlinked=' || count(*)
from ogevia.client_authorizations
where not is_current and superseded_by_id is null
union all
select 'version_numbers_contiguous', count(*) = 0, 'lineages=' || count(*)
from (select lineage_id from ogevia.client_authorizations
      group by lineage_id having max(version_number) <> count(*)) x
union all
select 'supersede_links_stay_in_lineage', count(*) = 0, 'violations=' || count(*)
from ogevia.client_authorizations a join ogevia.client_authorizations p on p.id = a.supersedes_id
where p.lineage_id <> a.lineage_id or p.version_number <> a.version_number - 1
-- Informational (always ok): months where lineage usage exceeds the CURRENT cap.
-- Legitimate after a retroactive decrease; each needs human review.
union all
select 'info:lineage_months_over_current_cap', true, 'count=' || count(*)
from (
  select a.lineage_id, date_trunc('month', v.service_date) as m, sum(v.billable_minutes) as used
  from ogevia.service_visits v join ogevia.client_authorizations a on a.id = v.service_authorization_id
  where v.status in ('signed', 'administrator_review')
  group by 1, 2
) u
join ogevia.client_authorizations cur on cur.lineage_id = u.lineage_id and cur.is_current
where u.used > cur.monthly_authorized_minutes;
