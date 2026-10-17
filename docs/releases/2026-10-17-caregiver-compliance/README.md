# Caregiver compliance hold: release report (2026-10-17)

**Status: IMPLEMENTED and TESTED LOCALLY (synthetic data, local PostgreSQL 16). PREPARED FOR REVIEW. NOT DEPLOYED. NOT RUN ON THE PILOT/TEST ENVIRONMENT. No AWS setting, live database or live caregiver record was touched.**
**The rules below are the owner's own product rules. They are not stated or verified as legal requirements.**
Companions: `FEATURE_TEST_PLAN.md`, `PILOT_CHECKLIST.md`, catalog area **CMP** in `docs/release-process/ACCEPTANCE_TEST_CATALOG.md`.

## 1. Objective
Stop a caregiver from being given work, or starting a visit, until (1) an authorised administrator has verified an **approved** background-check result, and (2) CPR and TB are verified within 14 calendar days of the hire date; hold the caregiver automatically when that period ends; show the office exactly what to cover; keep history; never end a visit in progress.

## 2. Exact deadline calculation (agency time zone)
| Item | Rule |
|---|---|
| Hire date | A calendar date in the agency's own time zone (`organizations.timezone`, today `America/Los_Angeles`). Day 0. |
| Due date | hire date + 14 calendar days. **The due date is the last day** to complete both requirements. |
| Hold begins | `(hire date + 15 days) at 00:00 agency-local`, converted with `AT TIME ZONE`: the first instant after the due date. In grace while `now < that instant`. A daylight-saving day is 23 or 25 hours; the boundary stays at local midnight (tested on 2026-11-01 and 2027-03-14). |
| Missing hire date | No period exists. A caregiver without current **verified** CPR and TB is blocked and held with the reason "Hire date is not recorded, so the 14-day period cannot be applied." Nothing is assumed. |
| Where the 14 lives | `ogevia.compliance_grace_days()`, one function. |
| Sticky | A hold opened because the period **ended** stays closed to the grace period: moving the hire date later does not reopen it. A hold that exists only because the date was missing clears when the real date is entered. |
| Inside the period | A CPR/TB record that is **missing** or only **uploaded (awaiting review)** is *pending*, not blocking. Rejected, expired, expiring before the work ends, expiry date missing, and "agency has not set up the CPR/TB type or rule" **keep blocking at once** (existing stricter controls, unchanged). |

## 3. What already existed (VERIFIED by reading the code at `d82fefc`) and was reused
| Existing control | Where | Use now |
|---|---|---|
| One commit-time gate `readiness_checks` / `assert_ready_for_work`, called by shift creation, reschedule, reassignment, care-request assignment, standing assignment, series, ad-hoc start and (trigger) every new live visit | 0042, last redefined 0047; trigger 0044 | **Extended in place** with a `background` check and the grace rule. No new call sites, so every path enforces the new rules. |
| Open-shift pickup calls `check_shift_caregiver` (the gate) | 0051 | Enforced with no change. |
| CPR/TB "verified, current, covering the work" decision `document_requirement_check`; administrator-only verification | 0041, 0044 | Reused unchanged. |
| Advice flags on shifts and standing assignments, with resolve columns | 0039/0040/0041 | New `compliance` kind on the same tables. |
| Owner's enforcement switch, report-only first | 0042 | The new checks follow the **same** switch (decision gate D1). |
| Audit (`write_audit`), idempotency keys, the per-caregiver advisory lock, RLS pattern, readonly role grants | 0005, 0039 | Reused. |
| Hire type, scheduling mode on `caregiver_records`; a `background_check_status` text on the *Supabase-era* applicant record | 0030; web only | Not present in the AWS database: **no hire date and no background-check field existed there**. New. |
| No scheduler of any kind (document reminders are computed on read) | n/a | New, prepared only (section 6). |

## 4. What changed
| Area | Change |
|---|---|
| Database `0053_caregiver_compliance_hold.sql` (rollback `0053_...down.sql`, BACKUP REQUIRED) | `caregiver_records.hire_date`; tables `caregiver_background_checks`, `caregiver_compliance_holds`; permission `caregivers.compliance.manage` (organization owner); `compliance` flag kind and `compliance_hold` series skip reason; functions `compliance_grace`, `background_clearance_state`, `compliance_blockers`, `compliance_evaluate`, `compliance_flag_impact`, `compliance_sweep`, `compliance_snapshot`; the gate (`readiness_checks`, `readiness_enforced`, `readiness_message`, `readiness_outcome`) edited; before-write triggers on `shifts` and `caregiver_assignments` (defence in depth for any path that skips the functions); after-change triggers on `document_versions` and `staff_documents` that re-evaluate the caregiver at once; API functions listed in section 6. |
| API (`apps/sv-api`) | Six routes, the Action needed field, the readiness report field, the `compliance` flag filter; `src/scheduled.ts` (scheduled run) and its entry in `src/index.ts`. |
| Infrastructure code (`infra/aws`) | Six routes in the API route list; one EventBridge rule resource (**not deployed**); allow-list entry `AWS::Events::Rule` (FREE). |
| Web (`apps/web`) | Compliance card on the Care Team profile; **Caregiver Holds** page `/compliance`; one Action needed line; permission added to the shared schema. |
| Tests/harness/docs | 28 + 5 + 5 + 14 new tests; harness seeds approved clearance for fixture caregivers; seven existing tests updated for the new migration (table lists, ledger version, rollback chain); catalog area CMP; this folder. |

