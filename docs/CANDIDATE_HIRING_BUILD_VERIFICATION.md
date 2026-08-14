# Candidate Hiring V1 — Build Verification

This branch implements an administrative recruiting/onboarding workflow. Ogevia does not score, rank, recommend, select, or reject candidates automatically. Pipeline changes and credential verification are explicit actions by authorized organization staff.

**Audit result (2026-08-13): repository implementation is PR-ready.** Compilation and tests pass. Database security must still be validated after applying migrations in a non-production environment before merge or deployment.

## Implemented

- Candidate pipeline list with source/stage filtering and human-controlled stage changes.
- CSV import preview/import for common recruiting exports with duplicate detection.
- Candidate detail workspace with recruiting profile, stage history, availability, credential review, onboarding, and transfer to a workforce record.
- Public candidate portal component and `/candidate/:token` route for temporary-token self-service.
- Generic candidate credentials and organization-configurable credential requirements.
- Independent caregiver/workforce records that do not require an auth user.
- Workforce list/detail routes at `/workforce` and `/workforce/:id`.
- Workforce availability supports multiple time windows on the same day.
- Existing caregiver auth memberships are backfilled into workforce records by the migration.
- Candidate-to-workforce transfer preserves profile, availability, and credentials.
- Candidate documents use the existing secure document request/review component.
- People navigation is Candidates, Clients, and Care Team; `/team/:id` resolves workforce records.
- Internal candidate portal helper RPCs are not directly executable by `anon` or `authenticated` browser clients.
- Repository verification passes: `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test` (web 420, shared 118, UI 73, auth 10).

## Required before production deployment

1. Run the passing repository checks in CI and retain the results on the PR.
2. Apply all Candidate/Hiring migrations to a non-production Supabase environment in timestamp order.
3. Verify RLS with two organizations for cross-organization read/write/update/delete denial.
4. Perform database-backed end-to-end tests for import, history, onboarding, credentials, documents, portal expiry/revocation, transfer, and account linking.

Do not merge or deploy this branch until the verification items above are complete.
