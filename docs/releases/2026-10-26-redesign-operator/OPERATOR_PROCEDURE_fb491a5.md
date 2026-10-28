# Ogevia TEST UPGRADE: operator procedure from code commit 7870a04 to fb491a5 (tarball delivery; migration 0087 applied on top of 0086, outside the ledger)

> **Status: PROPOSED. NOTHING IN THIS DOCUMENT HAS BEEN RUN AGAINST AWS.** The development container has no AWS CLI and no credentials. Every script was tested locally against fake `aws`, `psql`, `curl` and `npx` programs, against real synthesized templates and, for the SQL, against a real PostgreSQL (section 12). Every step marked **[YELLOW]** changes AWS or TEST data and is run only after the owner's GO message for this exact code commit. **TEST only.** This procedure SUPERSEDES the 7870a04 TEST procedure (executed 2026-10-25/26; its record is `docs/releases/2026-10-26-redesign/DEPLOYED_RECORD_TEST.md` and the original text is in git at `644d6e2`). It upgrades the TEST that runs 7870a04 (migration 0086 already applied, outside the ledger, the file below is byte-identical to the one applied) with the fixes for security-review findings M-1, L-1, L-2 and L-3. Production (`Ogevia-prd-*`, `ogevia_prd`, API `zk527zk4ua`) is never named as a target and is not requested.
>
> **Owner approval this procedure rests on:** "Approved for TEST" (2026-10-26, for the release `2026-10-26-redesign`), the Owner's instruction of 2026-10-28 to implement Option B for M-1 with the L-1, L-2 and L-3 fixes and to prepare the TEST deployment (the GO for THIS deployment is still to be given), and decision **D1 option (b)**: migration 0087 (like 0086 before it) is applied to the TEST database only, from `infra/aws/db/pending`, in **one transaction as `ogevia_owner`**, **without a ledger row**, so the TEST ledger stays exactly **85 / 0085** and the production release package (pinned to 0001-0085) is untouched. The release window, the Operator, the approval reference `<REF>`, the tarball hash and the admin host's IP come from the owner's GO message (decision D4), not from this document.
>
> Labels: **LOCAL VERIFIED** = run in the development container with fakes, real synthesized templates or a real local PostgreSQL. **NOT VERIFIED** = needs AWS, a person at a browser, or another external system. Words used exactly: *implemented*, *tested (where)*, *deployed (where)*, *accepted (by whom)*.

## 1. What is deployed, and the pins

| Item | Value |
|---|---|
| Code commit (what `BUILD_INFO.json` names) | `fb491a554c0fdc484102025179c9c993f694b4e0` (`fb491a5`, branch `claude/magical-lovelace-9y5ras`, parent `773b762`). It is the production-bound candidate `24fd8b17795dd7e0ba6f36eec1791918feefb216` plus migration 0087, the accept route and Handler change, the web invitation panel and the staff-form warning, and their tests; TEST currently runs `7870a04c43545bacc378ad93ffc6a09d63345b5a`. Commits after it on the branch are documentation and this package only; the tarball is built from this exact commit (`--code-commit fb491a554c0fdc484102025179c9c993f694b4e0`), never from the branch tip |
| Delivery | A tarball built by `scripts/build-operator-tarball.sh`: the owner downloads it and uploads it to CloudShell (Actions, Upload files) as `~/ogevia-operator-fb491a5.tar.gz`. There is **no git** in this procedure |
| Tarball sha256 | **Not in this document**: the tarball contains this document. It is printed by the build script and travels in the covering message and the GO message as `OGEVIA_EXPECT_TARBALL_SHA`. Step 1 refuses to extract a tarball whose hash differs |
| Inside the tarball | `BUILD_INFO.json` and `PACKAGE_MANIFEST.sha256` (sha256 of every file); the code is `git archive` of the commit; this package folder is taken from the working tree at build time. The top directory is `ogevia-test-0086-fb491a5` |
| Migration set 0001-0085 | sha256 `de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef` (`sha256sum -- *.sql \| sha256sum` in `infra/aws/db/migrations`). **Identical to the set applied to TEST on 2026-10-19** and unchanged since `e80b770`: no applied migration was edited. The directory holds exactly 85 files and **no 0086** |
| Migrations 0086 (already on TEST) and 0087 (this upgrade), pending, outside the ledger | 0086 `infra/aws/db/pending/migrations/0086_staff_management.sql` sha256 `8eb7b4a353300ba78156bd58a0df6cbc9857b677cec0e8ec51233fcda5a16a4f` (**unchanged**: it is pinned to prove the file TEST holds is the file in this package); rollback `.../rollback/0086_staff_management.down.sql` sha256 `d2773fdfdf502bb2b337b6e8fb888b72f9b9da660bc944f60a7ff60bec8d2942`. 0087 `.../migrations/0087_staff_invitation_acceptance.sql` sha256 `f9d75d8c776005873b6019ca2d76353d182772144b9946cadd3291cdbad4cf88`; rollback `.../rollback/0087_staff_invitation_acceptance.down.sql` sha256 `1789131e12e54317eda1690d8f34f4a396f4d46fa234ba157c1e62caf3c10354`. These four are the only files allowed in `db/pending` (besides its README). **This upgrade applies 0087 only** |
| `pnpm-lock.yaml` | sha256 `7f5964021b4dbeeebf703fda27e1a509c164c1aecb4436f9324003b7de88dcae` |
| Toolchain | Node 22.x, pnpm 9.15.4, CDK CLI 2.1143.0 (from the package), Python 3, `jq`, `curl`, `openssl`, `timeout`, AWS Session Manager plugin, PostgreSQL client 15 or newer |
| Handler code asset | release `2871b03d6be42b0b8c85bac6feea12de75b3d05ca4636610259b6a18e1d00ed7.zip` (TEST runs `94b73574c5a6…` until this upgrade); IdentityHandler unchanged `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip`. **The asset key depends on the build environment**: it was produced in the development container and Step 4 confirms CloudShell produces the same key; if it does not, STOP (section 9) |
| API routes | 242 = the 241 TEST has now + **1** (`POST /v1/me/staff-invitations/{organizationId}/accept`). `scripts/new-route-keys.json` lists the ONE route this upgrade adds (the gate, the post-check and the route smoke use it); the assembly check pins all 14 staff routes |
| Release synthesis fingerprints (deploy mode) | EvidenceStorage `3e14cbbd…`, NetworkEgress `6009b20c…`, WebHosting `5546cc6d…`, ServiceVerificationApi `c2c489ae…`, Observability `bf4f7f32…` (full values in `assembly_check.py`) |
| Web | built on CloudShell with `VITE_APP_ENV=test VITE_APP_VERSION=<the 40-character code SHA>`; the build embeds `VITE_APP_VERSION:"<sha>"` in the main script and Step 11 reads it from the served bundle |

