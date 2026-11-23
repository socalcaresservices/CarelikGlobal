# Executive summary — stabilization of Ogevia (2026-11-23)

## Where things stand
Production runs release commit **c7691b63** (ledger 111 rows, 0001–0112 minus 0108). Branch `stabilization/main-reconciliation` now contains **main, the whole production lineage and the config alignment**, passes every repository gate, and is **ready for a pull request into `main`** (a human action; main is untouched). Nothing in this work was deployed or applied to any AWS environment.

| Phase | Deliverable | STATUS |
|---|---|---|
| 1 Git audit | `branch-analysis.md` (computed ancestry; main is 351 commits behind the release) | COMPLETE |
| 2 Reconciliation | branch built, 2 merges, 1 documented conflict, pins re-pinned; `reconciliation-report.md` | COMPLETE |
| 3 Configuration drift | `configuration-drift.md`; 4 production switches aligned in code (270 live routes computed to equal the synth) | COMPLETE; items needing live reads → NEEDS HUMAN INPUT |
| 4 Database audit (0108) | `database-audit.md`; schema fingerprint baseline + read-only comparison script | COMPLETE; 0108 verdict needs one owner read-only capture |
| 5 Sorting | 8 targets implemented with the existing sort framework; `sorting-completion.md` | COMPLETE (legacy Supabase-path tables: NEEDS HUMAN INPUT) |
| 6 Feature readiness | `feature-readiness.md`: bulk import FIX FIRST; duplicate merge DO NOT ENABLE; save-to-phone ENABLE after merge | COMPLETE |
| 7.1 Cover shift notifications | `cover-shift-notifications.md`: in-app exists; email/SMS are on another branch, need owner decisions | **NEEDS HUMAN INPUT** |
| 7.2 Branded invitation emails | renderer, optional pool setting (OFF), previews, 7 tests | COMPLETE (per-office branding NOT BUILT; sender needs SES decision) |
| 8 Security | `security-review.md`: production dependency advisories 5 → 0 | COMPLETE (dev-tool advisories remain) |
| 9 Validation | `validation-report.md`: lint, typecheck, build, unit, database, API all pass | COMPLETE |
| 10 Deployment package | `deployment-plan.md` (proposed; owner gates) | COMPLETE |

## Live features (in production now, VERIFIED by release records, not re-checked live today)
Offices and counties; multiple office assignments with history; caregiver and dashboard colors; request cleanup; sign-in override; corrected-invitation procedure (used once). Switches ON: staffManagement, signInOverride, requestCleanup, offices, officeAssignments, assignmentHistory.

## Deployed features
Same list as live. The 2026-11-22 feature release has **not yet been confirmed by the owner in the production app** (open item).

## Built but not deployed / missing
Sorting completion and dependency security fixes (this branch); bulk import (TEST ON, production OFF); duplicate staff merge (OFF everywhere); save-to-phone help (other branch); Open Shifts + SMS (other branch, needs renumbering and owner decisions); branded invitation (built, off); cover-shift email (not built).

## Branch status
`main` = 466f8ac9 (ancestor of production). Stabilization branch contains c7691b63. Not merged: `claude/magical-rubin-d40thi` (11 conflicts, migration number clash), `claude/peaceful-clarke-uw8l1h`, `claude/compassionate-thompson-jk5ozb`, `codex/cover-shift-text`.

## Configuration drift status
Repository now equals production for all route switches; one structural difference is intentional (6 TEST-only `liveTestRepairs` routes). Two manual 2026-11-14 production DB changes and ownership drift remain **undocumented in migrations** until the 0108 capture/comparison is run.

## Migration status
Ledger 111/0112, 0108 absent and proposal-only. No migration added by this work. Next free number 0113.

## Deployment readiness score
**7 / 10** for a web (+ no API change) release: gates pass, API bundle unchanged, rollback is a web restore. Lost points: no TEST run of this exact commit, no real-phone/email-client checks, no live drift capture after the merge. For anything involving bulk import, duplicate merge, notifications or the invitation template: **not ready** (see each document).

## Remaining risks
1. Unverified live state: items listed in `configuration-drift.md` and the 0108 capture.
2. zod 4 and react-router upgrades verified by tests only, not in a deployed bundle.
3. Dev-tool advisories (vitest critical, dev-only) accepted until a planned vitest 3 upgrade.
4. Open Shifts work diverges further from the release lineage with each release.
5. Legacy `pages/*` tables (not sorted) may or may not be live.

## Decisions I need from the owner
1. Open a PR from `stabilization/main-reconciliation` to `main` and merge as a merge commit (my recommendation: yes).
2. Cover-shift notifications: recipients, channel (recommend in-app + email first), limits, SMS provider.
3. Run the two read-only production captures (0108 capture; schema comparison) so drift can be closed.
