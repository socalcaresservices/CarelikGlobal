# Ogevia TEST release: operator procedure for code commit e80b770 (tarball delivery; two possible starting states, PATH A and PATH B)

> **Status: PROPOSED. NOTHING IN THIS DOCUMENT HAS BEEN RUN AGAINST AWS.** The development container has no AWS CLI and no credentials. Every script was tested locally against fake `aws`, `psql` and `npx` programs and against real synthesized templates (section 12). Every step marked **[YELLOW]** changes AWS or TEST data and is run only after the owner's explicit GO (`CLAUDE.md` section 13). **TEST only, synthetic data only.** Production (`Ogevia-prd-*` stacks, database `ogevia_prd`, the production API and web) is never deployed, migrated or queried. **Enforcement is not activated.** No push, merge or production deployment is authorized by this document.
>
> **Owner approval this procedure rests on** (verbatim intent): run the TEST rehearsal in the documented sequence, subject to (1) the TEST ledger matching the plan (77 rows, latest 0077), (2) a verified snapshot, (3) an expected-only infrastructure diff. Explicitly approved: the shared `Ogevia-prod-NetworkEgress` change needed for document uploads (the client-documents key pattern on the S3 gateway endpoint policy). That endpoint policy covers the TEST bucket **and the production bucket**, so the change must be **additive only**: no existing statement, resource, principal, action or condition removed or altered for either bucket. **STOP on any unexpected change or failed check.**
>
> Labels: **LOCAL VERIFIED** = run in the development container with fakes or real synthesized templates. **NOT VERIFIED** = needs AWS, a person at a browser, or another external system. The approval reference `<REF>` and the release window come from the owner's GO message, not from this document.

## 1. What is deployed, and the pins

| Item | Value |
|---|---|
| Code commit (what `BUILD_INFO.json` names) | `e80b770210c54e423d28ecf48e00f1dda9506cec` (`e80b770`, branch `local/review-updates`, **not pushed**) |
| Delivery | A tarball built from that commit by `scripts/build-operator-tarball.sh`: the owner downloads it from the development session and uploads it to CloudShell (Actions, Upload files) as `~/ogevia-operator-e80b770.tar.gz`. CloudShell cannot fetch from GitHub because nothing is pushed, and there is **no git** in this procedure |
| Tarball sha256 | **Not in this document**: the tarball contains this document, so its own hash cannot be written inside it. It is printed by the build script and travels in the covering message and the GO message as `OGEVIA_EXPECT_TARBALL_SHA`. Step 1 refuses to extract a tarball whose hash differs |
| Inside the tarball | `BUILD_INFO.json` (code commit, tree, build time, approval reference or the placeholder `APPROVAL-REF-PENDING-OWNER`) and `PACKAGE_MANIFEST.sha256` (sha256 of every file). The code is `git archive` of the commit; this package folder is taken from the working tree at build time |
| TEST currently runs (baseline) | The earlier release candidate `d89327600f3fc55ab9c59af0d0eaea8675d77535` (migrations 0001-0077 applied by the owner on 2026-10-18; ComplianceSweep ENABLED; enforcement OFF). Step 5 verifies this against the live stacks instead of trusting the record |
| Migrations to apply | `0078` to `0085`, **functions only** (no table, column or stored row changes), each with a rollback in `infra/aws/db/rollback` |
| Migration set 0001-0085 | sha256 `de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef` (`sha256sum -- *.sql \| sha256sum` in `infra/aws/db/migrations`) |
| Migrations 0001-0077 (already applied) | sha256 `90785eaa779a0be2fc46aa7c251294c102b83d0d240b693ea9fb0d5fffc9a335`: unchanged since the TEST operation, so no applied migration was edited |
| Rollback set 0078-0085 | sha256 `29ca0330d71dbb124eb32d4584421486debd1e4253eda03d75678780e024e875` (8 files) |
| `pnpm-lock.yaml` | sha256 `7f5964021b4dbeeebf703fda27e1a509c164c1aecb4436f9324003b7de88dcae` |
| Toolchain | Node 22.x, pnpm 9.15.4, CDK CLI 2.1143.0 (from the package), Python 3, `jq`, `curl`, `openssl`, `timeout`, AWS Session Manager plugin, PostgreSQL client 15 or newer |
| Handler code asset | baseline `929cdb1bde9bbf18025dc36f5cc61210246ca048efa6d6b51147cf4c22b24ab0.zip`, release `eab95a809b3b95b7479cfe6a572e1be0ea068ef6f12751419669443397fe7eda.zip`; IdentityHandler unchanged `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip` (two local syntheses, baseline and release, reproduced the keys) |
| Infrastructure change in this release | `git diff 3159e52 e80b770 --stat -- infra/aws/lib` lists three files: `evidence-storage-stack.ts` (a constant), `network-egress-stack.ts` and `service-verification-api-stack.ts`. A local `cdk synth` of the baseline and the release (deploy mode) shows **only two stacks differ**, exactly as listed in section 2. The other three stacks (EvidenceStorage, WebHosting, Observability) are byte-identical |
| Web | built on CloudShell with `VITE_APP_ENV=test VITE_APP_VERSION=<the 40-character code SHA>`. **The web shows no version text on screen**: the build embeds `VITE_APP_VERSION:"<sha>"` in the main script, and Step 12 reads it from the served bundle |

## 1a. Two possible starting states: PATH A and PATH B (decided by Step 5, confirmed by Step 6)

This package ships the whole UX-density and TEST-findings update. Nobody has confirmed from the development session whether the earlier package (`f6dd9b7f007034ae8d9c010c2ef87e550d93f510`: migrations 0078-0085, NetworkEgress and ServiceVerificationApi) was already run on TEST, so ONE procedure serves both. **No guessing and no choice by the operator**: Step 5 reads the live stacks and writes `~/ogevia-before/path.txt`; Step 6 must then read the matching ledger; any mismatch stops.

| | PATH A: TEST is still the recorded baseline | PATH B: TEST already runs the earlier package |
|---|---|---|
| Step 5 finds | live NetworkEgress and ServiceVerificationApi equal the baseline `d893276`, Handler asset `929cdb1b...` | live stacks equal this release's fingerprints, Handler asset `162b7a43...` (the earlier package) |
| Step 6 ledger must be | exactly **77 rows, latest 0077** | exactly **85 rows, latest 0085** |
| Step 7 snapshot | yes | yes (still recommended: the API code and web change) |
| Step 8 gates | NetworkEgress: endpoint policy gains the two client-documents entries; API: Handler asset `929cdb1b...` to `eab95a80...` and the `ClientDocumentObjects` statement | NetworkEgress: **NO difference at all** (the gate fails on any difference); API: **only** the Handler asset `162b7a43...` to `eab95a80...` (no policy change) |
| Step 9 migrations 0078-0085 | yes | **skip** (`rehearsal-migrate-test.sh` refuses in path B) |
| Step 10 NetworkEgress deploy | yes | **skip** (`deploy-guard.sh` refuses; only `check`) |
| Step 11 ServiceVerificationApi deploy | yes (CDK asks to approve ONE added IAM statement) | yes; **CDK should NOT ask for approval** (no IAM change); if it asks, answer `n` and stop |
| Steps 12-17 | same | same |

