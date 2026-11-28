# Ogevia NFC and QR visit verification — Build request for Claude

Implement in a dedicated feature branch and draft PR. Reuse scheduled visits, service types, punch records, signature evidence, permissions, audit and reporting. Pilot with synthetic data in TEST. Continue Sandata for required EVV. Report evidence and costs before production approval.

## Location and timekeeping

Set separate expected start and end locations by service type, with authorized per-visit overrides where allowed. Default in-home respite to home only. Use the client service address with required city and ZIP. Flag addresses that cannot be located reliably. Display both expected locations before the visit.

| Visit | Clock-in | Clock-out |
|---|---|---|
| Home only | NFC or QR | NFC or QR, then signature |
| Approved community | Assigned visit screen | Active visit screen, then signature |
| Home to community | NFC or QR | Active visit screen, then signature |
| Community to home | Assigned visit screen | NFC or QR, then signature |

On a valid tap or scan, open Ogevia, prompt for login if needed and resume. Automatically clock in when exactly one assigned visit matches the home and arrival window. A distinct departure scan on the matching active visit records checkout and opens signing. Confirm substantially early checkout or ambiguous intent. Write only through explicit authenticated server actions after validation. Session previews and opening the URL have no punch side effects. Use idempotency and atomic state transitions. Retries, reloads, rapid taps, and concurrent devices must never turn arrival into checkout or duplicate a punch. Show the saved time and status.

Capture phone location and accuracy at punches only. Track within range, outside range, unavailable and low accuracy separately. Compare with the expected endpoint. A copied label link cannot authorize a punch. Enforce caregiver assignment and agency isolation. For an identifiable active visit, save actual checkout despite location problems and flag the exception. Unexpected off-site checkout for a home-only visit routes to direct client confirmation. Apply configured rules at approved community locations.

Handle wrong home, absent or multiple assignments, outside-window arrival, cancellation, reassignment and overlapping punches without guessing or overwriting actual time. Offer choice among the caregiver's valid assignments where needed. Preserve authorized attempts for review. Show whether a punch saved. If offline queuing exists, show pending sync and deduplicate. Provide audited missed-punch corrections for poor connectivity, dead phones, lost tags or delayed login. Flag overdue open visits, with actual and scheduled times kept separate.

## Sign at checkout or later

Save clock-out first. Every unsigned checkout remains Signature pending until validly signed. At ordinary checkout show the recorded visit date and times and allow the client or authorized representative to draw a fresh signature on the caregiver's phone. Record signer name, relationship, attestation, signing method and time.

Authorized staff can send or resend a secure, expiring, single-use link to a signer on file. Revoke replaced links. Require this direct signing path after an unexpected off-site checkout for a home-only visit. Allow later signing from any location. Record follow-up owner, request and delivery history, and known reasons such as unavailable or declined. Keep visit details out of email subjects and tokens out of logs. A late signature resolves the missing-signature issue only. Preserve actual checkout and separate time, signature, location review and billing readiness.

## Screenshot and reuse safeguards

Use a fresh signature pad for every visit. Disable image uploads, paste and reuse. Validate stroke data on the server with a short-lived session bound to the exact visit and time revision. Atomically consume the session and reject expired, replaced, reused, wrong-visit or stale-revision submissions. Preserve the original signed revision in audit history if times change materially, reopen Signature pending and request a fresh signature.

After submission show caregivers Signed and the date. Restrict stored images to authorized roles and omit them from routine exports. Assume screenshots are possible in browsers. If a native Android signing screen exists, use supported screenshot blocking. Native iPhone screenshot notifications occur after capture. External photos and manual tracing can evade these controls. GPS describes the punch location and cannot identify the signer. For a disputed visit, confirm using the authorized contact on file and preserve the evidence.

## Home labels and branding

Authorized agency admins can register a batch of unassigned stickers, each with a unique ID. From the client record or agency label inventory, tap the NFC sticker, scan its QR code, or enter its ID to capture it. Select the client service location and confirm the address on file. Show the sticker ID, status, and installation date on the client record. Enforce one active label per client service location and reject duplicate or cross-agency assignments. Stickers identify their registered location. The caregiver phone supplies the location at check-in for comparison with the service address. Keep client names and addresses out of supplier files. Log who assigned, deactivated, replaced, or reassigned a sticker and when. On replacement or reassignment, revoke or rotate the previous link and preserve historical visit references. NFC and QR open the same opaque, revocable Ogevia link. Print no client name or address. Give agency admins preview, print, copy link for tag programming, revoke and replace actions. Keep historical assignments. Offer discreet Ogevia, agency-branded and large high-contrast layouts with optional logo and accent color. Keep the QR high contrast and use clear tap and scan instructions. Pilot QR first, then test programmed tags on real iPhone and Android devices.

## Reports

Use existing filters for office, date, caregiver, client, service type and status where applicable. Apply permission checks to drill-downs and CSV. Omit signature images, precise GPS and signing links from routine exports.

| Report | Required content |
|---|---|
| Visit exceptions | Missing or failed punches, overdue clock-outs, location issues, overlaps, disputed signatures and correction requests. Include age, reviewer, status and resolution history. |
| Checked out without signature | Checkout, pending age, reason, last request, delivery status, owner and send/resend actions. Clear from open view on valid signing, retain history and reopen if signed times are corrected. |
| Visit time and signature register | Scheduled and actual times, punch method, expected location category, location results, signature status, method and signed time. |
| Corrections and audit | Original and revised values, requester, approver, reasons, timestamps, re-signing requirements, location decisions and label changes. |
| Payroll and billing review | Recorded and reviewed hours, separate exception and signature status, and configured billing holds. Preserve recorded time and existing approval rules. |
| Home label inventory | Sticker ID, client service location, office, unassigned/active/disabled status, issue and replacement dates, last use and authorized replacement actions. |

## TEST acceptance and cost

Show all four visit setups, both QR and NFC on iPhone and Android, repeated scans and reloads, concurrent devices, early checkout, bad or denied GPS, poor connectivity, wrong or revoked labels and agency isolation. Test batch registration, tap and scan assignment, duplicate and cross-agency rejection, location mismatch after moving a sticker, and replacement revocation. Verify immediate and later signing, direct confirmation after an off-site exception, report creation and clearance, corrected-time re-signing, rejection of upload/paste and invalid or reused sessions, and restricted access to signature evidence. Report local versus TEST results and device prompts.

Proposed pricing includes this workflow, QR, signatures and reports in the agency plan. Physical NFC kits or replacements are optional. Measure hardware, printing, email, storage, address lookup and support. Estimate SMS and Sandata integration separately if added.
