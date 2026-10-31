# Target verification status and open items (2026-10-30, 0086)

**Owner decisions D9-D12 (DECISION_RECORD A4) close sections 2 and 3 and set the rule in section 4: due-days is API-only; enforcement stays OFF in UAT (O13/S4 not executed); cross-agency is manual if TEST has a second organization, otherwise the reviewer must accept reliance on the automated tests.**

**0086 remains NOT RELEASABLE.** Owner instruction 2026-10-30: no merge, deploy, migration, enforcement change or environment change. Release readiness is evaluated only after UAT execution and sign-off.

## 1. Read-only target verification (runbook section B)
| Item | Status | Evidence |
|---|---|---|
| Verification from Claude's container | **NOT POSSIBLE, not attempted against any environment** | `aws` CLI and AWS SDK are not installed here. The target database is on private RDS (no public endpoint, `CLAUDE.md` section 8), so no query can reach it from this container. Environment variables with AWS keys exist, but their account and scope are unknown, and I did not install tooling or probe with them. |
| Verification by the Operator | **PENDING (Stella Okereke)** | Run runbook B on database `ogevia_sv_test` only, after the `current_database()` guard (the same instance also holds `ogevia_prd`), as the read-only role in `begin read only;`. Record: migration ledger max and count, Ready/Active count, `to_regclass('ogevia.caregiver_work_approvals')` (null expected), and the value in section 2 below. |

## 2. Is enforcement reversible? **No, not through the product.** (VERIFIED from code)
- `ogevia_api.activate_readiness_enforcement` (0042) sets `enforcement_active_from = now()` and refuses a second call ("Readiness checks are already active."). It needs a reason (3+ characters), a finished CPR/TB setup, and the expected affected-shift count to match.
- No function, route or screen sets `enforcement_active_from` back to null (searched all 86 migrations and `routes.ts`). The only way back is a manual database edit, which is outside the release process and would need its own approval and backup.
- `set_service_checks` (On/Off) is a **different** switch: it turns the service checks off, does not undo activation, and cannot be turned On until activation has happened.
- Consequence: **enforcement must not be switched on in TEST for UAT unless the owner accepts that it stays on.** UAT steps O13 and S4 are optional and stay un-run. Under that rule, UAT proves the report-only ("Flagged only") behaviour; the blocking behaviour is covered by the automated tests.
- **Operator to read, read-only:** `select enforcement_active_from from ogevia.organization_readiness_settings` for the SoCal organization on `ogevia_sv_test`. If it is already non-null, TEST is already enforcing and the CPR/TB rule will block new shifts for overdue people from the moment 0086 is applied. Record the value before Phase C. UNKNOWN today.

## 3. CPR/TB due-days setting: API only, or a screen?
- **Current state (VERIFIED):** `GET/POST /v1/compliance/settings` and `ogevia_api.set_cpr_tb_due_days` exist (reason required, audited, idempotent). No web screen reads or writes it.
- **The owner's brief** asks for an agency setting with default 30 and does not ask for a screen. **No owner decision on a screen exists.** This is OPEN, not decided.
- **Recommendation:** keep it API-only for this release. It changes rarely, there is one agency, and a screen means a new commit, a new SHA (A3 is pinned), repeated B9/Phase C checks and a new GO. Revisit after UAT if the Owner role needs to change it without help. Until decided, UAT step O14 has the Operator read the value through the API.
- **Owner to record one of:** `API-only accepted for 0086` / `screen required before release`.

## 4. Cross-agency isolation (tracking)
- **Covered by automated tests (VERIFIED earlier):** DB tests for the new readiness functions and the sv-api HTTP tests include a second organization and expect refusal of cross-organization reads and writes.
- **Not yet proven on TEST (OPEN):** whether `ogevia_sv_test` contains a second synthetic agency. If it has none, the UAT sign-off must say cross-agency isolation rests on the automated tests, and the Security reviewer decides whether that is enough. Operator to count organizations on TEST (read-only).
- **Reviewer item:** `SECURITY_REVIEW.md` still has to be completed and signed.

## 5. Remaining Phase C blockers (unchanged)
1. Owner signs `DECISION_RECORD.md` (D1-D8, A1, A3); Stella acknowledges.
2. Operator confirms TEST identifiers read-only (section 1), including the enforcement value (section 2) and the organization count (section 4).
3. Owner states the window and gives a written GO (covers SHA `54894411f0e69ac29bec762006e47f7d943b94f2` only).
4. Operator runs the real `cdk diff` (expect 8 routes plus a Lambda asset per API stack).
5. A human accepts B9 (G4).
6. Reviewer completes and signs `SECURITY_REVIEW.md`.
7. ~~Owner records the due-days and enforcement decisions~~ DONE (D9, D10).
8. Phase C, then Phase D UAT with all four validators, then the release record update (D7).

