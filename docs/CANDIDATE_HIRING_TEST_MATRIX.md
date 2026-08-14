# Candidate Hiring V1 — Test Matrix

## Definition of Done status (audited 2026-08-13)

Legend: **Pass** = covered by repository evidence/tests; **Partial** = implementation exists but its complete workflow is not covered; **Open** = required implementation is missing; **Unverified** = requires an applied non-production Supabase environment.

- **Pass:** `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test` complete successfully. Test totals: web 420, shared 118, UI 73, auth 10.
- **Pass:** Candidates, Clients, and Care Team navigation/routes; independent workforce records; legacy route aliases; CSV preview/duplicate classification; explicit stage changes; candidate detail; and workforce list tests.
- **Partial:** candidate portal, onboarding, credential verification, document request/review, transfer, and account linking exist without complete database-backed end-to-end coverage.
- **Pass:** manual staff candidate creation, staff token-link management, portal links to requested-document upload, onboarding/document continuity after transfer, filtered CSV export, and workforce profile/availability/credential editing are implemented.
- **Unverified:** live token expiry/revocation, role denial paths, migration application, and cross-organization read/write/update/delete isolation.

The repository Definition of Done is met. Deployment Definition of Done remains conditional on every Unverified database-backed item passing in a non-production environment.

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
