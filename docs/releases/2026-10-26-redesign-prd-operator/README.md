# Operator package: PRODUCTION release 2026-10-26-redesign (code commit f8cd7df), migration 0086 applied outside the ledger

**Status: PROPOSED. Nothing here has been run against AWS.** PRODUCTION. The TEST package is `docs/releases/2026-10-26-redesign-operator/`; nothing in it is reused for production, and no TEST exception carries over.

| File | Purpose |
|---|---|
| `OPERATOR_PROCEDURE_PRD_f8cd7df.md` | The procedure the Operator follows in CloudShell: pins, Steps 0-17, expected output, stop conditions, recovery R1-R7 |
| `scripts/build-prd-tarball.sh` | Runs in the development container: builds the tarball (`git archive` of the code commit + this folder + the seven bundled release templates synthesized from the archived code), `BUILD_INFO.json`, `PACKAGE_MANIFEST.sha256` |
| `scripts/tarball-pin-check.sh`, `pkg-lib.sh` | Operator-side, no git: commit, manifest, migration sets, 0086 hashes, lockfile, toolchain |
| `scripts/assembly_check_prd.py`, `diff_gate_prd.py`, `deploy-guard-prd.sh`, `new-route-keys.json` | Synthesis check (six `Ogevia-prd-*` stacks, pinned builds, 241 routes), expected-only gate (Auth URLs; 13 routes + Handler + two CORS origins; nothing else), the only deploy path (one of two stacks per call) |
| `lib.sh`, `p0-baseline-capture.sh`, `p1-diff-report.sh`, `tpl_diff.py` | Read-only baseline and recovery capture of production (extended with the route keys, the API's own CORS and the Cognito client URLs) and the difference report |
| `ledger-recheck-prd.sh`, `snapshot-verify-prd.sh` | Ledger verdict through one temporary `/32` rule (production only); the named snapshot `ogevia-prod-postgres-pre-0086-prd-YYYYMMDDHHMM` |
| `apply-0086-prd.sh`, `verify-0086.sql` | Apply (or roll back) 0086 in one transaction as `ogevia_owner`, no ledger row; 110 read-only checks; writes the marker that the stack deployments require |
| `web-prd.sh`, `route-smoke-prd.sh`, `record-deployed-prd.sh` | Web build with production's own values, publish guard, verification and rollback; the 13 routes (401 without a valid token) and the CORS preflights; the deployed record |

Building the tarball (development container, after the procedure and scripts are present in the working tree; the code commit must be in the clone and `pnpm install` done):

```
OGEVIA_APPROVAL_REF=<owner reference, optional> bash docs/releases/2026-10-26-redesign-prd-operator/scripts/build-prd-tarball.sh --out-dir <dir outside the repository> --code-commit f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45
```

It prints the tarball's sha256 (the value the Owner gives the Operator), the migration-set, 0086 and lockfile pins, and refuses to build if the archived code does not synthesize the approved release (Handler `94b73574…`, Identity `7c5f8eb6…`, 241 routes). The Owner downloads the tarball and uploads it to CloudShell. The procedure is the only instruction the Operator follows.
