# Consolidated Deployment Approval Request: Ogevia Test Slice (Phases 3-6)

**One approval covers everything below.** Nothing has been deployed. Every item is YELLOW under CLAUDE.md §13. It is prepared as code on branch `claude/phase3-cognito-auth`, synthesized, scanned (0 violations), cdk-nag clean, and diffed read-only.

## 1. Read-only facts (VERIFIED 2026-10-01, profile `ogevia-readonly`)

| Fact | Value |
| --- | --- |
| Account / region | 300094796789 / us-west-2 |
| CDK bootstrap (`CDKToolkit`) | **absent** |
| Template diff (`--method=template`) | 5 stacks: **61 resources added, 0 modified, 0 removed** |
| RDS `ogevia-prod-postgres` | available, PostgreSQL 18.3, db.t4g.micro, private, encrypted, `default.postgres18` |
| Admin host `ogevia-db-admin-temp` | `i-0ce8db2d7e5839dd5`, **running**, t3.micro (SSM tunnel available) |
| Cognito pool | 0 users, MFA ON, Essentials; one client `ogevia-web` |
| CloudFront distributions | none |
| VPC endpoints | SSM, SSM Messages only |
| Lambda account concurrency | 10 (D-P1-3: enough for testing; increase before production) |
| Budget | "ogevia phase 1 Budget", $50 |

## 2. What the approval authorizes (exact list)

| # | Action | Mutates | Reversible? |
| --- | --- | --- | --- |
| 1 | `cdk bootstrap aws://300094796789/us-west-2` (default template) | Creates the `CDKToolkit` stack: assets bucket, ECR repo, deploy roles | Yes (delete the stack + empty the bucket) |
| 2 | `cdk deploy` **Ogevia-prod-EvidenceStorage** | KMS key (rotation, RETAIN), signature bucket (SSE-KMS, versioned, private), access-log bucket | Stack delete keeps the key/buckets (RETAIN) |
| 3 | `cdk deploy` **Ogevia-prod-NetworkEgress** (D-P1-1) | Secrets Manager interface endpoint (1 AZ, private DNS), new endpoint SG (443 from AppSG), S3 gateway endpoint on the two private route tables (scoped policy) | Yes (stack delete) |
| 4 | `cdk deploy` **Ogevia-prod-WebHosting** | CloudFront + OAC + function + headers policy, site + log buckets, **new** Cognito app client `ogevia-web-prod-test-slice` + managed-login branding in the existing pool | Yes; buckets RETAIN |
| 5 | `cdk deploy` **Ogevia-prod-ServiceVerificationApi** | HTTP API (12 JWT routes), Lambda (real handler), IAM role/policy, 2 log groups (365 d) | Yes; log groups RETAIN |
| 6 | `cdk deploy` **Ogevia-prod-Observability** | 6 alarms, SNS topic | Yes |
| 7 | Create database `ogevia_sv_test` on the existing instance; apply migrations 0001-0009; create the app login role (NOINHERIT, member of `ogevia_app`) from the existing `ogevia/database/app` secret | DB objects only; no existing database touched | Yes (`drop database ogevia_sv_test`; drop role) |
| 8 | Create **2** Cognito users (caregiver + manager) at inboxes you control; invitation email; TOTP at first sign-in | 2 users | Yes (disable) |
| 9 | Seed **synthetic** org/clients/service/assignments/authorizations for those 2 users | Rows in `ogevia_sv_test` only | Yes |
| 10 | Upload the AWS web build to the site bucket; CloudFront invalidation | Objects | Yes |

**Not included (still prohibited):**
- changing `ogevia-web` or any pool setting;
- DNS, Netlify or Supabase;
- real users, clients or PHI;
- deleting anything;
- NAT, WAF, a production cutover;
- Object Lock;
- a Lambda concurrency quota request.

## 3. Cost (new recurring)

Unit prices are the VERIFIED values from `PHASE_1_COST_MODEL.md` unless marked otherwise.

