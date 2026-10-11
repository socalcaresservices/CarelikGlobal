# Deployment checkpoint: migrations 0047 and 0048 (PROPOSED. Nothing has been run against AWS.)

Prepared 2026-10-11 for owner approval. Every action below that changes AWS or production data is YELLOW (CLAUDE.md section 13) and waits for the owner.
Release content: `docs/releases/availability-override/README.md` (0047) and `docs/releases/account-status/README.md` (0048).

## Gate evidence (owner-provided output, recorded 2026-10-11; Claude did not run these and cannot verify them independently)
| Check | Result | Status |
|---|---|---|
| Admin host `i-0ce8db2d7e5839dd5` already carries the app security group | groups `sg-064ffce3bcbe8eb3b`, `sg-00e01e2ca80442c1f` | PASS (no security-group change needed) |
| Production ledger (read-only, `-d ogevia_prd`) | `ogevia_prd|46|0046` | PASS (readiness release 0039-0046 is live; 0047 and 0048 are the only migrations to apply) |
| Cognito lookup by `sub` (`admin-get-user --username <sub>`, pool `us-west-2_849AYz5J7`) | `status CONFIRMED, enabled true, sub` equal to the one passed | PASS for lookup. It does not prove AdminDisableUser/AdminEnableUser; the first Disable/Enable of a synthetic test person after deployment is the final proof. |
Observation: the admin host is running with direct database access attached (a standing attachment). Consider stopping the host or detaching the group after deployment (separate change, owner decision).
Still required before any deployment: the owner's explicit go decision naming the commit SHA, the merge decision, the `OGEVIA_DEPLOY_APPROVAL` reference, who runs it, and the window. Re-run the ledger query immediately before `db:migrate`; it must still read `46|0046` (the runner prints "applied 2, already applied 46").

## Stop conditions (check these first; any "no" means do not continue)
1. **Live migration ledger reads exactly `46|0046`** (query in step 2). This release was built on top of the caregiver-readiness release (0039-0046). If production is still at `38|0038`, STOP: applying would also deploy that whole release, which needs its own approval (`docs/releases/caregiver-readiness/RELEASE_HANDOFF.md`). The live level is NOT known to this session.
2. The read-only Cognito `sub` check in `docs/releases/account-status/README.md` returned the user. (Needed for Disable/Enable to reach Cognito; 0047 does not depend on it.)
3. `deploy-production.sh check` passes (RDS available, 7-day backups, encrypted, private, deletion protection, pool MFA ON, repository gates, `cdk synth` for env=prd).
4. A low-traffic window, with the owner available to run the post-deploy checks.

## Process (operator shell with admin AWS credentials; tools: aws jq psql node pnpm(9.15.4 via corepack) session-manager-plugin)
```bash
git fetch origin && git checkout <APPROVED_COMMIT_SHA>        # the SHA the owner approves; record it
corepack pnpm@9.15.4 install --frozen-lockfile
# 1. read-only checks
AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh check
# 2. rollback anchor (RDS manual snapshot), then open the private tunnel and read the ledger
OGEVIA_DEPLOY_APPROVAL=<ref> AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh snapshot
#    (tunnel + OGEVIA_DATABASE_URL exactly as in caregiver-readiness/RELEASE_HANDOFF.md section 4)
psql "$OGEVIA_DATABASE_URL" -Atc "select count(*), max(version) from ogevia_meta.schema_migrations"   # MUST print 46|0046
# 3. migrations 0047, 0048 (checksummed, one transaction per file, refuses drift)
OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner corepack pnpm@9.15.4 --filter @carelik/infra-aws db:migrate   # expect: applied 2, already applied 46
corepack pnpm@9.15.4 --filter @carelik/infra-aws db:verify                                                    # every line PASS
psql "$OGEVIA_DATABASE_URL" -Atc "select count(*), max(version) from ogevia_meta.schema_migrations"          # 48|0048
# 4. API + identity function + IAM (interactive: CDK shows the diff and asks to confirm the IAM broadening)
OGEVIA_DEPLOY_APPROVAL=<ref> AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh infra
AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh smoke
# 5. web (last; keeps the previous bundle in S3 history)
OGEVIA_DEPLOY_APPROVAL=<ref> AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh web
```
Do NOT use `deploy-production.sh database` or `all`: they create the database, login, tenant and administrator (an existing installation already has them).
Read the `cdk diff` in step 4 before confirming. Expected for `Ogevia-prd-ServiceVerificationApi` only: 3 new routes (`GET /v1/accounts`, `POST /v1/accounts/{userId}/disable`, `POST /v1/accounts/{userId}/enable`, all JWT), a new IAM statement `SwitchSignInsOnOff` (`AdminDisableUser`, `AdminEnableUser` on the one pool), two description changes, and new code for the API and identity Lambdas. STOP if the diff shows anything else (another stack, a security group, a secret, a deletion or replacement). Reference: `docs/releases/account-status/CLOUDFORMATION_TEMPLATE_DIFF.txt`.

