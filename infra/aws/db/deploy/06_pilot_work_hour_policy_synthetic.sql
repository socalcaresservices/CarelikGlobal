-- SCS PILOT (synthetic organization ONLY) / work-hour policy fixture.
-- Gives the SYNTHETIC pilot organization (slug scs-pilot-synthetic) the same owner-approved policy as the agency: 8 hours a day, 40 hours a week,
-- no manager override (agency_work_hour_policies, migration 0060). It exists so the rule can be exercised end to end in the pilot/TEST database
-- before anything is activated for the real tenant (slug socal-care-services). It does NOT touch the real tenant's policy or any other organization.
--
-- Run as the RDS master user against the pilot/TEST database AFTER migration 0060 and AFTER 04_seed_scs_pilot_synthetic.sql:
--   psql ... -f 06_pilot_work_hour_policy_synthetic.sql
--
-- Safe to repeat: the policy table is append-only and keyed by (slug, version); a second run finds version 1 and writes nothing.
-- It refuses to run unless the synthetic pilot organization exists, and it only ever writes the synthetic slug.
\set ON_ERROR_STOP on
begin;

do $$
begin
  if not exists (select 1 from ogevia.organizations where slug = 'scs-pilot-synthetic') then
    raise exception 'The synthetic pilot organization (scs-pilot-synthetic) is not in this database; refusing to write a policy.';
  end if;
end $$;

insert into ogevia.agency_work_hour_policies (organization_slug, version, max_daily_minutes, max_weekly_minutes, effective_from, basis)
values ('scs-pilot-synthetic', 1, 480, 2400, now(),
        'SYNTHETIC pilot fixture mirroring the owner-approved SoCal Care Services limits (8 hours a day, 40 hours a week, no override). Not a live tenant.')
on conflict (organization_slug, version) do nothing;

-- Evidence: exactly one policy for the synthetic slug, and nothing for any other slug was written by this script.
select organization_slug, version, max_daily_minutes, max_weekly_minutes
from ogevia.agency_work_hour_policies
where organization_slug = 'scs-pilot-synthetic';

commit;
