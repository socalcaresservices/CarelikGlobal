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
