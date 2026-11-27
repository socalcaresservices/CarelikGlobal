# What is deployed: Ogevia TEST and production (2026-11-27, PROVISIONAL)

Method: the closeout audit (`2026-11-26-closeout-audit.md`), the repository and branches (read from Git on 2026-11-27), CI results, and the deployment output and screenshots you pasted. **No live AWS check was possible from the session** (no AWS access). `DEPLOYMENT_EVIDENCE_BLOCK.sh` in this folder is the one read-only CloudShell block that collects the live evidence; nothing below is "confirmed live" until its output is read. A merged PR, green CI or a migration file in Git is not treated as proof of deployment.

## Direct answers
1. **Production through 0112:** documented through **0112** (0109 on 2026-11-21, 0110 on 2026-11-21, 0111 and 0112 on 2026-11-22; owner-pasted output, "111 verified ledger rows"). **Nothing from Release Train 2 (0113-0120) was deployed to production in any recorded step**; every RT2 deploy output says "Production was not touched". Not re-verified live. The production `requestCleanup` switch state after 2026-11-21 14:16 is **unknown**.
2. **Open Shifts in TEST:** deployed and enabled through stage 3 (`620ccf35`, 0117-0120, web + API, owner "pass all" 2026-11-26). **Email:** stages 4 (`0c85c5fe`), 5 (`c1af8dbc`, SES permission fix) and 6 (`b2fe3944`, `footietree` recipient) were each reported complete by the owner. I saw the stage 4 and 5 output; for stage 6 I have only "deploy complete" with no output. An email DID arrive after stage 5 (screenshot, 1:15 PM, from `scheduling@ogevia.com`, Reply-To works). **No post-fix test yet proves** `dkim`/`dmarc` pass, the trace's `sent` row, or that **View shift opens the exact shift after sign-in**. Email acceptance = NOT VERIFIED.
3. **QR/NFC, stickers, signatures, exception reports:** built locally only (PR #125, branch `claude/amazing-clarke-8b309z`, migration file `0120_nfc_qr_visit_verification.sql`, version `0120`). **Not deployed to TEST or production** (TEST ledger version `0120` is `0120_alert_opens_exact_shift.sql`; the NFC migration has never been applied anywhere). **The 0120 conflict is NOT resolved**: Git on 2026-11-27 still shows both `0120_*.sql` files on separate branches, neither merged into `main` (698ae23b) and neither containing the other.
4. See the table.

## Table
| Feature | Built | TEST deployed and enabled | TEST verified | Production deployed and enabled | Evidence | What remains |
|---|---|---|---|---|---|---|
| Request cleanup, offices, office assignments + counties + colors, assignment history (0109-0112) | Yes | Yes (ledger 0109-0112) | Yes (owner passes 2026-11-21/22) | Yes per owner output 2026-11-21/22; `requestCleanup` switch: unknown | Owner pastes; PR #113/#114 merged | Re-check live (block); production switch state |
| Go-live ten items (sorting, drawer, refresh, picker, mobile, refusals) | Yes | Yes | Partly (no per-item acceptance) | Yes per owner report (#113 live 2026-11-21) | PR #113/#114 | Per-item acceptance unknown |
| Notifications, in-app (0113) | Yes | Yes (stage 1, `b0848ede`) | Yes (owner screenshots, pass all) | No (RT2 not in production) | Stage 1 output 2026-11-23 | Production decision |
| Open Shifts: board, request, office queue, exact-shift link, statuses (0117, 0119, 0120) | Yes | Yes (stages 2-3, `620ccf35`) | Yes (owner, 2026-11-26) | No | Stage 2/3 output; screenshots | Production decision; call-out/cancel/replacement flows not exercised in TEST |
| Service location + one edit form (0118) | Yes | Yes (stage 2) | Unknown (owner never reported) | No | Stage 2 output | 3-minute TEST check |
| Alert email via SES (stages 4-6) | Yes | Yes per owner (stage 6 output not seen); app email setting ON | **Not verified**: arrival yes; `dkim`/`dmarc`, sent row, exact-shift link after sign-in unknown | No | Stage 4/5 output; email screenshot | Acceptance checks; cosmetic HTML line breaks |
| SMS texting (mock) | Yes | Yes (mock only) | Unknown | No | Stage 2 output | Owner check of mock texts |
| Live SMS | No (mock only) | No | No | No | Owner: separate approval | Sender, number, registration undecided |
| Branded invitations, password-reset emails (0114 + Cognito trigger) | Yes (code) | 0114 applied; Cognito trigger/sender: unknown (block lists pool triggers) | No | No | PR #124 docs | Wire sender; no branded email received |
| Bulk import + rollback (0115) | Yes | Migration applied; switches unknown | No | No (`bulkImport` false in production config) | Ledger 0115 | Switch check; TEST acceptance |
| Staff duplicate merge hardening (0116) | Yes | Migration applied; switch OFF in stage scripts | No | No | Ledger 0116 | Enable and test |
| Operations readiness dashboard | Yes | No (switch OFF) | No | No | Stage scripts | Enable and test |
| QR/NFC visit verification (PR #125) | Yes (local tests) | **No** | No | No | Branch `claude/amazing-clarke-8b309z`; `0120_nfc_qr_visit_verification.sql` | Renumber (conflict), merge, deploy, real iPhone/Android test |
| Sticker management software (inventory, assign, print sheet, revoke) | Yes (local) | No | No | No | PR #125 | Same. **Printed QR sticker and programmed NFC tag on real phones: NOT DONE** |
| Checkout signatures, secure sign-later link, exception reports | Yes (local); sign-later email NOT built | No | No | No | PR #125 README | Deploy; build email delivery; device test |
| Sandata reconciliation | Unknown (no brief) | Unknown | Unknown | Unknown | None found | Provide the brief |
| Authorization worklist | Unknown | Unknown | Unknown | Unknown | None found | Provide the brief |
| Patriot payroll/billing export | Unknown | Unknown | Unknown | Unknown | None found | Provide the brief |
| Second-agency access | Unknown (tenant isolation is tested in all work) | Unknown | Unknown | Unknown | None found | Provide the brief |
| Family access (private care-request link, save to phone) | Partly (PR #110 draft) | No | No | Unknown (care-request link exists; PR #110 not merged) | PR #110 | Decision on PR #110 |
| Overlapping open-shift PRs #121, #122 (migration "0086") | Yes (drafts) | No | No | No | PR list | Close or keep |
| Rollback runbook and captures | Yes (Git) | n/a | n/a | n/a | `rollback-plan.md` | Stage 3 capture lost; stage 2 copy missing |

## Items that still need building, deployment or acceptance testing
- **Acceptance (TEST):** email `dkim`/`dmarc`, sent row, exact-shift link after caregiver sign-in; service-location checks; mock SMS checks; call-out/cancel/replacement scenarios.
- **Deployment decisions:** which of bulk import, merge, readiness, branded invitations to enable in TEST; any production release of RT2.
- **Build:** NFC/QR renumber and merge with #124; sign-later email delivery; HTML line breaks in the alert email; live SMS sender.
- **Physical stickers:** artwork, printing, NFC programming, real-phone tests (none done).
- **Briefs missing:** Sandata, authorization worklist, Patriot, second agency.
- **Unknown live state:** everything in the "unknown" cells until the block's output is read.
