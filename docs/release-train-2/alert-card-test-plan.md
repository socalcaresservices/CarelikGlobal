# Stage 3 (TEST only): alert card, exact-shift link, live status

Release commit: filled in below when pushed. Script: `docs/releases/2026-11-20-test-plan/toolchain/TEST_RT2_N3_ALERT_CARD.sh`. Production is not touched. Email and live texting stay off.

## What changes in TEST
| Layer | Change | Evidence it is bounded |
|---|---|---|
| Database | Migration 0120 (+ rollback): exact-shift link rule, short alert body, live shift summary per alert, `get_cover_shift` | `VERIFY_PENDING.sql` (0120 checks), DB test `alert-exact-shift-0120.db.test.ts` (including rollback and the verify script) |
| API | Handler code only. `get_cover_shift` is reached through the EXISTING `GET /v1/open-shifts` route as `?shiftId=` | `GET /v1/open-shifts` is declared with no feature switch in `service-verification-api-stack.ts`; the gate (`diff_gate_rt2.py --stage stage3`) refuses any added route, rule, permission or variable and requires the live route count to be unchanged |
| Web | New card, shift page statuses, office queue with Pacific times | web tests, 21-check phone-width browser pass (`alert-card-browser-evidence/`) |

## Order
1. Deploy (one script, stops at the first failure, asks you to type `DEPLOY-TEST-ALERT-CARD`).
2. Phone checks below, then the separate email acceptance.

## Rollback order (each asks for its own typed word)
```bash
bash TEST_RT2_N3_ALERT_CARD.sh rollback-web     # ROLLBACK-TEST-WEB
bash TEST_RT2_N3_ALERT_CARD.sh rollback-api     # ROLLBACK-TEST-API
bash TEST_RT2_N3_ALERT_CARD.sh rollback-db      # ROLLBACK-TEST-0120
```
No routes rollback exists because no route changes. The fresh snapshot id is in the capture folder (`snapshot-id.txt`).

## Phone checks (two TEST caregivers in the Temecula office, plus the office login)
1. Caregiver A signed out. Open the alert link (`/my-shifts?shift=<id>`) on the phone. Expect the sign-in page, then the exact shift first with **Request this shift**.
2. Caregiver A requests. Expect **Requested — waiting for the office**. Caregiver B (own phone or private window) opens the alert, signs in, lands on the same shift, requests later.
3. Office: Schedule, "Caregiver requests for open shifts". One card, "Shift starts … PT", A numbered 1 and B numbered 2, each with "Asked … PT", earliest eligible marked.
4. Office confirms one. Chosen caregiver's card says **You are confirmed**; the other's says **Filled** and the shift page shows Filled with no request button.
5. Layout on the phone: date and time readable, **View shift** easy to tap, ⋯ menu holds Mark read and Archive, no client name or address in the alert.
6. An older alert (made before this release) still opens (it forwards to My Schedule or the exact shift).

## Email acceptance (separate; not part of the in-app pass)
TEST has no email sender. It passes only when a NEWLY generated TEST open-shift email arrives and its **View shift** link opens the exact shift after sign-in. Needs owner approval for a sender, then a new alert. Until then: NOT VERIFIED.

### The earlier email
`CHECK_EMAIL_EVER.sql` shows whether the app ever sent one (counts only). The Demo Today A alert's delivery was `queued`, never `sent`, and the stage scripts assert that no email function exists. So an app-sent open-shift email cannot have been delivered by TEST. Messages that did arrive are most likely sign-in emails (invitation, temporary password, reset code) sent by the sign-in service. Confirm from the message itself: sender address, subject, time, and (Show original) the `Received`/`Message-ID` lines.
