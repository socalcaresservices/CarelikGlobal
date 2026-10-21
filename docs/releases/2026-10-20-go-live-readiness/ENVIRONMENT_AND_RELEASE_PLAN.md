# Environment baseline and release plan (go-live readiness, engineer D)

Prepared from repository HEAD `291c713` (code `4029176`), branch `local/review-updates`. **PREPARED, NOT EXECUTED.** Nothing here was run against AWS, Netlify, Supabase or GitHub; no deployment, merge, push or snapshot is authorised by this document. Synthetic data only.

Status words (from `docs/TESTING_AND_RELEASE_PROCESS.md` 1.2): **implemented** = in the repository; **proposed** = written here, not agreed; **tested** (say where); **deployed** (say where). Evidence classes as in `SECURITY_PRIVACY_EVIDENCE.md`: IMPLEMENTED IN CODE / DOCUMENTED POLICY/PROCEDURE ONLY / UNVERIFIED / NOT FOUND.

---
# Part A. What the repository says about DEV, TEST and Production

## A1. Environments
| | DEV (local) | TEST / pilot | Production candidate |
|---|---|---|---|
| CDK context | none (no AWS) | `-c env=prod` (the word "prod" means the pilot slice) | `-c env=prd` (alias `production`) |
| Stacks | n/a | `Ogevia-prod-{EvidenceStorage,NetworkEgress,WebHosting,ServiceVerificationApi,Observability}` | `Ogevia-prd-{DatabaseSecret,EvidenceStorage,WebHosting,ServiceVerificationApi,Observability}`; NetworkEgress NOT duplicated: it is shared from `Ogevia-prod-NetworkEgress` |
| Database | `ogevia_local_harness` on local PostgreSQL (harness) | `ogevia_sv_test` | `ogevia_prd` |
| RDS | local Docker/PostgreSQL | `ogevia-prod-postgres` | the **same instance**, same master credential, same VPC, same Lambda security group, same Cognito pool |
| App login / secret | n/a | `ogevia_app` / `ogevia/database/app` | `ogevia_prd_app` / `ogevia/prd/database/app` (CDK-generated, RETAIN) |
| Web | `https://localhost` (harness, self-signed, stand-in sign-in, no MFA) | `https://d2xumch5w0izfg.cloudfront.net`, banner "TEST — synthetic data only" (built with `VITE_APP_ENV=test`) | `https://d3l4psdkokkvnb.cloudfront.net` (`VITE_APP_ENV=production`); `app.ogevia.com` DNS "not repointed" |
| API | local handler | `https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com` | `https://zk527zk4ua.execute-api.us-west-2.amazonaws.com` |
| Evidence | in-memory | TEST bucket + KMS key | `ogevia-prd-signature-evidence-...` + own KMS key |
| Fail-closed guards | harness refuses non-local DB | Lambda `OGEVIA_ENV=prod`; `DB_NAME=ogevia_sv_test` | `OGEVIA_ENV=prd` requires `DB_NAME=ogevia_prd` and secret `dbname` match (`config.ts:279-314`, `apps/sv-api/src/config.ts:56-61`) |
| Sources | `config.ts:151-160,251-260`; `docs/aws/URL_REGISTRY_AND_LAUNCH_CHECKLIST.md:14-16` (URLs are records from 2026-10-10, not live checks); `docs/aws/PRODUCTION_DEPLOYMENT.md:7-18` | | |

Correction of a common shorthand: `Ogevia-prod-*` serves **only** `ogevia_sv_test`. Production is `Ogevia-prd-*` and `ogevia_prd`. They share one RDS instance, one Cognito pool, and the NetworkEgress endpoints. Consequences: (1) a TEST-side deploy of `Ogevia-prod-NetworkEgress` also changes the endpoint policies production uses (it is a production-affecting stack even though named "prod"); (2) a restore, modify or reboot of the RDS instance affects both; (3) the Cognito pool, users and MFA settings are common.