## 6. Update 2026-10-31: Operator report, Part 1
Reported PASS (as reported by Stella Okereke; not independently verified): AWS account 300094796789, region us-west-2, `Ogevia-prod-*` stacks present, `ogevia-prod-postgres` available, publicly accessible = false, CloudFront banner confirmed. Package seen in Git at `015c6a2…`. **Part 2 (V1-V6) is blocked on the database access path** (`STELLA_READONLY_VERIFICATION.md` Part 2a: the earlier route needs a security-group change and the master credential; both need an owner decision). Enforcement value, organization count and ledger are still UNKNOWN. Parts 1 items 5-6 (API id, Cognito client, backup) and Part 3 not yet reported.

**D13 (2026-10-31):** Part 2 proceeds by an existing lower-privilege login role that can `SET ROLE ogevia_readonly` only. Master secret, host start/stop, security-group or network changes are not authorized; Stella stops and reports the exact requirement. No gate advances on Part 1; Part 2 results (V1-V6) are required.

## 7. Part 2 BLOCKED (Operator report 2026-10-31)
**Status: BLOCKED.** No database connection attempted; no infrastructure change; no secret accessed (as reported by the Operator). V1-V6 unknown. No gate advances.

**Cause (VERIFIED from the documents, not live):** the only documented route to the private database is SSM port forwarding through `ogevia-db-admin-temp` with the app security group attached to it only for the window (`docs/aws/TEST_PILOT_DEPLOYMENT_PLAN.md`), and a login that in earlier rehearsals came from the master secret. There is no standing network path from anywhere else, and no document names a lower-privilege login role. Whether such a role exists in the database is UNKNOWN (only a database query can show it, which needs the blocked path).

**Exact additional authorization that would unblock it (the owner picks one; none is granted):**
| Option | What it authorizes | Changes | Notes |
|---|---|---|---|
| A (recommended; matches the rehearsal route) | Stella may, for one named window: (1) attach the app security group to `ogevia-db-admin-temp` and restore and re-check it afterwards; (2) read the master secret into a shell variable (never printed or stored) to log in, then `SET ROLE ogevia_readonly` and run only `STELLA_READONLY_VERIFICATION.sql` inside `begin read only` | one temporary security-group change (reversible, must be re-checked), one secret read; the admin host stays in its present state unless the owner also says to start it | It is a changed environment for the window even though no data is written |
| B | As A, but Stella first creates a dedicated read-only login role for later checks | adds a database write (a role) and still needs A's access to do it | More durable, but a write to TEST: needs its own approval and rollback. Not recommended for this check |
| C | Owner provides an existing approved path I do not know of (a standing read-only access route that avoids SG, host and secret) | none | If one exists, name it and Stella uses it |
| D | Do not verify now | none | 0086 stays blocked; Phase C cannot start |
If the host is stopped, starting it is a separate written step (not covered by A unless stated). Whatever the owner chooses, it should name the window, the single person, the exact steps, who re-checks the restore, and that nothing else changes.

## 8. Update 2026-10-31: Option A approved (D14, A7)
Part 2 is authorized for verification only: Stella, one window, procedure in `STELLA_READONLY_VERIFICATION.md` Part 2b. Not yet run; V1-V6 unknown. Passing Part 2 clears only the target-verification blocker. After her report, Claude records results and the SG restore confirmation here and in `CHECKLIST.md` C0. A non-null V5 is reported to the owner first.

## 9. Part 2b step 1 pre-check, partial (pasted CloudShell output, 2026-10-31; read-only describe calls only)
| Check | Result | Status |
|---|---|---|
| `i-0ce8db2d7e5839dd5` state | `running` | PASS (host not started or stopped by anyone for this check) |
| Instance security groups | `sg-00e01e2ca80442c1f` only (checked twice) | PASS: unchanged, AppSG not attached |
| Network interfaces | one: `eni-099616641dd91bcaf` | recorded |
| Instance tag = `ogevia-db-admin-temp` | not shown in the output | OPEN |
| AppSG `sg-064ffce3bcbe8eb3b` identity; RDS SG `sg-00530a1f4f7648e65` admits 5432 from AppSG only | not shown | OPEN |
| Window start time | not recorded | OPEN |
Notes: (1) the stray line `sg-00e01e2ca80442c1f` ran as a shell command and failed (`command not found`); harmless, no effect. (2) **No change has been made** in the output shown. (3) Part 2 (V1-V6) still NOT RUN.

