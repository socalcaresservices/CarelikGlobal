# Missing-signature recovery: design and decision gates

**Status:** DESIGN ONLY. Nothing in this document is built or deployed. Do not
call the missing-signature workflow complete until a recipient and a manager
can finish it end to end on AWS TEST (pilot findings, Oct 4–5 2026, item 3).

**Date:** 10/05/2026. **Scope:** AWS TEST, synthetic data only, until the
BAA/security gate is confirmed separately.

## 1. Problem

A visit can end without a client or representative confirmation. The
caregiver records "unable to confirm" with a reason (method
`unable_to_confirm`). Today that visit:

- is locked, as every finalized visit is (`service_visits_guard_update`);
- shows its no-signer reason on the Visit review page (`/visits/:visitId`,
  built in 0031, not yet deployed);
- can only be closed by an administrator as "accept capped billable" or
  "close not billable" (0031 `decide_visit_review`), with a reason and an
  audit record.

There is no path for the client or representative to confirm the visit
afterwards. The agency must then either bill without the confirmation the
payer may expect, or not bill time that was actually worked.

## 2. What already exists and will be reused (VERIFIED in the repository)

| Existing piece | Where | Reuse |
|---|---|---|
| Hashed, expiring, revocable public links | `0011_care_requests_availability.sql`: `token_hash` (SHA-256 hex, unique), `expires_at`, `revoked_at`, resolution only through one `*_by_token` function | Same pattern for signature-request links |
| Approved public-route list | `infra/aws/lib/public-routes.ts` + `assertPublicRoutesApproved` (synth fails if a public route is not on the approved list) | New public routes must be added there, with the owner's acknowledgement |
| Private evidence storage | EvidenceStorage stack (private, encrypted S3) + `visit_evidence` metadata | Store the late signature image and any paper scan the same way |
| Locked-visit immutability | `service_visits_guard_update`, `visit_confirmations.visit_id unique` | Late evidence is a **separate append-only record**; the original "unable to confirm" confirmation is never overwritten |
| Review decisions | 0031 `visit_review_decisions` (append-only, revocable until billing approval) | A manager's acceptance of late evidence is a review decision with its own type |
| Audit | `write_audit` | Every request, view, response, acceptance, rejection and revocation |

## 3. Proposed workflow

Electronic first, paper as a fallback.

1. **Request.** An administrator (permission `visits.manage`) opens the visit
   review page and selects "Request confirmation". They pick the recipient
   from the client's recorded representatives, or enter a name and
   relationship. The server:
   - creates a `visit_confirmation_requests` row bound to the visit **and its
     current version** (snapshot of times, service, caregiver, worked minutes);
   - creates a random 256-bit token and stores only its SHA-256;
   - sets an expiry (recommended: 7 days) and a single-use rule;
   - returns the link once to the screen. It is not stored in plain form and
     is not logged.
2. **Delivery.** See decision gate A. The recommended default is that staff
   copy the link and send it through a channel they already use. Ogevia
   records "link created", not "delivered".
3. **Recipient verification.** See decision gate B. The recommended default
   is a one-time code that staff read to the recipient by phone. The code is
   separate from the link, and five failed attempts lock the link.
4. **Recipient view.** The page shows only what is needed: agency name,
   service, date, start and end time (MM/DD/YYYY, h:mm AM/PM, agency
   timezone), caregiver first name, and duration. It shows no client
   identifiers, DOB, payer IDs or diagnosis.
5. **Recipient response.** The recipient chooses one of:
   - **Confirm.** They draw a signature or type their name, state their
     relationship, and attest.
   - **Dispute.** They give a reason, for example a wrong time or the visit
     not happening.

   The response is append-only and stores the visit version it confirmed.
   If the visit was corrected after the request was sent, the link is void
   and a new request is required.
6. **Manager review.** The visit appears in Needs attention under "Late
   confirmation to review". The manager either:
   - **accepts** the evidence: an append-only review decision
     `accept_late_confirmation`, with a reason; or
   - **rejects** it, with a reason. The visit stays in review, where it can be
     re-requested or closed as not billable.

   A dispute always routes to review and never becomes billable automatically.
7. **Billing eligibility.** This is decision gate D. Accepted late evidence
   can make the visit eligible for the existing **human** billing approval.
   It never approves billing itself.
8. **Paper fallback.** An administrator uploads a scan of a signed paper
   form. The scan goes to private S3 as `visit_evidence`, with
   `kind = late_paper` and recipient details as entered by staff. It then
   goes through the same manager accept/reject step.
9. **Tracking.** The visit page shows each request: created, by whom,
   expiry, verification attempts, response, review decision, and
   revocation. An administrator can revoke a request at any time before it
   receives a response.

## 4. Data model sketch (new migration; not written)