## A2. Migration ledger state
| Environment | Latest known ledger | Evidence | Class |
|---|---|---|---|
| Local / repository | 0001-0081 contiguous; `db/verification/01_schema_version.sql` expects 0081 / 81 | `ls infra/aws/db/migrations` (81 files, 0078-0081 are the newest); 81 files in `infra/aws/db/rollback/` | IMPLEMENTED IN CODE |
| `main` (`d82fefc`) | 0052; HEAD is 83 commits ahead | `git rev-list --count main..HEAD` | IMPLEMENTED IN CODE |
| TEST `ogevia_sv_test` | 52 at 2026-10-17T16:29Z (owner-supplied run), then 0053-0077 applied by the owner's operation of 2026-10-18 and "verified in that session's output" (session output is not in the repository). Not re-read since. 0078-0081 NOT applied. | `docs/releases/2026-10-19-review-updates/CHECKLIST.md:10`; `HOURS_ACCOUNTING.md:3` | UNVERIFIED (owner operation; no record in repo) |
| Production `ogevia_prd` | Never read. Last recorded intent: 38 migrations (0001-0038) deployed 2026-10-10 (owner-provided stack status only; database existence and ledger "OPEN") | `URL_REGISTRY_AND_LAUNCH_CHECKLIST.md:45-48`; `ledger-check` docs state it is "UNKNOWN, never queried" | UNVERIFIED |

Implication: if production is at 0038, a release to it applies 0039-0081 (43 migrations) in one contiguous run (rule 3.3.5). Each needs its own approval and TEST/UAT validation. The production API code at the deployed stack is also from the 38-migration era.

## A3. Local vs main vs TEST vs Production (code, schema, infra)
| Layer | Local `291c713` | `main` `d82fefc` | TEST | Production |
|---|---|---|---|---|
| Migrations | 0081 | 0052 | 0077 (UNVERIFIED) | 0038? (UNVERIFIED) |
| API routes | all (routes in `service-verification-api-stack.ts`) | fewer (59 routes added by RC) | RC `64515dd`/`3159e52` family intended (exact SHA UNVERIFIED) | 38-migration era |
| IAM / endpoint policy | adds `ClientDocumentObjects` statement and `*/client-documents/*/*` endpoint pattern (`service-verification-api-stack.ts:460-465`, `network-egress-stack.ts:91-100`) | none | not present: document upload fails ("file could not be stored", cause established from code, live error not seen) | not present |
| Web | `VITE_AUTH_PROVIDER=cognito` AWS app, Review-updates UI | older | RC UI | old AWS build |
| `ComplianceSweep` (15 min EventBridge rule) | in code | no | enabled by owner on TEST 2026-10-18 | UNKNOWN |
| Legacy Netlify/Supabase build | still builds from repo | same | n/a | what Netlify serves at app.ogevia.com: UNVERIFIED |
Diff of infra code between RC `3159e52` and HEAD is limited to `network-egress-stack.ts`, `service-verification-api-stack.ts`, `evidence-storage-stack.ts` (the client-documents key shape; `git diff 3159e52 HEAD --stat -- infra/aws/lib`), plus API handler/route changes in `apps/sv-api/src` (131 insertions) and migrations 0078-0081.

## A4. How the deployed commit is identified, and what is missing
| Mechanism | Evidence | Verdict |
|---|---|---|
| `BUILD_INFO` (commit, build time, approval ref) | written only INSIDE the CI deployment-bundle tarball (`infra/aws/scripts/build-slice-bundle.sh:29`); not served by the web app or API | Not a deployed-commit stamp |
| Per-run operator manifests in CloudShell home (`MANIFEST.json` with `deployingCommit`, Lambda `CodeSha256`) | `infra/aws/slice/increment-deploy.sh:168-181` | Lives on the operator's machine, not in the repository |
| Stack tag `ogevia:deployment-status = approved-<OGEVIA_DEPLOY_APPROVAL>` | `infra/aws/lib/app.ts:130-136` | Identifies the approval, not the commit |
| `VITE_APP_VERSION` | `apps/web/src/env.ts:22`, default `0.1.0`; no script sets it | NOT FOUND (always `0.1.0`) |
| API version/health route | none in `apps/sv-api/src/routes.ts` | NOT FOUND |
| CDK output / Lambda env with the SHA | none | NOT FOUND |
| `candidate-pin-check.sh` (pins HEAD, migration hash, lockfile hash) | `infra/aws/slice/candidate-pin-check.sh:5-11,36-46` reads `candidate-pins.txt`, which is **not tracked** (`git ls-files` finds no such file) and names an old candidate (`d893276...`); it will report FAIL | Broken for this release |
| CI bundle workflow | `ci.yml` builds a bundle with the hard-coded approval `owner-approved-2026-10-01-test-slice`, copies only migrations 0010-0018, and runs a `mode=deploy` synth | Stale; do not use as a deployable artifact |

