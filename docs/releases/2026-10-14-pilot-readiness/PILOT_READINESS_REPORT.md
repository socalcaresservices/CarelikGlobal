# Pilot readiness report: Wave 1 (migrations 0047 to 0052)

Date 2026-10-14. Author: Claude Code. Companion files in this folder: `BLOCKER_REGISTER.md`, `TEST_EVIDENCE_MATRIX.md`, `PILOT_OPERATOR_RUNBOOK.md`, `PILOT_DEPLOYMENT_PROCEDURE.md`, `rollback-0047-0052.sql`, `RELEASE_DECISION_PACKAGE.md`, `OPEN_PR_REVIEW.md`, `OWNER_ACTION_SHEET.md`, `evidence/PHASE_B_WALKTHROUGH.md`. The release checklist stays `docs/releases/2026-10-13-wave1/CHECKLIST.md` (the one authoritative checklist; this report feeds it).

**Four milestones are kept apart throughout:** *code complete* (merged), *locally tested* (isolated database, synthetic data), *deployed* (live in an environment), *verified live* (checked in that environment). Today Wave 1 is code complete and locally tested. It is **not deployed to any AWS environment** and **not verified live anywhere**.

## 1. Plain-English summary
**Finished.** The Wave 1 features (unscheduled visits need a reason and go to office review; the agency's schedule-variance rule; verbal and declined confirmations; caregiver attestation; the outcome screen; open-shift pickup) and the accounting fix (a minute counts once, as used or as reserved) are merged to `main`. The full local test suite passes with nothing skipped. Existing test scripts that the changes made out of date were fixed, and the one missing end-to-end test (a correctly scheduled visit, signed, Billing Ready, hours counted once) and the missing upgrade test (existing visits survive 0050 to 0052 unchanged) were added.

**Not finished.** We do not know what is running in the AWS pilot: its deployed commit, its database migration level, or whether the seed the smoke tests need is present. No reviewed procedure exists to deploy migrations 0047 to 0052 to the pilot. The live authentication check (SMK-06), the by-hand checks by people on a real phone, and the owner's decisions have not happened. Netlify has the `63de403` build (owner-confirmed) but the value of its sign-in setting is not recorded.

**Also finished in this assignment.** A persona walkthrough (administrator, scheduler, caregiver, authorization manager) on synthetic local data: 53 of 53 checks passed (`evidence/PHASE_B_WALKTHROUGH.md`). A read-only AWS preflight script with a guard test (drafted, **not run** against AWS). A written pilot deployment procedure and a rehearsed database rollback script (neither executed against AWS). One real control gap was found: a correction to a visit can turn an unscheduled visit into `signed` (VIS-54, B-12).

**What can safely happen next.** Push the branch for review (your approval), then the read-only preflight by a named operator. After it, decisions on tooling and the release commit, then the pilot deployment under its own approval. Pilot deployment is **NO-GO today**.

## 2. Baseline (inspected in the repository, not taken from memory)
| Fact | Value | Evidence |
|---|---|---|
| `main` | `484135df007bd10e76fdd37e8ddcb6db015a7dc7` (merge of PR #93) | `git rev-parse origin/main` |
| PR #87 | MERGED as `63de403f0c37d33cc8c7cb1c6d23202aee298965` (head `c1903b1`; validate, postgres, harness passed before merge) | git log; PR checks |
| PR #88, #89 | MERGED (#88 into the #87 branch, #89 into `main` as `c320a36`) | git log |
| PR #90 | **MERGED** as `0d63fd9` on 2026-10-14, after the owner's explicit instruction "Merge #90"; CI was green (validate, postgres, harness). Adds the hotfix rule to `docs/TESTING_AND_RELEASE_PROCESS.md` section 9 and the post-merge verification record. | git log; PR checks |
| PR #91, #92, #93 | MERGED (`b46bd40`, `17480dd`, `484135d`): Wave 1 checklist; `smoke.py` unscheduled-visit update; `smoke.py` availability-rule update. CI green on each | git log |
| Is `484135d` the relevant baseline? | Yes. `git diff 63de403 484135d` changes only `docs/TESTING_AND_RELEASE_PROCESS.md`, the Wave 1 `CHECKLIST.md` and `POST_MERGE_VERIFICATION.md`, and `infra/aws/slice/smoke.py`: **no application code, migration, API or Supabase file** | `git diff --stat` |
| Commits after `63de403` touching Wave 1 or 0047 to 0052 | None (documentation and the `smoke.py` script only) | same |
| Working tree | This assignment's work was merged to `main` by PR #94 as `12b5d4b` (branch head `75cb761`, after the owner's explicit push approval and a green CI run), then PR #95 (`9d710eb`, owner action sheet). CI on `main` is green for both merges. **Nothing is deployed.** | PR #94, #95; Actions runs 349 and 351 |
| Migrations defined | 52 (0001 to 0052); rollback scripts exist for 0047 to 0052 (and earlier ones, not individually checked); `db/verification/01_schema_version.sql` expects 0052 | `ls infra/aws/db/migrations` |
| Open pull requests | 17 older ones (#43 to #73, created 2026-08-24 to 2026-10-08); none concern Wave 1; whether they are superseded is not verified (Blocker B-18) | `list_pull_requests` |

## 3. Environment matrix (never assume any two are the same system)
| Environment | Purpose | Deployed SHA | Migration version | Verification |
|---|---|---|---|---|
| Local harness | Development testing | Built and run from `3f057a3` (application code identical to `484135d`; see `TEST_EVIDENCE_MATRIX.md` section 0) | 0052 (52 files applied by the real runner) | **VERIFIED** (LOCAL) |
| AWS pilot/test (`Ogevia-prod-*`, database `ogevia_sv_test`, app `d2xumch5w0izfg.cloudfront.net`, API `s0epy5rgzb`) | Synthetic-data acceptance testing | **NOT VERIFIED.** Last documented release: 0036 at `7b1236d` (owner-run 2026-10-05). The 2026-10-13 plan says the pilot ledger is unknown. | **NOT VERIFIED** (expected 46 before this release) | **BLOCKED** (no AWS access here): runbook section 1 |
| AWS production (`Ogevia-prd-*`, `ogevia_prd`, app `d3l4psdkokkvnb.cloudfront.net`, API `zk527zk4ua`) | Real service operations | **NOT VERIFIED** | Owner-reported `46|0046` on 2026-10-11 and again quoted on 2026-10-13; not verified; the owner states 0047 to 0052 are not released | **BLOCKED / NOT VERIFIED** |
| Netlify production (`www.ogevia.com`; project `carelikglobal`) | Public web (Supabase build when the sign-in setting is unset or `supabase`) | `63de403` **published 2026-10-13, owner-confirmed** (screenshots; five stages complete). Later `main` commits may also have been published: NOT VERIFIED | Backend is Supabase, not AWS: its schema is `supabase/migrations/` (unchanged since `63de403`); **the AWS ledger is irrelevant to it** | PARTIAL: deploy OWNER-reported; sign-in setting value NOT VERIFIED |
| `app.ogevia.com` | Unknown | NOT VERIFIED | NOT VERIFIED | Documents conflict (Blocker B-17) |

A Netlify publish does not deploy AWS code or run AWS migrations; an AWS deployment does not change Netlify. No CI job deploys anything.

## 4. Pilot-readiness dashboard
| Category | Status | Evidence | Remaining action | Responsible | Owner involved | GO/NO-GO impact |
|---|---|---|---|---|---|---|
| Code readiness | **VERIFIED** (merged, CI green) | `63de403`..`484135d` | None | n/a | No | None |
| Test readiness | **VERIFIED locally** | `TEST_EVIDENCE_MATRIX.md`: on `3f057a3`: 1,319 unit, 561 database, 75 API, 45 harness smoke, 53 persona-walkthrough checks, 79 smoke (twice), 11 pilot-smoke; 0 failed; 0 skipped in `test:all`; pilot regression 35 pass / 0 fail / 1 not run (SMK-06) | Live runs (Phase C); persona walkthrough is done locally (B-11 closed) | Claude Code / Operator | No | Phase C entry |
| Database readiness | **NOT VERIFIED live**; locally verified | Upgrade 0049→0052 rehearsal; rollback tests; 25 functions audited | Read pilot ledger; snapshot; apply under approval | Operator | Yes | **P0 until B-02 closes** |
| AWS pilot readiness | **BLOCKED** | No AWS access | Runbook section 1 | Operator | Yes (authorize) | **P0 (B-01 to B-04)** |
| Netlify readiness | **NOT VERIFIED** (deploy owner-confirmed) | Code interpretation verified | Owner provides three screens (section 6); decide automatic publishing (B-08) | Owner | Yes | Does not block the AWS pilot; blocks a hotfix-base statement |
| Security and permission readiness | **VERIFIED locally** | 25 functions: no definer without `search_path`, none executable by PUBLIC; new tables have row-level security and no direct app privileges; tenant, role, forged-claim tests pass | Reviewer signs the checklist (B-19); live checks (SMK-06, negative checks) | Reviewer / Operator | Yes (sign) | Phase C entry |
| Caregiver workflow readiness | **VERIFIED locally; NOT on a real phone** | Harness, API and smoke tests; 390 px Chromium screenshots | Real-phone acceptance (VIS-32/33/41) | Caregiver validator | Yes | Phase D |
| Scheduling readiness | **VERIFIED locally** | Shift, series, pickup tests; smoke scheduled workflow | Live scheduling smoke | Operator | No | Phase C |
| Authorization and accounting readiness | **VERIFIED locally** | Single-bucket tests; clean scheduled visit test; before/after evidence for 0049 and 0052 | Hand recalculation of three balances in the pilot | Owner + Scheduler | Yes | Phase D |
| Release and rollback readiness | **NOT VERIFIED** | Rollback tests pass locally; procedure documented | Snapshot id; pilot tooling decision (B-03); owner decisions O1 to O3 | Owner / Operator | Yes | **P0 (B-03, B-04)** |

No percentage is given because there is no measurable denominator; the count that matters is open P0 items: **4 (B-01 to B-04)**, all missing evidence or decisions, none a known defect.

## 5. What was fixed or added during this assignment (merged to `main` in PR #94; not deployed)
1. `smoke.py` expected exactly 38 API routes; the handler has 169. It now reads the count from the handler's route table (checked by import and `slice-contract.test.ts`).
2. New `scheduled` workflow in `smoke.py` (14 checks): a 15-minute shift, start on it, end, signature, signed/Billing Ready, hours counted once, retry refused. Re-runnable within the hour (tries later start times when the slot is taken).
3. New API test: the clean scheduled visit end to end with accounting and billing-review state.
4. New upgrade test `upgrade-0049-to-0052.db.test.ts`.
5. Read-only pilot preflight (`pilot-preflight-readonly.sh`, `pilot_preflight_probe.py`) with a static guard test; not run against AWS.
6. Pilot deployment procedure, rollback SQL (rehearsed locally), operator runbook, blocker register, evidence matrix, open-PR review, owner action sheet, Phase B walkthrough evidence, this report and the decision package.
Merged to `main` (PR #94, then #95 for the owner action sheet). Nothing was deployed.

## 6. Netlify: what to read (owner, about five minutes, no secrets; the same steps are in `OWNER_ACTION_SHEET.md` Task 2)
Open `https://app.netlify.com/projects/carelikglobal/deploys` and sign in.
1. **Deploys → Production deploys, top row.** Screenshot: the short commit SHA, "Published" time and state. (Tells us whether `484135d` or `63de403` is live — B-07.) Then open the row for `63de403` and note its time.
2. **Site configuration → Environment variables.** Look for `VITE_AUTH_PROVIDER`. Screenshot the *row* showing its name, its scopes (Production / Deploy Previews / Branch deploys) and, if shown, its value. If it is not in the list, say "not set". **Do not reveal, open or screenshot any other variable** (some hold keys). Also note whether any other variable starts with `VITE_COGNITO_`: if one exists, it matters only together with `VITE_AUTH_PROVIDER=cognito`.
3. **Site configuration → Build & deploy → Continuous deployment** (and the Deploys page): note the **production branch** and whether **auto publishing** is on (the Deploys page shows a "Stop auto publishing" button when it is). Do not change it.
4. *(Optional, sixty seconds.)* In a private window open `https://www.ogevia.com`, open the browser's developer tools → Network, and load the sign-in page without typing anything: requests to `*.supabase.co` mean the Supabase build; a redirect to an Amazon Cognito sign-in domain means the Cognito build. Screenshot the request list only.
**Interpretation (VERIFIED against code, `packages/auth/src/auth-provider.tsx:231-233`, `apps/web/src/main.tsx:12`, `apps/web/src/env.ts:42-44`):** unset or empty → Supabase; `supabase` → Supabase; `cognito` → AWS build; any other value → configuration failure. Fine for this site: unset or `supabase`. A problem: `cognito`, or anything else.
After you send the screens: I record them in `docs/releases/2026-10-13-wave1/POST_MERGE_VERIFICATION.md` and close items B-06 and B-07. The same facts will not be asked again.

## 7. Hotfix and release safety
PR #90's rule (`docs/TESTING_AND_RELEASE_PROCESS.md` section 9) is in force: until 0047 to 0052 are released, a hotfix branches from the last **verified deployed** commit of the environment concerned, not from `main`, and still passes all six gates. Today no environment's deployed SHA is verified from the environment itself (B-01, B-07, B-14), so a hotfix base cannot yet be named with evidence: for AWS the designated commit was `1639cf6` (never confirmed deployed); for Netlify it is `63de403` (owner-confirmed) or later. That gap closes with the preflight and the Netlify screens. Automatic publishing of `main` on Netlify is reported as decision B-08; nothing was changed.

## 8. Owner actions, grouped (the smallest set)
| # | Action | Where | Sensitive? | What happens next |
|---|---|---|---|---|
| 0 | ~~Approve pushing the work branch~~ **Done**: merged as PR #94 (`12b5d4b`) and #95 (`9d710eb`). The operator takes the preflight script from `main` | n/a | No | n/a |
| 1 | Netlify screens (section 6) | app.netlify.com project `carelikglobal` | No (do not capture other variables) | I record them and close B-06, B-07 |
| 2 | Authorize and run the **read-only** AWS preflight (runbook sections 1 and 5; nothing changes) or name the Operator | AWS CloudShell | No secrets are printed | I record the results; B-01, B-02, B-05, B-09 close or become STOP items |
| 3 | Decisions: (a) release SHA and `OGEVIA_DEPLOY_APPROVAL` reference; (b) approve writing a reviewed pilot deployment script (B-03); (c) B-08 automatic publishing; (d) B-12 whether VIS-26/54/57 block the pilot (I recommend no); (e) B-13 who sets the agency's variance value; (f) B-17 what `app.ogevia.com` serves | A message to me | No | Deployment is only proposed after 1 and 2 are done |
