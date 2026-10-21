# Production authentication separation: consolidated deployment package (for owner approval)

**Status: PREPARED AND TESTED LOCALLY. NOT DEPLOYED. Nothing in AWS was changed, no identity was migrated, no live record was touched.**
Date: 2026-10-21. Branch `claude/determined-franklin-on6umd` (local, not pushed). Base: `origin/claude/ogevia-prd-readiness` (tip `fa3ca07`).

Distinguish: **implemented** (code and tests, local) is true; **deployed** is false; **verified live** is false. Every live claim below says which.

## 1. What you are asked to approve

Give Production its **own** sign-in (a dedicated Cognito user pool and web client), so that a pilot/test user can no longer obtain a token Production accepts, and Production invitations, the Production API and the Production website all use only that pool. The existing shared pool stays as the pilot/test pool, unchanged.

| You approve | Where |
|---|---|
| Deploying exactly two stacks: **new** `Ogevia-prd-Auth` and an **in-place update** of `Ogevia-prd-ServiceVerificationApi` | section 3, step A |
| Sending one Cognito invitation email to your Production administrator address | step B1 |
| Moving **your existing Production person record** to the new sign-in (one audited database change, reversible) | step B3 |
| Publishing the Production website build with the new sign-in settings | step C |
| A window of a few minutes during which the Production site cannot sign anyone in (between steps A and C) | section 5 |
| The typed phrases and approval reference in section 9 | section 9 |

**Not approved by this package and not done:** deleting anything; removing the old Production client from the shared pool; changing the pilot; DNS or `app.ogevia.com`; SES or custom invitation email; moving anyone other than the people you name; any database schema change.

## 2. Evidence base and branch resolution

| Item | Result |
|---|---|
| Newest code line | `origin/claude/ogevia-prd-readiness` (tip `fa3ca07`, 2026-10-20) contains `main` and 142 more commits (migrations to 0085, 228 routes, the production release package). No branch is ahead of it. The only newer remote branch is one documentation-only commit on `main`. |
| What I did | Merged that branch into this local branch (a merge commit; nothing rewritten, nothing of theirs removed) and built on top. |
| Authentication, environment and alarm files | **Identical** on `main` and the readiness branch (verified by diff), so the Phase 2 design stands on both. |
| Which commit is deployed | **UNVERIFIED.** The gate (step A check) compares the live templates with this code and refuses on any unexpected difference, which is the real proof. |
| Live state used | The owner's CloudShell inventory of 2026-10-21 03:38 UTC (`docs/aws/INVENTORY_RECONCILIATION_2026-10-21.md`): one shared pool, three clients, both APIs on that pool, audiences exactly `{legacy, test-slice}` and `{legacy, old production client}`. |
| Production records | Treated as potentially real. This package never creates, deletes, merges or edits a person, agency, membership, caregiver or visit record; the only database write is the sign-in id on the person you name. |

## 3. Exact resource changes

### 3.1 CREATED: stack `Ogevia-prd-Auth` (termination protection on; tag `ogevia:deployment-status` = your approval reference)

| Resource | Key settings |
|---|---|
| `AWS::Cognito::UserPool` `ogevia-prd` | Essentials tier; email as username; **MFA ON, authenticator app (TOTP) only**; **admin-create only (no self sign-up)**; password minimum 12 with upper, lower, number, symbol, history 5, temporary password valid 7 days; deletion protection **ACTIVE**; email by Cognito default; no SMS, no Lambda triggers, no groups, no custom attributes. **DeletionPolicy and UpdateReplacePolicy: Retain** (the pool survives even if the stack is deleted). Username and email attribute settings cannot be changed after creation; they are final. |
| `AWS::Cognito::UserPoolDomain` | prefix `ogevia-prd-300094796789`, managed login v2: `https://ogevia-prd-300094796789.auth.us-west-2.amazoncognito.com` |
| `AWS::Cognito::UserPoolClient` `ogevia-web-prd` | public (no secret), authorization code + PKCE, scopes `openid email`; flows refresh and SRP only; access/ID tokens 60 minutes, refresh 12 hours; token revocation on; callback `<production CloudFront origin>/auth/callback`, logout `<production CloudFront origin>/`; nothing else (no localhost, no `app.ogevia.com`) |
| `AWS::Cognito::ManagedLoginBranding` | Cognito-provided defaults |
| Outputs | `UserPoolId`, `UserPoolArn`, `AppClientId`, `ManagedLoginDomain` (plus three CloudFormation exports the API stack imports) |

