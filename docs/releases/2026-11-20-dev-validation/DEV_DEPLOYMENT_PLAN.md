# DEV validation plan for PR #113 at commit 96dd96a

Status: **prepared. Steps 1 to 4 were rehearsed on the local harness on 2026-11-20 (results below). Nothing was deployed to AWS. No production, TEST or AWS call was made.** Status words follow `docs/TESTING_AND_RELEASE_PROCESS.md`: proposed, implemented, tested (where), deployed (where), accepted (by whom).

Commit under test: `96dd96a` (PR #113 head after PR #114 merged; contains migration 0109 and go-live items 1 to 10). CI on `4b004f9` (content-identical to the code at `96dd96a` apart from the merge) was green; CI on `96dd96a` itself was still running when this was written.

## 0. What "DEV" can be here (finding)

The repository defines no AWS DEV environment.
- `infra/aws/lib/config.ts` knows two environments only: `prod` (the existing TEST slice, database `ogevia_sv_test`) and `prd` (production).
- The isolated TEST was deployed and accepted on 2026-11-11 (source `6cbab00`, `docs/releases/2026-11-10-ux-redesign-test/`). Its URL is `https://d2xumch5w0izfg.cloudfront.net`.
- A `development` banner label exists in the deploy script and a Dev Cognito pool is only a design (`docs/aws/AUTH_SEPARATION_PHASE2_DESIGN.md`, row "Development: new pool ogevia-dev"). Nothing of it is built.
- The release process (`docs/TESTING_AND_RELEASE_PROCESS.md`): Phase A development, **Phase B local harness**, Phase C pilot/test, D acceptance, E production.

Recommendation (no cost, no AWS, no contact with production): **DEV = Phase B, the local harness.** It runs the real web app and the real API handler on a local PostgreSQL 16 with the real migration runner, with synthetic data only (`infra/aws/local-harness/README.md`).

A real AWS DEV would be new infrastructure (database, Cognito pool, API, web) with recurring cost; `CLAUDE.md` section 11 and 13 require the owner's approval first. It is not proposed here. If the owner wants it, the cost model and approval come first.

What the local harness cannot prove (so these stay for TEST): API Gateway route gating, the real Cognito sign-in, CloudFront and the web bucket, IAM, RDS TLS and the shared-instance topology, and appearance on a real phone.

## 1. Switches in this release

- Only one switch is new: `requestCleanup` (`infra/aws/lib/config.ts`, `service-verification-api-stack.ts`). It gates exactly three API routes: `POST /v1/care-notifications/read`, `POST /v1/documents/{documentId}/cancel`, `POST /v1/document-types/{documentTypeId}/retire`. It is OFF in every environment.
- The other switches (`staffManagement`, `signInOverride`, `bulkImport`, `staffDuplicates`, `liveTestRepairs`) are unchanged by this release; do not touch them.
- Go-live items 1 to 10 have no switch. They ship with the web build and need no database change.
- Migration 0109 is deliberately outside the ledger runner's set (`infra/aws/db/pending/`). The harness setup applies the 107 released and pending-UX migrations and not 0109.

## 2. Steps, with commands and the result of the rehearsal

Prerequisites: Node 22, pnpm 9.15.4, a local PostgreSQL 16 superuser, `openssl`. The harness refuses any non-local database.

### Step 1. Deploy 96dd96a to DEV
```bash
git fetch origin claude/ops-fixes-requests-documents-sorting && git checkout --detach 96dd96a
corepack enable && pnpm install --frozen-lockfile
export HARNESS_ADMIN_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres
pnpm --filter @carelik/infra-aws harness:setup    # drops and recreates ogevia_local_harness, applies migrations, seeds synthetic data
pnpm --filter @carelik/infra-aws harness:build
pnpm --filter @carelik/infra-aws harness:serve    # https://localhost
```
Rehearsal 2026-11-20: **PASS.** 107 migrations applied; seeded 7 clients, 50 shifts, 12 visits; web built.

### Step 2. Apply 0109 in DEV only, and prove it rolls back and reapplies
```bash
P="psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -U postgres -d ogevia_local_harness"
$P -f infra/aws/db/pending/migrations/0109_request_cleanup.sql
$P -f infra/aws/db/pending/rollback/0109_request_cleanup.down.sql
$P -f infra/aws/db/pending/migrations/0109_request_cleanup.sql
```
Rehearsal 2026-11-20: **PASS.** Before: 0 functions and 0 columns. After apply: 3 functions and 4 columns. After rollback: 0 functions. After reapply: 3 functions. (Data-level behavior is covered by `infra/aws/db/test/request-cleanup-0109.db.test.ts`, 10 tests, passing.)

### Step 3. Keep every switch OFF first
In the harness the equivalent of OFF is "0109 not applied", so run the smoke before step 2. Result: see step 4. **Limit:** the real OFF is route absence in API Gateway (a CDK fact). The harness serves every route, so it cannot show it. Check it separately, before TEST: `cdk synth` for the TEST slice with `requestCleanup` false then true, and expect the true template to add exactly three routes and the false one none. NOT DONE (needs the CDK synth for the TEST environment; no infra test covers `requestCleanup` today, a gap).

### Step 4. Smoke
```bash
pnpm --filter @carelik/infra-aws harness:smoke     # stop harness:serve first; both use port 443
```
Rehearsal 2026-11-20: **PASS, 45 of 45**, once before 0109 (switch-OFF equivalent) and once after apply, rollback and reapply.

### Step 5. Enable each switch individually (the one new switch, three behaviors, one at a time)
Run in the harness with 0109 applied. Order and expected result; stop at the first failure. Sign in with the stand-in as Olivia Owner (Administrator) unless stated.
1. **Alerts (R35):** Care requests, the "N new alerts" pill opens the list; Mark read on one; Mark all read; the count falls to 0 and stays 0 after a refresh. Another person's alerts are unchanged.
2. **Cancel a document request (R37):** Documents, a request with no upload shows Cancel request; a reason is required; after saving it is closed and the caregiver's readiness is re-evaluated; a request that has an upload offers no Cancel.
3. **Retire a duplicate document type (R37):** Settings, document types, Retire on a duplicate that has no open requests; refused for the CPR or TB requirement type and for a type with open requests; the retired type is listed separately and cannot be requested.
After each, switch the migration off again (step 2 rollback) to confirm the app says "not available in this environment yet" and does not error, then reapply.
Rehearsal: **NOT DONE in a browser.** Automated cover exists and passes: `request-cleanup-0109.db.test.ts` (10), API tests in `apps/sv-api`, and the page tests (`care-requests`, `documents-cancel-retire`).

### Step 6. Verify the go-live items in DEV
See `DEV_SIGNOFF_CHECKLIST.md`, section C. Items 1 to 10 each have a manual check on the harness and the automated evidence already recorded in `docs/releases/2026-11-20-go-live-items/TRACKER.md`.

### Step 7. Sign-off
`DEV_SIGNOFF_CHECKLIST.md`. DEV sign-off is the owner's. Claude Code cannot give it.

## 3. After DEV (not prepared here, not authorized)
- TEST (Phase C) is the existing isolated TEST. Its operator path is `docs/releases/2026-11-10-ux-redesign-test/toolchain/` (`OPERATOR_TEST_DEPLOY.sh`, `OPERATOR_TEST_DB.sh`); it needs the operator's AWS credentials, a snapshot before the migration, the diff gate, and the owner's GO. A TEST plan for 96dd96a (with 0109 and the three routes) has to be written and reviewed separately.
- Production (Phase E) needs TEST validation, user acceptance, the completed release checklist and the owner's explicit GO.

## 4. Rollback for DEV
- Reset everything: `harness:setup` (drops and recreates the database).
- Remove 0109 only: the `.down.sql` in step 2. Rolling back leaves already-cancelled requests closed, as designed.
- No AWS resource exists to roll back.

## 4a. Browser pass on the harness (2026-11-20)
A scripted browser pass (desktop 1280 px and phone 390 px, signed in as the synthetic owner, 0109 applied) found one real defect: the Staff header's button row (Import from a file, Add caregiver, Add office staff) made the page scroll sideways by 2 px at 390 px. Cause: the shared page header kept its action area from shrinking, so the wrapping button row never wrapped. Fixed by letting that area cap at the container width (`apps/web/src/aws/ui/page-header.tsx`, test `ui/page-header.test.tsx`). After the fix the browser pass reports 0 failures at both widths. Not covered by the pass: the cancel and retire flows (no suitable seeded request was found), and a real phone.

## 5. Limits of this rehearsal
- Synthetic data only; local PostgreSQL 16.15; the stand-in sign-in is not Cognito.
- No browser pass and no real-phone check were done.
- CI on `96dd96a` itself was not yet confirmed.
