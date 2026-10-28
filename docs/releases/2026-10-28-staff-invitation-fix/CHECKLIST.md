# Release checklist: 2026-10-28-staff-invitation-fix (deployment candidate `fb491a5`, TEST first)

Prepared 2026-10-28 from `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`. Process: `docs/TESTING_AND_RELEASE_PROCESS.md`. Status words: proposed, implemented, tested, deployed, accepted (never interchangeable).

**Status of this candidate: IMPLEMENTED and TESTED (locally and in CI, see section A). NOT DEPLOYED anywhere. NOT ACCEPTED by anyone. EVERY APPROVAL LINE BELOW IS UNSIGNED.** Nothing in this file is a signature, an exception or a GO. Where a line needs a person or AWS it says so and stays open.

Evidence rules: real output only; never passwords, tokens, secret values, real client or caregiver data.

## Earlier approvals (HISTORICAL RECORD ONLY; they do not carry over to this candidate)
These are copied by reference, not re-signed, and are not edited. They concern a different commit (`7870a04`) and a different scope.

| Earlier record | What it covers | Where it lives |
|---|---|---|
| Phases A, B, C signed by the Owner, 2026-10-25 23:10 PDT, with Owner exceptions | release `2026-10-26-redesign`, code `7870a04`, TEST only | `docs/releases/2026-10-26-redesign/CHECKLIST.md` (unchanged) |
| Phase D: Owner accepted TEST ("Testing is complete and accepted."); Scheduler, Caregiver and Authorization validations EXCEPTED by the Owner | the same release on TEST | the same file and `RELEASE_COMPLETION_TEST.md` section 8 |
| TEST approval "Approved for TEST" (2026-10-26) | deployment of `7870a04` to TEST | `docs/releases/2026-10-26-redesign/DEPLOYED_RECORD_TEST.md` |
| Phase E (production GO) | **never given**; no production approval exists for any candidate | `docs/releases/2026-10-26-redesign/PRODUCTION_RELEASE_PREPARATION.md` |
| Owner instruction of 2026-10-28 | implement Option B for M-1 with the L-1, L-2, L-3 fixes; prepare TEST deployment; **the GO for this deployment is still to be given** | this folder's `RELEASE_MANIFEST.md`, section 3 |

## 0. Release identity
| Field | Value |
|---|---|
| Release ID | `2026-10-28-staff-invitation-fix` |
| **Deployment SHA** (code that would be deployed, full 40 characters) | `fb491a554c0fdc484102025179c9c993f694b4e0` |
| **CI-tested SHAs** | `cd57ffb3a7638238cf31e2ad4733ee0a5f4dd1e1`: validate, harness and postgres all success (run 40766462415). `cea8b47eaed56764f10b1ea07325ebe22f0e869e`: validate and harness success, **postgres FAILURE** (run 40771238644), cause not identified. Both differ from `fb491a5` only in tests, the pending-migrations README and documentation (`RELEASE_MANIFEST.md` section 0). Later heads: see the PR's checks; not claimed here |
| Operator-package files | taken from the working tree when a tarball is built; last commit touching them: `215b7c6`. The shippable tarball's sha256 is the identity of the package (it is built only after the Owner's GO) |
| Branch / pull request | `claude/magical-lovelace-9y5ras`; draft CI-only pull request https://github.com/socalcaresservices/CarelikGlobal/pull/107 (base `claude/redesign-review-nav-ui`; **do not merge**) |
| Prepared by (name, date) | Claude Code session, 2026-10-28. Owner approval for this deployment: **NONE YET** |
| Change classification | ☑ migration (pending, outside the ledger) ☑ API (one route) ☑ user admin ☑ web ☐ scheduling ☐ authorization ☐ visits/verification ☐ billing ☐ reports |
| Feature Test Plan | V4/V5/V6/V7 steps: `V4_READINESS.md`, `V5_V7_PREPARATION.md`; the 2026-10-26 plan still applies to the unchanged parts |
| Catalog areas required | USR (staff and invitations), isolation cases, migration rollback cases, API route area |