### 3.2 CHANGED IN PLACE: stack `Ogevia-prd-ServiceVerificationApi` (no resource added, removed or replaced; verified by the gate)

| Resource | Property | From | To |
|---|---|---|---|
| JWT authorizer `ApiCognitoJwt1870F097` | Issuer | shared pool `us-west-2_849AYz5J7` | the production pool (import from `Ogevia-prd-Auth`) |
| same | Audience | `[legacy ogevia-web, old production client]` | **exactly one**: the production client |
| API Lambda `Handler886CB40B` | env `COGNITO_USER_POOL_ID` | shared pool | production pool |
| same | env `COGNITO_APP_CLIENT_ID` | legacy + old production client | production client (one) |
| same | env `OGEVIA_FORBIDDEN_POOL_IDS` | (absent) | `us-west-2_849AYz5J7`; the Lambda **refuses to start** on that pool, with the wrong number of clients, or without this setting |
| same | `Code.S3Key` | previous build | new build (adds that startup guard) |
| Identity Lambda `IdentityHandler6F0A3417` | env `COGNITO_USER_POOL_ID` | shared pool | production pool (this is what makes production invitations use the new pool) |
| Policy `IdentityPolicyF3EE534F` | statements `CreateCaregiverSignIns`, `SwitchSignInsOnOff`: `Resource` | shared pool ARN | production pool ARN (same four actions, nothing widened) |
| About a dozen resources | tag `ogevia:deployment-status` value | previous approval | your new approval reference (informational) |

CDK may ask to approve "IAM broadening" for the policy change. **Answer yes only if the shown difference is exactly those two statements' `Resource` changing to the production pool ARN; anything else: answer n and stop.**

### 3.3 Deliberately NOT changed

| Item | Why |
|---|---|
| `Ogevia-prd-WebHosting` (not deployed) | Its template loses one unused export (the old production client) because the API no longer imports it; the deploy guard accepts only the two stacks above, so the live web stack is untouched. Removing the old client is a later, separately approved clean-up. |
| Shared pool `us-west-2_849AYz5J7`, its three clients, its users | Left exactly as is (the post-check proves the client list is unchanged). The old production client stays there, now accepted by nothing. |
| Pilot stacks, pilot API, pilot database, pilot users | Untouched (post-check proves the pilot authorizer is unchanged). |
| RDS instances, databases, secrets, buckets, alarms, KMS | Untouched. No migration. |
| Cognito user pool of anyone else | There is none. |

Cost: no fixed charge. Cognito bills per monthly active user above its free allowance (current price **not re-verified** in this session); about 8 users exist in total. The default Cognito email allows about 50 messages a day (documented, not re-verified).

## 4. What people experience

1. **Between step A and step C (minutes):** the Production site cannot sign anyone in (the old site sends old-pool tokens, the API now refuses them). Pilot is unaffected.
2. **Production administrator (you):** one email from Cognito with a temporary password; first sign-in at the Production site sets a new password and enrols an authenticator app; then the same agency, role and permissions as today.
3. **Any other Production person** (the plan counts at least 5 accounts and 4 caregivers): cannot sign in to Production until they are invited and relinked one by one with the same scripts (`b-admin-prd.sh invite`, then `relink`, with their own email). Their pilot sign-ins keep working at the pilot. None of their records changes.

## 5. Sequencing and preconditions (all must hold before you approve a start)

