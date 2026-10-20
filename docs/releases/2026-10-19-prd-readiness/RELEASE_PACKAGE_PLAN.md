# Production release package: plan and stage A (discovery)

Written 2026-10-20. **Preparation only. Nothing here deploys anything, and the owner has not authorised a production deployment.** Production is owner-confirmed to hold synthetic data only and to serve no real customers (`PRODUCTION_READINESS_PLAN.md` section 29), so a release is an upgrade of a pre-launch environment; the process gates in `docs/TESTING_AND_RELEASE_PROCESS.md` still apply.

## 1. What the release has to do
Bring the production environment from what it runs today (database at 46/0046; Lambda built on or before 2026-10-10; web of unknown version) to the accepted TEST release (code e80b770, migrations through 0085). The database part is rehearsed (`REHEARSAL_PLAN.md`). What remains is the application layer and the process.

## 2. Stages (each ends at an owner gate; later stages are written from the facts of the earlier ones)
| Stage | Content | AWS effect | Status |
|---|---|---|---|
| A. Discovery | Capture what production runs (live templates of `Ogevia-prd-*` and the shared `Ogevia-prod-NetworkEgress`, Lambda build and code zip, previous code asset, web bucket and what the served bundle says, route count, endpoint policy, RDS, snapshots); report how live differs from the release templates | **Reads only** (plus downloads) | **Built and tested locally** (this document, package `ogevia-prd-release-discovery`); not yet run |
| B. Gate and guard | An expected-only gate for `Ogevia-prd-*` (and NetworkEgress if it differs), written from the stage A report; pin check for the release; a deploy guard that can only target the `Ogevia-prd-*` stacks and requires a typed phrase | none until used | Not started; needs the stage A report |
| C. Window | Fresh named snapshot of the current state; pre-checks (no open visit, no shift in the window, ledger exactly 46/0046, no drift); notice to the owner's test accounts | one snapshot | Not started |
| D. Execute | Migrations 0047-0085 (rehearsed psql steps, through the temporary access window used for the ledger read), then API deploy, then web publish, back to back; smoke | production changes | Not started; needs the owner's explicit GO |
| E. Verify and record | Served bundle carries the release version and the production API host (direct byte hash, not the shell-variable hash that gave the false FAIL in the TEST run); ledger 85/0085; sweep log via the function's own log group (`LoggingConfig.LogGroup`); deployed record | reads | Not started |
Recovery sources the stages rely on: the Lambda's previous code asset and the downloaded zip (stage A), the whole web bucket (stage A), the rollback runner for the database (before real data exists; otherwise fix forward or restore the stage C snapshot to a new instance), and the rehearsed order: migrate, API, web without pause.

## 3. Stage A package
`docs/releases/2026-10-19-prd-readiness/release/` (build: `bash release/build-package.sh <dir>`; output `ogevia-prd-release-discovery.tar.gz`, reproducible, with `MANIFEST.sha256`, `BUILD_INFO.json`, `ASSETS.txt` and six release templates synthesized with `cdk synth -c env=prd` and `-c env=prod` for the shared NetworkEgress).
Scripts: `p0-baseline-capture.sh` (read-only), `p1-diff-report.sh` and `tpl_diff.py` (local files; a report, not a gate; ignores CDK metadata, resource metadata, the bootstrap parameter and the value of the `ogevia:deployment-status` tag).
Tests (`infra/aws/db/test/prd-release-discovery.db.test.ts`, mock aws, 8 tests passing): the package manifest and pins; a production-shaped capture with only read verbs and no environment-variable values stored except DB_NAME and OGEVIA_ENV; refusal when the Lambda serves another database, the downloaded zip does not match the live hash, the previous asset is missing, a stack is unsettled, or the web calls another API; the diff report shows no difference when live equals release, ignores the approval tag and metadata, and lists a changed Lambda code asset, a changed distribution property and a removed resource with counts.
Defects of the TEST run corrected here: the API-host search keeps the API id (the earlier pattern dropped it) and the web page is compared by direct byte hash.

