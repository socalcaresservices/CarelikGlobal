# Operator runbook: 2026-10-30-caregiver-readiness (migration 0086)

**Status: PROPOSED. NOTHING HERE HAS BEEN RUN AGAINST ANY SHARED ENVIRONMENT.**

**Owner decision 2026-10-30:** this is a **TEST/PILOT package only** until a deployment target is formally designated. **Designated Operator: Stella Okereke.** Nothing in this runbook may be scheduled or scripted against any shared environment until the target environment is explicitly identified and documented in the checklist (C0). **Target environment: DESIGNATED 2026-10-30 (owner's choice in conversation, unsigned; `DECISION_RECORD.md` A1): the existing TEST/pilot slice** (stacks `Ogevia-prod-*`, database `ogevia_sv_test` on `ogevia-prod-postgres`, account 300094796789, `us-west-2`). The designation does **not** authorize any step: the owner must still state the commit SHA, the window and a GO for Phase C. Identifiers are from repository documents and are **NOT VERIFIED LIVE**. The real `cdk diff` is run by the Operator in the target once it is designated (checklist C4a); the local synthesized comparison below is not a substitute. 0086 is **not releasable** while any release gate in `CHECKLIST.md` is open.

 Every YELLOW action below needs the owner's explicit GO for that environment (`CLAUDE.md` section 13). Claude Code has no AWS access and cannot run this.

Why this is not a copy of the 2026-10-19 operator package: that package (`docs/releases/2026-10-19-test-rehearsal/`) is built around one named TEST database whose ledger was `52|0052`, and its pin tests fix the repository at 85 migrations. A target that is not yet identified cannot be scripted safely. This runbook therefore starts with a read-only probe that tells the operator which migrations the target is missing.

## A. What is in the package
| Artifact | Where | Pin |
|---|---|---|
| Migration | `infra/aws/db/migrations/0086_caregiver_readiness_approve_for_work.sql` | sha256 `d9c8cc372011e68221868767e83922da641457535e796b9de23b836881c568ee` |
| Rollback (BACKUP REQUIRED) | `infra/aws/db/rollback/0086_caregiver_readiness_approve_for_work.down.sql` | sha256 `fe47381cb9c888e8cb541936dbd8402a550aac83b5926a64d736a1463f520e29` |
| Migrations 0001 to 0085 (unchanged by this release) | `infra/aws/db/migrations/` | set sha256 `de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef` (same value as the 2026-10-19 package: no earlier file was edited) |
| All 86 migration files | same | set sha256 `af15f5bb47d333b740375e0dbc3a9131fe416cc0ccb9f76d26e28759c8c33461` |
| Rollback set 0078 to 0086 | `infra/aws/db/rollback/` | sha256 `69ef19fa2c9961bb55791db174f5bcb08ebfc8ddfe1943f3df51f334ffb32641` |
| `pnpm-lock.yaml` | repo root | sha256 `7f5964021b4dbeeebf703fda27e1a509c164c1aecb4436f9324003b7de88dcae` |
| Code | commit `dd59c8b3d56e190ef1f47316c19b4fa287f57d77` on `claude/practical-tesla-r07odb` (the owner's GO must name the final SHA; documentation-only commits may follow it) | |
| Task 8 report query | `TASK8_ACTIVE_CAREGIVER_GAPS.sql` | read-only |

Recompute any pin with: `cd infra/aws/db/migrations && LC_ALL=C sha256sum -- *.sql | sha256sum` (all files), the same command over `$(ls *.sql | LC_ALL=C sort | head -85)` (0001 to 0085), and `sha256sum <file>` for one file.

## B. Confirm the target (read-only; no approval needed beyond access)
**Guard, first:** the RDS instance `ogevia-prod-postgres` also holds `ogevia_prd` (PRODUCTION). Every command below, and every later step, must be pointed at database `ogevia_sv_test` only. Before anything else run `select current_database();` and **stop unless it returns `ogevia_sv_test`**; confirm the stack names are `Ogevia-prod-*` (not `Ogevia-prd-*`) and the banner reads "TEST — synthetic data only".

Run on `ogevia_sv_test`, as the read-only role, inside `begin read only;`:
```sql
select count(*) as n, max(version) as latest from ogevia_meta.schema_migrations;                 -- expect latest 0085 for a database that has had every earlier release
select version from ogevia_meta.schema_migrations order by version desc limit 5;
select count(*) filter (where status in ('ready','active')) as ready_or_active,
       count(*) as caregivers from ogevia.caregiver_records where deleted_at is null;           -- record these numbers: section F compares them
select to_regclass('ogevia.caregiver_work_approvals') as already_has_0086;                        -- null expected before
```
**Contiguity rule:** if `latest` is below `0085`, every missing migration up to `0086` must be applied in order, each with its own rollback script, and the earlier gaps need their own approvals and checks (`docs/TESTING_AND_RELEASE_PROCESS.md`). The runner applies every missing file in order, so a database behind 0085 would receive those too; each needs its own review. Do not treat 0086 as a stand-alone change on such a database.

## C. Pre-flight (YELLOW: separate approval for the snapshot)
1. Owner names the environment, the commit SHA, the window and the Operator (checklist C0).
2. Manual RDS snapshot of the target; record its identifier and that its status is `available` (checklist C3 / E4). 0086 changes data (see section D), so the snapshot is mandatory.
3. Capture the previous web bundle (S3 object versions) and the previous API template/commit (checklist C2).
4. `cdk diff` for the API stack must show **only** the changes in section D. Anything else: STOP.

## D. What the release changes
| Layer | Change | Cost |
|---|---|---|
| Database | New tables `organization_compliance_settings`, `caregiver_cpr_tb_extensions`, `caregiver_work_approvals`, `caregiver_contacts`; new functions; replaced functions (`readiness_checks`, `compliance_blockers`, `compliance_snapshot`, `get_compliance_summary`, `set_caregiver_status`, `begin_invitation_resend`, `ensure_onboarding_defaults`, `list_caregivers`, `list_accounts`, `compliance_grace`, `compliance_grace_days`). **Data written:** one `legacy_status` approval row per caregiver whose stored status is `ready` or `active`; the onboarding requirements of category `background_check`, `document` and `clearance` are set `is_active = false`. Nothing is deleted. | none |
| API | 8 new routes (`GET .../readiness`, `POST .../approve`, `POST .../cpr-tb/extend`, `GET .../cpr-tb/extensions`, `GET` and `POST /v1/compliance/settings`, `POST .../contact`, `POST .../signin-link`). **Verified locally by synthesizing both versions of the CDK app:** `Ogevia-prd-ServiceVerificationApi` and `Ogevia-prod-ServiceVerificationApi` each gain exactly 8 `AWS::ApiGatewayV2::Route` resources and one `AWS::Lambda::Function` changes (the code asset). Every other stack is byte-identical. | no new fixed cost; usage-based API Gateway/Lambda only |
| Web | Rebuilt caregiver page, Caregivers list, Staff list, Recruiting link | none |
| Behaviour change the owner asked for | 14-day CPR/TB rule becomes an agency setting, default **30**; a missing CPR/TB no longer blocks work inside its due date (reverses the 2026-10-19 rule); Approved/Active can no longer be set by the status picker | |

Compatibility during the window: the order is database, API, web. New database with the **old** API or web is safe for reads; the old status picker and the old "Move to Approved" fail with a plain message (by design) until the web is updated. The **new** API on the old database is not supported (it calls functions that do not exist yet). Deploy the three as one unit.

## E. Apply (YELLOW: owner GO for the named environment and SHA)
```bash
# 1. database (the runner refuses a non-local host without this variable)
export OGEVIA_DATABASE_URL=<target url from Secrets Manager, never typed into chat>
export OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner      # only after the written GO
pnpm --filter @carelik/infra-aws db:migrate                 # applies only the missing files (expected: 0086)
pnpm --filter @carelik/infra-aws db:verify                  # all PASS; 01_schema_version expects latest 0086 and count 86
# 2. API: cdk diff shows only section D, then deploy the SV API stack of the target environment (stack names per checklist C0)
# 3. web: build (VITE_AUTH_PROVIDER=cognito and the target's settings), upload, invalidate CloudFront
```
After step 1, run the section B probe again: `latest = 0086`, `caregiver_work_approvals` count equals the `ready_or_active` number recorded before (every one is `legacy_status`).

## F. Checks only the real environment can prove (checklist B10 carried to C6)
Synthetic caregivers only; the sign-in pool may be shared, so never disable or change a real person.
1. **Cognito invitation:** add an email to a synthetic caregiver and press Send sign-in link: Cognito sends one message; the page shows "Invited, has not signed in yet" and "Last sent". Resend within a minute is refused; after the first sign-in the control disappears.
2. **Message content:** read the received email: it must contain no client or health information.
3. **Temporary password:** it works once and expires after the pool's configured validity (read the pool setting; record the days). This was NOT verified by Claude.
4. **Routes:** each of the 8 routes answers (200/409 as expected) for the right role and 401 without a token, 403 for a caregiver, 404 across agencies.
5. **CloudFront:** the new bundle is served; open the caregiver page on a phone: no sideways scroll, buttons easy to press.
6. **Migration on populated data:** counts from section B match; `select count(*) from ogevia.caregiver_work_approvals where source = 'legacy_status'` equals the pre-release `ready_or_active`; no caregiver lost scheduling (open the Schedule as the Scheduler).
7. **Task 8:** run `TASK8_ACTIVE_CAREGIVER_GAPS.sql` (read-only) and send the output to the owner **before** enforcement is switched on.
8. Regression set R and smoke set S from the catalog.

## G. Rollback
| Order | Action | What it cannot undo |
|---|---|---|
| 1. Web | Redeploy the previous bundle (S3 object versions) | Nothing is lost; the old page needs the old API's compliance routes, which still exist |
| 2. API | Redeploy the previous template/commit | Sign-in links already sent stay sent |
| 3. Database | `infra/aws/db/rollback/0086_caregiver_readiness_approve_for_work.down.sql` (**BACKUP REQUIRED**), via the range runner after the snapshot: `OGEVIA_DATABASE_URL=... OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner pnpm --filter @carelik/infra-aws db:rollback-to 0086 --expect-set-sha be131bf6778c2331151290c5b126d134fa363e10c4f652f2a68e2e9da8db3c87` (the pin is the hash of the one-file rollback set 0086) | **Drops** `caregiver_work_approvals`, `caregiver_cpr_tb_extensions`, `caregiver_contacts` and `organization_compliance_settings` with their rows (approvals made after the release, extensions, saved emails, the agency days). Restores the earlier functions and the 14-day rule. Re-activates every onboarding requirement of category background_check/document/clearance (an agency that had switched one off by hand before 0086 would have it back on). Stored caregiver status, onboarding items, background checks, documents, shifts and visits are untouched. |

Rehearsed: the rollback runs inside the automated rollback suites (`rollback-range`, `readiness-rollback`, `readiness-restore`, `upgrade-*`) on a real PostgreSQL 16 and re-applies cleanly. Not rehearsed on the target. **Call a rollback when** a gate in checklist C fails, a caregiver who was Ready/Active before the release cannot be scheduled, or any cross-agency read is seen. Restore from the snapshot goes to a NEW instance and needs its own approval. Corrections to data created during the release are made through the product, never by hand.

## H. Enforcement
This release does not switch enforcement on. After the Task 8 report is reviewed, the owner activates it on the Readiness screen as before. With enforcement on, a caregiver past the CPR/TB due date (30 days after hire, or the extended date) cannot get a new shift; Active caregivers are never deactivated automatically.
