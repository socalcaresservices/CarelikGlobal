# Ogevia UX change list

Recorded: 3 October 2026, Pacific time.
Status: requirements recorded; interface changes not implemented.
Scope: improve the existing Ogevia interface, starting with the AWS TEST pilot.
Suggested repository home when implementing: docs/product/OGEVIA_UX_CHANGE_LIST.md.

## Owner requirements

1. Use dropdowns for groups of choices instead of displaying every option in one row. In particular, replace the row of date/time-range choices (All time, This week, Last 14 days, This month, This quarter, This year, Custom) with one labelled Date range dropdown. Show From and To fields when Custom is selected. Preserve the available ranges and their meaning.
2. Display the action label **NEEDS ATTENTION** in bold, uppercase, red text. Make it a visible, tappable entry to exceptions, rather than burying it in the report selector. Retain a text label so colour is not the only signal; use accessible contrast. Show a count if the data supports one.
3. Reduce visual clutter. Put optional report filters in a collapsible Filter section, particularly on phones. Keep the selected filters understandable and easy to reset.
4. Show **MANAGER VIEW** prominently in the manager header, together with the manager’s actual display name (for example, Manager: [display name]). Show the account email as secondary information and an easy-to-find Sign out action. Use CAREGIVER VIEW for caregivers. Derive the view label from actual permissions and the name from the signed-in profile; do not invent a name or use the email as the primary name. If the name is missing, make the fallback explicit and allow it to be completed.

## Proposed layout to review before implementation

Manager navigation: Today, Visits, Schedule, Reports. Put infrequent settings in a secondary area. Today should surface active visits and NEEDS ATTENTION.

Caregiver home: next visit, assigned client, service and scheduled time; primary workflow Start visit → End visit → Confirm. Provide My visits and Sign out. Do not show manager controls to caregivers.

Keep common actions visible. Dropdowns are for secondary choices; do not hide Start visit, End visit, Confirm or NEEDS ATTENTION inside dropdowns.

## Observations from owner testing

- Owner initially could not distinguish the manager view from the caregiver view.
- Report Center is a heading, not a tappable navigation action.
- Selecting the already-selected Operations overview appeared to do nothing and caused confusion.
- Exceptions needing attention is inside the report dropdown.
- The visible date-range button row and expanded filters create clutter.
- The Exceptions screenshot showed no visits needing attention with all filters and All time selected. This is an empty-state observation, not proof of the missed-Time-Out workflow.

## Visit records navigation issue (owner screenshot, 3 October 2026)

- Clicking Visit records opens Report Center with Operations overview selected. The actual Visit details view is buried in an eight-option report dropdown. The destination and selected navigation label do not match the owner’s task.
- Requirement: Visit records should open the visit list directly, with recent visits first and clear client, caregiver, service, status, Time In, Time Out and duration. Provide Today as a readily available date choice.
- Keep aggregate reports under Reports. Keep Visit details reachable from the list. Do not require selecting a report to locate a completed visit.
- Move Copy staff sign-in link and Print / Save as PDF into secondary actions so they do not dominate the initial view.
- Use short instructions and collapsed optional filters; retain advanced reporting options.

## Acceptance checks

- Manager can find NEEDS ATTENTION without navigating a report dropdown.
- Date range uses one dropdown; Custom exposes valid From/To controls.
- Phone layout at approximately 390 px has no horizontal scrolling or clipped controls; also check desktop.
- MANAGER VIEW and the signed-in manager’s actual display name are visible and correct; account and Sign out are easy to find.
- Filters, reports and date calculations retain their existing behaviour.
- Visit start/end, confirmations, authorisation limits, audit history and permissions still work after the interface changes.
- Test keyboard access, visible focus, labels and red-label contrast.

## Implementation tracking

All items are pending. Record the implementing commit/PR, deployment environment and owner acceptance for each completed item. Update this same change list as more feedback arrives. Do not treat a saved requirement as an implemented or deployed change.

## Visit list column review (owner test, 3 October 2026)

Observed screenshot: one Signed visit; Time 18:09–18:12; Worked 2 min; Billable 2 min; Authorised 10 hr; Used MTD 2 min; Remaining 9 hr 58 min. Table horizontally scrolled; left-hand identity columns not visible in this screenshot. Owner reports long visit reference and apparently duplicated client text; exact rendering needs inspection before declaring a data duplication bug.

