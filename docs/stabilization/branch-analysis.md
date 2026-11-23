# Branch analysis (computed from git, 2026-11-23)

STATUS: COMPLETE. Every number below is computed with `git rev-list`, `git merge-base --is-ancestor`, `git merge-tree` against `origin/*` fetched on 2026-11-23. Appendices: `appendix-commits-release-not-on-main.txt` (339 non-merge commits), `appendix-unmerged-branches.txt` (91 branches).

## 1. Production commit lineage
Production release commit: `c7691b637621783615c1977d1f14e0f24e8f3689` (2026-11-22, migrations 0111 + 0112, nine routes, web). It sits on branch `claude/sharp-mendel-sy1p24`.
Production deployments recorded in the repo and where each sits relative to c7691b63 and to `main`:
| Production event | Commit | In c7691b63 | On main |
|---|---|---|---|
| Staff-management routes + 0086 (2026-10-26) | 515c49af | yes | no |
| UX release (2026-11-11) | 48fa30f3 | yes | no |
| Sign-in override routes (2026-11-15) | b3a22741 | **no** (branch `claude/keen-hawking-e9o2jg`) | no |
| PR #113 release, request cleanup switch OFF (2026-11-21) | bd5955e3 | yes | no |
| Offices + request cleanup ON (2026-11-21) | aeaed304 | yes | no |
| Office assignments, counties, colour, history (2026-11-22) | c7691b63 | yes | no |
First-parent merge spine of c7691b63 (newest first): PR #119 → #118 → #117 → #116 → #115 → #114 (all into the PR #113 branch `claude/ops-fixes-requests-documents-sorting`) → `origin/prod-ux` merge 5f2f940e → earlier main-based tip df862ad6 → TEST line 908ad8f1 → main 466f8ac9 (PR #102, 2026-10-24).
Diff main..c7691b63: 892 files, +72,166 / -2,256; 351 commits (339 non-merge: 116 in 2026-10, 223 in 2026-11; 318 by "Claude", 21 by "SCS"); 12 merge commits; areas: docs/releases 337 files, infra/aws 210, apps/web 191, docs/ux 104, apps/sv-api 27.

## 2. Branches containing c7691b63
Only `origin/claude/sharp-mendel-sy1p24`. (Its tip `35327465` is 7 commits past c7691b63: records and the two production correction-wrapper fixes.)

