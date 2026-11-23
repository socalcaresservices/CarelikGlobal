# Ogevia build brief
## City-based Open Shifts and automatic SMS

Implement this feature in the current Ogevia AWS application for SoCal Care Services. Verify the current release base and deployed migration lineage before editing. Reuse the existing schedule, call-out, pickup request, readiness, office approval, authorization and audit workflows. Validate in TEST with synthetic data. Keep production activation subject to explicit owner approval.

### Product request and completion target

Build automatic, city-based coverage recruitment in Ogevia. Staff can post an unassigned shift, and a caregiver call-out automatically reopens the same shift if the client still needs care. The system finds qualified caregivers using the actual service city and sends an opt-in SMS without staff copying or sending it. Caregivers request the opening after signing in. The office reviews and confirms the assignment. A client cancellation closes the shift and sends no recruitment alert.

SoCal Care Services is the first agency. Design every agency setting, permission, notification and cost record for independent subscribing companies from the start. Build and prove the workflow in TEST before seeking approval for live texting.

### Positions and responsibilities

| Position | Can see and do | Scope |
|---|---|---|
| Agency owner or authorized agency admin | Configure city coverage, office contacts, escalation hours, notification preferences and limits. View agency usage and review audit history. | Own agency only, subject to existing permissions. |
| Scheduler or office coordinator | Create shifts, post or unpost, enter call-outs received by phone, distinguish caregiver call-out from client cancellation, review requests, confirm a caregiver, and handle escalations. | Assigned offices or existing agency-wide authority. |
| On-call office contact | Receives urgent alerts after hours and routes coverage manually if needed. | Being listed as an alert recipient grants no new Ogevia permissions. |
| Assigned caregiver | Sees assigned shift through existing access, reports a call-out, receives their own receipt or relevant schedule change. | Own assignment and authorized details. |
| Eligible backup caregiver | Sees privacy-limited posted openings by service city, chooses a shift, requests or withdraws it, and sees the outcome. | Own agency membership, eligibility and requests only. |
| Client or family | Client cancellation follows the existing authorized workflow. A provider or staff member records it if that is how the agency currently operates. | No access to the caregiver board or other requesters. |
| Ogevia worker | Rechecks eligibility and posting state, sends or suppresses SMS, records outcomes and escalates unresolved coverage. | Tenant-scoped service access. Cannot approve an assignment. |
| Ogevia platform operator | Maintains feature entitlements, provider setup and diagnostics through established support roles. | Least privilege. Agency consent, permissions and sender isolation still apply. |

### Where the feature lives

- **Caregiver Home → Open Shifts:** visible entry and requestable count. The list shows city, date, start and end, and the action or status. Open a text link to the relevant posting after sign-in. If it is gone, show its current safe status and a route to other openings.
- **Caregiver My Shifts:** existing confirmed assignments and the caregiver's own request outcomes. “Requested” and “Confirmed” must be visually distinct.
- **Office Schedule → shift details:** show assignment and posting status independently. Provide **Post for Coverage**, **Unpost**, **Record caregiver call-out**, and the existing client-cancellation action as appropriate. Show what the selected action will do before staff submits it.
- **Office coverage queue:** show service city, shift time, office, urgency, posting state, request count, contact and delivery summary, and escalation reason. Show eligible requests in submission order, with earliest eligible preselected. Staff confirms explicitly and records a reason if skipping an eligible earlier request. If it becomes ineligible, surface the reason and the next eligible candidate for review.
- **Agency settings:** approved coverage cities per caregiver, office and on-call contacts, recruitment quiet hours and escalation settings, agency brand and SMS setup, consent and usage. Use existing routes and permissions wherever possible.

### State model and examples

Keep three separate layers: **shift** (assigned, needs coverage, cancelled, or existing terminal state), **coverage posting** (unposted, posted, closed or expired, with round ID), and **request** (pending, withdrawn, declined, invalidated, confirmed or closed because filled). Delivery status belongs to a notification record. Sending or delivering a text must never change assignment state.

