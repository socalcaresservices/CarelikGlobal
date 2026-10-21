# Go-live readiness, engineer A: lineage locks, review audit trail, tenant isolation sweep

Status: IMPLEMENTED and TESTED LOCALLY (disposable PostgreSQL 16, synthetic data). NOT DEPLOYED. No AWS used. Migration 0082 is new; 0001-0081 are untouched.

## 1. The race (real, reproduced)
`end_service_visit` and five other functions changed the minutes the scheduling guards read (used + reserved + unreserved Pending) without taking `ogevia.lock_authorization_lineage`. Reproduced with two real connections and a test-only pause trigger (`db/test/lineage-lock-race.db.test.ts`): a 45-minute unscheduled visit ended (uncommitted) while a 600-minute shift was created on a 600-minute authorization; both committed (645 of 600). Fixed by 0082: each takes the same lock (key `ogevia.authorization-lineage:<lineage>`) through `ogevia.lock_visit_lineage(visit)`.

| Function | Lock before 0082 | After 0082 |
| --- | --- | --- |
| create_shift, reschedule_shift, series create/change/extend/end, schedule_makeup_shift, assign_shift_caregiver, confirm_shift_pickup, assign_care_request, confirm_service_visit, correct_service_visit, review_late_visit_confirmation, reconcile_ended_shift, approve_billing_rounding_adjustment, amend_client_authorization, record_outage_visit | lineage | unchanged |
| end_service_visit, close_missed_service_visit | none | shift row, then lineage |
| decide_visit_review, revoke_visit_review_decision, void_service_visit, void_billing_rounding_adjustment | none | lineage (after the row lock) |
| pickup_open_shift | none (records a request only; consumes nothing) | unchanged |
| cancel_shift, public_cancel_care_request, series cancel paths | none (only release minutes) | unchanged: a guard that read just before is merely conservative |

What a lock cannot do: ending a visit, closing a missed visit and reopening a review are never refused for capacity (the work happened). When one is serialised AFTER a scheduling operation that took the last minutes, the committed total exceeds the authorization and the screens read Over limit (existing per-authorization behaviour). That is an owner decision, see below.

## 2. Governing rule for releasing a reservation when a review is closed as not billable
None exists. `HOURS_ACCOUNTING.md` section 2 records it as an open POLICY QUESTION; `2026-10-14-0052-single-bucket/README.md` says the same. Today only signing (0013), cancelling the shift or changing the series (both refused while a visit is linked), and `reconcile_ended_shift` (refused when a visit exists) release a reservation. The default is kept: no release, no path built.

## 3. Audit trail
`audit_events` stores actor, `occurred_at`, reason, request id, `before_state`, `after_state` and rejects UPDATE/DELETE (triggers). 0082 fills the previous values that were missing: `visit.review_decided` (before was null), `visit.review_revoked` (visit and minutes were missing), `visit.late_confirmation_reviewed` (before was null), `billing.rounding_adjustment_voided` (more fields). Review decision rows keep the visit snapshot, decided_by/at and revoked_by/at/reason and cannot be edited or deleted. Tests: `db/test/review-reopen-accounting.db.test.ts`.

## 4. Tests added
- `infra/aws/db/test/lineage-lock-race.db.test.ts`: race, both orders, 40 random interleavings, lock inventory from the catalog, idempotency and existing errors.
- `infra/aws/db/test/review-reopen-accounting.db.test.ts`: close/reopen/re-close, close with late confirmation, rounding applied/voided/applied, correction, audit evidence, append-only.
- `infra/aws/db/test/hours-month-boundaries.db.test.ts`: agency-local month/midnight/DST, real minutes, idempotent retry.
- `apps/sv-api/test/tenant-isolation-sweep.db.test.ts`: every route, two orgs, cross-role.

## 5. Owner questions (not decided here)
1. Should reopening a review (revoke), ending a visit that started without a shift, or closing a missed visit be refused when the authorization has no room, or keep recording the work and read Over limit?
2. Should `correct_service_visit` be refused (or carry the close forward) when the visit has an active "close not billable" decision? Today the correction is a new record back in review (Pending) and the close stays on the superseded original.
3. Should an unscheduled visit that is still a draft hold provisional time? Today it consumes nothing until it ends.
4. Should closing a review as not billable release its reservation (HOURS_ACCOUNTING.md)?
