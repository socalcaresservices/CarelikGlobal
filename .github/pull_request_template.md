## What changed

## Why

<!-- The problem or requirement, with its source (owner request, defect, decision). -->

## Change type
- [ ] Feature
- [ ] Bug fix
- [ ] Migration (`infra/aws/db/migrations`)
- [ ] API route
- [ ] Dashboard or report
- [ ] Scheduling or recurrence
- [ ] Authorization or accounting
- [ ] Visits or service verification
- [ ] Availability or matching
- [ ] User administration or permissions
- [ ] Infrastructure (CDK)
- [ ] Documentation only (no file under `apps/`, `packages/`, `infra/`, `supabase/`, `.github/` or `netlify.toml`: skip the sections below)

## Release process
Every change follows [docs/TESTING_AND_RELEASE_PROCESS.md](../docs/TESTING_AND_RELEASE_PROCESS.md).
- [ ] Feature test plan: `docs/releases/<release-id>/FEATURE_TEST_PLAN.md` (link): ____________
- [ ] Release checklist started: `docs/releases/<release-id>/CHECKLIST.md` (link): ____________

## Phase A: validation run on this commit
Paste the summary line of each. A skipped test is a failed gate.
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `OGEVIA_TEST_DATABASE_URL=<local database> pnpm test:all`: unit and static tests, database tests and API tests, **0 skipped** (`pnpm test` alone runs none of the database or API tests)

Counts: ____________

- [ ] Bug fix: the reproducing test **failed before** the fix and **passes after** (say where the failure is recorded)
- [ ] Every changed rule has a test that fails without the change, and a control test for the nearest case that must not change
- [ ] Failure-first cases covered where they apply: invalid input, stale data, concurrent requests, retry, wrong role, other agency, old data

## Phase B: local harness
- [ ] Verified in the local harness (`pnpm --filter @carelik/infra-aws harness:setup`, `harness:build`, `harness:serve`); catalog IDs checked: ____________
- [ ] Screenshots saved under `docs/releases/<release-id>/evidence/` (before and after for a bug fix or rule change)
- [ ] N/A, with the reason (documentation-only or non-user-visible change): ____________

## Migrations (AWS: `infra/aws/db/migrations`)
- [ ] No migration in this change.
- [ ] A **new** numbered file only; no applied migration was edited.
- [ ] A matching `rollback/NNNN_*.down.sql` with a `-- ROLLBACK NNNN | CLASS:` header, and the rollback was run in the tests.
- [ ] `db/verification/01_schema_version.sql` and the ledger-tail tests (`readiness-restore`, `upgrade-*`) updated.
- [ ] **Contiguity:** deploying this migration also deploys every earlier migration that is not live yet. Those are: ____________ (each needs its own approval and validation).
- [ ] Destructive or data-rewriting change: separate written owner approval linked here, backup plan stated.
- [ ] Adds or changes a `SECURITY DEFINER` function, a `GRANT`/`REVOKE` or tenant access: [docs/security-review-checklist.md](../docs/security-review-checklist.md) completed, every box checked or explained.

## API routes
- [ ] No route change.
- [ ] Route added or changed in both `apps/sv-api/src/routes.ts` and the API stack route list, and `slice-contract.test.ts` passes.
- [ ] Permission, other-agency, unauthenticated, bad-input and (if it creates records) idempotency tests exist.

## Not part of this pull request
Merging does **not** deploy anything. Deployment is a separate, owner-approved step that needs Phase C (pilot/test validation), Phase D (user acceptance) and Phase E (owner GO) recorded in the release checklist. State here what is still outstanding: ____________

## Legacy Supabase build (`supabase/migrations/`)
- [ ] This PR does not touch `supabase/migrations/` (skip this section).
- [ ] It adds or modifies a `SECURITY DEFINER` function, an RLS policy, or a `GRANT`/`REVOKE`, and I completed [docs/security-review-checklist.md](../docs/security-review-checklist.md).
- [ ] It includes a new file in `supabase/migrations/` that still needs to be applied to the Supabase project after merge, and I've said which file and any manual step.
