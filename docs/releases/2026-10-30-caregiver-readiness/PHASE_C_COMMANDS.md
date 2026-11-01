# Phase C commands: caregiver readiness (0088) integrated onto the TEST line — DRAFT, NOT RUN

**Status: pins filled (`PINS.md`), window and GO reference given by the owner (AMENDED 2026-11-01 (A22): 2026-11-01 07:30 UTC to 2026-11-02 02:00 UTC = 00:30 PDT to 18:00 PST, `GO-0088-TEST-20261101-C`), and the owner has given the GO (A20, amended by A22). Section 1 may run only inside the window.** Candidate commit: **`464dea64cb939c49fbca624b652f34b2863db2f2`** (the only approved deployment commit). It replaces the first candidate's commands; the first Phase C stopped at its gate and nothing was deployed.

**Two checkouts. Never mix them.**
| | Path | What it is | Used for |
|---|---|---|---|
| **DOCS/SCRIPT checkout** | `/tmp/ogevia-phasec/docs-checkout5` (branch tip, sparse: only the release folder and the staff verification scripts) | scripts and documents only | running `STELLA_PHASE_C_DB.sh`, `STELLA_PHASE_C_DEPLOY.sh`, `diff_gate_0086.py`. **Never built, never deployed.** |
| **APPLICATION checkout** | `/tmp/ogevia-phasec/app-464dea6` (**exactly** `464dea64cb939c49fbca624b652f34b2863db2f2`, detached) | the code that is migrated, built and deployed | `REPO=` for both scripts |

## 0. Rebuild (CloudShell resets `/tmp`; do this first, locally; no AWS change)
```bash
export PATH="$HOME/node22/bin:$PATH"; node -v; pnpm -v        # v22.x and 9.15.4
df -h /tmp ~ | cat                                              # /tmp >= 3 GB free; home >= 300 MB (the web capture)
mkdir -p /tmp/ogevia-phasec && cd /tmp/ogevia-phasec

# 1) scripts checkout
git clone --depth 1 --filter=blob:none --sparse --branch claude/practical-tesla-r07odb https://github.com/socalcaresservices/CarelikGlobal.git docs-checkout5
cd docs-checkout5 && git sparse-checkout set docs/releases/2026-10-30-caregiver-readiness && git rev-parse HEAD
cd docs/releases/2026-10-30-caregiver-readiness && sha256sum STELLA_PHASE_C_DB.sh STELLA_PHASE_C_DEPLOY.sh diff_gate_0086.py STELLA_READONLY_VERIFICATION.sql   # must equal PINS.md

# 2) application checkout at the one approved commit
mkdir -p /tmp/ogevia-phasec/app-464dea6 && cd /tmp/ogevia-phasec/app-464dea6 && git init -q && git remote add origin https://github.com/socalcaresservices/CarelikGlobal.git
git fetch --depth 1 origin 464dea64cb939c49fbca624b652f34b2863db2f2 && git checkout -q --detach FETCH_HEAD
git rev-parse HEAD            # MUST print exactly 464dea64cb939c49fbca624b652f34b2863db2f2
git status --porcelain | wc -l   # MUST print 0

# 3) dependencies (never --no-frozen-lockfile)
pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store 2>&1 | tail -5

# 4) settings, selftests, assembly
export D=/tmp/ogevia-phasec/docs-checkout5/docs/releases/2026-10-30-caregiver-readiness R=/tmp/ogevia-phasec/app-464dea6
export GO_REF=GO-0088-TEST-20261101-C
cd "$D" && REPO=$R bash STELLA_PHASE_C_DB.sh selftest
OGEVIA_DEPLOY_APPROVAL=$GO_REF REPO=$R bash STELLA_PHASE_C_DEPLOY.sh selftest
OGEVIA_DEPLOY_APPROVAL=$GO_REF REPO=$R bash STELLA_PHASE_C_DEPLOY.sh synth     # PASS all checks: five Ogevia-prod-* stacks, Handler asset (PINS.md), IdentityHandler 7c5f8eb6..., 250 routes
```
If the shell resets, repeat `export PATH`, `export D=... R=... GO_REF=...` and `cd "$D"`; if `/tmp` is empty, repeat this whole block. Keep one tab open.

