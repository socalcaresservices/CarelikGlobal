# Phase 7.2 — Branded invitation emails

Date: 2026-11-23 · STATUS: **COMPLETE for company branding, configurable sender and previews; PARTIAL for per-office branding (NOT BUILT: needs a Cognito custom-message trigger); NOT ENABLED anywhere**

## How invitations are sent today (VERIFIED, code)
Cognito sends the invitation email (`AdminCreateUser` and resend, via `apps/sv-api/src/identity.ts`) using Cognito's default message and Cognito's default sender (`emailSendingAccount: COGNITO_DEFAULT`, `infra/aws/lib/auth-stack.ts`). The app does not render any email body. Therefore branding is a setting of the Cognito user pool, not application code.

## What was built (reuses the existing pool resource; no new service)
- `infra/aws/lib/invitation-email.ts`: pure renderer. Responsive table layout (600 px, narrow-screen rule at 480 px, full-width button), company name or optional https logo, accent colour, office line (optional), sign-in button plus visible address, help address (display only), plain-text fallback. Keeps Cognito's two required placeholders (`{username}`, `{####}`) exactly once; validates and escapes every brand value; refuses braces/line breaks in names; enforces Cognito's template limits (subject ≤140, body ≤20,000).
- `config.auth.invitationEmail` (optional, **absent everywhere today**): when present, `auth-stack.ts` writes `adminCreateUserConfig.inviteMessageTemplate`; when `sender` is also present, `emailConfiguration` becomes `DEVELOPER` with the SES `from` address and identity ARN (ARN format validated). Absent = the synthesized pool is byte-for-byte the live shape (test asserts `{AllowAdminCreateUserOnly:true}` and `COGNITO_DEFAULT`).
- Previews: `infra/aws/scripts/preview-invitation-email.ts` writes four sample pages (company default, with logo, office-branded, long name; sample values only, no personal data) to `docs/stabilization/email-previews/`.

## Verification
- `infra/aws/test/invitation-email.test.ts`: 7 tests pass (placeholders, limits, responsive markers, no scripts/remote CSS, escaping, validation refusals, pool unchanged when unset, template applied when set, SES sender applied, bad ARN refused). `tsc --noEmit` clean.
- Rendered the office-branded preview in Chromium at 390 px and 900 px: no horizontal scroll (scrollWidth equals viewport) (VERIFIED, local file).
- NOT VERIFIED: how Gmail/Outlook/iOS Mail render it (not tested in real clients); that Cognito accepts this exact body (limits and placeholders are checked locally against Cognito's documented rules, not against a live pool); delivery from SES.

## Limits and decisions needed
1. **One brand per pool.** A static template cannot vary by agency or office. Per-office branding needs a Cognito *CustomMessage_AdminCreateUser* Lambda trigger that looks up the invited person's office (database access from a trigger Lambda, IAM, VPC, a cost-neutral but new moving part). Not built; the renderer already accepts `office` for it. Recommendation: do not build until a second office actually needs a different look; offices are shown by name/colour inside the app today.
2. **Sender.** A custom sender requires a verified SES identity (domain or address) in `us-west-2` and SES production access; the sender address is the owner's choice. Until then the sender stays Cognito's default.
3. **Where to enable:** TEST uses the shared pilot pool, which this repository does not manage, so the template cannot be tried on TEST through CDK. Enabling is a production-pool message change (in-place, no replacement) by the usual reviewed change set after the owner's approval. Recommended first proof: apply the same message to the TEST pool by hand-run console/CLI change by the owner, send one invitation to a test inbox, then approve production.
