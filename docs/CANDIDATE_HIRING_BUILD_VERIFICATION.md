# Candidate Hiring V1 — Build Verification

This branch implements an administrative recruiting/onboarding workflow. Ogevia does not score, rank, recommend, select, or reject candidates automatically. Pipeline changes and credential verification are explicit actions by authorized organization staff.

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
- Candidate and workforce schema/unit tests.

## Required before production deployment

1. Run `pnpm typecheck`, `pnpm build`, and `pnpm test` in CI.
2. Apply and validate the new Supabase migrations in a non-production environment first.
3. Verify RLS with two organizations: cross-organization read/write/update/delete attempts must fail.
4. Tighten direct execution privileges on internal candidate-token helper RPCs before production.
5. Add a discoverable navigation entry for the new workforce workspace or complete the planned replacement of the legacy Team membership screen.
6. Add the administrative UI control that creates and shares a candidate self-service token; the public route exists, but this branch currently does not expose that control on Candidate Detail.
7. Perform end-to-end tests for CSV import, stage history, onboarding save, credential verification, candidate portal expiry/revocation, workforce transfer, and optional auth-account linking.

Do not merge or deploy this branch until the verification items above are complete.