Owner requirements and proposed implementation:
- Put Status near the client and date, never beyond a horizontal scroll on phones. Main summary: client name, caregiver name, date, status, Time In–Time Out and worked/billable duration. Use compact cards on phones and a table on desktop.
- Retain the Columns chooser, with sensible defaults and saved user preferences. Avoid showing every optional field by default.
- Use a short human-readable Visit ID as secondary text, with full technical identifier available in details/copy for support. Preserve underlying identifiers and ensure displayed references remain unique. Do not merely truncate a UUID and assume uniqueness.
- Display client name once, with the client code secondary. Inspect the reported apparent duplication; distinguish duplicate presentation from duplicate database records.
- Rename Used MTD to Used this month, Authorised to Monthly limit only when it truly represents a monthly limit, and Remaining to Hours left (with units shown). Put these authorisation fields together under an expandable Hours balance section rather than spreading them across the visit list.
- For this test, no scheduled shift was shown before start; Not linked to a scheduled shift is consistent with the observed unscheduled workflow. Do not fabricate a link. Label clearly as Unscheduled visit and test the scheduled workflow separately.
- Rename Correct to Correct visit. Use View history or Correction history with a clear explanation: audit trail of changes, not an indication that the visit is wrong. Keep original values, editor, time and reason. Do not weaken audit controls.
- Put secondary actions into an Actions dropdown; retain clear primary attention actions when a visit needs intervention.
- Explain Show superseded records as Show replaced records, with help text that original versions are retained after corrections; off by default.
- Verify duration display: 18:09–18:12 is displayed as 2 minutes worked/billable. Minute-only timestamps do not reveal seconds or rounding, so this screenshot does not establish an error. Inspect the actual timestamps and billing rule, and explain any rounding without inventing a policy.

Acceptance: a manager can identify who worked, when, duration and signature/status without horizontal scrolling; optional detail remains available; scheduled and unscheduled visits are distinguishable; column preferences continue working.

## Printable client service calendar (owner requirement, 3 October 2026)

- Add Print calendar / Save calendar as PDF directly beside the Calendar month selector. CSV remains optional; it is a data table and does not satisfy calendar printing.
- Output a real monthly grid with weekdays and dated day cells, one client per calendar. Header: agency, client’s full name (client code secondary), month and year.
- Header/footer summary: one separate row per service with service name/code, maximum authorised hours for that month, hours worked that month and hours remaining. Never combine service allowances or totals. Handle multiple authorisations without duplicating the allowance; document the actual authorised limit/period rather than guessing.
- Each worked date lists actual hours separately by service. Sum hours across all caregivers who worked for that client on that date for that service. Do not show caregiver names in this client calendar. Example: caregiver A works 2 hours of respite and caregiver B works 3 hours of respite on the same date → Respite 5 hr; a separate personal-care visit remains a separate line.
- A caregiver filter must not silently turn this client calendar into a partial client total. Default/all-client calendar sums all caregivers; explicitly identify any intentionally filtered export or require clearing that filter before the full calendar print.
- Use real worked durations, not scheduled hours. Clearly distinguish worked from confirmed/billable amounts; never relabel unconfirmed work as billable. Keep replaced/original corrections from being double-counted and explain which visit states are included.
- The print/PDF must contain only the calendar and its client/service summary; exclude navigation, expanded filters, buttons and technical IDs. Prefer landscape Letter with readable text and no clipped day cells; allow additional pages if needed rather than shrinking to unreadability. Preserve a clean calendar grid in the exported PDF.
- Show zero worked hours for authorised services with no work that month. Include month/year and units on totals. Keep exact minute arithmetic internally and consistent display rounding.

Acceptance: full client name appears; each service has its own authorised maximum and worked/remaining totals; same-day same-service work by two or more caregivers is summed once without names; different services stay separate; daily totals reconcile to monthly service totals; printed preview is a legible calendar rather than a CSV table.

## Owner and manager permissions (owner decision, 3 October 2026)