**Missing for stable commit identification (all PROPOSED, need owner approval since each is a code/deploy change):** (1) build the web app with `VITE_APP_VERSION=<40-char SHA>` and write `build-info.json` (SHA, time, approval ref) next to `index.html`; (2) set a `GIT_SHA` Lambda environment variable from CDK context (`-c sha=...`) and return it from an unauthenticated `GET /v1/version` that also reports the highest applied migration (reads `ogevia_meta.schema_migrations`; must be read-only and PHI-free; note the public route list is approval-gated); (3) tag stacks `ogevia:commit`; (4) commit the operator manifests' non-secret fields into `docs/releases/<id>/evidence/`; (5) regenerate or delete `candidate-pins.txt` and refresh the pins to the release SHA. Until then the deployed commit must be recorded manually: Lambda `CodeSha256` compared with a local `cdk synth` of the SHA, plus the SHA in the release checklist.

## A5. Configuration and secret parity
| Item | Repository evidence | Class |
|---|---|---|
| Lambda config comes only from CDK (no hand-set env vars): `DB_NAME`, `DB_SECRET_ARN`, `OGEVIA_ENV`, evidence bucket/key, Cognito pool/client ids, `DB_SET_ROLE=ogevia_app` | `service-verification-api-stack.ts:581-599` | IMPLEMENTED IN CODE |
| Web runtime config: build-time `VITE_*` plus optional `config.json` written at deploy time | `deploy-test-slice.sh:187-196`; `deploy-production.sh:331-334`; `aws-runtime.ts` | IMPLEMENTED IN CODE |
| Secrets: TEST `ogevia/database/app` (manual, rotation off); production `ogevia/prd/database/app` (CDK-generated); RDS master shared | `config.ts:218-219`; `database-secret-stack.ts` | IMPLEMENTED IN CODE |
| Environment-specific secrets that differ and must be checked before a release: TEST/prd Cognito app client ids (separate `WebHosting` stacks), API URLs, allowed origins, evidence bucket/key, DB secret | `web-hosting-stack.ts:132-150` | UNVERIFIED live |
| Parity gaps: TEST API allows origin `app.ogevia.com`; `ogevia-web` client accepted by both APIs; Cognito pool is one; `Ogevia-prd-Observability` never reported as deployed | `config.ts:160,158` | UNVERIFIED |
| Netlify env vars and Supabase keys | Netlify site settings | UNVERIFIED (outside repo) |

---
# Part B. Release plan (PROPOSED; for the owner to approve, an Operator to run)

Release under consideration: HEAD `291c713` family (code `4029176`), migrations 0078-0081 on top of TEST's 0077, plus the client-documents IAM/endpoint fix, plus whatever engineers A-C add (migration 0082 expected from engineer A: the plan below applies to the final SHA, not to `291c713`). The SHA is a placeholder `<RC_SHA>` until the lead freezes it.

Legend: **[GATE n]** = owner approval gate (written, with SHA and window). **R** = read-only. **W** = changes AWS/data (YELLOW). Stop condition = stop and report; do not improvise.

## B1. Release-candidate selection and code review checklist
| # | Step | Command / evidence | Stop condition |
|---|---|---|---|
| 1 | Freeze branch; record full 40-char `<RC_SHA>`; list commits since `3159e52` (10 at `291c713`) and since `main` (83) | `git rev-parse HEAD`; `git log --oneline 3159e52..<RC_SHA>` | Tree dirty; SHA not on a pushed branch (RC doc: the branch is not on GitHub, `RELEASE_CANDIDATE_CLOSURE.md:180`) |
| 2 | Migration rules audit | Only new files after 0077; none edited (`git diff --stat 3159e52 <RC_SHA> -- infra/aws/db/migrations` shows only additions); each has `rollback/NNNN_*.down.sql` with class header; `01_schema_version.sql` and ledger-tail tests name the new latest | Any edited applied migration; checksum drift |
| 3 | Security-sensitive review | `docs/security-review-checklist.md` completed for each new SECURITY DEFINER/grant change; confirm no wildcard IAM action (template scanner) | Unchecked security-sensitive migration |
| 4 | Infra diff review | `git diff 3159e52 <RC_SHA> -- infra/aws/lib`: expect only the client-documents statement + endpoint pattern (+ anything A-C add) | Any unexplained construct change |
| 5 | Scope statement | Written list: migrations, routes, screens, IAM statements, rollback order (web, API, DB) | Missing |
| 6 | Feature test plans + checklist | `docs/releases/<id>/CHECKLIST.md` from `RELEASE_CHECKLIST_TEMPLATE.md`; sections A and B completed with real output | Blank lines |
**[GATE 1] Owner approves the RC SHA, the scope, and the TEST window.**

