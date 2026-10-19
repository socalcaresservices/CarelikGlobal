# Count definitions and attention timing (owner directive 2026-10-18, items 2.4 and 2.5)

Status: IMPLEMENTED and TESTED locally (migration 0080, synthetic data). NOT deployed; TEST has 0053 to 0077 applied, production state unknown.
Every number below is computed by the database from the same rows as the list it opens (`ogevia.action_issue_rows`, the rows behind `list_action_issues`). The web shows the numbers; it does not recompute them.
Where the API serves them: `GET /v1/attention` now also returns `counts` (from `ogevia_api.get_attention_counts`); no new API route was added, so no API Gateway change is needed.

## 1. Timing rules (one set, applied by the server in the lists, counts and screens)

| Item | Rule | Server source |
|---|---|---|
| Unfilled shift, or shift whose caregiver is blocked (compliance hold or required document) | Upcoming when it starts MORE than 48 hours from now. Urgent when it starts 48 hours or LESS from now (exactly 48 h is Urgent). Critical at or after its start (exactly at the start is Critical) while it has not ended. | `ogevia.shift_attention_class(starts_at, now)` (0080) and the same comparison in `action_issue_rows`, the overview and the summary (0059, 0073, 0077); tests compare all of them |
| Caregiver hold | Effective at once: the readiness gate refuses new work immediately. Only where the affected shift is LISTED follows the shift rule above (a far-off blocked shift is listed as Upcoming but the hold is already enforced). | 0055 gate, 0064 |
| Pending Confirmation | Routine (a reminder) until 48 hours after the visit END; then Urgent ("confirmation overdue"). The agency may set a SHORTER number, never longer. | `attention_rule_hours(org, 'confirmation_overdue')` (0073) |
| Administrator review | Enters the Approvals exception queue immediately (Routine). Urgent after 24 hours in that queue. The agency may set a shorter number. | `visit_review_entered_at` (0059), `review_overdue` rule |
| Document review (staff upload awaiting review) | Routine for 48 hours after the upload; then Urgent ("review overdue"). Sooner, at once, when the document is expired or blocks care (section 4). | `document_review_overdue` rule (0073); escalation test in `action_issue_rows` |
| Routine reminders | Listed, never added to an urgent number: Pending Confirmation under 48 h, Ready for Approval, routine document review, documents expiring soon, waiting for a signature, pickups, reconciliation, authorization changes, caregiver holds as items. | queue and severity on each row |
| Red styling | Red means the SERVER says Critical for that badge's items. An Urgent or overdue item is amber. The sidebar badge is red only when the count's `critical` is above zero. | `critical` in each count |

### Administrator-review clock: which event starts it, and whether it restarts
No new column was needed (0080 adds functions only). The existing lifecycle evidence is valid: `service_visits.signed_at` is written with the status `administrator_review` by every path that sets it (confirmation, manager correction, outage record), so `visit_review_entered_at(visit)` is the ACTUAL review-entry event, never the visit creation time. It is the latest of: that entry, a review decision that was revoked, a confirmation request that lapsed or was revoked, a late-confirmation review that was decided.
- Late confirmation: a late client response is its own item; its clock is the time it was received and it escalates 24 h after that. Deciding it ends the item.
- Correction: a manager correction creates a NEW visit that enters review at the correction; its own 24 h clock starts then. The old visit is no longer in the queue.
- Reopening (a revoked review decision): the clock RESTARTS at the revocation, not at the first entry.
- Historical timing is NOT reconstructed. Where an entry time cannot be established the function returns null, the item is still counted and shown, it is never escalated, and no time is invented. (`signed_at` is required for every visit in review, so this is a safeguard for the unexpected; it has not been observed.)
- Tests: `attention-tiers.db.test.ts` (clock = entry not creation; 23:59 vs 24:01; correction; revoked decision; lapsed request; late confirmation; null timing) and `attention-counts-one-definition.db.test.ts` (23 h 59 m 59.999999 s, exactly 24 h, plus a microsecond, and 0 s).

