# Reconciliation report: branch `stabilization/main-reconciliation`

STATUS: COMPLETE (branch built and tested; **not pushed to main and not merged**: `main` is untouched). Built from `origin/main` (466f8ac9, 2026-10-24) in an isolated worktree.

## Result
`stabilization/main-reconciliation` contains: all of `main` (ancestor: yes), the production release commit `c7691b63` (ancestor: yes), and the 15 production-record commits of `claude/keen-hawking-e9o2jg`. Because `main` is an ancestor of the release, **no content of main was overwritten and there is nothing in main that the release lacks**.

## Every merge (in order)
| # | Commit | Merge | Parents | Conflicts |
|---|---|---|---|---|
| 1 | 88f17b1a | `35327465` (the release line: contains c7691b63 plus the post-release production correction records and the audit; the last commit before any stabilization work) into main, `--no-ff` so the join point is visible | main 466f8ac9 + 35327465 | **none** (main is an ancestor: all 351 commits applied cleanly) |
| 2 | 20f70234 | `origin/claude/keen-hawking-e9o2jg` (tip a2b75e18; 15 commits: sign-in override production deployment records and script, `config.ts` change for the override, migration 0108 proposal) | 88f17b1a + a2b75e18 | **1** (below) |
| 3 | 1aa9ae04 | not a merge: re-pin of the release pins to the new application state | 20f70234 | none |
Not merged, on purpose: `claude/peaceful-clarke-uw8l1h` (save-to-phone help) and `claude/compassionate-thompson-jk5ozb`: neither was ever deployed to production, so they are not production lineage; they merge cleanly and are listed in `branch-analysis.md` section 7. `claude/magical-rubin-d40thi` (Open Shifts + SMS): not production, not mergeable as is (11 conflicts and a migration-number collision).

## Every conflict and resolution
| File | Cause | Resolution |
|---|---|---|
| `docs/ux/REQUIREMENTS-TRACKER.md` (change log) | Both sides appended change-log entries at the same place: the release line added the 2026-11-17 to 2026-11-20 entries (R32 to R39); keen-hawking added the three 2026-11-15 production entries for the sign-in override (deployed, accepted, monitoring). | Kept **both** blocks, in date order (the three 2026-11-15 production entries first, then the 2026-11-17 and later entries). No entry was edited or removed (the tracker's own rule 3 forbids deleting rows). |
Auto-merged without conflict but reviewed because they change behavior:
| File | Effect |
|---|---|
| `infra/aws/lib/config.ts` | The production environment now has `signInOverride: true`. **This matches production reality** (the override routes are live in production since 2026-11-15; before the merge the repository said false). `bulkImport` and `staffDuplicates` stay false (those routes are absent in production). |
| `infra/aws/db/pending/README.md` | lists the 0108 proposal |
| `infra/aws/db/pending/production-alignment/0108_*.sql` | proposal files arrive in a sub-directory the migration runner does not load: **not applied, not in any ledger** |
| `apps/sv-api/test/signin-override.db.test.ts`, `infra/aws/test/*switch*.test.ts`, `slice-contract.test.ts`, `staff-routes-switch.test.ts` | tests updated by keen-hawking for the production enablement; they pass here |

## Production behavior preserved
No application code of the release line changed in step 1. Step 2 changes only configuration and tests/docs; the only behavior-relevant line is the production `signInOverride` flag, which now equals what production runs. The release scripts operate on the live template (they do not read this flag), so the released procedures are unaffected.

## Verification on the reconciliation branch
- `pnpm typecheck` (infra): clean.
- `release_pins` re-pinned (the guard correctly refused the merge until re-pinned: application files had changed since the pinned commit: `config.ts`, the pending README and the 0108 proposal). After re-pin: release-pins, sign-in-override switch, staff-routes switch, slice-contract, production-config and offices-switch tests: 63 passed.
- Full infra unit suite and the sign-in-override API test: see `validation-report.md` (run on this branch).

## How to land it (not done)
Open a PR `stabilization/main-reconciliation` → `main`, review, and merge as a **merge commit** (not squash: squashing would erase the 339-commit history this branch preserves). I did not push to or modify `main`.
