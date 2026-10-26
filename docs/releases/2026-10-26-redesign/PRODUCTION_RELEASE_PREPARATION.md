# Production release preparation: 2026-10-26-redesign (staff management and the redesigned navigation)

**Status: PREPARATION, stage 1 of 3. Nothing is deployed to production. No GO has been requested. Production's live state is UNKNOWN until Stella runs the read-only discovery package (section 6).** Opened 2026-10-26 on the Owner's instruction ("I want this update deployed to PRODUCTION. Begin production release preparation now."). Owner and AWS Operator: Stella Okereke. TEST exceptions do not carry over to production (the Owner's words); section 3 shows what that means item by item.

Labels: VERIFIED (read from the repository or a recorded run), INFERRED, UNKNOWN.

## 1. What exactly was tested on TEST, and how production code relates to it
| Item | Value | Label |
|---|---|---|
| Code deployed to TEST | commit `7870a04c43545bacc378ad93ffc6a09d63345b5a` (Handler asset `94b73574c5a681d5a8c22b4264742f64e5a6d40aa1ace783be12e7383b9d8a9e.zip`, Identity asset `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip`, 241 routes = 228 + 13 staff routes) | VERIFIED (`DEPLOYED_RECORD_TEST.md`) |
| Migration deployed to TEST | `0086_staff_management.sql` from `infra/aws/db/pending/` (sha256 `8eb7b4a3…a16a4f`), applied outside the ledger; ledger stayed 85 / 0085; `verify-0086.sql` 110 of 110 | VERIFIED |
| Web deployed to TEST | the build at `7870a04` (redesigned navigation, Staff page) | VERIFIED |
| Production-bound difference | **one config line**: `ENVIRONMENTS.prd.features.staffManagement` set `true` (commit `515c49a`), plus tests that hold the flag off where they compare against pre-staff snapshots (`515c49a`, `f8cd7df`). The Handler and Identity code assets are byte-identical to TEST's (VERIFIED by the synthesis in `infra/aws/test/prd-discovery-package.test.ts`) | VERIFIED |
| Later branch commits NOT in this release | everything else after `7870a04`: documentation, operator-package scripts and tests only. The only changed source file outside docs and tests is `infra/aws/lib/config.ts` (the flag) | VERIFIED by `git diff --name-only 7870a04 HEAD` |

Why the flag is part of "deploy this update": without it production would serve the 228 earlier routes and the redesigned web would call 13 staff routes that do not exist. It is a decision for the Owner (D-P1, section 7), recommended YES.

## 2. Production target (to be confirmed by the discovery capture)
Account `300094796789`, region `us-west-2`. Stacks `Ogevia-prd-Auth`, `-DatabaseSecret`, `-EvidenceStorage`, `-Observability`, `-ServiceVerificationApi`, `-WebHosting`; database `ogevia_prd` on the RDS instance `ogevia-prod-postgres` that TEST also uses (database `ogevia_sv_test`); API id `zk527zk4ua`; Cognito pool `us-west-2_FHJoX71ca`; hostnames `app.ogevia.com`, `admin.ogevia.com`. VERIFIED from the repository's configuration; whether each exists and what it runs now is UNKNOWN.

## 3. V1–V8: what passed, what was waived on TEST, what production needs
| # | TEST result | Carries to production? | Production disposition |
|---|---|---|---|
| V1 regression set R | EXCEPTED, not run | **No** | **OPEN.** Run on TEST (already at the same code) before GO; it writes synthetic rows, so it must not be pointed at production if production holds real data. A production-side smoke set (read-only) replaces it |
| V2 pilot smoke | EXCEPTED, not run | **No** | **OPEN.** Run (read-mostly) after the production deploy as the post-deploy check |
| V3 every role walks every menu item; log search | EXCEPTED (Owner role only) | **No** | **OPEN.** Run on TEST now; on production after deploy: sign-in per existing production role, log search for 5xx |
| V4 tenant and Caregiver negatives | EXCEPTED (401 and forged token on 13 routes passed) | **No** | **OPEN, required.** Cross-tenant and Caregiver-cannot-reach-Administrator checks are part of the production gate; the SQL-level negatives (110 checks, tenant-isolation sweep) passed in the development run |
| V5 staff invitation by e-mail | EXCEPTED | **No** | **OPEN.** Needs the production Cognito pool and the production e-mail path (UNKNOWN whether sending is configured); verify on TEST first |
| V6 Scheduler, Caregiver (phone), Authorization validators | EXCEPTED | **No** | **OPEN.** Needs the people. Not required by the redesign's database change, but required by the process for the caregiver and authorization screens |
| V7 reviewer signature, `SECURITY_REVIEW_0086.md` | EXCEPTED (author-prepared only) | **No** | **OPEN.** A second person must read the SQL against the checklist, or the Owner records a production exception in writing |
| V8 signatures | SIGNED for TEST | **No** | **OPEN.** Production Phase E signature and the explicit GO |

Passed on TEST and relevant evidence for production (not a substitute for production checks): Step 5/6/7/9/10/12/14/15/16 checks, route smoke 26 of 26, gate DELTA/NONE, 110 SQL checks, 0086 apply and rollback tested against real PostgreSQL.

## 4. Unresolved at this point
1. Live production state: stack versions, Lambda code, web version, whether the earlier production release (`2026-10-19-prd-readiness`, pinned to `e80b770`) was ever executed, whether `Ogevia-prd-Auth` exists. UNKNOWN.
2. Migration ledger of `ogevia_prd` (last documented 46 / 0046 on 2026-10-20/21). The release needs 0047–0085 (if still behind) and then 0086 outside the ledger. UNKNOWN.
3. Data in production (legitimate versus synthetic). The Owner stated on 2026-10-20 that production holds synthetic data only; that must be re-confirmed now and checked by row counts. UNKNOWN.
4. The existing production tooling is pinned to a different release and must not be reused for the deployment stages; only the read-only discovery pieces are version-neutral. VERIFIED.

## 5. Safety design for the production package (built after the capture)
Same pattern as TEST: one tarball built from the production-bound commit with manifest and hash; a temporary single /32 rule on the shared RDS group (typed phrase, rule set verified identical before and after); an RDS snapshot inside a 12-hour UTC window before any change; an expected-only diff gate (live templates against release templates, any unexpected change stops); migrations from the actual ledger; 0086 applied as on TEST with `verify-0086.sql`; one stack deployed per typed phrase (API before web); web published after the API; rollback R1–R7 analog (code rollback by previous asset; 0086 rollback is **BACKUP REQUIRED** because it drops the staff tables with rows; snapshot restore as the last resort). The shared RDS instance means production work must not touch `ogevia_sv_test` and vice versa; the package pins the database name `ogevia_prd`.

## 6. Step now: read-only discovery (Stella, CloudShell, us-west-2)
Package: `ogevia-prd-discovery.tar.gz` built by `docs/releases/2026-10-26-redesign-production/build-discovery-package.sh`; its README has the commands. Summary: verify the manifest; run `scripts/p0-baseline-capture.sh` and `scripts/p1-diff-report.sh` (AWS reads and local files only); optionally (YELLOW, typed phrase, adds and removes one /32 rule) `OGEVIA_PRD_READ_COUNTS=1 OGEVIA_EXPECT_HOST_IP=10.20.132.179 bash scripts/ledger-prd-read.sh prd --host-ip` for the ledger and row counts only. Paste the output back; do not paste secrets or names.

## 7. Decision gates for the Owner
| Id | Decision | Recommendation |
|---|---|---|
| D-P1 | Enable the 13 staff routes in production (`staffManagement: true`) | YES: required for the redesigned web |
| D-P2 | 0086 path on production | Same tested path as TEST (apply from `db/pending` outside the ledger). Promoting it into `migrations/` would need re-pinning and adoption on TEST |
| D-P3 | Re-confirm production data is synthetic only (after the counts are read) | Decide after the capture |
| D-P4 | V1–V7 for production: run, or written Owner exception per item | Run V4 and a review of 0086 at minimum |
| D-P5 | Execution window (≤ 12 h UTC, snapshot inside it) | Proposed after the capture, off-hours Pacific |

## 8. Next
After the capture: write the production gate and pins, migration plan from the real ledger, deploy guard, web guard, snapshot step, rollback and deployed-record scripts; test with mocked AWS and real PostgreSQL; present the exact target, changes, risks and window; ask for the final GO. Nothing is pushed, merged or deployed without the Owner's explicit instruction.
