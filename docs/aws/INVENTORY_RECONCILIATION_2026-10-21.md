# Live inventory reconciliation, 2026-10-21

Source: the owner's CloudShell output file `ogevia-inventory-20261021-0338.txt` (2,026 lines, run 2026-10-21 03:38:45 UTC, region us-west-2).
Evidence class: **OWNER-AWS (raw output)**. Claude read it; Claude did not run it and still has no working AWS access.
Nothing in AWS was changed by this work. This document records what the output confirms, what it changes, and what stays unverified.

## 0. How to read the evidence

| Item | Result |
|---|---|
| Caller identity in the output | The account **root** principal (`arn:aws:iam::300094796789:root`). See risk R18. |
| Commands that failed or returned nothing | `aws configure get region` (CloudShell has no default, expected); two S3 lifecycle reads (buckets without lifecycle rules, expected); the Secrets Manager listing and the SES `get-account` call are **absent from the file** (not even their command lines). Cause, reproduced locally: both contain a `!` inside double quotes (`'rds!'`, `!ProductionAccessEnabled`), and interactive bash aborts such a line with `event not found` without running it. **Inconclusive, not "no secrets"**. Fixed with `set +H` at the top of the script; re-run those two lines. |
| A script bug found | The Lambda step read an environment variable named `COGNITO_APP_CLIENT_IDS`. The real name is `COGNITO_APP_CLIENT_ID` (`apps/sv-api/src/config.ts`, `service-verification-api-stack.ts:516`), so that field printed `null`. Corrected in `CLOUDSHELL_READONLY_INVENTORY.md`. The audiences were still read correctly from the API authorizers. |
| Identity hashes, user lists, passwords, tokens | None were requested or are in the output. |

## 1. Which code is deployed (the baseline correction)

My Phase 1 and Phase 2 analysis was done on `main` (`d82fefc`, 2026-10-14). The live account is ahead of `main`:

| Evidence | Reading |
|---|---|
| Snapshots named `pre-0077-…` (10-18), `pre-0085-…` (10-19, two), `pre-prdrelease-…` (10-20 06:55Z) | The pilot database has been upgraded through migrations at least to 0085. `main` has only 0001-0052. |
| Branch `origin/claude/ogevia-prd-readiness` (tip `fa3ca07`, 2026-10-20) | 142 commits ahead of `main`, migrations to `0085_create_caregiver_gate_no_service_void`, 228 routes (10 public), a 15-minute EventBridge compliance rule, and a "production release package". Its plan records an owner GO for the window **2026-10-21 17:00-21:00 UTC** (reference `owner-go-prd-20261020-01`). |
| Stack tags and times | `Ogevia-prd-ServiceVerificationApi` updated **2026-10-20 07:12Z** with tag `approved-owner-go-prd-20261020-01`; production handler code hash changed (`ffiawX…` on 10-10 to `eVI1Zd…` on 10-20). The pilot handler (updated 10-19 21:34Z) has the **identical** hash `eVI1Zd…`. Both run the same build. |
| Which commit that build is | **UNVERIFIED.** Compare the Lambda code hash with a local synth of the branch tip. |
| Timing discrepancy | The production API stack carries the GO reference and was updated on 10-20 at 07:12Z, which is **before** the documented window (10-21 17:00Z). Either the steps were run earlier than the window, or the window text is stale. **Ask the owner; do not assume.** |
| Production database migration level | **UNVERIFIED.** Earlier documents said 38, 46 or 52; the snapshots point to a release near 0085. Needs the read-only ledger count (held, see section 7). |

Does this invalidate the separation analysis? **No.** Verified by `git diff origin/main origin/claude/ogevia-prd-readiness`: the files that define authentication, alarms, environments and hosting (`infra/aws/lib/config.ts`, `auth-contract.ts`, `app.ts`, `observability-stack.ts`, `web-hosting-stack.ts`, `apps/sv-api/src/config.ts`) are **unchanged** on that branch. Only the API stack changed (routes, one scheduled rule, one IAM statement), not its authorizer. The new batch (section 6) applies cleanly to that branch and passes its full infra suite (495 tests), including the release gate tests.

What does differ on the release branch (so earlier statements scoped to `main` must be read that way): 228 routes instead of 169 (public routes still exactly 10); a scheduled Lambda invocation exists (my earlier "no background jobs" is true of `main` only).

