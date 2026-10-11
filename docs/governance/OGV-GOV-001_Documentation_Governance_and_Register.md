# OGV-GOV-001: Documentation Governance and Register

| Field | Value |
|---|---|
| Document ID | OGV-GOV-001 |
| Version | 0.1 (DRAFT, not approved) |
| Evidence date | 2026-10-11 |
| Evidence basis | Repository `socalcaresservices/CarelikGlobal`, `origin/main` = `a2d249b0d947a7414e0b7ed7d7b94ed5a6cc9ca4` (2026-10-11), working branch `claude/amazing-meitner-cap9fd` at the same commit. |
| Live AWS / production verified in this version? | **No.** No AWS call was made. Anything about deployed state below is quoted from repository documents and labelled with that document's date. |
| Approver | Owner (`CLAUDE.md` §1, §12: the owner approves changes to this governance). No other named approver exists in the repository. |

## 1. Purpose and scope

This document defines how the 24-document Ogevia reference set (`OGV-*`) is owned, written, evidenced, approved, versioned, reviewed, changed and retained, and it holds the master register. It governs the new reference set. It does not replace `CLAUDE.md`, which remains the build directive (`CLAUDE.md` §1).

## 2. Authority order for documentation

When two sources disagree, the document author uses this order and records the conflict in §9 rather than choosing silently.

1. Live system evidence collected read-only with a recorded date (not available in this version).
2. Repository code, migrations, CDK, tests and CI at a stated commit.
3. `CLAUDE.md` (the standing rules in §0 and the directive).
4. Dated repository documents, newest first. A document's own date is the latest it can be right.
5. Owner statements not backed by an artifact in the repository. These are recorded as "owner-stated" and are never presented as verified.

## 3. Status vocabulary (mandatory)

Taken from `CLAUDE.md` §0 ("Accurate records") and the evidence classes the owner requires. Every capability, resource or claim in an `OGV-*` document carries exactly one status.

| Term | Meaning | Minimum evidence |
|---|---|---|
| PROPOSED | Written down, no code. | The proposing document. |
| IMPLEMENTED | Code or SQL exists at a commit. | File path and commit. |
| TESTED | Automated or manual test was run and the result recorded. | Command, commit, result, date. |
| DEPLOYED | Running in a named environment. | Read-only live evidence with date, or an owner-provided output labelled as such. |
| VERIFIED | Directly proven by evidence the document cites. | The evidence itself. |
| INFERRED | Strongly implied, not directly proven. | Stated reasoning. |
| UNKNOWN | Cannot be established. | Statement of what is missing. |

"Implemented" is never written to mean "deployed." A claim that production works needs production evidence.

## 4. Roles

| Role | Who (from evidence) | Duty |
|---|---|---|
| Owner / approver | The repository owner (`CLAUDE.md` calls this "the owner" and "architecture owner"). Named individuals are not recorded in the repository. | Approves documents, scope changes and any claim about compliance posture. |
| Author | Claude Code on the owner's instruction, or an engineer. | Collects evidence, writes, states unknowns. |
| Independent checker | **Not assigned.** | See Decision Gate D2. |

Incident contacts and escalation owners are not in the repository. They are not invented here (see OGV-SOP-004 in the register).

## 5. Required structure of every `OGV-*` document

1. Header table: ID, version, evidence date, commit, environment(s) examined, live-verified yes/no, approver, status.
2. Scope and what is excluded.
3. Body, with every factual statement carrying a status from §3 and a source (path, commit, query, or owner statement).
4. "How to verify" for each resource or procedure, with read-only commands only.
5. Unknowns and conflicts found.
6. Change log.

Sanitization rule: no secrets, credentials, tokens, real PHI, or real client/caregiver data in any document. Examples use synthetic or placeholder values only (`CLAUDE.md` §8).

## 6. Versioning and change control

* Version `0.x` = draft; `1.0` = approved by the owner. Minor increments for content changes, major for structural change or a changed conclusion.
* A document is stored in `docs/` and changes only through a reviewed pull request, so that git history is the audit trail.
* A document must be re-checked, and its evidence date updated, whenever any trigger below occurs. If it is not re-checked, it must say so in its header.

| Trigger | Documents affected |
|---|---|
| New file in `infra/aws/db/migrations/` or `supabase/migrations/` | DATA-001, SOP-002, API-001, TEST data, RISK-001 |
| Change in `infra/aws/lib/` | INFRA-001, SOP-001, SEC-001, OPS-001 |
| Change in `apps/sv-api/src/routes.ts` or `identity*.ts` | API-001, IAM-001 |
| Change in `apps/web/src/` user flows | the matching USER and PROD documents |
| Deployment to any environment | INFRA-001, SOP-001, RISK-001 |
| Incident | SOP-004, RISK-001, OPS-001 |

