# Phase 8 — Security and dependency review

Date: 2026-11-23 · STATUS: **COMPLETE for production dependencies (0 known advisories after upgrade); dev-tool advisories remain, documented below (NEEDS HUMAN INPUT only if the owner wants the vitest major upgrade now)**
Tool: `pnpm audit` (registry advisory data at the time of the run, 2026-11-23; the advisory database changes daily).

## Before and after
| Scope | Before | After |
|---|---|---|
| Production dependencies (`pnpm audit --prod`) | 5 advisories: 2 high (react-router; zod), 3 moderate (qs ×3) | **0** |
| All dependencies including dev | 53 (2 low, 23 moderate, 24 high, 4 critical) | 21 (8 moderate, 9 high, 4 critical) — every one dev-only (below) |

## The named items
| Item | Finding | Action | Breaking change |
|---|---|---|---|
| react-router (web) | 7.18.1: high, "RSC mode CSRF bypass allows action execution" (≥7.12.0 <7.18.2). **Not reachable**: the web app uses the data-router/BrowserRouter model, not RSC mode (INFERRED from imports) | `react-router-dom` `^7.1.1` → `^7.18.6` (resolved 7.18.6) | None (same major) |
| zod | 3.25.76 (web, shared): high, memory exhaustion validating oversized constrained collections (fixed in 4.x) | `zod` `^3.24.1` → `^4.6.7` in `apps/web` and `packages/shared` | Major. `packages/shared` (13 files) and `apps/web/src/env.ts` compile unchanged; shared suite 118/118 pass. `@hookform/resolvers` 3.x is **not used** with zod anywhere (grep), so its zod-4 incompatibility does not apply. Full gate results: `validation-report.md` |
| qs | 6.15.3 via `stripe@18.5.0` (apps/netlify-functions): 3 moderate DoS | root `pnpm.overrides` `"qs@<6.16.1": "^6.16.1"` (resolved 6.17.1) | None expected; netlify-functions is the legacy Supabase/Stripe path |
| Safe in-range updates | outdated | `pnpm update -r` within declared ranges: @aws-sdk 3.1144→3.1175 (sv-api), jose 6.2.18, @tanstack/react-query 5.108.3, react-hook-form 7.92, supabase-js 2.119.2, vite 6.4.6, TypeScript 5.9.3, tsx, vitest 2.1.9, tailwind patch levels, postcss | Minor/patch only |
| Deliberately NOT upgraded | `aws-cdk-lib` 2.272 → 2.278, `aws-cdk` and `cdk-nag` 3.1: a CDK library change can alter synthesized templates for a pinned, production-aligned stack; needs a `cdk diff` against production by the owner's operator. `@types/react`/`react` 19, `@eslint/js` 10, `@types/node` 26, `@testing-library/jest-dom` 8, `@hookform/resolvers` 7, `@netlify/functions` 6: major upgrades with no security need | Leave; revisit as a planned task |

## Remaining advisories (all dev-time, none in a deployed bundle)
- **vitest 2.1.9 / tinypool / @vitest/mocker** (4 critical, 3 moderate): exploitable only when the Vitest UI/API server is listening or when running untrusted test code. CI and this repo run `vitest run` (no UI server) on repository code. Fix is vitest ≥3.2.6 (major, touches every package's test config). Recommendation: schedule as its own change after the production release; risk accepted meanwhile (INFERRED, low).
- **toml, extract-zip, glob, minimatch, zod (inside `@netlify/functions`' packager)**: dev dependency of the legacy `apps/netlify-functions` (build-time). Not deployed code. Retire with the Netlify functions.

## Other security observations (from this stabilization pass)
- Config drift: production API switches now match the live deployment in code (see `configuration-drift.md`); no secret values were read or printed anywhere in this review.
- Branded invitation (7.2) and sorting changes add no new routes, data paths or permissions. The renderer validates and escapes all brand values.
- Unchanged and still open from earlier reports: ownership drift on four tables/17 functions (`ogevia_admin`) and the two undocumented manual production grants of 2026-11-14 (database-audit.md); needs the owner's read-only capture.
- Not performed: secret scanning of history, container/Lambda image scanning, penetration testing, SAST beyond lint/typecheck. The repository's `security-review` skill and a GitHub secret scan could be run on request.
