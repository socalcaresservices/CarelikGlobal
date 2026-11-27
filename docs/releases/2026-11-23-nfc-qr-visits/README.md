# NFC and QR visit verification (migration 0124): build record

Owner brief: `OWNER_BRIEF.md` (saved verbatim, 2026-11-23). Branch `claude/amazing-clarke-8b309z`, based on `origin/main` 698ae23. Draft PR, **not deployed, no migration applied anywhere, switch OFF in every environment.**
Built to be merged later with the other open work (PR #124 owns 0113-0123; this was 0120 and was renumbered to 0124 on integration, 2026-11-27). Pilot with synthetic data in TEST; Sandata stays the EVV system of record (nothing here replaces or calls it).

Status words: **WORKING (local)** = built and passing the tests listed below against a local PostgreSQL 16 and the real API handler; **PARTIAL** = part built, gap named; **NOT BUILT**; **NOT VERIFIED** = needs TEST or a real phone. Nothing in this record is a TEST or production result.

## 1. What was built, against the brief

| Brief item | Status | Evidence / gap |
|---|---|---|
| Expected start and end place by service; per-visit override where allowed; default in-home respite = home only | **WORKING (local)** (database + API); no screen | `service_location_rules`, `shift_location_overrides`; override refused unless the service allows it, a visit has not started, and the person may manage shifts. DB test "in-home respite defaults to home only…". **Gap:** no Schedule or Services screen for the rule/override (API only). |
| Service address with required city and ZIP; unlocatable address flagged | **WORKING (local)** | `client_service_locations`; `needs_attention` when no map position. **Gap:** no geocoding provider is connected (none approved); a position is typed in or left empty and flagged. |
| Display both expected locations before the visit | **PARTIAL** | `GET /v1/shifts/{id}/expected-locations` returns both places, the clock-in/out method and city/ZIP; **not yet shown on the caregiver's schedule screen**. |
| Four visit setups (home only, community, home to community, community to home) | **WORKING (local)** | DB tests "approved community places…" (community-start refuses a label scan; community->home departs at the label). Community start/end from the visit screen uses `POST /v1/visit-punch`; **the visit screen itself is not wired to it** (API only). |
| Tap/scan opens Ogevia, login then resume | **WORKING (local)** (`/l#token`, token kept in this tab only, removed from the address bar, 10 min) | `label-punch-page.test.tsx`. **NOT VERIFIED** on a phone. |
| Opening, previewing and scanning have no punch side effects | **WORKING (local)** | DB test "opening or previewing a link has no punch side effects"; API test; page test (only the preview request is sent). |
| Auto clock-in when exactly one assigned visit matches home and window; choice when several; nothing guessed | **WORKING (local)** | DB tests "one matching visit…", "two valid visits…", "wrong home, no or other assignment, outside-window, cancellation". |
| Departure only by a separate explicit action on the matching running visit; early or ambiguous checkout asks first | **WORKING (local)** | The server decides from the person's *intent* (button), never from a repeated scan. DB test "a repeated scan, a reload or a second device…" (4 repeated arrivals and 3 concurrent departures: exactly one checkout saved). Early checkout threshold is a setting (default 30 min). |
| Idempotent, atomic; retries, reloads, rapid taps, concurrent devices never turn arrival into checkout or duplicate | **WORKING (local)** | Per-caregiver advisory lock + `unique (caregiver, idempotency key)` + stored answer; page keeps the same key when an answer is lost. |
| Show the saved time and status | **WORKING (local)** | Saved page shows time and location result in plain words; a lost answer is *not* shown as saved. |
| Phone location and accuracy at punches only; four separate results; compared with the expected endpoint | **WORKING (local)** | `within_range / outside_range / unavailable / low_accuracy`; location is requested only when the person presses the button. Accuracy limit and radius are settings. |
| A copied label link cannot authorize a punch | **WORKING (local)** | The link only identifies the label. The punch needs a signed-in caregiver of that agency with a matching assignment and visit; cross-agency and unassigned callers get "cannot be used" and no row is written for an unknown token. |
| Saves actual checkout despite location problems and flags the exception; off-site checkout of a home-only visit goes to direct client confirmation | **WORKING (local)** | Tests for denied, low-accuracy and outside-range checkouts; outside-range on home/home sets `direct_required`, blocks signing on the phone and removes the visit from the caregiver's open state. |
| Absent/multiple assignments, outside window, cancellation, reassignment, overlaps handled; attempts preserved | **WORKING (local)** | `visit_punches` (append-only) keeps every attempt incl. refused ones; `failed_punch` / `overlap` exceptions. |
| Offline queue / pending sync | **NOT BUILT** | The app has no offline queue (brief: "if offline queuing exists"). A lost connection shows "not confirmed" and retries safely with the same key. |
| Audited missed-punch corrections (poor connectivity, dead phone, lost tag, delayed login) | **WORKING (local)** (DB, API, reviewer screen) | Request + a *different* reviewer decides; applies through the existing `close_missed_service_visit` / `correct_service_visit`. **Gap:** no caregiver-side "request a correction" screen; staff file it on their behalf. A scheduled visit with no visit at all (never started) is flagged `missing_punch`; recording it still uses the existing "Record missing visit" function (TEST only, 0089). |
| Overdue open visits flagged; actual and scheduled times kept apart | **WORKING (local)** | Flagged when the exceptions list is opened (no scheduler added). |
| Save clock-out first; every unsigned checkout stays Signature pending until validly signed | **WORKING (local)** | See constraint 1 below. |
| Sign at ordinary checkout: recorded date and times shown, fresh signature on the caregiver's phone; signer name, relationship, attestation, method, time | **WORKING (local)** | `VisitSigning`; evidence stored through the existing private evidence path; `visit_confirmations` row. |
| Staff send/resend a secure expiring single-use link; replaced links revoked; owner, request and delivery history | **WORKING (local)** | Uses the 0036 link (7 days, one answer, code given by phone). **Correction to the first version of this record:** an *open* link is not replaced automatically (the database refuses a second open request), so the new email route revokes the open one first, with a recorded reason, and logs `link_revoked`. **Email sending is built** (see section 10, switch `signatureEmail`): staff type the address, the server emails only the link, the code comes back to the staff member for the phone call, and `request_created` / `email_queued` / `delivery_failed` are recorded without address, link or code. Not verified with real SES. |
| Direct signing required after an off-site checkout | **WORKING (local)** | Signing session refused for the phone; follow-up flagged `direct_signing_required`. |
| Later signing from any location; reasons unavailable/declined; late signature resolves the signature issue only | **WORKING (local)** | Follow-up resolves itself from a confirmed late confirmation; visit times, status and billable minutes verified unchanged (DB test). |
| Fresh pad per visit; no image upload, paste or reuse; server validates strokes; short-lived session bound to visit and time revision; atomic consume; reject expired/replaced/reused/wrong-visit/stale | **WORKING (local)** for the caregiver's phone | The phone sends **strokes**; the server validates them and draws the PNG itself. Session reasons tested: replaced, wrong visit, someone else's, expired, stale revision, reused, rolled-back transaction releases the session. **PARTIAL:** the secure-link page (existing 0036 page) still takes a drawn PNG; it is single-use and bound to a visit snapshot but is not stroke-validated. Converting it changes an accepted TEST page: owner decision below. |
| Material time change keeps the original signed revision in the audit history, reopens Signature pending, asks for a fresh signature | **WORKING (local)** | Original row and confirmation untouched; `reopened` event holds the original revision hash; the threshold is a setting (default 5 min). |
| Caregiver sees "Signed" and the date; images restricted; omitted from exports | **WORKING (local)** | No report, CSV or exception row holds an image, a precise GPS position or a link (tests assert this). |
| Screenshot controls | **NOT BUILT** (web only) | No native screen exists. Browsers cannot block screenshots; GPS describes the punch place, not the signer, as the brief says. |
| Admins register stickers in batches with unique IDs; assign by tap, scan or typed ID; confirm the address; show ID, status, install date; one active label per location; reject duplicate and cross-agency; log who and when; replace/reassign revokes the old link and keeps history | **WORKING (local)** (typing the ID and pasting a link) | Tap (browser NFC reading) and scan (camera barcode detection) are feature-detected: each button appears only where the phone's browser offers it, and neither is **VERIFIED** on any device. Which phones and browsers offer them must be confirmed on the TEST devices. Typing the ID or pasting the link always works. |
| No client name or address on a sticker or in the supplier file; NFC and QR open the same opaque revocable link | **WORKING (local)** | Printed sheet = QR + sticker ID + instruction (test asserts no name/address); supplier file = IDs only. |
| Preview, print, copy link for tag programming, revoke, replace; discreet / agency-branded / large high-contrast layouts | **WORKING (local)** | Every view of a link is logged. **Gap:** optional logo is not drawn (accent color and agency name are). |
| Six reports with existing filters; permission-checked drill-downs and CSV | **PARTIAL** | All six reports, date + status filters, CSV (needs `reports.export`, audited by report and row count only). The API also filters by caregiver, client and service; **the screen has dates and status only**. **Office filter NOT BUILT** (depends on offices 0110, which is not in this base). |
| Pricing/cost report | See section 7. |

## 2. Constraints found in the existing system (and what was done)

1. **An unsigned visit in `awaiting_signature` blocks the caregiver's next visit** (migration 0005 unique indexes; start refuses). "Sign later" therefore uses the **existing "unable to confirm" path**: the visit locks in `administrator_review` with 0 billable minutes, the actual checkout is kept, the caregiver is free, and `visit_signature_followups` carries the *Signature pending* work item. A later valid signature clears the follow-up; billing still needs the existing human approval. *Alternative (not done):* relax the one-open-visit rule, which touches core visit behavior.
2. **Visit times are immutable; a correction creates a new row and keeps the original confirmation** (0083). The brief wants a fresh signature after a material change: done in the follow-up table, without changing 0083.
3. **The baseline start function cannot start a visit on a chosen shift.** Migration 0102 (TEST) adds one that can. 0124 uses it when present and otherwise uses the baseline and refuses cleanly if the baseline picked another shift. Both paths are tested.
4. **The existing per-client QR card (0102) stays untouched.** Per-location labels supersede it in purpose; recommend retiring the card after the pilot (owner decision, nothing removed here).

## 3. Decisions for the owner (only the ones that matter)

1. **Re-pinned on this branch (owner decision 2026-11-23, option 1)** to cb37560 (`PINS_0109.json`, `PINS_0110.json`, `PINNED` in `release-pins.test.ts`), so CI is green here. When this merges with the other branch, re-pin once more to the merged application commit (same `release_pins.py generate` step); expect a trivial conflict in those three files.
2. **Secure-link signing page:** convert to stroke-validated signing like the phone (recommended, small), or leave the accepted TEST page as is for the pilot.
3. **Correction approval:** the person who requests a correction cannot approve it (recommended; a one-person agency needs a second reviewer or the existing direct correction).
4. **Caregivers see the expected place as city and ZIP, not the street** (matches the R23 privacy decision). Staff see the full address.
5. **Retire the per-client QR card** after the pilot.

## 4. How it fits together

* **Punch** (`ogevia_api.record_punch`): one function, the only writer. Arrival uses the existing start (authorization, readiness, shift match, one open visit); departure uses the existing end. Refusals are recorded as `not_saved` attempts with a plain reason and, where a person should look, an exception. Location is compared with the label's registered location (home) or the client's nearest approved community place.
* **Signing now**: open session (short-lived, replaces the earlier one, bound to a hash of the visit's times and service) -> phone sends strokes -> server checks the session, draws the PNG, stores it privately, then **in one transaction** consumes the session, registers the evidence and confirms. A storage failure leaves the session usable; a spent one needs a fresh pad.
* **Signing later**: existing "unable to confirm" + follow-up; staff create the existing 0036 link; history records created / copied / revoked / failed (never the link or code).
* **Exceptions** are opened by the punch function, the overdue scan and correction requests; resolution history is append-only.

## 5. Files

New: `infra/aws/db/pending/migrations/0124_nfc_qr_visit_verification.sql` and `rollback/…down.sql`; `apps/sv-api/src/home-labels.ts`; `apps/web/src/aws/{stroke-pad,visit-signing,label-punch-page,home-labels-data,home-labels-panel,verification-reports-page}.tsx|ts`; tests listed in section 6; this folder.
Shared files touched (small, for merge): `apps/sv-api/src/routes.ts` (import, `VERIFICATION_REPORTS`, `punchFields`, 29 routes appended at the end of `ROUTES`), `infra/aws/lib/service-verification-api-stack.ts` (29 routes behind `feature: "homeLabels"`), `infra/aws/lib/config.ts` (type only), `apps/web/src/lib/aws-api.ts` (`SWITCHED_PATHS`), `apps/web/src/aws/{aws-root,aws-shell,client-detail-page}.tsx` (a route, a gate, one menu link shown only when the switch is on, one panel), `infra/aws/db/pending/README.md` (one row), `apps/sv-api/test/tenant-isolation-sweep.db.test.ts` (id and value rules for the new routes; one role-sweep allowance).

## 6. Tests actually run (local; PostgreSQL 16; synthetic data)

| Command | Result |
|---|---|
| `OGEVIA_TEST_DATABASE_URL=… vitest run --config vitest.db.config.ts db/test/nfc-qr-visit-0124` (infra/aws; PostgreSQL 16 locally, CI uses 18) | 2 files, **29 passed** (28 on the TEST baseline incl. 0089-0102, 1 on the production baseline) |
| same folder, **full** `vitest.db.config.ts` (infra/aws) | 126 files, **1,320 passed** |
| `apps/sv-api` **full** `vitest.db.config.ts` | 33 files, **195 passed** |
| `apps/sv-api` unit | 8 files, **119 passed** (incl. 9 new: tokens, sealing, stroke validation, PNG) |
| `apps/sv-api` `home-labels.db.test.ts` + `tenant-isolation-sweep.db.test.ts` | **13 passed**; sweep = 289 routes, 578 probes, 0 validation-first, 0 leaks, no synthetic id kinds |
| `apps/web` full | 160 files, **1,440 passed** (22 new: pad, label page, signing, reports, inventory, print sheet) |
| `infra/aws` unit (`pnpm test`) | 900 passed, **3 failed = the release-pin tripwire (section 3, item 1)**; the new switch test (3) passes: 29 routes, OFF in every environment, JWT-only when on, nothing else changes |
| `pnpm typecheck` (7 packages), `pnpm build`, web `eslint` | clean / exit 0 |
| **`pnpm test:all` (the release gate)** | **Failed in step 1 before the re-pin** (3 release-pin tests; now re-pinned and passing, 5/5) and, in this shallow clone only, 11 tests skipped in `operator-prd-tarball.test.ts` because this clone is shallow (the pinned code commit is not in it; not caused by this change). Steps 2 and 3 (database and API suites) passed in full. The gate is not passed until the re-pin is done and the suite is run in a full clone. |
| Rollback | the down script removes every 0124 object, leaves visits/confirmations/audit rows untouched, and the migration re-applies (tested) |

The sweep and the null-safety review found two real defects in the first draft, both fixed and covered: an open shift (no caregiver) was readable by any caregiver (NULL in an `or` chain read as "allowed"), and agency settings were readable by caregivers.

## 6b. Security review checklist (`docs/security-review-checklist.md`) for the 45 new SECURITY DEFINER functions

* **Target row belongs to the claimed organization:** every API function checks the caller's permission or membership for `p_organization_id` *and* reads the target row with `organization_id = p_organization_id` (labels by code and by id, locations, exceptions, correction requests, shifts, visits). The label punch takes **no organization from the caller**: the agency is the label's own, and the caller must be an active caregiver there. Proof: `tenant-isolation-sweep.db.test.ts` probes all 289 routes (29 of them from this change) as an agency-B manager naming agency A and naming his own agency with agency A's ids: 0 leaks, 0 existence differences, agency A unchanged.
* **Specific relationship, not just membership:** a punch needs the caregiver's own assignment/shift and a running visit of their own; a signing session needs the caregiver's own visit; a caregiver sees an expected place only for a shift that is theirs (the null-safety defect found and fixed here was exactly this check).
* **`search_path` pinned:** all 45 (`set search_path = ogevia, pg_temp`), asserted by test.
* **Grants:** `revoke all … from public` on every function; `EXECUTE` only for the 34 API functions to `ogevia_app`; the 11 internal functions have no grant; nothing for `anon`. All 13 tables have row security on, no policy and no privilege for the application role. Asserted by test ("0124 grants and row security").
* **Client-supplied ids:** the organization and ids a caller sends are only ever re-validated against the caller's own rights; times, status, location result and agency are never taken from the caller.
* Tokens: the label token is 256 random bits, stored as a SHA-256 hash plus an AES-GCM sealed copy (existing QR key parameter, agency-bound context, discarded when the link is revoked); tokens, codes and strokes are not logged (API test asserts the log carries none).

## 7. TEST acceptance and cost

**Not run anywhere but a laptop-class container.** What TEST must still show (none of it is verified):

| Item | Where |
|---|---|
| Four visit setups end to end through the real screens | TEST (the visit screen is not yet wired to community punches) |
| QR and NFC on **iPhone and Android** (how each phone opens a tapped tag, the location, camera and NFC prompts, reloads, repeated scans; which browsers offer in-app NFC reading and QR scanning for assignment) | **real devices** |
| Concurrent devices, early checkout, denied/low-accuracy GPS, poor connectivity, revoked and wrong labels, agency isolation | database/API parts verified locally; phone behavior not |
| Batch registration, tap/scan assignment, duplicate and cross-agency rejection, moved-sticker mismatch, replacement revocation | database/API verified locally; tap and scan UI not |
| Immediate and later signing, direct confirmation after an off-site exception, report creation and clearance, corrected-time re-signing, rejection of upload/paste and invalid or reused sessions, restricted access to signature evidence | verified locally through the real handler with an in-memory evidence store; **real S3 storage not exercised** |

**Cost (measured or UNKNOWN; no prices were invented):**

* **New AWS resources: none.** The 29 routes use the existing HTTP API, Lambda, database and evidence bucket. Fixed monthly cost change: **0**. (Route count on the API rises by 29 only when the switch is on.)
* **Signature storage (measured):** a server-drawn PNG of a three-stroke signature at 1200x400 is **about 5.8 KB**; the stroke JSON is about 4.3 KB and is *not* stored (only the PNG and a checksum are). 10,000 visits would add about 58 MB to the evidence bucket (arithmetic, not a bill).
* **Database rows per visit:** one punch row per attempt (both clock events plus refusals), one signature session, a few audit and event rows; each is small text and numbers.
* **UNKNOWN until measured in TEST/pilot:** sticker and NFC tag unit prices (supplier quote needed), printing, **email** (no sender built), **address lookup** (no provider connected), support time. **SMS and Sandata integration are not estimated** (not added, per the brief).

## 8. Release steps (not performed; each needs the owner's explicit go)

1. Merge with the other work; renumber 0124 if another branch took it; re-pin (section 3).
2. Snapshot, then apply 0124 to TEST through the ledgered runner (`BACKUP REQUIRED` rollback).
3. Turn `features.homeLabels` on for TEST only; run the TEST acceptance table with real phones; record results here.
4. Production only after the release checklist (`docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`) and the owner's GO.

## 9. Release 2 integration (2026-11-27)
This branch now contains PR #124 (merged in, so it carries #124's own migrations 0113-0123) plus the NFC/QR work and the directive items below. PR #124 is untouched and can merge on its own first; this branch then shrinks to its own changes.
* **Renumbered:** NFC/QR migration 0120 -> **0124** (0120-0123 belong to #124). Files, tests and docs renamed; behavior unchanged.
* **0125 Authorization Worklist** (new, pending, switch `authorizationWorklist` OFF): `GET /v1/authorization-worklist`; page `/authorizations/worklist` with dashboard, hours totals, by-office table, filters (month, status, client, office, program, dates, "expiring within N days"), CSV, Excel, Print.
* **Exports everywhere it was missing:** one helper (`report-export.ts`, `export-menu.tsx`): CSV, Excel and Print on Caregiver readiness (Care Team), Documents, Caregiver holds, the Authorization Worklist and all NFC/QR verification reports; the rows exported are the rows on screen, in screen order, formula-safe.
* **Office filter** on all six NFC/QR reports (needs 0110/0111, which production already has).
* **Compliance package:** `docs/compliance/` (retention policy draft with blank periods, security, HIPAA and BAA readiness checklists).
* Existing in #124 and not rebuilt: readiness dashboard, CPR/TB and document tracking, holds, admin-approved exceptions with revoke/audit, notifications, invitations, offices, open-shift workflow, service-location/county.

## 10. Signing-link email (2026-11-27)
* `POST /v1/visits/{visitId}/signature-link-email` (switch `signatureEmail`, OFF everywhere). Needs the environment's email function (`notifications` + `notificationEmail` from PR #124); without it the route answers 503 **before** creating any link. Permission: `visits.manage`.
* **The email** (`signature-email.ts`): subject "Please confirm a care visit" (nothing visit-specific); body = agency name, the link, the expiry date, "enter the 6-digit code the agency gave you by phone". **Never** the code, a client or caregiver name, service, date or time. HTML uses real paragraphs and a list (no collapsed line breaks).
* **Flow:** revoke an open earlier link -> create the 0036 link -> send through the existing email Lambda (one retry on a transient error; the Lambda's TEST recipient allow-list still applies) -> record `email_queued` or `delivery_failed` (status code only). On success the **code** returns to the staff member to read out; on failure the link and code return so it can be copied. A repeated retry key cannot email the same link twice (409).
* **Where it appears:** Visit verification > Checked out without signature > Send signing link > "Email address" + "Email the link".
* **Tests:** text 4, route 3 (success, failure/retry, unavailable/permission/isolation/validation), web 1, CDK switch 2, sweep (321 routes, 0 leaks).
* **Not verified:** a real SES send (needs a verified sender identity in the environment: owner decision, `docs/release-train-2/email-sender.md`); how the email looks in real mail clients; delivery to a real address. The address is typed by staff from the file: this app has no stored signer email.