In both paths the web is published (Step 12) and the final ledger read (Step 16) must be **85 / 0085**. Production (`Ogevia-prd-*`) is never touched in either path.

## 2. The expected infrastructure difference (what the gate allows, and nothing else)

`scripts/diff_gate.py` compares the **live template** (`aws cloudformation get-template --template-stage Original`, captured at run time) with the **synthesized template**, as JSON, and exits non-zero on anything outside this list. It runs again immediately before each deployment.

| Stack | Allowed difference | Everything else |
|---|---|---|
| `Ogevia-prod-NetworkEgress` | The S3 gateway endpoint policy (`AWS::EC2::VPCEndpoint`, `Gateway`, `Properties.PolicyDocument`) gains exactly two entries in its existing statement's `Resource` list: `arn:aws:s3:::ogevia-prod-signature-evidence-300094796789-us-west-2/*/client-documents/*/*` (TEST bucket) and `arn:aws:s3:::ogevia-prd-signature-evidence-300094796789-us-west-2/*/client-documents/*/*` (production bucket). The 6 earlier resources (3 key shapes for each bucket), the principal, the actions and the `aws:PrincipalAccount` condition are unchanged | No resource added, removed or replaced; no other property of any resource; no change to Description, Parameters, Outputs, Conditions, Mappings, Rules; the value of the `ogevia:deployment-status` tag is ignored (it carries the approval reference); `CDK::Metadata` ignored |
| `Ogevia-prod-ServiceVerificationApi` | (1) The API Handler's `Code.S3Key` `929cdb1b...` to `eab95a80...` (and the asset path in its Metadata); (2) the Handler's managed policy gains exactly one statement: `Sid ClientDocumentObjects`, Allow `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject` on `arn:aws:s3:::ogevia-prod-signature-evidence-300094796789-us-west-2/*/client-documents/*/*` (TEST bucket only) | No Lambda environment, role, runtime, memory, route, permission, EventBridge rule, Cognito, RDS, security-group, KMS or bucket-policy change; no resource added or removed; IdentityHandler unchanged. The route count stays 228 and the ComplianceSweep rule stays as it is |
| `Ogevia-prod-EvidenceStorage`, `-WebHosting`, `-Observability` | **No change.** They are never deployed by this procedure; `assembly_check.py` proves the synthesized templates equal the release synthesis, and `baseline-capture.sh` reports (does not stop on) drift of the live ones | |

After the NetworkEgress deployment, `deploy-guard.sh post` captures the live endpoint policy again and runs `diff_gate.py endpoint-policy --before --after`: every earlier resource for **both** buckets must still be present, the principal, actions and condition identical, and the only additions the two entries above.

## 3. How production is protected

1. **Only two stacks can be deployed**, and only through `deploy-guard.sh`: it accepts exactly `Ogevia-prod-NetworkEgress` or `Ogevia-prod-ServiceVerificationApi`, one per call, and builds the command itself: `npx cdk deploy --app /tmp/ogevia-cdk.out --exclusively <stack> --require-approval broadening --no-notices`. A production name (`Ogevia-prd-*`), a glob, a list, `--all` or any other stack is refused before any AWS call (12 refusal cases, each tested to make no AWS call).
2. **No `Ogevia-prd-*` stack is deployed, and the production API and web are untouched.** The assembly contains only the five `Ogevia-prod-*` stacks (checked).
3. **The shared S3 endpoint policy change is additive only**, machine-checked before (template vs live) and after (live policy vs the captured one).
4. The migration wrapper connects only to `ogevia_sv_test` (`-d ogevia_sv_test`), never names `ogevia_prd`, and refuses if the Lambda does not serve `ogevia_sv_test`.
5. Enforcement is read (never changed) before and after the migration, and in Step 16; any activated agency stops the rehearsal.
6. If the live NetworkEgress template or endpoint policy is anything other than the recorded baseline, Step 8 stops before any change.

## 4. Prerequisites (before the window)

- Owner GO message naming: the operator; the **release window as UTC start and end** (at most 12 hours: the snapshot must be taken inside it and the migration run inside it); the approval reference `<REF>` (6-64 characters of `A-Za-z0-9._-`); the **tarball sha256**; and the **admin host's private IP** (the host tagged `ogevia-db-admin-temp`).
- AWS CloudShell, region `us-west-2`, AdministratorAccess session, account `300094796789`. **A second CloudShell session open and ready for recovery** (section 8); it needs only Step 0's environment file and `~/ogevia-before/`.
- **Disk lesson from the earlier operation: the CloudShell home directory filled up.** Everything large goes to `/tmp` (the pnpm store, `node_modules`, the extracted package, the synthesized assembly, the web build). Only small files (the tarball, `~/ogevia-before/`) live in the home directory. `/tmp` is cleared when the CloudShell environment is recycled; Steps 1-4 rebuild it from the tarball in minutes. Keep `~/ogevia-before/` (it holds the recovery captures) until the owner accepts the release.
- TEST freeze: announce that nobody schedules, edits or confirms on TEST from Step 9 until Step 12 is done (the old API runs against the new database functions in between).

## 5. Procedure

Each step has one command block. "Paste back" is the evidence the operator sends before the next step. **Any output not listed under Expected is a stop** (section 9).

