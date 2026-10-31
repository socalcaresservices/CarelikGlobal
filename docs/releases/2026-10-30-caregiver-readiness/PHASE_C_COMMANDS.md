# Phase C: final approved commands (copy and paste) — 0086 on TEST — DRAFT, NOT RUN, G1 NOT GIVEN

**Two checkouts. Never mix them.**
| | Path | What it is | Used for |
|---|---|---|---|
| **DOCS/SCRIPT checkout** | `/tmp/ogevia-phasec/docs-checkout` (branch `claude/practical-tesla-r07odb`, tip) | scripts and documents only (sparse: just the release folder) | running `STELLA_PHASE_C_DB.sh`, `STELLA_PHASE_C_DEPLOY.sh`, `diff_gate_0086.py`. **Never built, never deployed.** |
| **APPLICATION checkout** | `/tmp/ogevia-phasec/app-5489` (**exactly** `54894411f0e69ac29bec762006e47f7d943b94f2`, detached) | the code that is migrated, built and deployed | `REPO=` for both scripts. **The only approved deployment commit.** |

## 0. Before the window (local only; nothing touches AWS)
```bash
df -h /tmp ~ | cat            # /tmp needs >= 3 GB free; home needs >= 300 MB (the web capture). If not: stop and say so
node -v; pnpm -v; python3 --version; jq --version; psql --version; session-manager-plugin --version >/dev/null && echo ssm-plugin-ok
#   expect node v22.x, pnpm 9.15.4. A missing tool: stop and report; do not install ad hoc.
mkdir -p /tmp/ogevia-phasec && cd /tmp/ogevia-phasec

# 1) DOCS/SCRIPT checkout (scripts only)
git clone --depth 1 --filter=blob:none --sparse --branch claude/practical-tesla-r07odb https://github.com/socalcaresservices/CarelikGlobal.git docs-checkout
cd docs-checkout && git sparse-checkout set docs/releases/2026-10-30-caregiver-readiness && git rev-parse HEAD && cd ..

# 2) APPLICATION checkout at the approved SHA only
mkdir app-5489 && cd app-5489 && git init -q && git remote add origin https://github.com/socalcaresservices/CarelikGlobal.git
git fetch --depth 1 origin 54894411f0e69ac29bec762006e47f7d943b94f2 && git checkout -q --detach FETCH_HEAD
git rev-parse HEAD            # MUST print exactly 54894411f0e69ac29bec762006e47f7d943b94f2
git status --porcelain | wc -l   # MUST print 0

# 3) dependencies (store and node_modules both in /tmp; never --no-frozen-lockfile)
pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store 2>&1 | tail -5 ; df -h /tmp | cat
cd ..

# 4) selftests (no AWS, no database)
export D=/tmp/ogevia-phasec/docs-checkout/docs/releases/2026-10-30-caregiver-readiness R=/tmp/ogevia-phasec/app-5489
cd "$D" && REPO=$R bash STELLA_PHASE_C_DB.sh selftest        # expect: pins ok, selftest done
```
Stop on: any hash/commit mismatch, `ERR_PNPM_OUTDATED_LOCKFILE`, "No space left on device". The checkout at the branch tip may be a later documentation commit than the one the owner reviewed; that is fine for scripts (the app checkout is pinned separately).
Optionally, read both scripts first (`sed -n '1,80p' STELLA_PHASE_C_DB.sh`, same for the deploy script) and check their hashes against the values in `PHASE_C_RUN_SHEET.md`.

