# Operator handoff: TEST release of PR #113 (request cleanup and go-live items 1 to 10)

**For the operator, in AWS CloudShell (us-west-2, account 300094796789). TEST ONLY. Nothing in this file authorizes anything by itself.** Production (`Ogevia-prd-*`, `ogevia_prd`) is never touched by any step.
Prepared 2026-11-20. Application commit pinned: `88426e8cc979e91c8fb36dd4843345a6b3cf6a23`. Use the checkout at the PR #113 head (it adds only documents and this toolchain on top; `release_pins.py` proves that).

## 0. Where things stand (read first)
| Part | State |
|---|---|
| Code, tests, CI | done: PR #113 green; pins, gates and tools tested locally |
| **Phase H1** (below): checkout check, live inventory, ledger probe, integrity check, TEST backup | **ready to run now.** Reads TEST only; the backup reads `ogevia_sv_test`. Changes nothing on TEST. |
| **Phase H2**: deploy the API and web, apply 0109, switch ON, validate | **not ready.** The deploy wrapper (the older `deploy-api`, `web`, `post-api`, `web-verify` modes of `OPERATOR_TEST_DEPLOY.sh`) asserts constants of the earlier release (commit `f4316c5` / `6cbab00`, the Handler asset hashes, the old file hashes) and refuses this commit. **Do not run those modes.** Phase H2 starts after you send back the Phase H1 results, so the wrapper can be re-pinned against your live captured template and checked with the `check` gate before anything is deployed. |

## 1. What the owner supplies before Phase H1
- The written Phase C statement (template in appendix A): the commit, TEST only, the operator, the UTC window, the approval reference. Phase H1 needs the reference only for the backup file's records; Phase H2 needs window and reference.
- The release checklist (`docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`) opened for this commit.
- DEV sign-off or the owner's written decision to proceed without it.

## 2. Prerequisites in CloudShell
Node 22.x, pnpm 9.15.4 (`corepack enable`), aws CLI v2, jq, python3, curl, PostgreSQL client tools (psql and pg_dump; the earlier release used version 18), the Session Manager plugin. The checkout's own CDK CLI is used; no global CDK.
```bash
export AWS_REGION=us-west-2 AWS_PAGER=""
git clone --single-branch --branch claude/ops-fixes-requests-documents-sorting https://github.com/socalcaresservices/CarelikGlobal.git ogevia-test && cd ogevia-test
git checkout --detach <full sha of the PR #113 head the owner named>
corepack enable && pnpm install --frozen-lockfile
export REPO="$PWD" OGEVIA_RELEASE_COMMIT="$(git rev-parse HEAD)"
TC=docs/releases/2026-11-20-test-plan/toolchain
```

## 3. Phase H1 (ready now)
Run in order. Stop at the first STOP or FAIL and send what you have (section 5).