**Existing CloudShell scripts (not reviewed by Claude; names only):** `window.sh` under the `2026-10-19-prd-readiness` package sets `DB_EXPECT=ogevia_prd` and targets the production stack, so it **must not be used** for this window. `db-window-run.sh` and `ledger-check-temp-access.sh` may attach AppSG and may do more than read-only. None of the three is authorized for Part 2 unless reviewed and shown to (a) touch only `ogevia_sv_test`, (b) run only the verification SQL, (c) restore the group on exit. Safest: use the Part 2b steps by hand, or paste a script here (secret-free) for review before use.

## 10. Window script (2026-10-31)
Stella reports the Part 2b pre-checks done (host running, baseline `sg-00e01e2ca80442c1f` only, app and RDS groups match, window started). No usable command sequence existed; `STELLA_PART2_WINDOW.sh` was added. **Not run.** Correction made: the restore re-check is on the admin host's own interface; AppSG is legitimately used by other interfaces (API Lambda).

## 11. Script review (revision 2, 2026-10-31; owner asked for a code review before it is run; not executed)
Findings in `STELLA_PART2_WINDOW.sh` at `c8f72d3`, fixed within D14 scope: (1) **read-only was only the SQL file's own transaction**: now also `default_transaction_read_only=on` for the session, plus a pre-run scan that refuses the SQL file if it lacks `begin read only` / `set local role ogevia_readonly`, contains a psql meta-command, or contains a write/DDL keyword outside comments; (2) **tunnel wait was a blind 8-second sleep that only proved the process existed**: now polls the local port for up to 30 seconds; (3) **psql failure was hidden by the `tee` pipe**: exit status now checked; (4) **restore was not verified**: now compares the host groups and the RDS security-group sources to the baseline, prints `RESTORE VERIFIED` or `RESTORE NOT VERIFIED` with `!!!` lines, and returns a non-zero exit status on failure; (5) **signals**: explicit INT/TERM/HUP handlers route to the one cleanup, a second Ctrl-C is ignored during restore, the tunnel child processes are killed; (6) **credential hygiene**: secret handled with builtin `printf` and a pipe (no temp file), stray `PG*` variables cleared, `umask 077` for the results file; (7) **pre-checks before any change**: required tools, RDS security-group sources equal AppSG only, RDS not public. No scope was added. Residual risks: a kill -9 or loss of the CloudShell session cannot run any trap (then restore by hand with the printed command); CloudShell can time out during a long window.

## 12. Part 2 results received (Operator, window 2026-10-31T00:42:39Z to 00:43:01Z UTC) — PARTIAL, V1/V2/login role not yet seen
Version run: commit `2d9960e722e2ec4e01cadea904e92cc41295e53b`; hashes match (`STELLA_PART2_WINDOW.sh` `891802f0…`, SQL `038bae27…`). Restore: `RESTORE VERIFIED` (admin host `sg-00e01e2ca80442c1f` only; RDS SG `sg-00530a1f4f7648e65` sources `sg-064ffce3bcbe8eb3b`, unchanged). Operator's confirmation of "no other change" is requested in the reply (not yet received).
| Query | Result | Status |
|---|---|---|
| V1 guard (`ogevia_sv_test`) | not seen in the pasted output | **INFERRED** only: the script stops unless `current_database()` equals `ogevia_sv_test` before running the SQL, and it ran |
| V2 migration ledger | not seen | **OPEN (needed)** |
| V3 `already_has_0086` | empty (null) | PASS: 0086 not applied |
| V4 | ready_or_active **5** of **6** caregivers | recorded baseline |
| V5 enforcement | `enforcement_active_from` **empty for all 4 organizations**; `service_checks` empty (no settings row) | **PASS: enforcement OFF in TEST** (D10 holds; UAT step S4 report-only check can run as designed) |
| V6 organizations | **4** (4 active): `http-iso-a-04ba3a61`, `http-iso-b-4ed578b8`, `ogevia-test-slice`, `scs-pilot-synthetic` | **2+ organizations: D11 manual cross-agency UAT (X1-X3) applies.** `http-iso-*` look like HTTP-isolation test fixtures (INFERRED); the Operator picks two organizations with synthetic sign-in users for X1-X3 |
| Login role | not seen | OPEN |
**Target verification is NOT yet complete**: V2 (ledger), V1 as printed, and the login role name are still needed. No gate advances. 0086 stays NOT RELEASABLE.