## 3. Branches not merged into main
91 remote branches are not merged into `main`; 85 of them carry commits that are not in c7691b63. The five named in the brief:
| Branch | Tip | Commits not in c7691b63 | Commits c7691b63 has that it lacks | In c7691b63 lineage |
|---|---|---|---|---|
| claude/sharp-mendel-sy1p24 | 35327465 | 7 | 0 | contains it |
| claude/ops-fixes-requests-documents-sorting (PR #113 branch) | ef90a2a4 | 0 | 59 | **yes** (ancestor) |
| claude/ogevia-ux-audit-redesign-w36cov (PR #113 target) | 2b07ae43 | 1 (the #113 merge commit) | 59 | no (contains the #113 tip; release is ahead) |
| claude/keen-hawking-e9o2jg | a2b75e18 | 15 | 98 | no |
| claude/peaceful-clarke-uw8l1h | 1bd7f28a | 1 | 351 | no |
Other branches with commits since `main` (2026-10-24) that are not in c7691b63:
| Branch | Tip / date | Not in release | Content (from git) |
|---|---|---|---|
| claude/magical-rubin-d40thi | cbceb5f7 / 2026-11-23 | 8 | **Open Shifts board + automatic SMS** (54 files, +5,321/-283), based on `main` (merge-base 466f8ac9). **Its migration is `0086_open_shifts_board_and_sms.sql`, which collides with production's `0086_staff_management.sql`.** Brief: `docs/releases/2026-11-23-open-shifts-sms/BRIEF.md` (owner, 2026-11-22). SMS transport is a mock; no email transport. |
| codex/cover-shift-text | 468eeefe / 2026-11-22 | 1 | Draft PR #121: a copyable cover-shift text on the AWS schedule page (13 lines in `schedule-page.tsx`). |
| claude/compassionate-thompson-jk5ozb | daecfc75 / 2026-11-21 | 3 | Two web fixes: failed requests say what failed; single-value Dashboard charts not drawn as a solid block; Care Request help panel. |
| claude/magical-lovelace-9y5ras | 8e75180d / 2026-10-30 | 24 | older line (not analysed further) |
| claude/sharp-newton-xfkb8c | f2208bd1 / 2026-10-25 | 3 | older line |

## 4. Commits in production but absent from main
351 (339 non-merge). Full list: `appendix-commits-release-not-on-main.txt`. In practice every production release since 2026-10-26 is absent from `main`. Additionally, 15 production-related commits are in **neither** main **nor** c7691b63: branch `claude/keen-hawking-e9o2jg` (the 2026-11-15 production sign-in-override deployment records and script, the config change that enables the override for production, and the migration 0108 proposal).

## 5. Commits in main but absent from production
**0.** `main` (466f8ac9) is an ancestor of c7691b63 (`git merge-base --is-ancestor` = yes). Merging c7691b63 into main is therefore a fast-forward: no conflicts.

## 6. Merge conflict risk (trial merges with `git merge-tree`, nothing written to any branch)
Merging each branch into the release tip `35327465`:
| Branch | Result | Conflict files |
|---|---|---|
| claude/keen-hawking-e9o2jg | 1 conflict | `docs/ux/REQUIREMENTS-TRACKER.md` (both sides appended tracker rows). **Auto-merges `infra/aws/lib/config.ts`** (it enables the sign-in override for production, matching production reality) and `infra/aws/db/pending/README.md` |
| claude/peaceful-clarke-uw8l1h | clean | none |
| claude/ogevia-ux-audit-redesign-w36cov | clean | none |
| claude/compassionate-thompson-jk5ozb | clean | none |
| codex/cover-shift-text | clean | none |
| claude/magical-rubin-d40thi | **11 conflicts** | `apps/sv-api/test/tenant-isolation-sweep.db.test.ts`, `apps/web/src/aws/aws-shell.tsx`, `pickup-requests.tsx`, `route-map.test.tsx`, `schedule-page.tsx`, `sidebar-home.test.tsx`, `wave1.test.tsx`, `pages/calendar-authorised-hours.test.tsx`, `infra/aws/db/scripts/migrations.ts`, `infra/aws/db/test/readiness-restore.db.test.ts`, `readiness-rollback.db.test.ts`, plus the **migration number collision (0086)** |
Highest-risk areas in general: `apps/web/src/aws/schedule-page.tsx`, `infra/aws/lib/service-verification-api-stack.ts` and `config.ts` (route switches), `infra/aws/db/scripts/migrations.ts` (runner ranges), `docs/ux/REQUIREMENTS-TRACKER.md`.

## 7. Exact merge recommendations (in this order)
1. `main` ← `c7691b63` **fast-forward** (no conflict; 351 commits). Do through the reconciliation branch and a reviewed PR, never a direct push to main.
2. Then merge `claude/keen-hawking-e9o2jg` (resolve only the tracker file by keeping both sets of rows). This brings the sign-in-override production records and the config that matches production; the 0108 proposal arrives as a *proposal* (see `database-audit.md`).
3. Then merge `claude/peaceful-clarke-uw8l1h` (save-to-phone help; clean), `claude/compassionate-thompson-jk5ozb` (web fixes; clean). `codex/cover-shift-text` (draft PR #121) only if the manual copyable text is still wanted; it overlaps the Open Shifts work.
4. **Do not merge `claude/magical-rubin-d40thi` as is**: it is built on the wrong base, collides with production migration 0086, and has 11 conflicts. It needs a port (see `executive-summary.md`, Phase 7 decision).
5. Close or archive the remaining 80+ stale branches only after the owner confirms; none was touched.
