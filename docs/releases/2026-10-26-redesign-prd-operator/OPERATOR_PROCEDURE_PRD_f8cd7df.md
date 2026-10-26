# Ogevia PRODUCTION release: operator procedure for code commit f8cd7df (staff management and the redesigned navigation; migration 0086 applied outside the ledger)

> **Status: PROPOSED. NOTHING IN THIS DOCUMENT HAS BEEN RUN AGAINST AWS.** The development container has no AWS CLI and no credentials. Every script was tested locally against fake `aws`, `psql`, `curl` and `npx` programs, against real synthesized templates and, for the SQL, against a real PostgreSQL (section 12). Every step marked **[YELLOW]** changes PRODUCTION and is run only after the Owner's GO message for this exact code commit. **PRODUCTION.** The TEST release `7870a04` is a different package (`docs/releases/2026-10-26-redesign-operator/`); TEST is never named as a target here and no TEST exception carries over.
>
> **Owner approvals this procedure rests on:** the instruction of 2026-10-26 to deploy this update to production; enabling the 13 staff routes in production (decision D-P1, `staffManagement: true`, commit `515c49a`); and migration 0086 applied from `infra/aws/db/pending` in **one transaction as `ogevia_owner`, without a ledger row** (decision D-P2), so the production ledger stays exactly **85 / 0085**. The release window, the Operator, the approval reference `<REF>`, the tarball hash and the admin host's IP come from the Owner's GO message, not from this document.
>
> Labels: **LOCAL VERIFIED** = run in the development container with fakes, real synthesized templates or a real local PostgreSQL. **NOT VERIFIED** = needs AWS, a person at a browser, or another external system. Words used exactly: *implemented*, *tested (where)*, *deployed (where)*, *accepted (by whom)*.

## 1. What is deployed, and the pins

| Item | Value |
|---|---|
| Code commit (what `BUILD_INFO.json` names) | `f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45` (`f8cd7df`, branch `claude/redesign-review-nav-ui`). It is the TEST-tested code `7870a04c43545bacc378ad93ffc6a09d63345b5a` plus ONE production configuration line (`ENVIRONMENTS.prd.features.staffManagement: true`) and tests. The tarball is built from this exact commit (`--code-commit f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45`), never from the branch tip |
| Delivery | A tarball built by `scripts/build-prd-tarball.sh`: the Owner downloads it and uploads it to CloudShell (Actions, Upload files) as `~/ogevia-prd-operator-f8cd7df.tar.gz`. There is **no git** in this procedure |
| Tarball sha256 | **Not in this document**: the tarball contains this document. It is printed by the build script and travels in the covering message and the GO message as `OGEVIA_EXPECT_TARBALL_SHA`. Step 1 refuses to extract a tarball whose hash differs |
| Inside the tarball | `BUILD_INFO.json` and `PACKAGE_MANIFEST.sha256` (sha256 of every file); the code is `git archive` of the commit; this package folder is taken from the working tree at build time; `release-templates/` are the seven templates synthesized from the archived code (local `cdk synth`). The top directory is `ogevia-prd-0086-f8cd7df` |
| Migration set 0001-0085 | sha256 `de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef`. **Identical to the set production already holds** (ledger 85 / 0085, read-only capture of 2026-10-26) and to the set applied to TEST; no applied migration was edited. The directory holds exactly 85 files and **no 0086** |
| Migration 0086 (pending, outside the ledger) | `infra/aws/db/pending/migrations/0086_staff_management.sql` sha256 `8eb7b4a353300ba78156bd58a0df6cbc9857b677cec0e8ec51233fcda5a16a4f`; rollback `infra/aws/db/pending/rollback/0086_staff_management.down.sql` sha256 `d2773fdfdf502bb2b337b6e8fb888b72f9b9da660bc944f60a7ff60bec8d2942`. The only two files allowed in `db/pending` (besides its README) |
| `pnpm-lock.yaml` | sha256 `7f5964021b4dbeeebf703fda27e1a509c164c1aecb4436f9324003b7de88dcae` |
| Toolchain | Node 22.x, pnpm 9.15.4, CDK CLI 2.1143.0 (from the package), Python 3, `jq`, `curl`, `openssl`, `timeout`, AWS Session Manager plugin, PostgreSQL client 15 or newer |
| Handler code asset | release `94b73574c5a681d5a8c22b4264742f64e5a6d40aa1ace783be12e7383b9d8a9e.zip` (the build TEST runs); IdentityHandler unchanged `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip`. Production runs `debd1d4305fc1e230fbc7c7a67ffded67d059f8b61cc3ccc3e238d64e74a3235.zip` today. **The asset key depends on the build environment**: TEST's CloudShell reproduced `94b73574c5a6…` and Step 4 confirms production's does; if it does not, STOP (section 9) |
| API routes | 241 = the 228 production has today + **13** staff routes (`scripts/new-route-keys.json`, the same list the gate, the assembly check, the post-check and the route smoke use) |
| Web | built on CloudShell from `apps/web` with **production's own embedded values** (taken from the currently served bundle) and `VITE_APP_VERSION=<the 40-character code commit>` replacing the previous release's `e80b770210c54e423d28ecf48e00f1dda9506cec`; Step 12 reads it back from the served bundle |

## 2. What changes in production, and what does not (from the read-only capture of 2026-10-26)