Owner: can see all agency information, including a bird’s-eye utilisation dashboard and its financial impact. Include authorised, scheduled, worked, confirmed/billable and unused hours by client/service and period. Translate these into revenue earned/estimated, potential revenue from unused authorised hours, caregiver/payroll costs and margin where supported by actual rates and costs. Clearly distinguish actual losses from potential revenue not realised. Missing rates/costs must show unavailable, not fabricated values or zero profit. Owner retains full financial visibility. Latest owner decision: Managers may also approve billing; see the consolidated brief below.

Manager/Supervisor: can see all operational information within their agency, including clients, caregivers, service authorisations, schedules, worked hours, remaining hours, visit exceptions, confirmations and corrections. Managers may approve billing under the latest owner decision. Give them the billing information needed to review that approval, while keeping wages/payroll costs, agency profitability, margins and broader owner finances restricted. Supervisor approval is not automatically granted by the Manager decision. Operational hours and visit-documentation review remain available.

Enforce the split in backend/API/database permissions as well as navigation, pages, exports and dashboards. Manager-facing responses must not expose hidden financial fields. Preserve tenant isolation and test Owner, Manager/Supervisor, Scheduler, Caregiver and another agency. Exact Scheduler permissions require a separately confirmed definition.

Current evidence: Claude reports local synthetic database tests passing; this is not live verification of owner access. No owner login has yet been independently confirmed in AWS TEST. Any role change should use the existing verified identity where appropriate, record before/after in the audit trail atomically, and have an exact rollback. Owner access does not establish that every financial dashboard is implemented.


## Consolidated refinement and feature recovery brief — latest owner direction

Recorded 3 October 2026, Pacific. This section supersedes earlier statements prohibiting manager billing approval. This is an implementation brief, not evidence that these changes have shipped.

### Decision and product identity

Managers may approve billing. Approval must be an explicit human action with approver, timestamp, reason where applicable, and audit history. Provide only the billing fields required for that task; do not grant payroll, costs, agency profit or broad financial administration implicitly. Owner sees all agency operations and finances. Preserve separate scheduled, worked, confirmed, billable, Billing Ready, Billing Approved and Submitted/Billed states. Approval is not automatic payer submission.

Keep Ogevia, CareScore, AskCare, Service Verification, Care Requests and established module names. Do not introduce wholesale renaming to simplify navigation. Plain-language field labels may be improved as specified above. Maintain existing routes or safe compatibility redirects; separate public, agency-app and platform-admin navigation. Subscription billing must be distinguishable from client service billing.

Ogevia connects authorisations, scheduling, service verification, reconciliation and billing readiness. Initial use is respite and personal assistance; agencies can configure their branding and services. Retain existing EVV, payroll and accounting relationships. Do not claim a replacement for those systems or a clinical EHR. The Apple/Epic reference is a design direction: clear hierarchy and thoughtful detail, with a warm non-clinical appearance. It is not a requirement to copy their visual identity or add clinical scope.

### One coordinated implementation programme

