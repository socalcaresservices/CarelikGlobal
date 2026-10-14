# Proposal 3: document reminders (decision D4)

**Status: PROPOSED. Nothing built, nothing provisioned.** Approved for design: in-app reminders at configurable intervals including 90, 30, 7 and 0 days, caregiver and designated administrator recipients, notification history, duplicate prevention. **No AWS service is provisioned and no email or SMS is implemented** until you approve the architecture, cost estimate and security assessment in part B.

## A. In-app reminders (no new AWS service)

### What exists (VERIFIED)
Issue and expiry dates, per-type "no expiry", review state separate from currency, reminder days per agency and per type (default 90, 60, 30, 14, 7), the Documents page, and Home counts. The days only change what screens show. The rule that validates the days accepts 1 to 365 only, so **0 (the expiry day) is refused today** (`valid_reminder_days`, 0033). Nothing records that a reminder was shown.

### Design
1. **Intervals:** allow 0 in `valid_reminder_days` (migration). Keep 1 to 8 distinct values, per agency with per-type override. Proposed default set: 90, 30, 7, 0 (your list); existing agencies keep their current set until they change it.
2. **Recipients (new setting, per agency):** the document's own caregiver (if they have a sign-in) and "designated administrative recipients": a chosen list of Care Team managers or the Administrator, picked by person, defaulting to people holding `documents.manage`. A caregiver without a sign-in has no in-app inbox; the office row says so.
3. **Notifications table** (`document_notifications`, organization-scoped, row-level security, append-only except `read_at`): document, expiry date, threshold days, recipient, due date, created, read. **Unique key (document, expiry date, threshold, recipient)** prevents duplicates; a renewed document has a new expiry date and therefore a new set.
4. **How they are created without a scheduler:** when a recipient opens the app, a server function idempotently inserts any notification that is now due for them (`insert ... on conflict do nothing`). Only the **latest crossed threshold** per document and recipient is created, so someone returning after a month is not flooded. No scheduled job, no new infrastructure, no recurring cost. **Limit:** nobody is reminded on a day when nobody opens the app; they see it at next sign-in, with "due since" wording.
5. **History:** the table is the history (who, which document, which threshold, when created, when read). A recipient's list shows unread first; the office can see what was sent to whom.
6. **Screens:** a Reminders block on Home for each recipient (replaces the current count-only reminder), a small count in the header, a history list under Documents. Copy follows the glossary.
7. **Messages contain no client information.** They name the document type and the caregiver only inside the app, where access is already controlled.

### Tests (written first)
Each threshold creates exactly one notification per recipient; reopening or a retry creates none; a returning user gets only the latest threshold; renewal creates a new set; a document type without expiry creates none; threshold 0 on the expiry day; recipients limited to the configured people; organization isolation (cross-tenant read and write refused); history is append-only; concurrent opens by two administrators create one row each, not two.

### Classes and dependencies
Database: new table, new settings columns, one function change (0 allowed), two functions. API: three routes. Web: Home block, header count, history list. No AWS change. Needs your approval of the recipient rule and the "latest threshold only" rule.

## B. Email and SMS assessment (for your decision; not part of A)

### Options
| | Email | SMS |
|---|---|---|
| Services (proposed) | Amazon SES for sending; EventBridge Scheduler plus one Lambda for the daily run; the existing RDS | Amazon SNS or AWS End User Messaging; same scheduler and Lambda |
| New AWS resources | SES verified domain and DKIM records, one scheduled rule, one function, alarms | Registered sender (10DLC or toll-free), opt-in and opt-out handling, same scheduler and function |
| Fixed monthly cost | none for SES itself (VERIFIED from AWS's published pricing summary, below); scheduler and Lambda at this volume are expected to be near zero (NOT VERIFIED) | carrier registration fees and a monthly sender fee (NOT VERIFIED; I could not retrieve current AWS SMS pricing) |
| Variable cost | **$0.10 per 1,000 emails** on the pay-as-you-go option; plans with a monthly fee also exist (source: AWS SES pricing page as summarized by a web search on 2026-10-14; I could not open the page itself, so confirm it before relying on it) | per-message price: NOT VERIFIED |
| Volume example (illustrative arithmetic, not your data) | 100 caregivers x 3 expiring documents x 4 reminders a year x 2 recipients = 2,400 emails a year, about $0.24 a year at $0.10 per 1,000 | same volume x a per-message price I have not verified |
| Approval needed under `CLAUDE.md` | yes: a new AWS service, a DNS change (yellow), and a cost estimate | yes, and a carrier registration |

### Security assessment (open items stated, not assumed)
- **Content:** a CPR or TB document type and its dates are sensitive employment-health information. Messages should say only "a required document is due" and link to sign-in. No document type, no result, no client information, no names beyond a first name.
- **HIPAA / BAA:** whether SES or SMS is covered by your AWS Business Associate Addendum for this content is **NOT VERIFIED**; check the AWS HIPAA eligible-services list and your signed BAA before any message is sent. CLAUDE.md requires the BAA gate before production ePHI.
- **Deliverability and spoofing:** requires a verified sending domain with SPF, DKIM and DMARC records (a DNS change).
- **Opt-out and preferences:** SMS needs a documented opt-in and opt-out; email needs a monitored sender address.
- **Duplicates and failure:** reuse the notification table (part A): a send is recorded once per unique key; the sender marks success or failure and retries safely; bounces and complaints are monitored.
- **Logging:** no addresses, phone numbers or message bodies in logs.
- **Access:** the sender function has least-privilege permission for the one sending identity and read access only to the notification table.

### Recommendation
Build part A first. It delivers every behavior you listed in-app at no recurring cost. Decide email separately after you confirm the BAA position and the sending domain; I would not add SMS until a clear need and the carrier-registration effort are accepted.
