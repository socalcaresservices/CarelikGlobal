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