**Sequencing consequence:** the release branch is mid-release. Nothing in the separation work may touch an `Ogevia-prd-*` stack, the shared RDS instance, or the shared pool until the owner closes that release.

## 2. What the inventory confirms, changes or adds

| # | Topic | Prior statement | Live result (2026-10-21) | Verdict |
|---|---|---|---|---|
| 1 | Pools | One shared pool `us-west-2_849AYz5J7` | Exactly one pool; MFA `ON` (TOTP enabled), Essentials, deletion protection `ACTIVE`, admin-create-only, 12-character password policy with history 5, email sender `COGNITO_DEFAULT`, no triggers, no groups | **CONFIRMED** |
| 2 | Users | "about 22" (cost doc) / unknown | `EstimatedNumberOfUsers` = **8** | **CHANGED** (small) |
| 3 | Clients | Three clients | `ogevia-web` (`1i27…`), `ogevia-web-prd` (`2af4ao08…`), `ogevia-web-prod-test-slice` (`7po3lrme…`); callbacks and flows exactly as in `cognito-target.ts` and the web stack | **CONFIRMED** |
| 4 | Pilot API audience | `{legacy, test-slice}` | `["1i27…", "7po3lrme…"]`, issuer = the one pool | **CONFIRMED** |
| 5 | Production API audience | `{legacy, prd}` | `["1i27…", "2af4ao08…"]`, issuer = the one pool | **CONFIRMED** |
| 6 | Identity functions | Both point at the one pool | `Ogevia-prod-IdentityAdmin` and `Ogevia-prd-IdentityAdmin`, both `COGNITO_USER_POOL_ID=us-west-2_849AYz5J7` | **CONFIRMED** |
| 7 | API CORS | `https://app.ogevia.com` plus own origin | Both APIs allow `https://app.ogevia.com` **and** their own CloudFront origin | **CONFIRMED** |
| 8 | Domains | `app.ogevia.com` not repointed | **No Route 53 hosted zones, no registered domains, no ACM certificates (us-east-1 or us-west-2), no API custom domains, no CloudFront aliases.** Neither `app.` nor `demo.ogevia.com` is served from this AWS account. Where DNS lives (Netlify, registrar) is **UNVERIFIED** | **CONFIRMED and strengthened** |
| 9 | Stacks | Two environments, no dev/demo | 12 stacks: five `Ogevia-prd-*`, five `Ogevia-prod-*` (incl. `NetworkEgress` only for `prod`), `CDKToolkit`, `ogevia-prod-data-layer`. No dev, demo or staging stack | **CONFIRMED** |
| 10 | Termination protection | "on" for CDK stacks | On for all `Ogevia-*` stacks; **off for `ogevia-prod-data-layer`**, the stack that owns the shared RDS instance and its security groups (the instance itself has deletion protection) | **NEW finding** (low effort to close later; a change, so not done) |
| 11 | Alarms | "notify nobody" (both topics) | 6 alarms per environment, all `OK`. **Pilot topic has one confirmed email subscription. Production topic has none.** The pilot subscription is not in the code (created outside CDK) | **CHANGED** (see section 5) |
| 12 | GuardDuty | "off" (gap) | A detector exists (`DetectorIds` has one entry). Its status and findings were not read | **CHANGED** (stale doc), details UNVERIFIED |
| 13 | CloudTrail | Multi-region, validated | `ogevia-audit-trail`, multi-region, log validation on, logging, last delivery 03:33Z | **CONFIRMED** |
| 14 | WAF | None (deferred) | No web ACLs, regional or CloudFront | **CONFIRMED** |
| 15 | Budget | $50 vs spend $55-84 | One budget "ogevia phase 1 Budget", $50 monthly | **CONFIRMED** (still below the documented estimate) |
| 16 | SES | Not configured | No email identities | **CONFIRMED** (so email is Cognito-default only) |
| 17 | Network | No NAT; private RDS | No NAT gateways; 5 endpoints (ssm, ssmmessages, s3 gateway, secretsmanager, lambda); RDS not public | **CONFIRMED** |
| 18 | Admin host | "temporary" | `ogevia-db-admin-temp` (t3.micro) is **running**. Running hosts cost money and are a standing access path | **NEW finding** (do not start/stop it without approval) |
| 19 | Log retention | Finite everywhere | API, handler and identity log groups: 365 days. **`/aws/rds/instance/ogevia-prod-postgres/postgresql` has no retention (never expires)**, contrary to CLAUDE.md section 11. Two extra pairs of `Ogevia-prod-…` log groups also exist (older deploys) | **NEW finding** |
| 20 | KMS | Rotation on | Both evidence keys enabled, rotation on, next rotation 2027-10 | **CONFIRMED** |
| 21 | Master secret mapping (Phase 1 defect 7) | Possible mismatch | The stack output of `ogevia-prod-data-layer` names `rds!db-ceb5276c-…` as the master secret of **`ogevia-prod-postgres`**. `config.ts` is right; `CURRENT_AWS_INVENTORY.md` (which assigned it to `ogevia-postgres`) is wrong | **RESOLVED** (the older doc is the error) |
| 22 | Manual snapshots | Several | 13 manual snapshots, all of `ogevia-prod-postgres` (pre-pilot, pre-0021 … pre-0085, pre-prd, pre-prdrelease, pre-rehearsal). None for `ogevia-postgres` | **NEW detail** |
| 23 | Automated backups | 7 days | Both instances: 7-day retention, latest restorable time about 03:32Z, daily automated snapshots (`ogevia-postgres` 11:35Z, `ogevia-prod-postgres` 12:14Z) | **CONFIRMED** |