## 1. Change contents
| Item | Value |
|---|---|
| Migrations in this release | **0087** `staff_invitation_acceptance` (pending, outside the ledger), on top of 0086 (already on TEST, byte-identical file; applied together with 0087 in production). Ledger 85 / `0085` unchanged. No earlier migration missing |
| Rollback script | `infra/aws/db/pending/rollback/0087_staff_invitation_acceptance.down.sql`; class ADDITIVE (functions only, no data removed). Production pair rollback: `MIGRATION_STATUS_MATRIX.md` section 6 |
| API routes added / changed / removed | +1 `POST /v1/me/staff-invitations/{organizationId}/accept`; `GET /v1/me` gains `pendingInvitations`; the invitation reply loses `existingAccount`. TEST 241 → 242 |
| Screens added / changed | Added: pending-invitation panel. Changed: invite success wording, Edit staff warning |
| Infrastructure (`cdk diff` summary) | Expected: `Ogevia-prod-ServiceVerificationApi` +1 route and Handler code only; the other four stacks "no difference". Offline evidence only; the live diff is TEST Step 8 |
| What deliberately does NOT change | Production, `ogevia_prd`, the ledger, migration 0086, caregiver invitations, authorizations, scheduling, visits, billing, reports |
| Data changed or created | none (functions only) |

## A. Development gates (Phase A) for `fb491a5`
| # | Gate | Result | Evidence |
|---|---|---|---|
| A1 | Install, frozen lockfile | ☑ ok (local and CI) | CI jobs reached `pnpm test` |
| A2 | Lint | ☑ local exit 0; ☑ CI `validate` success on `cd57ffb` and `cea8b47` | PR 107 checks |
| A3 | Typecheck | ☑ same | same |
| A4 | Unit and static tests | ☑ local: shared 118, auth 150, sv-api 96, ui 73, web 1270, infra-aws 1025, 0 failed. ☑ CI `validate` success (`pnpm test`) | `NOTHING_DROPPED.md` section 5 |
| A5 | Build | ☑ local exit 0; ☑ CI `validate` | |
| A6 | Database tests (infra) | ☐ **local: NOT PASSED** (28 failures in 4 files that also fail on the baseline `644d6e2` in this sandbox; local artefact). ☐ **CI `postgres` (`pnpm test:all` on PostgreSQL 18): PASSED on `cd57ffb`, FAILED on `cea8b47`**, cause not identified (log unreadable from the sandbox). The gate is **not passed** until a green `postgres` run on the final head and the failure is explained | https://github.com/socalcaresservices/CarelikGlobal/actions/runs/40766462415 (green), https://github.com/socalcaresservices/CarelikGlobal/actions/runs/40771238644 (red) |
| A7 | API database tests | ☑ local 153/153; part of the CI `postgres` job (see A6) | |
| A8 | CI run on the pull request | ☐ see A6; run links above | |
| A9 | Test counts did not drop versus the baseline | ☑ no product test deleted or skipped; one test file replaced by a TEST-state equivalent (`operator-0086-sql.db.test.ts` → `operator-0087-sql.db.test.ts`), disclosed in `NOTHING_DROPPED.md` section 4. Baseline infra-aws static count NOT MEASURED | |

Change-specific:
- ☑ Failure-first: new DB, API and web tests were written first; mutation checks recorded in `RELEASE_MANIFEST.md` section 3.
- ☑ Migration: one new file; applied files unedited (set hash `de0c8abb…` unchanged; 0086 byte-identical); `.down.sql` present; rollback tested on a real PostgreSQL.
- ☐ `docs/security-review-checklist.md` for 0087: `SECURITY_REVIEW_0087.md` is the author's own, **unsigned; no second person has reviewed it (V7)**.
- ☑ API: permission, other-agency, unauthenticated and bad-input tests exist (`staff.db.test.ts`, `tenant-isolation-sweep.db.test.ts`).
- ☑ UI states covered by `pending-invitations.test.tsx` (3 tests); ☐ 390 px and 1280 px browser check NOT RUN.

**Phase A signed:** ☐ UNSIGNED. (Open: A6.)