## 2. Decisions the owner answers before the window

| # | Decision | What the procedure does |
|---|---|---|
| D1 | How 0087 reaches TEST | **As 0086 did (decided):** `apply-0087-test.sh` runs the pinned file in one transaction as `ogevia_owner`, no ledger row, on top of 0086. Consequence: TEST stays two migrations "ahead" of its ledger (85 / 0085). Promotion to production later is the production package (0086 then 0087 in one transaction); the TEST database would then need the ledger rows adopted or both down scripts run first (a separate approval) |
| D2 | Are the hostnames live on TEST? | **Yes, since the 7870a04 deployment:** the 7870a04 TEST deployment (record `DEPLOYED_RECORD_TEST.md`) made the live templates equal the release, including the demo CORS origin. The gate therefore allows NO hostname, CORS or callback difference any more: the old one-origin catch-up allowance was removed. Any such difference **stops** Step 8 |
| D3 | Shared resources (RDS instance, VPC, endpoint policy) | Only `ogevia_sv_test`, the TEST API stack and the TEST web files change. The Handler code and ONE route are the only API-stack changes. `NetworkEgress`, `EvidenceStorage`, `WebHosting`, `Observability` are never deployed (only checked for "no difference") |
| D4 | Window (UTC, at most 12 hours), Operator, approval reference | In the GO message. The window bounds the snapshot and the 0087 apply |
| D5 | Demo users see the new menu the moment the web files change; UAT invitations create real Cognito users and send real email in the TEST pool | Use inboxes the owner controls; warn anyone using Demo |

## 3. How production and the shared database are protected

1. **Only one stack can be deployed**, and only through `deploy-guard.sh`: exactly `Ogevia-prod-ServiceVerificationApi`, one stack per call, with the command the script builds itself: `npx cdk deploy --app /tmp/ogevia-cdk.out --exclusively Ogevia-prod-ServiceVerificationApi --require-approval broadening --no-notices`. A production name, a glob, a list, `--all`, `--force`, `--hotswap`, `--no-rollback` and `--concurrency` are refused before anything is read. The other four TEST stacks can only be `check`ed and must show **no difference**.
2. **No `Ogevia-prd-*` stack is deployed**; the assembly holds only the five `Ogevia-prod-*` stacks (checked); `route-smoke.sh` refuses the production API id.
3. The database script connects only to `ogevia_sv_test` (`-d ogevia_sv_test`), never names `ogevia_prd`, refuses unless the Lambda serves `ogevia_sv_test`, and writes **no ledger row** (a test fails if any ledger write appears in the script).
4. 0087 is **additive**: it adds 2 API functions (`list_my_staff_invitations`, `accept_staff_invitation`: SECURITY DEFINER, fixed `search_path`, `ogevia_app` execute only) and replaces 5 functions from 0086 (`complete_staff_invitation`, `note_my_sign_in`, `list_staff`, `update_staff`) with fixed versions. It creates no table, trigger or permission and drops, deletes and updates no row. A membership created under 0086 stays exactly as it is (active). `verify-0086.sql` (110 read-only checks, still all passing) and `verify-0087.sql` (24 read-only checks) must pass before the API is deployed.
5. The people-and-access tables (`app_users`, `organization_memberships`, `audit_events`, `caregiver_records`, `organizations`) must have **identical row counts** before and after the apply, and the ledger must still read 85 / 0085.
6. Enforcement is read (never changed) before and after; any activated agency stops the run.

## 4. Prerequisites (before the window)

- Owner GO message naming: the Operator; the release window as UTC start and end; the approval reference `<REF>` (6-64 characters of `A-Za-z0-9._-`); the tarball sha256; and the admin host's private IP (the host tagged `ogevia-db-admin-temp`).
- AWS CloudShell, region `us-west-2`, account `300094796789`. **A second CloudShell session open and ready for recovery** (section 8).
- **Disk:** everything large goes to `/tmp` (pnpm store, `node_modules`, the extracted package, the assembly, the web build). Only small files (the tarball, `~/ogevia-before/`) live in the home directory.
- TEST freeze: nobody schedules, edits or confirms on TEST from Step 9 until Step 11 is done. Nobody invites staff on TEST during the window.
- Demo users warned (D5).

## 5. Procedure

Each step has one command block. "Paste back" is the evidence sent before the next step. **Any output not listed under Expected is a stop** (section 9).