## B2. CI verification against the exact release SHA
| What `.github/workflows/ci.yml` does (IMPLEMENTED IN CODE) | Evidence |
|---|---|
| Triggers on every pull request and on push to `main` only. Never deploys; `permissions: contents: read`; no secrets, no AWS/Netlify step. | `ci.yml:7-15` |
| Job `validate`: frozen install, `pnpm typecheck`, `lint`, `build`, `pnpm test` (unit/static, includes CDK vitest), then builds and uploads a 7-day TEST bundle | `ci.yml:17-47` |
| Job `postgres` (PostgreSQL 18 service): `pnpm test:all` = unit + `infra/aws` `test:db` + `sv-api` `test:db`, fails on any skip. **Yes, ci.yml does run the DB suites**, in this job only. | `ci.yml:49-82` |
| Job `harness`: harness setup, build, `harness:smoke` (41 checks) | `ci.yml:84-120` |

| Gap | Effect | Closing step |
|---|---|---|
| CI has never run on this SHA; the branch is not pushed. All counts in the ledger are local terminal runs. | G1-G3 not evidenced by CI | Owner authorises a push of the branch (no merge); open a PR so CI triggers; record the run URL and the three job results for `<RC_SHA>` **[GATE 2]** |
| A push to a non-`main` branch does not trigger CI (only `pull_request` and `main`) | Easy to believe CI ran when it did not | Confirm the run's head SHA equals `<RC_SHA>` |
| Whether the three jobs are REQUIRED checks before merge | UNVERIFIED | Owner reads branch protection |
| `validate` also builds a stale deploy bundle (A4) | Misleading artifact | Treat as informational; do not deploy from it |
| No `cdk synth -c env=prd`, no `cdk diff`, no dependency/secret scan, no coverage or accessibility job | Production synth only exercised through CDK unit tests | Run synth for both envs locally/CloudShell (below); scanning NOT FOUND |
| Node mismatch: CI Node 22; Netlify Node 20; Lambda Node 24 | Environment drift | Documented in process section 11; owner decision |
| `pnpm test` alone does not run DB tests | A green `validate` is not G3 | Require job `postgres` green |
Local fallback if CI is unavailable: run on a clean checkout of `<RC_SHA>`: `corepack enable && pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm build`, then `OGEVIA_TEST_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres pnpm test:all` (refuses to start without a local DB; fails on skips), then `pnpm --filter @carelik/infra-aws harness:setup && harness:build && harness:smoke`. Record counts against the baseline in process section 3.1.

## B3. TEST deployment and migration rehearsal (Operator, AWS CloudShell, us-west-2)
Target: `Ogevia-prod-*`, `ogevia_sv_test` only. **Never** `Ogevia-prd-*` or `ogevia_prd` (except the shared-stack caveat in step 9). Existing operator tooling used: `infra/aws/slice/owner-access-check.sh`, `ledger-check-temp-access.sh`, `infra/aws/scripts/deploy-test-slice.sh`, `infra/aws/db/scripts/{migrate,verify,rollback}.ts`, `infra/aws/slice/{smoke.py,pilot_smoke.py,pilot_regression.py}`. There is no single reviewed script for this exact release; the commands below follow `RELEASE_CANDIDATE_CLOSURE.md:211-245` and must be reviewed as a written command list (process 3.1 step 3). **[GATE 3] Owner approves this command list + `OGEVIA_DEPLOY_APPROVAL` reference.**