## 4. What the release templates already show (from the synthesized files, not from production)
- The release Handler code asset is `eab95a80...zip` and the Identity asset `7c5f8eb6...zip` (the same builds as TEST). The production Lambda's current asset key is unknown until p0 runs.
- The release API has 228 routes.
- The `Ogevia-prd-WebHosting` template defines its own Cognito app client (logical id `TestSliceAppClient`, plus `TestSliceManagedLogin`) and exports it; the user pool itself is the single pool in the account. Whether the live production web uses a client separate from TEST's is NOT established; p0/p1 will show the live resource.
- `Ogevia-prod-NetworkEgress` is owned by the TEST environment's stack set and is shared; the TEST run showed no difference for it, and p1 will show whether the live copy equals the release template.

## 5. Not verified
Every script was tested against a mocked aws only; none has run against AWS. The stage B-E scripts do not exist yet. Stage A cannot show the compatibility gap (35 dropped functions, including the caregiver start and confirm functions in 0050) in operation.

## 6. Next
The owner runs stage A in CloudShell (read-only) and pastes the output. Stage B is written from it.

## 7. Stage A result, part 1: p1 diff report (OWNER-PASTED RAW OUTPUT, 2026-10-20 04:03Z)
`p1-diff-report.sh` compared the captured live templates with the release templates (package built from `7cbf61a`):
| Stack | Live resources | Release resources | Result |
|---|---|---|---|
| Ogevia-prd-DatabaseSecret | 1 | 1 | **equals the release template** |
| Ogevia-prd-EvidenceStorage | 6 | 6 | **equals** |
| Ogevia-prd-WebHosting | 10 | 10 | **equals** |
| Ogevia-prd-Observability | 8 | 8 | **equals** |
| Ogevia-prod-NetworkEgress (shared) | 5 | 5 | **equals** (the client-documents endpoint entries are already live) |
| Ogevia-prd-ServiceVerificationApi | 176 | 244 | **differs:** 68 resources added, 0 removed, 31 changed properties, 0 section changes (99 difference lines in total) |
The 25 lines shown are all `RESOURCE-ADDED AWS::ApiGatewayV2::Route ...` (for example `/v1/accounts`, `/v1/action-issues`, `/v1/appearance`, `/v1/attention-overview`, `/v1/client-document-types`, `/v1/exports`, `/v1/notifications`); the remaining 43 added resources and the 31 changed properties were not pasted.
**What this tells us.** Five of the six stacks need no deployment. The release changes ONE stack, `Ogevia-prd-ServiceVerificationApi`: new API routes (the release has 228; 68 more than live, so live has about 160, consistent with a build from before the TEST releases) and 31 changed properties (expected: the Handler's code asset key, the Handler's managed policy, and similar; not yet seen). The web stack and the shared network stack are unchanged. The web CONTENT in the bucket is separate from the CloudFormation template and must still be published.
**Not yet seen:** part 2, the `p0-baseline-capture.sh` output (the Lambda's current build and asset key, the web's version string and API host, the live route count, snapshots, MFA, bucket protections). The paste began after the end of p0 (`BASELINE CAPTURED ... Nothing was changed in AWS.`), which indicates p0 finished without a failed check, but its facts have not been seen.
Needed to write stage B: the 31 `CHANGED` lines (`grep ^CHANGED ~/ogevia-prd-before/diff-Ogevia-prd-ServiceVerificationApi.txt`) and the p0 output (`cat ~/ogevia-prd-before/log.txt`).