### Step 0 - Session variables and tool check (no change to AWS)
Replace the `<...>` values with those in the GO message, then paste the block.
```
TARBALL_SHA=<64 hex from the GO message>; REF=<approval reference>; WSTART=<UTC start, e.g. 2026-10-27T03:00:00Z>; WEND=<UTC end>; HOSTIP=<admin host private IP>
mkdir -p ~/ogevia-before && cat > ~/ogevia-before/session-env.sh <<EOF
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" PYTHONDONTWRITEBYTECODE=1 CDK_DISABLE_CLI_TELEMETRY=true
export OGEVIA_BEFORE=\$HOME/ogevia-before PKG=/tmp/ogevia-pkg ASSEMBLY=/tmp/ogevia-cdk.out
export S=/tmp/ogevia-pkg/docs/releases/2026-10-26-redesign-operator/scripts
export OGEVIA_EXPECT_COMMIT=fb491a554c0fdc484102025179c9c993f694b4e0
export OGEVIA_EXPECT_MIGRATIONS_SHA=de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef
export OGEVIA_EXPECT_0086_SHA=8eb7b4a353300ba78156bd58a0df6cbc9857b677cec0e8ec51233fcda5a16a4f
export OGEVIA_EXPECT_0086_DOWN_SHA=d2773fdfdf502bb2b337b6e8fb888b72f9b9da660bc944f60a7ff60bec8d2942
export OGEVIA_EXPECT_0087_SHA=f9d75d8c776005873b6019ca2d76353d182772144b9946cadd3291cdbad4cf88
export OGEVIA_EXPECT_0087_DOWN_SHA=1789131e12e54317eda1690d8f34f4a396f4d46fa234ba157c1e62caf3c10354
export OGEVIA_EXPECT_LOCKFILE_SHA=7f5964021b4dbeeebf703fda27e1a509c164c1aecb4436f9324003b7de88dcae
export OGEVIA_APP_ENV=test VITE_APP_ENV=test VITE_APP_VERSION=fb491a554c0fdc484102025179c9c993f694b4e0
export OGEVIA_EXPECT_TARBALL_SHA=$TARBALL_SHA OGEVIA_TARBALL_SHA256=$TARBALL_SHA OGEVIA_DEPLOY_APPROVAL=$REF
export OGEVIA_RELEASE_WINDOW_START=$WSTART OGEVIA_RELEASE_WINDOW_END=$WEND OGEVIA_EXPECT_HOST_IP=$HOSTIP
EOF
source ~/ogevia-before/session-env.sh && echo "$AWS_REGION $AWS_DEFAULT_REGION [$AWS_PAGER]" && node --version && pnpm --version && for t in jq curl openssl python3 timeout session-manager-plugin psql; do command -v $t >/dev/null && echo "ok $t" || echo "MISSING $t"; done; df -h /tmp ~ | cat; ls -l ~/ogevia-operator-fb491a5.tar.gz
```
Expected: `us-west-2 us-west-2 []`; `v22.x.y`; `9.15.4`; `ok` for all seven tools; `/tmp` with at least 3 GB available; the tarball listed. Stop: any `MISSING`, Node not 22.x, pnpm not 9.15.4 (install pnpm yourself into `/tmp`: `npm install --prefix /tmp/pnpm-tool pnpm@9.15.4 && export PATH=/tmp/pnpm-tool/node_modules/.bin:$PATH`). Paste back: the output.

### Step 1 - Verify the uploaded tarball and extract it into /tmp (no change to AWS)
```
source ~/ogevia-before/session-env.sh && cd ~ && echo "$OGEVIA_EXPECT_TARBALL_SHA  ogevia-operator-fb491a5.tar.gz" | sha256sum -c - && rm -rf "$PKG" /tmp/ogevia-x && mkdir -p /tmp/ogevia-x && tar -xzf ~/ogevia-operator-fb491a5.tar.gz -C /tmp/ogevia-x && mv /tmp/ogevia-x/ogevia-test-0086-fb491a5 "$PKG" && rmdir /tmp/ogevia-x && jq . "$PKG/BUILD_INFO.json" && (cd "$PKG" && sha256sum -c --quiet PACKAGE_MANIFEST.sha256 && echo "manifest ok: $(wc -l < PACKAGE_MANIFEST.sha256) files")
```
Expected: `ogevia-operator-fb491a5.tar.gz: OK`; `BUILD_INFO.json` with `"code_commit": "fb491a554c0fdc484102025179c9c993f694b4e0"`; `manifest ok: N files`. Stop: `FAILED` or any non-zero exit (re-upload; never extract a file that fails). Paste back: the output.

### Step 2 - Install dependencies in /tmp (no change to AWS)
```
source ~/ogevia-before/session-env.sh && [ "$(df --output=avail -k /tmp | tail -1)" -gt 3000000 ] && cd "$PKG" && pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store 2>&1 | tail -15 && df -h /tmp | cat
```
Expected: the install finishes (`Done in ...`). Stop: any install error, `ERR_PNPM_OUTDATED_LOCKFILE` (never use `--no-frozen-lockfile`), `No space left on device`. Recovery: `rm -rf /tmp/pnpm-store "$PKG/node_modules"` and repeat. Paste back: the tail and `df`.