1. The production release (window 2026-10-21 17:00-21:00 UTC per its plan; its stack was tagged 2026-10-20) is **closed** and no other production deployment is running. Nothing here may run inside that window. *Open question to you: when did that release actually run?*
2. You confirm which email is the Production administrator (the same inbox as today's sign-in), that you can read it, and that you have an authenticator app ready.
3. The admin database host `ogevia-db-admin-temp` is running (it was on 2026-10-21 03:38; this package never starts it) with the unchanged security group.
4. Production data is treated as potentially real. If any real person signs in to Production during the window they will be locked out for minutes; schedule it when nobody does.

## 6. Commands (CloudShell, us-west-2, administrator role; every YELLOW step needs your go)

All scripts are in `docs/releases/2026-10-21-auth-separation/scripts/` and, in the package, under `new/docs/releases/2026-10-21-auth-separation/scripts/`. READ-ONLY steps change nothing. No script prints a password, token, email, sign-in id or hash.

**Step 0: build and upload the package (done by Claude on request, locally; nothing is pushed)**

```bash
# in the repository, after the commit is approved:
bash docs/releases/2026-10-21-auth-separation/scripts/build-package.sh ./out <previous commit = fa3ca07 unless live shows otherwise>
# upload out/ogevia-prd-auth-package-<12 hex>.tar.gz and its .sha256 through CloudShell > Actions > Upload file
```

**Step 1: extract, verify, install (CloudShell, no AWS change)**

```bash
cd ~ && sha256sum -c ogevia-prd-auth-package-*.tar.gz.sha256
tar -xzf ogevia-prd-auth-package-*.tar.gz && cd pkg && sha256sum -c --quiet MANIFEST.sha256 && cat BUILD_INFO.json
# the candidate_commit must equal the commit you approved
cd new && pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store
cd infra/aws && npx tsx test/dump-templates.ts ~/auth-new-templates
export OGEVIA_AUTH_NEW_TEMPLATES=~/auth-new-templates
cd ~/pkg/new/docs/releases/2026-10-21-auth-separation/scripts
```

**Step A1: read-only gate** (saves the live templates; proves the live account is exactly as expected and the difference is only section 3)

```bash
bash a-deploy-prd.sh check          # expect: CHECK PASSED. Any FAIL: stop and send me the output.
```

**Step A2: rollback anchor** (YELLOW, creates one RDS snapshot; cost negligible)

```bash
SNAP=ogevia-prod-postgres-pre-auth-$(date -u +%Y%m%d%H%M)
aws rds create-db-snapshot --db-instance-identifier ogevia-prod-postgres --db-snapshot-identifier "$SNAP" --region us-west-2
aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAP" --region us-west-2 && echo "$SNAP available"
```

**Step A3: deploy** (YELLOW, changes PRODUCTION; starts the sign-in outage window)

```bash
export OGEVIA_DEPLOY_APPROVAL=<your approval reference>   # e.g. owner-go-auth-20261021
export OGEVIA_PREDEPLOY_SNAPSHOT_ID="$SNAP"
bash a-deploy-prd.sh deploy         # re-runs the gate, shows the exact command, asks you to type DEPLOY-Ogevia-prd-Auth-and-Api
```

It runs exactly `cdk deploy -c env=prd -c mode=deploy --exclusively Ogevia-prd-Auth Ogevia-prd-ServiceVerificationApi --require-approval broadening --no-notices`. A failed update is rolled back by CloudFormation itself.

**Step A4: post-checks** (READ-ONLY)

```bash
bash a-deploy-prd.sh post           # expect: POST-CHECKS PASSED (pool settings, one client, authorizer, Lambda, identity function, shared pool and pilot unchanged, anonymous 401)
```

**Step B0 (optional, can be run BEFORE step A): see which existing person record is yours** (YELLOW read-only database window)

```bash
export OGEVIA_EXPECT_HOST_IP=<admin host private IP, as in the release>
bash b-admin-prd.sh inspect         # type OPEN-5432-WINDOW-AUTH-INSPECT
```

Shows every person record (display name, role, agency, whether it has a sign-in) and duplicate warnings. No email or sign-in id.

**Step B1: invite the administrator into the production pool** (YELLOW, sends one email)

```bash
export OGEVIA_ADMIN_EMAIL=<your own inbox>
bash b-admin-prd.sh invite          # type INVITE-PRD-ADMIN
```

**Step B3: move your existing person record to the new sign-in** (YELLOW database write, reversible)

```bash
bash b-admin-prd.sh relink          # type OPEN-5432-WINDOW-AUTH-RELINK; output: RELINKED ... no person, agency, membership or caregiver record was added or removed
```

**Step C: publish the Production website with the production pool** (YELLOW; ends the outage window)

```bash
bash c-web-prd.sh build             # LOCAL: replaces only the sign-in values, refuses any bundle that still carries an old value
bash c-web-prd.sh publish           # type PUBLISH-WEB-Ogevia-prd-AUTH; refuses unless the API already trusts only the production client
```

**Step D: live token checks** (READ-ONLY)

```bash
bash d-verify-prd.sh tokens         # paste a production token and a pilot token when asked (not shown), or export OGEVIA_PRD_TOKEN / OGEVIA_TEST_TOKEN
```

Expected: production token to production API **200**; pilot token to production API **401**; production token to pilot API **401**; pilot token to pilot API **200**; no token **401** on both.

## 7. Administrator activation (what you do, in order)

1. Run B1. Open the email from Cognito (check spam; sender is the Cognito default address). It holds a temporary password.
2. Run B3 (the database now says: this existing person = this new sign-in). Then C.
3. Open the Production site. Sign in with your email and the temporary password; set a new password (12+ characters, upper, lower, number, symbol); enrol an authenticator app with the QR code; enter the code.
4. You land in the app as the same administrator: same agency name, same role (Administrator), same menu (Accounts, Settings, Billing review). If you see "Your account is not active in any organization", the relink did not happen or the wrong person was relinked: run `bash b-admin-prd.sh inspect`, then `undo`.
5. Run step D with your real production token (copy it from the browser: developer tools, Network, a `/v1/me` request, Authorization header, the part after `Bearer `; it expires in 60 minutes).

**How the existing mapping works (so nothing is duplicated):** a sign-in is a Cognito identity; the database keeps one **person record** per sign-in (`app_users`), and 94 tables reference that person record by its internal id. Emails live only in Cognito. `relink` changes only the sign-in id stored on your existing person record, so your membership, history and audit trail follow automatically. It **refuses** if the new sign-in already belongs to another person record (that would create a duplicate or merge people), if the person is disabled or has no membership, or if the database is not `ogevia_prd`. Running it twice changes nothing.

## 8. Rollback (nothing in this package deletes anything, so rollback loses nothing)

| If | Do |
|---|---|
| Step A3 fails or is interrupted | CloudFormation rolls the stack update back by itself. Run `bash a-deploy-prd.sh post`, send me the output. Production stays on the old pool. |
| After A, you want to go back | 1) `b-admin-prd.sh undo` for each relinked person; 2) `c-web-prd.sh rollback` if the web was published; 3) with the previous commit's templates: `OGEVIA_AUTH_PREVIOUS_TEMPLATES=<dir> bash a-deploy-prd.sh rollback-check` (read-only proof that the previous commit restores exactly the pre-change state); 4) `OGEVIA_PREVIOUS_CDK_DIR=<previous/infra/aws> bash e-rollback-prd.sh api` (type `ROLLBACK-Ogevia-prd-Api`); 5) `bash e-rollback-prd.sh post`. |
| The administrator is locked out | `b-admin-prd.sh undo` returns the person to the old sign-in; the old pool user was never removed. |
| Anything unexpected in the data | The only data change is the sign-in id of the named people, with before/after in the audit trail; the snapshot from A2 is the full-database anchor. |