| Item | Fixed / month | Usage at test volume |
| --- | --- | --- |
| Secrets Manager interface endpoint, 1 AZ | **$7.30** | +$0.01/GB |
| KMS evidence key | $1.00 | ≈ $0.01 |
| 6 CloudWatch alarms | $0.60 | — |
| Lambda, HTTP API, logs, S3, SNS | $0 | < $0.25 |
| CloudFront | $0 | ≈ $0 at test volume (always-free allowance; INFERRED, not re-verified) |
| Cognito (2 test users) | $0 | ≈ $0 (Essentials MAU pricing; not re-verified) |
| CDK bootstrap resources | $0 | pennies (asset storage) |
| **Total new** | **≈ $8.90/month** | **< $1/month** |

Existing cost to note: the admin host t3.micro is running. Recommendation: stop it after steps 7 and 9; stopping it is your action, not part of this approval. The 2-AZ endpoint alternative is ≈ $14.60/month.

## 4. Security posture after deployment

- RDS stays private; no SG rule is added to CloudFormation-owned groups; NAT stays deferred.
- Every API route requires a Cognito access token for one of 2 named app clients; the database decides tenant, role and assignment.
- Evidence is private (SSE-KMS, versioned, no CORS, no presigned URLs).
- Logs carry no PHI by design (tested).
- Only synthetic data exists in `ogevia_sv_test`.

**BAA gate (CLAUDE.md §8):** this deployment carries no PHI. The BAA must still be confirmed before any real client data (Phase 7).

## 5. Execution (one command per step, after approval)

```bash
cd infra/aws
export OGEVIA_DEPLOY_APPROVAL=<your approval reference, e.g. owner-2026-10-02>
export AWS_PROFILE=<administrator SSO profile>
export OGEVIA_TEST_CAREGIVER_EMAIL=<inbox you control>   # e.g. you+caregiver@…
export OGEVIA_TEST_MANAGER_EMAIL=<inbox you control>
export OGEVIA_RDS_MASTER_SECRET_ARN=arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-ceb5276c-c146-4b3d-9ce6-dab7b70e0cfa-PRte3a
./scripts/deploy-test-slice.sh preflight
./scripts/deploy-test-slice.sh bootstrap
./scripts/deploy-test-slice.sh infra        # cdk stops for confirmation on IAM/SG widening
./scripts/deploy-test-slice.sh database     # SSM tunnel via the admin host; secrets stay in shell memory
./scripts/deploy-test-slice.sh users
./scripts/deploy-test-slice.sh seed         # synthetic data for the two subs (opens its own tunnel)
./scripts/deploy-test-slice.sh web
./scripts/deploy-test-slice.sh smoke
```

Tools needed: AWS CLI v2, session-manager-plugin, psql, jq, pnpm, Node 22.

## 6. Browser testing (after `smoke` passes)

1. Open the `WebOrigin` URL printed by `web` (`https://<id>.cloudfront.net`) on a phone.
2. **Caregiver account:** open the invitation email → *Sign in* → temporary password → new password → TOTP enrolment (authenticator app). Then:
   1. Pick TEST-C01, start, wait at least 1 minute, end.
   2. Draw a signature and confirm. Expect "Visit saved / Confirmed".
   3. Repeat on TEST-C02 with **"No signature"** → expect review. (Optional: a visit over 2 h on TEST-C02 shows the authorization cap.)
3. **Manager account** (another browser or private window):
   1. Open *Visit records*: see both visits. Correct one (time + reason) and open *History*.
   2. Open *Billing review*: "Billing ready" vs "Needs review". *View signature* shows the drawn PNG.
4. Negative checks:
   - The caregiver has no *Billing review* link.
   - Signing out ends the session (Back does not restore it).
   - `curl <ApiUrl>/v1/me` without a token returns 401.

## 7. Rollback

