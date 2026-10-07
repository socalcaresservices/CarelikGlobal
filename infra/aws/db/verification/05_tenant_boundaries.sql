-- READ ONLY. Every child row belongs to its parent's organization.
select 'visits_client_same_org' as check_name, count(*) = 0 as ok, 'violations=' || count(*) as detail
from ogevia.service_visits v join ogevia.clients c on c.id = v.client_id
where c.organization_id <> v.organization_id
union all
select 'visits_authorization_same_org', count(*) = 0, 'violations=' || count(*)
from ogevia.service_visits v join ogevia.client_authorizations a on a.id = v.service_authorization_id
where a.organization_id <> v.organization_id or a.client_id <> v.client_id or a.service_id <> v.service_id
union all
select 'evidence_same_org_as_visit', count(*) = 0, 'violations=' || count(*)
from ogevia.visit_evidence e join ogevia.service_visits v on v.id = e.visit_id
where e.organization_id <> v.organization_id
union all
select 'confirmations_same_org_as_visit', count(*) = 0, 'violations=' || count(*)
from ogevia.visit_confirmations c join ogevia.service_visits v on v.id = c.visit_id
where c.organization_id <> v.organization_id
union all
select 'corrections_same_org', count(*) = 0, 'violations=' || count(*)
from ogevia.visit_corrections k
join ogevia.service_visits o on o.id = k.original_visit_id
join ogevia.service_visits n on n.id = k.corrected_visit_id
where o.organization_id <> k.organization_id or n.organization_id <> k.organization_id
union all
select 'assignments_same_org', count(*) = 0, 'violations=' || count(*)
from ogevia.caregiver_assignments ca join ogevia.clients c on c.id = ca.client_id
where c.organization_id <> ca.organization_id
union all
select 'visit_caregiver_is_org_member', count(*) = 0, 'violations=' || count(*)
from ogevia.service_visits v
where v.caregiver_user_id is not null
  and not exists (select 1 from ogevia.organization_memberships m
                  where m.organization_id = v.organization_id and m.user_id = v.caregiver_user_id);