`Ogevia-prd-Auth` is left in place after a rollback (it is retained and carries no traffic). Deleting a user pool is a separate RED action that needs its own instruction.

## 9. Approval block (what I need back from you)

> "GO for production authentication separation: commit `<12 hex>`, package sha256 `<…>`, reference `<owner-go-auth-…>`; administrator email `<…>` (you tell me; I do not store it); start window `<time>`."

| Typed phrase / variable | Step |
|---|---|
| `OGEVIA_DEPLOY_APPROVAL=<reference>` | every YELLOW step |
| `DEPLOY-Ogevia-prd-Auth-and-Api` | A3 |
| `INVITE-PRD-ADMIN` | B1 |
| `OPEN-5432-WINDOW-AUTH-INSPECT` / `-RELINK` / `-UNDO` | B0 / B3 / rollback |
| `PUBLISH-WEB-Ogevia-prd-AUTH` / `ROLLBACK-WEB-Ogevia-prd-AUTH` | C / rollback |
| `ROLLBACK-Ogevia-prd-Api` | rollback |

## 10. Tests (actual results, this session; see section 11 for the totals)

| Area | Evidence |
|---|---|
| Your Production administrator can sign in | `apps/sv-api/test/auth-cutover.db.test.ts`: after the real relink SQL, a production-pool token through the real handler returns your agency, role `organization_owner` and permissions (`accounts.manage`, `billing.approve`, `organization.update`); the old sign-in gets 401 |
| Production invitations use the new pool | same file: inviting a caregiver through the real route calls Cognito only on the production pool; `apps/sv-api/test/auth-separation.test.ts` and `production-auth.test.ts`: the identity function, its environment and its IAM statements name only the production pool; script test `b-admin-prd.sh invite` refuses when the function acts on any other pool |
| Test tokens rejected by Production, Production tokens rejected by Test | `packages/auth/src/server/environment-separation.test.ts` (11 cases with separate keys, issuers and clients per environment: cross-environment, forged, wrong audience, wrong issuer, expired, ID token); `auth-separation.test.ts` (Lambda handler, 8 production cases and the pilot direction); CDK tests (authorizer issuer and one-client audience) |
| Agency membership and permissions remain enforced | `auth-relink.db.test.ts` (19) and `auth-cutover.db.test.ts` (8): other agency gets no data, manager still refused the owner-only route, caregiver sees nothing and cannot write, a person in two agencies keeps both memberships; no person, agency or membership is added by the relink |
| Existing workflows continue working | The complete existing database and API suites run unchanged (section 11), including the visit, billing, scheduling and invitation workflows |
| Fail-closed configuration | The production Lambda refuses to start on the shared pool, without the forbidden-pool setting, or with more than one client (`auth-separation.test.ts`); CDK refuses a production configuration without a dedicated pool |
| Deployment safety | `auth-cutover-gate.test.ts` (14): the gate accepts only the intended change, using templates from the **unmodified release-branch code** as the "live" proxy, in plan and deploy mode, and refuses 11 kinds of drift; `auth-cutover-scripts.db.test.ts` (54): every operator script against a mocked AWS, fake curl, cdk and vite, and a real local PostgreSQL |
| Real CDK CLI | `cdk synth -c env=prd` in plan and deploy mode produced all six production stacks including `Ogevia-prd-Auth` |