| Stack / resource | Today (captured) | After this release |
|---|---|---|
| `ogevia_prd` (database) | ledger 85 / 0085; no staff objects | + 2 tables, 6 internal and 15 API functions, 1 trigger, 2 permissions (`staff.read`, `staff.manage`; Owner only); `note_my_sign_in` replaced; 7 default staff types seeded per existing agency; nothing existing is dropped, deleted or updated. **Ledger stays 85 / 0085** |
| `Ogevia-prd-Auth` | web app client without the `app.`/`admin.` URLs | sign-in callbacks `https://app.ogevia.com/auth/callback` and `https://admin.ogevia.com/auth/callback`, sign-out URLs `https://app.ogevia.com/` and `https://admin.ogevia.com/` added (nothing removed) |
| `Ogevia-prd-ServiceVerificationApi` | 228 routes, Handler `debd1d43…` | + 13 staff routes (JWT-authorized like the others), Handler `94b73574…`, CORS origins `https://app.ogevia.com` and `https://admin.ogevia.com` added |
| `Ogevia-prd-WebHosting` | equal to the release except one export | **not deployed**; the web files are published to its bucket. The template keeps `ExportsOutputRefTestSliceAppClient5EA2F71F`, which the release no longer has (no stack imports it, checked) |
| `Ogevia-prd-DatabaseSecret`, `-EvidenceStorage`, `-Observability`, `Ogevia-prod-NetworkEgress` (shared) | equal to the release | **not deployed** (checked for "no difference") |
| Web files | version `e80b770…` | the redesigned navigation and the Staff pages, version = the code commit |
| Cognito users, data, buckets, KMS, secrets, security groups | | **unchanged** (apart from the one temporary, verified-removed `/32` rule in Steps 6, 9 and 16) |

## 3. How TEST and the shared database are protected

1. **Only two stacks can be deployed**, only through `deploy-guard-prd.sh`, one per call, with the command the script builds itself: `npx cdk deploy --app /tmp/ogevia-prd-cdk.out --exclusively <stack> --require-approval broadening --no-notices` for exactly `Ogevia-prd-Auth` or `Ogevia-prd-ServiceVerificationApi`. A TEST stack name (`Ogevia-prod-*`), a glob, a list, `--all`, `--force`, `--hotswap`, `--no-rollback` and `--concurrency` are refused. The other stacks can only be `check`ed.
2. **No `Ogevia-prod-*` (TEST) stack is deployed**; the assembly holds only the six `Ogevia-prd-*` stacks (checked); `route-smoke-prd.sh` accepts only the production API id.
3. The database script connects only to `ogevia_prd` (`-d ogevia_prd`), never names `ogevia_sv_test` as a target, refuses unless the Lambda serves `ogevia_prd` with `OGEVIA_ENV=prd`, and writes **no ledger row** (a test fails if any ledger write appears in the script). The RDS instance is shared with TEST: the snapshot contains both databases and is never restored in place.
4. 0086 is **additive** (section 2). `verify-0086.sql` (110 read-only checks) must pass before any stack is deployed, and no stack deployment starts without the marker `db-0086.ok` that only a verified apply writes.
5. The people-and-access tables (`app_users`, `organization_memberships`, `audit_events`, `caregiver_records`, `organizations`) must have **identical row counts** before and after the apply, and the ledger must still read 85 / 0085. These counts are compared by the script; they are never printed as a judgement about whether the data is real or synthetic, and the procedure deletes nothing.
6. Enforcement is read (never changed) before and after; the apply stops if it changes.

## 4. Prerequisites (before the window)

- Owner GO message naming: the Operator; the release window as UTC start and end (at most 12 hours, the snapshot must be taken inside it); the approval reference `<REF>` (6-64 characters of `A-Za-z0-9._-`); the tarball sha256; the admin host's private IP (the host tagged `ogevia-db-admin-temp`, `10.20.132.179` when last read); and this code commit `f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45`.
- AWS CloudShell, region `us-west-2`, account `300094796789`. **A second CloudShell session open and ready for recovery** (section 8).
- **Disk:** everything large goes to `/tmp` (pnpm store, `node_modules`, the extracted package, the assembly, the web build). Only small files (the tarball, `~/ogevia-prd-before/`) live in the home directory.
- Production freeze: nobody changes anything in production from Step 9 until Step 14 is done. Users who are signed in will see the new menu after the web files change (Step 12) and may need to refresh.
- Rename the earlier discovery capture so it is kept: `mv ~/ogevia-prd-before ~/ogevia-prd-discovery-capture-20261026` (Step 0 does it).

## 5. Procedure

Each step has one command block. "Paste back" is the evidence sent before the next step. **Any output not listed under Expected is a stop** (section 9).

### Step 0 - Session variables and tool check (no change to AWS)
Replace the `<...>` values with those in the GO message, then paste the block.
```
TARBALL_SHA=<64 hex from the GO message>; REF=<approval reference>; WSTART=<UTC start, e.g. 2026-10-28T03:00:00Z>; WEND=<UTC end>; HOSTIP=<admin host private IP>
[ -d ~/ogevia-prd-before ] && mv ~/ogevia-prd-before ~/ogevia-prd-discovery-capture-20261026
mkdir -p ~/ogevia-prd-before && chmod 700 ~/ogevia-prd-before && cat > ~/ogevia-prd-before/session-env.sh <<EOF
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" PYTHONDONTWRITEBYTECODE=1 CDK_DISABLE_CLI_TELEMETRY=true
export OGEVIA_PRD_BEFORE=\$HOME/ogevia-prd-before OGEVIA_BEFORE=\$HOME/ogevia-prd-before PKG=/tmp/ogevia-prd-pkg ASSEMBLY=/tmp/ogevia-prd-cdk.out
export S=/tmp/ogevia-prd-pkg/docs/releases/2026-10-26-redesign-prd-operator/scripts
export OGEVIA_EXPECT_COMMIT=f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45
export OGEVIA_EXPECT_MIGRATIONS_SHA=de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef
export OGEVIA_EXPECT_0086_SHA=8eb7b4a353300ba78156bd58a0df6cbc9857b677cec0e8ec51233fcda5a16a4f
export OGEVIA_EXPECT_0086_DOWN_SHA=d2773fdfdf502bb2b337b6e8fb888b72f9b9da660bc944f60a7ff60bec8d2942
export OGEVIA_EXPECT_LOCKFILE_SHA=7f5964021b4dbeeebf703fda27e1a509c164c1aecb4436f9324003b7de88dcae
export OGEVIA_EXPECT_TARBALL_SHA=$TARBALL_SHA OGEVIA_TARBALL_SHA256=$TARBALL_SHA OGEVIA_DEPLOY_APPROVAL=$REF
export OGEVIA_RELEASE_WINDOW_START=$WSTART OGEVIA_RELEASE_WINDOW_END=$WEND OGEVIA_EXPECT_HOST_IP=$HOSTIP
EOF
source ~/ogevia-prd-before/session-env.sh && echo "$AWS_REGION $AWS_DEFAULT_REGION [$AWS_PAGER]" && node --version && pnpm --version && for t in jq curl openssl python3 timeout session-manager-plugin psql; do command -v $t >/dev/null && echo "ok $t" || echo "MISSING $t"; done; df -h /tmp ~ | cat; ls -l ~/ogevia-prd-operator-f8cd7df.tar.gz
```
Expected: `us-west-2 us-west-2 []`; `v22.x.y`; `9.15.4`; `ok` for all seven tools; `/tmp` with at least 3 GB available; the tarball listed. Stop: any `MISSING`, Node not 22.x, pnpm not 9.15.4 (install pnpm yourself into `/tmp`: `npm install --prefix /tmp/pnpm-tool pnpm@9.15.4 && export PATH=/tmp/pnpm-tool/node_modules/.bin:$PATH`). Paste back: the output.

