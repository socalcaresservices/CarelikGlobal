# Account status and Admin enable/disable (migration 0048): approval package

Status: **implemented and tested locally. NOT deployed. No AWS change was made. Waiting for owner approval of the YELLOW actions below.**
Decision source: `docs/product/SCHEDULING_AND_ACCOUNTS_DECISIONS.md` (owner, 2026-10-11).

## 1. The Cognito permission being added, and why
| Permission | Why it is required |
|---|---|
| `cognito-idp:AdminDisableUser` | Switches a person's sign-in off so they cannot authenticate. Ogevia's own database check already blocks them at once; this stops them signing in at all. |
| `cognito-idp:AdminEnableUser` | Switches it back on when an Admin re-enables the person. |
Existing, unchanged: `AdminCreateUser`, `AdminGetUser`. **Not added** (and a test fails if they ever appear): any password action (`AdminSetUserPassword`, `AdminResetUserPassword`), `AdminUpdateUserAttributes`, `AdminDeleteUser`, group actions, `ListUsers`, `cognito-idp:*`.

## 2. Which Lambda / role receives it
The identity function `Ogevia-<env>-IdentityAdmin` (role `IdentityRole`, managed policy `IdentityPolicy`), as a new statement `SwitchSignInsOnOff`. It sits outside the VPC, has no database, S3, KMS or secret access, and is invoked only by the API Lambda. The API Lambda's own role gets nothing new.

## 3. Scope: which user pool
The statement's resource is exactly one pool ARN: `arn:aws:cognito-idp:us-west-2:300094796789:userpool/us-west-2_849AYz5J7`.
**Correction to the request wording:** this is *the* Ogevia pool, but it is **shared by the pilot (`Ogevia-prod-*`) and production (`Ogevia-prd-*`)** (see `infra/aws/lib/config.ts`: production "reuses the Cognito pool"). It is not a production-only pool. The IAM statement therefore cannot limit itself to production users. The limits that apply are in the database: the caller must be an owner of an agency, the target must belong to that agency, and a sign-in that is also active in another agency is never switched off by this one. `prd` and `prod` each have their own identity function; deploying only `Ogevia-prd-ServiceVerificationApi` changes production alone.

## 4. UI / API
| API | Behaviour |
|---|---|
| `GET /v1/accounts?organizationId=` | Owner only. Status of each person in the agency plus Care Team records with no sign-in. No email, password or Cognito id returned. |
| `POST /v1/accounts/{userId}/disable` `{organizationId, reason}` | Reason required. Database first: membership suspended, and the app user disabled if it was their last active access anywhere. Then Cognito switch-off. If Cognito fails the person is already blocked and the Admin is told to repeat Disable; a repeat is safe. |
| `POST /v1/accounts/{userId}/enable` `{organizationId, reason}` | Cognito switch-on first (if it fails nothing changes in Ogevia), then the database restores access. |
UI: new **Accounts** page (Setup menu, owner only): list with status badge, Disable/Enable with a required reason. Your own row has no Disable button.

## 5. Permission proof
`accounts.manage` is granted by migration to `organization_owner` only. Enforced in the database by `ogevia.accounts_manage_guard` (not in the browser). Tests: managers, schedulers and caregivers are refused (`OGA03` / HTTP 403) on all four functions and all three routes; another agency's manager is told the agency does not exist (`OGN04`); an owner cannot act on another agency's person; refused requests never reach the identity function; the owner cannot disable themselves.

## 6. Statuses users see
| Shown | Meaning | Source |
|---|---|---|
| Active | Can sign in. | membership active, user active, has signed in |
| Invitation Pending | Invited; has not signed in yet; must set a password at first sign-in. | invitation sent, never signed in (Cognito `FORCE_CHANGE_PASSWORD`) |
| Disabled | Cannot sign in. Records are kept. | membership suspended or user disabled |
| Account Setup Required | Care Team record with no sign-in. | no linked user |
"Password Change Required" as a separate state after an Admin-started reset arrives with Step 3 (password reset); until then the first-sign-in state is shown as Invitation Pending. Cognito's technical names are never displayed.

## 7. Tests (local PostgreSQL 16, synthetic data; see the session report for counts)
`infra/aws/db/test/account-status.db.test.ts` (10), `apps/sv-api/test/accounts.db.test.ts` (5), `apps/sv-api/test/identity.test.ts` (7, 3 new), `apps/web/src/aws/accounts.test.tsx` (5), `infra/aws/test/service-verification-api-stack.test.ts` (IAM: exactly four Cognito actions on one ARN), plus the rollback/restore/verification chain updated to 0048.

## 8. Rollback impact
- Database: `rollback/0048_account_status_enable_disable.down.sql` (SAFE AUTOMATED): drops the four functions and the permission; keeps all data and audit rows. **People disabled while 0048 was live stay disabled and there is no screen to re-enable them afterwards: re-enable first.**
- IAM: removing the statement removes the capability; the 0048 API then returns an identity error for disable/enable. Nothing else uses the two actions.
- Web: the Accounts page disappears; nothing else depends on it.

## Verify BEFORE approving deployment (read-only, from CloudShell)
The identity function addresses a person by their Cognito `sub`. AWS documents that the `sub` is accepted as `Username` when the username is not an alias attribute, but this is **UNVERIFIED for this pool**. Run, with a real user's sub (output shows only attributes; no secret):
`aws cognito-idp admin-get-user --user-pool-id us-west-2_849AYz5J7 --username <that user's sub> --region us-west-2 --query '{status:UserStatus,enabled:Enabled}'`
If it returns the user, the design works as written. If it says UserNotFound, the function needs a `ListUsers` filter by `sub` (one more read-only permission) and I will change the design before any deployment.

## Deployment order (YELLOW; needs your explicit approval; not started)
1. Snapshot. 2. Apply migrations to 0048 (ledger `48|0048`; note 0047 comes first). 3. `cdk diff` then deploy `Ogevia-prd-ServiceVerificationApi` (IAM statement + identity and API code). 4. Deploy web. 5. Smoke: sign in as owner, open Accounts, disable then enable a clearly synthetic test person.
