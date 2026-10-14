# Wave 1 post-merge verification (PR #87, main at 63de403)

Date: 2026-10-14. Read-only. Nothing deployed, no migration applied, no Netlify or environment change.

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Netlify production deploy for 63de403 | BLOCKED | No Netlify CLI, token or MCP in this session. Netlify's own PR #87 deploy-preview checks passed before the merge; the production deploy was not observed. Owner: record status, commit, time and build result here. |
| 2 | Netlify production `VITE_AUTH_PROVIDER` | BLOCKED | `netlify.toml` sets it only in no context (no production context, no `VITE_AUTH_PROVIDER`). The production value lives in the Netlify UI. Note `docs/OGEVIA_OPERATING_RECORD.md` (10/07) describes app.ogevia.com as Cognito OAuth production, which conflicts with the premise that the Netlify production context is not cognito. Which host is which is NOT VERIFIED. Owner: record the value. |
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
