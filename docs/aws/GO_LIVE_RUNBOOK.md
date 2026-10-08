# Go-live runbook: switch app.ogevia.com to the AWS production build

Status: **DRAFT for owner approval. Nothing here has been executed.** Prepared 2026-10-08.
Scope: AWS production activation only. Source of the commands: `docs/aws/PRODUCTION_DEPLOYMENT.md`, `docs/aws/PHASE_3_AUTH_CUTOVER_PLAN.md`, `infra/aws/scripts/deploy-production.sh`, `infra/aws/lib/cognito-target.ts`.

Evidence labels: **Repo** = stated in the repository; **Owner** = reported by the owner; **Unverified** = not checked live (no AWS, Netlify or DNS access was available when this was written).

## 1. Decisions recorded

| Decision | Choice | Source |
|---|---|---|
| Site that was tested | AWS Test, `https://d2xumch5w0izfg.cloudfront.net` (test database `ogevia_sv_test`, synthetic data) | Owner, 2026-10-08 |
| Launch scope | The AWS build as it is. Not included: hiring (candidates, applicants, public apply page, candidate portal), credentials, incidents, staff access and invitations, audit page, platform and organization admin, owner dashboard, pricing and Stripe, signed sheets, workforce. | Owner, 2026-10-08; routes compared in `App.tsx` and `aws/` |
| Data | Clean start for SoCal Care Services only. No Supabase data is copied. Ogevia Demo, OgeThinks and all test accounts stay behind. Supabase is not changed or deleted. | Owner, 2026-10-08 |
| Hosting | Netlify keeps serving `app.ogevia.com` with the AWS build (recommended). No DNS change. The CloudFront production stack has no custom-domain or certificate support. | Recommendation; owner to confirm |

## 2. Still needed before any step runs