## 8. Stage A result, part 2: the 31 changed properties and the p0 facts (OWNER-PASTED RAW OUTPUT, 2026-10-20)
### The 31 CHANGED lines, decoded (all in `Ogevia-prd-ServiceVerificationApi`)
| Change | Detail |
|---|---|
| Handler Lambda code | asset key `4832b6ba4f8ff1b8706697326b0d76d3d96d5031265c0d6024ee10c1e194817c.zip` -> `eab95a809b3b95b7479cfe6a572e1be0ea068ef6f12751419669443397fe7eda.zip` |
| Identity Lambda code | `e345075a65c98ef8fae929be46fb48be5c3c268702af0f409df509fb3634791b.zip` -> `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip` |
| Identity Lambda and role descriptions | wording only ("caregiver invitations: Cognito AdminCreateUser/AdminGetUser only" -> "identity: create/get/disable/enable of sign-ins on one pool"; role text likewise) |
| Handler managed policy | **one statement is ADDED**, `ClientDocumentObjects`: `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject` on `arn:aws:s3:::ogevia-prd-signature-evidence-300094796789-us-west-2/*/client-documents/*/*` only. The other 22 CHANGED lines on this policy are the later statements shifting down one position (AgencyLogoObjects, EvidenceKeyForSignatureObjects, InvokeIdentityAdmin); their content is unchanged. |
| Identity managed policy | **one statement is ADDED**, `SwitchSignInsOnOff`: Allow `cognito-idp:AdminDisableUser` and `cognito-idp:AdminEnableUser` on `arn:aws:cognito-idp:us-west-2:300094796789:userpool/us-west-2_849AYz5J7` (the single user pool in the account, shared with TEST) |
Count check: 1 (handler asset) + 22 (handler policy) + 2 (identity asset, description) + 5 (identity policy statement) + 1 (role description) = 31.
**Two IAM permissions are added.** CDK classes both as broadening and will ask for approval at deploy (`CLAUDE.md` s.13: changing IAM policies is a YELLOW action). The same release change is already live in TEST.
### Added resources: 68, not all seen
Live has 162 routes (p0, counted from the API itself) and the release has 228: that is 66 more routes, but 68 resources are added, so **two added resources are not routes**. Strongest candidate (INFERRED, not seen): the `ComplianceSweep` EventBridge rule and its Lambda invoke permission, because p0 found exactly one `ComplianceSweep` rule in the account and it belongs to the TEST stack (`Ogevia-prod-ServiceVerifica-ComplianceSweep51D1109D-oAlBozy5Hiaa`, ENABLED); production has none today. Needed: `grep '^RESOURCE' diff-Ogevia-prd-ServiceVerificationApi.txt | grep -v 'ApiGatewayV2::Route'`.
### p0 facts (raw, from `grep` of the log; the grep did not show the PASS lines, but it included FAIL and STOP and none appeared, and `BASELINE CAPTURED` was printed, which requires zero failures)
| Fact | Value |
|---|---|
| Production Lambda | `Ogevia-prd-ServiceVerificationApi-Handler886CB40B-KQ2l1HsdGkhR`, CodeSha256 `ffiawXVEQlhnBniTJouSjqgvvux5QrjsNSSyDIIuEpc=`, last modified 2026-10-10T06:11:29Z, nodejs24.x; live code asset key `4832b6ba...817c.zip` (from the diff) |
| p0 checks that passed (no FAIL) | Lambda serves `ogevia_prd` with `OGEVIA_ENV=prd`; the downloaded code zip equals the live hash; the previous code asset exists in the asset bucket; every stack settled |
| Production web | `https://d3l4psdkokkvnb.cloudfront.net`; served `index.html` equals the bucket's (direct byte hash); main bundle `assets/index-DewFCiEF.js`; **no version string** (an older build); environment `production`; the only API host in the bundle is `zk527zk4ua.execute-api.us-west-2.amazonaws.com`, the production API |
| API routes | 162 live; the release has 228 |
| Shared S3 endpoint | `vpce-091d94b7ec23278e7`: 4 entries for the TEST bucket, 4 for the production bucket, 2 client-documents entries (matches the release NetworkEgress, as p1 showed) |
| RDS | available, private, encrypted; 12 manual snapshots (newest: the rehearsal snapshot) |
| Cognito | pool `us-west-2_849AYz5J7`, MFA ON |
| Evidence and web buckets | all four `ogevia-prd-*` buckets: versioning Enabled, public-access block on |
### What this closes and opens
- B1 narrowed: the web DOES call the production API (answers the question open since 2026-10-10); the production Lambda's build is identified by its asset key (the commit is still not known); the web is an older build without a version string.
- The release is: one stack deployment (the API stack: new routes, two new code assets, two added IAM statements, probably the ComplianceSweep rule), a web content publish, and migrations 0047-0085. No other stack changes.
- Stage B gate allow-list (written from this): exactly the Handler and Identity asset changes, the two description changes, the two added statements (nothing else in either policy), added `AWS::ApiGatewayV2::Route` resources only (68 minus the non-route ones), and the non-route additions once seen; no removal, no replacement, no change to any other stack.

