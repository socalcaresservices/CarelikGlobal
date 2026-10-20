# Ogevia URL registry and launch checklist

Last updated: 2026-10-10. Repository checked at `main` = `24eabe2` (fetched 2026-10-10).
Evidence classes used below. Nothing here is a deployment instruction.

- **OWNER-AWS**: output the owner pasted from AWS CloudShell or the AWS console (us-west-2). Claude did not run it and cannot re-run it (no AWS CLI or credentials in the Claude session).
- **CLAUDE-CHECK**: Claude ran it from the Claude session (repository reads, public unauthenticated HTTP GET).
- **OWNER-STATED**: the owner said so; no output or document reached the repository.
- **UNVERIFIED**: no evidence either way. This means "not yet confirmed", not "not done".

## 1. URL registry

| Name | App (CloudFront) | API (API Gateway) | Database | Use for |
|---|---|---|---|---|
| Pilot / test (`env=prod`, stacks `Ogevia-prod-*`) | `https://d2xumch5w0izfg.cloudfront.net` | `https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com` | `ogevia_sv_test` (repository records; live not re-checked) | **Synthetic data only.** `docs/aws/PRODUCTION_DEPLOYMENT.md` says not to use it as production. |
| Production candidate (`env=prd`, stacks `Ogevia-prd-*`) | `https://d3l4psdkokkvnb.cloudfront.net` | `https://zk527zk4ua.execute-api.us-west-2.amazonaws.com` | `ogevia_prd` (Lambda configured for it; connectivity unverified) | Intended for real client use, **after the open items in section 3 are closed.** Not yet cleared for real client data. |

`app.ogevia.com` DNS is not repointed to either link. That is a separate owner decision.

## 2. Evidence recorded (2026-10-10)

| # | Fact | Class | Source |
|---|---|---|---|
| 1 | `Ogevia-prd-ServiceVerificationApi-Handler886CB40B-KQ2l1HsdGkhR` exists in us-west-2, `State=Active`, `LastUpdateStatus=Successful`, `LastModified=2026-10-10T06:11:29.031+0000` | OWNER-AWS | `lambda get-function-configuration`, CloudShell |
| 2 | That Lambda has `DB_NAME=ogevia_prd` and `OGEVIA_ENV=prd` | OWNER-AWS | same output |
| 3 | CloudFormation: `Ogevia-prd-WebHosting` = `UPDATE_COMPLETE`; `Ogevia-prd-ServiceVerificationApi` = `UPDATE_COMPLETE` | OWNER-AWS | CloudFormation |
| 4 | CloudFormation identifies `https://d3l4psdkokkvnb.cloudfront.net` as the production candidate app and `https://zk527zk4ua.execute-api.us-west-2.amazonaws.com` as the prd API | OWNER-AWS | CloudFormation |
| 5 | AWS BAA confirmed. The agreement itself is not in the repository. | OWNER-STATED | owner statement (previously confirmed) |
| 6 | Both API addresses answer an unauthenticated `GET /v1/me` with HTTP 401 and `www-authenticate: Bearer` (at 2026-10-10 about 15:03 UTC). The API is up and requires a login. This does not show what either API is connected to. | CLAUDE-CHECK | public GET |
| 7 | The prd address is a configured stack in the repository: `Ogevia-prd-*` stacks, `ogevia_prd` database and `OGEVIA_ENV=prd` fail-closed check (`apps/sv-api/src/config.ts`, `infra/aws/lib/config.ts`). A mismatch makes the Lambda refuse to start, which supports (but does not prove) a working configuration. | CLAUDE-CHECK (repository read) | code |
| 8 | Claude could not open either CloudFront address (sandbox proxy blocks them), so it has not seen what the frontend calls. | CLAUDE-CHECK (limit) | curl |

Corrections to earlier records:
- `docs/aws/PRODUCTION_DEPLOYMENT.md` section 7 (written before this deployment) lists items 6–17 as NOT RUN and states "deployment not yet executed". Items 13 (stack deployed, Lambda `DB_NAME=ogevia_prd`) and part of 17 (frontend published) now have owner-provided evidence. The other rows stay as written until evidence arrives. Rows marked NOT RUN mean "not recorded", not "not performed".
- The production database is **not** claimed absent. The Lambda being configured for `ogevia_prd` does not by itself prove the database exists, is migrated, or is reachable.
- The BAA gate in `docs/aws/SECURITY_DECISIONS.md` was written as "not yet satisfied". It is now **owner-confirmed** (item 5 above). The agreement itself has not been reviewed by Claude.