1. **Winchester opening managed by Temecula:** staff saves and posts an unassigned shift. A qualified backup approved for Winchester sees it and, if opted in, receives the text. A caregiver covering only Temecula sees neither.
2. **Caregiver calls out by phone:** office records the call-out for the affected occurrence. The same shift automatically posts, retaining authorization and reservation. Office receives the call-out notice, original caregiver gets their own receipt if opted in, and eligible backups receive recruitment SMS when within the window. Other occurrences keep their assignments.
3. **Two people request the same shift:** both see pending. Office confirms one after a fresh eligibility check. The approved caregiver gets confirmation, the other sees Filled in-app, and any unsent recruitment jobs stop.
4. **The replacement calls out:** the same shift reopens in a new coverage round. Previously notified caregivers can be contacted once in the new round if they still qualify. Competing requests from the prior round require fresh confirmation.
5. **Client cancels after an alert was sent:** the posting closes, unsent recruitment and obsolete approval texts stop, and the assigned caregiver receives the cancellation notice if opted in. A link from the earlier alert shows the opening is unavailable.
6. **No qualified recipient or SMS is unavailable:** the office gets a specific action item. A valid posting remains on the board for eligible caregivers, and authorized staff can arrange coverage.
7. **Agency B uses the same caregiver phone as Agency A:** each message uses the correct agency name, sender, consent and quota. The link returns to the correct agency. Disabling Agency A's SMS does not affect Agency B.

### Starting points

