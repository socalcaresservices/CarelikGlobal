# Release package (PREPARED, NOT EXECUTED): UX redesign, TEST only

**Owner decision 3 (2026-11-10):** "Prepare and verify a TEST-only release." Nothing in this file has been run. Production (`Ogevia-prd-*`, `ogevia_prd`) is not touched by any step.
Process: `docs/TESTING_AND_RELEASE_PROCESS.md`. Checklist: `CHECKLIST.md` (this folder). Status words: **implemented, tested** below are true; **deployed** is false for everything.

## 1. What is in the candidate
Branch `claude/ogevia-ux-audit-redesign-w36cov` (PR draft to `main`, never merge without your word). Candidate SHA: fill in at Phase C from `git rev-parse HEAD` (last verified: `16d9f21` plus the 0094 commit that follows it).

| Area | Rows | Needs a database change | Needs an API change | Switch |
|---|---|---|---|---|
| Navigation, help panel, dashboard, schedule drawer, caregiver tabs, phone touch targets, wording | R1 R2 R3 R4 R5 R8 R12 R13 R14 R18 R19 R20 R21 R25 R26 R27 | none | none | none (web only) |
| Caregiver client labels | R23 | pending **0091** (two read functions gain one column) | none | none (web shows the code only until 0091) |
| Approve by override | R10 | pending **0090** + permission `caregivers.signin_override` | 2 routes | `signInOverride` |
| Bulk import (people, clients) | R11 | pending **0092** | 1 route (`exceljs` added: larger Lambda bundle) | `bulkImport` |
| Duplicate staff report and merge | R6 | pending **0093** | 2 routes | `staffDuplicates` |
| Standard CPR/TB document types | R7 | pending **0094** (data: up to 2 rows per agency, names only) | none | none |

Ship order constraint already in the code: the web build knows the new permission key before 0090 is applied.

## 2. What deliberately does not change
Production. The released ledger 0001–0088. Billing, authorization, schedule and visit rules. No migration is moved into `db/migrations`: the four files stay in `infra/aws/db/pending` and are applied to the TEST database **outside the ledger**, exactly as 0086 was applied to TEST (see `docs/releases/2026-10-30-caregiver-readiness/DEPLOYED_RECORD_0088_TEST.md`). Moving them into the released set is a later, separate decision for the production release.

## 3. Facts that change the risk
- **TEST and production share one RDS instance** (`ogevia-prod-postgres`; finding U1, still unverified live). A snapshot covers both databases, and a heavy migration or restore touches the shared instance. All four migrations are small and additive. Restoring TEST alone from a snapshot is not possible without restoring the instance: rollback below uses the down scripts instead.
- Migrations run against database `ogevia_sv_test` only. Every script must refuse any other database name (the seed script already does; the runner commands below name the database explicitly).
- Switches turn on only for the TEST stack (`ENVIRONMENTS.prod`, stacks `Ogevia-prod-*`). `TEST-switches-on.patch` is the exact change. It is **not applied**: applying it makes the three `*-switch.test.ts` files fail by design (they assert OFF), so the release commit must also change those assertions for the TEST stack and keep them OFF for `prd`.

## 4. Operator sequence (Phase C), for the person you name; every step has a stop condition
0. You state in writing: candidate SHA (40 chars), target TEST only, who runs it, window. (Checklist C0.)
1. Pre-flight, read-only: ledger count and max on `ogevia_sv_test` (expected 88 / 0088); banner reads "TEST — synthetic data only"; target database name is `ogevia_sv_test`. Stop if anything else.
2. Capture rollback inputs: previous web bundle, previous API template; take a manual RDS snapshot (covers the shared instance). Stop if the snapshot is not `available`.
3. Apply `0090`, `0091`, `0092`, `0093`, `0094` in that order, each in its own transaction as `ogevia_owner`, to `ogevia_sv_test` only (the same call shape the DB tests use). Stop on the first error; each has a down script in `infra/aws/db/pending/rollback`.
4. `cdk diff` for `Ogevia-prod-*` with the switches patch: expected changes are the three new switch routes (4 routes: 2 override, 1 import, 2 duplicates = 5) and the Lambda code; anything else, stop.
5. Deploy API, then web, from the same SHA (`infra/aws/slice/test-web-release.sh` stamps `VITE_APP_VERSION`).
6. Verify: `db:verify`; the pilot regression runner; catalog areas for the changed workflows; every role opens every menu item; negative checks (401 forged token, other tenant sees nothing, caregiver cannot reach administrator data).
7. Seed the demo day: `infra/aws/db/deploy/07_seed_ux_demo_visits.sql` (refuses any database except `ogevia_sv_test`).
8. Live check: `VITE_APP_VERSION` in the served bundle equals the SHA (this also answers R22).

## 5. Rollback
Web: previous bundle. API: previous template (switches off removes the five routes). Database: down scripts in reverse order `0094 → 0090` (0092 and 0093 drop their tables: take the snapshot first; created records stay). Nothing in 0090–0094 deletes existing data.

## 6. Verified so far (local, this session)
Lint 6/6, typecheck, build, unit suites (web 1,308, infra 684, sv-api 108, auth 150, shared 118, ui 73), database suites (infra 1,155, sv-api 173 including the cross-tenant sweep with all pending migrations applied), 44 px touch-target measurement (0 of 20 screens), offline preview. **Not verified:** CI on the newest commits (GitHub was unreachable for part of the session), the live demo, any real phone, Cognito/IAM/S3/CloudFront behaviour (B10: this change touches none, apart from the larger Lambda bundle).

## 7. Open items before Phase C can start
Your written statement (step 0); the CloudShell results (U1–U4) to confirm the instance facts above; whether the operator is you or a named person.