## 3. Launch checklist (production candidate)

| # | Check | Status | Evidence / what is needed |
|---|---|---|---|
| 1 | Production Lambda deployed, `DB_NAME=ogevia_prd`, `OGEVIA_ENV=prd` | **PASS (owner-provided)** | OWNER-AWS items 1–2 |
| 2 | prd stacks deployed (`WebHosting`, `ServiceVerificationApi`) | **PASS (owner-provided)** | OWNER-AWS item 3 |
| 3 | AWS BAA | **Owner-confirmed** | Keep a copy of the executed agreement with business records |
| 4 | Production frontend actually calls the prd API | OPEN | Check that the deployed bundle contains `zk527zk4ua` and not `s0epy5rgzb` |
| 5 | Database connectivity from the Lambda to `ogevia_prd` | OPEN | Run `deploy-production.sh smoke` (read-only), or check `pg_stat_activity` for `application_name=ogevia-sv-api` on `ogevia_prd` as `ogevia_prd_app` |
| 6 | Applied migrations in `ogevia_prd` | OPEN | `select count(*), max(version) from ogevia_meta.schema_migrations` — expected 38 / 0038 if the 38-migration release is what was deployed; 46 / 0046 only if the caregiver-readiness release (merged to `main`, documented as not deployed) was applied |
| 7 | Deployed commit / version | OPEN | Record the commit SHA of the build used for `Ogevia-prd-*` (the CloudShell / deploy log, or Lambda code hash compared against a local `cdk synth` of the SHA) |
| 8 | Test credential refused on `ogevia_prd` | OPEN | `deploy-production.sh database` access checks or equivalent |
| 9 | Administrator sign-in with MFA on the prd app | OPEN | Browser test on `d3l4psdkokkvnb`, owner account |
| 10 | Synthetic visit and signature workflow on the prd app: start, end, client confirmation, Signed status, manager view | OPEN | Browser/phone test; delete or void the synthetic record afterward |
| 11 | Signature object lands in the `ogevia-prd-signature-evidence-…` bucket | OPEN | S3 listing (metadata only) after item 10 |
| 12 | Caregiver-role user cannot see agency data | OPEN | Browser test |
| 13 | Cross-tenant and unauthorized-access negative checks on prd | OPEN | Existing automated tests ran locally; not run against prd |
| 14 | Backups, snapshot and restore procedure on RDS | UNVERIFIED | `deploy-production.sh check` output |
| 15 | `app.ogevia.com` DNS decision | OPEN (owner decision) | Not part of this work |

No item above moves to PASS on the strength of this document alone.

## 4. Next verification step

See the chat reply for the single next step. In short: confirm which API the production frontend calls (item 4), then run the read-only `smoke` step (items 5–6).

## 5. Environments, roles, accounts, email, onboarding and cost audit (2026-10-20)

Read-only audit. Checkout: branch `claude/peaceful-keller-vh47u7` = `origin/main` = `d82fefc` (fetched 2026-10-20). **No AWS CLI and no credentials in the Claude session, and the sandbox proxy blocks `*.ogevia.com`, CloudFront and AWS endpoints. Nothing below is VERIFIED LIVE by Claude.** "Live (recorded)" means an owner-pasted output already in the repository, with its date. Nothing was changed except this section and the warning in `docs/OGEVIA_OPERATING_RECORD.md`.

Evidence classes: **CODE** (read in this checkout), **LIVE (recorded)** (owner-pasted AWS output in an existing doc, dated), **UNKNOWN**.

### 5.1 Environments and permanent URLs

| Environment | CODE / LIVE (recorded) | Permanent URL? |
|---|---|---|
| Pilot / test (`env=prod`, `Ogevia-prod-*`, `ogevia_sv_test`, synthetic data) | Section 1 above; stacks and Lambda LIVE (recorded) 2026-10-04 to 10-14 | **No.** `d2xumch5w0izfg.cloudfront.net` and `s0epy5rgzb.execute-api...` are generated CloudFront/API Gateway names with no custom domain. |
| Production candidate (`env=prd`, `Ogevia-prd-*`, `ogevia_prd`) | Section 1 above; Lambda `DB_NAME=ogevia_prd` LIVE (recorded) 2026-10-10 | **No.** `d3l4psdkokkvnb.cloudfront.net` / `zk527zk4ua.execute-api...` only. Not cleared for real client data (section 3). |
| `app.ogevia.com`, `api.ogevia.com`, `www.ogevia.com` | CODE: CORS, Cognito callback target (`cognito-target.ts`, `PHASE_3_AUTH_CUTOVER_PLAN.md`) and several docs name them | **UNKNOWN what they point to.** Section 1 says `app.ogevia.com` is not repointed to either AWS link. `docs/OGEVIA_OPERATING_RECORD.md` (2026-10-07) calls `app.ogevia.com` an "active production environment" with Cognito; that conflicts and is unsupported. `PHASE_3_AUTH_ARCHITECTURE.md` says production still used Supabase Auth, and README/`netlify.toml` show Netlify hosting. |
| Development | Last-known RDS `ogevia-postgres` (not stack-owned; `MONTHLY_PLATFORM_COST_2026-10.md` says verify); local harness (`infra/aws/local-harness`) | n/a |
| Legacy Supabase + Netlify | CODE: `supabase/`, `apps/netlify-functions`, `netlify.toml`; CLAUDE.md forbids cancelling before acceptance | UNKNOWN (Netlify site URL not in the repository) |