### Step 3 - Pin check (no change to AWS)
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/tarball-pin-check.sh"
```
Expected (all `PASS`, last line `PINS HOLD`): BUILD_INFO code commit `fb491a55…`; PACKAGE_MANIFEST verifies; no file outside the manifest; migration set `de0c8abbe12023ba…`; migrations 0001-0085 equal the set applied to TEST on 2026-10-19; `db/migrations` holds exactly the 85 released files and no 0086 or 0087; 0086 up `8eb7b4a353300ba7…` and down `d2773fdfdf502bb2…` (unchanged); 0087 up `f9d75d8c77600587…` and down `1789131e12e54317…`; `db/pending` holds only the four 0086 and 0087 files; `pnpm-lock.yaml` `7f5964021b4dbeee…`; `node v22`, `pnpm 9.15.4`, dependencies installed, `cdk 2.1143.0`. The note about the placeholder approval reference is normal. Stop: any `FAIL` or no `PINS HOLD`. Paste back: the output.

### Step 4 - Synthesize outside the repository and check the assembly (no change to AWS)
```
source ~/ogevia-before/session-env.sh && cd "$PKG/infra/aws" && rm -rf "$ASSEMBLY" && PATH="$PWD/node_modules/.bin:$PATH" npx cdk synth --quiet --no-notices -c env=prod -c mode=deploy -o "$ASSEMBLY" && python3 -I -B "$S/assembly_check.py" --assembly "$ASSEMBLY" && cd "$PKG" && bash "$S/tarball-pin-check.sh" | tail -2
```
Expected: `assembly_check.py` prints `PASS` for: exactly the five `Ogevia-prod-*` stacks and no `Ogevia-prd-*`; Handler asset `2871b03d6be4…`; IdentityHandler `7c5f8eb676c9…`; 242 API routes; each of the 14 staff routes present once; exactly one EventBridge rule, `State ENABLED`; exactly two Lambda permissions; each stack equal to the release synthesis; then `PASS all checks`; and `PINS HOLD`. **Stop:** `FAIL Handler code asset`: CloudShell produced a different build than the development container; do not deploy, paste the output (the pinned key is reproducible only if the toolchain matches). Paste back: the `PASS`/`FAIL` lines.

### Step 5 - Read-only baseline and recovery capture
Records what TEST is now and captures everything recovery needs (previous API code, route list, CORS, web bucket, hostnames). Reads only (describe, list, get, `s3 sync` downloads); writes files under `~/ogevia-before/`.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/baseline-capture.sh"
```
Expected: `account 300094796789`; each stack `CREATE_COMPLETE` or `UPDATE_COMPLETE`; the **TEST API URL** and **TEST web URL**; for each stack the line `<stack>: EXPECTED-ONLY: YES (...)`  (a `WARN` for a stack, or `NO` for WebHosting or ServiceVerificationApi, is information: **Step 8 is the authoritative gate and will stop on it**); `PASS the accept route does not exist yet (this upgrade adds it)`; `PASS the Lambda serves ogevia_sv_test`; `PASS captured code zip hash equals the live CodeSha256`; `PASS previous API code asset ... exists`; the API id, the route count, the CORS origins, the CloudFront aliases and the Cognito callbacks; `PASS RDS available, not publicly accessible, encrypted`; web files captured; `PASS ComplianceSweep is ENABLED`; `BASELINE CAPTURED`. Stop: any `FAIL`. Paste back: the output (it is the only record of the "before" state).