- `visit_confirmation_requests`: id, organization_id, visit_id,
  visit_version, visit_snapshot, recipient_name, recipient_relationship,
  token_hash (unique), verification_hash, failed_attempts, expires_at,
  revoked_at/by/reason, created_by, created_at. A unique partial index
  allows one active request per visit.
- `visit_late_confirmations`: id, organization_id, request_id (null for
  paper), visit_id, visit_version, outcome (`confirmed` | `disputed`),
  method (`draw` | `typed` | `paper`), evidence_id, signer_name,
  signer_relationship, dispute_reason, attested_at, received_at. Updates
  and deletes are blocked by a guard trigger.
- `visit_review_decisions.decision` gains `accept_late_confirmation`. It
  references the late confirmation, and the existing revoke-before-approval
  rule applies.
- Public functions resolve the token only through one
  `confirmation_request_by_token(hash)` function: active, not revoked, not
  expired, not answered, and visit version unchanged.

## 5. Failure modes covered by the design

| Case | Handling |
|---|---|
| Link forwarded to the wrong person | One-time code (gate B); single use; revocable; minimum information shown |
| Link guessed | 256-bit random token; only a hash is stored; uniform 404 for invalid, expired or revoked links |
| Visit corrected after the request | Version binding voids the link |
| Double submit or retry | Idempotency key on the response; second response refused |
| Dispute | Never billable without a manager decision; stays in review |
| Request after billing approval or submission | Refused; corrections after approval follow the existing correction path |
| Cross-agency access | Token resolves to one organization; staff functions check membership and permission |
| Logging | Token, code and signature payload never logged (existing API log rules) |

## 6. Decision gates (owner)

### A. Delivery channel

The pricing below comes from secondary sources, because the AWS pricing
pages could not be fetched from this environment. Confirm it on
aws.amazon.com before approval.

| Option | Fixed cost | Per message | Effort and risk |
|---|---|---|---|
| **Staff copy the link** (recommended for the pilot) | $0 | $0 | No new AWS resource. Staff send the link from their own phone or email. Ogevia cannot show delivery. |
| Amazon SES email | $0 (identity and DNS setup) | about $0.10 per 1,000 under the pay-as-you-go plan; secondary sources report SES pricing plans introduced 07/21/2026 | Needs a verified domain, production-access request, bounce handling, and an email body without PHI. PHI-free notices are low risk. Confirm SES is covered under the BAA before any PHI is sent. |
| SMS (AWS End User Messaging, 10DLC) | about $4 one-time brand registration, about $10/month per campaign ($2 low-volume), about $2/month per number | about $0.0088 per US message including the carrier fee | Carrier registration takes days to weeks, and opt-in/STOP handling is required. It is a recurring fixed cost, so it requires approval. |

**Recommendation:** staff copy the link for the pilot, with SES only after a
separate approval. No SMS until the pilot shows a measured need.

### B. Recipient identity verification

Recommended: a one-time 6-digit code read by staff to the recipient by
phone, plus the recipient attesting to their name and relationship.

Alternatives:
- a link alone (weakest);
- a knowledge question (needs client data in the public flow, so it is
  rejected).

### C. Payer acceptance (legal and business; cannot be derived from code)

Whether IRC/DDS or another payer accepts:
- a confirmation obtained after the visit date;
- an electronic or typed signature;
- a paper form scanned later.

The time window allowed is also unknown. **UNKNOWN.** The owner must confirm
this with the payer or contract before accepted late evidence counts toward
billing. Until then, the recommended default is that late evidence is
recorded and reviewable but **does not change billing eligibility**.

### D. Billing rule for accepted late evidence

Recommended: accepted late evidence makes the visit eligible for the
existing human billing approval, at worked minutes capped by authorization
(the same rule as "accept capped billable"). This requires a server-side
change to `approve_visit_for_billing`, which would be gated on decision C.

## 7. Test plan (required before calling this complete)

1. Request → copy link → recipient verifies code → confirms with a drawn
   signature → manager accepts → visit eligible → human billing approval.
2. The same flow, with the recipient disputing → visit stays in review → not
   billable.
3. An expired, revoked, already-answered or wrong-agency link gives a uniform
   refusal.
4. Five wrong codes lock the link.
5. Visit corrected after the request → link void.
6. Paper upload → manager accepts or rejects.
7. Retry or double submit → one response.
8. Phone width 390 px for the recipient page.
9. Audit rows for every step. Token, code and signature are absent from logs.

## 8. Cost and effort estimate

- **AWS (pilot, staff-copied links):** no new fixed cost. Requests and
  responses use the existing API Lambda, RDS and S3. The marginal cost is
  negligible at pilot volume.
- **Build:** one migration, about 6 API routes (2–3 of them public), the
  recipient page, the request and review UI, DB, API and e2e tests, and a
  release. About 3–5 focused working days, then a rehearsed TEST release.
  This is an estimate, not a commitment.
