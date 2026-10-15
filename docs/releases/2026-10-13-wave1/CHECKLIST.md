# Release checklist: 2026-10-13-wave1

**Status: IMPLEMENTED and TESTED LOCALLY (Phase A). Merged to `main`. NOT DEPLOYED to the pilot or production. NOT ACCEPTED.**
Phase A is complete on the merge commit. Phase B is partly complete (see B). Phases C, D, E and F are open; they need the pilot, validators and the owner's GO and are not filled in here. Nothing in this file is a deployment proposal until C–E are done.
Process: `docs/TESTING_AND_RELEASE_PROCESS.md`. Prepared by Claude Code, 2026-10-14 (owner review pending). Evidence outputs were captured at `/tmp/claude-0/rc/` in the session (not committed); the commands and counts are reproduced below.

Marks: ☑ done with evidence · ☐ open · N/A with reason · ⚠ done but with a stated gap.

---

## 0. Release identity
| Field | Value |
|---|---|
| Release ID | `2026-10-13-wave1` (includes the follow-ups merged with it: 0052 single-bucket fix, PR #88; UI simplification, PR #89) |
| Commit SHA to deploy | OPEN: fixed by the owner at Stage 0. Code was verified on `63de403f0c37d33cc8c7cb1c6d23202aee298965` (merge of PR #87). `main` is now `0d63fd9d7f370aef578d448049689409e5e63104`, which adds documentation only (PR #90). |
| Branch / pull request | `claude/determined-goodall-syvv7s`, PR #87 (merged, includes #88). #89 merged separately into `main`. |
| Prepared by | Claude Code, 2026-10-14 |
| Change classification | ☑ feature ☑ migration ☑ API ☑ visits/verification ☑ scheduling ☑ authorization (0052) ☑ infrastructure (API route list only) ☐ bug fix ☐ dashboard ☐ report ☐ availability/matching ☐ user admin ☐ notifications ☑ web |
| Feature Test Plan | `docs/releases/2026-10-12-wave1-caregiver-exceptions/FEATURE_TEST_PLAN.md` |
| Catalog areas required | Visit verification (VIS), scheduling (SCH), migrations (MIG-W1a–c); regression set R; security/privacy (VIS-37 to 39); mobile (VIS-40 to 42). Exact set to be confirmed against process section 6.3 by the owner. |

## 1. Change contents
| Item | Value |
|---|---|
| Migrations (include every earlier migration not yet live) | **0047** availability_override_one_shift, **0048** account_status_enable_disable, **0049** reservation_not_counted_when_late_confirmation_accepted, **0050** wave1_visit_review_and_variance_rule, **0051** wave1_open_shift_pickup, **0052** reservation_not_counted_when_review_visit_counted_as_used. Contiguity: 0047–0049 are not live anywhere (their own plan: `docs/releases/2026-10-13-0047-0048-0049/DEPLOYMENT_PLAN.md`). The pilot ledger before this release is UNKNOWN to Claude Code (production owner-reported `46\|0046`); if the pilot is behind 0046, every earlier migration ships first. |
| Rollbacks | `infra/aws/db/rollback/0050_*.down.sql` (refuses when Wave 1 records exist, so it can never silently delete them), `0051_*.down.sql`, `0052_*.down.sql` (restores the 0049 definition). 0047–0049: see their plan. |
| API routes | Added: `GET/POST /v1/visit-rules`, `GET /v1/open-shifts`, `POST /v1/shifts/{shiftId}/pickup`. Changed: start accepts `unscheduledReason`; confirm accepts `attested` and returns `outcome`; review returns rule and reason fields. |
| Screens | Caregiver: Start (reason when unscheduled), Confirm (Verbal only, declined reasons, attestation), Final outcome, My shifts (Open shifts, Pick up). Office: Settings → Visit rules (new), Visit review (reasons, rule), Schedule (open shifts). #89 UI: readiness table, client List/Cards, shorter copy with Details. No menu item added. |
| Infrastructure | Route list in `infra/aws/lib/service-verification-api-stack.ts` only. `cdk diff` NOT RUN (no AWS access); CDK unit tests pass. |
| What does NOT change | Supabase build (new controls gated on `backend.wave1`, set only by the AWS adapter; static check in `POST_MERGE_VERIFICATION.md`); Cognito pool; hostnames; enforcement activation; payer rules; billing approval remains human. |
| Data changed or created | None expected. Additive columns and two append-only tables; no existing row changes (MIG-W1c: see below). |

---

## A. Development gates (Phase A), run on a clean checkout of `63de403`
Clean worktree, `pnpm install --frozen-lockfile`, local PostgreSQL 16. Final line of `pnpm test:all`: `PASS  all suites ran, none skipped, all passed.`

| # | Gate | Result | Evidence |
|---|---|---|---|
| A1 | Install | ☑ exit 0 | frozen lockfile, 13.5 s |
| A2 | **Lint (G1)** | ☑ exit 0 | 6/6 tasks |
| A3 | **Typecheck (G2)** | ☑ exit 0 | 7/7 tasks |
| A4 | **Unit and static (G3a)** | ☑ exit 0. web 792 (95 files), shared 118, auth 138, ui 73, infra-aws 124, sv-api unit 67 | `test:all` output |
| A5 | Build | ☑ exit 0 | 6/6 tasks (turbo warns "no output files" for infra-aws and sv-api builds: pre-existing warning) |
| A6 | **Database tests (G3b)** | ☑ 560 passed, 57 files, **0 skipped** | `test:all` step 2/3 |
| A7 | **API tests (G3c)** | ☑ 74 passed, 5 files, **0 skipped** | `test:all` step 3/3 |
| A8 | CI on the PR | ☑ green: validate, postgres, harness on PR #87 head `c1903b1` before merge | PR #87 checks. CI on `63de403` itself was not separately read. |
| A9 | Counts did not drop vs the baseline | ☑ yes. Wave 1 branch before #88/#89: web 775, DB 551 (56 files), API 73 (4 files). Now: web 792, DB 560 (57 files), API 74 (5 files). | |

Change-specific:
- ☑ Failing-first: the new DB tests failed without 0050/0051 (29 of 30 failed); output in `failing-first.txt`. 0052: its tests were written first (`authorization-single-bucket.db.test.ts`, 9 tests; see `docs/releases/2026-10-14-0052-single-bucket/README.md`).
- ☑ Every changed rule has a test and a control (G01–G09; see IMPLEMENTATION.md §5).
- ⚠ Failure-first cases: concurrency (open-shift claim), retry/idempotency, wrong role, other agency and old data are covered by tests named in IMPLEMENTATION.md. Network-loss cases (VIS-32, 33) need a real phone and are open (Phase D).
- ☑ Migrations: new files only; `.down.sql` present; ledger-tail and `01_schema_version.sql` updated to 0052.
- ☑ `SECURITY DEFINER`/grants: `pickup_open_shift` added to the readiness-gate protected-function list. ⚠ `docs/security-review-checklist.md` completion for 0050–0052 is NOT RECORDED in this folder; the owner must confirm or Claude Code completes it before Phase C.
- ☑ API: permission, other-agency, unauthenticated, bad-input and idempotency tests exist; `slice-contract.test.ts` passes (part of A7/A4).
- ⚠ UI: 390 px and 1280 px checked in Chromium against the harness (IMPLEMENTATION.md §4 item 9); contrast tests pass; not tested on a physical phone, slow network or screen reader.
- ☑ Terminology/copy cap enforced by `copy-length.test.ts` (#89).

**Phase A signed:** Claude Code (executed), 2026-10-14. Owner review: ☐ ________

## B. Local harness (Phase B), gate G4 — PARTIAL
| # | Step | Result | Evidence |
|---|---|---|---|
| B1 | `harness:setup` on this commit | ⚠ run on the Wave 1 branch at 51 migrations (before 0052 and #89): 45/45 checks. NOT re-run locally on `63de403` (52 migrations). CI `harness` job passed on PR #87 head `c1903b1`. | IMPLEMENTATION.md §5; CI |
| B2 | `harness:build` and `serve` on this commit | ⚠ same | |
| B3 | Seed covers the change | ☑ scheduled, unscheduled and over-the-rule visits seeded (`local-harness/setup.ts`) | |
| B4 | Catalog IDs performed as personas | ⚠ see table below | |
| B5 | Screenshots saved | ☑ 16 images in `docs/releases/2026-10-13-wave1/screenshots/` (390 px caregiver, 1280 px office) | |
| B6 | Before/after for a rule change | ⚠ the 0052 case has before/after in its README; Wave 1 has no before screenshots (new features) | |
| B7 | Console/network clean | ⚠ not recorded as a separate check | |
| B8 | Negative checks | ☑ automated (wrong role, other agency, unauthenticated) in A6/A7; not performed by hand | |
| B9 | Regression set R | ☐ not run | |
| B10 | What the harness cannot prove and this change touches | Cognito groups and authorizer for the new routes, IAM for the new routes, API Gateway route list in the deployed stack, CloudFront, real phone, email. Carried to C6. | ☑ listed |

Catalog results. "Auto" = an automated test covers the behavior (A6/A7/A4 pass); the per-ID mapping from the plan to named tests is NOT VERIFIED (IMPLEMENTATION.md describes coverage per gap, not per ID). Nothing below is PASS-by-persona yet.

| Catalog ID | Persona | Status | Notes |
|---|---|---|---|
| VIS-14 to 19, 35 (confirm choices, verbal, declined, evidence) | Caregiver | Auto + screenshots 05–08 | G05 built as described |
| VIS-20, 21, 21c (attestation) | Caregiver | Auto | Server names `attest-v1`; screenshot 07 |
| VIS-21b, 27, MIG-W1c (old data unchanged) | n/a | NOT VERIFIED as an upgrade test | Additive migrations; no upgrade test with pre-change signed visits is recorded. Required before Phase C. |
| VIS-22a–d (final screen) | Caregiver | Auto + screenshot 08 | G07 |
| VIS-23, 24, 24d, 25, 28, 29 (unscheduled, review reasons, approval gate) | Caregiver / Office | Auto + screenshots 02–03, 13–14 | |
| VIS-24b (flexible caregiver stays Billing Ready) | — | **DIVERGES**: decision D-U made every shift-less visit go to review, fixed or flexible. Plan row is superseded; the test was rewritten. | Owner decision, not a failure |
| VIS-26 (exception center groups/filters by reason) | Office | **NOT BUILT** | Reasons are shown on review; grouping/filtering was not built |
| VIS-50 to 53, 55, 56 (variance rule, versions, history, access) | Administrator | Auto + screenshots 11–12 | |
| VIS-54 (correction re-evaluates under stored version) | — | **NOT BUILT** | `correct_service_visit` untouched (risk 4) |
| VIS-57 (unverified labels for rounding and periods; named statuses) | — | **PARTIAL**: variance rule labeled unverified; the rounding/period labels and named statuses were not built | |
| SCH-18 to 24, 26, 27 (pickup) | Caregiver / Scheduler | Auto + screenshots 09–10 | G09 |
| SCH-21b (called-out caregiver refused) | | Auto | Decision O-1 = refused |
| SCH-21c (O-1 answer B) | | N/A: the owner chose answer A | |
| SCH-25 (authorization arithmetic unchanged by pickup) | | NOT VERIFIED by a named test | Pickup keeps the reservation; the extension test named in the plan was not confirmed |
| VIS-30, 31, 34, 36 (idempotency, refresh, retry) | | Auto (30, 34, 36); VIS-31 refresh by hand NOT RECORDED | |
| VIS-32, 33 (network loss at End/Submit) | Caregiver | ☐ OPEN: pilot, real phone | |
| VIS-37, 40 (identifiers, 390 px) | Caregiver | ⚠ Chromium 390 px, no overflow; client code only | |
| VIS-38 (no "EVV compliant") | | NOT VERIFIED: no search of the built bundle recorded | Run before Phase C |
| VIS-39 (no PHI in logs) | | ☐ OPEN: pilot logs | |
| VIS-41 (real phone) | Caregiver | ☐ OPEN: Phase D | |
| VIS-42 (contrast/focus) | | Auto (`contrast.test.ts` passes); tab order NOT RECORDED | |
| MIG-W1a (apply at 0049 and fresh) | | ⚠ fresh database: ☑ (harness, tests). Upgrade from a real 0049 ledger: ☐ OPEN (Phase C) | |
| MIG-W1b (each `.down.sql` restores behavior) | | ☑ 0052 and 0050/0051 rollback tests in A6 | |

**Phase B signed:** ☐ NOT SIGNED. To close: re-run harness setup/build/serve on the release SHA (52 migrations), perform the VIS/SCH rows as personas, run set R, record console/network.

## C. Pilot/test environment (Phase C) — OPEN
Not started. Requires the owner's written statement (commit SHA, pilot/test only, operator, window). Nothing was run against AWS; Claude Code has no AWS access in this session. Steps C0–C10 stay as in the template and are all ☐.

**Owner's written Phase C statement: RECORDED 2026-10-14 17:44:57 PDT (Release 0052, pilot/test only).** Phase E (production) is NOT decided and is not affected.
- Reference: `owner-go-pilot-0052-2026-10-15` (the owner left the reference for Claude to assign; assigned and recorded at the owner's written instruction to "accept and record my completed Phase C approval").
- Commit: `d82fefcd37407d837e7c94f6ac57a907ea286ed1`. Operator: Ogechi Okereke.
- Window (America/Los_Angeles): **2026-10-14 17:44:57 PDT to 2026-10-14 19:44:57 PDT** (two hours from acceptance). When it ends, no further WRITE step starts; a running step finishes; state is reported. Rollback is not covered by the window and needs a separate owner instruction.
- Approved (owner's words): "migrations 0037-0052 on ogevia_sv_test and deployment of Ogevia-prod-ServiceVerificationApi only, following the release runbook's backup and stop conditions."
- Applied as: one RDS snapshot (tagged with the reference); migrations 0037-0052 with schema verification; deploy of `Ogevia-prod-ServiceVerificationApi` only; read-only post-deploy checks.
- NOT approved: web upload (excluded by the owner); seed 03, `smoke.py`, `pilot_smoke.py`, `pilot_regression.py` (not named in the statement; they write synthetic records; need a separate one-line approval); `Ogevia-prod-NetworkEgress`, `-WebHosting`, `-EvidenceStorage`, `-Observability`; any `Ogevia-prd-*` stack; production; Netlify; Supabase; any tag change.
- Consequence: UI-level validation (C6, C8 screens) and C5/C7 smoke and regression cannot be completed until those are approved.
- Evidence before the window: C0 target is the pilot (stacks `Ogevia-prod-*`, database `ogevia_sv_test`; banner not checked); C1 ledger before `36|0036`, contiguous `0001|0036|36|true`; Step 5 read-only validation PASS (47 routes added, 0 removed, changed only Handler, IdentityHandler, IdentityPolicy, IdentityRole).

Items already known for Phase C:
- **`infra/aws/slice/smoke.py` updated (2026-10-14)** for unscheduled visits; verified in local mode only (workflow section 32 of 32 checks pass; see `POST_MERGE_VERIFICATION.md` item 6). It has NOT been run against the pilot. The two earlier `care` failures were diagnosed and fixed in the smoke (availability needs administrator approval since 0039; `POST /v1/availability/me` always returns 422). The care workflow depends on the seeded availability of TEST-CG-02 (`db/deploy/03_seed_care_acceptance.sql`); confirm on the pilot that this seed is still applied (UNKNOWN today). Local run: 65 of 65 checks, twice on the same database. The seeded identities have no shift, so smoke.py no longer exercises a clean scheduled-and-signed visit; that path is covered by the DB/API suites only until a scheduled-visit smoke step is added.
- Count Visits to Review per 100 visits on the pilot (risk 1: unmeasured office workload effect).
- Deploy order database → API → web; the web app cannot ship before the API.
- Confirm the `matching-shift` link behaves on real schedules, and the variance rule value is set by the agency (the 15-minute default is a placeholder, not a payer rule).

## D. User acceptance (Phase D) — OPEN
Owner, Scheduler, Caregiver (own phone), Authorization (three balances recalculated by hand, to the minute): none run. Defect log: empty (no testing by validators yet).

## E. Production approval (Phase E) — OPEN
E1 to E7 and the decision record are blank. Decision: ☐ GO ☐ NO-GO — **not decided**. A GO would cover one SHA and one window only.

## F. After deployment — N/A until deployed
Nothing is deployed. The Netlify (Supabase) site received `63de403` on 2026-10-13 per the owner; that build contains no Wave 1 behavior (static check) and does not count as a release of this checklist.

---

## Open items that must close before Phase C (summary)
1. Owner chooses the release SHA and the contiguity plan (0047–0049 first).
2. Re-run the harness on the release SHA; sign Phase B.
3. Upgrade test with pre-change signed visits (VIS-21b, VIS-27, MIG-W1c).
4. Bundle search for "EVV compliant" (VIS-38).
5. Security review checklist for 0050–0052.
6. ~~Update `smoke.py`~~ done locally; still to run on the pilot, and its 2 unrelated `care` failures to diagnose.
7. Decide whether the plan rows NOT BUILT or PARTIAL (VIS-26, VIS-54, VIS-57) block the pilot or move to a later wave.
