# HIPAA readiness checklist (operational; not legal advice)

Date: 2026-11-27. This lists what the **Security Rule's administrative, physical and technical safeguards** ask an agency to be able to show, and where Ogevia and AWS already help. It does not decide whether a specific agency is a covered entity or how any rule applies to it: that is a **legal determination for the owner and counsel**. "Evidence" cites what exists in the repository today; everything else is an open task.

## Administrative safeguards
| Item | Status | Evidence / action |
|---|---|---|
| Security officer named | OPEN | Owner names a person; record it here. |
| Risk analysis (written, dated, repeated when systems change) | OPEN | Start from this checklist, `SECURITY_READINESS_CHECKLIST.md` and `docs/aws/PHASE7_SECURITY_REVIEW.md`; owner/counsel sign. |
| Risk management plan (what is fixed by when) | OPEN | Turn unchecked rows of the Security checklist into dated tasks. |
| Workforce access: role-based, least privilege, individual accounts | PARTLY DONE | Roles and permissions per agency (`role_permissions`), individual Cognito accounts, offices limit visibility. Add: access review every quarter (export the roles page). |
| Onboarding and termination procedure | PARTLY DONE | Account disable and caregiver holds exist; write the checklist (disable Ogevia and Cognito access the same day). |
| Training on privacy and security | OPEN | Short staff training; record attendance. Include: no client details in text messages or email subjects; store exports only in approved places. |
| Sanctions policy | OPEN | Owner/counsel. |
| Information system activity review | PARTLY DONE | Audit log, override history, exceptions report, verification reports. Add: a named person reviews exceptions and overrides weekly. |
| Contingency plan: backups, disaster recovery, emergency mode, testing | PARTLY DONE | RDS backups, retained buckets; `docs/aws/CONTINUITY_AND_RECOVERY.md`. Open: a tested restore and an offline paper procedure for visits. |
| Business associate agreements | OPEN | See `BAA_READINESS_CHECKLIST.md`. |
| Evaluation (periodic review of safeguards) | OPEN | Re-run this checklist at each major release and yearly. |

## Physical safeguards
| Item | Status | Evidence / action |
|---|---|---|
| Data center security | AWS responsibility | Covered by the AWS agreement; keep the AWS compliance report on file. |
| Workstation use and security | OPEN | Office computers: screen lock, disk encryption, no shared logins. |
| Device and media controls (lost phone, exports) | OPEN | Caregiver phones hold no client data at rest in Ogevia (web app, session in the browser); write a lost-phone procedure (disable the account). Exports and printouts: handling rule in the handbook. |

## Technical safeguards
| Item | Status | Evidence |
|---|---|---|
| Unique user identification | DONE | Individual accounts. |
| Emergency access procedure | OPEN | Owner-held break-glass account procedure. |
| Automatic logoff | OPEN | Confirm the web session lifetime and idle behavior; set Cognito token lifetimes accordingly. |
| Encryption at rest | DONE in design | RDS and S3 (KMS) per CDK; confirm live (Security checklist). |
| Audit controls | DONE | Append-only audit events, signature event log, punch attempts, override history. |
| Integrity (no silent alteration) | DONE | Locked visits, correction chain, signature revision hashes, server-drawn images with checksums. |
| Person or entity authentication | DONE | Cognito; server verifies tokens, issuer and client id. |
| Transmission security | DONE in design | TLS required (CloudFront/API Gateway, S3 `enforceSSL`; RDS `force_ssl` to confirm). |

## Privacy-rule operations (confirm with counsel)
- Minimum necessary: client codes (not names) in worklists, reports and alerts; caregivers see city/ZIP, not the street, for expected places.
- Individual rights requests (access, amendment, accounting of disclosures): decide who receives them and how the audit log supports an accounting. OPEN.
- Notice of privacy practices and consent forms: owner/counsel. OPEN.
- Breach response: written procedure (who decides, who notifies, timelines set by counsel), a contact list, and a log. OPEN; the audit data above supports the investigation.
- Retention: `RETENTION_POLICY.md` (periods are a decision).

## Before production PHI (gates)
1. BAA with AWS accepted and recorded (see BAA checklist) and the AWS services in use confirmed as covered.
2. Security checklist live checks done and recorded.
3. Risk analysis signed.
4. Email: no PHI in email until SES coverage and the agency's policy are confirmed.
5. Real client data stays out of tests, tickets, chats and screenshots (synthetic data only in TEST).
