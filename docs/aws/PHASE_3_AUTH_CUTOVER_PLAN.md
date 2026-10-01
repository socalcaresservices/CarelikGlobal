# Phase 3: Authentication Cutover Plan

Production remains on **Supabase Auth** until every gate below passes. Nothing here has been executed.

## Stages

| Stage | What | Gate to proceed | Rollback |
| --- | --- | --- | --- |
| 0 (done) | Cognito adapter, PKCE, server principal, DB bridge, tests | Phase 3 tests green | n/a |
| 1 (test slice) | Deploy the WebHosting stack (new test client + CloudFront) and the API; 2 synthetic sign-ins; synthetic data in `ogevia_sv_test` | Owner browser test passes (see `TEST_SLICE_DEPLOYMENT_APPROVAL.md` §6) | Delete the test client (stack), disable the test users; production unaffected |
| 2 | Phase 7 security/cost gate (BAA, CSP review, alarms, budget, backup/restore drill) | Signed-off | n/a |
| 3 | Fix `ogevia-web` (D-P1-2): callback `https://app.ogevia.com/auth/callback`, logout `https://app.ogevia.com/`, remove `ALLOW_USER_AUTH`, refresh 12 h | Applied in a change window | Re-apply the recorded previous values (`cognito-target.ts` CURRENT) |
| 4 | Migrate users (Option B) and link `cognito_sub` | Dry run has 0 BLOCKED rows; owner approval | AdminDisableUser + unlink |
| 5 | Build the production web with `VITE_AUTH_PROVIDER=cognito` and the production API; deploy to the approved host | Smoke + pilot users OK | Redeploy the previous Supabase build (the flag is build-time; the Supabase path is unchanged) |
| 6 | Retire Supabase Auth | ≥ 30 days stable; data migration accepted | n/a (gate) |

## Invariants during cutover

- One identity per person, with no shared logins.
- `sub` is the only identity input to the database.
- Roles and organizations come only from PostgreSQL.
- The Supabase build remains deployable until Stage 6. The Supabase path's behavior is unchanged (504 pre-existing web tests pass unmodified apart from typing the new auth members).
