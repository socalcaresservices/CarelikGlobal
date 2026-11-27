# CLAUDE.md — Ogevia (socalcaresservices/CarelikGlobal)

Short project rules that load every session. The full authoritative build directive is
`docs/engineering/OGEVIA_AWS_MASTER_DIRECTIVE.md`. **Read it before any work on AWS/CDK, infrastructure,
database schema or migrations, RLS/auth, authorizations, scheduling, visits/Service Verification, or billing.**
If this file and the directive conflict, the directive wins unless the owner says otherwise.

## Repo

- pnpm 9 monorepo with Turbo. Apps: `apps/web` (Vite/React, `@carelik/web`), `apps/sv-api`, `apps/netlify-functions`.
  Packages: `packages/auth`, `packages/shared`, `packages/ui`. Infra: `infra/aws` (CDK, us-west-2). DB: `supabase/`.
- Commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:all`.
  Single app: `pnpm --filter @carelik/web <script>`.

## Start of every task

- Follow the owner's current instruction. Historical build phases do not restart on their own.
- Read `docs/ux/REQUIREMENTS-TRACKER.md` every session — single source of truth for the UX redesign. A row is DONE
  only with evidence; never delete rows (mark SUPERSEDED with a reason); nothing is "verified on demo" until the owner confirms.
- Confirm branch and freshness (`git fetch origin main`, check HEAD) before describing current state.
- Inspect and reuse existing code. No duplicate components, endpoints, tables, rules, or tools.
- Don't reopen settled decisions (AWS/CloudFront hosting, PostgreSQL, API route set) without a concrete need and owner OK.

## Never break

- Tenant isolation: every tenant path scoped by `organization_id`; RLS where applicable. Cross-tenant exposure = P0.
- Financial/authorization logic runs server-side. Never trust client-sent org, role, balance, billable amount, time, or status.
- Keep states separate: authorized → reserved → scheduled → worked → confirmed → reconciled → billing ready →
  human billing approval → submitted/billed. Billing Ready ≠ billed. Final billing approval is a human action.
- No PHI or payer/member IDs in URLs, filenames, logs, analytics, or test fixtures.
- Service Verification is not California EVV/Sandata. Don't claim "EVV compliant" or "HIPAA compliant."

## Needs explicit owner approval (prepare, then stop)

`cdk deploy/bootstrap/import`, applying migrations to any AWS/Supabase database, IAM/security-group/DNS changes,
Netlify/Supabase production config, production data changes, anything adding recurring cost, `git push`, merging PRs.
Never: delete production data, force-push `main`, disable encryption/auth/audit logging, bypass security to pass tests.

## Done means

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` pass (plus suites named in
  `docs/TESTING_AND_RELEASE_PROCESS.md` for releases). Report failures; never weaken a test to pass.
- Releases follow `docs/TESTING_AND_RELEASE_PROCESS.md` and `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`.
- Say exactly what is proposed / implemented / tested / deployed. Implemented never means deployed.
- Record briefs, decisions, and notes under `docs/releases/`.
