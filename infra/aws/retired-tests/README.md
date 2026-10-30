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