| # | Step (kind) | Command / action | Read-only pre-check | Expected result | Stop condition | Rollback |
|---|---|---|---|---|---|---|
| 1 | Pin (R) | clone, `git checkout <RC_SHA>`, `git rev-parse HEAD` | tree clean | equals approved SHA | mismatch | none needed |
| 2 | Local gate in CloudShell (R) | `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm build`; `npx cdk synth --quiet -c env=prod -c mode=plan`; same with `-c env=prd -c mode=plan` | none | all exit 0; for both envs no scanner violations | any failure | none |
| 3 | Identify environment (R) | Lambda config of `Ogevia-prod-ServiceVerificationApi` | n/a | `DB_NAME=ogevia_sv_test`, `OGEVIA_ENV` not `prd` | anything else | none |
| 4 | Baseline capture (R) | ledger via `ledger-check-temp-access.sh test --host-ip` (opens one temporary RDS SG rule, hash-verified restore; a **W** on the SG, needs its own approval); Lambda `CodeSha256`; `cloudformation get-template` of API and NetworkEgress stacks; `s3 sync` of current web bucket to `web-before`; `organization_readiness_settings.enforcement_active_from` | n/a | ledger `77 / 0077` contiguous, checksums equal repo files (if it reads 52 or 81, STOP and re-plan); enforcement still null | ledger not exactly 77; SG hash not restored (`NOT RESTORED`) | `--restore-only` run |
| 5 | Snapshot (W) | `aws rds create-db-snapshot --db-instance-identifier ogevia-prod-postgres --db-snapshot-identifier ogevia-prod-postgres-pre-0081-<date>`; wait `available` | `describe-db-instances` status available, `LatestRestorableTime` recent | snapshot `available` | not available | this snapshot is the anchor; restore only to a NEW instance (instance holds `ogevia_prd` too) |
| 6 | Diff NetworkEgress (R) | `npx cdk diff Ogevia-prod-NetworkEgress -c env=prod -c mode=deploy` | step 4 captured template | exactly: S3 gateway endpoint policy gains `*/client-documents/*/*` for each env (TEST and prd); nothing deleted/replaced | any other change, any replacement | n/a |
| 7 | Deploy NetworkEgress (W) **[GATE 4: shared with production]** | `npx cdk deploy Ogevia-prod-NetworkEgress -c env=prod -c mode=deploy --exclusively --require-approval broadening` (do NOT use `deploy-test-slice.sh infra`, which deploys all five stacks) | diff reviewed | `UPDATE_COMPLETE`; endpoint policy lists 4 key shapes | rollback/failed stack | redeploy previous commit's template (captured) |
| 8 | Migrations 0078-0081 (W) | `OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner OGEVIA_DATABASE_URL=<ogevia_sv_test URL via tunnel> npx tsx db/scripts/migrate.ts`; then `npx tsx db/scripts/verify.ts` | URL names `ogevia_sv_test`; `select current_database()` | "applying 0078 ... 0081", "applied 4, already applied 77"; verify all PASS (schema version 0081, 81 contiguous) | any failed migration (that file rolls back, earlier stay) | down scripts `0081..0078` in reverse with `psql -v ON_ERROR_STOP=1 --single-transaction -f`; or restore snapshot to new instance |
| 9 | Diff API (R) | `npx cdk diff Ogevia-prod-ServiceVerificationApi -c env=prod -c mode=deploy` | step 4 template | changed Lambda code asset; one added IAM statement `ClientDocumentObjects`; plus any routes added by A-C; nothing deleted; Lambda resource-policy size known (near the 20 480-byte limit once) | anything else | n/a |
| 10 | Deploy API (W) | `npx cdk deploy Ogevia-prod-ServiceVerificationApi -c env=prod -c mode=deploy --exclusively --require-approval broadening` **immediately after step 8** | diff reviewed | `UPDATE_COMPLETE`; Lambda env unchanged; resource-policy size < 20 480 B; rule `ComplianceSweep` ENABLED | stack rollback | redeploy previous API (captured template/code) — previous API works on new schema except intended differences (verify for 0078-0081 in step 13) |
| 11 | Web (W) | `OGEVIA_APP_ENV=test ... ./scripts/deploy-test-slice.sh web` | `web-before` copy exists | new bundle uploaded, `/index.html` and `/` invalidated; banner "TEST — synthetic data only" | banner missing | re-upload `web-before`, invalidate |
| 12 | Smoke (R) | `deploy-test-slice.sh smoke`; `python3 infra/aws/slice/smoke.py`; `pilot_smoke.py` | n/a | anonymous 401, CSP header, SPA route 200; all checks PASS | any FAIL | roll back web, then API, then DB |
| 13 | Regression runner | `python3 infra/aws/slice/pilot_regression.py --mode aws --i-am-targeting-the-pilot --commit <RC_SHA> ...` (instructions `docs/release-process/PILOT_REGRESSION_RUNNER.md`; implemented and tested locally, never run on the pilot) | stack = `Ogevia-prod-ServiceVerificationApi`, `DB_NAME=ogevia_sv_test` | exit code 0 (gate needs 0; no `--allow-skip`) | exit 1/2/3 | fix forward on new commit, restart at Phase A |
| 14 | Post-state record (R) | ledger `81 / 0081`; Lambda `CodeSha256`; `enforcement_active_from` null; migration verify output | n/a | recorded in checklist section C | mismatch | n/a |
| 15 | Rollback rehearsal on TEST (W, optional but PROPOSED as required before production) | after step 14 and **[GATE 5]**: apply down scripts 0081-0078, run `verify.ts` at 0077 expectations, re-apply forward | snapshot from step 5 exists | forward/back/forward returns to 81 with counts unchanged | any data loss | restore snapshot to NEW instance |
Shared-stack caveat (step 7): NetworkEgress is owned by `env=prod` but carries production's endpoint policies. The change is additive; still announce it as production-affecting and confirm production smoke (`deploy-production.sh smoke`, read-only, needs an admin session) afterwards. Not run here.