Conflict to resolve: the Cognito pool `us-west-2_849AYz5J7` is **shared** by pilot and production (`infra/aws/lib/config.ts`; `docs/releases/account-status/README.md`; `PRODUCTION_DEPLOYMENT.md` section 8). Older docs call it the "TEST pool". The `ogevia-web` client's callback list is **UNKNOWN today**: it was `d84l1y8p4kdic.cloudfront.net` on 2026-10-01 (D-P1-2), and no record shows it was changed to the pilot or prd CloudFront domains, which sign-in needs.

### 5.2 Roles and permissions

CODE (`infra/aws/db/migrations/0002`, later `insert into ogevia.role_permissions`; `packages/shared/src/permissions.ts`). The database is the authority (`ogevia.has_permission`); Cognito groups and custom claims are ignored (tests prove forged claims change nothing).

| Role | Permissions granted by migrations 0001-0052 (count of distinct keys) | Notes |
|---|---|---|
| `organization_owner` | 34, the only holder of `accounts.manage` (0048) | Can see sign-in status and disable/enable sign-ins |
| `manager` | 22: clients/caregivers/assignments/shifts manage, visits manage, authorizations update, documents, care requests, matching, `billing.approve`, `billing.visits.read`, `continuity.export` | |
| `scheduler` | 9: shifts manage, care requests manage, read of visits/authorizations/availability/readiness/matching | |
| `caregiver` | 4: `availability.manage_own`, `caregiver_services.read_own`, `documents.manage_own`, `experience.report_own` (visit start/end/confirm go through the assignment/visit rules, not this table) | Caregiver record must also be linked and active |
| `organization_admin`, `coordinator` | 2 each: care requests read/manage | Roles exist in the enum; no UI path assigns them |
| `staff`, `read_only` | **0 grants** | Enum values only; a user holding them can do nothing |
| `platform_owner` | Blocked: `check (role <> 'platform_owner')` on memberships | No platform-operator role exists in the AWS schema |

**Multiple roles per user:** one role per person **per agency**: `unique (organization_id, user_id)` in `organization_memberships`. One person (one Cognito `sub`) can hold a membership in several agencies, each with its own role, and `get_my_context()` returns all of them; the UI switches by `activeOrganizationId`. A person cannot be both manager and caregiver in the same agency. UNTESTED against a live database: the multi-agency switch behaviour (no recorded browser test with two memberships). Permission listing above counts migration inserts only; I did not run the SQL, so verify with the CloudShell query in 5.8.

### 5.3 Accounts and memberships per environment

**None VERIFIED LIVE today.** The last recorded counts are stale:

| Environment | Last record | Date | Source |
|---|---|---|---|
| Cognito pool (shared) | 5 sign-ins, all enabled; one caregiver still `FORCE_CHANGE_PASSWORD` | 2026-10-04 | `PILOT_ACCEPTANCE_RECORD.md` |
| `scs-pilot-synthetic` org | 1 manager, 2 caregivers; owner added 2026-10-04 (`admin.ogevia@gmail.com`) | 2026-10-04 | same |
| Test slice `ogevia-test-slice` | 1 test manager, 1 test caregiver (synthetic) | seed script | `02_seed_synthetic_test_slice.sql` |
| Production `ogevia_prd` | Tenant `socal-care-services` and its single `organization_owner` are created by `12_` and `13_` scripts. **No record shows they were run.** The checklist (section 3, item 6, 9) is OPEN. `PRODUCTION_DEPLOYMENT.md` says no manager or caregiver gets a prd membership. | UNKNOWN | scripts only |

