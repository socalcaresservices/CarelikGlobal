# TEST deployment: approval request (UNSIGNED)

**STATUS: APPROVED FOR TEST DEPLOYMENT ONLY - recorded 2026-10-29 about 05:45Z from the Owner's own message and restated about 05:51Z with identical values. This approval does NOT authorize production, a merge to `main`, or any change outside TEST.** The request below is kept as written; its fields now carry the values the Owner supplied. The approval covers deployment SHA `fb491a554c0fdc484102025179c9c993f694b4e0`, the tarball with sha256 `c61e2a73df6c9c57e14cf9f443f21b324e6d993a311444046dec023757bed6b8`, and the window below, and nothing else.

## 1. What is requested
Permission to run the TEST upgrade procedure `docs/releases/2026-10-26-redesign-operator/OPERATOR_PROCEDURE_fb491a5.md` (Steps 0-16) on the TEST environment: apply migration **0087** (on top of the 0086 already on TEST), deploy the TEST API stack (Handler and one route), publish the TEST web build, then run the V4, V5 and V6 verifications with the Owner.

| Field | Value |
|---|---|
| Environment | **TEST only**: stacks `Ogevia-prod-*`, database `ogevia_sv_test`, API `s0epy5rgzb`, web `demo.ogevia.com`, account `300094796789`, region `us-west-2`. **Not** `Ogevia-prd-*`, not `ogevia_prd`, not `main`, not Netlify, not Supabase |
| **Candidate (deployment) SHA** | `fb491a554c0fdc484102025179c9c993f694b4e0` (`fb491a5`) |
| CI-tested SHAs, and their results | `cd57ffb3a7638238cf31e2ad4733ee0a5f4dd1e1`: validate, harness, postgres all success (https://github.com/socalcaresservices/CarelikGlobal/actions/runs/40766462415). `cea8b47eaed56764f10b1ea07325ebe22f0e869e`: validate and harness success, **postgres failure, cause not identified** (https://github.com/socalcaresservices/CarelikGlobal/actions/runs/40771238644). The result for the final documentation head is in the PR's checks; **see pre-condition P1** |
| Package | **prepared 2026-10-29**: `ogevia-operator-fb491a5.tar.gz`, sha256 `c61e2a73df6c9c57e14cf9f443f21b324e6d993a311444046dec023757bed6b8`; `BUILD_INFO.json` carries the placeholder reference and the Operator exports the real one at run time (details: `OWNER_DECISIONS_FOR_TEST.md` section 6) |
| Migration | 0087 only (functions; ledger unchanged at 85 / `0085`); 0086 untouched; files `f9d75d8c…` (up) and `1789131e…` (down) |
| Expected TEST change | web `7870a04` → `fb491a5`; Handler `94b73574c5a6…` → `2871b03d6be4…`; routes 241 → 242; 0087 absent → present |
| Reads | `RELEASE_MANIFEST.md`, `MIGRATION_STATUS_MATRIX.md`, `CHECKLIST.md`, `OPEN_RISKS_AND_ASSUMPTIONS.md` in this folder |

## 2. Fields the Owner fills (nothing is pre-approved)
| Field | Value |
|---|---|
| Approval reference (6-64 characters of `A-Za-z0-9._-`; the scripts refuse anything else) | `OGEVIA-TEST-GO-20261028` (supplied by the Owner on 2026-10-29 (05:09Z); 23 characters, matches the required pattern). **A reference is not a GO**: the decision row below stays blank |
| Operator (who runs the commands in CloudShell) | **Stella Okereke** (supplied by the Owner on 2026-10-29 (05:09Z)). The Owner states that the Operator and the approver are different people; the approver's name is still to be filled below |
| Release window, UTC start and end (at most 12 hours; the window bounds the snapshot and the 0087 apply) | **2026-10-29 05:00Z to 2026-10-29 09:00Z** (4 hours) (supplied by the Owner on 2026-10-29 (05:09Z)). Pacific: 22:00 on 28 Oct to 02:00 on 29 Oct (PDT, UTC-7; DST ends 1 Nov). **This window was already open (05:09Z) when it was recorded; opening it authorizes nothing, and nothing may start without the signed GO** |
| Admin host private IP (the host tagged `ogevia-db-admin-temp`) | **`10.20.132.179`** (instance `i-0ce8db2d7e5839dd5`), pasted by the Owner on 2026-10-29 at about 05:15Z from the read-only lookup: `i-0ce8db2d7e5839dd5  10.20.132.179  1  1` (one instance, one interface, one private address). Not independently re-read by the development session; the TEST script re-reads it live and refuses a mismatch |
| Tarball sha256 | `c61e2a73df6c9c57e14cf9f443f21b324e6d993a311444046dec023757bed6b8` (prepared; the Owner copies it into the GO message) |
| Decision | ☑ **GO for TEST - "APPROVED FOR TEST DEPLOYMENT ONLY"** ☐ NO-GO (the Owner's words; production is not authorized) |
| Approver (as given by the Owner), date and time | **Socal Care Services**, restated by the Owner on 2026-10-29 about 05:51Z as **"You (Socal Care Services)"**: the approver is the person who issued this instruction in the session, acting for Socal Care Services. The Owner has said the Operator and the approver are different people. No individual's name has been given, and none is inferred here; the Owner may add it. GO first recorded about 05:45Z, restated about 05:51Z with identical values |
| Conditions or exceptions (written) | Those the Owner has already stated, and nothing more: P1 CI evidence accepted on `1b27f82` with U6 (flaky `postgres` job) open; V7 option B, a TEST-only exception, with an independent SQL review required before any production request; V4 and V5's M-1 step stay BLOCKED or NOT VERIFIED until their accounts exist; no exception to the TEST freeze, the snapshot, the pin and gate checks or the stop rules of the procedure |

The GO covers this SHA, this package and this window only. If the window ends before Step 9 (apply) completes, the approval does not extend: stop and ask for a new window.

## 3. Rollback plan (TEST)
Reverse order of deployment: web, then API, then database. AWS recovery commands are YELLOW and **not rehearsed on AWS**; the database rollbacks were rehearsed on a real PostgreSQL only (`MIGRATION_STATUS_MATRIX.md` section 6, procedure section 8).

| Failure point | Action | Evidence it worked |
|---|---|---|
| Step 9 (apply 0087) | none needed: one transaction keeps nothing of 0087 on failure; fix, re-run from Step 6 | `APPLY FAILED... nothing of 0087 was kept`; objects `1\|1\|21` and `0` |
| Step 10 (API) | R2: restore the previous Lambda code captured at Step 5 | CodeSha256 equals the baseline |
| Step 11 (web) | R1: restore the captured web files | served `index.html` hash equals the captured hash |
| 0087 must be removed | R3: `apply-0087-test.sh rollback` (0087 only; 0086 stays), after R1 and R2. Do not invite anyone on TEST afterwards (0086 alone activates an existing sign-in at once, finding M-1) | objects `1\|1\|21` and `0`; ledger 85 / `0085`; people counts identical |
| Last resort | R4: snapshot restore - documented, **not prepared, not rehearsed**; the snapshot also holds `ogevia_prd`, so it is never restored in place | n/a |

A named restore-point snapshot `ogevia-prod-postgres-pre-0087-<stamp>` is taken inside the window (Step 7) and verified `available`, manual, encrypted before anything changes. It is a prerequisite only.

## 4. Checks, split by when they can run

### 4.1 Must pass BEFORE the TEST deployment (no AWS needed)
| # | Check | Status today |
|---|---|---|
| P1 | CI on the final PR head: `validate`, `harness`, `postgres` success. Green on `1b27f82` (https://github.com/socalcaresservices/CarelikGlobal/actions/runs/40778866660). The `postgres` job was nondeterministic on identical code (red on `cea8b47`, failing test never identified) | **ACCEPTED by the Owner on 2026-10-28** on the green `1b27f82` run, with U6 kept open as a known flaky-test risk (`OWNER_DECISIONS_FOR_TEST.md` section 0) |
| P2 | Local gates: lint, typecheck, build, unit suites; sv-api database suite | PASSED locally. The local infra database suite does not pass in the development sandbox (28 failures, same four files as the baseline); CI on PostgreSQL 18 is the arbiter (see P1) |
| P3 | Package checks: pin check, assembly check, expected-only diff gate, deploy guard, apply script, route smoke, deployed-record script, tarball determinism | Static package tests PASSED (CI `validate` success on `cd57ffb` and `cea8b47`); the database-backed package tests run in the `postgres` job (see P1); both placeholder tarballs rebuilt byte-identically on 2026-10-28 |
| P4 | Owner has reviewed `RELEASE_MANIFEST.md` | **OPEN** (review log: `OWNER_DECISIONS_FOR_TEST.md` section 3) |
| P5 | Second-person review of the 0087 SQL (V7), or a written Owner exception | **DECIDED 2026-10-29: option B, a written Owner exception for TEST only** (`OWNER_DECISIONS_FOR_TEST.md` section 4). `SECURITY_REVIEW_0087.md` stays unsigned; option A is required before any production request |
| P6 | Approval reference, Operator, window and admin host IP supplied (section 2) | **OPEN** (guidance and operator confirmation list: `OWNER_DECISIONS_FOR_TEST.md` sections 1-2; the records name the operator differently, so it needs the Owner's confirmation) |
| P7 | Shippable tarball built; its sha256 given to the Operator | **PREPARED** (sha256 `c61e2a73df6c9c57e14cf9f443f21b324e6d993a311444046dec023757bed6b8`, placeholder reference, runtime reference); delivery to you and upload by the Operator are OPEN |
| P8 | Operator ready: CloudShell in us-west-2 with the prerequisites in procedure section 4, and a second CloudShell session ready for recovery | **NOT VERIFIED** |
| P9 | TEST freeze and Demo users warned (procedure D5); nobody schedules, edits or invites staff on TEST during Steps 9-11 | **OPEN** |

### 4.2 Can only run on the deployed TEST environment
| # | Check | Status |
|---|---|---|
| T1 | Procedure Steps 5-16: baseline, ledger re-read (85 / `0085`, 0086 present `1\|1\|21`, 0087 absent), snapshot, five-stack gates, apply 0087 (`verify-0086` 110 and `verify-0087` 24 PASS), API deploy, web publish and bundle-version check, route smoke, sweep, final ledger and objects, deployed record | NOT RUN |
| T2 | Handler asset key `2871b03d6be4…` reproduces in the Operator's CloudShell (Step 4 decides) | **NOT VERIFIED** |
| T3 | **V4**: same-agency Caregiver gets 403 on the four staff routes; other-agency and non-Owner negatives; `invitation_checks_v4.py` phases | NOT RUN. The same-agency Caregiver sign-in does not exist: **BLOCKED** until the Owner creates it in V4 step C1 |
| T4 | **V5**: M-1 (an existing sign-in outside the TEST agency receives a pending invitation and gets no access until it accepts), L-1, L-2, L-3 in a browser with a real sign-in | NOT RUN. The invitee needs an existing sign-in reachable by e-mail (accounts D or E, browser sign-in **NOT VERIFIED**): otherwise the M-1 live check is **BLOCKED** and the Owner decides whether the CI database and API tests suffice |
| T5 | **V6**: the Owner's own walk-through of Staff, invitations and the Accounts list on TEST | NOT RUN |
| T6 | **V7**: signed review of the SQL | see P5 |
| T7 | Web label: the amber "TEST - synthetic data only" band on sign-in screens now shows on `demo.ogevia.com` (published with `fb491a5`; the records do not show the `24fd8b1` label having been published to TEST, so treat it as not yet there) | NOT RUN |
| T8 | The JWT authorizer with a real Cognito token on the accept route (CI exercises refusals only) | **NOT VERIFIED** |

Any failed T-check is a stop; none is an exception unless the Owner writes one.

## 5. What this request does not do
No production approval; no merge to `main`; no promotion of 0086/0087 into `db/migrations`; no change to Netlify, Supabase, DNS or Cognito production; no Phase E. Production would need its own package, window, snapshot, V3-V7 disposition and a separate signed GO (`MIGRATION_STATUS_MATRIX.md` section 3).
