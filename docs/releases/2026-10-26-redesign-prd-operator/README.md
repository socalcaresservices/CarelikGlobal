# Operator package: PRODUCTION release 2026-10-26-redesign (code commit 730b601), migrations 0086 and 0087 applied outside the ledger

**Status: PROPOSED. Nothing here has been run against AWS.** PRODUCTION. The TEST package is `docs/releases/2026-10-26-redesign-operator/`; nothing in it is reused for production, and no TEST exception carries over.

| File | Purpose |
|---|---|
| `OPERATOR_PROCEDURE_PRD_730b601.md` | The procedure the Operator follows in CloudShell: pins, Steps 0-17, expected output, stop conditions, recovery R1-R7 |
| `scripts/build-prd-tarball.sh` | Runs in the development container: builds the tarball (`git archive` of the code commit + this folder + the seven bundled release templates synthesized from the archived code), `BUILD_INFO.json`, `PACKAGE_MANIFEST.sha256` |
| `scripts/tarball-pin-check.sh`, `pkg-lib.sh` | Operator-side, no git: commit, manifest, migration sets, 0086 and 0087 hashes, lockfile, toolchain |
| `scripts/assembly_check_prd.py`, `diff_gate_prd.py`, `deploy-guard-prd.sh`, `new-route-keys.json` | Synthesis check (six `Ogevia-prd-*` stacks, pinned builds, 242 routes), expected-only gate (Auth URLs; 14 routes + Handler + two CORS origins; nothing else), the only deploy path (one of two stacks per call) |
| `lib.sh`, `p0-baseline-capture.sh`, `p1-diff-report.sh`, `tpl_diff.py` | Read-only baseline and recovery capture of production (extended with the route keys, the API's own CORS and the Cognito client URLs) and the difference report |
| `ledger-recheck-prd.sh`, `snapshot-verify-prd.sh` | Ledger verdict through one temporary `/32` rule (production only); the named snapshot `ogevia-prod-postgres-pre-0086-prd-YYYYMMDDHHMM` |
| `apply-0086-prd.sh`, `verify-0086.sql`, `verify-0087.sql` | Apply (or roll back) 0086 then 0087 in one transaction as `ogevia_owner`, no ledger row; 110 + 22 read-only checks; writes the marker that the stack deployments require |
| `web-prd.sh`, `route-smoke-prd.sh`, `record-deployed-prd.sh` | Web build with production's own values, publish guard, verification and rollback; the 14 routes (401 without a valid token) and the CORS preflights; the deployed record |

Building the tarball (development container, after the procedure and scripts are present in the working tree; the code commit must be in the clone and `pnpm install` done):

```
OGEVIA_APPROVAL_REF=<owner reference, optional> bash docs/releases/2026-10-26-redesign-prd-operator/scripts/build-prd-tarball.sh --out-dir <dir outside the repository> --code-commit 730b60166409cef217be15e7d20618538a1e131f
```

It prints the tarball's sha256 (the value the Owner gives the Operator), the migration-set, 0086, 0087 and lockfile pins, and refuses to build if the archived code does not synthesize the approved release (Handler `2871b03d…`, Identity `7c5f8eb6…`, 242 routes). The Owner downloads the tarball and uploads it to CloudShell. The procedure is the only instruction the Operator follows.