The existing `live-status-check.sh` reads the **test** database and states it never touches production. **There is no recorded script for reading `ogevia_prd` memberships** (gap; commands in 5.8).

### 5.4 Invitation and password-reset email

| Item | Evidence |
|---|---|
| Sender of invitations | CODE: the identity Lambda (`apps/sv-api/src/identity-handler.ts`) calls Cognito `AdminCreateUser` (and `MessageAction: RESEND`). Cognito sends the message; **Ogevia code sends no email.** No SES, SMTP or mail library is used by the AWS path. |
| Password reset | CODE: the sign-in page redirects to Cognito managed login `/forgotPassword` (`packages/auth/src/cognito/oidc.ts`). Cognito sends the code. |
| Sender address shown | `PHASE_3_COGNITO_CURRENT_TARGET_MATRIX.md`: email sender `COGNITO_DEFAULT` (test) "SES later". With the default, Cognito sends from `no-reply@verificationemail.com` (AWS documented default; INFERRED, not seen in an Ogevia email). **No Ogevia-branded sender, no SES identity, no custom invite template is defined anywhere in the repository.** The user pool itself is **not created by CDK** (it is referenced), so its live email settings are UNKNOWN. |
| Limits | Cognito default email has a low daily send cap (AWS-documented; verify current value). Unverified whether invitation or reset emails reach inboxes or spam: no recorded delivery test other than the owner re-sending to `pinkpopsllc@gmail.com` on 2026-10-04. |
| Legacy | Supabase `invite-member` function (`inviteUserByEmail`) belongs to the old stack; not used by the AWS path. |

### 5.5 How a new agency and its owner are created today

CODE: **there is no application route, UI or self-service flow to create an agency or an owner.** The API has caregiver invitation only (`POST /v1/caregivers/{id}/invitation`, `.../resend`) and account disable/enable (`/v1/accounts/{userId}/disable|enable`). `PRODUCTION_DEPLOYMENT.md` states this explicitly.

Current procedure (a Cloud-Shell/operator procedure, per agency):
1. Cognito `AdminCreateUser` for the owner's email (temporary password emailed by Cognito; password change and TOTP at first sign-in).
2. Copy the Cognito `sub`.
3. As the RDS master user, in a DB window through the SSM admin host, run SQL that inserts into `ogevia.organizations`, `app_users` and `organization_memberships` (role `organization_owner`).
   Scripted only for **one hard-coded tenant**: `12_prd_bootstrap_tenant.sql` (slug `socal-care-services`) and `13_prd_bootstrap_admin.sql` (refuses a second owner). Other agencies need hand-written SQL.
4. Further staff: caregivers via the in-app invitation. **Managers, schedulers and other staff cannot be invited in the app**; they need steps 1-3 by hand.

### 5.6 Manual, missing or untested in onboarding

Manual: every new agency, every owner, every non-caregiver staff account; DB window and master-secret use; Cognito user creation; stack deployment per environment.
Missing (NOT BUILT): agency creation route or script; generalized owner bootstrap; staff invitation; email change or owner transfer in the app; agency suspension/offboarding; Stripe-to-tenant provisioning (`apps/netlify-functions` checkout/webhook belong to the legacy Supabase stack and do not create AWS tenants); Ogevia-branded email; a production-only Cognito pool/client (owner decision, `PRODUCTION_DEPLOYMENT.md` section 8); custom domain for app/API.
Untested live: bootstrap scripts `12_`/`13_` on `ogevia_prd` (checklist 6, 9, 10); sign-in to the prd app with MFA; caregiver-role isolation on prd; second-agency isolation through the API (automated DB tests exist, none run against prd); invitation email delivery and sender appearance; forgot-password flow end to end.
Stale or unsafe doc: `docs/deployment/phase-c-tenant-init-procedure.md` is Supabase-era (public schema, `organization_members`, `api.ogevia.com/organizations`, which does not exist) **and prints a literal temporary password**. It must not be followed. Recommend marking it superseded (owner approval to edit).

### 5.7 AWS costs

**Actual costs: UNKNOWN.** No Cost Explorer or bill output exists in the repository. `MONTHLY_PLATFORM_COST_2026-10.md` is an estimate: about $55-84 per month today (fixed about $54-83 plus under $1 variable), about $34-41 if the second RDS instance and the SSM endpoints are retired. Budget recorded as $50 per month (below the estimate). By-environment split is not possible from the estimate: the pilot and prd stacks add API, CloudFront, S3, KMS and Secrets Manager items that the estimate does not separate, and `ogevia-prod-postgres` hosts both `ogevia_sv_test` and `ogevia_prd` (one instance), so database cost cannot be split by environment at all. Tag `environment` is applied by CDK (`app.ts`), but cost allocation tags must be activated in Billing before Cost Explorer can group by them (UNKNOWN whether they are).