## 9. The two non-route additions (OWNER-PASTED RAW OUTPUT, 2026-10-20)
`RESOURCE-ADDED AWS::Events::Rule ComplianceSweep51D1109D` and `RESOURCE-ADDED AWS::Lambda::Permission ComplianceSweepAllowEventRuleOgeviaprdServiceVerificationApiHandlerB5423A9EE440EE04`. VERIFIED: the 68 added resources are 66 routes plus the ComplianceSweep rule and its invoke permission. Production has no ComplianceSweep schedule today; the release creates one (every 15 minutes, enabled; a no-op while no agency has enforcement activated, as on TEST).

## 10. Stage B built (2026-10-20; local only, mock-tested)
Package `ogevia-prd-release` (stages A+B). New: `prd_gate.py` (expected-only gate for the API stack, pinned from the baseline: live keys `4832b6ba...` and `e345075a...`, release keys `eab95a80...` and `7c5f8eb6...`, 66 routes, the two statements, the sweep pair), `p2-gate.sh` (fresh re-read; production must equal the p0 baseline; the other five stacks must equal the release; then the API gate), `prd_assembly_check.py` (a deploy-mode synthesis must equal the release templates apart from the approval tag, hold exactly the five `Ogevia-prd-*` stacks and the two asset directories), `deploy-guard-prd.sh` (check/deploy/post for the one stack).
Tests: `infra/aws/db/test/prd-release-discovery.db.test.ts`, 30 passing, with a mocked aws and a model of the baseline state derived from the release template (176 live resources, 244 release, 68 added, 5 changed, as the real report showed). They cover: the gate passes the baseline state and refuses an unrelated changed resource, an unpinned live asset, a changed Lambda environment, a removed resource, a production that already equals the release, a wider or extra IAM statement, a widened identity permission, a changed existing statement, a disabled sweep rule, a route count that is not 66, a public route (unless named), a missing authorizer and an unknown integration; the p2 gate passes the baseline and stops on production changes after the baseline, another stack differing, or a non-baseline API stack; the guard accepts only the API stack, passes the check with and without an assembly and fails on an extra stack, a missing asset or a modified template; deploy refuses without the approval reference, an assembly, the pinned CDK version, a correctly named recent verified encrypted snapshot, or the 85|0085 migration marker, needs the typed phrase and runs exactly one `cdk deploy --app <assembly> --exclusively Ogevia-prd-ServiceVerificationApi --require-approval broadening --no-notices`; post passes only when the live template equals the release and the Lambda, the route count (228) and the sweep rule check out.
Pinned facts that are the owner's to confirm: the approval reference (the `approval_ref` mismatch from the TEST release is still unresolved) and whether any public route may be added.
NOT built (needed before any deployment): the window stage (fresh `pre-prdrelease` snapshot, pre-checks, access window for the database), the migration step for the production database (the rehearsed psql steps adapted to `ogevia_prd`, writing `db-at-0085.ok`), the deploy-mode assembly and pinned CDK CLI for CloudShell, the web publish, the fixed web verification, the sweep log check through the function's own log group, and the deployed-record script. No script in this package has run against AWS other than stage A's reads.

## 11. First real run of the stage B gate (OWNER-PASTED RAW OUTPUT, 2026-10-20 04:36Z)
Package `ogevia-prd-release` (sha256 `c19d1777...cd7a`): `p0-baseline-capture.sh` again, then `p2-gate.sh`.
**p2 result: `GATE PASSED: only Ogevia-prd-ServiceVerificationApi changes, and only by the release's expected change. Nothing was deployed.`**
- Production was UNCHANGED since the baseline: all six stacks reported "is unchanged since the p0 baseline".
- Five stacks (`DatabaseSecret`, `EvidenceStorage`, `WebHosting`, `Observability` and the shared `Ogevia-prod-NetworkEgress`) equal the release templates: nothing to deploy.
- The API stack: `resources: live 176, release 244; added 68 (66 routes, 2 other); removed 0; changed 5 (Handler886CB40B, HandlerPolicy7544C855, IdentityHandler6F0A3417, IdentityPolicyF3EE534F, IdentityRole07BDF020)`, then `ALLOWED the release's code assets, descriptions, 2 added IAM statements, the ComplianceSweep rule and permission, and 66 JWT-authorized routes` and `EXPECTED-ONLY: YES`. The live asset keys matched the pinned ones (the gate checks them), no public route is among the 66 added (the gate prints a line and fails if one is), every added route has the existing JWT authorizer and an existing integration, and the two added IAM statements are exactly the expected ones.
**p0 facts newly seen in this run:** the previous Lambda code asset `s3://cdk-hnb659fds-assets-300094796789-us-west-2/4832b6ba...817c.zip` exists (250,362 bytes), so the quick API rollback works; the downloaded code zip equals the live CodeSha256 (`ffiawXVE...`), a second recovery copy; the identity function's CodeSha256 is `aA/+A8uX...`; the production web bucket was downloaded (63 files) and the served `index.html` (sha256 `300b1448...9811`) equals the bucket's; `config.json` returns HTTP 403 (not served, so the web has no runtime config file); RDS is available, private, encrypted, restorable up to 2026-10-20T04:32Z, 7-day backups, deletion protection on; 12 manual snapshots; the production secret's last change is 2026-10-10 06:00Z (rotation not enabled); the only ComplianceSweep rule in the account is the TEST one.
**What this establishes:** the release's production difference is fully understood and bounded: one stack, five resources changed, 68 added (66 routes + the sweep rule and permission), nothing removed. The deployment, when authorised, can be held to exactly that.
**What it does not establish:** that the deploy mechanics work (no deploy-mode assembly, CDK CLI install, migration step or web publish exists yet), or that the compatibility gap is short.