- **Web:** delete the WebHosting stack. This removes the test client; buckets are retained.
- **API:** delete the API + Observability stacks.
- **Egress:** delete the NetworkEgress stack. This restores the route tables.
- **Database:** `drop database ogevia_sv_test with (force)`; drop the login role.
- **Users:** `admin-disable-user`.

None of these affect Supabase, Netlify, `ogevia-web`, or the existing RDS databases.

## 8. Execution log and open gate (2026-10-01)

| Step | Result |
| --- | --- |
| Approval | Owner approved ("approve the test deployment"); reference `owner-approved-2026-10-01-test-slice` |
| preflight | PASS (gate green; bootstrap absent; admin host running; Lambda limit 10) |
| bootstrap | **DONE**: `CDKToolkit` created in us-west-2 |
| infra | **NOT RUN**: the session's safety policy refuses `--require-approval never` (no human review of IAM/SG changes). Must be run by the owner in an interactive terminal |
| database | (first attempt) **FAILED SAFELY, nothing created**: RDS SG `sg-00530a1f4f7648e65` admits 5432 only from AppSG `sg-064ffce3bcbe8eb3b`; the admin host has only `sg-00e01e2ca80442c1f` (VERIFIED). The approval package missed this |
| users, seed, web, smoke | Not run (held so invitation passwords do not expire before the stack exists) |

**Decision needed (not covered by the original approval):** how the one-time database setup reaches RDS.

| Option | Change | Reversible | Recommendation |
| --- | --- | --- | --- |
| A | Temporarily attach AppSG to the admin host (`aws ec2 modify-instance-attribute --instance-id i-0ce8db2d7e5839dd5 --groups sg-00e01e2ca80442c1f sg-064ffce3bcbe8eb3b`), run `database` + `seed`, then restore `--groups sg-00e01e2ca80442c1f` | Yes, immediately | **Recommended**: no rule on any CloudFormation-owned group; the host gains exactly the Lambda's DB reachability, for minutes |
| B | Add an RDS SG ingress rule from the admin SG | Yes | Not recommended: changes a CloudFormation-owned group outside its stack (drift) |
| C | A one-off migration Lambda in the VPC | Yes | More code and another deploy; slower |

### 8.1 Database window (owner-approved option A, TEST only), 2026-10-01

| Item | Result (VERIFIED) |
| --- | --- |
| AppSG attached to `i-0ce8db2d7e5839dd5` | Only during the window, inside a script whose EXIT trap always restores the original group |
| Attempt 1 | `ogevia_sv_test` created + 0001-0009 applied, then stopped: the app secret's login is `ogevia_app` itself (`grant ogevia_app to ogevia_app`). SG restored and verified. Fixed in `01_app_login_role.sql` (+ test; 98 DB tests pass) |
| Attempt 2 | database (idempotent), `ogevia_app` LOGIN NOINHERIT with the secret's password, CONNECT on `ogevia_sv_test`; `db:verify` 97 PASS / 0 FAIL; 2 Cognito users created (`FORCE_CHANGE_PASSWORD`, invitations emailed); synthetic seed: 2 memberships, 2 assignments, 2 authorizations |
| SG removed | Admin host groups = `sg-00e01e2ca80442c1f` only; no network interface uses AppSG; tunnel process closed |
| RDS SG `sg-00530a1f4f7648e65` | Unchanged: 5432 from `sg-064ffce3bcbe8eb3b` only |
| Note | Roles are instance-wide: `ogevia_app` can now log in to other databases on this instance via the default PUBLIC CONNECT, but it holds no privileges there. Revoke PUBLIC CONNECT on other databases in Phase 7 |

### 8.2 One-command finish (2026-10-01)

`infra/aws/slice/finish.sh` (run from CloudShell) does the following:
- verifies the account, region, AdministratorAccess, bootstrap, test sign-ins and stack states (it stops on any failed stack and never deletes);
- shows the template diff;
- deploys the 5 stacks with `--require-approval broadening` (the owner types `y`);
- uploads the AWS web build plus a runtime `config.json` written from the stack outputs;
- invalidates CloudFront and waits until the site is reachable;
- runs `slice/smoke.py`.

