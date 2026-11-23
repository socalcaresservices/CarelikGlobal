# Open Shifts: office runbook

For schedulers, coordinators and agency administrators. Texting is separate from the board: the board and your approval work even when texting is off.

## Every day
1. Open **Schedule → Coverage**. Each row is a shift that needs a caregiver. Check **Urgent** (starts within 48 hours) first.
2. A row says **Not posted** or **On the board**. **Post for Coverage** shows the shift to caregivers approved for its service city. It never assigns anyone.
3. If a row says **No service city**, enter the city and save. Until then caregivers cannot see it and no text is sent.
4. Click **Review requests**. Requests are listed in the order they came in. The green one is the earliest caregiver who can work it right now. **Confirm assignment** assigns them. Choosing someone else asks for a reason, which is recorded.
5. A request marked "Cannot be approved now" shows why (hours, hold, overlap, city). Nothing was assigned.
6. If nobody has asked and the shift is close, recruit by phone, then use **Assign** on the Schedule page.

## When something changes
- **Caregiver calls out** (they report it, or you record it): Schedule → shift → **Record call-out**. The same shift goes back on the board automatically, the office contacts are texted, and eligible backups are texted if texting is on. The caregiver who called out is never offered the shift.
- **Client cancels**: Schedule → shift → **Cancel shift**. The opening closes, reserved hours return, and the assigned caregiver is told not to go. No recruitment text is sent.
- **Take a shift off the board**: Schedule → shift → **Coverage and posting → Unpost**. Waiting requests are closed.
- **Time or city of a posted shift changes**: waiting requests are cancelled and caregivers must ask again.

## Text problems
- The top of **Coverage** lists recent call-outs, cancellations and any text that failed, has an unknown outcome, or was blocked (limit, no consent, sender off).
- **Send again** is offered for a failed text. For an unknown outcome you will be asked to confirm the person did not receive it first, so nobody gets a duplicate.
- A caregiver who texts STOP is opted out of that agency's texts immediately. They still see the board.
- The monthly text limit is shown in the 30-day summary. When it is reached, texts stop and the board keeps working.

## Settings (administrators): Settings → Open shifts and texts
- Cities each caregiver may work (comma-separated). A caregiver with no cities sees nothing.
- Office contacts for alerts. One on-call number receives alerts outside office hours. Being listed gives no sign-in access.
- Quiet hours (default 9 PM–7 AM), alert window (default 14 days), urgent (48 h) and escalation (24 h) hours, monthly limit.
- **Send texts for this agency** only works after Ogevia support has verified your sender number. Turn it off at any time.

## Emergency: stop all texting
1. Agency administrator: Settings → Open shifts and texts → turn **off** "Send texts for this agency" (immediate, this agency only).
2. Ogevia support, all agencies: set the platform switch (`select ogevia.set_sms_emergency_disable(true, 'reason')`) or set `SMS_EMERGENCY_DISABLE=true` on the function, or disable the `CoverageSms` schedule. Queued texts are then suppressed or left unsent. Nothing about posting, requests or approval changes.
3. Tell the office by phone: coverage must be arranged manually until texting is restored.
