# Phase 7.1 — Cover Shift Notifications

Date: 2026-11-23 · STATUS: **NEEDS HUMAN INPUT** (nothing new built in this branch; the complete implementation already exists on another branch and is ready to port once the owner decides the points in section 4)

## 1. What exists (VERIFIED from code)
| Requirement | In the release lineage (production c7691b63 and this branch) | On `claude/magical-rubin-d40thi` (commits c507cbe1…cbceb5f7, not deployed, forked from main 466f8ac9) |
|---|---|---|
| In-app notifications | YES, office side: `GET /v1/notifications`, bell (`notifications.ts`, migration 0077). Critical always, Urgent per agency setting. Uncovered shifts ("No caregiver assigned", "Caregiver called out, not replaced") raise Urgent/Critical. Setting `outboundChannels` is fixed to `'none'`. | Same, plus caregiver Open Shifts board and office Coverage queue |
| Email | NO outbound email exists for notifications (only Cognito's invitation email) | NO ("the contact stores the email preference but no email is sent") |
| SMS | NO | YES, written, **mock transport only; cannot send** (no provider package wired; agency switch, entitlement and sender default OFF) |
| Notification preferences | Agency-level only (in-app urgency) | Per caregiver `caregiver_sms_consent(+events)`, per office contact preferences, quiet hours, monthly limit, on-call routing |
| Audit logging | In-app: notification rows | Audit event on every transition; `notification_jobs` append-style records; receipt reconciliation |
| Retry handling | n/a | Job table with unique key (agency+purpose|round|recipient), claim/send/record, unknown/transient outcomes, re-queue panel |
Migration 0086 on that branch is 1,946 lines and **collides with the production ledger's 0086**-number space only in the sense that production already has 0001–0112; it must be renumbered (0113+).

## 2. Why I did not port it blind in this pass
- It was branched from `main` (466f8ac9) before 339 release commits; `git merge` conflicts in 11 files (computed in Phase 1) including `routes.ts`, the CDK stack and nav, files the release lineage rewrote.
- Turning it on needs decisions that are not mine to invent: a paid SMS provider and per-agency sender registration (new third party handling caregiver phone numbers and client-linked shift text), consent wording, recipient rules and limits.
- Directive: no paid vendor, no new PHI-sharing vendor and no new migration releases without the owner's approval. A port that cannot be switched on is cost without value today.

## 3. Recommended path (one path)
1. Owner answers section 4.
2. Port in a separate branch from this one: merge the branch, resolve the 11 conflicts, renumber 0086 → 0113 (+ rollback), put the new routes behind a new `openShifts` release switch (OFF in production and TEST), keep the SMS schedule disabled, re-pin, run full gates. Estimated effort: one focused engineering pass; risk is the conflict resolution in `routes.ts`/stack, which the existing route-sweep and slice-contract tests will catch.
3. Add **email first**, because it needs no sender registration and costs almost nothing: reuse the job table (`channel = 'email'`) and send through Amazon SES (same SES identity decision as the branded invitations, 7.2). SMS stays disabled until the toll-free sender is registered (lead time is the provider's, not engineering's).
4. TEST with allowlisted test numbers/addresses; production only after the owner's GO.

## 4. Decisions needed from the owner (batched, with my recommendation)
| # | Decision | Recommendation |
|---|---|---|
| 1 | Who is notified when a shift needs cover: all eligible caregivers, or the office first? | Eligible caregivers by city and readiness (the branch's eligibility function), office notified in-app |
| 2 | Channel | In-app + email first; SMS later |
| 3 | Limits | Branch defaults: 14-day window, urgent 48 h, escalation 24 h, quiet hours 9 PM–7 AM, 100 texts/month/agency |
| 4 | SMS provider | Amazon end-user messaging (toll-free sender, about $2/month plus about $0.03 per segment; estimate from the branch notes, confirm on the AWS pricing page) |
| 5 | Microsoft Forms shortcut | Keep as the fallback until the board is live; do not run both in parallel for the same shift |

## 5. Not verified
Nothing in this document was executed against TEST or production; the branch's own evidence is local PostgreSQL with synthetic data (its README).
