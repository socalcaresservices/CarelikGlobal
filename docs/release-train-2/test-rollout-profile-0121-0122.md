# TEST rollout: caregiver profile, 0121 (one email, one person), 0122 (unset CPR/TB type is not a block)

Status: **PROPOSED. Nothing from this document has been applied.** TEST only. Production (`Ogevia-prd-*`, `ogevia_prd`) is not part of it and every script named here refuses a production target.
Owner decisions: layout review first; scheduling behaviour is signed off only after the enforcement-on TEST cases below pass (owner, 2026-11-27).

## What changes, and the exact commits
| Change | Kind | Code commit | Notes |
|---|---|---|---|
| Caregiver profile redesign (four tabs, compact rows, real holds shown) | web only | `3bdfd9e7` (profile `6a1f813e` + phone 44 px fix), later hold display in `428cfaea` | no API change |
| 0121 one email, one person | database only | `479fdf26` | five functions replaced; only new writes are checked |
| 0122 unset CPR/TB document type is not a block | database only | `428cfaea` | three functions replaced (`readiness_checks`, `compliance_blockers`, `caregiver_readiness`) plus one helper |
| Release commit to deploy from | | **`cb1d8569`** (re-pin; contains all of the above) | the web build is taken from this commit |

No API Lambda, CloudFormation or switch change. 0122 rule, in one line: for a caregiver whose admin work approval is **recorded** (`caregiver_work_approvals`), a CPR/TB document **type** that the agency has not set up is shown ("Document type not set up") and does not block scheduling or open a compliance hold. Unchanged: configured documents, missing/rejected/expired credentials where the rule requires them, a document **rule** that is not set up (`policy_not_set`), the background check, hours, availability, conflicts, every other hold, and enforcement itself. A caregiver without a recorded approval behaves as before.

## Deployment order (TEST)
Stop at the first failure. Each step has its own rollback below.
1. **Preconditions:** CI green on `cb1d8569`; the owner's GO and a TEST authorization reference (`<ref>`, 6 to 64 characters of letters, digits, `.`, `_`, `-`).
2. **Snapshot:** `aws rds create-db-snapshot --region us-west-2 --db-instance-identifier ogevia-postgres --db-snapshot-identifier ogevia-test-pre-0121-0122`, then wait for `aws rds describe-db-snapshots --region us-west-2 --db-snapshot-identifier ogevia-test-pre-0121-0122 --query 'DBSnapshots[0].Status'` to say `available`. (The instance holds more than the TEST database; the snapshot is a safety copy, and a restore always makes a NEW instance, never an overwrite.)
3. **Check out the release commit** in CloudShell (full hash; GitHub refuses a short one): `git fetch --depth 1 origin cb1d8569…` then `git checkout` it. (Use the full 40-character hash from `git rev-parse` on the branch.)
4. **0121:** from `docs/releases/2026-11-20-test-plan/toolchain`:
   `bash TEST_DB_SESSION.sh bash TEST_PENDING_LEDGER.sh probe 0121`
   `bash TEST_DB_SESSION.sh env OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_TEST_SNAPSHOT=ogevia-test-pre-0121-0122 bash TEST_PENDING_LEDGER.sh apply 0121`
   `bash TEST_DB_SESSION.sh bash TEST_PENDING_LEDGER.sh verify 0121`
5. **0122:** the same three commands with `0122`. `probe` must show `prerequisites missing: none` (it needs 0103).
6. **Web publish (TEST only):** `REPO=<checkout> OGEVIA_RELEASE_COMMIT=<full cb1d8569 hash> WORK=<work dir> OGEVIA_DEPLOY_APPROVAL=<ref> bash TEST_WEB_FIX.sh deploy`, typed word `PUBLISH-TEST-WEB`. It captures the live files first (the web rollback reference), builds for TEST, uploads without deleting, invalidates CloudFront and verifies what the site serves.
7. **Hand-off:** tell me it finished; I read the TEST state back with the read-only checks below before the owner starts the cases.