### Step 1 - Verify the uploaded tarball and extract it into /tmp (no change to AWS)
```
source ~/ogevia-prd-before/session-env.sh && cd ~ && echo "$OGEVIA_EXPECT_TARBALL_SHA  ogevia-prd-operator-f8cd7df.tar.gz" | sha256sum -c - && rm -rf "$PKG" /tmp/ogevia-x && mkdir -p /tmp/ogevia-x && tar -xzf ~/ogevia-prd-operator-f8cd7df.tar.gz -C /tmp/ogevia-x && mv /tmp/ogevia-x/ogevia-prd-0086-f8cd7df "$PKG" && rmdir /tmp/ogevia-x && jq . "$PKG/BUILD_INFO.json" && (cd "$PKG" && sha256sum -c --quiet PACKAGE_MANIFEST.sha256 && echo "manifest ok: $(wc -l < PACKAGE_MANIFEST.sha256) files")
```
Expected: `ogevia-prd-operator-f8cd7df.tar.gz: OK`; `BUILD_INFO.json` with `"code_commit": "f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45"`, `"environment": "PRODUCTION"`, `"api_routes_in_release": 241`; `manifest ok: N files`. Stop: `FAILED` or any non-zero exit (re-upload; never extract a file that fails). Paste back: the output.

### Step 2 - Install dependencies in /tmp (no change to AWS)
```
source ~/ogevia-prd-before/session-env.sh && [ "$(df --output=avail -k /tmp | tail -1)" -gt 3000000 ] && cd "$PKG" && pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store 2>&1 | tail -15 && df -h /tmp | cat
```
Expected: the install finishes (`Done in ...`). Stop: any install error, `ERR_PNPM_OUTDATED_LOCKFILE` (never use `--no-frozen-lockfile`), `No space left on device`. Recovery: `rm -rf /tmp/pnpm-store "$PKG/node_modules"` and repeat. Paste back: the tail and `df`.

### Step 3 - Pin check (no change to AWS)
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && bash "$S/tarball-pin-check.sh"
```
Expected (all `PASS`, last line `PINS HOLD`): BUILD_INFO code commit `f8cd7dff…`; PACKAGE_MANIFEST verifies; no file outside the manifest; migration set `de0c8abbe12023ba…`; migrations 0001-0085 equal the set production and TEST hold; `db/migrations` holds exactly the 85 released files and no 0086; 0086 up `8eb7b4a353300ba7…` and down `d2773fdfdf502bb2…`; `db/pending` holds only the two 0086 files; `pnpm-lock.yaml` `7f5964021b4dbeee…`; `node v22`, `pnpm 9.15.4`, dependencies installed, `cdk 2.1143.0`. Stop: any `FAIL` or no `PINS HOLD`. Paste back: the output.

### Step 4 - Synthesize outside the repository and check the assembly (no change to AWS)
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG/infra/aws" && rm -rf "$ASSEMBLY" && PATH="$PWD/node_modules/.bin:$PATH" npx cdk synth --quiet --no-notices -c env=prd -c mode=deploy -o "$ASSEMBLY" && python3 -I -B "$S/assembly_check_prd.py" --assembly "$ASSEMBLY" --release-templates "$PKG/docs/releases/2026-10-26-redesign-prd-operator/release-templates" --approval "$OGEVIA_DEPLOY_APPROVAL" && cd "$PKG" && bash "$S/tarball-pin-check.sh" | tail -2
```
Expected: `assembly_check_prd.py` prints `PASS` for: exactly the six `Ogevia-prd-*` stacks and no `Ogevia-prod-*`; each equal to the bundled release template; Handler asset `94b73574c5a6…`; IdentityHandler `7c5f8eb676c9…`; both asset directories present; 241 API routes; each of the 13 staff routes once; exactly one EventBridge rule `ENABLED`; exactly two Lambda permissions; every `ogevia:deployment-status` tag carries `approved-<REF>`; then `PASS all checks`; and `PINS HOLD`. **Stop:** `FAIL Handler code asset`: CloudShell produced a different build than the development container; do not deploy, paste the output. Paste back: the `PASS`/`FAIL` lines.

