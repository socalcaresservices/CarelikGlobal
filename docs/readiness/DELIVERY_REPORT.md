# Caregiver readiness and explainable matching — delivery report

Branch `claude/festive-keller-0iz16g`. Migrations 0039–0041, API routes, web screens. **Nothing is deployed. No AWS or production data was touched.** All verification below ran against a local PostgreSQL 16, a fake API, and a local Vite preview with synthetic data.

## 1. What is built

| Area | Database / API | Web screen | Status |
|---|---|---|---|
| Required documents (agency-configured, none seeded) | 0039; `GET/POST /v1/document-types/…required`, `GET /v1/documents/compliance` | Documents → Document types: "Required for work" toggle with reason | Working end to end |
| Document verify with dates / revoke | 0039; `…/versions/{id}/verify`, `…/revoke` | Documents: Verify now needs Valid from (and Valid through when the type has an expiry); Revoke verification with reason | Working end to end |
| Explicit service approval (default Off) | 0039; approvals routes, settings | Caregiver profile → Services (own, read-only); Care Team → caregiver → Services (approve, revoke); Readiness settings switch with reason | Working end to end |
| Availability request / approval | 0040; request, cancel, review, direct edit, conflicts routes | Caregiver Availability page (request with reason, pending, stale, last decision, cancel, days off); Care Team → Availability requests (compare, approve, decline with note) | Working end to end |
| One readiness check, enforced on every path | 0039–0041 triggers on `shifts`, `caregiver_assignments`, live visit start; per-caregiver advisory lock | Server messages shown in existing forms; "Why this match" shows each check | Working (see gaps) |
| Experience tags, submit, verify | 0041; tag, experience, review routes | Care Team → Experience tags; caregiver Experience card; caregiver detail → Experience (verify / do not verify / remove / add verified / mark reviewed) | Working end to end |
| Client support needs (optional or mandatory) | 0041 | Client page → Support needs; Service location | Working end to end |
| ZIP "Approx. distance" | 0041 (`zip_centroids` is empty) | Caregiver Location, Client Service location, table column | Mechanism works; **no data loaded** (see §5) |
| match-v1 score and details | 0041; `POST /v1/matches` | Care Requests → Matches table + "Why this match"; Schedule → Assign caregiver uses the same table | Working |
| Assignment decision record | 0041; written in the same transaction as assign | Optional "Why this caregiver" / override reason fields on Care Request assign and Shift assign | Working; no history screen yet |
| Sidebar | unchanged | unchanged (labels, order, routes, permissions) | Verified by existing tests |

## 2. Not built / gaps (read before deploying)

1. **Matches are wired into two screens only**: Care Request assignment and Schedule → Assign caregiver. Not yet in: Add shift (a caregiver chosen there is checked by the server and a refusal is shown, but there is no Matches table or override field), repeating-series create/reassign, and reschedule. The server enforces readiness on all of them; only the helper UI is missing.
2. **No screen for the assignment decision history** (`GET /v1/assignment-decisions` exists).
3. **No administrator UI for direct availability edit** (route exists; requests are the normal path).
4. **No admin screen for caregiver-side document expiry list** beyond the per-caregiver Documents card and the existing Documents page. The Care Team "Upcoming services needing attention" card lists flagged shifts.
5. **Phone layout**: the Matches table scrolls sideways inside its card on a 390 px screen (page itself does not scroll). It is an office screen; I did not build a stacked mobile layout.
6. The caregiver availability form still edits one time range for the selected days (as before). Saved schedules with different hours per day show a warning, and a request replaces them with the one range.
7. **Real-device, screen-reader and keyboard testing were not done.** Only Chromium via Playwright at 1280 and 390 px.

## 3. Verification actually run

| Check | Result |
|---|---|
| `infra/aws` DB suite (migrations apply from zero, rollback round trip, RLS, concurrency, readiness, availability, match, deploy scripts) | 42 files, 456 tests passed |
| `apps/sv-api` DB suite through the real route table | 65 passed |
| `pnpm lint` / `typecheck` / `build` | passed |
| `pnpm test` (all packages) | 1 failure in the first full run: `aws-app.test.tsx` "caregiver vertical slice". It passed in 4 isolated reruns and in a second full web run (89 files, 724 passed). Cause not established; consistent with load-related timing, **not proven**. |
| Route table ↔ CDK route list contract test | passed (includes the new routes) |
| Browser check, production-mode Vite build, fake API, 1280 and 390 px | no page errors, no horizontal page scroll (one overflow bug found and fixed: a screen-reader-only header cell widened the page) |
| Concurrency | assign vs revoke tested in both orders; two simultaneous care-request assignments for one caregiver cannot double-book (DB tests) |

