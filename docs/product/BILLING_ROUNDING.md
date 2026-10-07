# Billing rounding (migration 0029)

**Status:** built and verified locally on 2026-10-05. **Not deployed.** It ships in the next reviewed AWS TEST release (0027–0029 plus the menu fix).

**Principle:** the subscriber's choice configures Ogevia; it does not override the payer's rules. Set rounding only as the payer's own written rule allows.

## What it does

| Requirement | Implementation |
| --- | --- |
| Default: no rounding | Without a policy version, nothing changes anywhere. |
| Per payer and service | A policy is keyed by the authorization's payer and the service: no rounding, nearest increment (a half increment rounds up), round up, or round down. |
| Increment | 1–240 minutes, for example 15. |
| Basis | Exactly one per version: **each visit**, or the **daily total** (client, authorization and service on one service date). Never both: a day's visits can carry per-visit adjustments or one daily adjustment, never both, and the database refuses the mix. |
| Records | Clock times, worked minutes, confirmed billable minutes and the visit billing approvals are never changed. Billing review shows separately: actual duration, approved visit minutes, the billing adjustment, and proposed billable minutes and units. |
| Controls | Only the Administrator (`billing.rounding.manage`) can enable rounding, and only after recording the payer rule: document reference and its date. The payer must match one already on the agency's authorizations. The database refuses a rounding policy without an increment, a basis or a payer rule. |
| Authorization | An adjustment never takes the month's billed time past the authorized minutes. A round-up that would exceed it falls to the largest increment that fits, and is flagged. Approved adjustments count against the authorization everywhere: caps on confirmation, scheduling and corrections, and remaining hours in the monthly summary. |
| Approval | An adjustment is computed by the server from the approved visit minutes and the policy in effect on the service date. A person with `billing.approve` approves it as a separate, audited line, after the visit minutes are approved. It is voided only with a reason. |
| Audit and versioning | Every policy change is a new dated version (effective date, payer rule, reason, who, when). Versions are never edited or deleted. |
| No silent recalculation | An approved adjustment keeps its policy version, minutes and rate. After a policy change it is shown as "approved under an earlier policy" until a person voids it and approves again. A visit approval covered by an active adjustment cannot be voided first. A visit cannot be approved into a day that already has an active daily adjustment. |
| Payroll | Unaffected. Ogevia has no payroll feature, and rounding never reads or writes worked minutes. |

## Evidence (local)

| Test | Result |
| --- | --- |
| Database: `infra/aws/db/test/rounding.db.test.ts` | 12 tests: arithmetic; who may set a policy; payer-rule requirement (in the function and in the table); versions and history; per-visit and daily adjustments; never both; the authorization cap; no recalculation; void rules; isolation between agencies; rollback refusal |
| Full database suite | 265/265 |
| API | 49/49 |
| Web | Rounding section and policy page tests pass |
| Browser at 390 px (`infra/aws/slice/pilot-e2e/rounding-e2e.ts`) | 14/14 |

## Open decision

Payer names are free text on authorizations, so a policy matches the payer as typed (case and outer spaces ignored). A canonical payer list would remove any risk of spelling variants; it is not built.