## 3. The two RDS instances, reconciled

| | `ogevia-prod-postgres` | `ogevia-postgres` |
|---|---|---|
| Engine and size | PostgreSQL 18.3, db.t4g.micro, 20 GB, single-AZ | identical |
| Protection | encrypted, **not public**, 7-day backups, deletion protection on | identical |
| Owner | CloudFormation stack `ogevia-prod-data-layer` (logical id `PostgreSQLDatabase`); stack termination protection **off** | **Unmanaged** (no CloudFormation tags); manually created |
| Subnet group / security group | `ogevia-prod-data-layer-dbsubnetgroup-…` / `sg-00530a1f…` (5432 from the Lambda security group only) | `ogevia-private-db-subnets` / `ogevia-db-sg` `sg-0bc0f1315…` (5432 from `ogevia-app-sg` and `ogevia-db-admin-sg`) |
| Tags | `Environment=production`, `DataClassification=sensitive`, `Application=Ogevia` | `Application`, `Name` only |
| Referenced by code | Yes: `config.ts:204`, CloudWatch alarms, the master secret `rds!db-ceb5276c-…`, both Lambdas' network path | **No.** Only a comment in `ownership.ts:29`. No Lambda, script or stack uses it |
| Databases it holds | `ogevia_sv_test` (pilot, synthetic) **and** `ogevia_prd` (production). **UNVERIFIED** from this output; established by code, Lambda `DB_NAME` (`ogevia_sv_test` on the pilot, `ogevia_prd` on production) and documents | **UNVERIFIED** (contents never inspected) |
| Snapshots | 13 manual + daily automated | automated only |
| Documents' label | "Production" (operating record) | "Development" (operating record, 2026-10-07) |
| Estimated cost | about $19.86/month each (cost doc estimate, not re-verified) | |

Reading:

1. **`ogevia-prod-postgres` is the production AND the pilot instance.** The instance tagged `production` / `sensitive` also holds the synthetic pilot database. Rollback granularity is the whole instance (readiness plan B3). The application logins are separate per database (the existing tests prove the pilot login cannot connect to `ogevia_prd`).
2. **`ogevia-postgres` is an apparently unused foundation instance.** Nothing in the repository connects to it. It costs about the same as the production instance. **Do not delete it, do not stop it, do not rename it.** It might hold early data; nobody has looked.
3. It is also the cheapest possible home for the missing **Development** and **Demo** databases (a different database name on an instance that already exists and is already private and encrypted). That is a recommendation for the owner's decision, not an action. It would not make production safer, only cheaper to build the other environments.
4. Smallest next facts (all read-only, held until you approve a database-access method): the database names on each instance, the migration ledger on each, and row counts on `ogevia-postgres`. Until then its status stays "unreferenced, contents unknown".

## 4. The confusing `prod` / `prd` naming, documented (no renames)

Nothing below is to be renamed. Renaming a CloudFormation stack, RDS instance, KMS alias or Cognito client replaces it and can destroy data or sign-ins.