## B4. Rollback order (any step failing)
web (re-upload `web-before`) then API (previous template/code) then DB (down scripts in reverse, or snapshot restore to a NEW instance). Classes from `RELEASE_CANDIDATE_CLOSURE.md:236-245`: BACKUP REQUIRED for 0055, 0056, 0060, 0063, 0064, 0067-0069, 0071-0074, 0077; for 0078-0081 read each file's `-- ROLLBACK` header before use (0081 down is 449 lines). The decision to call a rollback is made by the owner on the triggers in B7.

## B5. End-to-end acceptance testing (Phase C/D) mapped to `docs/release-process/ACCEPTANCE_TEST_CATALOG.md`
| Set | Catalog IDs | Who | Notes |
|---|---|---|---|
| Smoke S | SMK-01 to SMK-08 (sign-in each role, Home numbers, Schedule, caregiver sees only assigned clients, start/end visit, 401 unauthenticated, TEST banner, standard suites) | Operator + Owner | every environment |
| Regression R | cases marked R in SCH, REC, VIS, AUT, DSH, RPT, USR | `pilot_regression.py` (API part) + hand | exit 0 required |
| Changed areas (by this release) | AUT, SCH, REC, DSH, RPT, VIS (accounting/one-bucket, 0078-0081); CMP + CLD (CPR/TB verified-required, client documents incl. the upload fix); UIS/HOM (wording, navigation regroup, route map `docs/releases/2026-10-19-review-updates/ROUTE_MAP.md`); NTF, CNT, ISS, DLN, SDS, PRF, UPG, ENF (release-candidate additions) | Owner, Scheduler, Caregiver, Authorization validator | Phase D sign-offs (process section 7) |
| Real-service checks the harness cannot prove | MFA sign-in, forged/absent token 401 through API Gateway, S3 upload/read of a client document and signature, KMS, CSP/CloudFront, RDS TLS | Operator | process 4.2; also security rows A7, B6 |
| Negative checks on TEST | unauthenticated 401; forged token 401; other tenant sees nothing; caregiver cannot reach administrator data; uploader cannot approve own document | Operator | `SECURITY_PRIVACY_EVIDENCE.md` B6 |
| Document-upload verification | upload a synthetic client document on TEST after step 10; confirm stored and retrievable; approve with a second account | Operator + Owner | closes the live check for the fix (cause was from code) |
| Authorization validator | recompute by hand three authorizations (low use, near limit, amended) | Authorization owner | process section 7 |
| Phone test | real caregiver phone: start, end, confirm; no horizontal scroll | Caregiver | `RELEASE_CANDIDATE_CLOSURE.md` section 9 (not yet performed) |
| Owner's 13 signed-in checks | listed in `RELEASE_CANDIDATE_CLOSURE.md:8.4` | Owner | "not yet reported" per readiness report |
Defect classes and NO-GO rules per process section 7. **[GATE 6] Owner records Phase D sign-offs (four roles) on the release SHA.**

## B6. Backup and recovery verification before production
| # | Step | Evidence required | Stop condition |
|---|---|---|---|
| 1 | Read-only RDS check: `deploy-production.sh check` | status available, backups >= 7 d, `StorageEncrypted`, not public, deletion protection, `LatestRestorableTime` | any item false (these settings are not in code; see security rows C7, F1) |
| 2 | Take pre-production snapshot (name with date) and wait `available` | snapshot id/time/status | not available |
| 3 | Restore latest snapshot (or PITR) to a **scratch** instance in the same private subnet group and security group, no public access, never replacing `ogevia-prod-postgres` | new instance id, time to available (last drill: 4 min 15 s on 2026-10-03, database only, schema 0001-0012) | restore into the live instance; public access |
| 4 | On the scratch instance: ledger equals source (versions + checksums, contiguous), `verify.ts`, row counts for `ogevia_sv_test` and `ogevia_prd` vs source, a forward migration + down rehearsal if not done in B3 step 15 | counts identical | any difference |
| 5 | Record time to available and `LatestRestorableTime` vs clock (data-loss window); delete **only** the scratch instance (owner approval; RED rule: no other deletion) | recorded | n/a |
| 6 | S3 + Cognito: confirm bucket versioning, list pool users (counts only), document the re-link procedure (NOT FOUND today) | written | gap accepted in writing or closed |
**[GATE 7] Owner accepts backup/restore evidence (closes security rows F1-F5).** A restore to production is a separate approval.

