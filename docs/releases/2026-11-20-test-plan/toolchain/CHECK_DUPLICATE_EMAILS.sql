-- READ-ONLY (TEST): lists email addresses that more than one caregiver or staff member holds in the same agency. Writes nothing.
--   bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -f CHECK_DUPLICATE_EMAILS.sql
-- Addresses are masked (first letter + domain). Migration 0121 stops NEW duplicates; this finds the existing ones so the office can fix them by hand.
\set ON_ERROR_STOP on
begin read only;
with a as (
  select organization_id, lower(btrim(contact_email)) as em, 'caregiver contact' as kind, caregiver_record_id::text as who from ogevia.caregiver_contacts where nullif(btrim(contact_email), '') is not null
  union all select organization_id, lower(btrim(email)), 'caregiver invitation', caregiver_record_id::text from ogevia.caregiver_invitations
  union all select organization_id, lower(btrim(contact_email)), 'staff contact', id::text from ogevia.staff_profiles where nullif(btrim(contact_email), '') is not null
  union all select organization_id, lower(btrim(login_email)), 'staff sign-in', id::text from ogevia.staff_profiles where nullif(btrim(login_email), '') is not null
)
select left(em, 1) || '***@' || split_part(em, '@', 2) as masked, count(distinct who) as people, string_agg(distinct kind, ', ') as used_as, organization_id
  from a group by organization_id, em having count(distinct who) > 1 order by 2 desc;
rollback;
