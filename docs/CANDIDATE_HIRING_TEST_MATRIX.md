# Candidate Hiring V1 — Test Matrix

## Candidate intake

- Direct organization application creates a Candidate scoped to the correct organization.
- Indeed-style CSV preview recognizes common name/email/phone/job/date headers.
- ZipRecruiter-style CSV preview recognizes common header variants.
- Missing first name, last name, or email is reported as invalid.
- Existing email, normalized phone, or source record is reported as a possible duplicate.
- Import skips invalid/duplicate rows and inserts only new records.

## Pipeline

- Authorized staff can change Candidate stages.
- Unauthorized roles cannot change stages.
- Each stage change writes Candidate stage history.
- Rejected, withdrawn, and Care Team records cannot continue using candidate self-service writes.

## Candidate self-service

- Valid non-expired token resolves only its Candidate and organization branding.
- Expired/revoked token fails.
- Candidate can update structured address and work preferences.
- Candidate can submit multiple availability windows on one day.
- Candidate can add generic credentials with issue/expiration information.
- Staff-verified credential rows are not overwritten by later Candidate portal edits.

## Onboarding and credentials

- Staff can set onboarding status/date/method/location/instructions.
- Staff can record background-check and compliance status.
- Required credential library is organization configurable.
- Candidate credential verification is a manual staff action.

## Workforce transfer

- Authorized transfer creates one workforce record without requiring an auth account.
- Repeating transfer does not create a duplicate workforce record.
- Profile, availability, and credentials are carried into the workforce record.
- Workforce availability preserves multiple windows on the same day.
- A workforce record can later be linked to an active organization account.

## Tenant isolation

- Organization A cannot read Organization B Candidates, Candidate history, onboarding, credentials, portal tokens, workforce records, workforce availability, or workforce credentials.
- Organization A cannot update/delete Organization B rows.
- Public candidate token access returns only the Candidate represented by that token.

## Regression

- Existing Clients, Schedule, Credentials, Authorizations, Incidents, Access, Settings, Service Verification, and billing routes still render.
- Existing caregiver login-based workflows remain available until the workforce workspace fully replaces the legacy Team screen.