The smoke suite (≈45 checks) covers:
- Cognito client/pool;
- API authorizer, routes, 401s and CORS;
- the Lambda configuration;
- the full workflow through the deployed Lambda using the seeded subs: start/idempotency/one-open/end/signature/retry/lock/no-signer/manager list/signature view/correction/history/billing review;
- tenant negatives;
- the S3 evidence object (SSE-KMS, versioned, anonymous 403) and the bucket controls;
- web routing, headers and config;
- log groups, alarms and SNS;
- RDS not public, the RDS SG unchanged, the admin host without AppSG;
- no sensitive values in Lambda logs.

Testing: the suite was run locally against PostgreSQL with the real handler, 30/30 workflow + tenant checks, re-run and interrupted-run recovery included. `finish.sh` was dry-run with stub tools (happy path + failed-stack stop). The bundled web build passed 22/22 in Chromium via `config.json` only.

Bundle: `s3://cdk-hnb659fds-assets-300094796789-us-west-2/ogevia-test-slice/ogevia-slice-7dc040c25549.tgz` (private bootstrap bucket, SSE-KMS), SHA-256 `c40b0fe5d3e18c76f8f8e41417c35640284c85cc66411b8ce753a240e822dcea`. It is built by `infra/aws/scripts/build-slice-bundle.sh` from commit `7dc040c25549`.

### 8.3 First CloudShell run: API stack failure and fix (2026-10-02)

| Item | Finding (VERIFIED) |
| --- | --- |
| Result | EvidenceStorage, NetworkEgress, WebHosting: `CREATE_COMPLETE` (kept, reused). ServiceVerificationApi: `ROLLBACK_COMPLETE`. Observability: not started |
| Cause | Lambda `Handler886CB40B` had `DependsOn: [HandlerRole]` only. The ENI actions live in the separate managed policy `HandlerPolicy7544C855`, which CloudFormation created in parallel. Events: Lambda `CREATE_FAILED` 23:57:30.904 ("...does not have permissions to call CreateNetworkInterface on EC2"); `HandlerPolicy` "Resource creation cancelled" 23:57:31.126 |
| Fix (`c70af6e`) | `this.handler.node.addDependency(policy)`; synthesized `DependsOn: [HandlerPolicy7544C855, HandlerRoleF4C27E12]`. No permission change: the same 5 ENI actions on `*`, no AWS managed policies |
| Guards | Regression tests (fail without the fix: negative control run); template-scanner rule `vpc-lambda-eni-ordering`; `finish.sh` checks every shipped VPC Lambda template before any action |
| Failed stack contents | Lambda, role, policy, API, stage, authorizer, metadata: `DELETE_COMPLETE` (no leftover role/function/API found). Two log groups `DELETE_SKIPPED` by design (RETAIN), 0 bytes, outside the stack. No outputs/exports |
| Recovery | Delete only the `Ogevia-prod-ServiceVerificationApi` stack record (termination protection must be lifted for it). This removes no live resource. `finish.sh` does it only with `OGEVIA_APPROVE_FAILED_API_CLEANUP=yes` and only if every resource is `DELETE_COMPLETE` (or a retained log group); it never touches another stack |
| Leftovers | The 2 empty retained log groups stay (no cost while empty). They can be deleted later on request |
| New bundle | `s3://cdk-hnb659fds-assets-300094796789-us-west-2/ogevia-test-slice/ogevia-slice-4f705a2f86ec.tgz`, SHA-256 `f76b50b95c502cf528b260d5d2bd295ce4674dda42939cc233d923e056e2e191` (commit `4f705a2`) |

### 8.4 PR #52 care requests: TEST deployment and acceptance (2026-10-02)

Synthetic data only. No production database, Netlify, Supabase, DNS or RDS rule change.