1. Inspect the original repository, git history, existing product specifications and current AWS slice. Produce a route/feature inventory with: existing code, AWS support, visible navigation, role permissions, tested status and recovery action. Distinguish absent, inaccessible, not migrated, broken and unverified. Restore existing sound implementations before rebuilding. Do not delete functionality to declutter.
2. Apply one shared design system across public landing, signed-in desktop and mobile. Agency name/logo leads inside its workspace; Ogevia leads on the public product site. Agency configuration supports logo, name and restrained accessible accent colours, with a clear fallback. Show real signed-in name and OWNER VIEW / MANAGER VIEW / CAREGIVER VIEW. Use readable typography, generous spacing, restrained imagery and labelled icons. No wall of controls, technical identifiers or clinical language.
3. Keep primary navigation and frequent actions visible. Group secondary controls under labelled dropdowns, More, filters and details. Preserve established module names. Mobile menu has a labelled Menu button, current section and accessible drawer; it must not depend on hovering or tiny icons. Role-appropriate navigation reaches Clients, Caregivers, Authorisations, Schedule, Service Verification, Visit records, Reports, Care Requests, Matching, CareScore, AskCare and Settings where implemented and permitted. Grouping is acceptable; silently dropping modules is not. No placeholder pages represented as working features.
4. Home shows what needs attention and the next useful action. Manager: active/incomplete visits, uncovered shifts, hours at risk, billing ready for review. Owner: these plus supported utilisation/financial summaries. Caregiver: next assigned visit, current visit, confirmation to finish and availability. Avoid zero-valued metrics when data is unavailable. NEEDS ATTENTION follows the bold red uppercase accessible requirement above.
5. Implement the already recorded visit-list, dropdown/filter and printable service-calendar requirements. Preserve column chooser, correction history and distinct service balances. Scheduled visits must show the true scheduled window alongside actual times; unscheduled visits remain clearly identified and subject to reconciliation. Show recent visits directly from Visit records.
6. Recover the four conceptual caregiver stages: Start, Active, End & Confirm, Submitted. Resume the active visit after interruptions. Preserve authorised hours, overlap controls, server timestamps, supported accessible confirmation/no-signer paths and audit history. Do not add extra required clinical documentation. Inspect current authentication and confirmation implementation before changing it; older design notes must not silently override the deployed Cognito/MFA workflow.
7. Recover authorisations, matching and coverage: calculations stay separate by client, service and authorisation period; matching includes supported city/location, services, recurring availability, weekend availability and date exceptions. Preserve constraints and explain why a candidate qualifies or does not. Call-outs retain the original shift and audit trail while replacing coverage. Do not add GPS/maps or invent matching criteria. Inspect supported recurrence rather than broadening it silently.
8. Preserve CareScore and verify its existing definition, inputs, weighting, explanations, missing-data behaviour, scope and role access against the original implementation. Do not invent a new formula or confuse a score with a clinical judgement. Show supporting evidence and links to the underlying records. If not migrated, identify and implement the necessary AWS dependencies before advertising it as live.
9. Preserve AskCare and verify existing provider, permissions, data access and runtime configuration. Answers must stay within the signed-in user's agency and permissions, show supporting records/date scope and acknowledge missing information. Financial answers follow role permissions. AskCare cannot autonomously approve billing, reconcile exceptions or alter records. No real client data should reach an unapproved AI provider. A static chat box does not count as restored AskCare.
10. Restore the public landing page with a clear explanation of the problem, workflow, benefits, actual features and sign-in/demo actions. Describe saving administrative time, finding visit discrepancies and unused hours, and improving billing readiness without unsupported savings guarantees. Present configurable agency branding/services and the initial respite/PA focus. Use human service-oriented imagery where useful; label pilot/coming-soon features honestly. Do not claim compliance, integrations or AI capability from infrastructure tests alone.

### Delivery and verification

Keep this as one coordinated backlog and reviewable change set; implement in controlled stages rather than one unchecked mass deployment. First role permissions and shared navigation/branding, then operational screens/calendars, then verified recovery of CareScore, Matching and AskCare. Preserve the existing working visit path throughout.

For each feature record commit/PR, environment, role and actual browser result. Test desktop and roughly 390 px phone width, accessible keyboard/focus, no clipping, primary task discovery, tenant isolation and restricted API/export fields. Test manager billing approval and denial of owner-only finance; caregiver cannot approve billing. Confirm owner login live. Inspect each recovered route with its proper role, not only automated database tests.

Deliver before/after screenshots, completed versus remaining inventory, release notes and an owner phone acceptance checklist. Existing deployment approval is not approval for an unlimited production feature rollout. Keep real-client launch readiness distinct from synthetic TEST acceptance.

Historical basis: this consolidation uses the current owner testing and retrieved prior conversation decisions. Prior master plans and CareScore details still require repository/source inspection; no complete historic specification or live CareScore/AskCare implementation has been verified here.


## CareLik historical recovery review — final scoped additions

Review date: 3 October 2026 Pacific. Prepared for owner review before the Claude handoff. No external message sent and no application changes made.

### Evidence and limits

Read the complete Ogevia Master Product and Business Plan (11 August 2026), retrieved July CareLik decisions, and inspected archived carelik-main.zip (15 entries) and CarelikGlobal.zip (15,478 entries, largely dependencies). The latter is a Phase 1 Foundation increment, not a complete later product. These are historical snapshots, not today's deployed repository or live database.

