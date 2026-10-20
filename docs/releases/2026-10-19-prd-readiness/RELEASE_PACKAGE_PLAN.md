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