**H1.1 The checkout equals the pins** (no AWS)
```bash
python3 $TC/release_pins.py check
```
Expect `PINS OK`. It proves: HEAD contains `88426e8`; no application file changed since; every hash in `PINS_0109.json` matches (lockfile, 88 released migrations, 0103 to 0107, 0109 and its rollback, every tool, the earlier release's `OPERATOR_TEST_DB.sh`); route counts 259 (switch off) and 262 (on); expected ledger 107/0107 then 108/0109.

**H1.2 Live inventory** (read-only calls and one public GET; no secret value is shown; the output is sanitized)
```bash
OUT=$HOME/ogevia-inventory-$(date -u +%Y%m%dT%H%M%SZ) bash $TC/TEST_DB_SESSION.sh env OUT=$OUT bash $TC/TEST_INVENTORY.sh
```
`TEST_DB_SESSION.sh` opens the port-forward to the isolated TEST database (same path and the same guards as the earlier `isolated-*` modes: account, host, not public, the one expected security group; no security group is changed) and gives the inventory the database variables, so the ledger is read as well. Expect **17 of 17 checks pass**. Any FAIL is a STOP: the live state is not what this release was prepared for.

**H1.3 Migration 0109 probe**
```bash
bash $TC/TEST_DB_SESSION.sh bash $TC/TEST_0109_LEDGER.sh probe
```
Expect `PROBE OK: baseline 107/0107, 0109 absent. Nothing was changed.`

**H1.4 Integrity of the accepted TEST database** (the earlier release's mode, unchanged; it opens its own tunnel, so do not nest it in `TEST_DB_SESSION.sh`)
```bash
bash docs/releases/2026-11-10-ux-redesign-test/toolchain/OPERATOR_TEST_DB.sh isolated-verify
```
Expect `ISOLATED DATABASE VERIFIED: 107/0107, all checksums, unprivileged TEST login.`

**H1.5 TEST-only logical backup** (read-only on TEST; consumes a little shared server capacity; run in a quiet period)
```bash
export OGEVIA_TEST_BACKUP="$HOME/ogevia_sv_test-pre-0109-$(date -u +%Y%m%dT%H%M%SZ).dump"
bash docs/releases/2026-11-10-ux-redesign-test/toolchain/OPERATOR_TEST_DB.sh isolated-backup
ls -l "$OGEVIA_TEST_BACKUP"*   # the .dump, .dump.sha256 and .dump.meta stay together
```
No RDS snapshot is proposed. Keep the three files; Phase H2 needs them (`TEST_0109_LEDGER.sh apply` refuses without a verified backup).

## 4. Phase H2 (after Phase H1 is returned and reviewed; not ready to run)
1. Re-pin the API and web deploy wrapper for this commit against the live template saved by H1.2 (`test-api-template.json`), and test it with the read-only gate before any deployment.
2. Gate: `python3 $TC/diff_gate_0109.py --live <live template> --new <synthesized template> --expect off` must say `EXPECTED-ONLY: YES (off)`: only the Handler code asset differs, routes stay at 259.
3. Deploy the API, then the web (stamped with the commit); verify.
4. Apply 0109: `OGEVIA_DEPLOY_APPROVAL=<ref> bash $TC/TEST_DB_SESSION.sh bash $TC/TEST_0109_LEDGER.sh apply`, then `... verify` (ledger 108/0109, all 20 object checks).
5. Switch ON as its own commit (`TEST-requestCleanup-on.patch`), gate with `--expect on` (exactly three routes added, 262), deploy, validate the three behaviors one at a time, gate with `--expect post`.
6. Validate the ten go-live items on TEST (DEV checklist section C), at desktop width and on a real phone. Phase D acceptance follows.

## 5. Stop conditions
| Situation | Do |
|---|---|
| `release_pins.py check` fails | STOP. Do not fetch other files to make it pass. Send the output. |
| Any inventory check FAILs (wrong account, host, database, route count 259, a request-cleanup route already live, RDS public or without backups, TEST site not 200, ledger not 107/0107) | STOP. Send `$OUT` and the output. Nothing is deployed. |
| `probe` fails or `isolated-verify` fails | STOP. The database is not the baseline. |
| A guard says STOP (wrong account, host or security group; tunnel does not come up) | STOP. Do not change a security group or retry with another account. |
| Anything touches `ogevia_prd` or an `Ogevia-prd-*` stack | STOP at once and say so. |

## 6. What to send back (nothing here contains a secret, a record or PHI)
1. The full output of H1.1 to H1.4 (copy the terminal text).
2. The inventory directory `$OUT` (sanitized JSON: stack states, handler database name and host, route lists, RDS metadata, ledger count; no secrets), zipped.
3. The backup file names and the contents of `.dump.sha256` and `.dump.meta` (not the dump).
4. Any STOP message, as is. Redact only account or user identifiers if you prefer.

## 7. Rollback (Phase H2 will use these; H1 changes nothing)
- Database: `TEST_0109_LEDGER.sh rollback` removes the objects and the ledger row in one transaction (cancelled requests stay closed; the cancel reason, who cancelled, and retire data go with the columns, which is why the backup comes first).
- Switch: revert the patch commit and redeploy the API (removes three routes; `--expect post` afterwards).
- API and web: the previous Handler code asset and the pre-release web files, captured in Phase H2 step 1 before anything is published.

## Appendix A. Phase C statement template (owner fills in; keep it in the release checklist)
```
Release: PR #113, application commit 88426e8cc979e91c8fb36dd4843345a6b3cf6a23 (checkout: <full sha of the head used>)
Environment: TEST only (stacks Ogevia-prod-*, database ogevia_sv_test on ogevia-postgres). Production is excluded.
Operator: <name>      AWS CloudShell, account 300094796789, us-west-2
Window (UTC): <start> to <end>      Approval reference: <ref>
Authorized now: Phase H1 (read-only inventory, probe, integrity check, TEST-only logical backup).
Authorized later, on a separate line: Phase H2 steps 3 to 5 (API and web deploy, migration 0109, switch ON).
Signed: <owner>   <date>
```
