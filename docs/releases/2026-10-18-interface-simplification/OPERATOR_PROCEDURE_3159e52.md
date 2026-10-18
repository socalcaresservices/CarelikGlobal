# Ogevia TEST deployment: operator procedure for release candidate 3159e520 (final)

> **SUPERSEDES** every earlier runbook for this release: section 8 and sections 6 to 10 of `RELEASE_CANDIDATE_CLOSURE.md` as committed in the candidate, and the earlier attachment `OGEVIA_TEST_DEPLOYMENT_RUNBOOK_3159e52.md`. Where they differ, this document governs.
>
> **Status: PROPOSED. NOTHING IN THIS DOCUMENT HAS BEEN RUN AGAINST AWS.** Every step marked **[YELLOW]** changes AWS or TEST data and is run only after the owner's explicit GO (`CLAUDE.md` section 13). TEST only, synthetic data only. Production (`Ogevia-prd-*`, database `ogevia_prd`) is never touched. No push, merge, deployment, migration window or enforcement activation has been authorized by this document.
>
> **Revision 3 (2026-10-18):** adds `SNAPSHOT_RESTORE_ISOLATED_3159e52.md`, a documented isolated snapshot-restore procedure for `ogevia_sv_test` that protects `ogevia_prd` (new instance, own security group, one-database dump and swap). Its SQL steps are rehearsed locally on PostgreSQL 16 (`snapshot-restore-local-rehearsal.sh`); every AWS step is **not run and not verified**, there is no reviewed window script for it, and it is **not a proven recovery procedure**. Tier 1 remains the only prepared and rehearsed database recovery.
>
> **Revision 2 (2026-10-18):** (1) migrate mode now also requires a named, available pre-deployment snapshot that belongs to `ogevia-prod-postgres` and was captured inside the owner-approved release window, validated before any access is proposed or opened; (2) `AWS_REGION`, `AWS_DEFAULT_REGION` and `AWS_PAGER` are exported explicitly in section 5, and no command relies on an unexported `REGION` variable.
>
> Labels used throughout: **LOCAL VERIFIED** = executed in the development container on 2026-10-18. **NOT VERIFIED** = needs AWS, a real device or another external system.

## 1. What is being deployed, and the pins