## Order matters (a short gap is expected between steps 3 and 4)
0047 removes the old 5-argument `authorize_availability_override`. Between the migration and the API deploy, creating an override fails in the old API/web (nothing else is affected). Do steps 3-5 in one sitting. The reverse order (new API on the old database) would fail the new routes and the override route, so the database goes first.

## After deployment (owner, in the app; synthetic data only)
1. Sign in as the owner (MFA). Open **Accounts**: statuses read in plain words; your own row has no Disable button.
2. Disable then enable a clearly synthetic test caregiver (not a real person): the disabled person cannot load the app; after enable they can; two audit events exist.
3. As a Manager, confirm the Accounts page says only an administrator can manage accounts.
4. Override: with a synthetic caregiver who has no availability, a Manager's attempt to assign is refused only AFTER readiness enforcement is active (it is NOT activated by this release); as the owner, grant an override for one shift, assign, and confirm the shift shows "Assigned with Admin override" and a second shift is refused.

## Rollback and recovery
| Situation | Action |
|---|---|
| Migration 0047 or 0048 fails | Its own transaction rolls back; the ledger shows the last applied version. Nothing else changed. Fix forward with a new migration (never edit an applied file). |
| `infra` step fails | CloudFormation rolls the failed stack back; the database is untouched. Re-run `infra`. |
| Need to undo the release | Order: web (previous bundle is in S3 history; redeploy it) -> API (check out the previous commit and run `infra`, which removes the 3 routes and the IAM statement) -> database: `OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner corepack pnpm@9.15.4 --filter @carelik/infra-aws db:rollback-readiness 0047` (runs 0048.down then 0047.down as one recorded attempt; no records are removed; see the two down scripts). |
| Anyone was disabled while 0048 was live | **Re-enable them BEFORE rolling back 0048**: afterwards they stay disabled and there is no screen to enable them. |
| Data damage suspected | Restore the pre-deployment snapshot to a NEW instance only; a restore is a separate approval. Deleting snapshots, databases or tables is RED and not part of this plan. |

## What this deployment changes in production (and what it does not)
- Database: two migrations add objects and replace functions. **No existing row in any table is modified** (upgrade rehearsal test: `infra/aws/db/test/upgrade-0046-to-0048.db.test.ts`). Added rows: one permission `accounts.manage` and its grant to `organization_owner`.
- No user account, role assignment, membership, password or email is created, changed or removed. The owner role gains the new capability `accounts.manage`; nobody else gains anything.
- Cognito: no user is touched. Only an IAM policy statement is added to the identity function's role (two actions, one pool). Users are changed in Cognito only if an Admin later disables or enables someone.
- Production behaviour that does change: creating an availability override now requires a client and covers one shift once (the old range override stops working; any old unexpired override becomes inert); shifts assigned under an override show a note; the matching panel uses Match / Partial Match / No Match wording; the Setup menu shows **Accounts** to administrators.
- NOT changed: readiness enforcement stays exactly as it is now. This release does not activate it.