Suggested review cycle (a proposal for the owner to adopt or change, not an existing policy): quarterly for all documents, and before any production data migration or cutover.

## 7. Evidence requirements and handling

* Evidence is a file path plus commit, a command plus its recorded output, or a dated owner statement.
* Live AWS evidence is collected read-only (`CLAUDE.md` §13 GREEN) and recorded with caller identity, region and timestamp. Secret values are never retrieved or printed (`CLAUDE.md` §7).
* Expired container credentials prove only that AWS access is unavailable, not that resources are missing (`CLAUDE.md` §0).
* A statement copied from an older document keeps that document's date and is marked INFERRED until re-checked.

## 8. Retention

No documentation or records retention policy was found in the repository (searched `docs/`, `CLAUDE.md`, `README.md`). Status: **UNKNOWN**. Interim rule proposed for approval: retain all `OGV-*` versions in git history indefinitely (no deletion; supersede, never delete). Retention periods for PHI-bearing records, audit events and S3 evidence are a legal/compliance decision and are outside this document (see Decision Gate D4).

## 9. Conflicts and gaps found in existing documentation (verified in the repository on 2026-10-11)

| # | Finding | Evidence | Effect | Needed action |
|---|---|---|---|---|
| C1 | `infra/aws/README.md` says "Nothing in this package is deployed. The account is not bootstrapped." Other documents state AWS TEST was deployed and accepted on phones, and that `Ogevia-prd-*` stacks are `UPDATE_COMPLETE`. | `infra/aws/README.md` (last change 2026-10-05); `docs/aws/SCS_PILOT_READINESS.md`; `docs/aws/PRODUCTION_DEPLOYMENT.md` (updated 2026-10-10, owner-provided output) | The README is stale, and a reader following it would draw the wrong conclusion about deployed state. | Correct in OGV-INFRA-001 after live verification; flag README for edit. |
| C2 | `PILOT_VERIFICATION_REPORT.md` (2026-10-07) says "ARCHITECTURE CONFLICT DETECTED", that the current branch deleted the Lambda Service Verification API, and gives "Migration Level: 0018". At `a2d249b`, `apps/sv-api/` exists and `infra/aws/db/migrations/` runs 0001 to 0048. | `PILOT_VERIFICATION_REPORT.md`; `ls apps/sv-api`, `ls infra/aws/db/migrations` | The report describes a different branch state and is superseded for current state. It sits at the repo root, where it is likely to be read as current. | Mark as historical in the register; move or label in a later change. |
| C3 | `docs/OGEVIA_OPERATING_RECORD.md` (2026-10-07) says "Pilot Launch Ready", "Confidence Level: High". `docs/aws/PRODUCTION_DEPLOYMENT.md` (2026-10-10) says database connectivity, migrations, deployed commit, MFA sign-in and the signature workflow on `ogevia_prd` are unverified. | Both files | "Ready" and "unverified" conflict for the production environment. The later document is the more authoritative. | Treat production readiness as UNKNOWN until live evidence exists. |
| C4 | `README.md` (last change 2026-08-24) has 32 mentions of Supabase/Netlify and none of AWS or Cognito. `CLAUDE.md` makes AWS the production path. | `grep -ci` on `README.md` | The front-door document describes the superseded stack, so onboarding from it is wrong. | OGV-DEV-001 replaces its role; README needs a pointer. |
| C5 | Two migration trees: `supabase/migrations/` (162 files, timestamp-style names) and `infra/aws/db/migrations/` (48 files, numeric `0001`–`0048`). `supabase/proposed/` holds one unapplied file. | `ls` of both | The authoritative schema for production is not stated in one place. The relationship (which Supabase files are ported to which AWS migration) is not recorded in one document I could confirm. | Resolve in OGV-DATA-001 and OGV-SOP-002 from `docs/aws/PHASE_2_SCHEMA_MAPPING.md` plus the code; UNKNOWN until done. |
| C6 | Environment naming: CDK context `env=prod` yields `Ogevia-prod-*` stacks and holds the **test** database `ogevia_sv_test`; `env=prd` yields `Ogevia-prd-*` stacks and holds the **production** database `ogevia_prd`. One letter apart. | `docs/aws/PRODUCTION_DEPLOYMENT.md` §1 | High risk of operating on the wrong environment. | Document prominently in OGV-INFRA-001 and OGV-SOP-001; record in RISK-001. |
| C7 | Seven deployment documents under `docs/deployment/` (all 2026-10-07) use "Phase B/C" and "Pilot-to-Production" language that does not map to the `CLAUDE.md` phases or the `docs/aws/` release plans. Relationship to the current production path is not stated. | `docs/deployment/*` | Possible duplicate or superseded procedures. | Reconcile when writing OGV-SOP-001; UNKNOWN until read in full. |
| C8 | Status wording is inconsistent: "VERIFIED", "READY FOR EXECUTION", "DOCUMENTED", "COMPLETE", "Pilot Launch Ready" are used without the §3 definitions. | Header lines of `docs/**` | Readers cannot tell tested from deployed. | Adopt §3 in all `OGV-*` documents. |
| C9 | Product naming varies: "CareLik Global" (README, `PRODUCT_CONSTITUTION.md`, `design-system.md`, August documents) versus "Ogevia". | headings | Confusing, and a risk for the marketing-claims review. | Glossary in OGV-INDEX-001. |
| C10 | Documents dated 2026-10-05 (the majority of `docs/aws/`) predate migrations 0039–0048 and the releases under `docs/releases/`. | `git log` dates versus migration list | Their inventories are incomplete for current state. | Treat as dated snapshots until refreshed. |