## 5. Requirement by requirement
| # | Requirement | Implementation | Status |
|---|---|---|---|
| 1 | Create before clearance; block assignment until verified; "completed" alone never qualifies | `caregiver_background_checks`: status (process) is separate from result. Clearance = `result = approved` **and** `verified_by`/`verified_at`. Only `verify_background_check` writes a result; status changes can never. Reopening an approved check withdraws the approval. | VERIFIED by tests CMP-01/02 |
| 2 | 14 days, due date and pending items on the profile, auto flag and hold, agency time zone, missing date not a bypass, stricter controls kept | Section 2; the Compliance card shows hire date, due date, the exact hold time and pending items | VERIFIED by tests CMP-03 to CMP-06, CMP-14 |
| 3 | Backend enforcement; hold flags assignments incl. recurring; Action needed; history preserved; in-progress visit alerts, never ends | The gate + triggers; `compliance_flag_impact` flags every scheduled shift row (each recurring occurrence) and active standing assignment; Caregiver Holds; nothing is cancelled, moved, reassigned or ended | VERIFIED by tests CMP-07 to CMP-09, CMP-13 |
| 4 | Exact reason + links; authorised verification only; restore only when all resolved; audit; never resume cancelled/reassigned | Reasons carry the plain message and a link; administrator only, never your own record; release is the same evaluation, only when no blocking item remains; audit on every change; release resolves flags and restores nothing | VERIFIED by tests CMP-10 to CMP-12 |
| 5 | Verification of boundary, missing date, CPR-only/TB-only, existing work, recurring shifts, direct API bypass, permissions, release, deadline with nobody watching | Section 8 | VERIFIED locally; **pilot NOT RUN** |

## 6. Interfaces
Routes (all JWT-protected, tenant from the verified identity, server-side decisions): `GET /v1/caregivers/{id}/compliance`; `POST /v1/caregivers/{id}/hire-date`; `POST .../background-check/status`; `POST .../background-check/verify`; `GET /v1/compliance/holds`; `POST /v1/compliance/sweep` ("Check now"). Also `GET /v1/attention` gains `complianceHolds` (null when not permitted, never a false zero); `GET /v1/readiness` gains `compliance` (who would be held, before activation); `GET /v1/readiness/flags?kind=compliance`.
Scheduled run (prepared, **not deployed**): EventBridge `rate(15 minutes)` → the same API Lambda with a constant payload `{ "ogevia-task": "compliance-sweep" }` that API Gateway can never produce; the handler calls `ogevia_api.system_compliance_orgs()` then `system_compliance_sweep_org(org)` one agency per short transaction as the application role (no signed-in person), logs counts and an error code only, and fails the run if any agency failed. Cost: EventBridge scheduled rules have no charge; 96 invocations a day. Deploying it is a YELLOW action.

## 7. Decision gates (owner decisions; the safe default was chosen and the change is reversible)
| ID | Question | What is known | Default chosen | If you choose differently |
|---|---|---|---|---|
| D1 | Are the new rules always on, or do they follow the owner's existing enforcement switch? | Production caregivers have no recorded clearance or hire date (the fields did not exist). | **Follow the switch.** Before activation they report; the readiness report lists who would be held. | Always-on would block every existing caregiver the moment 0053 is applied (nobody could start a visit) until an administrator enters data for each. Not recommended without a data-entry step first. |
| D2 | Who may verify background clearance? | CPR/TB verification is administrator-only (0044). | `caregivers.compliance.manage` = organization owner only. Managers track status and enter a first-time hire date. | Granting the permission to managers is one `role_permissions` row; every verification is still audited. |
| D3 | Is "14 calendar days from the hire date" inclusive of day 14? | The owner's text does not say. | Due date = hire + 14 (inclusive); hold at 00:00 the next day. | Treating hire + 14 as the first held day shortens the period by one day: change `compliance_grace` by one term. |
| D4 | Is an uploaded but unverified CPR/TB "pending"? | The owner requires *verified* records. | Pending inside the period, blocking after it. | Treating it as blocking from day 0 makes the period useless for anyone who has uploaded. |
| D5 | Existing caregivers | No hire date and no clearance on file; nothing was backfilled (no live record may be changed). | None backfilled. | Backfill is a separate, audited data task the owner approves. |
| D6 | Migration number | Another unmerged branch (`claude/determined-goodall-syvv7s`) also uses `0053` and `0054`. | Left as `0053`. | Whichever merges second renumbers; the runner requires contiguous numbers. |
| D7 | Deploy the 15-minute rule? | Needed for automatic flags/alerts at the deadline; enforcement does not need it. | Prepared, not deployed. | Without it: the block is automatic, but the hold record, flags and Action needed entry for a deadline that passed appear when staff presses **Check now** or when any document/clearance/hire-date change re-evaluates the caregiver. |
| D8 | May the office (manager) enter a missing hire date? | That is what clears a "no hire date" hold; the date is audited with a reason. | Yes for a date not yet recorded; changing a recorded date is administrator-only. | Owner-only removes a manager's ability to fix a missing date and is slower. |
| D9 | Evidence for the background check | A note naming where the clearance was confirmed; no report content is stored. | Note only (3 to 500 characters). | Attaching a document would store sensitive report data; needs a privacy review. |