### Step 0 - Session variables and tool check (no change to AWS)
Purpose: set the pinned values once; write them to a file so a second session can load them. Replace the five `<...>` values with those in the GO message, then paste the block.
```
TARBALL_SHA=<64 hex from the GO message>; REF=<approval reference>; WSTART=<UTC start, e.g. 2026-10-19T03:00:00Z>; WEND=<UTC end>; HOSTIP=<admin host private IP>
mkdir -p ~/ogevia-before && cat > ~/ogevia-before/session-env.sh <<EOF
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" PYTHONDONTWRITEBYTECODE=1 CDK_DISABLE_CLI_TELEMETRY=true
export OGEVIA_BEFORE=\$HOME/ogevia-before PKG=/tmp/ogevia-pkg ASSEMBLY=/tmp/ogevia-cdk.out
export S=/tmp/ogevia-pkg/docs/releases/2026-10-19-test-rehearsal/scripts
export OGEVIA_EXPECT_COMMIT=e80b770210c54e423d28ecf48e00f1dda9506cec
export OGEVIA_EXPECT_MIGRATIONS_SHA=de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef
export OGEVIA_EXPECT_ROLLBACK_SHA=29ca0330d71dbb124eb32d4584421486debd1e4253eda03d75678780e024e875
export OGEVIA_EXPECT_LOCKFILE_SHA=7f5964021b4dbeeebf703fda27e1a509c164c1aecb4436f9324003b7de88dcae
export OGEVIA_APP_ENV=test VITE_APP_ENV=test VITE_APP_VERSION=e80b770210c54e423d28ecf48e00f1dda9506cec
export OGEVIA_EXPECT_TARBALL_SHA=$TARBALL_SHA OGEVIA_TARBALL_SHA256=$TARBALL_SHA OGEVIA_DEPLOY_APPROVAL=$REF
export OGEVIA_RELEASE_WINDOW_START=$WSTART OGEVIA_RELEASE_WINDOW_END=$WEND OGEVIA_EXPECT_HOST_IP=$HOSTIP
EOF
source ~/ogevia-before/session-env.sh && echo "$AWS_REGION $AWS_DEFAULT_REGION [$AWS_PAGER]" && node --version && pnpm --version && for t in jq curl openssl python3 timeout session-manager-plugin psql; do command -v $t >/dev/null && echo "ok $t" || echo "MISSING $t"; done; df -h /tmp ~ | cat; ls -l ~/ogevia-operator-e80b770.tar.gz
```
Expected: `us-west-2 us-west-2 []`; `v22.x.y`; `9.15.4`; `ok` for all seven tools; `/tmp` with at least 3 GB available; the tarball listed. Stop: any `MISSING`, Node not 22.x, pnpm not 9.15.4 (install pnpm yourself into `/tmp`: `npm install --prefix /tmp/pnpm-tool pnpm@9.15.4 && export PATH=/tmp/pnpm-tool/node_modules/.bin:$PATH`; this procedure installs nothing else), less than 3 GB in `/tmp`. Recovery: none needed (nothing changed). Paste back: the whole output.

### Step 1 - Verify the uploaded tarball and extract it into /tmp (no change to AWS)
Purpose: prove the file is byte-for-byte what the owner built; nothing else is trusted.
```
source ~/ogevia-before/session-env.sh && cd ~ && echo "$OGEVIA_EXPECT_TARBALL_SHA  ogevia-operator-e80b770.tar.gz" | sha256sum -c - && rm -rf "$PKG" /tmp/ogevia-x && mkdir -p /tmp/ogevia-x && tar -xzf ~/ogevia-operator-e80b770.tar.gz -C /tmp/ogevia-x && mv /tmp/ogevia-x/ogevia-rehearsal-e80b770 "$PKG" && rmdir /tmp/ogevia-x && jq . "$PKG/BUILD_INFO.json" && (cd "$PKG" && sha256sum -c --quiet PACKAGE_MANIFEST.sha256 && echo "manifest ok: $(wc -l < PACKAGE_MANIFEST.sha256) files")
```
Expected: `ogevia-operator-e80b770.tar.gz: OK`; `BUILD_INFO.json` with `"code_commit": "e80b770210c54e423d28ecf48e00f1dda9506cec"`; `manifest ok: N files`. Stop: `FAILED` or any non-zero exit (a corrupted or different upload: upload again; never extract a file that fails). Recovery: delete `/tmp/ogevia-pkg` and re-upload. Paste back: the output.

### Step 2 - Install dependencies in /tmp (no change to AWS)
Purpose: `pnpm install --frozen-lockfile` with the store and `node_modules` in `/tmp`, never in the home directory.
```
source ~/ogevia-before/session-env.sh && [ "$(df --output=avail -k /tmp | tail -1)" -gt 3000000 ] && cd "$PKG" && pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store 2>&1 | tail -15 && df -h /tmp | cat
```
Expected: the install finishes (`Done in ...`); `/tmp` still has free space. Stop: any install error, `ERR_PNPM_OUTDATED_LOCKFILE` (the lock does not match: do not use `--no-frozen-lockfile`), or `No space left on device`. Recovery: `rm -rf /tmp/pnpm-store "$PKG/node_modules"` and repeat; if `/tmp` is too small, stop and report. Paste back: the last lines and the `df` output.

### Step 3 - Pin check (no change to AWS)
Purpose: the tarball-based replacement for the earlier git pin check. It fails closed: a check that cannot run is a failure.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/tarball-pin-check.sh"
```
Expected (all `PASS`, last line `PINS HOLD`): BUILD_INFO code commit `e80b770c...`; PACKAGE_MANIFEST verifies; no file outside the manifest; migration set (0001-0085) `de0c8abbe12023ba...`; migrations 0001-0077 equal the set applied to TEST on 2026-10-18 (`90785eaa779a0be2...`); `pnpm-lock.yaml` `7f5964021b4dbeee...`; `node v22.x`; `pnpm 9.15.4`; dependencies installed; `cdk 2.1143.0`. The line `NOTE BUILD_INFO approval_ref is the placeholder` is normal. Stop: any `FAIL`, no `PINS HOLD`, exit status not 0. Recovery: none (nothing changed). Paste back: the output.

### Step 4 - Synthesize outside the repository and check the assembly (no change to AWS)
Purpose: build the CloudFormation assembly that will be deployed, in `/tmp/ogevia-cdk.out` (never the tracked, stale `infra/aws/cdk.out`, which is not even in the tarball), and prove it is the release.
```
source ~/ogevia-before/session-env.sh && cd "$PKG/infra/aws" && rm -rf "$ASSEMBLY" && PATH="$PWD/node_modules/.bin:$PATH" npx cdk synth --quiet --no-notices -c env=prod -c mode=deploy -o "$ASSEMBLY" && python3 -I -B "$S/assembly_check.py" --assembly "$ASSEMBLY" && cd "$PKG" && bash "$S/tarball-pin-check.sh" | tail -2
```
Expected: `assembly_check.py` prints `PASS` for: exactly the five `Ogevia-prod-*` stacks and no `Ogevia-prd-*`; Handler asset `eab95a809b3b...`; IdentityHandler `7c5f8eb676c9...`; 228 API routes; exactly one EventBridge rule, `State ENABLED`; exactly two Lambda permissions; each of the five stacks equal to the release synthesis; then `PASS all checks`; then the pin check ends `PINS HOLD` (the synthesis did not change the package). Stop: any `FAIL`, or a Handler asset key that is not `eab95a80...` (bundling is reproducible; a different key means different inputs: do not deploy). Recovery: none. Paste back: the output.

### Step 5 - Read-only baseline and recovery capture
Purpose: record what TEST is now, capture everything recovery needs, and prove the live stacks are the recorded baseline. Reads only (describe, list, get, `s3 sync` downloads); writes files under `~/ogevia-before/`.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/baseline-capture.sh"
```
Expected: `account 300094796789`; each of the five stacks `CREATE_COMPLETE` or `UPDATE_COMPLETE` with its outputs; the **TEST API URL** and **TEST web URL**; the line `PASS live TEST is the recorded baseline: PATH A` or `PASS live TEST already runs the earlier package f6dd9b7: PATH B` (exactly one; neither means STOP) and the live baseline check `PASS all checks` (live NetworkEgress and ServiceVerificationApi equal the recorded baseline `d893276`; a `WARN` for one of the other three stacks is reported, not a stop); the handler function name and **live CodeSha256 (before)**; `PASS ... this is TEST` (`DB_NAME=ogevia_sv_test`); the captured zip hash equal to the live `CodeSha256`; `previous API code asset ... exists`; the S3 gateway endpoint id and `endpoint ... policy: 6 resources (3 for the TEST bucket, 3 for the PRODUCTION bucket)`; RDS `available, not publicly accessible, encrypted`; `web files captured: N`; the **index.html sha256 (captured) equal to (served)**; `ComplianceSweep ... ENABLED`; last line `BASELINE CAPTURED`. Stop: any `FAIL` or `STOP`, a live baseline that is not the recorded one, a missing endpoint entry for either bucket. Recovery: nothing changed. Paste back: the whole output (it shows the URLs, `CodeSha256` and web hash the owner needs as the "before" record).