**Not verified:** anything against real AWS, real Cognito, real S3 uploads, the deployed CDK stack (`cdk diff`/`synth` of the new routes was not run against an account; the CDK unit tests passed), load or timing at production volume.

Screenshots (synthetic data): `docs/readiness/screenshots/`

- `1-caregiver-profile-availability-request-desktop.png` — caregiver profile: availability request, Services, Experience
- `1b-caregiver-availability-pending-phone.png` — pending request on a phone
- `2-availability-review-desktop.png` — availability review, readiness flags, settings (enforcement OFF)
- `3-document-review-desktop.png` — document verify with dates, required toggles
- `4-candidate-list-desktop.png`, `4b-candidate-list-phone.png` — candidate list
- `5-match-details-desktop.png` — "Why this match" (incomplete score explained)

## 4. match-v1 scoring: worked examples (arithmetic checked by script)

`score = round(100 × (0.50·A + 0.25·L + 0.25·E))`; not-applicable parts drop out and the remaining weights are scaled to sum to 1; an applicable unknown part makes the score "Incomplete" (no number).

| Case | A | L | E | Score |
|---|---|---|---|---|
| Fully available, 6 mi, radius 15 (L = 0.60), holds tags worth 5 of 6 weight | 1.00 | 0.60 | 0.833 | **86** |
| Location setting Off (weights 0.667 / 0.333), A = 0.5, E = 0.5 | 0.50 | — | 0.50 | **50** |
| Client has no optional needs (weights 0.667 / 0.333), 6 mi | 1.00 | 0.60 | — | **87** |
| Caregiver ZIP not recorded | any | unknown | any | **Incomplete** |
| Experience not marked reviewed and some requested tags not held | any | any | unknown | **Incomplete** |

Sensitivity (A = 1, E = 0.833): distance 0 / 6 / 15 / 20 mi at radius 15 → 96 / 86 / 71 / 71 (clamped at 0). Radius 15 → 30 at 6 mi: 86 → 91. Availability 100 / 75 / 50 % → 86 / 73 / 61. The weights and the radius are a product hypothesis, not validated against outcomes.

## 5. Decisions needed from the owner

1. **ZIP centroid dataset.** `zip_centroids` is empty on purpose. Until a dataset (source, licence, vintage) is approved and loaded, every distance is "Not available" and every score for an agency with location On is **Incomplete**. Recommended: ship with location **Off** until loaded.
2. **Enforcement switches** stay Off until you turn them on. Recommended order: enter service approvals for every active caregiver → review the flag list → turn on service checks with a reason.
3. **Which document types are required** (e.g. CPR, TB) and whether each needs an expiry. Nothing is assumed.
4. **Experience tags list** (start empty). ABA-related tags, if you add any, are preferences only, never proof of clinical authority.
5. **Retention** of the decision record and availability request history (currently kept indefinitely).
6. **Do mandatory client needs apply to existing assignments?** Currently existing schedules are flagged, never changed.

## 6. Deployment order (all are your actions; none were run)

1. Merge the branch. `pnpm lint typecheck test build` on the merge commit.
2. **Database** (`deploy-production.sh` db step): migrations 0039 → 0040 → 0041, additive. Take a snapshot first. Verification script `01_schema_version.sql` checks 0041 / 41 files.
3. **API** (`deploy-production.sh infra`, a YELLOW step: new routes and Lambda code). Review `cdk diff`: expect only new routes plus the Lambda asset.
4. **Web** (`deploy-production.sh web`).
5. Do not turn on enforcement in the same window.

Ordering note: `POST /v1/availability/me` now creates a request and **requires `reason`**. A cached old web page will get a 400 until it reloads. Deploy web promptly after the API.
Existing availability is kept as the approved baseline; nothing is re-approved or backfilled.

## 7. Rollback limits

- Down scripts `0041` → `0040` → `0039` refuse to run while any readiness, approval, experience, support-need, location or decision record exists. They never delete records silently.
- Before any such data exists, rollback is clean and tested (round trip from zero).
- After data exists, the supported rollback is: web back, API back (old routes still work against the new schema except availability save, which now needs a request), leave the schema in place. Dropping the schema would require an explicit, backed-up data decision.
- A visit already started is not stopped by a later revocation.
- Locking requires the default READ COMMITTED isolation and protects only code paths that take the per-caregiver lock.