The older carelik-main archive contains app.html with Branding—Make It Yours (logo upload/reset, brand colour), hours and financial charts, CareScore-labelled matching, AskCare, agency settings and mobile navigation; compliance.html with staff/client/agency/form categories, credential dates, expiry displays and document review; staff-submit.html with document submission. Actual code confirms these concepts existed; it does not establish their production security, storage reliability or successful migration.

Specific risks observed: branding and document lists use carelik_brand, carelik_settings and carelik_docs localStorage; some compliance upload paths store file.name as metadata without calling the file-storage helper. Staff submission shows success before asynchronous cloud completion and falls back locally on errors. Other paths contain real storage helpers and database credential writes; the archive is inconsistent, so do not label all uploads fake or all records safely saved. A comment in app.html explicitly describes a prior localStorage-only credential problem and adds database writes. Changing origin/browser or local-storage keys can make such data invisible; that is a risk mechanism, not proof it happened here.

No confirmed rename-caused data loss. Distinguish: records deleted, records in another backend/tenant, browser-only records, missing AWS migration, hidden routes/permissions, and unbuilt proposals. Preserve source databases, original browser data, archives and git history. Do not clear cache or overwrite original data during diagnosis. Compare source and target identifiers, row counts, links, file objects and checksums through authorised read-only checks; report missing files separately from metadata. Keep private backup content and identities out of public reports.

The August plan narrowed launch deliberately to authorisation-aware scheduling, verification, reconciliation and human billing approval. Its earlier infrastructure/pricing suggestions are historical and are not current deployment guidance. Current owner decisions supersede conflicting historical scope; do not restore every June/July proposal indiscriminately.

### Scope decision table

| Component | Historical basis | Final treatment |
| --- | --- | --- |
| Owner front-screen utilisation | Earlier owner charts preference; archived hours/financial charts; current owner request | Include a small actionable utilisation overview, not advanced predictive analytics |
| Agency branding and colours | Explicit agency-first preference; archived logo/colour settings; August all-role branding decision | Restore tenant-persisted settings across desktop, mobile and print |
| Documents and credential due dates | Archived Document Center plus current explicit request | Include a minimal administrative document/compliance module |
| CareScore and Matching | Archived ranking and prior product decisions | Preserve/recover existing supported definition; validate against later versions |
| AskCare | Archived question interface; later narrowed launch deferred AI | Preserve name and recover verified operational answers; new external AI/provider work is a separate expansion |
| Applicants and Tasks | Older modules and administrative proposals | Inventory/preserve existing code; no new recruitment suite or workflow engine |
| Custom domains, independent tenant page builders, Drive sync | Older proposals/preference for tenant customisation | Keep architecture compatible; defer new domain automation/page builder/connectors |
| Clinical charting, eMAR, payroll execution, automatic claims, GPS | Explicit later scope exclusions | Do not add |

### Owner home: useful chart, not dashboard clutter

Default to the organisation's current month and timezone. Show four compact summaries: authorised hours, worked hours, billable hours and hours left. A single utilisation bar chart compares authorised versus worked by service; tap into client/service detail. Define utilisation as worked minutes divided by authorised minutes for the same valid client/service/period; show no authorisation as unavailable, and flag overage rather than hiding it. Do not add scheduled, worked and billable together: they describe different stages of the same work. Different authorisation periods must not be treated as monthly grants or duplicated when amended.

Below, show NEEDS ATTENTION with links/counts for missing confirmations/time out, uncovered shifts, expiring/missing credentials and authorisations requiring review. Supported owner-only financial cards show documented billable value, potential value of unused authorised hours and estimated contribution after supported costs. Unused capacity is not automatically a loss; billable value is not collected revenue; wages alone are not total labour cost or net profit. Missing rates/costs show unavailable. Manager home keeps operational hours, attention and billing approval, excluding owner-only finance. Chart has an accessible text/table equivalent.

### Branding settings

Agency Profile → Branding: agency name, logo upload, accent colour, preview, save and reset. Reuse the existing naming where present. Persist per agency in the backend so another browser/device sees the same brand. Apply to all role shells, mobile menu and printed calendars/reports/document headers. Ogevia remains visible subtly as Powered by Ogevia; no wholesale technical-resource renaming. Colour selection cannot override required warning semantics or accessible contrast. Do not restore the old hard-coded tenant IDs or browser-local-only settings design.