## 1. In the window, in this order (paste each output; stop at the first `STOP:` or `!!!`)
All commands run from `$D`. `REPO=$R` as shown. The window and GO reference are the owner's (`GO_DRAFT.md` section 1).
| Step | Command | Expect | Stop if |
|---|---|---|---|
| S0 | `date -u; aws sts get-caller-identity --query Account --output text; aws ec2 describe-instances --region us-west-2 --instance-ids i-0ce8db2d7e5839dd5 --query 'Reservations[0].Instances[0].[State.Name,SecurityGroups[].GroupId]' --output text` | in the window; `300094796789`; `running` + only `sg-00e01e2ca80442c1f` | any differs |
| S2 | `REPO=$R bash STELLA_PHASE_C_DB.sh probe` *(type `G1 AUTHORIZED`)* | `ledger=85/0085 readiness_table=absent staff_objects_present=true ready_or_active/caregivers=5/6 orgs_enforcing=0`; `BASELINE MATCHES`; V1-V7; `RESTORE VERIFIED` | any difference or `!!!` |
| S3 | `REPO=$R bash STELLA_PHASE_C_DEPLOY.sh capture` then `... check` | `TEST confirmed`; previous API asset exists; `added: 8 route(s) (the 8 expected)`; `Handler code asset changed: Handler...`; `EXPECTED-ONLY: YES` | anything else in the diff |
| S5 | `REPO=$R bash STELLA_PHASE_C_DB.sh snapshot` | prints `SNAPSHOT_ID=ogevia-prod-postgres-pre-0088-...` (available, encrypted) | not available |
| S6a | `REPO=$R SNAPSHOT_ID=<id> bash STELLA_PHASE_C_DB.sh adopt` *(type `G1 AUTHORIZED`, then `ADOPT 0086 0087`)* | `verify-0086.sql: 110 checks, 0 failing`; `verify-0087.sql: 24 checks, 0 failing`; `ADOPTED STATE MATCHES` (ledger 87/0087); `RESTORE VERIFIED` | any check failing, or a state difference |
| S6b | `REPO=$R SNAPSHOT_ID=<id> bash STELLA_PHASE_C_DB.sh migrate` *(type `G1 AUTHORIZED`, then `MIGRATE 0088`)* | `applied 1, already applied 87`; verify PASS; `POST-STATE MATCHES` (88/0088, legacy approvals 5, staff present); `RESTORE VERIFIED` | any STOP/`!!!` |
| S8 | `OGEVIA_DEPLOY_APPROVAL=$GO_REF REPO=$R bash STELLA_PHASE_C_DEPLOY.sh deploy-api` *(type `DEPLOY-Ogevia-prod-ServiceVerificationApi`)* | CDK asks nothing; `POST-API OK` | CDK asks for IAM approval: answer `n`, STOP |
| S9 | `OGEVIA_DEPLOY_APPROVAL=$GO_REF REPO=$R bash STELLA_PHASE_C_DEPLOY.sh web` *(type `PUBLISH-WEB`)* | `WEB VERIFIED` | any FAIL after one retry for CloudFront lag |
| S10 | Phase C checks `RUNBOOK.md` F1-F8, **plus the staff regression check below** | each passes | any failure |
| S11 | `REPO=$R bash STELLA_PHASE_C_DB.sh final` | ledger 88/0088 and the post-state; `RESTORE VERIFIED` | any difference |
| S12 | UAT fit check | decision recorded | n/a |

**Staff regression check (S10, read-only through the app, synthetic data):** as the synthetic Owner of `scs-pilot-synthetic`: open Staff (list loads), Staff types (list loads), Accounts (list loads, an invited person reads "Invitation pending"); as a user without access the same pages refuse. `GET /v1/staff`, `/v1/staff/types` and `/v1/role-permissions` answer 401 without a token. These are the 14 routes the first candidate would have removed.

**Timing:** a step that has STARTED before the window ends may finish; none may BEGIN after (A12).

## 2. Rollback (only after a stop condition; after the window end solely to restore known-good)
Order: web, API, database. Each asks for a typed confirmation.
```bash
cd "$D"
OGEVIA_DEPLOY_APPROVAL=$GO_REF REPO=$R bash STELLA_PHASE_C_DEPLOY.sh rollback-web
OGEVIA_DEPLOY_APPROVAL=$GO_REF REPO=$R bash STELLA_PHASE_C_DEPLOY.sh rollback-api    # code only; tell the owner CloudFormation is then out of step
REPO=$R SNAPSHOT_ID=<id> bash STELLA_PHASE_C_DB.sh rollback                           # removes 0088 only (drops four tables WITH their rows); staff and their ledger rows stay; expects 87/0087
```
The DB rollback asks you to type `OWNER AUTHORIZED DB ROLLBACK ACCESS`; the GO covers the access (step 10). Restoring the RDS snapshot creates a new instance and is **not** authorized. If `adopt` had run and the migration had not, there is nothing to roll back in the database: the two ledger rows are correct whatever happens to 0088.

## 3. TLS to the database
Full certificate verification (`verify-full` against the RDS CA bundle, by RDS host name, through the tunnel). Verified end to end on the real RDS endpoint on 2026-10-31 (S2 of the first attempt). No fallback to unverified TLS exists in the scripts.