| Item | Status |
|---|---|
| Written approval and an approval reference for `OGEVIA_DEPLOY_APPROVAL` | Pending |
| Approval for the Cognito client change (section 5) | Pending |
| Who runs the AWS steps (an operator shell with AWS admin access, `session-manager-plugin`, `psql`) | Pending |
| Owner email for the first administrator (the person's own inbox) | Pending |
| AWS BAA | Confirmed by the owner |
| Production restore test of `ogevia_prd` (step 4a): required before any real client data | Required; not yet prepared |
| Security headers for the AWS build on Netlify (section 4) | Open |
| Decision on the `Ogevia-prd-WebHosting` stack (section 7) | Open |

## 3. Steps

Each step ends with its GO criterion. Stop at the first failure.

| # | Step | Command or action | GO when |
|---|---|---|---|
| 1 | Read-only check | `cd infra/aws && AWS_PROFILE=<admin> ./scripts/deploy-production.sh check` | The check passes: inputs and production config valid; RDS available, backups on, encrypted, private. |
| 2 | Deploy production | `OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_ADMIN_EMAIL=<owner inbox> OGEVIA_ADMIN_NAME="<name>" AWS_PROFILE=<admin> ./scripts/deploy-production.sh all` (interactive; CDK asks to confirm IAM changes). Order: check, snapshot, secret, egress, database, infra, smoke. | Script exits 0. A pre-deploy snapshot exists. `ogevia_prd` has all 38 migrations (a rerun applies none). The smoke step shows the API running on `ogevia_prd` as `ogevia_prd_app`, anonymous calls return 401, and the test credential is refused on `ogevia_prd`. |
| 3 | Fix the sign-in client | Section 5. | `describe-user-pool-client` shows the target values. |
| 4 | Owner first sign-in | The invited owner opens the Cognito invitation, sets a password and enrols the authenticator code. The pool's multi-factor must be on or step 2 stops. | The owner signs in with the code, sees SoCal Care Services as `organization_owner`. |
| 4a | **Production restore test (REQUIRED before step 5)** | Restore the latest backup to a temporary instance, check that `ogevia_prd` is in it, record the time it took, and delete only the temporary instance. The existing restore script checks only the pilot database, so a version that also checks `ogevia_prd` must be prepared first. | The record shows the restore worked, `ogevia_prd` is present and intact, and the time to restore is written down. |
| 5 | Enter real data | In the app: services, clients (random client codes), authorizations, caregivers, assignments, managers. Staff get no production membership by default; the owner adds them. | Records visible to the owner only. Caregivers see only their assignments. |
| 6 | Real-phone test on a non-production address | Build the web with the production variables (section 4) and open it on a phone. During this test only, add the test address to the client's callback list, and remove it afterwards. | Start, end, confirm, signature stored in the `ogevia-prd-signature-evidence-...` bucket; a caregiver cannot see agency data; a synthetic client is voided afterwards. |
| 7 | Switch the site | Netlify, Production context: set the variables in section 4. Redeploy from `main`. | Netlify shows the new production deploy Published. |
| 8 | Smoke test on `app.ogevia.com` | Owner and caregiver sign-in, one visit end to end, one report. | All pass. Watch alarms for the agreed period. |

## 4. Netlify Production variables (build time)

Set in the **Production** context only. Deploy previews must not receive them; previews keep the demo Supabase settings from `netlify.toml`.

| Variable | Value |
|---|---|
| `VITE_AUTH_PROVIDER` | `cognito` |
| `VITE_COGNITO_REGION` | `us-west-2` |
| `VITE_COGNITO_USER_POOL_ID` | `us-west-2_849AYz5J7` |
| `VITE_COGNITO_CLIENT_ID` | `1i27abbina08fvg1i9u8vprgo9` |
| `VITE_COGNITO_DOMAIN` | `https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com` |
| `VITE_COGNITO_REDIRECT_URI` | `https://app.ogevia.com/auth/callback` |
| `VITE_COGNITO_LOGOUT_URI` | `https://app.ogevia.com/` |
| `VITE_COGNITO_REFRESH_PERSISTENCE` | `memory` or `session` (owner choice) |
| `VITE_SV_API_BASE_URL` | the `ApiUrl` output of `Ogevia-prd-ServiceVerificationApi` (known after step 2) |
| `VITE_APP_ENV` | `production` |

The identifiers above come from the repo (`cognito-target.ts`, `config.ts`) and are not secrets; the pool, client and domain were last recorded 2026-10-01 and are **Unverified** now. Keep the existing `VITE_SUPABASE_*` variables until Supabase is retired; the AWS build never creates a Supabase client.

Security headers: `netlify.toml` has none. The CloudFront stack provides a content-security-policy (`default-src 'self'`, `script-src 'self'`, `connect-src` limited to the site, the API and the Cognito domain, `frame-ancestors 'none'`), HSTS, `nosniff`, no referrer and a restrictive permissions policy. Add the equivalent for Netlify as part of step 7. Do not add it earlier: it would also apply to the current Supabase build, which needs different `connect-src` entries.

## 5. Cognito client change (`ogevia-web`, step 3)

Manual change; the client is not managed by CloudFormation. Values from `infra/aws/lib/cognito-target.ts` (current values were recorded 2026-10-01, **Unverified** now):

| Setting | Current | Target |
|---|---|---|
| Callback URL | `https://d84l1y8p4kdic.cloudfront.net` | `https://app.ogevia.com/auth/callback` |
| Logout URL | none | `https://app.ogevia.com/` |
| Explicit auth flows | refresh, user-auth, SRP | refresh, SRP |
| Refresh token life | 5 days | 12 hours |

Procedure: save the full `describe-user-pool-client` output first. `update-user-pool-client` resets any field you do not pass, so pass every existing field unchanged except the four above. Run `describe-user-pool-client` again and compare. Keep the saved output as the rollback.

## 6. Rollback

- Before step 7: nothing customer-facing changed. Restore the client values saved in step 3; the `ogevia_prd` database and stacks are retained (termination protection on).
- After step 7: unset `VITE_AUTH_PROVIDER` (and the other AWS variables) in Netlify and redeploy. The Supabase build is unchanged. Any records created in AWS after the switch stay in AWS and must be exported before returning customers to Supabase.

## 7. Known gaps and risks

- **Untested path.** AWS Test used a test-only Cognito client, the test database and CloudFront hosting. Production uses `ogevia-web`, `ogevia_prd`, the production API and Netlify. Only step 6 tests this combination before the switch.
- **Release.** The live AWS Test acceptance is release 0036 (`7b1236d`). Production applies 0038, and `main` is newer. No live test of that code exists.
- **`infra` also deploys `Ogevia-prd-WebHosting`** (CloudFront, S3 and an extra Cognito client). With Netlify hosting it is unused. Decide whether to keep it as a staging origin for step 6 or to remove it from the stack set. Whether its client's tokens are accepted by the production API is **Unverified**.
- **Shared sign-in pool.** The production API uses the same pool as AWS Test; authorization comes from database membership (`PRODUCTION_DEPLOYMENT.md` §8).
- **Multi-factor for every user, including caregivers**, adds sign-in friction (`PHASE_1_CDK_ARCHITECTURE.md`).
- **Phase 7 sign-off** (backup and restore drill, alarms, budget, content-security-policy review) is not recorded as done.
- **The AWS credentials used to prepare this runbook were rejected**, so every AWS value above is from the repo, not a live check.