## 13. Part 2 results, now complete V1-V6 (Operator paste of the saved results file, 2026-10-31)
| Query | Result | Status |
|---|---|---|
| V1 | db `ogevia_sv_test`, `role_in_use` `ogevia_readonly`, `is_test_db` = t | **PASS** (VERIFIED from the results file) |
| V2 | 85 migrations, latest `0085`; last five 0085, 0084, 0083, 0082, 0081 | **PASS: ledger as expected; only 0086 would be applied; contiguity rule satisfied** |
| V3 | `already_has_0086` empty | PASS: 0086 not applied |
| V4 | ready_or_active 5, caregivers 6 | baseline recorded |
| V5 | `enforcement_active_from` empty for all four organizations | PASS: enforcement OFF (D10 holds) |
| V6 | 4 organizations, 4 active | D11: manual cross-agency X1-X3 applies |
**D14 required report items still outstanding:** (a) the login role name (the `LOGIN ROLE USED` line; `role_in_use` above is the role after `SET ROLE`, not the login role), (b) the Operator's written confirmation that no other change was made. Restore was verified by the script (host `sg-00e01e2ca80442c1f` only, RDS SG sources unchanged). **Target verification will be marked complete when (a) and (b) are received.** This clears the target-verification blocker only; no other gate advances. 0086 stays NOT RELEASABLE.

