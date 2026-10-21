# TEST rehearsal package for code commit e80b770

Operator package for the owner-approved TEST rehearsal: migrations 0078-0085, the `Ogevia-prod-NetworkEgress` and `Ogevia-prod-ServiceVerificationApi` stack changes (client-documents key pattern), and the web build, all on TEST (`Ogevia-prod-*`, database `ogevia_sv_test`). **Prepared, not run against AWS** (no AWS CLI or credentials in the development container). Production (`Ogevia-prd-*`, `ogevia_prd`) is never deployed; enforcement is not activated.

## Files

| File | What it is |
|---|---|
| `OPERATOR_PROCEDURE_e80b770.md` | The CloudShell procedure: Steps 0-17, one command block per step, with purpose, expected output, stop condition, recovery pointer and the evidence to paste back; the expected infrastructure difference; recovery R1-R7; stop conditions |
| `SNAPSHOT_RESTORE_ISOLATED_e80b770.md` | Last-resort database recovery reference, adapted from the 2026-10-18 document (ledger numbers only). Documented, not rehearsed on AWS |
| `scripts/build-operator-tarball.sh` | Runs in the development container. Builds the deterministic tarball + `BUILD_INFO.json` + `PACKAGE_MANIFEST.sha256` + `.sha256` |
| `scripts/pkg-lib.sh` | Shared read-only helpers (BUILD_INFO commit, manifest check, stray-file check, migration/rollback hashes); no git |
| `scripts/tarball-pin-check.sh` | Pin check of the extracted package (replaces the git-based `candidate-pin-check.sh`); every failure is non-zero |
| `scripts/assembly_check.py` | Proves a synthesized assembly is the release (five `Ogevia-prod-*` stacks, asset keys, route count, fingerprints) and that the live stacks are the recorded baseline |
| `scripts/diff_gate.py` | The EXPECTED-ONLY machine gate (live template vs synthesized template) and the additive-only endpoint-policy check |
| `scripts/deploy-guard.sh` | The only deployment path: `check`, `deploy`, `post` for exactly one of the two allowed stacks |
| `scripts/baseline-capture.sh` | Step 5: read-only baseline and recovery capture |
| `scripts/ledger-recheck.sh` | Steps 6 and 16: adapted copy of `ledger-check-temp-access.sh` v3 that returns a verdict (77 / 0077 before, 85 / 0085 after, enforcement off) |
| `scripts/snapshot-verify.sh` | Step 7: create and verify the named snapshot |
| `scripts/rehearsal-migrate-test.sh` | Step 9 and R4: the migration-access wrapper (migrate 0078-0085, rollback 0085-0078), adapted from the 2026-10-18 `candidate-migrate-test.sh`; no git |
| `scripts/web-verify.sh` | Step 12: what the TEST site serves is the build, with the code SHA as version |
| `scripts/record-deployed.sh` | Step 17: the DEPLOYED SHA record |

Tests (under `infra/aws/test`): `operator-tarball.test.ts`, `rehearsal-diff-gate.test.ts`, `rehearsal-deploy-guard.test.ts`, `rehearsal-migrate.test.ts`, `rehearsal-ledger-recheck.test.ts`, `rehearsal-operator-scripts.test.ts`, helper `rehearsal-fixtures.ts`, and real synthesized templates in `fixtures/rehearsal-e80b770/` (baseline d893276 and release e80b770).

## Build the tarball (development container)

```
bash docs/releases/2026-10-19-test-rehearsal/scripts/build-operator-tarball.sh --out-dir /some/dir/outside/the/repo [--code-commit e80b770210c54e423d28ecf48e00f1dda9506cec]
# optional: OGEVIA_APPROVAL_REF=<owner reference>   (default placeholder APPROVAL-REF-PENDING-OWNER)
# optional: OGEVIA_BUILD_TIME=2026-10-19T12:00:00Z   (fixes the build time: the same inputs then give a byte-identical tarball)
```

Output: `ogevia-operator-e80b770.tar.gz`, `ogevia-operator-e80b770.tar.gz.sha256`, `BUILD_INFO.json`, `PACKAGE_MANIFEST.sha256`. The code is `git archive` of the commit (uncommitted code edits cannot travel); this package folder is taken from the working tree. Excluded: `.git`, `_backup`, `node_modules`, the tracked stale `infra/aws/cdk.out`, every other `docs/releases` folder and all screenshots. The build refuses an output directory inside the repository, symbolic links, images and file names with whitespace, and verifies the finished tarball against its own manifest.

The tarball's hash cannot be written inside the tarball (it contains the procedure). Give the owner's operator the printed `tarball sha256` in the GO message; Step 1 refuses a file that does not match it. Upload to CloudShell: Actions, Upload files, to the home directory as `ogevia-operator-e80b770.tar.gz`.

## Run the tests

```
cd infra/aws && PATH=$PWD/node_modules/.bin:$PATH pnpm exec vitest run test/operator-tarball.test.ts test/rehearsal-diff-gate.test.ts test/rehearsal-deploy-guard.test.ts test/rehearsal-migrate.test.ts test/rehearsal-ledger-recheck.test.ts test/rehearsal-operator-scripts.test.ts
cd infra/aws && pnpm exec tsc --noEmit
```

No database suites are needed (no database code changed in this package).


## Update for code commit e80b770 (UX density pass and TEST-findings cleanup): two possible starting states
The package for e80b770 serves BOTH starting states of TEST with one procedure (`OPERATOR_PROCEDURE_e80b770.md`, section 1a): **PATH A** (TEST still on the recorded baseline, ledger 77/0077: the full sequence) and **PATH B** (TEST already runs the earlier package f6dd9b7, ledger 85/0085: no migration, NetworkEgress must show no difference, only the ServiceVerificationApi Handler code asset and the web change). Step 5 detects the path from the live stacks and writes `~/ogevia-before/path.txt`; Step 6 must read the matching ledger; the scripts refuse the steps that do not belong to the path. This e80b770 change adds no migration, no infrastructure change and no API route: migration set 0001-0085, rollback set 0078-0085 and the lockfile are unchanged from f6dd9b7; only the Handler code asset changes (`162b7a43...` to `eab95a80...`).
