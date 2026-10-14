# Wave 1 post-merge verification (PR #87, main at 63de403)

Date: 2026-10-14. Read-only. Nothing deployed, no migration applied, no Netlify or environment change.

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Netlify production deploy for 63de403 | VERIFIED (owner-reported) | Owner confirmed on 2026-10-14 from Netlify: `63de403` published to www.ogevia.com on 2026-10-13; all five stages (Initializing, Building, Deploying, Cleanup, Post-processing) completed; build about 2 minutes; no failure. Claude Code has no Netlify access and did not observe this itself. |
| 2 | Netlify production `VITE_AUTH_PROVIDER` | NOT VERIFIED (value pending) | The code treats unset, empty and `supabase` identically as the Supabase build, and `cognito` as the AWS build (`packages/auth/src/auth-provider.tsx:231-233`, `apps/web/src/env.ts:42-44`, `apps/web/src/main.tsx:12`); any other value fails closed. The owner earlier reported the variable absent from Netlify's list, but has not confirmed it for the record, so it is not recorded as absent. Pending: the exact value and scope (Production, Deploy Preview, Branch deploys). `netlify.toml` sets it only in no context (no production context, no `VITE_AUTH_PROVIDER`). The production value lives in the Netlify UI. Note `docs/OGEVIA_OPERATING_RECORD.md` (10/07) describes app.ogevia.com as Cognito OAuth production, which conflicts with the premise that the Netlify production context is not cognito. Host: the owner states www.ogevia.com is the Netlify site (item 1). The Cognito app host is a separate site; the owner has not stated whether app.ogevia.com is still current. |
| 3 | Frontend blast radius, `apps/web` excluding `src/aws` | VERIFIED (static) | See below. No P0. |
| 4 | Live smoke of production | BLOCKED | Egress to the production host is refused by the sandbox proxy (HTTP 403 on CONNECT). Nothing was loaded or exercised. |
| 5 | Hotfix safety | VERIFIED (documented) | `docs/TESTING_AND_RELEASE_PROCESS.md` section 9. Last deployed Netlify commit is NOT VERIFIED; AWS designated commit `1639cf6`. |
| 6 | smoke.py pre-pilot task | VERIFIED (recorded) | Below. smoke.py not changed. |

## Item 3: changed files (5e711d9..63de403, excluding `apps/web/src/aws`)
Same four files against `1639cf6`, plus one test file. The previously deployed Netlify commit is unknown, so both bases were checked.

| File | Calls RPC/table/column/enum/status from 0047 to 0052? | Reaches the Supabase path? |
|------|------|------|
| `lib/sv-backend.ts` | No. Types only: `VisitOutcome`, optional `wave1`, optional `unscheduledReason`/`typedSignerName`/`attested`, and `"verbal"` added to the `ConfirmationMethod` type. | No runtime effect. |
| `lib/sv-backend-aws.ts` | Yes (`/v1/visits` `unscheduledReason`, `attested`, `outcome`), AWS API only. | Only built when `VITE_AUTH_PROVIDER=cognito`. |
| `lib/visit-outcome.ts` (new) | No RPC or table. Wording only; names review codes as plain strings. | Used by the page only when `wave1`. |
| `pages/service-verification-page.tsx` | No RPC or table. Sends `unscheduledReason`, `typedSignerName`, `attested`, method `verbal` through the backend interface. Every new control and branch is gated on `backend.wave1`, which only the AWS adapter sets. | Supabase adapter (`sv-backend-supabase.ts`) is unchanged and does not set `wave1`. |
| `pages/client-detail-page.test.tsx` (vs 1639cf6 only) | Test only. | No. |

`supabase/` is unchanged in this range. The Supabase schema already allows confirmation method `verbal`, and the Supabase UI cannot select it. Limit of this check: static reading of the diff, not a runtime test of the Supabase build; the existing web test suite passed on 63de403 in Phase A.

## Item 6: required pre-pilot task (not done)
`infra/aws/slice/smoke.py` starts visits with no scheduled shift (about lines 222 to 242 and 284) and expects the confirmed visit to come back `signed` and billable. Since 0050, a visit with no linked shift requires an `unscheduledReason` to start and returns in `administrator_review` with review reason `unscheduled`. The smoke test must be updated before any pilot run: pass a reason or create a shift, and assert the new outcome. The test that currently covers this is the database/API suite, not smoke.py. Not changed here by instruction.

## Remaining checks to close post-merge verification
1. Item 2: owner reads the Netlify environment variables and records the `VITE_AUTH_PROVIDER` value, or its absence, for each scope (Production, Deploy Preview, Branch deploys). Close only if it is not `cognito`. Any other non-empty value other than `supabase` is a defect (the build fails closed).
2. Item 4: a live read-only smoke of www.ogevia.com, signed out and then signed in, loading sign-in, schedule view and the visit-flow screens without creating, editing or submitting anything, with the browser console and network tab checked for 4xx/5xx and "function does not exist", column or enum errors. Claude Code cannot reach the site (proxy 403), so the owner or a machine with access runs it and records exactly what was exercised.
3. Item 5: owner records the commit Netlify served before `63de403` (Netlify deploy list) so the hotfix base in `docs/TESTING_AND_RELEASE_PROCESS.md` section 9 can be named instead of marked NOT VERIFIED.
4. Item 6 stays open as a pre-pilot task (`smoke.py`), not a blocker for closing this verification.
