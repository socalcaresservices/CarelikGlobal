# Homepage updates (2026-11-20)

Status: **implemented and tested locally. Not deployed.** No migration, no release switch, no AWS change.

"Homepage updates" is not itemized anywhere in the repository. The concrete, verifiable defect found on the Home (Dashboard) page: its Refresh button re-read only the attention overview, utilisation, action items and today's shifts, while a shift change (items 5 and 6) refreshes shifts, dashboard figures and request lists. The two could disagree. Other Home changes already built (R32, R33, caregiver names on document rows, chart color schemes) are untouched. If the owner meant further Home changes, they need to be itemized.

## What changed (`apps/web/src/aws/home-page.tsx`)
- Refresh now runs the shared `refreshAfterShiftChange` (`shift-refresh.ts`), so one button press refreshes the schedule lists, the dashboard figures and the request lists. The explicit refetches were removed because the shared refresh already covers the attention overview and utilisation: each is fetched once, not twice.
- Behavior kept: "Updated" time, stale warning, "Could not refresh" keeping the last figures with Retry, and no false zero.

## Tests
`home-today.test.tsx`: 1 added (Refresh marks shift, dashboard and request queries stale); the existing refresh tests still pass (one request per Refresh). Full web suite passes.
