# Production-readiness report (separate from the UI work)

Status date: 2026-10-18. Local, read-only inspection of the repository only. No AWS, Netlify or GitHub-settings access was used.

## Figures previously reported
- "6 unapproved caregiver-service pairs" and "22 of 37 future shifts fail document or hours checks": these came from the Care Team screenshots of the LOCAL harness (synthetic seed). They are HISTORICAL and UNVERIFIED as anything about TEST or Production. Verifying them needs authorised read-only access to the live database (the Care Team readiness screen on TEST, signed in as an administrator, shows the live values; I have not seen them).

## Service checks and document enforcement (reported separately, neither changed here)
- Service checks (approved caregiver-service pairs): a separate switch; local synthetic state is Off. Live state: UNKNOWN from here.
- Document/availability/conflict enforcement ("readiness checks"): a separate setting; live state: UNKNOWN from here. The TEST operation of 2026-10-18 kept enforcement off by instruction.
- This work activates nothing.

## Deployment triggers (read-only; four systems reported separately)
| System | Evidence | Finding |
|---|---|---|
| GitHub Actions | `.github/workflows/ci.yml` (only workflow) | Runs on every pull request and on pushes to `main`. Install, typecheck, lint, build, test, then builds and uploads a 7-day TEST bundle artifact. `permissions: contents: read`, no secrets, no AWS or Netlify step. It cannot deploy. |
| Netlify | `netlify.toml` | Build command and publish folder are configured (`pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @carelik/web build`, `apps/web/dist`). Which branch is the production branch, whether auto-publishing and deploy previews are on, and the real environment variables are Netlify site settings: NOT VERIFIABLE from the repository. Note: `netlify.toml` pins Node 20 while CI and the release gates use Node 22. The file contains the public Supabase anon key for deploy previews (browser-safe by design). |
| GitHub apps | none readable from the repository | Installed apps and their permissions are GitHub organisation settings: UNKNOWN. |
| AWS automation | CDK in `infra/aws` | The repository has no workflow that deploys. Deployed automation I know of from the 2026-10-18 TEST operation: the scheduled ComplianceSweep (enabled in TEST by the owner's approval). Production state of any rule: UNKNOWN. |
Repository configuration alone cannot prove the external settings are safe.

## Remaining setup, environment and real-login checks (not UI work)
- Owner's 13 signed-in browser checks on TEST: not yet reported to me.
- Document upload on TEST: a fix is prepared locally (Batch 1) and NOT deployed; the CDK change needs network and API stack deploys, which need the owner's approval.
- Production ledger (`ogevia_prd`) never read; current TEST ledger not re-read since the operation.
- Real caregiver sign-in on a phone: not performed.
- Pending owner decisions: freeze lift, merging PRs #100 and #101.