### What is NOT modelled
- Stricter payer, regulator or contract deadlines (for example a payer rule shorter than the agency's) are NOT modelled. 0073 lets an agency set a SHORTER confirmation, review or document-review deadline (never longer, every change recorded with who, when, why); it does not know any external deadline. Still true on this branch.
- The 48-hour shift window is fixed. The overview endpoint accepts a different window for experiments (1 to 168 hours), but the counts, the badges and the issue list always use 48 hours.
- The summary function `get_attention_summary` keeps a default of 60 minutes for its third argument. The API always passes 2880 (48 h), and the agency rule can only shorten it, so the real deadline is used. Direct callers that rely on the default would see "not confirmed" after 60 minutes; none exists in the code.

## 2. The six counts (one definition each)

"Issue" means one row of the issue list (one problem on one record). "Item" means a unique shift or visit (one record can have two issues).

| Count | Where it is shown | Definition | Opens | Seen by |
|---|---|---|---|---|
| Needs attention | Header badge (every page except Home), Home first row and tile | Unique shifts and visits in the Needs attention now queue: an unfilled or blocked shift that is Urgent or Critical (starts within 48 h or has started), a visit still open past its end (missing clock-out), a visit in progress for a caregiver on hold. Critical count shown with it. | `/attention` (Needs attention now). Same as `get_attention_overview.urgent.itemCount` (tested equal). | `shifts.manage` or `visits.manage`, or `visits.read`, or `readiness.read` |
| Needs action | Home "Needs action first" ("View all (n)"), Action needed page ("n need action") | Critical and Urgent ISSUES in three queues: Needs attention now, Documents & compliance, Visit review. Counts issues, so one shift with two problems adds two. Routine items are not counted. | `/action-needed` (all severities in those queues; filter severity Critical or Urgent). Equals `list_action_issues.counts.actionNeeded`. | any of the permissions above |
| Notifications | Bell badge | Unread, unresolved in-app notifications addressed to YOU. Critical issues always notify the staff who can see them; Urgent issues notify per the agency setting (default on); Routine never. One per person, issue and severity step. A notification stops counting when the issue is no longer in your list or you mark it read. Brought up to date when your notification list is read. | the bell panel; the number is the `unread` of `list_my_notifications` (tested equal to the unread rows listed) | any staff member who can see attention items |
| Scheduling (sidebar badge) | Sidebar "Scheduling"; the page's "Need action now" figure shows the same number | Unique shifts in Needs attention now that need staffing action: unfilled (open or called-out and not replaced) or with a blocked caregiver, starting within 48 h or already started and not ended. Upcoming shifts more than 48 h away and ended shifts are NOT counted. | the Scheduling page, group "Upcoming: need coverage" (every unfilled shift that has not ended, running shifts included, listed in start order). The badge is the subset starting within 48 h or running; the heading counts the whole group for the chosen calendar range. | `shifts.manage` or `visits.manage` |
| Caregivers (sidebar badge) | Sidebar "Caregivers" | Urgent STAFF document issues: document expired, document overdue, document review overdue. Routine document review, expiring-soon reminders, rejected uploads, caregiver holds as items, and CLIENT documents are NOT counted. | Documents & compliance, restricted to staff documents at Urgent. Equals the staff-document issues in the Documents & compliance queue with severity Urgent or Critical. | `documents.read` |
| Approvals (sidebar badge) | Sidebar "Approvals" and "Visits to review" | EXCEPTION REVIEW only: missing clock-out, confirmation overdue (Pending Confirmation after 48 h), administrator review (counted from the moment it enters the queue, Routine or Urgent), late response to review. Pending Confirmation under 48 h and Ready for Approval are NOT in it. | "Visits to review" (the exceptions view). | `visits.read` |
| Ready for Approval (its own count, never added to Approvals exception review) | Sidebar "Approvals" for someone who may see billing; billing review page | Visits that are Ready for Review (signed, or accepted in review) or Voided, waiting for a person to approve billing. Approval is a human step; nothing here approves, submits or pays. | the billing review page (`/billing-review`). Equals the `ready_for_approval` queue and `billing_ready_unapproved`. | `billing.visits.read` |

A person who may not see a count gets no number (null in the response, no badge in the sidebar), never a false zero. A caregiver gets none of these.
The sidebar "Approvals" link shows Ready for Approval when it opens the billing review page (people who may bill) and exception review when it opens the exceptions view (everyone else). "Visits to review" always shows exception review.

## 3. What changed from the earlier badges (so the change is not hidden)
- Approvals badge: it MIXED the two. It added missing clock-out, awaiting confirmation, visits to review, signatures to review AND Ready for Approval into one number. Now Ready for Approval is separate (own number, own link) and exception review has its own. This follows the owner's earlier decision to keep review exceptions and billing approval apart.
- Caregivers badge: it added all documents "to review", including routine uploads under 48 hours. Now only Urgent staff-document issues count. Routine review is still listed, not counted.
- Scheduling badge: counted unfilled shifts only. Now it also counts shifts whose caregiver is blocked, because those are in Needs attention now with the same timing rule. The previous source (`get_attention_summary.uncovered_shifts`) still exists and is unchanged.
- Badge colour: it used a fixed list (missing clock-out, overdue documents = red). Now it follows the server's Critical number.
- Web "Upcoming: need coverage" and "Needs coverage only": used the browser clock and the raw coverage state. Now they use the server's display state (below).

## 4. "Blocks care" (document review) defined from the existing eligibility rules
An uploaded staff document that is awaiting review is escalated at once (instead of waiting 48 hours) when ANY of these is true, taken from existing records:
1. The document is expired (`currency_status = expired`, from the document's expiry date or the requirement policy), or
2. its caregiver has an unresolved readiness flag of kind `document` (written by the required-documents gate, 0041, when a required document is not current) on a shift that is scheduled, has not ended and is not called out. That flag is the readiness-check result that makes the shift Blocked; once it is resolved the upload is Routine again.
A caregiver compliance HOLD is a separate item (queue Documents & compliance, Routine item, enforced immediately by the gate) and does not by itself escalate a document upload. Client documents escalate only at the review deadline (they have no shift link).
Tests: `attention-counts-one-definition.db.test.ts` (48 h minus a microsecond Routine, exactly 48 h and plus a microsecond Urgent; blocks-care escalation and un-escalation when the flag resolves) and `attention-tiers.db.test.ts` (expired replacement, blocking flag).

## 5. Investigation: "1 needs coverage" beside two past shifts on Scheduling
Finding: a GROUPING error in the web page, not a counting error on the server. Evidence (synthetic):
- Server (`attention-counts-one-definition.db.test.ts`, "'1 needs coverage' beside two past shifts"): a shift that started 30 minutes ago and has nobody assigned is counted once (summary `uncovered_shifts` = 1, Scheduling count 1 and Critical = 1, in the issue list as `uncovered_open` in Needs attention now). Two uncovered shifts that ended 3 h and 28 h ago are NOT counted anywhere. In the shift list the ended ones have `coverage_state = needs_coverage` (nobody was ever assigned, a raw fact) but `display_state = missed`, while the running one is `needs_coverage`. So past shifts are never counted as needing coverage; the number 1 was correct.
- Web before the fix: "Upcoming: need coverage" kept a shift only if `startsAt > browser now` and the "Needs coverage only" box and month grid used the RAW `coverageState`. The running shift (started, not ended) was neither "Upcoming" nor "Past: need review", so the page showed a count of 1 elsewhere and two past shifts in the lists and nothing in the coverage group. The raw state also let ended shifts appear under "Needs coverage only", and ended rows were drawn with the red "needs coverage" border.
- Fix: the page now uses the server's display state for every coverage decision (no browser clock): the group is "unfilled and not ended" (running shifts included, ended shifts never). Tests: `attention-counts-badges.test.tsx` (heading counts 3 of 5 shifts; the two Missed shifts are not in the group and are hidden by "Needs coverage only") and the DB test above.
- I could not see the real screen or data. If the owner's case differs (for example an unfilled shift tomorrow at an agency in another time zone), the DB test shows the rule the server applies: the badge counts only shifts starting within 48 hours or running.

## 6. Tests that tie each count to its list
Database (`infra/aws/db/test/attention-counts-one-definition.db.test.ts`): Needs attention vs overview and vs the queue list; Needs action vs `list_action_issues.counts.actionNeeded`; Scheduling vs unique shift ids in the queue; Caregivers vs staff-document issues; Approvals exceptions vs the exception reasons and vs the summary; Ready for Approval vs its queue and vs `billing_ready_unapproved`; Notifications vs the unread rows. Run for owner, manager and scheduler. Null for what a role may not see; another agency never reaches the counts.
Handler (`apps/sv-api/test/action-issues.db.test.ts`): `GET /v1/attention` returns `counts` that equal the issue lists the same caller opens.
Web (`apps/web/src/aws/attention-counts-badges.test.tsx`): sidebar badges show the server numbers; Approvals and Visits to review stay apart; red only on Critical; a missing count shows no badge; the Scheduling figure equals the badge; past shifts are not counted as needing coverage.

## 7. What is still computed in the web (stated plainly)
- `coverageTone` / `itemTone` in `attention.ts`: a legacy fallback used ONLY when a response has no server `tier` (an older server). With the current server the tier is always present, so the web does not decide Urgent versus Critical. The fallback is kept so an older API still renders; it can be removed once 0080 is deployed everywhere.
- The Pending Confirmation, review and document hint texts name 48 h and 24 h as words. The numbers that decide are server-side.
- Row actions in the shift list (`editable`, `future`) still compare the shift end and start with the browser clock to decide which buttons to offer. They do not change any count or group.
- The header badge and the Home tiles read `GET /v1/attention/overview` (their own request); the sidebar badges read `counts`. Both are produced by the server from the same rows and are tested equal; they are two requests, so after a change they can differ for up to one refresh interval (5 minutes), not by definition.

## 8. Over limit in Action needed (migration 0084, owner decision 2026-10-18; implemented and tested locally, NOT deployed)
Owner hours rule: pay all actual hours worked, warn about overages, never bill beyond the monthly authorized hours. Worked time is kept; the warning is this item.
| Item | Definition |
|---|---|
| What | One issue per authorization lineage, for the agency-local CURRENT month, when committed minutes (Billable + Rounding + Pending + Reserved, the per-authorization Over limit figure of `ogevia.hours_breakdown` / `list_monthly_service_summary`) are greater than Authorized. Never netted across authorizations; exactly at the limit is not an item. Only the current month is listed (an overage in a past month is read in the reports, not here). |
| Text | `N h over the monthly authorization (A h authorized). Over-limit time cannot be billed; worked time is kept.` The row shows the client and service codes (the issue list is code-only for every kind). The list also returns `overLimitMinutes` and `authorizedMinutes`. |
| Severity | Urgent. Never Critical by itself (red must not automatically mean Critical). Not to be confused with the authorization tier word "critical" on the client page and in utilisation (a utilisation level, not an issue severity). No deadline, so it has no "Due" time. |
| Queue and category | Queue Visit review, category Authorization (the existing category and filter; no new queue). |
| Who sees it | Holders of `visits.read` (owner, manager, scheduler): the permission behind the hours surfaces. Nobody else; a caregiver cannot open the list; another agency never sees it. |
| Action | "Amend or add an authorization": `/clients/<client>#authorizations` (the client page, Authorizations card). Nothing is changed for the person. |
| Identity and resolution | Issue key `authorization:over_limit:<stable id of lineage and month>`. Acknowledge/History work as for every issue. It resolves on its own when Over limit returns to 0 (the next list read records it as resolved) and reappears as the SAME issue (reopened) if it recurs. A new month is a new issue. |
| Counts | Included in Needs action (`get_attention_counts.needsAction` and `list_action_issues.counts.actionNeeded`, Urgent, `byQueue.visit_review`, `urgent`). NOT in Needs attention now, Scheduling, Caregivers or the Approvals exception count (kind authorization, queue Visit review); the legacy `/v1/attention` summary and the overview are unchanged. |
| Home | "Needs action first" lists it (it is a non-routine issue); "View all (n)" uses the same count. |
| Notifications | No new mechanism: the existing in-app rule already covers every Urgent issue in Visit review (Urgent notifies per the agency setting, default on; Critical always; routine never). Text is the label "Over the monthly authorization", with the client code. No email, text or push. |
| Tests | `infra/aws/db/test/over-limit-action-needed.db.test.ts` (item and numbers, boundary, per authorization, identity and reopening, counts equal the list, permissions, notifications), `attention-counts-one-definition.db.test.ts` (needsAction equals the list with the item present), `apps/web/src/aws/action-needed-page.test.tsx` (label, Urgent word, link, category filter). |
Not done: names instead of codes on this row (the whole issue list is code-only today); an Over limit tile on the Visit review page (that page counts visits).