## Enforcement-on verification (owner, in TEST, synthetic caregivers only)
**Read this first:** the app refuses to switch enforcement on until CPR and TB are set up (`activate_readiness_enforcement` returns "Finish the CPR and TB setup first"), and there is **no in-app way to switch enforcement off again** (it says "already active"). Turning it on in TEST is therefore a one-way setting; the way back is the snapshot (a new instance) or an owner-approved SQL change to `organization_readiness_settings`. Because of that order, the "unset type" case is built **after** activation by retiring the CPR and TB types, exactly the state 0122 is about.
A. **Finish the setup** (Care Team page, readiness card): create the CPR and TB document types with their validity rules (the one-click standard types if offered). Re-open any caregiver: both rows now show real document status, not "Document type not set up".
B. **Activate enforcement** (Operations readiness card): review the affected-work count and activate with a reason. Read back: `bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -v cg=<code> -f CHECK_SCHEDULING_0122.sql` must show `enforcement_on = t`.
C. **Case 2 first (configured types):** use a synthetic caregiver whose hire date is more than 30 days ago, with an approved background check, completed training and a recorded work approval, and **no** CPR document. Try to schedule a shift in Admin, Schedule: it must be **refused**, naming CPR. Upload and verify a current CPR and TB for the same caregiver: the same shift can now be scheduled. (A rejected or expired document also refuses.)
D. **Case 1 (unset type):** retire the CPR type and the TB type (Documents, document types; the app refuses while requests are open, so cancel or finish them first). Use an **admin-approved** synthetic caregiver with no other hold (background approved, training done, available). Open Readiness: CPR and TB read **Document type not set up** with the "Setup needed" chip and no "Scheduling hold" box. Schedule a shift: it must **succeed**. If that caregiver already had an automatic hold caused only by the unset type, the next compliance sweep (or any document change) releases it; the sweep runs on its own schedule.
E. **Case 3 (independent hold, type still unset):** for the same caregiver set the background check to Not approved (Readiness, Background check, Verify, result Not approved). Scheduling is **refused** naming the background check, and the profile shows **Scheduling hold: Background check: …** next to "Work approval: Approved". Restore the background check afterwards.
F. After each case run `CHECK_SCHEDULING_0122.sql` and send me the output (masked: no names or emails). It prints, for a one-hour window tomorrow at 09:00: enforcement, whether an approval is recorded, each scheduling check with status, code and whether it is enforced, whether the compliance read calls the caregiver eligible, and any open hold.
G. Re-create the CPR and TB types (or leave TEST in the state you want) before further tests.

## Rollback (reverse order; each step stands alone)
1. **Web:** `REPO=<checkout> OGEVIA_RELEASE_COMMIT=<hash> WORK=<same work dir> OGEVIA_DEPLOY_APPROVAL=<ref> bash TEST_WEB_FIX.sh rollback-web`, typed word `ROLLBACK-TEST-WEB`. Restores the captured pre-release files (nothing deleted; `config.json` untouched). The old profile layout returns; no data is involved.
2. **0122:** `bash TEST_DB_SESSION.sh env OGEVIA_DEPLOY_APPROVAL=<ref> bash TEST_PENDING_LEDGER.sh rollback 0122` (atomic with its ledger row). It restores the 0088 `readiness_checks` and `compliance_blockers` and the 0103 `caregiver_readiness`, and drops the helper. After it, an approved caregiver with an unset type is blocked again by the 0088 rule; compliance holds that 0122 had released are re-opened by the next evaluation or sweep (not instantly).
3. **0121:** `... rollback 0121`. Restores the five previous functions; no stored email is changed by 0121 or its rollback.
4. **Enforcement:** not undone by any rollback above (see the warning). Reverse it only by restoring the snapshot into a NEW instance, or by an owner-approved SQL change. It is a TEST data setting, not a code change.
5. **Last resort:** restore snapshot `ogevia-test-pre-0121-0122` into a new instance and repoint TEST. This loses everything written to TEST after the snapshot.

## Evidence so far (local PostgreSQL 16, synthetic data; NOT TEST)
* `infra/aws/db/test/unset-cpr-tb-0122.db.test.ts`, 11 tests, with enforcement activated through the real workflow and shifts created through `ogevia_api.create_shift`: before 0122 an approved caregiver with the types unset is refused and a compliance hold opens; after 0122 the hold is released by the next evaluation and the caregiver is schedulable; **Case 1** schedulable and the profile read says "Document type not set up" with `blocksShifts = false`; a caregiver with no recorded approval is treated as before; an agency rule that is not set up still blocks; **Case 2** missing past the grace period, rejected and expired documents block, a current one passes, and a missing one inside the grace period stays a warning; **Case 3** a not-approved background check blocks and the compliance read shows the reason; report-only agencies are unchanged; the rollback restores the 0088 behaviour and re-applying is safe; `VERIFY_PENDING.sql` passes present and absent.
* `infra/aws/db/test/one-email-0121.db.test.ts`, 7 tests.
* Web: `caregiver-profile.test.tsx` (15 tests) and the existing suites updated for the tabs.
* Not verified: any TEST result, any phone or real browser against TEST.