### 5.8 Read-only CloudShell commands for the unknowns (us-west-2; no secrets requested)

```bash
export AWS_REGION=us-west-2 POOL=us-west-2_849AYz5J7
# 1. Environments and generated URLs
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE --query "StackSummaries[?starts_with(StackName,'Ogevia-')].[StackName,StackStatus,LastUpdatedTime]" --output table
aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'Ogevia-')].[StackName,Outputs[].[OutputKey,OutputValue]]" --output json
aws cloudfront list-distributions --query "DistributionList.Items[].[Id,DomainName,Aliases.Items,Comment]" --output json
aws apigatewayv2 get-apis --query "Items[].[Name,ApiId,ApiEndpoint]" --output table
aws apigatewayv2 get-domain-names --query "Items[].DomainName"
aws route53 list-hosted-zones --query "HostedZones[].Name"     # console: Route 53 > Hosted zones (or your registrar's DNS page)
# 2. Cognito email sender, invitation template, MFA, callbacks (no secrets)
aws cognito-idp describe-user-pool --user-pool-id $POOL --query "UserPool.{MFA:MfaConfiguration,Email:EmailConfiguration,Invite:AdminCreateUserConfig,Recovery:AccountRecoverySetting,Domain:Domain,CustomDomain:CustomDomain}"
aws cognito-idp list-user-pool-clients --user-pool-id $POOL
aws cognito-idp describe-user-pool-client --user-pool-id $POOL --client-id 1i27abbina08fvg1i9u8vprgo9 --query "UserPoolClient.{Callbacks:CallbackURLs,Logout:LogoutURLs,Flows:ExplicitAuthFlows}"
aws sesv2 get-account --query "{Production:ProductionAccessEnabled,Sending:SendingEnabled}"; aws sesv2 list-email-identities
# 3. Sign-ins (counts and status first; emails are personal data, share masked if you prefer)
aws cognito-idp list-users --user-pool-id $POOL --query "Users[].[UserStatus,Enabled,UserCreateDate]" --output table
# 4. Memberships per database: use the existing audited reader for TEST
#    bash infra/aws/slice/live-status-check.sh   (type READ-DB when asked)
#    PRODUCTION has no reader script: after your approval, adapt only the RO() query block in
#    ogevia-live-status-block.sh (read-only transaction, DB window, never print secrets):
#    select o.slug, m.role, m.status, count(*) from ogevia.organization_memberships m
#      join ogevia.organizations o on o.id=m.organization_id group by 1,2,3 order by 1,2,3;
#    select o.slug, count(*) from ogevia.organizations o group by 1;
# 5. Costs (Cost Explorer API lives in us-east-1; change the dates to the month needed)
aws ce get-cost-and-usage --region us-east-1 --time-period Start=2026-10-01,End=2026-10-20 --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
aws ce list-cost-allocation-tags --region us-east-1 --query "CostAllocationTags[?TagKey=='environment']"
aws ce get-cost-and-usage --region us-east-1 --time-period Start=2026-10-01,End=2026-10-20 --granularity MONTHLY --metrics UnblendedCost --group-by Type=TAG,Key=environment    # empty until the tag is activated
aws budgets describe-budgets --account-id 300094796789 --query "Budgets[].[BudgetName,BudgetLimit.Amount,CalculatedSpend.ActualSpend.Amount]"
```
Console: Billing and Cost Management > Cost Explorer (group by Service; then by Tag `environment`), Billing > Cost allocation tags, Budgets, Cognito > User pools > Messaging.

### 5.9 Unanswered questions (summary)

1. What do `app.ogevia.com` and `www.ogevia.com` serve today, and is any environment reachable on a permanent URL?
2. Does the shared pool's `ogevia-web` client list the pilot and prd CloudFront callbacks?
3. Cognito `EmailConfiguration`: is it still `COGNITO_DEFAULT`, and what do invitation and reset emails look like to the recipient?
4. Have `12_` and `13_` been run on `ogevia_prd`, and who holds the owner membership?
5. Current account counts per environment (last record is 2026-10-04).
6. Actual AWS cost by service and environment, and whether the `environment` tag is activated.
7. Owner decision: build an agency-provisioning path (script or admin route) and a staff invitation path before a second agency, or keep it as an operator procedure.