## 8. Test evidence (local, synthetic)
| Check | Result |
|---|---|
| Existing database suites before the change | 561 tests: pass (the two `prd-deploy-scripts` tests fail on the baseline too under this sandbox's default password authentication, and pass once loopback authentication is `trust`) |
| **New** `db/test/compliance-hold.db.test.ts` | 28 tests: report-only; exact boundary (14 days inclusive, midnight, 25-hour and 23-hour days); missing hire date; CPR-only and TB-only; uploaded-not-verified; rejected/expired not relaxed; background (none/completed-only/not-approved/approved); every path (manual, reassignment, pickup, standing assignment, series, visit start, direct database write) refused; the deadline passing with no one opening anything and the scheduled run (no person) opening the hold, flagging a single shift, 14 recurring occurrences and a standing assignment, auditing it with no actor, idempotent; cancelled/reassigned not flagged; in-progress visit not ended and still endable; history unchanged; sticky hold; partial then full release by the verifying administrator; multi-cause hold; permissions; self-verification refused; idempotent replay; audit rows; cross-tenant |
| **New** `apps/sv-api/test/compliance.db.test.ts` | 5 tests through the real handler: validation (400), permissions (403), other agency (404), direct bypass attempts (422 `not_ready`, nothing written), Action needed numbers, readiness report |
| **New** `apps/sv-api/test/scheduled.test.ts` | 5 tests: event shape cannot be forged over HTTP, one transaction per agency, a failed agency fails the run and logs no names, malformed role refused |
| **New** web `compliance.test.tsx` | 14 tests: card states, hold reasons and links, pending dates, missing hire date, role differences, "completed is not cleared", report-only banner, holds page with an urgent in-progress alert, Check now, Action needed category |
| Deliberate breakages (each then restored) | Deadline moved by one day: 5 tests failed. "Completed" accepted as clearance: 5 tests failed. |
| Full gate | See section 9 |

## 9. Gate results
**PASS.** `OGEVIA_TEST_DATABASE_URL=<local> pnpm test:all` exited 0 with the line "PASS  all suites ran, none skipped, all passed." (unit/static, database and API steps; local PostgreSQL 16, synthetic data, sandbox loopback authentication set to `trust` so the two `prd-deploy-scripts` tests run). Also: `pnpm lint`, `pnpm typecheck`, `pnpm build` exit 0. This is a local result only; nothing was run on TEST.

## 10. Remaining gaps (honest list)
1. **Not deployed and not run on the pilot.** Phases C and D of `docs/TESTING_AND_RELEASE_PROCESS.md` have not been done; `PILOT_CHECKLIST.md` is the script.
2. **Automatic hold record at the deadline needs the 15-minute rule deployed (D7).** The *block* does not.
3. **"Immediately alert" is the Action needed line** (staff actions re-evaluate at once; the badge polls every 5 minutes). There is no push, SMS or email in the AWS build today, so no out-of-app alert exists.
4. **The caregiver's own message** when blocked is the server's plain text ("CPR missing. TB missing."). It does not yet say "ask the office". NOT BUILT.
5. **The Schedule view does not mark flagged shifts**; they appear in Caregiver Holds and through `GET /v1/readiness/flags`. NOT VERIFIED whether the schedule already surfaces other flag kinds.
6. **No concurrency test** of "hold opens while an assignment is being made". Every evaluation and every commit check takes the same per-caregiver lock (`ogevia.lock_caregiver`), but this was not exercised under parallel load.
7. **Activation count semantic:** the "affected shifts" number the owner must confirm before activating now also counts shifts blocked by missing background clearance (it counts every blocked check except service). This is intended, but changes the number the owner will see.
8. **Mobile (390 px) and screen-reader checks were not run in a real browser.** The web logic is covered by jsdom tests only. NOT VERIFIED.
9. The enforcement trigger on `caregiver_assignments` also fires for direct fixture inserts; one shared test helper writes fixtures with triggers off. Product paths are unaffected.
10. Real Cognito sign-in, the authorizer and CloudFront were not exercised (no AWS access in this environment).

## 11. Rollback and next approval
- Rollback order: web → API → `0053_caregiver_compliance_hold.down.sql` (BACKUP REQUIRED: take a snapshot and export hire dates, background results and hold history first). The down script restores the 0047 gate and was tested (empty round trip, populated upgrade/rollback, readiness release rollback and restore).
- **Next approval gate (owner):** review this report and decisions D1 to D9; approve a snapshot and the Phase C deployment of migration 0053, the API and the web to TEST only; separately approve the EventBridge rule (D7).