- Repository: [CarelikGlobal](https://github.com/socalcaresservices/CarelikGlobal).
- The AWS implementation previously inspected put open pickups under **My shifts** in `apps/web/src/aws/schedule-page.tsx`. It used `GET /v1/open-shifts`, `POST /v1/shifts/{shiftId}/pickup`, and a withdrawal endpoint. The existing database rules are introduced in migrations 0051 and 0063. Read later migrations for overrides.
- The previously reviewed list showed a client code and scoped pickup to caregivers already assigned to the client and service. Change those behaviors for this board while preserving applicable entitlement, readiness, scheduling and office controls.
- [Draft PR #121](https://github.com/socalcaresservices/CarelikGlobal/pull/121) adds manual copy-and-text. Treat it as reference. Automatic SMS from Ogevia is the requested feature.
- Confirm repository findings separately from what is deployed. Microsoft Forms may remain available during rollout.

### Scheduling horizon

- Operating default: plan fixed client schedules two months ahead on a rolling basis. A third month is appropriate when caregiver availability and service authorizations are confirmed. Enter variable or on-call dates as the family confirms them. Use the existing recurrence workflow and preserve exceptions, month-specific authorization accounting, and series edits. This is scheduling guidance, not a new hard limit or automatic series extension.
- Separate the schedule horizon from the SMS window. Use 14 calendar days ahead in the agency timezone as the initial automatic alert window. Posted shifts farther out remain on the board and become SMS-eligible when they enter the window. Update or replace the old fixed 14-day list filter for board visibility without removing the 14-day alert rule. Sort upcoming openings by start time and paginate as needed.

### Posting and status

| Event | Schedule and board behavior | Automatic SMS |
|---|---|---|
| Staff adds or edits an unassigned shift | Save it as Needs Coverage. Offer an explicit **Post for Coverage** action. Show staff whether it is posted. | On posting, send inside the alert window. Otherwise defer. |
| An assigned caregiver cancels or calls out and care is still needed | Remove the active assignment via the existing call-out workflow. Preserve the same shift record, date, start/end, authorization and reservation. Preserve former caregiver and reason in coverage history. Auto-post immediately. | Send inside the window. Otherwise defer. Exclude the caregiver who called out. |
| Staff explicitly unposts an opening | Remove it from the board and suppress waiting alerts. Resolve pending requests visibly and keep audit history. | Suppress unsent messages. |
| Client cancels care | Close using the existing client cancellation workflow and release reserved minutes according to existing rules. Remove the posting and close pending requests. | Suppress unsent messages. |
| Staff approves a request or assigns someone directly | Close the posting, resolve competing requests, and record the assignment. | Suppress unsent coverage texts. |
| Shift starts, expires, becomes invalid, or care has already begun | Remove it from self-service and surface any outstanding coverage issue to staff. | Suppress unsent messages. |

- Model Needs Coverage as a scheduling state and posted as a distinct visibility state. For preexisting unfilled shifts, preserve their coverage state and give the office an explicit way to review and post them. Avoid sending a batch of historical alerts during migration or activation.
- Editing the same shift does not trigger a second text. Recheck updated facts before dispatch. If city, date or time changes after requests are submitted, invalidate stale requests for office review and require fresh caregiver agreement before assignment. See the coverage round rules below.

### Caregiver home and Open Shifts

- Add a visible **Open Shifts** entry with the count of currently requestable openings. Make the board mobile-friendly, with loading, empty, and error states. Caregivers can request more than one shift if each is individually eligible. Pending requests do not reserve work hours or guarantee assignment. Display **Requested** and allow withdrawal through the existing workflow.
- Display only the client's **service city**, local date, start time and end time, plus the request action/status. Show the local end date too if a shift crosses midnight. Match using the actual service location for the shift, across clients. Use an existing approved city-coverage record if present. Otherwise add agency-managed coverage cities per caregiver. Use a canonical city key that distinguishes cities with identical names. If location or coverage is missing, keep the shift in the staff queue for correction and suppress exposure and texts. The assigned office manages the shift and approvals. Its street address, county and city do not determine caregiver matching.
- Use an opaque posting or shift reference for authorized actions. The caregiver-facing board API, errors, payloads and SMS must omit client name, ID, code, exact address, care details and other caregivers' information. A copied URL requires sign-in and fresh eligibility checks. Client details are available only through the normal assigned-caregiver permissions after approval.

### Eligibility and office approval

- Candidate must be active, in the same agency, approved to work in the service city, qualified for the service and applicable client-specific requirements, available for the entire shift, and medically/compliance cleared under existing readiness rules. Reuse existing checks for onboarding, background clearance, CPR/TB, staff holds, overlapping assignments, service approvals, and the 8-hour daily / 40-hour weekly limits. Use existing agency time, work-week, and cross-midnight accounting.
- Allow qualified backups who have never served the client to request a posted shift. Review why the legacy client-specific assignment gate exists and preserve genuine client restrictions, exclusions, or required training. Keep regular client records private. Do any assignment prerequisite changes through the existing office-authorized workflow as part of confirmation, with audit history.
- Check eligibility when listing/counting, submitting a request, selecting SMS recipients, sending, and confirming. Derive the actor and agency from authenticated context. Recheck authorization capacity and reservation at confirmation. If two openings overlap or exceed hours together, office approval of one must block approval of the other when applicable. Use existing transactional locking or equivalent concurrency protection so exactly one caregiver can be confirmed for the same shift. Preserve authorization totals and release/reserve time through existing routines only.
- Office sees all openings within its existing scope, current posting state, pending requests, why a request is blocked, and SMS status. Office approval assigns the caregiver. Caregiver requests alone never assign the shift.
- **Request order (owner decision, Option A — first come, office approves):** List requests in the order they were submitted, using a server timestamp. Pre-select the earliest request that currently passes every eligibility check and show it first, so the office can approve it in one action. If that request fails a recheck at approval (for example, hours, hold, overlap or authorization), show why and move the next eligible request in submission order to the top. The office may still choose a different eligible requester; record who was approved, the order position, and the reason when the earliest eligible request was skipped. No request is assigned automatically.

### Automatic SMS

- Use AWS End User Messaging SMS and a verified U.S. toll-free number, subject to account/region support. Validate rate, sender verification, production access and delivery status handling before enabling live messages. Reuse existing AWS worker/scheduler patterns and keep the transport mockable in TEST.
- Trigger on a new posting inside 14 days or on entry into the 14-day window. Recheck the live shift, recipient eligibility, active phone number and SMS opt-in just before sending. Use explicit opt-in with consent timestamp/source and enforce opt-out, including STOP handling. If no qualified opted-in caregivers exist, keep the board posting available and show staff that no texts went out.
- Example: “SoCal Care Services: Cover shift in Winchester Fri Nov 27, 1:30-5:00 PM. Request in Ogevia: https://app.ogevia.com/my-shifts”. Use a signed-in board link and the existing tenant/environment origin. Keep content short and plain text. Check segment count for actual messages and include provider-required instructions where applicable.
- Persist notification jobs transactionally with posting changes, or use an equivalent reliable mechanism. Enforce one recruitment SMS per tenant, coverage round and eligible caregiver. Edits, retries and unpost/repost reuse the same round. Deduplicate shared phone numbers where possible. Atomically claim jobs, apply bounded retries for confirmed transient failures, and reconcile ambiguous provider outcomes before retrying. Track queued, accepted, delivered, failed and suppressed states as available. A provider failure leaves the opening on the board.
- Record who/what posted, date and time, eligibility decisions or suppression reason, message status, provider message ID, and cost/segment counts where available. Restrict access to recipient data and mask phone numbers in logs. Give the office an SMS enable switch and a configurable monthly send limit. Track usage against it and surface blocked sends. TEST uses a mock or explicitly allowlisted numbers. Keep production sending disabled until approved.

### Cancellation, assignment and office notifications

Addendum, 2026-11-22. Reuse any notification mechanism already in the repository before adding one. Every notification below is sent through the same reliable job, dedupe, retry, masking and audit rules as coverage alerts, and every caregiver text still requires the caregiver's SMS opt-in; in-app messages are always shown.

| Event | Recipient | Channel | Timing |
|---|---|---|---|
| Caregiver cancels in Ogevia | That caregiver | On-screen confirmation plus one text | Immediately |
| | Office notification contacts | Office queue alert plus text and/or email per contact setting | Immediately |
| Caregiver cancels by phone and staff enter it | Same as above | Same as above | When entered |
| Client cancels (entered by staff) | Assigned caregiver | Text plus in-app message: shift cancelled, do not go | Immediately |
| | Office notification contacts | Office queue alert | Immediately |
| Office approves a request | Approved caregiver only | Text plus in-app message | Immediately |
| | Requesters not selected | In-app status **Filled** only; **no text** | Immediately |
| Opening still unfilled near start | Office notification contacts | Urgent alert | Default: 24 hours before start |

- Example texts (no client name, ID, code, address or care details; details appear only after sign-in through normal assigned-caregiver access):
  - Caregiver who cancelled: “SoCal Care Services: Your cancellation for Fri Nov 27, 1:30-5:00 PM (Winchester) was received. The office has been notified.”
  - Approved caregiver: “SoCal Care Services: You're confirmed for Fri Nov 27, 1:30-5:00 PM in Winchester. See details in Ogevia: [signed-in link]”
  - Client cancellation: “SoCal Care Services: Your shift Fri Nov 27, 1:30-5:00 PM has been cancelled by the client. You don't need to go.”
  - Office: “Ogevia: Caregiver cancelled Fri Nov 27, 1:30-5:00 PM, Winchester. Reposted for coverage. Review: [signed-in link]”
- Office alerts are not limited by the 14-day coverage window: every cancellation alerts the office immediately, whatever the shift date.
- Defaults pending owner confirmation:
  1. Office notification contacts are an agency-managed list in Ogevia; each contact chooses text, email or both.
  2. Outside office hours, office alerts also go to one designated on-call phone number.
  3. A cancellation is flagged **Urgent** when the shift starts within 48 hours; an unfilled opening escalates 24 hours before start.
- Count these texts against the same monthly send limit and SMS enable switch. A blocked or failed office or caregiver notification is shown in the office queue; it never blocks the cancellation, posting or approval itself.

### Running cost

- Reuse the current AWS app and database. Meter incremental worker, queue/scheduler and logging charges separately from the existing hosting baseline.
- AWS lists a **$2/month U.S. toll-free number lease** plus SMS usage and carrier fees. At an illustrative **$0.03 per one-segment outbound text**, 50 texts cost about **$3.50/month total**, 100 cost **$5**, and 300 cost **$11**, before other usage or applicable charges. These figures are estimates, not a provider quote or the agency's actual bill. Confirm the rate and setup charges before provisioning. [AWS End User Messaging pricing](https://aws.amazon.com/end-user-messaging/pricing/).
- Budget example: 20 openings per month × 5 eligible recipients each = 100 texts. Report actual number rental, outbound segment charges, inbound/opt-out charges if any, and related infrastructure usage in AWS billing after rollout. Keep setup of paid resources separate from coding and TEST review.
- Notification addendum estimate: about 20 cancellations per month generating 3–4 texts each (cancelling caregiver, office contacts, approved caregiver) adds roughly 60–80 texts, about $2–3/month at the same illustrative rate. Estimate only.

### TEST acceptance criteria

1. A Winchester shift managed by a Temecula office is visible to qualified caregivers covering Winchester, including an approved backup who has not served the client. A caregiver covering only Temecula cannot list or request it, including by direct API call. Another agency cannot access it.
2. A caregiver can request an eligible shift and withdraw it. An overlapping shift, unavailable time, compliance hold, service restriction, work-hour limit or authorization problem blocks the appropriate request or approval with a useful message. A change after request is caught on approval.
3. Saving an unassigned shift leaves it off the board until staff posts it. A caregiver call-out automatically posts the same record, preserving its time and reservation. Client cancellation closes it and releases reserved time under existing rules.
4. A shift 20 days out is posted now and alerts once upon entering the 14-day window, provided it is still open. A posting within the window alerts promptly. A shift filled, cancelled or unposted before dispatch sends no text. Verify agency-time boundaries and a cross-midnight shift.
5. Opted-out, unavailable, ineligible and called-out caregivers receive zero recruitment texts. An opted-in caregiver who called out still receives their own confirmation. A provider timeout, duplicate event, repeated worker run or staff edit does not cause duplicate alerts. Test late opt-out, missing city, spend limit and a provider failure.
6. Simultaneous approvals yield one assignment, no duplicate reservation, and competing requests are resolved. Confirm an approved caregiver receives only their normal client access. Inspect caregiver API responses, errors, logs and SMS to verify client details are omitted from the board and alert.
7. Verify the mobile home entry, count, empty state, request status and office queue. Confirm an opened SMS link after sign-in lands on the correct caregiver board and displays current state.
8. With three eligible requests, the earliest is pre-selected; if it fails a recheck at approval, the next in submission order moves up with the reason shown. No request assigns the shift without office approval, and a skipped earliest request is recorded with a reason.
9. A caregiver cancellation, whether self-service or entered by staff, immediately confirms to that caregiver and alerts office contacts, including for a shift beyond 14 days and outside office hours (on-call number). A client cancellation immediately notifies the assigned caregiver.
10. On approval, only the approved caregiver receives a text; non-selected requesters receive zero texts and see **Filled**. Opted-out caregivers receive in-app messages only. Duplicate events or retries send no repeat notification.

### Coverage exceptions and proposed operating defaults

- When a confirmed caregiver, including a replacement, calls out and care is still needed, start a new coverage round for the same shift. Close the prior round and suppress its outstanding jobs. Preserve the reservation and request history. Previously contacted caregivers may receive one new text if still eligible. Exclude the person who just called out. Require a fresh request or staff reconfirmation.
- Maintain one office coverage item per active round. Flag immediately if nobody can be reached or all sends fail, and escalate if unfilled 24 hours before start. Escalate immediately if posted within 24 hours. Distinguish pending requests from zero requests so staff know whether to review or recruit. If service is about to start or a no-show occurs after the self-service cutoff, route to the office/on-call contact for manual recovery.
- Proposed recruitment quiet hours are 9 PM–7 AM in the agency timezone. Recheck before sending delayed texts. Route urgent overnight gaps to the on-call office contact and leave an automatic caregiver quiet-hours bypass disabled by default. Direct assignment and cancellation notices retain their immediate timing.
- If city, date or time changes, invalidate stale requests and notify affected requesters in-app. A link from a text already sent must show current details or “This opening is no longer available.” If an assigned shift changes, use the existing schedule-change and acknowledgement flow and verify the assigned caregiver is notified. Suppress pending confirmations if the assignment is cancelled before dispatch.
- Show request received, withdrawn, declined, filled, changed, closed and confirmed in-app. Route unsuccessful delivery, provider outcome unknown, missing consent, exhausted quota and disabled sender separately to the office view. Keep one active escalation item rather than repeating identical notifications.

### Recommended alert wording

Use the registered agency's display name in the message and Ogevia as the app. Render agency-local dates and times, both dates for overnight shifts, and an authenticated link that resumes its destination after sign-in. Exclude client names, codes, addresses and care details. Check the final SMS segment count and apply provider-approved opt-out wording.

| Event | Suggested wording |
|---|---|
| Open shift SMS | {Agency}: Open shift in {City}, {Date}, {Start}-{End}. Request in Ogevia: {Link} |
| Call-out receipt SMS | {Agency}: We received your call-out for {Date}, {Start}-{End}. The office was notified. |
| Assignment confirmation SMS | {Agency}: You're confirmed for {Date}, {Start}-{End} in {City}. Details in Ogevia: {Link} |
| Client cancellation SMS | {Agency}: Your shift on {Date}, {Start}-{End} is cancelled. Please do not go. Ogevia: {Link} |
| Assigned shift changed | {Agency}: Your shift on {Date} changed. Open Ogevia to review: {Link} |
| Office escalation | {Agency}: Coverage needed in {City}, {Date}, {Start}-{End}. Review in Ogevia: {Link} |
| In-app request receipt | Request sent. Wait for the office to confirm before working this shift. |
| In-app changed or closed | This shift changed. Review the new details and request it again. / This opening is no longer available. |

### Subscription and agency isolation

- Pilot with SoCal Care Services and store branding, timezone, office routes, coverage cities, consent, templates, sender and usage per agency. A caregiver employed by multiple agencies has separate memberships and sender-specific consent. Enforce tenant boundaries on board, requests, worker jobs, callback attribution, logs and exports.
- Configure Open Shifts and SMS as separate tenant capabilities. Wire SMS to future subscription entitlements without requiring a billing system for the pilot. If SMS is suspended, unverified, disabled or over quota, keep the shift board, office actions and in-app notices available. Recheck entitlement at send time. Reactivation must not trigger a historical blast.
- Plan one verified toll-free sender per subscribing business that enables SMS. AWS associates a toll-free number with a single business. Require agency-specific identity, website, opt-in evidence, message samples, and applicable public privacy and terms links. No fallback through another company's sender. [AWS toll-free registration](https://docs.aws.amazon.com/end-user-messaging/latest/userguide/nx-reg-type-tollfree.html).
- Meter number rental, outbound segments, inbound charges where applicable, and provider failures per agency and billing period. Enforce quota atomically and surface usage to agency admins. Model operating costs separately from subscription prices. Keep the existing pricing illustrations as estimates.

### Additional TEST cases

- Verify that a replacement call-out triggers a fresh round, ordinary edits do not, and duplicate events do not repeat an SMS within the same round.
- Test zero eligible recipients, complete delivery failure, 24-hour escalation, an overnight urgent opening, and a shift filled before a delayed send.
- Verify changed requests, cancellation after approval, stale links, full outcome wording, and agency-local overnight dates.
- Test two agencies sharing a caregiver or phone number. Verify separate senders, branding, consent, links, quotas and callback attribution. Suspend SMS for one agency and verify both boards still work and the other agency can still send.

### Build sequence for Claude Code

1. Inspect the checkout, migrations, current permission model, existing route and worker conventions, and environment mapping. Record which baseline is confirmed from code and which behavior is verified in TEST or production. Identify what can be reused and any conflict between this brief and a live authorization or release rule.
2. Implement additive tenant-scoped data and server transitions first. Write posting/call-out and durable notification intent atomically. Reuse row locks or equivalent transactional protection for confirmation and authorization accounting. Use tenant + round + message purpose + recipient to deduplicate notification delivery. Reconcile uncertain provider outcomes before attempting another send.
3. Build the caregiver board, office queue and agency settings using existing navigation and permissions. Exercise mobile UI and the authenticated return from SMS before enabling a real transport.
4. Implement notification rendering, queue scheduling, cutoff and escalation, per-tenant preference and quota enforcement, verified sender mapping, and provider callback handling. Recheck eligibility, current round, link target, consent, tenant entitlement and quota at dispatch. Keep a mock transport for TEST and avoid a bulk send when toggling the feature on.
5. Prove each scenario using API/database and browser tests, then provide a draft PR, rollback notes, and a short operator walkthrough. Include an explicit fail-closed test for foreign tenant IDs and a test for a cancelled posting whose delayed text is already queued. List any AWS registration or production activation dependencies separately.

### Owner review before production

Use the documented proposed 14-day recruitment window, urgent flag within 48 hours, 24-hour unfilled escalation, and 9 PM–7 AM quiet hours as configurable TEST defaults. The office needs to verify on-call routing and messaging templates, and approve live sender setup, monthly send limit and production activation. The two-month planning horizon is guidance for fixed schedules. The feature must not require a paid SMS plan for an agency to use the board and office approval workflow.

### Implementation handoff

Deliver a draft PR with the existing behavior verified, migration and rollback plan, affected UI/API/worker paths, TEST evidence, cost assumptions, and any unresolved deployment or provider dependencies. Run the applicable repository checks, database tests and browser scenarios. Report precisely which parts ran in TEST and which require owner approval or live validation.