## 1. In the window (09:00-12:00 PDT = 16:00-19:00 UTC), in this order
Every command below runs from `$D` after `export D=... R=...` (section 0) and `export OGEVIA_DEPLOY_APPROVAL=GO-0086-TEST-20261031`.
| Step | Command | Expect | Stop if |
|---|---|---|---|
| S0 | `date -u; aws sts get-caller-identity --query Account --output text` | `300094796789`; host groups per the DB script | other account |
| S1 | `REPO=$R bash STELLA_PHASE_C_DB.sh selftest && REPO=$R bash STELLA_PHASE_C_DEPLOY.sh selftest` | both `selftest done` | any STOP |
| S2 | `REPO=$R bash STELLA_PHASE_C_DB.sh probe` *(needs G1; type `G1 AUTHORIZED`)* | `BASELINE MATCHES`; `RESTORE VERIFIED` | any STOP/`!!!` |
| S3a | `REPO=$R bash STELLA_PHASE_C_DEPLOY.sh synth` | `PASS all checks` (five Ogevia-prod-* stacks, Handler asset `c3f09ddf4d99...`, IdentityHandler `7c5f8eb676c9...`, 236 routes) | any FAIL: different inputs, do not deploy |
| S3b | `REPO=$R bash STELLA_PHASE_C_DEPLOY.sh capture` then `REPO=$R bash STELLA_PHASE_C_DEPLOY.sh check` | `TEST confirmed`, previous asset exists; `added: 8 route(s) (the 8 expected)`, `EXPECTED-ONLY: YES` | anything else in the diff |
| S5 | `REPO=$R bash STELLA_PHASE_C_DB.sh snapshot` | prints `SNAPSHOT_ID=ogevia-prod-postgres-pre-0086-...` (available, encrypted) | not available |
| S6-7 | `REPO=$R SNAPSHOT_ID=<id> bash STELLA_PHASE_C_DB.sh migrate` *(G1; then type `MIGRATE 0086`)* | `applied 1, already applied 85`; verify PASS; `POST-STATE MATCHES`; `RESTORE VERIFIED` | any STOP/`!!!` |
| S8 | `REPO=$R bash STELLA_PHASE_C_DEPLOY.sh deploy-api` *(type `DEPLOY-Ogevia-prod-ServiceVerificationApi`)* | CDK asks nothing; `POST-API OK` | CDK asks for IAM approval: answer `n` and STOP |
| S9 | `REPO=$R bash STELLA_PHASE_C_DEPLOY.sh web` *(type `PUBLISH-WEB`)* | `WEB VERIFIED` | any FAIL after one retry for CloudFront lag |
| S10 | Phase C checks `RUNBOOK.md` F1-F8 (manual, synthetic data) | each passes | any failure |
| S11 | `REPO=$R bash STELLA_PHASE_C_DB.sh final` | ledger 86, counts as post-state; `RESTORE VERIFIED` | any difference |
Timing: a step that has STARTED before 12:00 PDT is allowed to finish; none may BEGIN after (A12). Start the snapshot early, because it can take many minutes.

## 2. Rollback (only after a stop condition; allowed after 12:00 PDT solely to restore known-good)
Order: web, API, database. Each asks for a typed confirmation.
```bash
cd "$D"
REPO=$R bash STELLA_PHASE_C_DEPLOY.sh rollback-web
REPO=$R bash STELLA_PHASE_C_DEPLOY.sh rollback-api      # code only; tell the owner CloudFormation is then out of step
REPO=$R SNAPSHOT_ID=<id> bash STELLA_PHASE_C_DB.sh rollback     # drops the four new tables WITH their rows (BACKUP REQUIRED); expects 85/0085 afterwards
```
Restoring the RDS snapshot creates a new instance and is **not** authorized: stop and ask the owner.

## 3. TLS to the database: full certificate verification IS preserved (tested locally)
The DB script uses `sslmode=verify-full` against the RDS CA bundle (downloaded from `truststore.pki.rds.amazonaws.com`), checking the certificate against the real RDS **host name** while the bytes go through the tunnel to 127.0.0.1: `psql` via `PGHOST=<rds name>` + `PGHOSTADDR=127.0.0.1`; the Node migration runner via the RDS name in the URL plus a tiny preload (`NODE_OPTIONS=--require`) that maps only that one name to 127.0.0.1. Tested on a local PostgreSQL with a throwaway CA: verified connection OK; wrong CA fails; plain `127.0.0.1` with verify-full fails (the problem the preload solves); the **real** `db:migrate` and `db:verify` ran through it (86 applied, all PASS). **No fallback to unverified TLS exists in the script.** Trade-offs: (1) the CA bundle is a public download at run time (a failed download stops the run; its hash is printed for the record; the author's copy was 174,560 bytes, sha256 `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b`, which AWS may legitimately update); (2) the preload is a small monkeypatch of Node's DNS lookup, tested on Node 22.22 only; (3) **not tested against the real RDS endpoint**: if the real certificate does not verify, the script stops and nothing is changed; accepting unverified TLS would be a separate owner decision.
