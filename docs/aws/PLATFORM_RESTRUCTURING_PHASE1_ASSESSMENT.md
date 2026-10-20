# Ogevia Platform Restructuring - Phase 1 assessment (inspection only)

Date: 2026-10-20. Repository `socalcaresservices/CarelikGlobal`, branch `claude/determined-franklin-on6umd`,
HEAD `d82fefcd37407d837e7c94f6ac57a907ea286ed1` (equal to `origin/main`; PR #97 merge). Working tree was clean at start;
this file is the only change. Nothing was deployed, migrated, pushed, or modified in AWS.

Evidence classes: **CODE** (read in this checkout), **TEST** (run in this session), **DOC** (a repository document says so;
not independently confirmed), **UNVERIFIED** (no evidence either way). "Implemented" never means "deployed".

## 0. Limits of this assessment

| Limit | Effect |
|---|---|
| OneNote charter not accessible (no OneNote connector in this session; a Google Drive search for the charter returned nothing). | The target requirements in the task brief were used. The charter was **not read**. |
| AWS credentials present in the environment are rejected (read-only Cognito `ListUserPools` returned `UnrecognizedClientException`; no AWS CLI installed). | No deployed resource was observed. Every "deployed" statement below is a DOC claim, mostly owner-pasted output from 2026-10-01 to 2026-10-10. |
| Netlify/Supabase settings and DNS are not visible from here. | What `app.ogevia.com`, `demo.ogevia.com` and `www.ogevia.com` serve today is UNVERIFIED. |
| Local PostgreSQL is 16; CI and RDS use 18. Scratch cluster used password auth; CI uses trust auth. | See section 6 for the two local test failures. |

## 1. Plain-language current state

- **One codebase, two backends in one web bundle.** `apps/web` builds one bundle. At start-up `VITE_AUTH_PROVIDER` selects either the
  legacy Supabase-era app (default when unset) or the AWS app (Cognito + API Gateway/Lambda + RDS PostgreSQL)
  (`apps/web/src/main.tsx:12`, `packages/auth/src/auth-provider.tsx`). The agency-facing product the pilot uses is the AWS app (`apps/web/src/aws/`).
  The legacy tree still contains the only subscription (Stripe) and platform-admin screens.
- **AWS has two named environments, both in one account, one VPC, one RDS instance and one Cognito user pool**
  (`infra/aws/lib/config.ts:17-18,164,203-220`). `env=prod` is the **pilot/test slice** (database `ogevia_sv_test`, synthetic data);
  `env=prd` is the **production candidate** (database `ogevia_prd`). The name "prod" meaning "test" is a standing source of confusion
  (`docs/aws/PRODUCTION_DEPLOYMENT.md` warns against it). There is **no** development, staging or demo environment in CDK.
- **Tenant isolation is strong and database-enforced.** The application database role has no table privilege; it can only execute
  `ogevia_api.*` functions, each of which re-checks active membership of an active organization and a role permission. Identity is the
  verified Cognito `sub`; organization, role and permissions are never read from the token or the browser
  (`0002_identity_tenancy.sql`, `0008_grants.sql`, `docs/aws/PHASE_3_AUTH_ARCHITECTURE.md`).
- **Agency lifecycle and platform operation are largely not built on AWS.** An organization status column exists (`active|suspended|closed`) and
  is honoured by every permission check, but there is no API/function to create, suspend or reactivate an agency, no subscription model,
  no platform operator identity (the `platform_owner` role is deliberately forbidden in `organization_memberships`), and no support-access mechanism.
  The first tenant and first administrator were created by SQL scripts plus a Cognito invitation.
- **Staff account management exists partially.** Caregiver invitation/resend and administrator disable/enable of any sign-in in the agency
  are implemented (0025, 0048). Inviting managers/schedulers/other roles, changing a role, and administrator-initiated password reset are not.
- **No agency "locations" concept exists on AWS.** `GET /v1/location-data` is ZIP-code data for matching, not agency sites.
- **Deployment evidence is thin and partly contradictory.** Documents disagree on what `app.ogevia.com` serves, which migration ledger
  the production candidate holds (38, 46 or 52 expected), and whether alarms exist. Wave 1 (0047-0052) is code-complete and not deployed anywhere.

## 2. Current versus target

| Area | Target | Current (evidence) | Gap |
|---|---|---|---|
| Environments | Dev, Test/Staging, Demo/Training, Production, each with own app/API deploy, database, auth config | Two: `prod` (=pilot/test) and `prd`; same account/VPC/RDS instance/Cognito pool (CODE config.ts) | Dev, Demo missing; Test/Prod not isolated at instance or identity level |
| Hostnames | `app.ogevia.com`, `demo.ogevia.com` | `*.cloudfront.net` for both AWS envs (DOC URL registry). No Route 53/ACM/custom domain in CDK. `demo.ogevia.com`: zero occurrences in repo. `app.ogevia.com`: CORS origin and unapplied Cognito target only (CODE) | DNS, certificates, custom domains, CORS per env; `app.` status UNVERIFIED and contradictory (B-17) |
| Identity | Shared Cognito customer pool **per environment** | One pool `us-west-2_849AYz5J7` shared by pilot and prd; 3 app clients; prd API audience still accepts legacy `ogevia-web` client (CODE service-verification-api-stack.ts:541) | Per-env pools/clients; narrow audience |
| Tenancy | Shared app + shared DB + enforced isolation | Implemented (function-only access, membership checks, RLS-on-no-policy defense in depth) | Needs a generated coverage proof across all 180 functions; platform paths are absent |
| Agency records and switching | Agency list, memberships, switching | `organizations`, `organization_memberships` (unique per org+user), `get_my_context` returns all active memberships; UI selector when >1 membership, active org kept in `sessionStorage` and sent as `organizationId` param | Works; switching not covered by an end-to-end test against API |
| Agency lifecycle | Create, invite, activate, suspend, reactivate | Status enum and enforcement exist; **no mutating function/route**; bootstrap by SQL (`db/deploy/12_prd_bootstrap_tenant.sql`) | Build |
| Subscriptions | Ogevia manages agency subscriptions | Stripe checkout/portal/webhook exist only for Supabase tree (`apps/netlify-functions`), accept Supabase JWTs only | Decide whether to port; no AWS-side field |
| Roles | Agency admins manage own staff/permissions | 9-value role enum; permissions granted only for `organization_owner`, `manager`, `scheduler`, `caregiver`, and two care-request permissions each for `organization_admin`/`coordinator`; `staff`/`read_only` have none (CODE migrations) | Role administration, permission editing not built |
| Staff lifecycle | Invite, reset initiation, deactivate, revoke sessions | Caregiver invite/resend (0025); disable/enable account with last-owner guard, DB-first, Cognito `AdminDisableUser` when last access (0048) | Non-caregiver invites; role change; admin-initiated reset; explicit global sign-out |
| Locations | Per-agency locations with access restrictions | Not present | Build or defer (decision) |
| Super Admin support | Controlled, audited | Not present on AWS. Legacy tree has `platform_owner` bypass screens (Supabase). AWS explicitly removed the bypass (`0002` comment) | Design and build |
| Demo safeguards | Synthetic data, no real notifications | Pilot banner "TEST - synthetic data only" via `VITE_APP_ENV`; synthetic seeds in `db/deploy/02-05`. No demo env. No code guard on outbound email | Build |
| Deployment control | Independent, gated, rollback | Strong per-release scripts with typed approval, diff gates, rollback scripts (pilot only); `OGEVIA_DEPLOY_APPROVAL` is a format check; no deploy CI | Generalise to 4 envs |
| Monitoring/DR | Alarms, backups, restore | 6 alarms, SNS topic with **no subscriptions** (CODE observability-stack.ts:26-45); 7-day backups; one restore drill on 2026-10-03 at migrations 0001-0012 (DOC) | Notifications, full drill |

## 3. Capability status

Status key: Implemented (in code and tested locally), In Progress, Planned, Unverified. "Deployed: UNVERIFIED" applies throughout unless noted.

| Capability | Status | Evidence |
|---|---|---|
| Function-only DB access, no table grants for app role | Implemented | `0001`, `0008_grants.sql`; verification SQL `db/verification/04_roles_grants.sql`; db tests (TEST: 559 of 561 DB tests pass, section 6) |
| Per-request membership + permission checks, suspended org rejected | Implemented | `0002` `is_active_member`/`has_permission`; `db/test/tenant-assignment-visit.db.test.ts:182`; `care-token-security.db.test.ts:130` |
| Token claims ignored for role/tenant | Implemented | `PHASE_3_AUTH_ARCHITECTURE.md` section 2; `packages/auth` tests (TEST: 138 pass) |
| Multi-agency membership and switching | Implemented (UI + `get_my_context`) | `aws-organization-provider.tsx`, `aws-shell.tsx:400-410`, `0009`; unique(org,user) |
| Cross-tenant file access (evidence, documents, logos) | Implemented; API-level isolation tests present, **live** untested | `apps/sv-api/src/evidence.ts`, `documents.ts`; `get_visit_signature_evidence` org check; TEST sv-api API suite 75 pass |
| Reports/exports isolation | Implemented in DB functions (org param + permission); no S3 report generation exists | `routes.ts` reports; DOC CONTINUITY_AND_RECOVERY section 3 |
| Background jobs | Not applicable: none exist | No EventBridge/schedulers in `infra/aws/lib` |
| Agency creation | Unverified/Planned: SQL bootstrap only | `db/deploy/12_prd_bootstrap_tenant.sql` |
| Agency suspend/reactivate | Planned (status column + enforcement only); `update organizations set status` appears only in tests | grep of migrations: no mutator |
| Agency invitation/activation of first admin | Partial: Cognito `AdminCreateUser` + `13_prd_bootstrap_admin.sql`; no route | `PRODUCTION_DEPLOYMENT.md` section 3 |
| Caregiver invite/resend | Implemented | `0025`, `apps/sv-api/src/identity*.ts`, routes `/v1/caregivers/{id}/invitation[/resend]` |
| Membership deactivation + sign-in disable | Implemented | `0048`; `GET /v1/accounts`, `POST /v1/accounts/{userId}/disable|enable`; `account-status.db.test.ts` |
| Session revocation | Partial. DB: membership suspension blocks the next API call (checked every request). Cognito: `AdminDisableUser` only when it was the person's last active access; no `AdminUserGlobalSignOut`; access tokens last 60 min, refresh 12 h (DOC/CODE web-hosting-stack.ts) | `0048`, `identity-handler.ts`. Effect on refresh tokens UNVERIFIED against live Cognito |
| Admin-initiated password reset | Planned: user-initiated "Forgot password" only; identity Lambda deliberately cannot set passwords | `identity-handler.ts` header |
| Non-caregiver staff invitation / role change | Planned | Only `role='caregiver'` is inserted by an invitation (`0025:280`) |
| Locations | Planned (nothing) | grep: `location` only in 0043/0044 (ZIP matching) |
| Super Admin support access + audit | Planned (nothing on AWS) | `0002` comment; web `isPlatformOwner` hard-coded false (`aws-organization-provider.tsx:332`) |
| Audit log | Implemented for domain events (`ogevia.write_audit`, `audit_events`, RLS on) | migrations; no platform-level events exist |
| Environment banner | Implemented for TEST/unverified; no DEMO | `apps/web/src/aws/environment.ts:18-23` |
| Demo environment/data | Planned (nothing) | no `demo` in IaC; synthetic seeds only for test slice |
| Outbound notification safeguards | Not present | Only outbound path is Cognito default email (DOC matrix; CODE identity-handler.ts) |
| CDK stacks per env | Implemented for 2 envs | `infra/aws/lib/app.ts`, 134 CDK tests pass (TEST) |
| Deployment gates and rollback | Implemented (pilot scripts, `deploy-production.sh`, 52 `.down.sql`) | `infra/aws/slice/*`; not exercised in this session |
| Alarm delivery | Not working as designed: no SNS subscriber | `observability-stack.ts`; DOC PHASE7 section 4 |
| Restore | Partially evidenced | DOC: one drill (4 min 15 s) to a new instance at 0001-0012; full-system recovery never drilled |

## 4. Confirmed defects, evidence gaps, dependencies

### Confirmed (CODE) defects or hazards
1. **Shared identity across test and production.** One Cognito pool; the prd API's JWT audience still includes the legacy `ogevia-web` client
   (`service-verification-api-stack.ts:541`), so any pilot/test user obtains a token the prd API accepts; only the lack of a prd membership stops them. Acknowledged in `PRODUCTION_DEPLOYMENT.md` section 8.
2. **No guard against real outbound email from non-production.** The identity Lambda can email any address in any environment where it is configured.
3. **Alarms notify nobody** (SNS topic has no subscription); the AWS Budget ($50) is below the documented estimated spend ($55-84) (DOC).
4. **No mutating path for agency status**; any suspension today is a manual SQL edit, which bypasses the audit trail.
5. **Administrator disable depends on a two-step DB-then-Cognito sequence** (safe direction). Cognito-side failure leaves the sign-in enabled but blocked by the DB; token refresh behaviour after disable is not tested live.
6. `db:rollback-readiness` defective for targets >= 0044 (BLOCKER_REGISTER B-15). A committed `infra/aws/cdk.out/` contains an `Ogevia-prd-NetworkEgress` template that current code no longer defines (appears stale).
7. Stale or contradictory records: `docs/BUILD_022_MULTI_TENANT_ARCHITECTURE.md` (hostname tenants on `carelik.com`, Supabase RLS, "production ready") and `docs/OGEVIA_OPERATING_RECORD.md` (labels `ogevia-postgres` development / `ogevia-prod-postgres` production, `app.ogevia.com` active) conflict with the AWS design and the URL registry. `CURRENT_AWS_INVENTORY.md` (2026-10-01) predates every stack. Config comment `config.ts:214-215` and the inventory disagree on which RDS master secret belongs to which instance (possible mismatch; UNVERIFIED).

### Evidence gaps (all UNVERIFIED)
- Live: RDS instances, backups, Cognito pool settings and clients, API/Lambda configuration, CloudFront/ACM/Route 53, alarms, budgets, deployed commit/migration ledger of pilot and prd, what `app.ogevia.com` and `www.ogevia.com` serve, Netlify env (`VITE_AUTH_PROVIDER`).
- The OneNote charter.
- Cognito behaviour on `AdminDisableUser` for existing refresh/access tokens.
- `organizationId` handling for every POST body in the web app (the client survey could not confirm all call sites; the server enforces regardless).

### Dependencies
- Owner credentials for read-only AWS inventory (Phase 0 below); CLAUDE.md forbids requesting them unless a task requires live access.
- Owner decisions D1-D8.
- Existing release process gates (`docs/TESTING_AND_RELEASE_PROCESS.md`); Wave 1 release (0047-0052) is unmerged-to-deployment and any new migration must number after 0052.

## 5. Role map (preserve names; do not rename)

| DB role | UI label (`aws-workspace.ts viewKind`) | Today's grants (CODE) |
|---|---|---|
| `organization_owner` | ADMINISTRATOR | All agency permissions incl. `accounts.manage`, `organization.update`, billing rates |
| `manager` | MANAGER | Operations + billing approval; no accounts, rates or branding |
| `organization_admin` | MANAGER | Only `care_requests.*` |
| `scheduler` | SCHEDULER | Shifts, matching, read access; no billing |
| `coordinator` | SCHEDULER | Only `care_requests.*` |
| `staff`, `read_only` | STAFF | No grants |
| `caregiver` | CAREGIVER | Own-scope permissions |
| `platform_owner` | none (AWS) | Rejected by check constraint on memberships; used only by the legacy Supabase tree |

Observation: the target "Agency administrators manage their own staff, permissions" maps to `organization_owner` + `accounts.manage`; the unused roles (`organization_admin`, `coordinator`, `staff`, `read_only`) are the natural extension points and need no rename.

## 6. Checks run (this session) and results

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | OK (ignored `node_modules` only) |
| `pnpm typecheck` | PASS, 7/7 tasks |
| `pnpm lint` | PASS, 6/6 tasks |
| `pnpm test` (unit/static, no DB) | PASS: web 792, auth 138, shared 118, ui 73, infra CDK 134, sv-api unit 67 |
| `pnpm build` | NOT RUN (not needed for the assessment) |
| `pnpm test:all` first attempt | FAILED to authenticate to my scratch Postgres (SCRAM, no password): 0 DB tests ran. Environment error, not a repo result. |
| `pnpm test:all` with scratch Postgres 16 + password auth | infra-aws DB tests: **559 pass, 2 fail**; sv-api API-against-DB tests: **75 pass**. Failures: `prd-deploy-scripts.db.test.ts` "production login acts as ogevia_app" and "TEST slice login cannot connect to ogevia_prd" - both `password authentication failed`. INFERRED to be a local-environment difference (CI runs PG 18 with trust auth, `.github/workflows/ci.yml`); not investigated further and **not** attributed to repo code. The CI `postgres` job result for HEAD was not retrieved. |
| AWS read-only call | Rejected credentials (`UnrecognizedClientException`) |
| OneNote / Drive charter search | Not accessible / no match |

These results come from the pre-existing checkout; no pre-existing failure was fixed or masked.

## 7. Decisions needed from the owner

| # | Decision | Recommendation | Consequence |
|---|---|---|---|
| D1 | Cognito topology: one customer pool per environment (dev, test, demo, prod) | Yes, four pools; production pool gets only the prd client; retire prd's use of `ogevia-web` | Users cannot be moved between pools without re-enrolment, so do this before real users; Essentials tier cost expected near $0 at current MAU (DOC, not re-verified) |
| D2 | Account strategy: separate AWS accounts vs same account | Same account, separate stacks/databases for dev/test/demo now; separate production RDS **instance** before real PHI scale; revisit accounts at growth | Accounts cost nothing fixed but add operational overhead; a second RDS instance is a recurring cost (approval required, CLAUDE.md section 11) |
| D3 | Environment naming | Introduce `dev`, `test`, `demo`, `prd` as new names; keep `prod` as a read-only alias of the current pilot until it is retired | Avoids repointing the running pilot |
| D4 | Platform operator identity | Platform staff are ordinary Cognito users in the production pool, registered in a new `platform_operators` table (not an organization role), MFA required, all actions on a separate `/v1/platform/*` namespace | Keeps tenant functions free of bypasses |
| D5 | Support access model | Time-boxed, reason-required, per-agency grant with owner notification and full audit; no standing cross-tenant read | Needs agency-side visibility screen |
| D6 | Subscriptions | Defer Stripe port; add a plain `subscription_status`/plan field editable by platform operators first | Stripe on AWS needs a vendor/PHI review and hosting decision (Netlify functions currently Supabase-only) |
| D7 | Locations | Define scope first (a location label on clients/caregivers/shifts vs access restriction). No schema until defined | Premature schema is costly to reverse |
| D8 | `app.ogevia.com` / `demo.ogevia.com` | Treat both as unverified targets; DNS/ACM only after D1-D3 and owner GO | DNS change is a YELLOW action |

## 8. Phased implementation plan

Each phase ends with the release-process gates (`docs/TESTING_AND_RELEASE_PROCESS.md`) and the owner's explicit GO before any deployment.

| Phase | Scope | Acceptance checks | Rollback |
|---|---|---|---|
| P0 Evidence closure (no code) | Owner runs the existing read-only checks (`pilot-preflight-readonly.sh`, `deploy-production.sh check`, `owner-access-check.sh`) and pastes output; confirm what `app.`/`www.` serve; resolve B-01..B-04, B-17; reconcile stale docs | Inventory table with every row dated and sourced; contradictions closed | Not applicable (read-only) |
| P1 Environment foundation | CDK `env` type extended to `dev|test|demo|prd`; per-env Cognito pool + client modelled; per-env DB name, secret, buckets; API audience limited to its own client; env marker adds DEMO; alarm SNS subscription (parameterised) | `cdk synth` for every env; CDK assertions: no env references another env's pool/DB/secret; prd rejects test tokens (token test with foreign client id) | Stacks per env are independent; `cdk destroy` only for non-stateful dev/test; prod stacks have termination protection |
| P2 Agency lifecycle (DB then API, then UI) | Migration 0053+: `platform_operators`, `ogevia_platform.*` functions: create agency, set status (active/suspended/closed) with reason, reactivate; first-admin invitation via the existing identity Lambda; audit events | DB tests: only operator succeeds; agency users get nothing; suspended agency blocked on all API routes (extend the existing suspended-org test to every route key); reactivation restores; audit rows written; idempotent retry | Additive migration; `.down.sql` refuses if data present (existing pattern); functions not granted until API route added |
| P3 Staff administration | Generalise 0025/0048: invite any non-owner role, change role (guards: last owner, self), explicit global sign-out on disable, resend; permission matrix for unused roles defined with owner | DB + API tests for each guard; token after disable fails on next call; Cognito identity Lambda adds only `AdminUserGlobalSignOut` | Additive; IAM change is a YELLOW action with approval |
| P4 Super Admin support access | Request/approve/expire grants (D5); read-only first; every call writes platform audit; agency-visible log | Expired grant stops access; no grant means 404-equivalent; audit rows attributable | Disable by revoking grants; no schema removal |
| P5 Locations | Per D7 scope | Per scope | Per scope |
| P6 Demo/Training | `demo` env with synthetic seeds, DEMO banner, outbound email disabled by default (identity function absent or allow-list), integrations non-production | No real address can receive mail from demo; reset script only runs when `OGEVIA_ENV=demo` | Delete and recreate demo stacks |
| P7 Operations | Four-env deploy runbook, per-env approval, backup/restore drill on production-shaped data, alarm delivery verified, budget reconciled | Restore drill at current migration level, timed; alarm test message received by a person | Snapshot-before-deploy (existing) |

## 9. Smallest useful first batch (proposal; not started)

**Batch 1: evidence closure + environment-isolation guard tests, with no behaviour change.**

Why first: every later phase needs (a) true live facts, and (b) a proof that environments cannot cross-authenticate. Both are read-only or test-only, and the second closes defect 1 as far as it can be closed before the pool split.

| Item | Detail |
|---|---|
| Scope | (1) New CDK unit test asserting the prd API stack's JWT audience contains only `ogevia-web-prd` once the legacy client is removed; today it will **fail**, documenting the gap, so ship it as a test of the *target* (`test.fails`/documented expected-fail) plus a config switch `extraAppClientIds` default unchanged. (2) New test that every route key in `ROUTES` is either public-by-token or requires a principal (completeness of the auth gate) - exists partly in `unit.test.ts`; extend only if not covered. (3) Generated suspended-organization test: iterate the route table and assert a suspended org yields 403/404 on every non-public route. (4) Correct the stale records (`OGEVIA_OPERATING_RECORD.md`, `BUILD_022...`) by adding a dated "superseded" banner; no deletion. |
| Files | `infra/aws/test/service-verification-api-stack.test.ts` (extend), `infra/aws/db/test/tenant-assignment-visit.db.test.ts` or a new `suspended-org-all-routes` db/API test under `apps/sv-api/test/`, two docs banners. No migration, no CDK construct change, no application code. |
| Validation | `pnpm typecheck`, `lint`, `test`, `test:all` (PG 18 or CI), CDK tests; compare against the baseline in section 6 |
| Risks | The route-iteration test may surface routes that do not check organization status (that would be a P0 finding, reported not fixed); expected-fail test semantics must be explicit so CI stays meaningful |
| Parallel owner input | P0 read-only AWS output so the inventory can be closed |
| Rollback | Revert the commit; tests and doc banners only |

Pending owner review: D1-D4 before Batch 2 (P1 environment foundation).