### Step 6 - Ledger recheck and PATH confirmation: 77 / 0077 (PATH A) or 85 / 0085 (PATH B) [YELLOW: one temporary database-access rule]
Purpose: re-read the TEST ledger immediately before migrating, with the reviewed v3 approach (one inbound rule on the RDS security group: tcp 5432 from the admin host's own IP as `/32`, removed and hash-verified on every exit path). `ledger-recheck.sh` is the v3 script with four documented changes (header of the script): the expected ledger is a parameter, the verdict is an exit status, the enforcement count is read, production mode removed.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && RP=$(tr -d '[:space:]' < ~/ogevia-before/path.txt) && echo "PATH $RP (from Step 5)" && if [ "$RP" = A ]; then export OGEVIA_EXPECT_LEDGER_COUNT=77 OGEVIA_EXPECT_LEDGER_LATEST=0077; elif [ "$RP" = B ]; then export OGEVIA_EXPECT_LEDGER_COUNT=85 OGEVIA_EXPECT_LEDGER_LATEST=0085; else echo "STOP: no path from Step 5"; false; fi && bash "$S/ledger-recheck.sh" test --host-ip
```
Type `OPEN-5432-WINDOW` only after reading the proposed change. Expected: `PATH A` or `PATH B` printed first; `connected: ogevia_sv_test | read_only=on`; `enforcement activated for 0 of N agencies`; PATH A: `NO ROW is above 0077: the TEST ledger is exactly the expected 77 / 0077`, PATH B: `... exactly the expected 85 / 0085`; `RESTORED (verified)`; `SECURITY GROUP: restored and verified identical to the original`; exit status 0. **Stop (the script exits 1 after restoring the group): any ledger that does not match the path (PATH A not exactly `77 migrations applied, latest 0077`; PATH B not exactly `85 migrations applied, latest 0085`; a PATH A TEST showing 85, or a PATH B TEST showing 77, means Step 5 and the database disagree: do not continue), any row above 0077, enforcement activated for any agency, a database that is not `ogevia_sv_test`, a rule that is not verified removed (exit 3, see R6).** Recovery: R6 for exit 3; otherwise none. Paste back: the output.

### Step 7 - Named pre-deployment snapshot and its verification [YELLOW: one `create-db-snapshot`]
Purpose: a restore point taken inside the owner's window, named `ogevia-prod-postgres-pre-0085-YYYYMMDDHHMM`. The instance also holds `ogevia_prd`, so this snapshot is a **prerequisite only**: it is never restored in place (R5).
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && date -u +%FT%TZ && bash "$S/snapshot-verify.sh" create
```
Expected: the time is inside `$OGEVIA_RELEASE_WINDOW_START`..`END`; `creating ogevia-prod-postgres-pre-0085-<stamp>`; then `snapshot ...: status=available instance=ogevia-prod-postgres type=manual created=<time inside the window> encrypted=True`; `SNAPSHOT VERIFIED`. The id is saved in `~/ogevia-before/snapshot-id.txt`. **Stop: status not `available`, not `manual`, not of `ogevia-prod-postgres`, not encrypted, created outside the window, or the snapshot id not recorded.** Recovery: a failed create leaves nothing to undo; do not continue without a verified snapshot. Paste back: the output and the snapshot id.

### Step 8 - Infrastructure diff gates for both stacks (read-only; the gate follows the PATH)
Purpose: for each of the two stacks, fetch the live template, run the assembly check and the `cdk diff`, and apply the machine gate of section 2. **No deployment.** This happens before any database change so that an unexpected difference stops the rehearsal at zero cost.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/deploy-guard.sh" check Ogevia-prod-NetworkEgress && bash "$S/deploy-guard.sh" check Ogevia-prod-ServiceVerificationApi
```
Expected (PATH B): NetworkEgress: `ALLOWED NetworkEgress has NO difference from the live stack`, `EXPECTED-ONLY: YES`, `CHECK PASSED` (ANY difference is a STOP); ServiceVerificationApi: exactly ONE line `ALLOWED Lambda Handler... code asset 162b7a43d10d... -> eab95a809b3b...`, `EXPECTED-ONLY: YES`, `CHECK PASSED` (a policy or any other difference is a STOP). Expected (PATH A) for NetworkEgress: `ALLOWED S3 gateway endpoint policy gains arn:aws:s3:::ogevia-prd-signature-evidence-...client-documents/*/*, arn:aws:s3:::ogevia-prod-signature-evidence-...client-documents/*/* (additive only; 6 earlier resources unchanged)`, `EXPECTED-ONLY: YES`, `CHECK PASSED for Ogevia-prod-NetworkEgress`. For ServiceVerificationApi: `ALLOWED Lambda Handler... code asset 929cdb1bde9b... -> eab95a809b3b...`, `ALLOWED handler managed policy ... gains the single statement ClientDocumentObjects ...`, `EXPECTED-ONLY: YES`, `CHECK PASSED`. The human-readable `cdk diff` above each verdict shows the same: one policy `Resource` list with two added lines; one IAM statement added; the Lambda `Code` key changed. **Stop on `EXPECTED-ONLY: NO`, any `VIOLATION`, `REFUSED`, any `[-]` or `(replace)` line in the diff, a changed Lambda environment, or any resource not named above.** Recovery: nothing changed. Paste back: both outputs in full.

### Step 9 - Migrations 0078-0085 [YELLOW]: the migration-access wrapper (**PATH A ONLY; PATH B: skip this step**)
Purpose: apply the eight function-only migrations to `ogevia_sv_test` through the reviewed `--host-ip` /32 wrapper (adapted from the 2026-10-18 operation; header of `rehearsal-migrate-test.sh` lists the differences). It opens one inbound rule (tcp 5432 from the admin host's own IP as `/32`), proves the package, the connection to `ogevia_sv_test` (read-only), the ledger (**exactly 77 / 0077**) and the enforcement count, runs the pinned runner (`db/scripts/migrate.ts`, one transaction per file), re-reads the ledger (**85 / 0085**), runs `db/scripts/verify.ts` (the verification queries in `infra/aws/db/verification`, which include `latest_migration_is_0085`), proves the enforcement count did not change, removes the rule and verifies the complete rule set equals the original. It validates the snapshot (exists, `available`, manual, of `ogevia-prod-postgres`, created inside the window) **before** it proposes or opens anything. `OGEVIA_ALLOW_REMOTE_MIGRATION` is never set; the tunnel is `127.0.0.1`.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && date -u +%FT%TZ | tee ~/ogevia-before/M0.txt && export OGEVIA_PREDEPLOY_SNAPSHOT_ID=$(cat ~/ogevia-before/snapshot-id.txt) && bash "$S/tarball-pin-check.sh" && bash "$S/rehearsal-migrate-test.sh" migrate
```
Type `OPEN-5432-WINDOW-MIGRATE-TEST` only after reading the proposed changes. Expected lines: `package commit e80b770c..., manifest verified (N files), no stray file; migration set sha256 de0c8abbe12023ba...: OK`; `snapshot ogevia-prod-postgres-pre-0085-<stamp>: available, manual, belongs to ogevia-prod-postgres, created <time> inside the release window` (printed before the proposed changes and before any rule is added); `Environment identified: TEST.`; `window open: exactly one rule was added`; `connected: ogevia_sv_test | read_only=on`; `ledger before: 77 migrations applied, latest 0077`; `enforcement activated for 0 of N agencies before`; `applying 0078 ... applying 0085`; `applied 7, already applied 77`; `ledger after: 85 migrations applied, latest 0085`; `verification: P PASS, 0 FAIL`; `enforcement state unchanged`; `RESTORED (verified)`; `SECURITY GROUP: restored and verified identical to the original`; exit status 0. **Stop on: any refusal before the window; a ledger other than 77 / 0077; any SQL error (that file's transaction is rolled back, earlier ones stay applied: the ledger line says where); verification with any FAIL; enforcement count changed; exit 3 (R6); exit 130 (interrupted: the ledger position is printed).** After a stop, do not deploy anything. A partial ledger may be continued with `... migrate --resume` only if the cause was transient (a timeout) and the owner agrees; any SQL error is a stop. Recovery: R4 (database), R6 (rule). Paste back: the whole output and `~/ogevia-migrate-window-migrate-*/RESULT.txt`.

### Step 10 - Deploy `Ogevia-prod-NetworkEgress` [YELLOW], then check production's access is preserved (**PATH A ONLY; PATH B: skip this step**)
Purpose: add the client-documents entries to the shared S3 endpoint policy. Runs the pin check, then the guard (which repeats the live-vs-synth gate, shows the exact command and waits for you to type `DEPLOY-Ogevia-prod-NetworkEgress`), then the read-only post check.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/tarball-pin-check.sh" | tail -1 && bash "$S/deploy-guard.sh" deploy Ogevia-prod-NetworkEgress && bash "$S/deploy-guard.sh" post Ogevia-prod-NetworkEgress
```
Expected: `PINS HOLD`; the gate output of Step 8 again; `ABOUT TO RUN (YELLOW): npx cdk deploy --app /tmp/ogevia-cdk.out --exclusively Ogevia-prod-NetworkEgress --require-approval broadening --no-notices`; CDK should **not** ask to approve IAM or security-group changes (the endpoint policy is not an IAM statement table; if it asks, the question may show nothing but this endpoint policy, otherwise answer `n` and stop); `Ogevia-prod-NetworkEgress` deployed; post: `PASS Ogevia-prod-NetworkEgress is UPDATE_COMPLETE`, `ENDPOINT POLICY ADDITIVE-ONLY: YES`, `resources now: 8 (before: 6)`, `POST-CHECK PASSED`. **Stop on: a gate failure, a CDK question about IAM or security groups, a stack status other than `UPDATE_COMPLETE`, `ENDPOINT POLICY ADDITIVE-ONLY: NO`, or any `lost access` line (production's access).** Recovery: R3. Paste back: the output and `~/ogevia-before/endpoint-policy-after.json`.

### Step 11 - Deploy `Ogevia-prod-ServiceVerificationApi` [YELLOW], then check (**PATH B: CDK should NOT ask for approval; the only change is the Handler code asset**)
Purpose: ship the new API code and the one extra IAM statement. Same guard, same typed confirmation (`DEPLOY-Ogevia-prod-ServiceVerificationApi`).
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/tarball-pin-check.sh" | tail -1 && bash "$S/deploy-guard.sh" deploy Ogevia-prod-ServiceVerificationApi && bash "$S/deploy-guard.sh" post Ogevia-prod-ServiceVerificationApi
```
Expected: `PINS HOLD`; the Step 8 gate output; `ABOUT TO RUN (YELLOW): ... --exclusively Ogevia-prod-ServiceVerificationApi ...`; **CDK will probably ask for approval** (`--require-approval broadening`), because an Allow statement is added: its "IAM Statement Changes" table must show exactly ONE added row (`+`), the row for `arn:aws:s3:::ogevia-prod-signature-evidence-300094796789-us-west-2/*/client-documents/*/*` with `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject`, and no `-` rows, no other row and no security-group table. Answer `y` only then; otherwise `n` and stop. Post: `PASS ... UPDATE_COMPLETE`, `PASS Lambda environment unchanged`, `Lambda CodeSha256: before <old> after <new>`, `PASS the Lambda code changed`, `PASS LastUpdateStatus Successful`, `PASS the handler policy has the ClientDocumentObjects statement`, `PASS ComplianceSweep still ENABLED`, `POST-CHECK PASSED`. **Stop on: a failed gate, a CDK table that shows anything but that one row, a stack status other than `UPDATE_COMPLETE`, a changed environment, a missing statement.** Recovery: R2. Paste back: the output (the new `CodeSha256` is part of the deployed record).

### Step 12 - Web build and publish [YELLOW], then verify what is served
Purpose: build `apps/web` from the package with the TEST banner and the code SHA as version, publish the way the earlier operation did (`deploy-test-slice.sh web`: assets first with the immutable cache header, then `index.html` with `no-cache`, no `--delete`, never `config.json`, CloudFront invalidation of `/index.html` and `/`). The old files stay in the bucket (nothing is deleted) and were captured in Step 5. The script requires `OGEVIA_DEPLOY_APPROVAL`. `deploy-test-slice.sh` is used for `web` and `smoke` only; its `infra`, `database`, `bootstrap`, `users`, `seed` and `pilot-*` commands are **never** run.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/tarball-pin-check.sh" | tail -1 && bash infra/aws/scripts/deploy-test-slice.sh web && sleep 60 && bash "$S/web-verify.sh"
```
Expected: `PINS HOLD`; the vite build output (a chunk-size warning is normal); S3 upload lines; `Open: https://...cloudfront.net`; then `PASS the served index.html is the one just built`, `PASS main script assets/index-<hash>.js`, `PASS the bundle carries the code SHA e80b770c...`, `PASS built for TEST`, `PASS config.json unchanged`, `WEB VERIFIED`. If only the `index.html` hash line fails, wait a minute (CloudFront) and run `bash "$S/web-verify.sh"` once more. **Stop on: a build error, an upload error, a version string that is not the code SHA, no TEST build.** Recovery: R1. Paste back: the output.

### Step 13 - Post-deployment smoke (read-only)
Purpose: the earlier smoke: the API refuses anonymous calls and the web origin serves the app with security headers.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash infra/aws/scripts/deploy-test-slice.sh smoke
```
Expected: `Smoke OK: API rejects anonymous calls; web origin serves the app with security headers.` Stop: anything else. Recovery: R1, R2. Paste back: the output.

### Step 14 - Acceptance on TEST with real accounts (manual; synthetic data only)
Purpose: the owner's document-upload test, which the infrastructure change exists to fix, plus the persistence check. Use the **TEST web URL** from Step 5 (a "TEST - synthetic data only" banner is visible on every page). Nothing here is scripted. Two different individual accounts are needed: account A (owner or manager, uploads) and account B (a second user who may approve client documents).

| # | Action | Expected |
|---|---|---|
| 1 | Account A signs in; open a synthetic client's Documents; upload a small synthetic document | The upload completes ("The file could not be stored" no longer appears); the document shows as pending review |
| 2 | Account A tries to approve its own upload | Refused (a different account must approve) |
| 3 | Account B signs in (another browser or a private window) and approves the document | Approved; the reviewer shown is account B, the uploader account A |
| 4 | Account B opens/downloads the document | The file opens |
| 5 | Reload the page in both browsers, sign out and in again | The document is still listed as approved with the same reviewer (persistence) |
| 6 | Home, Action needed, Schedule load; the sidebar badge numbers equal the Action needed counts | No error banner; no false zero |
| 7 | Assign a shift that exceeds a limit (if a synthetic case exists) | The server outcome is shown first ("Blocked"/"Warning"/"Allowed" with the numbers) |
| 8 | A caregiver account starts and ends a visit and the client confirms | Server times; locked afterwards |

Stop: step 1 fails (read the CloudWatch log of the Lambda for `storageError`; it names the AWS error type, never the message), step 2 succeeds, step 5 loses the approval. Paste back: pass/fail per row and, for a failure, the screen text and time. Recovery: R1-R4 as the owner decides.

### Step 15 - ComplianceSweep still runs and still does nothing (read-only; within 20 minutes after Step 11)
Purpose: the scheduled ComplianceSweep (EventBridge, every 15 minutes, deployed ENABLED) is a verified no-op while no agency has enforcement activated; this proves it still runs and still evaluates nothing.
```
source ~/ogevia-before/session-env.sh && FN=$(cat ~/ogevia-before/handler-function-name.txt) && aws logs filter-log-events --log-group-name "/aws/lambda/$FN" --filter-pattern '"compliance-sweep"' --start-time $(( ($(date +%s) - 1500) * 1000 )) --query 'events[-3:].message' --output text && aws events list-rules --query 'Rules[?contains(Name,`ComplianceSweep`)].[Name,State]' --output text
```
Expected: JSON log lines with `"task":"compliance-sweep"`, `"organizations":0`, `"evaluated":0`, `"holdsOpened":0`, `"holdsReleased":0`, `"failedOrganizations":0`; the rule listed `ENABLED`. (If the log group has another name: `aws logs describe-log-groups --log-group-name-prefix /aws/lambda/Ogevia-prod-ServiceVerificationApi`.) Stop: `failedOrganizations` above 0, `level:error`, a rule that is not `ENABLED` or has changed. Paste back: the output.

### Step 16 - Final database read: 85 rows, latest 0085, enforcement still OFF [YELLOW: one temporary database-access rule]
Purpose: a read-only confirmation after everything is deployed (the migration wrapper already proved the ledger and the enforcement count at the end of Step 9; this is the independent final read the owner asked for). Same reviewed window as Step 6.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && OGEVIA_EXPECT_LEDGER_COUNT=85 OGEVIA_EXPECT_LEDGER_LATEST=0085 bash "$S/ledger-recheck.sh" test --host-ip
```
Type `OPEN-5432-WINDOW`. Expected: `NO ROW is above 0085: the TEST ledger is exactly the expected 85 / 0085, and enforcement is activated for 0 of N agencies as expected`; `RESTORED (verified)`; exit 0. Stop: any other result. Paste back: the output.

### Step 17 - Record the DEPLOYED SHA (read-only)
Purpose: the record the owner needs: the **updated TEST link** and the **deployed SHA**, with every artifact mapped to the tarball's BUILD_INFO commit.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/record-deployed.sh"
```
Expected: `PASS BUILD_INFO code commit`; `PASS Lambda CodeSha256 <b64> (before: <old b64>)`; `PASS the DEPLOYED stack's Handler asset is the release's pinned build eab95a80...zip`; `PASS Lambda LastUpdateStatus Successful`; `PASS web bundle version string = e80b770c...`; then the record: `DEPLOYED SHA : e80b770210c54e423d28ecf48e00f1dda9506cec`, the tarball sha256, the TEST web URL and API URL, the Lambda CodeSha256 (base64 and hex), LastModified, the Handler asset key, the web version string, the five stack statuses; last line `RECORDED`. The file is `~/ogevia-before/DEPLOYED_RECORD.txt`. Stop: any `FAIL`. Paste back: the whole record, plus `~/ogevia-before/M0.txt` and the Step 7 snapshot id. Add the ledger result of Step 16 ("85 rows, latest 0085").

## 6. Evidence the operator must paste back (summary)
Step 0 tool/disk output; 1 hash and manifest; 2 install tail and `df`; 3 pin check; 4 assembly check; 5 baseline (URLs, CodeSha256 before, web hash, endpoint policy counts, RDS state); 6 ledger `77 / 0077` and enforcement; 7 snapshot id and verification; 8 both diff gates; 9 the wrapper output and `RESULT.txt`; 10 NetworkEgress gate, deploy and post check; 11 API gate, deploy and post check; 12 web verification; 13 smoke; 14 the table of results; 15 sweep log; 16 ledger `85 / 0085`; 17 `DEPLOYED_RECORD.txt`.

## 7. Evidence status (section 12 has the test list)
| | LOCAL VERIFIED | NOT VERIFIED |
|---|---|---|
| Tarball | built twice byte-identically; excluded paths absent; self-verified; pin check fails on a wrong hash, commit, migration set, lockfile, toolchain, a changed, missing or stray file, an edited applied migration, and when `sha256sum` fails silently | the upload through CloudShell |
| Diff gate | real baseline and release synthesized templates pass exactly; more than 35 negative cases stop (extra resource, removal, lost production entry, condition/principal/action change, extra IAM statement, widened or production-bucket statement, Lambda environment change, unknown stack, malformed input) | the live templates |
| Deploy guard | exact command; 12 refusal cases (production stack, glob, list, `--all`, other stacks); phrase required; post checks pass and fail correctly | `cdk deploy` itself |
| Migration wrapper | 87 tests: pins, ledger precondition, snapshot (19 refusals in each mode), success, failures, interruption, failed revoke, rollback, resume | the real tunnel, secret, RDS |
| Web bundle | a local `vite build` with `VITE_APP_VERSION=<sha>` embeds `VITE_APP_VERSION:"e80b770c..."` and `VITE_APP_ENV:"test"` | the CloudFront publish |
| Database functions | not re-run here (no database code changed after the DB suites passed on the commit) | RDS |

## 8. Recovery
Read this before the window. **Open the second session now.** Order of recovery is the reverse of deployment: **web, then API, then endpoint policy (only if needed), then database.** The functions-only migrations leave tables and data unchanged, so a database rollback is not required to restore service; use it only if the new functions themselves misbehave. The snapshot is a prerequisite, not a recovery procedure (R5).

### R1 Web: restore the captured files
The deployment never deletes (no `--delete`); assets are content-hashed, so the old files are still in the bucket; `~/ogevia-before/web-before/` is the whole bucket captured in Step 5 with a hash manifest. The block below verifies that every captured file is still in the bucket with the same size, restores any that is not (assets first), and only then puts the old `index.html` back. `config.json` is never touched.
```
# CLOUDSHELL (changes AWS only when it restores a missing asset; nothing is ever deleted)
source ~/ogevia-before/session-env.sh
BUCKET=$(aws cloudformation describe-stacks --stack-name Ogevia-prod-WebHosting --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)
DIST=$(aws cloudformation describe-stacks --stack-name Ogevia-prod-WebHosting --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)
cd ~/ogevia-before && (cd web-before && sha256sum -c ../web-before.sha256 --quiet) && echo "capture intact"
# web-rollback-asset-check
rm -f restore-assets.txt; touch restore-assets.txt
for a in $(grep -o 'assets/[A-Za-z0-9._-]*' web-before/index.html | sort -u); do [ -f "web-before/$a" ] || echo "STOP: $a is referenced by the captured index.html but is not in the capture"; done
(cd web-before && find . -type f ! -name index.html ! -name config.json -printf '%P\t%s\n') | while IFS=$'\t' read -r key size; do
  live=$(aws s3api head-object --bucket "$BUCKET" --key "$key" --query ContentLength --output text 2>/dev/null || echo missing)
  [ "$live" = "$size" ] || echo "$key" >> restore-assets.txt
done
echo "files to restore from the capture: $(wc -l < restore-assets.txt)"
while read -r key; do
  case "$key" in assets/*) CC="public,max-age=31536000,immutable";; *) CC="no-cache";; esac
  aws s3 cp "web-before/$key" "s3://$BUCKET/$key" --cache-control "$CC" --only-show-errors && echo "restored $key"
done < restore-assets.txt
# end web-rollback-asset-check
aws s3 cp web-before/index.html "s3://$BUCKET/index.html" --cache-control no-cache
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/"
```
Expected: `capture intact`; `files to restore from the capture: 0` (normal); no `STOP:` line. Any `STOP:` line means the capture itself is incomplete: do not restore the page, report. Afterwards `curl -sS "$(cat ~/ogevia-before/web-url-before.txt)/index.html" | sha256sum` must equal `~/ogevia-before/web-index-sha256-before.txt`.

### R2 API: previous code
Quick rollback (code only; the extra IAM statement is additive and harmless): the previous Lambda code is still in the CDK asset bucket (Step 5 verified it: `~/ogevia-before/previous-api-asset.txt` holds the bucket and key).
```
source ~/ogevia-before/session-env.sh && FN=$(cat ~/ogevia-before/handler-function-name.txt) && aws lambda update-function-code --function-name "$FN" --s3-bucket "$(sed -n 1p ~/ogevia-before/previous-api-asset.txt)" --s3-key "$(sed -n 2p ~/ogevia-before/previous-api-asset.txt)" --query '[LastUpdateStatus,CodeSha256]' --output text && aws lambda wait function-updated --function-name "$FN" && aws lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text && jq -r .CodeSha256 ~/ogevia-before/lambda-config-before.json
```
The last two lines must be equal (the code is the baseline again). This puts CloudFormation out of step with the stack (the template still names the new asset): tell the owner, and reconcile by re-deploying the captured previous template: upload `~/ogevia-before/live/Ogevia-prod-ServiceVerificationApi.json` (157 KB, larger than the 51,200-byte `--template-body` limit) to a small S3 object the owner names, then `aws cloudformation update-stack --stack-name Ogevia-prod-ServiceVerificationApi --template-url <that object> --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM` and wait for `UPDATE_COMPLETE`. **NOT REHEARSED; only on the owner's instruction.** Fallback if the asset is gone: `aws lambda update-function-code --function-name "$FN" --zip-file fileb://$HOME/ogevia-before/lambda-code-before.zip` (the zip captured in Step 5, hash-verified against the live `CodeSha256`).

### R3 Endpoint policy (shared with production)
The change is additive, so the old behaviour is restored by removing the two added entries, i.e. by putting the captured policy back. Preferred (CloudFormation stays the source of truth): re-deploy the captured previous NetworkEgress template (small, below the 51,200-byte limit):
```
source ~/ogevia-before/session-env.sh && aws cloudformation update-stack --stack-name Ogevia-prod-NetworkEgress --template-body file://$HOME/ogevia-before/live/Ogevia-prod-NetworkEgress.json --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM && aws cloudformation wait stack-update-complete --stack-name Ogevia-prod-NetworkEgress && aws ec2 describe-vpc-endpoints --vpc-endpoint-ids "$(cat ~/ogevia-before/endpoint-id.txt)" --query 'VpcEndpoints[0].PolicyDocument' --output text | jq -S '[.Statement[].Resource | if type=="array" then .[] else . end] | sort' | diff - <(jq -S '[.Statement[].Resource | if type=="array" then .[] else . end] | sort' ~/ogevia-before/endpoint-policy-before.json) && echo "endpoint policy equals the captured one"
```
Quick alternative if CloudFormation cannot be used: `aws ec2 modify-vpc-endpoint --vpc-endpoint-id "$(cat ~/ogevia-before/endpoint-id.txt)" --policy-document file://$HOME/ogevia-before/endpoint-policy-before.json` (then reconcile the stack drift with the command above). **Both are YELLOW and NOT REHEARSED.** Effect of rolling back: only client-document uploads stop working again; the production bucket's earlier entries are untouched in every case. If a post check ever reports `lost access` for the production bucket, treat it as an incident: restore the captured policy first, then report.

### R4 Database (functions only; the shared production database is preserved)
Tier 1 (prepared, rehearsed with fakes): the wrapper's `rollback` mode applies the pinned `db/rollback/0085 ... 0078` files to `ogevia_sv_test`, newest first, one transaction per file (`set local role ogevia_owner`; the rollback file; the ledger row deleted in the same transaction), through the same /32 window. It refuses unless the package, migration-set hash, rollback-set hash and snapshot validate and the ledger is contiguous between 0078 and 0085; it never names `ogevia_prd`. Roll back the web and the API first. Expected: `ledger after: 77 migrations applied, latest 0077`, `enforcement state unchanged`, `migrations 0085 to 0078 reverted`, `RESTORED (verified)`.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && export OGEVIA_PREDEPLOY_SNAPSHOT_ID=$(cat ~/ogevia-before/snapshot-id.txt) && bash "$S/tarball-pin-check.sh" && bash "$S/rehearsal-migrate-test.sh" rollback
```
Type `OPEN-5432-WINDOW-ROLLBACK-TEST`. Each rollback file restores the earlier function definitions (read its `-- ROLLBACK` header); none drops a table, column or row. A partially applied sequence is rolled back from where the ledger stands.

### R5 Snapshot restore (last resort; documented, not prepared, not rehearsed on AWS)
`SNAPSHOT_RESTORE_ISOLATED_e80b770.md` (this folder; adapted from the 2026-10-18 document, ledger numbers only) restores the snapshot to a **new** instance with its own security group and copies back only `ogevia_sv_test`. The snapshot also contains `ogevia_prd`, so it is **never** restored in place and the application is never repointed at a restored instance. It has no reviewed window script, its local rehearsal was not re-run for this release, and it runs only on the owner's explicit instruction. If Tier 1 fails: stop and report.

### R6 If the temporary database rule cannot be removed (exit 3), from the second session
The script prints these commands. Identify the one row with cidr `<admin host IP>/32`, tcp 5432, description beginning `TEMP-migrate-` or `TEMP-ledger-check-`:
```
aws ec2 describe-security-group-rules --region us-west-2 --filters Name=group-id,Values=sg-00530a1f4f7648e65 --query 'SecurityGroupRules[?IsEgress==`false`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,cidr:CidrIpv4,sourceSg:ReferencedGroupInfo.GroupId,desc:Description}' --output table
aws ec2 revoke-security-group-ingress --region us-west-2 --group-id sg-00530a1f4f7648e65 --security-group-rule-ids sgr-<id of that one row>
cd "$PKG" && bash "$S/rehearsal-migrate-test.sh" --restore-only; bash "$S/ledger-recheck.sh" --restore-only
```
Never touch the row whose `sourceSg` is `sg-064ffce3bcbe8eb3b` (the application group). The marker (`~/.ogevia-migrate-window/OPEN` or `~/.ogevia-ledger-window/OPEN`) blocks any further run until `--restore-only` verifies the rule set equals the recorded original.

### R7 Lost session, full disk
Open a new CloudShell, `source ~/ogevia-before/session-env.sh`; if `/tmp/ogevia-pkg` is gone repeat Steps 1-4 (nothing in `~/ogevia-before/` depends on `/tmp`). If the home directory is full, delete only `~/ogevia-migrate-window-*` and `~/ogevia-ledger-window-*` run folders **after** pasting their `RESULT.txt` back; never delete `~/ogevia-before/`.

## 9. Stop conditions (any one stops the procedure; nothing later is run)
A tarball hash that differs; a pin check without `PINS HOLD`; an assembly check or live baseline check that fails; a ledger that is not exactly 77 / 0077 at the recheck or in the window; enforcement activated for any agency, before or after; a snapshot that is missing, not `available`, not manual, not encrypted, not of `ogevia-prod-postgres`, or created outside the release window, or a window that has ended (`migrate`); a diff gate that prints `EXPECTED-ONLY: NO`, any `VIOLATION`, `[-]` or `(replace)` line; a CDK question about IAM or security-group changes that is not exactly the `ClientDocumentObjects` statement; an endpoint policy post check that is not additive-only, or any production-bucket entry lost; a stack not `UPDATE_COMPLETE`; a changed Lambda environment; a wrapper that exits non-zero (read its message; restoration is verified before it exits unless it says exit 3); `verify.ts` with any FAIL; a web `index.html` that differs from the local build or a bundle whose version string is not the code SHA; a missing TEST banner; the document-upload test failing; any step that would touch `ogevia_prd`, an `Ogevia-prd-*` stack, `config.json`, Cognito, Netlify or Supabase.

## 10. What this procedure does not do
It does not deploy `Ogevia-prd-*`, `Ogevia-prod-EvidenceStorage`, `-WebHosting` or `-Observability`; does not change Cognito, RDS, security groups (other than the one temporary, verified-removed `/32` rule in Steps 6, 9 and 16), KMS or bucket policies; does not activate enforcement; does not touch `config.json`, Netlify or Supabase; does not push or merge anything; does not run the production procedures. Production readiness is a separate decision after the owner reviews the TEST result.

## 11. Decisions and approvals this procedure needs from the owner
1. The GO message: operator, release window (UTC, at most 12 hours), `<REF>`, the tarball sha256 and the admin host IP.
2. Download the tarball from the development session and upload it to CloudShell (nothing is pushed).
3. The `--host-ip` /32 database-access method for Steps 6, 9 and 16 (as approved for the 2026-10-18 operation).
4. Accept that R2, R3 and R5 are documented, not rehearsed against AWS.
5. Complete the release checklist (`docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`) with the pasted evidence; it is not completed by this package.

## 12. Tests that back this package
Under `infra/aws/test`: `operator-tarball.test.ts` (build script and pin check, 23 tests), `rehearsal-diff-gate.test.ts` (gate, endpoint policy, assembly, 46), `rehearsal-deploy-guard.test.ts` (32), `rehearsal-migrate.test.ts` (87), `rehearsal-ledger-recheck.test.ts` (13), `rehearsal-operator-scripts.test.ts` (baseline, snapshot, web verify, record, this document, the R1 block, 49): 250 tests. Seven deliberate weakenings of the scripts (gate ignores a removal, gate ignores a lost production entry, guard allow-list off, manifest failure ignored, ledger check relaxed, ledger verdict exit status removed, snapshot status ignored) each made tests fail.
