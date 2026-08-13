# Ogevia Candidate Hiring V1

## Purpose

Build a human-controlled recruiting and onboarding workspace for care organizations. This module manages administrative workflow only. Ogevia must not automatically rank, select, reject, or recommend candidates for employment. Hiring decisions remain with authorized organization staff.

## Product naming

Under **People**, use these default labels:

- **Candidates** — people imported, referred, or applying for a role.
- **Clients** — people receiving services. Organizations may later customize this display label (for example Participant, Member, Individual, Patient, or Person Served) without changing the underlying entity.
- **Care Team** — caregivers/workforce records. Login/account administration remains under **Access**.

Keep existing route compatibility (`/applicants`, `/team`) while changing visible labels only.

## Candidate lifecycle

Default organization workflow:

1. Imported
2. Application Needed
3. Application Received
4. Screening
5. Interview
6. Conditional Offer
7. Hired / Onboarding Required
8. Onboarding Scheduled
9. Onboarding
10. Compliance Pending
11. Ready to Work
12. Care Team

Terminal/alternate states: On Hold, Rejected, Withdrawn.

Organizations must be able to rename/reorder/disable display stages later. V1 may use the default sequence, but stage changes are always explicit human actions. No automatic employment decisioning.

## Candidate source/import

Add actions to the Candidates page:

- Add Candidate
- Import Candidates
- Copy Application Link

Support universal CSV import from Indeed, ZipRecruiter, an agency website, referrals, or another ATS/export. The import flow must:

1. Ask for source: Indeed, ZipRecruiter, Referral, Agency Website, Manual, Other.
2. Parse common column names for first name, last name/full name, email, phone, position/job, applied date, and source candidate/application ID.
3. Show a preview before import.
4. Validate required fields.
5. Detect likely duplicates using normalized email, phone, and source record ID.
6. Never silently create duplicates. Show New / Possible duplicate / Invalid counts and let staff skip or review duplicates.
7. Preserve source, source record ID, original application date, imported date, and position applied for as structured reportable fields.

Do not parse resumes to score or rank people. A resume can be stored as a document only.

## Candidate secure portal

Authorized staff can create a revocable, expiring candidate link. The candidate does not need an Ogevia login to complete recruitment information.

Portal sections:

- Profile
- Contact/address
- Work preferences
- Availability
- Languages/skills
- Credentials/certifications
- Application information
- Requested documents
- Onboarding details when applicable

The portal link must be high-entropy, time-limited, revocable, organization-scoped, and must not expose other candidates or organization records.

## Availability

Availability is structured and reusable when the candidate becomes a caregiver.

Each weekday supports zero, one, or multiple time slots, for example:

- Monday 8:00 AM–12:00 PM
- Monday 3:00 PM–7:00 PM
- Tuesday 2:30 PM–8:00 PM

Each slot stores:

- day of week
- start time
- end time
- available/preferred

Portal UX:

- Add another time
- Remove time
- Copy this day to selected weekdays
- Clear day

Also store structured work preferences:

- earliest start date
- full-time / part-time / per diem / contractor where applicable
- desired, minimum, and maximum weekly hours
- minimum and maximum shift length
- max travel time
- transportation method
- reliable transportation
- valid driver's license where job-relevant
- vehicle available where job-relevant
- auto insurance where job-relevant
- willing to transport clients where the organization/service requires it

Only collect fields relevant to the role and organization policy.

## Credentials/certifications

Replace CPR/TB-only thinking with a generic candidate credential record. Starter examples can include CPR, First Aid, BLS, TB Clearance, Driver License, Auto Insurance, Vehicle Registration, professional license/certificate, and Other.

Each record stores:

- credential type
- status
- issue date
- expiration date
- does-not-expire flag
- issuing organization
- credential/license number
- document/request linkage when available
- verification status
- verified by
- verification date
- notes

The candidate may self-report/upload information through the secure portal. Staff verification is separate from candidate submission.

