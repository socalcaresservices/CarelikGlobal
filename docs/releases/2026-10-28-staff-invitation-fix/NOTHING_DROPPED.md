# Commit lineage and nothing-dropped verification

Written 2026-10-28. Every statement is from `git` in this checkout (VERIFIED) unless it says otherwise. The earlier session's unpushed work was lost with its container; this document shows what the rebuilt candidate contains and what it does not.

## 1. Identity and lineage
| Item | Value |
|---|---|
| **Candidate code commit** (what both tarballs name; the code `git archive` takes) | `fb491a554c0fdc484102025179c9c993f694b4e0` (`fb491a5`) |
| Parent of the candidate | `773b7625…` (`773b762`, "TEST upgrade package…") |
| Branch | `claude/magical-lovelace-9y5ras`, created from `origin/claude/redesign-review-nav-ui` at `644d6e2` (PR 106's head when the earlier session crashed). `git merge-base --is-ancestor` confirms `origin/main`, `644d6e2`, `24fd8b1`, `f8cd7df` and `7870a04` are **all ancestors** of the candidate. |
| Lineage (oldest to newest) | `origin/main` `466f8ac` → 34 commits of PR 106 → `7870a04` (code deployed to TEST) → `f8cd7df` (earlier production candidate; superseded) → `d788c1f` (environment band on the sign-in screens) → `24fd8b1` (config comment; the production candidate named in PR 106) → `644d6e2` (PR 106 head at the crash; records only) → `69e61bf` (the fix: 0087, accept route, web) → `9945cfa` (production package scripts, WIP) → `730b601` (rollback test; the first pinned candidate, **superseded**) → `468db93`, `773b762` (re-pin of both packages) → **`fb491a5`** (0087 completed: Disable guard, Invited-before-Disabled; the final pinned candidate) → documentation and package commits after it (the package folders are taken from the working tree at build time; code is `git archive fb491a5`). |
| Commits since PR 106's head | 8 (`git rev-list --count 644d6e2..HEAD`) at the time of writing, plus the final documentation commit(s) |

## 2. What the handoff said versus the repository
| Handoff statement | Finding |
|---|---|
| "Release candidate `f8cd7df`" | **Superseded** in PR 106 by `24fd8b1` (a comment-only change to `config.ts` and the environment band on the sign-in screens). Both are ancestors of the candidate. |
| "Label fix `5de9ee2` committed locally, possibly not pushed" | `5de9ee2` **does not exist** in any ref or object here. It was never pushed. I could not tell whether it differed from `d788c1f` (the environment band on the sign-in screens, which is pushed and included). **NOT VERIFIED whether anything in `5de9ee2` is missing.** |
| "TEST runs `7870a04`" | Consistent with `DEPLOYED_RECORD_TEST.md` (VERIFIED as of 2026-10-26; not re-read live). |
| "fix migration plus API/UI for M-1, L-2, L-3 and L-1" | Lost; **re-implemented from scratch** per the Owner's Option B description (migration 0087, accept route, web panel). It cannot be compared with the lost version. |
| "promoting 0086 into `migrations/`" | **Not done and not part of this candidate.** 0086 stays in `db/pending` (decision D-P2 is still the Owner's); the packages apply 0086/0087 outside the ledger. |
| "TEST adoption path" | Replaced by the **0087-only TEST upgrade** (0086 already on TEST stays as it is). |

## 3. Nothing-dropped: the candidate against each earlier reference
Method: `git diff --name-status <reference> fb491a5` over the product-code paths (`apps`, `packages`, `infra/aws/lib`, `infra/aws/bin`, `infra/aws/db/migrations`, `infra/aws/db/rollback`, `supabase`, `netlify.toml`, `.github`, `package.json`, `pnpm-lock.yaml`).

| Reference | Files **deleted** in product paths | Files **modified** | Files **added** | Reading |
|---|---|---|---|---|
| `24fd8b1` (production candidate of PR 106) | **0** | 8: `apps/sv-api/src/routes.ts`, `apps/sv-api/test/staff.db.test.ts`, `apps/web/src/aws/aws-shell.tsx`, `aws-workspace.ts`, `staff-pages.tsx`, `staff-pages.test.tsx`, `apps/web/src/lib/sv-backend-aws.ts`, `infra/aws/lib/service-verification-api-stack.ts` | 2: `apps/web/src/aws/pending-invitations.tsx`, `pending-invitations.test.tsx` | Exactly the files of this work. Nothing else in product code changed. |
| `f8cd7df` (earlier candidate) | 0 | 13 (the 8 above, plus `.github/workflows/ci.yml`, `aws-auth-pages.tsx`, `environment-marker.tsx`, `environment-letterhead-availability.test.tsx`, `infra/aws/lib/config.ts`) | 2 | The 5 extra files are the `f8cd7df`→`24fd8b1` changes recorded in PR 106 (CI time limits, environment band on the sign-in screens, a comment in `config.ts`). All are present in the candidate. |
| `7870a04` (code on TEST now) | 0 | 13 (as above) | 2 | Same set: TEST gets the PR 106 additions since `7870a04` plus this work. |

Migrations: `infra/aws/db/migrations` is **byte-identical** at `7870a04`, `24fd8b1` and `fb491a5` (the 0001-0085 set hash `de0c8abbe120…` is pinned and tested). `0086_staff_management.sql` (`8eb7b4a353300ba7…`) and its rollback (`d2773fdfdf50…`) are **byte-identical** to `24fd8b1`. No applied migration was edited.

Routes: `apps/sv-api/src/routes.ts` gained one route and one field; no route was removed (the full unit and API suites pass; the stack route list test `slice-contract` compares both lists). The synthesized API stack differs from `7870a04`'s only by the accept route and the Handler asset (the TEST gate checks exactly that on the real templates).

Tests: no test was skipped, deleted or weakened in product suites (the CI rule `test:all` fails on any skipped test). Counts are in section 5.

## 4. Differences found, and why they exist
| Difference | Why |
|---|---|
| `OPERATOR_PROCEDURE_7870a04.md`, `apply-0086-test.sh`, `operator-0086-apply.test.ts` renamed to `OPERATOR_PROCEDURE_fb491a5.md`, `apply-0087-test.sh`, `operator-0087-apply.test.ts` (and their text rewritten) | The TEST package is now an **upgrade** package (0087 only, on top of 0086). The executed 7870a04 procedure and script remain in git at `644d6e2`; `DEPLOYED_RECORD_TEST.md` is the record of what ran and is untouched. |
| `infra/aws/db/test/operator-0086-sql.db.test.ts` **deleted**, replaced by `operator-0087-sql.db.test.ts` | The old file tested the TEST copy of "install 0086 from nothing"; the identical logic is covered by `operator-prd-sql.db.test.ts` (same SQL, apply/verify/sabotage/rollback/round trip), which is kept and extended for 0087. The new file tests the TEST state (0086 present, apply 0087 alone, roll back 0087 alone). **This is a removed test file; it is disclosed, not hidden.** |
| `infra/aws/test/fixtures/operator-0086/live` (e80b770 templates) deleted; `release` (7870a04 templates) moved to `live`; new `release` (candidate templates) | The TEST diff gate now compares what TEST runs (7870a04) with the candidate. The decision-D2 "hostnames not live" tests and the CORS catch-up allowance were removed with it: those hostnames are live on TEST since 7870a04, and any CORS/hostname difference is now a violation (stricter). |
| TEST `diff_gate.py`: allow-list narrowed from 13 routes + a CORS catch-up to **one** route + Handler | Same reason. |
| `new-route-keys.json`: TEST lists the 1 route the upgrade adds; production lists all 14 | TEST already has the other 13. |
| Stray bytecode `__pycache__/assembly_check.cpython-313.pyc` | I committed it by accident while running a local check, then removed it; it is not in the candidate, nor was it at `644d6e2` (VERIFIED by `git ls-tree`). |
| Production tarball: 0086 and 0087 both applied in one transaction (`apply-0086-prd.sh` extended, not renamed) | The Owner's requirement: keep 0086 byte-identical and add 0087 as a separate migration. |

## 5. Test counts (before and after)

| Suite | Baseline `644d6e2` (PR 106 head) | Deployment SHA `fb491a5` (measured in local runs at documentation head `215b7c6`; code and tests are the same at `cea8b47` except the DST test fix) |
|---|---|---|
| shared / auth / ui | not re-run (no change) | 118 / 150 / 73 passed |
| sv-api unit | 96 passed | 96 passed |
| web | 1265 passed, 1 failed (one run, 1266 total; the failing test was not identified; a second run was not inspected) | 1270 passed, 0 failed |
| infra-aws static | NOT MEASURED at baseline | 1025 passed |
| sv-api DB (PG16 local) | not run at baseline | 22 files, 153 passed |
| infra-aws DB (PG16 local) | 4 files, 28 failed / 86 passed (same four files) | 28 failed in the same 4 files (1226 passed of 1254) |

The 28 infra DB failures are **identical in files and counts on the baseline** (`auth-cutover-scripts` 6, `prd-release-exec` 13, `prd-rehearsal` 8, `dst-local-times` 1): VERIFIED pre-existing in this sandbox (private PostgreSQL crashes, one date-dependent test, since fixed in `cd57ffb`; see `RELEASE_MANIFEST.md` section 4). They are not caused by this work, but they are **not proven to pass** here; CI on PostgreSQL 18 is the arbiter and has not run (see the manifest).