### Step 6 - Ledger recheck: exactly 85 / 0085, 0086 present and 0087 absent [YELLOW: one temporary database-access rule]
Re-reads the TEST ledger through one inbound rule on the RDS security group (tcp 5432 from the admin host's own IP as `/32`), removed and hash-verified on every exit path.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && OGEVIA_EXPECT_LEDGER_COUNT=85 OGEVIA_EXPECT_LEDGER_LATEST=0085 OGEVIA_EXPECT_0086=present OGEVIA_EXPECT_0087=absent bash "$S/ledger-recheck.sh" test --host-ip
```
Type `OPEN-5432-WINDOW` only after reading the proposed change. Expected: `connected: ogevia_sv_test | read_only=on`; `enforcement activated for 0 of N agencies`; `staff-management objects (staff_types|staff_profiles|functions of 21): 1|1|21`; `0086 is PRESENT as expected (2 tables, 21 functions).`; `0087 objects (functions of 2): 0`; `0087 is ABSENT as expected.`; `NO ROW is above 0085: the TEST ledger is exactly the expected 85 / 0085`; `RESTORED (verified)`; `SECURITY GROUP: restored and verified identical to the original`; exit 0. Stop: any other result (a ledger of 86 means someone ran the runner; 0086 objects not `1|1|21` or 0087 objects not `0` mean TEST is not in the state this upgrade starts from: **do not continue**). Paste back: the output.

### Step 7 - Named pre-deployment snapshot and its verification [YELLOW: one `create-db-snapshot`]
A restore point taken inside the owner's window, named `ogevia-prod-postgres-pre-0087-YYYYMMDDHHMM`. The instance also holds `ogevia_prd`, so this snapshot is a **prerequisite only**: it is never restored in place (R4).
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && date -u +%FT%TZ && bash "$S/snapshot-verify.sh" create
```
Expected: the time is inside the window; `creating ogevia-prod-postgres-pre-0087-<stamp>`; then `status=available instance=ogevia-prod-postgres type=manual created=<time inside the window> encrypted=True`; `SNAPSHOT VERIFIED`. The id is saved in `~/ogevia-before/snapshot-id.txt`. Stop: anything else; an unverified snapshot means no later step may run. Paste back: the output.

### Step 8 - Infrastructure gates for all five stacks (read-only)
For each stack: fetch the live template, run the assembly check and `cdk diff`, and apply the machine gate (`diff_gate.py`: the allow-list is the ONE accept route and the Handler code asset for the API stack, and nothing at all for the other four). **No deployment.** Done before any database change so an unexpected difference costs nothing.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && for s in EvidenceStorage NetworkEgress WebHosting Observability ServiceVerificationApi; do bash "$S/deploy-guard.sh" check Ogevia-prod-$s || break; done
```
Expected: for the first four stacks `ALLOWED Ogevia-prod-<stack> has NO difference from the live stack`, `EXPECTED-ONLY: YES (NONE)`, `CHECK PASSED ... (NONE)`; for `ServiceVerificationApi`: `ALLOWED 1 staff API route(s) added, each JWT-authorized like the existing routes`, exactly one `ALLOWED Lambda Handler... code asset 94b73574c5a6... -> 2871b03d6be4...`, `EXPECTED-ONLY: YES (DELTA)`, `CHECK PASSED ... (DELTA)`. **Stop:** any `VIOLATION`. A violation on `WebHosting` or on the HTTP API resource (CloudFront alias or certificate, Cognito callback URLs, CORS origins) means TEST differs from what the 7870a04 deployment left: do not change anything by hand; paste the output and wait for the owner. Anything else is also a stop: IAM, security-group, secret, authorizer, stage, rule, log, deletion or replacement. Paste back: the output.

### Step 9 - Apply migration 0087 to the TEST database (on top of 0086) [YELLOW]
One transaction as `ogevia_owner`, no ledger row; temporary rule as in Step 6; the snapshot is re-verified first. The script proves the package, the connection to `ogevia_sv_test` (read-only session), the ledger (85 / 0085), that the 0086 objects are present and the 0087 objects absent, and records the people-and-access row counts and the enforcement state; then runs the one transaction; then re-reads everything and runs `verify-0086.sql` (110 checks), `verify-0087.sql` (24 checks) and the runner's own verification set; only then it closes the window.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && date -u +%FT%TZ | tee ~/ogevia-before/M0.txt && export OGEVIA_PREDEPLOY_SNAPSHOT_ID=$(cat ~/ogevia-before/snapshot-id.txt) && bash "$S/tarball-pin-check.sh" | tail -1 && bash "$S/apply-0087-test.sh" apply
```
Type `OPEN-5432-WINDOW-APPLY-0087-TEST` only after reading the proposed changes. Expected lines: `package commit fb491a55..., manifest verified (N files), no stray file`; `snapshot ogevia-prod-postgres-pre-0087-<stamp>: available, manual, belongs to ogevia-prod-postgres, created ... inside the release window`; `window open: exactly one rule was added`; `connected: ogevia_sv_test | read_only=on`; `ledger before: 85 migrations applied, latest 0085`; `staff-management objects (...): 1|1|21` and `0087 objects (functions of 2): 0`; the before counts; after the transaction `1|1|21` and `2`, the ledger still `85 / 0085`, the counts identical; `verify-0086.sql: 110 checks, 0 failing`; `verify-0087.sql: 24 checks, 0 failing`; `runner verification set: N PASS, 0 FAIL`; `RESULT: 0087 applied on top of 0086 (2 new functions, 5 replaced); ledger 85 / 0085 unchanged; people and access unchanged; verify-0086.sql 110 PASS, verify-0087.sql 24 PASS`; `RESTORED (verified)`. Stop and **do not deploy the API or web** on: `APPLY FAILED` (the transaction rolled back; nothing of 0087 was kept: paste the output), a ledger that is not 85 / 0085, changed counts, a verification that fails (0087 IS applied: paste the output; section 8 R3 is the owner's decision), exit 3 (the rule could not be removed: R5 first). Paste back: the output and `RESULT.txt` from the printed run folder.

### Step 10 - Deploy `Ogevia-prod-ServiceVerificationApi` [YELLOW], then check
One stack only. The guard repeats the Step 8 gate (it must say `DELTA`; "nothing to deploy" is a refusal), shows the exact command and waits for the typed phrase.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/tarball-pin-check.sh" | tail -1 && bash "$S/deploy-guard.sh" deploy Ogevia-prod-ServiceVerificationApi && bash "$S/deploy-guard.sh" post Ogevia-prod-ServiceVerificationApi
```
Type `DEPLOY-Ogevia-prod-ServiceVerificationApi` only after reading the gate output. Expected: `PINS HOLD`; the Step 8 gate again (`DELTA`); `ABOUT TO RUN (YELLOW): npx cdk deploy --app /tmp/ogevia-cdk.out --exclusively Ogevia-prod-ServiceVerificationApi --require-approval broadening --no-notices`; CDK should **not** ask for approval (no IAM or security-group change; one new route and a code asset only). **If CDK shows an "IAM Statement Changes" or "Security Group Changes" table, answer `n` and stop.** Then the post check: `PASS Ogevia-prod-ServiceVerificationApi is UPDATE_COMPLETE`, `PASS Lambda environment unchanged`, `PASS the Lambda code changed`, `PASS LastUpdateStatus Successful`, `PASS the API gained exactly 1 route`, `PASS the added staff route exists`, `PASS no earlier route was lost`, `PASS CORS configuration unchanged`, `PASS ComplianceSweep still ENABLED`, `POST-CHECK PASSED`. Stop: anything else; do not deploy anything else. Recovery: R2. Paste back: the output.

### Step 11 - Web build and publish [YELLOW], then verify what is served
Builds `apps/web` from the package with the TEST banner and the code SHA as version and publishes the way the earlier operation did (`deploy-test-slice.sh web`: assets first with the immutable cache header, then `index.html` with `no-cache`, no `--delete`, never `config.json`, CloudFront invalidation of `/index.html` and `/`).
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/tarball-pin-check.sh" | tail -1 && bash infra/aws/scripts/deploy-test-slice.sh web && sleep 60 && bash "$S/web-verify.sh"
```
Expected: `PINS HOLD`; the vite build output (a chunk-size warning is normal); S3 upload lines; then `PASS the served index.html is the one just built`, `PASS main script assets/index-<hash>.js`, `PASS the bundle carries the code SHA fb491a55...`, `PASS built for TEST`, `PASS config.json unchanged` (or the NOTE that the capture has none), `WEB VERIFIED`. If only the first check fails, wait a minute and rerun `web-verify.sh` once (CloudFront cache); otherwise stop. Recovery: R1. Paste back: the output.

### Step 12 - Post-deployment smoke (read-only)
The earlier smoke (the API refuses anonymous calls; the web serves the app with security headers) plus the new accept route: **no token → 401** and **forged token → 401** (2 calls), and one CORS preflight from `https://demo.ogevia.com`. The calls carry no credentials; the authorizer answers before any code runs.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash infra/aws/scripts/deploy-test-slice.sh smoke && bash "$S/route-smoke.sh"
```
Expected: `Smoke OK: API rejects anonymous calls; web origin serves the app with security headers.`; 2 lines `PASS POST /v1/me/staff-invitations/{organizationId}/accept (none|forged token): 401`; `PASS CORS preflight from https://demo.ogevia.com`; `ROUTE SMOKE PASSED: 1 route x 2 calls, all 401; CORS preflight ok`. Stop: any other code (a `200` on a staff route is a **P0**: roll back R2 at once and report). Paste back: the output.

### Step 13 - Acceptance on TEST with real accounts (manual; synthetic data only)
Use the TEST web URL from Step 5 (the "TEST - synthetic data only" banner is visible). The scripts per validator (Owner, Scheduler, Caregiver on a phone, Authorization recalculation) and the case IDs are in `docs/releases/2026-10-26-redesign/DEPLOY_PLAN_TEST.md` section 9 and `FEATURE_TEST_PLAN.md`; they are not repeated here. Minimum before the next step: sign in as the Owner; the menu shows Dashboard, Clients, Staff, Scheduling, Operations, Settings; open **Staff**, **Staff Types** and **Roles & Permissions** with no error screen; add one synthetic staff member and see it listed; open Reports and run one report. Then run the invitation-acceptance checks in `docs/releases/2026-10-28-staff-invitation-fix/V4_READINESS.md` (M-1, L-1, L-2, L-3 and the same-agency Caregiver check). Stop: any error screen on a Staff page (the API or database is not what the web expects: R1). Paste back: pass/fail per item and, for a failure, the screen text and time.

### Step 14 - ComplianceSweep still runs and still does nothing (read-only; within 20 minutes after Step 10)
```
source ~/ogevia-before/session-env.sh && FN=$(cat ~/ogevia-before/handler-function-name.txt) && aws logs filter-log-events --log-group-name "/aws/lambda/$FN" --filter-pattern '"compliance-sweep"' --start-time $(( ($(date +%s) - 1500) * 1000 )) --query 'events[-3:].message' --output text && aws events list-rules --query 'Rules[?contains(Name,`ComplianceSweep`)].[Name,State]' --output text
```
Expected: JSON log lines with `"task":"compliance-sweep"`, `"organizations":0`, `"evaluated":0`, `"holdsOpened":0`, `"holdsReleased":0`, `"failedOrganizations":0`; the rule `ENABLED`. (If the log group has another name: `aws logs describe-log-groups --log-group-name-prefix /aws/lambda/Ogevia-prod-ServiceVerificationApi`.) Paste back: the output.

### Step 15 - Final database read: 85 / 0085, 0086 and 0087 present, enforcement unchanged [YELLOW: one temporary database-access rule]
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && OGEVIA_EXPECT_LEDGER_COUNT=85 OGEVIA_EXPECT_LEDGER_LATEST=0085 OGEVIA_EXPECT_0086=present OGEVIA_EXPECT_0087=present bash "$S/ledger-recheck.sh" test --host-ip
```
Type `OPEN-5432-WINDOW`. Expected: `staff-management objects (...): 1|1|21`; `0086 is PRESENT as expected (2 tables, 21 functions).`; `0087 objects (functions of 2): 2`; `0087 is PRESENT as expected (2 functions).`; `NO ROW is above 0085: the TEST ledger is exactly the expected 85 / 0085, and enforcement is activated for 0 of N agencies as expected`; `RESTORED (verified)`; exit 0. Stop: any other result. Paste back: the output.

### Step 16 - Record the DEPLOYED SHA (read-only)
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && bash "$S/record-deployed.sh"
```
Expected: `PASS BUILD_INFO code commit`; `PASS Lambda CodeSha256 <b64> (before: <old b64>)`; `PASS the DEPLOYED stack's Handler asset is the release's pinned build 2871b03d...zip`; `PASS Lambda LastUpdateStatus Successful`; `PASS web bundle version string = fb491a55...`; then the record (`DEPLOYED SHA : fb491a554c0fdc484102025179c9c993f694b4e0`, tarball sha256, Lambda CodeSha256 in base64 and hex, the Handler asset, stack statuses, the TEST URLs) and `RECORDED: every deployed artifact maps to fb491a55...`. It is saved as `~/ogevia-before/DEPLOYED_RECORD.txt`. Stop: any `FAIL` or `STOP:`. Paste back: the whole output; the development session writes a new dated deployed record (`docs/releases/2026-10-28-staff-invitation-fix/DEPLOYED_RECORD_TEST_fb491a5.md`) from it; the earlier `DEPLOYED_RECORD_TEST.md` for 7870a04 is not overwritten. **Deployed means: this record exists and the owner has the TEST link; accepted means the Phase D sign-offs.**

## 6. Evidence the operator pastes back (summary)
Step 0 tool/disk output; 1 hash and manifest; 2 install tail; 3 pin check; 4 assembly check; 5 baseline (URLs, CodeSha256 before, route count, CORS, hostnames, RDS state); 6 ledger `85 / 0085` with 0086 present and 0087 absent; 7 snapshot id and verification; 8 all five gates; 9 the apply output and `RESULT.txt`; 10 deploy and post check; 11 web verify; 12 smoke and route smoke; 13 manual pass/fail; 14 sweep; 15 final ledger with 0086 and 0087 present; 16 the deployed record. The release checklist (`docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`, instance `docs/releases/2026-10-26-redesign/CHECKLIST.md`) is completed from this evidence by the development session; it is not completed by this package.

## 7. Evidence status
| | LOCAL VERIFIED | NOT VERIFIED |
|---|---|---|
| Tarball | built twice byte-identically; 0086 and 0087 only in `db/pending`; a build with 0086 in `migrations/` refused; pin check fails on a wrong commit, migration set, 0086 file, down file, lockfile, toolchain, a changed, missing or stray file, and when `sha256sum` fails silently | the upload through CloudShell; that CloudShell reproduces the Handler asset key (Step 4 decides) |
| SQL | the pinned 0086 file then the pinned 0087 file apply in one transaction as `ogevia_owner` on a real PostgreSQL holding the real 0001-0085 migrations, and 0087 alone applies on top of a database that already has 0086; `verify-0086.sql` reports 110 and `verify-0087.sql` 24 passing checks; 15 sabotage cases each turn a check red; the rollback restores the earlier state (also with staff data present); apply, rollback and re-apply round-trips | RDS (the real instance, secret and tunnel) |
| Database script | pins, snapshot (21 refusal cases), 0086 state, ledger 85 / 0085 before and after, people-and-access counts, failing transaction, interruption, failed revoke, `--restore-only`, rollback and its post-check, no ledger write | the real tunnel, secret and RDS |
| Diff gate | the real 7870a04 (live) and fb491a5 (release) templates: DELTA for the API only; NONE for the other four; 25+ negative cases (route removed, altered, a second route, not JWT, other integration, IAM/permission/authorizer/stage/rule/secret change, Handler environment change, unknown stack, malformed input); any CORS, hostname or callback difference stops | the live templates |
| Deploy guard | exact command; refusals (production stack, glob, list, `--all`, other stacks); phrase required; post checks pass and fail correctly | `cdk deploy` itself |
| Web and routes | web-verify and route-smoke against fakes (bytes compared from a file; bundle version and TEST; 2 calls, CORS) | the CloudFront publish; the real authorizer |

## 8. Recovery
Open the second session now. Order of recovery is the reverse of deployment: **web, then API, then database.** All recovery commands are YELLOW and, apart from R3, **NOT REHEARSED against AWS**.

### R1 Web: restore the captured files
The deployment never deletes (no `--delete`); assets are content-hashed, so the old files are still in the bucket; `~/ogevia-before/web-before/` is the whole bucket captured in Step 5 with a hash manifest.
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
Expected: `capture intact`; `files to restore from the capture: 0` (normal); no `STOP:` line (a `STOP:` line means the capture itself is incomplete: do not restore the page, report). Afterwards `curl -sS "$(cat ~/ogevia-before/web-url-before.txt)/index.html" | sha256sum` must equal `~/ogevia-before/web-index-sha256-before.txt`.

### R2 API: previous code
Quick rollback (code only): the previous Lambda code is still in the CDK asset bucket (Step 5 verified it; `~/ogevia-before/previous-api-asset.txt` holds the bucket and key).
```
source ~/ogevia-before/session-env.sh && FN=$(cat ~/ogevia-before/handler-function-name.txt) && aws lambda update-function-code --function-name "$FN" --s3-bucket "$(sed -n 1p ~/ogevia-before/previous-api-asset.txt)" --s3-key "$(sed -n 2p ~/ogevia-before/previous-api-asset.txt)" --query '[LastUpdateStatus,CodeSha256]' --output text && aws lambda wait function-updated --function-name "$FN" && aws lambda get-function-configuration --function-name "$FN" --query '[LastUpdateStatus,CodeSha256]' --output text && jq -r .CodeSha256 ~/ogevia-before/lambda-config-before.json
```
The last two values must be equal (the code is the baseline again). The accept route still exists in API Gateway but the old code answers it with its not-found response; the invitation panel shows an error until the web is rolled back (R1: do R1 first). This leaves CloudFormation out of step with the stack: tell the owner, and reconcile by re-deploying the captured previous template (`~/ogevia-before/live/Ogevia-prod-ServiceVerificationApi.json`, larger than the 51,200-byte inline limit, so it needs an S3 location chosen by the owner: a separate YELLOW step).

### R3 Database: roll back 0087 only (0086 stays)
Prepared and rehearsed with a real PostgreSQL (`staff-management.db.test.ts`, "0087 rolls back on its own"). It drops the two acceptance functions and restores the 0086 versions of the five replaced functions. It touches no table and no row. **A membership that 0087 left in status `invited` stays as it is**: under 0086 it grants nothing, and the Owner can see it as "Invited". After this rollback an invitation to an e-mail that already has a sign-in makes that person an active member at once (the 0086 behaviour that finding M-1 describes), so do not invite anyone on TEST afterwards until 0087 is applied again. Run it only after the snapshot exists, and only if R1 and R2 are done.
```
source ~/ogevia-before/session-env.sh && cd "$PKG" && export OGEVIA_PREDEPLOY_SNAPSHOT_ID=$(cat ~/ogevia-before/snapshot-id.txt) && bash "$S/tarball-pin-check.sh" | tail -1 && bash "$S/apply-0087-test.sh" rollback
```
Type `OPEN-5432-WINDOW-ROLLBACK-0087-TEST`. Expected: 0086 `1|1|21` and 0087 `2` before, 0086 `1|1|21` and 0087 `0` after, the ledger still `85 / 0085`, the people-and-access counts identical, `note_my_sign_in` on its 0086 definition and the two `staff.*` permissions still present, `RESTORED (verified)`. Rolling back 0086 itself (dropping the staff tables) is NOT part of this upgrade; the 0086 rollback (`apply-0086-test.sh` of the 7870a04 package, in git at `644d6e2`) is a separate decision.

### R4 Snapshot restore (last resort; documented, not prepared, not rehearsed on AWS)
`docs/releases/2026-10-19-test-rehearsal/SNAPSHOT_RESTORE_ISOLATED_e80b770.md` (in the repository; not in this tarball) restores the Step 7 snapshot to a **new** instance with its own security group and copies back only `ogevia_sv_test`. The snapshot also contains `ogevia_prd`, so it is **never** restored in place and the application is never pointed at a restored instance without the owner's separate approval. Everything written to TEST after the snapshot is lost for the restored database.

### R5 If the temporary database rule cannot be removed (exit 3), from the second session
The script prints these commands. Identify the one row with cidr `<admin host IP>/32`, tcp 5432, description beginning `TEMP-migrate-` or `TEMP-ledger-check-`:
```
aws ec2 describe-security-group-rules --region us-west-2 --filters Name=group-id,Values=sg-00530a1f4f7648e65 --query 'SecurityGroupRules[?IsEgress==`false`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,cidr:CidrIpv4,sourceSg:ReferencedGroupInfo.GroupId,desc:Description}' --output table
aws ec2 revoke-security-group-ingress --region us-west-2 --group-id sg-00530a1f4f7648e65 --security-group-rule-ids sgr-<id of that one row>
cd "$PKG" && bash "$S/apply-0087-test.sh" --restore-only; bash "$S/ledger-recheck.sh" --restore-only
```
Never touch the row whose `sourceSg` is `sg-064ffce3bcbe8eb3b` (the application group). The marker (`~/.ogevia-migrate-window/OPEN` or `~/.ogevia-ledger-window/OPEN`) blocks any further run until `--restore-only` verifies the rule set equals the recorded original.

### R6 Lost session, full disk
Open a new CloudShell, `source ~/ogevia-before/session-env.sh`; if `/tmp/ogevia-pkg` is gone repeat Steps 1-4 (nothing in `~/ogevia-before/` depends on `/tmp`). If the home directory is full, delete only `~/ogevia-apply-0087-*` and `~/ogevia-ledger-window-*` run folders **after** pasting their `RESULT.txt` back; never delete `~/ogevia-before/`.

### R7 TEST differs from what 7870a04 left (Step 8 stops)
Step 8 stops with a `VIOLATION` on WebHosting, on the HTTP API resource or on anything outside the accept route and the Handler code. Nothing was changed except the Step 6-7 window and snapshot. Do not apply the difference by hand and do not deploy `WebHosting`. Paste the Step 8 output; the owner decides (a separate approval and a different gate).

## 9. Stop conditions (any one stops the procedure; nothing later is run)
A tarball hash that differs; a pin check without `PINS HOLD`; an assembly check that fails (including a Handler asset key that CloudShell does not reproduce); a baseline `FAIL`; a ledger that is not exactly 85 / 0085 at Step 6, inside Step 9 or at Step 15; 0086 already present before Step 9 or absent at Step 15; enforcement activated for any agency; a snapshot that is missing, not `available`, not manual, not encrypted, not of `ogevia-prod-postgres`, or created outside the window; any gate `VIOLATION` (in particular any hostname, IAM, security-group, secret, authorizer, stage, deletion or replacement difference); `cdk deploy` asking to approve any IAM or security-group change; a post-check `FAIL`; a staff route answering anything but 401 without a valid token; a web check that fails twice; a temporary database rule that cannot be removed (exit 3); an unexpected error from any command. After a stop: paste the full output and wait. Do not continue, do not retry with changed values and do not edit a script or a file in the package.

## 10. What this procedure does not do
It does not deploy `Ogevia-prd-*`, `Ogevia-prod-EvidenceStorage`, `-NetworkEgress`, `-WebHosting` or `-Observability`; does not change Cognito, RDS, KMS or bucket policies; does not change security groups other than the one temporary, verified-removed `/32` rule in Steps 6, 9 and 15; does not activate enforcement; does not write a migration-ledger row; does not touch `config.json`, DNS, Netlify, Supabase, or any production database, user or object; does not create, delete or modify Cognito users; does not run the migration runner against TEST; and does not install anything on the operator's machine beyond `pnpm install --frozen-lockfile` in `/tmp`.

## 11. Decisions and approvals this procedure needs from the owner
1. The GO message (D4): Operator, window (UTC, at most 12 hours), `<REF>`, the tarball sha256, the admin host IP; naming this code commit `fb491a554c0fdc484102025179c9c993f694b4e0`.
2. Confirmation that TEST is the 7870a04 state this upgrade starts from (Steps 5, 6 and 8 prove it; any difference stops).
3. D5: demo users warned; invitation inboxes the owner controls.
4. Download the tarball from the development session and upload it to CloudShell.
5. The `--host-ip` `/32` database-access method for Steps 6, 9 and 15 (as approved for the 2026-10-18 and 2026-10-19 operations).
6. Accept that R1, R2, R4, R5 and R7 are documented, not rehearsed against AWS.

## 12. Tests that back this package
Under `infra/aws/test`: `operator-0086-tarball.test.ts` (build script and pin check), `operator-0086-diff-gate.test.ts` (gate and assembly check against the real synthesized templates), `operator-0086-deploy-guard.test.ts`, `operator-0086-apply.test.ts` (the 0087 window script against fake `aws`/`psql`/`npx`), `operator-0086-ledger-recheck.test.ts`, `operator-0086-scripts.test.ts` (baseline, snapshot, web-verify, record-deployed, route-smoke), `operator-0086-procedure.test.ts` (this document cannot drift from the code); and `infra/aws/db/test/operator-0086-sql.db.test.ts` (the exact `psql` command lines and the 110- and 22-check verifications against a real PostgreSQL with the real migrations). Run: `pnpm --filter @carelik/infra-aws exec vitest run test/operator-0086-*.test.ts` and `pnpm --filter @carelik/infra-aws test:db` (the database test needs `OGEVIA_TEST_DATABASE_URL`). Results of the final run are in `docs/releases/2026-10-26-redesign/CHECKLIST.md`.