**Not verified in this version:** whether the repository `main` CI is passing (CI definition read: `.github/workflows/ci.yml` runs typecheck, lint, build, test, a deployment-bundle build, and a PostgreSQL 18 integration job; no run result was retrieved); and whether any document outside the repository (Drive, Notion, email) holds additional authoritative material.

## 10. Master register

Status key: NOT STARTED, DRAFT, APPROVED. "Existing sources" are the repository files the author starts from; they are leads, not proof.

| # | ID | Title | Status | Blocking issue | Existing sources to start from |
|---|---|---|---|---|---|
| 1 | OGV-TECH-001 | Master Technical Reference | **BLOCKED** | The "original 57-section prompt" is not in the repository or in this session. It must be supplied. | `CLAUDE.md`, `docs/aws/PHASE_1_CDK_ARCHITECTURE.md` |
| 2 | OGV-PROD-001 | Master Product Reference | NOT STARTED | none | `docs/OGEVIA_OPERATIONS_PRD.md`, `docs/product/PILOT_SCOPE_RECONCILIATION.md`, `docs/product/FEATURE_RECOVERY_INVENTORY.md`, `docs/product/PENDING_RESTORATION.md` |
| 3 | OGV-GOV-001 | Documentation Governance and Register | **DRAFT v0.1 (this document)** | Owner approval; D1–D4 | this file |
| 4 | OGV-INFRA-001 | Environment and Infrastructure Reference | NOT STARTED | Live read-only AWS verification needs credentials (D5) | `docs/aws/CURRENT_AWS_INVENTORY.md`, `PHASE_1_*`, `URL_REGISTRY_AND_LAUNCH_CHECKLIST.md`, `infra/aws/lib/*` |
| 5 | OGV-DATA-001 | Database and Data Dictionary | NOT STARTED | C5 | `infra/aws/db/migrations/0001–0048`, `docs/aws/PHASE_2_*`, `supabase/migrations` |
| 6 | OGV-API-001 | API and Integration Reference | NOT STARTED | none | `apps/sv-api/src/routes.ts`, `docs/aws/PHASE_4_API_CONTRACT.md` |
| 7 | OGV-IAM-001 | Identity, Roles, and Tenant Isolation | NOT STARTED | none | `packages/auth`, `apps/sv-api/src/identity*.ts`, `infra/aws/lib/auth-contract.ts`, `cognito-target.ts`, `PHASE_3_*`, `docs/product/ACCESS_AND_BILLING_VISIBILITY.md` |
| 8 | OGV-SEC-001 | Security, Privacy, and HIPAA Architecture | NOT STARTED | The BAA is owner-stated only; the agreement is not in the repository (`SECURITY_DECISIONS.md` §HIPAA) | `docs/aws/SECURITY_DECISIONS.md`, `PHASE7_SECURITY_REVIEW.md`, `docs/security-review-checklist.md` |
| 9 | OGV-DEV-001 | Developer Onboarding and Local Setup | NOT STARTED | C4; setup commands must be run to be documented | `package.json`, `turbo.json`, `.github/workflows/ci.yml`, `infra/aws/README.md` |
| 10 | OGV-SOP-001 | Deployment and Release SOP | NOT STARTED | C6, C7; production deployment path unverified (C3) | `docs/aws/DEPLOYMENT_PLAN_*`, `PRODUCTION_DEPLOYMENT.md`, `infra/aws/slice/`, `docs/releases/*` |
| 11 | OGV-SOP-002 | Database Migration SOP | NOT STARTED | C5 | `infra/aws/db/deploy`, `verification`, `rollback`, `restore`, `scripts` |
| 12 | OGV-SOP-003 | Rollback, Backup, and Recovery SOP | NOT STARTED | No restore test evidence located yet | `docs/aws/CONTINUITY_AND_RECOVERY.md`, `PHASE_2_ROLLBACK_PLAN.md`, `infra/aws/db/restore` |
| 13 | OGV-OPS-001 | Operations and Observability Runbook | NOT STARTED | Live alarm state needs AWS access | `infra/aws/lib/observability-stack.ts`, `docs/ops/README.md` |
| 14 | OGV-SOP-004 | Incident Response SOP | NOT STARTED | Owners and contacts not in the repository (D3) | `docs/aws/CONTINUITY_AND_RECOVERY.md`, `SECURITY_DECISIONS.md` |
| 15 | OGV-USER-001 | Organization and User Administration Guide | NOT STARTED | UI paths must be verified in the app | `docs/releases/account-status`, `supabase/functions/invite-member`, `apps/web/src` |
| 16 | OGV-USER-002 | Client and Caregiver Management Guide | NOT STARTED | as above | `docs/releases/caregiver-readiness`, `apps/web/src` |
| 17 | OGV-USER-003 | Scheduling and Authorization Guide | NOT STARTED | as above | `docs/product/SCHEDULING_AND_ACCOUNTS_DECISIONS.md`, `docs/releases/availability-override` |
| 18 | OGV-USER-004 | Visit Verification and Evidence Guide | NOT STARTED | as above | `docs/product/SIGNATURE_RECOVERY_DESIGN.md`, `docs/SERVICE_VERIFICATION_V3_BUILD_VERIFICATION.md`, `PHASE_5_EVIDENCE_STORAGE.md` |
| 19 | OGV-MATCH-001 | CareScore and Matching Reference | NOT STARTED | Matching rule is labelled "provisional" in the repository | `docs/releases/caregiver-readiness/MATCHING_WORKED_EXAMPLES.md`, `MARKETING_CLAIMS_REVIEW.md` |
| 20 | OGV-REPORT-001 | Reporting and Billing Readiness Reference | NOT STARTED | none | `docs/product/BILLING_ROUNDING.md`, `supabase/tests/billing-correction`, `supabase/proposed/` |
| 21 | OGV-QA-001 | Testing and Quality Assurance Reference | NOT STARTED | Tests must be run to report results | 200 test files (counted), `ci.yml`, `docs/aws/PHASE_2_TEST_REPORT.md`, `PHASE_3_AUTH_SECURITY_TEST_REPORT.md` |
| 22 | OGV-ADR-001 | Architecture Decisions and Development History | NOT STARTED | Resend history needs source search | `git log` (131 commits, first 2026-08-20), `docs/BUILD_022_*`, `docs/phase-*.md`, `CLAUDE.md` §1, §3 |
| 23 | OGV-RISK-001 | Technical Debt, Risks, and Limitations Register | NOT STARTED | Seeded by §9 above | §9; `docs/product/PENDING_RESTORATION.md` |
| 24 | OGV-INDEX-001 | Documentation Navigation and Troubleshooting Index | NOT STARTED | Written last | all |