## B7. Production deployment plan (YELLOW; PROPOSED)
Preconditions (all must be recorded before GATE 8): Phase C and D done on the same SHA; B6 done; Critical rows of `SECURITY_PRIVACY_EVIDENCE.md` closed or formally accepted (alarm subscriber, incident owner, RDS settings verified live, BAA copy); production state read (below).
| # | Step | Command / action | Expected | Stop / rollback |
|---|---|---|---|---|
| 1 | Read-only production baseline | `ledger-check-temp-access.sh prod` (needs separate approval; refuses `--host-ip` for prod); Lambda `DB_NAME=ogevia_prd`, `OGEVIA_ENV=prd`; `deploy-production.sh check` | ledger known; if the database does not exist, STOP: first-time creation is a different plan (`deploy-production.sh all`) | unexpected ledger or SG hash not restored |
| 2 | Decide path | ledger N -> apply N+1..81 contiguously; **`deploy-production.sh database` hard-codes the 38-file expectation in its comments and must be reviewed against 0081 before use** (`deploy-production.sh:206-210`) | written, reviewed command list | script not reviewed |
| 3 | Snapshot `ogevia-prod-postgres-pre-prd-0081-<date>` | `deploy-production.sh snapshot` (`:126-134`) | available | anchor |
| 4 | Migrations on `ogevia_prd` only | `migrate.ts` with remote guard, URL naming `ogevia_prd`, login = admin | applied N+1..81; `verify.ts` PASS | failed file rolls back; fix forward or snapshot restore to new instance |
| 5 | Infra | `npx cdk diff` then `cdk deploy Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability -c env=prd -c mode=deploy --exclusively --require-approval broadening`; (`Ogevia-prd-WebHosting` only if its diff is expected) | stack `UPDATE_COMPLETE`; includes `ClientDocumentObjects` | any replacement or unexpected IAM change: STOP |
| 6 | Web | `deploy-production.sh web` (`VITE_APP_ENV=production`) | bundle contains the prd API host `zk527zk4ua`, not `s0epy5rgzb` (checklist item 4) | wrong API host: roll back web |
| 7 | Smoke (read-only) | `deploy-production.sh smoke` (`:282-316`) | Lambda config correct, 401 anonymous, runtime connection observed on `ogevia_prd` as `ogevia_prd_app`, none on the test DB | any FAIL |
| 8 | Owner's own account | MFA sign-in, changed workflows, SMK set with one clearly labelled synthetic client; delete/void through supported path | PASS | any FAIL: rollback plan |
| 9 | Monitoring period | B8 thresholds for the agreed period | within limits | trigger -> rollback |
Approvals: **[GATE 8]** owner GO for this SHA and window (process section 8 decision record); **[GATE 9]** separate approval for any snapshot restore/instance deletion; **[GATE 10]** separate approval for DNS (`app.ogevia.com`), custom domain/TLS, enforcement activation (`ACTIVATION_CHECKLIST_SOCAL_CARE_SERVICES.md`; one-way switch), and real data (BAA/security items). A GO is valid only for that SHA and window.

## B8. Health monitoring and rollback triggers (ALL PROPOSED: no alarm other than the six in B8-a has been verified to exist)
B8-a. Implemented in code, deployment UNVERIFIED (`observability-stack.ts:65-133`): LambdaErrors >= 1 / 5 min; LambdaThrottles >= 1 / 5 min; Api5xx >= 1 / 5 min; RdsCpuHigh >= 80% x3 periods; RdsFreeStorageLow < 2 GiB; RdsCpuCreditsLow < 20 x3. The SNS topic has no subscriber in code.
B8-b. Proposed additions (new code/CDK, owner approval): 
| Signal | Source | Threshold (proposed) | Action |
|---|---|---|---|
| API 5xx rate | API Gateway `5xx` / `Count` | > 1% of requests over 5 min, or any 5xx on the first 30 min after cutover | investigate; > 5% for 10 min = rollback |
| Lambda errors | `Errors` | >= 3 in 5 min (current alarm fires at 1) | rollback if sustained 15 min |
| Auth failures | API Gateway 401/403 `4xx` rate and `authorizerError` in access log | > 10 per 5 min per environment above baseline | check Cognito/pool change; not itself a rollback trigger |
| Latency | `IntegrationLatency`/`Latency` p95 | p95 > 3 s for 10 min (cold start allowance) | investigate; > 5 s sustained = rollback |
| Lambda throttles | `Throttles` | any (account limit 10) | request quota increase; rollback if user-visible |
| DB connections | RDS `DatabaseConnections` | > 70% of `max_connections` (not known; read it) | investigate pool; restart not allowed without approval |
| DB health | RDS CPU, free storage, `ReadLatency/WriteLatency` | existing + latency > 50 ms for 15 min | investigate |
| Sweep job | `ComplianceSweep` invocations/errors | any error, or no invocation in 30 min | disable rule (`aws events disable-rule`, YELLOW) |
| Data integrity | after release: counts of `service_visits`, `visit_corrections`, `audit_events` unchanged for old data; `enforcement_active_from` unchanged | any change | stop; rollback |
| Business checks | smoke set S every hour for the first day | any fail | rollback |
Call rollback when: Phase C/D sign-offs invalid for the deployed SHA, wrong-money/hours/access/data defect (Blocker), a smoke fail that persists after one retry, or an 5xx/latency trigger above. The owner decides; the Operator executes B4.
Incident owner, deputy and contact path: **NOT FOUND**; must be named before any real-customer pilot (security row I5).

