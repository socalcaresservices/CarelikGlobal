# Wave 1 — implementation record (G01–G09)

**Status: IMPLEMENTED and TESTED LOCALLY. NOT DEPLOYED. NOT MERGED.** Branch `claude/determined-goodall-syvv7s`, draft PR #87 (unchanged: still a draft).
Migrations 0050 and 0051 have been applied only to disposable local PostgreSQL databases (test databases and the local harness). Nothing ran against AWS, the pilot or production. No AWS access was used.
Scope kept: G01–G09 only. Waves 2 and 3, F2, F4, F6, F8 untouched. No menu change.

## 1. Plan as built (decisions applied: Q-F yes, O-1 no, Q-R keep reservation, Q-D 15 minutes with no Off)

| Gap | What was built | Where it is enforced |
|---|---|---|
| G01 | A visit that links to no scheduled shift needs a reason (3–500 characters). It is stored on the visit. A signed unscheduled visit goes to `administrator_review` for every caregiver (fixed or flexible), keeps its capped billable minutes, and cannot be approved for billing until a review decision exists. | PostgreSQL (0050); UI shows the field |
| G02 | Versioned, effective-dated agency rule (default 15 min, 1–240, no Off). Only `organization.update` can change it; never a past date; each change is a new version with who/when/why. Each confirmed visit stores which rule version and value it was checked against, so later changes never re-judge old visits. The starting value is labeled "not verified". | PostgreSQL (0050); Settings → Visit rules |
| G03 | Review reasons `unscheduled` and `schedule_variance` added to the existing reason list; review and approval gates use the existing mechanism. | PostgreSQL (0050); review page wording |
| G04 | No new build. The no-signature resolution (late-confirmation request link/paper, review decision) already existed; only wording changed where reasons are shown. | existing |
| G05 | Caregiver confirm options: Verbal only (needs the confirming person's name; goes to review, 0 billable, never fakes a signature), "Client declined to sign" (sent as unable-to-confirm with that reason), technical-problem reasons. | UI + existing DB methods |
| G06 | Caregiver attestation tick required in the app. The server records the version `attest-v1`; the browser cannot name a version. Server accepts a missing attestation as "Not recorded" so an older app keeps working while a release is staged. | API + PostgreSQL |
| G07 | Final screen: worked, confirmed, billable, authorization left, confirmed-by method, billing state, plain-language reasons. | API (`get_visit_outcome`) + UI |
| G08 | Refresh/lost-signal behavior: retries reuse the same idempotency key; confirm retry returns the stored result and now also the outcome; duplicate start/confirm tests exist. | API + tests |
| G09 | Caregivers see open shifts they are assigned to (client code only) and pick one up. One winner (row lock), retry returns the same answer, readiness (Care Team record, availability, overlap) and authorization are re-checked at claim time, the reservation made at scheduling is kept, and a caregiver who called out of a shift cannot take it back (O-1). | PostgreSQL (0051) |

## 2. Files changed

Database (not applied anywhere but local test databases)
- `infra/aws/db/migrations/0050_wave1_visit_review_and_variance_rule.sql`, `0051_wave1_open_shift_pickup.sql`
- `infra/aws/db/rollback/0050_…down.sql`, `0051_…down.sql` (0050 down refuses when it would delete records)
- `infra/aws/db/verification/01_schema_version.sql` (expects 51 / 0051)

API: `apps/sv-api/src/routes.ts` (start accepts `unscheduledReason`; confirm accepts `attested`, returns `outcome`; review returns rule/reason fields; new `GET/POST /v1/visit-rules`, `GET /v1/open-shifts`, `POST /v1/shifts/{shiftId}/pickup`); `infra/aws/lib/service-verification-api-stack.ts` (route list only; no other infrastructure change).

Web (AWS build only; the Supabase build is unchanged because the new elements are gated on `backend.wave1`):
`apps/web/src/pages/service-verification-page.tsx`, `lib/sv-backend.ts`, `lib/sv-backend-aws.ts`, new `lib/visit-outcome.ts`, `aws/visit-review-page.tsx`, `aws/schedule-page.tsx` (open shifts), new `aws/visit-rules-page.tsx`, `aws/aws-root.tsx` (route `/settings/visit-rules`, linked from Settings; no menu item added), `aws/workspace-settings-pages.tsx` (link), `aws/action-needed.ts` (hint text).

Tests: new `db/test/wave1-visit-review.db.test.ts` (18), `wave1-pickup.db.test.ts` (12), `apps/sv-api/test/wave1.db.test.ts` (4), `apps/web/src/aws/wave1.test.tsx` (13). Existing tests adapted: harness (`api.start` now creates a matching shift unless a reason or `null` is passed; `ageVisit` resizes that helper shift; `api.confirm` takes `attestation`), ledger/version expectations (0051), required-table list, readiness-gate protected-function list (adds `pickup_open_shift`), rollback/restore expectations, and tests whose meaning changed (see risks).
Harness: `infra/aws/local-harness/setup.ts` (seed: scheduled, unscheduled and over-the-rule visits), `smoke.ts` (4 new checks).

## 3. Migrations required: 0050, 0051 (both additive)
Additive columns (`service_visits.unscheduled_reason`, `visit_confirmations.attestation_version`), two new append-only tables, new functions; the old 6-argument start and 8-argument confirm functions are replaced by versions with one trailing optional parameter. No existing row is changed. Rollback scripts exist; 0050's refuses once Wave 1 records exist (so a rollback can never silently delete them).
Contiguity: the ledger must be 0001–0049 before 0050. 0047–0049 are not yet deployed anywhere (their release plan is separate), so 0050/0051 cannot ship before them.

## 4. Risks (all are findings, none hidden)
1. **Behavior change for every start without a shift.** Any visit with no matching shift now needs a reason and ends in review; flexible (EOR) caregivers' shift-less visits are no longer Billing Ready automatically (decision D-U). Confirmed by tests (`hire-type` test rewritten to the new rule). Office workload effect is unmeasured: pilot must count Visits to Review per 100 visits.
2. **Scheduled visit sent to review by the variance rule keeps its reservation while its billable minutes count as used** (same family as F1). Characterized, not fixed (existing test "keeps the reservation while a linked visit is in administrator review"). Authorization can look lower than reality until review.
3. **Deploy order must be database → API → web.** The API change is backward compatible with the old app (attestation optional, reason optional); an old app against the new database would fail unscheduled starts with a clear message and no data loss. The web app cannot ship before the API.
4. **`correct_service_visit` was left untouched** (out of Wave 1): a manager correction of an unscheduled visit is not re-evaluated by the new rules.
5. **`accept_capped_billable` reused** for "accept this visit as worked" (wording only differs on screen). Audit shows the existing decision name.
6. **Deployed-environment scripts not updated:** `infra/aws/slice/smoke.py` (lines ~222–242, 284) starts visits with no shift and expects `signed`; after Wave 1 that returns `administrator_review`. It must be updated in Phase C against the pilot; it was not run or changed here (cannot be verified without the environment).
7. **Rule default is a placeholder, not a payer rule** (labeled on screen). The agency must set and verify its own value.
8. **Open-shift pick-up trusts the reservation made when the shift was scheduled**; a shift with no reservation is refused rather than guessed.
9. Mobile checks were done in a real Chromium at 390 px against the harness (no horizontal overflow on start, final or My shifts). Not tested on a physical phone, slow network, or screen reader.

## 5. Test plan and results (local)
| Check | Result |
|---|---|
| Failing-first: new DB tests without 0050/0051 | 29 of 30 failed (output: `failing-first.txt`) |
| `pnpm lint` | 6/6 tasks pass |
| `pnpm typecheck` | 7/7 pass |
| `pnpm test` (web 775, infra 124, sv-api 67 unit) | pass |
| `@carelik/infra-aws test:db` | 56 files, 551 tests pass |
| `@carelik/sv-api test:db` | 4 files, 73 tests pass |
| `pnpm build` | 6/6 pass |
| Local harness: setup (51 migrations), build, smoke | 45/45 checks pass |
| Screenshots (390 px caregiver, 1280 px office) | `screenshots/` (16 images) |
Not run: database-in-AWS tests, pilot, user acceptance (Phases C–E). `cdk synth`/diff not run (route-list change only; CDK unit tests pass).

## 6. Estimated effort per gap (relative, for planning; not time-tracked)
G01 L (DB, API, UI, ~140 test call sites) · G02 L (new tables, versioning, settings page) · G03 S · G04 XS (wording) · G05 M · G06 S · G07 M · G08 S (tests) · G09 L (concurrency, authorization re-check, UI). The shared cost was adapting existing tests to the new start rule.

## 7. Release checklist
Phase A (development): complete except owner review of this document. Phases B (local harness): done as above. C (pilot/test environment), D (user acceptance) and E (production approval): **open**. No deployment proposal without `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md` completed and the owner's explicit GO.
