begin;

-- Lightweight "Requirements" capture at application time: TB test and
-- CPR expiration dates (if the applicant already holds current certs)
-- and a background-check consent flag. Deliberately narrow - this is
-- NOT the credentials subsystem (no document upload, no per-agency
-- configurable credential list, no verification workflow). Those stay
-- staff-side, tracked in caregiver_credentials after hire. These three
-- fields exist because an agency needs to know them before it can even
-- schedule an interview, so asking at intake avoids a second round-trip
-- with the applicant.
--
-- background_check_consent defaults to false and isn't constrained to
-- true by the database - the form enforces it as a required checkbox
-- (same "derive UI requirements in the UI layer, not by over-fitting
-- the schema" pattern used elsewhere in this table), so a staff member
-- editing a record directly isn't blocked from correcting it.

alter table public.job_applicants
  add column tb_test_expires_at date,
  add column cpr_expires_at date,
  add column background_check_consent boolean not null default false;

commit;
