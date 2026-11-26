# TEST email sender: recommendation (2026-11-26) — nothing has been changed or sent

## Where things stand (VERIFIED from the repository and the deploy output)
- The app can already send open-shift email: `notificationEmail` in `infra/aws/lib/config.ts` adds ONE small Lambda outside the VPC, allowed `ses:SendEmail` on ONE verified identity, invoked by the API. It is not configured in TEST, so TEST has no sender and every queued email stays `queued`. The stage scripts assert this.
- The email body is short and carries no client name, code, ZIP or street: service type, date, time, service city, and one "View shift" link to `/my-shifts?shift=<id>`.
- Cognito's own sender (invitations, reset codes) is separate and cannot be used for these emails.
- Owner decision of 2026-11-23: open-shift notifications from **scheduling@ogevia.com**, kept in configuration, never in a template.

## Recommendation: send through Amazon SES from a verified `ogevia.com` domain identity
| | |
|---|---|
| From | `Ogevia <scheduling@ogevia.com>` (your 2026-11-23 decision) |
| Reply-To | `scheduling@ogevia.com` if that mailbox exists; otherwise `admin.ogevia@gmail.com` (Reply-To does not affect delivery checks) |
| Identity | SES domain identity `ogevia.com` in us-west-2, Easy DKIM (three CNAME records at your DNS host). DKIM on your own domain makes Gmail's From-domain alignment check pass. |
| Reuse | Same tool the code already supports; the same identity serves production later. No new vendor. |
| Cost | One small Lambda, no always-on resource, no NAT. SES charges per message; the pricing page lists $0.10 per 1,000 messages à la carte and $0.16 per 1,000 on the Essentials plan (the page changed recently: confirm before production). TEST volume is a few dozen messages: well under one dollar. |

### Why not the alternatives
- **`admin.ogevia@gmail.com` as the From address.** Google requires the From-domain to align with the SPF or DKIM domain; mail from gmail.com sent by another service cannot, so it is likely to be junked or refused. A short TEST would work only by luck, and would prove nothing about the real sender.
- **A third-party email provider.** New vendor, new cost, new data-sharing review; the repository already supports SES. Needs a demonstrated gap first: none found.
- **Cognito's default sender.** Cannot send application mail.

## TEST specifics
- A new SES account is in the **sandbox**: it can send only to verified recipient addresses, 200 messages per day, 1 per second. For TEST that is enough: verify each TEST recipient address (your `+` aliases count as separate addresses; each sends a link to the same inbox). Production access is a separate request, made only for production.
- No PHI in TEST (synthetic data). For production, the AWS BAA must be confirmed first (project rule); UNKNOWN today.

## Steps and who does them
1. **You (SES console, us-west-2):** Create identity → Domain `ogevia.com` → Easy DKIM. Add the three CNAME records at your DNS host. Wait for "Verified". Do not change any existing mail records (MX, SPF). If `_dmarc.ogevia.com` has no record, tell me before adding one.
2. **You:** verify the TEST recipient addresses (SES → Identities → Email address; click each link).
3. **Me, after your "go":** set `notificationEmail` for TEST in configuration, extend the deploy gate to allow exactly: one new Lambda, its role, the one-identity send permission, the invoke permission, one environment variable. Same pattern as stage 3: tests, CI, one script, a typed confirmation, rollback.
4. **You, in the app:** turn on email in the open-shift settings (it stays off until then), create a new open shift two or more days out.
5. **Acceptance (separate from the in-app pass):** a NEW email arrives; the headers show `dkim=pass` and `dmarc=pass`; **View shift** opens the exact shift after sign-in. Until all three, email stays NOT VERIFIED.

## Rollback
Turn the email setting off in the app (immediate, nothing else needed). To remove the sender, a reviewed config change redeploys without the Lambda. The SES identity can stay.

## Decisions I need from you
1. Approve using `ogevia.com` as the SES identity (do you control its DNS today?). 
2. Reply-To: does a `scheduling@ogevia.com` mailbox exist?
3. Which TEST recipient addresses should receive the test emails?

## UNKNOWN (not checkable from here)
Whether this AWS account already has SES identities or is still in the sandbox; whether `ogevia.com` already has a DMARC record; whether the AWS BAA is in place for production.