| Item | Pin |
|---|---|
| CI-tested release candidate | `3159e520a7b9bc7006ee82d526a907622d30d97c` (PR 100, CI run 361: `validate`, `postgres` (postgres:18 image), `harness` all success; GitHub's generated merge commit `7acb0bed…` has the identical tree `a91dacdb…`) |
| Operator commit (what the operator checks out) | **`<OPERATOR_SHA>`** = the candidate plus added files only (scripts, tests, documents). Its full SHA is in the covering message and in `SHA256SUMS`. It must be pushed to a new branch `claude/ogevia-operator-3159e52` first (needs the owner's authorization; not done) |
| Proof the operator commit has the candidate's application | `infra/aws/slice/candidate-pins.txt`: 13 git object ids (`apps/web`, `apps/sv-api/src`, `packages`, `infra/aws/lib`, `infra/aws/bin`, `infra/aws/db`, `infra/aws/scripts`, lockfile, package manifests). `candidate-pin-check.sh` compares each with `git rev-parse HEAD:<path>`. Independent check: `git rev-parse 3159e520a7b9bc7006ee82d526a907622d30d97c:<path>` returns the same ids |
| Baseline deployed on TEST today (API) | `d82fefcd37407d837e7c94f6ac57a907ea286ed1`. Source: the owner's recorded Phase C statement for Release 0052 (PR 98, 2026-10-14): migrations 0037-0052 and `Ogevia-prod-ServiceVerificationApi` from that commit; `PR 99` records TEST's API as the 169 routes of `main` and the ledger as `52|0052`. Operator-reported, not read from AWS by me |
| Baseline web on TEST today | **UNKNOWN which build.** PR 99 (open, 2026-10-16) says TEST still ran the web published 2026-10-05 and that its own release (baseline web) was prepared, not authorized. Whether it was run since is not recorded. The recovery artifact for the web is therefore the operator's own capture in step 4, not a commit |
| Migration set (0001-0077) | `sha256sum -- *.sql \| sha256sum` in `infra/aws/db/migrations` = `90785eaa779a0be2fc46aa7c251294c102b83d0d240b693ea9fb0d5fffc9a335` |
| Rollback set (0053-0077) | `sha256sum -- 00[5-7][0-9]_*.down.sql \| awk '$2 >= "0053"' \| sha256sum` in `infra/aws/db/rollback` = `b03302eac1c02d29f19bbbdb2f71a13b15e22ce9b9cb6395b3e92b089eac55bd` (25 files) |
| Lockfile | `pnpm-lock.yaml` sha256 `7f5964021b4dbeeebf703fda27e1a509c164c1aecb4436f9324003b7de88dcae` |
| Toolchain (what the tests and CI ran on) | Node 22.x (22.22.0 here), pnpm 9.15.4, CDK CLI 2.1143.0 (from the checkout), Python 3, PostgreSQL client 15 or newer, AWS Session Manager plugin, `jq`, `git`, `timeout` |
| Handler code asset, baseline `d82fefc` | `2fcda02d87dfb6eb35aefa22a88b95cc36675c526cb696094a87b9d1e17b125c.zip` (two local syntheses of the baseline gave identical keys) |
| Handler code asset, candidate | `929cdb1bde9bbf18025dc36f5cc61210246ca048efa6d6b51147cf4c22b24ab0.zip` |
| IdentityHandler code asset (unchanged by this release) | `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip` |
| Ledger check script (reviewed, v3) | `infra/aws/slice/ledger-check-temp-access.sh` sha256 `f96c06f2c4f20d4c85871baad84cdc8726fb2183e138cd1ac7cd6d15bef85f6f` (commit `4881611c`); the earlier TEST read used exactly this file |

Script checksums (all in the operator commit; each also listed in `SHA256SUMS`):
```
97b1ed095139af5bb3fee4b6866a43e2a561aafbba6aaa8abf3eea1349ccd6c8  infra/aws/slice/candidate-migrate-test.sh
d0a06d6d4e63d705d649c406d8cfb56007da5b36336a717fc12826db69c5175a  infra/aws/slice/candidate-pin-check.sh
e5f540f97fa66477014321403f5414fd86647d3027cb05d585aef060ca1f342c  infra/aws/slice/candidate-pins.txt
1bb7d612c4ed0ea7e5c8e5c0a6083f93d0c7bb25f316e35981f6eac4e85bbdfc  infra/aws/slice/candidate_assembly_check.py
71680ddf0930fef71d30b97dba84ee098f2d18899c2425db29d46ad43e1126d9  infra/aws/slice/lambda-policy-check-readonly.sh
70f320ea3dde2aeb5cb9faabd955a1a3eaa6d33a8e767765314bad886374e9f3  infra/aws/slice/lambda_policy_check.py
```
(If `candidate-migrate-test.sh` is edited after this list was written, `SHA256SUMS` in the covering message is the authoritative list.)

## 2. Corrections to earlier statements (stale text withdrawn)

| Earlier statement | Where | Correction |
|---|---|---|
| "CI has not run on the candidate" / "CI `postgres` job … still have not run this candidate" / PR 100 body "had not yet run" | closure checklist (in the candidate and the first attachment), runbook v1 sections E and I, PR 100 description | CI **has** run: run 361 on 2026-10-18, `validate`, `postgres` (postgres:18) and `harness` success on the candidate head. The "has not run" wording was true only when PR 100 was opened. The PR description still carries that sentence and cannot be edited without authorization; this line supersedes it |
| TEST ledger "owner-reported 2026-10-16, not verified" | first closure checklist, blocker 3 | The 2026-10-17T16:29:27Z run of `ledger-check-temp-access.sh test --host-ip` (script `f96c06f2…`, database `ogevia_sv_test`, `read_only=on`) reported 52 migrations, latest 0052, none at 0053 or higher, cleanup RESTORED. Operator-supplied evidence, valid at that time; **recheck is still required before migrating** (step 5) |
| "`cdk synth` writes `cdk.out`; deploy with `--app cdk.out`" | runbook v1, step 0 | **Wrong for a plain checkout.** `infra/aws/cdk.out` is tracked in git and holds stale `Ogevia-prd-*` (production-candidate) templates. A plain `cdk synth` also modifies tracked files. All commands below write the assembly outside the repository (`-o ~/ogevia-rc-cdk.out`) and never deploy from the tracked `cdk.out` |
| "Roll back to the pinned `origin/main` commit" | runbook v1, recovery | `origin/main` moves. The rollback target is the immutable SHA `d82fefcd37407d837e7c94f6ac57a907ea286ed1`, plus the captured live artifacts (section 8) |
| "Lambda resource-policy size risk not resolved" | runbook v1 | Resolved: section 7 (the check validates size and principals) |
| "ComplianceSweep may be enabled or disabled" (undefined) | runbook v1 | Defined in section 9: deployed **ENABLED**, verified a no-op while enforcement is off |
| "No reviewed method for the migration database window" | runbook v1, section G | A wrapper using the reviewed `--host-ip` /32 approach is prepared and rehearsed (section 6); it still needs the owner's approval to run |
| CI bundle `ogevia-test-deployment-bundle` as a deployment source | implied | Not used as the source: its web is built with `VITE_APP_ENV=production` (no TEST banner) and its `finish.sh` deploys all five stacks (section 4) |

## 3. Evidence summary

| | LOCAL VERIFIED | NOT VERIFIED |
|---|---|---|
| Candidate | CI run 361 success on the candidate head; local suites on PostgreSQL 16 and 18.4 (database 840, sv-api database 115, 369 verification checks) | the managed RDS engine; the real TEST account |
| Migration wrapper | 86 rehearsal tests against fake AWS/psql/npx: pins, host IP, wrong database, ledger precondition, success, migration failure, interruption, failed verification, failed revoke (exit 3 and recovery), resume, rollback success, rollback failure, rollback interruption, activation state, **snapshot validation in both modes (19 refusals each: no id, wrong pattern, missing, not available, other instance, not manual, created outside the release window or in the future, name stamp outside the window, missing, malformed or impossible window, window over 12 hours, window not started; migrate refused after the window ended; each refusal opens no access)**, and the region and pager fixed by the script itself (`OPERATOR_REHEARSAL_TRANSCRIPTS.md`). Three deliberate weakenings of the snapshot checks each made tests fail | the real tunnel, secret, runner output and timing in CloudShell |
| The SQL path of recovery | the exact `psql -1 … set local role ogevia_owner; -f down.sql; delete ledger row` command, 0077 down to 0053 then 0053-0077 up again, on a real database: PostgreSQL 16 and 18.4, ledger 52 / 0052 then 77 / 0077, verification 369 PASS | RDS |
| Shared database preserved | two databases in one cluster: rolling one back left the other database's dump and the cluster's roles identical (PostgreSQL 16; `pg_dump` and `pg_dumpall --globals-only`, ignoring pg_dump's random `\restrict` token). `grep` finds no `create/alter/drop role`, extension, database or `alter system` in migrations or rollbacks 0053-0077 | the real `ogevia_prd` |
| Assembly | the candidate's TEST API stack synthesized locally in deploy mode differs from the baseline `d82fefc` by exactly: 59 new routes, 1 new EventBridge rule (State ENABLED), 1 new Lambda permission, the Handler code asset, CDK metadata. No IAM, environment, output or other change. 6 tests on a real synthesis plus mutations | `cdk diff` against the live stack |
| ComplianceSweep | with enforcement off the run selects no agency and writes no row to any table; with an agency's activation it acts for that agency only (2 tests, real database, the real scheduled code) | the rule firing in AWS |
| Lambda policy check | 24 tests (principals, size, both modes, the wrapper with a fake CLI) | the live policy |

## 4. About `deploy-test-slice.sh` and the CI artifact (inspected; `infra/aws/test/deploy-test-slice-scope.test.ts` pins the facts)

`infra/aws/scripts/deploy-test-slice.sh` **does not choose a version**. It runs no `git` command; it takes `REPO` from its own location and builds and deploys whatever checkout it sits in. It therefore can neither check out nor rebuild a different version by itself, but it also does not prove it is deploying the candidate: that proof is `candidate-pin-check.sh`, run in the same command line immediately before.
- Used for this release: only **`web`** (builds `apps/web` from the checkout with `VITE_APP_ENV` from `OGEVIA_APP_ENV`, default `test`; uploads assets, then `index.html`, no `--delete`, no `config.json`; invalidates CloudFront) and **`smoke`** (read-only).
- **Not used:** `infra` (deploys all five TEST stacks), `database` (creates the database and rewrites the application login role), `bootstrap`, `users`, `seed`, `pilot-*`.
- It has no capture and no rollback; section 8 supplies both.

CI artifact `ogevia-test-deployment-bundle` (id 12122743587; digest `sha256:38edea10d6bfba4a5c6edb544352cce381306edfd5afa200c898dc57bdd1b9dd`; created 2026-10-18T02:53:30Z; **expires 2026-10-25T02:53:29Z**; built from the PR merge commit whose tree equals the candidate's): **not the deployment source.** Its web is built with `VITE_APP_ENV=production` (`build-slice-bundle.sh`), which shows no TEST banner, and its `finish.sh` deploys all five stacks. I could not download or open it from the development container (the download host is blocked), so its contents are UNVERIFIED. Suitable use: an independent cross-check. After downloading it, `python3 -B infra/aws/slice/candidate_assembly_check.py --assembly <extracted>/cdk.out` must report `Handler code asset is the candidate's build`; that comparison cannot succeed on a bundle built from other code.

## 5. Prerequisites (before the window)

- Owner GO message naming: the operator, the **release window as UTC start and end** (at most 12 hours; the snapshot must be taken inside it and the migration run inside it), an approval reference `<REF>` (6-64 characters of `A-Za-z0-9._-`), and approving (a) the push of `claude/ogevia-operator-3159e52`, (b) the migration database-access method in section 6, (c) the API deployment including the ComplianceSweep rule in state ENABLED.
- AWS CloudShell, region `us-west-2`, AdministratorAccess session, account `300094796789`. Tools: section 1. **A second CloudShell session open and ready for recovery** (section 8), with `~/CarelikGlobal` fetched as in the earlier procedure.
- Environment variables, set once per session (values are in section 1; `<OPERATOR_SHA>` and `<REF>` come from the GO message). Always set `PYTHONDONTWRITEBYTECODE=1` so Python never writes into the checkout:
```
export AWS_REGION=us-west-2
export AWS_DEFAULT_REGION=us-west-2
export AWS_PAGER=""
export PYTHONDONTWRITEBYTECODE=1
export OGEVIA_EXPECT_COMMIT=<OPERATOR_SHA>
export OGEVIA_EXPECT_MIGRATIONS_SHA=90785eaa779a0be2fc46aa7c251294c102b83d0d240b693ea9fb0d5fffc9a335
export OGEVIA_EXPECT_ROLLBACK_SHA=b03302eac1c02d29f19bbbdb2f71a13b15e22ce9b9cb6395b3e92b089eac55bd
export OGEVIA_EXPECT_LOCKFILE_SHA=7f5964021b4dbeeebf703fda27e1a509c164c1aecb4436f9324003b7de88dcae
export OGEVIA_DEPLOY_APPROVAL=<REF>
export OGEVIA_APP_ENV=test
export OGEVIA_RELEASE_WINDOW_START=<UTC start from the GO message, e.g. 2026-10-19T03:00:00Z>
export OGEVIA_RELEASE_WINDOW_END=<UTC end from the GO message>
```
The three `AWS_*` lines are exported explicitly so that every `aws` command in this procedure runs in `us-west-2` with no pager, whatever the CloudShell session had before; verify with `echo "$AWS_REGION $AWS_DEFAULT_REGION [$AWS_PAGER]"`, which must print `us-west-2 us-west-2 []`. Commands in this procedure that name a region pass the literal `us-west-2`; none uses a shell variable `REGION`. The migration wrapper also fixes these three variables itself, from its own constants, for every call it makes (test-asserted: it overrides a hostile caller environment).

## 6. Procedure

Every command shows its working directory. "Expected" lists the lines that must appear; anything else is a stop (section 10).

### Step 1 - Fetch exactly the operator commit (no change to AWS) 
Working directory `~/CarelikGlobal` (the existing checkout whose `origin` works):
```
cd ~/CarelikGlobal
git fetch origin claude/ogevia-operator-3159e52
git worktree add --detach ~/ogevia-rc "$OGEVIA_EXPECT_COMMIT"
cd ~/ogevia-rc && git rev-parse HEAD
```
Expected: the last line prints `<OPERATOR_SHA>` exactly. (A new worktree leaves the existing checkout untouched. If `git worktree add` refuses because the directory exists, choose a new directory name; never reuse a directory.) Then verify the scripts: `cd ~/ogevia-rc && sha256sum infra/aws/slice/candidate-migrate-test.sh infra/aws/slice/candidate-pin-check.sh infra/aws/slice/candidate-pins.txt infra/aws/slice/candidate_assembly_check.py infra/aws/slice/lambda-policy-check-readonly.sh infra/aws/slice/lambda_policy_check.py infra/aws/slice/ledger-check-temp-access.sh` and compare with `SHA256SUMS` (read the scripts first: about 330, 60, 130 and 100 lines).

### Step 2 - Install and pin check (no change to AWS)
Working directory `~/ogevia-rc`:
```
cd ~/ogevia-rc && pnpm install --frozen-lockfile
cd ~/ogevia-rc && bash infra/aws/slice/candidate-pin-check.sh
```
Expected (13 pins for the paths in `candidate-pins.txt`):
```
PASS commit <OPERATOR_SHA>
PASS working tree clean
PASS migration set sha256 90785eaa779a0be2...
PASS pnpm-lock.yaml sha256 7f5964021b4dbeee...
PASS 13 content pins equal the CI-tested candidate (application, packages, infrastructure, migrations, rollbacks, deploy scripts, lockfile)
PASS node v22.x.y
PASS pnpm 9.15.4
PASS dependencies installed
PASS cdk 2.1143.0 (build ...)
PINS HOLD
```
Optional local gate: `cd ~/ogevia-rc && pnpm lint && pnpm typecheck`.

### Step 3 - Synthesize the candidate outside the repository and check it (no change to AWS)
Working directory `~/ogevia-rc/infra/aws`:
```
cd ~/ogevia-rc/infra/aws
npx cdk synth --quiet --no-notices -c env=prod -c mode=deploy -o ~/ogevia-rc-cdk.out
python3 -B slice/candidate_assembly_check.py --assembly ~/ogevia-rc-cdk.out
```
Expected: 9 `PASS` lines ending `PASS all checks`, including: the five `Ogevia-prod-*` stacks and no `Ogevia-prd-*`; Handler asset `929cdb1bde9b...`; IdentityHandler `7c5f8eb676c9...`; 228 routes; exactly one EventBridge rule whose deployment state is explicitly `ENABLED`; exactly two Lambda permissions; the 61 expected added resources; "everything else equals the baseline d82fefc".
The approval reference is embedded as the tag `ogevia:deployment-status` on taggable resources; the checker ignores that value. After `git -C ~/ogevia-rc status --porcelain` prints nothing (synthesis must not have modified the checkout).

### Step 4 - Read-only baseline and recovery capture (no change to AWS)
Working directory `~/ogevia-rc`. These commands only read; they write files under `~/ogevia-before/` (outside the repository).
```
mkdir -p ~/ogevia-before && cd ~/ogevia-before
API_STACK=Ogevia-prod-ServiceVerificationApi; WEB_STACK=Ogevia-prod-WebHosting
FN=$(aws cloudformation list-stack-resources --stack-name $API_STACK --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId,'Handler')].PhysicalResourceId" --output text); echo "handler: $FN"
aws lambda get-function-configuration --function-name "$FN" --output json > lambda-config-before.json
aws lambda get-function --function-name "$FN" --query 'Code.Location' --output text > code-url.txt
curl -sS -o lambda-code-before.zip "$(cat code-url.txt)" && rm -f code-url.txt
echo "zip sha256 (base64): $(openssl dgst -sha256 -binary lambda-code-before.zip | base64)"; echo "live CodeSha256     : $(jq -r .CodeSha256 lambda-config-before.json)"
aws cloudformation get-template --stack-name $API_STACK --template-stage Original --query TemplateBody --output json > api-template-before.json
BUCKET=$(aws cloudformation describe-stacks --stack-name $WEB_STACK --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)
aws s3 sync "s3://$BUCKET" web-before --only-show-errors && (cd web-before && find . -type f -print0 | sort -z | xargs -0 sha256sum > ../web-before.sha256) && wc -l web-before.sha256
aws events list-rules --query 'Rules[].[Name,State]' --output text | grep -i ComplianceSweep || echo "no ComplianceSweep rule yet (expected before the deployment)"
```
Expected: the two hash lines equal; `api-template-before.json` exists; `web-before.sha256` lists the live site (including `index.html` and `config.json`). **Store `~/ogevia-before/` until the release is accepted.** Then:
```
cd ~/ogevia-rc && python3 -B infra/aws/slice/candidate_assembly_check.py --live-template ~/ogevia-before/api-template-before.json
```
Expected: `PASS LIVE Handler code asset is the baseline d82fefc build (2fcda02d87df...)`, `PASS LIVE template equals the recorded baseline ...`, `PASS all checks`. **If either fails the live stack is not the recorded baseline: STOP.** Do not use `d82fefc` as the rollback target (the script says so); rely on `~/ogevia-before/` and report.

### Step 5 - Ledger recheck (reviewed v3 script; read-only apart from its own temporary /32 window)
This repeats the earlier TEST check (2026-10-17T16:29:27Z, valid at that time) immediately before migrating. Working directory `~/ogevia-rc`:
```
cd ~/ogevia-rc && OGEVIA_EXPECT_HOST_IP=<the admin host's private IP> bash infra/aws/slice/ledger-check-temp-access.sh test --host-ip
```
(Confirm the script checksum from section 1 first; its prompt is `OPEN-5432-WINDOW`.) Expected: `connected: ogevia_sv_test | read_only=on`, `52 migrations applied, latest 0052`, `NO ROW has version >= 0053`, `RESTORED (verified)`, `SECURITY GROUP: restored and verified identical to the original`. Anything else: STOP.

### Step 6 - Pre-deployment Lambda-policy check (read-only)
Working directory `~/ogevia-rc`:
```
cd ~/ogevia-rc && bash infra/aws/slice/lambda-policy-check-readonly.sh pre
```
Expected: `function: <handler> | API id: <id> | rule: none yet | mode: pre`, then `statements: N (API Gateway N, EventBridge 0) | bytes now: <size> | largest statement: <b> | projected peak: <size+2*b+2> | limit 20480 | gate 19000` and `PASS all checks (size and principals)`. The check **fails** on: any principal other than `apigateway.amazonaws.com` or `events.amazonaws.com`; any action other than `lambda:InvokeFunction`; any resource other than this function; an API Gateway statement not limited to this API's ARN; an events statement not limited to the ComplianceSweep rule; `Deny`, `NotPrincipal`, `NotAction`; a size at or above 20,480 bytes; a projected peak (size plus two new statements) at or above 19,000. With the synthesized shape the policy is about 1 KB; the earlier per-route shape (38 statements) projects to about 14 KB. Exit status 0 only if all hold.

### Step 7 - Named pre-deployment snapshot [YELLOW]
The snapshot must be taken **inside the release window** (after `OGEVIA_RELEASE_WINDOW_START`), named exactly `ogevia-prod-postgres-pre-0077-YYYYMMDDHHMM` (the UTC minute), and be `available` before step 9. The migration wrapper refuses, before it proposes or opens any access, unless the snapshot exists, is `available`, belongs to `ogevia-prod-postgres`, is of type `manual`, was **created** inside the release window (not in the future), and its name stamp is inside the window; `migrate` also refuses if the window has ended.
```
date -u +%FT%TZ    # must be at or after $OGEVIA_RELEASE_WINDOW_START and before $OGEVIA_RELEASE_WINDOW_END
export OGEVIA_PREDEPLOY_SNAPSHOT_ID=ogevia-prod-postgres-pre-0077-$(date -u +%Y%m%d%H%M); echo "$OGEVIA_PREDEPLOY_SNAPSHOT_ID" | tee ~/ogevia-before/snapshot-id.txt
aws rds create-db-snapshot --db-instance-identifier ogevia-prod-postgres --db-snapshot-identifier "$OGEVIA_PREDEPLOY_SNAPSHOT_ID"
aws rds wait db-snapshot-available --db-snapshot-identifier "$OGEVIA_PREDEPLOY_SNAPSHOT_ID"
aws rds describe-db-snapshots --db-snapshot-identifier "$OGEVIA_PREDEPLOY_SNAPSHOT_ID" --query 'DBSnapshots[0].[Status,DBInstanceIdentifier,SnapshotType,SnapshotCreateTime]' --output text
```
Expected last line: `available	ogevia-prod-postgres	manual	<a time inside the window>`. **STOP if it is not `available`, or the time is outside the window.** In a new session, set `OGEVIA_PREDEPLOY_SNAPSHOT_ID` again from `~/ogevia-before/snapshot-id.txt`. **The snapshot is a recovery prerequisite, not a recovery procedure.** Restoring from it is not prepared or rehearsed (section 8.5, Tier 2); the instance also holds `ogevia_prd`, so a snapshot is never restored in place.

### Step 8 - Diff against the live stack (read-only)
Working directory `~/ogevia-rc/infra/aws`:
```
cd ~/ogevia-rc/infra/aws && npx cdk diff --app ~/ogevia-rc-cdk.out Ogevia-prod-ServiceVerificationApi --no-notices
```
Expected, and nothing else: `[~]` the Handler's `Code` (`S3Key` `2fcda02d…` to `929cdb1b…`); `[+]` 59 `AWS::ApiGatewayV2::Route`; `[+]` one `AWS::Events::Rule`; `[+]` one `AWS::Lambda::Permission` (principal `events.amazonaws.com`); `[~]` the `ogevia:deployment-status` tag value on taggable resources (it changes to `approved-<REF>`; benign). **STOP on:** any `[-]`, any `(replace)`, a changed Lambda environment, a changed IAM statement, a changed output, an `Ogevia-prd` name, a second Lambda. 

### Step 9 - Migrations [YELLOW]: the migration-access wrapper
**What it is.** `infra/aws/slice/candidate-migrate-test.sh` is the reviewed `ledger-check-temp-access.sh v3 --host-ip` approach with a different job inside the window: one inbound rule on the RDS security group `sg-00530a1f4f7648e65`, tcp 5432, source = the admin host's own private IP as `/32` (never a group, never a range); every AWS and database command bounded by `timeout`; the exact phrase typed to open it; cleanup on every exit path that **verifies a hash of the complete rule set**; a marker file that survives a killed session and blocks the next run; independent recovery commands by rule id. In the window it (1) proves the checkout (commit, clean tree, migration-set hash, host IP), (2) proves the connection is `ogevia_sv_test` and read-only, (3) proves the ledger is exactly 52 / 0052, (4) records how many agencies have enforcement activated, (5) runs the pinned runner `npx tsx db/scripts/migrate.ts` against that one database (one transaction per file), (6) re-reads the ledger (must be 77 / 0077), (7) runs `db/scripts/verify.ts`, (8) proves the activation count is unchanged. It never names, connects to or queries `ogevia_prd`. The runner's own refusal of non-local hosts is not overridden (the tunnel is `127.0.0.1`), so `OGEVIA_ALLOW_REMOTE_MIGRATION` is never set. The RDS master credential stays in memory and is never printed. AWS verbs: describe/list/get, one authorize and one revoke of the single temporary rule, `ssm start-session`, `secretsmanager get-secret-value`.

**Announce the freeze first** (no caregiver pickups or schedule edits on TEST until told; the previous web shows a false "You have the shift" for a pickup made after migration 0063 and before the new web is live). Then, working directory `~/ogevia-rc/infra/aws`:
```
cd ~/ogevia-rc/infra/aws && date -u +%FT%TZ | tee ~/ogevia-before/M0.txt
cd ~/ogevia-rc/infra/aws && OGEVIA_EXPECT_HOST_IP=<the admin host's private IP> bash slice/candidate-migrate-test.sh migrate
```
Type `OPEN-5432-WINDOW-MIGRATE-TEST` only after reading the proposed changes. Expected lines (full rehearsal transcript: `OPERATOR_REHEARSAL_TRANSCRIPTS.md`, sections A-G): `commit <OPERATOR_SHA> (clean)`, `Environment identified: TEST.`, `snapshot ogevia-prod-postgres-pre-0077-<stamp>: available, manual, belongs to ogevia-prod-postgres, created <time> inside the release window <start> to <end>.` (printed **before** the proposed changes and before any rule is added), `window open: exactly one rule was added`, `connected: ogevia_sv_test | read_only=on`, `ledger before: 52 migrations applied, latest 0052`, `enforcement activated for 0 of N agencies before (this run never changes it)`, `applying 0053 ... applying 0077`, `applied 25, already applied 52`, `ledger after: 77 migrations applied, latest 0077`, `verification: 369 PASS, 0 FAIL`, `enforcement state unchanged: 0 of N agencies activated`, `RESTORED (verified)`, `SECURITY GROUP: restored and verified identical to the original`, exit status 0.
If it stops: read the message; the three recovery situations are rehearsed (migration failure: ledger position printed and nothing else is attempted; interruption: ledger position printed, exit 130; rule not removed: exit 3 and the exact commands in section 8). A partial ledger can be continued with `... migrate --resume` only if the cause was transient (a timeout) and the owner agrees; any SQL error is a STOP.

### Step 10 - API deployment [YELLOW]
Working directory `~/ogevia-rc/infra/aws`. Deploy the assembly that step 3 verified, not a fresh synthesis:
```
cd ~/ogevia-rc/infra/aws && bash slice/candidate-pin-check.sh && python3 -B slice/candidate_assembly_check.py --assembly ~/ogevia-rc-cdk.out && npx cdk deploy --app ~/ogevia-rc-cdk.out --exclusively Ogevia-prod-ServiceVerificationApi --require-approval broadening --no-notices
```
Answer `y` only if CDK asks about nothing beyond what step 8 listed (it should not ask: there is no IAM statement or security-group change). Expected: `Ogevia-prod-ServiceVerificationApi: deploying ...`, `✅  Ogevia-prod-ServiceVerificationApi`, and a stack status `UPDATE_COMPLETE`. Immediately:
```
cd ~/ogevia-rc && bash infra/aws/slice/lambda-policy-check-readonly.sh post
```
Expected: `rule: <the ComplianceSweep rule name>`, `statements: ... (API Gateway >=1, EventBridge 1)`, `PASS all checks (size and principals)`. And:
```
aws lambda get-function-configuration --function-name "$FN" --output json | diff <(jq -S .Environment ~/ogevia-before/lambda-config-before.json) <(jq -S .Environment -) && echo "environment unchanged"
aws events list-rules --query 'Rules[?contains(Name,`ComplianceSweep`)].[Name,State]' --output text
```
Expected: `environment unchanged`; the rule listed with state `ENABLED`.

### Step 11 - Web [YELLOW]
`deploy-test-slice.sh web` builds from the checkout, so the pin check runs in the same command line:
```
cd ~/ogevia-rc && bash infra/aws/slice/candidate-pin-check.sh && bash infra/aws/scripts/deploy-test-slice.sh web
```
(`OGEVIA_APP_ENV=test` and `OGEVIA_DEPLOY_APPROVAL` are exported in section 5.) Expected: the build output, the S3 uploads, `Open: https://d2xumch5w0izfg.cloudfront.net` (the TEST site). The script never touches `config.json` and never deletes. Then verify what was published:
```
SITE=https://d2xumch5w0izfg.cloudfront.net
curl -sS "$SITE/index.html" | sha256sum; sha256sum ~/ogevia-rc/apps/web/dist-aws/index.html
curl -sS "$SITE/" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1
```
Expected: the two `index.html` hashes are equal (allow for CloudFront cache for a minute after the invalidation); the asset file listed exists locally under `apps/web/dist-aws/assets/` and contains `VITE_APP_ENV:"test"`. Also `aws s3api head-object` on `config.json` has the same ETag as in `~/ogevia-before/web-before` (unchanged).

### Step 12 - Close the window and smoke
- Read-only: `select count(*) from ogevia.shift_pickup_requests where requested_at >= '<M0>'` is optional here; the practical check is the Schedule page's pickup panel: any pending request made during the window is shown for the office to confirm or decline.
- `cd ~/ogevia-rc && bash infra/aws/scripts/deploy-test-slice.sh smoke` (read-only): expected `Smoke OK: API rejects anonymous calls; web origin serves the app with security headers.`
- Signed-in smoke with synthetic users (TEST banner visible on every page):

| # | Action | Expected |
|---|---|---|
| 1 | Owner signs in; Home loads | Four streams, "Needs action first", no false zero; sidebar badge numbers equal the Action needed page counts |
| 2 | Action needed; open an item | Right page with context; severity words shown |
| 3 | Notifications button | Count equals unread Critical/Urgent items; "Mark all read" gives 0 |
| 4 | Owner switches Urgent notifications off with a reason, then on | Saved; audit event present |
| 5 | Client page: documents, readiness, authorization first | Missing document listed; activation refused until ready |
| 6 | Upload a synthetic document; approve as a second user | Approved; the uploader cannot approve their own |
| 7 | Schedule beyond remaining authorization | Refused with the shortage reason |
| 8 | Schedule Day/Week/Month, filter, replacement suggestions | Consistent; office confirms |
| 9 | Caregiver asks for an open shift; office confirms in Schedule | Request appears; confirmation assigns the shift |
| 10 | Reporting & billing: export billing review as owner; try as scheduler | Owner downloads CSV; scheduler refused |
| 11 | Owner audit report | Field names only |
| 12 | Caregiver on a phone: start and end a visit, confirm | Server times; locked afterwards; no horizontal scroll |
| 13 | Enforcement state (the wrapper already printed it) | Still activated for 0 agencies |
- Within 20 minutes after the deployment (the rule runs every 15 minutes): see section 9 for the sweep log check.
- Tell the owner the result; keep `~/ogevia-before/` and the run folders (`~/ogevia-migrate-window-*`).

## 7. The Lambda-policy check, in one place
`slice/lambda-policy-check-readonly.sh pre|post` (read-only: `sts get-caller-identity`, `cloudformation list-stack-resources`, `lambda get-function-configuration`, `lambda get-policy`) feeds `slice/lambda_policy_check.py`, which validates **size and principals**: exact principal, action, resource, SourceArn condition for each statement; one API Gateway shape and one EventBridge shape; no wildcard, account principal, other service, `Deny` or `Not*` key; at most 19,000 bytes projected peak before and after. Exit 0 only if everything passes. 24 tests cover each failure (`infra/aws/test/lambda-policy-check.test.ts`). Live policy: NOT VERIFIED.

## 8. Recovery
Read this before the window. **Open the second session now** and keep `~/ogevia-before/` safe.

### 8.1 Pinned recovery artifacts
| Layer | Recovery artifact | How it is pinned |
|---|---|---|
| API | Rebuild of commit **`d82fefcd37407d837e7c94f6ac57a907ea286ed1`** (never `origin/main`), asset key `2fcda02d…` | `git rev-parse HEAD` must equal that SHA; the rebuilt template must pass `candidate_assembly_check.py --live-template <rebuilt template>` (it checks the Handler key and the whole template against the baseline fingerprint). Fallback: `~/ogevia-before/lambda-code-before.zip` (hash verified against the live `CodeSha256` in step 4) and `api-template-before.json` |
| Web | `~/ogevia-before/web-before/` | `web-before.sha256` manifest taken before the change |
| Database | the pinned rollback files (rollback-set hash in section 1) are the **prepared, rehearsed** recovery. The named snapshot in `~/ogevia-before/snapshot-id.txt` is a **prerequisite only**: restoring from it is **not a prepared or proven recovery procedure** (section 8.5, Tier 2; documented, unrehearsed on AWS, in `SNAPSHOT_RESTORE_ISOLATED_3159e52.md`) | snapshot validated by the wrapper (exists, `available`, belongs to `ogevia-prod-postgres`, manual, created inside the release window) |

### 8.2 Order of recovery
Reverse of the deployment: **web, then API, then database.** A database rollback while the new API is live makes the new routes call functions that no longer exist. Web and API alone are enough if the schema is fine, but the previous web on the new schema shows the false pickup message (open shifts), so keep pickups frozen until the database is also rolled back or the new web is back.

### 8.3 Web (restore the captured files)
```
BUCKET=$(aws cloudformation describe-stacks --stack-name Ogevia-prod-WebHosting --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)
DIST=$(aws cloudformation describe-stacks --stack-name Ogevia-prod-WebHosting --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)
cd ~/ogevia-before && (cd web-before && sha256sum -c ../web-before.sha256 --quiet) && echo "capture intact"
aws s3 cp web-before/index.html "s3://$BUCKET/index.html" --cache-control no-cache
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/"
```
(New hashed assets stay in the bucket; that is harmless and nothing is deleted. `config.json` is never touched.)

### 8.4 API (pinned baseline, then fallback)
Use a separate clone so the operator checkout is unchanged:
```
cd ~/CarelikGlobal && git fetch origin && git worktree add --detach ~/ogevia-baseline d82fefcd37407d837e7c94f6ac57a907ea286ed1 && cd ~/ogevia-baseline && test "$(git rev-parse HEAD)" = d82fefcd37407d837e7c94f6ac57a907ea286ed1 && pnpm install --frozen-lockfile
cd ~/ogevia-baseline/infra/aws && npx cdk synth --quiet --no-notices -c env=prod -c mode=deploy -o ~/ogevia-baseline-cdk.out
cd ~/ogevia-rc && python3 -B infra/aws/slice/candidate_assembly_check.py --live-template ~/ogevia-baseline-cdk.out/Ogevia-prod-ServiceVerificationApi.template.json
cd ~/ogevia-baseline/infra/aws && npx cdk deploy --app ~/ogevia-baseline-cdk.out --exclusively Ogevia-prod-ServiceVerificationApi --require-approval broadening --no-notices
```
The checker must print `PASS all checks` before the deploy line is run (it proves the rebuilt baseline equals the recorded baseline). If the rebuilt asset key differs from `2fcda02d…`, STOP: restore from `lambda-code-before.zip` instead, as an owner-approved emergency step (`aws lambda update-function-code --function-name "$FN" --zip-file fileb://~/ogevia-before/lambda-code-before.zip`; this puts CloudFormation out of step with the stack and is followed by a proper redeploy of the baseline).

### 8.5 Database only (the shared production database is preserved)
**Tier 1 (prepared, rehearsed): the wrapper's `rollback` mode.** It applies the pinned `db/rollback/0077 ... 0053` files to `ogevia_sv_test`, newest first, one transaction per file (`set local role ogevia_owner`; the rollback file; the ledger row deleted in the same transaction), through the same reviewed /32 window. It refuses unless: the commit and clean tree hold; the migration-set and rollback-set hashes match; the named pre-deployment snapshot validates exactly as in `migrate` mode (exists, `available`, belongs to `ogevia-prod-postgres`, manual, created inside the release window; for a rollback the window need only have started, so a recovery can run after it ends) because several rollbacks drop tables, so a snapshot must exist as a prerequisite ( 0055, 0056, 0060, 0063, 0064, 0067, 0068, 0069, 0071, 0072, 0073, 0074, 0077; the snapshot is not what recovers them, the pinned rollback files are); the connection is `ogevia_sv_test`; the ledger is contiguous between 0053 and 0077. It never names `ogevia_prd`.
```
cd ~/ogevia-rc/infra/aws && OGEVIA_PREDEPLOY_SNAPSHOT_ID=$(cat ~/ogevia-before/snapshot-id.txt) OGEVIA_EXPECT_HOST_IP=<the admin host's private IP> bash slice/candidate-migrate-test.sh rollback
```
Type `OPEN-5432-WINDOW-ROLLBACK-TEST`. Expected: `ledger after: 52 migrations applied, latest 0052`, `enforcement state unchanged`, `migrations 0077 to 0053 reverted`, `RESTORED (verified)`. Export the pending pickup requests first (`shift_pickup_requests`): rolling back 0063 drops that table; the shifts they asked for stay open. Why this preserves the shared instance: LOCAL VERIFIED on PostgreSQL 16 with two databases in one cluster, rolling one back left the other database's dump and the cluster's roles identical; no migration or rollback 0053-0077 contains cluster-level statements (roles, extensions, databases, `alter system`); the wrapper only ever connects to `ogevia_sv_test` (`-d ogevia_sv_test`, test-asserted). NOT VERIFIED on the real RDS.

**Tier 2 (a full restore of `ogevia_sv_test` from the snapshot): DOCUMENTED in `SNAPSHOT_RESTORE_ISOLATED_3159e52.md`; NOT PREPARED, NOT REHEARSED ON AWS. The snapshot alone is not a proven recovery procedure: it proves only that a copy exists.** The snapshot also contains `ogevia_prd` as of the snapshot time, so it is **never** restored in place and the application is **never** repointed at a restored instance. A restore would go to a NEW instance, and `ogevia_sv_test` alone would then be copied back (`pg_dump`/`pg_restore`, every command naming the database) after the owner approves; that has no reviewed window script yet. If Tier 1 fails, **stop and report**; Tier 2 is run only from `SNAPSHOT_RESTORE_ISOLATED_3159e52.md`, only on the owner's instruction, never improvised.

### 8.6 If the temporary rule cannot be removed (exit 3), from the independent session
The script prints these; they are repeated here. First identify (read-only); the temporary rule is the ONE row with cidr `<admin host IP>/32`, tcp 5432, description beginning `TEMP-migrate-`:
```
aws ec2 describe-security-group-rules --region us-west-2 --filters Name=group-id,Values=sg-00530a1f4f7648e65 --query 'SecurityGroupRules[?IsEgress==`false`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,cidr:CidrIpv4,sourceSg:ReferencedGroupInfo.GroupId,desc:Description}' --output table
aws ec2 revoke-security-group-ingress --region us-west-2 --group-id sg-00530a1f4f7648e65 --security-group-rule-ids sgr-<id of that one row>
cd ~/ogevia-rc/infra/aws && bash slice/candidate-migrate-test.sh --restore-only
```
Never touch the row whose `sourceSg` is `sg-064ffce3bcbe8eb3b` (the application group). The marker `~/.ogevia-migrate-window/OPEN` stays, and blocks any further run, until `--restore-only` verifies the rule set equals the recorded original.

## 9. ComplianceSweep: what it does, and its deployment state
**Verified from the code and by test (LOCAL VERIFIED, real database, the real scheduled code, application role):** the EventBridge rule invokes the API Lambda every 15 minutes with the constant event `{"ogevia-task":"compliance-sweep"}`, which an HTTP request can never produce. The handler asks `ogevia_api.system_compliance_orgs()` for active agencies whose `enforcement_active_from` is set and not in the future. **While no agency has activated enforcement that list is empty: the run evaluates nothing, writes no row to any table (holds, flags, audit, events: row counts of every table in the schema were identical before and after), and activates nothing.** Repeated runs stay no-ops. Once an agency's activation exists the same run acts for that agency only (`apps/sv-api/test/compliance-sweep-off.db.test.ts`, 2 tests). Cost: scheduled EventBridge rules are free; 96 invocations a day.

**Deployment state: ENABLED, explicitly.** The synthesized template sets `State: ENABLED` (checked by `candidate_assembly_check.py` and by step 10). This is consistent with the separate activation approval: the deployment approval covers a rule that is a verified no-op; **it does not activate anything** (activation is the owner's one-way `activate_readiness_enforcement`, which this procedure never calls, and the migration wrapper proves the activation count did not change). The reason for ENABLED rather than DISABLED: the activation checklist says holds and shift flags appear on the next scheduled run after activation; a rule deployed disabled would silently delay that until someone remembered to enable it. If the owner prefers DISABLED until activation, that is a separate decision requiring a change to the stack (not made here) or `aws events disable-rule` after the deployment plus an explicit enable step added to the activation checklist.

Post-deployment check, within 20 minutes after step 10 (read-only):
```
aws logs filter-log-events --log-group-name "/aws/lambda/$FN" --filter-pattern '"compliance-sweep"' --start-time $(( ($(date +%s) - 1500) * 1000 )) --query 'events[].message' --output text
```
Expected JSON log line with `"task":"compliance-sweep"`, `"organizations":0`, `"evaluated":0`, `"holdsOpened":0`, `"holdsReleased":0`, `"failedOrganizations":0`. (If the log group has another name, list it with `aws logs describe-log-groups --log-group-name-prefix /aws/lambda/Ogevia-prod-ServiceVerificationApi`.) A line with `failedOrganizations` above 0 or `level:error` is a stop. Emergency stop of the rule: `aws events disable-rule --name <rule name>` (YELLOW; enforcement does not depend on the rule).

## 10. Stop conditions (any one stops the procedure; nothing later is run)
A pin check that does not print `PINS HOLD`; an assembly check or live-template check that fails; a ledger that is not exactly 52 / 0052 at the recheck or in the window; a snapshot that is missing, not `available`, not manual, not of `ogevia-prod-postgres` or created outside the release window (the wrapper refuses before opening access), or a release window that has ended (`migrate`); a `cdk diff` line outside step 8; a policy check that fails; a wrapper that exits non-zero (read its message: restoration is verified before it exits unless it says exit 3); `verify.ts` with any FAIL; an API stack not `UPDATE_COMPLETE`; a changed Lambda environment; a web `index.html` hash that differs from the local build; a TEST banner missing from the site; any step that would touch `ogevia_prd`, an `Ogevia-prd-*` stack, `config.json`, Cognito, Netlify or Supabase; enforcement activation count changing.

## 11. Decisions and approvals this procedure needs
1. Push `claude/ogevia-operator-3159e52` (new branch, no force) so CloudShell can fetch the operator commit.
2. Approve the migration database-access method: the `--host-ip` /32 wrapper (recommended; it is the reviewed approach, rehearsed) in place of the older application-group attachment.
3. Name the operator, the release window (UTC start and end, at most 12 hours) and the approval reference.
4. Accept: Tier 2 database recovery is documented (`SNAPSHOT_RESTORE_ISOLATED_3159e52.md`; SQL steps rehearsed locally only) but not prepared as a reviewed script and not rehearsed on AWS; the live Lambda policy, the live template equality and the real tunnel are verified only at run time by the checks above.
5. ComplianceSweep deployed ENABLED (section 9), or choose DISABLED with the extra step.

Not verified and not required for the TEST deployment: a real phone or tablet, a screen reader, performance on realistic volume, the managed RDS engine, the rule firing in AWS, any Netlify or webhook behaviour of the push.
