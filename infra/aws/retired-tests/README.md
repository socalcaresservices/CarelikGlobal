# Retired tests

**Retired 2026-10-30 on the owner's instruction:** tests tied exclusively to the superseded release packages of 2026-10-19 and 2026-10-21 are no longer run. They are **not deleted**: they are kept here, outside every test and typecheck path (`vitest*.config.ts` include only `test/` and `db/test/`; `tsconfig.json` does not include this folder), and are restored with `git mv` back to the path named below.

**Not re-pinned.** If a new release-pin baseline is needed, it is created only after the target environment and release candidate are finalized (owner decision 2026-10-30).

| File (restore to) | Package it belongs to | Why retired |
|---|---|---|
| `2026-10-19-test-rehearsal/operator-tarball.test.ts` (`test/`) | `docs/releases/2026-10-19-test-rehearsal` | Pins the package to exactly 85 migrations and a fixed commit; fails (5 of 23) for any later migration |
| `2026-10-19-test-rehearsal/rehearsal-operator-scripts.test.ts` (`test/`) | same | Its "document pins the values the files actually have" test fails (1 of 50) for any later migration |
| `2026-10-21-auth-separation/auth-cutover-gate.test.ts` (`test/`) | `docs/releases/2026-10-21-auth-separation` | Compares the current CDK templates with the cutover's "before" fixtures; fails (3 of 15) for any added route |
| `2026-10-21-auth-separation/web-headers-gate.test.ts` (`test/`) | same | Same comparison; fails (1 of 6) |
| `2026-10-21-auth-separation/auth-cutover-scripts.db.test.ts` (`db/test/`) | same | Drives the cutover scripts against mocked AWS; **16 of 62 fail on the unmodified code in this container** (before migration 0086 existed) |
| `2026-10-19-prd-readiness/prd-release-exec.db.test.ts` (`db/test/`) | `docs/releases/2026-10-19-prd-readiness` | Drives the production-migration executor against mocked AWS and a fixed `46|0046` ledger; **13 of 32 fail on the unmodified code** |
| `2026-10-19-prd-readiness/prd-rehearsal.db.test.ts` (`db/test/`) | same | Same family; **8 of 14 fail on the unmodified code** |

Left in place on purpose (they pass and are not pin tests): `rehearsal-diff-gate`, `rehearsal-deploy-guard`, `rehearsal-migrate`, `rehearsal-ledger-recheck`, `prd-ledger-read`, `auth-separation`, `prd-release-discovery`, `prd-deploy-scripts`, the fixtures `test/rehearsal-fixtures.ts` and `test/fixtures/`. They can be retired later with the same procedure if the owner wants.

## Retired 2026-10-31: tests of the TEST line's staff operator packages (release 2026-10-26 to 2026-10-29)
**Why.** The readiness release was integrated onto the TEST line (`fb491a5`). That integration promoted the staff migrations "0086" and "0087" from `db/pending/` into the ledger set (`db/migrations/`, `db/rollback/`) and put the readiness migration at 0088. The staff operator packages (`docs/releases/2026-10-26-redesign-operator`, `...-redesign-prd-operator`) were built for the opposite layout: migrations 0001-0085 pinned by hash and count, 0086/0087 pending and applied outside the ledger, "0086 inside db/migrations is refused". Their pin and refusal tests therefore fail by design on the integrated tree. The TEST package was executed on 2026-10-29; the production package was never executed and is superseded by the integrated release. **Moved, not deleted. Not re-pinned.** A new baseline is created only for the new release candidate.

| File (restore to) | Package | Failures on the unmodified TEST line `fb491a5` -> on the integrated tree |
|---|---|---|
| `2026-10-26-redesign-operator/operator-0086-tarball.test.ts` (`test/`) | TEST package | 5 -> 18 |
| `2026-10-26-redesign-operator/operator-0086-procedure.test.ts` (`test/`) | TEST package | 1 -> 1 |
| `2026-10-26-redesign-operator/operator-0087-apply.test.ts` (`test/`) | TEST upgrade package | 0 -> 60 |
| `2026-10-26-redesign-operator/operator-0087-sql.db.test.ts` (`db/test/`) | TEST upgrade package | 0 -> all 9 skipped (the pending files no longer exist) |
| `2026-10-26-redesign-operator/operator-prd-apply.test.ts` (`test/`) | production package | 0 -> 60 |
| `2026-10-26-redesign-operator/operator-prd-deploy-guard.test.ts` (`test/`) | production package | 0 -> 7 |
| `2026-10-26-redesign-operator/operator-prd-gate.test.ts` (`test/`) | production package | 0 -> 1 |
| `2026-10-26-redesign-operator/operator-prd-procedure.test.ts` (`test/`) | production package | 1 -> 1 |
| `2026-10-26-redesign-operator/operator-prd-web-record.test.ts` (`test/`) | production package | 0 -> 1 |
| `2026-10-26-redesign-operator/prd-discovery-package.test.ts` (`test/`) | production discovery package | 0 -> 1 |
| `2026-10-26-redesign-operator/operator-prd-sql.db.test.ts` (`db/test/`) | production package | 0 -> 5 (reads the pending files) |

The 7 failures that already exist on `fb491a5` (3 files) are pre-existing on the TEST line and are listed here for the record. Left in place (they pass on the integrated tree): `operator-0086-deploy-guard`, `operator-0086-diff-gate`, `operator-0086-ledger-recheck`, `operator-0086-scripts`, `operator-prd-ledger-recheck`, `operator-prd-snapshot-smoke`, `operator-prd-tarball` and the rest of the unit suite.
