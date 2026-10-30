# Operator package: TEST release 2026-10-26-redesign UPGRADE from 7870a04 to code commit fb491a5, migration 0087 applied on top of 0086 outside the ledger

**Status: PROPOSED. Nothing here has been run against AWS.** This package supersedes the one used for the 7870a04 TEST deployment (still in git at `644d6e2`). TEST only. Production is not requested and never named as a target.

| File | Purpose |
|---|---|
| `OPERATOR_PROCEDURE_fb491a5.md` | The procedure the Operator follows in CloudShell: pins, Steps 0-16 (upgrade), expected output, stop conditions, recovery R1-R7 |
| `scripts/build-operator-tarball.sh` | Runs in the development container: builds the tarball (`git archive` of the code commit + this folder), `BUILD_INFO.json`, `PACKAGE_MANIFEST.sha256` |
| `scripts/tarball-pin-check.sh`, `pkg-lib.sh` | Operator-side, no git: commit, manifest, migration sets, 0086 and 0087 hashes, lockfile, toolchain |
| `scripts/assembly_check.py`, `diff_gate.py`, `deploy-guard.sh`, `new-route-keys.json` | Synthesis check, expected-only gate (the ONE accept route + Handler code asset, nothing else), the only deploy path (one stack) |
| `scripts/baseline-capture.sh`, `snapshot-verify.sh`, `ledger-recheck.sh` | Read-only baseline and recovery capture; named snapshot; ledger read through one temporary `/32` rule |
| `scripts/apply-0087-test.sh`, `verify-0086.sql`, `verify-0087.sql` | Apply (or roll back) 0087 on top of 0086 in one transaction as `ogevia_owner`, no ledger row; 110 + 24 read-only checks |
| `scripts/web-verify.sh`, `route-smoke.sh`, `record-deployed.sh` | Read-only verification of the served web, the accept route (401 without a valid token) and the deployed record |

Building the tarball (development container, after the procedure and scripts are committed or present in the working tree):

```
OGEVIA_APPROVAL_REF=<owner reference, optional> bash docs/releases/2026-10-26-redesign-operator/scripts/build-operator-tarball.sh --out-dir <dir outside the repository> --code-commit fb491a554c0fdc484102025179c9c993f694b4e0
```

The tarball hash it prints travels in the covering message and the owner's GO message; it cannot be written inside the tarball. Tests: `infra/aws/test/operator-0086-*.test.ts` and `infra/aws/db/test/operator-0086-sql.db.test.ts`.
