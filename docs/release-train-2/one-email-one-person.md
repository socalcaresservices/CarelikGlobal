# 0121: one email, one person (TEST, PROPOSED, NOT DEPLOYED)

**Why.** 2026-11-27 TEST: the caregiver TEST-CG-01's contact email was first the admin's address, then `footietree@gmail.com`, which also existed as a separate sign-in. Alerts follow the caregiver's linked sign-in and go to the contact address, so alerts and sign-ins could point at different people with no warning. The owner's rule: an email must never belong to more than one caregiver or staff member.

**What it does.** Migration `0121_one_email_one_person.sql` adds `ogevia.email_used_by_other()` and calls it in the five places an address enters the system: `set_caregiver_contact`, `begin_caregiver_invitation`, `begin_staff_invitation`, `create_staff`, `update_staff`. It checks, per agency, case-insensitively: caregiver contact addresses, caregiver invitation addresses, staff contact addresses and staff sign-in addresses. A clash returns HTTP 409 with "That email is already used by someone else in this agency. Each person needs their own email." The message never names the other person. Another agency using the same address is not a clash. Only NEW writes are checked: existing rows are not changed or blocked.

**Database only.** No API, web or CloudFormation change: the functions are replaced in place and the API already maps the error to 409. Production is not touched.

**Verified (local PostgreSQL 16, synthetic data):** `infra/aws/db/test/one-email-0121.db.test.ts`, 7 of 7 pass (refusals in every direction, own address re-save, other agency allowed, VERIFY_PENDING present/absent, masked duplicate report, rollback). Lint passes. NOT verified: TEST database, any phone or browser.

**Deploy to TEST (needs the owner's go; a fresh RDS snapshot first, as for 0120).**
1. `bash TEST_PENDING_LEDGER.sh probe 0121` (read-only).
2. `OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_TEST_SNAPSHOT=<fresh snapshot id> bash TEST_PENDING_LEDGER.sh apply 0121`.
3. `bash TEST_PENDING_LEDGER.sh verify 0121`.
Find existing shared addresses (read-only): `bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -f CHECK_DUPLICATE_EMAILS.sql`.

**Rollback.** `OGEVIA_DEPLOY_APPROVAL=<ref> bash TEST_PENDING_LEDGER.sh rollback 0121` restores the five previous function bodies and drops the helper, atomically with the ledger row.

**Numbering.** 0121 is taken here. PR #125's NFC/QR migration also uses 0120 and must be renumbered to 0122 or later when it follows #124.