### Minimal Documents and Compliance module

One Documents & Compliance area, with staff profile → Documents as a second entry. Support staff, client and agency documents with tenant and role permissions; initial focus is staff credentials plus client authorisation evidence and agency forms. Caregiver sees/uploads only their own permitted documents. Managers may review ordinary credentials; sensitive employment/tax/identity files require separately restricted owner/authorised administration permissions.

Document record: linked person/agency, document type, issue/completion date, actual expiry where applicable, requested/due date, file/version, uploaded by/at, verification reviewer/date and rejection/replacement reason. Distinguish document due date, credential expiry and authorisation effective dates. Support Missing, Requested, Uploaded—Awaiting review, Verified, Rejected, Expiring and Expired without implying uploaded equals verified. Historical versions remain auditable.

Types: TB, CPR, First Aid, background-clearance status/evidence, driving licence/insurance where relevant, training/orientation, agency forms and configurable types. Do not force every type to expire. Do not copy the archive's blanket annual TB/24-month CPR defaults as authoritative requirements: use the actual certificate and the agency's approved requirements. Sensitive identity/payroll files are not required for the initial module. An archived forms library is not evidence every template is current or appropriate.

Phone workflow: select requested document → photograph or select PDF/image → enter applicable dates → upload → wait for server-confirmed storage → submitted status → manager verification. Validate allowed file types and size; use private tenant-scoped storage and time-limited authorised downloads; no public permanent document URLs, names in object keys or silent local-only success. File metadata and storage must remain consistent on errors/retry. A completed upload must reopen successfully on a second device with the correct role.

Warnings: due soon, due today, overdue, expiring and expired; always show exact date and days remaining/overdue. Proposed configurable reminder thresholds are 30/14/7 days, not a recovered universal policy. Initially surface reminders inside the app; external email/SMS automation may follow only through the approved notification setup. Generic notifications link to the secure app, not attached credential data. Replacements verified correctly stop the previous warning; avoid duplicate alerts.

No new blanket scheduling prohibition. Display credential concerns and apply only an existing or explicitly configured agency eligibility rule; preserve visit history and audited overrides. Admin document review is not legal clearance or clinical assessment.

### Acceptance before calling this recovered

1. Brand saved by owner appears for manager/caregiver on another device and in print.
2. Owner utilisation totals reconcile to service reports for the same authorisation periods; manager cannot retrieve owner-only finance.
3. Upload a synthetic TB/CPR PDF/photo; manager opens the real file, reviews it and sees exact applicable dates. Caregiver/another agency cannot open unauthorised files.
4. Test missing, due today, soon, expired, rejected and renewed documents; date logic follows organisation timezone and removes resolved alerts.
5. Failed/oversized upload never reports success; retry does not create duplicate records/objects. Old versions are retained and audited according to the chosen retention policy.
6. Feature recovery inventory identifies old source, current route/API/storage dependencies and observed browser result. Latest CareScore formula and AskCare implementation require comparison to later commits; this July snapshot does not settle them.

Recommendation: these owner summaries, branding settings and minimal document/expiry workflows are justified operational additions requested now. Keep clinical scope and advanced automation deferred. Preserve broader product code, but do not make every historical aspiration a launch blocker. The recovery brief is consolidated; actual data-loss diagnosis and implementation remain unverified until current source and live authorised systems are compared.

## Implementation log

| Date | Item | Change | Environment | Verified | Owner acceptance |
| --- | --- | --- | --- | --- | --- |
| 2026-10-04 | Brief item 1 (inventory) | [FEATURE_RECOVERY_INVENTORY.md](FEATURE_RECOVERY_INVENTORY.md), from repository inspection | none | Repository only; not checked against live systems | Pending |
| 2026-10-04 | Managers may approve billing (consolidated brief) | AWS migration 0019 (approval, void, list; owner-only dollar amounts via `billing.read`); 3 API routes; approve/void on Billing review | Branch only; **not deployed** (needs approval; separate from the pending 0013–0018 pilot deploy) | Database, API and web tests; local 390 px browser run, 17/17 | Pending |
