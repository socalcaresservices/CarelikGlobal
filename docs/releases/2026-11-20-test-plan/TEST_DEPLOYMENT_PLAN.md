# TEST deployment plan for PR #113 at commit 96dd96a

**Status: PREPARED. NOT AUTHORIZED. NOT RUN.** Nothing here was run against AWS. No AWS credential was used. This document is not an approval; Phase C needs the owner's written statement (commit, TEST only, operator, window, reference) as described in `docs/TESTING_AND_RELEASE_PROCESS.md`. Status words are used exactly: proposed, implemented, tested (where), deployed (where), accepted (by whom).

## Update 2026-11-20 (after the owner's instruction to resolve the three blockers)
The pinned application commit is **`88426e8`** (PR #113 head; application files identical to `784c3b6`). Nothing was run against AWS: this session has no AWS CLI and no usable AWS credentials (the environment's AWS variables are proxy placeholders, and the TEST site is not reachable from here). What was prepared and tested locally, all in `toolchain/`:

| Blocker | Prepared | Tested |
|---|---|---|
| 1. Operator toolchain re-pin | `release_pins.py` + `PINS_0109.json` (application commit, hashes of every toolchain file, migration sets, 0109 and its rollback, lockfile, route counts 259 off / 262 on, expected ledger 107/0107 then 108/0109); `diff_gate_0109.py` (API template gate: `off` = only the Handler code asset may change; `on` = plus exactly the three routes; `post` = no difference) | `infra/aws/test/release-pins.test.ts` (3), `diff-gate-0109.test.ts` (1, driven by the real synthesized isolated-TEST templates and damaged copies) |
| 2. Migration 0109 ledger recording | `TEST_0109_LEDGER.sh` (`probe`, `apply`, `verify`, `rollback`): identity guards, pinned file hashes, verified backup required, owner approval reference required, SQL and ledger row in one transaction, rollback removes both together | `infra/aws/db/test/test-0109-ledger.db.test.ts` (10, against a local database holding the accepted 107/0107 ledger) |
| 3. Live TEST inventory | `TEST_INVENTORY.sh` (read-only; describe/get/list calls and one public GET; sanitized output) + `check_inventory.py` (17 checks against what this release expects) | `infra/aws/test/test-inventory.test.ts` (3, with a stand-in `aws`: read-only calls only, secrets redacted, wrong account stops first) |

**Not done, and why:** the live inventory itself (needs the operator's AWS session); and the API and web deploy wrapper. The older `OPERATOR_TEST_DEPLOY.sh` modes `deploy-api`, `web`, `post-api`, `web-verify` assert constants of the earlier release (commit `6cbab00`, the Handler asset hashes, the previous file hashes) and refuse anything else, so they cannot be reused unchanged for this commit. They have to be re-pinned in CloudShell against the live captured template, where they can be tested; that is the remaining part of blocker 1.

Operator sequence with the new tools (CloudShell, after the owner's written Phase C statement):
```bash
python3 toolchain/release_pins.py check                 # the checkout equals the pins (strict: no uncommitted changes)
OUT=$HOME/ogevia-inventory-$(date -u +%Y%m%dT%H%M%SZ) bash toolchain/TEST_INVENTORY.sh      # add the PG* variables of your tunnel to include the ledger
# every line must PASS; any FAIL is a STOP
bash toolchain/TEST_0109_LEDGER.sh probe
# backup: the existing isolated-backup mode; keep the .dump, .dump.sha256 and .dump.meta together
python3 toolchain/diff_gate_0109.py --live <live-template.json> --new <synthesized-template.json> --expect off    # then deploy the API and web (re-pinned wrappers)
OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_TEST_BACKUP=<dump> bash toolchain/TEST_0109_LEDGER.sh apply
bash toolchain/TEST_0109_LEDGER.sh verify
# switch ON: apply TEST-requestCleanup-on.patch as its own commit; gate with --expect on; deploy; validate the three behaviors; gate with --expect post
```
Rollback: `TEST_0109_LEDGER.sh rollback` (database), revert the patch and redeploy (switch), and the captured previous API asset and web files (existing `rollback-api` and `rollback-web` modes, subject to the same re-pin).

## 0. Decisions needed before this plan can start
1. **Which commit to pin.** You asked for `96dd96a`. Two later commits exist on the same branch: `784c3b6` (PR #113 head, includes the Staff header 390 px fix, the DEV plan and checklist; CI green). `96dd96a` itself is CI green but still has the 2 px sideways scroll on Staff at 390 px. Recommendation: pin `784c3b6`. Everything below works for either; only the "commit" field changes. The switch-ON step adds one more commit on top (section 4).
2. **DEV sign-off first** (`docs/releases/2026-11-20-dev-validation/DEV_SIGNOFF_CHECKLIST.md`). The owner said DEV before TEST. Sections B3 to D there are still NOT RUN.
3. **Item meanings** for go-live items 1 to 4 and 7 to 10 (my readings; the owner's written list is not in the repository).
4. **Who is the operator and the UTC window**, and the approval reference the scripts require.

## 1. Target (recorded state, not live-verified today)
| Item | Value | Source |
|---|---|---|
| TEST | stacks `Ogevia-prod-*`; web at `demo.ogevia.com` and `https://d2xumch5w0izfg.cloudfront.net` | `infra/aws/lib/config.ts` (`prod` = TEST, `customDomains`), TEST release record |
| TEST database | isolated `ogevia_sv_test` on `ogevia-postgres`, login `ogevia_test_app`, secret `ogevia/test/database/app` | `ISOLATED_TEST_TARGET` in `config.ts` |
| TEST source last deployed | `6cbab00` (accepted by the owner 2026-11-11; ledger 107/0107; 259 routes) | `docs/releases/2026-11-10-ux-redesign-test/` |
| Production | stacks `Ogevia-prd-*`, database `ogevia_prd`. **Never touched by this plan.** | same |
These must be re-read live before the window (section 3, step 1). "Recorded" is not "verified".

## 2. What changes between `6cbab00` and `96dd96a` (computed from git)
- 34 commits. Web: 57 files. API: `apps/sv-api/src/routes.ts` (+34: three handlers), `exports.ts` (export row order). Infra: `config.ts` and `service-verification-api-stack.ts` add the `requestCleanup` switch (6 lines). Shared: `packages/auth/src/export-order.ts` (new, no new dependency).
- **Database: no change to the ledger set.** Migration 0109 is a pending file outside every release set (`infra/aws/db/pending/`). It applies only when someone applies it.
- **API routes: verified by CDK synthesis for the isolated TEST configuration (test `infra/aws/test/isolated-test-database.test.ts`, passing at this commit, plus a one-off count):** switch OFF = **259 routes** (the same as TEST today); switch ON = **262**, adding exactly `POST /v1/care-notifications/read`, `POST /v1/documents/{documentId}/cancel`, `POST /v1/document-types/{documentTypeId}/retire`; none removed. So with the switch OFF the API change is a Handler code change only.
- No new AWS resource, no IAM change, no network change, no new fixed cost.

## 3. Sequence (each phase has its own stop condition and rollback)
Phase 1 puts the new code on TEST with the switch OFF; phase 2 applies 0109; phase 3 turns the switch ON. They are separate so a failure points at one layer.

### Step 0. Approvals and gates (before any AWS action)
- Owner's written Phase C statement; the release checklist (`docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`) filled in for this commit; DEV sign-off.
- CI green on the pinned commit; local full gate recorded (`pnpm test:all`, lint, typecheck, build). Done for `e18564f`; to be repeated for the exact pinned commit.

### Step 1. Read-only live inventory (no writes, no secrets)
Use section 1 of `docs/releases/2026-11-10-ux-redesign-test/toolchain/PHASE_C_COMMANDS.md` (stack names, RDS, each API's `DB_HOST` and `DB_NAME`). Required answers: TEST's Handler points at `ogevia_sv_test`; production's at `ogevia_prd`; TEST API route count is 259; the live web commit stamp; the live ledger is 107/0107 (read through the existing `isolated-verify` mode); the live Handler code hash (this is the rollback reference). Any difference from section 1 is a STOP.

### Step 2. Re-pin the operator toolchain for the new commit
The scripts under `docs/releases/2026-11-10-ux-redesign-test/toolchain/` are pinned to older commits, file hashes and a ledger of exactly 107/0107 (`PINS.md`). They refuse any other state. For this release the operator must regenerate and review: the commit pin, the script hashes, the Handler asset hash, the web file hash, and the expected route count (259 with the switch off, 262 on). The `check` mode's diff gate must be told to expect only a Handler asset change and, in phase 3, exactly the three routes above. This is preparation work, not run, and needs its own review before the window.

### Step 3. Backup (TEST only)
Logical backup of `ogevia_sv_test` with checksum and metadata, kept together (the existing `isolated-backup` mode). Capture the live TEST web files and the previous API asset (`capture` mode). No RDS snapshot of the shared instance is proposed (see risks).

### Phase 1. Deploy the pinned commit, switch OFF
`deploy-api` then `web` (publish with `VITE_APP_VERSION=<commit>`), then `post-api`, `web-verify` (existing modes). The `check` gate must report: Handler asset changed, routes unchanged at 259.
Verify: API smoke; the web shows the new commit stamp; the ten go-live items that need no database change (section 5, items 1 to 10 except the three 0109 behaviors); the three 0109 buttons answer "not available in this environment yet" and do not error.
Stop condition: any route change, any failed smoke, any error not explained. Rollback: `rollback-web`, then `rollback-api` (existing modes).

### Phase 2. Apply migration 0109 on the TEST database
- **Gap:** no existing operator mode applies 0109. `OPERATOR_TEST_DB.sh` applies exactly 0103 to 0107 (and the isolated modes expect 107/0107). The owner's rule (2026-11-10) is that a pending migration is never applied as untracked SQL: the version, filename and SHA-256 go into the migration ledger in the same transaction. So a ledger-recording apply and rollback step for `0109_request_cleanup.sql` has to be added to the operator tool, modeled on its `guarded_psql`. It must be reviewed and tested against a throwaway database before use. **Not written here, and not run.**
- Expected after: ledger **108 rows, highest version 0109** (0108 is not part of this release). Confirm that expectation in the re-pin review.
- Verify with `toolchain/VERIFY_0109.sql` (read-only; tested locally: 20 checks, passes only in the right state): `-v expect=absent -v ledger=absent` before; `-v expect=present -v ledger=present` after.
- Rollback: `infra/aws/db/pending/rollback/0109_request_cleanup.down.sql` inside the same guarded transaction, which also removes the ledger row. It drops the three functions and four columns. Requests already cancelled stay closed; the cancel reason and who cancelled are lost with the columns (back up first).

### Phase 3. Turn the switch ON
- A config-only commit on top of the pinned commit: `TEST-requestCleanup-on.patch` (this folder; adds `requestCleanup: true` to TEST's features; applies cleanly). The deployed commit for this phase is therefore **the pinned commit plus that patch**, and needs its own green CI and its own pin.
- `check` must now report exactly three added routes, none removed (262).
- Validate the three behaviors one at a time with synthetic data only, stopping at the first failure: (a) the alerts pill opens the list; Mark read; Mark all read; only the person's own alerts change; (b) cancel a document request that has no upload (reason required; none offered when an upload exists); (c) retire a duplicate document type (refused for the CPR/TB type and with open requests).
- Rollback: revert the patch and redeploy the API (removes the three routes), then phase 2 rollback if needed.

## 4. Validation on TEST for all go-live items
Same ten checks as `DEV_SIGNOFF_CHECKLIST.md` section C, run by an administrator, a scheduler and a caregiver on TEST (synthetic data), at a desktop width and on a real phone. The real-phone check is required here: it is the first time one is possible. Evidence (screenshots with the commit stamp visible) goes into the release checklist. Then Phase D user acceptance, then Phase E (production) is a separate approval.

## 5. Risks and effects
- **Shared database server.** TEST's database is isolated but sits on the same RDS instance as production's (`ogevia-postgres`, per `config.ts` and the TEST record; not re-verified). A backup and a small migration add load to the shared server. Run in a quiet window; production is not touched by any step.
- **Handler code change** alters the server-made exports (row order) and adds three handlers; with the switch OFF they are unreachable. Validate server-made exports in phase 1.
- **0109 rollback loses the cancel reason, who cancelled, and the retired-by and retired-at values** (the columns drop). Retired types come back to active only by a database action. Backup first.
- **Cost:** none new (no resource; three routes and a Lambda code change). **Security:** no weakening; the three functions are definer functions, tenant-scoped, permission-checked and audited, with no PUBLIC execute and execute only for the application role (verified by `VERIFY_0109.sql`).
- **Unknowns:** live TEST state; whether the operator toolchain re-pin passes its own self-tests; the real phone behavior.

## 6. What exists in the repository for this plan
- `VERIFY_0109.sql`: tested on the local harness (present, absent and wrong-state cases).
- `TEST-requestCleanup-on.patch`: applies cleanly; synthesis shows 259 routes OFF and 262 ON, three added, none removed.
- Migration 0109 apply, rollback and reapply passing in the database suite (10 tests) and on the local harness.
- Full local gate at `e18564f` and CI green at `784c3b6`.

## 7. Not done (blocks starting)
Operator re-pin (step 2); the ledger-recording apply and rollback step for 0109 (phase 2); the live inventory (step 1); the release checklist for the pinned commit; DEV sign-off; the owner's written Phase C statement.
