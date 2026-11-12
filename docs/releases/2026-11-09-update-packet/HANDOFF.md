# Handoff: moving the Ogevia work to another coding agent (Codex)

Written 2026-11-09. Read `AGENTS.md`, then `CLAUDE.md`, then `UPDATE_PACKET.md` in this folder.

## 1. Where the work is
- Repository: `socalcaresservices/CarelikGlobal`. Work branch: `claude/compassionate-thompson-jk5ozb` (pushed). Last commits: `84bdc78` (migration 0089 and tests), then the update packet.
- **The live app (app.ogevia.com) does not run `main`.** It runs the line `claude/practical-tesla-r07odb` (186 commits ahead of `main`, migrations through 0088). The work branch is based on that line. Never describe the live app from `main`.
- The exact deployed commit is not confirmed (owner decision D0). Confirm it before relying on any live behavior.

## 2. What is finished and what is not
| Item | State |
|---|---|
| Migration 0089: App sign-in becomes a follow-up, not a hard requirement for approving, assigning, or scheduling a caregiver | Implemented and tested locally. **Not applied to any database.** It lives in `infra/aws/db/pending/` (not `migrations/`) on purpose: eight existing tests pin "88 migrations, latest 0088". Releasing it is an owner-approved step (see `infra/aws/db/pending/README.md`). |
| Everything else in `UPDATE_PACKET.md` | Proposed only. Nothing built. |
| CI / pull request | None yet. No GitHub Actions run exists for the branch. |

## 3. How to run the checks (what actually worked)
```bash
pnpm install --frozen-lockfile
pnpm --filter @carelik/web typecheck
pnpm --filter @carelik/web lint
pnpm --filter @carelik/web test
pnpm --filter @carelik/infra-aws typecheck
```
Database tests need a local PostgreSQL 16 superuser (the migrations create roles and `btree_gist`):
```bash
export OGEVIA_TEST_DATABASE_URL=postgres://postgres:<password>@127.0.0.1:5432/postgres
cd infra/aws && npx vitest run --config vitest.db.config.ts                      # all (about 5 min)
cd infra/aws && npx vitest run --config vitest.db.config.ts db/test/signin-followup-0089.db.test.ts
cd apps/sv-api && npx vitest run --config vitest.db.config.ts test/caregiver-readiness-http.db.test.ts
```
Last full results on the work branch: infra DB 102 files / 1,127 tests pass; web 130 files / 1,266 tests pass; typecheck and lint clean.

Run the app locally with synthetic people and no passwords (the "local harness", see `infra/aws/local-harness/README.md`):
```bash
export HARNESS_ADMIN_URL=postgres://postgres:<password>@127.0.0.1:5432/postgres
pnpm --filter @carelik/infra-aws harness:setup
pnpm --filter @carelik/infra-aws harness:build
pnpm --filter @carelik/infra-aws harness:serve     # https://localhost (needs port 443)
```
Note: the harness builds the current checkout. On the work branch that is the live line; on `main` it is older.

## 4. Lessons from this session (avoid repeating them)
- I first answered from `main` and was wrong about the live behavior. Check the branch against the owner's screenshots before concluding anything.
- Migrations not yet released go in `infra/aws/db/pending/` with their own test that applies the file on top of 0001-0088 (see `db/test/signin-followup-0089.db.test.ts`). Putting one in `migrations/` breaks the pinned-set tests.
- A force-push to the work branch was blocked by the environment; a normal merge worked. Prefer non-destructive git operations.
- The live site could not be opened from the previous environment, and signing in needs an account. Live verification needs either screenshots or a test account with fake data only.

## 5. Open decisions (owner)
D0 deployed commit; D1 schedule-first direction; D2 billing status of manager-entered past visits; D3 when to release 0089 (TEST first); D4 Excel import library; D5 where the review queue lives; D6 CalEVV path; D7 caregiver-facing client label. Full wording in `UPDATE_PACKET.md` section 2.

## 6. Suggested next steps
1. Open a pull request for the work branch so CI builds it (no PR exists yet; the owner has not asked for one).
2. Resolve D0, then reproduce the dashboard "could not be loaded" error and the failing Notifications count on the matching build.
3. Fix the help overlay bug B-01 (small and low risk); then the cleanup items in `UPDATE_PACKET.md` section 13.