### Step 5 - Read-only baseline and recovery capture, and the difference report
Records what production is now and captures everything recovery needs (previous API code, route keys, the API's own CORS, the Cognito client URLs, the web bucket). Reads only (describe, list, get, `s3 sync` downloads); writes files under `~/ogevia-prd-before/`.
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && bash "$S/p0-baseline-capture.sh" && bash "$S/p1-diff-report.sh"
```
Expected: `account 300094796789, region us-west-2: OK`; all seven stacks settled; the Lambda serves `ogevia_prd` with `OGEVIA_ENV=prd`; `PASS the downloaded code zip hash equals the live CodeSha256`; the previous code asset `debd1d43…` exists; `routes on the production API: 228`; the served web version `e80b770210c54e423d28ecf48e00f1dda9506cec`, environment `production`, API host `zk527zk4ua`; `PASS RDS available, private, encrypted`; `BASELINE CAPTURED`. The diff report (`p1-diff-report.sh`, which compares templates with `tpl_diff.py`; local files only) lists: Auth 4 changed properties; API 13 added resources and 3 changed properties; WebHosting 1 section change; the others none. **Differences from this are information for the Owner and the gate in Step 8 is authoritative.** Stop: any `FAIL`. Paste back: the output (it is the only record of the "before" state).

### Step 6 - Ledger recheck: exactly 85 / 0085 and 0086 absent [YELLOW: one temporary database-access rule]
Re-reads the production ledger through one inbound rule on the RDS security group (tcp 5432 from the admin host's own IP as `/32`), removed and hash-verified on every exit path. It reports facts only; it does not judge the data.
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && OGEVIA_EXPECT_LEDGER_COUNT=85 OGEVIA_EXPECT_LEDGER_LATEST=0085 OGEVIA_EXPECT_0086=absent bash "$S/ledger-recheck-prd.sh" prd --host-ip
```
Type `OPEN-5432-WINDOW-PRD` only after reading the proposed change. Expected: `connected: ogevia_prd | read_only=on`; `staff-management objects (staff_types|staff_profiles|functions of 21): 0|0|0`; `0086 is ABSENT as expected.`; `NO ROW is above 0085: the production ledger is exactly the expected 85 / 0085`; `RESTORED (verified)`; `SECURITY GROUP: restored and verified identical to the original`; exit 0. Stop: any other result (a ledger of 86 means someone ran the runner; objects `1|1|21` mean 0086 is already there: **do not continue**). Paste back: the output.

### Step 7 - Named pre-deployment snapshot and its verification [YELLOW: one `create-db-snapshot`]
A restore point taken inside the Owner's window, named `ogevia-prod-postgres-pre-0086-prd-YYYYMMDDHHMM`. The instance also holds `ogevia_sv_test`, so this snapshot is a **prerequisite only**: it is never restored in place (R4).
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && date -u +%FT%TZ && bash "$S/snapshot-verify-prd.sh" create
```
Expected: the time is inside the window; `creating ogevia-prod-postgres-pre-0086-prd-<stamp>`; then `status=available instance=ogevia-prod-postgres type=manual created=<time inside the window> encrypted=True`; `SNAPSHOT VERIFIED`. The id is saved in `~/ogevia-prd-before/snapshot-id.txt`. Stop: anything else; an unverified snapshot means no later step may run. Paste back: the output.

### Step 8 - Infrastructure gates for all seven stacks (read-only)
For each stack: fetch the live template, run the assembly check and `cdk diff`, and apply the machine gate (`diff_gate_prd.py`). **No deployment.** Done before any database change so an unexpected difference costs nothing.
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && for s in Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-Observability Ogevia-prod-NetworkEgress Ogevia-prd-WebHosting Ogevia-prd-Auth Ogevia-prd-ServiceVerificationApi; do bash "$S/deploy-guard-prd.sh" check $s || break; done
```
Expected: for the first four stacks `ALLOWED Ogevia-… has NO difference from the live stack`, `EXPECTED-ONLY: YES (NONE)`, `CHECK PASSED … (NONE)`; for `Ogevia-prd-WebHosting`: `ALLOWED WebHosting: Output ExportsOutputRefTestSliceAppClient5EA2F71F … absent from the release template`, `EXPECTED-ONLY: YES (EXPORT-ONLY)`; for `Ogevia-prd-Auth`: `ALLOWED Cognito app client WebClient: sign-in callbacks […] and sign-out URLs […] added; every other property identical`, `EXPECTED-ONLY: YES (DELTA)`; for `Ogevia-prd-ServiceVerificationApi`: `ALLOWED HTTP API …: CORS origins https://app.ogevia.com and https://admin.ogevia.com added to the template; every other property identical`, exactly one `ALLOWED Lambda Handler… code asset debd1d4305fc… -> 94b73574c5a6…`, `ALLOWED 13 staff API routes added, each JWT-authorized like the existing routes`, `EXPECTED-ONLY: YES (DELTA)`, `CHECK PASSED … (DELTA)`. **Stop:** any `VIOLATION`: IAM, security-group, secret, authorizer, stage, rule, log, deletion, replacement, another CORS origin, another callback URL, another removed export. Do not change anything by hand; paste the output and wait for the Owner. Paste back: the output.

### Step 9 - Apply migration 0086 to the production database [YELLOW]
One transaction as `ogevia_owner`, no ledger row; temporary rule as in Step 6; the snapshot is re-verified first. The script proves the package, the connection to `ogevia_prd` (read-only session), the ledger (85 / 0085), that the 0086 objects are absent, and records the people-and-access row counts and the enforcement state; then runs the one transaction; then re-reads everything and runs `verify-0086.sql` (110 checks) and the runner's own verification set; only then it closes the window and writes the marker `~/ogevia-prd-before/db-0086.ok`.
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && date -u +%FT%TZ | tee ~/ogevia-prd-before/M0.txt && export OGEVIA_PREDEPLOY_SNAPSHOT_ID=$(cat ~/ogevia-prd-before/snapshot-id.txt) && bash "$S/tarball-pin-check.sh" | tail -1 && bash "$S/apply-0086-prd.sh" apply
```
Type `OPEN-5432-WINDOW-APPLY-0086-PRD` only after reading the proposed changes. Expected lines: `package commit f8cd7dff…, manifest verified (N files), no stray file`; `snapshot ogevia-prod-postgres-pre-0086-prd-<stamp>: available, manual, belongs to ogevia-prod-postgres, created … inside the release window`; `Environment identified: PRODUCTION.`; `window open: exactly one rule was added`; `connected: ogevia_prd | read_only=on`; `ledger before: 85 migrations applied, latest 0085`; `staff-management objects (…): 0|0|0`; the before counts; after the transaction `1|1|21`, the ledger still `85 / 0085`, the counts identical; `verify-0086.sql: 110 checks, 0 failing`; `runner verification set: N PASS, 0 FAIL`; `marker written: … db-0086.ok (85|0085|0086 …)`; `RESULT: 0086 applied (2 tables, 21 functions); ledger 85 / 0085 unchanged; people and access unchanged; verify-0086.sql 110 PASS`; `RESTORED (verified)`. Stop and **do not deploy any stack or publish the web** on: `APPLY FAILED` (the transaction rolled back; nothing of 0086 was kept: paste the output), a ledger that is not 85 / 0085, changed counts, a verification that fails (0086 IS applied: paste the output; section 8 R3 is the Owner's decision), exit 3 (the rule could not be removed: R5 first). Paste back: the output and `RESULT.txt` from the printed run folder.

### Step 10 - Deploy `Ogevia-prd-Auth` [YELLOW], then check
One stack only. The guard repeats the Step 8 gate (it must say `DELTA`; "nothing to deploy" is a refusal), shows the exact command and waits for the typed phrase.
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && export OGEVIA_PREDEPLOY_SNAPSHOT_ID=$(cat ~/ogevia-prd-before/snapshot-id.txt) && bash "$S/tarball-pin-check.sh" | tail -1 && bash "$S/deploy-guard-prd.sh" deploy Ogevia-prd-Auth && bash "$S/deploy-guard-prd.sh" post Ogevia-prd-Auth
```
Type `DEPLOY-Ogevia-prd-Auth` only after reading the gate output. Expected: `PINS HOLD`; the Step 8 gate again (`DELTA`); `ABOUT TO RUN (YELLOW, changes PRODUCTION): npx cdk deploy --app /tmp/ogevia-prd-cdk.out --exclusively Ogevia-prd-Auth --require-approval broadening --no-notices`; CDK should **not** ask for approval. **If CDK shows an "IAM Statement Changes" or "Security Group Changes" table, answer `n` and stop.** Then the post check: `PASS Ogevia-prd-Auth is UPDATE_COMPLETE`, `PASS the live template now equals the release template`, `PASS the production user pool is unchanged (us-west-2_FHJoX71ca)`, `PASS the app client allows the app. and admin. sign-in and sign-out URLs`, `PASS no earlier callback or sign-out URL was lost`, `POST-CHECK PASSED`. Stop: anything else; do not deploy the API. Recovery: R2b. Paste back: the output.

### Step 11 - Deploy `Ogevia-prd-ServiceVerificationApi` [YELLOW], then check
One stack only; needs the Auth marker from Step 10 and the database marker from Step 9.
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && export OGEVIA_PREDEPLOY_SNAPSHOT_ID=$(cat ~/ogevia-prd-before/snapshot-id.txt) && bash "$S/tarball-pin-check.sh" | tail -1 && bash "$S/deploy-guard-prd.sh" deploy Ogevia-prd-ServiceVerificationApi && bash "$S/deploy-guard-prd.sh" post Ogevia-prd-ServiceVerificationApi
```
Type `DEPLOY-Ogevia-prd-ServiceVerificationApi` only after reading the gate output. Expected: `PINS HOLD`; the Step 8 gate again (`DELTA`); `ABOUT TO RUN (YELLOW, changes PRODUCTION): npx cdk deploy --app /tmp/ogevia-prd-cdk.out --exclusively Ogevia-prd-ServiceVerificationApi --require-approval broadening --no-notices`; CDK should **not** ask for approval (no IAM or security-group change; new routes, two CORS origins and a code asset only). **If CDK shows an "IAM Statement Changes" or "Security Group Changes" table, answer `n` and stop.** Then the post check: `PASS Ogevia-prd-ServiceVerificationApi is UPDATE_COMPLETE`, `PASS the live template now equals the release template`, `PASS Lambda LastUpdateStatus Successful`, `PASS the Lambda code changed`, `PASS the Lambda still serves ogevia_prd with OGEVIA_ENV=prd`, `PASS the Lambda's environment variable names are unchanged`, `PASS the API gained exactly 13 routes`, `PASS all 13 staff routes exist`, `PASS no earlier route was lost`, `PASS CORS: only the app. and admin. origins were added (or were already there)…`, `PASS the production ComplianceSweep rule … is ENABLED`, `POST-CHECK PASSED`. Stop: anything else; do not publish the web. Recovery: R2 (and R3 if the Owner decides). Paste back: the output.

### Step 12 - Web build and publish [YELLOW], then verify what is served
Builds `apps/web` from the package with production's own embedded values (Cognito pool/client/domain, redirect URIs, API base URL) taken from the currently served bundle and the code commit as `VITE_APP_VERSION`, and refuses any other difference. Publish: assets first (immutable cache header), then `index.html` with `no-cache`, no `--delete`, never `config.json`, CloudFront invalidation of `/index.html` and `/`. Requires the database and API markers, an intact recovery capture and a served page identical to the capture.
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && bash "$S/tarball-pin-check.sh" | tail -1 && bash "$S/web-prd.sh" build && bash "$S/web-prd.sh" publish
```
Type `PUBLISH-WEB-Ogevia-prd` only after reading the proposed change. Expected: `PINS HOLD`; `the new bundle embeds exactly the production values plus VITE_APP_VERSION:"f8cd7dff…"`; `WEB BUILD READY`; the `PROPOSED (YELLOW, changes the PRODUCTION site …)` line; then `PASS the served index.html is byte-identical to …`, `PASS the served main script equals the expected file`, `PASS the bundle carries VITE_APP_VERSION:"f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45"`, `PASS built for production (VITE_APP_ENV:"production")`, `PASS the bundle calls the production API host zk527zk4ua.execute-api...`, `PASS no other API host in the bundle`, `PUBLISHED AND VERIFIED`. If only the first check fails, the script waits and retries once (CloudFront cache); otherwise stop. Recovery: R1. Paste back: the output.

### Step 13 - Post-deployment smoke (read-only)
The 13 new routes: **no token → 401** and **forged token → 401** for each (26 calls), and a CORS preflight from `https://app.ogevia.com` and from `https://admin.ogevia.com`. The calls carry no credentials; the authorizer answers before any code runs.
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && bash "$S/route-smoke-prd.sh"
```
Expected: 26 lines `PASS <route> (none|forged token): 401`; `PASS CORS preflight from https://app.ogevia.com: 204 and the origin is allowed`; the same for `admin.`; `ROUTE SMOKE PASSED: 13 routes x 2 calls, all 401; CORS preflight ok for app. and admin.`. Stop: any other code (a `200` on a staff route is a **P0**: roll back R2 at once and report). Paste back: the output.

### Step 14 - Owner acceptance in production (manual; creates no data)
Use the production web URL from Step 5. Minimum, and nothing here creates, edits or deletes a production record: sign in as the Owner (an existing production account); the menu shows Dashboard, Clients, Staff, Scheduling, Operations, Settings; open **Staff**, **Staff Types** and **Roles & Permissions** with no error screen (the lists may be empty or hold only the seeded staff types); open one existing page of each area you use daily (Clients, Scheduling, a report) with no error screen. If production has any non-Owner account (Scheduler, Manager, Caregiver), sign in as one, confirm the pages that account used before still open and that **Staff** is not offered to it. Do not invite or create staff in production as a test. Stop: any error screen on a Staff page or on a page that worked before (R1 first, then report). Paste back: pass/fail per item and, for a failure, the screen text and time.

### Step 15 - ComplianceSweep still runs and still does nothing; API log search (read-only; within 20 minutes after Step 11)
```
source ~/ogevia-prd-before/session-env.sh && FN=$(cat ~/ogevia-prd-before/handler-function-name.txt) && LG=$(aws lambda get-function-configuration --function-name "$FN" --query 'LoggingConfig.LogGroup' --output text) && aws logs filter-log-events --log-group-name "$LG" --filter-pattern '"compliance-sweep"' --start-time $(( ($(date +%s) - 1500) * 1000 )) --query 'events[-3:].message' --output text && aws logs filter-log-events --log-group-name "$LG" --filter-pattern ERROR --start-time $(( ($(date +%s) - 3600) * 1000 )) --query 'length(events)' --output text
```
Expected: JSON log lines with `"task":"compliance-sweep"` and `"holdsOpened":0`, `"failedOrganizations":0` (the counts of organizations are information, not a judgement); then the number of ERROR events in the last hour: `0`. Stop: a non-zero ERROR count (paste the count; do not paste messages: they may contain identifiers). Paste back: the output.

### Step 16 - Final database read: 85 / 0085, 0086 present, enforcement unchanged [YELLOW: one temporary database-access rule]
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && OGEVIA_EXPECT_LEDGER_COUNT=85 OGEVIA_EXPECT_LEDGER_LATEST=0085 OGEVIA_EXPECT_0086=present bash "$S/ledger-recheck-prd.sh" prd --host-ip
```
Type `OPEN-5432-WINDOW-PRD`. Expected: `staff-management objects (…): 1|1|21`; `0086 is PRESENT as expected (2 tables, 21 functions).`; `NO ROW is above 0085: the production ledger is exactly the expected 85 / 0085`; `RESTORED (verified)`; exit 0. Stop: any other result. Paste back: the output.

### Step 17 - Record the DEPLOYED SHA (read-only)
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && bash "$S/record-deployed-prd.sh"
```
Expected: `PASS the migration marker says 85|0085|0086 (snapshot …)`; `PASS the API post-check marker exists`; `PASS Lambda CodeSha256 <b64> (before: <old b64>)`; `PASS the DEPLOYED stack's Handler asset is the release's pinned build 94b73574…zip`; `PASS the Lambda serves ogevia_prd (OGEVIA_ENV=prd), LastUpdateStatus Successful`; all seven stacks settled; `PASS the ComplianceSweep rule … is ENABLED`; `PASS no ERROR event in the last 30 minutes …`; `PASS the served web is the release build`; then the record (`DEPLOYED SHA : f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45`, tarball sha256, Lambda CodeSha256 in base64 and hex, the Handler asset, stack statuses, the production URLs) and `RECORDED: every deployed artifact maps to f8cd7dff…`. It is saved as `~/ogevia-prd-before/DEPLOYED_RECORD.txt`. Stop: any `FAIL` or `STOP:`. Paste back: the whole output; the development session writes `docs/releases/2026-10-26-redesign/DEPLOYED_RECORD_PRD.md` from it. **Deployed means: this record exists and the Owner has the production link; accepted means the Owner's Phase E sign-off.**

## 6. Evidence the operator pastes back (summary)
Step 0 tool/disk output; 1 hash and manifest; 2 install tail; 3 pin check; 4 assembly check; 5 baseline and diff report; 6 ledger `85 / 0085` with 0086 absent; 7 snapshot id and verification; 8 all seven gates; 9 the apply output and `RESULT.txt`; 10 Auth deploy and post check; 11 API deploy and post check; 12 web build, publish and verify; 13 smoke; 14 manual pass/fail; 15 sweep and log count; 16 final ledger with 0086 present; 17 the deployed record.

## 7. Evidence status
| | LOCAL VERIFIED | NOT VERIFIED |
|---|---|---|
| Tarball | built twice byte-identically from the real repository at the code commit; 0086 only in `db/pending`; seven bundled templates; pin check fails on a wrong commit, migration set, 0086 file, down file, lockfile, toolchain, a changed, missing or stray file, and 0086 inside `db/migrations` | the upload through CloudShell; that CloudShell reproduces the Handler asset key (Step 4 decides) |
| SQL | the pinned 0086 file applies in one transaction as `ogevia_owner` on a real PostgreSQL holding the real 0001-0085 migrations; `verify-0086.sql` reports 110 passing checks; each sabotage turns a check red; apply, rollback and re-apply round-trips | RDS (the real instance, secret and tunnel), the real production data |
| Database script | pins, snapshot (refusal cases), 0086 state, ledger 85 / 0085 before and after, people-and-access counts, failing transaction, interruption, failed revoke, `--restore-only`, rollback and its post-check, no ledger write, the marker only after a verified apply | the real tunnel, secret and RDS |
| Diff gate | the real synthesized production templates against "live" stacks derived from the 2026-10-26 capture: DELTA for Auth and API, EXPORT-ONLY for WebHosting, NONE for the rest; 60+ negative cases | the live templates |
| Deploy guard | exact command; refusals (TEST stack, glob, list, `--all`, other stacks, missing marker, snapshot problems, no Auth marker for the API); phrase required; post checks pass and fail correctly | `cdk deploy` itself |
| Web and routes | web guard against a mocked bucket (build with production's values, publish, verify, rollback); route smoke (26 calls, two preflights); the deployed record | the CloudFront publish; the real authorizer |

## 8. Recovery
Open the second session now. Order of recovery is the reverse of deployment: **web, then API, then (if the Owner decides) database.** All recovery commands are YELLOW and, apart from R3, **NOT REHEARSED against AWS**.

### R1 Web: restore the captured files
The deployment never deletes (no `--delete`); assets are content-hashed, so the old files are still in the bucket; `~/ogevia-prd-before/web-before/` is the whole bucket captured in Step 5 with a hash manifest.
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && bash "$S/web-prd.sh" rollback-verify && bash "$S/web-prd.sh" rollback
```
Type `RESTORE-WEB-Ogevia-prd`. Expected: `ROLLBACK SOURCE OK`; restored files (if any); `ROLLED BACK AND VERIFIED: … serves the captured site` with the previous version string `e80b770…`.

### R2 API: previous code
Quick rollback (code only): the previous Lambda code is still in the CDK asset bucket (Step 5 verified it; `~/ogevia-prd-before/previous-api-asset.txt` holds the bucket and key).
```
source ~/ogevia-prd-before/session-env.sh && FN=$(cat ~/ogevia-prd-before/handler-function-name.txt) && aws lambda update-function-code --function-name "$FN" --s3-bucket "$(sed -n 1p ~/ogevia-prd-before/previous-api-asset.txt)" --s3-key "$(sed -n 2p ~/ogevia-prd-before/previous-api-asset.txt)" --query '[LastUpdateStatus,CodeSha256]' --output text && aws lambda wait function-updated --function-name "$FN" && aws lambda get-function-configuration --function-name "$FN" --query '[LastUpdateStatus,CodeSha256]' --output text && jq -r .CodeSha256 ~/ogevia-prd-before/lambda-config-before.json
```
The last two values must be equal (the code is the baseline again). The 13 routes still exist in API Gateway but the old code answers them with its not-found response; the Staff pages show an error until the web is rolled back (do R1 first). This leaves CloudFormation out of step with the stack: tell the Owner, and reconcile by re-deploying the captured previous template (`~/ogevia-prd-before/live/Ogevia-prd-ServiceVerificationApi.json`, larger than the 51,200-byte inline limit, so it needs an S3 location chosen by the Owner: a separate YELLOW step).

### R2b Auth: the added URLs
The Auth change only **adds** four URLs to the web client; leaving them in place breaks nothing. Reverting them is a separate YELLOW step the Owner approves (re-deploy of the captured template `~/ogevia-prd-before/live/Ogevia-prd-Auth.json` from an S3 location chosen by the Owner, or `aws cognito-idp update-user-pool-client` restoring the URLs in `~/ogevia-prd-before/cognito-client-before.json`: all other settings of the client must be repeated in that call, so it is not prepared here).

### R3 Database: roll back 0086 (BACKUP REQUIRED)
Prepared and rehearsed with a real PostgreSQL. It drops `staff_types` and `staff_profiles` **with their rows** (the counts are printed first) and restores the previous `note_my_sign_in`; sign-ins, memberships, roles and audit events stay. Run it only after the snapshot exists, only if R1 and R2 are done (the old API and web do not use the staff objects, so rolling back the database alone is also safe in that order), and only on the Owner's decision.
```
source ~/ogevia-prd-before/session-env.sh && cd "$PKG" && export OGEVIA_PREDEPLOY_SNAPSHOT_ID=$(cat ~/ogevia-prd-before/snapshot-id.txt) && bash "$S/tarball-pin-check.sh" | tail -1 && bash "$S/apply-0086-prd.sh" rollback
```
Type `OPEN-5432-WINDOW-ROLLBACK-0086-PRD`. Expected: the objects present (`1|1|21`) before, `0|0|0` after, the ledger still `85 / 0085`, the people-and-access counts identical, `note_my_sign_in` restored and no `staff.*` permission left, `RESTORED (verified)`; the marker `db-0086.ok` is removed.

### R4 Snapshot restore (last resort; documented, not prepared, not rehearsed on AWS)
`docs/releases/2026-10-19-test-rehearsal/SNAPSHOT_RESTORE_ISOLATED_e80b770.md` (in the repository; not in this tarball) restores the Step 7 snapshot to a **new** instance with its own security group and copies back only `ogevia_prd`. The snapshot also contains `ogevia_sv_test`, so it is **never** restored in place and the application is never pointed at a restored instance without the Owner's separate approval. Everything written to production after the snapshot is lost for the restored database.

### R5 If the temporary database rule cannot be removed (exit 3), from the second session
The script prints these commands. Identify the one row with cidr `<admin host IP>/32`, tcp 5432, description beginning `TEMP-migrate-` or `TEMP-ledger-check-`:
```
aws ec2 describe-security-group-rules --region us-west-2 --filters Name=group-id,Values=sg-00530a1f4f7648e65 --query 'SecurityGroupRules[?IsEgress==`false`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,cidr:CidrIpv4,sourceSg:ReferencedGroupInfo.GroupId,desc:Description}' --output table
aws ec2 revoke-security-group-ingress --region us-west-2 --group-id sg-00530a1f4f7648e65 --security-group-rule-ids sgr-<id of that one row>
cd "$PKG" && bash "$S/apply-0086-prd.sh" --restore-only; bash "$S/ledger-recheck-prd.sh" --restore-only
```
Never touch the row whose `sourceSg` is `sg-064ffce3bcbe8eb3b` (the application group). The marker (`~/.ogevia-migrate-window/OPEN` or `~/.ogevia-ledger-window/OPEN`) blocks any further run until `--restore-only` verifies the rule set equals the recorded original.

### R6 Lost session, full disk
Open a new CloudShell, `source ~/ogevia-prd-before/session-env.sh`; if `/tmp/ogevia-prd-pkg` is gone repeat Steps 1-4 (nothing in `~/ogevia-prd-before/` depends on `/tmp`). If the home directory is full, delete only `~/ogevia-apply-0086-*` and `~/ogevia-ledger-window-*` run folders **after** pasting their `RESULT.txt` back; never delete `~/ogevia-prd-before/` or `~/ogevia-prd-discovery-capture-20261026/`.

### R7 The gate finds a difference nobody expected
Step 8 stops with a `VIOLATION`. Nothing was changed except the Step 6-7 window and snapshot. Do not apply the difference by hand and do not deploy anything. Paste the Step 8 output; the Owner decides whether this release carries the difference (a separate approval and a different gate).

## 9. Stop conditions (any one stops the procedure; nothing later is run)
A tarball hash that differs; a pin check without `PINS HOLD`; an assembly check that fails (including a Handler asset key that CloudShell does not reproduce); a baseline `FAIL`; a ledger that is not exactly 85 / 0085 at Step 6, inside Step 9 or at Step 16; 0086 already present before Step 9 or absent at Step 16; enforcement activated for any agency; a snapshot that is missing, not `available`, not manual, not encrypted, not of `ogevia-prod-postgres`, or created outside the window; any gate `VIOLATION` (in particular any IAM, security-group, secret, authorizer, stage, deletion, replacement, CORS or callback difference beyond the two origins and the four URLs); `cdk deploy` asking to approve any IAM or security-group change; a post-check `FAIL`; a staff route answering anything but 401 without a valid token; a web check that fails twice; a temporary database rule that cannot be removed (exit 3); an unexpected error from any command. After a stop: paste the full output and wait. Do not continue, do not retry with changed values and do not edit a script or a file in the package.

## 10. What this procedure does not do
It does not deploy `Ogevia-prd-DatabaseSecret`, `-EvidenceStorage`, `-Observability`, `-WebHosting` or the shared `Ogevia-prod-NetworkEgress`, or any `Ogevia-prod-*` stack; does not change Cognito users or the user pool (only the web client's URL lists, in `Ogevia-prd-Auth`), RDS, KMS or bucket policies; does not change security groups other than the one temporary, verified-removed `/32` rule in Steps 6, 9 and 16; does not activate enforcement; does not write a migration-ledger row; does not touch `config.json`, DNS, Netlify or Supabase; does not read, copy, classify or delete any production record (it compares row counts before and after, nothing more); does not copy TEST data into production; does not run the migration runner; does not send invitations or create staff, users or clients; and does not install anything on the operator's machine beyond `pnpm install --frozen-lockfile` in `/tmp`.

## 11. Decisions and approvals this procedure needs from the Owner
1. The GO message: Operator, window (UTC, at most 12 hours), `<REF>`, the tarball sha256, the admin host IP; naming this code commit `f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45`.
2. Written disposition of V1 to V8 for production (`docs/releases/2026-10-26-redesign/PRODUCTION_RELEASE_PREPARATION.md` section 3): TEST exceptions do not carry over.
3. Download the tarball from the development session and upload it to CloudShell.
4. The `--host-ip` `/32` database-access method for Steps 6, 9 and 16 (as approved for the 2026-10-18, 2026-10-19 and 2026-10-26 operations).
5. Accept that R1, R2, R2b, R4, R5 and R7 are documented, not rehearsed against AWS.

## 12. Tests that back this package
Under `infra/aws/test`: `operator-prd-gate.test.ts` (gate and assembly check against the real synthesized templates), `operator-prd-deploy-guard.test.ts`, `operator-prd-apply.test.ts` (the 0086 window script against fake `aws`/`psql`/`npx`), `operator-prd-ledger-recheck.test.ts`, `operator-prd-snapshot-smoke.test.ts`, `operator-prd-web-record.test.ts` (baseline, web guard, deployed record), `operator-prd-tarball.test.ts` (the real builder and the pin check), `operator-prd-procedure.test.ts` (this document cannot drift from the code); and `infra/aws/db/test/operator-prd-sql.db.test.ts` (the exact `psql` command lines and the 110-check verification against a real PostgreSQL with the real migrations). Run: `pnpm --filter @carelik/infra-aws exec vitest run test/operator-prd-*.test.ts` and `pnpm --filter @carelik/infra-aws test:db` (the database test needs `OGEVIA_TEST_DATABASE_URL`). Results of the final run are in `docs/releases/2026-10-26-redesign/PRODUCTION_RELEASE_PREPARATION.md`.
