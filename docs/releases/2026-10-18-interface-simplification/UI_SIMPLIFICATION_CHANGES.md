# TEST interface simplification: change list for approval

Status: IMPLEMENTED and TESTED locally on branch `local/ui-simplification-review`. Not pushed. Not deployed. Enforcement untouched.
Presentation only: no calculation, permission, API, migration or workflow change.

## Evidence
- Web: `tsc --noEmit` clean, eslint clean, `pnpm build` OK, vitest 115 files / 1096 tests pass. UI package: 73 tests pass.
- Local harness browser scenario (synthetic data): desktop 1280x900 106/106, phone 390x844 106/106.
- Screens captured for 5 personas at both widths: 150 each before/after, no sideways scrolling after the change (one Care Team phone overflow found and fixed).
- Page height across 142 matched screens: 285,273 px before, 227,670 px after (20% shorter). Schedule: 4,241 to 2,072 px desktop, 6,693 to 3,288 px phone.
- Side by side: `screenshots-ui2/compare.html` (before/ and after/ folders).

## What changed
1. Scheduling: "Upcoming: need coverage (n)" and "Past: need review (n)" are separate lists with their own counts. Shifts are a compact table on desktop, expandable rows on phone, one primary action per row, the rest under a More menu.
2. Assignment result: the overall scheduling outcome is shown first; the per-check detail (including authorization shortfall) sits under it, so "Assignment allowed" no longer sits beside "Not enough authorized time".
3. Past shifts with no visit: one row each with "Record what happened"; the mutually exclusive findings are radio buttons, then Save.
4. Home, Action needed, notifications: repeated explanations and duplicate figures removed; counts shown once; supporting text moved to Details.
5. Clients, Care team, Documents, Recruiting, Care requests: compact tables / expandable rows; Caregiver readiness and Compliance are collapsed summaries that open when attention is needed; the readiness table stacks on phones.
6. Document and visit decisions (approve/reject, confirmation method) use radio groups.
7. Approvals, Reports, Services, Settings, sign-in pages: shorter headings and help text, concise specific error messages ("what failed, how to fix").
8. Kept visible: authorization balances, compliance status, consent and confirmation steps, warnings that block or reserve time.

## Test and harness updates (not behavior)
- `sidebar-home.test.tsx`: shift actions now checked through the More menu.
- Browser scenario: radios instead of buttons for reconcile and document decisions, collapsed sections opened before use, "need action" wording, exact "Service" label. The seeded 9-hour open shift falls outside the caregiver's 14-day window when run on Sunday; it was moved inside for the run only (seed file restored).

## Not done / separate
- Document upload failure ("The file could not be stored") is NOT addressed here; tracked separately (task 10).
- Not verified: deployed TEST, real devices, screen reader beyond role/label tests.
