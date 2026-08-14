# Candidate Hiring V1 — Draft Release Notes

Candidate Hiring V1 expands Ogevia's administrative people workflow from a basic applicant list into a recruiting, onboarding, credential, and workforce-record foundation.

The release adds candidate source tracking, CSV import with duplicate preview, a human-controlled pipeline, onboarding records, generic credential tracking, temporary-token candidate self-service, independent caregiver/workforce records, and a transfer action that carries existing candidate information into the workforce record.

No automated employment decisioning is included. Ogevia does not rank, score, recommend, select, or reject candidates. Authorized organization staff make and record all recruiting and onboarding decisions.

Repository implementation is complete and checks pass. Staff manual intake, portal-link management, requested-document access, onboarding/document transfer continuity, workforce editing, and filtered CSV export are included. Release remains gated on applying the migrations to a non-production Supabase project, running database-backed end-to-end tests, and verifying two-organization tenant isolation before merge or production deployment.
