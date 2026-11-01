# Production runbook: release of migrations 0086, 0087 and 0088 (DRAFT, NOT APPROVED)

**Nothing in this runbook may be run until the owner's written GO exists for the commit and window named in it. Parts 1 and 2 are read-only but need their own written approval. This is for the Operator (Stella Okereke). Claude does not run anything in AWS.**
Companion documents: `PRD_DEPLOYMENT_DESIGN.md` (why), `PHASE_E_PACKAGE.md` (the owner's package), `CHECKLIST.md`. Scripts: `STELLA_PRD_DB.sh`, `STELLA_PRD_DEPLOY.sh`, `STELLA_PRD_READONLY.sql`, `diff_gate_prd0088.py`. Estimates below are from the pilot run, not measured on production.

## 0. Rules (learned on 2026-11-01)
1. **Paste only what the command printed, never the command.** If the terminal scrolls, run `sed -n 1,40p <log>` for the part you need, or send a screenshot. Output folders: `~/prd0088-*` (database) and `~/prd0088-before` (deploy captures); keep them until the release is accepted.
2. **A shell or CloudShell reset clears `/tmp` and the variables.** Repeat part 3, step 0 first. Your home folder survives.
3. **Use single quotes around text containing `!`** (bash history expansion). Do not run the 2026-10-19 package's `p2-gate.sh` or any `deploy-guard-prd.sh`: they belong to an earlier release.
4. **One step at a time; stop at the first `STOP:`, `FAIL`, `!!!` or `NOT RESTORED`.** Do not retry the same command without a changed reason. A `STOP` before a change means nothing was changed; the script says so.
5. **Keep a second CloudShell tab open and idle** for the database steps. Its only command is `cd "$D" && bash STELLA_PRD_DB.sh --restore-only`. Use it only if a database step is interrupted or prints `NOT RESTORED` (exit code 3).
6. No step may **begin** after the window end; a step that began may finish. Typed phrases are typed by you, never pasted from a message you did not read.
7. Nothing here sends a sign-in link, changes enforcement, or touches TEST, Cognito or the network.

## 1. What must exist first (owner and author)
The owner's GO (commit, window, approval reference) and `PHASE_E_PACKAGE.md` section 9 settled. The author then fills the placeholders with `fill_pins_prd.py`, commits the filled scripts and writes `PRD_PINS.md` (commit, reference, window, script hashes, asset keys, migration and rollback set hashes). You verify the hashes before running anything (part 3, step 0).

## 2. Before the GO: the read-only production dry run (needs a separate written approval)
Purpose: prove the new access path and read production's live API template with the new gate, so the gate's allow-list can be corrected from real output before the owner decides. The owner issues a **dry-run reference and a short window** (for example 2 hours); the author fills a **dry-run copy** of the scripts with them (different bytes from the final scripts, same logic). Steps, in order, each pasted back:
| Step | Command (from `$D`, after part 3 step 0) | Changes in AWS | Typed |
|---|---|---|---|
| D1 | `OGEVIA_DEPLOY_APPROVAL=$GO_REF REPO=$R bash STELLA_PRD_DEPLOY.sh synth` | nothing | none |
| D2 | `... bash STELLA_PRD_DEPLOY.sh capture` | nothing (reads CloudFormation, Lambda, API Gateway, S3, CloudFront; downloads the web bucket) | none |
| D3 | `... bash STELLA_PRD_DEPLOY.sh check` | nothing | none |
| D4 | `REPO=$R bash STELLA_PRD_DB.sh probe` | **one temporary rule on the RDS security group, removed and proven identical; the master secret read into memory** | `OPEN-5432-WINDOW-PRD` |
Expected: D2 ends `CAPTURED ... and no drift from the baseline`; D3 prints `added: 22 route(s) (the 22 expected)` and `EXPECTED-ONLY: YES`, or lists the differences it found (that is the finding to send, not a failure of your run); D4 prints `BASELINE MATCHES` (ledger 85/0085, readiness absent, staff 0|0|0, enforcement 0), then counts only, and `SECURITY GROUP: restored and verified identical`. **Read the D4 output for `active_onboarding_requirements_by_category`**: those rows are the ones migration 0088 retires.

## 3. Release night
**Step 0: set up (local, no AWS).** Repeat after any reset.
```
export PATH="$HOME/node22/bin:$PATH"
cd /tmp && rm -rf prd-release && git clone --depth 1 --filter=blob:none --sparse --branch claude/practical-tesla-r07odb https://github.com/socalcaresservices/CarelikGlobal.git prd-release
cd prd-release && git sparse-checkout set docs/releases/2026-11-01-prd-0088 && git rev-parse HEAD
export D=/tmp/prd-release/docs/releases/2026-11-01-prd-0088 GO_REF=<the approval reference>
cd "$D" && sha256sum STELLA_PRD_DB.sh STELLA_PRD_DEPLOY.sh STELLA_PRD_READONLY.sql diff_gate_prd0088.py      # must equal PRD_PINS.md
# the application checkout at the ONE approved commit
mkdir -p /tmp/prd-app && cd /tmp/prd-app && git init -q && git remote add origin https://github.com/socalcaresservices/CarelikGlobal.git
git fetch --depth 1 origin <the 40-character SHA> && git checkout -q --detach FETCH_HEAD && git rev-parse HEAD && git status --porcelain | wc -l     # SHA exactly; 0
pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store 2>&1 | tail -3
export R=/tmp/prd-app; df -h /tmp ~ | cat        # /tmp >= 3 GB, home >= 150 MB
cd "$D" && REPO=$R bash STELLA_PRD_DB.sh selftest && ASSEMBLY=/tmp/ogevia-cdk-prd-0088.out REPO=$R bash STELLA_PRD_DEPLOY.sh selftest
```
Expected: the hashes equal `PRD_PINS.md`; `pins ok` and `selftest done` for both. **Stop** if a hash or the commit differs.
| Step | Command (from `$D`; `OGEVIA_DEPLOY_APPROVAL=$GO_REF` for deploy-script modes) | Expected | Stop if |
|---|---|---|---|
| P1 | `... REPO=$R bash STELLA_PRD_DEPLOY.sh synth`, then `capture`, then `check` | `PASS all checks` (six `Ogevia-prd-*` stacks, asset keys, 250 routes); `CAPTURED ... no drift`; `added: 22 route(s)`, `EXPECTED-ONLY: YES` | any drift, any `FAIL`, any other difference in the gate |
| P2 | `REPO=$R bash STELLA_PRD_DB.sh probe` (type `OPEN-5432-WINDOW-PRD`) | `BASELINE MATCHES`; counts; rule restored and proven | any difference, `NOT RESTORED` |
| P3 | `REPO=$R bash STELLA_PRD_DB.sh snapshot` | `SNAPSHOT_ID=ogevia-prod-postgres-pre-0088-prd-...` (available, encrypted, manual) | not available |
| P4 | `REPO=$R SNAPSHOT_ID=<id> bash STELLA_PRD_DB.sh migrate` (type `OPEN-5432-WINDOW-PRD`, then `MIGRATE PRD 0086-0088`) | `applied 3, already applied 85`; `db:verify` passes; `POST-STATE MATCHES`; `verify-0086.sql: 110 checks, 0 failing`; `verify-0087.sql: 22 checks, 0 failing`; `PASS existing data counts unchanged`; `marker written`; rule restored and proven | anything else: the marker is not written and the API stays blocked; **send the output, do not roll back without the owner** |
| P5 | `OGEVIA_DEPLOY_APPROVAL=$GO_REF REPO=$R bash STELLA_PRD_DEPLOY.sh deploy-api` (type `DEPLOY-PRD-Ogevia-prd-ServiceVerificationApi`) | CDK asks nothing; stack `UPDATE_COMPLETE`; `PASS Lambda environment unchanged`; routes 250 (22 added, 0 removed); four `401`; `POST-API OK` | CDK asks for IAM approval (answer `n`, stop); a failed update; any `STOP` |
| P6 | `OGEVIA_DEPLOY_APPROVAL=$GO_REF REPO=$R bash STELLA_PRD_DEPLOY.sh web` (type `PUBLISH-WEB-PRD`) | `WEB VERIFIED` (raw bytes equal, commit in the bundle, `production`, API host `zk527zk4ua`, `config.json` unchanged) | a FAIL after one retry of `web-verify` for CloudFront lag |
| P7 | `... bash STELLA_PRD_DEPLOY.sh smoke`, then the owner's checks (below) | `PASS` lines | any failure |
| P8 | `REPO=$R bash STELLA_PRD_DB.sh final` (type `OPEN-5432-WINDOW-PRD`) | `FINAL STATE MATCHES` (ledger 88/0088, readiness table and staff objects present, enforcement 0); rule restored and proven | any difference |
| P9 | paste every output to Claude | the record is written | |
**Owner's checks (P7), with the owner's own Owner account, look only:** Staff and Staff Types load; Accounts loads; one caregiver page shows the checklist and "flagged only" lines with no email or phone in the clear; the Schedule loads; Roles and Permissions loads; a non-Owner login is refused on `/staff`. Do **not** press Approve, Send sign-in link or any Add button during these checks. After the window: observe production for the monitoring period the owner names (new 5xx or support reports); the checklist's F5.

## 4. Rollback (only after a stop condition; the owner decides; web first)
Order and commands are in `PHASE_E_PACKAGE.md` section 3: `rollback-web` (type `ROLLBACK-WEB-PRD`), then `rollback-api` (type `ROLLBACK-API-PRD`), then `rollback-db` (needs the snapshot id, the owner's written authorization, and two typed phrases `OWNER AUTHORIZED PRD DB ROLLBACK` and `ROLLBACK PRD TO 0085`). **The database rollback drops tables with their rows.** After launch prefer a forward fix. Restoring the RDS snapshot is not part of this runbook.

## 5. If a step is interrupted
Run `--restore-only` in the second tab, paste its output, and do not start another step. If it prints the manual commands (exit 3), run exactly those in a separate session; they remove only the one temporary rule by its id.
