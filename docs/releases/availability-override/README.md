# Availability override: one shift, one use (migration 0047)

Status: **implemented and tested locally. NOT deployed. No AWS change was made.**
Source decision: `docs/product/SCHEDULING_AND_ACCOUNTS_DECISIONS.md` (owner, 2026-10-11).

## What changed
| Area | Change |
|---|---|
| Database `0047_availability_override_one_shift.sql` | `availability_overrides` gains `client_id`, `original_status`, `consumed_at`, `consumed_context`, `shift_id` (all nullable; nothing dropped). New helper `availability_override_for`. `readiness_checks` and `assert_ready_for_work` (CREATE OR REPLACE) use it. New trigger links the used override to the shift. `authorize_availability_override` is now the 6-argument form (adds `p_client_id`); the 5-argument form is removed. `list_shifts` gains `availability_override`, `availability_override_reason`. |
| Rules | An override is for one caregiver, ONE client and ONE exact shift time (at most 24 h), expires after 30 minutes, and is used up by the first assignment that uses it. It records the availability result it lifted. It is refused when the caregiver is already available. A shift for a different client under the override is refused and rolled back. It is not honoured for recurring series. The caregiver's stored availability is never changed. Admin only (`availability.override`). |
| API `POST /v1/availability/overrides` | Now requires `clientId` (400/422 otherwise). |
| Web | Override form sends the client and says it is for this one shift; the override button needs a chosen client; a shift assigned under an override shows "Assigned with Admin override (availability was No Match): reason"; matching labels read Match / Partial Match / No Match. |
| Rollback `0047_availability_override_one_shift.down.sql` | SAFE AUTOMATED: restores the 0042/0046 functions, 5-argument authorize and old `list_shifts`; keeps the new nullable columns so override history is not lost. Runs first in the existing readiness rollback chain (now 0039-0047). |

## Deploy order (when approved; YELLOW actions)
The 5-argument function is removed, so the database, API and web must go together: (1) snapshot, (2) migrate to 0047 (ledger must read 47|0047), (3) deploy the API (route now needs `clientId`), (4) deploy the web. A new web build against the old API, or the old web against the new database, cannot create an override (the old form omits the client). Use the existing `deploy-production.sh` steps; the handoff in `docs/releases/caregiver-readiness/RELEASE_HANDOFF.md` describes the 0039-0046 sequence this extends. The live ledger level before this step is NOT verified here.

## Known limits (not hidden)
- This does not make No Match a hard block by itself. Availability still only blocks after an owner activates readiness enforcement (open decision); before that an unavailable caregiver can be assigned with a warning and no override is needed.
- Series (recurring) dates cannot use an override. Create the one date as an ordinary shift with an override and skip that date in the series.
- Visit start keeps its covering rule (the interval is "now") but is also single use and bound to the client.
- Overrides made before 0047 have no client and are inert (they expired within 30 minutes anyway).
- "Match / Partial Match / No Match" labels were applied to the matching panel and override text only; the individual check messages keep the server's wording.
- Not verified: a real browser or phone, or any deployed environment. The web behaviour is covered by jsdom tests only.

## Tests run (local PostgreSQL 16.x, synthetic data)
- `infra/aws` database suite: 51 files, 500 tests passed (includes the rewritten override tests, 4 new ones, the whole-chain rollback and re-apply, and the restore tests).
- Repository gates: `pnpm lint`, `typecheck`, `test` (web 755, shared 118, auth 138, sv-api 64, ui 73, infra 124), `build` all passed.
