# Operator package: TEST release 2026-10-26-redesign (code commit 7870a04), migration 0086 applied outside the ledger

**Status: PROPOSED. Nothing here has been run against AWS.** TEST only. Production is not requested and never named as a target.

| File | Purpose |
|---|---|
| `OPERATOR_PROCEDURE_7870a04.md` | The procedure the Operator follows in CloudShell: pins, Steps 0-16, expected output, stop conditions, recovery R1-R7 |
| `scripts/build-operator-tarball.sh` | Runs in the development container: builds the tarball (`git archive` of the code commit + this folder), `BUILD_INFO.json`, `PACKAGE_MANIFEST.sha256` |
| `scripts/tarball-pin-check.sh`, `pkg-lib.sh` | Operator-side, no git: commit, manifest, migration sets, 0086 hashes, lockfile, toolchain |
| `scripts/assembly_check.py`, `diff_gate.py`, `deploy-guard.sh`, `new-route-keys.json` | Synthesis check, expected-only gate (13 routes + Handler code asset, nothing else), the only deploy path (one stack) |
| `scripts/baseline-capture.sh`, `snapshot-verify.sh`, `ledger-recheck.sh` | Read-only baseline and recovery capture; named snapshot; ledger read through one temporary `/32` rule |
| `scripts/apply-0086-test.sh`, `verify-0086.sql` | Apply (or roll back) 0086 in one transaction as `ogevia_owner`, no ledger row; 110 read-only checks |
| `scripts/web-verify.sh`, `route-smoke.sh`, `record-deployed.sh` | Read-only verification of the served web, the 13 routes (401 without a valid token) and the deployed record |

Building the tarball (development container, after the procedure and scripts are committed or present in the working tree):

```
OGEVIA_APPROVAL_REF=<owner reference, optional> bash docs/releases/2026-10-26-redesign-operator/scripts/build-operator-tarball.sh --out-dir <dir outside the repository> --code-commit 7870a04c43545bacc378ad93ffc6a09d63345b5a
```

The tarball hash it prints travels in the covering message and the owner's GO message; it cannot be written inside the tarball. Tests: `infra/aws/test/operator-0086-*.test.ts` and `infra/aws/db/test/operator-0086-sql.db.test.ts`.