**Not proven (needs your live run):** CloudFormation's own validation of the new pool and domain at deploy time; managed login v2 and TOTP enrolment behaviour; Cognito email delivery; the real Systems Manager tunnel; the gate against your actual live templates (it uses the code-synthesized proxy and refuses on any difference); the API Gateway authorizer behaviour with the new issuer. A failed deploy rolls back automatically; the post-checks and token checks are the live proof.

## 11. Test totals (actual run, local PostgreSQL 16 scratch cluster, candidate commit `a03f43e` plus this document)

Command: `OGEVIA_TEST_DATABASE_URL=postgres://… node scripts/test-all.mjs`; also `pnpm typecheck` (7/7 tasks) and `pnpm lint` (6/6 tasks), both passing.

| Suite | Result |
|---|---|
| `@carelik/shared` | 118 passed |
| `@carelik/auth` | 150 passed |
| `@carelik/sv-api` unit | 96 passed |
| `@carelik/ui` | 73 passed |
| `@carelik/web` | 1219 passed |
| `@carelik/infra-aws` (CDK, gate, config) | 534 passed |
| infra-aws database / script suites | 1162 passed, **1 failed** |
| sv-api database suite | 147 passed |

**The one failure is not caused by this change.** `db/test/lineage-lock-race.db.test.ts` ("end_service_visit twice … wrong-state errors are unchanged") fails identically on the unmodified readiness commit `fa3ca07` (checked in a separate worktree, same database). It is pure SQL; this change adds no migration. It needs its own look; it was not "fixed" here.

**One side-effect found and fixed.** The earlier production-readiness release package builds its templates from the working tree, so after this change 16 of its tests failed (it correctly noticed that the production API stack now differs). Its builder now accepts `OGEVIA_RELEASE_SOURCE_COMMIT` and the two suites pin it to `fa3ca07`, so that package keeps describing the release it was approved for. They pass again (62/62). This needs `fa3ca07` in the clone (it is an ancestor of this branch).

**Operator package.** `build-package.sh <out> fa3ca07` was run on the committed HEAD: manifest verifies (`sha256sum -c`), previous commit confirmed to lack the dedicated pool, candidate confirmed to have it. Two builds differ only in the `built_at` stamp in `BUILD_INFO.json`.
