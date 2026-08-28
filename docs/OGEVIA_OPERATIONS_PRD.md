# Ogevia Operations PRD

**Status:** Active product requirements  
**Last updated:** 2026-08-27  
**Scope:** Client operations, scheduling, Visit Verification, authorization-hours control, exceptions, and operational reporting.

This document is the product requirements document for Ogevia's day-to-day care-operations workflow. Candidate hiring remains governed by `docs/CANDIDATE_HIRING_V1.md`. Repository-wide engineering rules remain governed by `docs/PRODUCT_CONSTITUTION.md`.

## 1. Product objective

Ogevia must reduce manual reconciliation work for agencies that have multiple caregivers serving the same client. A completed visit must become one operational record that can support client authorization usage, caregiver-hours reporting, visit verification, exception review, and downstream billing review without requiring staff to reconstruct the month from multiple paper sheets.

The core operating chain is:

`Assignment / Schedule -> Visit Verification -> Verified Visit -> Authorization Usage -> Caregiver Hours -> Exception / Billing Review`

CalEVV or another required EVV workflow is separate. Ogevia Visit Verification does not claim to be EVV and does not collect GPS in the current product.

## 2. Canonical identities and source of truth

- `organization_id` is the tenant-security boundary.
- `client_code` is the operational client reference shown in privacy-limited caregiver workflows.
- `caregiver_record_id` is the operational workforce identity.
- `linked_user_id` is login/access identity and must not replace the Care Team record as the workforce source of truth.
- Client authorization hours live in the authorization model and are not retyped into visit records.
- Visit duration is derived from Time In and Time Out; it is not manually keyed by the caregiver.
- Corrections preserve the original record and create an auditable correction history.

## 3. Roles

### Agency owner / authorized operations staff

May create clients, authorizations, caregiver assignments and schedules; review Visit Verification; correct allowed visit data with a reason; review exceptions; and copy the Visit Verification link when holding the required visit-management permission.

### Caregiver

May access Visit Verification only after authentication and only within the organization(s) and assignments permitted by their membership. The caregiver must never gain broader client visibility merely by possessing the shared Visit Verification URL.

### Client / parent / guardian / responsible party

Confirms the visit details presented at the end of the visit. A failed or unavailable confirmation must not be silently converted into a verified/billable visit.

## 4. Visit Verification

### 4.1 Entry point

Canonical route: `/service-verification`.

User-facing product wording should prefer **Visit Verification** even if existing internal code, routes, database objects, or historical documentation retain `service_verification` naming.

### 4.2 Caregiver flow

The caregiver flow must be simple enough to use on a phone:

1. Authenticate.
2. See only assigned client references permitted for that caregiver.
3. Select the client and an active authorized service.
4. Tap **Sign in now**.
5. Ogevia records Time In using the server/database timestamp.
6. Visit remains recoverable if the browser is refreshed.
7. Tap **Sign out now**.
8. Ogevia records Time Out using the server/database timestamp.
9. Show the responsible party the client reference, service, date, Time In, Time Out, and total time.
10. Collect confirmation/signature or record that the signer could not confirm.
11. Lock the caregiver submission from silent editing.
12. Route exceptions to authorized office review.

### 4.3 Visit controls

- Caregiver cannot type or backdate Time In or Time Out.
- Only one open visit may exist for a caregiver/workforce record at a time.
- A visit cannot start without the applicable assignment/authorization checks passing.
- Caregiver overlap and authorization-cap rules remain data-layer rules, not UI-only warnings.
- A no-signer/unverified visit must remain visibly exceptional and must not be treated as normally verified merely because hours exist.
- Manager/admin corrections require a reason and must retain before/after history.

## 5. Sendable Visit Verification link

This is a required operational handoff, not an optional convenience.

### 5.1 Required workflow

After a caregiver has been assigned, authorized agency staff must be able to:

`Assign caregiver -> Copy Visit Verification link -> Send link -> Caregiver authenticates -> Assigned clients/services only -> Verify visit`

The reusable link must be visible in the same operational area where assignments/schedules are created, and may also appear on the Operations Dashboard.

### 5.2 Security requirements

The current V1 share link is a reusable authenticated portal link to `/service-verification`. It is **not** a caregiver-specific bearer token and possession of the URL grants no data access by itself.

The shared URL must not contain:

- client name;
- client id or client code;
- caregiver id;
- organization id;
- diagnosis, care notes, UCI, or other client-sensitive data;
- authorization details;
- PHI or other sensitive identifiers in query parameters or path segments.

After opening the link:

- authentication is required;
- organization membership remains authoritative;
- assignment and authorization checks remain authoritative;
- a caregiver can see only the clients/services the existing Visit Verification access rules permit;
- a Care Team record without a linked Ogevia login cannot use the authenticated Visit Verification link until the login is invited/linked.

The staff-facing copy/share control must be permission-gated (currently `visits.manage`).

### 5.3 Current implementation

Implemented through the production code path added in PRs #48 and #49:

- reusable Visit Verification link;
- one-click copy control;
- selectable URL fallback;
- visible on Operations Dashboard for authorized staff;
- visible on Schedule near caregiver assignment;
- no database migration required for the share control itself.

## 6. Assignment and scheduling relationship

Visit Verification must consume assignment/schedule data; it must not become a second independent scheduling system.

- Office staff create fixed weekly or one-time shifts in Schedule.
- Multiple caregivers may serve the same client across separate shifts.
- Each concrete shift remains independently changeable for call-out/reassignment.
- A call-out on one occurrence must not silently alter the caregiver's remaining recurring assignments.
- Reassignment history must preserve original caregiver, replacement, actor, reason, and timestamp.
- No-login Care Team records may be scheduled operationally, but authenticated caregiver self-service requires a linked login.

## 7. Authorization-hours control

The system must make the client balance understandable even when three or more caregivers serve the same client.

For a client + service + authorization period, Ogevia must derive:

`Authorized hours - delivered/verified hours = remaining delivered balance`

Where scheduling data is included for planning, it should separately show:

`Authorized hours - delivered hours - future committed scheduled hours = remaining schedulable balance`

Rules:

- All caregivers serving the same client/service draw from the same applicable authorization bucket.
- The calculation is client/service/period based, not caregiver based.
- The same visit contributes to caregiver-hours reporting and client-authorization usage; staff should not re-enter the visit into a second ledger.
- Near-cap and over-cap conditions must be visible before payroll/billing reconciliation.
- Authorization usage must be computed from authoritative visit/schedule data rather than manually maintained running-balance fields.

## 8. Caregiver-hours reporting

Ogevia must be able to answer, for any caregiver and selected reporting period:

- which clients they served;
- date of each visit;
- Time In and Time Out;
- worked/verified minutes;
- total hours for the period;
- visits with missing or exceptional verification.

This reporting must be derived from visit records rather than reconstructed from separate paper sheets.

## 9. Exception-first office review

Normal completed visits should not require repetitive manual review. Office attention should be directed to exceptions such as:

- missing responsible-party confirmation;
- unable-to-confirm/no-signer visit;
- EVV reconciliation needed outside Ogevia;
- time correction requested;
- authorization issue;
- overlapping service/shift conflict;
- call-out or reassignment history needing review;
- other administrator-review status.

The product goal is that staff reconcile the exception list instead of re-adding every caregiver's sheets at the end of the month.

## 10. EVV boundary

Ogevia Visit Verification and CalEVV are related operational records but are not the same system.

Current Ogevia Visit Verification:

- records service visit start/end and confirmation;
- does not collect GPS;
- must not be represented as CalEVV or as a replacement for a legally required EVV process;
- may support office reconciliation by showing that an EVV exception still needs attention.

An EVV failure must not cause Ogevia to lose the internal visit record, but the internal record must not be used to pretend an applicable EVV obligation has been satisfied.

## 11. Privacy and security requirements

- Tenant isolation is enforced with authenticated user identity, immutable organization IDs, active membership, permissions, and Supabase RLS.
- No service-role credential in the browser.
- Caregiver access follows minimum-necessary visibility.
- Caregiver Visit Verification should use internal client references rather than exposing unnecessary client demographics.
- Sensitive identifiers must not be embedded into shareable URLs.
- Signature/confirmation data and identifiable visit data must be treated according to the deployment's applicable privacy/compliance requirements; coding a client as `Client 1` alone is not a compliance boundary.
- Audit history must remain immutable where required for visit corrections and access-sensitive operations.

## 12. Acceptance criteria for the sendable-link requirement

The requirement is complete only when all of the following are true:

- Authorized office user can see **Visit Verification Link** on Schedule after/while managing assignments.
- Authorized office user can copy the link with one action.
- Link opens the Visit Verification route.
- Logged-out recipient is required to authenticate before client data is shown.
- Caregiver account can see only assigned/permitted client references and active authorized services.
- Unassigned client is not visible to that caregiver.
- Cross-organization data is not visible.
- URL contains no client/caregiver/organization identifiers or PHI.
- User without `visits.manage` cannot see the office share control.
- Care Team record without a linked login receives a clear instruction that login linkage is required before authenticated Visit Verification can be used.

## 13. Deliberately deferred

The following are not implied by the current share-link implementation and require separate design/security review before being built:

- anonymous caregiver Visit Verification;
- caregiver-specific bearer links that bypass login;
- client-specific public links;
- GPS/EVV certification;
- replacing CalEVV;
- storing PHI in URL parameters;
- automatic employment decisions or caregiver assignment decisions without human control.

## 14. Implementation references

- `docs/SERVICE_VERIFICATION_V3_BUILD_VERIFICATION.md`
- `apps/web/src/pages/service-verification-page.tsx`
- `apps/web/src/pages/schedule-page.tsx`
- `apps/web/src/components/visit-verification-link-card.tsx`
- PR #44 — Service Verification v3
- PR #48 — reusable sendable Visit Verification link
- PR #49 — share link surfaced directly on Schedule
