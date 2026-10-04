# SCS pilot: AWS TEST deployment and real-phone acceptance record

**Result (reconciled 2026-10-04): DEPLOYED to AWS TEST (owner-reported 12/12). Real-phone acceptance of the deployed build: NOT YET RECORDED.**

## Timeline (UTC, from this session's messages)

| Time | Event | Evidence class |
| --- | --- | --- |
| 2026-10-03 19:57 | First recovery run (`ecf513c`, 11 checks) reported "Live verification 11/11 PASS" | Owner-reported; later contradicted (next rows) |
| 19:58 to 20:01 | Phone results A–G reported PASS, all seven sections within about 3 minutes | Owner-reported |
| 23:40 | Restore drill: the source database `ogevia_sv_test` was at migration **0012** | Owner-reported drill output |
| 23:51 | Owner: "Deployment logs confirm the pilot stopped at phase 7's scope gate" | Owner-reported |
| after 23:59 | Recovery block `pilot-recover-scope.sh` (`5f7a10a`, 12 checks, pinned build 87a9be2) run; owner reports **migrations through 0018 and 12/12 live verification** | Owner-reported. The terminal output did not reach Claude. This container has no valid AWS credentials, so Claude has not independently confirmed it. |

**Classification of the phone results.** The A–G results were reported at 19:58–20:01, before the database was migrated past 0012. They therefore did not test the deployed pilot build:
- D (scheduled service preselected, 0017), E (correction keeps seconds, 0018) and F (manager close-out, 0015 and the `close` route) depend on code that was not live at that time.
- A and C (sign-in, start/end/confirm) cover behaviour that also existed in the October 2 build, so those results describe that earlier build only.

They are kept here as historical records and are **not** used as acceptance of the pilot build. Re-run the phone checklist on the deployed build; post-deployment results are recorded in the table below when received.

## Post-deployment phone acceptance (deployed build 87a9be2)

| Section | Result | Date | Notes |
| --- | --- | --- | --- |
| A–G | Not yet reported | | |

## Independent live confirmation (pending)

Run `infra/aws/slice/live-status-check.sh` in CloudShell (read-only, except the temporary DB-window security group, which it restores and verifies). It prints the migration ledger, the live API and web versions, Cognito sign-ins, agency owner and manager access, and the Phase 7 security settings.

## Evidence basis (earlier record, kept for audit)

| Item | Source | Classification |
| --- | --- | --- |
| Deployment and the 11 live checks | The owner ran `infra/aws/slice/pilot-recover-scope.sh` (`ecf513c`) in CloudShell. The final line was `PILOT DEPLOYED AND VERIFIED ON AWS TEST`, with `Live verification: 11/11 PASS` and no FAIL lines. | Owner-reported. The terminal output did not reach Claude (pasted blocks were dropped), and Claude's environment has no valid AWS credentials. The full output is kept in CloudShell: `~/ogevia-pilot-run/recover-*.log`, `deploy-*.log`, `REPORT.md` and `VERIFY.txt`. |
| Phone acceptance A–G | Owner-reported PASS for each section on real phones, with no FAIL rows | Owner-reported. Claude did not receive the screenshots. |

**Earlier mistake, corrected:** an earlier message reported "exit code 0" with no evidence behind it. The read-only evidence script `pilot-evidence.sh` showed nothing had deployed, because the run had stopped at the scope gate. Deployment was confirmed only after the logged recovery above.

## Deployed scope (strict scope gate, approved once with DEPLOY)

The scope gate allowed only the following changes, each compared attribute by attribute against the captured live templates:
- **+ route** `POST /v1/visits/{visitId}/close`: identical to the live `…/end` route except its RouteKey; it uses the existing integration and requires sign-in (JWT).
- **+ its route-scoped Lambda invoke permission.**
- **~ the existing Handler:** code package only.
- **~ `AWS::CDK::Metadata` `Analytics`** in 5 stacks; this creates nothing in AWS.

Other changes in this deployment:
- RDS manual snapshot `ogevia-prod-postgres-pre-pilot-<date>`.
- Migrations 0012–0018 applied to `ogevia_sv_test`, after the run checked that existing visit timestamps would stay unchanged.
- 3 individual Cognito sign-ins.
- The synthetic pilot seed.
- The web build and `config.json`.

The admin host's temporary security group was removed again afterwards.

## Live verification (11/11 PASS, owner-reported)

1. The API stack is `UPDATE_COMPLETE`, updated after the approval.
2. The Lambda runs new code (its `CodeSha256` differs from the rollback capture) with `DB_NAME=ogevia_sv_test`.
3. There is exactly one new route (`close`, JWT); the 8 public routes are unchanged.
4. The live API returns HTTP 401 on `close` without sign-in.
5. The web bucket `index.html` is this build.
6. The web URL serves this build.
7. `config.json` points at the TEST API and the TEST app client.
8. The pre-pilot snapshot is available.
9. The 3 pilot sign-ins exist and are enabled.
10. The DB window is closed (the app security group is not on the admin host).
11. Both smoke suites (the test slice and the pilot checks) passed.

## Real-phone acceptance (owner-reported)

| Section | Result | What it proves |
| --- | --- | --- |
| A. Sign-in with MFA | PASS, all 3 phones | Individual accounts; TOTP is required at every sign-in; caregivers land on Today's visits with no billing menus |
| B. Scheduling | PASS | Shifts are created through Care Requests. **B4: a 4 h request beyond the 3 h authorization was refused** with the authorized-time message. |
| C. Complete visit | PASS | Server Time In/Out; a refresh keeps the same visit with no duplicate; signature captured; the visit ends **Billing ready, not billed** |
| D. Service selection | PASS | The scheduled service (PCS) is preselected, and choosing a different service shows a warning |
| E. Correction | PASS | Pacific AM/PM entry; a wrong AM/PM is refused with a specific message; the original is kept in History; **unchanged Time In identical, seconds included** |
| F. Missed clock-out | PASS | The visit appears under Missing Time Out; the manager closes it with explicit AM/PM and a reason; the caregiver sees "entered by your agency" and signs |
| G. Review and isolation | PASS | An unconfirmed visit goes to manager review with 0 billable; Billing ready is separate from approved, billed or submitted; reconciliation adds up; the phone layout is clean; **the test-slice manager sees no pilot data** |

## Still required before any real client data

1. The AWS BAA confirmed in AWS Artifact.
2. The Phase 7 security sign-off: encryption, private DB, least-privilege IAM, CloudTrail, alarms and retention, a backup restore drill, and budgets.
3. A separately approved production cutover. The PR chain is #68 → #51 … #67 into `main`, with no merge yet.

## Rollback (kept in CloudShell `~/ogevia-pilot-run/rollback`)

Run `bash infra/aws/slice/pilot-rollback.sh <web|api|users|db|status>` from the 87a9be2 checkout. The snapshot `ogevia-prod-postgres-pre-pilot-<date>` remains until it is deleted, and adds a small RDS snapshot storage cost.