Suggested writing order (dependencies, not importance): GOV → DATA, API, IAM → INFRA → SEC → SOP-002, SOP-001, SOP-003 → OPS, SOP-004 → PROD, USER-001..004, MATCH, REPORT → QA, ADR, RISK → DEV → INDEX → TECH (once the prompt is supplied).

## 11. Decision gates

| ID | Question | Known | Unknown | Recommended default | If a different choice is made |
|---|---|---|---|---|---|
| D1 | Supply the 57-section prompt for OGV-TECH-001 | Not in repo or session | Its content | Provide it as a file under `docs/governance/` | Without it the document cannot be produced "exactly as supplied" |
| D2 | Who is the independent checker? | None named | | Owner reviews each draft; add a second person when available | Authors would approve their own work |
| D3 | Who are the incident owners and contacts? | None in repo | | Owner supplies; SOP-004 uses placeholders marked UNKNOWN until then | Invented contacts would be unsafe |
| D4 | Retention periods for audit/PHI records | No policy found | Legal requirement | Obtain compliance/legal input before writing SEC-001 retention text | Inaccurate retention text is a compliance risk |
| D5 | Authorize read-only live AWS verification for INFRA-001, OPS-001, SEC-001 | CLAUDE.md §13 allows read-only calls; credentials in this container were not tested | Current live state | Provide an SSO read-only session when INFRA-001 starts (`CLAUDE.md` §0 says do not request earlier) | Those documents would stay repository-evidence-only and be labelled so |

## 12. Change log

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-10-11 | First draft, from repository evidence at `a2d249b`. |