## B. Local harness (Phase B)
| # | Step | Result |
|---|---|---|
| B1-B3 | `harness:setup`, `harness:build`, `harness:serve` on `fb491a5` | ☑ CI `harness` job success on `cd57ffb` and `cea8b47` (it builds the harness database with migrations 0001-0085 and the demo seed, builds the web app and drives it over HTTPS). It does **not** apply pending 0086/0087 |
| B4 | Catalog IDs performed as personas in a browser | ☐ NOT RUN |
| B5-B7 | Screenshots, console and network review | ☐ NOT RUN |
| B8 | Negative checks (wrong role refused) | ☑ automated (API and DB tests); ☐ not exercised in a browser |
| B9 | Regression set R | ☐ NOT RUN (automated suites only) |
| B10 | What the harness cannot prove: Cognito invitation e-mail and acceptance with a real token, the JWT authorizer on the new route, CloudFront bundle, CORS | ☑ carried to C6 below |

**Phase B signed:** ☐ UNSIGNED.

## C. Pilot/test environment (Phase C) - NOT STARTED
Owner has stated in writing: commit SHA ______, target pilot/test only, who runs it ______, window ______. ☐ **NOT RECORDED. Request: `TEST_APPROVAL_REQUEST.md`.**

| # | Step | Result |
|---|---|---|
| C0 | Target confirmed as TEST (`Ogevia-prod-*`, `ogevia_sv_test`, banner "TEST - synthetic data only") | ☐ NOT RUN (procedure Step 5) |
| C1 | Ledger before: expected 85 / `0085`, 0086 present (`1\|1\|21`), 0087 absent | ☐ NOT RUN (Step 6) |
| C2 | Previous web bundle and API template captured | ☐ NOT RUN (Step 5) |
| C3 | Manual RDS snapshot `ogevia-prod-postgres-pre-0087-<stamp>` available | ☐ NOT RUN (Step 7) |
| C4 | Deployed in order database, API, web with the reviewed scripts | ☐ NOT RUN (Steps 9-11) |
| C4a | `cdk diff`: API stack = accept route + Handler only; other four stacks no difference | ☐ NOT RUN (Step 8) |
| C4b | Ledger after 85 / `0085`; `verify-0086.sql` 110 and `verify-0087.sql` 24 PASS | ☐ NOT RUN (Steps 9, 15) |
| C5 | Smoke: route smoke (1 route x 2 + preflight), catalog set S | ☐ NOT RUN |
| C6 | Changed workflows on TEST, including B10 items | ☐ NOT RUN (V5) |
| C7 | Regression set R (`pilot_regression.py`) | ☐ NOT RUN |
| C8 | Every role opens every menu item; logs searched for 5xx | ☐ NOT RUN |
| C9 | Negative checks including the **same-agency Caregiver (V4)** | ☐ NOT RUN; **BLOCKED until the Caregiver sign-in exists** (created in V4 step C1; it does not exist today) |
| C10 | Rollback readiness | ☑ inputs defined in the procedure; database rollbacks rehearsed on a real PostgreSQL only; ☐ NOT rehearsed on AWS |

**Phase C signed (Operator + validator):** ☐ UNSIGNED.

## D. User acceptance (Phase D) - NOT STARTED
| Validator | Scripts | Result | Signature / date |
|---|---|---|---|
| Owner | V4, V5, V6 per `V4_READINESS.md`, `V5_V7_PREPARATION.md` | ☐ NOT RUN | UNSIGNED |
| Invitee account for M-1 (an existing sign-in outside the TEST agency, reachable by e-mail) | V5 | ☐ **BLOCKED / NOT VERIFIED**: accounts D and E are enabled through the API but browser sign-in is NOT VERIFIED; if neither works the M-1 live check is BLOCKED and the Owner decides (never decided by this file) | UNSIGNED |
| Second person for the 0087 SQL (V7) | `SECURITY_REVIEW_0087.md` section 6 | ☐ NOT DONE | UNSIGNED |

No defect log: nothing has been run on TEST.

## E. Production approval (Phase E) - NOT REQUESTED
No production approval is requested, prepared for signature or implied. Items E1-E7 stay open; the production package and window are a separate, later request after TEST is accepted.

| Field | Value |
|---|---|
| Decision | ☐ GO ☐ NO-GO - **UNSIGNED, NOT REQUESTED** |
| Commit SHA the decision covers | |
| Approval reference | |

## F. After deployment - NOT APPLICABLE (nothing deployed)