## Documents

Reuse the existing organization document-request engine. Staff can select one or more organization-configured document types and generate/send a secure upload link.

Candidate detail must show:

- requested
- uploaded
- pending review
- verified
- rejected
- replacement requested
- expired/missing

On rejection, reason is required. Preserve document history instead of overwriting it.

## Hiring/onboarding

When staff set the candidate to the hired/onboarding stage, show an onboarding checklist and allow staff to:

- choose/send onboarding document requests
- set onboarding date/time
- set onboarding location or meeting method
- add onboarding notes/instructions
- track completion status
- record background-check workflow after the appropriate hiring stage and in accordance with applicable law/policy
- track required compliance items before Ready to Work

Background-check information must not be used by Ogevia to automatically make an employment decision.

## Candidate detail layout

Use tabs or clear sections:

**Overview | Availability | Credentials | Documents | Onboarding | History**

Overview headline should include:

- candidate name
- stage/status
- source
- position
- applied date
- contact information
- desired hours
- available start date

Use compact status chips, progressive disclosure, and the same clean visual language as Shift Verification.

## Transfer to Care Team

The transfer must be one operational action from the hiring workflow and must not require re-keying data.

On transfer, preserve/copy:

- identity/contact data
- structured address
- availability including multiple slots/day
- desired work hours and shift preferences
- languages
- skills/services
- credentials and their dates/status
- relevant verified documents
- hiring/onboarding history linkage

The caregiver/workforce record and the authentication/login account are separate concepts. A hired caregiver record must be able to exist before the person accepts Ogevia login access. Account invitation/linking is a separate Access action.

Until that workforce-record separation is implemented in the schema, do not fake the transfer by creating duplicate applicant/member records. Keep a clear migration path from the current membership-based caregiver implementation.

## Reporting/filtering

Candidate data must be structured enough to answer:

- candidates by source
- candidates by stage
- candidates by position
- candidates by date range
- candidates with incomplete application
- candidates missing requested documents
- candidates with credentials expiring in a date range
- candidates available on a specific weekday/time window
- candidates by desired weekly hours
- candidates with onboarding scheduled in a date range
- source-to-hire conversion counts (descriptive reporting only; no automated ranking)

CSV export must use the current filtered view.

## Security/audit

- organization_id on every tenant-owned candidate record
- RLS on every candidate-related table
- staff permissions for read/update/import/document actions
- candidate portal access only through valid token-scoped RPCs
- no service-role key in browser code
- audit stage changes, onboarding changes, credential verification, document decisions, and transfer to Care Team
- retain original source/import metadata

## Acceptance tests

1. Import an Indeed CSV with new, duplicate, and invalid rows; duplicates are not silently inserted.
2. Import a ZipRecruiter CSV with different header names; mapped fields are correct.
3. Imported candidate receives a secure portal link and completes their profile without an Ogevia account.
4. Candidate adds two Monday availability windows and one Tuesday window; all persist independently.
5. Staff can request multiple documents in one action and review each upload.
6. Candidate credential expiration dates persist and are filterable.
7. Staff schedule onboarding and it appears on the candidate record.
8. Stage changes are human-controlled and audited.
9. Transfer to Care Team preserves availability, preferences, credentials, and document relationships without re-entry.
10. Candidate from Organization A cannot be viewed or edited by Organization B.

## Implementation order

1. Database/model migration for pipeline, source metadata, secure portal tokens, generic candidate credentials, and onboarding fields.
2. Candidate import parser + duplicate-safe import RPC/UI.
3. Candidate portal + multi-slot availability editor.
4. Candidate detail redesign + onboarding/document/credential sections.
5. Workforce caregiver separation and one-action transfer.
6. Reporting/filtering/export.
7. End-to-end and cross-tenant tests.

Do not merge frontend changes that depend on unapplied Supabase migrations. Apply database changes, test the full candidate flow in a non-production environment, then merge/deploy.
