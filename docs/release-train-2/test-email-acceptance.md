# TEST email sender: set-up and acceptance (owner approval 2026-11-26, TEST only)

Approved: Amazon SES from the verified `ogevia.com` domain; **From** `Ogevia <scheduling@ogevia.com>`; **Reply-To** `admin.ogevia@gmail.com`; **sole recipient** `admin.ogevia@gmail.com`
(enforced inside the email function, so no other address can receive mail from TEST even after SES leaves its sandbox). Nothing here touches production.

## What changes in AWS (all in TEST stacks, nothing else)
- `Ogevia-prod-ServiceVerificationApi`: + one Lambda `Ogevia-prod-NotificationEmail` (outside the VPC; may call `ses:SendEmail` on the one identity only; no database, S3, KMS or secret access), its role, policy and log group; the API gains ONE invoke statement for it and two variables (`EMAIL_FUNCTION_NAME`, `APP_ORIGIN=https://demo.ogevia.com`).
- `Ogevia-prod-NetworkEgress`: the shared Lambda VPC endpoint's policy gains ONE function ARN. (This stack is shared with production; the entry names a function that exists only in TEST and widens nothing for production.)
- Gate: `diff_gate_email.py` refuses anything else. Tests: `diff-gate-email.test.ts` (real synthesis, including tampering) and `test-rt2-n4-email.test.ts` (the script).

## Your steps (in order)
1. **SES domain identity** (console, us-west-2, Amazon SES, Identities, Create identity): Domain `ogevia.com`, "Easy DKIM" (RSA 2048). Add the three CNAME records shown to your DNS host (Netlify DNS). Do not change existing MX or SPF records. Wait until the identity shows **Verified** and DKIM **Successful**.
2. **Recipient**: if the account is still in the sandbox (the script tells you), Identities, Create identity, Email address `admin.ogevia@gmail.com`; click the link SES sends to that inbox.
3. **Deploy** with `TEST_RT2_N4_EMAIL.sh` (commands in the chat message). It checks 1 and 2 itself and stops with a clear message if either is not ready. Type `DEPLOY-TEST-EMAIL` when asked. Nothing is sent by the deploy.
4. **Clear old queued emails** (optional but recommended, so the first email is a NEW one): preview, then apply, `CLEANUP_QUEUED_EMAIL.sql` (instructions inside the file).
5. **Associate the address with a synthetic caregiver**: in the app, Staff, Care team, TEST-CG-01 (Test Caregiver), set the contact email to `admin.ogevia@gmail.com`. The alert email goes to a caregiver's contact email first. (Sign-in itself is unchanged; a resent sign-in link would also go to this address.)
6. **Turn email on** in the app: Notifications, open-shift settings, email on.
7. **Generate a new alert**: create an open shift at least 2 days out in Winchester (Temecula office), no shift office set.

## Acceptance (separate from the in-app pass)
PASS only when all of these are seen on the NEW email in `admin.ogevia@gmail.com` (not an older one):
| Check | How |
|---|---|
| Arrived | inbox or spam; note where |
| From / Reply-To | From `Ogevia <scheduling@ogevia.com>`; reply goes to admin.ogevia@gmail.com |
| Authenticated | Gmail, three dots, Show original: `dkim=pass` and `dmarc=pass` (record the `Message-ID` domain) |
| Content | short body: service, date, time, service city; no client name, code, ZIP or street; subject follows the agency template |
| **View shift** | tap it signed out in a private window: sign in as TEST-CG-01 and land on that exact shift (`/my-shifts?shift=<id>`) with Request this shift |
| Nobody else | no email to any other address (the function refuses them: `recipient_not_allowed`) |

## Rollback
1. Turn email OFF in the app (immediate).
2. `bash TEST_RT2_N4_EMAIL.sh rollback` (typed `ROLLBACK-TEST-EMAIL`): removes the function, role, policy, log group, invoke statement, variables and the endpoint entry. The SES identity stays.

## Status
Prepared and tested locally only. NOT DEPLOYED. Email acceptance: NOT VERIFIED.

## Finding 2026-11-26 and stage 5 (SES sandbox)
First real send: TEST-CG-01's email reached the function with the approved address, passed the allow-list, and SES returned `access_denied_exception` (trace: alert 05:10:21 PT, failed 05:10:22). The account is in the SES sandbox (`ProductionAccessEnabled=false`), where SES also checks send permission on the RECIPIENT identity, and the function's permission named only `ogevia.com`. The policy simulator could not confirm this per identity (inconclusive); the first real send after stage 5 will.
Stage 5 (`TEST_RT2_N5_EMAIL_RECIPIENT_IDENTITY.sh`) adds exactly one identity ARN (`admin.ogevia@gmail.com`) to the function's single `ses:SendEmail` statement. The allow-list is unchanged. Gate: `diff_gate_email.py --expect identity`. After it deploys, create ONE new open shift inside the 48-hour window (TEST `window_hours` = 48).
