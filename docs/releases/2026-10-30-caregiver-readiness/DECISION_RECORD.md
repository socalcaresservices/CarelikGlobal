# Decision record: release 2026-10-30-caregiver-readiness (migration 0086)

**Status: FILED, NOT SIGNED.** This record is prepared for the owner's signature. Claude Code cannot sign for the owner; the signature block below is blank on purpose. Until the owner signs, the decisions are recorded as *given in the conversation with Claude Code on 2026-10-30* and nothing else.

Scope: this release package only. It authorizes **nothing** beyond what is written here. In particular it does not designate a target environment, approve a deployment, or give a GO (gate G6).

## 1. Decisions of the owner (D1 to D7)
Wording follows what the owner wrote in the conversation on 2026-10-30; the right-hand column says where each is reflected in the package.

| # | Decision | Reflected in |
|---|---|---|
| D1 | Treat 0086 as a **TEST/PILOT package only** until a deployment target is formally designated. **Operator: Stella Okereke.** Do not schedule, script or execute deployment against any shared environment until the target environment is explicitly identified and documented. | `RUNBOOK.md` header; `CHECKLIST.md` section C. Target: **NOT DESIGNATED** |
| D2 | **Retire** the release-pin tests tied exclusively to the superseded 2026-10-19 and 2026-10-21 release packages. **Do not re-pin** them at this stage. If a new release-pin baseline is required, create it only after the target environment is identified and the release candidate is finalized. | `infra/aws/retired-tests/` (7 files moved, not deleted, with a README) |
| D3 | Categorize the 41 database test failures as a pre-existing environment issue, an obsolete test, a harness/container issue, or an actual product defect. | `TEST_FAILURE_CATEGORIZATION.md` (37 obsolete/harness, 4 date-dependent, 0 defects) |
| D4 | Run the real CDK diff once the target environment has been identified. | `RUNBOOK.md` D and E; **blocked: no target** |
| D5 | Complete all remaining Phase B validations (browser console, network, regression checks) and all remaining release gates and activities in Phases C, D and E. | `CHECKLIST.md`: B7 done; **B9 open**; C, D, E not run |
| D6 | Keep the failed gate accurately marked as failed until resolved. | G3 was marked failed until resolved and validated on 2026-10-30; now resolved (`TEST_REMEDIATION_DATE_DEPENDENT.md`) |
| D7 | Do **not** mark 0086 releasable, deployment-ready or production-approved until: the failed gate is resolved, outstanding validations are completed, the deployment target is documented, and the release record is updated accordingly. | `CHECKLIST.md` release status table |

### Further owner decision recorded the same day (not part of D1 to D7)
| # | Decision | Reflected in |
|---|---|---|
| D8 | Make the 4 date-dependent tests calendar-independent: do not weaken coverage, do not remove assertions, do not change production behaviour, use a deterministic approach, preserve all business-rule validation, document what changed and why, validate on the current date and after 2026-11-02, and update G3 only after validation. | `TEST_REMEDIATION_DATE_DEPENDENT.md`; G3 resolved |

## 2. State of the release at the time of filing (facts, not decisions)
| Item | State |
|---|---|
| Code | `claude/practical-tesla-r07odb`; no pull request opened; nothing merged to main |
| Gates | G1 lint pass; G2 typecheck pass; G3 tests pass and validated; G4 open (B9 regression spot-check outstanding); G5 pilot not run; G6 owner GO **not given** |
| Target environment | **NOT DESIGNATED** |
| Operator | Stella Okereke |
| Deployed anywhere | **No** |
| **0086 releasable / deployment-ready / production-approved** | **NO** (D7 conditions not met: B9, target, Phases C, D, E, security review confirmation outstanding) |

## 3. What this record does NOT do
- It is not a GO or NO-GO (G6). That is a separate decision record in `CHECKLIST.md` section E and names a commit SHA and window.
- It does not designate the target environment. When the owner designates one, add it in section 5 and in `CHECKLIST.md` C0.
- It does not approve re-pinning, deployment, schedule, scripts, or any action against a shared environment.

## 4. Signature
| Field | Entry |
|---|---|
| Owner (full name) | ______________________________ |
| Role | ______________________________ |
| Signature | ______________________________ |
| Date | ______________________________ |
| Decisions confirmed (tick) | ☐ D1 ☐ D2 ☐ D3 ☐ D4 ☐ D5 ☐ D6 ☐ D7 ☐ D8 |
| Corrections to the wording above (if any) | |

Operator acknowledgement (D1: Operator is Stella Okereke; she runs nothing against a shared environment until a target is designated):

| Field | Entry |
|---|---|
| Operator (full name) | Stella Okereke |
| Signature | ______________________________ |
| Date | ______________________________ |

## 5. Amendments (append only; date and sign each)
| Date | Change | Owner signature |
|---|---|---|
| | e.g. "Target environment designated: …" | |