## 12. Execution stages built (2026-10-20; implemented and tested locally; NOT run against AWS)
Owner instruction: build and test blockers #1, #3, #4 only; no deployment, no production migration, no AWS change, no snapshot created. Package `ogevia-prd-release.tar.gz` (sha256 `a6bd061340764c25a5aa987c78081d6f730182535a6c8c81082714593fe3d42d`, built twice with the same hash, built from commit `af70a8b1855fb9bed59060defb268205fd259c7e`, clean tree, 114 files in `MANIFEST.sha256`).
| Item | Files | Tests | Remaining manual action |
|---|---|---|---|
| C1 fresh snapshot (create/verify) | `release/scripts/c1-snapshot-prd.sh` | 2 tests (window, approval, phrase, exactly one create call, six rejection cases) | owner GO, typed `SNAPSHOT-NOW`; retention decision |
| D1 migration executor (+rollback, restore-only) | `d1-migrate-prd.sh`, `window.sh`, `fp-compare.py`, `sql/`, `migrations/` (39), `rollback/` (39), `verification/` (8), `data/` | 9 tests, real PostgreSQL 16: pins, snapshot, gate, DRIFT stop, lock-induced failure, full 46 to 85 (39 files, 8/8 verification, data unchanged, SG identical), rollback to 46/0046 with two phrases, exit 3 + `--restore-only`, verb allow-list | owner GO; typed `OPEN-5432-WINDOW-MIGRATE-PRD` |
| D2 deploy-mode assembly | `d2-assemble-prd.sh`, `prd_assembly_check.py --approval`, `lib.sh operator_pkg_ok` | 3 tests (fake cdk) + REAL `cdk synth -c env=prd -c mode=deploy` checked against the real release templates | install dependencies in CloudShell; assembly hashes must reproduce there (checked at run time) |
| D3 web build / publish / verify / rollback | `d3-web-prd.sh` | 7 tests (fake vite, mock S3/CloudFront) + a REAL `vite build` showing `VITE_APP_VERSION:"<commit>"` embedded | owner GO; typed `PUBLISH-WEB-Ogevia-prd` |
| E1 deployed record | `e1-record-deployed-prd.sh` | 1 test (7 failure cases) | none |
| Guard `post` writes `api-at-release.ok` (web publish requires it) | `deploy-guard-prd.sh` | existing guard tests + D3 | none |
Gates run: `pnpm lint` rc 0, `pnpm typecheck` rc 0, `pnpm test` rc 0 (auth 139, shared 118, ui 73, sv-api 74, web 1219 unit tests); db suites: `prd-release-exec` 25/25, `prd-release-discovery` + `prd-rehearsal` 44/44. `pnpm build` was not rerun (no application code changed). The whole API/database `test:db` suites were not rerun for this change (no application or migration code changed).
**Defects found by testing and fixed:** (1) the deploy-mode tag value is `approved-<REF>`, not `<REF>` (found by a real synth; the first check would have blocked the release); (2) the operator-package check did not detect a stray file; (3) a publish could have replaced a site that changed since the recovery capture: it now refuses.