## B9. Controlled pilot launch and support plan
| Stage | Entry criteria | Exit criteria | Gate |
|---|---|---|---|
| P0 TEST validation (synthetic) | B1-B3 done; Phase C PASS | B5 complete, Phase D sign-offs; 0 Blocker, no unwaived Major | GATE 6 |
| P1 Synthetic-data pilot on production stack (optional) | B6, B7 steps 1-8 done on `Ogevia-prd-*`; banner shows production environment; clearly synthetic client only; no real caregiver data | one week without a rollback trigger; synthetic records voided via supported path; owner sign-off | GATE 8 |
| P2 Real-customer pilot (SoCal Care Services first) | P1 exit **and** all Critical rows of `SECURITY_PRIVACY_EVIDENCE.md` closed or formally accepted in writing: AWS BAA copy held, risk analysis, breach/incident procedure, named incident owner, alarm subscriber confirmed, RDS settings verified live, restore drill at current schema, third-party BAAs resolved (Netlify/Supabase/email/SMS) or confirmed not to touch PHI, agency BAA executed, offboarding procedure, retention decision recorded; caregiver device policy signed; real-device phone test done | 30 days: no Blocker; no 5xx trigger; audit and billing review reconciled by a person; owner GO to widen | GATE 10 |
Support roles (PROPOSED; names are NOT FOUND in the repository): **Owner** decisions, GO/NO-GO, Security Official; **Operator** deployments, snapshots, rollbacks, live checks; **Incident owner** + **deputy** (alarm recipient, breach decision clock); **Agency office lead** first-line support for caregivers; **Engineering (Claude Code)** prepares fixes, cannot touch AWS.
Communication (PROPOSED): written change notice to each tester/agency before every deployment (what changes by role, window, rollback contact); status message at start and end of window; incident message path owned by the incident owner; daily 15-minute check during the first week; defects logged with steps and screen only, never PHI; testers do not fix defects (process section 7). Outage fallback: continuity pack and outage visit records (migrations 0027/0028) require each agency to hold a current pack and blank numbered forms (`docs/aws/CONTINUITY_AND_RECOVERY.md:46-67`).

## B10. Approval gates summary
| Gate | Decision | By |
|---|---|---|
| 1 | RC SHA, scope and TEST window | Owner |
| 2 | Push branch (no merge) so CI can run on the RC | Owner |
| 3 | TEST command list and `OGEVIA_DEPLOY_APPROVAL` reference | Owner |
| 4 | Deploy `Ogevia-prod-NetworkEgress` (shared with production) | Owner |
| 5 | Rollback rehearsal on TEST | Owner |
| 6 | Phase D sign-offs (four roles) | Owner + testers |
| 7 | Backup/restore evidence accepted | Owner |
| 8 | Production GO for SHA + window | Owner |
| 9 | Any restore to a new instance or deletion of the scratch instance | Owner |
| 10 | DNS, custom domain/TLS, enforcement activation, real data (BAA/security items) | Owner (+ Legal) |
Every YELLOW action also needs the Operator's own typed confirmation in the existing scripts. Claude Code cannot perform any of them (no AWS access).

## B11. Implemented vs proposed
| Implemented in the repository (not deployed-verified) | Proposed (this document) |
|---|---|
| Migrations 0001-0081 and down scripts; runner, verify, rollback scripts; operator scripts `deploy-test-slice.sh`, `deploy-production.sh`, `ledger-check-*`, `pilot_regression.py`; CDK stacks for both envs; six alarms; client-documents IAM/endpoint fix (local only); CI workflow (never run on this SHA) | Release SHA freeze; CI run on the SHA; TEST command list in B3; commit stamping; extra alarms and thresholds; alarm subscriber; rollback rehearsal; scratch-restore drill; production path in B7; pilot stages and support roles in B9 |