## 14. Owner instruction 2026-10-31: adopt recorded Part 2 facts; collect remaining items
- **Adopted:** the Part 2 values in section 13 (V1-V6) are the current verification results **unless Stella identifies an error** in them.
- **Window start/end (recorded):** 2026-10-31T00:42:39Z to 2026-10-31T00:43:01Z (printed by the script; from the Operator's output). Operator's earlier manual pre-checks and the window opening are not separately timed.
- **Still to obtain from Stella (not yet received; Claude has no channel to her, so the owner relays the request):** (a) login role name, name only; (b) written confirmation that no other change was made; (c) confirmation that the section 13 values contain no error.
- **Security review:** reviewer **not yet named** (no name in the records). Packet ready: `REVIEWER_PACKET.md` + `SECURITY_REVIEW.md`. The owner names the reviewer and sends the packet; the outcome is recorded here after it returns. Claude does not assign, contact or substitute for the reviewer.
- **0086 stays NOT RELEASABLE** until the security review outcome is recorded and accepted, the remaining open items are closed, and the required approvals and gates are satisfied.

## 15. Reviewer designated (2026-10-31, D15 / A8)
Security reviewer: **Stella Okereke**. Outstanding reviewer actions: review `REVIEWER_PACKET.md`; complete `SECURITY_REVIEW.md`; record outcome; record all findings including any objection to manager-approve; sign and date. Outstanding Part 2 items from Stella: login role name (name only); written confirmation "No other changes were made beyond the authorized Part 2 verification procedure." Role overlap (Operator and reviewer) noted in A8; S12 is optional. 0086 stays NOT RELEASABLE.

## 16. S12 decision (2026-10-31, D16 / A9)
S12 may remain optional and unreviewed; no second reviewer. Required review scope and the four outstanding items are in `DECISION_RECORD.md` A9. 0086 stays NOT RELEASABLE.

## 17. Login role name: UNKNOWN as observed (Stella Okereke, 2026-10-31)
Stella reports the login role name used in Part 2 was not recorded in her notes. **Status: UNKNOWN (not observed).** Where it was and was not captured: the script printed it once to the terminal (`LOGIN ROLE USED (name only): …`), but that line was not written to the results file (only the SQL output is), and V1's `role_in_use` shows `ogevia_readonly`, the role after `SET ROLE`, not the login. So the saved evidence does not contain it.
**Allowed ways to settle it (none touches the secret, none changes anything):**
1. **Terminal scrollback.** If the CloudShell tab from the window is still open, scroll up (do not close the tab) and copy the one line `LOGIN ROLE USED (name only): …`. This would make it **VERIFIED**.
2. **Derive it, read-only (INFERRED, label it so):** `aws rds describe-db-instances --region us-west-2 --db-instance-identifier ogevia-prod-postgres --query 'DBInstances[0].MasterUsername' --output text`. The script took the username from the instance's RDS-managed master secret (the ARN came from `MasterUserSecret` on the same instance), and that username is the instance's master user, so this should match. It is an inference from how the script works, not an observation of that session.
**Not authorized to settle it:** reading the master secret again, or any new database connection (D14 covered one window only).
**If neither is available the record stays "UNKNOWN"** with the inference above, and the owner decides whether that satisfies the D14 reporting item. 0086 stays NOT RELEASABLE.

## 18. Login role name, derived (Operator output, 2026-10-31)
Read-only `describe-db-instances` for `ogevia-prod-postgres` (us-west-2) returned `MasterUsername` = **`ogevia_admin`**. **Status: INFERRED, not observed.** The Part 2 script took its login from the instance's RDS-managed master secret, whose username is the instance's master user, so the login used in the window was most likely `ogevia_admin`. The terminal line that would have confirmed it (`LOGIN ROLE USED (name only): …`) was not saved. No secret was read and no connection made to obtain this. Name only; no credential was seen. If the CloudShell scrollback for the window still exists, copying that one line would upgrade this to VERIFIED. The owner decides whether INFERRED satisfies the D14 report item. Still outstanding from Stella: the written no-other-change confirmation; the completed security review, outcome and signature. 0086 stays NOT RELEASABLE.

## 19. D14 report items received; target verification CLOSED (2026-10-31)
Received in the conversation (unsigned; relayed text, no separate signed form):
- **Operator confirmation:** "No other changes were made beyond the authorized Part 2 verification procedure."
- **Login role name accepted for the D14 report item:** `ogevia_admin` (INFERRED from the instance's MasterUsername, not independently verified; accepted as such).
**D14 report items status:** V1-V6 received (section 13); login role name accepted (inferred); security group restore verified by the script (`RESTORE VERIFIED`); no-other-change confirmation received. **Target verification (Part 2) is COMPLETE.** This clears the target-verification blocker only. No other gate advances. Security review outcome remains PENDING (`SECURITY_REVIEW.md` not completed or signed). 0086 stays NOT RELEASABLE.

## 20. Security review outcome received (2026-10-31, relayed text)
Reviewer **Stella Okereke**: **APPROVED**; findings: **none**; 6a: **not applicable** (four organizations on TEST, manual cross-agency UAT will be performed); justifications for unticked boxes: none; signature typed `Stella Okereke`; date stated `2026-10-30`.
**Gaps in the evidence (recorded, none changes the outcome):**
1. The **individual boxes** in `SECURITY_REVIEW.md` sections 1 to 3 were not received; the repo checklist says not to approve without every box ticked or justified. "Justifications: none" implies all ticked, but the ticked document is not in the repository. Ask the reviewer to commit or send the completed file; Claude does not tick boxes.
2. The **four decisions only the reviewer can make** (`REVIEWER_PACKET.md` section 8) were not answered individually. "No findings" is read as "no objection", including to managers approving for work. The owner should confirm that reading, because it settles README package decision 2.
3. The **date** (2026-10-30) precedes the reviewer designation (2026-10-31) and the packet. Confirm or correct.
4. The reviewer is also the Operator; S12 stays optional and unreviewed (D16).
**Effect:** the security-review gate has an APPROVED outcome recorded. 0086 stays NOT RELEASABLE: the decision record is unsigned, the six package decisions are unconfirmed, no window or GO exists, the real `cdk diff`, B9 acceptance, Phase C, Phase D and the release record update remain.

## 21. Review of the recorded sign-off (2026-10-31)
- **Reviewer name/role:** name Stella Okereke; role "Security Reviewer" (her own words); recorded. **Review start/finish times: NOT RECORDED** and not inferred.
- **Date:** 2026-10-30 is consistent with a Pacific local date (see `SECURITY_REVIEW.md` Date row). The earlier "conflict" note in section 20 item 3 is withdrawn as a time-zone artifact, pending the reviewer's confirmation of her time zone.
- **Signature:** typed text relayed in the conversation, not a system or wet signature; not evidence that checks passed.
- **Boxes:** 30 lines in `SECURITY_REVIEW.md` still carry unticked boxes (sections 1 to 3 and the item rows); one outcome box is ticked. The reviewer's ticked copy was not received.
- **D11:** consistent. Four organizations means 6a is not applicable and manual X1-X3 are required; **X1-X3 have not been run** and the two organizations have not been named.
- **Conflicting sign-offs:** none found. `DECISION_RECORD.md` is unsigned by the owner, so no owner sign-off exists to conflict with or support the review.
- **Technical evidence:** the author's re-run (`SECURITY_REVIEW.md` section 8) reproduced the measured facts. It is the author's, not the reviewer's.

## 22. Pre-window setup, Operator-reported (2026-10-31, about 03:20 UTC = 20:20 PDT on 2026-10-30; local only, no AWS change)
- Tools: Node `v22.22.0` (from `~/node22`; the shell default was v20.20.2), pnpm `9.15.4`, Python 3.13.16, jq 1.8.1, psql 16.15, session-manager-plugin present.
- Disk: `/tmp` 9.7 GB free before and 8.7 GB after the install; home 317 MB free. Web bucket (read-only listing): 165 objects, 27,422,669 bytes.
- Docs/script checkout `/tmp/ogevia-phasec/docs-checkout` at `52a9110ea1c0c07e51c33bff60c626c7dc5dbbbd`; script hashes match (`STELLA_PHASE_C_DB.sh` 2ec5b842…, `STELLA_PHASE_C_DEPLOY.sh` 4023b034…, `diff_gate_0086.py` 4e86f8d5…).
- Application checkout `/tmp/ogevia-phasec/app-5489` at exactly `54894411f0e69ac29bec762006e47f7d943b94f2`, 0 local changes. `pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store`: Done in 22 s.
- `STELLA_PHASE_C_DB.sh selftest`: window math, URI encoding and pin checks passed (commit, migration, rollback and set hashes). `STELLA_PHASE_C_DEPLOY.sh selftest`: passed (no assembly yet, as expected before `synth`).
- Not done yet: `synth` (local build), anything in AWS, anything in the database. **G1 not approved.** 0086 stays NOT RELEASABLE.

## 23. `synth` run in the Operator's environment (2026-10-31 03:23 UTC; local build, no AWS change; Operator-reported output)
`STELLA_PHASE_C_DEPLOY.sh synth` (Node 22.22.0, CDK 2.1143.0 as pinned; CDK printed a "newer version available" notice, ignored: no upgrade) wrote `/tmp/ogevia-cdk-0086.out` and passed every assembly check: exactly the five `Ogevia-prod-*` stacks and no `Ogevia-prd-*`; **Handler code asset `c3f09ddf4d995244…` (reproduced exactly in the Operator's environment)**; IdentityHandler asset `7c5f8eb676c93261…`; 236 API routes; `PASS all checks`. The deploy selftest then passed with the assembly (gate self-compare `EXPECTED-ONLY: YES`, repo at the approved SHA). Not yet done: anything in AWS or the database. **G1 not approved.** 0086 stays NOT RELEASABLE.

## 24. Updated DB script verified by the Operator (2026-10-31 03:28 UTC; local only)
Docs checkout `docs-checkout2` at `cca4bcba5e2cff79825f3e1c950af9649830383a`; hashes `STELLA_PHASE_C_DB.sh` `0d247068…`, `STELLA_PHASE_C_DEPLOY.sh` `4023b034…`, `diff_gate_0086.py` `4e86f8d5…` all match; DB selftest passed (window math, URI encoding, pins). G1 extended to DB rollback by A14. Use `docs-checkout2` for the window. Not done: anything in AWS or the database. 0086 stays NOT RELEASABLE.

## 25. UAT organizations named (2026-10-31)
Org 1 `ogevia-test-slice`, Org 2 `scs-pilot-synthetic` (as reported; slugs both appear in the Part 2 V5 output). Synthetic accounts: to be identified. Roles reported: Owner and Caregiver. Gaps recorded in `PHASE_D_UAT_SCRIPTS.md` section 5a: X3 needs office-level users (the Managers exist per the seed scripts); an Owner may not exist in either organization (needed for O11/O12). Phase C is unaffected. 0086 stays NOT RELEASABLE.

## 26. UAT accounts decided (2026-10-31, D22 / A15)
X1-X3: Manager of `ogevia-test-slice` and Manager of `scs-pilot-synthetic` (separate synthetic accounts); Caregiver of `scs-pilot-synthetic` for visibility checks; Owner steps O11, O12 and due-days via a synthetic Owner if one exists, else the automated tests, with no new TEST user. Finding: verifying a background check and the Accounts page are owner-only, so a no-Owner cycle also cannot exercise the new-caregiver approval chain (table in `PHASE_D_UAT_SCRIPTS.md` 5a). Operator to confirm accounts and whether an Owner exists. Phase C unaffected.

## 27. Owner-only UAT workflows decided (2026-10-31, D23 / A16)
Check for a synthetic Owner first (V7, count-only, inside the S2 probe covered by G1; SQL hash now `9e54d9d47b1639b1b1ad078e009b26e9392a6ab82ff8073336030f0e84868ca7`, Stella refreshes to `docs-checkout3`). Owner exists: use it for O2, O5, O6, O9, O11, O12, C3 and due-days; none: those workflows rest on automated tests and review evidence; no new user, no production account. UAT only; Phase C and the window are unchanged.

## 28. Synthetic Owner exists (owner statement 2026-10-31, D24 / A17)
The owner reports a synthetic Owner exists in TEST; it is used for all owner-only UAT steps; no new user; the D23 fallback is not used. To confirm: V7 at S2 (expect an `organization_owner` row) and the Operator's confirmation that the account is synthetic and which organization it belongs to. UAT only; Phase C and the window unchanged.

## 29. Test mailbox confirmed (2026-10-31, D25 / A18)
The designated test mailbox is under the owner's control and is for one synthetic caregiver ("UAT Ready", P1) only; no caregiver is created before Phase C is complete; creation is in the approved UAT data-prep step through the application. Still to state: no existing account in the shared pool for this address; the Owner's organization. P3 has no sign-in step (mailbox reserved for P1). UAT only; Phase C unchanged.

## 30. Pre-window checks, Operator-reported (2026-10-31, before 09:00 PDT; local only, no AWS change)
Script checkout `docs-checkout3` at `d4b899eee76480eada36ec092db9a118635f10be` (the branch tip when the checks were run); Node `v22.22.0`; all four hashes match: `STELLA_PHASE_C_DB.sh` `0d247068…`, `STELLA_PHASE_C_DEPLOY.sh` `4023b034…`, `diff_gate_0086.py` `4e86f8d5…`, `STELLA_READONLY_VERIFICATION.sql` `9e54d9d4…`. The DB selftest result was not stated in the report. The application checkout `app-5489` (pinned SHA) was verified earlier. Window opens 09:00 PDT; nothing has run in AWS. 0086 stays NOT RELEASABLE.

## 31. Window status at 18:45 UTC (Operator's CloudShell clock, 2026-10-31 = 11:45 PDT)
The Operator's shell printed `Sat Oct 31 06:45:01 PM UTC 2026` while running S0 (account `300094796789`; admin host `running` with only `sg-00e01e2ca80442c1f`). The authorized window ends 19:00 UTC (12:00 PDT), so about 15 minutes remained and **Phase C had not started** (no probe, snapshot, migration, deployment or security-group change). The selftests did not run in that shell: the working directory was `~` (the shell had been reset; `D` and `R` were unset). Phase C cannot complete in the time left, and no new step may begin after 12:00 PDT (A12). **Recommendation recorded: do not start S2, S5, S6, S8 or S9; request a new window and GO.** Read-only `synth`, `capture` and `check` are not window-gated and may be run to de-risk the next window. 0086 stays NOT RELEASABLE.

## 32. Window lapsed; Phase C not started (2026-10-31, about 19:07 UTC = 12:07 PDT)
The authorized window (09:00-12:00 PDT) ended with **no Phase C step run**: no probe, snapshot, migration, `synth`, `cdk diff`, deployment, security-group attach or database connection. Operator-reported at the last attempt: AWS account `300094796789`, admin host `running` with only `sg-00e01e2ca80442c1f` (baseline unchanged). The S1 selftests stopped because `/tmp/ogevia-phasec` held only `docs-checkout3`: the CloudShell `/tmp` had been reset (the application checkout `app-5489`, its dependencies and the assembly were gone). **The GO (A11/A12) expired at 12:00 PDT and G1 was limited to the window, so nothing may start until the owner gives a new window and written GO.** Nothing needs rollback (nothing was applied). Lessons: `/tmp` is not persistent (rebuild the application checkout, install and `synth` at the start of the next window and budget about 15 minutes for it); home has about 317 MB free, too little for the dependencies. 0086 stays NOT RELEASABLE. Gate G5 (Phase C) is NOT RUN.

## 33. New window and GO (2026-10-31, D26 / A19)
Window 14:00-18:00 PDT (21:00 UTC to 01:00 UTC on 2026-11-01), GO `GO-0086-TEST-20261031-B`, same scope, G1 and its DB-rollback extension included. Scripts re-issued with the new window and reference: `STELLA_PHASE_C_DB.sh` `38c8fb4296e39353b7ed9b75727c80a63648a7c2c6a0240f754d83a9624f4284`, `STELLA_PHASE_C_DEPLOY.sh` `30d8c2fb67e25ea94b2bddc9e7a17523f6f2c77bc3049f45ff3342337ce9f40c`; gate and SQL unchanged. Stella re-verifies hashes, rebuilds `/tmp`, runs `synth`, then Phase C from S0 at 14:00 PDT. Nothing has run in AWS under this window yet. 0086 stays NOT RELEASABLE.

## 34. Preparation for the 14:00-18:00 PDT window, Operator-reported (2026-10-31; local only, no AWS change)
Scripts checkout `docs-checkout4` at `c8a4f6afdad69e24a251d9a7fa39041414d63ca8`; application checkout at exactly `54894411f0e69ac29bec762006e47f7d943b94f2`; the four hashes matched the values in section 33; Node `v22.22.0`; `pnpm install --frozen-lockfile` succeeded; `synth` passed every check (five `Ogevia-prod-*` stacks, Handler `c3f09ddf…`, IdentityHandler `7c5f8eb6…`, 236 routes). Ready to start S0 at 14:00 PDT under `GO-0086-TEST-20261031-B`. Nothing has run in AWS under this window. 0086 stays NOT RELEASABLE.

## 35. Phase C S2 `probe` PASSED (Operator-reported output; 2026-10-31 22:59:49Z to 23:01:42Z, window 21:00Z-01:00Z, GO `GO-0086-TEST-20261031-B`)
- **Login role observed: `ogevia_admin`** (upgrades the earlier inferred value to observed). Guard `ogevia_sv_test`. TLS verified end to end: the script connected with `verify-full`; RDS CA bundle sha256 `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b` (identical to the author's download), which also settles the "real RDS certificate" question for the database path.
- State: ledger 85/`0085`, 0086 table absent, 5 of 6 Ready/Active, no organization enforcing; `BASELINE MATCHES`. V1-V6 identical to Part 2. **V7 (count-only):** `scs-pilot-synthetic`: organization_owner 1 (active), manager 1 (active), scheduler 1 (**invited**, not signed in), caregiver 4 (active); `ogevia-test-slice`: manager 1, caregiver 1 (both active).
- **Restore verified:** host groups `sg-00e01e2ca80442c1f` only, RDS SG sources unchanged (`RESTORE VERIFIED`); `exit=0`; log `~/phaseC_probe_20261031T225949Z.txt`.
- UAT implications: the synthetic Owner (D24) is in `scs-pilot-synthetic`, so that is the main UAT organization (Owner, Manager, 4 caregivers); `ogevia-test-slice` has the second Manager for X1-X3. The Scheduler there is only invited, so the Scheduler validator needs that person to sign in first or another route (open). The Operator still confirms the Owner and the other accounts are synthetic.
- Not yet done: S3b `capture`/`check`, S5 snapshot, S6-S7 migration, S8 API, S9 web, S10 checks, S11 final. 0086 stays NOT RELEASABLE.

## 36. Phase C S3a `synth` and S3b `capture` PASSED (Operator-reported output; GO `GO-0086-TEST-20261031-B`)
- Rebuild after the second `/tmp` reset: scripts hashes matched (DB `38c8fb42…`, deploy `30d8c2fb…`, gate `4e86f8d5…`, SQL `9e54d9d4…`); application checkout at exactly `54894411…`, 0 local changes; install done in 13 s; `synth` passed (five `Ogevia-prod-*` stacks, Handler `c3f09ddf…`, IdentityHandler `7c5f8eb6…`, 236 routes). Both selftests passed in the window.
- **S3b `capture` (read-only), ended 23:04:04Z:** `Ogevia-prod-ServiceVerificationApi` and `Ogevia-prod-WebHosting` both `UPDATE_COMPLETE`; **TEST confirmed (Lambda serves `ogevia_sv_test`)**; Lambda `CodeSha256` before `VFN/cMO326y63xaTOQERNhyvp+mHC19EM3/xN4IWeE4=`; the previous API code asset exists (`s3://cdk-hnb659fds-assets-300094796789-us-west-2/2871b03d6be42b0b8c85bac6feea12de75b3d05ca4636610259b6a18e1d00ed7.zip`, 263,034 bytes); 165 web files captured; served `index.html` sha256 `38adebb140069d8272113de33633cbfd535d6d74b528c9d2e1706797090396cb`; rollback material at `~/ogevia-before-0086`.
- Next: S3b `check` (the real `cdk diff` and the expected-only gate), then S5 snapshot, S6-S7 migrate, S8 API, S9 web, S10 checks, S11 final. 0086 stays NOT RELEASABLE.