| Name you see | What it actually is |
|---|---|
| `Ogevia-prod-*` stacks, CDK `-c env=prod`, tag `environment=prod`, `OGEVIA_ENV=prod` | **The PILOT / TEST slice.** Synthetic data. API `s0epy5rgzb`, site `d2xumch5w0izfg.cloudfront.net`, database `ogevia_sv_test`, Cognito client `ogevia-web-prod-test-slice` |
| `Ogevia-prd-*` stacks, CDK `-c env=prd` (alias `production`), `OGEVIA_ENV=prd` | **PRODUCTION.** API `zk527zk4ua`, site `d3l4psdkokkvnb.cloudfront.net`, database `ogevia_prd`, Cognito client `ogevia-web-prd`. Described as a pre-launch environment in the readiness plan (section 29, branch `claude/ogevia-prd-readiness`) |
| `ogevia-prod-postgres` | **The shared RDS instance** holding both of the above databases. Tagged `production`. Also the prefix of every manual snapshot (even `pre-prd-…`, `pre-0085-…`) |
| `ogevia-prod-data-layer` | The CloudFormation stack for that instance, its two security groups and the secret. Shared by pilot and production |
| `ogevia-prod-vpc` / `vpc-0ee9df0c…` | The one VPC for everything |
| `ogevia-postgres` | The unmanaged, unreferenced foundation instance ("Development" in one older document) |
| `us-west-2_849AYz5J7` "User pool - q5d8l" | The one shared Cognito pool |
| `ogevia-web` | The legacy client of that pool, accepted by both APIs |
| `www.ogevia.com` | The live Netlify/Supabase product, a different authentication system |
| `app.ogevia.com` | Allowed by CORS and written into target configurations only. **Not in Route 53/ACM/CloudFront in this account.** |

Rules until a rename is separately approved: write "pilot (`prod`)" and "production (`prd`)" together in every record; never write "prod" alone; new environments use the names `dev`, `test`, `demo`, `prd` (Phase 1 decision D3); keep the existing `prod` as a read-only alias of the pilot until it is retired.

## 5. The missing production alarm subscriber

Verified live: the production alarm topic (`Ogevia-prd-Observability-AlarmTopic…`) has **zero subscriptions**, so the six production alarms (Lambda errors, Lambda throttles, API 5xx, RDS CPU, RDS storage, RDS CPU credits) fire into a topic nobody receives. The pilot topic has one email subscription that exists only in the console.

| Item | Detail |
|---|---|
| Code change (this batch) | `ObservabilityStack` accepts an optional alarm email; `bin/ogevia.ts` reads it from `OGEVIA_ALARM_EMAIL` (never committed). **Default is off**, so every existing template, including the release package's, is unchanged (proved by tests, section 6) |
| Deploy-time effect | One `AWS::SNS::Subscription` (email). SNS sends the recipient a confirmation email; **nothing is delivered until they click Confirm.** Cost about $0 |
| Do not use it for the pilot topic | The pilot already has a console-created subscription; a second would duplicate it. Use it for `-c env=prd` only |
| Approval class | YELLOW (an observability stack update on a production environment): not to be run during the open release window, and only with the owner's explicit approval and a chosen recipient |
| Smaller alternative with no code or deploy | The owner subscribes an address to the production topic in the SNS console (one click and one confirmation). It is outside CDK like the pilot's. Recommended **today** if you want protection before the code lands; then the CDK subscription can follow later (or be skipped) |
| Owner decision needed | Who receives production alarms (a person or a shared mailbox), and whether a second contact is wanted |
| Not covered | Alarms do not page anyone out of hours; email only. No alarm exists for authorizer rejections or sign-in failures |

## 6. The code-and-tests batch (prepared, local, not deployed)

Scope (3 modified, 3 new files), no behaviour change when deployed:

| File | Change |
|---|---|
| `infra/aws/lib/observability-stack.ts` | Optional `alarmEmail` prop creating one email subscription; address validated; error text never echoes the address |
| `infra/aws/lib/app.ts` | Optional `options.alarmEmail` passed through (default none) |
| `infra/aws/bin/ogevia.ts` | Reads `OGEVIA_ALARM_EMAIL` (with a note to synthesize into a temporary `--output` directory so the address is not written into the tracked `infra/aws/cdk.out`) |
| `infra/aws/lib/auth-separation.ts` (new) | Pure function listing pool/domain/client identifiers shared between environments |
| `infra/aws/test/auth-separation.test.ts` (new) | (a) the committed configuration equals the live values; (b) **today's exact sharing** (pool, domain, legacy client between `prod` and `prd`) is recorded, so any NEW shared identifier fails the build; (c) an expected-to-fail **target** test (`it.fails`) that flips to green when pools are separated; (d) checker unit tests |
| `infra/aws/test/observability-alarm-subscription.test.ts` (new) | No subscription by default for either environment; empty address = none; with an address, exactly one added resource and every other resource byte-identical; invalid addresses rejected without echo |

Validation (actual results):

| Check | Base | Result |
|---|---|---|
| `tsc --noEmit` (infra) | my branch | pass |
| infra unit suite | my branch (`main` + docs) | **146 passed** (13 files) |
| `git apply --check` and apply | `origin/claude/ogevia-prd-readiness` (`fa3ca07`) in a throwaway worktree (removed afterwards) | applies cleanly |
| `tsc --noEmit` and full infra unit suite | readiness branch + batch | **495 passed** (23 files, includes the release gate and operator-script tests) |
| Not run | `pnpm build`, DB suites, API suites | unaffected by this change (no database, API or web files touched) |

Risks: the target test uses `it.fails`, which turns red the day the separation lands (intentional, it forces the ratchet to be flipped in that change); a future release template gate that diffs the Observability stack is safe because the default output is unchanged; the email address appears in a synthesized template when supplied, hence the temporary `--output` instruction.

Explicitly **not** in this batch: the startup guard that makes the production Lambda refuse the pilot pool (it would stop production from starting today), any Cognito, API, Lambda, IAM or web change, any rename, any deployment, any user move.

## 7. Impact on the separation plan

| Finding | Effect |
|---|---|
| Release mid-flight (section 1) | Phases 2 and 3 of the separation (provisioning, cutover) wait until the owner closes the production release. Phase 1 (code/tests) is unaffected |
| Estimated 8 users in the pool. The readiness plan counts at least 5 user accounts and 4 caregivers in production (section 28) and records an owner classification of that dataset as **synthetic** on 2026-10-20 (section 29) | That classification is a document in another branch, not a confirmation given in this work. **Production records are treated as potentially real until you confirm otherwise here.** The short-switch cutover is chosen only after you confirm in writing who those accounts are |
| No domain or certificate exists in AWS | The `app.ogevia.com` / `demo.ogevia.com` DNS step is entirely ahead (Route 53 or the current DNS host, ACM in us-east-1, CloudFront alias, Cognito callback). Keep it out of the separation change |
| One shared RDS instance | Pool separation does not change the database fate-sharing (readiness plan B3). That stays a separate owner decision; the unused `ogevia-postgres` is an option for non-production databases |
| Root principal used for the inventory | See R18 below |
| Additional risks | R18 root principal in daily use (Medium); R19 production alarms unsubscribed (High until closed); R20 admin host left running (Low-Medium); R21 separation work colliding with an open release window (High, mitigated by sequencing) |

## 8. Decisions needed (unchanged ones omitted)

1. Who receives production alarms, and whether to subscribe in the console now (recommended) or via the code later.
2. Confirm here whether the production rows (about 5 accounts, 4 caregivers per the readiness plan, which classifies them as synthetic on 2026-10-20) are synthetic or real. Until then they are treated as potentially real.
3. Confirm when the production release actually ran or will run (stack time 10-20 07:12Z vs window 10-21 17:00Z), so the separation is scheduled after it.
4. Whether to treat `ogevia-postgres` as the future Development/Demo database host (needs a read-only look at its contents first).
5. Whether to approve the held database counts (access method in `CLOUDSHELL_PHASE0_COUNTS.md`, master credential in a shell variable only).

## 9. Still unverified after this inventory

The deployed commit; both databases' migration ledgers and contents; the contents of `ogevia-postgres`; Secrets Manager metadata and SES account state (both lines were skipped by shell history expansion; fixed, re-run); GuardDuty detector status; whether the console subscription on the pilot topic is confirmed by a named person; where `app.ogevia.com` DNS is hosted; which users exist in the pool and in each database.