| Item | Result (VERIFIED unless marked) |
| --- | --- |
| Code | Commit `998e871` on `feature/care-request-availability`. CI run 36972877031: `validate` + `postgres` green; TEST bundle built and uploaded |
| DB window (owner-approved) | AppSG attached to the admin host inside a trap-restored script. Applied 0010 + 0011 to `ogevia_sv_test` only (`applied 2, already applied 9`). `db:verify` 0 FAIL, latest = 0011. Seeded TEST-CG-02 (link-only, 7 availability windows) with `db/deploy/03_seed_care_acceptance.sql`. AppSG removed; admin host = `sg-00e01e2ca80442c1f` only; RDS SG `sg-00530a1f4f7648e65` unchanged (5432 from AppSG only) |
| Pre-deploy diff | Run read-only against the live stacks with the bundle's `cdk.out`. EvidenceStorage, NetworkEgress, WebHosting, Observability: no differences. ServiceVerificationApi: 24 new routes + 24 `lambda:InvokeFunction` permissions (API Gateway principal, route-scoped `SourceArn`) and new Lambda code only. No network, RDS, IAM-role or environment change. Lambda `DB_NAME=ogevia_sv_test`, `DB_SET_ROLE=ogevia_app` (unchanged) |
| Deploy | Bundle `ogevia-slice-998e871b6e9a.tgz`, SHA-256 `d4e1cfc77ce1c5ed2dc1eb195af8a0255f97e1fc2bd9318e5df90742a7d4e7e4`. Owner ran `finish.sh` in CloudShell and confirmed the broadening prompt. ServiceVerificationApi `UPDATE_COMPLETE` 07:28 UTC; other stacks unchanged |
| Live API | 36 routes: 29 JWT, exactly 7 public `{token}` routes (the approved list). Anonymous probes: random portal/offer token 404, malformed token 400, staff care routes and revoke 401, unapproved `/v1/public/*` 404 |
| Smoke | 109/109 PASS (includes 21 care-workflow checks and log-hygiene checks) |
| Browser acceptance | 42/42 PASS, 390-px mobile Chromium. Pages: the exact files deployed to the site bucket, served under the real web origin through Playwright routing (CloudFront is blocked by the agent's egress policy). All `/v1` calls went to the live API. Agency steps used the smoke suite's Lambda-invoke mechanism (Cognito sign-in needs the owner's TOTP). One check (3-hour minimum) first failed with a client-side network error; access logs show that request never reached the API. Re-run in isolation: PASS |
| Covered in the browser | Client link opens without sign-in (token only in `#fragment`); only the client's authorized service offered; 2.5-h request refused with the API message; 4-h request accepted; under-72-h request flagged short notice; explicit availability + unavailable-date filtering; overlapping-shift conflict filtering; Available and Not available never assign; caregiver assign attempt 403; agency assignment creates one shift; repeated assignment creates no second shift; client and caregiver pages show Assigned; caregiver call-out → Coverage Needed (client page, staff queue, staff notification); called-out and Not-available caregivers not re-offered; replacement assignment reuses the **same shift id**; client cancels an assigned request in the browser → `client_cancelled`, caregiver link 404, staff notified, the cancelled shift no longer blocks the caregiver; revoke → invalid-link page; malformed fragment makes no API call; no horizontal scroll at 390 px |
| Not verifiable on the live API | Reservation row counts are not exposed by any route. "Reserved exactly once" and "released on client cancel" are proven by the CI PostgreSQL tests (`care-token-security.db.test.ts`); live evidence is indirect (same shift id reused; cancelled shift stops blocking) |
| Not done by the agent | Signed-in staff/caregiver screens (Care requests page, link creation/revoke buttons, caregiver availability screen): need the owner's Cognito sign-in with TOTP |
| Finding (follow-up) | The caregiver offer page shows no message when "I'm available", "Not available" or "I can no longer work this shift" fails (the mutation error is not rendered). Behaviour is correct when the call succeeds; failures are silent |
| Leftover synthetic data | Several unassigned synthetic requests and offers for TEST-C01 from acceptance/debug runs; all client links revoked |
